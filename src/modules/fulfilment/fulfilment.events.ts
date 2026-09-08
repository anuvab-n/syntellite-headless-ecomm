/**
 * The fulfilment module's audit vocabulary.
 *
 * **Audit only — there are no shipment events.** The outbox handler registry has exactly one
 * consumer (`user.password_reset_requested`), so nothing would consume `shipment.shipped`, and
 * §39's rule has held for seven increments: an event with no consumer is a guess at one.
 *
 * `shipment.shipped` is the most obviously event-worthy thing here — "your order has shipped" is
 * the notification every shop sends, and the mail infrastructure already exists. That is exactly
 * why it must not get a speculative event: the consumer is one increment away, not zero, and the
 * event should ship WITH it so its payload is designed against a real reader. A test asserts the
 * outbox stays empty, so adding one later is a deliberate act rather than a side effect.
 *
 * Names live in constants because an audit action is read by humans in a filter box: it is a
 * vocabulary an auditor can be handed, not free text.
 */

/** `resource_type` for every entry here. Answers "what happened to THIS shipment?" in one query. */
export const SHIPMENT_RESOURCE = 'shipment';

/**
 * Audit actions. Dotted, past tense, permanent.
 *
 * Four, matching the four things a staff member can actually do to a shipment. There is
 * deliberately no action for a refused transition: a 409 is not something that happened to the
 * shipment, and recording every rejected double-click would bury the transitions that matter.
 *
 * `tracking_updated` is here because a tracking number is a CUSTOMER-VISIBLE fact, and a
 * correction to one is precisely what an audit trail exists for — who changed the number the
 * customer is watching, and when.
 */
export const SHIPMENT_AUDIT = {
  created: 'shipment.created',
  shipped: 'shipment.shipped',
  delivered: 'shipment.delivered',
  trackingUpdated: 'shipment.tracking_updated',
} as const;

export type ShipmentAuditAction = (typeof SHIPMENT_AUDIT)[keyof typeof SHIPMENT_AUDIT];
