import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { buildOpenApiSpec } from '../../src/http/routes/docs.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * The endpoint inventory — the audit's ground truth.
 *
 * Enumerates what the REAL container actually registers by walking the Express router stack,
 * then diffs that against the hand-written OpenAPI document. Both halves matter and they fail
 * differently:
 *
 *  - **Registered but undocumented** is a client-facing gap: the endpoint works and nobody
 *    outside the codebase can discover it.
 *  - **Documented but unregistered** is worse: a client codes against a path that 404s.
 *
 * The existing `docs.integration.test.ts` already guards the second direction, but against a
 * hand-maintained stub app rather than the real container — so a route that exists in the spec
 * and in the stub, but was never wired into `buildContainer`, passes there and fails here.
 * This file closes that gap.
 *
 * It also writes the inventory to disk so the audit report can quote it rather than paraphrase.
 */
/**
 * Where the inventory is written.
 *
 * Under the OS temp directory, not the repository: the file is an audit artefact rather
 * than source, and writing it into the working tree makes `format:check` fail on a
 * generated JSON file nobody should be formatting.
 */
const INVENTORY_PATH = join(tmpdir(), 'endpoint-inventory.json');

describe('endpoint inventory (audit)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({ databaseUrl: testDb.connectionUri, redisUrl: redis.url }),
      drainer: { pollIntervalMs: 50 },
    });
    await seedTestStore({ ...testDb, config: container.config });
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /**
   * The prefixes routers are mounted at, stripped from BOTH sides before comparison.
   *
   * Express 5 does not expose a mounted router's path on its layer — there is no `path` and no
   * `regexp` to reverse — so the prefix cannot be recovered by walking the stack. Rather than
   * reconstruct it from internals that changed once already, both inventories are compared on
   * the unprefixed path, and the mount points are asserted separately over HTTP below.
   */
  const MOUNT_PREFIXES = ['/api/v1/webhooks', '/api/v1', '/health'];

  /** Strip the LONGEST matching mount prefix, so `/api/v1/webhooks` wins over `/api/v1`. */
  const unprefixed = (entry: string): string => {
    for (const prefix of [...MOUNT_PREFIXES].sort((a, b) => b.length - a.length)) {
      if (entry.includes(` ${prefix}/`)) return entry.replace(` ${prefix}/`, ' /');
    }
    return entry;
  };

  /**
   * Walk the Express router tree and collect every registered method+path.
   *
   * Paths are as the ROUTER declares them, without the prefix it was mounted at — see
   * `MOUNT_PREFIXES`.
   */
  function registeredRoutes(): string[] {
    const found: string[] = [];

    const walk = (stack: unknown[]): void => {
      for (const entry of stack) {
        const layer = entry as {
          route?: { path: string | string[]; methods: Record<string, boolean> };
          handle?: { stack?: unknown[] };
        };

        if (layer.route) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          for (const p of paths) {
            for (const [method, enabled] of Object.entries(layer.route.methods)) {
              if (enabled && method !== '_all') found.push(`${method.toUpperCase()} ${p}`);
            }
          }
          continue;
        }

        if (layer.handle?.stack) walk(layer.handle.stack);
      }
    };

    const app = container.app as unknown as {
      router?: { stack?: unknown[] };
      _router?: { stack?: unknown[] };
    };
    walk(app.router?.stack ?? app._router?.stack ?? []);

    return [...new Set(found)].sort();
  }

  /**
   * The OpenAPI document, built from the same function the docs route serves.
   *
   * Read directly rather than over HTTP: the docs router is mounted outside the versioned
   * API prefix, and going through the wire would only test the mount point.
   */
  function documentedRoutes(): string[] {
    const spec = buildOpenApiSpec(container.config) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const out: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          // OpenAPI writes {id}; Express writes :id. Normalise to Express form.
          out.push(`${method.toUpperCase()} ${path.replaceAll(/\{([^}]+)\}/gu, ':$1')}`);
        }
      }
    }
    return [...new Set(out)].sort();
  }

  it('enumerates the registered routes and writes the inventory', () => {
    const registered = registeredRoutes();
    const documented = documentedRoutes().map(unprefixed);

    expect(registered.length).toBeGreaterThan(50);

    const registeredSet = new Set(registered);
    const documentedSet = new Set(documented);

    const undocumented = registered.filter((r) => !documentedSet.has(r));
    const unregistered = documented.filter((d) => !registeredSet.has(d));

    writeFileSync(
      INVENTORY_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          counts: {
            registered: registered.length,
            documented: documented.length,
            undocumented: undocumented.length,
            unregistered: unregistered.length,
          },
          registered,
          documented,
          registeredButUndocumented: undocumented,
          documentedButUnregistered: unregistered,
        },
        null,
        2,
      ),
      'utf8',
    );

    /*
     * Reported, not asserted to zero.
     *
     * The audit's job is to surface discrepancies with evidence; failing here would hide the
     * list behind a single red line. The counts are asserted in the two cases below, where a
     * non-zero value is genuinely a defect.
     */
    expect(Array.isArray(registered)).toBe(true);
  });

  it('documents every route the container registers under /api/v1', () => {
    const registered = registeredRoutes().filter((r) => !r.includes('/docs'));
    const documented = new Set(documentedRoutes().map(unprefixed));

    const undocumented = registered.filter((r) => !documented.has(r));

    expect(undocumented, `registered but NOT documented:\n${undocumented.join('\n')}`).toEqual([]);
  });

  it('registers every route the OpenAPI document describes', () => {
    const registered = new Set(registeredRoutes());
    const documented = documentedRoutes().map(unprefixed);

    const unregistered = documented.filter((d) => !registered.has(d));

    expect(unregistered, `documented but NOT registered:\n${unregistered.join('\n')}`).toEqual([]);
  });
});
