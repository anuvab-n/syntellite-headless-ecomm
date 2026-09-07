import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { invariant } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { waitForRedisReady } from './ready.js';

/**
 * A Redis leader lock, for "exactly one instance may do this".
 *
 * The scheduler is the reason it exists. Two schedulers running the same recurring task is
 * not a performance problem, it is a correctness one: the reservation sweeper would release
 * stock twice, and the abandoned-cart job would email every customer twice. The spec is
 * blunt about it — exactly one instance, ever — and "we only deploy one replica" is not an
 * enforcement mechanism, because a rolling deploy briefly runs two.
 *
 * How it works, and why each part is needed:
 *
 *  - `SET key token NX PX ttl` — atomic acquire. `NX` means only if absent, so two callers
 *    cannot both win. `PX` means it expires, so a leader that is SIGKILLed does not hold the
 *    lock forever.
 *  - A random `token` per instance. Release and renew are compare-and-act on that token via
 *    Lua, so an instance whose lock already expired cannot delete or extend the NEW leader's
 *    lock. Without the token, a slow instance waking up after its TTL lapsed would happily
 *    `DEL` a lock it no longer owns — and then two instances believe they are leader.
 *  - Renewal at a fraction of the TTL, so a brief GC pause or network blip does not cost
 *    leadership.
 *
 * Honest limits: this is a single-Redis lock, not Redlock. If Redis fails over to a replica
 * that has not yet received the SET, two instances can briefly both hold it. For scheduling
 * recurring jobs that is an acceptable trade — the alternative is a consensus system, and
 * the tasks themselves should be idempotent regardless. It would NOT be acceptable as the
 * only guard on a money-moving operation; those use PostgreSQL row locks instead.
 */

export type LeaderLock = {
  /** True while this instance holds the lock. */
  isLeader: () => boolean;
  /** Attempt to acquire. Returns whether this instance is now the leader. */
  tryAcquire: () => Promise<boolean>;
  /** Release if still held. Safe to call when not the leader. */
  release: () => Promise<void>;
  /** This instance's fencing token, for logging. */
  token: string;
};

export type LeaderLockOptions = {
  redis: Redis;
  logger: Logger;
  /** Namespaced key. One per distinct thing being singleton-guarded. */
  key: string;
  /**
   * How long the lock survives without renewal.
   *
   * The floor on failover time: a crashed leader's work stalls for up to this long. The
   * ceiling is set by how long a paused process might be — too short and a GC pause costs
   * leadership to no purpose.
   */
  ttlMs?: number;
  /** Called when leadership is lost unexpectedly (renewal failed, key taken). */
  onLeadershipLost?: (reason: string) => void;
};

const DEFAULT_TTL_MS = 30_000;

/** Floor on how often renewal runs, so a short TTL cannot hammer Redis. */
const MIN_RENEW_INTERVAL_MS = 1_000;

/**
 * How long to wait for the client to connect before treating an election attempt as
 * failed. Bounded, because "wait forever" turns a Redis outage into a hung process rather
 * than a standby that keeps retrying. A failed attempt is safe — the caller is simply not
 * leader, and the next tick tries again.
 */
const READY_WAIT_MS = 3_000;

/**
 * Extend only if we still own it. The compare-and-extend must be atomic, or between the
 * `GET` and the `PEXPIRE` the lock could expire and be taken by somebody else — and we would
 * then extend THEIR lock while believing it was ours.
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;

/** Delete only if we still own it. Same reasoning as renewal. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export function createLeaderLock(opts: LeaderLockOptions): LeaderLock {
  const { redis, logger, key } = opts;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  /**
   * Renew at a third of the TTL, so two consecutive renewals can fail before leadership
   * lapses. Renewing at, say, 90% of the TTL means one dropped packet loses the lock.
   *
   * The 1s floor stops a pathologically short TTL from hammering Redis — but it also means
   * the ratio silently inverts below a 3s TTL, which is a trap rather than a trade-off.
   */
  const renewIntervalMs = Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(ttlMs / 3));

  /**
   * Enforce the margin the comment above claims, rather than merely hoping for it.
   *
   * The stated property is that TWO consecutive renewals may fail before leadership lapses,
   * which requires `renewIntervalMs * 3 <= ttlMs`. The 1s floor silently breaks that below a
   * 3s TTL: at `ttlMs = 1000` the interval EQUALS the TTL, so the first renewal races the
   * expiry; at `ttlMs = 1500` the ratio is 1.5x, so a single late renewal loses the lock.
   * Both look fine and fail intermittently — the worst failure mode for a singleton
   * guarantee, and the cause of this file's long-running flaky test.
   *
   * Asserted at construction rather than clamped. A caller asking for a 1s leadership TTL has
   * misunderstood something, and silently substituting a workable value would hide it.
   * Production uses 30s (a 10s interval), so this cannot fire there — it fired in the tests,
   * which is how the trap was found.
   */
  invariant(
    renewIntervalMs * 3 <= ttlMs,
    `leader lock ttlMs=${String(ttlMs)} leaves no renewal margin: the ${String(
      MIN_RENEW_INTERVAL_MS,
    )}ms floor forces renewIntervalMs=${String(renewIntervalMs)}, and leadership must ` +
      'survive two consecutive failed renewals (interval * 3 <= ttl). Use a TTL of at ' +
      `least ${String(MIN_RENEW_INTERVAL_MS * 3)}ms.`,
  );

  const token = randomUUID();
  let leader = false;
  let renewTimer: NodeJS.Timeout | undefined;

  function stopRenewing(): void {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = undefined;
    }
  }

  function loseLeadership(reason: string): void {
    if (!leader) return;
    leader = false;
    stopRenewing();
    // Warn, not info: a healthy leader keeps its lock. Losing it means a stall, a network
    // problem, or — worst case — that another instance now believes it is leader too.
    logger.warn({ key, token, reason }, 'leadership_lost');
    opts.onLeadershipLost?.(reason);
  }

  function startRenewing(): void {
    stopRenewing();
    renewTimer = setInterval(() => {
      void (async () => {
        try {
          const extended = await redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
          if (extended !== 1) {
            // The key is gone or owned by somebody else. We are not the leader any more,
            // whatever this process believes.
            loseLeadership('renewal_rejected');
          }
        } catch (err) {
          logger.error({ err, key }, 'leadership_renewal_failed');
          /**
           * Deliberately pessimistic: a renewal we could not confirm means we may already
           * have lapsed, and continuing to act as leader risks two instances running the
           * same task. Stand down and re-acquire — fail closed.
           */
          loseLeadership('renewal_error');
        }
      })();
    }, renewIntervalMs);
    // Must not keep the process alive on its own during shutdown.
    renewTimer.unref();
  }

  return {
    token,
    isLeader: () => leader,

    async tryAcquire() {
      if (leader) return true;
      try {
        /**
         * Wait for the connection before issuing the SET.
         *
         * The lock client is configured with `enableOfflineQueue: false` — correct for a
         * client that guards money, because a command must fail rather than be replayed
         * seconds later. The side effect is that a command issued microseconds after boot
         * hits a socket that is still shaking hands and throws immediately.
         *
         * Without this wait the scheduler's first election attempt always failed, and a
         * single-instance deployment sat as a standby for a full tick before leading.
         * Found by running the process, not by a test.
         */
        await waitForRedisReady(redis, READY_WAIT_MS);
        // 'NX' + 'PX' in one command. Two calls (EXISTS then SET) would race.
        const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
        if (result === 'OK') {
          leader = true;
          startRenewing();
          logger.info({ key, token, ttlMs }, 'leadership_acquired');
          return true;
        }
        return false;
      } catch (err) {
        // Cannot reach Redis means cannot prove we are alone, so we are not the leader.
        logger.error({ err, key }, 'leadership_acquire_failed');
        return false;
      }
    },

    async release() {
      stopRenewing();
      if (!leader) return;
      leader = false;
      try {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
        logger.info({ key, token }, 'leadership_released');
      } catch (err) {
        /**
         * Not fatal. The lock has a TTL, so failing to release only delays the next
         * leader by up to `ttlMs` — which is exactly the crash case the TTL exists for.
         */
        logger.warn({ err, key }, 'leadership_release_failed');
      }
    },
  };
}
