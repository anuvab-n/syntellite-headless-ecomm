import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Refresh token primitives.
 *
 * A refresh token is a bearer credential with a 30-day life. It is therefore the most
 * valuable secret this system hands to a client, and it gets treated accordingly:
 *
 *  - **Opaque.** It encodes nothing. Not a user id, not a store, not an expiry. Everything
 *    knowable about a refresh token lives in the `refresh_session` row it hashes to, which is
 *    what makes revocation possible at all — you cannot revoke a fact encoded in a string the
 *    client holds.
 *  - **Random, not derived.** No UUID. A UUIDv4 carries 122 bits inside a recognisable
 *    structure, and UUIDv7 — which this project uses for row ids — embeds a TIMESTAMP and is
 *    therefore partially predictable. Neither is credential material.
 *  - **Stored hashed.** PostgreSQL holds a SHA-256 hex digest, never the token. A database
 *    dump, a replica, or a backup then yields no usable sessions.
 *
 * Why SHA-256 and not Argon2, given `password.ts` argues the opposite for passwords: a
 * password is low-entropy and human-chosen, so hashing must be deliberately slow to make
 * guessing expensive. A refresh token is 256 bits of CSPRNG output — there is nothing to
 * guess, so a slow hash would only add latency to every refresh. The threat model is
 * different, so the primitive is different.
 */

/* ── Types ───────────────────────────────────────────────────────────────── */

/**
 * A raw refresh token — the secret handed to the client.
 *
 * Marker-typed in the same style as `PasswordHash` in `password.ts`, so a raw token and its
 * hash are not interchangeable at a call site. This is the confusion that matters: passing a
 * RAW token where a hash is expected writes the secret to the database in plaintext, and the
 * bug is invisible in review because both are 43-to-64-character strings.
 */
export type RefreshToken = string & { readonly __brand?: 'RefreshToken' };

/** A SHA-256 hex digest of a refresh token. Exactly what `refresh_session.tokenHash` holds. */
export type RefreshTokenHash = string & { readonly __brand?: 'RefreshTokenHash' };

/* ── Parameters ──────────────────────────────────────────────────────────── */

/**
 * 32 bytes = 256 bits of entropy.
 *
 * Comfortably beyond brute force, and it matches the digest size so neither side is the weak
 * link. base64url-encodes to 43 characters with no padding: URL-safe, header-safe, and
 * cookie-safe, so the token needs no escaping wherever a client chooses to put it.
 */
const TOKEN_BYTES = 32;

/**
 * SHA-256 hex is 64 characters, which is exactly `refresh_session.tokenHash`'s
 * `varchar(64)`.
 *
 * Not a coincidence and not a codependency to leave implicit: the column was sized for this
 * digest. Asserted by a test, so switching to SHA-512 (128 hex chars) fails loudly here
 * rather than silently truncating a hash in the database — which would make every session
 * collide on its first 64 characters.
 */
export const REFRESH_TOKEN_HASH_LENGTH = 64;

/** Expected encoded length of a generated token. Asserted by a test. */
export const REFRESH_TOKEN_LENGTH = 43;

/* ── Generation ──────────────────────────────────────────────────────────── */

/**
 * Generate a new refresh token.
 *
 * `randomBytes` is Node's CSPRNG, seeded by the OS. Deliberately NOT `Math.random`, and
 * deliberately not `newId()`: the project's UUIDv7 ids are time-ordered by design, which is
 * excellent for an index and disqualifying for a secret.
 */
export function generateRefreshToken(): RefreshToken {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/* ── Hashing ─────────────────────────────────────────────────────────────── */

/**
 * Hash a refresh token for storage or lookup.
 *
 * Deterministic and unsalted, which is correct here and would be wrong for a password: a
 * lookup needs to find the row by hashing the presented token, and a per-row salt would make
 * that impossible without reading every row first. Unsalted is safe precisely because the
 * input is 256 random bits — there is no dictionary to precompute.
 *
 * Pure: the input string is not mutated, retained, or logged.
 */
export function hashRefreshToken(token: RefreshToken): RefreshTokenHash {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two refresh token hashes.
 *
 * Provided for the refresh flow, which will compare a presented token's hash against a stored
 * one. `===` on a string short-circuits at the first differing byte, and that timing
 * difference is measurable across a network — it lets an attacker recover a hash byte by byte.
 * The database lookup is the primary path; this exists so any in-memory comparison a future
 * caller writes is safe by default rather than by remembering.
 */
export function refreshTokenHashesEqual(a: RefreshTokenHash, b: RefreshTokenHash): boolean {
  // `timingSafeEqual` throws on a length mismatch, which would itself leak length. Both are
  // fixed-width hex digests, so unequal length means malformed input, not a near-miss.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The parameters in force, for tests and documentation. Never the tokens themselves. */
export function refreshTokenParameters(): {
  entropyBytes: number;
  entropyBits: number;
  encoding: 'base64url';
  hashAlgorithm: 'sha256';
  hashLength: number;
} {
  return {
    entropyBytes: TOKEN_BYTES,
    entropyBits: TOKEN_BYTES * 8,
    encoding: 'base64url',
    hashAlgorithm: 'sha256',
    hashLength: REFRESH_TOKEN_HASH_LENGTH,
  };
}
