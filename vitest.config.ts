import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Node, not jsdom. This is a backend; a test that needs a DOM is testing the wrong
     * thing.
     */
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    /**
     * Integration tests share a Postgres container and truncate between cases, so they
     * must not run in parallel against it. Unit tests are pure and parallelise freely.
     * `fileParallelism` is disabled for the integration project only — see tests/setup.
     */
    globals: false,
    /**
     * Testcontainers needs time to pull and start Postgres on a cold cache. A 5s default
     * turns "first run of the day" into a spurious failure.
     */
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/db/migrations/**',
        'src/db/seed.ts',
        // Entry points are covered by the smoke test, not by unit coverage.
        'src/main.ts',
        'src/workers/**',
      ],
      thresholds: {
        // Deliberately modest at Phase 0 and raised per phase. A high global number
        // encourages tests that execute code without asserting anything about it; the
        // gate that matters is the mandatory correctness tests listed in DECISIONS.md.
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
