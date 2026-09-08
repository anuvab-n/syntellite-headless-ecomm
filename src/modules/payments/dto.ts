import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import { PAYMENT_METHODS } from './payments.repository.js';
import type { PaymentEventRecord, PaymentRecord } from './payments.repository.js';
import type { PaymentHandoff, PaymentView } from './payments.service.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

/**
 * The payments module's request and response contracts.
 *
 * ## What the request may contain
 *
 * One field: `method`. Nothing else, and `strictObject` makes that enforceable rather than
 * merely intended — an unknown key is a `400`, never silently dropped.
 *
 * **The amount is deliberately not in the schema.** It comes from `order.total`, which
 * `ck_order_total_identity` already constrains to `subtotal - discount_total`. A client that
 * sends `amount`, `total`, `currency`, `orderId`, `userId`, `storeId` or `status` is rejected,
 * and the orders suite's forged-field test is the model for the one that proves it here. A
 * schema that accepted an amount "for convenience" would be the whole vulnerability.
 *
 * ## What the response may contain
 *
 * `orderNumber`, not `orderId`: the order's UUID is internal, and the customer already
 * addresses their order by number everywhere else. No `userId`, no `storeId`, no internal
 * payment `id` on the customer surface — a customer needs to know the state of their payment,
 * not our primary keys.
 *
 * **No provider-specific key anywhere in these types.** `provider` is a string, `providerRef`
 * is a string, and neither is named after a gateway. A regression test asserts the response has
 * no Razorpay-shaped field, because the moment one appears the domain has leaked.
 */

/* ── Requests ────────────────────────────────────────────────────────────── */

/**
 * The order this payment is for.
 *
 * Same pattern as `OrderNumberParamsSchema`: validated against the generated shape rather than
 * accepted as free text, so a malformed number is a `400` at the boundary instead of a `404`
 * from a query that could never have matched.
 */
export const OrderNumberParamsSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .max(64)
    .regex(/^ORD-\d{8}-[A-Z2-9]{6}$/, 'must be a valid order number'),
});
export type OrderNumberParams = z.infer<typeof OrderNumberParamsSchema>;

/**
 * How the customer wants to pay.
 *
 * `online` or `cod` — the approved methods, read from the schema constant so the API and the
 * database CHECK cannot disagree. Required rather than defaulted: defaulting would make the
 * most consequential field in the request implicit, and a client that forgot it would silently
 * get whichever we happened to prefer.
 */
export const InitiatePaymentRequestSchema = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
});
export type InitiatePaymentRequest = z.infer<typeof InitiatePaymentRequestSchema>;

export const PAYMENT_LIST_DEFAULT_LIMIT = 20;
export const PAYMENT_LIST_MAX_LIMIT = 100;

export const ListPaymentsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: PAYMENT_LIST_MAX_LIMIT,
    default: PAYMENT_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

export type PaymentEventResponse = {
  fromStatus: string | null;
  toStatus: string;
  eventType: string;
  occurredAt: string;
};

export type PaymentResponse = {
  orderNumber: string;
  method: string;
  provider: string | null;
  status: string;
  currency: string;
  amount: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  history: PaymentEventResponse[];
};

/**
 * The provider handoff, present only when an `online` payment was just created.
 *
 * Three public values. `publicKey` is the provider's publishable key — designed to be sent to
 * a browser — and the secret it pairs with never leaves the adapter's closure. There is no
 * field here that could carry one.
 */
export type PaymentHandoffResponse = {
  provider: string;
  providerRef: string;
  publicKey: string | null;
};

function toEventResponse(record: PaymentEventRecord): PaymentEventResponse {
  return {
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    eventType: record.eventType,
    occurredAt: record.createdAt.toISOString(),
  };
}

/**
 * Every field listed explicitly.
 *
 * Not a spread of the record. A spread would publish whatever column a later increment adds —
 * `provider_ref` on the customer surface, or an instrument field if one were ever wrongly
 * introduced — and the leak would arrive with no diff to the response type to notice.
 */
export function toPaymentResponse(view: PaymentView, orderNumber: string): PaymentResponse {
  const record: PaymentRecord = view.payment;
  return {
    orderNumber,
    method: record.method,
    provider: record.provider,
    status: record.status,
    currency: record.currency,
    amount: record.amount,
    failureCode: record.failureCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    history: view.events.map(toEventResponse),
  };
}

export type PaymentListResponse = {
  payments: PaymentResponse[];
  pagination: PaginationResponse;
};

/**
 * A page of payments.
 *
 * Each row is the SAME `PaymentResponse` the single read returns, with `history` empty — one
 * response type rather than a leaner list variant, so a client can hand a list row to whatever
 * renders a payment without a second shape to handle. The order number comes from the join, so
 * a row is addressable without a second request.
 */
export function toPaymentListResponse(page: {
  items: readonly (PaymentRecord & { orderNumber: string })[];
  total: number;
  limit: number;
  offset: number;
}): PaymentListResponse {
  return {
    payments: page.items.map((record) =>
      toPaymentResponse({ payment: record, events: [] }, record.orderNumber),
    ),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

export function toHandoffResponse(handoff: PaymentHandoff): PaymentHandoffResponse {
  return {
    provider: handoff.provider,
    providerRef: handoff.providerRef,
    publicKey: handoff.publicKey,
  };
}
