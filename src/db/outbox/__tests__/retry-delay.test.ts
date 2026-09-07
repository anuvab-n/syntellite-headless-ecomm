import { describe, expect, it } from 'vitest';

import { retryDelayMs } from '../drainer.js';

describe('retryDelayMs', () => {
  const opts = { retryBaseMs: 1_000, retryMaxMs: 60_000 };

  it('grows exponentially with the attempt count', () => {
    // random() = 1 gives the top of the jitter window, i.e. the plain exponential.
    const ceiling = (attempts: number) => retryDelayMs(attempts, { ...opts, random: () => 1 });
    expect(ceiling(1)).toBe(1_000);
    expect(ceiling(2)).toBe(2_000);
    expect(ceiling(3)).toBe(4_000);
    expect(ceiling(4)).toBe(8_000);
  });

  it('clamps at retryMaxMs so a long outage retries hourly, not yearly', () => {
    // 2^40 milliseconds is about 35 years without the clamp.
    expect(retryDelayMs(40, { ...opts, random: () => 1 })).toBe(60_000);
  });

  it('applies full jitter', () => {
    // Without jitter, a hundred events that failed together all retry at the same instant
    // and knock over the dependency again the moment it recovers.
    expect(retryDelayMs(3, { ...opts, random: () => 0 })).toBe(0);
    expect(retryDelayMs(3, { ...opts, random: () => 0.5 })).toBe(2_000);
    expect(retryDelayMs(3, { ...opts, random: () => 1 })).toBe(4_000);
  });

  it('never returns a negative delay for a zeroth or negative attempt', () => {
    expect(retryDelayMs(0, { ...opts, random: () => 1 })).toBe(1_000);
    expect(retryDelayMs(-5, { ...opts, random: () => 1 })).toBe(1_000);
  });

  it('returns zero when configured with no delay, for tests', () => {
    expect(retryDelayMs(5, { retryBaseMs: 0, retryMaxMs: 0 })).toBe(0);
  });
});
