import type { JsonObject } from './events.js';

/**
 * Audit trail contracts.
 *
 * Types only — no I/O, no imports from `db/`. Same discipline as `events.ts`, and for the
 * same reason: domain code declares "record that this was done, by whom" without depending
 * on where the record lands.
 *
 * ## Audit log versus domain events
 *
 * These look similar and answer different questions. Keeping them separate is deliberate.
 *
 *  - An **event** says *something happened*, so other parts of the system can react. It is
 *    delivered at-least-once, may be handled minutes later, and its consumers are code.
 *  - An **audit entry** says *someone did something*, so a human can later ask who. It is
 *    never delivered anywhere, never retried, and its consumer is an auditor.
 *
 * A single table serving both ends up either dropping the actor (useless for audit) or
 * carrying delivery state (useless for reading). One admin action legitimately produces
 * both: an event so the storefront cache invalidates, an audit row so a manager can see
 * who changed the price.
 */

/**
 * Who performed the action.
 *
 * A discriminated union rather than two loose columns, because `actor_type = 'system'` with
 * a non-null `actor_user_id` is a contradiction the type system can rule out. It maps onto
 * `audit_log.actor_type` and `audit_log.actor_user_id`.
 */
export type AuditActor =
  /** A staff member acting through the admin API. The most important case to attribute. */
  | { readonly type: 'staff'; readonly userId: string }
  /** A customer acting on their own account. */
  | { readonly type: 'customer'; readonly userId: string }
  /** The platform itself — a migration, a sweeper, an operator script. No user. */
  | { readonly type: 'system' }
  /** A background job. Named, so a surprising entry can be traced to its scheduler. */
  | { readonly type: 'job'; readonly name: string };

/** The `actor_type` values this build writes. Constrained here rather than at each call site. */
export const AUDIT_ACTOR_TYPES = ['staff', 'customer', 'system', 'job'] as const;

export type AuditEntry = {
  /**
   * What was done. Dotted, past tense, and stable: `product.published`,
   * `auth.password_changed`. Read by humans in a filter box, so it is a vocabulary rather
   * than free text — see the per-module constants files.
   */
  readonly action: string;
  readonly actor: AuditActor;
  /** What was acted on: `product`, `app_user`. Absent for actions with no single subject. */
  readonly resourceType?: string;
  readonly resourceId?: string;
  /**
   * Why, or what changed. A before/after diff, or the reason a privileged action was taken.
   *
   * NEVER credential material. Not a password, not a hash, not a token, not a token hash.
   * Audit logs are read by more people than the database, and are frequently shipped to a
   * log aggregator with different access controls.
   */
  readonly metadata?: JsonObject;
  /**
   * The tenant. Falls back to the ambient request context, so a caller inside a
   * store-scoped request need not thread it through every layer.
   */
  readonly storeId?: string;
};

export type AuditOptions = {
  /**
   * Permit recording with no open transaction.
   *
   * Off by default, mirroring `EmitOptions.allowOutsideTransaction`. An audit row written
   * outside the transaction it describes can survive a rollback — producing a trail that
   * claims an action happened when it did not — or be lost while the action commits,
   * producing a trail that is silently incomplete. Both are worse than a loud failure.
   *
   * Legitimate uses: recording a FAILED action that has no successful write to join
   * (`auth.login_failed`), and tests.
   */
  allowOutsideTransaction?: boolean;
};

/**
 * The only sanctioned way to write an audit entry.
 *
 * Returns nothing. There is no id to correlate and no delivery to await — an audit entry is
 * a fact recorded for later reading, not a message. Making it `void` keeps callers from
 * building logic on top of it.
 */
export type AuditTrail = {
  record(entry: AuditEntry, options?: AuditOptions): Promise<void>;
};
