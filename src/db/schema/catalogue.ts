import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  codeColumn,
  moneyColumn,
  primaryId,
  slugColumn,
  softDelete,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';
import { store } from './store.js';

/**
 * The catalogue: products and the SKUs that are actually sold.
 *
 * `product` is the merchandising entity — the thing with a name, a description, a URL, and a
 * lifecycle. `sku` is the SELLABLE unit: the thing with a price, and the thing that inventory,
 * cart lines, order lines and tax classification will reference. Nothing buys a product.
 *
 * Both live in this file because they are one aggregate. Splitting them would suggest a
 * boundary that does not exist — a SKU has no meaning without its product, and the two are
 * written together in a single transaction on every mutation that touches either.
 *
 * Categories, inventory, media, variant option grids and pricing rules all belong to later
 * increments and are deliberately absent.
 */

/**
 * Product statuses.
 *
 * A plain `varchar` with a CHECK rather than a PostgreSQL `enum` type. Adding a value to a
 * PG enum is a migration that cannot run inside a transaction on older servers and cannot be
 * reversed at all; widening a CHECK is an ordinary `ALTER`. The set will grow — `scheduled`
 * is the obvious next one — so the cheaper-to-change form wins.
 */
export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const product = pgTable(
  'product',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /** URL segment. Unique per store, not globally — see the index below. */
    slug: slugColumn().notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    /**
     * Empty string rather than NULL. There is no meaningful difference between "no
     * description" and "an empty description" for a storefront, and a nullable column would
     * make every consumer handle both.
     */
    description: text('description').notNull().default(''),

    /**
     * Defaults to `draft`, and that default is the point.
     *
     * Creating a product must never publish it. A merchant filling in a form over several
     * minutes should not have a half-finished listing visible to customers between saves, and
     * the first public read endpoint will filter on `active` rather than trusting that every
     * row in the table is fit to show.
     */
    status: varchar('status', { length: 20 }).notNull().default('draft'),

    /**
     * DEPRECATED — superseded by `sku.price`. Read and written by nothing.
     *
     * Price belongs to the sellable unit, not the merchandising container: two sizes of one
     * shirt routinely differ in price, which a product-level column cannot express. Increment
     * 24 moved it to `sku.price`, backfilled one SKU per product, and dropped the `NOT NULL`.
     *
     * The column survives this increment ONLY as a migration safety net — a record of what
     * each product cost before the move, in case the SKU read path needed auditing. It is
     * dropped in Increment 25. Nothing in the application reads or writes it; a grep for
     * `product.price` should return this comment, the schema, and the migrations, and nothing
     * else.
     */
    price: moneyColumn('price'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * Slug uniqueness is per STORE and excludes deleted rows.
     *
     * Leading with `store_id` is what makes the catalogue genuinely multi-tenant: a global
     * unique index on `slug` would let the first merchant to create `blue-shirt` block every
     * other merchant on the platform from ever using that URL.
     *
     * Partial on `deleted_at IS NULL`, matching `uq_user_email_active`, so deleting a product
     * frees its slug for reuse rather than permanently reserving it.
     */
    uniqueIndex('uq_product_slug_active')
      .on(t.storeId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * The storefront's read path: this store's live products. Leads with `store_id` because
     * every catalogue query is store-scoped, and no query will ever filter on status alone.
     */
    index('ix_product_store_status').on(t.storeId, t.status),

    /**
     * Enforced in the database, not only in Zod.
     *
     * The API is not the only writer — a seed script, a bulk import, or an operator running
     * SQL during an incident all bypass application validation. A status the code cannot
     * interpret is worse than a rejected write.
     */
    check('ck_product_status', sql`${t.status} in ('draft', 'active', 'archived')`),
  ],
);

/**
 * A stock-keeping unit: the SELLABLE unit.
 *
 * Everything a sale touches attaches here rather than to the product — price now, and
 * inventory, cart lines, order lines and tax classification in later increments. A product
 * with no active SKU has nothing to sell, and the public read path treats it accordingly.
 *
 * Deliberately NOT a `variant` table with a `sku` table beneath it. A variant is a
 * relationship (a product plus a choice of option values), not an entity; a table between
 * product and SKU would be a synonym for SKU reached through an extra join. The option grid
 * that names those choices — Size, Colour — is Increment 25. SKUs here are option-less on
 * purpose, which is why nothing in this table references an option.
 */
export const sku = pgTable(
  'sku',
  {
    id: primaryId(),

    /**
     * Denormalised from `product.store_id`, deliberately.
     *
     * It is reachable through the product, so this column is redundant for correctness — and
     * it is here because every repository predicate in this codebase carries `store_id` in
     * its own `WHERE`. Requiring a join to enforce tenancy would make this the one table
     * where the store boundary lives somewhere else, which is exactly the erosion the
     * cross-store repository tests exist to prevent.
     */
    storeId: storeIdColumn(() => store.id),

    /**
     * `ON DELETE RESTRICT`, matching the store reference and for the same reason: products
     * are SOFT deleted, so a hard delete that still has SKUs attached is a bug and must fail
     * loudly rather than silently taking rows with it. The soft-delete cascade is done in the
     * service, inside the same transaction as the product's own deletion.
     */
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    /**
     * The merchant's own code. Case-SENSITIVE, per the `codeColumn` convention — unlike a
     * slug or an email, `ABC-1` and `abc-1` are legitimately different codes in a merchant's
     * own numbering, and normalising them would silently merge two products' identities.
     */
    code: codeColumn('code').notNull(),

    /**
     * A short display label — "500ml", "Large". Empty string rather than NULL, matching
     * `product.description`: there is no useful difference between "no label" and "an empty
     * label", and a nullable column would make every consumer handle both.
     */
    name: varchar('name', { length: 300 }).notNull().default(''),

    /**
     * `NUMERIC(19,4)`, per docs/DECISIONS.md §6. Never a float: binary floating point cannot
     * represent 0.10, and this value is summed into an invoice total.
     *
     * NO currency column. The store is the currency aggregate (`store.currency`), so a
     * per-SKU currency would let one cart mix currencies. Multi-currency pricing is a real
     * feature with its own table, not a column to add speculatively.
     */
    price: moneyColumn('price').notNull(),

    /**
     * Whether this SKU is currently sellable.
     *
     * A boolean, not a lifecycle. A SKU has no "draft" meaning independent of its product —
     * the product's `status` governs storefront visibility — and both transitions here are
     * always legal, so there is no state machine to enforce and no illegal transition to
     * reject. That is why `isActive` is an ordinary PATCH field rather than a pair of
     * explicit actions, which is the opposite of the choice §26 made for product status.
     */
    isActive: boolean('is_active').notNull().default(true),

    /**
     * The SKU's option combination, materialised as one canonical string.
     *
     * ## Why a column and not a query
     *
     * The invariant is "two SKUs of one product must not have the same complete combination",
     * and PostgreSQL cannot express that over a junction table: a unique index needs its
     * columns in ONE row, and the combination lives in 0..n rows of `sku_option_value`. A
     * materialised signature turns a multi-row fact into a single-column one, which is the
     * only shape a unique index can arbitrate.
     *
     * It is NOT a generated column: PostgreSQL generated columns cannot read another table.
     * The application maintains it, in the SAME transaction that rewrites the junction rows —
     * see `catalogue.service.ts`. That transaction boundary is the whole guarantee; without
     * it, `sku_option_value` and this column could disagree about what the SKU is.
     *
     * ## The format is STORAGE, not display
     *
     * Sorted `product_option_value` ids, lowercase canonical UUID text, joined with `,`.
     * Ids rather than names, because a rename must not change what combination a SKU
     * represents. Sorted, because `Red+Small` and `Small+Red` are the same variant and must
     * collide. Every element is exactly 36 characters from a fixed alphabet, so the encoding
     * is unambiguous — the delimiter is stated for readability in a log or a psql session, not
     * because concatenation alone would be lossy.
     *
     * **Never "improve" the ordering or the delimiter.** Doing so silently invalidates every
     * stored signature and every uniqueness guarantee built on them, with no error at the
     * moment of the change. `buildOptionSignature` is the one place it is computed, and a test
     * pins the exact string for a known pair of ids.
     *
     * `NOT NULL DEFAULT ''` rather than nullable: an option-less SKU has a KNOWN combination —
     * the empty one — and giving that fact two spellings (`NULL` and `''`) would make every
     * future reader guess which means what. The empty case is exempted by the partial index
     * below, not by a NULL. The default is also what makes the Increment 25 migration a no-op
     * for the option-less SKUs Increment 24 created.
     */
    optionSignature: text('option_signature').notNull().default(''),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * Merchant code uniqueness: per STORE, and freed on delete.
     *
     * Leading with `store_id` is what makes it multi-tenant — a global unique index on `code`
     * would let the first merchant to use `SHIRT-1` block every other merchant on the
     * platform. Partial on `deleted_at IS NULL`, matching `uq_product_slug_active`, so
     * deleting a SKU releases its code for reuse rather than reserving it forever.
     */
    uniqueIndex('uq_sku_code_active')
      .on(t.storeId, t.code)
      .where(sql`${t.deletedAt} IS NULL`),

    /** Every product detail page reads its SKUs, and the list batch-loads by product id. */
    index('ix_sku_product').on(t.productId),

    /**
     * Supports the `EXISTS` that decides public visibility and price matching. Leads with
     * `store_id` because that predicate is always store-scoped, and carries `is_active`
     * because an inactive SKU can never satisfy it.
     */
    index('ix_sku_store_active').on(t.storeId, t.isActive),

    /**
     * Enforced in the database, not only in Zod.
     *
     * The API is not the only writer — a bulk import or an operator running SQL during an
     * incident bypasses application validation entirely. A negative price would flow into a
     * cart total and then an invoice, where it becomes a credit nobody authorised.
     */
    check('ck_sku_price_non_negative', sql`${t.price} >= 0`),

    /**
     * **The concurrency arbiter for duplicate variant combinations.**
     *
     * Two staff requests can build the same combination at the same time; neither sees the
     * other's uncommitted junction rows, so both pre-checks pass. This index is what decides,
     * and the loser's whole transaction rolls back — which is why the signature write must
     * share the transaction with the junction rows rather than merely follow them. An
     * application check, an advisory lock, or a row lock would each be a weaker answer to a
     * question the database can settle exactly.
     *
     * Two predicates, both load-bearing:
     *
     *  - `option_signature <> ''` exempts option-less SKUs. Increment 24 created SKUs with no
     *    options and they remain legal, so many of them must coexist under one product.
     *  - `deleted_at IS NULL` frees the combination when the SKU is deleted. WITHOUT it, a
     *    soft-deleted SKU reserves its combination forever and a merchant can never re-create
     *    a variant they deleted — a 409 with no way out. Verified against PostgreSQL before
     *    this index was written. It is the same rule `uq_sku_code_active` applies to `code`.
     *
     * Scoped to `product_id`, not `store_id`: the question is "does this PRODUCT already have
     * this variant", and two products may legitimately share a combination. A product belongs
     * to exactly one store, so tenancy follows.
     */
    uniqueIndex('uq_sku_combination')
      .on(t.productId, t.optionSignature)
      .where(sql`${t.optionSignature} <> '' AND ${t.deletedAt} IS NULL`),

    /**
     * FK TARGET ONLY — `sku_option_value` references `(sku_id, product_id)`.
     *
     * PostgreSQL requires a unique constraint on exactly the referenced columns of a composite
     * foreign key; without this, the FK is rejected with "there is no unique constraint
     * matching given keys". Trivially unique because `id` is already the primary key, so it
     * adds no new guarantee about `sku` — its entire purpose is to let the junction table pin
     * a SKU's product, which is half of "a SKU option value belongs to the SKU's product".
     */
    uniqueIndex('uq_sku_id_product').on(t.id, t.productId),

    /** FK TARGET ONLY — `sku_option_value` references `(sku_id, store_id)`. Same reasoning. */
    uniqueIndex('uq_sku_id_store').on(t.id, t.storeId),
  ],
);

/**
 * A named option on one product — "Size", "Colour".
 *
 * The option belongs to a PRODUCT, not to the store and not to a shared library. Two products
 * that both offer "Size" own two independent options, which is what lets one sell S/M/L and
 * the other 39/40/41 without either constraining the other. Shared option templates are a
 * different feature with a different table.
 *
 * Soft-deleted, and deletion is REFUSED while a live SKU still uses one of its values — see
 * `catalogue.service.ts`. That combination of rules is what keeps every stored signature
 * meaningful: an id in a live signature always resolves to a row that still exists.
 */
export const productOption = pgTable(
  'product_option',
  {
    id: primaryId(),

    /** Denormalised, exactly as on `sku`, so every repository predicate carries its own scope. */
    storeId: storeIdColumn(() => store.id),

    /**
     * `RESTRICT`, matching `sku.product_id`. Products are soft-deleted, so a hard delete that
     * still has options attached is a bug and must fail loudly. The soft-delete cascade runs
     * in the service, inside the product's own transaction.
     */
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),

    /** The display label. Case is preserved; uniqueness ignores it — see the index below. */
    name: varchar('name', { length: 120 }).notNull(),

    /**
     * Display order. Small/Medium/Large is not alphabetical, and neither is any real option,
     * so an explicit order is the only one that can be right. Ties are broken by `id` at every
     * read site, so the ordering is total even when a merchant leaves every value at 0.
     */
    sortOrder: integer('sort_order').notNull().default(0),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * One option name per product, CASE-INSENSITIVELY, and freed on delete.
     *
     * `lower(name)` in the index is the enforcement — a migration-backed database mechanism,
     * not application lowercasing, so a bulk import or an operator running SQL cannot create
     * the duplicate that the API rejects. The column keeps the merchant's own capitalisation;
     * only the comparison is folded.
     *
     * Case-INSENSITIVE is the deliberate opposite of `sku.code`, and for a stated reason: a
     * SKU code is an identifier printed on purchase orders where `ABC-1` and `abc-1` may be
     * two different things, whereas "Size" and "size" are one option to every human who reads
     * them, and letting both exist would produce a variant grid with two identical columns.
     *
     * Scoped to `product_id`, which satisfies "different products may reuse identical option
     * names" directly, and tenancy through the product.
     */
    uniqueIndex('uq_product_option_name_active')
      .on(t.productId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),

    /** Every option read is "the options of this product" — the admin list and the mappers. */
    index('ix_product_option_product').on(t.productId),

    /**
     * FK TARGET ONLY — `product_option_value` references `(option_id, product_id)`, which is
     * what makes it impossible for a value to claim an option belonging to another product.
     */
    uniqueIndex('uq_product_option_id_product').on(t.id, t.productId),
  ],
);

/**
 * One selectable value of an option — "Small", "Red".
 *
 * `product_id` is denormalised here and it is LOAD-BEARING, not a convenience: paired with
 * `option_id` in a composite foreign key to `product_option(id, product_id)`, it makes "this
 * value's option belongs to this value's product" a fact the database checks rather than a
 * rule the application remembers.
 */
export const productOptionValue = pgTable(
  'product_option_value',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * No single-column FK to `product_option`. The composite key below covers this reference
     * AND the product agreement in one constraint; adding a second, weaker FK to the same
     * parent would be redundant and would imply the composite one was optional.
     */
    optionId: uuid('option_id').notNull(),

    /** Denormalised to close the composite key. Never written from a request. */
    productId: uuid('product_id').notNull(),

    value: varchar('value', { length: 120 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * The composite foreign key that enforces "an option value belongs to exactly one option,
     * and that option belongs to this value's product".
     *
     * Verified against PostgreSQL 16.15 before being written: inserting a value whose
     * `option_id` belongs to a different product than its `product_id` is rejected here, not
     * by any application check.
     */
    foreignKey({
      columns: [t.optionId, t.productId],
      foreignColumns: [productOption.id, productOption.productId],
      name: 'fk_pov_option_product',
    }).onDelete('restrict'),

    /** One value per option, case-insensitively, freed on delete. Same reasoning as the option. */
    uniqueIndex('uq_product_option_value_active')
      .on(t.optionId, sql`lower(${t.value})`)
      .where(sql`${t.deletedAt} IS NULL`),

    /** Values are always loaded by their option, nested into the option list. */
    index('ix_product_option_value_option').on(t.optionId),

    /** FK TARGET ONLY — `sku_option_value` references `(option_value_id, option_id)`. */
    uniqueIndex('uq_pov_id_option').on(t.id, t.optionId),

    /** FK TARGET ONLY — `sku_option_value` references `(option_value_id, product_id)`. */
    uniqueIndex('uq_pov_id_product').on(t.id, t.productId),
  ],
);

/**
 * Which option values a SKU carries: the variant combination, one row per option.
 *
 * ## Every invariant here is a database constraint
 *
 * The three denormalised columns exist to be halves of composite foreign keys. Read together
 * they make the following unrepresentable rather than merely rejected:
 *
 *  - the SKU's product is pinned by `(sku_id, product_id)`;
 *  - the value's product is pinned by `(option_value_id, product_id)`;
 *  - both must equal this row's own `product_id`, so **a SKU can never carry another product's
 *    option value** — with no application code involved;
 *  - `(sku_id, store_id)` pins tenancy the same way;
 *  - `(option_value_id, option_id)` guarantees `option_id` really is the value's option, which
 *    is what stops the obvious attack on the unique index below: writing a FALSE `option_id`
 *    to slip a second value of the same option past it.
 *
 * All six were attempted against PostgreSQL 16.15 during the design review and all six were
 * rejected by the database.
 *
 * ## Lifecycle
 *
 * No `deleted_at`, deliberately. These rows survive SKU and product soft-deletion untouched —
 * they are the historical record of what a SKU was — and a soft-delete flag would force
 * `uq_sov_sku_option` to become partial, at which point a SKU could accumulate many superseded
 * rows per option and its CURRENT combination would be a query rather than a fact.
 *
 * Combination REPLACEMENT is therefore the one operation that hard-deletes rows here. That is
 * not a contradiction: the history of an edit lives in the `sku.options_updated` event and its
 * audit entry, which carry the before and after combinations. Deleting a SKU or a product
 * deletes nothing from this table.
 *
 * No `updated_at`: a row is created or superseded, never edited.
 */
export const skuOptionValue = pgTable(
  'sku_option_value',
  {
    skuId: uuid('sku_id').notNull(),
    optionValueId: uuid('option_value_id').notNull(),

    /** Denormalised so one-value-per-option is expressible as a unique index. */
    optionId: uuid('option_id').notNull(),

    /** Denormalised to tie the SKU and the value to the same product. */
    productId: uuid('product_id').notNull(),

    /** Denormalised for the repository tenancy discipline every other table follows. */
    storeId: uuid('store_id').notNull(),

    /**
     * Justified rather than reflexive: these rows outlive their SKU as history, so when the
     * association was made is the only thing that dates them. There is no `updated_at` because
     * the row is never edited.
     */
    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /**
     * The pair IS the identity. A surrogate id would permit two rows stating one fact, and
     * nothing would ever need to address such a row by an id of its own.
     */
    primaryKey({ columns: [t.skuId, t.optionValueId], name: 'pk_sku_option_value' }),

    /**
     * **One value per option per SKU.** A SKU cannot be both Red and Blue.
     *
     * Only meaningful alongside `fk_sov_value_option` below, which proves `option_id` is
     * honest. Without that, a caller could write a fabricated `option_id` and this index would
     * cheerfully admit the second value.
     */
    uniqueIndex('uq_sov_sku_option').on(t.skuId, t.optionId),

    /** The SKU exists, belongs to this product, and is not another store's. */
    foreignKey({
      columns: [t.skuId, t.productId],
      foreignColumns: [sku.id, sku.productId],
      name: 'fk_sov_sku_product',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_sov_sku_store',
    }).onDelete('restrict'),

    /** `option_id` is genuinely this value's option — the guard on `uq_sov_sku_option`. */
    foreignKey({
      columns: [t.optionValueId, t.optionId],
      foreignColumns: [productOptionValue.id, productOptionValue.optionId],
      name: 'fk_sov_value_option',
    }).onDelete('restrict'),

    /** The value belongs to the same product as the SKU. The invariant with no code. */
    foreignKey({
      columns: [t.optionValueId, t.productId],
      foreignColumns: [productOptionValue.id, productOptionValue.productId],
      name: 'fk_sov_value_product',
    }).onDelete('restrict'),

    /**
     * Serves the DELETE GUARD: "is any live SKU still using this value?" runs on every option
     * and every value deletion. The primary key already leads with `sku_id`, so the reverse
     * direction is the one that would otherwise be a sequential scan.
     */
    index('ix_sov_option_value').on(t.optionValueId),
  ],
);
