import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

import type { DeliveredEvent } from '../../shared/events.js';
import type { Logger } from '../../shared/logger.js';
import type { Dispatcher } from './dispatcher.js';
import type { EventPublisher } from './publisher.js';
import type { OutboxRepository } from './outbox.repository.js';

/**
 * BullMQ wiring.
 *
 * Redis is a WORK DISTRIBUTION mechanism here, never a system of record. The distinction is
 * load-bearing and shows up in three concrete places:
 *
 *  1. An event is durable in `outbox_event` before Redis ever hears about it.
 *  2. A job carries an event ID, and the worker RE-READS the event from PostgreSQL. If
 *     Redis is flushed, restarted empty, or evicts a job, nothing is lost — the outbox row
 *     is still unpublished (or reclaimed by the reaper) and gets enqueued again.
 *  3. `processed_event` — the duplicate-suppression ledger — lives in PostgreSQL, so it
 *     survives a Redis wipe. Putting it in Redis would mean an eviction silently permits a
 *     second charge.
 */

/**
 * Queue names.
 *
 * Separated by BLAST RADIUS, not by domain. A bulk marketing send must not sit in front of
 * an order confirmation, and a two-minute report must not occupy the worker that dispatches
 * payment webhooks.
 */
export const QUEUE_NAMES = ['default', 'emails', 'heavy'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Event type → queue. Anything unrouted goes to `default`. */
export type QueueRoutes = Readonly<Record<string, QueueName>>;

export type EventQueues = {
  connection: Redis;
  queues: Readonly<Record<QueueName, Queue>>;
  resolveQueue(eventType: string): Queue;
  closeAll(): Promise<void>;
};

/**
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ for a blocking connection. With the
 * ioredis default, a brief Redis blip makes a blocking `BRPOPLPUSH` throw and the worker
 * dies instead of reconnecting.
 */
function createConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export function createEventQueues(deps: {
  redisUrl: string;
  logger: Logger;
  routes?: QueueRoutes;
}): EventQueues {
  const { logger, routes = {} } = deps;
  const connection = createConnection(deps.redisUrl);

  connection.on('error', (err) => {
    // Must be handled, or an idle-connection error is an unhandled 'error' event and takes
    // the process down. A Redis outage should degrade the queue, not kill the worker.
    logger.error({ err }, 'queue_redis_error');
  });

  const queues = Object.fromEntries(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection })]),
  ) as Record<QueueName, Queue>;

  return {
    connection,
    queues,
    resolveQueue(eventType) {
      return queues[routes[eventType] ?? 'default'];
    },
    async closeAll() {
      await Promise.allSettled(Object.values(queues).map((q) => q.close()));
      await connection.quit();
    },
  };
}

/* ── Publisher ───────────────────────────────────────────────────────────── */

/**
 * The production publisher: hand the event to a queue and return.
 *
 * The ONLY place in the codebase permitted to call `queue.add`. Everything else emits
 * through the event bus, or it forfeits the transactional guarantee. (A lint rule will
 * enforce this in Step 8; until then it is a review rule.)
 *
 * The job payload is deliberately thin — an id plus enough context to log. The worker
 * re-reads the event from PostgreSQL, so a stale or truncated job payload cannot cause a
 * handler to act on wrong data.
 *
 * `jobId: event.id` makes the ENQUEUE idempotent: a drainer that publishes, crashes before
 * marking the row, and is later reclaimed by the reaper re-adds the same job id, and BullMQ
 * discards the duplicate instead of running handlers twice.
 */
export function createQueueEventPublisher(deps: {
  queues: EventQueues;
  logger: Logger;
}): EventPublisher {
  const { queues, logger } = deps;

  return {
    async publish(event: DeliveredEvent) {
      const queue = queues.resolveQueue(event.type);
      await queue.add(
        event.type,
        {
          eventId: event.id,
          eventType: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          storeId: event.storeId,
          requestId: event.requestId,
        },
        {
          jobId: event.id,
          // Retries here are for handler failures. Enqueue failures are retried by the
          // outbox instead, which is the more durable of the two mechanisms.
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
          // Kept: a failed job is evidence, and the dead-letter view reads it.
          removeOnFail: false,
        },
      );
      logger.debug(
        { eventId: event.id, eventType: event.type, queue: queue.name },
        'event_enqueued',
      );
    },
    async close() {
      await queues.closeAll();
    },
  };
}

/* ── Worker ──────────────────────────────────────────────────────────────── */

export type EventJobData = {
  eventId: string;
  eventType: string;
};

export type EventWorkers = {
  workers: Worker[];
  close(): Promise<void>;
};

/**
 * Consume queued jobs and run their handlers.
 *
 * Re-reads the event from PostgreSQL by id rather than trusting the job payload — that is
 * what keeps Redis out of the system-of-record role. A job whose event no longer exists is
 * ACKED rather than retried: the only way that happens is the retention job having trimmed
 * an already-published row, and retrying forever would turn housekeeping into an alert
 * storm.
 */
export function createEventWorkers(deps: {
  redisUrl: string;
  repository: OutboxRepository;
  dispatcher: Dispatcher;
  logger: Logger;
  concurrency?: number;
  queueNames?: readonly QueueName[];
}): EventWorkers {
  const { repository, dispatcher, logger } = deps;
  const concurrency = deps.concurrency ?? 10;

  /**
   * Connections are tracked so `close()` can quit them.
   *
   * BullMQ only takes ownership of a connection it created itself from an options object.
   * Given an existing ioredis instance — as here, because each worker needs its own
   * blocking connection — `worker.close()` closes the worker but leaves the socket open.
   * Those sockets keep the event loop alive, so the process never exits: shutdown appears
   * to succeed and then hangs until the orchestrator SIGKILLs it.
   */
  const connections: Redis[] = [];

  const workers = (deps.queueNames ?? QUEUE_NAMES).map((name) => {
    const connection = createConnection(deps.redisUrl);
    connections.push(connection);
    connection.on('error', (err) => logger.error({ err, queue: name }, 'worker_redis_error'));

    const worker = new Worker(
      name,
      async (job: Job<EventJobData>) => {
        const event = await repository.findDeliveredById(job.data.eventId);

        if (!event) {
          logger.warn({ eventId: job.data.eventId, queue: name }, 'event_row_missing_for_job');
          return;
        }

        // Throwing here marks the BullMQ job failed and schedules its retry. The
        // dispatcher has already released any handler claim, so the retry is safe.
        await dispatcher.dispatch(event);
      },
      { connection, concurrency },
    );

    worker.on('failed', (job, err) => {
      logger.error({ err, jobId: job?.id, queue: name }, 'event_job_failed');
    });

    return worker;
  });

  return {
    workers,
    async close() {
      // `worker.close()` finishes in-flight jobs before resolving; a job killed mid-flight
      // would be redelivered anyway, but finishing cleanly avoids the duplicate.
      await Promise.allSettled(workers.map((w) => w.close()));
      // Then release the sockets BullMQ does not own. Order matters: quitting first would
      // fail the in-flight jobs the workers are still finishing.
      await Promise.allSettled(connections.map((c) => c.quit()));
    },
  };
}
