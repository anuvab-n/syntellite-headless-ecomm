import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import {
  CreateReturnRequestSchema,
  StaffListReturnsQuerySchema,
  InspectReturnRequestSchema,
  StaffReturnDecisionSchema,
  toReturnRefundResponse,
  toStaffReturnDetailResponse,
  toStaffReturnListItemResponse,
  toStaffReturnResponse,
  ListReturnsQuerySchema,
  ReturnNumberParamsSchema,
  toReturnResponse,
  type CreateReturnRequest,
  type ListReturnsQuery,
  type ReturnNumberParams,
  type StaffListReturnsQuery,
  type InspectReturnRequest,
  type StaffReturnDecisionRequest,
} from './dto.js';
import type { ReturnsService } from './returns.service.js';

/**
 * Customer-facing return routes.
 *
 * Middleware order matches every other mutating customer route in this API:
 *
 * ```
 *   resolveStore (API router) -> requireAuth -> requireIdempotency -> validate -> handler
 * ```
 *
 * `requireIdempotency` sits AFTER `requireAuth` because the claim is scoped to the
 * authenticated user, and a key claimed before identity is known could be claimed across
 * customers.
 *
 * Nothing here reads a store or a user from the request body or a header — both come from the
 * verified token, which is why no DTO has a `storeId` or `userId` field to send.
 */
export function createReturnsRoutes(deps: {
  returns: ReturnsService;
  verifyAccessToken: AccessTokenVerifier;
  requireIdempotency: RequestHandler;
  /**
   * The `staff` scope guard, pre-built by the composition root.
   *
   * Passed in because the privilege check belongs to identity; this file only declares
   * which privilege a route requires.
   */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { returns, requireIdempotency, requireStaff, logger } = deps;

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

  const customerActor = (req: Request): AuditActor => ({
    type: 'customer',
    userId: requireUser(req).id,
  });

  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /** The tenant a staff member acts for. From the verified token, never the request. */
  const staffStore = (req: Request): string => requireUser(req).storeId;

  const claimOf = (req: Request): { key: string; endpoint: string } => ({
    key: (req.get('idempotency-key') ?? '').trim(),
    endpoint: `${req.method.toUpperCase()} ${req.baseUrl + req.path}`,
  });

  const returnNumberOf = (req: Request): string =>
    validatedParams<ReturnNumberParams>(req).returnNumber;

  /**
   * `POST /users/me/orders/{orderNumber}/returns`
   *
   * 201 with the created return.
   *
   * `Idempotency-Key` is REQUIRED. A client that never sees the response cannot know whether
   * the return was raised; without a key its only sane move is to retry, and that retry would
   * consume a second slice of the returnable quantity for goods the customer sent back once.
   *
   * The body is a reason, an optional note, and the lines. **Every amount is derived** from the
   * frozen order line inside the transaction — see `CreateReturnRequestSchema` for the full
   * list of fields a client cannot send and why.
   *
   * `404` when the order is unknown, another customer's, or another store's — all three are
   * deliberately indistinguishable. `422` when the order is not returnable (cancelled, not
   * delivered, window closed, unknown SKU) or the quantity is unavailable.
   */
  router.post(
    '/users/me/orders/:orderNumber/returns',
    auth,
    requireIdempotency,
    validate({ body: CreateReturnRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<CreateReturnRequest>(req);
      const view = await returns.createReturn({
        ...scope(req),
        orderNumber: String(req.params['orderNumber'] ?? ''),
        reason: body.reason,
        customerNote: body.customerNote ?? '',
        lines: body.lines,
        actor: customerActor(req),
        idempotency: claimOf(req),
        /**
         * Rendered by the SAME function the route uses, and handed to `idempotency.complete()`
         * inside the transaction. A replay must reproduce this response verbatim; rendering it
         * twice from two code paths is how a replay ends up differing from the original.
         */
        renderResponse: (created) => ({ return: toReturnResponse(created) }),
      });

      res.status(201).json({ return: toReturnResponse(view) });
    }),
  );

  /**
   * `GET /users/me/returns`
   *
   * 200 with a page of this customer's returns, newest first, each with its lines.
   *
   * Paginated with the project's established `limit`/`offset` contract: an over-limit page is
   * a `400` rather than being silently clamped, because a clamped page tells a client its size
   * was honoured when it was not.
   */
  router.get(
    '/users/me/returns',
    auth,
    validate({ query: ListReturnsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = validatedQuery<ListReturnsQuery>(req);
      const page = await returns.listReturns({ ...scope(req), limit, offset });

      res.status(200).json({
        returns: page.items.map(toReturnResponse),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    }),
  );

  /**
   * `GET /users/me/returns/{returnNumber}`
   *
   * 200 with one return the customer owns. `404` for anyone else's — the same answer a
   * nonexistent number gets, so the response cannot be used to discover which numbers exist.
   */
  router.get(
    '/users/me/returns/:returnNumber',
    auth,
    validate({ params: ReturnNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const view = await returns.getReturn({ ...scope(req), returnNumber: returnNumberOf(req) });

      res.status(200).json({ return: toReturnResponse(view) });
    }),
  );

  /**
   * `POST /users/me/returns/{returnNumber}/cancel`
   *
   * 200 with the cancelled return.
   *
   * Only from `approved` — the one cancellable state the approved rules name. A customer may
   * withdraw a return the merchant has agreed to but not yet received; once the goods are in
   * the merchant's hands the decision is theirs, not the customer's.
   *
   * A second cancellation is a `409`, deliberately NOT idempotent: a client that gets the same
   * answer twice cannot tell whether it cancelled something or nothing. This mirrors order
   * cancellation, which made the same choice for the same reason.
   */
  router.post(
    '/users/me/returns/:returnNumber/cancel',
    auth,
    validate({ params: ReturnNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const view = await returns.cancelReturn({
        ...scope(req),
        returnNumber: returnNumberOf(req),
        actor: customerActor(req),
      });

      res.status(200).json({ return: toReturnResponse(view) });
    }),
  );

  /* ── Staff ────────────────────────────────────────────────────────────── */

  /**
   * `GET /admin/returns`
   *
   * 200 with the store’s return queue, newest first, optionally filtered by status.
   *
   * Store-scoped and NOT owner-scoped: staff act for a tenant, so a colleague’s case is
   * theirs to see. The store comes from the verified token, so one tenant’s staff can never
   * reach another’s returns.
   */
  /**
   * `GET /admin/returns/summary` — return counts by status for the store. Increment 53.
   *
   * Queue depth, not a report: no money, no period, no filters. Every status in the vocabulary
   * appears, including the ones at zero, so the response shape does not change with the data.
   *
   * Registered BEFORE `/admin/returns/{returnNumber}` below, so the literal is matched before
   * the parameter is ever considered — the same ordering rule the orders module documents.
   *
   * Store-scoped from the verified staff token; no query object at all, so there is nothing for
   * a client to supply. `401` unauthenticated, `403` without the `staff` scope.
   */
  router.get(
    '/admin/returns/summary',
    auth,
    requireStaff,
    asyncHandler(async (req, res) => {
      const byStatus = await returns.summaryForStore({ storeId: scope(req).storeId });
      res.status(200).json({ returns: { byStatus } });
    }),
  );

  router.get(
    '/admin/returns',
    auth,
    requireStaff,
    validate({ query: StaffListReturnsQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = validatedQuery<StaffListReturnsQuery>(req);
      const page = await returns.listStoreReturns({
        storeId: staffStore(req),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.q === undefined ? {} : { q: query.q }),
        /*
         * Validated as an ISO string, widened to an instant HERE — the same place the orders
         * list does it, so the service and repository only ever see a `Date`.
         */
        ...(query.requestedFrom === undefined
          ? {}
          : { requestedFrom: new Date(query.requestedFrom) }),
        ...(query.requestedTo === undefined ? {} : { requestedTo: new Date(query.requestedTo) }),
        limit: query.limit,
        offset: query.offset,
      });

      res.status(200).json({
        returns: page.items.map(toStaffReturnListItemResponse),
        total: page.total,
        limit: page.limit,
        offset: page.offset,
      });
    }),
  );

  /**
   * `GET /admin/returns/{returnNumber}`
   *
   * 200 with one return in the store. `404` for another tenant’s — the same answer an
   * unknown number gets, so the response cannot be used to probe other stores.
   */
  router.get(
    '/admin/returns/:returnNumber',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const view = await returns.getStoreReturnDetail({
        storeId: staffStore(req),
        returnNumber: returnNumberOf(req),
      });

      res.status(200).json({ return: toStaffReturnDetailResponse(view) });
    }),
  );

  /**
   * `POST /admin/returns/{returnNumber}/approve`
   *
   * 200 with the approved return. **Only `requested -> approved`**; every other state is a
   * `409` naming both ends of the refused move.
   *
   * Approval agrees to the return exactly as it was raised. The body is an optional note and
   * nothing else — no quantity, no amount, no status — so approval can never silently edit
   * what the customer asked for or what they are owed. The frozen refund snapshot taken at
   * creation is left untouched.
   *
   * No `Idempotency-Key`. The status predicate on the update is the idempotency: a second
   * approval matches no row and answers `409`, which is the honest result — a client that
   * received `200` twice could not tell whether it approved something or nothing.
   */
  router.post(
    '/admin/returns/:returnNumber/approve',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema, body: StaffReturnDecisionSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<StaffReturnDecisionRequest>(req);
      const view = await returns.approveReturn({
        storeId: staffStore(req),
        returnNumber: returnNumberOf(req),
        actor: staffActor(req),
        ...(body.staffNote === undefined ? {} : { staffNote: body.staffNote }),
      });

      res.status(200).json({ return: toStaffReturnResponse(view) });
    }),
  );

  /**
   * `POST /admin/returns/{returnNumber}/reject`
   *
   * 200 with the rejected return. `requested -> rejected` today; `received -> rejected`
   * becomes reachable when 40e adds receipt.
   *
   * A rejected return refunds nothing and restocks nothing, and it **releases its quantity**
   * back to the returnable pool — nothing came back and no money moved, so the customer may
   * raise another return for the same units.
   */
  router.post(
    '/admin/returns/:returnNumber/reject',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema, body: StaffReturnDecisionSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<StaffReturnDecisionRequest>(req);
      const view = await returns.rejectReturn({
        storeId: staffStore(req),
        returnNumber: returnNumberOf(req),
        actor: staffActor(req),
        ...(body.staffNote === undefined ? {} : { staffNote: body.staffNote }),
      });

      res.status(200).json({ return: toStaffReturnResponse(view) });
    }),
  );

  /**
   * `POST /admin/returns/{returnNumber}/receive`
   *
   * 200 with the received return. **Only `approved -> received`**; every other state is a
   * `409` naming both ends of the refused move.
   *
   * The parcel is at the warehouse. Nothing about money or stock happens here — the units are
   * present but not yet judged, and restocking unexamined goods would put them back on sale
   * before anyone had looked at them. That judgement is the next endpoint.
   *
   * No `Idempotency-Key`, matching approve and reject: the status predicate on the update IS
   * the idempotency, so a second receipt matches no row and answers `409` — the honest result,
   * since a client that received `200` twice could not tell whether it moved anything.
   */
  router.post(
    '/admin/returns/:returnNumber/receive',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema, body: StaffReturnDecisionSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<StaffReturnDecisionRequest>(req);
      const view = await returns.receiveReturn({
        storeId: staffStore(req),
        returnNumber: returnNumberOf(req),
        actor: staffActor(req),
        ...(body.staffNote === undefined ? {} : { staffNote: body.staffNote }),
      });

      res.status(200).json({ return: toStaffReturnResponse(view) });
    }),
  );

  /**
   * `POST /admin/returns/{returnNumber}/inspect`
   *
   * 200 with the inspected return. **Only `received -> inspected`.**
   *
   * The body carries the good-to-sell / written-off split for **every** line, as counts. Neither
   * count changes what the customer is owed — a smashed jar is still a jar they sent back, and
   * the frozen refund snapshot taken at creation is never touched here. What they decide is how
   * many units go back into sellable stock at completion.
   *
   * Every line must be present and each line's two counts must sum exactly to the quantity that
   * came back. A partial inspection is a `422` rather than a defaulted zero, because completion
   * would otherwise restock a number nobody decided.
   *
   * **There is no rejection from here.** `received -> rejected` is the refusal edge, taken
   * INSTEAD of this one; reaching `inspected` already means accepted, which is what makes
   * `inspected -> completed` unconditional.
   *
   * Failure modes: `400` for an unknown field, a malformed SKU code or a negative count; `404`
   * for an unknown return or another store's; `409` from any state but `received`; `422` when
   * the counts do not account for what came back or a line is missing or named twice.
   */
  router.post(
    '/admin/returns/:returnNumber/inspect',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema, body: InspectReturnRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<InspectReturnRequest>(req);
      const view = await returns.inspectReturn({
        storeId: staffStore(req),
        returnNumber: returnNumberOf(req),
        actor: staffActor(req),
        lines: body.lines,
        ...(body.staffNote === undefined ? {} : { staffNote: body.staffNote }),
      });

      res.status(200).json({ return: toStaffReturnResponse(view) });
    }),
  );

  /**
   * `POST /admin/returns/{returnNumber}/complete`
   *
   * 200 with the completed return and the refund it raised. **Only `inspected -> completed`.**
   *
   * **This is not "set status = completed".** It is where money and stock actually move, in
   * this order:
   *
   *   1. raise a refund for the FROZEN `refundTotal` — never a figure recomputed from today's
   *      catalogue;
   *   2. stop unless it succeeded;
   *   3. restock the good-to-sell units decided at inspection;
   *   4. close the return.
   *
   * All in one transaction, so a failure at any step leaves the return exactly where it was.
   *
   * **A failed refund is a `422`, not a completion.** The return stays in `inspected` and may
   * be completed again once the cause is fixed. An UNRESOLVED refund is also a `422`, and
   * `details.refundStatus` says `processing` — that one must be reconciled against the provider
   * and must **not** be retried, because the money may already have moved.
   *
   * **COD completes with a `pending` manual refund.** There is no gateway to confirm, and the
   * disbursement happens by a route this backend has no visibility of; blocking on it would mean
   * a COD return could never close. The refund row records the obligation and staff settle it
   * with `POST /admin/refunds/{refundNumber}/settle` once the money is actually handed back.
   *
   * No `Idempotency-Key`: the `inspected -> completed` compare-and-swap is the idempotency, and
   * it is also what guarantees the restock happens exactly once — a second completion matches no
   * row, throws, and rolls back its own stock movement.
   */
  router.post(
    '/admin/returns/:returnNumber/complete',
    auth,
    requireStaff,
    validate({ params: ReturnNumberParamsSchema, body: StaffReturnDecisionSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<StaffReturnDecisionRequest>(req);
      const storeId = staffStore(req);
      const returnNumber = returnNumberOf(req);

      const view = await returns.completeReturn({
        storeId,
        returnNumber,
        actor: staffActor(req),
        ...(body.staffNote === undefined ? {} : { staffNote: body.staffNote }),
      });

      res.status(200).json({
        return: toStaffReturnResponse(view),
        refunds: (await returns.refundsForReturn({ storeId, returnNumber })).map(
          toReturnRefundResponse,
        ),
      });
    }),
  );

  return router;
}
