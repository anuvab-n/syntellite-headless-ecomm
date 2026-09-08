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
  rateColumn,
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
 * columns — no carrier, no cost, no tracking. No invoice number or series. No return or refund
 * state. Each belongs to its own increment, and each would encode a business rule this
 * increment has not been given.
 *
 * **Tax arrived in Increment 38** and is the exception that proves the rule: it was added
 * ADDITIVELY, as `tax_total` / `grand_total` beside an untouched `total`, plus a determination
 * snapshot that copies every mutable input rather than referencing it. There is still no
 * invoice number, no series, no IRN and no credit note.
 *
 * No inventory interaction of any kind: §39 defers _"reservations and allocation (the increment
 * that will need `FOR UPDATE`, and the one that first writes `reserved`)"_, so placing an order
 * moves no stock and writes no ledger row.
 *
 * No `promotion_redemption` and no usage counters. Applying and now ordering with a coupon still
 * consumes nothing; §42 defers that with the concurrency design already recorded.
 */

/**
 * The order lifecycle in this build: two states.
 *
 * `placed` on creation, and `cancelled` when the customer withdraws an order nobody has been
 * charged for. Both are producible, which is the bar this enum is held to.
 *
 * `pending_payment`, `paid`, `payment_failed`, `packed`, `shipped`, `delivered`, `returned` and
 * `refunded` remain absent on purpose. Each would be written by an increment that does not
 * exist, and a status value nothing can produce is worse than a missing one: it looks like a
 * supported state to every reader of the enum.
 *
 * **`cancelled` is NOT a payment state, and adding it did not fold one in here.** It records a
 * decision about the ORDER — the customer no longer wants it. Whether money moved is still
 * answered entirely by the payment table, and the cancellation rule reads that table through a
 * port rather than mirroring it into this column. The four state spaces stay separate:
 * `cart.status`, `order.status`, the payment table, and a future shipment table. Folding
 * payment or fulfilment into this column is the shortcut that makes both impossible to model
 * properly later.
 */
export const ORDER_STATUSES = ['placed', 'cancelled'] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The status an order is created in. */
export const INITIAL_ORDER_STATUS: OrderStatus = 'placed';

/**
 * Statuses a customer may cancel from.
 *
 * One entry, and it is the whole of the transition table for orders — `placed -> cancelled` is
 * the only legal move. `cancelled` is terminal and absorbing: there is no un-cancel, because
 * reinstating an order would need the stock, the prices and the promotion to still be valid,
 * and none of that is re-checkable after the fact. A customer who changes their mind places a
 * new order.
 */
export const CANCELLABLE_ORDER_STATUSES = ['placed'] as const;

/** The status a cancelled order holds. Named so the service and the CHECK cannot drift. */
export const CANCELLED_ORDER_STATUS: OrderStatus = 'cancelled';

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
     * GST, added by Increment 38 **additively**. `total` was not touched.
     *
     *   `tax_total`   = Σ `order_line.tax_total`
     *   `grand_total` = `total` + `tax_total`   ← what the customer actually pays
     *
     * The comment above promised exactly this shape — *"When GST arrives it adds `tax_total`
     * and `grand_total`; it must not redefine `total`"* — and `ck_order_total_identity` is
     * still in force beside `ck_order_grand_total_identity`, so neither meaning can drift.
     *
     * **`grand_total` is now the payable amount**, and `payment.amount` is copied from it
     * rather than from `total`. For an untaxed order the two are equal, which is why that
     * change is invisible to every order placed before this increment.
     *
     * Both NOT NULL. Pre-GST orders were backfilled `tax_total = 0` and `grand_total = total`,
     * which is not an assumption — no tax was calculated or charged on any of them, and the
     * arithmetic is true. What those orders do NOT get is the determination snapshot below.
     */
    taxTotal: moneyColumn('tax_total').notNull().default('0'),
    grandTotal: moneyColumn('grand_total').notNull(),

    /**
     * **The tax determination snapshot. Every column NULL together, or every column present.**
     *
     * NULL across the group means *no tax determination was made for this order* — either it
     * predates Increment 38, or its store has no GST profile configured. That is genuinely
     * different from a determination that produced zero, which arrives as a full snapshot with
     * zero rates, and the two must stay distinguishable: one says "not assessed", the other
     * says "assessed at nil". Collapsing them would make an unassessed order look exempt.
     *
     * `ck_order_tax_snapshot` enforces the all-or-nothing, exactly as
     * `ck_order_promotion_snapshot` does for the promotion group.
     *
     * ## Why every one of these is COPIED
     *
     * Approved decision 14: *"Historical invoices/orders must not re-read mutable tax master
     * data."* Every source below is mutable — a store can change its GSTIN, a customer can
     * correct their registration, a merchant can move premises. §40's rule applies to all of
     * them: *"the moment a past invoice reads a live address, a customer fixing a typo
     * rewrites history."* There is deliberately no foreign key to `tax_class` or `tax_rate`
     * anywhere on an order.
     */

    /**
     * The AUTHORITATIVE TAX INSTANT: the moment the determination was made, and the instant
     * the effective-dated rate was selected against.
     *
     * Its own column rather than reusing `placed_at`, for the reason `placed_at` itself is not
     * `created_at`: they coincide today because tax is determined during checkout, and a
     * future increment that moves the determination — to dispatch, say — must be able to say
     * so without restating what "placed" means.
     *
     * Approved decision 16 fixes this for COD too: tax becomes authoritative here, at
     * checkout, and does NOT wait for a payment that by design never succeeds.
     */
    taxAt: tsColumn('tax_at'),

    /** `intra_state` (CGST+SGST) or `inter_state` (IGST) — approved decision 10. */
    supplyType: varchar('supply_type', { length: 20 }),

    /**
     * Where the supply was made, and WHICH RULE decided that.
     *
     * The basis column is approved decision 9 made structural: *"Do not hide statutory
     * exceptions inside a generic state comparison."* One value exists today
     * (`delivery_destination`), so every historical order records the rule it was decided
     * under and a future exception becomes a new value rather than an invisible behaviour
     * change.
     *
     * Stored as the NORMALISED state string actually used in the comparison, not the raw
     * `ship_state` — so re-reading the order shows exactly what was compared. There is no
     * state code, because §43 declined to invent that catalogue and this increment was told
     * not to invent one either.
     */
    placeOfSupplyState: varchar('place_of_supply_state', { length: 120 }),
    placeOfSupplyBasis: varchar('place_of_supply_basis', { length: 40 }),

    /** The seller of record at the moment of supply — approved decision 2. */
    sellerGstin: varchar('seller_gstin', { length: 15 }),
    sellerLegalName: varchar('seller_legal_name', { length: 300 }),

    /**
     * The origin / dispatch address, snapshotted in full.
     *
     * A reference would not do, for precisely the reason §40 measured on the delivery address:
     * the snapshot is what survives the merchant editing the live row. `origin_state` is the
     * seller half of the supply-type comparison and is the field that most needs freezing.
     */
    originLine1: varchar('origin_line1', { length: 300 }),
    originLine2: varchar('origin_line2', { length: 300 }),
    originCity: varchar('origin_city', { length: 120 }),
    originState: varchar('origin_state', { length: 120 }),
    originPostalCode: varchar('origin_postal_code', { length: 16 }),
    originCountryCode: varchar('origin_country_code', { length: 2 }),

    /**
     * B2B or B2C, and the customer's GSTIN when there is one — approved decision 8.
     *
     * `customer_gstin` is NULL for B2C and NOT NULL for B2B, which
     * `ck_order_customer_tax_category` enforces rather than leaves to convention: a B2B order
     * with no registration number on it is an invoice that cannot be claimed as input credit,
     * and a B2C order carrying one is a determination that contradicts its own category.
     */
    customerTaxCategory: varchar('customer_tax_category', { length: 10 }),
    customerGstin: varchar('customer_gstin', { length: 15 }),
    customerLegalName: varchar('customer_legal_name', { length: 300 }),

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

    check('ck_order_status', sql`${t.status} in ('placed', 'cancelled')`),

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

    /* ── GST, Increment 38 ───────────────────────────────────────────────── */

    /**
     * **The new identity, stated beside the old one rather than replacing it.**
     *
     * `ck_order_total_identity` above still says `total = subtotal - discount_total`. This
     * says `grand_total = total + tax_total`. Both hold on every row, which is what makes
     * `total` permanently the goods total and `grand_total` permanently the payable one — a
     * row where the two disagree is an order that cannot be invoiced, and it would be found by
     * an accountant rather than by a test.
     */
    check('ck_order_grand_total_identity', sql`${t.grandTotal} = ${t.total} + ${t.taxTotal}`),

    /** Tax is never a credit. Same sentence `ck_order_money_non_negative` was written for. */
    check('ck_order_tax_total_non_negative', sql`${t.taxTotal} >= 0`),

    /**
     * Tax with no determination behind it has no explanation — the exact shape of
     * `ck_order_discount_needs_promotion`, and it is what stops a stray `UPDATE` putting an
     * amount on an order that cannot say how it was arrived at.
     */
    check('ck_order_tax_needs_determination', sql`${t.taxTotal} = 0 OR ${t.taxAt} IS NOT NULL`),

    /**
     * The determination snapshot is all-or-nothing.
     *
     * `customer_gstin` and `customer_legal_name` are deliberately NOT in this group — a B2C
     * determination is complete without them, and `ck_order_customer_tax_category` below is
     * what governs their presence.
     */
    check(
      'ck_order_tax_snapshot',
      sql`(${t.taxAt} IS NULL AND ${t.supplyType} IS NULL AND ${t.placeOfSupplyState} IS NULL
           AND ${t.placeOfSupplyBasis} IS NULL AND ${t.sellerGstin} IS NULL
           AND ${t.sellerLegalName} IS NULL AND ${t.originLine1} IS NULL
           AND ${t.originCity} IS NULL AND ${t.originState} IS NULL
           AND ${t.originPostalCode} IS NULL AND ${t.originCountryCode} IS NULL
           AND ${t.customerTaxCategory} IS NULL)
          OR (${t.taxAt} IS NOT NULL AND ${t.supplyType} IS NOT NULL
           AND ${t.placeOfSupplyState} IS NOT NULL AND ${t.placeOfSupplyBasis} IS NOT NULL
           AND ${t.sellerGstin} IS NOT NULL AND ${t.sellerLegalName} IS NOT NULL
           AND ${t.originLine1} IS NOT NULL AND ${t.originCity} IS NOT NULL
           AND ${t.originState} IS NOT NULL AND ${t.originPostalCode} IS NOT NULL
           AND ${t.originCountryCode} IS NOT NULL AND ${t.customerTaxCategory} IS NOT NULL)`,
    ),

    check(
      'ck_order_supply_type',
      sql`${t.supplyType} IS NULL OR ${t.supplyType} in ('intra_state', 'inter_state')`,
    ),

    check(
      'ck_order_place_of_supply_basis',
      sql`${t.placeOfSupplyBasis} IS NULL OR ${t.placeOfSupplyBasis} in ('delivery_destination')`,
    ),

    /**
     * B2B carries a GSTIN; B2C carries none. Approved decision 8's rule, in the database.
     *
     * Written as three explicit cases rather than as an equality between two `IS NOT NULL`
     * tests, because the unassessed case (both NULL) must also be legal and a two-way
     * equivalence would quietly permit `b2c` with a GSTIN attached.
     */
    check(
      'ck_order_customer_tax_category',
      sql`(${t.customerTaxCategory} IS NULL AND ${t.customerGstin} IS NULL
           AND ${t.customerLegalName} IS NULL)
          OR (${t.customerTaxCategory} = 'b2c' AND ${t.customerGstin} IS NULL
           AND ${t.customerLegalName} IS NULL)
          OR (${t.customerTaxCategory} = 'b2b' AND ${t.customerGstin} IS NOT NULL
           AND ${t.customerLegalName} IS NOT NULL)`,
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

    /**
     * **The taxable value: `line_total - discount_amount`.**
     *
     * §42 decided the ordering — *"a cart-level discount must be allocated across order lines
     * before tax is computed"* — and §43 promised the basis would be derivable per line *"with
     * no re-allocation against a cart that no longer exists"*. Approved decision 12 restates
     * both. This column is that basis, MATERIALISED rather than derived at read time.
     *
     * Stored rather than computed because it is the figure the tax was actually applied to,
     * and a reader must be able to see it without repeating the subtraction and hoping they
     * repeat it the same way. `ck_order_line_taxable_value` pins it to the identity, so it can
     * never disagree with the two columns it comes from.
     *
     * NOT NULL, and backfilled for pre-GST rows: the identity is arithmetic and was already
     * true of every existing line, so the backfill states a fact rather than inventing one.
     */
    taxableValue: moneyColumn('taxable_value').notNull().default('0'),

    /**
     * The classification snapshot — approved decision 6: *"HSN/SAC must be snapshotted on the
     * order line. Historical orders must not depend on the current SKU master data."*
     *
     * Text, not a foreign key to `tax_class`. A class can be renamed and a SKU can be
     * reclassified; either would silently restate a historical invoice through a join. Both
     * the code and the name are copied for the same reason `order_line` copies `sku_code` AND
     * `sku_name` — an audit needs the identifier and the human-readable meaning it had then.
     *
     * NULL together when the order carried no tax determination.
     */
    hsnCode: varchar('hsn_code', { length: 16 }),
    taxClassCode: codeColumn('tax_class_code'),
    taxClassName: varchar('tax_class_name', { length: 300 }),

    /**
     * The resolved rates and the amounts they produced. **Both, not one.**
     *
     * Storing only the amounts would make a line impossible to explain; storing only the rates
     * would make it recomputable and therefore vulnerable to a future change in how rounding
     * works. Approved Phase 3 asks for both, and `ck_order_line_tax_total` ties the amounts
     * together so a stored total can never disagree with its own components.
     *
     * All eight NOT NULL, defaulting to zero, and backfilled as zero: no tax was calculated on
     * a pre-GST line, and zero is the arithmetic truth. Whether the order was ASSESSED at all
     * is answered on the header by `tax_at`, which is where that distinction belongs — a
     * nullable component here would make every consumer handle two spellings of nothing.
     */
    cgstRate: rateColumn('cgst_rate').notNull().default('0'),
    cgstAmount: moneyColumn('cgst_amount').notNull().default('0'),
    sgstRate: rateColumn('sgst_rate').notNull().default('0'),
    sgstAmount: moneyColumn('sgst_amount').notNull().default('0'),
    igstRate: rateColumn('igst_rate').notNull().default('0'),
    igstAmount: moneyColumn('igst_amount').notNull().default('0'),
    cessRate: rateColumn('cess_rate').notNull().default('0'),
    cessAmount: moneyColumn('cess_amount').notNull().default('0'),

    /** Σ of the four amounts above. The figure that sums into `order.tax_total`. */
    taxTotal: moneyColumn('tax_total').notNull().default('0'),

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

    /* ── GST, Increment 38 ───────────────────────────────────────────────── */

    /** The taxable basis, as an identity. See the column comment. */
    check(
      'ck_order_line_taxable_value',
      sql`${t.taxableValue} = ${t.lineTotal} - ${t.discountAmount}`,
    ),

    check(
      'ck_order_line_tax_non_negative',
      sql`${t.cgstRate} >= 0 AND ${t.cgstAmount} >= 0
          AND ${t.sgstRate} >= 0 AND ${t.sgstAmount} >= 0
          AND ${t.igstRate} >= 0 AND ${t.igstAmount} >= 0
          AND ${t.cessRate} >= 0 AND ${t.cessAmount} >= 0
          AND ${t.taxTotal} >= 0`,
    ),

    /** The line's own arithmetic, so a stored total cannot disagree with its components. */
    check(
      'ck_order_line_tax_total',
      sql`${t.taxTotal} = ${t.cgstAmount} + ${t.sgstAmount} + ${t.igstAmount} + ${t.cessAmount}`,
    ),

    /**
     * **A line is intra-state or inter-state, never both.**
     *
     * Approved decision 10 makes the two mutually exclusive: CGST+SGST for a supply within the
     * state, IGST across it. A row carrying all three is not a rounding error — it is a
     * determination that contradicts itself, and it would be discovered on a return rather
     * than here. Rates as well as amounts, so a zero-rated inter-state line still cannot carry
     * an intra-state rate.
     *
     * Cess is deliberately outside the test: it accompanies either arrangement.
     */
    check(
      'ck_order_line_tax_split',
      sql`(${t.igstRate} = 0 AND ${t.igstAmount} = 0)
          OR (${t.cgstRate} = 0 AND ${t.cgstAmount} = 0
              AND ${t.sgstRate} = 0 AND ${t.sgstAmount} = 0)`,
    ),

    /**
     * The classification snapshot is all-or-nothing, matching `ck_sku_tax_classification` on
     * the master row it was copied from.
     */
    check(
      'ck_order_line_tax_classification',
      sql`(${t.hsnCode} IS NULL AND ${t.taxClassCode} IS NULL AND ${t.taxClassName} IS NULL)
          OR (${t.hsnCode} IS NOT NULL AND ${t.taxClassCode} IS NOT NULL
              AND ${t.taxClassName} IS NOT NULL)`,
    ),

    /** Tax on a line that names no classification cannot be explained on an invoice. */
    check(
      'ck_order_line_tax_needs_classification',
      sql`${t.taxTotal} = 0 OR ${t.taxClassCode} IS NOT NULL`,
    ),
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

    check('ck_order_status_history_to_status', sql`${t.toStatus} in ('placed', 'cancelled')`),
    check(
      'ck_order_status_history_from_status',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} in ('placed', 'cancelled')`,
    ),
    /** A transition to the state it came from is not a transition. */
    check(
      'ck_order_status_history_progresses',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
  ],
);
