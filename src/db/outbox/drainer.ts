import { hostname } from 'node:os';

import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import type { OutboxRepository } from './outbox.repository.js';
import type { EventPublisher } from './publisher.js';

/**
 * The outbox drainer.
 *
 * Polls for committed-but-unpublished events, claims a batch under
 * `FOR UPDATE SKIP LOCKED`, publishes each one, and marks the outcome. Safe to run on
 * every worker container: `SKIP LOCKED` means N drainers divide the work rather than
 * fighting over it.
 *
 * Polling rather than `LISTEN/NOTIFY` deliberately. A poll is one indexed query per second
 * against a partial index — trivially cheap — and it recovers by itself from a dropped
 * connection, a restart, or a backlog. `NOTIFY` is lower latency and loses every
 * notification delivered while a listener was disconnected, which reintroduces exactly the
 * silent-loss failure the outbox was built to remove.
 */

export type DrainerOptions = {
  /** How many events one claim takes. */
  batchSize?: number;
  /** Sleep between polls when there was nothing to do. */
  pollIntervalMs?: number;
  /**
   * Attempts before an event is dead-lettered. `attempts` increments on CLAIM, so this
   * bounds crashes as well as failures.
   */
  maxAttempts?: number;
  /** Base for exponential backoff between retries. */
  retryBaseMs?: number;
  /** Ceiling on backoff, so a long-broken dependency retries hourly, not yearly. */
  retryMaxMs?: number;
  /**
   * A claim older than this is presumed abandoned and reclaimed.
   *
   * Must exceed the longest legitimate publish. Too low and the reaper steals work from a
   * healthy-but-slow worker, causing duplicate delivery (survivable — handlers are
   * idempotent). Too high and a crashed worker's events sit stranded for that long
   * (not survivable — a customer never gets their email).
   */
  staleClaimAfterMs?: number;
  /** Identifies this drainer in `claimed_by`. Defaults to host + pid + random. */
  workerId?: string;
};

const DEFAULTS = {
  batchSize: 100,
  pollIntervalMs: 1_000,
  maxAttempts: 8,
  retryBaseMs: 1_000,
  retryMaxMs: 60 * 60 * 1_000,
  staleClaimAfterMs: 5 * 60 * 1_000,
} as const;

export type DrainResult = {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
};

export type OutboxDrainer = ReturnType<typeof createOutboxDrainer>;

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters more than it looks: without it, a hundred events that failed together
 * because a downstream service went down all retry at the same instant, hit it again the
 * moment it starts recovering, and knock it back over. Full jitter spreads the retry
 * uniformly across the window.
 */
export function retryDelayMs(
  attempts: number,
  opts: { retryBaseMs: number; retryMaxMs: number; random?: () => number },
): number {
  const exponential = Math.min(opts.retryMaxMs, opts.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  const random = opts.random ?? Math.random;
  return Math.round(random() * exponential);
}

export function createOutboxDrainer(deps: {
  repository: OutboxRepository;
  publisher: EventPublisher;
  logger: Logger;
  options?: DrainerOptions;
}) {
  const { repository, publisher, logger } = deps;
  const opts = { ...DEFAULTS, ...deps.options };
  const workerId = deps.options?.workerId ?? `${hostname()}:${process.pid}:${newId().slice(0, 8)}`;

  let running = false;
  let stopped = false;
  /** Resolves the sleep early so `stop()` does not wait out a full poll interval. */
  let wakeUp: (() => void) | undefined;

  /**
   * Claim and publish one batch. Returns what happened, so tests and the scheduler can
   * assert on it and so a loop can decide whether to sleep.
   *
   * Each event is published independently: one failure must not prevent the rest of the
   * batch from going out.
   */
  async function drainOnce(): Promise<DrainResult> {
    const events = await repository.claimBatch({ workerId, batchSize: opts.batchSize });
    const result: DrainResult = {
      claimed: events.length,
      published: 0,
      failed: 0,
      deadLettered: 0,
    };
    if (events.length === 0) return result;

    const publishedIds: string[] = [];

    for (const event of events) {
      try {
        await publisher.publish(event);
        publishedIds.push(event.id);
        result.published += 1;
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);

        if (event.attempts >= opts.maxAttempts) {
          await repository.markDeadLettered({ id: event.id, error: message });
          result.deadLettered += 1;
          // Error level and a distinct event name: this one needs a human, and it is what
          // the dead-letter alert fires on.
          logger.error(
            { eventId: event.id, eventName: event.type, attempts: event.attempts },
            'outbox_event_dead_lettered',
          );
          continue;
        }

        const delay = retryDelayMs(event.attempts, opts);
        await repository.markFailed({
          id: event.id,
          error: message,
          retryAt: new Date(Date.now() + delay),
        });
        result.failed += 1;
        logger.warn(
          {
            err,
            eventId: event.id,
            eventName: event.type,
            attempts: event.attempts,
            retryInMs: delay,
          },
          'outbox_publish_failed',
        );
      }
    }

    // Marked in one statement after the loop: fewer round trips, and the claim already
    // guarantees nobody else can touch these rows in the meantime.
    await repository.markPublished(publishedIds);

    if (result.published > 0) {
      logger.info({ ...result, workerId }, 'outbox_batch_published');
    }
    return result;
  }

  /** Crash recovery. Cheap, and only ever touches rows nothing else can. */
  async function reapStaleClaims(): Promise<number> {
    const reclaimed = await repository.reclaimStale({
      olderThan: new Date(Date.now() - opts.staleClaimAfterMs),
    });
    if (reclaimed > 0) {
      // Warn, not info: a healthy system reclaims nothing. Any number here means a worker
      // died mid-publish, and a steady trickle means something is crash-looping.
      logger.warn(
        { reclaimed, staleClaimAfterMs: opts.staleClaimAfterMs },
        'outbox_claims_reclaimed',
      );
    }
    return reclaimed;
  }

  /**
   * Drain repeatedly until nothing is left. Used by tests and by the CLI; the long-running
   * process uses `start()`.
   *
   * Bounded by `maxBatches` so a bug that keeps re-queuing work cannot spin forever.
   */
  async function drainUntilEmpty(maxBatches = 100): Promise<DrainResult> {
    const total: DrainResult = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };
    for (let i = 0; i < maxBatches; i += 1) {
      const result = await drainOnce();
      total.claimed += result.claimed;
      total.published += result.published;
      total.failed += result.failed;
      total.deadLettered += result.deadLettered;
      if (result.claimed === 0) break;
    }
    return total;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * The long-running loop.
   *
   * Never throws: a transient database error must not kill the drainer, or the outbox stops
   * draining and every side effect in the system silently stops happening. It logs, backs
   * off, and keeps going.
   */
  async function start(): Promise<void> {
    if (running) throw new Error('outbox drainer already started');
    running = true;
    stopped = false;
    logger.info({ workerId, ...opts }, 'outbox_drainer_started');

    let sinceReap = 0;

    while (!stopped) {
      try {
        const result = await drainOnce();

        // Reap on a slower cadence than the drain: it is a recovery path, not a hot path.
        sinceReap += 1;
        if (sinceReap * opts.pollIntervalMs >= opts.staleClaimAfterMs) {
          sinceReap = 0;
          await reapStaleClaims();
        }

        // A full batch means there is probably more waiting — go straight round again
        // rather than sleeping while a backlog builds.
        if (result.claimed < opts.batchSize && !stopped) {
          await sleep(opts.pollIntervalMs);
        }
      } catch (err) {
        logger.error({ err, workerId }, 'outbox_drain_loop_error');
        if (!stopped) await sleep(opts.pollIntervalMs);
      }
    }

    running = false;
    logger.info({ workerId }, 'outbox_drainer_stopped');
  }

  /**
   * Stop after the in-flight batch.
   *
   * Deliberately does NOT abandon work mid-batch. An event already handed to the publisher
   * is either marked or left claimed for the reaper; killing the loop harder would strand
   * it for `staleClaimAfterMs` for no gain.
   */
  function stop(): void {
    stopped = true;
    wakeUp?.();
  }

  return { drainOnce, drainUntilEmpty, reapStaleClaims, start, stop, workerId };
}
