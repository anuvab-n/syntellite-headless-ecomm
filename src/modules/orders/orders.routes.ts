import { Router, type Request, type RequestHandler, type Response } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import { renderInvoice, type InvoiceDocumentRecord, type InvoiceInput } from './invoice.js';
import type { OrdersService } from './orders.service.js';
import {
  CheckoutRequestSchema,
  ListOrdersQuerySchema,
  OrderNumberParamsSchema,
  toOrderListResponse,
  toOrderResponse,
  type CheckoutRequest,
  type ListOrdersQuery,
  type OrderNumberParams,
} from './dto.js';

/**
 * The orders module's HTTP surface: five customer routes and one staff route.
 *
 * **The staff surface is exactly one route** — `GET /admin/orders/{orderNumber}/invoice`, the
 * invoice for any order in the store. It exists because re-issuing a customer's invoice is a
 * routine support request whose only previous answers were "ask the customer to fetch it
 * themselves" and "impersonate them", the second of which is the worse security posture.
 *
 * **There is still no operator order list.** That is a reporting concern and needs its own
 * visibility rules — which orders a support agent may see, and whether another customer's
 * address is among them. The invoice route sidesteps the question because it requires an order
 * number, so the agent already has one from the customer; a browsable list does not, and
 * inventing one as a side effect of an invoice request would be the wrong way to settle it.
 *
 * ## The middleware chain, and why the order changed
 *
 *   resolveStore (API router) -> requireAuth -> requireIdempotency -> validate -> handler
 *
 * `requireIdempotency` now sits AFTER `requireAuth`, where the original design documented it
 * before. It has to: a key is scoped to (store, USER, key, endpoint), and the user comes from the
 * verified token. The cost is that a replay re-authenticates before it is served; the benefit is
 * that one customer's key can never arbitrate another customer's request — which, with identical
 * payloads, would have replayed another customer's ORDER.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createOrdersRoutes(deps: {
  orders: OrdersService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  /**
   * The idempotency guard, pre-built by the composition root against the shared store.
   *
   * Passed in rather than constructed here because the store is cross-cutting infrastructure
   * this module must not reach for — the same reason `requireStaff` arrives pre-built elsewhere.
   */
  requireIdempotency: RequestHandler;
  /**
   * The `staff` scope guard, pre-built by the composition root — the same instance the
   * catalogue, inventory and promotions routers use.
   *
   * Passed in for the reason `requireIdempotency` is: the privilege check belongs to identity,
   * and this file only declares which privilege a route requires.
   */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { orders, requireIdempotency, requireStaff, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({
    verifyAccessToken: deps.verifyAccessToken,
    logger,
  });

  /** The owner, the tenant and the currency — none of them from the request. */
  const scope = (
    req: Request,
  ): { userId: string; storeId: string; storeCurrency: string; storeTimezone: string } => {
    const user = requireUser(req);
    return {
      userId: user.id,
      storeId: user.storeId,
      storeCurrency: requireStore(req).currency,
      /*
       * The store's IANA timezone, for the invoice's financial year and document date. From the
       * RESOLVED store, exactly as the currency is — never from a header or a body.
       */
      storeTimezone: requireStore(req).timezone,
    };
  };

  /**
   * The customer placing the order, for the audit trail and the status-history row.
   *
   * From the VERIFIED token. An actor a client could supply is a trail a client could forge,
   * which is worse than no trail because it is trusted.
   */
  const customerActor = (req: Request): AuditActor => ({
    type: 'customer',
    userId: requireUser(req).id,
  });

  /**
   * The one HTML response in this API, sent identically to whoever asked for it.
   *
   * Shared by the customer and staff invoice routes so the two cannot drift: the hardening on
   * this response — a per-route CSP because the API disables CSP globally, and `no-store`
   * because the document carries a delivery address — must not be something one route
   * remembers and the other forgets.
   */
  const sendInvoice = (
    res: Response,
    result: {
      view: { order: InvoiceInput['order']; lines: InvoiceInput['lines'] };
      payment: InvoiceInput['payment'];
      /**
       * The issued statutory invoice, or `null`.
       *
       * Read by the service, never issued here: requirement 15 keeps these routes read-only, so
       * fetching a document allocates nothing.
       */
      invoice: {
        invoice: Omit<InvoiceDocumentRecord, 'summary'>;
        summary: InvoiceDocumentRecord['summary'];
      } | null;
    },
  ): void => {
    /*
     * The service returns the invoice ROW and its summary as two fields; the renderer takes one
     * flattened record. Mapped here rather than reshaped in the service, so the document type
     * stays the renderer's own and the service is not coupled to how a page is laid out.
     */
    const document =
      result.invoice === null
        ? null
        : { ...result.invoice.invoice, summary: result.invoice.summary };
    res
      .status(200)
      .type('html')
      .set(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .set('Cache-Control', 'private, no-store')
      .send(
        renderInvoice({
          order: result.view.order,
          lines: result.view.lines,
          payment: result.payment,
          invoice: document,
        }),
      );
  };

  /**
   * The idempotency claim this request already holds.
   *
   * Recomputed from the same inputs the middleware used, so the service completes exactly the
   * row the middleware claimed. `endpoint` must match `endpointOf(method, baseUrl + path)`
   * character for character — a mismatch would complete nothing and leave the key in flight
   * until it expired.
   */
  const claimOf = (req: Request): { key: string; endpoint: string } => ({
    key: (req.get('idempotency-key') ?? '').trim(),
    endpoint: `${req.method.toUpperCase()} ${req.baseUrl + req.path}`,
  });

  /**
   * POST /users/me/checkout
   *
   * 201 with the created order. **The whole request body is `{ addressId }`.**
   *
   * `Idempotency-Key` is REQUIRED — checkout is the endpoint §36 built that machinery for, and
   * the first to mount it. A client that never sees the response cannot know whether the order
   * was placed; without a key its only sane move is to retry, and that retry would place a
   * second order and eventually take a second payment.
   *
   * Everything is server-authoritative. The cart is found from the verified token, prices are
   * re-read from the catalogue inside the transaction, purchasability is re-evaluated, the
   * applied promotion is re-priced, and every total is computed from that one read. The cart's
   * own `subtotal`/`discountTotal`/`cartTotal` are display values and are never consulted.
   *
   * Failure modes: `400` for a malformed body, an unknown field, or a missing/short
   * `Idempotency-Key`; `404` for an address that is unknown, another customer's, another
   * store's, or soft-deleted — all indistinguishable; `409` when the cart is already checked out
   * or a concurrent checkout won the race, and for an in-flight key; `422` for an empty cart,
   * for lines that are no longer purchasable (naming the SKU codes), and for a key reused with a
   * different body.
   *
   * **Nothing is reserved or decremented**: no stock is read or written, so an order can be
   * placed for stock that is not there until the allocation increment lands.
   */
  router.post(
    '/users/me/checkout',
    auth,
    requireIdempotency,
    validate({ body: CheckoutRequestSchema }),
    asyncHandler(async (req, res) => {
      const view = await orders.checkout({
        ...scope(req),
        addressId: validatedBody<CheckoutRequest>(req).addressId,
        idempotency: claimOf(req),
        actor: customerActor(req),
        /**
         * The response body, rendered by the SAME function the route uses, and handed to
         * `idempotency.complete()` inside the transaction. A replay must reproduce this
         * response verbatim — rendering it twice from two code paths is how a replay ends up
         * differing from the original.
         */
        renderResponse: (created) => ({ order: toOrderResponse(created) }),
      });

      res.status(201).json({ order: toOrderResponse(view) });
    }),
  );

  /**
   * GET /users/me/orders
   *
   * 200 with a page of this customer's orders, **newest first**, each with its lines.
   *
   * Paginated with the project's established `limit`/`offset` contract: an over-limit page is a
   * `400` rather than being silently clamped, because a clamped page tells a client its size was
   * honoured when it was not, and a client paging on `offset += limit` would then skip orders.
   *
   * The page and the total share one predicate, so a caller on the last page is never told the
   * total counted rows it cannot see.
   */
  router.get(
    '/users/me/orders',
    auth,
    validate({ query: ListOrdersQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = validatedQuery<ListOrdersQuery>(req);
      const { userId, storeId } = scope(req);

      const page = await orders.listOrders({ userId, storeId, limit, offset });

      res.status(200).json(toOrderListResponse(page));
    }),
  );

  /**
   * GET /users/me/orders/:orderNumber
   *
   * 200, or `404` for an unknown number, another customer's order or another store's — all
   * indistinguishable, the §25 rule that ownership belongs in the query rather than in a
   * comparison performed afterwards. A `403` for "someone else's" would confirm the order
   * exists, which is exactly the leak one answer closes.
   *
   * Every value returned is a snapshot taken at checkout. Renaming the product, repricing or
   * deleting the SKU, or editing or deleting the address changes nothing here.
   */
  /**
   * POST /users/me/orders/:orderNumber/cancel
   *
   * 200 with the cancelled order. **No request body** — there is nothing to supply: the order
   * comes from the path, the customer from the token, and the only decision is one the server
   * makes about eligibility.
   *
   * No `Idempotency-Key`, deliberately. Cancellation has a natural guard — the
   * `status = 'placed'` predicate on the update — so a duplicate request cannot cancel twice.
   * It answers `409` rather than replaying a `200`, because a client that is told "cancelled"
   * twice cannot tell whether it cancelled something or nothing, and for a state change that is
   * worth knowing.
   *
   * Failure modes: `400` for a malformed order number; `404` for an order that is unknown,
   * another customer's or another store's — all indistinguishable; `409 ORDER_NOT_CANCELLABLE`
   * when the order is already cancelled (`details.reason = "status"`), when a payment is still
   * in progress (`"payment_in_progress"`), or when it has been paid (`"paid"`).
   *
   * **Paid orders cannot be cancelled**, because refunds do not exist yet and cancelling one
   * would take money the system has no way to return.
   */
  router.post(
    '/users/me/orders/:orderNumber/cancel',
    auth,
    validate({ params: OrderNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const { userId, storeId } = scope(req);
      const view = await orders.cancelOrder({
        userId,
        storeId,
        orderNumber: validatedParams<OrderNumberParams>(req).orderNumber,
        actor: customerActor(req),
      });
      res.status(200).json({ order: toOrderResponse(view) });
    }),
  );

  /**
   * GET /users/me/orders/:orderNumber/invoice
   *
   * The invoice for one of the customer's own orders, as a self-contained HTML document.
   *
   * **`text/html`, not JSON** — the only such response in this API, which is why it sets two
   * headers the other routes do not need:
   *
   *  - `Content-Security-Policy`, because `app.ts` disables CSP globally on the stated grounds
   *    that this is "a JSON API with no HTML responses". That is no longer true here, so the
   *    document carries its own policy: no scripts at all, no remote anything, and inline
   *    styles only. Escaping in `renderInvoice` is the primary defence; this is the second one.
   *  - `X-Content-Type-Options: nosniff` comes from helmet already, and matters more here than
   *    anywhere else in the API.
   *
   * `Cache-Control: private, no-store` because the document contains a delivery address. A
   * shared cache holding it would be a data leak, and a browser cache holding it after logout
   * is one too.
   *
   * Prints to PDF from any browser — the document has `@media print` rules for exactly that.
   * A server-generated PDF would need a rendering dependency, which is a decision worth taking
   * on its own terms rather than as a side effect of this endpoint.
   *
   * Failure modes: `400` for a malformed order number; `404` for an order that is unknown,
   * another customer's or another store's — all indistinguishable, and rendered through the
   * standard JSON error envelope, because an error is not a document.
   */
  router.get(
    '/users/me/orders/:orderNumber/invoice',
    auth,
    validate({ params: OrderNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const { userId, storeId } = scope(req);
      sendInvoice(
        res,
        await orders.getOrderForInvoice({
          userId,
          storeId,
          orderNumber: validatedParams<OrderNumberParams>(req).orderNumber,
        }),
      );
    }),
  );

  /**
   * `GET /admin/orders/{orderNumber}/invoice` — the invoice for ANY order in the store.
   *
   * The staff counterpart of the route above, and the first `/admin/order*` route in the
   * project. It exists because "re-send the customer their invoice" is a support request that
   * arrives daily, and the only previous answer was to ask the customer to fetch it themselves
   * or to impersonate them — the second of which is a far worse security posture than an
   * explicit, guarded staff route.
   *
   * ### What is and is not relaxed
   *
   * `store_id` scoping is NOT relaxed: the repository method behind this still filters by
   * tenant, so staff of one store cannot read another's orders. Only *ownership within the
   * store* is dropped, which is precisely what "admin" means here.
   *
   * ### Deliberately still absent
   *
   * There is no `GET /admin/orders` list and no staff order detail endpoint. This route needs
   * the order number, so it serves a support agent who already has one from the customer. A
   * browsable admin order surface is a larger design question — filtering, pagination, PII
   * exposure and what staff may see of another customer's address — and inventing it as a side
   * effect of an invoice request would be the wrong way to decide it.
   *
   * Failure modes are the customer route's, minus one: `404` here means the order is unknown
   * **or belongs to another store**. A different customer's order is no longer a 404, which is
   * the entire feature.
   */
  router.get(
    '/admin/orders/:orderNumber/invoice',
    auth,
    requireStaff,
    validate({ params: OrderNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      sendInvoice(
        res,
        await orders.getStoreOrderForInvoice({
          storeId: requireUser(req).storeId,
          orderNumber: validatedParams<OrderNumberParams>(req).orderNumber,
        }),
      );
    }),
  );

  router.get(
    '/users/me/orders/:orderNumber',
    auth,
    validate({ params: OrderNumberParamsSchema }),
    asyncHandler(async (req, res) => {
      const { userId, storeId } = scope(req);

      const view = await orders.getOrder({
        userId,
        storeId,
        orderNumber: validatedParams<OrderNumberParams>(req).orderNumber,
      });

      res.status(200).json({ order: toOrderResponse(view) });
    }),
  );

  return router;
}
