import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../tests/helpers/redis.ts';
import { DomainError } from '../../shared/errors.js';
import { createRateLimiter, hashRateLimitSubject, type RateLimiter } from '../rate-limiter.js';

/**
 * The rate limiter, against real Redis.
 *
 * Real Redis and not a mock, for the same reason the outbox tests use a real database: the
 * behaviour under test IS the Redis semantics. `INCR` on a missing key creating it at 1,
 * `PEXPIRE` only applying to an existing key, `PTTL` returning -2 rather than 0 for a key that
 * does not exist — a mock would encode my assumptions about all three, and the assumptions are
 * exactly what could be wrong.
 */
describe('rate limiter (integration)', () => {
  let testRedis: TestRedis;
  let redis: Redis;
  let limiter: RateLimiter;

  const POLICY = { max: 3, windowSeconds: 60 };
  const BUCKET = 'test:bucket';

  beforeAll(async () => {
    testRedis = await startTestRedis();
    redis = new Redis(testRedis.url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    limiter = createRateLimiter({ redis, logger: silentLogger });
  }, 180_000);

  afterAll(async () => {
    await redis?.quit();
    await testRedis?.stop();
  });

  beforeEach(async () => {
    await testRedis.flush();
  });

  describe('consume', () => {
    it('allows exactly `max` attempts, then blocks', async () => {
      const results = [];
      for (let i = 0; i < 5; i += 1) {
        results.push(await limiter.consume(BUCKET, 'subject-a', POLICY));
      }

      // Boundary precision, not an approximation: the third attempt must be ALLOWED and the
      // fourth blocked. An off-by-one here silently gives every attacker a free guess, or
      // locks out a user one attempt early.
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
      expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4, 5]);
    });

    it('reports remaining budget, floored at zero', async () => {
      const first = await limiter.consume(BUCKET, 'subject-b', POLICY);
      expect(first.remaining).toBe(2);

      for (let i = 0; i < 4; i += 1) await limiter.consume(BUCKET, 'subject-b', POLICY);

      const over = await limiter.consume(BUCKET, 'subject-b', POLICY);
      // Never negative: this value goes into an `X-RateLimit-Remaining` header, and a
      // negative number there confuses clients that parse it as unsigned.
      expect(over.remaining).toBe(0);
    });

    it('keeps subjects independent', async () => {
      for (let i = 0; i < 4; i += 1) await limiter.consume(BUCKET, 'noisy', POLICY);

      const quiet = await limiter.consume(BUCKET, 'quiet', POLICY);

      // The whole point of a per-subject limiter. If one subject's traffic could exhaust
      // another's budget, one abusive client would lock out every customer.
      expect(quiet.allowed).toBe(true);
      expect(quiet.count).toBe(1);
    });

    it('keeps buckets independent', async () => {
      for (let i = 0; i < 4; i += 1) await limiter.consume('bucket:one', 'same-subject', POLICY);

      const other = await limiter.consume('bucket:two', 'same-subject', POLICY);

      // Being blocked on login must not block registration, and vice versa.
      expect(other.allowed).toBe(true);
    });
  });

  describe('window expiry', () => {
    it('sets the TTL on the first attempt', async () => {
      await limiter.consume(BUCKET, 'ttl-subject', POLICY);

      const ttl = await redis.pttl(`rl:${BUCKET}:ttl-subject`);

      // Without this the key would live forever and a single burst would block the subject
      // permanently — a self-inflicted denial of service on a real customer.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });

    it('does NOT extend the window on later attempts', async () => {
      const shortPolicy = { max: 100, windowSeconds: 60 };
      await limiter.consume(BUCKET, 'no-extend', shortPolicy);

      // Age the window by rewriting the TTL, rather than sleeping 60 seconds.
      await redis.pexpire(`rl:${BUCKET}:no-extend`, 5_000);
      await limiter.consume(BUCKET, 'no-extend', shortPolicy);

      const ttl = await redis.pttl(`rl:${BUCKET}:no-extend`);

      /**
       * The `if count == 1` guard in the Lua script is what this pins. Calling `PEXPIRE`
       * unconditionally would let a blocked attacker hold their own block open indefinitely
       * by continuing to hammer — which sounds like their problem until you notice it is
       * also how you permanently lock out a legitimate user whose client retries in a loop.
       */
      expect(ttl).toBeLessThanOrEqual(5_000);
    });

    it('allows attempts again once the window expires', async () => {
      for (let i = 0; i < 4; i += 1) await limiter.consume(BUCKET, 'expiring', POLICY);
      expect((await limiter.consume(BUCKET, 'expiring', POLICY)).allowed).toBe(false);

      // Simulate the window elapsing. A fixed window resets wholesale rather than sliding.
      await redis.del(`rl:${BUCKET}:expiring`);

      expect((await limiter.consume(BUCKET, 'expiring', POLICY)).allowed).toBe(true);
    });

    it('reports the full window when no TTL is live', async () => {
      const verdict = await limiter.peek(BUCKET, 'never-seen', POLICY);

      /**
       * `PTTL` returns -2 for a missing key. Passing that through would produce
       * `Retry-After: -2`, which some clients reject and others read as "retry now".
       */
      expect(verdict.retryAfterSeconds).toBe(60);
      expect(verdict.count).toBe(0);
    });

    it('never reports a retry interval below one second', async () => {
      await limiter.consume(BUCKET, 'sub-second', POLICY);
      // 200ms left: `Math.ceil` would give 1, but a 40ms remainder would floor to 0.
      await redis.pexpire(`rl:${BUCKET}:sub-second`, 40);

      const verdict = await limiter.peek(BUCKET, 'sub-second', POLICY);

      // `Retry-After: 0` invites an immediate retry, which is the opposite of backing off.
      expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
  });

  describe('peek', () => {
    it('does not increment', async () => {
      await limiter.consume(BUCKET, 'peeked', POLICY);

      await limiter.peek(BUCKET, 'peeked', POLICY);
      await limiter.peek(BUCKET, 'peeked', POLICY);
      await limiter.peek(BUCKET, 'peeked', POLICY);

      const after = await limiter.peek(BUCKET, 'peeked', POLICY);

      /**
       * The behaviour the per-email limiter depends on entirely. If `peek` counted, every
       * login REQUEST would spend the failure budget and five successful sign-ins in a
       * minute would lock a user out of their own account.
       */
      expect(after.count).toBe(1);
    });

    it('creates no key for an unseen subject', async () => {
      await limiter.peek(BUCKET, 'ghost', POLICY);

      /**
       * A `peek` that created keys would let anyone allocate unbounded Redis memory by
       * sending login requests with random email addresses — a memory-exhaustion vector
       * opened by the defence against a CPU-exhaustion vector.
       */
      expect(await redis.exists(`rl:${BUCKET}:ghost`)).toBe(0);
    });

    it('reflects a budget already spent', async () => {
      for (let i = 0; i < 4; i += 1) await limiter.record(BUCKET, 'spent', POLICY);

      const verdict = await limiter.peek(BUCKET, 'spent', POLICY);

      // This is the exact path the middleware takes: the service recorded failures, and a
      // later request is refused without the middleware itself counting anything.
      expect(verdict.allowed).toBe(false);
      expect(verdict.count).toBe(4);
    });
  });

  describe('record and reset', () => {
    it('record increments the same counter peek reads', async () => {
      await limiter.record(BUCKET, 'shared-key', POLICY);
      await limiter.record(BUCKET, 'shared-key', POLICY);

      expect((await limiter.peek(BUCKET, 'shared-key', POLICY)).count).toBe(2);
    });

    it('reset clears the counter', async () => {
      for (let i = 0; i < 4; i += 1) await limiter.record(BUCKET, 'forgiven', POLICY);
      expect((await limiter.peek(BUCKET, 'forgiven', POLICY)).allowed).toBe(false);

      await limiter.reset(BUCKET, 'forgiven');

      // What a successful login does: prior failures are forgiven on proof of ownership.
      expect((await limiter.peek(BUCKET, 'forgiven', POLICY)).allowed).toBe(true);
      expect((await limiter.peek(BUCKET, 'forgiven', POLICY)).count).toBe(0);
    });

    it('reset of an unseen subject is a no-op, not an error', async () => {
      // Every successful login calls this, including the first one a user ever makes.
      await expect(limiter.reset(BUCKET, 'never-failed')).resolves.toBeUndefined();
    });
  });

  describe('failing closed', () => {
    /**
     * The security property that makes this whole increment worth having.
     *
     * A limiter that allows the request when its backend is down is a limiter an attacker
     * removes by attacking Redis — converting an availability problem into unlimited brute
     * force. Every method must refuse rather than allow.
     */
    it('throws rather than allowing when Redis is unreachable', async () => {
      // Port 1 is reserved and never listening. `enableOfflineQueue: false` means the command
      // fails immediately instead of being buffered forever.
      const dead = new Redis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      // An unreachable client emits 'error'; without a listener Node treats it as unhandled.
      dead.on('error', () => {});

      const failing = createRateLimiter({ redis: dead, logger: silentLogger });

      await expect(failing.consume(BUCKET, 'anyone', POLICY)).rejects.toThrow(DomainError);
      await expect(failing.peek(BUCKET, 'anyone', POLICY)).rejects.toThrow(DomainError);
      await expect(failing.record(BUCKET, 'anyone', POLICY)).rejects.toThrow(DomainError);
      await expect(failing.reset(BUCKET, 'anyone')).rejects.toThrow(DomainError);

      dead.disconnect();
    }, 30_000);

    it('reports the failure as a 503, not a 429', async () => {
      const dead = new Redis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      dead.on('error', () => {});

      const failing = createRateLimiter({ redis: dead, logger: silentLogger });
      const error = await failing.consume(BUCKET, 'anyone', POLICY).catch((err: unknown) => err);

      /**
       * 503 and not 429, deliberately. A 429 would tell the client "you have made too many
       * attempts", which is false and un-actionable — they made one. A 503 says a dependency
       * is broken, which is true, is retryable, and is what a monitoring dashboard should
       * count as OUR fault rather than as attack traffic.
       */
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).statusCode).toBe(503);

      dead.disconnect();
    }, 30_000);
  });

  describe('subject hashing', () => {
    it('is stable for the same inputs and different across them', () => {
      // Stability is what lets the middleware and the service agree on a key. If this were
      // salted per process, the two would never touch the same counter.
      expect(hashRateLimitSubject('store-1', 'a@example.com')).toBe(
        hashRateLimitSubject('store-1', 'a@example.com'),
      );
      expect(hashRateLimitSubject('store-1', 'a@example.com')).not.toBe(
        hashRateLimitSubject('store-2', 'a@example.com'),
      );
    });

    it('separates parts so they cannot be confused by concatenation', () => {
      /**
       * `('ab', 'c')` and `('a', 'bc')` must differ. Joining without a separator would make
       * them identical, letting a crafted email address land in another store's bucket —
       * cross-tenant budget interference from a naive `+`.
       */
      expect(hashRateLimitSubject('ab', 'c')).not.toBe(hashRateLimitSubject('a', 'bc'));
    });

    it('produces a fixed-length key regardless of input size', () => {
      const short = hashRateLimitSubject('s', 'a@b.co');
      const long = hashRateLimitSubject('s', `${'x'.repeat(300)}@example.com`);

      // The input is attacker-controlled; the key length must not be.
      expect(short).toHaveLength(32);
      expect(long).toHaveLength(32);
    });

    it('contains no trace of the plaintext', () => {
      const email = 'victim@example.com';
      const hashed = hashRateLimitSubject('store-1', email);

      // PII must not sit in a Redis key that shows up in `KEYS *` during an incident.
      expect(hashed).not.toContain('victim');
      expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
