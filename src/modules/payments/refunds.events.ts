/**
 * The refund audit vocabulary.
 *
 * **Audit only — no domain events**, exactly as `payments.events.ts` and `returns.events.ts`
 * decided for the same reason. The handler registry is empty (`container.ts` passes
 * `opts.handlers ?? {}` and no entry point supplies one), so a `refund.succeeded` event would
 * have no consumer, and the rule this project has held since Increment 26 is that an event with
 * no consumer is a guess at one. A refund is at least as event-worthy as a payment, which is
 * precisely why it must not get a speculative event: the first real consumer — a refund
 * confirmation email, or a reconciliation worker — ships the event with it.
 *
 * Five actions, because five distinct things can happen to a refund and an auditor chasing
 * money needs to tell them apart. `unresolved` in particular is not noise: it is the entry that
 * says "we asked the provider and never found out", and it is the one an operator must be able
 * to filter for.
 */

/** `resource_type` for every entry here. Answers "what happened to THIS refund?" in one query. */
export const REFUND_RESOURCE = 'refund';

export const REFUND_AUDIT = {
  /** A refund row was created and the balance was claimed. Before any provider call. */
  raised: 'refund.raised',
  /** The provider confirmed it, or staff recorded a manual disbursement. */
  succeeded: 'refund.succeeded',
  /** The provider refused it. Evidence of failure, not merely an absence of success. */
  failed: 'refund.failed',
  /** The provider was asked and the answer is unknown. Needs reconciliation. */
  unresolved: 'refund.unresolved',
  /** A manual refund was asserted paid out offline by a named staff member. */
  settled: 'refund.settled',
} as const;

export type RefundAuditAction = (typeof REFUND_AUDIT)[keyof typeof REFUND_AUDIT];
