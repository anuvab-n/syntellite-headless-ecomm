import { buildContainer } from '../container.js';
import { manageLifecycle } from '../lifecycle.js';
import { createLeaderLock } from '../redis/leader-lock.js';

/**
 * The scheduler process.
 *
 * Runs recurring jobs. There are NO jobs yet — the registry below is deliberately empty,
 * because inventing a fake reservation sweeper to make this file look busy would be a lie
 * the next reader has to unpick. What exists now is the lifecycle and, critically, the
 * singleton guarantee those future jobs will depend on.
 *
 * Why the guarantee matters more here than anywhere else: the spec says exactly one
 * scheduler instance, ever, and the reason is arithmetic rather than performance. Two
 * schedulers running the reservation sweeper release stock twice; two running the
 * abandoned-cart job email every customer twice.
 *
 * "We only deploy one replica" is not an enforcement mechanism. A rolling deploy runs the
 * old and new instance simultaneously for a few seconds, and that window is exactly when a
 * scheduled task fires. So leadership is held in Redis and re-checked continuously.
 *
 * The losing instance stays running as a warm STANDBY rather than exiting. Exiting would
 * make the orchestrator restart-loop it, and standby gives automatic failover: if the leader
 * is SIGKILLed, its lock expires and a standby takes over within the TTL.
 */

/**
 * A recurring job.
 *
 * `run` must be idempotent and must tolerate being skipped: a standby that never becomes
 * leader simply never runs it, and a failover means one tick may be missed. Nothing here
 * should assume "this ran exactly every N ms since the beginning of time".
 */
type ScheduledTask = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

/**
 * The registry. Empty at Phase 0, and that is the honest state.
 *
 * Phase 2 adds the reservation-expiry sweeper here; Phase 4 the payment reconciliation
 * poller; Phase 6 abandoned-cart detection. Each is a business job and belongs to its phase,
 * not to this one.
 */
const TASKS: readonly ScheduledTask[] = [];

/** How often to attempt election, and to check whether a task is due. */
const TICK_INTERVAL_MS = 5_000;

/**
 * Leadership TTL. A crashed leader's jobs stall for at most this long before a standby
 * takes over — the floor on failover time.
 */
const LEADERSHIP_TTL_MS = 30_000;

const container = buildContainer({ role: 'scheduler' });
const { logger } = container;

const lock = createLeaderLock({
  redis: container.locks,
  logger,
  /**
   * One key for the whole scheduler, not one per task. Splitting per task would let two
   * instances each lead a different subset — which is a legitimate design, but it makes
   * "did anything run twice?" much harder to answer during an incident. One leader runs
   * everything.
   */
  key: 'ecom:scheduler:leader',
  ttlMs: LEADERSHIP_TTL_MS,
  onLeadershipLost: (reason) => {
    logger.warn({ reason }, 'scheduler_standing_down');
  },
});

/** Last completed run per task, so a tick can tell what is due. */
const lastRunAt = new Map<string, number>();
/** Tasks currently executing, so a slow task does not overlap itself. */
const running = new Set<string>();

async function runDueTasks(): Promise<void> {
  const now = Date.now();

  for (const task of TASKS) {
    // Re-checked per task, not once per tick: leadership can lapse mid-tick, and a task
    // started after that point would be running without the guarantee it depends on.
    if (!lock.isLeader()) return;

    // A task that overruns its interval must not be started again alongside itself. This is
    // why `running` exists rather than relying on the interval being long enough.
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
      // One failing task must not stop the others, and must not stop the loop. The next
      // tick retries it.
      logger.error({ err, task: task.name }, 'scheduled_task_failed');
    } finally {
      lastRunAt.set(task.name, Date.now());
      running.delete(task.name);
    }
  }
}

let stopped = false;
/**
 * The tick currently in flight, so shutdown can await it.
 *
 * Without this, a SIGTERM landing during an election round-trip lets `tryAcquire()` resolve
 * AFTER `release()` has already run: it would then set `leader = true` and start a renewal
 * interval on a container that is closing, and — worse — leave the lock key in Redis for its
 * full TTL, delaying the next leader by up to 30 seconds on every unlucky deploy.
 */
let inFlight: Promise<void> | undefined;

async function tick(): Promise<void> {
  if (stopped) return;

  if (!lock.isLeader()) {
    const acquired = await lock.tryAcquire();
    if (!acquired) {
      // Debug, not info: with two replicas this fires every tick forever on the standby,
      // and at info it would be the highest-volume log line in the system.
      logger.debug('scheduler_standby_waiting');
      return;
    }
  }

  await runDueTasks();
}

/**
 * Runs a tick unless one is already running, and records it for shutdown to await.
 *
 * The guard also prevents overlap: a tick that outruns the interval must not have a second
 * one started alongside it, or two elections race and two task runs overlap.
 */
function scheduleTick(): void {
  if (inFlight) return;
  inFlight = tick()
    .catch((err: unknown) => {
      // `tick` handles its own failures, so reaching here is a bug rather than a Redis
      // blip. Logged rather than rethrown: an unhandled rejection would trip the lifecycle
      // handler and shut the scheduler down over a single bad tick.
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
    leadershipTtlMs: LEADERSHIP_TTL_MS,
    token: lock.token,
    environment: container.config.environment,
    pid: process.pid,
  },
  'scheduler_started',
);

// Attempt election immediately rather than waiting a full tick, so a single-instance
// deployment is leading within milliseconds of boot instead of five seconds.
scheduleTick();

manageLifecycle({
  processName: 'scheduler',
  logger,
  shutdown: async () => {
    stopped = true;
    clearInterval(timer);

    /**
     * Wait for an in-flight tick before releasing. An election or a task completing after
     * `release()` would re-acquire leadership on a process that is going away, leaving the
     * key in Redis for its full TTL.
     */
    await inFlight;

    /**
     * Release BEFORE closing the container, because releasing needs the Redis client the
     * container is about to close. Doing it in the other order leaves the lock held until
     * its TTL expires, which delays the next leader by up to 30 seconds on every deploy —
     * a self-inflicted gap in scheduled work.
     */
    await lock.release();
    await container.shutdown();
  },
});
