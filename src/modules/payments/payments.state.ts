import type { PaymentStatus } from './payments.repository.js';

/**
 * The payment state machine.
 *
 * Its own file, and a pure function over a literal table, for three reasons:
 *
 *  1. **A CHECK cannot express it.** `ck_payment_status` constrains which values the column
 *     holds; it cannot say that `succeeded -> failed` is illegal. The database guards the
 *     alphabet, this guards the grammar, and neither substitutes for the other.
 *  2. **It is the defence against a duplicate or out-of-order provider notification.** A
 *     gateway will happily deliver `payment.failed` after `payment.captured` — retries and
 *     at-least-once delivery make that ordinary, not exotic. Everything that would corrupt a
 *     terminal payment is rejected here, once, rather than at each call site.
 *  3. **It is testable without a database.** The transition table is the specification of the
 *     approved lifecycle, so the test that reads it is the test that proves the increment
 *     implements what was approved.
 *
 * ## The approved lifecycle
 *
 * ```
 *                    ┌──────────┐
 *      create ──────▶│ pending  │
 *                    └────┬─────┘
 *                         │
 *        ┌────────────────┼────────────────┐
 *        ▼                ▼                ▼
 *   ┌─────────┐     ┌──────────┐     ┌──────────┐
 *   │succeeded│     │  failed  │     │ expired  │
 *   └─────────┘     └──────────┘     └──────────┘
 * ```
 *
 * `pending` is the only state with any outgoing transition. The other three are **absorbing**:
 * the approved scope has no retry, so `failed -> succeeded` and `failed -> expired` are
 * forbidden in this increment, and `succeeded` and `expired` never move at all.
 *
 * That makes the machine monotonic in the only sense that matters here — a payment leaves
 * `pending` exactly once — which is what lets a redelivered webhook be a safe no-op instead of
 * a second transition.
 */

/**
 * Which states each state may move to. The empty arrays are load-bearing, not filler: they are
 * how "terminal" is stated in a form the code can read, and removing one would silently permit
 * a regression the tests are written to catch.
 */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  expired: [],
};

/**
 * May a payment move from `from` to `to`?
 *
 * A transition to the state already held is **not** legal. It is not a transition — the
 * database says the same thing in `ck_payment_event_progresses` — and treating it as legal
 * would let a redelivered notification append a second history row saying nothing happened.
 * The caller distinguishes "already there" (a no-op) from "illegal" (a rejection) before
 * asking; see `isTerminal`.
 */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Has this payment finished? A terminal payment is never written again. */
export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
