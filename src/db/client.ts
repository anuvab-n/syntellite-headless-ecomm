import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Config } from '../config.js';
import type { Logger } from '../shared/logger.js';
import * as schema from './schema/index.js';

/**
 * The database client.
 *
 * Two connections exist, and the distinction is architectural rather than cosmetic:
 *
 *   primary — every write, and every read inside a transaction. Row locks live here.
 *   replica — selectors only. Replica-safe by definition: no locks, no writes, and
 *             tolerant of a few milliseconds of lag.
 *
 * A service (a command) must never touch the replica. Reading a stock level from a replica
 * and then deciding whether to reserve is exactly how you oversell: the read is stale and
 * the lock is on the wrong server. Locally both point at the same URL, which means the
 * mistake will not surface until production — hence the naming, and the review rule.
 */
export type Database = NodePgDatabase<typeof schema>;

export type DatabaseHandle = {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
};

function createPool(
  url: string,
  config: Config,
  logger: Logger,
  role: 'primary' | 'replica',
): Pool {
  const pool = new Pool({
    connectionString: url,
    max: config.databasePoolMax,

    /**
     * A server-side cap on any single statement. The last line of defence against one
     * pathological query holding a connection — or worse, a lock — indefinitely.
     *
     * Migrations set their own, higher value; see migrate.ts.
     */
    statement_timeout: config.databaseStatementTimeoutMs,

    /**
     * Separate from statement_timeout: this one kills a transaction left OPEN with no
     * statement running. An abandoned `BEGIN` holding a `FOR UPDATE` lock blocks every
     * other checkout for that variant until it is cleared.
     */
    idle_in_transaction_session_timeout: config.databaseStatementTimeoutMs,

    application_name: `ecom-${role}`,

    // Recycle idle connections so a pooler or a failover does not leave us holding
    // sockets to a server that is gone.
    idleTimeoutMillis: 30_000,

    connectionTimeoutMillis: 5_000,
  });

  /**
   * `pg` emits 'error' on IDLE clients (a network drop, a failover, an admin
   * `pg_terminate_backend`). With no listener this is an unhandled 'error' event, which
   * takes the whole process down. It must be handled, and it must not be fatal.
   */
  pool.on('error', (err) => {
    logger.error({ err, role }, 'db_idle_client_error');
  });

  return pool;
}

export function createDatabase(
  url: string,
  config: Config,
  logger: Logger,
  role: 'primary' | 'replica' = 'primary',
): DatabaseHandle {
  const pool = createPool(url, config, logger, role);

  const db = drizzle(pool, {
    schema,

    // Query logging in development only. In production this would log every parameter,
    // including PII, at a volume nobody reads.
    logger:
      config.logFormat === 'pretty' && config.environment === 'local'
        ? {
            logQuery: (query, params) => logger.debug({ query, params }, 'db_query'),
          }
        : false,
  });

  /**
   * The single shutdown operation for this pool.
   *
   * `pg` throws if `pool.end()` is called more than once. Keeping the promise means
   * repeated or concurrent calls to `close()` all await the same shutdown operation.
   */
  let closePromise: Promise<void> | undefined;

  return {
    db,
    pool,

    close: async (): Promise<void> => {
      closePromise ??= pool.end();
      await closePromise;
    },
  };
}

/**
 * Readiness probe query.
 *
 * `SELECT 1` deliberately — not a count, not a table read. The probe answers "can I reach
 * the database and get a connection from the pool", nothing more. A probe that touches
 * application tables will fail during a migration and take healthy instances out of
 * rotation for no reason.
 */
export async function checkDatabase(handle: DatabaseHandle): Promise<void> {
  const client = await handle.pool.connect();

  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
