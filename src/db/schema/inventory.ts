import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { sku } from './catalogue.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * Inventory: what is in stock, and every change that ever made it so.
 *
 * ## Two tables, and which one is the truth
 *
 * `stock_ledger` is the SOURCE OF TRUTH — append-only, one row per movement, per
 * docs/DECISIONS.md §3 decision 7. `stock_item` is a PROJECTION of it: the current state, kept
 * so that "what is in stock?" is one indexed row read rather than a `SUM` over an
 * ever-growing table. The two are written in one transaction and are reconcilable —
 * `SUM(delta) = on_hand` must hold for every SKU, and a test asserts it.
 *
 * ## Inventory hangs off the SKU, never the product
 *
 * The SKU is the sellable unit, so it is the thing that can be in stock. Nothing here
 * references `product`; the product is reachable through the SKU when a consumer needs it.
 *
 * ## What is deliberately absent
 *
 * No warehouse or location: no such abstraction exists anywhere in this codebase, and
 * inventing one would be a guess at multi-location semantics nobody has asked for. When it
 * arrives it adds a `location_id` to both tables and widens `stock_item`'s primary key — the
 * seam is recorded rather than built.
 *
 * No cost price, batch, lot, expiry, supplier, or reorder threshold. Each belongs to a
 * different increment, and each would encode a business rule this increment has not been given.
 */

/**
 * Why an adjustment happened — a TECHNICAL vocabulary, deliberately small.
 *
 * These three describe the MECHANISM of a change, not its accounting treatment. `damage`,
 * `theft`, `shrinkage`, `write_off`, `expiry` and `stocktake_variance` are all absent on
 * purpose: each determines which ledger a loss is posted to and how it is treated for tax,
 * which is an accounting determination and not one to bury in a CHECK constraint. An operator
 * records intent in `note`; widening this list later is an ordinary `ALTER`.
 */
export const STOCK_REASONS = ['manual_increase', 'manual_decrease', 'correction'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

/**
 * Current stock for one SKU. A projection, not the truth.
 *
 * Never written except alongside a `stock_ledger` insert in the same transaction — see
 * `inventory.service.ts`. PostgreSQL cannot express "this UPDATE must be accompanied by that
 * INSERT" without a trigger, and a trigger would hide the arithmetic from the code that
 * reasons about it; the reconciliation test is the guard instead.
 */
export const stockItem = pgTable(
  'stock_item',
  {
    /**
     * **The SKU id IS the primary key.**
     *
     * That is what makes "at most one inventory row per SKU" structural rather than a separate
     * unique index somebody could later drop. There is no surrogate `id`, because nothing
     * needs to address a stock row by an identity of its own — it is always reached by SKU.
     */
    skuId: uuid('sku_id').primaryKey().notNull(),

    /**
     * Denormalised from `sku.store_id`, exactly as on `sku` itself: every repository predicate
     * in this codebase carries `store_id` in its own `WHERE`, and it is half of the composite
     * foreign key below.
     */
    storeId: storeIdColumn(() => store.id),

    /**
     * Units physically held. `integer`, per the approved decision — inventory is counted in
     * whole units, and fractional quantities (weighed goods, cable by the metre) are out of
     * scope. Widening to `numeric` later is a table rewrite, which is why it was a decision
     * rather than an assumption.
     */
    onHand: integer('on_hand').notNull().default(0),

    /**
     * Units promised to something but not yet shipped.
     *
     * **Always 0 in this increment** — no endpoint writes it, and reservation/allocation is a
     * later increment. It ships now so `available` has its final definition and its CHECK
     * constraints from day one: the increment that introduces reservations then changes no
     * formula and no constraint anywhere.
     */
    reserved: integer('reserved').notNull().default(0),

    /**
     * **The one authoritative definition of availability**, computed by PostgreSQL.
     *
     * A `STORED GENERATED` column rather than a view, a service helper, or a mapper
     * expression, because each of those is a second place the formula could be written
     * differently — and a stock figure two endpoints disagree about is worse than one that is
     * merely wrong.
     *
     * PostgreSQL REFUSES to write it: `column "available" can only be updated to DEFAULT`.
     * So no code path, no migration, and no operator can make it contradict its inputs. That
     * is the invariant made structurally impossible to violate rather than merely asserted.
     */
    available: integer('available')
      .notNull()
      .generatedAlwaysAs((): ReturnType<typeof sql> => sql`on_hand - reserved`),

    ...timestamps,
  },
  (t) => [
    /**
     * Tenancy AND parentage in one constraint: the stock row's SKU must exist, and its store
     * must be that SKU's store. A cross-store projection row is unrepresentable rather than
     * merely rejected by application code.
     *
     * The target index `uq_sku_id_store` already exists — Increment 25 created it as a
     * composite-FK target for `sku_option_value`, so this needs no new index on `sku`.
     *
     * `RESTRICT`, matching every other reference to `sku`: SKUs are soft-deleted, so a hard
     * delete that still has inventory attached is a bug and must fail loudly.
     */
    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_stock_item_sku_store',
    }).onDelete('restrict'),

    /**
     * Defensive BACKSTOPS, not the concurrency mechanism.
     *
     * The atomic `UPDATE` predicate in `inventory.repository.ts` is what produces a clean 409;
     * these catch a bug in that predicate and surface as SQLSTATE 23514. Measured during the
     * design review: a CHECK constraint alone prevents negative numbers but does NOT prevent
     * lost updates — two concurrent read-modify-write decrements both committed a legal value
     * and four units vanished with no constraint violated. Hence both, and hence the atomic
     * statement is mandatory rather than an optimisation.
     */
    check('ck_stock_on_hand_non_negative', sql`${t.onHand} >= 0`),
    check('ck_stock_reserved_non_negative', sql`${t.reserved} >= 0`),
    check('ck_stock_reserved_within_on_hand', sql`${t.reserved} <= ${t.onHand}`),
  ],
);

/**
 * Every stock movement, ever. **Append-only.**
 *
 * No `updated_at` and no `deleted_at`, and that is the point: there is no column with which to
 * edit or hide an entry, so the history cannot be rewritten. Nothing in the module exposes an
 * update or delete path, and a test asserts that.
 *
 * The ledger does NOT depend on SKU liveness to remain readable. Soft-deleting a SKU or its
 * product leaves every entry intact and every id still resolving, because those deletions are
 * soft — which is what lets a later reconciliation read a retired SKU's full movement history.
 */
export const stockLedger = pgTable(
  'stock_ledger',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * References the SKU, not `stock_item`.
     *
     * A ledger entry is a statement about a SKU's history, and it must stay readable even if a
     * projection row were never created or were removed by an operator. Pointing the immutable
     * record at the mutable derived one would couple their lifecycles.
     */
    skuId: uuid('sku_id').notNull(),

    /** Signed. Zero is refused: an entry recording that nothing happened is audit-trail noise. */
    delta: integer('delta').notNull(),

    /**
     * The arithmetic, both sides of it.
     *
     * Storing only `delta` would make "what was the stock on Tuesday?" a running sum over the
     * whole table; storing only the result would lose the arithmetic that produced it. Both,
     * plus the CHECK below, means an incoherent row cannot exist.
     */
    onHandBefore: integer('on_hand_before').notNull(),
    onHandAfter: integer('on_hand_after').notNull(),

    /** One of `STOCK_REASONS`, enforced by a CHECK — see that constant for what is absent. */
    reason: varchar('reason', { length: 40 }).notNull(),

    /**
     * Free text from the operator. Empty string rather than NULL, matching
     * `product.description`: there is no useful difference between "no note" and "an empty
     * note", and a nullable column would make every consumer handle both.
     */
    note: varchar('note', { length: 500 }).notNull().default(''),

    /**
     * Who did it — **NOT NULL, with a real foreign key.**
     *
     * Every entry in this increment is a manual staff adjustment, so an unattributed row is a
     * bug rather than a missing optional field. The FK to `app_user` is also what makes the
     * rollback test possible: naming a nonexistent actor fails the insert *after* the stock
     * update, proving the two share a transaction.
     *
     * When a later increment adds system-originated movements — an order allocation with no
     * human actor — that increment widens this deliberately, with its own decision.
     */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),

    /**
     * Correlation, mirroring `audit_log.request_id` — **including its type.**
     *
     * `varchar(64)`, not `uuid`, and that is not cosmetic. `resolveRequestId` ACCEPTS a
     * client-supplied `X-Request-Id` header when it is short enough and matches the safe
     * pattern, so a request id from an upstream proxy need not be a UUID at all. A `uuid`
     * column would reject those inserts and fail an otherwise valid adjustment — a bug the
     * integration suite could not see, because Testcontainers requests always generate their
     * own UUID ids. It was found by the live smoke test.
     *
     * Matching `audit_log` exactly also means the two can be joined without a cast, which is
     * the whole point of recording the same value in both places.
     *
     * Nullable because a future CLI or background adjustment has no HTTP request; every
     * adjustment through the API carries one, which is what lets an operator line a ledger
     * entry up against the request that caused it.
     */
    requestId: varchar('request_id', { length: 64 }),

    /** No `updated_at`: a ledger row is created once and never edited. */
    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /** The same tenancy key as the projection, so an entry cannot cross stores either. */
    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_stock_ledger_sku_store',
    }).onDelete('restrict'),

    /**
     * The history endpoint: "this SKU's movements, newest first", paged.
     *
     * The table's only read pattern, and it has no other index. Leads with `store_id` because
     * the predicate always carries it, and `created_at DESC` supplies the ordering so the page
     * needs no sort node. `id` breaks ties — it is UUIDv7, so it is itself time-ordered, which
     * makes the order total even for two entries written in the same millisecond.
     */
    index('ix_stock_ledger_sku_time').on(t.storeId, t.skuId, t.createdAt.desc(), t.id.desc()),

    /** A movement of zero is not a movement. */
    check('ck_stock_ledger_delta_non_zero', sql`${t.delta} <> 0`),

    /** Both sides of the arithmetic are real stock levels. */
    check(
      'ck_stock_ledger_quantities_non_negative',
      sql`${t.onHandBefore} >= 0 AND ${t.onHandAfter} >= 0`,
    ),

    /**
     * The row's own arithmetic must be self-consistent. Without this a ledger entry could
     * claim a before, a delta, and an after that do not add up — and the ledger would stop
     * being reconcilable against the projection, which is the whole reason it is the truth.
     */
    check('ck_stock_ledger_arithmetic', sql`${t.onHandBefore} + ${t.delta} = ${t.onHandAfter}`),

    /**
     * Enforced in the database, not only in Zod.
     *
     * A `varchar` + CHECK rather than a PostgreSQL `enum`, matching `product.status`: adding a
     * value to a PG enum cannot run inside a transaction on older servers and cannot be
     * reversed, whereas widening a CHECK is an ordinary `ALTER`. The set will grow when
     * accounting rules on classifications, so the cheaper-to-change form wins.
     */
    check(
      'ck_stock_ledger_reason',
      sql`${t.reason} in ('manual_increase', 'manual_decrease', 'correction')`,
    ),
  ],
);
