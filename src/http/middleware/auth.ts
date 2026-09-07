import type { Request, RequestHandler } from 'express';

import { AuthenticationRequired, InvariantViolation } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import type { AuthenticatedUser } from '../types.js';
import { asyncHandler } from '../async-handler.js';
import { requireStore } from './store.js';

/**
 * Access-token authentication.
 *
 * Establishes `req.user` from a verified `Authorization: Bearer` token and nothing else. No
 * new transport is invented here: the scheme, the RS256 algorithm pinning, the claim set, and
 * the single opaque failure mode all live behind the `AccessTokenVerifier` port, implemented
 * by the identity module and supplied by the composition root. This file never imports it.
 *
 * Deliberately NOT in this file:
 *
 *  - **Authorization.** This answers "who are you", never "may you". Scope derivation from
 *    `isStaff`/`isSuperuser` is a separate increment, and mixing the two here would mean every
 *    future permission check had to be threaded through authentication.
 *  - **A revocation check.** Access tokens are stateless and stay valid until `exp`. Adding a
 *    per-request database or Redis lookup would put a dependency in front of every
 *    authenticated route, which is a large architectural change to make as a side effect of
 *    building logout. The trade-off is recorded in docs/DECISIONS.md §20.
 */

/** Bearer scheme prefix, matched case-insensitively per RFC 7235 §2.1. */
const BEARER_PREFIX = /^Bearer /i;

/**
 * What this middleware learns from a token, and deliberately nothing more.
 *
 * The identity module's `VerifiedAccessToken` also carries `isStaff`, `isSuperuser`, `tokenId`,
 * `issuedAt`, and `expiresAt`. This type omits all of them, and the omission is load-bearing
 * twice over:
 *
 *  - **Privilege claims cannot re-enter the HTTP boundary.** §22 removed `isStaff`/`isSuperuser`
 *    from `AuthenticatedUser` so a stale flag could not be trusted by mistake. Narrowing the
 *    verifier's *return* type moves that guarantee one layer earlier: this file cannot read a
 *    privilege claim even if someone tried, because the value never arrives.
 *  - **The HTTP layer stops depending on the identity module.** Mirrors `StoreResolver` in
 *    `store.ts` and `AuthorizationSubjectLoader` in `scope.ts` — a capability, not a service.
 *    Enforced by `.dependency-cruiser.cjs` (`no-http-to-modules`), so the dependency cannot
 *    creep back in unnoticed.
 */
export type VerifiedIdentity = {
  userId: string;
  storeId: string;
  sessionId: string;
};

/**
 * Verify an access token, or throw.
 *
 * Throwing is part of the contract: every failure mode — bad signature, wrong algorithm,
 * expired, wrong issuer or audience, missing claim — is the implementation's to raise, and it
 * raises one opaque error so the reasons stay indistinguishable to a caller.
 */
export type AccessTokenVerifier = (token: string) => Promise<VerifiedIdentity>;

export function requireAuth(deps: {
  verifyAccessToken: AccessTokenVerifier;
  logger: Logger;
}): RequestHandler {
  const { verifyAccessToken, logger } = deps;

  return asyncHandler(async (req, _res, next) => {
    const presented = readBearerToken(req);

    /**
     * A missing or malformed header is `AuthenticationRequired`, not `InvalidAccessToken`.
     *
     * The distinction is safe and useful: "you sent no credential" tells an attacker nothing
     * they did not already know, and it is the difference between a client that forgot the
     * header and one whose token has expired — which are different bugs to fix. Every failure
     * involving an actual token value stays opaque.
     */
    if (presented === null) {
      throw new AuthenticationRequired();
    }

    /**
     * Every verification failure — bad signature, wrong algorithm, expired, wrong issuer,
     * wrong audience, missing claim — surfaces as one `InvalidAccessToken` (401) raised by the
     * token service itself, with the specific reason logged at debug. Not re-wrapped here,
     * because a second error class for the same condition would let the two drift.
     */
    const verified = await verifyAccessToken(presented);

    /**
     * The token's store must match the store this request resolved to.
     *
     * `storeId` is a claim, so it is signed and cannot be edited by the client — but nothing
     * stops a client from taking a legitimately-issued token for store A and presenting it to
     * store B. Without this check that token would authenticate, and every downstream query
     * would be scoped by `req.store` while the identity came from another tenant.
     *
     * Reported as `AuthenticationRequired` rather than a distinct cross-tenant error: telling
     * a caller "that token is valid, just not here" confirms the token is real.
     */
    const store = requireStore(req);
    if (verified.storeId !== store.id) {
      logger.warn(
        { storeId: store.id, tokenStoreId: verified.storeId, userId: verified.userId },
        'auth_rejected_store_mismatch',
      );
      throw new AuthenticationRequired();
    }

    /**
     * Identity only. The token's `isStaff`/`isSuperuser` claims are deliberately dropped
     * here rather than carried forward — see the note on `AuthenticatedUser`. Authorization reads
     * the database through `requireScope`, so a stale privilege claim is never in scope to be
     * trusted by accident.
     */
    req.user = {
      id: verified.userId,
      storeId: verified.storeId,
      sessionId: verified.sessionId,
    };

    next();
  });
}

/**
 * Extract the bearer token, or null if there is not exactly one well-formed header.
 *
 * Returns null rather than throwing so the caller owns the error, and treats every malformed
 * shape identically — an empty value, a `Basic` credential, or a bare token with no scheme are
 * all "no bearer token present".
 */
function readBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (typeof header !== 'string' || !BEARER_PREFIX.test(header)) return null;

  const value = header.replace(BEARER_PREFIX, '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Read the authenticated user, failing loudly if `requireAuth` was not mounted.
 *
 * Mirrors `requireStore`. The optionality of `req.user` is real — most routes are public — so
 * a handler that needs it must say so, and a route wired without the middleware must fail with
 * a diagnosable message rather than a `TypeError` on `.id` three lines later.
 *
 * `InvariantViolation` (500), deliberately not a 401: a router mounted without its middleware
 * is OUR bug, and reporting it as an authentication failure would send the caller off to check
 * their token while the real fault sits in the composition root.
 */
export function requireUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new InvariantViolation(
      'req.user is missing; this route was mounted without requireAuth() middleware',
    );
  }
  return req.user;
}
