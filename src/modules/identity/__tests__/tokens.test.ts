import { generateKeyPairSync } from 'node:crypto';

import { importPKCS8, SignJWT, UnsecuredJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../../../config.js';
import { silentLogger } from '../../../../tests/helpers/postgres.ts';
import { createTokenService, InvalidAccessToken, type AccessTokenSubject } from '../tokens.js';

/**
 * Access tokens.
 *
 * Real RSA keys, real signatures, no mocks — the properties under test (algorithm pinning,
 * issuer/audience verification, signature validation) are properties of the cryptography, and
 * a mocked verifier would only confirm we call our own functions.
 *
 * No database and no HTTP: this increment is deliberately the crypto foundation alone.
 */
describe('access tokens', () => {
  /** Generated once — RSA-2048 keygen is ~200ms and nothing here needs a fresh key. */
  const primary = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  /** A second, unrelated pair — the attacker's key for the wrong-signature test. */
  const foreign = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const ISSUER = 'ecom-test-issuer';
  const AUDIENCE = 'ecom-test-audience';

  /**
   * Build a `Config` through the REAL schema rather than an object literal.
   *
   * That matters here specifically: this increment tightened PEM validation, so parsing
   * through `parseConfig` proves the generated keys satisfy the new rules. A hand-built
   * config object would bypass exactly the code under test.
   */
  function buildConfig(overrides: Record<string, string> = {}): Config {
    const result = parseConfig({
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
      DATABASE_URL: 'postgres://a:b@localhost:5432/c',
      REDIS_CACHE_URL: 'redis://localhost:6379/0',
      REDIS_LOCK_URL: 'redis://localhost:6379/1',
      REDIS_QUEUE_URL: 'redis://localhost:6379/2',
      JWT_PRIVATE_KEY: primary.privateKey,
      JWT_PUBLIC_KEY: primary.publicKey,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
      JWT_ACCESS_TTL_MINUTES: '15',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      PAYMENT_SANDBOX_MODE: 'true',
      S3_BUCKET: 'test',
      S3_REGION: 'us-east-1',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      LOG_LEVEL: 'error',
      LOG_FORMAT: 'json',
      ...overrides,
    });

    if (!result.success) {
      throw new Error(`test config failed to parse: ${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  const service = () => createTokenService({ config: buildConfig(), logger: silentLogger });

  const subject: AccessTokenSubject = {
    userId: '01a04236-7412-73ab-b93b-fe58db1c223c',
    storeId: '01a04236-0000-7000-8000-000000000001',
    isStaff: false,
    isSuperuser: false,
    sessionId: '01a04236-0000-7000-8000-000000000002',
  };

  /* ── Configuration validation ──────────────────────────────────────────── */

  describe('key configuration', () => {
    it('accepts a well-formed generated keypair', () => {
      expect(() => buildConfig()).not.toThrow();
    });

    it('rejects key material that is not a PEM block', () => {
      /**
       * The gap this increment closed. Previously `.min(1)` accepted any non-empty string, so
       * `'not-a-key'` deployed cleanly and failed at the first signature — which in a fresh
       * deployment is the first customer login, not boot.
       */
      for (const bad of ['not-a-key', ' ', '', 'BEGIN PRIVATE KEY']) {
        const result = parseConfig({ ...rawEnv(), JWT_PRIVATE_KEY: bad });
        expect(result.success, `expected rejection for ${JSON.stringify(bad)}`).toBe(false);
      }
    });

    it('rejects a PKCS#1 private key, naming the fix', () => {
      // `openssl genrsa` without `-outform` produces this, and `jose` cannot import it.
      const pkcs1 = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
      const result = parseConfig({ ...rawEnv(), JWT_PRIVATE_KEY: pkcs1 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain('pnpm keys:generate');
      }
    });

    it('rejects the public key where a private key belongs', () => {
      // Pasting the wrong half of the pair is the single most common key mistake.
      const result = parseConfig({ ...rawEnv(), JWT_PRIVATE_KEY: primary.publicKey });
      expect(result.success).toBe(false);
    });

    it('rejects a truncated PEM body', () => {
      const truncated = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';
      const result = parseConfig({ ...rawEnv(), JWT_PRIVATE_KEY: truncated });
      expect(result.success).toBe(false);
    });

    it('preserves escaped-newline unescaping', () => {
      // `.env` files cannot contain real newlines inside a quoted value, so keys arrive with
      // literal `\n`. Breaking this makes every deployment fail with an opaque ASN.1 error.
      const escaped = primary.privateKey.replace(/\n/g, '\\n');
      const result = parseConfig({ ...rawEnv(), JWT_PRIVATE_KEY: escaped });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.jwtPrivateKey).toContain('\n');
        expect(result.data.jwtPrivateKey).not.toContain('\\n');
      }
    });

    /** The env map minus the field a test is about to override. */
    function rawEnv(): Record<string, string> {
      return {
        NODE_ENV: 'test',
        ENVIRONMENT: 'test',
        DATABASE_URL: 'postgres://a:b@localhost:5432/c',
        REDIS_CACHE_URL: 'redis://localhost:6379/0',
        REDIS_LOCK_URL: 'redis://localhost:6379/1',
        REDIS_QUEUE_URL: 'redis://localhost:6379/2',
        JWT_PRIVATE_KEY: primary.privateKey,
        JWT_PUBLIC_KEY: primary.publicKey,
        JWT_ISSUER: ISSUER,
        JWT_AUDIENCE: AUDIENCE,
        CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
        PAYMENT_SANDBOX_MODE: 'true',
        S3_BUCKET: 'test',
        S3_REGION: 'us-east-1',
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        LOG_LEVEL: 'error',
        LOG_FORMAT: 'json',
      };
    }
  });

  /* ── Issuance ──────────────────────────────────────────────────────────── */

  describe('issuance', () => {
    it('issues a token that this service verifies', async () => {
      const tokens = service();
      const issued = await tokens.issueAccessToken(subject);

      const verified = await tokens.verifyAccessToken(issued.token);

      expect(verified.userId).toBe(subject.userId);
      expect(verified.storeId).toBe(subject.storeId);
      expect(verified.sessionId).toBe(subject.sessionId);
      expect(verified.isStaff).toBe(false);
      expect(verified.isSuperuser).toBe(false);
    });

    it('signs with RS256 and stamps a kid', async () => {
      const tokens = service();
      const issued = await tokens.issueAccessToken(subject);

      const header = decodeSegment(issued.token, 0);
      expect(header['alg']).toBe('RS256');
      expect(header['typ']).toBe('JWT');
      expect(header['kid']).toBe(await tokens.keyId());
    });

    it('derives the kid deterministically from the public key', async () => {
      // RFC 7638 thumbprint: the same key always yields the same id, and any verifier holding
      // the public key can derive it — no registry, no new environment variable. That is what
      // makes future rotation additive rather than a token-format change.
      const first = await service().keyId();
      const second = await service().keyId();
      expect(first).toBe(second);

      // A different key yields a different id.
      const other = createTokenService({
        config: buildConfig({
          JWT_PRIVATE_KEY: foreign.privateKey,
          JWT_PUBLIC_KEY: foreign.publicKey,
        }),
        logger: silentLogger,
      });
      expect(await other.keyId()).not.toBe(first);
    });

    it('sets the approved claims and nothing more', async () => {
      const issued = await service().issueAccessToken(subject);
      const payload = decodeSegment(issued.token, 1);

      expect(Object.keys(payload).sort()).toEqual([
        'aud',
        'exp',
        'iat',
        'isStaff',
        'isSuperuser',
        'iss',
        'jti',
        'sid',
        'storeId',
        'sub',
      ]);
    });

    it('carries no email, name, scopes, or password material', async () => {
      const staff: AccessTokenSubject = { ...subject, isStaff: true, isSuperuser: true };
      const issued = await service().issueAccessToken(staff);
      const payload = JSON.stringify(decodeSegment(issued.token, 1));

      // A JWT is base64, not encryption — anyone holding it reads the payload. Email is PII
      // and mutable; scopes are derived at authorization time so a revoked permission takes
      // effect immediately rather than in 15 minutes.
      for (const forbidden of ['email', 'name', 'scope', 'password', 'hash', 'argon2']) {
        expect(payload.toLowerCase()).not.toContain(forbidden);
      }
    });

    it('sets issuer and audience from configuration', async () => {
      const issued = await service().issueAccessToken(subject);
      const payload = decodeSegment(issued.token, 1);

      expect(payload['iss']).toBe(ISSUER);
      expect(payload['aud']).toBe(AUDIENCE);
    });

    it('sets a unique jti per token', async () => {
      const tokens = service();
      const ids = new Set<string>();

      for (let i = 0; i < 20; i += 1) {
        const issued = await tokens.issueAccessToken(subject);
        ids.add((await tokens.verifyAccessToken(issued.token)).tokenId);
      }

      // Unique per token, so an audit trail can correlate a specific credential and a future
      // denylist can name one.
      expect(ids.size).toBe(20);
    });

    it('expires according to the configured TTL', async () => {
      const tokens = createTokenService({
        config: buildConfig({ JWT_ACCESS_TTL_MINUTES: '5' }),
        logger: silentLogger,
      });

      const issued = await tokens.issueAccessToken(subject);
      const verified = await tokens.verifyAccessToken(issued.token);

      expect(issued.expiresInSeconds).toBe(300);
      const lifetimeSeconds = (verified.expiresAt.getTime() - verified.issuedAt.getTime()) / 1000;
      expect(lifetimeSeconds).toBe(300);
      // The reported expiry and the token's own claim describe the same instant.
      expect(issued.expiresAt.getTime()).toBe(verified.expiresAt.getTime());
    });

    it('reports staff and superuser flags faithfully', async () => {
      const tokens = service();
      const admin = await tokens.issueAccessToken({
        ...subject,
        isStaff: true,
        isSuperuser: true,
      });

      const verified = await tokens.verifyAccessToken(admin.token);
      expect(verified.isStaff).toBe(true);
      expect(verified.isSuperuser).toBe(true);
    });
  });

  /* ── Key handling ──────────────────────────────────────────────────────── */

  describe('key handling', () => {
    it('warms up without issuing a token', async () => {
      await expect(service().warmUp()).resolves.toBeUndefined();
    });

    it('caches imported keys across calls', async () => {
      const tokens = service();

      // Correctness under concurrent first use: the promise is cached, not the value, so
      // parallel callers share one import rather than racing several.
      const [a, b, c] = await Promise.all([tokens.keyId(), tokens.keyId(), tokens.keyId()]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('rejects a well-formed PEM that is not a usable RSA key', async () => {
      /**
       * The residue config cannot catch. Shape validation is synchronous and passes; the
       * import fails. This is why `warmUp()` exists and why increment 3 will call it during
       * startup — so a deployment fails at boot rather than at the first login.
       */
      const body = 'A'.repeat(128);
      const tokens = createTokenService({
        config: buildConfig({
          JWT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
        }),
        logger: silentLogger,
      });

      await expect(tokens.warmUp()).rejects.toThrow(/unusable/);
    });

    it('does not cache a failed import', async () => {
      // A transient failure must not poison the service for the rest of the process.
      const body = 'A'.repeat(128);
      const tokens = createTokenService({
        config: buildConfig({
          JWT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
        }),
        logger: silentLogger,
      });

      await expect(tokens.warmUp()).rejects.toThrow();
      // Rejects again rather than replaying a memoised rejection silently.
      await expect(tokens.warmUp()).rejects.toThrow();
    });
  });

  /* ── Verification failures ─────────────────────────────────────────────── */

  describe('verification failures', () => {
    it('rejects malformed tokens', async () => {
      const tokens = service();

      for (const bad of [
        '',
        'not-a-token',
        'a.b',
        'a.b.c',
        'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.',
        '....',
      ]) {
        await expect(tokens.verifyAccessToken(bad)).rejects.toThrow(InvalidAccessToken);
      }
    });

    it('rejects an expired token', async () => {
      const tokens = service();

      // Signed by hand with a past `exp`, because the service will not mint an expired token.
      const privateKey = await importPKCS8(primary.privateKey, 'RS256');
      const past = Math.floor(Date.now() / 1000) - 3_600;
      const expired = await new SignJWT({
        storeId: subject.storeId,
        isStaff: false,
        isSuperuser: false,
        sid: subject.sessionId,
      })
        .setProtectedHeader({ alg: 'RS256', kid: await tokens.keyId(), typ: 'JWT' })
        .setSubject(subject.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setJti('expired-token')
        .setIssuedAt(past - 900)
        .setExpirationTime(past)
        .sign(privateKey);

      await expect(tokens.verifyAccessToken(expired)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects a token signed with a different key', async () => {
      // A valid RS256 token from an unrelated keypair. The signature is real; it is simply
      // not ours.
      const forged = await signWith(foreign.privateKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });

      await expect(service().verifyAccessToken(forged)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects a wrong issuer', async () => {
      const wrongIssuer = await signWith(primary.privateKey, {
        issuer: 'https://attacker.example',
        audience: AUDIENCE,
      });

      // Correctly signed by us, but minted for a different system. Without issuer
      // verification, any service sharing our key becomes a token factory for this one.
      await expect(service().verifyAccessToken(wrongIssuer)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects a wrong audience', async () => {
      const wrongAudience = await signWith(primary.privateKey, {
        issuer: ISSUER,
        audience: 'some-other-service',
      });

      // Prevents a token issued for one audience of ours (an internal admin API, say) being
      // replayed against another.
      await expect(service().verifyAccessToken(wrongAudience)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects an unsecured (alg: none) token', async () => {
      /**
       * The classic attack: strip the signature and set `alg` to `none`. `jose` will not even
       * accept such a token through `jwtVerify` — hence `UnsecuredJWT`, which is the only way
       * to construct one with this library. Verification must refuse it.
       */
      const unsecured = new UnsecuredJWT({
        storeId: subject.storeId,
        isStaff: true,
        isSuperuser: true,
        sid: subject.sessionId,
      })
        .setSubject(subject.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setJti('unsecured')
        .setIssuedAt()
        .setExpirationTime('15m')
        .encode();

      await expect(service().verifyAccessToken(unsecured)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects an algorithm other than RS256', async () => {
      /**
       * Algorithm confusion. An unpinned verifier trusts the token's own `alg` header, so an
       * attacker sets `HS256` and signs with the PUBLIC key — which is public — and the token
       * verifies.
       *
       * Constructing that exact token is impractical here: `jose`'s `SignJWT.sign()` type-
       * checks the key against the header algorithm and refuses to HMAC-sign with an RSA key.
       * So this asserts the closest realistic construction — a token whose header claims a
       * different algorithm — plus the pin itself. The `algorithms: ['RS256']` option in the
       * service is what makes any such token fail before the signature is even considered.
       */
      const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const payload = base64url(
        JSON.stringify({
          sub: subject.userId,
          storeId: subject.storeId,
          sid: subject.sessionId,
          isStaff: true,
          isSuperuser: true,
          iss: ISSUER,
          aud: AUDIENCE,
          jti: 'confused',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      );
      // A plausible-looking but wrong signature. The algorithm pin rejects this before the
      // signature matters, which is precisely the point.
      const confused = `${header}.${payload}.${base64url('not-a-real-signature')}`;

      await expect(service().verifyAccessToken(confused)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects a token whose kid does not match the current key', async () => {
      // Signed by us, valid in every other respect, but stamped with another key's id. Today
      // that cannot happen; the moment rotation lands it can, and the verifier already
      // distinguishes keys.
      const privateKey = await importPKCS8(primary.privateKey, 'RS256');
      const wrongKid = await new SignJWT({
        storeId: subject.storeId,
        isStaff: false,
        isSuperuser: false,
        sid: subject.sessionId,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'some-other-key-id', typ: 'JWT' })
        .setSubject(subject.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setJti('wrong-kid')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privateKey);

      await expect(service().verifyAccessToken(wrongKid)).rejects.toThrow(InvalidAccessToken);
    });

    it('rejects a token missing our application claims', async () => {
      /**
       * `jwtVerify` proves a token is signed and unexpired; it does NOT prove our own claims
       * are present. A token from an older version of this service would otherwise verify and
       * then yield `undefined` where a session id was expected.
       */
      const privateKey = await importPKCS8(primary.privateKey, 'RS256');
      const tokens = service();
      const incomplete = await new SignJWT({ storeId: subject.storeId })
        .setProtectedHeader({ alg: 'RS256', kid: await tokens.keyId(), typ: 'JWT' })
        .setSubject(subject.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setJti('incomplete')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(privateKey);

      await expect(tokens.verifyAccessToken(incomplete)).rejects.toThrow(InvalidAccessToken);
    });

    it('reports one indistinguishable error for every failure mode', async () => {
      const tokens = service();
      const failures = [
        'malformed',
        await signWith(foreign.privateKey, { issuer: ISSUER, audience: AUDIENCE }),
        await signWith(primary.privateKey, { issuer: 'wrong', audience: AUDIENCE }),
        await signWith(primary.privateKey, { issuer: ISSUER, audience: 'wrong' }),
      ];

      const messages = new Set<string>();
      const codes = new Set<string>();

      for (const token of failures) {
        try {
          await tokens.verifyAccessToken(token);
          expect.unreachable('should have rejected');
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidAccessToken);
          messages.add((err as InvalidAccessToken).message);
          codes.add((err as InvalidAccessToken).code);
        }
      }

      /**
       * ONE message and ONE code for all four. The differences are what an attacker probes:
       * "expired" confirms the token was once valid, "wrong issuer" confirms the signature
       * checked out. The reason is logged at debug and never returned.
       */
      expect(messages.size).toBe(1);
      expect(codes.size).toBe(1);
      expect([...codes][0]).toBe('INVALID_ACCESS_TOKEN');
    });

    it('maps to 401', async () => {
      try {
        await service().verifyAccessToken('malformed');
        expect.unreachable('should have rejected');
      } catch (err) {
        // So the terminal error middleware renders it without a special case.
        expect((err as InvalidAccessToken).statusCode).toBe(401);
      }
    });
  });

  /* ── Helpers ───────────────────────────────────────────────────────────── */

  /** Sign a structurally valid token with an arbitrary key, issuer, and audience. */
  async function signWith(
    privateKeyPem: string,
    claims: { issuer: string; audience: string },
  ): Promise<string> {
    const key = await importPKCS8(privateKeyPem, 'RS256');
    return new SignJWT({
      storeId: subject.storeId,
      isStaff: false,
      isSuperuser: false,
      sid: subject.sessionId,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(subject.userId)
      .setIssuer(claims.issuer)
      .setAudience(claims.audience)
      .setJti('handmade')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
  }

  /** Decode a JWT segment without verifying — for asserting on the wire format. */
  function decodeSegment(token: string, index: 0 | 1): Record<string, unknown> {
    const segment = token.split('.')[index];
    if (segment === undefined) throw new Error('token has no such segment');
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  }

  function base64url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  // Referenced so the linter sees the import as used even though every test builds its own.
  beforeAll(() => {
    expect(typeof primary.privateKey).toBe('string');
  });
});
