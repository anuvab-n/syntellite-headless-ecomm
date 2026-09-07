import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * Argon2id, with parameters stated explicitly rather than inherited from the library's
 * defaults. Defaults are a moving target across minor versions: a dependency bump that
 * lowers them silently weakens every password created afterwards, and one that raises them
 * silently makes every login slower. Pinning them here means a change to the cost of a
 * password is a change to this file, visible in a diff.
 *
 * Why Argon2id specifically: it is the OWASP first choice, and the `id` variant is the
 * hybrid — Argon2i's resistance to side-channel attacks plus Argon2d's resistance to
 * GPU/ASIC cracking. Argon2i or Argon2d alone each give up one of those.
 *
 * The whole point of this function is to be SLOW. That makes every endpoint calling it a
 * CPU-exhaustion target on a single-threaded runtime, which is why rate limiting is a
 * prerequisite for shipping login rather than a nice-to-have.
 */

/**
 * OWASP Password Storage Cheat Sheet (2024) minimum for Argon2id: m=19456 KiB, t=2, p=1.
 *
 *  - `memoryCost` 19456 KiB (19 MiB) is the lever that actually costs an attacker money;
 *    memory is what makes GPU and ASIC parallelism expensive. Raising `timeCost` instead is
 *    much weaker per unit of latency.
 *  - `parallelism: 1` because Node is single-threaded and `argon2` hashes on the libuv
 *    threadpool. Asking for lanes we cannot use adds coordination for no security.
 *  - Measured at roughly 40–60 ms per hash on a developer laptop. If that ever drops below
 *    ~50 ms on production hardware, raise `memoryCost` — not `timeCost`.
 *
 * Raising these is safe and does not invalidate anything: the PHC string records the
 * parameters each hash was made with, `verifyPassword` reads them from the hash, and
 * `needsRehash` detects the stale ones so a successful login can silently upgrade.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Upper bound on what we will hash.
 *
 * Argon2's cost is dominated by its parameters, not input length, so this is not about
 * hashing time — it is about not passing an unbounded attacker-controlled buffer into a
 * native addon. The DTO enforces the same limit at the boundary; this is the backstop for
 * any future caller that does not.
 */
const MAX_PASSWORD_BYTES = 1_024;

/** Marker type, so a hash cannot be confused with a plaintext password at a call site. */
export type PasswordHash = string & { readonly __brand?: 'PasswordHash' };

/**
 * Hash a plaintext password.
 *
 * Returns a full PHC string — `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>` — which
 * carries its own algorithm, version, parameters, and a per-hash random salt. No separate
 * salt column is needed, and no two identical passwords produce the same hash.
 *
 * The plaintext is never logged, never returned, and never retained beyond this call.
 */
export async function hashPassword(password: string): Promise<PasswordHash> {
  assertHashable(password);
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Returns `false` rather than throwing for ANY failure — a wrong password, a malformed
 * hash, an empty string, a hash produced by a different algorithm. That matters for two
 * reasons:
 *
 *  1. A caller must not be able to distinguish "wrong password" from "corrupt hash" by
 *     catching different exceptions. Both are simply a failed login.
 *  2. A row with a damaged `password_hash` would otherwise produce a 500 instead of a 401,
 *     which tells an attacker they have found an interesting account.
 *
 * Argon2's own comparison is constant-time, so this does not add a timing signal.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Guard before touching the addon: `argon2.verify` on an empty or over-long input is a
  // throw we would only catch and discard anyway.
  if (hash.length === 0) return false;
  if (!isHashable(password)) return false;

  try {
    return await argon2.verify(hash, password);
  } catch {
    // Deliberately swallowed. See the note above — every failure mode is one answer.
    return false;
  }
}

/**
 * Whether a hash was produced with weaker parameters than we now require.
 *
 * The upgrade path for cost factors. On a successful login the caller re-hashes and stores
 * the result, so passwords strengthen as users return — without a mass reset, and without
 * ever needing the plaintext outside that one request.
 *
 * Returns `false` for a malformed hash: an unreadable hash cannot be meaningfully compared,
 * and reporting `true` would send the caller into a rehash it cannot complete.
 */
export function needsRehash(hash: string): boolean {
  if (hash.length === 0) return false;
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** The parameters in force, for tests and for a startup log line. Never the secrets. */
export function passwordHashingParameters(): {
  algorithm: 'argon2id';
  memoryCostKib: number;
  timeCost: number;
  parallelism: number;
} {
  return {
    algorithm: 'argon2id',
    memoryCostKib: ARGON2_OPTIONS.memoryCost,
    timeCost: ARGON2_OPTIONS.timeCost,
    parallelism: ARGON2_OPTIONS.parallelism,
  };
}

/* ── Internals ───────────────────────────────────────────────────────────── */

function isHashable(password: string): boolean {
  return password.length > 0 && Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
}

function assertHashable(password: string): void {
  if (password.length === 0) {
    throw new Error('refusing to hash an empty password');
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    // Byte length, not character length: an emoji password is four bytes per character, so
    // a limit measured in characters would let a much larger buffer through.
    throw new Error(`refusing to hash a password over ${String(MAX_PASSWORD_BYTES)} bytes`);
  }
}
