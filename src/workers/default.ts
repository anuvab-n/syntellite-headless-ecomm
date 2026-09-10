import { buildContainer } from '../container.js';
import { manageLifecycle } from '../lifecycle.js';

/**
 * The worker process.
 *
 * Starts the outbox DRAINER and sequences its shutdown, nothing more. What the drainer does
 * with a claimed event depends on the transport `buildContainer` was given:
 *
 *  - **'in-process' (the default since this file was written).** The drainer claims
 *    committed events with `FOR UPDATE SKIP LOCKED` and runs the matching handler itself,
 *    right here, with `processed_event` suppressing duplicates. No BullMQ, no queue Redis
 *    database — Redis is used by nothing in this process. Safe to run on N replicas: `SKIP
 *    LOCKED` means N drainers divide the claimed work rather than fighting over it.
 *
 *  - **'queue'**, if a deployment opts back in explicitly (`buildContainer({ role: 'worker',
 *    transport: 'queue' })`). The drainer hands claimed events to BullMQ instead of running
 *    them, and `container.outbox.workers` — otherwise `undefined` — consumes those jobs and
 *    runs the handlers. This is the process to scale on queue depth once a handler needs to
 *    scale independently of the drain loop; nothing here requires it before that.
 *
 * No HTTP server either way.
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
