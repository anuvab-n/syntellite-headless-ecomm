import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  needsRehash,
  passwordHashingParameters,
  verifyPassword,
} from '../password.js';

/**
 * Password hashing.
 *
 * No database and no mocks — this exercises the real Argon2 addon, because the properties
 * that matter (the plaintext is unrecoverable, the salt is per-hash, a malformed hash cannot
 * cause a 500) are properties of the algorithm, not of our wrapper.
 *
 * Argon2 is deliberately ~50 ms per hash, so these are the slowest unit tests in the suite.
 * That is the cost being verified, not overhead to optimise away.
 */
describe('password hashing', () => {
  const PASSWORD = 'correct horse battery staple';

  describe('parameters', () => {
    it('uses Argon2id at or above the OWASP minimum', () => {
      const params = passwordHashingParameters();

      // Pinned deliberately. A dependency bump that changed library defaults would
      // otherwise silently weaken every password created afterwards.
      expect(params.algorithm).toBe('argon2id');
      expect(params.memoryCostKib).toBeGreaterThanOrEqual(19_456);
      expect(params.timeCost).toBeGreaterThanOrEqual(2);
      expect(params.parallelism).toBe(1);
    });

    it('records the parameters in the hash itself', async () => {
      const hash = await hashPassword(PASSWORD);

      /**
       * The PHC string carries algorithm, version, and cost factors, which is what makes
       * `needsRehash` and future upgrades possible without a separate parameters column.
       *
       * Asserted field by field rather than as one fixed string: the encoding orders
       * parameters alphabetically (`m,p,t`), which is an encoding detail we should not pin.
       * The values are the contract; their order is not.
       */
      expect(hash).toMatch(/^\$argon2id\$v=19\$/);
      expect(hash).toContain('m=19456');
      expect(hash).toContain('t=2');
      expect(hash).toContain('p=1');
    });
  });

  describe('hashPassword', () => {
    it('never returns the plaintext', async () => {
      const hash = await hashPassword(PASSWORD);

      expect(hash).not.toBe(PASSWORD);
      expect(hash).not.toContain(PASSWORD);
      // Word-by-word too: a hash that embedded any fragment would be a catastrophic bug.
      for (const word of PASSWORD.split(' ')) {
        expect(hash).not.toContain(word);
      }
    });

    it('produces a different hash every time for the same password', async () => {
      const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

      // A per-hash random salt. Without it, identical passwords would be identifiable
      // across accounts from a database dump alone.
      expect(a).not.toBe(b);
      // ...and both must still verify.
      await expect(verifyPassword(PASSWORD, a)).resolves.toBe(true);
      await expect(verifyPassword(PASSWORD, b)).resolves.toBe(true);
    });

    it('refuses an empty password', async () => {
      // A guard, not a validation rule: the DTO enforces 10 characters. Reaching here with
      // an empty string means a caller bypassed the boundary, and hashing it would create
      // an account nobody can sign in to.
      await expect(hashPassword('')).rejects.toThrow(/empty password/);
    });

    it('refuses an implausibly long password', async () => {
      // Not about hashing time — Argon2's cost is set by its parameters. This is about not
      // handing an unbounded attacker-controlled buffer to a native addon.
      await expect(hashPassword('a'.repeat(2_000))).rejects.toThrow(/over 1024 bytes/);
    });

    it('measures length in bytes, not characters', async () => {
      // A 4-byte emoji: 300 characters is 1200 bytes, over the limit, even though a
      // character-based check would let it through.
      await expect(hashPassword('😀'.repeat(300))).rejects.toThrow(/bytes/);
    });

    it('accepts a password at the DTO maximum', async () => {
      // 128 characters is the documented ceiling and must comfortably hash.
      const hash = await hashPassword('x'.repeat(128));
      await expect(verifyPassword('x'.repeat(128), hash)).resolves.toBe(true);
    });
  });

  describe('verifyPassword', () => {
    it('accepts the correct password', async () => {
      const hash = await hashPassword(PASSWORD);
      await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const hash = await hashPassword(PASSWORD);
      await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
    });

    it('rejects a near-miss', async () => {
      const hash = await hashPassword(PASSWORD);

      // Case, trailing whitespace, and one changed character must all fail. Passwords are
      // compared exactly; nothing normalises them.
      await expect(verifyPassword(PASSWORD.toUpperCase(), hash)).resolves.toBe(false);
      await expect(verifyPassword(`${PASSWORD} `, hash)).resolves.toBe(false);
      await expect(verifyPassword(`${PASSWORD}x`, hash)).resolves.toBe(false);
    });

    it('returns false rather than throwing for a malformed hash', async () => {
      /**
       * The important one. A row with a corrupt `password_hash` must produce a failed login
       * (401), not an unhandled exception (500) — a 500 on one specific account tells an
       * attacker they have found something interesting.
       */
      const malformed = [
        '',
        'not-a-hash',
        '$argon2id$broken',
        '$argon2id$v=19$m=19456,t=2,p=1$invalid-base64$also-invalid',
        '$2b$10$abcdefghijklmnopqrstuv', // a bcrypt hash — wrong algorithm entirely
      ];

      for (const hash of malformed) {
        await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(false);
      }
    });

    it('returns false for an empty or over-long candidate without throwing', async () => {
      const hash = await hashPassword(PASSWORD);

      // Verification is on the login path, where any failure must be one indistinguishable
      // answer. Unlike `hashPassword`, this never throws.
      await expect(verifyPassword('', hash)).resolves.toBe(false);
      await expect(verifyPassword('a'.repeat(2_000), hash)).resolves.toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('reports false for a hash made with the current parameters', async () => {
      const hash = await hashPassword(PASSWORD);
      expect(needsRehash(hash)).toBe(false);
    });

    it('reports true for a hash made with weaker parameters', () => {
      // Hand-written PHC string with m=4096 — far below our 19456. This is the upgrade
      // signal: a successful login re-hashes and stores the stronger result, so passwords
      // strengthen as users return, with no mass reset.
      const weak =
        '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$abcdefghijklmnopqrstuvwxyz012345';
      expect(needsRehash(weak)).toBe(true);
    });

    it('reports false for a malformed hash rather than throwing', () => {
      // Reporting `true` would send the caller into a rehash it cannot perform, because a
      // hash it cannot parse is a hash it cannot have verified either.
      expect(needsRehash('')).toBe(false);
      expect(needsRehash('not-a-hash')).toBe(false);
    });
  });
});
