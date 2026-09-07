import {
  calculateJwkThumbprint,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
} from 'jose';

import type { Config } from '../../config.js';
import { DomainError } from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';

/**
 * Access tokens.
 *
 * This module is the ONLY place in the codebase that imports `jose`. Everything else takes
 * `TokenService` and deals in typed claims, so swapping the JWT library — or moving to
 * opaque access tokens with introspection — touches one file.
 *
 * The design in one line: access tokens are stateless, short-lived, and RS256-signed;
 * refresh tokens are opaque and stored in PostgreSQL. That asymmetry is deliberate — an
 * access token is fast to verify and impossible to revoke, so it lives 15 minutes; a refresh
 * token is revocable because logout and breach response have to actually work.
 */

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * A token could not be trusted.
 *
 * ONE error for every failure mode — malformed, expired, wrong key, wrong issuer, wrong
 * audience, wrong algorithm. A caller must not be able to distinguish them, because the
 * differences are exactly what an attacker probes for: "expired" confirms the token was once
 * valid, and "wrong issuer" confirms the signature checked out. The reason is logged at debug
 * for our own diagnosis and never returned.
 *
 * Extends `DomainError` directly rather than `AuthenticationRequired`, whose `code` is a
 * string literal type and therefore not overridable. Same pattern as the `Conflict`
 * subclasses in `identity.service.ts`.
 */
export class InvalidAccessToken extends DomainError {
  readonly code = 'INVALID_ACCESS_TOKEN';
  readonly statusCode = 401;

  constructor() {
    super('The access token is missing, invalid, or expired.');
  }
}

/**
 * The key material in configuration is not usable.
 *
 * NOT a `DomainError`: this is a deployment fault, not a business outcome, and it must surface
 * as a 500 rather than being mistaken for a client problem. Config validates PEM *shape*
 * synchronously at boot; this is the residue — a well-formed PEM that is not actually an RSA
 * key, or a mismatched pair.
 */
export class TokenKeyUnusable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`JWT key material is unusable: ${message}`, options);
    this.name = 'TokenKeyUnusable';
  }
}

/* ── Claims ──────────────────────────────────────────────────────────────── */

/**
 * What the caller supplies when issuing a token.
 *
 * Note what is absent, and why each absence is deliberate:
 *
 *  - **email / name.** PII, and mutable. A token minted before an email change would carry a
 *    stale address for its whole lifetime, and every log line that dumped a decoded token
 *    would carry PII with it.
 *  - **scopes.** Derived from `isStaff`/`isSuperuser` at authorization time, not embedded.
 *    Baking a scope list into a 15-minute credential means a permission revoked now takes
 *    effect in 15 minutes; deriving it per request makes revocation immediate.
 *  - **anything password-related.** Never.
 */
export type AccessTokenSubject = {
  /** `sub`. The authenticated user id. */
  userId: string;
  /**
   * `storeId`. Carried in the token so tenancy survives without a lookup, and so a token
   * minted for one store is structurally unusable against another.
   */
  storeId: string;
  isStaff: boolean;
  isSuperuser: boolean;
  /**
   * `sid`. The `refreshSession` row this access token descends from.
   *
   * Present from the first token so the format never has to change. It is what makes
   * "revoke this session" able to reach access tokens later, via a short-lived denylist —
   * without it, the only options are waiting out the TTL or revoking everything.
   */
  sessionId: string;
};

/** A verified token's claims, with the standard fields resolved to useful types. */
export type VerifiedAccessToken = AccessTokenSubject & {
  /** `jti`. Unique per token, for audit correlation and future replay detection. */
  tokenId: string;
  issuedAt: Date;
  expiresAt: Date;
};

export type IssuedAccessToken = {
  token: string;
  /** So a caller can tell a client when to refresh without decoding the token. */
  expiresAt: Date;
  expiresInSeconds: number;
};

export type TokenService = {
  issueAccessToken(subject: AccessTokenSubject): Promise<IssuedAccessToken>;
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
  /** The `kid` this service stamps on issued tokens. Exposed for tests and diagnostics. */
  keyId(): Promise<string>;
  /**
   * Import and cache the keys, proving they are usable.
   *
   * Not wired into the application lifecycle yet — deliberately. It belongs in the API
   * startup sequence alongside login, so a deployment with a well-formed but broken key
   * fails at boot rather than at the first sign. Increment 3 wires it.
   */
  warmUp(): Promise<void>;
};

/**
 * The signing algorithm, pinned in one place.
 *
 * RS256, and only RS256, on BOTH sides. Pinning the verifier is the part that matters: an
 * unpinned verifier accepts whatever the token's own header claims, which is the classic
 * algorithm-confusion attack — swap `alg` to `HS256` and sign with the *public* key, which
 * is public, and the token verifies. `jose` additionally refuses `alg: none` outright.
 */
const ALGORITHM = 'RS256';

export function createTokenService(deps: { config: Config; logger: Logger }): TokenService {
  const { config, logger } = deps;

  const ttlSeconds = config.jwtAccessTtlMinutes * 60;

  /**
   * Keys are imported once and cached as a promise, not a value.
   *
   * Caching the promise rather than awaiting it up front collapses concurrent first-use into
   * a single import, and keeps the factory synchronous so `buildContainer()` stays
   * synchronous. A rejected import is deliberately NOT cached — a transient failure must not
   * poison the service for the process's lifetime.
   */
  let keys: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; kid: string }> | undefined;

  function loadKeys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; kid: string }> {
    keys ??= (async () => {
      let privateKey: CryptoKey;
      let publicKey: CryptoKey;

      try {
        privateKey = await importPKCS8(config.jwtPrivateKey, ALGORITHM);
      } catch (err) {
        throw new TokenKeyUnusable('JWT_PRIVATE_KEY is not an importable PKCS#8 RSA key', {
          cause: err,
        });
      }

      try {
        publicKey = await importSPKI(config.jwtPublicKey, ALGORITHM);
      } catch (err) {
        throw new TokenKeyUnusable('JWT_PUBLIC_KEY is not an importable SPKI RSA key', {
          cause: err,
        });
      }

      /**
       * `kid` from the RFC 7638 JWK thumbprint of the PUBLIC key.
       *
       * Deterministic, so the same key always yields the same id, and derivable by any
       * verifier holding the public key — no shared registry, and no new environment
       * variable. That is what makes rotation additive later: a second configured key
       * brings its own `kid`, verification selects by `kid`, and the token FORMAT never
       * changes. Deriving it now costs ten lines; retrofitting it would mean every token in
       * flight lacking the header the verifier needs.
       */
      const kid = await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256');

      logger.debug({ kid, algorithm: ALGORITHM }, 'jwt_keys_loaded');
      return { privateKey, publicKey, kid };
    })().catch((err: unknown) => {
      // Clear the memo so the next call retries rather than replaying the failure forever.
      keys = undefined;
      throw err;
    });

    return keys;
  }

  return {
    async keyId() {
      return (await loadKeys()).kid;
    },

    async warmUp() {
      await loadKeys();
    },

    async issueAccessToken(subject) {
      const { privateKey, kid } = await loadKeys();

      /**
       * Seconds, not milliseconds. JWT `exp`/`iat` are NumericDate — seconds since the
       * epoch — and the floor keeps the token's own claims and the `expiresAt` we return
       * describing the same instant rather than differing by a stray millisecond.
       */
      const issuedAtSeconds = Math.floor(Date.now() / 1000);
      const expiresAtSeconds = issuedAtSeconds + ttlSeconds;
      const tokenId = newId();

      const token = await new SignJWT({
        storeId: subject.storeId,
        isStaff: subject.isStaff,
        isSuperuser: subject.isSuperuser,
        sid: subject.sessionId,
      })
        // `kid` in the header so a future multi-key verifier can select without trial
        // decryption. `alg` pinned, never taken from input.
        .setProtectedHeader({ alg: ALGORITHM, kid, typ: 'JWT' })
        .setSubject(subject.userId)
        .setIssuer(config.jwtIssuer)
        .setAudience(config.jwtAudience)
        .setJti(tokenId)
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(expiresAtSeconds)
        .sign(privateKey);

      return {
        token,
        expiresAt: new Date(expiresAtSeconds * 1000),
        expiresInSeconds: ttlSeconds,
      };
    },

    async verifyAccessToken(token) {
      const { publicKey, kid } = await loadKeys();

      try {
        const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
          // The three that make this safe. `algorithms` prevents algorithm confusion;
          // `issuer` and `audience` prevent a token minted by another system — or for
          // another audience of ours — from being accepted here.
          algorithms: [ALGORITHM],
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,
        });

        /**
         * Belt and braces on `kid`.
         *
         * `jwtVerify` already proved the signature against our public key, so a mismatched
         * `kid` cannot mean a forged token. It means a token from a PREVIOUS keypair whose
         * signature happens to still validate — impossible today with one key, and exactly
         * the case that appears the moment rotation lands. Rejecting now means the rotation
         * increment starts from a verifier that already distinguishes keys.
         */
        if (protectedHeader.kid !== kid) {
          throw new InvalidAccessToken();
        }

        return parseClaims(payload);
      } catch (err) {
        if (err instanceof InvalidAccessToken) throw err;

        /**
         * Every jose failure collapses to one error. The reason is logged at DEBUG — not
         * warn — because an expired token is normal traffic: every client hits it once per
         * 15 minutes by design, and at warn it would be the noisiest line in the system.
         */
        logger.debug(
          { reason: err instanceof Error ? err.message : 'unknown' },
          'access_token_rejected',
        );
        throw new InvalidAccessToken();
      }
    },
  };
}

/* ── Claim parsing ───────────────────────────────────────────────────────── */

/**
 * Convert a verified payload into typed claims, rejecting anything malformed.
 *
 * `jwtVerify` proves the token was signed by us and is unexpired; it does NOT prove our own
 * claims are present or the right type. A token issued by an older version of this service —
 * before `sid` existed, say — would sail through verification and then produce
 * `undefined` where a session id was expected. Validating here turns that into a rejection
 * at the boundary instead of a confusing failure three layers in.
 */
function parseClaims(payload: Record<string, unknown>): VerifiedAccessToken {
  const sub = payload['sub'];
  const jti = payload['jti'];
  const storeId = payload['storeId'];
  const sid = payload['sid'];
  const isStaff = payload['isStaff'];
  const isSuperuser = payload['isSuperuser'];
  const iat = payload['iat'];
  const exp = payload['exp'];

  if (
    typeof sub !== 'string' ||
    typeof jti !== 'string' ||
    typeof storeId !== 'string' ||
    typeof sid !== 'string' ||
    typeof isStaff !== 'boolean' ||
    typeof isSuperuser !== 'boolean' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    throw new InvalidAccessToken();
  }

  return {
    userId: sub,
    tokenId: jti,
    storeId,
    sessionId: sid,
    isStaff,
    isSuperuser,
    issuedAt: new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  };
}
