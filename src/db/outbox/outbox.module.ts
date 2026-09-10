import type { EventBus } from '../../shared/events.js';
import type { Logger } from '../../shared/logger.js';
import type { Database } from '../client.js';
import { createIdempotentDispatchPublisher } from './dispatcher.js';
import { createOutboxDrainer, type DrainerOptions, type OutboxDrainer } from './drainer.js';
import { createEventBus } from './event-bus.js';
import { createOutboxRepository, type OutboxRepository } from './outbox.repository.js';
import type { EventPublisher, HandlerRegistry } from './publisher.js';
// BullMQ is DISABLED for now. Only the TYPES are imported here (erased at compile time, no
// `bullmq`/`ioredis` code runs from importing a type), so `OutboxSubsystem`'s shape does not
// have to change for every caller that reads `container.outbox.queues`/`.workers` to know
// they are always `undefined` right now. The real queue/worker construction this file used
// to hold under `transport: 'queue'` has been removed; find it in git history
// (`git log -- src/db/outbox/outbox.module.ts src/db/outbox/queues.ts`) the day it needs to
// come back.
import type { EventQueues, EventWorkers, QueueRoutes } from './queues.js';

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
 *   'queue'      — **disabled, not wired.** Would enqueue to BullMQ and let separate worker
 *                  processes run the handlers — the shape to reach for once a handler needs
 *                  to scale independently of the drain loop, and not before. Passing
 *                  `transport: 'queue'` throws rather than silently doing nothing; the
 *                  removed implementation is recoverable from git history.
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

  // transport === 'queue': disabled for now — no queue system, Redis used only for locks and
  // rate limiting. See the module docblock above for what this used to build.
  throw new Error(
    "createOutboxSubsystem: transport 'queue' is disabled for now — BullMQ support was " +
      "removed from outbox.module.ts and queues.ts. Use transport: 'in-process' (the " +
      'default in container.ts), or restore the queue implementation from git history if ' +
      'this deployment now needs it.',
  );
}
