import type { ReturnStatus } from './returns.repository.js';

/**
 * The return transition table. The approved set, exactly.
 *
 * ```
 *   requested ──> approved ──> received ──> inspected ──> completed
 *       │             │            │
 *       └─> rejected  └─> cancelled└─> rejected
 * ```
 *
 * Here rather than in the schema because a CHECK constrains which values a column may hold and
 * cannot see the row's previous value. The schema owns the vocabulary; this owns the grammar.
 *
 * Two absences are deliberate and load-bearing:
 *
 *  - **No `inspected -> rejected`.** Inspection is the activity performed while the goods sit
 *    in `received`, and its two outcomes are the two edges out of that state. Reaching
 *    `inspected` already means the return was accepted, which is what makes
 *    `inspected -> completed` unconditional.
 *  - **No `requested -> cancelled`… wait, there is one edge from `approved` only.** A customer
 *    may withdraw a return the merchant has agreed to but not yet received; the approved rules
 *    place the cancellation boundary there and nowhere else.
 */
const TRANSITIONS: Readonly<Record<ReturnStatus, readonly ReturnStatus[]>> = {
  requested: ['approved', 'rejected'],
  approved: ['received', 'cancelled'],
  received: ['inspected', 'rejected'],
  inspected: ['completed'],
  completed: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: ReturnStatus, to: ReturnStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Nothing further happens from here. Mirrors `TERMINAL_RETURN_STATUSES` in the schema. */
export function isTerminal(status: ReturnStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * The one state a customer may cancel from.
 *
 * A named constant rather than a literal at the call site, so the cancellation boundary is
 * stated once and a test can assert it rather than restate it.
 */
export const CUSTOMER_CANCELLABLE_STATUSES = ['approved'] as const;

export function isCustomerCancellable(status: ReturnStatus): boolean {
  return (CUSTOMER_CANCELLABLE_STATUSES as readonly string[]).includes(status);
}
