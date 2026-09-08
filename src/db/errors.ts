/**
 * Reading PostgreSQL driver errors.
 *
 * One implementation, replacing four near-identical copies that had drifted apart in
 * `identity.repository.ts`, `catalogue.service.ts`, `orders.service.ts` and
 * `payments.service.ts`. Every one of them existed to answer the same question — "was this a
 * unique violation, and on which constraint?" — and every one of them had rediscovered the
 * same two traps, which is exactly the sort of knowledge that should live once.
 *
 * Lives in `db/` rather than `shared/`: it is a database-driver concern, and `shared/` is
 * meant to stay free of anything that knows which database this is. Domain modules already
 * import `db/transaction.js` and `db/client.js`, so this is reachable from every caller that
 * needs it without weakening a layering rule.
 *
 * Imports nothing. It reads the shape of a thrown value and returns a string; there is no I/O
 * here and no dependency on the driver package.
 */

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * How far up the `cause` chain to look.
 *
 * **Not decoration.** Drizzle wraps a driver error in a `DrizzleQueryError` whose own `code` is
 * undefined, so a check on the top-level error alone silently never matches — and the symptom
 * is a `500` where a `409` was intended, on paths that decide whether a customer is charged
 * twice or told their email is taken. Found the hard way, by a payments concurrency test
 * returning `[201, 500]` instead of `[201, 409]`.
 *
 * Bounded rather than `while (true)`, so a self-referential `cause` cannot hang a request.
 * Five, which is the larger of the two values the previous copies used — a deeper walk can
 * only ever recognise MORE violations, never fewer, so it cannot turn a match into a miss.
 */
const MAX_CAUSE_DEPTH = 5;

/** The fields read off a thrown value. Structural, so no driver type is imported. */
type PostgresError = { code?: unknown; constraint?: unknown; cause?: unknown };

/**
 * The constraint a unique violation was raised on, or `undefined` when the error was not one.
 *
 * Three outcomes, and callers depend on the middle one existing:
 *
 *  - a constraint name — a unique violation this caller can recognise and translate
 *  - `''` — a unique violation on an **unnamed** constraint, which is still a violation and
 *    must be distinguishable from "not a violation at all"
 *  - `undefined` — not a unique violation; the caller rethrows
 *
 * Matched on SQLSTATE rather than on a message: driver messages are not a contract and change
 * between versions.
 *
 * Every call site compares the result against a specific constraint name, so `''` and
 * `undefined` behave identically at all of them today. The distinction is kept because it is
 * the honest contract, and because collapsing it would make a future caller that wants to
 * treat "some unique violation" as a conflict impossible to write correctly.
 */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  let current: unknown = err;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;

    const candidate = current as PostgresError;
    if (candidate.code === UNIQUE_VIOLATION) {
      return typeof candidate.constraint === 'string' ? candidate.constraint : '';
    }

    current = candidate.cause;
  }

  return undefined;
}
