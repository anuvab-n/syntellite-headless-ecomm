import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * BullMQ wiring — DISABLED for now.
 *
 * "No queue system for now, only Redis for locks/cache" — the outbox's default transport is
 * `'in-process'` (see `outbox.module.ts`, `container.ts`), which runs handlers directly and
 * touches no queue Redis database at all. The real BullMQ implementation this file used to
 * hold (queue/worker construction, the publisher that called `queue.add`) has been removed;
 * find it in git history (`git log -- src/db/outbox/queues.ts`) the day it needs to come back.
 *
 * Only TYPES stay here: `EventQueues`, `EventWorkers`, `QueueName`, `QueueRoutes`. A type is
 * erased at compile time, so keeping them live imports zero `bullmq`/`ioredis` runtime code —
 * they exist so `OutboxSubsystem` (`outbox.module.ts`) and its callers (`container.ts`,
 * `workers/default.ts`) keep compiling against `queues?: EventQueues` and
 * `workers?: EventWorkers`, both of which are simply always `undefined` right now.
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

export type EventJobData = {
  eventId: string;
  eventType: string;
};

export type EventWorkers = {
  workers: Worker[];
  close(): Promise<void>;
};
