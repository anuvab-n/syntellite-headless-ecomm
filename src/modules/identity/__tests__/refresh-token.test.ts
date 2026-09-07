import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenHashesEqual,
  refreshTokenParameters,
  REFRESH_TOKEN_HASH_LENGTH,
  REFRESH_TOKEN_LENGTH,
} from '../refresh-token.js';

/**
 * Refresh token primitives.
 *
 * No raw token is ever written to test output: a token printed by a failing assertion ends up
 * in CI logs, and the habit of tolerating that is how a real one eventually gets there.
 * Assertions therefore compare derived facts (length, equality, distinctness) rather than
 * echoing values.
 */
describe('refresh token primitives', () => {
  describe('parameters', () => {
    it('uses 256 bits of entropy and SHA-256', () => {
      const params = refreshTokenParameters();

      expect(params.entropyBits).toBe(256);
      expect(params.entropyBytes).toBe(32);
      expect(params.encoding).toBe('base64url');
      expect(params.hashAlgorithm).toBe('sha256');
    });

    it('produces a hash length that exactly matches the database column', () => {
      /**
       * `refresh_session.tokenHash` is `varchar(64)` and SHA-256 hex is 64 characters. This
       * is a codependency, not a coincidence: switching to SHA-512 (128 hex chars) would
       * silently truncate every hash to its first 64 characters, and every session would then
       * collide with every other. This assertion is what makes that change fail loudly.
       */
      expect(REFRESH_TOKEN_HASH_LENGTH).toBe(64);
      expect(hashRefreshToken(generateRefreshToken())).toHaveLength(64);
    });
  });

  describe('generation', () => {
    it('is non-deterministic', () => {
      // 1000 tokens, all distinct. A generator that repeated — or was seeded from a clock —
      // would collide here.
      const tokens = new Set(Array.from({ length: 1_000 }, () => generateRefreshToken()));
      expect(tokens.size).toBe(1_000);
    });

    it('has the expected length and is URL-safe', () => {
      const token = generateRefreshToken();

      expect(token).toHaveLength(REFRESH_TOKEN_LENGTH);
      // base64url: no `+`, `/`, or `=`. So the token needs no escaping in a header, a URL, or
      // a cookie — which is where callers will inevitably put it.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('encodes no identity data', () => {
      /**
       * The property that makes revocation possible: everything knowable about a refresh
       * token lives in its database row, not in the string. A token that encoded a user id
       * could not be invalidated without invalidating the id.
       */
      const userId = '01a04236-7412-73ab-b93b-fe58db1c223c';
      const storeId = '01a04236-0000-7000-8000-000000000000';

      for (let i = 0; i < 100; i += 1) {
        const token = generateRefreshToken();
        expect(token).not.toContain(userId);
        expect(token).not.toContain(storeId);
        // No recognisable UUID structure either — a UUIDv7 embeds a timestamp and is
        // therefore partially predictable, which disqualifies it as credential material.
        expect(token).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      }
    });

    it('has high per-character variety across many samples', () => {
      // A crude but real check that output is not structured: 1000 tokens should exercise
      // most of the 64-character base64url alphabet. A templated or counter-based generator
      // would use very few distinct characters.
      const chars = new Set(
        Array.from({ length: 1_000 }, () => generateRefreshToken())
          .join('')
          .split(''),
      );
      expect(chars.size).toBeGreaterThan(50);
    });
  });

  describe('hashing', () => {
    it('is deterministic for the same token', () => {
      const token = generateRefreshToken();

      // Required for lookup: the refresh flow finds a session by hashing the presented token,
      // so the same input must always produce the same digest. This is exactly why the hash
      // is unsalted — and safe to be, given 256 bits of random input.
      expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    });

    it('produces different hashes for different tokens', () => {
      const hashes = new Set(
        Array.from({ length: 500 }, () => hashRefreshToken(generateRefreshToken())),
      );
      expect(hashes.size).toBe(500);
    });

    it('never returns the raw token', () => {
      const token = generateRefreshToken();
      const hash = hashRefreshToken(token);

      // The whole point of hashing before persistence: a database dump must yield no usable
      // sessions.
      expect(hash).not.toBe(token);
      expect(hash).not.toContain(token);
      expect(token).not.toContain(hash);
      // Hex, not base64url — visibly a different alphabet from the token.
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('matches an independent SHA-256 of the same input', () => {
      // Verifies the implementation against Node's crypto directly, so a future refactor
      // cannot quietly change the digest and orphan every stored session.
      const token = generateRefreshToken();
      const expected = createHash('sha256').update(token, 'utf8').digest('hex');

      expect(hashRefreshToken(token)).toBe(expected);
    });

    it('does not mutate the token it is given', () => {
      const token = generateRefreshToken();
      const before = String(token);

      hashRefreshToken(token);
      hashRefreshToken(token);

      expect(token).toBe(before);
      // And still hashes to the same value, so nothing was consumed.
      expect(hashRefreshToken(token)).toBe(hashRefreshToken(before));
    });
  });

  describe('hash comparison', () => {
    it('matches identical hashes and rejects different ones', () => {
      const a = hashRefreshToken(generateRefreshToken());
      const b = hashRefreshToken(generateRefreshToken());

      expect(refreshTokenHashesEqual(a, a)).toBe(true);
      expect(refreshTokenHashesEqual(a, b)).toBe(false);
    });

    it('rejects a length mismatch without throwing', () => {
      /**
       * `timingSafeEqual` throws on unequal lengths, and letting that propagate would turn a
       * malformed input into a 500. Both operands are fixed-width digests, so a length
       * mismatch means malformed input rather than a near-miss.
       */
      const hash = hashRefreshToken(generateRefreshToken());

      expect(refreshTokenHashesEqual(hash, '')).toBe(false);
      expect(refreshTokenHashesEqual(hash, 'abc')).toBe(false);
      expect(refreshTokenHashesEqual(hash, `${hash}extra`)).toBe(false);
    });

    it('rejects a hash differing only in the last character', () => {
      // The case a short-circuiting `===` would answer fastest, and therefore the one whose
      // timing would leak most. Correctness is what is asserted here; constant-time
      // behaviour is a property of `timingSafeEqual`, not something a unit test can measure
      // reliably on a shared CI runner.
      const hash = hashRefreshToken(generateRefreshToken());
      const lastChar = hash.slice(-1);
      const tampered = `${hash.slice(0, -1)}${lastChar === 'a' ? 'b' : 'a'}`;

      expect(refreshTokenHashesEqual(hash, tampered)).toBe(false);
    });
  });
});
