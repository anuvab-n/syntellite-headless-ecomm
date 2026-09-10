/** The audit `resourceType` for everything in this module. */
export const RETURN_RESOURCE = 'return';

/**
 * Audit actions, one per state transition plus creation.
 *
 * Named constants rather than literals at the call sites, so a rename cannot leave the audit
 * trail half-migrated and a test can assert the exact action rather than restate the string.
 *
 * **No domain events are emitted by this module.** The outbox exists for coupling that is
 * genuinely asynchronous and has a consumer; nothing subscribes to a return today, and the
 * approved rules forbid creating dead consumers. The append-only `return_event` table and the
 * audit trail carry the history that matters. An outbox event arrives with the first real
 * subscriber, not before.
 */
export const RETURN_AUDIT = {
  requested: 'return.requested',
  cancelled: 'return.cancelled',
  approved: 'return.approved',
  rejected: 'return.rejected',
} as const;

export type ReturnAuditAction = (typeof RETURN_AUDIT)[keyof typeof RETURN_AUDIT];

/** Who caused a `return_event`. Matches `ck_return_event_actor_type`. */
export const RETURN_ACTOR_TYPES = ['customer', 'staff'] as const;
export type ReturnActorType = (typeof RETURN_ACTOR_TYPES)[number];
