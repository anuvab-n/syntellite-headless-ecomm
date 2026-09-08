import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import { ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import {
  CreateShipmentRequestSchema,
  FulfilmentQueueQuerySchema,
  ShipmentIdParamsSchema,
  ShipmentTransitionRequestSchema,
  UpdateTrackingRequestSchema,
  toCustomerShipmentResponse,
  toStaffShipmentResponse,
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
