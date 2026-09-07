import { buildContainer } from '../container.js';
import { manageLifecycle } from '../lifecycle.js';

/**
 * The worker process.
 *
 * Two jobs, both already implemented in the outbox subsystem — this file starts them and
 * sequences their shutdown, nothing more:
 *
 *  1. The outbox DRAINER: claims committed events with `FOR UPDATE SKIP LOCKED` and hands
 *     them to BullMQ.
 *  2. The event WORKERS: consume those jobs and run handlers, with `processed_event`
 *     suppressing duplicates.
 *
 * Safe to run on N replicas. `SKIP LOCKED` means N drainers divide the work rather than
 * fighting over it, and BullMQ distributes jobs across consumers. This is the process to
 * scale on queue depth.
 *
 * No HTTP server. No second queue system — `role: 'worker'` is the single flag that tells
 * the composition root to construct the BullMQ workers it already knows how to build.
 */

const container = buildContainer({ role: 'worker' });
const { logger } = container;

/**
 * `start()` runs until `stop()` is called and is documented as never throwing — it logs and
 * backs off on error, because a drainer that dies takes every side effect in the system with
 * it. The promise is retained rather than discarded so shutdown can await the loop actually
 * ending, instead of assuming it did.
 */
const draining = container.outbox.drainer.start();

logger.info(
  {
    workerId: container.outbox.drainer.workerId,
    queues: container.outbox.workers?.workers.map((w) => w.name) ?? [],
    environment: container.config.environment,
    pid: process.pid,
  },
  'worker_started',
);

manageLifecycle({
  processName: 'worker',
  logger,
  /**
   * Order matters here for a specific reason.
   *
   * The drainer is stopped and AWAITED first. `container.shutdown()` closes the BullMQ
   * queue connections; if the drain loop were still mid-batch at that moment it would try
   * to publish to a closed queue, and those events would be marked failed and retried for
   * no reason. Letting the loop finish its current batch first avoids inventing failures
   * during a routine deploy.
   *
   * `container.shutdown()` then closes the workers (BullMQ finishes in-flight jobs before
   * resolving), the queue connections, Redis, and the database pool.
   */
  shutdown: async () => {
    container.outbox.drainer.stop();
    await draining;
    await container.shutdown();
  },
});
