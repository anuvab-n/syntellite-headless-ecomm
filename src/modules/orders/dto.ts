import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import {
  ORDER_DISPLAY_STATUSES,
  deriveOrderDisplayStatus,
  type OrderDisplayStatus,
} from './order-display-status.js';
import type { AdminOrderRecord, OrderLineRecord } from './orders.repository.js';
import type { AdminOrderView, OrderView } from './orders.service.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

/**
 * The orders module's wire contracts.
 *
 * Two jobs, both security boundaries: decide exactly what a client may send, and exactly what
 * leaves the system.
 */

/** Page size for the customer's order list. Operational hygiene, not a business rule. */
export const ORDER_LIST_DEFAULT_LIMIT = 20;
export const ORDER_LIST_MAX_LIMIT = 100;

/* ── POST /users/me/checkout ─────────────────────────────────────────────── */

/**
 * The entire checkout request: **one field.**
 *
 * `strictObject`, so `addressId` is the ONLY accepted key, and everything a client might try to
 * influence is a `400` naming the field rather than being silently ignored:
 *
 *   `userId`, `storeId`      — both come from the verified token; accepting either would be a
 *                              mass-assignment hole across a tenant boundary
 *   `cartId`                 — the cart is found from (user, store); a client cannot choose one
 *   `promotionId`, `promotionCode`
 *                            — the applied promotion comes from the cart and is re-priced here
 *   `subtotal`, `discountTotal`, `total`, `taxTotal`, `expectedTotal`
 *                            — every figure is computed server-side from a transactional read
 *   `unitPrice`, `lineTotal`, `quantity`, `items`, `lines`
 *                            — the lines come from the cart at checkout-time prices
 *   `currency`               — from the store
 *   `orderNumber`, `status`, `paymentStatus`, `placedAt`, `createdAt`, `actorUserId`
 *                            — server-owned, and `paymentStatus` does not exist at all
 *
 * There is deliberately no `expectedTotal` concurrency guard. It would be a genuine UX
 * improvement and a new contract; the order response already tells the customer exactly what
 * they were charged, and adding a field a client must compute is how a client ends up computing
 * money.
 *
 * `Idempotency-Key` is a required HEADER, enforced by `requireIdempotency` rather than by this
 * schema — a header is not part of the body, and validating it here would duplicate the
 * middleware that also has to claim it.
 */
export const CheckoutRequestSchema = z.strictObject({
  /**
   * Which of the customer's addresses to ship to.
   *
   * Required, and there is no default: Increment 27 deferred default addresses entirely, so
   * there is no `is_default_shipping` to fall back on. A UUID by shape only — ownership,
   * tenancy and "not deleted" are decided by the query, never by validation.
   */
  addressId: z.uuid(),
});

export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

/* ── GET /users/me/orders ────────────────────────────────────────────────── */

export const ListOrdersQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: ORDER_LIST_MAX_LIMIT,
    default: ORDER_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

/* ── GET /users/me/orders/:orderNumber ───────────────────────────────────── */

/**
 * The path parameter: an order NUMBER, not an id.
 *
 * The number is what a customer quotes to support and what appears on an invoice; the internal
 * id is never published, so it never becomes part of the contract. The pattern matches what
 * `generateOrderNumber` produces, so a malformed number is a `400` from Zod rather than a query
 * that can only ever miss.
 *
 * Case-SENSITIVE, matching `codeColumn`'s stated convention and unlike a coupon code: an order
 * number is machine-generated and quoted back verbatim, never typed off a banner from memory.
 */
export const OrderNumberParamsSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .max(64)
    .regex(/^ORD-\d{8}-[A-Z2-9]{6}$/, 'must be an order number of the form ORD-YYYYMMDD-XXXXXX'),
});

export type OrderNumberParams = z.infer<typeof OrderNumberParamsSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * One line of an order, as the customer sees it.
 *
 * An allowlist, field by field. `skuId`, `orderId` and `storeId` never appear — an order line is
 * identified by its SKU code, and publishing internal ids would make them part of the contract.
 *
 * Every value here is a SNAPSHOT read straight from `order_line`. Nothing is recomputed from the
 * live catalogue, which is §3 #9 — the product may since have been renamed, repriced, deactivated
 * or deleted, and a past order must not notice.
 *
 * `lineTotal` is PRE-discount merchandise value and `discountAmount` is this line's allocated
 * share, so `lineTotal - discountAmount` is the line's net value — the figure a future tax
 * calculation needs, derivable without re-allocating anything.
 */
export type OrderItemResponse = {
  skuCode: string;
  skuName: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  discountAmount: string;
  /**
   * The line's tax, or `null` when the order carried no determination.
   *
   * A nested object rather than nine flat fields, so "this line was not assessed" is one null
   * rather than nine zeros a client has to interpret. `taxableValue` lives inside it for the
   * same reason: it is only meaningful alongside the rates that were applied to it.
   */
  tax: OrderItemTaxResponse | null;
};

/** One line's GST breakdown, exactly as it was snapshotted. Nothing is recomputed on read. */
export type OrderItemTaxResponse = {
  taxableValue: string;
  hsnCode: string;
  taxClassCode: string;
  taxClassName: string;
  cgstRate: string;
  cgstAmount: string;
  sgstRate: string;
  sgstAmount: string;
  igstRate: string;
  igstAmount: string;
  cessRate: string;
  cessAmount: string;
  taxTotal: string;
};

/**
 * The order-level GST determination, or `null` when none was made.
 *
 * **Deliberately narrow.** The customer sees what was charged and where the supply was made —
 * the facts on their own invoice. The seller's origin ADDRESS is snapshotted on the order but
 * is not published here: a customer needs to know the supply's place, not the merchant's
 * premises, and every field on a response is a field that has to keep being true.
 */
export type OrderTaxResponse = {
  supplyType: string;
  placeOfSupply: string;
  sellerGstin: string;
  sellerLegalName: string;
  customerTaxCategory: string;
  customerGstin: string | null;
  taxedAt: string;
};

/** The delivery address as it was at checkout. `label` is not part of a delivery record. */
export type OrderAddressResponse = {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

/** The promotion that discounted this order, or `null`. Never its internal id or its terms. */
export type OrderPromotionResponse = {
  code: string;
  name: string;
};

/**
 * An order.
 *
 * `id`, `userId`, `storeId`, `cartId`, `addressId`, `promotionId`, `createdAt` and `updatedAt`
 * are all absent. Ownership and tenancy are invariants of the query rather than fields to
 * inspect; the order is addressed by `orderNumber`; and `placedAt` is the one timestamp that is
 * a business fact rather than row bookkeeping.
 *
 * `total` means the payable GOODS total after the cart-level merchandise discount and **before
 * any future tax**. When GST arrives it adds `taxTotal` and `grandTotal` alongside; it must not
 * redefine `total`. Increment 29 had to redefine `cartTotal` once, and that is precisely why
 * this meaning is pinned here, in the schema, and in `docs/DECISIONS.md`.
 */
export type OrderResponse = {
  orderNumber: string;
  status: string;
  currency: string;
  /** Σ `lineTotal` — pre-discount merchandise. */
  subtotal: string;
  /** Σ `discountAmount` across the lines. Exactly, by construction. */
  discountTotal: string;
  /** `subtotal - discountTotal`. The GOODS total, permanently. */
  total: string;
  /** Σ line tax. Zero when no determination was made. */
  taxTotal: string;
  /** `total + taxTotal` — **the payable amount, and what a payment charges**. */
  grandTotal: string;
  /** The determination, or null when this order was never assessed for tax. */
  tax: OrderTaxResponse | null;
  placedAt: string;
  promotion: OrderPromotionResponse | null;
  shippingAddress: OrderAddressResponse;
  items: OrderItemResponse[];
};

/**
 * One line, with its tax block built explicitly rather than by spreading the record.
 *
 * The all-or-nothing test mirrors `ck_order_line_tax_classification`, so a line that was never
 * assessed reports `tax: null` rather than a block of zeros that reads as "assessed at nil".
 * Built by an explicit mapper for the same reason `toCustomerShipmentResponse` is: a column
 * added to `order_line` later must not reach a customer response by default.
 */
export function toOrderItemResponse(line: OrderLineRecord): OrderItemResponse {
  const classified =
    line.hsnCode !== null && line.taxClassCode !== null && line.taxClassName !== null;

  return {
    skuCode: line.skuCode,
    skuName: line.skuName,
    productName: line.productName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    discountAmount: line.discountAmount,
    tax: classified
      ? {
          taxableValue: line.taxableValue,
          hsnCode: line.hsnCode,
          taxClassCode: line.taxClassCode,
          taxClassName: line.taxClassName,
          cgstRate: line.cgstRate,
          cgstAmount: line.cgstAmount,
          sgstRate: line.sgstRate,
          sgstAmount: line.sgstAmount,
          igstRate: line.igstRate,
          igstAmount: line.igstAmount,
          cessRate: line.cessRate,
          cessAmount: line.cessAmount,
          taxTotal: line.taxTotal,
        }
      : null,
  };
}

export function toOrderResponse(view: OrderView): OrderResponse {
  const { order, lines } = view;

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    subtotal: order.subtotal,
    discountTotal: order.discountTotal,
    total: order.total,
    taxTotal: order.taxTotal,
    grandTotal: order.grandTotal,
    /*
     * All-or-nothing, matching `ck_order_tax_snapshot`. Every field is tested rather than
     * just `taxAt`, because that is what convinces TypeScript the object below has no nulls —
     * asserting the constraint would trade a compile-time guarantee for a runtime one.
     */
    tax:
      order.taxAt === null ||
      order.supplyType === null ||
      order.placeOfSupplyState === null ||
      order.sellerGstin === null ||
      order.sellerLegalName === null ||
      order.customerTaxCategory === null
        ? null
        : {
            supplyType: order.supplyType,
            placeOfSupply: order.placeOfSupplyState,
            sellerGstin: order.sellerGstin,
            sellerLegalName: order.sellerLegalName,
            customerTaxCategory: order.customerTaxCategory,
            customerGstin: order.customerGstin,
            taxedAt: order.taxAt.toISOString(),
          },
    placedAt: order.placedAt.toISOString(),
    /**
     * All-or-nothing, matching `ck_order_promotion_snapshot`. Reading the code without the name
     * would publish half a snapshot.
     */
    promotion:
      order.promotionCode === null || order.promotionName === null
        ? null
        : { code: order.promotionCode, name: order.promotionName },
    shippingAddress: {
      recipientName: order.shipRecipientName,
      phone: order.shipPhone,
      line1: order.shipLine1,
      line2: order.shipLine2,
      landmark: order.shipLandmark,
      city: order.shipCity,
      state: order.shipState,
      postalCode: order.shipPostalCode,
      countryCode: order.shipCountryCode,
    },
    items: lines.map(toOrderItemResponse),
  };
}

export function toOrderListResponse(page: {
  items: readonly OrderView[];
  total: number;
  limit: number;
  offset: number;
}): { orders: OrderResponse[]; pagination: PaginationResponse } {
  return {
    orders: page.items.map(toOrderResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

/* ── GET /admin/orders ───────────────────────────────────────────────────── */

/**
 * Page size for the admin order list. Larger than the customer's, because an operator paging
 * through a store's orders is a different activity from a customer reviewing their own six.
 */
export const ADMIN_ORDER_LIST_DEFAULT_LIMIT = 25;
export const ADMIN_ORDER_LIST_MAX_LIMIT = 100;

/**
 * The payment and shipment vocabularies, restated here.
 *
 * **Restated, not imported.** `no-cross-module-imports` forbids `modules/orders` from importing
 * `modules/payments` or `modules/fulfilment`, and these are query-parameter validation rather
 * than domain logic — the point is that `?paymentStatus=suceeded` is a `400` naming the field
 * instead of a silently empty page that reads as "no such orders".
 *
 * The duplication is real and is bounded: if either module's vocabulary grows, a valid status
 * rejected here is a `400` a test will catch, not a wrong answer. `admin-orders.integration.test`
 * drives one order into each state through the real services and asserts each value filters it
 * back, so a rename upstream fails loudly here.
 */
const ADMIN_FILTER_PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired'] as const;
const ADMIN_FILTER_SHIPMENT_STATUSES = ['pending', 'shipped', 'delivered'] as const;

/**
 * An ISO-8601 instant with an offset, matching the promotions and tax modules' `instantField`.
 *
 * **The client owns the timezone.** A bare `YYYY-MM-DD` was the alternative and was rejected: the
 * server would have had to pick a timezone to widen it into, and every choice is wrong somewhere
 * — UTC misfiles the edges of an Indian trading day, the store's timezone surprises an operator
 * working from another one, and neither is visible in the request. An explicit instant makes the
 * decision the caller's, where the calendar the operator is looking at actually lives.
 */
const instantField = z.iso.datetime({ offset: true });

/**
 * The admin list's query string. `strictObject`, so an unknown parameter is a `400` naming it
 * rather than a filter silently ignored — the failure mode where an operator trusts a page that
 * was never narrowed.
 *
 * **`storeId` is not here and never will be.** Tenancy comes from the verified staff token; a
 * store parameter on an admin list is a cross-tenant read waiting to be discovered.
 */
export const AdminListOrdersQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: ADMIN_ORDER_LIST_MAX_LIMIT,
    default: ADMIN_ORDER_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),

  /** The dashboard's tabs. Composed per §49 and filtered in the database, never in JavaScript. */
  displayStatus: z.enum(ORDER_DISPLAY_STATUSES).optional(),

  paymentStatus: z.enum(ADMIN_FILTER_PAYMENT_STATUSES).optional(),
  shipmentStatus: z.enum(ADMIN_FILTER_SHIPMENT_STATUSES).optional(),

  placedFrom: instantField.optional(),
  placedTo: instantField.optional(),

  /**
   * The operator's search box: an order number or a customer email, case-insensitive substring.
   *
   * Trimmed and bounded. Deliberately NOT a search across names or addresses — a wider search is
   * a wider disclosure, and these two are what an operator already has from the customer.
   */
  q: z.string().trim().min(1).max(320).optional(),
});

export type AdminListOrdersQuery = z.infer<typeof AdminListOrdersQuerySchema>;

/**
 * The customer, as an operator sees them on an order.
 *
 * `passwordHash`, `isStaff` and `isSuperuser` are absent here, absent from the repository
 * projection that feeds this, and absent from the record type in between — three layers, so
 * adding one back takes three deliberate edits rather than one forgotten `...spread`.
 */
export type AdminOrderCustomerResponse = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

/** The payment's state, or `null` when the order has none. Never an amount, never a provider. */
export type AdminOrderPaymentResponse = {
  status: string;
  method: string;
};

/** The shipment's state, or `null` when none exists. */
export type AdminOrderShipmentResponse = {
  status: string;
};

/**
 * One row of the admin order list.
 *
 * **Not `OrderResponse`.** A list row carries no items and no shipping address: a page of 100
 * orders would otherwise ship a hundred delivery addresses to render a table that shows none of
 * them, and the detail endpoint is one click away. Money, status and identity only.
 *
 * `itemCount` is absent too, and deliberately: counting lines per order means a second query or
 * a GROUP BY that complicates the count half of the page, and §49's scope is the statuses. The
 * detail response carries the items.
 */
export type AdminOrderSummaryResponse = {
  orderNumber: string;
  /** §49 — composed on read from the three lifecycles, stored nowhere. */
  displayStatus: OrderDisplayStatus;
  /** The underlying `order.status`, unchanged: `placed` or `cancelled`. */
  status: string;
  currency: string;
  total: string;
  taxTotal: string;
  grandTotal: string;
  placedAt: string;
  customer: AdminOrderCustomerResponse;
  payment: AdminOrderPaymentResponse | null;
  shipment: AdminOrderShipmentResponse | null;
};

/**
 * The admin order detail: **the customer's own order response, plus who and where it stands.**
 *
 * Built by spreading `toOrderResponse` rather than by restating its fields, so the money, the
 * tax snapshot, the promotion and the line items cannot drift between the two audiences. What
 * admin adds is exactly the four keys below.
 */
export type AdminOrderDetailResponse = OrderResponse & {
  displayStatus: OrderDisplayStatus;
  customer: AdminOrderCustomerResponse;
  payment: AdminOrderPaymentResponse | null;
  shipment: AdminOrderShipmentResponse | null;
};

/** The customer block, from the allowlisted columns the repository selected. */
function toAdminOrderCustomer(record: AdminOrderRecord): AdminOrderCustomerResponse {
  return {
    id: record.customerId,
    email: record.customerEmail,
    firstName: record.customerFirstName,
    lastName: record.customerLastName,
  };
}

/**
 * The payment block. All-or-nothing: `status` and `method` are `NULL` together, because they come
 * from the same `LEFT JOIN`ed row. Testing both is what convinces TypeScript the object has no
 * nulls, rather than asserting it.
 */
function toAdminOrderPayment(record: AdminOrderRecord): AdminOrderPaymentResponse | null {
  return record.paymentStatus === null || record.paymentMethod === null
    ? null
    : { status: record.paymentStatus, method: record.paymentMethod };
}

function toAdminOrderShipment(record: AdminOrderRecord): AdminOrderShipmentResponse | null {
  return record.shipmentStatus === null ? null : { status: record.shipmentStatus };
}

/**
 * The display status for one record.
 *
 * Computed here, from the same three fields for both the list row and the detail, so one order
 * cannot report two different statuses depending on which endpoint asked.
 */
function displayStatusOf(record: AdminOrderRecord): OrderDisplayStatus {
  return deriveOrderDisplayStatus({
    orderStatus: record.status,
    payment: toAdminOrderPayment(record),
    shipmentStatus: record.shipmentStatus,
  });
}

export function toAdminOrderSummaryResponse(record: AdminOrderRecord): AdminOrderSummaryResponse {
  return {
    orderNumber: record.orderNumber,
    displayStatus: displayStatusOf(record),
    status: record.status,
    currency: record.currency,
    total: record.total,
    taxTotal: record.taxTotal,
    grandTotal: record.grandTotal,
    placedAt: record.placedAt.toISOString(),
    customer: toAdminOrderCustomer(record),
    payment: toAdminOrderPayment(record),
    shipment: toAdminOrderShipment(record),
  };
}

export function toAdminOrderDetailResponse(view: AdminOrderView): AdminOrderDetailResponse {
  return {
    ...toOrderResponse({ order: view.order, lines: view.lines }),
    displayStatus: displayStatusOf(view.order),
    customer: toAdminOrderCustomer(view.order),
    payment: toAdminOrderPayment(view.order),
    shipment: toAdminOrderShipment(view.order),
  };
}

export function toAdminOrderListResponse(page: {
  items: readonly AdminOrderRecord[];
  total: number;
  limit: number;
  offset: number;
}): { orders: AdminOrderSummaryResponse[]; pagination: PaginationResponse } {
  return {
    orders: page.items.map(toAdminOrderSummaryResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}
