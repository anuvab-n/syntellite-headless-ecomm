import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, tsColumn } from './_shared.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * Password reset tokens.
 *
 * Modelled on `refresh_session` deliberately, down to the column names: a 64-character SHA-256
 * digest of a 256-bit random token, an expiry, and a nullable timestamp recording that it has
 * been spent. Reusing that shape means the reset flow inherits properties that were already
 * reasoned about once — see `refresh-token.ts` on why the hash is deterministic and unsalted,
 * and why that is correct for a high-entropy token and would be wrong for a password.
 *
 * ## The token itself is NEVER stored
 *
 * Only its digest. A dump of this table cannot be used to reset anybody's password, which is
 * the whole point: a reset token is a bearer credential for the single most sensitive operation
 * an account has, and storing it in plaintext would make this table equivalent to a table of
 * passwords.
 *
 * ## Single use, enforced by a column rather than by deletion
 *
 * `used_at` is set instead of the row being deleted. Two reasons. A spent token that is still
 * present can be recognised as spent — a second click on the same emailed link gets a clear
 * "already used" rather than an indistinguishable "invalid", which matters because the second
 * click is usually the same honest person. And an investigation into a compromised account
 * wants to see that a reset happened, which a deleted row cannot show.
 *
 * ## What is deliberately absent
 *
 * No email column: the address is on `app_user` and duplicating it here would be a second copy
 * of a PII field to keep in sync and to redact. No attempt counter — the token is 256 bits, so
 * there is nothing to brute force, and rate limiting on the endpoint is what defends the
 * enumeration surface. No IP or user agent: they would be a record of where a customer was, for
 * no operational gain.
 */
export const passwordResetToken = pgTable(
  'password_reset_token',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /** Whose password this token can change. */
    userId: uuid('user_id').notNull(),

    /**
     * SHA-256 hex of the token handed to the customer — 64 characters.
     *
     * Unique GLOBALLY rather than per store, and that is the correct scope for a secret: the
     * token is looked up by its digest alone, before any store is known, because the customer
     * clicking a link in an email supplies nothing else. A per-store constraint would permit
     * the same digest in two stores and make that lookup ambiguous.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),

    /**
     * When this token stops working.
     *
     * Short by design — see `PASSWORD_RESET_TTL_MINUTES`. A reset link is a password
     * equivalent sitting in an inbox, and an inbox is a place credentials get read from long
     * after they were needed.
     */
    expiresAt: tsColumn('expires_at').notNull(),

    /** Set the moment the token is spent. NULL means still usable. */
    usedAt: tsColumn('used_at'),

    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /** The lookup, and the guarantee that one digest identifies at most one token. */
    uniqueIndex('uq_password_reset_token').on(t.tokenHash),

    /**
     * Ownership AND tenancy in one constraint, matching every other reference to `app_user`.
     * A token that could name a user from another tenant is a cross-store account takeover.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_password_reset_user_store',
    }).onDelete('cascade'),

    /**
     * The purge scan, and the "invalidate this user's other tokens" write.
     *
     * Partial, so it covers only rows still worth looking at: a spent token is never read
     * again by either path.
     */
    index('ix_password_reset_user')
      .on(t.userId, t.storeId)
      .where(sql`${t.usedAt} IS NULL`),

    index('ix_password_reset_expiry')
      .on(t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),

    /**
     * A token cannot have been used before it was created.
     *
     * Cheap, and it is the invariant a clock skew or a bad backfill would break first.
     */
    check(
      'ck_password_reset_used_after_created',
      sql`${t.usedAt} IS NULL OR ${t.usedAt} >= ${t.createdAt}`,
    ),
  ],
);
