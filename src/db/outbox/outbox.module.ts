import type { EventBus } from '../../shared/events.js';
import type { Logger } from '../../shared/logger.js';
import type { Database } from '../client.js';
import { createIdempotentDispatchPublisher, createIdempotentDispatcher } from './dispatcher.js';
import { createOutboxDrainer, type DrainerOptions, type OutboxDrainer } from './drainer.js';
import { createEventBus } from './event-bus.js';
import { createOutboxRepository, type OutboxRepository } from './outbox.repository.js';
import type { EventPublisher, HandlerRegistry } from './publisher.js';
import {
  createEventQueues,
  createEventWorkers,
  createQueueEventPublisher,
  type EventQueues,
  type EventWorkers,
  type QueueRoutes,
} from './queues.js';

/**
 * Composition for the outbox subsystem.
 *
 * A plain factory taking explicit dependencies and returning the assembled parts — the
 * same pattern the composition root will use in Step 6. No decorators, no reflection, no
 * container library. The construction order below IS the dependency graph, and a cycle in
 * it would be a compile error rather than something discovered at startup.
 *
 * Two delivery modes, chosen by `transport`:
 *
 *   'in-process' — the drainer runs handlers itself. No Redis. Correct and fully
 *                  idempotent; right for local development, tests, and a single-process
 *                  deployment. A slow handler blocks the drain loop.
 *
 *   'queue'      — the drainer enqueues to BullMQ and separate worker processes run the
 *                  handlers. The production shape: publishing stays fast, handlers scale
 *                  independently, and one slow handler cannot stall the outbox.
 */

export type OutboxTransport = 'in-process' | 'queue';

export type OutboxSubsystem = {
  repository: OutboxRepository;
  events: EventBus;
  publisher: EventPublisher;
  drainer: OutboxDrainer;
  /** Present only for the queue transport. */
  queues?: EventQueues;
  /** Present only when this process also consumes jobs. */
  workers?: EventWorkers;
  shutdown(): Promise<void>;
};

export type CreateOutboxSubsystemOptions = {
  db: Database;
  logger: Logger;
  handlers: HandlerRegistry;
  transport: OutboxTransport;
  drainer?: DrainerOptions;
  /** Required for the queue transport. */
  redisUrl?: string;
  queueRoutes?: QueueRoutes;
  /**
   * Whether THIS process should also run BullMQ workers.
   *
   * Usually false on the API process and true on worker containers. Running workers inside
   * the API means a CPU-bound handler stalls every concurrent HTTP request — Node is
   * single-threaded, and that failure presents as "the site is down".
   */
  runWorkers?: boolean;
  workerConcurrency?: number;
};

export function createOutboxSubsystem(opts: CreateOutboxSubsystemOptions): OutboxSubsystem {
  const { db, logger, handlers } = opts;

  const repository = createOutboxRepository({ db });
  const events = createEventBus({ repository, logger });

  if (opts.transport === 'in-process') {
    const publisher = createIdempotentDispatchPublisher({ db, repository, handlers, logger });
    const drainer = createOutboxDrainer({
      repository,
      publisher,
      logger,
      ...(opts.drainer ? { options: opts.drainer } : {}),
    });

    return {
      repository,
      events,
      publisher,
      drainer,
      async shutdown() {
        drainer.stop();
      },
    };
  }

  if (opts.redisUrl === undefined) {
    // Fail at construction, not at the first publish. A queue transport with no Redis URL
    // is a misconfiguration that must not reach a running process.
    throw new Error("createOutboxSubsystem: redisUrl is required when transport is 'queue'");
  }

  const queues = createEventQueues({
    redisUrl: opts.redisUrl,
    logger,
    ...(opts.queueRoutes ? { routes: opts.queueRoutes } : {}),
  });
  const publisher = createQueueEventPublisher({ queues, logger });
  const drainer = createOutboxDrainer({
    repository,
    publisher,
    logger,
    ...(opts.drainer ? { options: opts.drainer } : {}),
  });

  const workers =
    opts.runWorkers === true
      ? createEventWorkers({
          redisUrl: opts.redisUrl,
          repository,
          dispatcher: createIdempotentDispatcher({ db, repository, handlers, logger }),
          logger,
          ...(opts.workerConcurrency !== undefined ? { concurrency: opts.workerConcurrency } : {}),
        })
      : undefined;

  return {
    repository,
    events,
    publisher,
    drainer,
    queues,
    ...(workers ? { workers } : {}),
    async shutdown() {
      // Order matters: stop taking new work, then drain what is in flight, then release
      // the connections. Closing Redis first would fail the in-flight jobs it is holding.
      drainer.stop();
      if (workers) await workers.close();
      await queues.closeAll();
    },
  };
}
