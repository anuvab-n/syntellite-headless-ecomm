import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import {
  AdminListPaymentsQuerySchema,
  CreateRefundRequestSchema,
  InitiatePaymentRequestSchema,
  ListPaymentsQuerySchema,
  OrderNumberParamsSchema,
  RefundNumberParamsSchema,
  toAdminPaymentDetailResponse,
  toAdminPaymentListResponse,
  toPaymentListResponse,
  toHandoffResponse,
  toPaymentResponse,
  toRefundResponse,
  type AdminListPaymentsQuery,
  type CreateRefundRequest,
  type InitiatePaymentRequest,
  type ListPaymentsQuery,
  type OrderNumberParams,
  type RefundNumberParams,
} from './dto.js';
import type { AdminPaymentFilters } from './payments.repository.js';
import type { PaymentsService } from './payments.service.js';
import type { RefundsService } from './refunds.service.js';

/**
 * The payments module's HTTP surface: three customer routes and two staff routes.
 *
 * **The staff surface is two routes, and both are READS** — `GET /admin/payments` (Increment 51)
 * and `GET /admin/orders/{orderNumber}/payment` (Increment 55). A support agent may see every
 * payment in their OWN store and none from another.
 *
 * The provider's identifiers appear on the DETAIL only, never on the list and never on any
 * customer surface. `providerRef` is the provider's ORDER handle and `providerTransactionId` is
 * its CHARGE id — the one a merchant looks up in the gateway's dashboard. Neither is a
 * credential, and the secret each pairs with never leaves the adapter's closure.
 *
 * **Still deliberately absent:** refunds, reconciliation, the payment transition timeline, and
 * any staff mutation at all. Staff may see that a payment exists and what state it reached;
 * changing one is not part of this increment and would need its own decisions about money.
 *
 * ## The middleware chain
 *
 *   resolveStore (API router) -> requireAuth -> requireIdempotency -> validate -> handler
 *
 * `requireIdempotency` sits AFTER `requireAuth` for the reason `orders.routes.ts` documents: a
 * key is scoped to (store, USER, key, endpoint) and the user comes from the verified token.
 * Without that ordering one customer's key could arbitrate another's request.
 *
 * This file is an HTTP ADAPTER and is one of two files in the module permitted to import
 * `http/` — `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createPaymentsRoutes(deps: {
  payments: PaymentsService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  /**
   * The idempotency guard, pre-built by the composition root against the shared store.
   *
   * Passed in rather than constructed here because the store is cross-cutting infrastructure
   * this module must not reach for — the same reason it arrives pre-built in `orders.routes.ts`.
   */
  requireIdempotency: RequestHandler;
  /**
   * The `staff` scope guard, pre-built by the composition root — the same instance the
   * catalogue, inventory, orders and promotions routers use.
   *
   * Passed in for the reason `requireIdempotency` is: the privilege check belongs to identity,
   * and this file only declares which privilege a route requires. Added in Increment 51 for
   * `GET /admin/payments`, the module's first staff route.
   *
   * **Optional, and when it is absent the admin route is NOT MOUNTED.** Several existing suites
   * mount this router directly to assert customer handler behaviour and have no scope loader.
   * The route disappearing is a safe default in a way that "mount it without the guard" could
   * never be — an unguarded store-wide payment list is a data breach, not a missing feature.
   * `container.integration.test.ts` is what proves the composition root always supplies it.
   */
  requireStaff?: RequestHandler;
  /**
   * The refunds service. Increment 59.
   *
   * Optional and paired with `requireStaff`: every refund route is staff-only, so a harness
   * that mounts this router without a scope loader gets neither the guard nor the routes. An
   * unguarded refund endpoint is not a missing feature, it is a way to give away money.
   */
  refunds?: RefundsService;
  logger: Logger;
  // Annotated rather than inferred, matching every other routes file: without it `tsc` cannot
  // name the router type portably under pnpm's nested `node_modules`.
}): Router {
  const { payments, requireIdempotency, requireStaff, refunds, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({
    verifyAccessToken: deps.verifyAccessToken,
    logger,
  });

  /** The owner and the tenant — neither of them from the request. */
  const scope = (req: Request): { userId: string; storeId: string } => {
    const user = requireUser(req);
    return { userId: user.id, storeId: user.storeId };
  };

  /**
   * The customer initiating the payment, for the audit trail and the first history row.
   *
   * From the VERIFIED token. An actor a client could supply is a trail a client could forge,
   * which is worse than no trail because it is trusted.
   */
  const customerActor = (req: Request): AuditActor => ({
    type: 'customer',
    userId: requireUser(req).id,
  });

  /**
   * The staff member raising a refund, for the audit trail and `refund.initiated_by`.
   *
   * From the VERIFIED token. `initiated_by` is NOT NULL and carries a composite FK to
   * `app_user`, so a forged or absent id fails the insert rather than writing an
   * unattributable refund — which for a money-moving row is the only acceptable behaviour.
   */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * The idempotency claim this request already holds.
   *
   * Recomputed from the same inputs the middleware used, so the service completes exactly the
   * row the middleware claimed. `endpoint` must match the middleware's
   * `endpointOf(method, baseUrl + path)` character for character — a mismatch would complete
   * nothing and leave the key in flight until it expired.
   */
  const claimOf = (req: Request): { key: string; endpoint: string } => ({
    key: (req.get('idempotency-key') ?? '').trim(),
    endpoint: `${req.method.toUpperCase()} ${req.baseUrl + req.path}`,
  });

  /**
   * POST /users/me/orders/:orderNumber/payments
   *
   * 201 with the payment, and — for `online` — the provider handoff the client needs.
   * **The whole request body is `{ method }`.**
   *
   * `Idempotency-Key` is REQUIRED. A client that never sees the response cannot know whether a
   * payment was created; without a key its only sane move is to retry, and for an `online`
   * method that retry would create a second provider-side order. The approved scope requires it.
   *
   * Everything else is server-authoritative. The order is found from the verified token and the
   * resolved store, the amount is copied from the persisted `order.total`, and the currency is
   * the order's. The client cannot influence any of them.
   *
   * Failure modes: `400` for a malformed body, an unknown field, an invalid method, a malformed
   * order number, or a missing/short `Idempotency-Key`; `404` for an order that is unknown,
   * another customer's or another store's — all indistinguishable; `409` when the order already
   * has a payment, when a concurrent initiation won the race, and for an in-flight key; `422`
   * for an order that is not payable and for a key reused with a different body; `503` when the
   * store has no usable provider configuration and `online` was asked for.
   */
  router.post(
    '/users/me/orders/:orderNumber/payments',
    auth,
    requireIdempotency,
    validate({ params: OrderNumberParamsSchema, body: InitiatePaymentRequestSchema }),
    asyncHandler(async (req, res) => {
      const { orderNumber } = validatedParams<OrderNumberParams>(req);
      const { userId, storeId } = scope(req);

      const { view, handoff } = await payments.initiate({
        orderNumber,
        userId,
        storeId,
        method: validatedBody<InitiatePaymentRequest>(req).method,
        actor: customerActor(req),
        idempotency: claimOf(req),
        /*
         * The replay body, serialised by the same function the live response uses. Passing the
         * renderer rather than a rendered object keeps the two from drifting: a replayed 201
         * and a fresh one are the same bytes by construction.
         */
        renderResponse: (created, createdHandoff) => ({
          payment: toPaymentResponse(created, orderNumber),
          ...(createdHandoff === null ? {} : { handoff: toHandoffResponse(createdHandoff) }),
        }),
      });

      res.status(201).json({
        payment: toPaymentResponse(view, orderNumber),
        ...(handoff === null ? {} : { handoff: toHandoffResponse(handoff) }),
      });
    }),
  );

  /**
   * GET /users/me/payments
   *
   * 200 with a page of this customer's payments, newest first.
   *
   * Mounted BEFORE the two `/users/me/orders/...` routes below only incidentally — the paths do
   * not overlap. `limit` defaults to 20 and is capped at 100, matching the order list, and each
   * row carries its `orderNumber` so a client can drill in without a second lookup.
   *
   * `history` is empty on a list row; the single-payment read is where the timeline lives.
   */
  router.get(
    '/users/me/payments',
    auth,
    validate({ query: ListPaymentsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = validatedQuery<ListPaymentsQuery>(req);
      const { userId, storeId } = scope(req);

      const page = await payments.listForUser({ userId, storeId, limit, offset });
      res.status(200).json(toPaymentListResponse(page));
    }),
  );

  /**
   * GET /users/me/orders/:orderNumber/payment
   *
   * 200 with the payment and its full transition history.
   *
   * Singular `payment` in the path against plural `payments` for the initiation, and that is
   * deliberate rather than sloppy: one payment per order is the approved model, so a customer
   * reads *the* payment while the write creates *a* payment. `404` when the order is unknown,
   * not theirs, or has no payment yet — a customer who has not paid and a customer looking at
   * somebody else's order get the same answer.
   */
  router.get(
    '/users/me/orders/:orderNumber/payment',
    auth,
    validate({ params: OrderNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const { orderNumber } = validatedParams<OrderNumberParams>(req);
      const { userId, storeId } = scope(req);

      const view = await payments.getForOrder({ orderNumber, userId, storeId });
      res.status(200).json({ payment: toPaymentResponse(view, orderNumber) });
    }),
  );

  /**
   * `GET /admin/payments` — a page of the store's payments. Increment 51.
   *
   * The module's first staff route. The header of this file recorded that there was "no admin
   * or staff surface" and that the approved scope named only the customer read and initiation;
   * this adds the read, and only the read.
   *
   * **Read-only, and deliberately narrow.** There is no payment detail route, no refund, no
   * reconciliation and no mutation of any kind. Staff may see that a payment exists and what
   * state it reached; acting on it is not part of this increment.
   *
   * Store-scoped from the verified staff token. There is no `storeId` parameter, and the query
   * schema is strict, so supplying one is a `400` rather than something to be ignored.
   *
   * `providerRef` is NOT in the response. It is the handle used to act on the provider side and
   * is handed to the paying customer for the checkout handoff alone — a staff list is a read,
   * and a read does not need a capability.
   *
   * Failure modes: `400` for an unknown query parameter, a malformed instant, a status/method/
   * provider outside the real vocabulary, a malformed order number, or an out-of-range `limit`;
   * `401` unauthenticated; `403` without the `staff` scope.
   */
  if (requireStaff) {
    router.get(
      '/admin/payments',
      auth,
      requireStaff,
      validate({ query: AdminListPaymentsQuerySchema }),
      asyncHandler(async (req, res) => {
        const query = validatedQuery<AdminListPaymentsQuery>(req);

        const page = await payments.listForStore({
          storeId: requireUser(req).storeId,
          limit: query.limit,
          offset: query.offset,
          filters: adminPaymentFilters(query),
        });

        res.status(200).json(toAdminPaymentListResponse(page));
      }),
    );

    /**
     * `GET /admin/orders/{orderNumber}/payment` — one payment, for staff. Increment 55.
     *
     * The read the list could not give: the list pages and filters, but nothing could answer
     * "show me THIS order's payment", and the provider's charge id had nowhere to be published.
     *
     * ### Addressed by order number, not by `payment.id`
     *
     * The payment's own id is published nowhere in this system — the staff list omits it by
     * design, because a payment is addressed by the order it pays for. A `/admin/payments/{id}`
     * route would therefore be unreachable by any client that had not first been given an id no
     * endpoint returns. `uq_payment_order` makes the order number an exact address.
     *
     * The path mirrors the customer's `GET /users/me/orders/{orderNumber}/payment` above and
     * fulfilment's `GET /admin/orders/{orderNumber}/shipments`. It does not collide with the
     * orders router's `/admin/orders/{orderNumber}`, mounted earlier: that route matches a
     * SINGLE trailing segment, and this path has two.
     *
     * Three fields more than the list row — `provider`, `providerRef` and
     * `providerTransactionId` — and no history: the transition timeline is a separate surface
     * that was not part of this increment.
     *
     * Failure modes: `400` for a malformed order number; `401` unauthenticated; `403` without
     * the `staff` scope; `404` for an unknown order, another store's order, and an order with
     * no payment alike — the query returns nothing for all three, so they cannot be told apart.
     */
    router.get(
      '/admin/orders/:orderNumber/payment',
      auth,
      requireStaff,
      validate({ params: OrderNumberParamsSchema }),
      asyncHandler(async (req, res) => {
        const { orderNumber } = validatedParams<OrderNumberParams>(req);

        const storeId = requireUser(req).storeId;
        const record = await payments.getStorePaymentForOrder({ orderNumber, storeId });

        const detail = toAdminPaymentDetailResponse(record);

        /*
         * Refund visibility, Increment 59. Composed onto the shipped contract rather than
         * folded into it: every field `AdminPaymentDetailResponse` already published is
         * unchanged, so a client parsing this response before the refund work still parses it.
         */
        if (refunds === undefined) {
          res.status(200).json({ payment: detail });
          return;
        }

        const [rows, balance] = await Promise.all([
          refunds.listForPayment({ paymentId: record.id, storeId }),
          refunds.balanceForOrder({ orderNumber, storeId }),
        ]);

        res.status(200).json({
          payment: { ...detail, refunds: rows.map(toRefundResponse), refundBalance: balance },
        });
      }),
    );
  }

  /* ── Refunds. Increment 59. Staff only, and mounted only when the guard exists. ────── */

  if (requireStaff !== undefined && refunds !== undefined) {
    /**
     * `POST /admin/orders/{orderNumber}/refund`
     *
     * 201 with the refund and the payment's new refund position.
     *
     * Addressed by ORDER NUMBER, not by a payment id: `uq_payment_order` makes the two
     * equivalent, and the order number is the identifier staff already have in front of them.
     * The payment's internal UUID is published nowhere in this API and does not start here.
     *
     * **This is not a generic "refund any payment" endpoint.** The refund is bound to the
     * payment behind the named order, its amount is checked against that payment's remaining
     * refundable balance under a row lock, and the currency is copied from the payment rather
     * than accepted from the caller.
     *
     * **Partial refunds** are expressed by sending less than the remaining balance; there is no
     * flag, because the amount already says everything a flag would. Cumulative refunds are
     * capped at the captured amount, and an attempt that is still `processing` holds its share
     * of the balance so nobody refunds around an unresolved provider call.
     *
     * `Idempotency-Key` is REQUIRED. A client that never sees the response cannot know whether
     * money moved, and its only sane move is to retry — which without a key would refund twice.
     *
     * A COD payment, or an online one whose provider charge id was never captured, produces a
     * `manual` refund: a recorded obligation, settled offline and marked with
     * `POST /admin/refunds/{refundNumber}/settle`. No gateway is called and none is faked.
     *
     * Failure modes: `400` for a malformed amount, an unknown field or a missing key; `401`;
     * `403` without the `staff` scope; `404` for an unknown order or another store's; `422`
     * for a payment that never succeeded, a non-positive amount, or an amount exceeding the
     * remaining balance — `details.remaining` says what is left; `503` when the payment was
     * taken online and this deployment has no provider configured.
     */
    router.post(
      '/admin/orders/:orderNumber/refund',
      auth,
      requireStaff,
      requireIdempotency,
      validate({ params: OrderNumberParamsSchema, body: CreateRefundRequestSchema }),
      asyncHandler(async (req, res) => {
        const { orderNumber } = validatedParams<OrderNumberParams>(req);
        const body = validatedBody<CreateRefundRequest>(req);

        const result = await refunds.refundForOrder({
          orderNumber,
          storeId: requireUser(req).storeId,
          amount: body.amount,
          actor: staffActor(req),
          requestKey: (req.get('idempotency-key') ?? '').trim(),
        });

        res.status(201).json({
          refund: toRefundResponse(result.refund),
          refundBalance: result.balance,
        });
      }),
    );

    /**
     * `POST /admin/refunds/{refundNumber}/settle`
     *
     * 200 with the settled refund. **Manual refunds only.**
     *
     * The minimum this backend can honestly say about money it did not move: a named staff
     * member asserts the offline disbursement happened, and the assertion is attributed and
     * timestamped. No bank, UPI or payout integration is implied — there is none in this system,
     * and inventing one would be inventing a business process nobody specified.
     *
     * A `provider` refund is a `409`. Its outcome is the gateway's to report, and letting
     * staff declare one succeeded would make the `processing` state — the entire point of the
     * three-way provider outcome — pointless.
     *
     * Failure modes: `400` for a malformed refund number; `404` for an unknown refund or
     * another store's; `409` for a provider refund or one that is not `pending`.
     */
    router.post(
      '/admin/refunds/:refundNumber/settle',
      auth,
      requireStaff,
      validate({ params: RefundNumberParamsSchema }),
      asyncHandler(async (req, res) => {
        const { refundNumber } = validatedParams<RefundNumberParams>(req);

        const settled = await refunds.settleManualRefund({
          refundNumber,
          storeId: requireUser(req).storeId,
          actor: staffActor(req),
        });

        res.status(200).json({ refund: toRefundResponse(settled) });
      }),
    );
  }

  return router;
}

/**
 * The validated query, as the repository's filter shape.
 *
 * Instants are parsed here rather than in the schema so the DTO stays a description of the WIRE
 * — strings in, strings out — and the `Date` conversion happens once, at the adapter boundary
 * where every other parse in this file happens.
 *
 * Built key by key with `exactOptionalPropertyTypes` in mind: an absent filter must be an absent
 * KEY, not a key holding `undefined`, or the repository would build a predicate against it.
 */
function adminPaymentFilters(query: AdminListPaymentsQuery): AdminPaymentFilters {
  return {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.method === undefined ? {} : { method: query.method }),
    ...(query.provider === undefined ? {} : { provider: query.provider }),
    ...(query.orderNumber === undefined ? {} : { orderNumber: query.orderNumber }),
    ...(query.transactionId === undefined ? {} : { transactionId: query.transactionId }),
    ...(query.createdFrom === undefined ? {} : { createdFrom: new Date(query.createdFrom) }),
    ...(query.createdTo === undefined ? {} : { createdTo: new Date(query.createdTo) }),
  };
}
