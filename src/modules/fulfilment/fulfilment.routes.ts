import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import { ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import {
  CreateShipmentRequestSchema,
  AdminListShipmentsQuerySchema,
  FulfilmentQueueQuerySchema,
  ShipmentIdParamsSchema,
  ShipmentTransitionRequestSchema,
  UpdateTrackingRequestSchema,
  toAdminShipmentDetailResponse,
  toAdminShipmentListResponse,
  toCustomerShipmentResponse,
  toStaffShipmentResponse,
  type AdminListShipmentsQuery,
  type CreateShipmentRequest,
  type FulfilmentQueueQuery,
  type FulfilmentQueueRow,
  type ShipmentIdParams,
  type ShipmentTransitionRequest,
  type UpdateTrackingRequest,
} from './dto.js';
import type { FulfilmentService } from './fulfilment.service.js';

/**
 * The fulfilment module's HTTP surface: one customer route and five staff routes.
 *
 * ## Action endpoints, not `PATCH {status}`
 *
 * `/ship` and `/deliver` rather than a status field, and for the reason §26 recorded for product
 * publish/archive: with `PATCH {status}`, `{"status":"delivered"}` on a pending shipment is a
 * request the server must accept, validate and refuse — an illegal transition is EXPRESSIBLE and
 * merely rejected. With action routes there is no route to call, so it is unrepresentable. The
 * `PATCH` that does exist touches only tracking and cannot reach the status column at all.
 *
 * ## No `Idempotency-Key`
 *
 * Deliberately. Creation is guarded by `uq_shipment_order` — two concurrent creations produce
 * one shipment and one `409`, which is a constraint doing the work a header would only
 * approximate. The transitions are guarded by a row lock plus a CAS on `from_status`, so a
 * duplicate click is a `409` with no second stock movement and no second event. Adding the
 * header would be ceremony on top of guarantees that already hold.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createFulfilmentRoutes(deps: {
  fulfilment: FulfilmentService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  /**
   * The `staff` scope guard, pre-built by the composition root.
   *
   * Passed in because the privilege check belongs to identity; this file only declares which
   * privilege a route requires.
   */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { fulfilment, requireStaff, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({
    verifyAccessToken: deps.verifyAccessToken,
    logger,
  });

  /** The owner and the tenant — neither from the request. */
  const scope = (req: Request): { userId: string; storeId: string } => {
    const user = requireUser(req);
    return { userId: user.id, storeId: user.storeId };
  };

  /**
   * The staff member performing the action, for the audit trail and the ledger.
   *
   * From the VERIFIED token, never from the request. An actor a client could supply is a trail a
   * client could forge, which is worse than no trail because it is trusted. Every route using
   * this sits behind `auth` and `requireStaff`, so `requireUser` cannot throw here.
   */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * The order number in a path.
   *
   * Validated as a bounded string rather than reusing the orders module's schema, because
   * `no-cross-module-imports` forbids importing it. The service answers `404` for anything that
   * does not resolve, so a malformed number and an unknown one are indistinguishable — which is
   * the existing convention and reveals nothing.
   */
  const orderNumberOf = (req: Request): string => {
    const raw = req.params['orderNumber'];
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
      throw new ValidationError({ orderNumber: ['must be an order number'] });
    }
    return raw;
  };

  /* ── Customer ─────────────────────────────────────────────────────────── */

  /**
   * `GET /users/me/orders/{orderNumber}/shipments`
   *
   * The customer's own order's shipments. An EMPTY array is a legitimate answer for an order
   * that has not shipped yet, and it is a different answer from `404` — which means the order is
   * unknown, another customer's, or another store's, all indistinguishable.
   *
   * The response carries no internal identifier, no note and nothing about inventory. See
   * `toCustomerShipmentResponse` for what is deliberately absent and why.
   */
  router.get(
    '/users/me/orders/:orderNumber/shipments',
    auth,
    asyncHandler(async (req, res) => {
      const { userId, storeId } = scope(req);
      const shipments = await fulfilment.listForCustomer({
        orderNumber: orderNumberOf(req),
        userId,
        storeId,
      });

      res.status(200).json({ shipments: shipments.map(toCustomerShipmentResponse) });
    }),
  );

  /* ── Staff ────────────────────────────────────────────────────────────── */

  /**
   * `GET /admin/orders/fulfilment` — the work queue.
   *
   * Mounted BEFORE the `:orderNumber` routes below, deliberately: `fulfilment` would otherwise
   * be matched as an order number by `/admin/orders/:orderNumber/shipments` and answer `404`.
   * Express matches in declaration order, so this is load-bearing rather than stylistic.
   *
   * Narrow by design — see `FulfilmentQueueQuerySchema`. Keyset-paged, oldest order first.
   */
  router.get(
    '/admin/orders/fulfilment',
    auth,
    requireStaff,
    validate({ query: FulfilmentQueueQuerySchema }),
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const query = validatedQuery<FulfilmentQueueQuery>(req);

      const rows = await fulfilment.listAwaitingFulfilment({
        storeId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });

      const orders: FulfilmentQueueRow[] = rows.map((row) => ({
        orderNumber: row.orderNumber,
        placedAt: row.placedAt.toISOString(),
        recipientName: row.shipRecipientName,
        city: row.shipCity,
        postalCode: row.shipPostalCode,
        shipmentStatus: row.shipmentStatus,
      }));

      /*
       * The cursor for the NEXT page, or `null` on the last one. Built from the last row rather
       * than from a count, because a keyset page cannot know a total without a second query the
       * queue does not need.
       */
      const last = rows.at(-1);
      const nextCursor =
        last === undefined || rows.length < query.limit
          ? null
          : fulfilment.encodeQueueCursor({
              placedAt: last.placedAt,
              orderNumber: last.orderNumber,
            });

      res.status(200).json({ orders, nextCursor });
    }),
  );

  /**
   * `POST /admin/orders/{orderNumber}/shipments` — raise the shipment.
   *
   * Creates it `pending`. It does NOT ship: `/ship` is a separate call because moving stock is
   * irreversible and should not be a side effect of a request whose body is tracking metadata.
   *
   * `409` if the order already has one — one shipment per order, enforced by
   * `uq_shipment_order`, which is also the duplicate-click guard.
   */
  router.post(
    '/admin/orders/:orderNumber/shipments',
    auth,
    requireStaff,
    validate({ body: CreateShipmentRequestSchema }),
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const body = validatedBody<CreateShipmentRequest>(req);

      const view = await fulfilment.createShipment({
        orderNumber: orderNumberOf(req),
        storeId,
        actor: staffActor(req),
        carrier: body.carrier ?? null,
        trackingNumber: body.trackingNumber ?? null,
        trackingUrl: body.trackingUrl ?? null,
      });

      res.status(201).json({ shipment: toStaffShipmentResponse(view.shipment) });
    }),
  );

  /** `GET /admin/orders/{orderNumber}/shipments` — staff view of one order's shipments. */
  router.get(
    '/admin/orders/:orderNumber/shipments',
    auth,
    requireStaff,
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const shipments = await fulfilment.listForStore({
        orderNumber: orderNumberOf(req),
        storeId,
      });

      res.status(200).json({ shipments: shipments.map(toStaffShipmentResponse) });
    }),
  );

  /**
   * `POST /admin/shipments/{id}/ship` — **the goods leave, and the stock moves.**
   *
   * The only route in the codebase that decreases `on_hand`. Refuses a cancelled order, refuses
   * an online order that is not paid, permits a COD order whose payment is still `pending`, and
   * answers `409` on a second attempt without moving stock twice.
   */
  /**
   * `GET /admin/shipments` — a page of the store's shipments, newest first. Increment 54.
   *
   * The read this module never had. `PATCH /admin/shipments/{id}` and both transition routes
   * have always addressed a shipment by id, so staff could change a shipment they had no way to
   * look at, and the only listing was the fulfilment queue — which is a worklist of orders
   * AWAITING shipment, and therefore excludes every shipment that already exists.
   *
   * Filters are exact, not searches: a status from the real vocabulary, and an order number
   * matching the generated shape. An unknown order number is an empty page rather than a `404` —
   * it is a filter, not a lookup.
   *
   * Ordered by `createdAt` descending then `id` descending. The tiebreaker is load-bearing:
   * `createdAt` alone is not a total order, and a non-total order makes `offset` paging skip and
   * repeat rows between pages.
   *
   * Store-scoped from the verified staff token. There is no `storeId` parameter, and the query
   * object is strict, so supplying one is a `400`.
   *
   * Failure modes: `400` for an unknown query parameter, an out-of-range `limit`, a status
   * outside the vocabulary or a malformed order number; `401` unauthenticated; `403` without the
   * `staff` scope.
   */
  router.get(
    '/admin/shipments',
    auth,
    requireStaff,
    validate({ query: AdminListShipmentsQuerySchema }),
    asyncHandler(async (req, res) => {
      const query = validatedQuery<AdminListShipmentsQuery>(req);

      const page = await fulfilment.listStoreShipments({
        storeId: scope(req).storeId,
        limit: query.limit,
        offset: query.offset,
        filters: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.orderNumber === undefined ? {} : { orderNumber: query.orderNumber }),
        },
      });

      res.status(200).json(toAdminShipmentListResponse(page));
    }),
  );

  /**
   * `GET /admin/shipments/{id}` — one shipment and its transition history. Increment 54.
   *
   * The list row plus `history`: every transition the shipment has made, oldest first, with the
   * note a staff member typed at each. The history lives here and not on the list because a page
   * of 100 shipments would otherwise carry every transition any of them ever made to render a
   * table that shows none of them.
   *
   * Registered AFTER `GET /admin/shipments` above so the literal is matched before the parameter
   * is considered. It does not collide with the existing routes under this prefix — those are
   * `PATCH /admin/shipments/{id}` and two `POST`s, so the method distinguishes them.
   *
   * Failure modes: `400` for a malformed UUID; `401` unauthenticated; `403` without the `staff`
   * scope; `404` for an unknown id and for another store's shipment alike — indistinguishable,
   * because the query returns nothing for both.
   */
  router.get(
    '/admin/shipments/:id',
    auth,
    requireStaff,
    validate({ params: ShipmentIdParamsSchema }),
    asyncHandler(async (req, res) => {
      const view = await fulfilment.getStoreShipment({
        shipmentId: validatedParams<ShipmentIdParams>(req).id,
        storeId: scope(req).storeId,
      });

      res.status(200).json({ shipment: toAdminShipmentDetailResponse(view) });
    }),
  );

  router.post(
    '/admin/shipments/:id/ship',
    auth,
    requireStaff,
    validate({ params: ShipmentIdParamsSchema, body: ShipmentTransitionRequestSchema }),
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const body = validatedBody<ShipmentTransitionRequest>(req);

      const view = await fulfilment.shipShipment({
        shipmentId: validatedParams<ShipmentIdParams>(req).id,
        storeId,
        actor: staffActor(req),
        note: body.note ?? null,
      });

      res.status(200).json({ shipment: toStaffShipmentResponse(view.shipment) });
    }),
  );

  /**
   * `POST /admin/shipments/{id}/deliver` — record arrival.
   *
   * No stock moves: the units left at `shipped`. A second attempt is `409` and
   * `delivered_at` is never overwritten.
   */
  router.post(
    '/admin/shipments/:id/deliver',
    auth,
    requireStaff,
    validate({ params: ShipmentIdParamsSchema, body: ShipmentTransitionRequestSchema }),
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const body = validatedBody<ShipmentTransitionRequest>(req);

      const view = await fulfilment.deliverShipment({
        shipmentId: validatedParams<ShipmentIdParams>(req).id,
        storeId,
        actor: staffActor(req),
        note: body.note ?? null,
      });

      res.status(200).json({ shipment: toStaffShipmentResponse(view.shipment) });
    }),
  );

  /**
   * `PATCH /admin/shipments/{id}` — correct the tracking facts.
   *
   * Tracking only. There is no `status` field in the schema, so this cannot become a state
   * change — which is the whole reason the transitions are action routes.
   *
   * Permitted in any state, `delivered` included: a wrong tracking number stays wrong and the
   * customer is still looking at it.
   */
  router.patch(
    '/admin/shipments/:id',
    auth,
    requireStaff,
    validate({ params: ShipmentIdParamsSchema, body: UpdateTrackingRequestSchema }),
    asyncHandler(async (req, res) => {
      const { storeId } = scope(req);
      const body = validatedBody<UpdateTrackingRequest>(req);

      const view = await fulfilment.updateTracking({
        shipmentId: validatedParams<ShipmentIdParams>(req).id,
        storeId,
        actor: staffActor(req),
        carrier: body.carrier,
        trackingNumber: body.trackingNumber,
        trackingUrl: body.trackingUrl,
      });

      res.status(200).json({ shipment: toStaffShipmentResponse(view.shipment) });
    }),
  );

  return router;
}
