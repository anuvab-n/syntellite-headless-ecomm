import { createAuditRepository, createAuditTrail } from '../../src/db/audit/index.js';
import type { Database } from '../../src/db/client.js';
import { createEventBus } from '../../src/db/outbox/event-bus.js';
import { createOutboxRepository } from '../../src/db/outbox/outbox.repository.js';
import type { AuditTrail } from '../../src/shared/audit.js';
import type { EventBus } from '../../src/shared/events.js';
import { silentLogger } from './postgres.ts';

/**
 * The event bus and audit trail, wired to a test database.
 *
 * REAL implementations against real tables, not doubles — and that is the point. A no-op
 * stub would let every existing suite keep passing while the services silently emitted
 * nothing, which is exactly the "looks wired, does nothing" failure the outbox exists to
 * prevent. With the real ports in place, a service that drops an event fails the assertions
 * in `product-events.integration.test.ts` rather than passing everywhere.
 *
 * It also means the existing catalogue and identity suites now exercise the transaction that
 * wraps write + event + audit, so a broken transaction boundary surfaces across the whole
 * suite instead of only in the new tests.
 */
export function testRecorders(db: Database): { events: EventBus; audit: AuditTrail } {
  return {
    events: createEventBus({
      repository: createOutboxRepository({ db }),
      logger: silentLogger,
    }),
    audit: createAuditTrail({
      repository: createAuditRepository({ db }),
      logger: silentLogger,
    }),
  };
}
