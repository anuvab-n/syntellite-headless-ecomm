import type { JsonObject } from '../../shared/events.js';
import type { Database } from '../client.js';
import { auditLog } from '../schema/identity.js';
import { executor } from '../transaction.js';

/**
 * Data access for the audit trail.
 *
 * One INSERT, and deliberately nothing else. `audit_log` is append-only: there is no update
 * method, no delete method, and no soft-delete column, because an audit trail an application
 * can rewrite is not an audit trail. Reads belong to a future admin reporting endpoint and
 * are not needed to write entries, so they are not here.
 *
 * `executor(db)` rather than `db`, so the insert joins the caller's open transaction — that
 * is what makes the entry atomic with the action it records.
 */

export type AuditRepository = ReturnType<typeof createAuditRepository>;

export type InsertAuditLog = {
  id: string;
  storeId: string | null;
  actorUserId: string | null;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: JsonObject;
  requestId: string | null;
};

export function createAuditRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Append audit entries.
     *
     * Batched, matching `OutboxRepository.insert`: one admin action can legitimately produce
     * several entries, and one round trip inside a transaction is cheaper than several.
     *
     * `created_at` is left to the column default so the database clocks the entry rather than
     * the application — an audit timestamp a caller could pass is an audit timestamp a caller
     * could get wrong.
     */
    async insert(rows: readonly InsertAuditLog[]): Promise<void> {
      if (rows.length === 0) return;
      await executor(db)
        .insert(auditLog)
        .values([...rows]);
    },
  };
}
