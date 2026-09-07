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

import {
  codeColumn,
  currencyColumn,
  moneyColumn,
  primaryId,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';
import { address } from './address.js';
import { cart } from './cart.js';
import { sku } from './catalogue.js';
import { appUser } from './identity.js';
import { promotion } from './promotions.js';
import { store } from './store.js';

/**
 * Orders — the immutable record of what a customer bought.
 *
 * Three tables, and the split is not stylistic. `order` is the header, `order_line` is what was
 * bought at the prices that applied, and `order_status_history` is append-only because §3 #8
 * settled that *"every transition is a row. No `UPDATE` rewrites the past."*
 *
 * ## Nothing here is ever deleted
 *
 * No `deleted_at` on any of the three. §3 #15 — _"anonymise, never delete. Tax law requires
 * invoice retention"_ — and `_shared.ts` names order status history among the tables that are
 * _"never deleted at all"_. `softDelete` is deliberately not imported.
 *
 * ## Everything a later read needs is COPIED, not joined
 *
 * §3 #9: _"snapshot product and address data onto order lines"_, because _"renaming a product
 * must not alter a past invoice"_. So the line carries the SKU code, the SKU name, the product
 * name and the unit price as they were at checkout, and the header carries the whole delivery
 * address. The foreign keys are kept for referential integrity and for answering "which SKU was
 * this?", never as the source of a historical read.
 *
 * ## What is deliberately absent
 *
 * No payment columns — no gateway, no authorisation, no capture, no payment status. No shipping
 * columns — no carrier, no cost, no tracking. No tax columns — no rate, no HSN/SAC, no
 * CGST/SGST/IGST, no place of supply, no GSTIN. No invoice number or series. No return or
 * refund state. Each belongs to its own increment, and each would encode a business rule this
 * increment has not been given.
 *
 * No inventory interaction of any kind: §39 defers _"reservations and allocation (the increment
 * that will need `FOR UPDATE`, and the one that first writes `reserved`)"_, so placing an order
 * moves no stock and writes no ledger row.
 *
 * No `promotion_redemption` and no usage counters. Applying and now ordering with a coupon still
 * consumes nothing; §42 defers that with the concurrency design already recorded.
 */

/**
 * The order lifecycle in this build: exactly one state.
 *
 * `cancelled`, `pending_payment`, `paid`, `payment_failed`, `packed`, `shipped`, `delivered`,
 * `returned` and `refunded` are all absent on purpose. Each would be written by an increment
 * that does not exist, and a status value nothing can produce is worse than a missing one: it
 * looks like a supported state to every reader of the enum.
 *
 * The four state spaces stay separate — `cart.status`, `order.status`, a future payment table,
 * and a future shipment table. Folding payment or fulfilment into this column is the shortcut
 * that makes both impossible to model properly later.
 */
export const ORDER_STATUSES = ['placed'] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The one status an order is created in, and — in this increment — the only one it can hold. */
export const INITIAL_ORDER_STATUS: OrderStatus = 'placed';

/** Bounds `order_line.quantity`, mirroring the cart's own ceiling. */
export const MAX_ORDER_LINE_QUANTITY = 999;

export const order = pgTable(
  'order',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * The customer. NOT NULL: checkout is authenticated-only in this build.
     *
     * Guest checkout is not supported, so there is no nullable-owner case to model. §7 lists it
     * as open with a default of "allowed, as a store setting"; that decision was taken the other
     * way for this increment, and reversing it later is a deliberate migration rather than a
     * column that silently permits an ownerless order today.
     */
    userId: uuid('user_id').notNull(),

    /**
     * The cart this order was made from.
     *
     * Unique, which is §36's *"one order per cart"* stated as a constraint rather than a hope.
     * It is the last line of defence behind the cart-row lock and the status transition: two
     * concurrent checkouts of one cart cannot both produce an order even if both other defences
     * were removed.
     */
    cartId: uuid('cart_id').notNull(),

    /**
     * The human-facing order number: `ORD-YYYYMMDD-XXXXXX`.
     *
     * `codeColumn` because `_shared.ts` names "order number" among its uses and fixes it as
     * case-sensitive. Generated server-side from a CSPRNG — deliberately NOT a sequence: a
     * serial in a customer-visible identifier leaks the store's order count, which is the same
     * reason `_shared.ts` chose UUIDv7 over `BIGSERIAL` for primary keys.
     */
    orderNumber: codeColumn('order_number').notNull(),

    status: varchar('status', { length: 20 }).notNull().default(INITIAL_ORDER_STATUS),

    /**
     * The order's currency, copied from the store at checkout.
     *
     * `_shared.ts` already named this column: the currency _"lives once per aggregate
     * (`store.currency`, `order.currency`) so a single order cannot end up with mixed-currency
     * lines"_. Copied rather than joined, so a store that later changes currency does not
     * restate every historical total.
     */
    currency: currencyColumn().notNull(),

    /**
     * The money, and its meaning is LOCKED.
     *
     *   `subtotal`       = Σ `order_line.line_total`   (pre-discount merchandise)
     *   `discount_total` = Σ `order_line.discount_amount`
     *   `total`          = `subtotal` − `discount_total`
     *
     * `total` is the payable goods total after the cart-level merchandise discount and **before
     * any future tax**. When GST arrives it adds `tax_total` and `grand_total`; it must not
     * redefine `total`. Increment 29 had to redefine `cartTotal` once, which is exactly why this
     * meaning is pinned here in the schema rather than left to a later reading.
     */
    subtotal: moneyColumn('subtotal').notNull(),
    discountTotal: moneyColumn('discount_total').notNull(),
    total: moneyColumn('total').notNull(),

    /**
     * The promotion that actually discounted this order, snapshotted.
     *
     * All three are NULL together when no promotion applied — including when one was applied to
     * the cart but was no longer eligible at checkout, which proceeds without a discount rather
     * than failing. The code and name are copied so a historical order can name the offer even
     * after the merchant renames or deletes it.
     */
    promotionId: uuid('promotion_id'),
    promotionCode: codeColumn('promotion_code'),
    promotionName: varchar('promotion_name', { length: 300 }),

    /**
     * The address this was shipped to: a reference AND a full snapshot.
     *
     * §40 restated the rule *"so the checkout increment inherits it explicitly"* — _"the moment
     * a past invoice reads a live address, a customer fixing a typo rewrites history"_. The
     * snapshot below is authoritative for every historical read; the reference exists so an
     * operator cannot orphan an order's address and so "which address was this?" is answerable.
     *
     * Measured during the design review: after the address was soft-deleted mid-checkout the
     * order still read its snapshotted city, while a join to the live row showed it deleted. The
     * foreign key alone would not have preserved it.
     *
     * `label` is deliberately NOT copied: it is the customer's private filing nickname ("Mum's
     * place"), not part of a delivery record.
     */
    addressId: uuid('address_id'),
    shipRecipientName: varchar('ship_recipient_name', { length: 300 }).notNull(),
    shipPhone: varchar('ship_phone', { length: 20 }).notNull(),
    shipLine1: varchar('ship_line1', { length: 300 }).notNull(),
    shipLine2: varchar('ship_line2', { length: 300 }).notNull().default(''),
    shipLandmark: varchar('ship_landmark', { length: 300 }).notNull().default(''),
    shipCity: varchar('ship_city', { length: 120 }).notNull(),
    shipState: varchar('ship_state', { length: 120 }).notNull(),
    shipPostalCode: varchar('ship_postal_code', { length: 16 }).notNull(),
    shipCountryCode: varchar('ship_country_code', { length: 2 }).notNull(),

    /**
     * When the order was placed.
     *
     * Distinct from `created_at`, which is row bookkeeping. `placed_at` is a business fact: the
     * tax rate in force and the invoice date are both functions of it, so it must not be
     * something a backfill could move.
     */
    placedAt: tsColumn('placed_at').notNull().defaultNow(),

    ...timestamps,
  },
  (t) => [
    /** §36's natural key: one order per cart, enforced rather than assumed. */
    uniqueIndex('uq_order_cart').on(t.cartId),

    /**
     * The order number is unique per STORE, not globally. Two merchants may each have their own
     * `ORD-20260904-7QK4M2`, and one must not be able to block the other's.
     */
    uniqueIndex('uq_order_number').on(t.storeId, t.orderNumber),

    /**
     * FK-target index for `order_line` and `order_status_history`.
     *
     * Adds no guarantee of its own — `id` is the primary key — and exists solely because
     * PostgreSQL requires a unique constraint on exactly the referenced columns.
     */
    uniqueIndex('uq_order_id_store').on(t.id, t.storeId),

    /** The customer's own order list, newest first. */
    index('ix_order_user_placed').on(t.userId, t.placedAt),

    /**
     * Ownership AND tenancy in one constraint: the order's user must exist, and its store must
     * be that user's store. A cross-store order is unrepresentable rather than merely refused
     * by application code.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_order_user_store',
    }).onDelete('restrict'),

    /**
     * RESTRICT, not CASCADE. Deleting a cart must never take an order with it — that would
     * delete the invoice trail §3 #15 requires be retained. The cart is history too, and both
     * survive together.
     */
    foreignKey({
      columns: [t.cartId, t.storeId],
      foreignColumns: [cart.id, cart.storeId],
      name: 'fk_order_cart_store',
    }).onDelete('restrict'),

    /**
     * RESTRICT: an operator hard-deleting an address must not silently detach it from a past
     * order. Customers soft-delete addresses, which this does not obstruct, and the snapshot
     * means the order reads correctly either way.
     */
    foreignKey({
      columns: [t.addressId, t.storeId],
      foreignColumns: [address.id, address.storeId],
      name: 'fk_order_address_store',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.promotionId, t.storeId],
      foreignColumns: [promotion.id, promotion.storeId],
      name: 'fk_order_promotion_store',
    }).onDelete('restrict'),

    check('ck_order_status', sql`${t.status} in ('placed')`),

    /**
     * The money invariants, in the database because the API is not the only writer.
     *
     * `total = subtotal - discount_total` is stated as an identity rather than trusted to the
     * service: a row whose three money columns disagree would be an order that cannot be
     * invoiced, and it would be discovered by an accountant rather than by a test.
     */
    check(
      'ck_order_money_non_negative',
      sql`${t.subtotal} >= 0 AND ${t.discountTotal} >= 0 AND ${t.total} >= 0`,
    ),
    check('ck_order_discount_within_subtotal', sql`${t.discountTotal} <= ${t.subtotal}`),
    check('ck_order_total_identity', sql`${t.total} = ${t.subtotal} - ${t.discountTotal}`),

    /**
     * The promotion snapshot is all-or-nothing.
     *
     * A row naming a code with no id, or an id with no name, is half a snapshot — and the read
     * path would have to decide which half to believe.
     */
    check(
      'ck_order_promotion_snapshot',
      sql`(${t.promotionId} IS NULL AND ${t.promotionCode} IS NULL AND ${t.promotionName} IS NULL)
          OR (${t.promotionId} IS NOT NULL AND ${t.promotionCode} IS NOT NULL AND ${t.promotionName} IS NOT NULL)`,
    ),

    /** A discount with no promotion behind it has no explanation. */
    check(
      'ck_order_discount_needs_promotion',
      sql`${t.discountTotal} = 0 OR ${t.promotionId} IS NOT NULL`,
    ),
  ],
);

/**
 * One line of an order. **Immutable once written.**
 *
 * Every display value is copied. A historical read must never join to `sku` or `product` for a
 * name, a code or a price — that is §3 #9, and it is what makes an order safe to invoice years
 * after the catalogue has moved on.
 *
 * `line_total` is PRE-discount merchandise value, and `discount_amount` is this line's allocated
 * share of the cart-level discount. So a future tax basis is `line_total - discount_amount`,
 * derivable per line with no re-allocation against a cart that no longer exists — which is
 * exactly what §42 decided must be possible.
 */
export const orderLine = pgTable(
  'order_line',
  {
    orderId: uuid('order_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    storeId: uuid('store_id').notNull(),

    /** Snapshots. The SKU may later be renamed, recoded, repriced, deactivated or deleted. */
    skuCode: codeColumn('sku_code').notNull(),
    skuName: varchar('sku_name', { length: 300 }).notNull(),
    productName: varchar('product_name', { length: 300 }).notNull(),

    quantity: integer('quantity').notNull(),

    /** The SKU's price at checkout, and the derived line money. See the table comment. */
    unitPrice: moneyColumn('unit_price').notNull(),
    lineTotal: moneyColumn('line_total').notNull(),
    discountAmount: moneyColumn('discount_amount').notNull().default('0'),

    ...timestamps,
  },
  (t) => [
    /**
     * The pair IS the identity, mirroring `cart_line`. One line per SKU per order, so a
     * duplicate is structurally impossible rather than merely unlikely.
     */
    primaryKey({ columns: [t.orderId, t.skuId], name: 'pk_order_line' }),

    /**
     * CASCADE is correct here and only here in this schema: a line has no meaning without its
     * order. It never fires in practice because an order is never deleted — it exists so that
     * an operator purging a test order cannot leave orphan lines behind.
     */
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_order_line_order_store',
    }).onDelete('cascade'),

    /**
     * RESTRICT, and together with the key above this pins the same `store_id` column, so a line
     * in store A cannot reference a SKU from store B. It also stops a merchant hard-deleting a
     * SKU that a past order names — which is precisely the case §24's soft-delete comment was
     * written for.
     */
    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_order_line_sku_store',
    }).onDelete('restrict'),

    check(
      'ck_order_line_quantity',
      sql`${t.quantity} >= 1 AND ${t.quantity} <= ${sql.raw(String(MAX_ORDER_LINE_QUANTITY))}`,
    ),
    check(
      'ck_order_line_money_non_negative',
      sql`${t.unitPrice} >= 0 AND ${t.lineTotal} >= 0 AND ${t.discountAmount} >= 0`,
    ),
    /** The line arithmetic, so a stored total can never disagree with its own inputs. */
    check('ck_order_line_total', sql`${t.lineTotal} = ${t.unitPrice} * ${t.quantity}`),
    check('ck_order_line_discount_within_line', sql`${t.discountAmount} <= ${t.lineTotal}`),
  ],
);

/**
 * Every status an order has held. **Append-only.**
 *
 * §3 #8: _"append-only status history. Every transition is a row. No `UPDATE` rewrites the
 * past."_ So there is no `updated_at` — nothing ever updates a row here — and no `deleted_at`,
 * because `_shared.ts` names this table among those _"never deleted at all"_.
 *
 * `from_status` is NULL for the first row, which is how "the order was created in this state" is
 * distinguished from "it moved into this state". This increment writes exactly that one row.
 */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: primaryId(),
    orderId: uuid('order_id').notNull(),
    storeId: uuid('store_id').notNull(),

    /** NULL only for the creation row. */
    fromStatus: varchar('from_status', { length: 20 }),
    toStatus: varchar('to_status', { length: 20 }).notNull(),

    /**
     * Who caused the transition. Mirrors `audit_log`'s actor split rather than inventing a
     * second vocabulary — a transition made by a background job must be distinguishable from
     * one a customer caused.
     */
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorUserId: uuid('actor_user_id'),

    /** Free text for an operator. Never a customer-facing message and never PII. */
    note: varchar('note', { length: 500 }),

    /** No `updated_at` on purpose: see the table comment. */
    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_order_status_history_order_store',
    }).onDelete('cascade'),

    foreignKey({
      columns: [t.actorUserId],
      foreignColumns: [appUser.id],
      name: 'fk_order_status_history_actor',
    }).onDelete('set null'),

    /** The transition timeline for one order, in order. */
    index('ix_order_status_history_order').on(t.orderId, t.createdAt),

    check('ck_order_status_history_to_status', sql`${t.toStatus} in ('placed')`),
    check(
      'ck_order_status_history_from_status',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} in ('placed')`,
    ),
    /** A transition to the state it came from is not a transition. */
    check(
      'ck_order_status_history_progresses',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
  ],
);
