import { createHash, randomBytes } from 'node:crypto';

/**
 * Password reset token generation and hashing.
 *
 * A near-twin of `refresh-token.ts`, and separate from it on purpose. The two are the same
 * construction — 256 random bits, base64url, stored as an unsalted SHA-256 digest — but they
 * are different credentials with different lifetimes, different tables and different blast
 * radii. Sharing one branded type would let a refresh token be passed where a reset token is
 * expected and typecheck, which is precisely the confusion a branded type exists to prevent.
 *
 * Read `refresh-token.ts` for the reasoning that applies to both: why `randomBytes` and not
 * `newId()`, and why a deterministic unsalted hash is correct for a high-entropy token and
 * would be indefensible for a password.
 */

/** 32 bytes = 256 bits. The same entropy as a refresh token, for the same reason. */
const TOKEN_BYTES = 32;

/** SHA-256 hex. Matches `password_reset_token.token_hash`'s `varchar(64)`. */
export const PASSWORD_RESET_HASH_LENGTH = 64;

/** Expected encoded length of a generated token. Asserted by a test. */
export const PASSWORD_RESET_TOKEN_LENGTH = 43;

/**
 * How long a reset link works. **One hour.**
 *
 * Deliberately short. A reset token is a password equivalent sitting in an inbox, and an inbox
 * is exactly where a credential gets read from weeks later — by a forwarded mail, a shared
 * family account, or whoever ends up with the device. An hour is long enough for a customer to
 * notice the mail and act, and short enough that a link found later is already dead.
 *
 * A constant rather than config: a deployment that could set this to a week would eventually
 * have one that did.
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;

/** A freshly generated reset token, for sending. Never stored in this form. */
export type PasswordResetToken = string & { readonly __brand: 'PasswordResetToken' };

/** The digest of one, for storage and lookup. */
export type PasswordResetTokenHash = string & { readonly __brand: 'PasswordResetTokenHash' };

/**
 * Generate a reset token.
 *
 * `randomBytes` is Node's CSPRNG. Deliberately not `newId()`: the project's UUIDv7 ids are
 * time-ordered by design, which is excellent for an index and disqualifying for a secret —
 * knowing roughly when a reset was requested would narrow the search space enormously.
 */
export function generatePasswordResetToken(): PasswordResetToken {
  return randomBytes(TOKEN_BYTES).toString('base64url') as PasswordResetToken;
}

/**
 * Hash a reset token for storage or lookup.
 *
 * Pure: the input is not mutated, retained, or logged. Nothing in this module logs, which is
 * not an omission — a log line containing a live reset token is an account takeover waiting for
 * whoever reads the log store.
 */
export function hashPasswordResetToken(token: string): PasswordResetTokenHash {
  return createHash('sha256').update(token, 'utf8').digest('hex') as PasswordResetTokenHash;
}

/** The parameters in force, for tests and documentation. Never the tokens themselves. */
export function passwordResetTokenParameters(): {
  entropyBytes: number;
  entropyBits: number;
  encoding: 'base64url';
  hashAlgorithm: 'sha256';
  hashLength: number;
  ttlMinutes: number;
} {
  return {
    entropyBytes: TOKEN_BYTES,
    entropyBits: TOKEN_BYTES * 8,
    encoding: 'base64url',
    hashAlgorithm: 'sha256',
    hashLength: PASSWORD_RESET_HASH_LENGTH,
    ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
  };
}
