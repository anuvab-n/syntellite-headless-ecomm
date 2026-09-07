import type { DeliveredEvent, EventHandler } from '../../shared/events.js';
import { runWithContext } from '../../shared/context.js';
import type { Logger } from '../../shared/logger.js';

/**
 * Where a drained event goes next.
 *
 * The drainer owns claiming, retrying, and reaping; the publisher owns delivery. Keeping
 * them separate means the locking logic can be tested against a real PostgreSQL without
 * also standing up Redis, and it is the seam that lets the queue be swapped (BullMQ today,
 * SQS if durability ever matters more than latency) without touching the parts that are
 * hard to get right.
 *
 * A publisher MUST throw on failure. A silent failure marks the event published and loses
 * it permanently — the exact outcome the outbox exists to prevent.
 */
export type EventPublisher = {
  publish(event: DeliveredEvent): Promise<void>;
  /** Optional teardown, for publishers holding a connection. */
  close?: () => Promise<void>;
};

/* ── In-process dispatch ─────────────────────────────────────────────────── */

export type HandlerRegistry = Readonly<Record<string, readonly EventHandler[]>>;

/**
 * Runs handlers in this process, immediately.
 *
 * Used by the integration tests, and viable for local development where running a separate
 * worker is friction with no benefit. NOT for production: a handler that throws here is
 * retried by the outbox rather than by a queue with per-job backoff and a visible dead
 * letter, and slow handlers block the drain loop.
 *
 * All handlers for an event run, and their failures are aggregated, so one broken
 * subscriber does not silently prevent the others from ever running.
 */
export function createDispatchPublisher(deps: {
  handlers: HandlerRegistry;
  logger: Logger;
}): EventPublisher {
  const { handlers, logger } = deps;

  return {
    async publish(event) {
      const registered = handlers[event.type] ?? [];

      if (registered.length === 0) {
        // Not an error. Events are published for whoever cares, and "nobody yet" is a
        // legitimate state — a new event usually lands before its first subscriber.
        logger.debug({ eventName: event.type, eventId: event.id }, 'event_no_handlers');
        return;
      }

      // Re-enter the originating request's context so handler logs carry the same
      // requestId as the HTTP request that caused the event, across the async boundary.
      await runWithContext(
        {
          requestId: event.requestId ?? event.id,
          ...(event.storeId !== null ? { storeId: event.storeId } : {}),
          startedAt: Date.now(),
          jobName: event.type,
        },
        async () => {
          const failures: unknown[] = [];

          for (const handler of registered) {
            try {
              await handler(event);
            } catch (err) {
              // Collected rather than rethrown immediately: the remaining handlers are
              // independent subscribers and deserve their turn.
              failures.push(err);
              logger.error(
                { err, eventId: event.id, eventName: event.type },
                'event_handler_failed',
              );
            }
          }

          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              `${failures.length} of ${registered.length} handler(s) failed for ${event.type}`,
            );
          }
        },
      );
    },
  };
}

/* ── Queue ───────────────────────────────────────────────────────────────── */

// The real BullMQ publisher lives in ./queues.ts, alongside the queue and worker
// construction it depends on. Deliberately NOT duplicated here behind a hand-rolled
// QueueLike interface: one publisher, one place, using the real BullMQ types.
