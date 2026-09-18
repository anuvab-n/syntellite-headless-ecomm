/**
 * Instant bounds for list filters, at the precision the API can actually express.
 *
 * ## The mismatch this exists to close
 *
 * PostgreSQL stores `timestamptz` to MICROSECOND precision. The API cannot:
 *
 *  - Inbound, a query parameter is parsed into a JavaScript `Date`, which counts whole
 *    milliseconds since the epoch. `new Date('2026-09-15T10:00:00.123456Z')` holds
 *    `…123Z` — the microseconds are gone before any query sees them, and no amount of
 *    validation can recover them.
 *  - Outbound, `toISOString()` emits exactly three fractional digits, so a row stored at
 *    `…123456Z` is published as `…123Z`.
 *
 * Both directions truncate DOWNWARD, so a published timestamp is always less than or equal to
 * the instant actually stored. That asymmetry is harmless for a lower bound and wrong for an
 * upper one: `created_at <= '…123Z'` excludes the row stored at `…123456Z`, including the row
 * the client copied that very timestamp from.
 *
 * ## The semantics, stated once
 *
 * **A bound names a MILLISECOND, because a millisecond is the finest instant this API can
 * express — and an inclusive bound therefore includes the whole of the millisecond named.**
 *
 * That is a reading of the existing contract rather than a new convention: the endpoints already
 * document both bounds as inclusive, and `…123Z` is not a name for one microsecond out of a
 * thousand, it is the only name the API has for all of them.
 *
 * The lower bound needs no adjustment. `created_at >= '…123Z'` already admits every microsecond
 * within that millisecond, because they are all greater than its start.
 */

/** One millisecond, in milliseconds. Named so the arithmetic below reads as intent. */
const ONE_MILLISECOND_MS = 1;

/**
 * The first instant AFTER the millisecond this one names.
 *
 * Pair it with a STRICT `<`, never `<=`: `created_at < exclusiveEndOfMillisecond(bound)` admits
 * every microsecond inside the named millisecond and nothing from the next one.
 *
 * Expressed as a half-open upper bound rather than by rounding the stored column
 * (`date_trunc('milliseconds', created_at) <= bound`) for one concrete reason: truncating the
 * column is not sargable, so it would discard the `(store_id, created_at)` index the admin lists
 * were measured to need. This form leaves the index usable and the comparison exact.
 */
export function exclusiveEndOfMillisecond(instant: Date): Date {
  return new Date(instant.getTime() + ONE_MILLISECOND_MS);
}
