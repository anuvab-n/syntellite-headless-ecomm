import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import { PAYMENT_METHODS, PAYMENT_PROVIDERS, PAYMENT_STATUSES } from './payments.repository.js';
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

/* ── GET /admin/payments ─────────────────────────────────────────────────── */

/** Page size for the staff payment list. Larger than the customer's, for the same reason. */
export const ADMIN_PAYMENT_LIST_DEFAULT_LIMIT = 25;
export const ADMIN_PAYMENT_LIST_MAX_LIMIT = 100;

/**
 * An ISO-8601 instant WITH an offset, matching the promotions and tax modules' `instantField`
 * and the admin order list.
 *
 * **The client owns the timezone, deliberately.** A bare `YYYY-MM-DD` would force the server to
 * choose one to widen it into, and every choice is wrong somewhere — UTC misfiles the edges of
 * an Indian trading day, the store's timezone surprises an operator working from another one,
 * and neither is visible in the request.
 *
 * Both bounds are INCLUSIVE. Stated here, on the endpoint, and asserted by a test that places a
 * payment exactly on each boundary — a half-open range that silently dropped the last day would
 * otherwise look like missing data rather than like a contract.
 */
const instantField = z.iso.datetime({ offset: true });

/**
 * The staff payment list's query string.
 *
 * `strictObject`, so an unknown parameter is a `400` naming it rather than a filter silently
 * ignored — the failure mode where an operator trusts a page that was never narrowed.
 *
 * **`storeId` is not here and never will be.** Tenancy comes from the verified staff token; a
 * store parameter on an admin list is a cross-tenant read waiting to be discovered, and because
 * this object is strict, sending one is a `400` rather than an ignored key.
 *
 * The status, method and provider vocabularies are the REAL ones, re-exported by the repository
 * from the schema — not restatements. A value the database cannot hold is rejected here rather
 * than returning a confusingly empty page.
 */
export const AdminListPaymentsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: ADMIN_PAYMENT_LIST_MAX_LIMIT,
    default: ADMIN_PAYMENT_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),

  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional(),

  /**
   * An EXACT order number, not a search.
   *
   * The same pattern the orders module validates, so a malformed number is a `400` rather than a
   * query that can only ever miss. `uq_payment_order` means this selects at most one payment.
   */
  orderNumber: z
    .string()
    .trim()
    .max(64)
    .regex(/^ORD-\d{8}-[A-Z2-9]{6}$/, 'must be an order number of the form ORD-YYYYMMDD-XXXXXX')
    .optional(),

  /**
   * An EXACT provider charge id — Razorpay's `pay_…`. Increment 55.
   *
   * Validated as a charset and a length, NOT as a `pay_` prefix. `order_number` above is OUR
   * format, so a shape regex there asserts something this system guarantees; this value is the
   * provider's, and pinning its shape would turn a provider changing its own identifiers into a
   * `400` on a lookup that would otherwise have worked. The bound that matters is the column's:
   * `varchar(255)`.
   *
   * Exact, not a search. `uq_payment_provider_txn` makes it at most one row per store.
   */
  transactionId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/, 'must be a provider transaction id')
    .optional(),

  createdFrom: instantField.optional(),
  createdTo: instantField.optional(),
});

export type AdminListPaymentsQuery = z.infer<typeof AdminListPaymentsQuerySchema>;

/**
 * One row of the staff payment list.
 *
 * Built field by field from `PaymentRecord`, and the omissions are the contract:
 *
 *  - **`providerRef`** — the Razorpay order/payment id. It is the handle used to act on the
 *    provider side, so it is handed to the paying customer for the checkout handoff and to
 *    nobody else. An operator list is a read, and a read does not need a capability.
 *  - **`amountMinor`** — the integer mirror of `amount`, kept for the provider call. Publishing
 *    both invites a client to pick one, and money leaves this system as a decimal string.
 *  - **`id`, `userId`, `orderId`, `storeId`** — internal ids. A payment is addressed by its
 *    order number here; tenancy and ownership are invariants of the query, not fields.
 *
 * `failureCode` IS included: it is already on the customer-facing `PaymentResponse`, so it is
 * established as non-sensitive, and it is the reason a row reads as failed on an operator screen.
 */
export type AdminPaymentResponse = {
  orderNumber: string;
  status: string;
  method: string;
  /** `null` for COD — `ck_payment_provider_matches_method` guarantees the pairing. */
  provider: string | null;
  amount: string;
  currency: string;
  /** Set only on a failed payment; `ck_payment_failure_code` enforces that. */
  failureCode: string | null;
  createdAt: string;
  /** The last transition's instant — when a payment succeeded, failed or expired. */
  updatedAt: string;
};

export type AdminPaymentListResponse = {
  payments: AdminPaymentResponse[];
  pagination: PaginationResponse;
};

export function toAdminPaymentResponse(
  record: PaymentRecord & { orderNumber: string },
): AdminPaymentResponse {
  return {
    orderNumber: record.orderNumber,
    status: record.status,
    method: record.method,
    provider: record.provider,
    amount: record.amount,
    currency: record.currency,
    failureCode: record.failureCode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toAdminPaymentListResponse(page: {
  items: readonly (PaymentRecord & { orderNumber: string })[];
  total: number;
  limit: number;
  offset: number;
}): AdminPaymentListResponse {
  return {
    payments: page.items.map(toAdminPaymentResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

/* ── GET /admin/orders/{orderNumber}/payment ─────────────────────────────── */

/**
 * One payment, for staff, with the provider's identifiers. Increment 55.
 *
 * **Extended, not modified.** `AdminPaymentResponse` above is the shipped list contract, shared
 * with `GET /admin/payments`; changing it would change that endpoint's published shape, so this
 * composes on top of it instead.
 *
 * Three fields more than the list row, and each names exactly one thing:
 *
 *  - `provider` — which gateway, already on the list row.
 *  - `providerRef` — the provider's ORDER (`order_…`), created at initiation. Null for COD.
 *  - `providerTransactionId` — the provider's CHARGE (`pay_…`), the id a merchant pastes into
 *    the gateway's dashboard. Null for COD, null until a payment succeeds, and null for every
 *    payment taken before the column existed.
 *
 * Deliberately absent, and each for a stated reason: `payment.id` (published nowhere; a payment
 * is addressed by its order number), `userId`, `orderId`, `storeId` (internal keys; tenancy is
 * an invariant of the query), `amountMinor` (money leaves as a decimal string), and
 * `providerEventId` (the webhook DELIVERY id — deduplication material, not a charge reference,
 * and it lives on the event row, not here).
 */
export type AdminPaymentDetailResponse = AdminPaymentResponse & {
  readonly providerRef: string | null;
  readonly providerTransactionId: string | null;
};

export function toAdminPaymentDetailResponse(
  record: PaymentRecord & { orderNumber: string },
): AdminPaymentDetailResponse {
  return {
    ...toAdminPaymentResponse(record),
    providerRef: record.providerRef,
    providerTransactionId: record.providerTransactionId,
  };
}
