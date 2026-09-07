import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { refreshSession } from '../../db/schema/identity.js';
import { executor } from '../../db/transaction.js';
import type { RefreshTokenHash } from './refresh-token.js';

/**
 * Refresh session data access.
 *
 * Imports `refreshSession` from its schema module directly, not through
 * `db/schema/index.ts` — that barrel is for drizzle-kit and the test truncate helper, per its
 * own docblock.
 *
 * The single most important property of this file: **no method accepts a raw refresh token.**
 * Every signature takes a `RefreshTokenHash`. Hashing is the service's job, so a caller
 * cannot persist the secret by mistake — and the mistake would be invisible in review,
 * because a raw token and its hash are both opaque strings of similar length.
 */

export type RefreshSessionRepository = ReturnType<typeof createRefreshSessionRepository>;

/** The unique index on `token_hash`. Global, not store-scoped — see `insertSession`. */
export const REFRESH_TOKEN_UNIQUE_CONSTRAINT = 'uq_refresh_session_token';

export type InsertRefreshSessionValues = {
  id: string;
  storeId: string;
  userId: string;
  /**
   * The SHA-256 hex digest. Typed, not `string`, so passing a raw token here is a compile
   * error rather than a silent plaintext write.
   */
  tokenHash: RefreshTokenHash;
  /**
   * Groups every token descended from one login.
   *
   * Written now, read by nothing yet. Rotation (a later increment) uses it: presenting an
   * already-consumed token means the token leaked, and the response is to revoke the whole
   * family rather than one row. Storing it from the first login means those sessions are
   * already usable by that logic when it arrives.
   */
  familyId: string;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
};

/** What a caller may see. Deliberately excludes `tokenHash` — nothing outside needs it. */
export type RefreshSessionRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
};

const RECORD_COLUMNS = {
  id: refreshSession.id,
  storeId: refreshSession.storeId,
  userId: refreshSession.userId,
  familyId: refreshSession.familyId,
  expiresAt: refreshSession.expiresAt,
  consumedAt: refreshSession.consumedAt,
  revokedAt: refreshSession.revokedAt,
  createdAt: refreshSession.createdAt,
} as const;

export function createRefreshSessionRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Create a session.
     *
     * Uses {@link executor}, so this joins the caller's open transaction — which is what
     * makes the session insert and the `lastLoginAt` update atomic in the login flow.
     *
     * Lets a unique violation on `token_hash` propagate rather than swallowing it. The
     * service translates and retries once: at 256 bits of entropy a collision is around
     * 2⁻¹²⁸, so a violation here means a broken CSPRNG far more plausibly than bad luck, and
     * silently retrying forever would hide that.
     *
     * Note the constraint is GLOBAL, not per store. Two stores cannot collide on a token
     * hash, which is correct — a refresh token must be unique across the whole system, or a
     * lookup by hash could match the wrong tenant's session.
     */
    async insertSession(values: InsertRefreshSessionValues): Promise<RefreshSessionRecord> {
      const [row] = await executor(db)
        .insert(refreshSession)
        .values(values)
        .returning(RECORD_COLUMNS);

      if (!row) {
        // Unreachable for `INSERT ... RETURNING`, but the array type admits it and a silent
        // `undefined` would surface later as a confusing mapper failure.
        throw new Error('insertSession returned no row');
      }
      return row;
    },

    /**
     * Find a live session by token hash.
     *
     * Written now for the rotation increment, which is the only caller that needs it. Scoped
     * by store as well as hash: the hash alone is globally unique, but adding the store to
     * the predicate means a bug elsewhere cannot make one tenant's token resolve against
     * another's session.
     *
     * "Live" means not revoked. `consumedAt` is deliberately NOT filtered — a consumed token
     * being presented is the theft signal rotation must detect, so it has to be findable.
     */
    async findLiveByTokenHash(params: {
      storeId: string;
      tokenHash: RefreshTokenHash;
    }): Promise<RefreshSessionRecord | undefined> {
      const [row] = await executor(db)
        .select(RECORD_COLUMNS)
        .from(refreshSession)
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            eq(refreshSession.tokenHash, params.tokenHash),
            isNull(refreshSession.revokedAt),
          ),
        )
        .limit(1);
      return row;
    },
    /**
     * Find a session by token hash in ANY state — consumed, revoked, or expired.
     *
     * The diagnosis step of rotation. `findLiveByTokenHash` cannot serve this because it
     * filters revoked rows, and a replayed token whose family was already revoked is exactly
     * the row that must still be findable.
     *
     * This is not an enumeration oracle: it is internal, and every outcome it distinguishes
     * produces the same `InvalidRefreshToken` response. The distinctions exist only to decide
     * whether to revoke a family and what to write to the log.
     */
    async findAnyByTokenHash(params: {
      storeId: string;
      tokenHash: RefreshTokenHash;
    }): Promise<RefreshSessionRecord | undefined> {
      const [row] = await executor(db)
        .select(RECORD_COLUMNS)
        .from(refreshSession)
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            eq(refreshSession.tokenHash, params.tokenHash),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Atomically consume a session for rotation, if and only if it is still usable.
     *
     * THIS IS THE CONCURRENCY CONTROL, and it is a single statement on purpose.
     *
     * A read-then-write — `findLiveByTokenHash` followed by an update — would let two
     * simultaneous requests both observe `consumed_at IS NULL` and both rotate, handing out
     * two valid replacement tokens from one parent and silently forking the family. The
     * window is small, and a load test would find it exactly once: in production.
     *
     * Instead the predicate and the write are one `UPDATE`. PostgreSQL takes a row lock, so
     * two concurrent transactions serialise on it: the second blocks until the first commits,
     * then re-evaluates the `WHERE` under READ COMMITTED, sees `consumed_at` is no longer
     * null, and updates zero rows. Exactly one caller can ever win, and the loser becomes
     * indistinguishable from a genuine replay — which is the correct thing for it to be.
     *
     * No application-level lock is involved, so this holds across processes and instances.
     *
     * Expiry is checked HERE rather than in the service, so the check and the claim cannot be
     * separated by a context switch.
     */
    async claimForRotation(params: {
      storeId: string;
      tokenHash: RefreshTokenHash;
      now: Date;
    }): Promise<RefreshSessionRecord | undefined> {
      const [row] = await executor(db)
        .update(refreshSession)
        .set({ consumedAt: params.now, updatedAt: params.now })
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            eq(refreshSession.tokenHash, params.tokenHash),
            isNull(refreshSession.consumedAt),
            isNull(refreshSession.revokedAt),
            gt(refreshSession.expiresAt, params.now),
          ),
        )
        .returning(RECORD_COLUMNS);

      return row;
    },

    /**
     * Revoke every session in a family that is not already revoked.
     *
     * The response to a replayed token. One row being reused means the token leaked, and the
     * thief may hold any number of descendants — so the family is the unit of revocation, not
     * the row. Both the legitimate user and the attacker are logged out, which is the point:
     * the system cannot tell them apart, so it trusts neither.
     *
     * Consumed-but-unrevoked rows are included. They are already unusable, but stamping them
     * records which sessions existed when the incident was detected, which is what makes the
     * forensic trail readable afterwards.
     *
     * Returns the number of rows revoked, for the security log. Idempotent: revoking an
     * already-revoked family updates nothing and returns 0 rather than failing.
     */
    async revokeFamily(params: {
      storeId: string;
      familyId: string;
      reason: string;
      at: Date;
    }): Promise<number> {
      const revoked = await executor(db)
        .update(refreshSession)
        .set({ revokedAt: params.at, revokedReason: params.reason, updatedAt: params.at })
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            eq(refreshSession.familyId, params.familyId),
            isNull(refreshSession.revokedAt),
          ),
        )
        .returning({ id: refreshSession.id });

      return revoked.length;
    },

    /**
     * Revoke every unrevoked session belonging to ONE user, across ALL families.
     *
     * The password-change operation, and the only revocation in this repository that is not
     * family-scoped. The distinction is the whole point: `revokeFamily` and
     * `revokeFamilyBySessionId` deliberately spare a user's other devices, because logging out
     * of a phone must not sign them out of a laptop (§20). A password change is the opposite
     * case — the reason to change a password is that the old one may be known to someone else,
     * and every session established under it is therefore suspect.
     *
     * Keyed by `user_id`, which `ix_refresh_session_user` already indexes, so no new index is
     * needed. `store_id` is in the predicate alongside it rather than being trusted from the
     * caller's lookup: ids are unique within a store, and a repository method that could be
     * pointed at another tenant's rows by a single wrong argument is one refactor away from
     * being a cross-tenant write.
     *
     * `revoked_at IS NULL` makes it idempotent and, more importantly, non-destructive of
     * history — a session already revoked by logout keeps its original timestamp and reason
     * rather than being re-stamped as a password change.
     *
     * Rows are REVOKED, never deleted, matching every other method here. Reuse detection and
     * the audit trail both depend on the row surviving (§20).
     *
     * Returns the count for the security log. The endpoint does not expose it: how many
     * sessions a user had open is not something a password change needs to disclose.
     */
    async revokeAllForUser(params: {
      storeId: string;
      userId: string;
      reason: string;
      at: Date;
    }): Promise<number> {
      const revoked = await executor(db)
        .update(refreshSession)
        .set({ revokedAt: params.at, revokedReason: params.reason, updatedAt: params.at })
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            eq(refreshSession.userId, params.userId),
            isNull(refreshSession.revokedAt),
          ),
        )
        .returning({ id: refreshSession.id });

      return revoked.length;
    },
    /**
     * Revoke every unrevoked member of the family that a given session belongs to.
     *
     * The logout operation. Keyed by SESSION id, not family id, because the caller's access
     * token carries `sid` and nothing else — deriving the family server-side is what lets
     * logout work without the client naming, or being able to name, a family.
     *
     * ONE statement, with the family resolved by a subquery. Reading the family first and then
     * revoking would be two round trips with a window between them, and — more importantly —
     * would need the read to be store-checked separately. Here the store predicate appears in
     * BOTH the subquery and the outer `WHERE`, so:
     *
     *  - A session id belonging to another store resolves to no family, and the update matches
     *    nothing. A caller cannot revoke across tenants even with a valid id.
     *  - Even if the subquery somehow returned a foreign family, the outer predicate would
     *    still confine the write to this store's rows.
     *
     * Idempotent by construction: `revoked_at IS NULL` means a second logout matches zero rows
     * and returns 0 rather than failing or double-stamping a timestamp. An unknown session id
     * behaves identically, which is what keeps the endpoint from reporting whether a session
     * existed.
     *
     * Rows are REVOKED, never deleted — the audit trail and reuse detection both depend on the
     * row surviving. See `docs/DECISIONS.md` §20.
     */
    async revokeFamilyBySessionId(params: {
      storeId: string;
      sessionId: string;
      reason: string;
      at: Date;
    }): Promise<number> {
      const family = executor(db)
        .select({ familyId: refreshSession.familyId })
        .from(refreshSession)
        .where(
          and(eq(refreshSession.id, params.sessionId), eq(refreshSession.storeId, params.storeId)),
        );

      const revoked = await executor(db)
        .update(refreshSession)
        .set({ revokedAt: params.at, revokedReason: params.reason, updatedAt: params.at })
        .where(
          and(
            eq(refreshSession.storeId, params.storeId),
            inArray(refreshSession.familyId, family),
            isNull(refreshSession.revokedAt),
          ),
        )
        .returning({ id: refreshSession.id });

      return revoked.length;
    },
  };
}
