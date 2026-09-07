import { pathToFileURL } from 'node:url';

import { loadConfig, type Config } from '../config.js';
import { createStoreRepository, type ResolvedStore } from '../modules/stores/index.js';
import { newId } from '../shared/id.js';
import { bootstrapLogger, type Logger } from '../shared/logger.js';
import { createDatabase, type Database } from './client.js';

/**
 * Seeding.
 *
 * Creates the minimum a running system needs and nothing more. Right now that is exactly one
 * row: the store every request resolves to. `app_user.store_id` is NOT NULL, so without it
 * registration cannot work at all — this is the bootstrap step, not demo data.
 *
 * IDEMPOTENT by construction, not by convention. `pnpm db:seed` is expected to be run
 * repeatedly: by a developer, by a test helper, and potentially by a deploy hook. It relies
 * on `ON CONFLICT DO NOTHING` against the unique slug index rather than a read-then-write,
 * so two concurrent runs cannot produce a duplicate or a crash.
 *
 * Product demo data (products, stock, promotions) belongs to the phase that introduces those
 * tables. Adding placeholders now would mean writing fixtures for a schema that does not
 * exist.
 */

export type SeedResult = {
  store: ResolvedStore;
  /** False when the store was already present — the normal case on a re-run. */
  storeCreated: boolean;
};

/**
 * Seed against an existing connection.
 *
 * Exported separately from the CLI entry point so the integration test helper can call the
 * SAME code the operator runs. A test fixture that built its store with its own INSERT would
 * drift from the seed, and the drift would only surface as a test that passes against a
 * database production never produces.
 */
export async function seed(deps: {
  db: Database;
  config: Config;
  logger: Logger;
}): Promise<SeedResult> {
  const { db, config, logger } = deps;
  const stores = createStoreRepository({ db });

  const { store, created } = await stores.createIfAbsent({
    id: newId(),
    slug: config.defaultStoreSlug,
    /**
     * A readable placeholder name derived from the slug. Deliberately not something like
     * "Demo Store": a merchant renames this through the admin API, and a name that looks
     * like sample data invites somebody to "clean it up" and delete the row every user row
     * depends on.
     */
    name: config.defaultStoreSlug,
    currency: config.defaultCurrency,
  });

  logger.info(
    { storeId: store.id, slug: store.slug, created },
    created ? 'seed_store_created' : 'seed_store_exists',
  );

  return { store, storeCreated: created };
}

/* ── CLI entry point ─────────────────────────────────────────────────────── */

/**
 * `pathToFileURL`, not a `file://${argv[1]}` template.
 *
 * On Windows `argv[1]` is `C:\path\to\seed.ts` while `import.meta.url` is
 * `file:///C:/path/to/seed.ts`, so the string comparison never matches and the script exits
 * 0 having done nothing. That exact bug was found in `migrate.ts`; this is the fixed form.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = bootstrapLogger;
  const handle = createDatabase(config.databaseUrl, config, logger, 'primary');

  try {
    await seed({ db: handle.db, config, logger });
    logger.info('seed_complete');
  } catch (err) {
    logger.fatal({ err }, 'seed_failed');
    process.exitCode = 1;
  } finally {
    // Always released, including on failure: a leaked pool means the process hangs instead
    // of reporting the error that caused it.
    await handle.close();
  }
}
