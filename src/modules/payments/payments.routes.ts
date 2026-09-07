import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import {
  InitiatePaymentRequestSchema,
  ListPaymentsQuerySchema,
  OrderNumberParamsSchema,
  toPaymentListResponse,
  toHandoffResponse,
  toPaymentResponse,
  type InitiatePaymentRequest,
  type ListPaymentsQuery,
  type OrderNumberParams,
} from './dto.js';
import type { PaymentsService } from './payments.service.js';

/**
 * The payments module's customer HTTP surface: three customer routes.
 *
 * **No admin or staff surface.** The approved scope names the customer read and initiation
 * endpoints as the minimum and excludes admin payment management outright. An operator payment
 * list would also need its own visibility rules — which payments a support agent may see, and
 * whether a provider reference is among them — and those are not decided.
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
  logger: Logger;
  // Annotated rather than inferred, matching every other routes file: without it `tsc` cannot
  // name the router type portably under pnpm's nested `node_modules`.
}): Router {
  const { payments, requireIdempotency, logger } = deps;

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

  return router;
}
