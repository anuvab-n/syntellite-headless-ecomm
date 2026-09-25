import { buildContainer } from '../container.js';
import { manageLifecycle } from '../lifecycle.js';

/**
 * The scheduler process.
 *
 * Runs recurring jobs. There is no leader election: run exactly ONE scheduler instance.
 * Every task must still be idempotent — a rolling deploy briefly overlaps two instances, and
 * a task may be skipped or repeated across a restart.
 */

/**
 * A recurring job.
 *
 * `run` must be idempotent and must tolerate being skipped. Nothing here should assume
 * "this ran exactly every N ms since the beginning of time".
 */
type ScheduledTask = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

/** How often to check whether a task is due. */
const TICK_INTERVAL_MS = 5_000;

const container = buildContainer({ role: 'scheduler' });
const { logger } = container;

const TASKS: readonly ScheduledTask[] = [
  {
    /**
     * Expire abandoned online payments and release the stock they were holding.
     *
     * `expires_at` decides when a payment is due, so the cadence only bounds how long stock
     * stays held PAST its window. Safe to overlap across instances: the payment row lock plus
     * the `status = 'pending'` CAS mean a second sweeper produces ignored results rather than
     * double-releasing stock.
     */
    name: 'payment-expiry-sweep',
    intervalMs: container.config.paymentExpirySweepIntervalMs,
    run: async () => {
      await container.paymentExpirySweeper.sweep();
    },
  },
];

/** Last completed run per task, so a tick can tell what is due. */
const lastRunAt = new Map<string, number>();
/** Tasks currently executing, so a slow task does not overlap itself. */
const running = new Set<string>();

async function runDueTasks(): Promise<void> {
  const now = Date.now();

  for (const task of TASKS) {
    if (stopped) return;

    if (running.has(task.name)) {
      logger.warn({ task: task.name }, 'scheduled_task_still_running_skipping');
      continue;
    }

    const last = lastRunAt.get(task.name) ?? 0;
    if (now - last < task.intervalMs) continue;

    running.add(task.name);
    try {
      await task.run();
      logger.info({ task: task.name }, 'scheduled_task_completed');
    } catch (err) {
      // One failing task must not stop the others, and must not stop the loop.
      logger.error({ err, task: task.name }, 'scheduled_task_failed');
    } finally {
      lastRunAt.set(task.name, Date.now());
      running.delete(task.name);
    }
  }
}

let stopped = false;
/** The tick currently in flight, so shutdown can await it before closing the container. */
let inFlight: Promise<void> | undefined;

function scheduleTick(): void {
  if (inFlight || stopped) return;
  inFlight = runDueTasks()
    .catch((err: unknown) => {
      logger.error({ err }, 'scheduler_tick_failed');
    })
    .finally(() => {
      inFlight = undefined;
    });
}

const timer = setInterval(scheduleTick, TICK_INTERVAL_MS);

logger.info(
  {
    taskCount: TASKS.length,
    tickIntervalMs: TICK_INTERVAL_MS,
    environment: container.config.environment,
    pid: process.pid,
  },
  'scheduler_started',
);

scheduleTick();

manageLifecycle({
  processName: 'scheduler',
  logger,
  shutdown: async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
    await container.shutdown();
  },
});
