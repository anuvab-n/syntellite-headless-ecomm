import type { StoreResolver } from '../../http/middleware/store.js';
import type { Logger } from '../../shared/logger.js';
import type { StoreRepository } from './stores.repository.js';

/**
 * The Phase 1 store resolution strategy: one store, named by configuration.
 *
 * Implements the `StoreResolver` port declared by `http/middleware/store.ts`. Phase 2 adds a
 * `createDomainStoreResolver` beside this one and the container picks between them; nothing
 * else in the system changes, because nothing else knows how resolution happens.
 *
 * Ignores the request entirely, which is exactly right while the platform is single-store:
 * pretending to inspect a Host header we do not yet honour would be worse than not looking.
 */

/**
 * How long a successful lookup is reused.
 *
 * Without a cache this is one SELECT on every single API request, forever, to answer a
 * question whose answer effectively never changes. With an unbounded cache, deactivating a
 * store would require a deploy to take effect. Sixty seconds is short enough that
 * `isActive = false` takes hold quickly and long enough that the query disappears from the
 * hot path.
 *
 * Failures are NOT cached: a store that is missing because the database was briefly
 * unreachable must be retried on the next request, not written off for a minute.
 */
const CACHE_TTL_MS = 60_000;

export function createDefaultStoreResolver(deps: {
  repository: StoreRepository;
  slug: string;
  logger: Logger;
  cacheTtlMs?: number;
}): StoreResolver {
  const { repository, slug, logger } = deps;
  const ttlMs = deps.cacheTtlMs ?? CACHE_TTL_MS;

  let cached:
    { store: Awaited<ReturnType<StoreRepository['findActiveBySlug']>>; at: number } | undefined;

  /**
   * Collapses concurrent lookups into one query.
   *
   * On a cold cache under load — the first moment after a deploy — every in-flight request
   * would otherwise issue its own identical SELECT. Sharing the promise turns a thundering
   * herd into a single round trip.
   */
  let inFlight: Promise<Awaited<ReturnType<StoreRepository['findActiveBySlug']>>> | undefined;

  return async function resolveDefaultStore() {
    const now = Date.now();

    if (cached && now - cached.at < ttlMs) {
      return cached.store;
    }

    inFlight ??= repository
      .findActiveBySlug(slug)
      .then((store) => {
        // Only a hit is cached; see the note on CACHE_TTL_MS.
        if (store) {
          cached = { store, at: Date.now() };
        } else {
          cached = undefined;
          logger.error({ slug }, 'default_store_not_found');
        }
        return store;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  };
}
