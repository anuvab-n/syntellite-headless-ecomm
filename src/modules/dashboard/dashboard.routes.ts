import { Router, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedQuery } from '../../http/validate.js';
import type { Logger } from '../../shared/logger.js';
import { resolveWindow, type DashboardService } from './dashboard.service.js';
import { DashboardQuerySchema, toDashboardResponse, type DashboardQuery } from './dto.js';

/**
 * The admin dashboard's HTTP surface: one route, and it is a READ.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createDashboardRoutes(deps: {
  dashboard: DashboardService;
  verifyAccessToken: AccessTokenVerifier;
  /**
   * The `staff` scope guard, pre-built by the composition root.
   *
   * **Optional, and when it is absent the route is NOT MOUNTED** — the same posture every other
   * admin router in this project takes. Several suites mount routers directly with no scope
   * loader, and a route disappearing is a safe default in a way that "mount it without the
   * guard" could never be: an unguarded dashboard publishes a store's entire commercial
   * position.
   */
  requireStaff?: RequestHandler;
  logger: Logger;
  /** Injected so a test can drive the default window without touching the clock. */
  now?: () => Date;
}): Router {
  const { dashboard, requireStaff, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const router = Router();
  const auth: RequestHandler = requireAuth({
    verifyAccessToken: deps.verifyAccessToken,
    logger,
  });

  /**
   * `GET /admin/dashboard` — every figure the dashboard screen renders. Increment 57.
   *
   * One endpoint rather than seven, because it is one screen and the seven widgets share a date
   * range that would otherwise have to be re-derived — and re-agreed — by each of them.
   *
   * ### What the date range governs
   *
   * `from`/`to` are an ANALYTICS window. They affect the revenue KPI, the orders KPI, the sales
   * series and the top products. They deliberately do NOT affect the product count, the customer
   * count, the order status counts, the low-stock list or the recent orders: those are "as of
   * now" operational facts, and a customer total silently narrowed to 30 days would be read as a
   * lifetime figure.
   *
   * Both bounds are INCLUSIVE at millisecond granularity, the convention every other admin list
   * here follows: the upper bound names a millisecond and includes the whole of it, so an
   * order's own published `placedAt` always round-trips as a bound even though PostgreSQL stores
   * microseconds underneath.
   *
   * Omitted, the window is the last twelve calendar months through now.
   *
   * ### The previous period
   *
   * The equal-DURATION window immediately before this one, ending one millisecond before `from`.
   * No overlap and no gap. Equal duration rather than equal calendar shape, so a 28-day February
   * is never compared against a 31-day January and the difference called growth.
   *
   * ### Tenancy
   *
   * Store-scoped from the verified staff token. There is no `storeId` parameter, and the query
   * object is strict, so supplying one is a `400` rather than something ignored.
   *
   * Failure modes: `400` for an unknown query parameter, a malformed instant, an interval
   * outside `day|week|month`, or an out-of-range limit; `401` unauthenticated; `403` without the
   * `staff` scope.
   */
  if (requireStaff) {
    router.get(
      '/admin/dashboard',
      auth,
      requireStaff,
      validate({ query: DashboardQuerySchema }),
      asyncHandler(async (req, res) => {
        const query = validatedQuery<DashboardQuery>(req);

        /*
         * Instants are parsed HERE rather than in the schema, so the DTO stays a description of
         * the WIRE — strings in, strings out — and the `Date` conversion happens once, at the
         * adapter boundary where every other parse in this project happens.
         */
        const window = resolveWindow({
          ...(query.from === undefined ? {} : { from: new Date(query.from) }),
          ...(query.to === undefined ? {} : { to: new Date(query.to) }),
          now: now(),
        });

        const store = requireStore(req);

        const view = await dashboard.overview({
          storeId: requireUser(req).storeId,
          window,
          currency: store.currency,
          timezone: store.timezone,
          interval: query.interval,
          topProductsLimit: query.topProductsLimit,
          lowStockLimit: query.lowStockLimit,
          recentOrdersLimit: query.recentOrdersLimit,
        });

        res.status(200).json(toDashboardResponse(view));
      }),
    );
  }

  return router;
}
