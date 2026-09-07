/**
 * The audit trail subsystem.
 *
 * Cross-cutting infrastructure, sited beside `db/outbox/` rather than under `modules/`
 * because every domain module writes to it. A `modules/audit/` would be unimportable:
 * `no-cross-module-imports` forbids one domain module reaching into another, with no
 * exception for a barrel.
 */

export {
  createAuditRepository,
  type AuditRepository,
  type InsertAuditLog,
} from './audit.repository.js';
export { createAuditTrail } from './audit-trail.js';
