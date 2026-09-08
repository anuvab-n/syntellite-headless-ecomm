import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { appUser } from './identity.js';
import { order } from './orders.js';
import { store } from './store.js';

/**
 * Fulfilment: the record that goods left the building, and arrived.
 *
 * ## The fourth state space, kept separate
 *
 * §43 fixed that `cart.status`, `order.status`, the payment table and a future shipment table
 * stay four separate state spaces. This is that shipment table, and it holds to the rule:
 * **nothing here writes `order.status`**, and `order.status` still has exactly two values
 * answering exactly one question — has the customer withdrawn the order.
 *
 * Expanding `order.status` with `shipped` was considered and rejected. One column cannot express
 * a shipment's carrier, its tracking number and two timestamps; it would make the column answer
 * two unrelated questions; and it would require widening three CHECK constraints plus
 * re-examining every reader of `CANCELLABLE_ORDER_STATUSES`. Whether an order is fulfilled is a
 * question ABOUT its shipment, and it is answered by joining rather than by mirroring.
 *
 * ## Manual fulfilment. No provider.
 *
 * There is no carrier API, no provider adapter, no provider port and no webhook. `carrier` and
 * `tracking_number` are text a staff member types, which is why both are nullable — a shipment
 * is created when picking begins and the tracking number often arrives later.
 *
 * The seam for a future provider is deliberately NOT built. `PaymentGateway` shows what it would
 * look like when a provider is chosen; building it now would be an abstraction with one caller
 * and no second case.
 *
 * ## One shipment per order, and no partial fulfilment
 *
 * `uq_shipment_order` makes it structural. That single decision removes a great deal: no
 * `shipment_item` table, no per-line quantities, no sum-of-shipped invariant that a row CHECK
 * cannot express — and it gives duplicate-request protection for free, exactly as
 * `uq_payment_order` does for payments, so no `Idempotency-Key` was added to creation.
 *
 * The consequence is stated rather than hidden: **a shipment fulfils the whole order or nothing.**
 * Splitting a delivery is not representable, and making it so is a later increment that would
 * need `shipment_item` and a reservation model that can hold a partial quantity — which
 * `stock_reservation`'s `(order_id, sku_id)` primary key currently cannot.
 */

/**
 * The fulfilment lifecycle. Three states, two transitions.
 *
 *     pending -> shipped -> delivered
 *
 * `pending` means the shipment record exists and goods have NOT left. It is not decoration: it
 * is the state in which a tracking number can be attached, and it separates "we intend to ship
 * this" from the irreversible act of moving stock. `shipped` is the physical departure, and the
 * only transition that touches inventory. `delivered` records arrival and moves no stock.
 *
 * There is deliberately no `packed` (no operational step acts on it), no `failed` and no
 * `returned` (returns are out of scope), and no `cancelled` — a shipment that should not have
 * existed is a correction, not a state, and cancelling an order before it ships already covers
 * the real case.
 *
 * Both `shipped` and `delivered` are terminal in the sense that nothing moves BACKWARD; the
 * transition table in `shipment.state.ts` is the authority.
 */
export const SHIPMENT_STATUSES = ['pending', 'shipped', 'delivered'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** The state a shipment is created in. Named so no caller writes the literal. */
export const INITIAL_SHIPMENT_STATUS = 'pending' satisfies ShipmentStatus;

/**
 * Statuses that block cancelling the order.
 *
 * `pending` deliberately does NOT block: nothing has moved, so a customer may still cancel, and
 * the pending shipment is left behind as an operational fact that can never ship — the ship path
 * refuses a cancelled order. `shipped` and `delivered` block, because undoing them means a
 * return, which is out of scope.
 */
export const FULFILMENT_BLOCKING_STATUSES = ['shipped', 'delivered'] as const;

/**
 * One shipment. The authoritative record of physical fulfilment.
 *
 * No `deleted_at`, and none is coming: a shipment is historical operational data, and the same
 * retention posture that forbids deleting an order forbids deleting the record that it shipped.
 */
export const shipment = pgTable(
  'shipment',
  {
    id: primaryId(),

    /** Tenancy, and half of the composite foreign key below. */
    storeId: storeIdColumn(() => store.id),

    /** The order this fulfils, in its entirety. */
    orderId: uuid('order_id').notNull(),

    status: varchar('status', { length: 20 }).notNull().default(INITIAL_SHIPMENT_STATUS),

    /**
     * Who carried it. Free text, nullable.
     *
     * A `carrier` table would be speculative: with no provider integration there is no
     * canonical list to constrain against, and a lookup table with rows a merchant types is a
     * lookup table with typos plus a join. When a provider is chosen it brings its own carrier
     * vocabulary and this becomes a CHECK or a reference — an ordinary `ALTER` either way.
     *
     * Nullable because a shipment is created before the courier is chosen.
     */
    carrier: varchar('carrier', { length: 120 }),

    /**
     * The carrier's consignment number. Nullable, for the same reason.
     *
     * Uniqueness is store- AND carrier-scoped and partial — see `uq_shipment_tracking`.
     */
    trackingNumber: varchar('tracking_number', { length: 120 }),

    /**
     * A link the customer can open, if the carrier gives one.
     *
     * Stored rather than templated because with no provider integration there is no table of
     * URL patterns to template FROM — a staff member pastes what the courier gave them. When a
     * provider arrives it supplies this, and the column is already here.
     */
    trackingUrl: varchar('tracking_url', { length: 500 }),

    /** When goods left. NULL until the `shipped` transition; never re-stamped. */
    shippedAt: tsColumn('shipped_at'),

    /** When they arrived. NULL until the `delivered` transition; never re-stamped. */
    deliveredAt: tsColumn('delivered_at'),

    ...timestamps,
  },
  (t) => [
    /**
     * **One shipment per order, structurally.**
     *
     * Not store-scoped, and deliberately: `order_id` is a UUIDv7 primary key, globally unique
     * on its own, so adding `store_id` would weaken the constraint rather than scope it — two
     * stores cannot share an order id, and a composite unique would permit two shipments for
     * one order if a caller ever supplied the wrong store. Tenancy is enforced by the composite
     * FK below and by every repository predicate.
     *
     * This is also the duplicate-request guard. Two staff clicking Create produce one shipment
     * and one 409, which is why creation carries no `Idempotency-Key` — the same trade
     * `uq_payment_order` makes for payments.
     */
    uniqueIndex('uq_shipment_order').on(t.orderId),

    /**
     * Composite-FK target for `shipment_event`. Mirrors `uq_payment_id_store`.
     *
     * MUST be created before the foreign keys that reference it. Drizzle has emitted an FK
     * ahead of its target index six times in this project; see the migration header.
     */
    uniqueIndex('uq_shipment_id_store').on(t.id, t.storeId),

    /**
     * Tenancy AND parentage in one constraint: the order must exist and belong to this store.
     * A cross-store shipment is unrepresentable rather than merely rejected in code.
     *
     * Target index `uq_order_id_store` already exists — `order_line` uses this exact key.
     * `RESTRICT` because an order is never hard-deleted, so a delete with a shipment attached
     * is a bug that must fail loudly rather than discard the record that goods went out.
     */
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_shipment_order_store',
    }).onDelete('restrict'),

    check('ck_shipment_status', sql`${t.status} in ('pending', 'shipped', 'delivered')`),

    /**
     * The timestamps and the status cannot disagree, and each direction is its own constraint
     * so a violation names which half broke.
     *
     * `shipped_at` is present for `shipped` and `delivered` — a delivered shipment necessarily
     * shipped — and absent for `pending`.
     */
    check(
      'ck_shipment_shipped_at',
      sql`(${t.status} in ('shipped', 'delivered')) = (${t.shippedAt} is not null)`,
    ),

    check(
      'ck_shipment_delivered_at',
      sql`(${t.status} = 'delivered') = (${t.deliveredAt} is not null)`,
    ),

    /** Goods cannot arrive before they leave. */
    check(
      'ck_shipment_delivered_after_shipped',
      sql`${t.deliveredAt} is null OR (${t.shippedAt} is not null AND ${t.deliveredAt} >= ${t.shippedAt})`,
    ),

    /**
     * A tracking URL without a number is a link to nothing.
     *
     * The reverse is fine: a number with no URL is the normal case for a courier that has no
     * public tracking page.
     */
    check(
      'ck_shipment_tracking_url_needs_number',
      sql`${t.trackingUrl} is null OR ${t.trackingNumber} is not null`,
    ),

    /**
     * One consignment number per carrier per store, when there is one.
     *
     * Store- and carrier-scoped rather than global, because two couriers legitimately reuse
     * number formats and two tenants must never collide. Partial, so the many shipments with no
     * number yet do not conflict with each other — the same shape as `uq_payment_provider_ref`.
     *
     * `carrier` is in the key, so it must be set for the constraint to bite; a number typed
     * without a carrier is only unique against other carrier-less rows, which is the honest
     * limit of what can be enforced when both fields are optional.
     */
    uniqueIndex('uq_shipment_tracking')
      .on(t.storeId, t.carrier, t.trackingNumber)
      .where(sql`${t.trackingNumber} is not null`),

    /**
     * The staff fulfilment queue's read: this store's shipments by state.
     *
     * Mirrors `ix_payment_store_status`. Deliberately NOT a broader index for reporting — the
     * queue is the only query, and speculative indexes for dashboards nobody has asked for are
     * exactly what this project refuses.
     */
    index('ix_shipment_store_status').on(t.storeId, t.status),
  ],
);

/**
 * Every shipment transition, ever. **Append-only.**
 *
 * The same shape as `payment_event` and `order_status_history`: no `updated_at` and no
 * `deleted_at`, so there is no column with which to rewrite the past. Every state machine in
 * this codebase has one of these, and a shipment without one would be the first exception.
 */
export const shipmentEvent = pgTable(
  'shipment_event',
  {
    id: primaryId(),

    shipmentId: uuid('shipment_id').notNull(),

    storeId: storeIdColumn(() => store.id),

    /** NULL only for the creation row, which records `NULL -> pending`. */
    fromStatus: varchar('from_status', { length: 20 }),

    toStatus: varchar('to_status', { length: 20 }).notNull(),

    /**
     * `staff` for every row this increment can write.
     *
     * Fulfilment is manual and always performed by an authenticated staff member, so there is
     * no `system` actor here — decision 19. A future provider webhook would be the first, and
     * would need its own decision about this column exactly as `stock_ledger.actor_user_id`
     * does.
     */
    actorType: varchar('actor_type', { length: 32 }).notNull(),

    /**
     * Nullable in the column, always present in practice.
     *
     * Nullable so a future system actor does not require a migration on an append-only table;
     * `ck_shipment_event_actor` is what makes today's rows attributable.
     */
    actorUserId: uuid('actor_user_id').references(() => appUser.id, { onDelete: 'restrict' }),

    /**
     * Free text from the operator. Mirrors `order_status_history.note`, including its
     * nullability — that column is present and unused, and this one gives it a first purpose:
     * "left with neighbour", "second delivery attempt".
     */
    note: varchar('note', { length: 500 }),

    /** No `updated_at`: an event row is created once and never edited. */
    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /**
     * Tenancy AND parentage. Target index `uq_shipment_id_store` is created above and MUST
     * precede this foreign key in the migration.
     */
    foreignKey({
      columns: [t.shipmentId, t.storeId],
      foreignColumns: [shipment.id, shipment.storeId],
      name: 'fk_shipment_event_shipment_store',
    }).onDelete('restrict'),

    /** The timeline read: one shipment's transitions, newest first. */
    index('ix_shipment_event_shipment_time').on(
      t.storeId,
      t.shipmentId,
      t.createdAt.desc(),
      t.id.desc(),
    ),

    check('ck_shipment_event_to_status', sql`${t.toStatus} in ('pending', 'shipped', 'delivered')`),

    check(
      'ck_shipment_event_from_status',
      sql`${t.fromStatus} is null OR ${t.fromStatus} in ('pending', 'shipped', 'delivered')`,
    ),

    /** A transition that goes nowhere is not a transition. Mirrors the order history CHECK. */
    check(
      'ck_shipment_event_progresses',
      sql`${t.fromStatus} is null OR ${t.fromStatus} <> ${t.toStatus}`,
    ),

    /**
     * Attributable, in the database.
     *
     * Every row this increment writes is a staff action, so a `staff` row without a user is a
     * bug rather than a missing optional field. Written as a biconditional on `staff` so the
     * first system actor is an ordinary CHECK widening rather than a silent hole.
     */
    check(
      'ck_shipment_event_actor',
      sql`(${t.actorType} = 'staff') = (${t.actorUserId} is not null)`,
    ),
  ],
);
