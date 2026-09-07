import type { Redis } from 'ioredis';

/**
 * Wait, with a bound, for an ioredis client to become usable.
 *
 * Exists because the lock client runs with `enableOfflineQueue: false` — correct for a
 * client guarding money, since a command must fail rather than be queued and replayed
 * seconds later — which means any command issued while the socket is still connecting
 * throws immediately. Callers that legitimately need to wait (a readiness probe at boot, a
 * leader election on startup) need this rather than a bare command.
 *
 * Why not `events.once(client, 'ready')`:
 *
 *  - It never times out. On a client in a TERMINAL state ('end'), neither 'ready' nor
 *    'error' is ever emitted, so the promise never settles and its listeners are never
 *    removed. Measured: one leaked 'ready' listener per call, growing without bound, and
 *    every caller paying its own outer timeout in full. A probe running every five seconds
 *    reaches Node's max-listeners warning in under a minute.
 *  - `once()` happens to self-clean while a connection is merely FAILING, because ioredis
 *    emits 'error' on each reconnect attempt and `once()` rejects on 'error'. That makes
 *    the leak invisible in the common outage case and present in the closed-client case,
 *    which is the worst combination for finding it.
 *
 * This implementation removes its listeners on every exit path and always settles.
 */
export async function waitForRedisReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return;
  // A closed client will never emit anything. Fail immediately rather than wait out the
  // timeout for an answer that cannot change.
  if (redis.status === 'end') throw new Error('redis client is closed');

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanUp();
      resolve();
    };
    const onEnd = (): void => {
      cleanUp();
      reject(new Error('redis connection ended while waiting'));
    };
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error(`redis did not become ready within ${String(timeoutMs)}ms`));
    }, timeoutMs);

    function cleanUp(): void {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
    }

    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });
}
