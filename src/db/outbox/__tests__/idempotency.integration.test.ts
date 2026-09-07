import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DeliveredEvent, EventHandler } from '../../../shared/events.js';
import { newId } from '../../../shared/id.js';
import { processedEvent } from '../../schema/outbox.js';
import { store } from '../../schema/store.js';
import { withTransaction } from '../../transaction.js';
import {
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { createIdempotentDispatcher } from '../dispatcher.js';
import { createOutboxDrainer } from '../drainer.js';
import { createEventBus } from '../event-bus.js';
import { createOutboxRepository } from '../outbox.repository.js';
import { createIdempotentDispatchPublisher } from '../dispatcher.js';

/**
 * TEST 4 — idempotency, end to end.
 *
 * The outbox delivers at-least-once, so the question is not "can an event arrive twice"
 * (it can, and will) but "does the business side effect happen twice". These tests
 * deliberately deliver the same event repeatedly and count the side effect.
 */
describe('handler idempotency (integration)', () => {
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
  const repository = () => createOutboxRepository({ db: db() });

  /** Counts invocations — this stands in for "an email was sent". */
  function countingHandler(name: string): { handler: EventHandler; calls: () => number } {
    let calls = 0;
    const handler = async (_event: DeliveredEvent): Promise<void> => {
      calls += 1;
    };
    // Named, because the handler name is what `processed_event` keys on.
    Object.defineProperty(handler, 'name', { value: name });
    return { handler, calls: () => calls };
  }

  async function emitOneEvent(): Promise<string> {
    const events = createEventBus({ repository: repository(), logger: silentLogger });
    return withTransaction(db(), silentLogger, async (tx) => {
      const id = newId();
      await tx.insert(store).values({ id, name: 'Idempotency', slug: `s-${id.slice(0, 8)}` });
      const emitted = await events.emit({
        type: 'order.placed',
        aggregateType: 'order',
        aggregateId: id,
        storeId: id,
        payload: { orderId: id },
      });
      return emitted.id;
    });
  }

  it('runs the side effect once when the same event is dispatched twice', async () => {
    const repo = repository();
    const eventId = await emitOneEvent();
    const email = countingHandler('send-order-confirmation');

    const dispatcher = createIdempotentDispatcher({
      db: db(),
      repository: repo,
      handlers: { 'order.placed': [email.handler] },
      logger: silentLogger,
    });

    const event = await repo.findDeliveredById(eventId);
    expect(event).toBeDefined();

    // Deliver the SAME event three times, as an at-least-once queue eventually will.
    await dispatcher.dispatch(event!);
    await dispatcher.dispatch(event!);
    await dispatcher.dispatch(event!);

    // One email, not three.
    expect(email.calls()).toBe(1);
    expect(await db().select().from(processedEvent)).toHaveLength(1);
  });

  it('runs the side effect once when two workers dispatch concurrently', async () => {
    const repo = repository();
    const eventId = await emitOneEvent();
    let calls = 0;

    const handler = async (): Promise<void> => {
      // Yield inside the handler so the two transactions genuinely overlap rather than
      // running back to back — without this the test could pass by accident.
      await new Promise((resolve) => setTimeout(resolve, 25));
      calls += 1;
    };
    Object.defineProperty(handler, 'name', { value: 'credit-wallet' });

    const makeDispatcher = () =>
      createIdempotentDispatcher({
        db: db(),
        repository: repo,
        handlers: { 'order.placed': [handler] },
        logger: silentLogger,
      });

    const event = (await repo.findDeliveredById(eventId))!;

    await Promise.all([
      makeDispatcher().dispatch(event),
      makeDispatcher().dispatch(event),
      makeDispatcher().dispatch(event),
    ]);

    // The unique index on (event_id, handler_name) is what makes this one, not three.
    expect(calls).toBe(1);
    expect(await db().select().from(processedEvent)).toHaveLength(1);
  });

  it('releases the claim when a handler fails, so the retry actually reruns it', async () => {
    const repo = repository();
    const eventId = await emitOneEvent();

    let attempts = 0;
    const handler = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient downstream failure');
    };
    Object.defineProperty(handler, 'name', { value: 'flaky-handler' });

    const dispatcher = createIdempotentDispatcher({
      db: db(),
      repository: repo,
      handlers: { 'order.placed': [handler] },
      logger: silentLogger,
    });

    const event = (await repo.findDeliveredById(eventId))!;

    // First delivery fails.
    await expect(dispatcher.dispatch(event)).rejects.toThrow();

    // THE CRITICAL ASSERTION. The claim was inserted before the handler ran, so if it were
    // committed independently the event would be marked done forever and the work silently
    // lost. Because claim and handler share one transaction, the rollback took the claim
    // with it.
    expect(await db().select().from(processedEvent)).toHaveLength(0);

    // So the retry genuinely reruns the handler...
    await dispatcher.dispatch(event);
    expect(attempts).toBe(2);

    // ...and now it is recorded, so a third delivery is suppressed.
    expect(await db().select().from(processedEvent)).toHaveLength(1);
    await dispatcher.dispatch(event);
    expect(attempts).toBe(2);
  });

  it('keeps handler claims independent, so one failure does not suppress the others', async () => {
    const repo = repository();
    const eventId = await emitOneEvent();

    const good = countingHandler('update-analytics');
    let badAttempts = 0;
    const bad = async (): Promise<void> => {
      badAttempts += 1;
      throw new Error('this handler is broken');
    };
    Object.defineProperty(bad, 'name', { value: 'broken-handler' });

    const dispatcher = createIdempotentDispatcher({
      db: db(),
      repository: repo,
      handlers: { 'order.placed': [good.handler, bad] },
      logger: silentLogger,
    });

    const event = (await repo.findDeliveredById(eventId))!;

    await expect(dispatcher.dispatch(event)).rejects.toThrow(AggregateError);

    // The good handler ran and is recorded; the broken one is not.
    expect(good.calls()).toBe(1);
    const claims = await db().select().from(processedEvent);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.handlerName).toBe('update-analytics');

    // On retry only the broken handler runs again — the good one is not repeated.
    await expect(dispatcher.dispatch(event)).rejects.toThrow(AggregateError);
    expect(good.calls()).toBe(1);
    expect(badAttempts).toBe(2);
  });

  it('suppresses duplicates across a full drain, including a reaped stale claim', async () => {
    const repo = repository();
    await emitOneEvent();
    const email = countingHandler('send-order-confirmation');

    const drainer = createOutboxDrainer({
      repository: repo,
      publisher: createIdempotentDispatchPublisher({
        db: db(),
        repository: repo,
        handlers: { 'order.placed': [email.handler] },
        logger: silentLogger,
      }),
      logger: silentLogger,
      options: { staleClaimAfterMs: 0 },
    });

    // A worker claims the event and "crashes" without marking it.
    const claimed = await repo.claimBatch({ workerId: 'doomed', batchSize: 10 });
    expect(claimed).toHaveLength(1);

    // The reaper releases it and the next drain delivers it.
    expect(await drainer.reapStaleClaims()).toBe(1);
    expect((await drainer.drainOnce()).published).toBe(1);

    // Reaping is the main source of genuine duplicate delivery in this design — a worker
    // that was merely slow gets its work reclaimed and done twice. `processed_event` is
    // what makes that harmless.
    expect(email.calls()).toBe(1);
    expect(await db().select().from(processedEvent)).toHaveLength(1);
  });
});
