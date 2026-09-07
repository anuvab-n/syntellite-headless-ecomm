import { buildContainer } from './container.js';
import { createHttpServer } from './http/server.js';
import { manageLifecycle, startOrCleanUp } from './lifecycle.js';

/**
 * The API process.
 *
 * Serves HTTP. Does NOT run job handlers and does NOT drain the outbox — both belong to the
 * worker process. Keeping them out is not tidiness: Node is single-threaded, so one
 * CPU-bound handler on this process stalls every concurrent request, and that failure
 * presents to customers as "the site is down" rather than as a slow background job.
 *
 * Consequence for local development: events emitted here stay in `outbox_event` until a
 * worker runs. `pnpm dev` and `pnpm dev:worker` are both needed to see a side effect fire.
 *
 * No business logic in this file, ever. It builds a container, starts a listener, and wires
 * shutdown. Anything else belongs in a module.
 */

const container = buildContainer({ role: 'api' });
const { config, logger } = container;

/**
 * The HTTP server is created HERE, not in the container.
 *
 * That is what makes the shutdown ordering below expressible: this process must stop
 * accepting connections and drain in-flight requests BEFORE the container closes the
 * database pool those requests are still using. A container that owned the listener could
 * not sequence its own teardown against itself.
 */
const http = createHttpServer({ app: container.app, logger });

const server = await startOrCleanUp({
  logger,
  processName: 'api',
  /**
   * Warm up BEFORE binding a port.
   *
   * `container.warmUp()` imports the JWT keypair, which is the only thing that proves the
   * configured key material is actually usable — config validates the PEM envelope
   * synchronously, but a well-formed block that is not a real RSA key passes that check.
   * Running it here means such a deployment fails at startup instead of at the first customer
   * login, and `cleanUp` below releases the pool and Redis connection on the way out.
   */
  start: async () => {
    await container.warmUp();
    return http.listen(config.port);
  },
  // The container is already holding a database pool and a Redis connection by this point.
  // A failed `listen()` — a taken port, usually — must release them, or the process hangs
  // instead of reporting the real error.
  cleanUp: () => container.shutdown(),
});

logger.info(
  {
    port: server.port,
    environment: config.environment,
    nodeEnv: config.nodeEnv,
    // Useful on the first line of a container log when a deploy misbehaves.
    pid: process.pid,
    nodeVersion: process.version,
  },
  'api_started',
);

manageLifecycle({
  processName: 'api',
  logger,
  /**
   * Order is the whole point of this function.
   *
   * 1. `server.close()` stops accepting NEW connections and waits for in-flight requests.
   *    An order half-way through its transaction gets to finish.
   * 2. Only then does the container close. Reversing these two closes the connection pool
   *    out from under a request that is still running, turning a graceful deploy into a
   *    handful of 500s and, worse, a partially applied write.
   */
  shutdown: async () => {
    await server.close();
    await container.shutdown();
  },
});
