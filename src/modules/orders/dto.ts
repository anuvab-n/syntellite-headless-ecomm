import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import type { OrderLineRecord } from './orders.repository.js';
import type { OrderView } from './orders.service.js';

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
