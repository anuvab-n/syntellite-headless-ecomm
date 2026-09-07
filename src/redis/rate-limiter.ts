import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import { DependencyUnavailable } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { waitForRedisReady } from './ready.js';

/**
 * Fixed-window rate limiting on Redis.
 *
 * No library. `rate-limiter-flexible` would add a dependency to wrap `INCR` and `PEXPIRE`,
 * and this codebase already hand-writes Lua for the leader lock — the same tool, for the same
 * reason: a check-then-set across two round trips is not atomic, and under exactly the load a
 * rate limiter exists to handle, two concurrent requests would both read the same count and
 * both be allowed.
 *
 * FIXED window, not sliding. One integer per key, which matters under a flood: a sliding
 * window keeps one sorted-set member per attempt, so an attacker controls our memory. The
 * cost is a boundary burst — 10 attempts at 0:59 and 10 more at 1:01 is 20 inside two
 * seconds. That is immaterial here: the goal is stopping thousands of guesses, not exactly
 * ten, and the burst is still bounded at 2× rather than unbounded.
 *
 * FAILS CLOSED. Every Redis error becomes a `DependencyUnavailable` (503) rather than a
 * silent allow. Without that, knocking Redis over would convert an availability attack into
 * unlimited brute force — an availability problem escalating into a security one. The lock
 * client already runs with `enableOfflineQueue: false`, so a command issued while
 * disconnected throws immediately rather than queueing.
 */

export type RateLimitPolicy = {
  /** Attempts permitted per window. */
  max: number;
  windowSeconds: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  /**
   * Raw counter value in this window.
   *
   * From `consume` this INCLUDES the attempt just made; from `peek` it counts only prior
   * attempts. `allowed` and `remaining` already account for the difference — read those
   * rather than comparing this against `policy.max` yourself.
   */
  count: number;
  /** Attempts left after this one. Never negative. */
  remaining: number;
  /** Seconds until the window resets. Always ≥ 1, so `Retry-After: 0` never happens. */
  retryAfterSeconds: number;
};

export type RateLimiter = {
  /** Count this attempt and report whether it is allowed. */
  consume(bucket: string, subject: string, policy: RateLimitPolicy): Promise<RateLimitVerdict>;
  /**
   * Report the current verdict WITHOUT counting.
   *
   * The per-email budget is checked before authentication but only spent after a failure, so
   * a legitimate user typing one wrong character does not burn budget on the retry that
   * succeeds. That split is why this exists separately from `consume`.
   */
  peek(bucket: string, subject: string, policy: RateLimitPolicy): Promise<RateLimitVerdict>;
  /** Count a failure against a subject. Used by the service after a rejected login. */
  record(bucket: string, subject: string, policy: RateLimitPolicy): Promise<void>;
  /** Clear a subject's counter. Used after a successful login. */
  reset(bucket: string, subject: string): Promise<void>;
};

/**
 * How long to wait for the client to connect before failing the check.
 *
 * The lock client has `enableOfflineQueue: false`, so a command issued microseconds after
 * boot throws against a socket still shaking hands. Bounded, because "wait forever" turns a
 * Redis outage into hung requests instead of fast 503s.
 */
const READY_WAIT_MS = 1_500;

/**
 * Increment, set the expiry on first touch, and report the remaining TTL — atomically.
 *
 * `PEXPIRE` only when the counter is new, so a burst inside a window cannot keep pushing the
 * reset time forward and extend a block indefinitely.
 */
const CONSUME_SCRIPT = `
local count = redis.call('incr', KEYS[1])
if count == 1 then
  redis.call('pexpire', KEYS[1], ARGV[1])
end
return { count, redis.call('pttl', KEYS[1]) }
`;

/** Read the counter and its TTL in one round trip, creating nothing. */
const PEEK_SCRIPT = `
local count = tonumber(redis.call('get', KEYS[1])) or 0
return { count, redis.call('pttl', KEYS[1]) }
`;

export function createRateLimiter(deps: {
  redis: Redis;
  logger: Logger;
  /** Namespace, so rate-limit keys never collide with locks or idempotency keys. */
  keyPrefix?: string;
}): RateLimiter {
  const { redis, logger } = deps;
  const prefix = deps.keyPrefix ?? 'rl';

  const keyFor = (bucket: string, subject: string): string => `${prefix}:${bucket}:${subject}`;

  /**
   * Turn a Lua `{count, pttl}` reply into a verdict.
   *
   * `PTTL` returns -2 for a missing key and -1 for a key with no expiry. Both mean "no live
   * window", so the full window is reported rather than a negative `Retry-After`, which some
   * clients treat as "retry immediately" and others reject outright.
   *
   * `counting` distinguishes the two callers, and getting it wrong is an off-by-one that
   * hands out a free attempt:
   *
   *  - `consume` has ALREADY incremented, so `count` includes the attempt being judged and
   *    the limit is reached when `count > max`.
   *  - `peek` counts only PRIOR attempts, so with `max` failures already recorded the budget
   *    is spent and the request being judged must be refused — `count >= max`.
   *
   * One shared comparison cannot serve both: it would either allow `max + 1` attempts through
   * the peek path or block the last legitimate one through consume.
   */
  function toVerdict(
    raw: unknown,
    policy: RateLimitPolicy,
    counting: 'includes-this-attempt' | 'prior-attempts-only',
  ): RateLimitVerdict {
    const [rawCount, rawTtl] = raw as [number, number];
    const count = Number(rawCount);
    const ttlMs = Number(rawTtl);

    const retryAfterSeconds =
      ttlMs > 0 ? Math.max(1, Math.ceil(ttlMs / 1000)) : policy.windowSeconds;

    const spent = counting === 'includes-this-attempt' ? count : count + 1;

    return {
      allowed: spent <= policy.max,
      count,
      // Budget left AFTER this request, which is what a client should back off against.
      remaining: Math.max(0, policy.max - spent),
      retryAfterSeconds,
    };
  }

  /**
   * Run a command, converting any Redis failure into a fail-closed 503.
   *
   * The `bucket` is logged but the SUBJECT is not: subjects are hashed emails and client IPs,
   * and a rate-limit outage should not dump either into the log at error volume.
   */
  async function guarded<T>(bucket: string, operation: () => Promise<T>): Promise<T> {
    try {
      await waitForRedisReady(redis, READY_WAIT_MS);
      return await operation();
    } catch (err) {
      logger.error({ err, bucket }, 'rate_limiter_unavailable');
      throw new DependencyUnavailable('rate-limiter');
    }
  }

  return {
    async consume(bucket, subject, policy) {
      return guarded(bucket, async () => {
        const raw = await redis.eval(
          CONSUME_SCRIPT,
          1,
          keyFor(bucket, subject),
          String(policy.windowSeconds * 1000),
        );
        return toVerdict(raw, policy, 'includes-this-attempt');
      });
    },

    async peek(bucket, subject, policy) {
      return guarded(bucket, async () => {
        const raw = await redis.eval(PEEK_SCRIPT, 1, keyFor(bucket, subject));
        return toVerdict(raw, policy, 'prior-attempts-only');
      });
    },

    async record(bucket, subject, policy) {
      await guarded(bucket, async () => {
        await redis.eval(
          CONSUME_SCRIPT,
          1,
          keyFor(bucket, subject),
          String(policy.windowSeconds * 1000),
        );
      });
    },

    async reset(bucket, subject) {
      await guarded(bucket, async () => {
        await redis.del(keyFor(bucket, subject));
      });
    },
  };
}

/**
 * Hash a rate-limit subject before it becomes part of a Redis key.
 *
 * Two reasons, and both matter:
 *
 *  1. **PII.** A raw email address in a Redis key is personal data sitting in a datastore
 *     that gets dumped, replicated, and inspected with `KEYS *` during incidents. A digest
 *     is just as usable as a counter key and reveals nothing.
 *  2. **Key shape.** An attacker controls the email they send. Hashing gives every key a
 *     fixed 32-character length, so a 320-character address cannot inflate key memory or
 *     smuggle a `:` that reshapes the namespace.
 *
 * Truncated to 128 bits, which is far beyond collision risk for a counter namespace — and a
 * collision would merely make two subjects share a budget, not bypass one.
 */
export function hashRateLimitSubject(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(' '), 'utf8').digest('hex').slice(0, 32);
}
