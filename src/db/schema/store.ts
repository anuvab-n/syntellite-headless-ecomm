import { sql } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { currencyColumn, primaryId, slugColumn, storeIdColumn, timestamps } from './_shared.js';

/**
 * The tenant root.
 *
 * v1 launches with exactly one row. The table exists anyway, and every tenant-owned
 * table carries `store_id`, because retrofitting tenancy later means rewriting every
 * query, index, and unique constraint in the system.
 */
export const store = pgTable(
  'store',
  {
    id: primaryId(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: slugColumn().notNull(),
    /** Storefront hostname. Resolves an inbound request to its store. */
    domain: varchar('domain', { length: 255 }),

    currency: currencyColumn().notNull().default('INR'),
    /**
     * Currencies this store can transact in. A single ORDER is always one currency —
     * this list governs which one a customer may choose, not per-line mixing.
     */
    supportedCurrencies: text('supported_currencies')
      .array()
      .notNull()
      .default(sql`ARRAY['INR']::text[]`),
    defaultLocale: varchar('default_locale', { length: 10 }).notNull().default('en-IN'),
    /** IANA name, not an offset. Offsets are wrong twice a year. */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Kolkata'),

    /* ── Invoicing identity (GST) ─────────────────────────────────────── */
    legalName: varchar('legal_name', { length: 300 }),
    gstin: varchar('gstin', { length: 15 }),
    pan: varchar('pan', { length: 10 }),
    /**
     * The seller's own address. Drives the CGST/SGST vs IGST split: same state as the
     * customer means CGST+SGST, different means IGST.
     */
    registeredAddress: jsonb('registered_address').notNull().default({}),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_store_slug').on(t.slug),
    uniqueIndex('uq_store_domain')
      .on(t.domain)
      .where(sql`${t.domain} IS NOT NULL`),
  ],
);

/**
 * Store settings — the merchant-editable half of configuration.
 *
 * The dividing line: if a merchant would reasonably want to change it without calling an
 * engineer, it is a setting. Return window, free-shipping threshold, minimum order value,
 * whether guest checkout is allowed. If it is a credential or an endpoint, it is an
 * environment variable.
 *
 * This table is what makes the backend reusable across storefronts: launching a new store
 * is seed data, not a code change.
 */
export const storeSetting = pgTable(
  'store_setting',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),
    /** Namespaced, e.g. `returns.window_days`, `checkout.allow_guest`. */
    key: varchar('key', { length: 200 }).notNull(),
    /**
     * JSONB so a setting can be a number, a boolean, or a structure without a migration.
     * The application validates each key against a Zod schema in the settings registry —
     * an unvalidated read of this column is how a string "false" becomes truthy.
     */
    value: jsonb('value').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('uq_store_setting').on(t.storeId, t.key)],
);

/**
 * Feature flags — for ROLLOUT, not permanent configuration.
 *
 * A permanent switch is a store setting. A flag is temporary by definition, which is why
 * `removeByTicket` is NOT NULL: a codebase with 40 stale flags has 2^40 notional
 * configurations, none of them tested.
 */
export const featureFlag = pgTable(
  'feature_flag',
  {
    id: primaryId(),
    /**
     * NULL means platform-wide. A row carrying a store id overrides the platform default
     * for that store. Nullable, so this is the one tenant-aware table that does not use
     * `storeIdColumn()`.
     */
    storeId: uuid('store_id').references(() => store.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 200 }).notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    /**
     * 0–100. Hashed on user id, so a given user gets a stable answer rather than
     * flickering between variants on consecutive requests.
     */
    rolloutPercentage: smallint('rollout_percentage').notNull().default(0),
    description: text('description').notNull(),
    /** The ticket that deletes this flag. Required at creation. */
    removeByTicket: varchar('remove_by_ticket', { length: 64 }).notNull(),
    ...timestamps,
  },
  (t) => [
    // NULLS NOT DISTINCT (PostgreSQL 15+) so at most ONE platform-wide row can exist per
    // key. Without it, `store_id IS NULL` rows are all mutually distinct and the same
    // flag could be inserted twice with contradictory values.
    //
    // A table CONSTRAINT rather than an index, because `nullsNotDistinct` is only
    // expressible on the constraint builder in Drizzle.
    unique('uq_feature_flag_scope').on(t.storeId, t.key).nullsNotDistinct(),
  ],
);
