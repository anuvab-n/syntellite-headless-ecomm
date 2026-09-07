/**
 * The payments module's audit vocabulary.
 *
 * **Audit only — there are no payment events.** The handler registry is empty (`container.ts`
 * passes `opts.handlers ?? {}`, and no entry point supplies one), so nothing would consume
 * `payment.succeeded`. Increment 26 settled that an event with no consumer is a guess at one;
 * the rule has held for Increments 26 through 30 and the approved scope for this increment
 * states it again — payment events stay deferred until a real consumer is registered.
 *
 * A payment is at least as event-worthy as an order, which is exactly why it must not get a
 * speculative event. §11 already anticipates the first consumers — a receipt email, and later
 * an invoice — and the queue split in `db/outbox/queues.ts` was written with *"the worker that
 * dispatches payment webhooks"* in mind. The event ships with that consumer, named
 * `payment.succeeded`, `aggregateType: 'payment'`, `aggregateId: payment.id` per §11's event
 * identity. A test asserts the outbox stays empty so adding one is deliberate.
 *
 * Names live in constants because an audit action is read by humans in a filter box: it is a
 * vocabulary an auditor can be handed, not free text.
 */

/** `resource_type` for every entry here. Answers "what happened to THIS payment?" in one query. */
export const PAYMENT_RESOURCE = 'payment';

/**
 * Audit actions. Dotted, past tense, permanent.
 *
 * Four, matching the four things that can actually happen to a payment in this increment. There
 * is deliberately no action for a duplicate webhook: a gateway redelivers aggressively, and a
 * row per redelivery would bury the transitions that matter under noise an auditor has to
 * filter out. A duplicate is logged at `info` with its provider event id instead — the approved
 * scope allows that trade explicitly, asking for an audit entry only *"if the existing audit
 * vocabulary supports that without excessive noise"*.
 *
 * `expired` is here because the approved lifecycle names the state. Nothing writes it in this
 * increment — no expiry window was approved — and it is defined now so the increment that is
 * given one adds a caller rather than a vocabulary.
 */
export const PAYMENT_AUDIT = {
  initiated: 'payment.initiated',
  succeeded: 'payment.succeeded',
  failed: 'payment.failed',
  expired: 'payment.expired',
} as const;
