import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../tests/helpers/redis.ts';
import { buildContainer, type AppContainer } from '../container.js';
import { appUser } from '../db/schema/identity.js';
import { outboxEvent } from '../db/schema/outbox.js';
import { store } from '../db/schema/store.js';
import { withTransaction } from '../db/transaction.js';
import { newId } from '../shared/id.js';

/**
 * The composition root, against real PostgreSQL and real Redis.
 *
 * The whole value of a composition root is that it either wires up or it does not, so the
 * tests that matter are the ones that construct the real thing against real dependencies.
 * A mocked container would assert that we call our own factories in the order we wrote —
 * which is not a property anybody cares about.
 */
describe('composition root (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  const built: AppContainer[] = [];

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /**
   * Anything a test builds is torn down, so a leaked pool cannot fail a later test.
   *
   * The database is truncated too, and that is not merely tidiness. `seedTestStore` re-seeds
   * by deleting existing stores, and `store` is referenced with `ON DELETE restrict` — so the
   * first test to leave a child row behind (a user, a product, a session) makes every LATER
   * test's seed fail with a foreign-key violation. The suite was previously independent only
   * by accident, because nothing had yet written a child row.
   */
  afterEach(async () => {
    await Promise.allSettled(built.splice(0).map((c) => c.shutdown()));
    await testDb.truncate();
  });

  function build(
    role: 'api' | 'worker' = 'api',
    opts: { transport?: 'in-process' | 'queue' } = {},
  ): AppContainer {
    const container = buildContainer({
      role,
      config: buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url }),
      // Fast poll so a test that drains does not wait a second per batch.
      drainer: { pollIntervalMs: 50 },
      ...(opts.transport ? { transport: opts.transport } : {}),
    });
    built.push(container);
    return container;
  }

  /* ── 1. Construction ───────────────────────────────────────────────────── */

  describe('construction', () => {
    it('constructs against the real Postgres and Redis environment', () => {
      const container = build();

      expect(container.config.environment).toBe('test');
      expect(container.db.pool).toBeDefined();
      expect(container.outbox.events).toBeDefined();
      expect(container.app).toBeDefined();
    });

    it('points replica at the primary handle when no replica is configured', () => {
      const container = build();

      // Not a second pool to the same server: that would double the connection count and
      // prove nothing. Identity, so shutdown closes it exactly once.
      expect(container.replica).toBe(container.db);
    });

    it('runs no job workers in an api container', () => {
      const container = build('api');

      // Node is single-threaded: a CPU-bound handler inside the API process stalls every
      // concurrent request, and users read that as "the site is down".
      expect(container.outbox.workers).toBeUndefined();
    });

    // SKIPPED: BullMQ is commented out for now (outbox.module.ts, queues.ts). transport:
    // 'queue' now throws by design, so this test — specifically about the queue path —
    // cannot pass. Re-enable alongside the queue branch.
    it.skip('runs job workers in a worker container using the queue transport', () => {
      const container = build('worker', { transport: 'queue' });

      expect(container.outbox.workers).toBeDefined();
      expect(container.outbox.workers?.workers.length).toBeGreaterThan(0);
    });

    it('runs no job workers in a worker container using the default (in-process) transport', () => {
      // The in-process transport has no BullMQ workers to run at all — the drainer runs
      // handlers itself. Asserted so a change that silently brings BullMQ back as the
      // default is caught here, not discovered in production Redis usage.
      const container = build('worker');

      expect(container.outbox.workers).toBeUndefined();
    });

    // SKIPPED: BullMQ is commented out for now — see the note above.
    it.skip('creates the queue infrastructure the outbox needs, when the queue transport is chosen', () => {
      const container = build('api', { transport: 'queue' });

      // Owned by the outbox subsystem, not by the container — one owner, one shutdown.
      expect(container.outbox.queues).toBeDefined();
      expect(container.outbox.queues?.queues.default).toBeDefined();
    });

    it('creates no queue infrastructure under the default (in-process) transport', () => {
      const container = build();

      expect(container.outbox.queues).toBeUndefined();
    });
  });

  /* ── 2. HTTP app from the container ────────────────────────────────────── */

  describe('http app', () => {
    it('serves GET /health/live with 200', async () => {
      const response = await request(build().app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('serves GET /health/ready with 200 when dependencies are healthy', async () => {
      const response = await request(build().app).get('/health/ready');

      // The REAL probe the container wired: a live Postgres query. Nothing else is required.
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        checks: { postgres: 'ok' },
      });
    });

    it('returns the standard JSON 404 for an unknown route', async () => {
      /**
       * A store must exist first. Phase 1 mounted `resolveStore` on the API router, so an
       * unseeded database answers 503 for EVERY `/api/v1` path — including unknown ones —
       * before routing is reached. That behaviour is asserted on purpose in
       * `http/__tests__/store-resolution.integration.test.ts`; here it would mask the
       * 404 this test is actually about.
       */
      await seedTestStore(testDb);

      /**
       * A path chosen to STAY unmatched.
       *
       * This previously used `/api/v1/products`, which was genuinely unknown when the test was
       * written in Phase 1 — and became a real endpoint in §31, turning a 404 assertion into a
       * 200. The test was right to fail: it had silently stopped testing the 404 handler and
       * started testing the catalogue.
       *
       * `/no-such-resource` is not a name any planned endpoint would take, so it does not
       * quietly become valid the way a plausible resource name does.
       */
      const response = await request(build().app).get('/api/v1/no-such-resource');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.requestId).toBeTypeOf('string');
    });

    it('serves the registration route that Phase 1 mounted', async () => {
      await seedTestStore(testDb);

      // An empty body fails validation, which is enough to prove the route is REACHABLE —
      // a 404 here would mean the container never wired the identity router.
      const response = await request(build().app).post('/api/v1/auth/register').send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('serves the refresh route', async () => {
      await seedTestStore(testDb);

      const response = await request(build().app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'x'.repeat(43) });

      // Reachable, and reaching the service rather than 404ing at the router.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('protects the catalogue DELETE route with the STAFF scope specifically', async () => {
      const seeded = await seedTestStore(testDb);
      const container = build();
      const app = container.app;

      const email = 'wiring-delete@example.com';
      const password = 'a-sufficiently-long-password';
      const user = await container.identity.registerCustomer({
        storeId: seeded.id,
        input: { email, password, firstName: 'Ada', lastName: 'Lovelace' },
      });

      const login = async () =>
        (await request(app).post('/api/v1/auth/login').send({ email, password })).body
          .accessToken as string;

      const remove = async (token: string) =>
        request(app)
          .delete('/api/v1/admin/products/wiring-check')
          .set('Authorization', `Bearer ${token}`);

      // A plain customer is refused before the product is even looked up.
      expect((await remove(await login())).status).toBe(403);

      await testDb.handle.db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      /**
       * A STAFF user — deliberately not a superuser — reaches the handler. The 404 is the
       * point: authorization passed and the product simply does not exist, a different outcome
       * from the 403 above.
       *
       * Asserted at the CONTAINER because the catalogue's own suites build their own router, so
       * wiring `requireScope('superuser')` in the composition root would leave all of them
       * passing. §22 established no scope hierarchy, so the wrong choice silently locks out the
       * intended audience.
       */
      const allowed = await remove(await login());
      expect(allowed.status).toBe(404);
      expect(allowed.body.error.code).toBe('NOT_FOUND');
    });

    it('protects the catalogue EDIT route with the STAFF scope specifically', async () => {
      const seeded = await seedTestStore(testDb);
      const container = build();
      const app = container.app;

      const email = 'wiring-edit@example.com';
      const password = 'a-sufficiently-long-password';
      const user = await container.identity.registerCustomer({
        storeId: seeded.id,
        input: { email, password, firstName: 'Ada', lastName: 'Lovelace' },
      });

      const login = async () =>
        (await request(app).post('/api/v1/auth/login').send({ email, password })).body
          .accessToken as string;

      const edit = async (token: string) =>
        request(app)
          .patch('/api/v1/admin/products/wiring-check')
          .set('Authorization', `Bearer ${token}`)
          .send({ name: 'Edited' });

      // A plain customer is refused before the product is even looked up.
      expect((await edit(await login())).status).toBe(403);

      await testDb.handle.db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      /**
       * A STAFF user — deliberately not a superuser — reaches the handler. The 404 is the
       * point: authorization passed and the product simply does not exist, which is a
       * different outcome from the 403 above.
       *
       * Asserted at the CONTAINER because the catalogue's own suites build their own router,
       * so swapping `requireScope('staff')` for `requireScope('superuser')` in the composition
       * root would leave every one of them passing. §22 established no scope hierarchy, so the
       * wrong choice is a silent, total lockout of the intended audience.
       */
      const allowed = await edit(await login());
      expect(allowed.status).toBe(404);
      expect(allowed.body.error.code).toBe('NOT_FOUND');
    });

    it('protects the catalogue LIST route with the STAFF scope specifically', async () => {
      const seeded = await seedTestStore(testDb);
      const container = build();
      const app = container.app;

      const email = 'wiring-list@example.com';
      const password = 'a-sufficiently-long-password';
      const user = await container.identity.registerCustomer({
        storeId: seeded.id,
        input: { email, password, firstName: 'Ada', lastName: 'Lovelace' },
      });

      const login = async () =>
        (await request(app).post('/api/v1/auth/login').send({ email, password })).body
          .accessToken as string;

      const listProducts = async (token: string) =>
        request(app).get('/api/v1/admin/products').set('Authorization', `Bearer ${token}`);

      // A plain customer is refused.
      expect((await listProducts(await login())).status).toBe(403);

      await testDb.handle.db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      /**
       * A STAFF user — deliberately not a superuser — must get through.
       *
       * Asserted at the CONTAINER because the catalogue's own suites build their own router, so
       * swapping `requireScope('staff')` for `requireScope('superuser')` in the composition root
       * would leave every one of them passing. §22 established no scope hierarchy, so picking
       * the wrong one is a silent, total lockout of the intended audience rather than an obvious
       * error. This is the same gap §24 recorded for the write route.
       */
      const allowed = await listProducts(await login());
      expect(allowed.status).toBe(200);
      // And the real route returns the real contract, not just a 200. `counts` joined it in
      // increment 58 — the list screen's tab badges, which are store-wide rather than page-wide.
      expect(Object.keys(allowed.body).sort()).toEqual(['counts', 'pagination', 'products']);
    });

    it('protects the catalogue write route with the STAFF scope specifically', async () => {
      const seeded = await seedTestStore(testDb);
      const container = build();
      const app = container.app;

      const email = 'wiring-staff@example.com';
      const password = 'a-sufficiently-long-password';
      const user = await container.identity.registerCustomer({
        storeId: seeded.id,
        input: { email, password, firstName: 'Ada', lastName: 'Lovelace' },
      });

      const login = async () =>
        (await request(app).post('/api/v1/auth/login').send({ email, password })).body
          .accessToken as string;

      const createProduct = async (token: string) =>
        request(app)
          .post('/api/v1/admin/products')
          .set('Authorization', `Bearer ${token}`)
          // No price: it moved to the SKU in Increment 24, and the body is a strict object.
          .send({ slug: 'wiring-check', name: 'Wiring Check' });

      // A plain customer is refused.
      expect((await createProduct(await login())).status).toBe(403);

      await testDb.handle.db.update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      /**
       * A STAFF user — deliberately not a superuser — must get through.
       *
       * This test exists because of a gap the module suite could not cover: that suite builds
       * its own router wiring, so swapping `requireScope('staff')` for `requireScope('superuser')`
       * in the composition root left all 28 of its tests passing. The scope a production route
       * actually demands is a property of the container, and has to be asserted there.
       *
       * There is no implied hierarchy (§22), so `superuser` would NOT satisfy a `staff` guard —
       * which is exactly why picking the wrong one is a silent, total lockout of the intended
       * audience rather than an obvious error.
       */
      expect((await createProduct(await login())).status).toBe(201);
    });
  });

  /* ── 3. Outbox wired through the container ─────────────────────────────── */

  describe('outbox wiring', () => {
    it('emits through the container event bus inside a transaction', async () => {
      const container = build();

      const storeId = await withTransaction(container.db.db, container.logger, async (tx) => {
        const id = newId();
        await tx.insert(store).values({ id, name: 'Container Store', slug: `c-${id.slice(0, 8)}` });
        await container.outbox.events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
        return id;
      });

      const rows = await container.db.db.select().from(outboxEvent);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregateId).toBe(storeId);
      // Durable but not yet published — the drainer has not run.
      expect(rows[0]?.publishedAt).toBeNull();

      await container.db.db.delete(outboxEvent);
      await container.db.db.delete(store);
    });

    it('discards the event when the transaction rolls back', async () => {
      const container = build();

      await expect(
        withTransaction(container.db.db, container.logger, async (tx) => {
          const id = newId();
          await tx.insert(store).values({ id, name: 'Doomed', slug: `d-${id.slice(0, 8)}` });
          await container.outbox.events.emit({
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { storeId: id },
          });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      // The container wiring must not have broken the atomicity guarantee Step 4 proved.
      expect(await container.db.db.select().from(outboxEvent)).toHaveLength(0);
      expect(await container.db.db.select().from(store)).toHaveLength(0);
    });

    // SKIPPED: BullMQ is commented out for now — see the note above.
    it.skip('drains a committed event to the queue through the container drainer', async () => {
      const container = build('api', { transport: 'queue' });

      await withTransaction(container.db.db, container.logger, async (tx) => {
        const id = newId();
        await tx.insert(store).values({ id, name: 'Drained', slug: `dr-${id.slice(0, 8)}` });
        await container.outbox.events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      const result = await container.outbox.drainer.drainOnce();
      expect(result.published).toBe(1);

      // Reached the real BullMQ queue on the real Redis.
      const counts = await container.outbox.queues!.queues.default.getJobCounts();
      expect(counts['waiting']).toBe(1);

      const [row] = await container.db.db.select().from(outboxEvent);
      expect(row?.publishedAt).toBeInstanceOf(Date);

      await container.db.db.delete(outboxEvent);
      await container.db.db.delete(store);
    });

    it('exposes exactly one event system', () => {
      const a = build();
      const b = build();

      // Two containers are two independent wirings; within one container there is a single
      // `events`/`repository`/`drainer` triple. A second event system would mean two
      // answers to "did this event get delivered".
      expect(a.outbox.events).not.toBe(b.outbox.events);
      expect(a.outbox.repository).toBeDefined();
    });
  });

  /* ── 4. Shutdown ───────────────────────────────────────────────────────── */

  describe('shutdown', () => {
    it('closes resources cleanly without hanging', async () => {
      const container = buildContainer({
        role: 'worker',
        config: buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url }),
        drainer: { pollIntervalMs: 50 },
      });

      const startedAt = Date.now();
      await container.shutdown();
      const elapsed = Date.now() - startedAt;

      // A 'worker' container holds the most resources: drainer, BullMQ workers with a
      // blocking connection each, the queue connection, the lock client, and the pool.
      // Ten seconds is generous; a hang here means a socket nobody owns, which is how a
      // deploy ends in SIGKILL.
      expect(elapsed).toBeLessThan(10_000);

      // The pool is genuinely closed, not merely idle.
      await expect(container.db.pool.query('SELECT 1')).rejects.toThrow();
    }, 30_000);

    it('is idempotent and safe to call concurrently', async () => {
      const container = buildContainer({
        role: 'api',
        config: buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url }),
      });

      // Two signals arriving together must both await ONE shutdown, not race two — the
      // second would try to close an already-closed pool and throw during shutdown.
      await expect(
        Promise.all([container.shutdown(), container.shutdown(), container.shutdown()]),
      ).resolves.toBeDefined();

      // And a later call still resolves rather than throwing.
      await expect(container.shutdown()).resolves.toBeUndefined();
    }, 30_000);

    it('survives shutdown when a dependency is already gone', async () => {
      const container = buildContainer({
        role: 'api',
        config: buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url }),
      });

      // Close things out from under it, as an unlucky ordering during a crash would.
      await container.db.close();

      // Shutdown must still complete: one resource failing to close must not abandon the
      // rest, or a stuck socket outlives the database it was waiting on.
      await expect(container.shutdown()).resolves.toBeUndefined();
    }, 30_000);
  });
});
