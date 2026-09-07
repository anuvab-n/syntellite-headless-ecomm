/**
 * The orders module's audit vocabulary.
 *
 * **Audit only — there are no order events.** The handler registry is empty (`container.ts`
 * passes `opts.handlers ?? {}`), so nothing consumes `order.placed`, and Increment 26 settled
 * that an event with no consumer is a guess at one. The rule has held for Increments 26, 27, 28
 * and 29 and holds here.
 *
 * An order is the most event-worthy thing in the domain, which is exactly why it must not get a
 * speculative one: §11 already anticipates the first consumer — an order-confirmation email, and
 * the queue split exists so that _"a bulk send must not queue ahead of an order confirmation"_.
 * The event ships with that consumer, named `order.placed`, `aggregateType: 'order'`,
 * `aggregateId: order.id` per §11's event identity. A test asserts the outbox stays empty so
 * adding it is deliberate.
 *
 * Names live in constants because an audit action is read by humans in a filter box: it is a
 * vocabulary an auditor can be handed, not free text.
 */

/** `resource_type` for every entry here. Answers "what happened to THIS order?" as one query. */
export const ORDER_RESOURCE = 'order';

/**
 * Audit actions. Dotted, past tense, permanent.
 *
 * One action, because this increment supports one transition. Cancellation, payment and
 * fulfilment each bring their own, written by the increment that can actually cause them.
 */
export const ORDER_AUDIT = {
  placed: 'order.placed',
} as const;
