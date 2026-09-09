/**
 * The invoicing module's audit vocabulary. **Audit actions only — no domain events.**
 *
 * §39's rule has held for eleven increments and holds here: an event with no consumer is a
 * guess at one. `invoice.issued` is the most obviously event-worthy thing in this increment —
 * "email the customer their invoice" is the notification every shop sends, and the mail
 * infrastructure already exists — which is exactly why it must not get a speculative one. The
 * consumer is one increment away, not zero, and the event should ship WITH it so its payload is
 * designed against a real reader.
 *
 * The outbox handler registry still has exactly one consumer, and a test asserts no `invoice.*`
 * event reaches it.
 */

export const INVOICE_RESOURCE = 'invoice';

/**
 * One action, and it is not a customer's.
 *
 * Issuance happens inside checkout, so the ACTOR is the customer who placed the order — but the
 * act being recorded is the allocation of a statutory number, which is the store's. Recorded
 * because a gapless series is an auditable artefact: "which order took number 000042, and when"
 * must be answerable without reading the invoice table itself.
 */
export const INVOICE_AUDIT = {
  issued: 'invoice.issued',
} as const;
