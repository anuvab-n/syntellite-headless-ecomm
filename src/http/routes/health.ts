import { Router } from 'express';

import type { Logger } from '../../shared/logger.js';
import { asyncHandler } from '../async-handler.js';

/**
 * Health endpoints.
 *
 * Two endpoints, and conflating them is one of the more expensive mistakes in an
 * orchestrated deployment:
 *
 *   /health/live  — "is this PROCESS alive?" Never touches a dependency. A failure here
 *                   means the orchestrator RESTARTS the container.
 *   /health/ready — "can this instance serve traffic?" Checks dependencies. A failure here
 *                   means the orchestrator REMOVES IT FROM THE LOAD BALANCER.
 *
 * Why liveness must not touch PostgreSQL: if it did, a database blip would fail liveness on
 * every instance simultaneously, the orchestrator would restart the entire fleet, and the
 * restarts would stampede the recovering database. The outage becomes self-sustaining.
 * Restarting a process cannot fix a database, so liveness must not ask about one.
 */

export type HealthCheck = {
  /** Appears verbatim in the response. Keep it a stable, boring identifier. */
  name: string;
  /** Resolve if healthy, throw or reject if not. */
  check: () => Promise<void>;
  /**
   * Whether the API can serve traffic without this dependency.
   *
   * PostgreSQL is required — nothing works without it. A cache is not: per the degradation
   * policy, losing the cache means slower browsing, and taking the instance out of the load
   * balancer for that would turn a performance dip into an outage.
   */
  required: boolean;
};

/** Per-dependency outcome. Deliberately coarse — see the note on leaking detail below. */
type CheckStatus = 'ok' | 'unavailable' | 'degraded';

export type ReadinessBody = {
  status: 'ok' | 'unavailable';
  checks: Record<string, CheckStatus>;
};

/**
 * How long a single dependency check may take before it is treated as unavailable.
 *
 * Without this, a hung TCP connection makes the readiness probe hang too. The orchestrator
 * then times the probe out and reports nothing useful, and — worse — probes pile up holding
 * connections. Failing fast and definitively is more useful than eventually being right.
 */
const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`health check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    // Without this the timer keeps the event loop alive and delays process exit.
    if (timer) clearTimeout(timer);
  }
}

export function createHealthRouter(deps: {
  checks: readonly HealthCheck[];
  logger: Logger;
}): Router {
  const { checks, logger } = deps;
  const router = Router();

  /**
   * Liveness. No dependencies, no `async`, no I/O of any kind.
   *
   * Returning 200 here means only "the event loop is turning and this process can accept
   * and answer a request" — which, notably, is also a genuine signal: if the event loop
   * were blocked by CPU-bound work, this would not answer at all.
   */
  router.get('/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * Readiness. Runs every check concurrently and reports each one.
   *
   * Concurrently, not sequentially: three 2-second timeouts in series is a 6-second probe,
   * which most orchestrators will have given up on.
   */
  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const results = await Promise.all(
        checks.map(async (dependency) => {
          try {
            await withTimeout(dependency.check(), CHECK_TIMEOUT_MS);
            return {
              name: dependency.name,
              status: 'ok' as CheckStatus,
              required: dependency.required,
            };
          } catch (err) {
            // Logged at warn WITH the error, because a failing readiness probe is a real
            // operational event and the reason must be diagnosable. This is also why
            // readiness is excluded from request logging but not from logging entirely.
            logger.warn({ err, dependency: dependency.name }, 'readiness_check_failed');
            return {
              name: dependency.name,
              // A non-required dependency being down is 'degraded', not 'unavailable':
              // it is visible on the probe without evicting the instance from the LB.
              status: (dependency.required ? 'unavailable' : 'degraded') as CheckStatus,
              required: dependency.required,
            };
          }
        }),
      );

      const body: ReadinessBody = {
        status: results.some((r) => r.required && r.status !== 'ok') ? 'unavailable' : 'ok',
        checks: Object.fromEntries(results.map((r) => [r.name, r.status])),
      };

      /**
       * 503 when a required dependency is down, so the orchestrator stops routing traffic
       * here. A 200 with `status: 'unavailable'` in the body would be ignored — probes read
       * the status code, not the JSON.
       *
       * The body reports only 'ok' / 'unavailable' / 'degraded' per dependency. No error
       * messages, no hostnames, no driver text: this endpoint is typically reachable from
       * further away than the rest of the API, and a connection error can contain a
       * connection string. The detail is in the log, keyed by the same request id.
       */
      res.status(body.status === 'ok' ? 200 : 503).json(body);
    }),
  );

  return router;
}

/**
 * PostgreSQL readiness check.
 *
 * Takes the probe function rather than the database handle, so this module never imports
 * from `db/` — the HTTP layer stays free of infrastructure imports, and the composition
 * root supplies the wiring.
 */
export function postgresCheck(probe: () => Promise<void>): HealthCheck {
  return { name: 'postgres', check: probe, required: true };
}

/**
 * Redis readiness check.
 *
 * `required: true` by default, and that is the deliberate choice for THIS system: Redis
 * holds idempotency keys and rate-limit counters, and the degradation policy fails closed on
 * anything touching money. An instance that cannot reach the lock store must not accept a
 * checkout, so it should leave the load balancer.
 *
 * Pass `required: false` only for a deployment where Redis is genuinely cache-only.
 */
export function redisCheck(probe: () => Promise<void>, required = true): HealthCheck {
  return { name: 'redis', check: probe, required };
}
