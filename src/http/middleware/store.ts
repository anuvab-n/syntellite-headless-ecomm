import type { Request, RequestHandler } from 'express';

import { extendContext } from '../../shared/context.js';
import { DependencyUnavailable, InvariantViolation } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { asyncHandler } from '../async-handler.js';

/**
 * Store resolution.
 *
 * Every tenant-owned row carries `store_id`, so a request must know which store it belongs
 * to before any domain code runs. This middleware answers that question once, at the edge,
 * so no service has to take a `storeId` parameter that a caller could get wrong.
 *
 * The resolution STRATEGY is injected, not implemented here. That is the whole point of the
 * split: today the strategy is "the one store named by `DEFAULT_STORE_SLUG`"; in Phase 2 it
 * becomes "match the Host header against `store.domain`". Swapping them means providing a
 * different `StoreResolver` — this file, and every identity service downstream, stay
 * untouched.
 *
 * It also lives here rather than in a module because `http/` owns the request boundary; the
 * resolver that queries the `store` table lives in `modules/stores`, which owns that table.
 */

/** The narrow store facts a request needs. Mirrors `ResolvedStore` in modules/stores. */
export type RequestStore = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
  readonly defaultLocale: string;
  readonly timezone: string;
};

/**
 * A strategy for mapping a request to a store.
 *
 * Returns `undefined` when no store matches — which the middleware treats as an
 * infrastructure problem, not a client error. See below.
 */
export type StoreResolver = (req: Request) => Promise<RequestStore | undefined>;

/**
 * Attaches the resolved store to the request and to the ambient context.
 *
 * Mounted on the API router only, never on `/health`: a readiness probe must not require a
 * seeded database, or a fresh deployment can never report ready long enough to be seeded.
 */
export function resolveStore(deps: { resolver: StoreResolver; logger: Logger }): RequestHandler {
  const { resolver, logger } = deps;

  return asyncHandler(async (req, _res, next) => {
    const store = await resolver(req);

    if (!store) {
      /**
       * 503, not 404.
       *
       * A missing store here is not "the client asked for something that does not exist" —
       * the client asked for nothing in particular. It means the configured store has not
       * been seeded, or has been deactivated: an operational fault on our side. A 404 would
       * send an integrator hunting through their own code for a bug that is ours, and it
       * would not trip the alerting that a 5xx does.
       */
      logger.error('store_resolution_failed');
      throw new DependencyUnavailable('store');
    }

    req.store = store;

    /**
     * Populate the ambient context too.
     *
     * `RequestContext.storeId` already exists and already has two consumers: the Pino mixin
     * puts it on every log line, and `EventBus.emit` falls back to it
     * (`event.storeId ?? context?.storeId ?? null`). So this single line makes every log
     * and every outbox event store-attributed without any call site passing a store id.
     *
     * `next()` is called INSIDE `extendContext` for the same reason `contextMiddleware`
     * does it: the store replaces the ambient store for the remainder of the request, and a
     * store established outside the callback would vanish at the first `await`.
     */
    extendContext({ storeId: store.id }, () => {
      next();
    });
  });
}

/**
 * Read the resolved store, or fail loudly.
 *
 * `req.store` is optional on the Express type because most middleware runs before
 * resolution. A route that needs a store and did not get one is a WIRING bug — the router
 * was mounted without `resolveStore` — so this throws an InvariantViolation (a 500), not a
 * DomainError. Returning a 4xx would blame the client for our mistake.
 */
export function requireStore(req: Request): RequestStore {
  if (!req.store) {
    throw new InvariantViolation(
      'req.store is missing; this route was mounted without resolveStore() middleware',
    );
  }
  return req.store;
}
