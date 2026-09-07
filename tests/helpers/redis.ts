import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * A real Redis for BullMQ integration tests.
 *
 * `GenericContainer` rather than `@testcontainers/redis`, to avoid another dependency for
 * something this simple.
 *
 * Debian-based `redis:7` rather than `redis:7-alpine`: Alpine/musl images fail to exec on
 * some Docker Desktop + WSL2 kernels (see docs/DECISIONS.md §10). `redis:7-alpine` happens
 * to work on this machine while `postgres:16-alpine` does not, but relying on that is
 * relying on luck.
 */
const REDIS_IMAGE = 'redis:7';

export type TestRedis = {
  url: string;
  /** Wipe all keys between tests, so a leftover job cannot leak across cases. */
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startTestRedis(): Promise<TestRedis> {
  const container: StartedTestContainer = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    // No persistence for a container that lives 30 seconds.
    .withCommand(['redis-server', '--save', '', '--appendonly', 'no'])
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const url = `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`;

  return {
    url,
    async flush() {
      // `redis-cli` inside the container, so the helper needs no client of its own.
      await container.exec(['redis-cli', 'FLUSHALL']);
    },
    async stop() {
      await container.stop();
    },
  };
}
