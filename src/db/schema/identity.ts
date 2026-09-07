import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { primaryId, softDelete, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { store } from './store.js';

/**
 * The user account.
 *
 * Email login from the first migration — there is no username column and never will be.
 * Retrofitting the login identifier means reissuing every credential in the system.
 *
 * Scoped per store: the same person shopping at two storefronts has two accounts. That
 * matches the reference schema and keeps a merchant's customer list genuinely theirs.
 */
export const appUser = pgTable(
  'app_user',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * Normalised to lowercase at the API boundary, but uniqueness is enforced on
     * `lower(email)` in the index below — so a code path that forgets to normalise
     * produces a constraint violation rather than a duplicate account.
     */
    email: varchar('email', { length: 320 }).notNull(),
    phone: varchar('phone', { length: 20 }),

    /**
     * Argon2id. The column is wide enough for the full PHC string including the
     * algorithm, version, and parameters, so the cost factors can be raised later and
     * old hashes still verify (and get rehashed on next successful login).
     */
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),

    firstName: varchar('first_name', { length: 150 }).notNull().default(''),
    lastName: varchar('last_name', { length: 150 }).notNull().default(''),

    isActive: boolean('is_active').notNull().default(true),
    /** Grants access to the admin API surface at all. Scopes decide what within it. */
    isStaff: boolean('is_staff').notNull().default(false),
    isSuperuser: boolean('is_superuser').notNull().default(false),

    emailVerifiedAt: tsColumn('email_verified_at'),
    phoneVerifiedAt: tsColumn('phone_verified_at'),
    acceptsMarketing: boolean('accepts_marketing').notNull().default(false),
    lastLoginAt: tsColumn('last_login_at'),

    /**
     * Soft delete, because erasure under DPDP/GDPR ANONYMISES rather than deletes: tax
     * law requires invoice retention, so the order survives with a scrubbed customer.
     */
    ...softDelete,
    ...timestamps,
  },
  (t) => [
    // Partial + expression: one active account per email per store, case-insensitive.
    // Excluding soft-deleted rows lets an erased customer sign up again later.
    uniqueIndex('uq_user_email_active')
      .on(t.storeId, sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('uq_user_phone_active')
      .on(t.storeId, t.phone)
      .where(sql`${t.deletedAt} IS NULL AND ${t.phone} IS NOT NULL`),

    /**
     * FK TARGET ONLY — `address` references `(user_id, store_id)`.
     *
     * PostgreSQL requires a unique constraint on exactly the referenced columns of a composite
     * foreign key; without this, the key is rejected with "there is no unique constraint
     * matching given keys". Trivially unique because `id` is already the primary key, so it
     * adds no new guarantee about `app_user` — its entire purpose is to let a child table pin
     * a row's owner AND that owner's store in one constraint, so a cross-store child row is
     * unrepresentable rather than merely rejected by application code.
     *
     * The same pattern `uq_sku_id_store` established for `sku_option_value` and `stock_item`.
     */
    uniqueIndex('uq_app_user_id_store').on(t.id, t.storeId),
  ],
);

/**
 * Refresh sessions.
 *
 * Access tokens are RS256 JWTs, 15 minutes, stateless — fast to verify, impossible to
 * revoke. Refresh tokens are the opposite: opaque, long-lived, and stored HERE so that
 * logout, "sign out everywhere", and breach response actually work. That asymmetry is the
 * whole point of the design.
 *
 * Rotation: presenting a refresh token issues a new one and marks this row consumed. A
 * SECOND presentation of an already-consumed token means the token leaked — the response
 * is to revoke the entire family (`familyId`), not just that row.
 */
export const refreshSession = pgTable(
  'refresh_session',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    /**
     * SHA-256 of the token, never the token itself. A database dump must not hand an
     * attacker live sessions. Argon2 is unnecessary here: the token is 256 bits of
     * entropy, so there is nothing to brute-force.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),

    /**
     * Groups every token descended from one login. Reuse of a consumed token revokes the
     * whole family — the standard detection for a stolen refresh token.
     */
    familyId: uuid('family_id').notNull(),

    expiresAt: tsColumn('expires_at').notNull(),
    /** Set when rotated. A non-null value plus an incoming use is the theft signal. */
    consumedAt: tsColumn('consumed_at'),
    revokedAt: tsColumn('revoked_at'),
    /** Why it was revoked: `logout`, `rotation_reuse`, `password_change`, `admin`. */
    revokedReason: varchar('revoked_reason', { length: 64 }),

    /** For the "your devices" view and for forensics. Not used for authorization. */
    userAgent: varchar('user_agent', { length: 512 }),
    ipAddress: varchar('ip_address', { length: 45 }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_refresh_session_token').on(t.tokenHash),
    index('ix_refresh_session_user').on(t.userId),
    index('ix_refresh_session_family').on(t.familyId),
    // Drives the sweeper that deletes expired rows. Partial, so it stays small.
    index('ix_refresh_session_expiry')
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

/**
 * Immutable audit trail for security-relevant and privileged actions.
 *
 * Written in Phase 0 so the habit exists before there is anything interesting to audit.
 * Append-only: there is no update or delete path, and the migration adds a rule
 * enforcing that at the database level.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    /** NULL for platform-level actions that precede store resolution. */
    storeId: uuid('store_id').references(() => store.id, { onDelete: 'restrict' }),
    /** NULL for anonymous or system actors. */
    actorUserId: uuid('actor_user_id').references(() => appUser.id, { onDelete: 'set null' }),
    /** `staff`, `customer`, `system`, `job`. */
    actorType: varchar('actor_type', { length: 32 }).notNull(),

    /** Dotted and stable, e.g. `order.refunded`, `auth.login_failed`. */
    action: varchar('action', { length: 128 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }),
    resourceId: varchar('resource_id', { length: 64 }),

    /** Before/after diff, or the reason a privileged action was taken. Never secrets. */
    metadata: jsonb('metadata').notNull().default({}),

    requestId: varchar('request_id', { length: 64 }),
    ipAddress: varchar('ip_address', { length: 45 }),

    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('ix_audit_log_store_time').on(t.storeId, t.createdAt),
    index('ix_audit_log_actor').on(t.actorUserId, t.createdAt),
    index('ix_audit_log_resource').on(t.resourceType, t.resourceId),
  ],
);
