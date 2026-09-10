import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import {
  CreateReturnRequestSchema,
  ListReturnsQuerySchema,
  ReturnNumberParamsSchema,
  toReturnResponse,
  type CreateReturnRequest,
  type ListReturnsQuery,
  type ReturnNumberParams,
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
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { returns, requireIdempotency, logger } = deps;

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

  return router;
}
