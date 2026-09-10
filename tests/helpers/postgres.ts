import { generateKeyPairSync } from 'node:crypto';

import { pino } from 'pino';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { loadConfig, resetConfigCache, type Config } from '../../src/config.js';
import { createDatabase, type DatabaseHandle } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed.js';
import type { ResolvedStore } from '../../src/modules/stores/index.js';
import { bootstrapLogger } from '../../src/shared/logger.js';

/**
 * A real PostgreSQL for integration tests.
 *
 * Testcontainers, not a shared local database and not a mock. The things being tested here
 * — `FOR UPDATE SKIP LOCKED`, transaction rollback, `ON CONFLICT DO NOTHING` — have no
 * meaningful in-memory equivalent. A mock would assert that the code calls the functions we
 * wrote, which is not the same as asserting the database behaves as we believe.
 */

/**
 * Debian, NOT `-alpine`. Alpine/musl images fail to exec on some Docker Desktop + WSL2
 * kernels ("accessing a corrupted shared library"), which presents as an unrelated and
 * baffling container startup failure. Matches docker-compose.yml.
 */
const POSTGRES_IMAGE = 'postgres:16';

export type TestDatabase = {
  handle: DatabaseHandle;
  config: Config;
  connectionUri: string;
  /** Empty every table, preserving schema. Between tests, not between files. */
  truncate: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * A real RS256 keypair for tests, generated ONCE per test process.
 *
 * The harness previously supplied `'test-private-key-placeholder'`, which is not a PEM and
 * cannot sign anything — so no token could ever be tested. Config now validates PEM shape,
 * which makes the placeholder a hard failure rather than a latent one.
 *
 * Generated rather than committed: a private key in the repository is a private key in every
 * fork, branch, and CI log, and a reviewer cannot tell at a glance that it is "only" a test
 * key. Generated rather than per-test: RSA-2048 keygen costs ~100-300ms, which is per-test
 * overhead nobody would accept and per-process overhead nobody notices.
 *
 * Uses Node's built-in `node:crypto` and the same encodings as `scripts/generate-keys.ts`
 * (PKCS#8 private, SPKI public), so tests exercise the shape production actually receives.
 */
let testKeyPair: { privateKey: string; publicKey: string } | undefined;

function getTestKeyPair(): { privateKey: string; publicKey: string } {
  testKeyPair ??= generateKeyPairSync('rsa', {
    // 2048 is the RS256 floor and what `pnpm keys:generate` produces. Larger keys would only
    // slow the suite down without testing anything different.
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return testKeyPair;
}

/**
 * The generated public key, exposed so a token test can assert a `kid` thumbprint or verify
 * with the matching key. The private key is deliberately NOT exported: tests should issue
 * tokens through the token service, not sign them by hand.
 */
export function testPublicKeyPem(): string {
  return getTestKeyPair().publicKey;
}

/**
 * Minimum viable environment for `loadConfig()`.
 *
 * Config is fail-fast by design, so a test that needs a `Config` must supply everything —
 * including a JWT keypair. Rather than generate real RSA keys (slow, and irrelevant to
 * anything under test here), supply syntactically valid placeholders. Auth tests that
 * actually sign a token will generate their own.
 */
function testEnvironment(databaseUrl: string, redisBaseUrl?: string): NodeJS.ProcessEnv {
  /**
   * Defaults point at the docker-compose Redis on high-numbered logical databases, so a
   * test that only needs Postgres does not also need a Redis container. A test that
   * genuinely exercises Redis passes its own Testcontainers URL.
   */
  const redis = redisBaseUrl ?? 'redis://localhost:56379';
  return {
    NODE_ENV: 'test',
    ENVIRONMENT: 'test',
    PORT: '8000',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '5',
    REDIS_CACHE_URL: `${redis}/10`,
    REDIS_LOCK_URL: `${redis}/11`,
    REDIS_QUEUE_URL: `${redis}/12`,
    JWT_PRIVATE_KEY: getTestKeyPair().privateKey,
    JWT_PUBLIC_KEY: getTestKeyPair().publicKey,
    JWT_ISSUER: 'ecom-test',
    JWT_AUDIENCE: 'ecom-test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
    PAYMENT_SANDBOX_MODE: 'true',
    S3_BUCKET: 'test',
    S3_REGION: 'us-east-1',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    // 'error', not 'silent': pino accepts silent but our config enum deliberately does
    // not, and loadConfig exits the process on a validation failure — which would kill
    // the whole test run rather than fail one case.
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
  };
}

/**
 * Start a container, migrate it, and hand back a connected client.
 *
 * Call once per test file in `beforeAll`. Container startup dominates the runtime, so
 * per-test containers would make the suite unusable; per-test isolation comes from
 * `truncate()` instead.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('ecom_test')
    .withUsername('ecom')
    .withPassword('ecom')
    // No durability needed for a database that is destroyed in 30 seconds, and losing
    // fsync makes the suite noticeably faster.
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
    .start();

  const connectionUri = container.getConnectionUri();

  // The migration runner is the SAME code production uses. A test schema built by a
  // separate `CREATE TABLE` script would drift from the migrations and hide exactly the
  // bugs this suite is meant to catch.
  await runMigrations(connectionUri);

  resetConfigCache();
  const config = loadConfig(testEnvironment(connectionUri));
  const handle = createDatabase(connectionUri, config, bootstrapLogger, 'primary');

  return {
    handle,
    config,
    connectionUri,

    /**
     * `TRUNCATE ... CASCADE` in one statement, rather than per-table DELETEs: it resets
     * every table regardless of foreign-key order, which means adding a table in a later
     * phase does not require editing this helper.
     */
    async truncate() {
      const { rows } = await handle.pool.query<{ tables: string }>(`
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tables
        FROM pg_tables
        WHERE schemaname = 'public'
      `);
      const tables = rows[0]?.tables;
      if (tables) {
        await handle.pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
      }
    },

    async stop() {
      await handle.close();
      resetConfigCache();
      await container.stop();
    },
  };
}

/**
 * A logger that emits nothing.
 *
 * Integration tests deliberately exercise failure paths, so the real logger buries the one
 * assertion message that matters under a screenful of expected warnings — which happened
 * while writing these tests and cost real time.
 */
export const silentLogger: typeof bootstrapLogger = pino({ level: 'silent' });

/**
 * Build a `Config` pointing at throwaway containers.
 *
 * Reuses the same `testEnvironment` the database helper uses, so a config field added there
 * is automatically present here — two hand-maintained copies of a 20-field environment map
 * would drift, and the failure mode is a `loadConfig()` that exits the whole test run.
 *
 * `resetConfigCache()` first, because `loadConfig` memoises: without it the second caller in
 * a run silently receives the first caller's database URL.
 */
export function buildTestConfig(args: {
  databaseUrl: string;
  redisUrl?: string;
  /**
   * Extra environment, layered OVER the defaults above.
   *
   * For the few settings a suite must control rather than inherit: the E2E journey configures
   * Razorpay credentials (the container builds the real gateway only when all three are
   * present, and answers `503` otherwise) and raises the auth rate limits, which default to
   * 10 requests per IP per minute and would otherwise reject a long sequential journey's own
   * logins as an attack.
   *
   * Optional and additive, so every existing caller gets exactly the environment it got
   * before.
   */
  extraEnv?: NodeJS.ProcessEnv;
}): Config {
  resetConfigCache();
  const config = loadConfig({
    ...testEnvironment(args.databaseUrl, args.redisUrl),
    ...args.extraEnv,
  });
  // Cleared again so the memo does not leak into the next test file.
  resetConfigCache();
  return config;
}

/**
 * Seed the configured default store into a test database.
 *
 * Calls the SAME `seed()` the operator runs via `pnpm db:seed`, rather than inserting a
 * store with its own INSERT. A hand-rolled fixture would drift from the real seed, and the
 * drift only ever surfaces as a test that passes against a database production never
 * produces.
 *
 * Idempotent, so it is safe to call after `truncate()` in a `beforeEach`.
 */
export async function seedTestStore(testDb: TestDatabase): Promise<ResolvedStore> {
  const { store } = await seed({
    db: testDb.handle.db,
    config: testDb.config,
    logger: silentLogger,
  });
  return store;
}
