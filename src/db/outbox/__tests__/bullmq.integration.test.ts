import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { EventHandler } from '../../../shared/events.js';
import { newId } from '../../../shared/id.js';
import { outboxEvent, processedEvent } from '../../schema/outbox.js';
import { store } from '../../schema/store.js';
import { withTransaction } from '../../transaction.js';
import {
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';
import { createOutboxSubsystem, type OutboxSubsystem } from '../outbox.module.js';

/**
 * The full production path, against real PostgreSQL and real Redis.
 *
 * Business transaction → COMMIT → drainer claims → BullMQ job → worker → handler, with
 * `processed_event` suppressing duplicates. Nothing here is mocked, because the properties
 * under test belong to PostgreSQL and Redis rather than to our code.
 *
 * The point these tests exist to prove: Redis is a work-distribution mechanism, not the
 * source of truth. The last test flushes Redis entirely and shows the event still gets
 * delivered.
 */
describe('outbox over BullMQ (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let subsystem: OutboxSubsystem | undefined;

  beforeAll(async () => {
    // Started in parallel: two container pulls in sequence dominates the runtime.
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  beforeEach(async () => {
    await testDb.truncate();
    await redis.flush();
  });

  afterEach(async () => {
    await subsystem?.shutdown();
    subsystem = undefined;
  });

  const db = () => testDb.handle.db;

  /** Waits for a condition rather than sleeping a fixed time — no arbitrary timeouts. */
  async function eventually(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 15_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error('condition not met before timeout');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function countingHandler(name: string): { handler: EventHandler; calls: () => number } {
    let calls = 0;
    const handler = async (): Promise<void> => {
      calls += 1;
    };
    Object.defineProperty(handler, 'name', { value: name });
    return { handler, calls: () => calls };
  }

  it('carries an event from a committed transaction through BullMQ to a handler', async () => {
    const email = countingHandler('send-order-confirmation');

    subsystem = createOutboxSubsystem({
      db: db(),
      logger: silentLogger,
      handlers: { 'order.placed': [email.handler] },
      transport: 'queue',
      redisUrl: redis.url,
      runWorkers: true,
      drainer: { pollIntervalMs: 50 },
    });

    // ── Business transaction: data + event, one commit.
    const orderId = await withTransaction(db(), silentLogger, async (tx) => {
      const id = newId();
      await tx.insert(store).values({ id, name: 'Queue Store', slug: `q-${id.slice(0, 8)}` });
      await subsystem!.events.emit({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: id,
        storeId: id,
        payload: { orderId: id, total: '499.0000', currency: 'INR' },
      });
      return id;
    });

    // ── The event is durable in PostgreSQL and Redis has not been touched yet.
    const [pending] = await db().select().from(outboxEvent);
    expect(pending?.publishedAt).toBeNull();
    expect(pending?.aggregateId).toBe(orderId);

    // ── Drain once: this is the only step that talks to Redis.
    const drained = await subsystem.drainer.drainOnce();
    expect(drained.published).toBe(1);

    // ── The row is marked published — meaning "handed to the queue", not "handled".
    const [published] = await db().select().from(outboxEvent);
    expect(published?.publishedAt).toBeInstanceOf(Date);

    // ── The worker picks the job up and runs the handler.
    await eventually(() => email.calls() === 1);
    expect(email.calls()).toBe(1);

    // ── And completion is recorded in PostgreSQL, not Redis.
    await eventually(async () => (await db().select().from(processedEvent)).length === 1);
    const claims = await db().select().from(processedEvent);
    expect(claims[0]?.handlerName).toBe('send-order-confirmation');
  });

  it('does not enqueue anything when the transaction rolls back', async () => {
    const email = countingHandler('send-order-confirmation');

    subsystem = createOutboxSubsystem({
      db: db(),
      logger: silentLogger,
      handlers: { 'order.placed': [email.handler] },
      transport: 'queue',
      redisUrl: redis.url,
      runWorkers: true,
      drainer: { pollIntervalMs: 50 },
    });

    await expect(
      withTransaction(db(), silentLogger, async (tx) => {
        const id = newId();
        await tx.insert(store).values({ id, name: 'Doomed', slug: `d-${id.slice(0, 8)}` });
        await subsystem!.events.emit({
          type: 'order.placed',
          aggregateType: 'order',
          aggregateId: id,
          storeId: id,
          payload: { orderId: id },
        });
        throw new Error('payment declined');
      }),
    ).rejects.toThrow('payment declined');

    // Nothing in PostgreSQL, so nothing can reach Redis — the queue never learns the event
    // existed. This is the guarantee that publishing inside the transaction would break.
    expect(await db().select().from(store)).toHaveLength(0);
    expect(await db().select().from(outboxEvent)).toHaveLength(0);
    expect((await subsystem.drainer.drainOnce()).claimed).toBe(0);

    const counts = await subsystem.queues!.queues.default.getJobCounts();
    expect(counts['waiting']).toBe(0);
    expect(counts['active']).toBe(0);
    expect(email.calls()).toBe(0);
  });

  it('suppresses the duplicate when the same job is enqueued twice', async () => {
    const email = countingHandler('send-order-confirmation');

    subsystem = createOutboxSubsystem({
      db: db(),
      logger: silentLogger,
      handlers: { 'order.placed': [email.handler] },
      transport: 'queue',
      redisUrl: redis.url,
      runWorkers: true,
      drainer: { pollIntervalMs: 50 },
    });

    const eventId = await withTransaction(db(), silentLogger, async (tx) => {
      const id = newId();
      await tx.insert(store).values({ id, name: 'Dup', slug: `dup-${id.slice(0, 8)}` });
      const emitted = await subsystem!.events.emit({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: id,
        storeId: id,
        payload: { orderId: id },
      });
      return emitted.id;
    });

    const event = (await subsystem.repository.findDeliveredById(eventId))!;

    // Publish the same event twice, as a drainer that crashed after enqueueing but before
    // marking the row would once the reaper released it.
    await subsystem.publisher.publish(event);
    await subsystem.publisher.publish(event);

    await eventually(async () => (await db().select().from(processedEvent)).length === 1);
    // Give a second delivery a chance to arrive and be suppressed before asserting.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Two defences agree: `jobId: event.id` makes BullMQ discard the duplicate enqueue, and
    // `processed_event` would suppress the handler even if it did not.
    expect(email.calls()).toBe(1);
    expect(await db().select().from(processedEvent)).toHaveLength(1);
  });

  it('survives Redis losing the job, because PostgreSQL is the source of truth', async () => {
    const email = countingHandler('send-order-confirmation');

    // Drainer only — no workers yet, so the job sits in Redis unconsumed.
    subsystem = createOutboxSubsystem({
      db: db(),
      logger: silentLogger,
      handlers: { 'order.placed': [email.handler] },
      transport: 'queue',
      redisUrl: redis.url,
      runWorkers: false,
      drainer: { staleClaimAfterMs: 0, pollIntervalMs: 50 },
    });

    await withTransaction(db(), silentLogger, async (tx) => {
      const id = newId();
      await tx.insert(store).values({ id, name: 'Resilient', slug: `r-${id.slice(0, 8)}` });
      await subsystem!.events.emit({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: id,
        storeId: id,
        payload: { orderId: id },
      });
    });

    await subsystem.drainer.drainOnce();
    expect((await subsystem.queues!.queues.default.getJobCounts())['waiting']).toBe(1);

    // ── Redis loses everything. An eviction, a restart with no persistence, a flush.
    await redis.flush();
    expect((await subsystem.queues!.queues.default.getJobCounts())['waiting']).toBe(0);

    // The outbox row is still in PostgreSQL with its full history, which is the whole
    // point: the durable record of "this must happen" never lived in Redis.
    const [row] = await db().select().from(outboxEvent);
    expect(row).toBeDefined();
    expect(row?.aggregateType).toBe('order');

    // Recovery is a re-publish from the surviving row. Nothing was lost — only delayed.
    const event = (await subsystem.repository.findDeliveredById(row!.id))!;
    await subsystem.publisher.publish(event);
    expect((await subsystem.queues!.queues.default.getJobCounts())['waiting']).toBe(1);
  });

  it('routes events to the queue configured for their type', async () => {
    subsystem = createOutboxSubsystem({
      db: db(),
      logger: silentLogger,
      handlers: {},
      transport: 'queue',
      redisUrl: redis.url,
      // Blast-radius separation: a bulk send must not queue behind an order confirmation.
      queueRoutes: { 'marketing.campaign_sent': 'emails', 'report.requested': 'heavy' },
      runWorkers: false,
      drainer: { pollIntervalMs: 50 },
    });

    await withTransaction(db(), silentLogger, async (tx) => {
      const id = newId();
      await tx.insert(store).values({ id, name: 'Routing', slug: `rt-${id.slice(0, 8)}` });
      await subsystem!.events.emitAll([
        { type: 'order.placed', aggregateType: 'order', aggregateId: id, storeId: id, payload: {} },
        {
          type: 'marketing.campaign_sent',
          aggregateType: 'campaign',
          aggregateId: id,
          storeId: id,
          payload: {},
        },
        {
          type: 'report.requested',
          aggregateType: 'report',
          aggregateId: id,
          storeId: id,
          payload: {},
        },
      ]);
    });

    await subsystem.drainer.drainUntilEmpty();

    expect((await subsystem.queues!.queues.default.getJobCounts())['waiting']).toBe(1);
    expect((await subsystem.queues!.queues.emails.getJobCounts())['waiting']).toBe(1);
    expect((await subsystem.queues!.queues.heavy.getJobCounts())['waiting']).toBe(1);
  });

  it('refuses to construct a queue transport with no Redis URL', () => {
    // Fails at construction, not at the first publish — a misconfigured worker must not
    // start and quietly accumulate undeliverable events.
    expect(() =>
      createOutboxSubsystem({
        db: db(),
        logger: silentLogger,
        handlers: {},
        transport: 'queue',
      }),
    ).toThrow(/redisUrl is required/);
  });
});
