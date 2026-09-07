import { Router, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import {
  RATE_LIMIT_BUCKETS,
  rateLimitByEmail,
  rateLimitByIp,
} from '../../http/middleware/rate-limit.js';
import { requireAuth, requireUser } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedBody } from '../../http/validate.js';
import type { RateLimiter, RateLimitPolicy } from '../../redis/rate-limiter.js';
import type { Logger } from '../../shared/logger.js';
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  ForgotPasswordRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  UpdateProfileRequestSchema,
  toUserResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type ForgotPasswordRequest,
  type RegisterRequest,
  type ResetPasswordRequest,
  RefreshRequestSchema,
  type RefreshRequest,
  type UpdateProfileRequest,
} from './dto.js';
import type { IdentityService } from './identity.service.js';
import type { TokenService } from './tokens.js';

/**
 * The identity module's HTTP surface.
 *
 * Mounted by the composition root under the API router, which is itself mounted at
 * `/api/v1` — so `POST /auth/register` here is reachable as `POST /api/v1/auth/register`.
 * The version prefix lives in exactly one place (`app.ts`) so it cannot drift between
 * modules.
 *
 * Handlers translate HTTP and nothing else: validate, read the resolved store, delegate,
 * serialise. There is no `if` about business state in this file — the service owns those,
 * which is what lets registration be driven from a CLI or a test without going through
 * Express.
 */

export function createIdentityRoutes(deps: {
  identity: IdentityService;
  /**
   * Needed by `requireAuth` on the logout route.
   *
   * Required rather than optional: an authenticated endpoint that silently mounted without
   * verification would be an open door, so a caller that cannot supply a token service does
   * not get this router at all.
   */
  tokens: TokenService;
  /** Used by `requireAuth`. Separate from the rate-limit logger, which may be absent. */
  logger: Logger;
  /**
   * Rate limiting, optional so existing tests can mount the router without Redis.
   *
   * When absent the endpoints are UNPROTECTED, which is correct for a unit test asserting
   * handler behaviour and would be a serious defect in production — so the composition root
   * always supplies it, and `container.integration.test.ts` asserts that it does.
   */
  rateLimit?: {
    limiter: RateLimiter;
    ipPolicy: RateLimitPolicy;
    emailPolicy: RateLimitPolicy;
    /**
     * Refresh gets its OWN per-IP policy, much more generous than login's.
     *
     * Refresh is a scheduled background call rather than a human action: every active client
     * rotates every ~15 minutes, so one NAT gateway legitimately produces far more refreshes
     * than logins. Reusing `ipPolicy` here would throttle the largest customers first, and it
     * would present to them as a random forced logout.
     *
     * Optional so a caller that omits it simply gets no refresh limiting, matching how the
     * whole `rateLimit` block behaves.
     */
    refreshPolicy?: RateLimitPolicy;
    logger: Logger;
  };
}): Router {
  const { identity, tokens, logger, rateLimit } = deps;
  const router = Router();

  /**
   * Adapt the token service to the HTTP layer's narrow verifier port.
   *
   * An arrow, not the bare method: `verifyAccessToken` is declared with method shorthand, so
   * passing it detached carries no `this`-safety guarantee — the same trap the scope guards hit.
   *
   * The port returns less than the service does. `VerifiedAccessToken` carries the privilege
   * claims; `VerifiedIdentity` does not, so they cannot reach the authentication middleware at
   * all. Authorization reads them fresh from the database instead.
   */
  const auth = requireAuth({
    verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
    logger,
  });

  /**
   * Build the limiter chain for one endpoint, or nothing when rate limiting is not wired.
   *
   * Returned as an array and spread into `router.post`, because Express treats an empty array
   * as "no middleware" — which keeps the route definitions below readable instead of
   * branching around two different `router.post` calls per endpoint.
   */
  const limiters = (options: {
    ipBucket: string;
    email: boolean;
    /** Which per-email bucket. Defaults to login's, which is what login and nothing else wants. */
    emailBucket?: string | undefined;
    /** Override the per-IP policy. Refresh uses its own; login and register share the default. */
    ipPolicy?: RateLimitPolicy | undefined;
  }): RequestHandler[] => {
    if (!rateLimit) return [];
    const { limiter, ipPolicy, emailPolicy, logger } = rateLimit;

    const chain: RequestHandler[] = [
      rateLimitByIp({
        limiter,
        policy: options.ipPolicy ?? ipPolicy,
        bucket: options.ipBucket,
        logger,
      }),
    ];

    if (options.email) {
      chain.push(
        rateLimitByEmail({
          limiter,
          policy: emailPolicy,
          bucket: options.emailBucket ?? RATE_LIMIT_BUCKETS.loginEmail,
          logger,
        }),
      );
    }

    return chain;
  };

  /**
   * POST /auth/register
   *
   * 201 with the created user. No tokens: registering and signing in are separate
   * operations, and issuing a session here would be half of an unbuilt login.
   *
   * Rate limited by IP only. Registration also runs Argon2 — at the higher HASHING cost, not
   * the verification cost — so it is the same CPU-exhaustion vector as login, and it is a
   * signup-spam vector besides. There is no per-email budget because a per-address limit on
   * registration would let an attacker who guesses an address block its real owner from ever
   * signing up.
   */
  router.post(
    '/auth/register',
    ...limiters({ ipBucket: RATE_LIMIT_BUCKETS.registerIp, email: false }),
    validate({ body: RegisterRequestSchema }),
    asyncHandler(async (req, res) => {
      // Throws an InvariantViolation (500) if the router was mounted without
      // `resolveStore` — a wiring bug, which must not be reported as a client error.
      const store = requireStore(req);

      const user = await identity.registerCustomer({
        storeId: store.id,
        // Reads `req.validated.body`, never `req.body`: the raw body has not been through a
        // schema, and the two are kept in different places precisely so this is visible.
        input: validatedBody<RegisterRequest>(req),
      });

      // `toUserResponse` is an allowlist, so `passwordHash` cannot reach a response even if
      // the repository were later changed to select it.
      res.status(201).json({ user: toUserResponse(user) });
    }),
  );

  /**
   * POST /auth/forgot-password
   *
   * **204, always.** An unknown address, a deactivated account and a real one are
   * indistinguishable, because any difference here is an account-existence oracle: anyone
   * could test an address list against this endpoint and learn who shops here.
   *
   * That makes rate limiting the actual defence, and it is applied on both dimensions — per IP
   * so the endpoint cannot be swept, and per EMAIL so one customer's inbox cannot be flooded
   * with reset mail by someone who knows their address.
   *
   * No body in the response, and nothing about whether a mail was queued. A client cannot
   * usefully act on that information and an attacker very much can.
   */
  router.post(
    '/auth/forgot-password',
    ...limiters({
      ipBucket: RATE_LIMIT_BUCKETS.forgotPasswordIp,
      email: true,
      emailBucket: RATE_LIMIT_BUCKETS.forgotPasswordEmail,
    }),
    validate({ body: ForgotPasswordRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      await identity.requestPasswordReset({
        storeId: store.id,
        email: validatedBody<ForgotPasswordRequest>(req).email,
      });
      res.status(204).send();
    }),
  );

  /**
   * POST /auth/reset-password
   *
   * 204 on success. The customer must sign in with the new password afterwards — no tokens are
   * issued here, for the same reason registration issues none: completing a reset and
   * establishing a session are separate operations, and handing out a session would make this
   * endpoint a login that skipped the password check it just replaced.
   *
   * **Every existing session is revoked.** A reset is the recovery path for an account whose
   * owner may have lost control of it, so leaving an attacker's refresh session alive would
   * defeat the point of resetting.
   *
   * Rate limited per IP only — the request carries a token rather than an address, so there is
   * no per-account key to bucket on, and guessing a 256-bit token is not a threat a counter
   * defends against. The limit is there to cap the Argon2 hashing cost of a flood.
   *
   * `400 INVALID_RESET_TOKEN` covers every failure: unknown, malformed, expired, already used,
   * minted for another store, or belonging to an account since deactivated.
   */
  router.post(
    '/auth/reset-password',
    ...limiters({ ipBucket: RATE_LIMIT_BUCKETS.resetPasswordIp, email: false }),
    validate({ body: ResetPasswordRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      await identity.resetPassword({
        storeId: store.id,
        input: validatedBody<ResetPasswordRequest>(req),
      });
      res.status(204).send();
    }),
  );

  /**
   * POST /auth/login
   *
   * 200 with the user, an access token, and an opaque refresh token.
   *
   * The two pieces of request METADATA are extracted here, in the HTTP layer, and handed to
   * the service as plain values — the service never sees an Express object.
   *
   * Middleware order here is load-bearing:
   *
   *   resolveStore (mounted by the composition root, on the API router)
   *     -> rateLimitByIp     counts every attempt, caps CPU
   *     -> rateLimitByEmail  checks the failure budget, counts nothing
   *     -> validate          400 on a malformed body
   *     -> handler           Argon2 runs here, and only here
   *
   * Both limiters run BEFORE validation, on purpose. A flood of malformed bodies is still a
   * flood, and validating first would let an attacker burn our CPU on Zod parsing without
   * ever touching their budget. `resolveStore` must precede both, because the per-email
   * subject includes the store id.
   */
  router.post(
    '/auth/login',
    ...limiters({ ipBucket: RATE_LIMIT_BUCKETS.loginIp, email: true }),
    validate({ body: LoginRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const response = await identity.login({
        storeId: store.id,
        input: validatedBody<LoginRequest>(req),
        /**
         * `req.get` is case-insensitive and returns undefined when absent. Normalised to
         * null rather than passed through, so the service has one shape to handle and the
         * column gets a real NULL rather than the string "undefined".
         */
        userAgent: req.get('user-agent') ?? null,
        /**
         * `req.ip`, NOT a hand-parsed `X-Forwarded-For`.
         *
         * `app.ts` already sets `trust proxy: 1`, which is the application's declared trust
         * boundary: Express derives `req.ip` from exactly one forwarded hop. Parsing the
         * header here would either duplicate that logic or — worse — trust hops the rest of
         * the app deliberately does not.
         */
        ipAddress: req.ip ?? null,
      });

      res.status(200).json(response);
    }),
  );

  /**
   * POST /auth/refresh
   *
   * 200 with a NEW access token and a NEW refresh token. The presented token is dead
   * afterwards.
   *
   * The refresh token arrives in the JSON BODY, not a cookie. That follows the convention
   * login already set — it returns `refreshToken` in its response body — and the project has
   * no cookie dependency, no `res.cookie` call, and no CSRF protection. A browser
   * automatically attaching a refresh cookie to a cross-site request is precisely the attack
   * a body-carried token cannot suffer.
   *
   * Rate limited by IP only, with its own generous policy. There is deliberately no per-email
   * limiter: the request carries no email, so there is nothing to key on, and guessing a
   * 256-bit token is not a threat that a counter defends against anyway. What the per-IP limit
   * does defend is the write amplification of a client — or an attacker holding one stolen
   * token — spinning rotations as fast as the network allows.
   */
  router.post(
    '/auth/refresh',
    ...limiters({
      ipBucket: RATE_LIMIT_BUCKETS.refreshIp,
      email: false,
      ipPolicy: rateLimit?.refreshPolicy,
    }),
    validate({ body: RefreshRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const response = await identity.refresh({
        storeId: store.id,
        input: validatedBody<RefreshRequest>(req),
        /**
         * Recorded on the REPLACEMENT session, so "your devices" reflects where the session is
         * being used now rather than where it was first created. Same normalisation as login:
         * `req.get` for the header, `req.ip` for the address — never a hand-parsed
         * `X-Forwarded-For`, because `trust proxy: 1` is the application's declared boundary.
         */
        userAgent: req.get('user-agent') ?? null,
        ipAddress: req.ip ?? null,
      });

      res.status(200).json(response);
    }),
  );

  /**
   * POST /auth/logout
   *
   * 204, and the only authenticated endpoint in the module.
   *
   * NO REQUEST BODY. The session to revoke comes from the access token's `sid` claim, which is
   * signed — so a caller can only ever log out the session they are actually holding. Accepting
   * a session id, family id, or refresh token in the body would let any authenticated caller
   * revoke sessions belonging to other users by guessing or observing an id.
   *
   * Not rate limited, deliberately, and consistent with the existing policy: the limiters guard
   * UNAUTHENTICATED endpoints that run Argon2. This one requires a valid signed token to reach
   * at all, and does a single indexed UPDATE. A caller spamming it is revoking their own
   * already-revoked session, which costs one query and achieves nothing.
   */
  router.post(
    '/auth/logout',
    auth,
    asyncHandler(async (req, res) => {
      const user = requireUser(req);

      await identity.logout({
        // Both from the verified token, never from the request. `requireAuth` has already
        // confirmed the token's store matches the resolved store.
        storeId: user.storeId,
        sessionId: user.sessionId,
      });

      /**
       * 204, matching the "no useful body" convention rather than inventing a
       * `{ "success": true }` envelope the project uses nowhere else.
       *
       * The SAME 204 whether rows were revoked or none were. A body reporting a count, or a 404
       * for an already-revoked session, would tell a caller whether their session was still
       * live — session state a successful logout has no reason to disclose, and which would
       * make the endpoint a probe for whether a stolen token's family had been revoked.
       */
      res.status(204).send();
    }),
  );

  /**
   * GET /users/me
   *
   * 200 with the authenticated user's CURRENT public profile, read from the database.
   *
   * NO parameters of any kind — no path segment, no query string, no body. `me` is not a
   * placeholder for an id: the user is determined entirely by the `sub` claim of the verified
   * access token. That is why no enumeration is possible here, and it is a stronger guarantee
   * than validating a supplied id would be, because there is nothing to validate.
   *
   * `resolveStore` is NOT mounted again. It already runs for every `/api/v1` route on the API
   * router in the composition root, and `requireAuth` depends on it having done so — it
   * compares the token's `storeId` claim against the resolved store.
   *
   *   resolveStore (API router)  ->  requireAuth  ->  handler
   *
   * Not rate limited, consistent with logout and with the existing policy: the limiters guard
   * unauthenticated endpoints that run Argon2. This needs a valid signed token to reach and
   * performs one primary-key read.
   */
  router.get(
    '/users/me',
    auth,
    asyncHandler(async (req, res) => {
      const user = requireUser(req);

      const current = await identity.getCurrentUser({
        // Both from the verified token. `requireAuth` has already confirmed the token's store
        // matches the store this request resolved to, so these cannot disagree.
        storeId: user.storeId,
        userId: user.id,
      });

      /**
       * `toUserResponse` — the SAME mapper register and login use, not a second shape.
       *
       * It is an allowlist, so the eight non-public columns on `app_user` (`passwordHash`,
       * `storeId`, `isActive`, `isStaff`, `isSuperuser`, `phoneVerifiedAt`, `lastLoginAt`,
       * `deletedAt`) cannot reach a response even though `findSubjectById` selects three of
       * them for the domain check above.
       *
       * Wrapped in `{ user }`, matching the registration response envelope.
       */
      res.status(200).json({ user: toUserResponse(current) });
    }),
  );

  /**
   * PATCH /users/me
   *
   * 200 with the authenticated user's updated public profile.
   *
   * SELF-ONLY, and structurally so. Like `GET /users/me`, there is no path segment, no query
   * string, and no body field naming a user — `me` is not a placeholder for an id. The subject
   * is the `sub` claim of the verified access token, which is why no user can edit another and
   * there is nothing to validate in order to guarantee it.
   *
   * NO scope guard, deliberately. This is a user editing themselves, not staff editing a
   * customer; `requireScope('staff')` here would lock every customer out of their own profile.
   *
   *   resolveStore (API router)  ->  requireAuth  ->  validate(body)  ->  handler
   *
   * Three fields are writable. Everything else on `app_user` — `email`, `isStaff`,
   * `isSuperuser`, `storeId`, `passwordHash`, `isActive`, `phone`, the verification timestamps
   * — is rejected by the strict schema with a 400 naming the field, not silently dropped.
   *
   * Not rate limited, consistent with `GET /users/me` and logout: the limiters guard
   * unauthenticated endpoints that run Argon2. This needs a valid signed token and performs
   * one primary-key write.
   */
  router.patch(
    '/users/me',
    auth,
    validate({ body: UpdateProfileRequestSchema }),
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const input = validatedBody<UpdateProfileRequest>(req);

      const updated = await identity.updateProfile({
        // Both from the verified token, never from the request body.
        storeId: user.storeId,
        userId: user.id,
        input,
      });

      // The SAME mapper and the SAME envelope as register, login, and `GET /users/me`. An
      // allowlist, so `passwordHash` and the seven other non-public columns cannot reach a
      // response even though `updateUserProfile` selects three of them for the check above.
      res.status(200).json({ user: toUserResponse(updated) });
    }),
  );

  /**
   * POST /users/me/password
   *
   * 204 on success. The authenticated user changes their own password, and every refresh
   * session they hold is revoked.
   *
   * SELF-ONLY for the same structural reason as the two routes above: the subject is the
   * token's `sub` claim, and the body carries only the two passwords. A caller cannot name an
   * account, so this endpoint cannot be aimed at one.
   *
   *   resolveStore (API router)  ->  requireAuth  ->  validate(body)  ->  handler
   *
   * A POST rather than a PATCH, and a sub-resource rather than a field on `PATCH /users/me`.
   * Changing a password is an ACTION with side effects — it verifies a credential and cuts
   * every session — not a field assignment, and the project already draws that line for
   * product `publish`/`archive` (§26). Folding it into the profile PATCH would also mean one
   * request could half-succeed across two very different kinds of change.
   *
   * NOT rate limited here, matching the existing policy: the limiters guard UNAUTHENTICATED
   * endpoints, and reaching this one already requires a valid signed access token. Noted
   * honestly rather than silently — it does run Argon2 twice (one verify, one hash), so an
   * authenticated caller can spend server CPU. The existing per-IP limiter on the API surface
   * still applies; a dedicated budget for authenticated password changes is a rate-limiting
   * decision, not part of this increment.
   */
  router.post(
    '/users/me/password',
    auth,
    validate({ body: ChangePasswordRequestSchema }),
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const input = validatedBody<ChangePasswordRequest>(req);

      await identity.changePassword({
        storeId: user.storeId,
        userId: user.id,
        input,
      });

      /**
       * 204 with NO body, matching logout rather than inventing a `{ "success": true }`
       * envelope the project uses nowhere else.
       *
       * Deliberately nothing about what happened: not the new hash (obviously), and not the
       * number of sessions revoked either. How many devices a user had signed in is not
       * something a password change needs to report back, and a count would make the response
       * a probe for session state.
       *
       * No new tokens are issued. The caller's own refresh token is now revoked along with
       * every other, so they must sign in again — which is the honest consequence of having
       * just invalidated every session, and the correct one: a client that kept working
       * afterwards would suggest the revocation had not really happened.
       */
      res.status(204).send();
    }),
  );

  return router;
}
