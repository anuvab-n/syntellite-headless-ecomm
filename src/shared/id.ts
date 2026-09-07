import { v7 as uuidv7 } from 'uuid';

/**
 * Identifier generation.
 *
 * UUIDv7 everywhere. The first 48 bits are a millisecond timestamp, so:
 *
 *  - Inserts append to the right edge of the B-tree the way a sequence does, instead of
 *    scattering random writes across the index and shredding cache locality the way v4
 *    does. On a busy `order` table that difference is measurable.
 *  - Sorting by id is chronological, so "most recent" queries need no extra index.
 *  - Nothing leaks. An exposed `BIGSERIAL` tells a competitor how many orders you took
 *    last week; a UUID does not.
 *
 * Generated in the APPLICATION, not by a database default. Services need the id before
 * the INSERT so they can build child rows, snapshot references, and emit an event with
 * the right id — all inside one transaction.
 *
 * Do not use `crypto.randomUUID()`: it produces v4, which loses the ordering property
 * above. A lint rule bans it.
 */
export function newId(): string {
  return uuidv7();
}

/** Loose shape check. Does NOT assert the version — use it for input rejection only. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * The timestamp embedded in a v7 id.
 *
 * Useful in support and forensics ("when was this cart created?") without a database
 * round trip. Returns undefined for a non-v7 uuid.
 */
export function timestampFromId(id: string): Date | undefined {
  if (!isUuid(id)) return undefined;
  const hex = id.replace(/-/g, '');
  // Version nibble sits at position 12.
  if (hex[12] !== '7') return undefined;
  const millis = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(millis) ? new Date(millis) : undefined;
}
