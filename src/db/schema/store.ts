import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  currencyColumn,
  GSTIN_LENGTH,
  GSTIN_PATTERN,
  PAN_PATTERN,
  primaryId,
  slugColumn,
  storeIdColumn,
  timestamps,
} from './_shared.js';

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

    /**
     * **The seller of record.** Approved decision 2: the STORE is the seller, not the
     * platform.
     *
     * Present since the first migration and dead until Increment 38, which gave them a
     * staff-only write path and made them the source of the seller identity a taxed order
     * snapshots. Nullable, because a store that has not configured GST has none of them —
     * and `ck_store_tax_profile` below makes "half configured" unrepresentable.
     */
    legalName: varchar('legal_name', { length: 300 }),
    gstin: varchar('gstin', { length: GSTIN_LENGTH }),

    /**
     * Optional, and deliberately NOT part of the all-or-nothing group below: a GSTIN already
     * embeds the PAN, so requiring it separately would refuse a complete tax profile over a
     * field the seller has already supplied inside another one.
     */
    pan: varchar('pan', { length: 10 }),

    /**
     * **Superseded by the typed `origin_*` columns below. Nothing reads it.**
     *
     * It was introduced as the seller's address and documented as driving the CGST/SGST vs
     * IGST split. Increment 38 declined to use it: an untyped `jsonb` defaulting to `{}` has
     * no shape, no validator and no NOT NULL on anything inside it, so a tax determination
     * resting on it would rest on whatever an operator happened to write. Place of supply is
     * the single most consequential field on a tax invoice; it does not belong in a blob.
     *
     * Kept rather than dropped because dropping a column is destructive and this one may hold
     * values a merchant entered directly. It is not read anywhere and must not become the tax
     * source of truth.
     */
    registeredAddress: jsonb('registered_address').notNull().default({}),

    /**
     * **The GST origin / dispatch address. One per store — approved decision 3.**
     *
     * Multi-warehouse origin is deferred, so this is a single set of columns on the tenant
     * root rather than a table. Typed columns rather than the blob above, and rather than a
     * reference to the customer `address` table: an origin is the seller's own place of
     * business, not somebody's delivery address, and reusing that table would put a
     * merchant's registered premises in a customer's address book.
     *
     * `origin_state` is the seller half of the CGST/SGST-versus-IGST comparison. Free text and
     * no state code, because §43 declined to invent a GST state-code catalogue and Increment
     * 38 was told not to invent one either — see `tax.calculator.ts` for how the comparison is
     * normalised and the limitation that carries.
     */
    originLine1: varchar('origin_line1', { length: 300 }),
    originLine2: varchar('origin_line2', { length: 300 }).notNull().default(''),
    originCity: varchar('origin_city', { length: 120 }),
    originState: varchar('origin_state', { length: 120 }),
    originPostalCode: varchar('origin_postal_code', { length: 16 }),
    originCountryCode: char('origin_country_code', { length: 2 }),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('uq_store_slug').on(t.slug),
    uniqueIndex('uq_store_domain')
      .on(t.domain)
      .where(sql`${t.domain} IS NOT NULL`),

    /**
     * **The tax profile is all-or-nothing, and this constraint is what makes GST safe to
     * switch on.**
     *
     * Either every field a tax determination needs is present, or none of them is. A store
     * with a GSTIN but no origin state would produce orders whose place-of-supply comparison
     * has only one side — and the failure would surface as silently wrong tax rather than as
     * an error, which is the worst possible shape for an accounting bug.
     *
     * It also gives the rest of the system ONE predicate for "is GST configured for this
     * store", which `tax.service.ts` uses to decide whether a checkout is assessed at all.
     * Two half-answers to that question is how a store ends up taxing some orders and not
     * others. Same shape as `ck_order_promotion_snapshot`, and for the same reason: half a
     * snapshot leaves the read path deciding which half to believe.
     */
    check(
      'ck_store_tax_profile',
      sql`(${t.gstin} IS NULL AND ${t.legalName} IS NULL AND ${t.originLine1} IS NULL
           AND ${t.originCity} IS NULL AND ${t.originState} IS NULL
           AND ${t.originPostalCode} IS NULL AND ${t.originCountryCode} IS NULL)
          OR (${t.gstin} IS NOT NULL AND ${t.legalName} IS NOT NULL AND ${t.originLine1} IS NOT NULL
           AND ${t.originCity} IS NOT NULL AND ${t.originState} IS NOT NULL
           AND ${t.originPostalCode} IS NOT NULL AND ${t.originCountryCode} IS NOT NULL)`,
    ),

    /** Shape, in the database as well as at the boundary. See {@link GSTIN_PATTERN}. */
    check(
      'ck_store_gstin',
      sql`${t.gstin} IS NULL OR ${t.gstin} ~ ${sql.raw(`'${GSTIN_PATTERN}'`)}`,
    ),
    check('ck_store_pan', sql`${t.pan} IS NULL OR ${t.pan} ~ ${sql.raw(`'${PAN_PATTERN}'`)}`),

    /** Two uppercase ASCII letters, matching `ck_address_country_code_shape` exactly. */
    check(
      'ck_store_origin_country_code_shape',
      sql`${t.originCountryCode} IS NULL OR ${t.originCountryCode} ~ '^[A-Z]{2}$'`,
    ),

    /**
     * `NOT NULL` alone would admit `''`, and an origin with an empty state is an origin that
     * cannot answer the only question it exists to answer. `origin_line2` is absent from this
     * list on purpose: it defaults to `''` and is genuinely optional, exactly as on `address`.
     */
    check(
      'ck_store_tax_profile_not_blank',
      sql`(${t.legalName} IS NULL OR length(btrim(${t.legalName})) > 0)
          AND (${t.originLine1} IS NULL OR length(btrim(${t.originLine1})) > 0)
          AND (${t.originCity} IS NULL OR length(btrim(${t.originCity})) > 0)
          AND (${t.originState} IS NULL OR length(btrim(${t.originState})) > 0)
          AND (${t.originPostalCode} IS NULL OR length(btrim(${t.originPostalCode})) > 0)`,
    ),
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
