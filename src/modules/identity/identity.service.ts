import type { Config } from '../../config.js';
import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import {
  AuthenticationRequired,
  Conflict,
  DomainError,
  InvalidCredentials,
} from '../../shared/errors.js';
import type { AuditTrail } from '../../shared/audit.js';
import type { EventBus } from '../../shared/events.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import type { MappableUser, RegisterRequest } from './dto.js';
import {
  EMAIL_UNIQUE_CONSTRAINT,
  PHONE_UNIQUE_CONSTRAINT,
  uniqueViolationConstraint,
  type EditableUserFields,
  type IdentityRepository,
  type UserSubject,
} from './identity.repository.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  REFRESH_TOKEN_UNIQUE_CONSTRAINT,
  type RefreshSessionRepository,
} from './refresh-session.repository.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';
import { AUTH_AUDIT, USER_AGGREGATE, USER_EVENTS, USER_RESOURCE } from './identity.events.js';
import type { TokenService } from './tokens.js';
import {
  toLoginResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type RefreshRequest,
  type UpdateProfileRequest,
} from './dto.js';

/**
 * The identity module's write API.
 *
 * A factory taking explicit dependencies, matching every other service in the codebase. No
 * HTTP types cross this boundary — the service takes validated data and a store id, and
 * raises `DomainError` subclasses that the terminal middleware maps. That is what makes it
 * callable from a route, a CLI command, a seed, and a test without duplication.
 */

export type IdentityService = ReturnType<typeof createIdentityService>;

/** A registration already conflicts with an existing account. */
export class EmailAlreadyRegistered extends Conflict {
  override readonly code = 'EMAIL_ALREADY_REGISTERED';

  constructor() {
    /**
     * No email address in the message, and no database detail.
     *
     * This response is a user-enumeration oracle by construction — a caller learns the
     * address is taken. That is an accepted trade-off (recorded in docs/DECISIONS.md)
     * because the alternative, always answering 202 and disambiguating by email, needs
     * email delivery that does not exist yet. Rate limiting is the mitigation and is the
     * next security increment. Echoing the address back would widen the leak from
     * "confirms what you sent" to "reflects it", so the message stays generic.
     */
    super('An account with these details already exists.');
  }
}

/** A registration conflicts on phone rather than email. */
export class PhoneAlreadyRegistered extends Conflict {
  override readonly code = 'PHONE_ALREADY_REGISTERED';

  constructor() {
    super('An account with these details already exists.');
  }
}

/**
 * The single response to every refresh failure.
 *
 * ONE error for all of: never existed, malformed, expired, revoked by logout, revoked by
 * family compromise, already consumed, belongs to a deactivated user, belongs to another
 * store. The caller learns only that they must log in again.
 *
 * This mirrors `InvalidCredentials` on the login path and exists for the same reason. A
 * `TOKEN_EXPIRED` distinct from `TOKEN_NOT_FOUND` would confirm to an attacker holding a
 * stolen token that it was *real* — and a distinct `TOKEN_REVOKED` would tell them their
 * theft had been detected, which is precisely when you want them to learn nothing and keep
 * replaying into a log you are watching.
 *
 * 401 rather than 403: the credential failed, so re-authenticating is the remedy, which is
 * what 401 means. Modelled on `InvalidAccessToken` in `tokens.ts` for consistency.
 */
export class InvalidRefreshToken extends DomainError {
  readonly code = 'INVALID_REFRESH_TOKEN';
  readonly statusCode = 401;

  constructor() {
    super('The refresh token is invalid or has expired. Please sign in again.');
  }
}

/** `revoked_reason` written when a replayed token triggers family revocation. */
export const REVOKED_REASON_ROTATION_REUSE = 'rotation_reuse';

/** `revoked_reason` written when a user deliberately signs out. */
export const REVOKED_REASON_LOGOUT = 'logout';

/**
 * `revoked_reason` written when a password change invalidates every session.
 *
 * A distinct value rather than reusing `logout`, so the forensic trail can tell "the user
 * signed out" from "the user's credentials were rotated and everything established under the
 * old one was cut" — different events with different follow-up.
 */
export const REVOKED_REASON_PASSWORD_CHANGE = 'password_change';

/**
 * A password nobody can log in with, hashed to give unknown accounts something to verify
 * against.
 *
 * Not a secret: its hash is never stored, so it authenticates nothing. Its only job is to
 * make `verifyPassword` run for an unknown email so the response takes as long as it does for
 * a known one. Without it, a failed login for a non-existent address returns in ~1ms while a
 * wrong password takes ~50ms, and the endpoint becomes a fast, reliable account-existence
 * oracle.
 */
const TIMING_EQUALISER_PASSWORD = 'timing-equaliser-not-a-real-credential';

/** Cap on a stored `user_agent`, matching `refresh_session.userAgent` `varchar(512)`. */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * The per-account failure budget, as seen by this service.
 *
 * A narrow port, not the `RateLimiter` itself. The service must be able to say "that attempt
 * failed" without knowing that the counter lives in Redis, has a fixed window, or is keyed by
 * a hash — otherwise logging in could not be driven from a CLI or a test without standing up
 * Redis, and the domain layer would depend on infrastructure.
 *
 * Why the SERVICE and not the middleware: only this method knows whether the credentials were
 * valid. Counting in middleware would spend budget on the successful retry after a typo.
 */
export type LoginAttemptTracker = {
  /** Count one failed authentication against this address. */
  recordFailure(params: { storeId: string; email: string }): Promise<void>;
  /** Forget this address's failures, after proof of ownership. */
  clear(params: { storeId: string; email: string }): Promise<void>;
};

export function createIdentityService(deps: {
  repository: IdentityRepository;
  sessions: RefreshSessionRepository;
  tokens: TokenService;
  db: Database;
  config: Config;
  logger: Logger;
  /**
   * Optional so every existing construction site and test keeps working untouched. When
   * absent, failures simply are not counted — the per-IP limiter still caps CPU, and the
   * composition root always supplies one, so production is never unprotected.
   */
  loginAttempts?: LoginAttemptTracker;
  events: EventBus;
  audit: AuditTrail;
}) {
  const { repository, sessions, tokens, db, config, logger, events, audit } = deps;

  /**
   * Report an attempt outcome to the failure budget. Never throws.
   *
   * Deliberately best-effort. By the time this runs the authentication decision is already
   * made, and the enforcement point — the middleware that refused the request — has already
   * passed. Letting a Redis blip here turn a correct 401 into a 500, or worse, fail a
   * SUCCESSFUL login because the counter could not be cleared, would trade a real outage for
   * a marginal gain in accounting accuracy.
   *
   * This is not a hole in the fail-closed posture: the CHECK fails closed with a 503. Only
   * the bookkeeping after the decision is tolerant.
   */
  async function trackAttempt(
    outcome: 'failed' | 'succeeded',
    params: { storeId: string; email: string },
  ): Promise<void> {
    if (!deps.loginAttempts) return;

    try {
      await (outcome === 'failed'
        ? deps.loginAttempts.recordFailure(params)
        : deps.loginAttempts.clear(params));
    } catch (err) {
      // No email in the log line — same non-enumeration rule as everywhere else in this file.
      logger.error({ err, storeId: params.storeId, outcome }, 'login_attempt_tracking_failed');
    }
  }

  /**
   * The dummy hash, computed once and cached as a promise.
   *
   * A promise rather than a value because hashing is async and this factory is synchronous —
   * the same pattern the token service uses for key import. Concurrent first-use shares one
   * Argon2 call instead of racing several.
   */
  let equaliserHash: Promise<string> | undefined;

  function getEqualiserHash(): Promise<string> {
    equaliserHash ??= hashPassword(TIMING_EQUALISER_PASSWORD);
    return equaliserHash;
  }

  const refreshTtlMs = config.jwtRefreshTtlDays * 24 * 60 * 60 * 1000;

  return {
    /**
     * Register a customer.
     *
     * NOT wrapped in a transaction, deliberately. It is a single INSERT: a transaction
     * around one statement adds a round trip and buys nothing, and the project's convention
     * is to use `withTransaction` only where there is a real consistency boundary. When this
     * grows a second write — the `user.registered` outbox event, or an `audit_log` row — the
     * transaction arrives with it, because THAT is when atomicity starts to mean something.
     *
     * No tokens are issued. Registration and session establishment are separate concerns and
     * separate increments; returning a session here would mean building half of login.
     */
    async registerCustomer(params: {
      storeId: string;
      input: RegisterRequest;
    }): Promise<MappableUser> {
      const { storeId, input } = params;

      /**
       * Re-normalise rather than trusting the caller.
       *
       * The DTO already lowercases and trims, so this is redundant for the HTTP path — and
       * that is the point: a future caller (a CLI command, an admin import) may hand over a
       * raw address, and the value written must match the `lower(email)` unique index either
       * way. One line here is cheaper than a duplicate-account bug later.
       */
      const email = input.email.trim().toLowerCase();
      const phone = input.phone ?? null;

      /**
       * Pre-check for a friendly error. NOT the enforcement mechanism.
       *
       * Two concurrent registrations for one address both reach this point and both see
       * nothing. The unique index is what actually prevents the duplicate; this exists so
       * the common case returns a clean 409 instead of surfacing a constraint violation, and
       * the catch below handles the race.
       */
      const existing = await repository.findActiveByEmail({ storeId, email });
      if (existing) {
        // Logged without the address: an email in a log is PII, and this line exists to
        // measure duplicate-signup rate, not to identify people.
        logger.info({ storeId }, 'registration_rejected_duplicate_email');
        throw new EmailAlreadyRegistered();
      }

      /**
       * Hash before the insert, and only after the pre-check.
       *
       * Argon2 costs ~50 ms of CPU by design, so doing it before a check that would reject
       * the request anyway would hand an attacker a cheap way to burn our CPU. (The reverse
       * ordering is correct for LOGIN, where skipping the hash on an unknown email leaks
       * which addresses exist through response timing — a different threat, handled in the
       * login increment.)
       */
      const passwordHash = await hashPassword(input.password);

      try {
        /**
         * Now a transaction, exactly as the note above anticipated.
         *
         * The insert has grown two companions — the `user.registered` event and the audit
         * entry — so atomicity finally means something: a welcome email must never be sent
         * for an account whose insert rolled back, and an audit trail must never claim an
         * account was created when it was not.
         *
         * The unique-violation catch stays OUTSIDE, because a failed statement poisons the
         * surrounding transaction and the rollback must finish before the error is translated.
         */
        const user = await withTransaction(db, logger, async () => {
          const row = await repository.insertUser({
            id: newId(),
            storeId,
            email,
            passwordHash,
            // The column defaults are `''`; the DTO makes these optional, so normalise here
            // rather than letting `undefined` reach the insert.
            firstName: input.firstName ?? '',
            lastName: input.lastName ?? '',
            phone,
            acceptsMarketing: input.acceptsMarketing ?? false,
            // isStaff / isSuperuser are absent from InsertUserValues by design. They cannot be
            // set through this path; the column defaults (false) apply.
          });

          await events.emit({
            type: USER_EVENTS.registered,
            aggregateType: USER_AGGREGATE,
            aggregateId: row.id,
            storeId,
            /**
             * Ids and facts. The email IS included — a welcome-email handler cannot do its
             * job without it, and re-reading the row would race a customer who changes their
             * address in the interim, sending the welcome to the wrong place.
             *
             * No password hash, obviously, and no phone: no handler needs it, and an outbox
             * payload is retained far longer than a request log.
             */
            payload: {
              userId: row.id,
              email: row.email,
              firstName: row.firstName,
              acceptsMarketing: row.acceptsMarketing,
            },
          });

          /**
           * Actor is the user themselves — a self-service signup, not a staff creation.
           *
           * Recorded because "when did this account first appear, and did anyone else create
           * it?" is a question every account investigation starts with. The email is NOT
           * duplicated into metadata: it is already on the row this entry points at, and
           * audit logs are shipped to aggregators with looser access controls than the
           * database.
           */
          await audit.record({
            action: AUTH_AUDIT.registered,
            actor: { type: 'customer', userId: row.id },
            resourceType: USER_RESOURCE,
            resourceId: row.id,
            storeId,
          });

          return row;
        });

        logger.info({ storeId, userId: user.id }, 'user_registered');
        return user;
      } catch (err) {
        /**
         * The race, arbitrated by the database.
         *
         * Translated by CONSTRAINT NAME, so a violation on some future unique index is not
         * silently reported as a duplicate email. Anything unrecognised is rethrown and
         * becomes an opaque 500 — which is correct: an unexpected constraint failure is a
         * bug, and dressing it up as a 409 would hide it.
         */
        const constraint = uniqueViolationConstraint(err);

        if (constraint === EMAIL_UNIQUE_CONSTRAINT) {
          logger.info({ storeId }, 'registration_lost_email_race');
          throw new EmailAlreadyRegistered();
        }
        if (constraint === PHONE_UNIQUE_CONSTRAINT) {
          logger.info({ storeId }, 'registration_lost_phone_race');
          throw new PhoneAlreadyRegistered();
        }
        throw err;
      }
    },

    /**
     * Authenticate a customer and establish a session.
     *
     * The ordering in this method is almost entirely security, not convenience. Reading it
     * top to bottom:
     *
     *  1. Look up credentials. `isActive` is fetched, not filtered.
     *  2. Verify the password ALWAYS — against the real hash if the user exists, against a
     *     dummy hash if not. Every failure path therefore costs one Argon2 verify.
     *  3. Only then consider `isActive`.
     *  4. Generate ids and the raw token; hash the token.
     *  5. Insert the session and stamp `lastLoginAt` in ONE transaction.
     *  6. Issue the access token AFTER commit.
     *  7. Best-effort password rehash, outside the transaction.
     *
     * Every rejection is the same `InvalidCredentials` (401) with the same message: unknown
     * email, wrong password, inactive account, and soft-deleted account are externally
     * indistinguishable.
     */
    async login(params: {
      storeId: string;
      input: LoginRequest;
      /** From the HTTP layer. `null` when unavailable — never fabricated. */
      userAgent: string | null;
      ipAddress: string | null;
    }): Promise<LoginResponse> {
      const { storeId, input } = params;

      // Same normalisation as registration, and re-applied here for the same reason: a
      // non-HTTP caller may hand over a raw address, and it must match the `lower(email)`
      // index either way.
      const email = input.email.trim().toLowerCase();

      const credentials = await repository.findCredentialsByEmail({ storeId, email });

      /**
       * Verify unconditionally.
       *
       * For an unknown email there is no hash to check, so we check the dummy one and discard
       * the result. Returning early instead would make a non-existent account answer in
       * about a millisecond where a real one takes fifty — a timing oracle precise enough to
       * enumerate a customer list over a coffee break.
       *
       * Soft-deleted users never reach here at all: the query excludes them, matching the
       * partial unique index, so an erased account cannot authenticate.
       */
      const passwordMatches = credentials
        ? await verifyPassword(input.password, credentials.passwordHash)
        : await verifyPassword(input.password, await getEqualiserHash()).then(() => false);

      if (!credentials || !passwordMatches) {
        /**
         * ONE log event for both, carrying no email and no distinguishing field.
         *
         * Splitting this into `login_unknown_email` and `login_wrong_password` would rebuild
         * the enumeration oracle inside our own logs — and log access is broader than
         * database access.
         */
        logger.info({ storeId }, 'login_rejected_invalid_credentials');

        /**
         * Counted for BOTH branches — unknown email and wrong password alike.
         *
         * Counting only real accounts would make the 429 itself an enumeration oracle: five
         * guesses at a nonexistent address would keep answering 401 while five at a real one
         * started answering 429. The budget therefore tracks whatever the client sent,
         * existing or not, which is the same principle that makes `InvalidCredentials`
         * indistinguishable across causes.
         */
        await trackAttempt('failed', { storeId, email });
        throw new InvalidCredentials();
      }

      /**
       * Checked AFTER verification, so a disabled account costs the same as a wrong password.
       *
       * Logged distinctly because this one is operationally useful — "a suspended customer is
       * still trying to sign in" is worth seeing — and it is safe: reaching this line proves
       * the caller already knew the correct password, so the log tells an attacker nothing
       * they did not supply.
       */
      if (!credentials.isActive) {
        logger.warn({ storeId, userId: credentials.id }, 'login_rejected_inactive_user');

        /**
         * A disabled account still counts, even though reaching here proves the password was
         * correct. Repeated attempts against a suspended account are still unwanted load, and
         * exempting them would hand an attacker who has already found valid credentials an
         * unlimited-attempt path.
         */
        await trackAttempt('failed', { storeId, email });
        throw new InvalidCredentials();
      }

      /**
       * Cleared HERE — at the moment ownership is proven, not at the end of the method.
       *
       * Everything below this line is session persistence and token minting, which can fail
       * for infrastructure reasons that say nothing about whether the caller is legitimate. If
       * the budget were cleared after all of that, a user with four prior typos who then
       * authenticated correctly but hit a database blip would still be one failure away from
       * being locked out — punished for our outage.
       */
      await trackAttempt('succeeded', { storeId, email });

      const sessionId = newId();
      const familyId = newId();
      const expiresAt = new Date(Date.now() + refreshTtlMs);

      /**
       * Persist first, mint second.
       *
       * The session insert and the `lastLoginAt` stamp are atomic because the asymmetry
       * matters: a committed session with a stale timestamp is harmless, but a stamped
       * timestamp with no session row would mean returning a refresh token that does not
       * exist — the client believes it holds a 30-day session and its first refresh fails
       * inexplicably.
       */
      const rawRefreshToken = await this.createSessionWithRetry({
        sessionId,
        familyId,
        storeId,
        userId: credentials.id,
        expiresAt,
        userAgent: truncateUserAgent(params.userAgent),
        ipAddress: params.ipAddress,
      });

      /**
       * Issued after COMMIT, and the trade-off is deliberate.
       *
       * Minting a credential whose `sid` might roll back is worse than the alternative. If
       * issuance fails here the session row is already committed and the client never learns
       * of it — an ORPHAN session that expires on its own while the client retries and gets a
       * fresh one. `warmUp()` at startup makes this vanishingly unlikely, because the only
       * realistic cause is unusable key material, which now fails the process at boot.
       */
      const accessToken = await tokens.issueAccessToken({
        userId: credentials.id,
        storeId: credentials.storeId,
        isStaff: credentials.isStaff,
        isSuperuser: credentials.isSuperuser,
        sessionId,
      });

      /**
       * Cost-factor upgrade, best effort, outside the transaction.
       *
       * Uses the hash that was just verified — no second read — and the update is conditional
       * on that hash still being current, so a concurrent login or password change cannot be
       * overwritten. A failure here is caught: a rehash problem must never turn a valid login
       * into a failed one, and the next login simply tries again.
       */
      await this.upgradePasswordHashIfNeeded({
        storeId,
        userId: credentials.id,
        currentHash: credentials.passwordHash,
        plaintext: input.password,
      });

      logger.info({ storeId, userId: credentials.id, sessionId }, 'login_succeeded');

      return toLoginResponse({
        user: credentials,
        accessToken: accessToken.token,
        expiresInSeconds: accessToken.expiresInSeconds,
        // The one and only time the raw token exists outside this method.
        refreshToken: rawRefreshToken,
      });
    },

    /**
     * Read the authenticated user's current state.
     *
     * The access token proves WHO the caller is; the database decides WHAT they currently are.
     * Those are different questions, and answering the second from the token would be wrong in
     * a way that is invisible until it matters: a token is valid for 15 minutes, so a name
     * change, an email verification, or a marketing opt-out made in that window would be
     * silently ignored, and the client would show stale data with no way to tell.
     *
     * So nothing here comes from the token except the two identifiers used to look the row up.
     * There is no `input` parameter at all — the caller cannot name a user, an email, or a
     * store, which is what makes enumeration structurally impossible rather than merely
     * guarded against.
     *
     * Reuses `findSubjectById` from the refresh increment rather than adding a near-duplicate
     * `findPublicUserById`. It already does exactly what is needed: store-scoped in the query
     * itself, `deleted_at IS NULL`, and a projection that never selects `passwordHash`.
     */
    async getCurrentUser(params: { storeId: string; userId: string }): Promise<UserSubject> {
      const user = await repository.findSubjectById({
        storeId: params.storeId,
        userId: params.userId,
      });

      /**
       * A cryptographically valid token does NOT mean a valid account.
       *
       * Three states reach here with a perfectly good signature: the row was soft-deleted
       * (excluded by the query), the row belongs to another store (excluded by the predicate),
       * or the account was deactivated. In every case the honest answer is that this credential
       * no longer identifies a usable identity — so returning the token's own claims as if the
       * account were fine would be presenting stale data as current.
       *
       * `AuthenticationRequired` (401), matching how `requireAuth` reports every other
       * authentication failure. Not 403: this is not "you may not", it is "you are not". Not
       * 404 either — a missing *self* is an authentication problem, and 404 would invite a
       * client to treat it as a routing bug.
       *
       * The SAME error for all three, so a caller cannot learn whether their account was
       * deleted, suspended, or moved.
       */
      if (!user || !user.isActive) {
        logger.warn(
          { storeId: params.storeId, userId: params.userId, found: user !== undefined },
          'current_user_rejected_not_active',
        );
        throw new AuthenticationRequired();
      }

      return user;
    },

    /**
     * Change the authenticated user's password, and cut every session established under the
     * old one.
     *
     * The subject comes from the verified access token and nothing else — there is no field in
     * `ChangePasswordRequest` that names a user, an email, or a store, so aiming this at
     * another account is not merely rejected but unrepresentable. The row is re-read from the
     * database rather than trusted from the token, for the same reason `getCurrentUser` does
     * (§21): a token is valid for 15 minutes, and an account deactivated inside that window
     * must not be able to rotate its own credential.
     *
     * ## Session revocation is an invariant, not a side effect
     *
     * The reason to change a password is that the old one may be known to someone else. Every
     * refresh session established under it is therefore suspect, so ALL of them are revoked —
     * across every family, not just the caller's. This is the one place the codebase revokes
     * user-wide; logout is deliberately family-scoped (§20) so that signing out of a phone does
     * not sign a user out of their laptop. Conflating the two would make the safe option the
     * only option, and here the safe option is the correct one.
     *
     * A password change that left a stolen refresh token alive would leave the attacker with a
     * renewable foothold — exactly what the user pressed the button to end.
     *
     * ## Atomicity
     *
     * Both writes run inside ONE `withTransaction`, using the project's existing helper rather
     * than a new abstraction. The repositories call `executor(db)`, which picks up the ambient
     * transaction automatically, so nothing about them changes.
     *
     * The partial state that must not exist is "password changed, sessions still live": the
     * user believes they have locked an intruder out while the intruder's refresh token still
     * works. Rolling both into one transaction means a revocation failure takes the password
     * change with it, and the user is told the operation failed — recoverable, and honest.
     *
     * Access tokens are NOT invalidated. They are stateless and remain valid until `exp`, at
     * most 15 minutes. This method ends refresh capability immediately; it cannot make an
     * outstanding access token stop working, and §20 already records that trade-off honestly
     * rather than implying a revocation that does not happen.
     */
    async changePassword(params: {
      storeId: string;
      userId: string;
      input: ChangePasswordRequest;
    }): Promise<void> {
      const { storeId, userId, input } = params;

      /**
       * Read WITH the hash, keyed by id. `findSubjectById` deliberately omits the hash, so
       * this path uses the credential projection — the one case where a `/users/me` route
       * legitimately needs it.
       */
      const user = await repository.findCredentialsById({ storeId, userId });

      /**
       * The same `AuthenticationRequired` (401) `getCurrentUser` raises, for the same three
       * states: soft-deleted, foreign store, or deactivated. A valid signature does not mean a
       * usable identity, and one error for all three means a caller cannot learn which.
       */
      if (!user || !user.isActive) {
        logger.warn(
          { storeId, userId, found: user !== undefined },
          'password_change_rejected_not_active',
        );
        throw new AuthenticationRequired();
      }

      /**
       * Proof of knowledge of the CURRENT password.
       *
       * This check is what stops a stolen access token from becoming a permanent account
       * takeover. Without it, 15 minutes of borrowed token is enough to lock the real owner out
       * of their own account — the attacker sets a password the owner does not know, and the
       * revocation below then cuts every one of the owner's sessions. Removing this line turns
       * a security feature into the attack it defends against.
       *
       * `InvalidCredentials` (401) — the same error login raises for a wrong password, rather
       * than a new one. There is no enumeration concern here: the caller already proved which
       * account is theirs, so the only fact disclosed is one they were testing on themselves.
       */
      if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
        logger.warn({ storeId, userId }, 'password_change_rejected_wrong_current_password');
        throw new InvalidCredentials();
      }

      const newHash = await hashPassword(input.newPassword);
      const at = new Date();

      await withTransaction(db, logger, async () => {
        /**
         * Compare-and-set on the hash we just verified, reusing the existing
         * `updatePasswordHash` unchanged — `expectedCurrentHash` is exactly the guard this
         * needs. If a concurrent login rehashed the row, or another password change landed
         * first, the WHERE matches nothing and this returns false rather than overwriting a
         * password set by a request that arrived later.
         */
        const updated = await repository.updatePasswordHash({
          storeId,
          userId,
          expectedCurrentHash: user.passwordHash,
          passwordHash: newHash,
        });

        if (!updated) {
          /**
           * The row changed underneath us, so the password we verified is no longer current.
           * A `Conflict` (409) rather than a 401: the credential presented WAS correct when
           * checked, and telling the user their current password is wrong would be a lie that
           * sends them looking for the wrong problem. Retrying is the right advice.
           *
           * Throwing here rolls the transaction back, so no session is revoked for a password
           * change that did not happen.
           */
          logger.warn({ storeId, userId }, 'password_change_conflicted');
          throw new Conflict('The password was changed by another request. Please try again.');
        }

        const revokedCount = await sessions.revokeAllForUser({
          storeId,
          userId,
          reason: REVOKED_REASON_PASSWORD_CHANGE,
          at,
        });

        /**
         * In the SAME transaction as the hash update and the revocation.
         *
         * A password change is the single most security-relevant thing a customer can do to
         * their own account, and the number of sessions it cut is exactly what an
         * investigation wants: an unexpectedly high count is the signature of an account that
         * had been compromised across several devices.
         *
         * `revokedCount` only — never the old or new hash, and never the passwords. The entry
         * records that the act happened and what it affected, which is what an audit trail is
         * for; the credential itself is not audit material.
         */
        await audit.record({
          action: AUTH_AUDIT.passwordChanged,
          actor: { type: 'customer', userId },
          resourceType: USER_RESOURCE,
          resourceId: userId,
          storeId,
          metadata: { revokedSessionCount: revokedCount },
        });

        /**
         * Inside the transaction, so a logged success cannot describe a rolled-back write.
         * `revokedCount` is recorded because a count far from expectations is worth being able
         * to see afterwards — it is never returned to the caller.
         */
        logger.info({ storeId, userId, revokedCount }, 'password_changed');
      });
    },

    /**
     * Update the authenticated user's own profile.
     *
     * Self-only, and structurally so: the subject comes from the token's `sub` claim, and
     * `UpdateProfileRequest` has no field that names a user or a store. No scope is required —
     * this is a user editing themselves, not staff editing a customer, and demanding `staff`
     * here would lock every customer out of their own profile.
     *
     * Only fields the caller actually supplied are written. `fields` is built by explicit
     * `!== undefined` checks rather than by spreading the parsed body, matching the catalogue's
     * `updateProduct` (§29).
     *
     * Two reasons, and it is worth being precise about which is which. The load-bearing one is
     * that `EditableUserFields` is a closed allowlist: spreading `input` would need an `as`
     * cast to compile, and that cast is exactly what would let a widened schema carry
     * `isStaff` into the SET clause. Building the object field by field means a new writable
     * column requires editing this method *and* the type.
     *
     * The second reason is narrower than it looks: Drizzle already filters `undefined` out of
     * a SET clause (`buildUpdateSet` keeps a column only when `set[col] !== undefined`), so
     * forwarding an omitted field would NOT write a NULL — verified in the driver rather than
     * assumed. The explicit form is preferred anyway because it is type-correct under
     * `exactOptionalPropertyTypes` without a cast, and because relying on that driver detail
     * would make the safety of this method a property of a dependency.
     *
     * `EditableUserFields` is the type-level half of the privilege boundary: even if this
     * method tried to forward `isStaff`, it would not compile. The Zod schema is the other
     * half, rejecting it at the boundary with a 400 that names the field.
     */
    async updateProfile(params: {
      storeId: string;
      userId: string;
      input: UpdateProfileRequest;
    }): Promise<UserSubject> {
      const { storeId, userId, input } = params;

      const fields: EditableUserFields = {};
      if (input.firstName !== undefined) fields.firstName = input.firstName;
      if (input.lastName !== undefined) fields.lastName = input.lastName;
      if (input.acceptsMarketing !== undefined) fields.acceptsMarketing = input.acceptsMarketing;

      /**
       * Wrapped in a transaction so the `isActive` rejection below can actually UNDO the write.
       *
       * The check has to happen on the row the update returned — the predicate excludes deleted
       * and foreign rows, leaving a deactivated account as the one case a read cannot settle
       * ahead of time without a second query whose answer could be stale by the time the write
       * ran. Checking after the write means the write has already happened, so without a
       * transaction a deactivated user would get a 401 *and* a modified profile. Same reasoning
       * as `changePassword`: the partial state is the thing to design out, not to document.
       */
      const updated = await withTransaction(db, logger, async () => {
        const row = await repository.updateUserProfile({
          storeId,
          userId,
          fields,
          at: new Date(),
        });

        /**
         * Soft-deleted, deactivated, or belonging to another store — all
         * `AuthenticationRequired` (401), matching `getCurrentUser` rather than the catalogue's
         * 404. A missing *self* is an authentication problem, not a routing one: there is no
         * resource identifier in this request that could have been wrong.
         */
        if (!row || !row.isActive) {
          logger.warn(
            { storeId, userId, found: row !== undefined },
            'profile_update_rejected_not_active',
          );
          throw new AuthenticationRequired();
        }

        return row;
      });

      logger.info({ storeId, userId, fields: Object.keys(fields) }, 'profile_updated');
      return updated;
    },

    /**
     * Log out: revoke the refresh-token family behind the caller's current session.
     *
     * FAMILY-scoped, not user-scoped. A user signed in on a phone and a laptop has two
     * independent families, and "log out" on one device must not sign them out of the other —
     * that is what the word means to the person pressing the button. Revoking everything would
     * be a different feature ("sign out everywhere"), and conflating them means the safe
     * option is the only option.
     *
     * The `sessionId` comes from the verified access token's `sid` claim, never from the
     * request body. A body-supplied id would let any authenticated caller revoke any session
     * whose id they could guess or observe — a one-line denial-of-service against other users,
     * and the store predicate alone would not stop it because ids are unique within a store.
     *
     * IDEMPOTENT. A second logout with the same token revokes zero rows and still succeeds. The
     * count is logged but never returned: reporting "0 revoked" would tell a caller whether
     * their session was already dead, which is information about session state that a
     * successful logout has no reason to disclose.
     *
     * Access tokens are NOT invalidated — they are stateless and remain valid until `exp`. This
     * method revokes refresh capability immediately; it does not and cannot make an outstanding
     * access token stop working. Recorded honestly in docs/DECISIONS.md §20.
     */
    async logout(params: { storeId: string; sessionId: string }): Promise<void> {
      const revokedCount = await sessions.revokeFamilyBySessionId({
        storeId: params.storeId,
        sessionId: params.sessionId,
        reason: REVOKED_REASON_LOGOUT,
        at: new Date(),
      });

      /**
       * Identifiers only. No token, and no token HASH either — the hash is a working lookup
       * key for the session table, and log stores are read by more people than the database.
       *
       * `info`, not `warn`: a logout is a routine, user-initiated event. `revokedCount` is
       * recorded because a family larger than expected is worth being able to see afterwards.
       */
      logger.info(
        { storeId: params.storeId, sessionId: params.sessionId, revokedCount },
        'logout_succeeded',
      );
    },

    /**
     * Exchange a refresh token for a new access token and a new refresh token.
     *
     * ROTATION: the presented token is consumed and a replacement is issued in the same
     * family. The old token is dead the instant this succeeds, so a token that leaks is only
     * useful until its owner next refreshes — which is what makes a 30-day credential
     * tolerable at all.
     *
     * The sequence, and why it is in this order:
     *
     *  1. Hash the presented token. The raw value never leaves this method.
     *  2. **Atomically** claim the session: one `UPDATE` that both checks usability and stamps
     *     `consumed_at`. This is the concurrency control — see `claimForRotation`.
     *  3. If the claim failed, diagnose it in a separate step that COMMITS before throwing,
     *     because a detected reuse must revoke a family and a rollback would undo that.
     *  4. Load the user fresh, so a deactivated or demoted account cannot refresh into new
     *     privileges.
     *  5. Insert the replacement session in the SAME transaction as the claim.
     *  6. Mint the access token after commit.
     *
     * Steps 2 and 5 share one transaction deliberately. If the insert failed after the claim
     * committed, the caller would hold a token that had just been consumed with no replacement
     * ever issued — logged out by an infrastructure blip, with no way to recover but signing in
     * again. Atomicity means a failure leaves the old token still valid and retryable.
     */
    async refresh(params: {
      storeId: string;
      input: RefreshRequest;
      /** From the HTTP layer. `null` when unavailable — never fabricated. */
      userAgent: string | null;
      ipAddress: string | null;
    }): Promise<LoginResponse> {
      const { storeId } = params;

      /**
       * Hashed once, up front. The raw token is not logged, not stored, and not passed to the
       * repository — whose signatures accept only a `RefreshTokenHash`, so a plaintext write
       * is a compile error rather than a review catch.
       */
      const presentedHash = hashRefreshToken(params.input.refreshToken);

      const MAX_ATTEMPTS = 2;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const replacementSessionId = newId();
        const replacementToken = generateRefreshToken();

        try {
          /**
           * Returns a discriminated union rather than throwing from inside the transaction.
           *
           * Throwing here would roll back — which is exactly wrong for the reuse path, where
           * the whole point is to COMMIT a family revocation and then reject. Separating "what
           * happened" from "what to raise" keeps the transaction boundary honest.
           */
          const outcome = await withTransaction(db, logger, async () => {
            const now = new Date();

            const claimed = await sessions.claimForRotation({
              storeId,
              tokenHash: presentedHash,
              now,
            });

            // No row matched: unknown, expired, already revoked, or already consumed. Which
            // one it is decides whether a family dies, and that is diagnosed outside this
            // transaction so the revocation can commit.
            if (!claimed) return { kind: 'claim-failed' } as const;

            const user = await repository.findSubjectById({ storeId, userId: claimed.userId });

            /**
             * Re-checked on every refresh, not trusted from the session row.
             *
             * A refresh token issued before an account was suspended must stop working. This
             * is the only place that enforcement can live: the access token is 15 minutes of
             * unavoidable staleness, but refresh is where the account is consulted again.
             */
            if (!user || !user.isActive) {
              logger.warn(
                { storeId, userId: claimed.userId, sessionId: claimed.id },
                'refresh_rejected_user_not_active',
              );
              return { kind: 'user-unavailable' } as const;
            }

            /**
             * The replacement joins the SAME family, and inherits the parent's expiry.
             *
             * Inheriting rather than extending is a deliberate security choice: a family dies
             * 30 days after the LOGIN that created it, no matter how often it is rotated. A
             * sliding expiry would let a stolen token be refreshed indefinitely, so a thief who
             * never misses a rotation window would never be forced out. The cost is that an
             * active user re-authenticates monthly; that is the trade, and it is recorded in
             * docs/DECISIONS.md §19.
             */
            await sessions.insertSession({
              id: replacementSessionId,
              storeId,
              userId: user.id,
              tokenHash: hashRefreshToken(replacementToken),
              familyId: claimed.familyId,
              expiresAt: claimed.expiresAt,
              userAgent: truncateUserAgent(params.userAgent),
              ipAddress: params.ipAddress,
            });

            return { kind: 'rotated', user, familyId: claimed.familyId } as const;
          });

          /**
           * One rejection point for both failure shapes, which also narrows `outcome` to the
           * rotated variant for the code below.
           *
           * `rejectFailedClaim` always throws, but its `Promise<never>` return does not
           * terminate control flow as far as the compiler is concerned — so the explicit throw
           * that follows is both a narrowing aid and a genuine backstop. If that method were
           * ever edited to fall through, the request would still be rejected rather than
           * continuing into a rotation with no claimed session.
           */
          if (outcome.kind !== 'rotated') {
            if (outcome.kind === 'claim-failed') {
              // Commits the family revocation if this was a replay, then throws.
              await this.rejectFailedClaim({ storeId, presentedHash });
            }

            // Same opaque error as every other failure. A caller must not be able to tell a
            // suspended account from a bad token.
            throw new InvalidRefreshToken();
          }

          /**
           * Minted after COMMIT, matching login.
           *
           * The claims come from the row just read, not from the old token, so `isStaff` and
           * `isSuperuser` reflect the account as it is now.
           */
          const accessToken = await tokens.issueAccessToken({
            userId: outcome.user.id,
            storeId: outcome.user.storeId,
            isStaff: outcome.user.isStaff,
            isSuperuser: outcome.user.isSuperuser,
            sessionId: replacementSessionId,
          });

          logger.info(
            {
              storeId,
              userId: outcome.user.id,
              sessionId: replacementSessionId,
              familyId: outcome.familyId,
            },
            'refresh_succeeded',
          );

          return toLoginResponse({
            user: outcome.user,
            accessToken: accessToken.token,
            expiresInSeconds: accessToken.expiresInSeconds,
            // The one and only time the replacement token exists outside this method.
            refreshToken: replacementToken,
          });
        } catch (err) {
          /**
           * Only a token-hash collision is retried, and retrying re-runs the WHOLE transaction.
           *
           * That matters: a unique violation aborts the PostgreSQL transaction, so the claim
           * rolled back with it and `consumed_at` is null again. Re-running is therefore safe
           * and necessary — retrying just the insert inside the aborted transaction would fail
           * with "current transaction is aborted" on every statement.
           */
          if (uniqueViolationConstraint(err) !== REFRESH_TOKEN_UNIQUE_CONSTRAINT) {
            throw err;
          }

          logger.error({ storeId, attempt }, 'refresh_token_hash_collision');

          if (attempt === MAX_ATTEMPTS) {
            throw new Error(
              'refresh token hash collided twice; the random source may be compromised',
              { cause: err },
            );
          }
        }
      }

      // Unreachable: the loop either returns or throws. Explicit, because the compiler cannot
      // prove it and an implicit `undefined` would be worse.
      throw new Error('refresh exhausted attempts without a result');
    },

    /**
     * Decide why a rotation claim failed, revoke a family if the token was replayed, and throw.
     *
     * REUSE DETECTION lives here. A row that exists and is already consumed means the token
     * was presented twice — and since rotation hands the client a replacement, a legitimate
     * client has no reason to ever send the old one again. So either it leaked, or the client
     * raced itself. The system cannot distinguish those, and it must not guess in the
     * attacker's favour.
     *
     * The response is to revoke the ENTIRE family. The thief may hold any number of
     * descendants of the leaked token, and revoking only the replayed row would leave them with
     * a live session. Revoking the family logs out the attacker AND the legitimate user, who
     * must sign in again — deliberately, because that is the only way to be sure the attacker
     * is out.
     *
     * This is why the order of use does not matter. Whether the attacker replays A before or
     * after the legitimate user has rotated to B and C, the replay of A revokes the family that
     * B and C belong to, so every descendant dies together.
     *
     * NOT wrapped in the caller's transaction: it commits, then throws.
     */
    async rejectFailedClaim(args: { storeId: string; presentedHash: string }): Promise<never> {
      const { storeId } = args;

      const existing = await sessions.findAnyByTokenHash({
        storeId,
        tokenHash: args.presentedHash,
      });

      /**
       * No row at all: a fabricated token, a token from another store, or one already deleted
       * by the expiry sweeper. Nothing to revoke.
       *
       * Logged at `info`, not `warn`. Random 43-character strings arriving at this endpoint is
       * background noise on the public internet, and paging on it would train people to ignore
       * the alert that matters.
       */
      if (!existing) {
        logger.info({ storeId }, 'refresh_rejected_unknown_token');
        throw new InvalidRefreshToken();
      }

      /**
       * Consumed is checked BEFORE revoked, and the order is load-bearing.
       *
       * After a family revocation a replayed token is both consumed AND revoked. Checking
       * `revokedAt` first would classify a genuine replay as a routine rejection and skip the
       * security log — so the second and third replays of a stolen token would go unrecorded,
       * which is exactly when someone is watching.
       *
       * Re-revoking an already-revoked family is idempotent and returns 0 rows.
       */
      if (existing.consumedAt) {
        const revokedCount = await sessions.revokeFamily({
          storeId,
          familyId: existing.familyId,
          reason: REVOKED_REASON_ROTATION_REUSE,
          at: new Date(),
        });

        /**
         * The security event. `error` level, because this is the one refresh outcome a human
         * should look at.
         *
         * Identifiers only — no raw token, and no hash either. The hash is a valid lookup key
         * for the session table, so writing it to a log store read by more people than the
         * database would hand over a working credential locator.
         */
        logger.error(
          {
            storeId,
            userId: existing.userId,
            familyId: existing.familyId,
            sessionId: existing.id,
            revokedCount,
            consumedAt: existing.consumedAt,
          },
          'refresh_token_reuse_detected',
        );

        throw new InvalidRefreshToken();
      }

      if (existing.revokedAt) {
        // Revoked without being consumed: logout, a password change, or collateral from a
        // sibling's reuse. Normal, not an incident.
        logger.info(
          { storeId, userId: existing.userId, sessionId: existing.id },
          'refresh_rejected_revoked_session',
        );
        throw new InvalidRefreshToken();
      }

      /**
       * Unconsumed, unrevoked, but the claim still failed — so it expired. Ordinary lifecycle,
       * and NOT a theft signal: an expired token proves nothing about whether it leaked.
       */
      logger.info(
        { storeId, userId: existing.userId, sessionId: existing.id },
        'refresh_rejected_expired_session',
      );
      throw new InvalidRefreshToken();
    },

    /**
     * Create the session, retrying ONCE on a token-hash collision.
     *
     * A collision at 256 bits of entropy is around 2⁻¹²⁸ — so a violation on
     * `uq_refresh_session_token` means a broken CSPRNG far more plausibly than bad luck. It is
     * therefore logged at error and retried exactly once: an unbounded retry loop would spin
     * forever against a generator returning a constant, which is precisely the failure this
     * would be signalling.
     *
     * Any OTHER unique violation is rethrown untouched. Reporting an unrelated constraint
     * failure as a collision would hide a real bug.
     */
    async createSessionWithRetry(args: {
      sessionId: string;
      familyId: string;
      storeId: string;
      userId: string;
      expiresAt: Date;
      userAgent: string | null;
      ipAddress: string | null;
    }): Promise<string> {
      const MAX_ATTEMPTS = 2;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const rawToken = generateRefreshToken();

        try {
          await withTransaction(db, logger, async () => {
            await sessions.insertSession({
              id: args.sessionId,
              storeId: args.storeId,
              userId: args.userId,
              // Hashed HERE, before it reaches the repository. The repository signature only
              // accepts a hash, so the raw token cannot be persisted by mistake.
              tokenHash: hashRefreshToken(rawToken),
              familyId: args.familyId,
              expiresAt: args.expiresAt,
              userAgent: args.userAgent,
              ipAddress: args.ipAddress,
            });

            await repository.updateLastLoginAt({
              storeId: args.storeId,
              userId: args.userId,
              at: new Date(),
            });
          });

          return rawToken;
        } catch (err) {
          if (uniqueViolationConstraint(err) !== REFRESH_TOKEN_UNIQUE_CONSTRAINT) {
            throw err;
          }

          logger.error(
            { storeId: args.storeId, userId: args.userId, attempt },
            'refresh_token_hash_collision',
          );

          if (attempt === MAX_ATTEMPTS) {
            // Fail loudly. Two collisions in a row is not chance; it is a generator returning
            // predictable output, and serving a session on a predictable token would be worse
            // than refusing to serve one at all.
            throw new Error(
              'refresh token hash collided twice; the random source may be compromised',
              // The underlying violation is kept as `cause` so the constraint name survives
              // into the log rather than being replaced by this summary.
              { cause: err },
            );
          }
        }
      }

      // Unreachable: the loop either returns or throws. Present because the compiler cannot
      // prove that, and an implicit `undefined` return would be worse than an explicit throw.
      throw new Error('createSessionWithRetry exhausted attempts without a result');
    },

    /**
     * Re-hash a verified password under current Argon2 parameters, if they have moved.
     *
     * Separated from `login` so the best-effort semantics are visible: this function never
     * throws, and its caller does not need a try/catch.
     */
    async upgradePasswordHashIfNeeded(args: {
      storeId: string;
      userId: string;
      currentHash: string;
      plaintext: string;
    }): Promise<void> {
      if (!needsRehash(args.currentHash)) return;

      try {
        const passwordHash = await hashPassword(args.plaintext);
        const updated = await repository.updatePasswordHash({
          storeId: args.storeId,
          userId: args.userId,
          expectedCurrentHash: args.currentHash,
          passwordHash,
        });

        // `false` means a concurrent login or password change got there first. Not a failure —
        // the row already holds a hash somebody else computed, and overwriting it would be
        // the actual bug.
        logger.info({ storeId: args.storeId, userId: args.userId, updated }, 'password_rehashed');
      } catch (err) {
        // Only safe identifiers. Never the plaintext, never either hash.
        logger.error({ err, storeId: args.storeId, userId: args.userId }, 'password_rehash_failed');
      }
    },
  };
}

/**
 * Truncate a user agent to the column width instead of rejecting it.
 *
 * A browser sending an absurd UA string must not be unable to log in. The value is forensic
 * only — it is never used for authorization — so losing the tail costs nothing, whereas a
 * `varchar(512)` overflow would fail the whole transaction.
 */
function truncateUserAgent(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_USER_AGENT_LENGTH);
}
