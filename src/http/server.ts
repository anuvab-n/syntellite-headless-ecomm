import { createServer, type Server } from 'node:http';

import type { Express } from 'express';

import type { Logger } from '../shared/logger.js';

/**
 * HTTP server lifecycle.
 *
 * Separate from `createApp` so tests can exercise the app with supertest without binding a
 * port, and so the process-level concerns (signals, exit codes, ordering against the
 * database and queue shutdown) stay in Step 7 where they belong.
 *
 * This module deliberately does NOT register signal handlers. A module that installs
 * `process.on('SIGTERM')` as an import side effect is impossible to test and fights whoever
 * owns shutdown ordering — and ordering is the whole difficulty: the HTTP server must stop
 * accepting connections BEFORE the database pool closes, or in-flight requests fail with
 * connection errors instead of completing.
 */

export type HttpServerHandle = {
  server: Server;
  port: number;
  /** Stop accepting connections, then wait for in-flight requests to finish. */
  close: () => Promise<void>;
};

/**
 * How long to wait for in-flight requests before forcing sockets closed.
 *
 * Must exceed the longest legitimate request. The orchestrator's own grace period must in
 * turn exceed this, or it SIGKILLs the process mid-transaction — which is how an order gets
 * created with no payment recorded.
 */
const SHUTDOWN_GRACE_MS = 30_000;

export function createHttpServer(deps: { app: Express; logger: Logger }): {
  listen: (port: number) => Promise<HttpServerHandle>;
} {
  const { app, logger } = deps;

  return {
    async listen(port) {
      const server = createServer(app);

      /**
       * Node's default `requestTimeout` is 300s and `headersTimeout` 60s. A request held
       * open for five minutes occupies a connection and, if it took a row lock, blocks
       * every checkout for that variant. 30s is generous for this API.
       */
      server.requestTimeout = 30_000;
      server.headersTimeout = 20_000;
      /**
       * Must exceed the load balancer's idle timeout, or the LB reuses a connection this
       * server is simultaneously closing and the client sees a sporadic 502.
       */
      server.keepAliveTimeout = 65_000;

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;

      logger.info({ port: boundPort }, 'http_server_listening');

      return {
        server,
        port: boundPort,

        async close() {
          logger.info('http_server_closing');

          await new Promise<void>((resolve) => {
            /**
             * `server.close()` stops accepting NEW connections and fires the callback once
             * existing ones drain. It does not hurry them along, which is the desired
             * behaviour — an in-flight checkout should finish.
             */
            const forceTimer = setTimeout(() => {
              // A client holding a keep-alive connection open would otherwise block
              // shutdown indefinitely. `closeAllConnections` exists for exactly this.
              logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'http_server_force_closing');
              server.closeAllConnections();
            }, SHUTDOWN_GRACE_MS);

            server.close(() => {
              clearTimeout(forceTimer);
              resolve();
            });

            /**
             * Idle keep-alive connections are closed immediately. Without this, `close()`
             * waits for each idle client's keep-alive to expire — up to 65s of doing nothing
             * on every deploy.
             */
            server.closeIdleConnections();
          });

          logger.info('http_server_closed');
        },
      };
    },
  };
}
