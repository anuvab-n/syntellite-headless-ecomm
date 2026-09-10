import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { sku } from './catalogue.js';
import { appUser } from './identity.js';
import { MAX_ORDER_LINE_QUANTITY, order } from './orders.js';
import { store } from './store.js';
import {
  codeColumn,
  currencyColumn,
  moneyColumn,
  primaryId,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';

/**
 * Returns — the customer-initiated reverse of a delivered order.
 *
 * ## What this increment stores, and what it deliberately does not
 *
 * Three tables: the request header, its lines, and an append-only transition log. **No refund
 * columns and no refund table** — a refund is its own aggregate (Increment 40f), linked to the
 * existing `payment` row rather than folded in here. The reason is `uq_payment_order`: there is
 * exactly one payment per order, so a refund cannot be a second payment, and modelling it as a
 * column on the return would make "how much was requested" and "how much actually moved"
 * the same field. They diverge the moment a provider refund fails.
 *
 * **No credit note.** An invoice in this system cannot be cancelled or amended and no credit
 * note exists (README, "An invoice cannot be cancelled or amended"). A return therefore reverses
 * money without producing the statutory instrument that would normally reverse the tax. That is
 * a recorded limitation of this increment, not an oversight — see the note on `refundTaxTotal`.
 *
 * ## Why the money is frozen here rather than derived on read
 *
 * Every monetary column below is apportioned from the ALREADY-FROZEN `order_line` snapshot at
 * the moment the return is created, and never recomputed. This is the same rule `order_line`
 * itself follows: a price change, a tax-rate change or a promotion edit after the fact must not
 * silently alter what a customer is owed. `order_line` is the only input; the current catalogue
 * is never consulted.
 */

/**
 * The return lifecycle. The approved set, exactly — no more.
 *
 * ```
 *   requested ──> approved ──> received ──> inspected ──> completed
 *       │             │            │
 *       └─> rejected  └─> cancelled└─> rejected
 * ```
 *
 * `completed`, `rejected` and `cancelled` are terminal. Note there is deliberately no
 * `inspected -> rejected`: inspection is the ACTIVITY performed while the goods sit in
 * `received`, and its two outcomes are the two edges out of that state — `inspected` when the
 * return is accepted, `rejected` when it is refused. Reaching `inspected` therefore already
 * means "accepted", which is what makes `inspected -> completed` unconditional.
 *
 * The transition table itself lives in the returns module, not here: a CHECK can constrain
 * which values a column holds, but it cannot see the row's previous value, so the two would
 * drift the first time anyone edited one and not the other.
 */
export const RETURN_STATUSES = [
  'requested',
  'approved',
  'received',
  'inspected',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Every return starts here. Named so no caller writes the literal. */
export const INITIAL_RETURN_STATUS = 'requested' satisfies ReturnStatus;

/**
 * The statuses from which nothing further happens.
 *
 * Used by `ck_return_closed_at` to tie the closing timestamp to the state, so a terminal row
 * without a closing instant — or an open row that claims one — cannot be written.
 */
export const TERMINAL_RETURN_STATUSES = ['completed', 'rejected', 'cancelled'] as const;

/**
 * Why the customer is returning the goods. A CLOSED list, per the approved decision.
 *
 * Closed rather than free text because this column is the input to any future policy that
 * treats fault-of-seller differently from change-of-mind — return shipping cost being the
 * obvious one — and a free-text column cannot be aggregated or branched on without a parser.
 * The customer's own words go in `customerNote`, which is free text and carries no logic.
 */
export const RETURN_REASONS = [
  'damaged_in_transit',
  'defective',
  'wrong_item_received',
  'not_as_described',
  'no_longer_needed',
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** How many characters the random half of a return number carries. */
export const RETURN_NUMBER_SUFFIX_LENGTH = 6;

/**
 * The alphabet a return number's suffix is drawn from.
 *
 * Digits `0`/`1` and letters `I`/`O` are absent: a return number is read aloud to support and
 * typed off an email, and those four are the pairs people confuse. Matches the order number's
 * alphabet for exactly the same reason.
 */
export const RETURN_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const returnRequest = pgTable(
  'return_request',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /** The order being returned against. Restricted, never cascaded: an order is a record. */
    orderId: uuid('order_id').notNull(),

    /**
     * The customer.
     *
     * Denormalised from the order rather than joined on every read, because the customer's own
     * list (`GET /users/me/returns`) filters on it and would otherwise need the order table for
     * a predicate that never changes.
     */
    userId: uuid('user_id').notNull(),

    /**
     * The public identifier. `RET-YYYYMMDD-XXXXXX`.
     *
     * A return number, not the internal id — same contract as `order_number`: the id is never
     * published, so it never becomes part of the API surface. Not a gapless series: unlike an
     * invoice number this carries no statutory meaning, so a redraw on collision is free.
     */
    returnNumber: codeColumn('return_number', 32).notNull(),

    status: varchar('status', { length: 20 }).notNull().default(INITIAL_RETURN_STATUS),

    reason: varchar('reason', { length: 40 }).notNull(),

    /** The customer's own words. Free text, and nothing branches on it. */
    customerNote: varchar('customer_note', { length: 500 }).notNull().default(''),

    /** Staff's words — an approval rationale, or why it was refused. Not customer-visible. */
    staffNote: varchar('staff_note', { length: 500 }).notNull().default(''),

    /**
     * The currency of every amount below.
     *
     * Copied from the order rather than inferred from the store, so a return reads correctly
     * even if the store's currency is later changed.
     */
    currency: currencyColumn().notNull(),

    /**
     * Σ `return_line.taxable_value` — the merchandise being credited, after its share of the
     * promotional discount and before tax.
     */
    refundTaxableValue: moneyColumn('refund_taxable_value').notNull(),

    /**
     * Σ `return_line.tax_total`.
     *
     * **This amount has no statutory instrument behind it in this increment.** GST is normally
     * reversed by a credit note, which this system does not implement and which Increment 40
     * explicitly excludes. The figure is computed, stored and refundable, but the tax reversal
     * is not documented anywhere a filing could cite. Recorded here rather than worked around.
     */
    refundTaxTotal: moneyColumn('refund_tax_total').notNull(),

    /** `refundTaxableValue + refundTaxTotal`. The payable credit, and what a refund charges. */
    refundTotal: moneyColumn('refund_total').notNull(),

    /**
     * The delivery instant this return's eligibility window was measured against.
     *
     * FROZEN at creation from `shipment.delivered_at`. Stored rather than re-read because the
     * window is a decision, and a decision has to be reconstructable: a shipment corrected
     * later must not retroactively make an accepted return look ineligible.
     */
    deliveredAt: tsColumn('delivered_at').notNull(),

    requestedAt: tsColumn('requested_at').notNull().defaultNow(),

    /** Set exactly when the return reaches a terminal status. See `ck_return_closed_at`. */
    closedAt: tsColumn('closed_at'),

    ...timestamps,
  },
  (t) => [
    /** The public identifier is unique per store, never globally. */
    uniqueIndex('uq_return_number').on(t.storeId, t.returnNumber),

    /**
     * The composite target every child FK points at.
     *
     * Redundant against the primary key on its own, and that is the point: it lets
     * `return_line` and `return_event` carry `store_id` and have the DATABASE enforce that a
     * child never references a parent in another tenant. Same device as `uq_order_id_store`.
     */
    uniqueIndex('uq_return_id_store').on(t.id, t.storeId),

    /** The customer's own list, newest first. */
    index('ix_return_user_requested').on(t.storeId, t.userId, t.requestedAt),

    /** The staff queue: everything awaiting action, by state. */
    index('ix_return_store_status').on(t.storeId, t.status),

    /** "What has been returned against this order" — the cumulative-quantity guard's read. */
    index('ix_return_order').on(t.orderId),

    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_return_order_store',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_return_user_store',
    }).onDelete('restrict'),

    check(
      'ck_return_status',
      sql`${t.status} in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')`,
    ),

    check(
      'ck_return_reason',
      sql`${t.reason} in ('damaged_in_transit', 'defective', 'wrong_item_received', 'not_as_described', 'no_longer_needed')`,
    ),

    /**
     * The header must foot to its own parts.
     *
     * Reconciling the header against `Σ return_line` cannot be a CHECK — it spans rows — so the
     * service does that. This one catches the cheaper error: a header whose two components do
     * not add up to its own total.
     */
    check('ck_return_total', sql`${t.refundTotal} = ${t.refundTaxableValue} + ${t.refundTaxTotal}`),

    check(
      'ck_return_amounts_non_negative',
      sql`${t.refundTaxableValue} >= 0 and ${t.refundTaxTotal} >= 0 and ${t.refundTotal} >= 0`,
    ),

    /**
     * Closed exactly when terminal.
     *
     * Written as an equality between two booleans, the same shape as `ck_shipment_shipped_at`,
     * so both directions are covered by one constraint: a terminal row without a closing
     * instant, and an open row that claims one, are equally rejected.
     */
    check(
      'ck_return_closed_at',
      sql`(${t.status} in ('completed', 'rejected', 'cancelled')) = (${t.closedAt} is not null)`,
    ),
  ],
);

export const returnLine = pgTable(
  'return_line',
  {
    returnId: uuid('return_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    storeId: uuid('store_id').notNull(),

    /** How many units of this SKU this request covers. */
    quantity: integer('quantity').notNull(),

    /**
     * The apportioned share of the order line's gross, before discount.
     *
     * Every money column here is a PROPORTIONAL share of the corresponding frozen
     * `order_line` column, for `quantity` of that line's units. Nothing is recalculated from a
     * rate or a current price — the order line is the sole input, so a rate change after the
     * sale cannot alter what is owed.
     */
    lineTotal: moneyColumn('line_total').notNull(),

    /** The returned units' share of the promotional discount. Refunded with them. */
    discountAmount: moneyColumn('discount_amount').notNull().default('0'),

    /** `lineTotal - discountAmount`. The GST taxable value for the returned units. */
    taxableValue: moneyColumn('taxable_value').notNull(),

    cgstAmount: moneyColumn('cgst_amount').notNull().default('0'),
    sgstAmount: moneyColumn('sgst_amount').notNull().default('0'),
    igstAmount: moneyColumn('igst_amount').notNull().default('0'),
    cessAmount: moneyColumn('cess_amount').notNull().default('0'),

    /** `cgst + sgst + igst + cess`, for the returned units. */
    taxTotal: moneyColumn('tax_total').notNull(),

    /** `taxableValue + taxTotal`. This line's contribution to `return_request.refundTotal`. */
    refundTotal: moneyColumn('refund_total').notNull(),

    /**
     * What inspection decided, as COUNTS rather than a label.
     *
     * Both stay `0` until the goods are inspected, and together they must then equal
     * `quantity`. Counts rather than an enum because a single line can legitimately split —
     * three jars returned, one smashed — and an enum would force staff to either lie about the
     * good two or raise a second return for the broken one. Neither column decides whether the
     * customer is refunded: a written-off unit is still a unit the customer sent back.
     *
     * The ledger movement they drive arrives in Increment 40e; nothing reads them yet.
     */
    restockQuantity: integer('restock_quantity').notNull().default(0),
    writeOffQuantity: integer('write_off_quantity').notNull().default(0),
  },
  (t) => [
    /**
     * One row per SKU per return, exactly as `order_line` is keyed.
     *
     * A second row for the same SKU in one request would make "how many units of this SKU are
     * coming back" a SUM rather than a lookup, and every cumulative-quantity check would have
     * to remember that. Multiple returns for the same SKU are still possible — they are
     * separate requests, which is decision 9.
     */
    primaryKey({ columns: [t.returnId, t.skuId], name: 'pk_return_line' }),

    /** Cascaded: a line has no meaning without its request, unlike the request itself. */
    foreignKey({
      columns: [t.returnId, t.storeId],
      foreignColumns: [returnRequest.id, returnRequest.storeId],
      name: 'fk_return_line_return_store',
    }).onDelete('cascade'),

    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_return_line_sku_store',
    }).onDelete('restrict'),

    /*
     * `sql.raw` for the ceiling, NOT interpolation.
     *
     * A plain `${MAX_ORDER_LINE_QUANTITY}` becomes a bound parameter (`$1`), and PostgreSQL
     * rejects a parameter inside a CHECK with `42P02` — at migration time, so every test in
     * the run dies in `beforeAll` rather than anywhere near the mistake. `order_line` inlines
     * the same constant the same way.
     */
    check(
      'ck_return_line_quantity',
      sql`${t.quantity} >= 1 and ${t.quantity} <= ${sql.raw(String(MAX_ORDER_LINE_QUANTITY))}`,
    ),

    check('ck_return_line_taxable', sql`${t.taxableValue} = ${t.lineTotal} - ${t.discountAmount}`),

    check(
      'ck_return_line_tax_total',
      sql`${t.taxTotal} = ${t.cgstAmount} + ${t.sgstAmount} + ${t.igstAmount} + ${t.cessAmount}`,
    ),

    check('ck_return_line_refund_total', sql`${t.refundTotal} = ${t.taxableValue} + ${t.taxTotal}`),

    check(
      'ck_return_line_amounts_non_negative',
      sql`${t.lineTotal} >= 0 and ${t.discountAmount} >= 0 and ${t.taxableValue} >= 0
          and ${t.cgstAmount} >= 0 and ${t.sgstAmount} >= 0 and ${t.igstAmount} >= 0
          and ${t.cessAmount} >= 0 and ${t.taxTotal} >= 0 and ${t.refundTotal} >= 0`,
    ),

    check('ck_return_line_discount_within_line', sql`${t.discountAmount} <= ${t.lineTotal}`),

    /**
     * Inspection cannot account for more units than came back.
     *
     * `<=` rather than `=`, because both are `0` for the whole of the request's life before
     * inspection. The exact equality at the moment of inspection is the service's to enforce —
     * a CHECK cannot say "only once the status is `inspected`" without duplicating the
     * transition table it cannot see.
     */
    check(
      'ck_return_line_inspection_quantity',
      sql`${t.restockQuantity} >= 0 and ${t.writeOffQuantity} >= 0
          and ${t.restockQuantity} + ${t.writeOffQuantity} <= ${t.quantity}`,
    ),
  ],
);

/**
 * Every transition a return has made. Append-only.
 *
 * The same device as `payment_event` and `order_status_history`: the header carries the CURRENT
 * state and this carries how it got there. Rows are never updated and never deleted, so "who
 * approved this, and when" survives a later rejection.
 */
export const returnEvent = pgTable(
  'return_event',
  {
    id: primaryId(),
    returnId: uuid('return_id').notNull(),
    storeId: uuid('store_id').notNull(),

    /** `null` only for the row that records creation, which has no previous state. */
    fromStatus: varchar('from_status', { length: 20 }),
    toStatus: varchar('to_status', { length: 20 }).notNull(),

    /** `customer` or `staff` — who caused it. Mirrors `payment_event.actor_type`. */
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorUserId: uuid('actor_user_id'),

    /** Free text explaining this specific transition. Not the request's own `reason`. */
    note: varchar('note', { length: 500 }).notNull().default(''),

    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.returnId, t.storeId],
      foreignColumns: [returnRequest.id, returnRequest.storeId],
      name: 'fk_return_event_return_store',
    }).onDelete('cascade'),

    /** The timeline for one return, in order. */
    index('ix_return_event_return').on(t.returnId, t.createdAt),

    check(
      'ck_return_event_to_status',
      sql`${t.toStatus} in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')`,
    ),

    check(
      'ck_return_event_from_status',
      sql`${t.fromStatus} is null or ${t.fromStatus} in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')`,
    ),

    check('ck_return_event_actor_type', sql`${t.actorType} in ('customer', 'staff')`),
  ],
);
