/**
 * The stores module's audit vocabulary. Increment 62.
 *
 * Audit actions only, and no domain events: the handler registry has no store consumer, and
 * `payments.events.ts`, `returns.events.ts` and `refunds.events.ts` all give the same reason for
 * the same choice — an event nothing consumes is a guess at a consumer, and a dead event type is
 * worse than none because the next reader assumes something depends on it.
 */

/** The `resource_type` for store audit entries. Matches the table name, as elsewhere. */
export const STORE_RESOURCE = 'store';

export const STORE_AUDIT = {
  /**
   * A staff member edited the business identity.
   *
   * Deliberately NOT `store.updated`: the tax profile writes the same TABLE under its own
   * action, and one shared verb would make "who changed our GSTIN" unanswerable by filter.
   */
  businessProfileUpdated: 'store.business_profile_updated',
} as const;

export type StoreAuditAction = (typeof STORE_AUDIT)[keyof typeof STORE_AUDIT];
