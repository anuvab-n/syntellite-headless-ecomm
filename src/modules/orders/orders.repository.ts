import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { address } from '../../db/schema/address.js';
import { appUser } from '../../db/schema/identity.js';
import { order, orderLine, orderStatusHistory } from '../../db/schema/orders.js';
import { exclusiveEndOfMillisecond } from '../../shared/time-bounds.js';
import { payment } from '../../db/schema/payments.js';
import { shipment } from '../../db/schema/shipments.js';

/**
 * The order lifecycle vocabulary, re-exported so nothing outside this module names the table.
 * Same pattern as `inventory.repository.ts` with `STOCK_REASONS`.
 */
export {
  ORDER_STATUSES,
  INITIAL_ORDER_STATUS,
  CANCELLABLE_ORDER_STATUSES,
  CANCELLED_ORDER_STATUS,
  type OrderStatus,
} from '../../db/schema/orders.js';
import { executor } from '../../db/transaction.js';

/**
 * Order persistence.
 *
 * The only file in this module permitted to import a table — `schema-only-in-repositories`.
 * Every method takes `storeId` and puts it in the predicate, and every customer-facing read
 * takes `userId` too, so ownership and tenancy are enforced here rather than trusted from a
 * caller. A future CLI command or job inherits the same isolation.
 *
 * `executor(db)` throughout, so a method called inside `withTransaction` joins the ambient
 * transaction. Checkout depends on that: the order, its lines, its first history row, the audit
 * entry and the idempotency completion must all commit together or not at all.
 *
 * ## Why this file may name `address`
 *
 * `findOwnedAddress` reads the address the customer named so checkout can SNAPSHOT it. That is a
 * table import, which the rules permit for a repository, and it is deliberately narrow: nothing
 * here writes an address, and the only thing decided about one is whether this customer owns it
 * and it is still live. The alternative — a port into the addresses module — would move the
 * ownership predicate out of the query, which is the one place §25 requires it to be.
 *
 * ## Why this file may also name `app_user`, `payment` and `shipment`
 *
 * Increment 50 — the admin order surface. `displayStatus` (§49) is composed from three
 * lifecycles, and the admin list must be able to FILTER and SORT on the result. Reading the
 * payment and shipment state through the existing ports would mean one round trip per order to
 * assemble a page and no way to filter in the database at all — an N+1 by construction, and a
 * filter applied in JavaScript after the page had already been cut, which would produce short
 * pages and a total nobody could trust.
 *
 * `schema-only-in-repositories` permits exactly this, and `no-cross-module-imports` is not
 * engaged: a table is not a module. The reach is deliberately narrow and read-only — nothing
 * here writes to any of the three, and the columns read are a status, a method, and the three
 * customer name fields the admin list shows. `password_hash`, `is_staff` and `is_superuser` are
 * never selected, here or anywhere downstream.
 *
 * Both joins are safe against row multiplication: an order has at most one payment
 * (`uq_payment_order`) and at most one shipment (the whole-order model `SHIPMENT_ALREADY_EXISTS`
 * enforces), so a `LEFT JOIN` on either cannot turn one order into two rows. If split shipments
 * ever land, this becomes a `DISTINCT ON` and the tests below are what will say so.
 */

export type OrdersRepository = ReturnType<typeof createOrdersRepository>;

/** An order header as the rest of the system sees it. */
export type OrderRecord = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly total: string;

  /**
   * GST — Increment 38. `grand_total` is the PAYABLE amount and is what payments charge;
   * `total` still means the goods total, permanently.
   *
   * The determination snapshot is nullable as a GROUP: NULL across it means no tax
   * determination was made for this order, which is different from one that produced zero.
   * `ck_order_tax_snapshot` makes a half-populated group unrepresentable, so a caller that
   * finds `taxAt` non-null may rely on every other field being present too.
   */
  readonly taxTotal: string;
  readonly grandTotal: string;
  readonly taxAt: Date | null;
  readonly supplyType: string | null;
  readonly placeOfSupplyState: string | null;
  readonly placeOfSupplyBasis: string | null;
  readonly sellerGstin: string | null;
  readonly sellerLegalName: string | null;
  readonly originLine1: string | null;
  readonly originLine2: string | null;
  readonly originCity: string | null;
  readonly originState: string | null;
  readonly originPostalCode: string | null;
  readonly originCountryCode: string | null;
  readonly customerTaxCategory: string | null;
  readonly customerGstin: string | null;
  readonly customerLegalName: string | null;

  readonly promotionCode: string | null;
  readonly promotionName: string | null;
  readonly shipRecipientName: string;
  readonly shipPhone: string;
  readonly shipLine1: string;
  readonly shipLine2: string;
  readonly shipLandmark: string;
  readonly shipCity: string;
  readonly shipState: string;
  readonly shipPostalCode: string;
  readonly shipCountryCode: string;
  readonly placedAt: Date;
};

/** One order line, exactly as it was snapshotted. Nothing here is ever recomputed. */
export type OrderLineRecord = {
  readonly skuCode: string;
  readonly skuName: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineTotal: string;
  readonly discountAmount: string;

  /**
   * GST — Increment 38. `taxableValue` is `lineTotal - discountAmount`, materialised.
   *
   * Rates and amounts are NOT NULL and zero when no tax applied; the classification snapshot
   * is null when the line was never assessed. Whether the ORDER was assessed at all is
   * answered by the header's `taxAt`, which is where that distinction belongs.
   */
  readonly taxableValue: string;
  readonly hsnCode: string | null;
  readonly taxClassCode: string | null;
  readonly taxClassName: string | null;
  readonly cgstRate: string;
  readonly cgstAmount: string;
  readonly sgstRate: string;
  readonly sgstAmount: string;
  readonly igstRate: string;
  readonly igstAmount: string;
  readonly cessRate: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
};

/** The delivery fields checkout copies onto the order. */
export type OwnedAddress = {
  readonly id: string;
  readonly recipientName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string;
  readonly landmark: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly countryCode: string;
};

/**
 * The response columns, one list.
 *
 * `id`, `user_id`, `store_id`, `cart_id`, `address_id`, `promotion_id`, `created_at` and
 * `updated_at` are all deliberately absent: an order is addressed by its NUMBER, and the rest
 * are invariants of the query rather than fields a client inspects.
 */
const ORDER_COLUMNS = {
  id: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  currency: order.currency,
  subtotal: order.subtotal,
  discountTotal: order.discountTotal,
  total: order.total,
  taxTotal: order.taxTotal,
  grandTotal: order.grandTotal,
  taxAt: order.taxAt,
  supplyType: order.supplyType,
  placeOfSupplyState: order.placeOfSupplyState,
  placeOfSupplyBasis: order.placeOfSupplyBasis,
  sellerGstin: order.sellerGstin,
  sellerLegalName: order.sellerLegalName,
  originLine1: order.originLine1,
  originLine2: order.originLine2,
  originCity: order.originCity,
  originState: order.originState,
  originPostalCode: order.originPostalCode,
  originCountryCode: order.originCountryCode,
  customerTaxCategory: order.customerTaxCategory,
  customerGstin: order.customerGstin,
  customerLegalName: order.customerLegalName,
  promotionCode: order.promotionCode,
  promotionName: order.promotionName,
  shipRecipientName: order.shipRecipientName,
  shipPhone: order.shipPhone,
  shipLine1: order.shipLine1,
  shipLine2: order.shipLine2,
  shipLandmark: order.shipLandmark,
  shipCity: order.shipCity,
  shipState: order.shipState,
  shipPostalCode: order.shipPostalCode,
  shipCountryCode: order.shipCountryCode,
  placedAt: order.placedAt,
} as const;

/**
 * The customer identity an admin order row carries. **An allowlist, and a short one.**
 *
 * Three columns, chosen because the admin list shows "who placed this" and nothing more. The
 * omissions are the point: `password_hash` is a credential, `is_staff` and `is_superuser` are
 * privilege flags that would let an operator screen double as a privilege map, and neither has
 * any business travelling with an order. Written as an explicit projection rather than
 * `getTableColumns(appUser)` so that a column added to `app_user` later cannot arrive here by
 * default — the §25 rule that a response is an allowlist, applied one layer earlier.
 */
const ADMIN_ORDER_CUSTOMER_COLUMNS = {
  customerId: appUser.id,
  customerEmail: appUser.email,
  customerFirstName: appUser.firstName,
  customerLastName: appUser.lastName,
} as const;

/**
 * The three lifecycle facts, joined. `null` on either side means "no such row", which is a
 * distinct answer from any status — see `deriveOrderDisplayStatus`, which relies on it.
 */
const ADMIN_ORDER_CONTEXT_COLUMNS = {
  paymentStatus: payment.status,
  paymentMethod: payment.method,
  shipmentStatus: shipment.status,
} as const;

const ADMIN_ORDER_COLUMNS = {
  ...ORDER_COLUMNS,
  ...ADMIN_ORDER_CUSTOMER_COLUMNS,
  ...ADMIN_ORDER_CONTEXT_COLUMNS,
} as const;

/** One order as the admin surface reads it: the header, its customer, and its two contexts. */
export type AdminOrderRecord = OrderRecord & {
  readonly customerId: string;
  readonly customerEmail: string;
  readonly customerFirstName: string;
  readonly customerLastName: string;
  readonly paymentStatus: string | null;
  readonly paymentMethod: string | null;
  readonly shipmentStatus: string | null;
};

/**
 * **`displayStatus` as SQL — the second implementation of §49's table, and the only one.**
 *
 * `deriveOrderDisplayStatus` is the runtime source of the VALUE on every response. This fragment
 * exists solely so the list can FILTER on that value in the database rather than in JavaScript
 * after the page has been cut. Two implementations of one rule is a drift risk, and it is
 * accepted deliberately rather than by accident:
 *
 *  - The branches below are in the same order, with the same conditions, as the `if` chain in
 *    `order-display-status.ts`. Read side by side they diff by eye.
 *  - `admin-orders.integration.test.ts` seeds every reachable combination and asserts that
 *    filtering by each status returns exactly the orders the TS function maps to it. Drift is
 *    caught by a failing test, not prevented by a comment.
 *
 * The alternative — deriving in SQL and deleting the TS function — was rejected because it would
 * make the rule untestable without a database and unavailable to the detail endpoint, which has
 * no filter to apply.
 */
const displayStatusSql: SQL<string> = sql<string>`
  case
    when ${order.status} = 'cancelled' then 'cancelled'
    when ${shipment.status} = 'delivered' then 'delivered'
    when ${shipment.status} = 'shipped' then 'shipped'
    when ${shipment.status} = 'pending' then 'processing'
    when ${payment.status} is null then 'pending'
    when ${payment.status} in ('failed', 'expired') then 'failed'
    when ${payment.status} = 'succeeded' then 'confirmed'
    when ${payment.status} = 'pending' and ${payment.method} = 'cod' then 'confirmed'
    else 'pending'
  end`;

/** The filters the admin list accepts. Every one of them is optional. */
export type AdminOrderFilters = {
  readonly displayStatus?: string;
  readonly paymentStatus?: string;
  readonly shipmentStatus?: string;
  readonly placedFrom?: Date;
  readonly placedTo?: Date;
  readonly q?: string;
};

export function createOrdersRepository(deps: { db: Database }) {
  const { db } = deps;

  /** This customer's orders in this store. Ownership and tenancy, never separable. */
  const owned = (params: { userId: string; storeId: string }) =>
    and(eq(order.userId, params.userId), eq(order.storeId, params.storeId));

  return {
    /**
     * The address the customer named, for the checkout snapshot.
     *
     * Scoped by `user_id`, `store_id` and `deleted_at IS NULL` in ONE predicate — the §25 rule
     * that ownership belongs in the query rather than in a comparison performed afterwards. An
     * unknown id, another customer's address, another store's, and a soft-deleted one are all
     * `undefined`, so the caller answers one `404` and reveals nothing.
     *
     * Read INSIDE the checkout transaction, so an address soft-deleted a moment later cannot
     * change what was snapshotted.
     */
    async findOwnedAddress(params: {
      addressId: string;
      userId: string;
      storeId: string;
    }): Promise<OwnedAddress | undefined> {
      const [row] = await executor(db)
        .select({
          id: address.id,
          recipientName: address.recipientName,
          phone: address.phone,
          line1: address.line1,
          line2: address.line2,
          landmark: address.landmark,
          city: address.city,
          state: address.state,
          postalCode: address.postalCode,
          countryCode: address.countryCode,
        })
        .from(address)
        .where(
          and(
            eq(address.id, params.addressId),
            eq(address.userId, params.userId),
            eq(address.storeId, params.storeId),
            isNull(address.deletedAt),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Insert the order header.
     *
     * Every money and snapshot value is supplied by the service, which computed them from one
     * transactional read. Nothing is defaulted here that a caller might have meant to set.
     */
    async insertOrder(values: {
      id: string;
      storeId: string;
      userId: string;
      cartId: string;
      orderNumber: string;
      status: string;
      currency: string;
      subtotal: string;
      discountTotal: string;
      total: string;
      taxTotal: string;
      grandTotal: string;
      taxAt: Date | null;
      supplyType: string | null;
      placeOfSupplyState: string | null;
      placeOfSupplyBasis: string | null;
      sellerGstin: string | null;
      sellerLegalName: string | null;
      originLine1: string | null;
      originLine2: string | null;
      originCity: string | null;
      originState: string | null;
      originPostalCode: string | null;
      originCountryCode: string | null;
      customerTaxCategory: string | null;
      customerGstin: string | null;
      customerLegalName: string | null;
      promotionId: string | null;
      promotionCode: string | null;
      promotionName: string | null;
      addressId: string;
      shipRecipientName: string;
      shipPhone: string;
      shipLine1: string;
      shipLine2: string;
      shipLandmark: string;
      shipCity: string;
      shipState: string;
      shipPostalCode: string;
      shipCountryCode: string;
      placedAt: Date;
    }): Promise<OrderRecord> {
      const [row] = await executor(db).insert(order).values(values).returning(ORDER_COLUMNS);
      if (!row) {
        // Unreachable: an INSERT ... RETURNING either returns its row or throws.
        throw new Error('order insert returned no row');
      }
      return row;
    },

    /** Insert every line in one statement. */
    async insertOrderLines(
      values: readonly {
        orderId: string;
        skuId: string;
        storeId: string;
        skuCode: string;
        skuName: string;
        productName: string;
        quantity: number;
        unitPrice: string;
        lineTotal: string;
        discountAmount: string;
        taxableValue: string;
        hsnCode: string | null;
        taxClassCode: string | null;
        taxClassName: string | null;
        cgstRate: string;
        cgstAmount: string;
        sgstRate: string;
        sgstAmount: string;
        igstRate: string;
        igstAmount: string;
        cessRate: string;
        cessAmount: string;
        taxTotal: string;
      }[],
    ): Promise<void> {
      if (values.length === 0) {
        // Unreachable: checkout refuses an empty cart before reaching here. Stated so a future
        // change fails loudly rather than writing an order with no lines.
        throw new Error('refusing to insert an order with no lines');
      }
      await executor(db)
        .insert(orderLine)
        .values([...values]);
    },

    /**
     * Append one status-history row.
     *
     * The only write this table ever gets: no update path and no delete path exists, which is
     * §3 #8 — _"every transition is a row. No `UPDATE` rewrites the past."_
     */
    async insertStatusHistory(values: {
      id: string;
      orderId: string;
      storeId: string;
      fromStatus: string | null;
      toStatus: string;
      actorType: string;
      actorUserId: string | null;
    }): Promise<void> {
      await executor(db).insert(orderStatusHistory).values(values);
    },

    /**
     * Lock one of this customer's orders for a status change.
     *
     * The serialisation point for cancellation, exactly as the cart row is for checkout: two
     * concurrent cancellations of one order both take this lock, so the second sees the status
     * the first wrote rather than the one it read. Scoped by user AND store, so a foreign order
     * is `undefined` here rather than being refused later.
     *
     * `FOR UPDATE` is only expressible on the query builder, never on `db.query.*` — §6's trap.
     */
    async lockOwnedOrderByNumber(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
    }): Promise<OrderRecord | undefined> {
      const [row] = await executor(db)
        .select(ORDER_COLUMNS)
        .from(order)
        .where(
          and(
            eq(order.orderNumber, params.orderNumber),
            eq(order.userId, params.userId),
            eq(order.storeId, params.storeId),
          ),
        )
        .limit(1)
        .for('update');
      return row;
    },

    /**
     * Move an order to a new status.
     *
     * The `status = fromStatus` predicate is in the statement, so a writer that somehow got
     * past the lock still resolves to one winner — and the loser learns it lost from a row count
     * rather than by overwriting a decision that landed first. Returns false when the row had
     * already moved.
     */
    async updateOrderStatus(params: {
      orderId: string;
      storeId: string;
      fromStatus: string;
      toStatus: string;
      at: Date;
    }): Promise<boolean> {
      const updated = await executor(db)
        .update(order)
        .set({ status: params.toStatus, updatedAt: params.at })
        .where(
          and(
            eq(order.id, params.orderId),
            eq(order.storeId, params.storeId),
            eq(order.status, params.fromStatus),
          ),
        )
        .returning({ id: order.id });
      return updated.length === 1;
    },

    /**
     * One of this customer's orders, by NUMBER.
     *
     * An unknown number, another customer's order and another store's order all return
     * `undefined`, so the route answers one indistinguishable `404`. Case-sensitive, matching
     * `codeColumn`'s stated convention — an order number is machine-generated and quoted back
     * verbatim, unlike a coupon a human types off a banner.
     */
    async findOwnedOrderByNumber(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
    }): Promise<OrderRecord | undefined> {
      const [row] = await executor(db)
        .select(ORDER_COLUMNS)
        .from(order)
        .where(and(eq(order.orderNumber, params.orderNumber), owned(params)))
        .limit(1);
      return row;
    },

    /**
     * One order in this store, WHOSEVER it is.
     *
     * The deliberate absence of a `user_id` predicate is the whole point, and it is the reason
     * this is a separate method rather than an optional argument on `findOwnedOrderByNumber`:
     * a caller that forgot to pass an owner would silently get store-wide reach, and that is
     * exactly the kind of hole an optional security parameter creates. Two names, two
     * predicates, and the narrower one stays the default.
     *
     * `store_id` is still non-negotiable — staff of one tenant must not read another's orders.
     * Only ownership within the store is relaxed, and only for callers behind `requireStaff`.
     */
    async findStoreOrderByNumber(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<OrderRecord | undefined> {
      const [row] = await executor(db)
        .select(ORDER_COLUMNS)
        .from(order)
        .where(and(eq(order.orderNumber, params.orderNumber), eq(order.storeId, params.storeId)))
        .limit(1);
      return row;
    },

    /**
     * Lock one order by NUMBER, store-scoped and NOT user-scoped. For staff fulfilment.
     *
     * Staff act on any order in their store and there is no customer in the request to scope
     * by, so `user_id` is deliberately absent — but `store_id` is mandatory and comes from the
     * staff member's verified token, never from input.
     *
     * Finds AND locks in one statement, so a caller cannot read first and lock later — the
     * read-then-decide shape this codebase refuses. Returns only the three fields fulfilment
     * needs; handing over the whole row would let another module reason about money.
     */
    async lockOrderByNumberForStore(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<{ id: string; orderNumber: string; status: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: order.id, orderNumber: order.orderNumber, status: order.status })
        .from(order)
        .where(and(eq(order.orderNumber, params.orderNumber), eq(order.storeId, params.storeId)))
        .limit(1)
        .for('update');
      return row;
    },

    /** The same lock, by id. The ship and deliver paths reach the order through a shipment. */
    async lockOrderByIdForStore(params: {
      orderId: string;
      storeId: string;
    }): Promise<{ id: string; orderNumber: string; status: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: order.id, orderNumber: order.orderNumber, status: order.status })
        .from(order)
        .where(and(eq(order.id, params.orderId), eq(order.storeId, params.storeId)))
        .limit(1)
        .for('update');
      return row;
    },
    /**
     * Lock one order by id, store-scoped and NOT user-scoped. For the expiry sweeper.
     *
     * The customer-facing `lockOwnedOrderByNumber` above carries `user_id` because a customer
     * may only lock their own order. The sweeper is the system acting on an order it reached
     * through a payment row, so there is no authenticated user to scope by — but `store_id` is
     * still mandatory, and it comes from the payment row rather than from any caller input.
     *
     * Returns the id only. The sweeper needs the LOCK, not the order: it makes no decision from
     * the order's contents, and returning the row would invite one.
     */
    async lockOrderById(params: {
      orderId: string;
      storeId: string;
    }): Promise<{ id: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: order.id })
        .from(order)
        .where(and(eq(order.id, params.orderId), eq(order.storeId, params.storeId)))
        .limit(1)
        .for('update');
      return row;
    },

    /** The lines of one order, in the sequence they were written. */
    /**
     * The frozen lines, with the SKU id the customer-facing projection deliberately omits.
     *
     * `OrderLineRecord` publishes `skuCode` because an id is never part of the API contract.
     * A return LINE references `sku_id` though, so returns needs both — and widening the
     * public record for one internal caller would leak the id into every order response.
     */
    async listOrderLinesWithSkuId(params: {
      orderId: string;
      storeId: string;
    }): Promise<(OrderLineRecord & { skuId: string })[]> {
      return executor(db)
        .select({
          skuId: orderLine.skuId,
          skuCode: orderLine.skuCode,
          skuName: orderLine.skuName,
          productName: orderLine.productName,
          quantity: orderLine.quantity,
          unitPrice: orderLine.unitPrice,
          lineTotal: orderLine.lineTotal,
          discountAmount: orderLine.discountAmount,
          taxableValue: orderLine.taxableValue,
          hsnCode: orderLine.hsnCode,
          taxClassCode: orderLine.taxClassCode,
          taxClassName: orderLine.taxClassName,
          cgstRate: orderLine.cgstRate,
          cgstAmount: orderLine.cgstAmount,
          sgstRate: orderLine.sgstRate,
          sgstAmount: orderLine.sgstAmount,
          igstRate: orderLine.igstRate,
          igstAmount: orderLine.igstAmount,
          cessRate: orderLine.cessRate,
          cessAmount: orderLine.cessAmount,
          taxTotal: orderLine.taxTotal,
        })
        .from(orderLine)
        .where(and(eq(orderLine.orderId, params.orderId), eq(orderLine.storeId, params.storeId)))
        .orderBy(orderLine.skuCode);
    },

    async listOrderLines(params: { orderId: string; storeId: string }): Promise<OrderLineRecord[]> {
      return executor(db)
        .select({
          skuCode: orderLine.skuCode,
          skuName: orderLine.skuName,
          productName: orderLine.productName,
          quantity: orderLine.quantity,
          unitPrice: orderLine.unitPrice,
          lineTotal: orderLine.lineTotal,
          discountAmount: orderLine.discountAmount,
          taxableValue: orderLine.taxableValue,
          hsnCode: orderLine.hsnCode,
          taxClassCode: orderLine.taxClassCode,
          taxClassName: orderLine.taxClassName,
          cgstRate: orderLine.cgstRate,
          cgstAmount: orderLine.cgstAmount,
          sgstRate: orderLine.sgstRate,
          sgstAmount: orderLine.sgstAmount,
          igstRate: orderLine.igstRate,
          igstAmount: orderLine.igstAmount,
          cessRate: orderLine.cessRate,
          cessAmount: orderLine.cessAmount,
          taxTotal: orderLine.taxTotal,
        })
        .from(orderLine)
        .where(and(eq(orderLine.orderId, params.orderId), eq(orderLine.storeId, params.storeId)))
        .orderBy(orderLine.skuCode);
    },

    /**
     * A page of this customer's orders, newest first, plus the total.
     *
     * Both halves use the SAME predicate, so the page and the count cannot disagree — the §28
     * rule that a caller on the last page must not be told the total counted rows it can never
     * see. Ordered by `placed_at DESC` then `order_number` so the ordering is total and a page
     * boundary is stable when two orders share an instant.
     */
    async listOrdersForUser(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: OrderRecord[]; total: number }> {
      const scope = owned(params);

      const [items, [totals]] = await Promise.all([
        executor(db)
          .select(ORDER_COLUMNS)
          .from(order)
          .where(scope)
          .orderBy(desc(order.placedAt), desc(order.orderNumber))
          .limit(params.limit)
          .offset(params.offset),
        executor(db).select({ total: count() }).from(order).where(scope),
      ]);

      return { items, total: totals?.total ?? 0 };
    },

    /**
     * The lines of many orders in one query, for the list endpoint.
     *
     * Store-scoped and keyed by order id, so a caller that has already established ownership of
     * those ids cannot be handed lines from anywhere else.
     */
    async listLinesForOrders(params: {
      orderIds: readonly string[];
      storeId: string;
    }): Promise<(OrderLineRecord & { orderId: string })[]> {
      if (params.orderIds.length === 0) return [];

      return executor(db)
        .select({
          orderId: orderLine.orderId,
          skuCode: orderLine.skuCode,
          skuName: orderLine.skuName,
          productName: orderLine.productName,
          quantity: orderLine.quantity,
          unitPrice: orderLine.unitPrice,
          lineTotal: orderLine.lineTotal,
          discountAmount: orderLine.discountAmount,
          taxableValue: orderLine.taxableValue,
          hsnCode: orderLine.hsnCode,
          taxClassCode: orderLine.taxClassCode,
          taxClassName: orderLine.taxClassName,
          cgstRate: orderLine.cgstRate,
          cgstAmount: orderLine.cgstAmount,
          sgstRate: orderLine.sgstRate,
          sgstAmount: orderLine.sgstAmount,
          igstRate: orderLine.igstRate,
          igstAmount: orderLine.igstAmount,
          cessRate: orderLine.cessRate,
          cessAmount: orderLine.cessAmount,
          taxTotal: orderLine.taxTotal,
        })
        .from(orderLine)
        .where(
          and(
            eq(orderLine.storeId, params.storeId),
            inArray(orderLine.orderId, [...params.orderIds]),
          ),
        )
        .orderBy(orderLine.skuCode);
    },

    /**
     * **A page of the STORE's orders, whosever they are, with their payment and shipment state.**
     *
     * The admin counterpart of `listOrdersForUser`, and a separate method for the reason
     * `findStoreOrderByNumber` is separate from `findOwnedOrderByNumber`: a caller that forgot
     * to pass an owner would otherwise silently get store-wide reach. Two names, two predicates,
     * and the narrower one stays the default.
     *
     * `store_id` is NOT relaxed and never comes from input — the caller takes it from the staff
     * member's verified token. Only ownership within the store is dropped, which is the entire
     * meaning of "admin" here.
     *
     * **One query, two joins, no N+1.** The payment and shipment state travel with the order row
     * rather than being fetched per order, so a page of 100 orders is one round trip and the
     * `displayStatus` filter is applied by the database BEFORE the page is cut. Filtering after
     * the fact would return short pages and a total that counted rows the filter then removed.
     *
     * Page and count share ONE predicate, so a caller on the last page is never told the total
     * counted rows it cannot see — the §28 rule `listOrdersForUser` already follows. Ordered by
     * `placed_at DESC` then `order_number DESC` so the ordering is total and a page boundary is
     * stable when two orders share an instant.
     */
    async listStoreOrders(params: {
      storeId: string;
      filters: AdminOrderFilters;
      limit: number;
      offset: number;
    }): Promise<{ items: AdminOrderRecord[]; total: number }> {
      const where = adminOrderPredicate(params.storeId, params.filters);

      /*
       * The joins are repeated on both halves rather than factored into a shared builder: the
       * count MUST see the same join graph as the page, because `displayStatus` and the shipment
       * and payment filters are expressed over the joined columns. A count over `order` alone
       * would silently ignore every one of them.
       */
      const [items, [totals]] = await Promise.all([
        executor(db)
          .select(ADMIN_ORDER_COLUMNS)
          .from(order)
          .innerJoin(appUser, eq(appUser.id, order.userId))
          .leftJoin(payment, and(eq(payment.orderId, order.id), eq(payment.storeId, order.storeId)))
          .leftJoin(
            shipment,
            and(eq(shipment.orderId, order.id), eq(shipment.storeId, order.storeId)),
          )
          .where(where)
          .orderBy(desc(order.placedAt), desc(order.orderNumber))
          .limit(params.limit)
          .offset(params.offset),
        executor(db)
          .select({ total: count() })
          .from(order)
          .innerJoin(appUser, eq(appUser.id, order.userId))
          .leftJoin(payment, and(eq(payment.orderId, order.id), eq(payment.storeId, order.storeId)))
          .leftJoin(
            shipment,
            and(eq(shipment.orderId, order.id), eq(shipment.storeId, order.storeId)),
          )
          .where(where),
      ]);

      return { items, total: totals?.total ?? 0 };
    },

    /**
     * One order in this store with its payment and shipment state, for the admin detail read.
     *
     * The same join graph as the list, so the `displayStatus` the detail reports can never
     * disagree with the one the list reported for the same order. Store-scoped and NOT
     * user-scoped, exactly as `findStoreOrderByNumber` is; `undefined` for an unknown number and
     * for another store's order alike, so the caller answers one `404` and reveals nothing.
     */
    async findStoreOrderDetailByNumber(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<AdminOrderRecord | undefined> {
      const [row] = await executor(db)
        .select(ADMIN_ORDER_COLUMNS)
        .from(order)
        .innerJoin(appUser, eq(appUser.id, order.userId))
        .leftJoin(payment, and(eq(payment.orderId, order.id), eq(payment.storeId, order.storeId)))
        .leftJoin(
          shipment,
          and(eq(shipment.orderId, order.id), eq(shipment.storeId, order.storeId)),
        )
        .where(and(eq(order.orderNumber, params.orderNumber), eq(order.storeId, params.storeId)))
        .limit(1);
      return row;
    },
  };
}

/**
 * The admin list's WHERE clause: tenancy, then whichever filters were supplied.
 *
 * A free function rather than a closure inside the factory because it takes everything it needs
 * and captures nothing — which is what makes it readable as the one place tenancy is applied.
 * `storeId` is the first conjunct and is not optional; every filter below can only narrow.
 */
function adminOrderPredicate(storeId: string, filters: AdminOrderFilters): SQL | undefined {
  const clauses: SQL[] = [eq(order.storeId, storeId)];

  /*
   * Compared against the CASE expression itself rather than against a set of raw-column
   * conditions unrolled per status. Unrolling would be a THIRD statement of §49's table, and the
   * one most likely to drift, because each status would be a hand-written combination nobody
   * reads next to the other two.
   */
  if (filters.displayStatus !== undefined) {
    clauses.push(sql`${displayStatusSql} = ${filters.displayStatus}`);
  }

  if (filters.paymentStatus !== undefined) clauses.push(eq(payment.status, filters.paymentStatus));
  if (filters.shipmentStatus !== undefined) {
    clauses.push(eq(shipment.status, filters.shipmentStatus));
  }

  /*
   * The lower bound needs no adjustment: every microsecond inside the named millisecond is
   * already greater than its start, so `>=` admits them all.
   */
  if (filters.placedFrom !== undefined) clauses.push(gte(order.placedAt, filters.placedFrom));
  /*
   * STRICT `<` against the start of the NEXT millisecond, not `<=` against this one.
   *
   * `placed_at` is microsecond-precise in the database and millisecond-precise everywhere in
   * this API, so `<=` dropped every order whose stored microseconds were non-zero — including
   * the order a client had just read the bound from. `exclusiveEndOfMillisecond` carries the
   * reasoning; the payment and customer lists use the same helper for the same reason.
   */
  if (filters.placedTo !== undefined) {
    clauses.push(lt(order.placedAt, exclusiveEndOfMillisecond(filters.placedTo)));
  }

  /*
   * The operator's search box: an order number or a customer email, case-insensitively, as a
   * substring. `%` and `_` in the term are escaped first — an unescaped `%` would turn a typo
   * into a full table scan that matched everything, which reads as "the filter is broken".
   *
   * Deliberately NOT a search over names or addresses. A wider search is a wider disclosure, and
   * the two fields here are the two an operator already has in hand from the customer.
   */
  if (filters.q !== undefined && filters.q.length > 0) {
    const term = `%${filters.q.replace(/([\\%_])/gu, '\\$1')}%`;
    const match = or(ilike(order.orderNumber, term), ilike(appUser.email, term));
    if (match) clauses.push(match);
  }

  return and(...clauses);
}
