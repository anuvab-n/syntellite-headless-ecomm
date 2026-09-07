import type { DomainEvent, EmitOptions, EmittedEvent, EventBus } from '../../shared/events.js';
import { getContext } from '../../shared/context.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { isInTransaction } from '../transaction.js';
import type { InsertOutboxEvent, OutboxRepository } from './outbox.repository.js';

/**
 * The event bus.
 *
 * `emit` writes a row to `outbox_event` and does nothing else. No queue call, no HTTP call,
 * no side effect. The write joins the caller's open transaction, which gives the property
 * the whole design rests on:
 *
 *   BEGIN
 *     insert order          ─┐
 *     insert outbox_event   ─┴─ same transaction
 *   COMMIT                      → both durable, drainer will publish
 *   ROLLBACK                    → neither exists, nothing is published
 *
 * There is no window in which an event exists for business data that does not, or business
 * data exists with a lost event. That is the entire point, and it is why `emit` must never
 * open a transaction of its own.
 */
export function createEventBus(deps: { repository: OutboxRepository; logger: Logger }): EventBus {
  const { repository, logger } = deps;

  function prepare(event: DomainEvent, now: Date): InsertOutboxEvent {
    const context = getContext();
    return {
      id: newId(),
      // Fall back to the ambient request context so a caller inside a store-scoped request
      // does not have to thread `storeId` through every layer to emit an event.
      storeId: event.storeId ?? context?.storeId ?? null,
      eventName: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      // Carried so a handler's logs, running minutes later on another process, correlate
      // back to the request that caused the event.
      requestId: context?.requestId ?? null,
      occurredAt: event.occurredAt ?? now,
      availableAt: event.availableAt ?? now,
    };
  }

  function assertTransaction(options: EmitOptions | undefined, count: number): void {
    if (options?.allowOutsideTransaction === true) return;
    if (isInTransaction()) return;
    throw new Error(
      `EventBus.emit() called outside a transaction (${count} event(s)). The outbox only ` +
        'guarantees atomicity when the event is written by the same transaction as the ' +
        'business change it describes. Wrap the work in withTransaction(), or pass ' +
        '{ allowOutsideTransaction: true } if this event genuinely has no business write ' +
        'to be atomic with.',
    );
  }

  async function emitAll(
    events: readonly DomainEvent[],
    options?: EmitOptions,
  ): Promise<EmittedEvent[]> {
    if (events.length === 0) return [];
    assertTransaction(options, events.length);

    // One `now` for the whole batch, so events emitted together sort deterministically
    // rather than by microsecond clock jitter.
    const now = new Date();
    const rows = events.map((event) => prepare(event, now));

    await repository.insert(rows);

    // Debug, not info: at one line per event this is the highest-volume log in the system.
    // The published-side log in the drainer is the one worth keeping at info.
    logger.debug(
      {
        events: rows.map((r) => ({
          id: r.id,
          type: r.eventName,
          aggregate: `${r.aggregateType}:${r.aggregateId}`,
        })),
      },
      'events_emitted',
    );

    return rows.map((r) => ({
      id: r.id,
      type: r.eventName,
      aggregateType: r.aggregateType,
      aggregateId: r.aggregateId,
      occurredAt: r.occurredAt,
    }));
  }

  return {
    async emit(event, options) {
      const [emitted] = await emitAll([event], options);
      // `emitAll` returns exactly one row for one input event.
      return emitted!;
    },
    emitAll,
  };
}
