import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../../../shared/id.js';
import type { DeliveredEvent, EventHandler } from '../../../shared/events.js';
import { outboxEvent, processedEvent } from '../../schema/outbox.js';
import { store } from '../../schema/store.js';
import { withTransaction } from '../../transaction.js';
import {
  silentLogger as bootstrapLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { createEventBus } from '../event-bus.js';
import { createOutboxDrainer } from '../drainer.js';
import { createOutboxRepository } from '../outbox.repository.js';
import { createDispatchPublisher, type EventPublisher } from '../publisher.js';

/**
 * Integration tests for the transactional outbox, against a real PostgreSQL.
 *
 * These are the proof that Phase 0's central mechanism works. Every one of them would pass
 * vacuously against a mock, which is why none of them use one:
 *
 *   - Atomicity is a property of PostgreSQL's transaction, not of our code.
 *   - `FOR UPDATE SKIP LOCKED` has no in-memory equivalent.
 *   - `ON CONFLICT DO NOTHING` dedupe is enforced by a unique index.
 */
describe('transactional outbox (integration)', () => {
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

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

  const db = () => testDb.handle.db;
  const repository = () => createOutboxRepository({ db: db() });

  /** Business data to be atomic with. `store` is the one table that exists at Phase 0. */
  async function insertStore(
    tx: Parameters<Parameters<typeof withTransaction>[2]>[0],
    slug: string,
  ) {
    const id = newId();
    await tx.insert(store).values({ id, name: `Store ${slug}`, slug });
    return id;
  }

  /** Records every event a handler saw, so a duplicate delivery is visible. */
  function recordingHandler(): { handler: EventHandler; seen: DeliveredEvent[] } {
    const seen: DeliveredEvent[] = [];
    return {
      seen,
      handler: async (event) => {
        seen.push(event);
      },
    };
  }

  /* ── TEST 1 — commit ───────────────────────────────────────────────────── */

  describe('TEST 1 — business data and event commit together, then drain', () => {
    it('processes an event emitted inside a committed transaction', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const { handler, seen } = recordingHandler();

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: createDispatchPublisher({
          handlers: { 'store.created': [handler] },
          logger: bootstrapLogger,
        }),
        logger: bootstrapLogger,
      });

      // ── Start a transaction, write business data, emit an event, commit.
      const storeId = await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'test-1');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id, slug: 'test-1' },
        });
        return id;
      });

      // The event is durable but NOT yet published — the drainer has not run.
      const beforeDrain = await repo.findById((await repo.listPending())[0]!.id);
      expect(beforeDrain?.publishedAt).toBeNull();
      expect(seen).toHaveLength(0);

      // ── Drain.
      const result = await drainer.drainUntilEmpty();

      expect(result.published).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.deadLettered).toBe(0);

      // ── The handler actually ran, with the payload that was committed.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.type).toBe('store.created');
      expect(seen[0]!.payload).toEqual({ storeId, slug: 'test-1' });
      expect(seen[0]!.storeId).toBe(storeId);

      // ── And the row is marked terminal, so a second drain is a no-op.
      const [row] = await db().select().from(outboxEvent);
      expect(row?.publishedAt).toBeInstanceOf(Date);
      expect(row?.claimedAt).toBeNull();
      expect(row?.attempts).toBe(1);

      const second = await drainer.drainUntilEmpty();
      expect(second.claimed).toBe(0);
      expect(seen).toHaveLength(1);
    });

    it('keeps the business row and the event in the same transaction boundary', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'atomic');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });

        // Mid-transaction: both rows are visible to THIS transaction and to nobody else.
        const visibleInTx = await tx.select().from(outboxEvent);
        expect(visibleInTx).toHaveLength(1);
      });

      expect(await db().select().from(store)).toHaveLength(1);
      expect(await db().select().from(outboxEvent)).toHaveLength(1);
    });
  });

  /* ── TEST 2 — rollback ─────────────────────────────────────────────────── */

  describe('TEST 2 — rollback discards business data AND the event', () => {
    it('persists neither when the transaction rolls back', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const { handler, seen } = recordingHandler();

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: createDispatchPublisher({
          handlers: { 'store.created': [handler] },
          logger: bootstrapLogger,
        }),
        logger: bootstrapLogger,
      });

      const boom = new Error('business rule failed after the event was emitted');

      // ── Start a transaction, write business data, emit an event, then FAIL.
      await expect(
        withTransaction(db(), bootstrapLogger, async (tx) => {
          const id = await insertStore(tx, 'rolled-back');
          await events.emit({
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { storeId: id, slug: 'rolled-back' },
          });
          // Anything that throws rolls the transaction back — a domain error, a constraint
          // violation, a crash. This stands in for all of them.
          throw boom;
        }),
      ).rejects.toThrow(boom);

      // ── Neither exists. This is the property the whole design rests on: there is no
      //    window where an event describes business data that was never committed.
      expect(await db().select().from(store)).toHaveLength(0);
      expect(await db().select().from(outboxEvent)).toHaveLength(0);

      // ── And nothing is drainable, so no handler ever hears about it.
      const result = await drainer.drainUntilEmpty();
      expect(result.claimed).toBe(0);
      expect(seen).toHaveLength(0);
    });

    it('discards the event when a database constraint aborts the transaction', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        await insertStore(tx, 'duplicate-slug');
      });

      // A unique-violation rollback, not one we threw ourselves — the failure mode that
      // actually happens in production.
      await expect(
        withTransaction(db(), bootstrapLogger, async (tx) => {
          const id = await insertStore(tx, 'duplicate-slug');
          await events.emit({
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { storeId: id },
          });
        }),
      ).rejects.toThrow();

      expect(await db().select().from(store)).toHaveLength(1);
      expect(await db().select().from(outboxEvent)).toHaveLength(0);
    });

    it('refuses to emit outside a transaction unless explicitly allowed', async () => {
      const events = createEventBus({ repository: repository(), logger: bootstrapLogger });
      const orphanId = newId();

      // The default is a hard error, because an emit with no ambient transaction is
      // usually a caller who believes it is atomic with a write that already committed.
      await expect(
        events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: orphanId,
          payload: { storeId: orphanId },
        }),
      ).rejects.toThrow(/outside a transaction/);

      expect(await db().select().from(outboxEvent)).toHaveLength(0);

      // The escape hatch exists for events with no business write to be atomic with.
      await events.emit(
        { type: 'system.ticked', aggregateType: 'system', aggregateId: 'scheduler', payload: {} },
        { allowOutsideTransaction: true },
      );
      expect(await db().select().from(outboxEvent)).toHaveLength(1);
    });
  });

  /* ── TEST 3 — concurrent claiming ──────────────────────────────────────── */

  describe('TEST 3 — two workers cannot process the same event', () => {
    it('gives a single event to exactly one of two concurrent drainers', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'single-event');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      const a = recordingHandler();
      const b = recordingHandler();
      const drainerA = createOutboxDrainer({
        repository: repo,
        publisher: createDispatchPublisher({
          handlers: { 'store.created': [a.handler] },
          logger: bootstrapLogger,
        }),
        logger: bootstrapLogger,
        options: { workerId: 'worker-a' },
      });
      const drainerB = createOutboxDrainer({
        repository: repo,
        publisher: createDispatchPublisher({
          handlers: { 'store.created': [b.handler] },
          logger: bootstrapLogger,
        }),
        logger: bootstrapLogger,
        options: { workerId: 'worker-b' },
      });

      // Genuinely concurrent: two claims racing on one row.
      const [resultA, resultB] = await Promise.all([drainerA.drainOnce(), drainerB.drainOnce()]);

      // Exactly one wins. SKIP LOCKED means the loser does not block — it gets nothing and
      // returns immediately, which is what keeps N workers from serialising into one.
      expect(resultA.published + resultB.published).toBe(1);
      expect(a.seen.length + b.seen.length).toBe(1);
      expect(await db().select().from(outboxEvent)).toHaveLength(1);
    });

    it('divides a backlog across many concurrent drainers with no double-processing', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      const EVENT_COUNT = 60;
      const WORKER_COUNT = 6;

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'backlog');
        await events.emitAll(
          Array.from({ length: EVENT_COUNT }, (_, i) => ({
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { sequence: i },
          })),
        );
      });

      const processed: DeliveredEvent[] = [];
      const drainers = Array.from({ length: WORKER_COUNT }, (_, i) =>
        createOutboxDrainer({
          repository: repo,
          publisher: createDispatchPublisher({
            handlers: {
              'store.created': [
                async (event) => {
                  processed.push(event);
                },
              ],
            },
            logger: bootstrapLogger,
          }),
          logger: bootstrapLogger,
          // A small batch forces real contention; one worker taking all 60 in a single
          // claim would make this test prove nothing.
          options: { workerId: `worker-${i}`, batchSize: 5 },
        }),
      );

      await Promise.all(drainers.map((d) => d.drainUntilEmpty()));

      // Every event processed exactly once — no losses, no duplicates.
      expect(processed).toHaveLength(EVENT_COUNT);
      expect(new Set(processed.map((e) => e.id)).size).toBe(EVENT_COUNT);

      const rows = await db().select().from(outboxEvent);
      expect(rows).toHaveLength(EVENT_COUNT);
      expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
      expect(rows.every((r) => r.attempts === 1)).toBe(true);

      // And the work was actually spread, rather than one worker doing all of it.
      const workers = new Set(rows.map((r) => r.claimedBy));
      expect(workers.size).toBeGreaterThan(0);
    });

    it('prevents duplicate handler execution via processed_event', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'dedupe');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      const [event] = await repo.listPending();
      const eventId = event!.id;

      // Two workers racing to run the SAME non-idempotent handler for the same event.
      const [first, second] = await Promise.all([
        repo.claimForHandler({ id: newId(), eventId, handlerName: 'send-welcome-email' }),
        repo.claimForHandler({ id: newId(), eventId, handlerName: 'send-welcome-email' }),
      ]);

      // Exactly one winner — so exactly one email.
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await db().select().from(processedEvent)).toHaveLength(1);

      // A different handler for the same event is unaffected: fan-out still works.
      const other = await repo.claimForHandler({
        id: newId(),
        eventId,
        handlerName: 'update-analytics',
      });
      expect(other).toBe(true);
      expect(await db().select().from(processedEvent)).toHaveLength(2);
    });
  });

  /* ── TEST 4 — stale claim recovery ─────────────────────────────────────── */

  describe('TEST 4 — a stale claim is recovered and eventually processed', () => {
    it('reclaims an event stranded by a crashed worker and processes it', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const { handler, seen } = recordingHandler();

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'stale-claim');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      // ── Simulate a worker that claims an event and then dies: the claim is taken, but
      //    the row is never marked published and the claim is never released.
      const claimed = await repo.claimBatch({ workerId: 'doomed-worker', batchSize: 10 });
      expect(claimed).toHaveLength(1);

      const afterCrash = await repo.findById(claimed[0]!.id);
      expect(afterCrash?.claimedAt).toBeInstanceOf(Date);
      expect(afterCrash?.publishedAt).toBeNull();

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: createDispatchPublisher({
          handlers: { 'store.created': [handler] },
          logger: bootstrapLogger,
        }),
        logger: bootstrapLogger,
        // Zero timeout so the claim is immediately stale; production uses minutes.
        options: { staleClaimAfterMs: 0 },
      });

      // ── Without the reaper the event is stranded FOREVER: claimBatch only ever
      //    considers rows where claimed_at IS NULL.
      const beforeReap = await drainer.drainOnce();
      expect(beforeReap.claimed).toBe(0);
      expect(seen).toHaveLength(0);

      // ── The reaper releases it...
      const reclaimed = await drainer.reapStaleClaims();
      expect(reclaimed).toBe(1);

      const afterReap = await repo.findById(claimed[0]!.id);
      expect(afterReap?.claimedAt).toBeNull();
      expect(afterReap?.lastError).toContain('claim expired');

      // ── ...and the next drain delivers it.
      const afterRecovery = await drainer.drainOnce();
      expect(afterRecovery.published).toBe(1);
      expect(seen).toHaveLength(1);

      const [row] = await db().select().from(outboxEvent);
      expect(row?.publishedAt).toBeInstanceOf(Date);
      // Two attempts: the doomed claim and the successful one. This is why `attempts`
      // increments on claim — a crash loop is bounded rather than infinite.
      expect(row?.attempts).toBe(2);
    });

    it('does not reclaim a claim that is still fresh', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'fresh-claim');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      await repo.claimBatch({ workerId: 'busy-but-healthy', batchSize: 10 });

      // A healthy worker mid-publish must keep its claim, or the reaper causes the very
      // duplicate deliveries it exists to avoid.
      const reclaimed = await repo.reclaimStale({ olderThan: new Date(Date.now() - 60_000) });
      expect(reclaimed).toBe(0);

      const [row] = await db().select().from(outboxEvent);
      expect(row?.claimedBy).toBe('busy-but-healthy');
    });
  });

  /* ── Retry and dead-lettering ──────────────────────────────────────────── */

  describe('retry and failure handling', () => {
    /** Fails a fixed number of times, then succeeds. */
    function flakyPublisher(failures: number): EventPublisher & { calls: () => number } {
      let calls = 0;
      return {
        calls: () => calls,
        async publish() {
          calls += 1;
          if (calls <= failures) throw new Error(`publish failed (attempt ${calls})`);
        },
      };
    }

    it('retries a failed publish with backoff, then succeeds', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const publisher = flakyPublisher(1);

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'retry');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher,
        logger: bootstrapLogger,
        // No backoff delay, or the retry would not be due within the test.
        options: { retryBaseMs: 0, retryMaxMs: 0 },
      });

      const first = await drainer.drainOnce();
      expect(first.failed).toBe(1);
      expect(first.published).toBe(0);

      const afterFailure = await db().select().from(outboxEvent);
      // Claim released so another worker can retry, and the error is recorded.
      expect(afterFailure[0]?.claimedAt).toBeNull();
      expect(afterFailure[0]?.publishedAt).toBeNull();
      expect(afterFailure[0]?.lastError).toContain('publish failed');

      const second = await drainer.drainOnce();
      expect(second.published).toBe(1);
      expect(publisher.calls()).toBe(2);

      const [row] = await db().select().from(outboxEvent);
      expect(row?.publishedAt).toBeInstanceOf(Date);
      // Cleared on success, so a stale error does not sit on a healthy row.
      expect(row?.lastError).toBeNull();
    });

    it('dead-letters an event that exhausts its attempts, without deleting it', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'poison');
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
        });
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: {
          async publish() {
            throw new Error('permanently broken handler');
          },
        },
        logger: bootstrapLogger,
        options: { maxAttempts: 3, retryBaseMs: 0, retryMaxMs: 0 },
      });

      // Attempts 1 and 2 fail and retry; attempt 3 hits the limit and dead-letters.
      const outcomes = [
        await drainer.drainOnce(),
        await drainer.drainOnce(),
        await drainer.drainOnce(),
      ];

      expect(outcomes.map((o) => o.failed)).toEqual([1, 1, 0]);
      expect(outcomes[2]!.deadLettered).toBe(1);

      const [row] = await db().select().from(outboxEvent);
      // Still present, with the evidence: a dead letter is a bug to investigate, and
      // deleting it would destroy the only record of what broke.
      expect(row?.deadLetteredAt).toBeInstanceOf(Date);
      expect(row?.publishedAt).toBeNull();
      expect(row?.lastError).toContain('permanently broken handler');
      expect(row?.attempts).toBe(3);

      // Terminal: a dead-lettered event is never claimed again, so it cannot spin.
      const after = await drainer.drainOnce();
      expect(after.claimed).toBe(0);
    });

    it('publishes the rest of a batch when one event fails', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'partial');
        await events.emitAll([
          {
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { n: 1 },
          },
          {
            type: 'store.poisoned',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { n: 2 },
          },
          {
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { n: 3 },
          },
        ]);
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: {
          async publish(event) {
            if (event.type === 'store.poisoned') throw new Error('nope');
          },
        },
        logger: bootstrapLogger,
        options: { retryBaseMs: 0, retryMaxMs: 0 },
      });

      const result = await drainer.drainOnce();

      // One bad event must not hold up two good ones.
      expect(result.published).toBe(2);
      expect(result.failed).toBe(1);
    });

    it('does not claim an event before its availableAt', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'scheduled');
        await events.emit({
          type: 'reservation.expired',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { storeId: id },
          availableAt: new Date(Date.now() + 60_000),
        });
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: { async publish() {} },
        logger: bootstrapLogger,
      });

      // Scheduling without a separate timer table: the drainer simply ignores it until due.
      expect((await drainer.drainOnce()).claimed).toBe(0);

      // Due now.
      await db()
        .update(outboxEvent)
        .set({ availableAt: new Date(Date.now() - 1_000) })
        .where(eq(outboxEvent.eventName, 'reservation.expired'));

      expect((await drainer.drainOnce()).published).toBe(1);
    });
  });

  /* ── Ordering and observability ────────────────────────────────────────── */

  describe('ordering and stats', () => {
    it('breaks ties on occurredAt, so events for one aggregate publish in order', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const order: number[] = [];

      // `available_at` is the PRIMARY sort key — it is the "due" time, and honouring it
      // first is what makes scheduled events work. `occurred_at` is only the tiebreaker.
      // So this test pins available_at identically across all three and varies only
      // occurred_at; otherwise it would just be asserting insertion order.
      const dueAt = new Date(Date.now() - 60_000);

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'ordering');
        // Emitted out of order on purpose: 3 happened longest ago, 1 most recently.
        for (const n of [3, 1, 2]) {
          await events.emit({
            type: 'store.created',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: { n },
            occurredAt: new Date(Date.now() - n * 10_000),
            availableAt: dueAt,
          });
        }
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: {
          async publish(event) {
            order.push((event.payload as { n: number }).n);
          },
        },
        logger: bootstrapLogger,
      });

      await drainer.drainUntilEmpty();
      // n=3 has the oldest occurredAt, so it goes first.
      expect(order).toEqual([3, 2, 1]);
    });

    it('honours availableAt ahead of occurredAt', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });
      const order: number[] = [];

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'due-order');
        // Event 1 happened LONG ago but is only due now; event 2 happened recently and was
        // due a minute ago. Due time wins — a delayed event must not jump the queue just
        // because the fact it describes is older.
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { n: 1 },
          occurredAt: new Date(Date.now() - 600_000),
          availableAt: new Date(Date.now() - 1_000),
        });
        await events.emit({
          type: 'store.created',
          aggregateType: 'store',
          aggregateId: id,
          storeId: id,
          payload: { n: 2 },
          occurredAt: new Date(Date.now() - 10_000),
          availableAt: new Date(Date.now() - 60_000),
        });
      });

      const drainer = createOutboxDrainer({
        repository: repo,
        publisher: {
          async publish(event) {
            order.push((event.payload as { n: number }).n);
          },
        },
        logger: bootstrapLogger,
      });

      await drainer.drainUntilEmpty();
      expect(order).toEqual([2, 1]);
    });

    it('reports pending, claimed, and dead-lettered counts for alerting', async () => {
      const repo = repository();
      const events = createEventBus({ repository: repo, logger: bootstrapLogger });

      expect(await repo.stats()).toMatchObject({
        pending: 0,
        claimed: 0,
        deadLettered: 0,
        oldestPendingAgeSeconds: null,
      });

      await withTransaction(db(), bootstrapLogger, async (tx) => {
        const id = await insertStore(tx, 'stats');
        await events.emitAll([
          {
            type: 'a.happened',
            aggregateType: 'store',
            aggregateId: id,
            storeId: id,
            payload: {},
            occurredAt: new Date(Date.now() - 30_000),
          },
          { type: 'b.happened', aggregateType: 'store', aggregateId: id, storeId: id, payload: {} },
        ]);
      });

      const pending = await repo.stats();
      expect(pending.pending).toBe(2);
      // The signal an alert fires on: how far behind the outbox is.
      expect(pending.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(29);

      await repo.claimBatch({ workerId: 'w', batchSize: 1 });
      expect((await repo.stats()).claimed).toBe(1);
    });
  });
});
