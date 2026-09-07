import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedParams, validatedQuery } from '../../http/validate.js';
import { validatedBody } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import type { InventoryService } from './inventory.service.js';
import {
  CreateAdjustmentRequestSchema,
  ListHistoryQuerySchema,
  ListInventoryQuerySchema,
  SkuCodeParamsSchema,
  toStockHistoryResponse,
  toStockListResponse,
  toStockLedgerResponse,
  toStockResponse,
  type CreateAdjustmentRequest,
  type ListInventoryQuery,
  type SkuCodeParams,
} from './dto.js';

/**
 * The inventory module's HTTP surface.
 *
 * Mounted by the composition root under the API router at `/api/v1`, so `GET /admin/inventory`
 * here is reachable as `GET /api/v1/admin/inventory`.
 *
 * `/admin/*` is deliberate: `app_user.isStaff` grants "access to the admin API surface at all",
 * so that surface must be identifiable from a path. **There is no public inventory route**, and
 * no public product or SKU response gained a stock field in this increment — without
 * reservations there is nothing to hold a displayed availability with, so publishing one would
 * ship the storefront a promise the backend cannot keep.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` rule carves out `*.routes.ts` for exactly this.
 * Everything it needs from other modules arrives as a port or a pre-built handler from the
 * composition root, because `no-cross-module-imports` forbids reaching into `identity` for a
 * token service.
 */

export function createInventoryRoutes(deps: {
  inventory: InventoryService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  /** The `staff` scope guard, built by the composition root from the identity module. */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. The catalogue routes do the same.
}): Router {
  const { inventory, verifyAccessToken, requireStaff, logger } = deps;

  const router = Router();
  const auth = requireAuth({ verifyAccessToken, logger });

  /**
   * The actor, from the VERIFIED token.
   *
   * Never from the request body — `CreateAdjustmentRequestSchema` has no field for it, and
   * `strictObject` makes one a 400. The two `GET` routes have no body schema at all, so an
   * unexpected body reaches `req.body` unvalidated; reading the actor or the store from there
   * would be the escalation Increment 24 found on its bodiless `DELETE`. Both come from the
   * request instead.
   */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * GET /admin/inventory
   *
   * 200 with a page of this store's stock, newest-code-first, using the same `limit`/`offset`
   * convention and the same `pagination` metadata shape the catalogue lists use.
   *
   * PAGED, unlike the SKU list under one product: a store's inventory is unbounded, which is
   * the same judgement §28 applied to products and the opposite of the one it applied to a
   * single product's variants.
   *
   * Deleted SKUs are excluded. INACTIVE SKUs are included, because a merchant managing stock
   * needs to see everything they hold — sellability is a separate question from stock.
   */
  router.get(
    '/admin/inventory',
    auth,
    requireStaff,
    validate({ query: ListInventoryQuerySchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      const query = validatedQuery<ListInventoryQuery>(req);

      const page = await inventory.getStockForStore({
        storeId: store.id,
        limit: query.limit,
        offset: query.offset,
      });

      res.status(200).json(
        toStockListResponse({
          items: page.items,
          total: page.total,
          limit: query.limit,
          offset: query.offset,
        }),
      );
    }),
  );

  /**
   * POST /admin/inventory/adjustments
   *
   * 201 with the ledger entry AND the resulting stock, so a caller never has to re-read to
   * learn the outcome — which also means a client is never tempted to read-then-write.
   *
   * The body carries a **delta**, never a target quantity. A target would either require the
   * client to read the current figure first (recreating the lost-update bug one layer up) or
   * silently discard a concurrent adjustment. A merchant who has physically counted 40 units
   * wants a recount, which is a different operation with its own reason code.
   *
   * Failure modes: `400` for a fractional, zero, out-of-bounds or malformed value and for any
   * unknown field; `404` for an unknown, another store's, or a **deleted** SKU, all
   * indistinguishable on purpose; `409 INSUFFICIENT_STOCK` when the delta would leave less
   * than is available, decided by the atomic statement's own predicate rather than by a check
   * in front of it.
   */
  router.post(
    '/admin/inventory/adjustments',
    auth,
    requireStaff,
    validate({ body: CreateAdjustmentRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const { stock, entry } = await inventory.adjustStock({
        storeId: store.id,
        actor: staffActor(req),
        input: validatedBody<CreateAdjustmentRequest>(req),
      });

      res.status(201).json({
        inventory: toStockResponse(stock),
        adjustment: toStockLedgerResponse(entry),
      });
    }),
  );

  /**
   * GET /admin/inventory/:skuCode/history
   *
   * 200 with this SKU's movements, newest first, paged.
   *
   * **This is the only way to read the ledger, and there is deliberately no other way to write
   * it.** No `PATCH`, no `DELETE`, and no endpoint that edits an entry: the table has no
   * `updated_at` and no `deleted_at`, so there is nothing to edit or hide with even if a route
   * wanted to. That is what makes it an append-only source of truth rather than a log.
   *
   * `404` for an unknown, another store's, or a deleted SKU — resolved before the history query
   * runs, so an unknown code is a 404 rather than an empty page. An empty array for a mistyped
   * code is the answer that sends someone looking for data that was never there.
   */
  router.get(
    '/admin/inventory/:skuCode/history',
    auth,
    requireStaff,
    validate({ params: SkuCodeParamsSchema, query: ListHistoryQuerySchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      const query = validatedQuery<ListInventoryQuery>(req);

      const page = await inventory.getHistoryForSku({
        storeId: store.id,
        code: validatedParams<SkuCodeParams>(req).skuCode,
        limit: query.limit,
        offset: query.offset,
      });

      res.status(200).json(
        toStockHistoryResponse({
          items: page.items,
          total: page.total,
          limit: query.limit,
          offset: query.offset,
        }),
      );
    }),
  );

  return router;
}
