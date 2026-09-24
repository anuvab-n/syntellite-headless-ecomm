import type { Logger } from '../shared/logger.js';
import {
  rateLimitVerdict,
  type RateLimiter,
  type RateLimitPolicy,
  type RateLimitVerdict,
} from './rate-limiter.js';

/**
 * Fixed-window rate limiting in process memory, for deployments running without Redis.
 *
 * **This is a single-instance substitute, not a replacement.** It is selected only when
 * `REDIS_LOCK_URL` is unset, which `config.ts` permits outside production and refuses
 * inside it. The reason for that asymmetry is the one property this cannot provide: the
 * counters live in one process, so N replicas give an attacker N times the budget, and a
 * restart clears every block. Against a distributed credential-stuffing attempt that is no
 * defence at all. On a developer's laptop — one process, one attacker at most, and the
 * point is to exercise the same code path rather than to withstand a botnet — it is exactly
 * equivalent.
 *
 * Deliberately mirrors the Redis limiter rather than simplifying:
 *
 *  - Same FIXED window, so the boundary-burst behaviour a test observes locally is the
 *    behaviour production has.
 *  - Same verdict arithmetic, imported rather than reimplemented. `rateLimitVerdict` is
 *    shared precisely so `allowed` and `remaining` cannot differ between the two.
 *  - Same `peek`/`consume` split, so the service's "check before, spend after" flow is
 *    unchanged.
 *
 * What it does NOT mirror is failure: there is no dependency to be unavailable, so nothing
 * here throws `DependencyUnavailable`. The Redis limiter fails closed because a reachable
 * Redis is the thing that proves the count; a `Map` in this process cannot become
 * unreachable without the process itself being gone.
 */

/** One fixed window: how many attempts, and when the window lapses. */
type Window = {
  count: number;
  /** Epoch milliseconds. Past this, the entry is treated as absent. */
  expiresAt: number;
};

/**
 * How often to drop lapsed windows.
 *
 * Necessary, not housekeeping. Keys are derived from attacker-supplied subjects (hashed
 * emails, client IPs), so without a sweep a flood of distinct subjects grows the map
 * without bound — the Redis limiter is immune because `PEXPIRE` reclaims the key itself.
 * Expiry is ALSO checked lazily on every read, so the sweep only reclaims memory; it is
 * never what makes a verdict correct.
 */
const SWEEP_INTERVAL_MS = 60_000;

export function createInMemoryRateLimiter(deps: {
  logger: Logger;
  /** Namespace, matching the Redis limiter's so bucket names behave identically. */
  keyPrefix?: string;
}): RateLimiter {
  const { logger } = deps;
  const prefix = deps.keyPrefix ?? 'rl';

  const windows = new Map<string, Window>();

  const keyFor = (bucket: string, subject: string): string => `${prefix}:${bucket}:${subject}`;

  /**
   * Warn once at construction rather than per request.
   *
   * Silently degrading a security control is how it stops protecting anything without
   * anybody noticing, so the substitution is stated in the log. Per request it would be
   * noise that gets filtered, which amounts to the same silence.
   */
  logger.warn(
    'rate_limiter_in_memory: REDIS_LOCK_URL is unset, so rate limits are per-process and ' +
      'reset on restart. Single-instance deployments only; production requires Redis.',
  );

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) {
      if (window.expiresAt <= now) windows.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  // Must never be the reason the process stays alive at shutdown.
  sweep.unref();

  /**
   * The live window for a key, or undefined once it has lapsed.
   *
   * Lapsed entries are deleted on sight rather than left for the sweep, so a long-lived key
   * that is read often never accumulates a stale count.
   */
  function liveWindow(key: string): Window | undefined {
    const window = windows.get(key);
    if (!window) return undefined;
    if (window.expiresAt <= Date.now()) {
      windows.delete(key);
      return undefined;
    }
    return window;
  }

  /** Increment, creating the window (and its expiry) on first touch. */
  function increment(key: string, policy: RateLimitPolicy): Window {
    const existing = liveWindow(key);
    if (existing) {
      existing.count += 1;
      return existing;
    }
    /**
     * The expiry is set ONLY when the window is created, matching the Redis script's
     * `PEXPIRE` on `count == 1`. Refreshing it on every hit would let a sustained burst
     * push the reset time forward indefinitely and turn a one-minute limit into a
     * permanent block.
     */
    const created: Window = {
      count: 1,
      expiresAt: Date.now() + policy.windowSeconds * 1000,
    };
    windows.set(key, created);
    return created;
  }

  /** Remaining window in milliseconds, using the `PTTL` convention of -2 for "absent". */
  function ttlMsOf(window: Window | undefined): number {
    return window ? window.expiresAt - Date.now() : -2;
  }

  function verdictFor(
    window: Window | undefined,
    policy: RateLimitPolicy,
    counting: 'includes-this-attempt' | 'prior-attempts-only',
  ): RateLimitVerdict {
    return rateLimitVerdict(window?.count ?? 0, ttlMsOf(window), policy, counting);
  }

  return {
    consume(bucket, subject, policy) {
      const window = increment(keyFor(bucket, subject), policy);
      return Promise.resolve(verdictFor(window, policy, 'includes-this-attempt'));
    },

    peek(bucket, subject, policy) {
      const window = liveWindow(keyFor(bucket, subject));
      return Promise.resolve(verdictFor(window, policy, 'prior-attempts-only'));
    },

    record(bucket, subject, policy) {
      increment(keyFor(bucket, subject), policy);
      return Promise.resolve();
    },

    reset(bucket, subject) {
      windows.delete(keyFor(bucket, subject));
      return Promise.resolve();
    },
  };
}
