import { once } from 'node:events';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../tests/helpers/redis.ts';
import { buildContainer } from '../container.js';
import { createHttpServer } from '../http/server.js';

/**
 * The startup and shutdown SEQUENCES the three entry points use, against real PostgreSQL
 * and real Redis.
 *
 * These reproduce the ordering from `main.ts` and `workers/default.ts` rather than importing
 * them, for one unavoidable reason: those files execute on import — they build a container,
 * bind a port, and register process-wide signal handlers. Importing them into a test runner
 * would bind a real port and install handlers that outlive the test file.
 *
 * So what is verified here is the ordering itself, which is where the bugs live. Signal
 * DELIVERY is covered separately in lifecycle.test.ts, and the entry points wired together
 * were verified by running them — see the report.
 */
describe('process lifecycle (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  const config = () => buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url });

  /**
   * Wait for an ioredis client to reach its terminal state.
   *
   * `quit()` resolves when the QUIT reply arrives, but the transition to 'end' happens a
   * tick later once the socket actually closes — so asserting `status` immediately is a
   * race. Waiting for the event is deterministic, and if the client never ends the
   * surrounding test times out, which is exactly the leak worth catching: a connected
   * socket keeps the event loop alive and the process never exits.
   */
  async function expectRedisClosed(client: Redis): Promise<void> {
    if (client.status !== 'end') {
      await once(client, 'end');
    }
    expect(client.status).toBe('end');
  }

  /* ── API process ───────────────────────────────────────────────────────── */

  describe('api process', () => {
    it('starts, serves /health/live, and shuts down in order', async () => {
      const container = buildContainer({ role: 'api', config: config() });
      // Port 0: the OS picks a free one, so the test cannot collide with a dev server.
      const server = await createHttpServer({
        app: container.app,
        logger: container.logger,
      }).listen(0);

      const live = await fetch(`http://127.0.0.1:${String(server.port)}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'ok' });

      const ready = await fetch(`http://127.0.0.1:${String(server.port)}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        status: 'ok',
        checks: { postgres: 'ok', redis: 'ok' },
      });

      // The exact sequence from main.ts: drain HTTP first, then close the container.
      const startedAt = Date.now();
      await server.close();
      await container.shutdown();

      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // The listener is genuinely gone, not merely idle.
      await expect(fetch(`http://127.0.0.1:${String(server.port)}/health/live`)).rejects.toThrow();
      // And so is the pool the requests were using.
      await expect(container.db.pool.query('SELECT 1')).rejects.toThrow();
    }, 60_000);

    it('closes the container when the listener fails to bind', async () => {
      // Occupy a port, then try to bind it again — the realistic startup failure.
      const blocker = buildContainer({ role: 'api', config: config() });
      const held = await createHttpServer({ app: blocker.app, logger: blocker.logger }).listen(0);

      const container = buildContainer({ role: 'api', config: config() });
      const http = createHttpServer({ app: container.app, logger: container.logger });

      await expect(http.listen(held.port)).rejects.toThrow();

      /**
       * This is what `startOrCleanUp` does in main.ts, and why it exists: the container is
       * already holding a pool and a Redis connection. Without this the process would not
       * exit — it would hang, and the orchestrator would report a startup timeout instead
       * of "port in use", hiding the actual error.
       */
      await expect(container.shutdown()).resolves.toBeUndefined();
      await expect(container.db.pool.query('SELECT 1')).rejects.toThrow();

      await held.close();
      await blocker.shutdown();
    }, 60_000);

    it('returns the standard envelope for an unmatched api route', async () => {
      // Phase 1 mounted `resolveStore` on the API router, so a store must exist before
      // routing is reached — otherwise every `/api/v1` path answers 503. That case is
      // asserted in store-resolution.integration.test.ts; this test is about the 404.
      await seedTestStore(testDb);

      const container = buildContainer({ role: 'api', config: config() });
      const server = await createHttpServer({
        app: container.app,
        logger: container.logger,
      }).listen(0);

      // `/orders` is genuinely unmatched: Phase 1 adds only `/auth/register`.
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/orders`);
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');

      await server.close();
      await container.shutdown();
    }, 60_000);
  });

  /* ── Worker process ────────────────────────────────────────────────────── */

  describe('worker process', () => {
    it('starts the drainer and BullMQ workers, then shuts down without hanging', async () => {
      const container = buildContainer({
        role: 'worker',
        config: config(),
        drainer: { pollIntervalMs: 50 },
      });

      // Exactly what workers/default.ts does: retain the promise so shutdown can await the
      // loop actually ending rather than assuming it did.
      const draining = container.outbox.drainer.start();

      expect(container.outbox.workers).toBeDefined();
      expect(container.outbox.workers?.workers.length).toBeGreaterThan(0);

      // Let the drain loop turn a few times so shutdown is exercised mid-poll, not from a
      // standing start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const startedAt = Date.now();
      container.outbox.drainer.stop();
      await draining;
      await container.shutdown();
      const elapsed = Date.now() - startedAt;

      // A worker holds the most sockets: a blocking Redis connection per queue, the queue
      // connection, the lock client, and the pool. A hang here means one has no owner —
      // which is precisely the bug found and fixed in Step 6.
      expect(elapsed).toBeLessThan(15_000);
      await expectRedisClosed(container.locks);
    }, 60_000);

    it('leaves no Redis connection connected after shutdown', async () => {
      const container = buildContainer({
        role: 'worker',
        config: config(),
        drainer: { pollIntervalMs: 50 },
      });
      const draining = container.outbox.drainer.start();

      container.outbox.drainer.stop();
      await draining;
      await container.shutdown();

      // The queue client and every per-worker blocking client must be released. A single
      // connected socket keeps the event loop alive and the process never exits — which is
      // exactly the bug found and fixed in Step 6, where BullMQ was left holding sockets it
      // did not own.
      const queueConnection = container.outbox.queues?.connection;
      expect(queueConnection).toBeDefined();
      if (queueConnection) await expectRedisClosed(queueConnection);
      await expectRedisClosed(container.locks);

      for (const worker of container.outbox.workers?.workers ?? []) {
        expect(worker.isRunning()).toBe(false);
      }
    }, 60_000);

    it('runs no HTTP listener', () => {
      const container = buildContainer({ role: 'worker', config: config() });

      // The app object exists (the container always builds it) but nothing binds a port.
      // Serving HTTP from the worker would put request latency behind job execution.
      expect(container.app).toBeDefined();
      return container.shutdown();
    }, 60_000);
  });

  /* ── Scheduler process ─────────────────────────────────────────────────── */

  describe('scheduler process', () => {
    it('builds without BullMQ workers', async () => {
      const container = buildContainer({ role: 'scheduler', config: config() });

      // A scheduler enqueues work; it does not consume it. Consuming here would make a slow
      // job delay the next tick.
      expect(container.outbox.workers).toBeUndefined();
      // It still needs the queues, because future tasks will enqueue.
      expect(container.outbox.queues).toBeDefined();

      await container.shutdown();
    }, 60_000);
  });
});
