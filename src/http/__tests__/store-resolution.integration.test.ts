import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { store as storeTable } from '../../db/schema/store.js';
import {
  createDefaultStoreResolver,
  createStoreRepository,
  type StoreRepository,
} from '../../modules/stores/index.js';
import { getContext } from '../../shared/context.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';
import { createApp } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { requireStore, resolveStore } from '../middleware/store.js';

/**
 * Store resolution, against real PostgreSQL.
 *
 * Two things are under test: that a resolved store reaches both `req.store` and the ambient
 * context, and that an UNRESOLVABLE store degrades the way an operational fault should
 * rather than the way a client error would.
 */
describe('store resolution (integration)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
  });

  const db = () => testDb.handle.db;

  /**
   * A probe router that reports what resolution produced, so the assertions inspect the
   * middleware's real output rather than a proxy for it.
   */
  function buildApp(opts: { slug?: string; repository?: StoreRepository } = {}) {
    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: opts.repository ?? createStoreRepository({ db: db() }),
          slug: opts.slug ?? testDb.config.defaultStoreSlug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );

    apiRouter.get(
      '/probe',
      asyncHandler(async (req, res) => {
        await Promise.resolve();
        res.json({
          reqStore: requireStore(req),
          // Read AFTER an await on purpose: proves the store survives the async boundary,
          // which is the property `extendContext` exists to provide.
          contextStoreId: getContext()?.storeId ?? null,
        });
      }),
    );

    return createApp({
      config: testDb.config,
      logger: silentLogger,
      healthChecks: [],
      apiRouter,
    });
  }

  describe('when the configured store exists', () => {
    it('attaches the store to req.store', async () => {
      const seeded = await seedTestStore(testDb);

      const response = await request(buildApp()).get('/api/v1/probe');

      expect(response.status).toBe(200);
      expect(response.body.reqStore).toEqual({
        id: seeded.id,
        slug: testDb.config.defaultStoreSlug,
        name: testDb.config.defaultStoreSlug,
        currency: testDb.config.defaultCurrency,
        defaultLocale: 'en-IN',
        timezone: 'Asia/Kolkata',
      });
    });

    it('populates RequestContext.storeId across an await', async () => {
      const seeded = await seedTestStore(testDb);

      const response = await request(buildApp()).get('/api/v1/probe');

      /**
       * The reason this matters beyond tidiness: `RequestContext.storeId` already has two
       * consumers — the Pino mixin puts it on every log line, and `EventBus.emit` falls back
       * to it. So one line in the middleware makes every log and every outbox event
       * store-attributed with no call site passing an id.
       */
      expect(response.body.contextStoreId).toBe(seeded.id);
    });

    it('resolves independently on each request', async () => {
      await seedTestStore(testDb);
      const app = buildApp();

      const [a, b] = await Promise.all([
        request(app).get('/api/v1/probe'),
        request(app).get('/api/v1/probe'),
      ]);

      // Caching must not leak one request's store into another's context.
      expect(a.body.contextStoreId).toBe(b.body.contextStoreId);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    });
  });

  describe('when the configured store is missing', () => {
    it('returns 503, not 404', async () => {
      // Database migrated but never seeded — the state of a fresh deployment.
      const response = await request(buildApp()).get('/api/v1/probe');

      /**
       * A missing store is OUR fault, not the caller's: they asked for nothing in
       * particular. A 404 would send an integrator hunting through their own code for a bug
       * that is ours, and would not trip the alerting a 5xx does.
       */
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    });

    it('returns 503 when the configured slug matches nothing', async () => {
      await seedTestStore(testDb);

      const response = await request(buildApp({ slug: 'no-such-store' })).get('/api/v1/probe');

      expect(response.status).toBe(503);
    });

    it('returns 503 when the store exists but is deactivated', async () => {
      await seedTestStore(testDb);
      await db()
        .update(storeTable)
        .set({ isActive: false })
        .where(eq(storeTable.slug, testDb.config.defaultStoreSlug));

      // `isActive` is part of the lookup predicate, so a deactivated store is
      // indistinguishable from a missing one at every call site — one forgotten check
      // cannot serve traffic for a store that was deliberately switched off.
      const response = await request(buildApp()).get('/api/v1/probe');

      expect(response.status).toBe(503);
    });

    it('leaks no configuration detail in the failure', async () => {
      const response = await request(buildApp({ slug: 'internal-slug-name' })).get('/api/v1/probe');
      const serialised = JSON.stringify(response.body);

      // The slug is deployment configuration, not something a caller needs or should learn.
      expect(serialised).not.toContain('internal-slug-name');
      expect(serialised).not.toContain('store_id');
      expect(serialised).not.toContain('SELECT');
    });

    it('recovers once the store is seeded, without a restart', async () => {
      const app = buildApp();

      await expect(request(app).get('/api/v1/probe')).resolves.toMatchObject({ status: 503 });

      // Failures are deliberately NOT cached: a store missing because the database was
      // briefly unreachable must be retried on the next request, not written off.
      await seedTestStore(testDb);

      await expect(request(app).get('/api/v1/probe')).resolves.toMatchObject({ status: 200 });
    });
  });

  describe('scope', () => {
    it('does not apply to /health', async () => {
      // Never seeded. Readiness must not require a store, or a fresh deployment can never
      // report ready long enough to be seeded — a genuine deadlock.
      const response = await request(buildApp()).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('seed idempotency', () => {
    it('creates the store once and reuses it thereafter', async () => {
      const first = await seedTestStore(testDb);
      const second = await seedTestStore(testDb);
      const third = await seedTestStore(testDb);

      // `pnpm db:seed` is expected to be run repeatedly — by a developer, a test helper, and
      // potentially a deploy hook.
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await db().select().from(storeTable)).toHaveLength(1);
    });

    it('is safe under concurrent runs', async () => {
      // `ON CONFLICT DO NOTHING` plus a read-back, rather than read-then-write: two seeds
      // racing would both pass a pre-check and one would fail on the unique index.
      const results = await Promise.all([
        seedTestStore(testDb),
        seedTestStore(testDb),
        seedTestStore(testDb),
      ]);

      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(await db().select().from(storeTable)).toHaveLength(1);
    });
  });
});
