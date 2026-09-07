import { runWithContext } from '../../shared/context.js';
import type { DeliveredEvent, EventHandler } from '../../shared/events.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import type { Database } from '../client.js';
import { withTransaction } from '../transaction.js';
import type { OutboxRepository } from './outbox.repository.js';
import type { EventPublisher, HandlerRegistry } from './publisher.js';

/**
 * Idempotent handler dispatch — where `processed_event` earns its keep.
 *
 * Outbox delivery is at-least-once, so every handler WILL occasionally see the same event
 * twice: a worker crash after the side effect but before the ack is enough, and so is a
 * stale-claim reclaim of a worker that was merely slow. For a handler that sends an email
 * or credits a wallet, "twice" is a real defect.
 *
 * The mechanism, and the ordering matters:
 *
 *   BEGIN
 *     INSERT processed_event (event_id, handler_name)   ← unique index; loser gets nothing
 *     run the handler                                    ← its DB writes join this tx
 *   COMMIT
 *
 * Three properties fall out of that shape:
 *
 *  1. Two workers racing the same event: exactly one wins the INSERT, so the side effect
 *     happens once. The loser skips.
 *  2. A handler that THROWS rolls back its own claim along with its writes, so the event
 *     is retried later. Claiming outside the transaction would mark it done forever and
 *     silently drop the work — the single easiest way to get this wrong.
 *  3. A handler whose effect is entirely in PostgreSQL gets genuine exactly-once.
 *
 * The honest limit: an EXTERNAL side effect cannot be transactional. If a handler sends an
 * email and then the commit fails, the email is out and the claim is gone, so the retry
 * sends a second one. Handlers with external effects should therefore be idempotent at the
 * provider (an idempotency key on the send) — the claim narrows the window, it does not
 * abolish it.
 */

export type Dispatcher = {
  dispatch(event: DeliveredEvent): Promise<void>;
};

export function createIdempotentDispatcher(deps: {
  db: Database;
  repository: OutboxRepository;
  handlers: HandlerRegistry;
  logger: Logger;
}): Dispatcher {
  const { db, repository, handlers, logger } = deps;

  /** Stable, and persisted. Renaming a handler makes every past event look unprocessed. */
  function handlerName(eventType: string, index: number, handler: EventHandler): string {
    return handler.name !== '' ? handler.name : `${eventType}#${index}`;
  }

  async function runOne(event: DeliveredEvent, name: string, handler: EventHandler): Promise<void> {
    await withTransaction(db, logger, async () => {
      const won = await repository.claimForHandler({
        id: newId(),
        eventId: event.id,
        handlerName: name,
      });

      if (!won) {
        // Already done by a previous delivery or a concurrent worker. Not an error — this
        // is the mechanism working, and it is expected traffic under retries.
        logger.debug({ eventId: event.id, handler: name }, 'event_handler_skipped_duplicate');
        return;
      }

      // Inside the same transaction as the claim: a throw here releases the claim.
      await handler(event);
      logger.debug({ eventId: event.id, handler: name }, 'event_handler_completed');
    });
  }

  return {
    async dispatch(event) {
      const registered = handlers[event.type] ?? [];

      if (registered.length === 0) {
        // Legitimate: an event type usually lands before its first subscriber does.
        logger.debug({ eventType: event.type, eventId: event.id }, 'event_no_handlers');
        return;
      }

      // Re-enter the originating request's context so handler logs carry the same
      // requestId as the HTTP request that caused the event, minutes and processes later.
      await runWithContext(
        {
          requestId: event.requestId ?? event.id,
          ...(event.storeId !== null ? { storeId: event.storeId } : {}),
          startedAt: Date.now(),
          jobName: event.type,
        },
        async () => {
          const failures: unknown[] = [];

          for (const [index, handler] of registered.entries()) {
            const name = handlerName(event.type, index, handler);
            try {
              await runOne(event, name, handler);
            } catch (err) {
              // Collected, not rethrown immediately: the remaining handlers are
              // independent subscribers and one broken one must not starve the others.
              // Each has its own claim, so only the failed one is retried.
              failures.push(err);
              logger.error(
                { err, eventId: event.id, eventType: event.type, handler: name },
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

/**
 * Wraps the idempotent dispatcher as an {@link EventPublisher} so it can be handed
 * straight to the drainer.
 *
 * This is the in-process path: the drainer claims an event and runs its handlers itself,
 * with no queue involved. Correct and fully idempotent, and the right choice for local
 * development and for tests. In production the queue path is preferred, because a slow
 * handler here blocks the drain loop.
 */
export function createIdempotentDispatchPublisher(deps: {
  db: Database;
  repository: OutboxRepository;
  handlers: HandlerRegistry;
  logger: Logger;
}): EventPublisher {
  const dispatcher = createIdempotentDispatcher(deps);
  return {
    publish: (event) => dispatcher.dispatch(event),
  };
}
