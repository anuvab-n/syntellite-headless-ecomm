/**
 * The addresses module's audit vocabulary.
 *
 * ## Audit only — NO domain events in this increment
 *
 * There is no `EventBus` here and no `address.created` outbox event, deliberately. Nothing
 * consumes an address change: the handler registry is empty, no checkout exists, and Increment
 * 26 established the rule that *an event with no consumer is a guess at one*. Adding the
 * vocabulary now would publish a contract before anyone can say what it should contain.
 *
 * Audit IS justified on its own terms: an address decides where goods go, and
 * docs/DECISIONS.md §3 decision 15 ("anonymise, never delete") places addresses inside the
 * erasure story, which needs a trail of who changed what and when.
 *
 * Constants rather than inline strings, matching `catalogue.events.ts` and
 * `inventory.events.ts`: an audit action is read by humans in a filter box, so it is a
 * vocabulary rather than free text, and a typo in a second literal is an entry nobody finds.
 */

/** The `resource_type` recorded on every address audit entry. */
export const ADDRESS_RESOURCE = 'address';

export const ADDRESS_AUDIT = {
  created: 'address.created',
  updated: 'address.updated',
  deleted: 'address.deleted',
} as const;
