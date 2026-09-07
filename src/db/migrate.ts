import { pathToFileURL } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { bootstrapLogger } from '../shared/logger.js';

/**
 * Migration runner.
 *
 * Runs as a SEPARATE process/step before the application starts — never on API boot.
 * Migrating at boot means N instances racing to apply the same DDL during a rolling
 * deploy, and an instance that fails to migrate refuses to serve traffic it could have
 * served.
 *
 * Uses its own connection with its own timeouts. The API's 30-second `statement_timeout`
 * would kill a legitimate index build partway through.
 */

const MIGRATION_STATEMENT_TIMEOUT_MS = 15 * 60 * 1_000;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
    // A migration must not be killed for sitting idle mid-transaction.
    idle_in_transaction_session_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
    application_name: 'ecom-migrate',
  });

  pool.on('error', (err) => {
    bootstrapLogger.error({ err }, 'migration_pool_error');
  });

  try {
    const db = drizzle(pool);
    const startedAt = Date.now();

    /**
     * Advisory lock: a rolling deploy starts several containers at once, and two of them
     * running `CREATE INDEX` concurrently is a deadlock or a duplicate-object error.
     * Drizzle's migrator does not take one, so we do. The lock is released when this
     * connection closes, including on a crash.
     */
    const LOCK_KEY = 947_213_004;
    await pool.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    try {
      bootstrapLogger.info('migrations_started');
      await migrate(db, { migrationsFolder: './src/db/migrations' });
      bootstrapLogger.info({ durationMs: Date.now() - startedAt }, 'migrations_complete');
    } finally {
      await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

/**
 * Entry point when invoked as `pnpm db:migrate`.
 *
 * `pathToFileURL` rather than a hand-built `file://${argv[1]}` template: on Windows
 * `argv[1]` is `C:\path\to\migrate.ts` while `import.meta.url` is
 * `file:///C:/path/to/migrate.ts`, so the string comparison never matches and the
 * migration silently does nothing while exiting 0. Which is exactly how this was found.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    bootstrapLogger.fatal('DATABASE_URL is not set');
    process.exit(1);
  }
  try {
    await runMigrations(url);
    process.exit(0);
  } catch (err) {
    bootstrapLogger.fatal({ err }, 'migrations_failed');
    process.exit(1);
  }
}
