import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../tests/helpers/redis.ts';
import { createLeaderLock, type LeaderLock } from '../leader-lock.js';

/**
 * The scheduler singleton guarantee, against real Redis.
 *
 * Not mockable in any meaningful way: the property under test is that `SET NX PX` is atomic
 * and that a Lua compare-and-delete cannot remove somebody else's lock. Both are Redis
 * behaviours, and a fake would only assert that we call the functions we wrote.
 */
describe('leader lock (integration)', () => {
  let redis: TestRedis;
  const clients: Redis[] = [];
  const locks: LeaderLock[] = [];

  beforeAll(async () => {
    redis = await startTestRedis();
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.quit()));
    await redis?.stop();
  });

  afterEach(async () => {
    // Release before flushing, so a renewal timer cannot resurrect a key mid-test.
    await Promise.allSettled(locks.splice(0).map((l) => l.release()));
    await redis.flush();
  });

  /**
   * A separate client per lock, as two separate processes would have.
   *
   * Returns the client as well as the lock, so a test can kill the connection to simulate a
   * process that died — the only honest way to stop renewal without reaching into the lock.
   */
  function newLock(opts: { key?: string; ttlMs?: number } = {}): {
    lock: LeaderLock;
    client: Redis;
  } {
    const client = new Redis(redis.url, { maxRetriesPerRequest: 2 });
    clients.push(client);
    const lock = createLeaderLock({
      redis: client,
      logger: silentLogger,
      key: opts.key ?? 'test:scheduler:leader',
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    });
    locks.push(lock);
    return { lock, client };
  }

  /** The common case: only the lock is needed. */
  const lockOnly = (opts: { key?: string; ttlMs?: number } = {}): LeaderLock => newLock(opts).lock;

  /**
   * Poll until a condition holds, or fail with a message naming what was awaited.
   *
   * Used instead of a fixed sleep wherever the assertion is "eventually X". A sleep sized to
   * just past a timer interval measures timer punctuality under load; a poll measures the
   * property, passes as soon as it is true, and fails only when it never becomes true.
   */
  async function waitUntil(
    condition: () => boolean,
    what: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
  }

  /** Read the raw key from an independent connection, as an observer would. */
  async function heldToken(key = 'test:scheduler:leader'): Promise<string | null> {
    const observer = new Redis(redis.url, { maxRetriesPerRequest: 2 });
    try {
      return await observer.get(key);
    } finally {
      await observer.quit();
    }
  }

  describe('mutual exclusion', () => {
    it('lets exactly one of two instances become leader', async () => {
      const a = lockOnly();
      const b = lockOnly();

      expect(await a.tryAcquire()).toBe(true);
      // The second instance is refused. This is the guarantee the whole process depends on:
      // two schedulers would release stock twice and email every customer twice.
      expect(await b.tryAcquire()).toBe(false);

      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(false);
    });

    it('lets exactly one of many concurrent instances win', async () => {
      const contenders = Array.from({ length: 8 }, () => lockOnly());

      // Genuinely concurrent: eight `SET NX` racing on one key. `SET NX` is atomic, so one
      // wins — a check-then-set would let several through.
      const results = await Promise.all(contenders.map((l) => l.tryAcquire()));

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(contenders.filter((l) => l.isLeader())).toHaveLength(1);
    });

    it('keeps separate keys independent', async () => {
      const scheduler = lockOnly({ key: 'test:scheduler:leader' });
      const other = lockOnly({ key: 'test:something-else:leader' });

      // Two different singleton guarantees must not contend with each other.
      expect(await scheduler.tryAcquire()).toBe(true);
      expect(await other.tryAcquire()).toBe(true);
    });

    it('is idempotent for the current leader', async () => {
      const a = lockOnly();

      expect(await a.tryAcquire()).toBe(true);
      // A standby loop calls this every tick; the leader must not have to special-case it.
      expect(await a.tryAcquire()).toBe(true);
      expect(a.isLeader()).toBe(true);
    });
  });

  describe('release', () => {
    it('frees the lock for a standby to take over', async () => {
      const a = lockOnly();
      const b = lockOnly();

      await a.tryAcquire();
      expect(await b.tryAcquire()).toBe(false);

      // This is what a graceful shutdown does, and why it matters: without it the standby
      // waits out the full TTL on every deploy — a self-inflicted gap in scheduled work.
      await a.release();

      expect(a.isLeader()).toBe(false);
      expect(await b.tryAcquire()).toBe(true);
    });

    it('is safe to call when not the leader', async () => {
      const b = lockOnly();

      // Shutdown runs unconditionally, so release must tolerate never having led.
      await expect(b.release()).resolves.toBeUndefined();
      expect(b.isLeader()).toBe(false);
    });

    it('does not delete a lock it no longer owns', async () => {
      /**
       * NO sleeping, and a long TTL on purpose.
       *
       * This test needs `a` to still BELIEVE it is leader while `b` actually holds the key —
       * because `release()` returns early when `!leader`, so a stale instance that has
       * already stood down never reaches the Lua compare-and-delete at all. A long TTL keeps
       * `a`'s renewal timer (TTL/3) from firing during the test, which is what preserves that
       * belief deterministically.
       *
       * The previous version slept past a 1s TTL and was neither: if `a`'s renewal fired and
       * was rejected, `a` stood down and the assertion passed VACUOUSLY without exercising
       * the token; if the renewal won the race against expiry, `b` could not acquire and the
       * test failed. There was no interleaving in which it tested the fencing token.
       */
      const a = lockOnly({ ttlMs: 60_000 });
      const b = lockOnly({ ttlMs: 60_000 });

      expect(await a.tryAcquire()).toBe(true);
      expect(await heldToken()).toBe(a.token);

      // Simulate `a`'s lock having lapsed and `b` taking over, without waiting for a real
      // expiry: drop the key from an independent connection, then let `b` win it.
      const evictor = new Redis(redis.url, { maxRetriesPerRequest: 2 });
      try {
        expect(await evictor.del('test:scheduler:leader')).toBe(1);
      } finally {
        await evictor.quit();
      }

      expect(await b.tryAcquire()).toBe(true);
      // `a` has not noticed — exactly the dangerous state this guard exists for.
      expect(a.isLeader()).toBe(true);

      await a.release();

      // b still holds it: a's release was a no-op because the token did not match. Without
      // the fencing token this DEL would have removed b's lock and both would believe they
      // were leader.
      expect(await heldToken()).toBe(b.token);
      expect(await heldToken()).not.toBe(a.token);
    });

    it('refuses a TTL that leaves no renewal margin', () => {
      /**
       * The root cause of this file's long-standing intermittent failures, now a loud error.
       *
       * The 1s renewal floor means any TTL under 3s silently loses the documented "two
       * renewals may fail" margin — at 1000ms the interval equals the TTL, and at 1500ms the
       * ratio is 1.5x. Both were in use in this very file.
       *
       * The boundary is asserted from both sides, because an invariant that never fires and
       * one that always fires are equally useless and look identical from a green suite.
       */
      expect(() => lockOnly({ ttlMs: 1_000 })).toThrow(/no renewal margin/);
      expect(() => lockOnly({ ttlMs: 1_500 })).toThrow(/no renewal margin/);
      expect(() => lockOnly({ ttlMs: 2_999 })).toThrow(/no renewal margin/);
      // 3000 is the floor * 3 exactly, which satisfies the margin.
      expect(() => lockOnly({ ttlMs: 3_000 })).not.toThrow();
      expect(() => lockOnly({ ttlMs: 30_000 })).not.toThrow();
    });
  });

  describe('expiry and failover', () => {
    it('expires so a crashed leader does not hold the lock forever', async () => {
      /**
       * A crashed leader does not renew, and that is the whole point — so the crash has to be
       * simulated rather than assumed.
       *
       * Killing the client connection is the honest simulation: the process is gone, its
       * renewals cannot reach Redis, and the key expires on its TTL exactly as `PX` promises.
       * The previous version left the leader's renewal timer running and depended on the
       * renewal losing a race against expiry, which is why it failed intermittently.
       *
       * With the connection dead, waiting longer than the TTL can only ever be too LATE,
       * never too early — the assertion cannot flake in the dangerous direction.
       */
      const crashed = newLock({ ttlMs: 4_000 });
      const standby = lockOnly({ ttlMs: 4_000 });

      expect(await crashed.lock.tryAcquire()).toBe(true);
      expect(await standby.tryAcquire()).toBe(false);

      crashed.client.disconnect();

      // Still held immediately after the "crash" — the TTL, not the disconnect, is what
      // releases it.
      expect(await heldToken()).toBe(crashed.lock.token);

      await new Promise((resolve) => setTimeout(resolve, 5_000));

      expect(await heldToken()).toBeNull();
      expect(await standby.tryAcquire()).toBe(true);
    }, 20_000);

    it('renews so a healthy leader keeps leadership past the TTL', async () => {
      /**
       * TTL 6s, so renewal runs every 2s and the check at 7s is genuinely past the original
       * expiry — which is what makes this test prove anything. Checking before the first TTL
       * elapsed would pass whether or not renewal worked at all.
       *
       * The 3x ratio also makes the assertion tolerant of exactly what it should be: TWO
       * consecutive renewals may be delayed or fail and the key still survives to 7s, which is
       * the safety margin the implementation documents. The previous 1.5s TTL gave a 1.5x
       * ratio — its comment claimed "renews every 500ms", but the 1s floor made it 1000ms —
       * so a single late renewal under suite load could expire the key.
       */
      const leader = lockOnly({ ttlMs: 6_000 });
      const standby = lockOnly({ ttlMs: 6_000 });

      await leader.tryAcquire();
      await new Promise((resolve) => setTimeout(resolve, 7_000));

      expect(leader.isLeader()).toBe(true);
      // Still refused: without renewal the key would have expired a second ago.
      expect(await standby.tryAcquire()).toBe(false);
    }, 30_000);

    it('stands down when its key is taken from under it', async () => {
      const leader = lockOnly({ ttlMs: 6_000 });
      await leader.tryAcquire();
      expect(leader.isLeader()).toBe(true);

      // Forcibly hand the key to somebody else, as a Redis failover to a stale replica
      // could. The next renewal sees a token that is not ours.
      const saboteur = new Redis(redis.url, { maxRetriesPerRequest: 2 });
      clients.push(saboteur);
      await saboteur.set('test:scheduler:leader', 'someone-else', 'PX', 30_000);

      /**
       * POLLED, not slept.
       *
       * The property is "eventually stands down", so waiting a fixed 200ms past the renewal
       * interval and asserting was measuring timer punctuality rather than the behaviour. A
       * poll with a deadline passes as soon as it is true and fails only if it never becomes
       * true — which is the actual claim.
       */
      await waitUntil(() => !leader.isLeader(), 'leader to stand down');

      // Fails closed: an instance that cannot prove it is alone must not act as leader.
      expect(leader.isLeader()).toBe(false);
    }, 30_000);
  });
});
