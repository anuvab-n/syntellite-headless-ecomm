import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { address } from '../../db/schema/address.js';
import { order, orderLine, orderStatusHistory } from '../../db/schema/orders.js';

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
  };
}
