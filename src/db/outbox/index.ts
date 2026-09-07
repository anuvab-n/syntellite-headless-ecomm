/**
 * The outbox module's public surface.
 *
 * Application and domain code should only ever need `EventBus` (from `shared/events.ts`)
 * and, for non-idempotent handlers, `claimForHandler` on the repository. The drainer and
 * publishers are wired once in the composition root and never referenced from a module.
 */

export { createEventBus } from './event-bus.js';
export {
  createOutboxRepository,
  type InsertOutboxEvent,
  type OutboxRepository,
  type OutboxStats,
} from './outbox.repository.js';
export { createDispatchPublisher, type EventPublisher, type HandlerRegistry } from './publisher.js';
export {
  createIdempotentDispatcher,
  createIdempotentDispatchPublisher,
  type Dispatcher,
} from './dispatcher.js';
export {
  createEventQueues,
  createEventWorkers,
  createQueueEventPublisher,
  QUEUE_NAMES,
  type EventQueues,
  type EventWorkers,
  type QueueName,
  type QueueRoutes,
} from './queues.js';
export {
  createOutboxDrainer,
  retryDelayMs,
  type DrainerOptions,
  type DrainResult,
  type OutboxDrainer,
} from './drainer.js';
export {
  createOutboxSubsystem,
  type CreateOutboxSubsystemOptions,
  type OutboxSubsystem,
  type OutboxTransport,
} from './outbox.module.js';
