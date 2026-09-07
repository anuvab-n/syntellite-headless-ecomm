import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { passwordResetToken } from '../../db/schema/password-reset.js';
import { executor } from '../../db/transaction.js';
import { newId } from '../../shared/id.js';

/**
 * Password reset token persistence.
 *
 * A sibling of `refresh-session.repository.ts`, and shaped the same way: issue, look up by
 * digest, spend, and revoke in bulk. `executor(db)` throughout, so the spend and the password
 * update commit together — a reset that changed the password but left the token usable would be
 * a second free takeover.
 */

export type PasswordResetRepository = ReturnType<typeof createPasswordResetRepository>;

/** A token row, as the service needs it. The digest is never returned — nothing needs it back. */
export type PasswordResetRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
};

export function createPasswordResetRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Issue a token, and invalidate this user's outstanding ones in the same breath.
     *
     * Invalidating first is a security decision, not tidiness. Without it, every "forgot
     * password" a customer clicks leaves another live token in another email, and the account
     * stays resettable by the oldest of them for an hour. One request, one live token.
     *
     * Called inside the caller's transaction, so the invalidation and the new row are atomic —
     * a partial application would either leave two live tokens or none.
     */
    async issue(params: {
      storeId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      at: Date;
    }): Promise<void> {
      await executor(db)
        .update(passwordResetToken)
        .set({ usedAt: params.at })
        .where(
          and(
            eq(passwordResetToken.userId, params.userId),
            eq(passwordResetToken.storeId, params.storeId),
            isNull(passwordResetToken.usedAt),
          ),
        );

      await executor(db).insert(passwordResetToken).values({
        id: newId(),
        storeId: params.storeId,
        userId: params.userId,
        tokenHash: params.tokenHash,
        expiresAt: params.expiresAt,
        createdAt: params.at,
      });
    },

    /**
     * Find a token by its digest.
     *
     * **Not scoped by store, and that is deliberate.** A customer clicking a link in an email
     * supplies the token and nothing else — no session, no store header — so the token IS the
     * lookup key, and the store comes back FROM the row. `uq_password_reset_token` is global for
     * exactly this reason.
     *
     * Returns the row whether or not it is expired or spent. The service decides what those
     * mean; a repository that filtered them out could not tell "already used" from "never
     * existed", and those deserve different answers.
     */
    async findByHash(tokenHash: string): Promise<PasswordResetRecord | undefined> {
      const [row] = await executor(db)
        .select({
          id: passwordResetToken.id,
          storeId: passwordResetToken.storeId,
          userId: passwordResetToken.userId,
          expiresAt: passwordResetToken.expiresAt,
          usedAt: passwordResetToken.usedAt,
        })
        .from(passwordResetToken)
        .where(eq(passwordResetToken.tokenHash, tokenHash))
        .limit(1);
      return row;
    },

    /**
     * Spend a token.
     *
     * The `used_at IS NULL` predicate is in the statement, so two concurrent resets with one
     * token resolve to a single winner — and the loser learns it lost from a row count rather
     * than by setting a second password. This is the compare-and-set that makes "single use"
     * true under concurrency rather than merely intended.
     */
    async markUsed(params: { id: string; at: Date }): Promise<boolean> {
      const updated = await executor(db)
        .update(passwordResetToken)
        .set({ usedAt: params.at })
        .where(and(eq(passwordResetToken.id, params.id), isNull(passwordResetToken.usedAt)))
        .returning({ id: passwordResetToken.id });
      return updated.length === 1;
    },

    /**
     * Delete spent and expired rows.
     *
     * Has no caller yet — the scheduler registers recurring work in the increment that needs
     * it, and this table grows only as fast as customers forget passwords. On the contract and
     * covered by a test so the sweeper is a one-line registration when it is due, matching how
     * `purgeExpired` sits on the idempotency store.
     */
    async purge(params: { before: Date }): Promise<number> {
      const deleted = await executor(db)
        .delete(passwordResetToken)
        .where(
          sql`(${passwordResetToken.usedAt} IS NOT NULL OR ${passwordResetToken.expiresAt} < ${params.before})
              AND ${passwordResetToken.createdAt} < ${params.before}`,
        )
        .returning({ id: passwordResetToken.id });
      return deleted.length;
    },

    /** Count this user's live tokens. For tests, and for an operator answering "why so many?". */
    async countLive(params: { userId: string; storeId: string; at: Date }): Promise<number> {
      const rows = await executor(db)
        .select({ id: passwordResetToken.id })
        .from(passwordResetToken)
        .where(
          and(
            eq(passwordResetToken.userId, params.userId),
            eq(passwordResetToken.storeId, params.storeId),
            isNull(passwordResetToken.usedAt),
            lt(sql`${params.at}`, passwordResetToken.expiresAt),
          ),
        );
      return rows.length;
    },
  };
}
