import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  codeColumn,
  GSTIN_LENGTH,
  GSTIN_PATTERN,
  primaryId,
  rateColumn,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * GST master data: tax classes, effective-dated rates, and customer tax identity.
 *
 * Three tables, and every one of them is CONFIGURATION rather than history. Nothing here is
 * ever read by a historical order — an order snapshots the resolved codes, names, rates and
 * amounts onto its own rows at checkout, which is what makes a rate change safe to make.
 *
 * ## What this file deliberately does NOT contain
 *
 * **No rates.** Not one. `tax_rate` is an empty table until a merchant configures it, and
 * there is no seed, no default, no fallback and no constant anywhere in this codebase naming a
 * GST percentage. Approved decision 11 — *"Tax rates are configurable, effective-dated master
 * data. NEVER hardcode GST rates"* — is enforced by the absence of any place to put one.
 *
 * **No HSN/SAC catalogue.** A code is a string a merchant types, validated for shape and
 * nothing else. Which code applies to which product is a classification the finance function
 * makes, and §40 already recorded why that kind of determination must not be buried in a CHECK
 * constraint: *"the finance function would later find it and have to live with it."*
 *
 * **No state-code catalogue.** A GST state code is a statutory numeric catalogue, and §43
 * declined to invent one. Place of supply is decided by comparing the seller's configured
 * origin state with the order's destination state, both normalised — see `tax.calculator.ts`
 * for exactly how, and the known limitation it carries.
 *
 * **No exemptions, no zero-rating, no reverse charge, no composition.** Each is a statutory
 * classification. A merchant who needs one configures a tax class whose rates are zero, which
 * records the FACT that a determination was made at a zero rate — genuinely different from an
 * order that was never assessed at all, and the two are distinguishable on the order row.
 */

/* ── Vocabularies ────────────────────────────────────────────────────────── */

/**
 * How a supply is taxed. Two values, and both are producible.
 *
 * `intra_state` carries CGST + SGST, `inter_state` carries IGST — approved decision 10. There
 * is deliberately no `export`, no `sez`, no `import` and no `exempt`: each is a statutory
 * classification with its own determination rules, and §26's standing rule applies — a status
 * value nothing can produce looks supported to every reader of the enum.
 */
export const SUPPLY_TYPES = ['intra_state', 'inter_state'] as const;
export type SupplyType = (typeof SUPPLY_TYPES)[number];

/**
 * How place of supply was arrived at. **One value today, and that is the point.**
 *
 * Approved decision 9: *"Do not hide statutory exceptions inside a generic state comparison.
 * Represent the calculation so future statutory exceptions can be added explicitly."* This
 * column is that representation. Every order records WHICH rule decided its place of supply,
 * so when a statutory exception is added it becomes a new value here rather than a silent
 * change in behaviour that no historical order can be distinguished by.
 */
export const PLACE_OF_SUPPLY_BASES = ['delivery_destination'] as const;
export type PlaceOfSupplyBasis = (typeof PLACE_OF_SUPPLY_BASES)[number];

/**
 * B2B or B2C, and the rule is exactly approved decision 8: a valid customer GSTIN supplied for
 * the transaction means B2B, anything else means B2C.
 *
 * No third value. No "unregistered", no "government", no "composition" — decision 8 says
 * plainly *"Do not invent additional customer classification rules."*
 */
export const CUSTOMER_TAX_CATEGORIES = ['b2b', 'b2c'] as const;
export type CustomerTaxCategory = (typeof CUSTOMER_TAX_CATEGORIES)[number];

/**
 * The ceiling on any single configured rate component, as a percentage.
 *
 * **Not a GST slab and not a statutory maximum** — it is a sanity bound that stops a typo
 * turning 18 into 1800 and charging a customer eighteen times the goods value. Mirrors
 * `MAX_PROMOTION_PERCENT`, which exists for the same reason and says the same thing.
 */
export const MAX_TAX_RATE_PERCENT = 100;

/* ── Tax class ───────────────────────────────────────────────────────────── */

/**
 * A tax classification: the thing a SKU points at, and the thing rates hang off.
 *
 * Deliberately holds NO percentage. Rates are effective-dated and a class is not — putting a
 * rate here would mean either losing the old value on every change (destroying the ability to
 * reprice a historical order correctly) or versioning the class itself, which is the same
 * table split done worse. `tax_rate` below is that split, done deliberately.
 *
 * **No soft delete.** A class is deactivated, not deleted, and nothing historical depends on
 * it surviving: an order line snapshots the code and the name as TEXT. `is_active` is an
 * ordinary boolean rather than a lifecycle for the same reason `sku.is_active` is — both
 * transitions are always legal, so there is no state machine to enforce.
 */
export const taxClass = pgTable(
  'tax_class',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * The merchant's own classification code — `GST-5`, `APPAREL-STD`, whatever their
     * accountant uses. Case-SENSITIVE, per the `codeColumn` convention and matching `sku.code`:
     * a merchant's own numbering may legitimately distinguish case, and normalising would
     * silently merge two classifications.
     *
     * This is what the admin API addresses a class by, so no internal id ever appears in a URL.
     */
    code: codeColumn('code').notNull(),

    /** What it means, for the staff member choosing one. Snapshotted onto the order line. */
    name: varchar('name', { length: 300 }).notNull(),

    /**
     * Whether new checkouts may resolve this class.
     *
     * Deactivating does NOT affect a historical order: the order line carries its own copy of
     * the code and name. It affects the next checkout of a SKU that points here, which is
     * refused rather than silently untaxed — see `tax.service.ts`.
     */
    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
  },
  (t) => [
    /**
     * One code per store. Leading with `store_id` is what makes it multi-tenant — a global
     * unique index would let the first merchant to use `GST-5` block every other merchant.
     *
     * Not partial on a delete flag, because there is no delete flag: a deactivated class keeps
     * its code, which is correct — reusing the code of a class that historical orders name
     * would make two different classifications indistinguishable in an audit.
     */
    uniqueIndex('uq_tax_class_code').on(t.storeId, t.code),

    /**
     * FK-target index for `tax_rate` and `sku`.
     *
     * Adds no guarantee of its own — `id` is the primary key — and exists solely because
     * PostgreSQL requires a unique constraint on exactly the referenced columns. Like every
     * one of its kind in this schema it must be created BEFORE the keys that reference it;
     * drizzle-kit emits them the other way round, which is the fault §43, §44 and §46 record.
     */
    uniqueIndex('uq_tax_class_id_store').on(t.id, t.storeId),

    /** `NOT NULL` alone would admit `''`, which is a class nobody can identify. */
    check(
      'ck_tax_class_not_blank',
      sql`length(btrim(${t.code})) > 0 AND length(btrim(${t.name})) > 0`,
    ),
  ],
);

/* ── Tax rate ────────────────────────────────────────────────────────────── */

/**
 * An effective-dated set of rate components for one tax class.
 *
 * **The whole reason this is a separate, dated table:** a rate change must not restate a
 * historical order. Approved decision 14 requires tax facts be snapshotted at the transaction
 * boundary, and this table is what makes the snapshot reproducible — the rate that applied on
 * a given date is still readable here after three later changes.
 *
 * ## Components are stored separately, never blended
 *
 * CGST, SGST, IGST and cess each get their own column. A single blended percentage would be
 * unable to produce a compliant breakdown later, and reconstructing the split from a total is
 * exactly the kind of derivation that goes wrong at the boundary between two slabs.
 *
 * **No relationship between the components is enforced.** The conventional Indian arrangement
 * is that IGST equals CGST plus SGST, and it is deliberately NOT a CHECK: that is an
 * accounting relationship, not a mathematical one, and encoding it here would make this
 * schema the authority on a rule the finance function owns. The service does not assume it
 * either — it reads whichever components the supply type calls for.
 */
export const taxRate = pgTable(
  'tax_rate',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    taxClassId: uuid('tax_class_id').notNull(),

    /** Percentages, `NUMERIC(9,6)` — the type `_shared.ts` designates for "a tax percentage". */
    cgstRate: rateColumn('cgst_rate').notNull(),
    sgstRate: rateColumn('sgst_rate').notNull(),
    igstRate: rateColumn('igst_rate').notNull(),

    /**
     * Cess, where a class attracts one. Defaults to zero rather than being nullable: a class
     * with no cess has a KNOWN cess of nothing, and giving that fact two spellings would make
     * every consumer handle both — the same argument `sku.option_signature` makes for `''`.
     */
    cessRate: rateColumn('cess_rate').notNull().default('0'),

    /**
     * When this rate starts applying. Inclusive.
     *
     * Compared against the order's AUTHORITATIVE TAX INSTANT, not against `now()` at read
     * time, so re-reading a historical order can never select a rate that did not exist when
     * it was placed.
     */
    effectiveFrom: tsColumn('effective_from').notNull(),

    /**
     * When it stops. **Exclusive**, and NULL means open-ended.
     *
     * Half-open, matching every other range in this system — `promotion.ends_at` is exclusive
     * for the same reason: a rate ending at midnight must not also apply at midnight, or two
     * rates are simultaneously in force for one instant.
     */
    effectiveTo: tsColumn('effective_to'),

    ...timestamps,
  },
  (t) => [
    /**
     * Tenancy AND parenthood in one constraint: the rate's class must exist, and its store
     * must be that class's store. A rate pointing at another tenant's classification is
     * unrepresentable rather than merely rejected in application code.
     *
     * RESTRICT, matching every other reference in this schema: a class with rates attached
     * cannot be hard-deleted, and there is no delete path anyway.
     */
    foreignKey({
      columns: [t.taxClassId, t.storeId],
      foreignColumns: [taxClass.id, taxClass.storeId],
      name: 'fk_tax_rate_class_store',
    }).onDelete('restrict'),

    /**
     * **Overlap prevention, part one: no two rates for one class may start at the same
     * instant.**
     *
     * Without it, two rates starting together are both "the latest one at or before the tax
     * instant" and the choice between them is whatever the planner happens to return.
     */
    uniqueIndex('uq_tax_rate_class_from').on(t.storeId, t.taxClassId, t.effectiveFrom),

    /**
     * **Overlap prevention, part two: at most ONE open-ended rate per class.**
     *
     * An open-ended rate overlaps everything after its start, so two of them always conflict.
     * This is the half of the overlap invariant a plain index can express, and it is the half
     * that matters most in practice — a merchant adding a new rate without closing the old one
     * is the mistake that actually happens.
     *
     * ## Why not an EXCLUDE constraint
     *
     * `EXCLUDE USING gist (store_id WITH =, tax_class_id WITH =, tstzrange(...) WITH &&)` would
     * express the invariant exactly and in one line. It needs the `btree_gist` extension, which
     * is not a trusted extension and therefore requires superuser in a migration — a privilege
     * this project's migration runner should not need and one a managed provider may withhold.
     * Drizzle also cannot express EXCLUDE, so the constraint would live only in hand-written
     * SQL and be invisible to `db:generate`.
     *
     * The remaining case — two CLOSED ranges that overlap — is closed by the service, which
     * takes the `tax_class` row lock before inserting a rate and re-checks under it. That lock
     * is what makes the check a decision rather than a guess; see `tax.service.ts`.
     */
    uniqueIndex('uq_tax_rate_class_open')
      .on(t.storeId, t.taxClassId)
      .where(sql`${t.effectiveTo} IS NULL`),

    /**
     * The resolution query: "the rate for this class in force at this instant", newest first.
     * Store-scoped and class-scoped because that predicate is never anything else.
     */
    index('ix_tax_rate_lookup').on(t.storeId, t.taxClassId, t.effectiveFrom),

    /**
     * Sanity bounds, enforced here because the API is not the only writer.
     *
     * Non-negative because a negative rate is a credit nobody authorised — the same sentence
     * `ck_sku_price_non_negative` was written for. Bounded above because a typo that multiplies
     * a rate by a hundred should fail at the constraint, not on a customer's card.
     */
    check(
      'ck_tax_rate_range',
      sql`${t.cgstRate} >= 0 AND ${t.cgstRate} <= ${sql.raw(String(MAX_TAX_RATE_PERCENT))}
          AND ${t.sgstRate} >= 0 AND ${t.sgstRate} <= ${sql.raw(String(MAX_TAX_RATE_PERCENT))}
          AND ${t.igstRate} >= 0 AND ${t.igstRate} <= ${sql.raw(String(MAX_TAX_RATE_PERCENT))}
          AND ${t.cessRate} >= 0 AND ${t.cessRate} <= ${sql.raw(String(MAX_TAX_RATE_PERCENT))}`,
    ),

    /** A window that closes before it opens is not a window. Exclusive, so equality fails too. */
    check(
      'ck_tax_rate_period',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/* ── Customer tax identity ───────────────────────────────────────────────── */

/**
 * A customer's GST registration. **The third thing §43 named and declined to build.**
 *
 * That section settled where a customer GSTIN does NOT belong — *"putting tax registration in
 * a delivery address would conflate two of them"* — and approved decision 7 restates it. This
 * table is the third thing itself: not address data, not seller identity, and not order-time
 * tax determination.
 *
 * ## Deliberately one row per user, and deliberately tiny
 *
 * A GSTIN and the registered name that goes with it. No billing address, no place of business,
 * no multiple registrations, no verification state, no expiry. Approved Phase 1B is explicit:
 * *"Do not build a broad customer-profile redesign."* Each of those is a feature with no
 * consumer, and §27 already refused defaults on addresses on exactly that ground.
 *
 * ## Mutable, and that is safe
 *
 * A customer may correct or remove their GSTIN at any time, and an order placed before the
 * change is unaffected: `order.customer_gstin` is a snapshot taken at checkout. That is the
 * §40 rule — *"the moment a past invoice reads a live address, a customer fixing a typo
 * rewrites history"* — applied to tax identity, and Phase 8 asserts it directly.
 */
export const customerTaxIdentity = pgTable(
  'customer_tax_identity',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * The owner. No single-column FK to `app_user`: the composite key below covers the
     * reference AND the store agreement in one constraint, and a second weaker key to the same
     * parent would imply the composite one was optional.
     */
    userId: uuid('user_id').notNull(),

    /** Shape-validated in the database as well as at the boundary. See {@link GSTIN_PATTERN}. */
    gstin: varchar('gstin', { length: GSTIN_LENGTH }).notNull(),

    /**
     * The registered legal name the GSTIN belongs to.
     *
     * Required, and deliberately not defaulted from the customer's account name: a GST
     * registration belongs to a business, and `app_user.first_name` is a person. Snapshotting
     * the wrong one onto an invoice is the kind of error nobody notices until an audit.
     */
    legalName: varchar('legal_name', { length: 300 }).notNull(),

    ...timestamps,
  },
  (t) => [
    /**
     * Ownership AND tenancy in one constraint, matching `fk_address_user_store` exactly: the
     * row's user must exist, and its store must be that user's store. A cross-store tax
     * identity is unrepresentable rather than merely refused by application code.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_customer_tax_identity_user_store',
    }).onDelete('restrict'),

    /**
     * **One per user.** Not `(store_id, user_id)`: `app_user.id` is a UUIDv7 primary key,
     * globally unique on its own, so adding `store_id` would WEAKEN the constraint rather than
     * scope it — a composite unique would permit two identities for one user if a caller ever
     * supplied the wrong store. The same reasoning `uq_shipment_order` records.
     */
    uniqueIndex('uq_customer_tax_identity_user').on(t.userId),

    check('ck_customer_tax_identity_gstin', sql`${t.gstin} ~ ${sql.raw(`'${GSTIN_PATTERN}'`)}`),

    check('ck_customer_tax_identity_legal_name', sql`length(btrim(${t.legalName})) > 0`),
  ],
);
