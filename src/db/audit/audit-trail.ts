import type { AuditActor, AuditEntry, AuditOptions, AuditTrail } from '../../shared/audit.js';
import { getContext } from '../../shared/context.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { isInTransaction } from '../transaction.js';
import type { AuditRepository, InsertAuditLog } from './audit.repository.js';

/**
 * The audit trail.
 *
 * `record` writes one row to `audit_log` and does nothing else. Structurally the same shape
 * as `createEventBus`, and intentionally so — both write a durable fact using the caller's
 * transaction, and both refuse to run outside one by default:
 *
 *   BEGIN
 *     update product        ─┐
 *     insert audit_log      ─┴─ same transaction
 *   COMMIT                      → the change and its attribution are both durable
 *   ROLLBACK                    → neither exists; no phantom entry claiming it happened
 *
 * The failure this prevents is subtle and one-directional in the worst way: an audit row
 * written in its own transaction survives a rollback of the action, so the trail asserts
 * that someone did something they did not do. That is worse than a missing entry, because
 * it is trusted.
 */
export function createAuditTrail(deps: {
  repository: AuditRepository;
  logger: Logger;
}): AuditTrail {
  const { repository, logger } = deps;

  /** Flatten the actor union onto the two columns the table actually has. */
  function actorColumns(actor: AuditActor): { actorType: string; actorUserId: string | null } {
    switch (actor.type) {
      case 'staff':
      case 'customer':
        return { actorType: actor.type, actorUserId: actor.userId };
      case 'job':
      case 'system':
        // No user. `job` keeps its name in metadata rather than in `actor_user_id`, which is
        // a foreign key to `app_user` and cannot hold a job name.
        return { actorType: actor.type, actorUserId: null };
    }
  }

  function prepare(entry: AuditEntry): InsertAuditLog {
    const context = getContext();
    const { actorType, actorUserId } = actorColumns(entry.actor);

    return {
      id: newId(),
      // Same fallback as the event bus: the ambient store, so a caller inside a store-scoped
      // request does not have to thread `storeId` through every layer.
      storeId: entry.storeId ?? context?.storeId ?? null,
      actorUserId,
      actorType,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      metadata:
        entry.actor.type === 'job'
          ? { ...(entry.metadata ?? {}), jobName: entry.actor.name }
          : (entry.metadata ?? {}),
      // The request that caused this. Correlates an audit entry to the access log and to any
      // events the same action emitted.
      requestId: context?.requestId ?? null,
    };
  }

  function assertTransaction(options: AuditOptions | undefined, action: string): void {
    if (options?.allowOutsideTransaction === true) return;
    if (isInTransaction()) return;
    throw new Error(
      `AuditTrail.record() called outside a transaction (action: ${action}). An audit entry ` +
        'must commit with the change it describes, or it can outlive a rollback and assert ' +
        'that something happened when it did not. Wrap the work in withTransaction(), or ' +
        'pass { allowOutsideTransaction: true } when recording an action that has no ' +
        'successful write to be atomic with (a failed login, for instance).',
    );
  }

  return {
    async record(entry, options) {
      assertTransaction(options, entry.action);

      const row = prepare(entry);
      await repository.insert([row]);

      // Debug, matching the event bus. The audit table is itself the durable record, so an
      // info-level line per entry would duplicate it into the log stream at volume.
      logger.debug(
        {
          audit: {
            id: row.id,
            action: row.action,
            actorType: row.actorType,
            resource:
              row.resourceType === null ? undefined : `${row.resourceType}:${row.resourceId}`,
          },
        },
        'audit_recorded',
      );
    },
  };
}
