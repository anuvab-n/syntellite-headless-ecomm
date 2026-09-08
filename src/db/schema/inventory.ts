import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { sku } from './catalogue.js';
import { appUser } from './identity.js';
import { MAX_ORDER_LINE_QUANTITY, order } from './orders.js';
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
export const STOCK_REASONS = [
  'manual_increase',
  'manual_decrease',
  'correction',
  /**
   * Goods physically left the building. Written by fulfilment (Increment 37), one row per
   * shipped SKU, always with a negative delta.
   *
   * The FIRST non-manual reason, and still a MECHANISM rather than an accounting treatment —
   * which is why it belongs here while `damage`, `shrinkage` and `write_off` still do not. It
   * is also the first reason a customer's order can cause, though the actor is always the staff
   * member who shipped it: `actor_user_id` stays NOT NULL and no system actor was introduced.
   */
  'shipment',
] as const;
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
      sql`${t.reason} in ('manual_increase', 'manual_decrease', 'correction', 'shipment')`,
    ),
  ],
);

/**
 * Reservation lifecycle values.
 *
 * `held` is the only non-terminal state. Both settled states are terminal in this increment:
 * `released` gave the units back, `committed` sold them. There is no `fulfilled` — the
 * increment that ships goods adds it, along with the only `on_hand` movement in this design.
 *
 * A `varchar` + CHECK rather than a PostgreSQL enum, matching `product.status` and
 * `stock_ledger.reason`: widening a CHECK is an ordinary `ALTER`, whereas adding an enum value
 * is not reversible and cannot run in a transaction on older servers.
 */
export const RESERVATION_STATUSES = ['held', 'released', 'committed', 'fulfilled'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** The one non-terminal status. Named so every CAS predicate has a single source. */
export const RESERVATION_HELD = 'held' satisfies ReservationStatus;

/**
 * Why a reservation stopped being held — a TECHNICAL vocabulary, like `STOCK_REASONS`.
 *
 * Each value names the CODE PATH that settled it, one-to-one, and nothing else. There is no
 * `damage`, `shrinkage` or `write_off` here for the reason `STOCK_REASONS` omits them too:
 * those are accounting classifications, and a CHECK constraint is the wrong place to decide
 * how a loss is posted.
 *
 * `payment_expired` is defined but **unreachable**: nothing writes `payment.status = 'expired'`,
 * because no expiry window has been approved and so no sweeper exists. It is here so that the
 * increment given a window adds a caller rather than a vocabulary — the same reason `expired`
 * already sits in `PAYMENT_STATUSES`.
 */
export const RESERVATION_SETTLED_REASONS = [
  'order_cancelled',
  'payment_succeeded',
  'payment_failed',
  'payment_expired',
  /**
   * The units shipped. Recorded on the `committed -> fulfilled` move (Increment 37).
   *
   * Note this reason names a settlement that is NOT the one `settled_reason` records — see
   * `fulfilledAt` below. It is here because the column's CHECK requires a value for every
   * non-held status, and because a reservation that reached `fulfilled` through some other
   * path would be a bug worth naming.
   */
  'shipment_fulfilled',
  /**
   * A COD order was fulfilled while its payment was still `pending`.
   *
   * **The explicit mechanism the approved COD rule requires.** COD payments never terminalise,
   * so a COD reservation would sit `held` forever and `held -> fulfilled` is deliberately
   * illegal. Rather than inventing a payment transition — forbidden — fulfilment performs
   * `held -> committed` with THIS reason and then `committed -> fulfilled`, both inside the
   * shipping transaction.
   *
   * It is distinct from `payment_succeeded` on purpose: the money has NOT been received, and a
   * reason that claimed otherwise would misreport an unpaid sale. Nothing about the payment
   * row changes.
   */
  'cod_fulfilment',
] as const;
export type ReservationSettledReason = (typeof RESERVATION_SETTLED_REASONS)[number];

/**
 * Which order holds which units of which SKU. The owner record behind `stock_item.reserved`.
 *
 * ## Why this table exists at all
 *
 * `stock_item.reserved` is a counter, and a counter cannot answer the two questions this
 * feature turns on: *whose* units are these, and *has this reservation already been settled?*
 * Without an owner row, "release exactly once" is unenforceable — a second cancellation would
 * decrement the counter again with nothing to refuse it. So the counter stays as the fast
 * projection and each row here is the record justifying part of it, exactly as `stock_ledger`
 * justifies `on_hand`.
 *
 * The relationship is a reconcilable invariant, asserted by a test:
 *
 *     SUM(quantity) WHERE status IN ('held', 'committed')  =  stock_item.reserved
 *
 * ## `committed` still counts toward `reserved`
 *
 * A committed reservation is a SALE AWAITING FULFILMENT. The units are still physically in the
 * building, so `on_hand` must keep counting them; they are no longer sellable, so `reserved`
 * must keep counting them too. `available = on_hand - reserved` therefore stays correct
 * without a single change to its formula or its CHECK constraints.
 *
 * The consequence is deliberate and worth stating plainly: **nothing in this increment ever
 * decreases `on_hand`.** As paid orders accumulate, `available` trends to zero while `on_hand`
 * stays flat. That is not a leak — it is what "sold but not yet shipped" looks like. The
 * fulfilment increment decrements both together and writes the `stock_ledger` row for it.
 *
 * ## Why `stock_ledger` is untouched
 *
 * That table is defined entirely around `on_hand`: `delta`, `on_hand_before`, `on_hand_after`,
 * `CHECK (on_hand_before + delta = on_hand_after)` and `CHECK (delta <> 0)`. A reservation
 * moves `reserved`, not `on_hand`, so it cannot be expressed there without either lying with
 * `delta = 0` — which the CHECK refuses — or adding `reserved_before`/`reserved_after` plus a
 * movement-kind discriminator, which changes what the ledger MEANS. And `SUM(delta) = on_hand`
 * is an asserted invariant that would stop holding.
 *
 * Because commit does not move `on_hand`, none of that is needed: this table's own
 * `held_at`/`settled_at`/`settled_reason` are the history, and `stock_ledger.actor_user_id`
 * keeps its `NOT NULL` — a sweeper-driven release has no user, which is exactly the widening
 * that column's comment anticipates and this increment does not need.
 *
 * ## Concurrency lives in the repository, not here
 *
 * The reserve statement is one conditional `UPDATE` on `stock_item` carrying `available >= :qty`;
 * the CHECK constraints below are BACKSTOPS that turn a bug in that predicate into SQLSTATE
 * 23514 rather than oversold stock. See `inventory.repository.ts` for the full argument,
 * including why `SELECT ... FOR UPDATE` is deliberately not used.
 */
export const stockReservation = pgTable(
  'stock_reservation',
  {
    /**
     * The owner. Leading column of the primary key, so "settle this order's reservations" —
     * the only hot read — is an index scan on the PK.
     */
    orderId: uuid('order_id').notNull(),

    /**
     * The reserved thing. Points at the SKU, **not** at `stock_item`, for the reason
     * `stock_ledger` does: an immutable record must not depend on a mutable projection's
     * lifecycle. It is also the row these units were taken from, which is why it is what the
     * deterministic lock ordering sorts by.
     */
    skuId: uuid('sku_id').notNull(),

    /** Tenancy, and half of both composite foreign keys below. */
    storeId: storeIdColumn(() => store.id),

    /**
     * Units held. `integer`, matching `stock_item.on_hand` and `order_line.quantity` — whole
     * units only. This is the amount given back on release and the amount reconciled against
     * `stock_item.reserved`.
     */
    quantity: integer('quantity').notNull(),

    /**
     * The CAS target that makes release and commit exactly-once.
     *
     * Every settlement is `UPDATE ... WHERE status = 'held' RETURNING`, so a second attempt
     * matches nothing and performs no counter change. Not a boolean: `released` and `committed`
     * differ in whether `stock_item.reserved` moves, so two settled states are load-bearing
     * rather than merely descriptive.
     */
    status: varchar('status', { length: 20 }).notNull().default(RESERVATION_HELD),

    /**
     * One of `RESERVATION_SETTLED_REASONS`, and NULL exactly while held.
     *
     * Without it, `released` cannot distinguish a cancellation from a payment failure from an
     * expiry — three different code paths with one outcome. The audit log records the
     * triggering action, but reading it is a join across time; this is the answer on the row.
     */
    settledReason: varchar('settled_reason', { length: 32 }),

    /**
     * When the units physically shipped. NULL until then. Increment 37.
     *
     * **A separate column rather than re-stamping `settled_at`**, because `committed -> fulfilled`
     * is a second settled-to-settled move and overwriting would destroy the fact that matters
     * most: WHEN THE SALE WAS COMMITTED. An auditor needs both instants — the moment the units
     * stopped being sellable, and the moment they left the building — and a single timestamp
     * can only hold one.
     *
     * `settled_at`/`settled_reason` therefore keep their existing meaning: when and why the
     * reservation left `held`. This records the later, physical event.
     */
    fulfilledAt: tsColumn('fulfilled_at'),

    /** When the units were taken. */
    heldAt: tsColumn('held_at').notNull().defaultNow(),

    /**
     * When they stopped being held, and NULL exactly while held — the CHECKs below enforce
     * that pairing in both directions.
     *
     * There is deliberately no `updated_at`: this row is written once and settled at most once,
     * so `updated_at` would be a second, redundant answer to the question `settled_at` already
     * answers. A settlement also never re-stamps it, because the CAS refuses a second
     * settlement — the same history-preserving property soft delete relies on.
     */
    settledAt: tsColumn('settled_at'),
  },
  (t) => [
    /**
     * **One reservation per order per SKU, structurally.**
     *
     * No surrogate `id`, following `order_line` and `stock_item`, which both key on their
     * natural composite. It is also a free idempotency backstop: a code path that somehow
     * reserved twice for one order hits a primary-key violation rather than silently
     * double-counting units.
     */
    primaryKey({ columns: [t.orderId, t.skuId], name: 'pk_stock_reservation' }),

    /**
     * Tenancy AND parentage in one constraint: the order must exist and its store must be this
     * store. A cross-store reservation is unrepresentable, not merely rejected in code.
     *
     * The target index `uq_order_id_store` already exists — `order_line` uses this exact key —
     * so this adds no index to `order`.
     *
     * `RESTRICT`, not `CASCADE`: an order is never hard-deleted, so a delete that still has
     * reservations attached is a bug and must fail loudly rather than quietly discarding the
     * record of stock that was taken.
     */
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_stock_reservation_order_store',
    }).onDelete('restrict'),

    /**
     * The same shape against the SKU. Target index `uq_sku_id_store` already exists —
     * `stock_item` uses it. `RESTRICT` matches every other reference to `sku`: SKUs are
     * soft-deleted, so a hard delete with live reservations must fail.
     */
    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_stock_reservation_sku_store',
    }).onDelete('restrict'),

    /**
     * Mirrors `ck_order_line_quantity` exactly, ceiling included, so a reservation can never
     * describe a quantity the order line it came from could not hold.
     */
    check(
      'ck_stock_reservation_quantity',
      sql`${t.quantity} >= 1 AND ${t.quantity} <= ${sql.raw(String(MAX_ORDER_LINE_QUANTITY))}`,
    ),

    check(
      'ck_stock_reservation_status',
      sql`${t.status} in ('held', 'released', 'committed', 'fulfilled')`,
    ),

    /**
     * Held and settled are mutually exclusive, enforced BOTH ways: a held row cannot carry a
     * settlement timestamp, and a settled row cannot lack one.
     *
     * Two separate constraints rather than one conjunction, so a violation names precisely
     * which half broke. A test asserting a database refusal is required to assert the
     * constraint NAME, and a combined constraint would make two different bugs
     * indistinguishable.
     */
    check(
      'ck_stock_reservation_settled_at',
      sql`(${t.status} = 'held') = (${t.settledAt} is null)`,
    ),

    check(
      'ck_stock_reservation_settled_reason',
      sql`(${t.status} = 'held') = (${t.settledReason} is null)`,
    ),

    check(
      'ck_stock_reservation_reason_values',
      sql`${t.settledReason} is null OR ${t.settledReason} in ('order_cancelled', 'payment_succeeded', 'payment_failed', 'payment_expired', 'shipment_fulfilled', 'cod_fulfilment')`,
    ),

    /**
     * `fulfilled_at` is present exactly when the status is `fulfilled`, both directions.
     *
     * Same shape as the settled pairing above, and for the same reason: a `fulfilled` row with
     * no timestamp, or a `committed` row carrying one, are two different bugs and each should
     * name itself.
     */
    check(
      'ck_stock_reservation_fulfilled_at',
      sql`(${t.status} = 'fulfilled') = (${t.fulfilledAt} is not null)`,
    ),

    /** Goods cannot ship before the sale they belong to was settled. */
    check(
      'ck_stock_reservation_fulfilled_after_settled',
      sql`${t.fulfilledAt} is null OR (${t.settledAt} is not null AND ${t.fulfilledAt} >= ${t.settledAt})`,
    ),

    /** Time only moves forward. A settlement before its hold is an incoherent row. */
    check(
      'ck_stock_reservation_settled_after_held',
      sql`${t.settledAt} is null OR ${t.settledAt} >= ${t.heldAt}`,
    ),

    /**
     * The reconciliation read: outstanding units per SKU, for
     * `SUM(quantity) = stock_item.reserved`.
     *
     * Partial, because released rows are history and never participate in that sum — so they
     * do not belong in the index that answers it. This is the invariant the whole table exists
     * to keep, and the analogue of `SUM(delta) = on_hand` on the ledger; without the index it
     * is a full scan. Leads with `store_id` because every predicate in this codebase carries it.
     */
    index('ix_stock_reservation_sku_outstanding')
      .on(t.storeId, t.skuId)
      .where(sql`${t.status} in ('held', 'committed')`),
  ],
);
