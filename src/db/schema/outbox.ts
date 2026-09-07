import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { primaryId, tsColumn } from './_shared.js';
import { store } from './store.js';

/**
 * The transactional outbox.
 *
 * The problem it solves, precisely:
 *
 *   Enqueueing a BullMQ job inside a database transaction lets a worker pick it up and
 *   query for a row that has not committed yet. The job fails with "order not found" for
 *   an order that plainly exists. It appears only under load, it is not reproducible
 *   locally, and it is miserable to diagnose.
 *
 *   Enqueueing AFTER the commit has the opposite failure: the process dies between COMMIT
 *   and `queue.add`, and the confirmation email is never sent. Silent, and only noticed
 *   when a customer complains.
 *
 * The outbox removes both. `events.emit()` INSERTs into this table using the caller's
 * transaction, so the event commits atomically with the business state — or not at all. A
 * separate drainer polls with `FOR UPDATE SKIP LOCKED`, pushes to BullMQ, and marks the
 * row published. Delivery is at-least-once, which is why every handler must be idempotent.
 *
 * Django's `transaction.on_commit()` is the equivalent and Node has no such thing. This
 * table is that mechanism. It is built in Phase 0, before the first event exists — an
 * ESLint rule bans calling `queue.add` anywhere outside the event bus.
 */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: primaryId(),
    /** NULL for platform-level events emitted before a store is resolved. */
    storeId: uuid('store_id').references(() => store.id, { onDelete: 'restrict' }),

    /** Dotted and versioned by convention: `order.placed`, `stock.reserved`. */
    eventName: varchar('event_name', { length: 128 }).notNull(),

    /**
     * What the event is ABOUT: `order`, `payment`, `stock_item`.
     *
     * Not derivable from `event_name` and worth its own column. It is what makes
     * "show me everything that ever happened to order X" a single indexed query — the
     * question actually asked during an incident, and the basis of any future replay.
     */
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    /**
     * The id of that thing. A string rather than a uuid: most aggregates are UUIDv7, but
     * some are naturally keyed by a business identifier (an invoice number, a gateway
     * reference), and forcing those through a uuid column would mean inventing one.
     */
    aggregateId: varchar('aggregate_id', { length: 128 }).notNull(),

    /**
     * The event body. Carries IDS AND FACTS, not entities — a payload holding a whole
     * serialised order becomes wrong the moment the order changes, and the handler runs
     * later by definition. Include what was true at emission.
     */
    payload: jsonb('payload').notNull(),

    /** Correlates the resulting job's logs back to the request that caused the event. */
    requestId: varchar('request_id', { length: 64 }),

    /** When the business fact happened — set by the emitter, inside the transaction. */
    occurredAt: tsColumn('occurred_at').notNull().defaultNow(),
    /** Earliest time the drainer may publish this. Set forward for retry backoff. */
    availableAt: tsColumn('available_at').notNull().defaultNow(),

    /** Set once handed to BullMQ. NULL means still owed. */
    publishedAt: tsColumn('published_at'),

    /**
     * Incremented when the row is CLAIMED, not when it fails. A worker that dies
     * mid-publish still burns an attempt, so an event whose payload crashes the process
     * eventually dead-letters instead of taking down every worker in a loop forever.
     */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    /**
     * Set when the event has exhausted its retries and will never be published.
     *
     * A separate state rather than "leave it pending with a far-future available_at":
     * pending-and-retrying and permanently-dead need different alerts and different human
     * responses. A dead-lettered event is a bug to investigate and replay by hand, not a
     * transient failure to wait out.
     */
    deadLetteredAt: tsColumn('dead_lettered_at'),

    /**
     * Claim marker. Set by the drainer under `FOR UPDATE SKIP LOCKED` so two drainer
     * instances never publish the same row, and a drainer that crashes mid-publish leaves
     * a visibly stale claim that the reaper can reclaim.
     */
    claimedAt: tsColumn('claimed_at'),
    claimedBy: varchar('claimed_by', { length: 128 }),

    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /**
     * The drainer's only query. Partial — it indexes ONLY unpublished rows, so it stays
     * small and fast forever even as the table accumulates millions of published events.
     * Without `WHERE published_at IS NULL` this index grows without bound and the poll
     * gets slower every week.
     *
     * `occurredAt` is the tiebreaker so events for the same aggregate publish in the
     * order they happened.
     */
    index('ix_outbox_unpublished')
      .on(t.availableAt, t.occurredAt)
      .where(sql`${t.publishedAt} IS NULL AND ${t.deadLetteredAt} IS NULL`),

    /** Feeds the alert on "oldest unpublished event age" — the outbox's health signal. */
    index('ix_outbox_stale_claims')
      .on(t.claimedAt)
      .where(sql`${t.publishedAt} IS NULL AND ${t.claimedAt} IS NOT NULL`),

    /** Dead letters are a human queue; small, and queried by "show me what broke". */
    index('ix_outbox_dead_lettered')
      .on(t.deadLetteredAt)
      .where(sql`${t.deadLetteredAt} IS NOT NULL`),

    /**
     * "Everything that happened to this order, in order." The question asked during an
     * incident, and the one a replay tool needs. Leads with `store_id` so it is usable
     * under tenancy rather than scanning every tenant's history.
     */
    index('ix_outbox_aggregate').on(t.storeId, t.aggregateType, t.aggregateId, t.occurredAt),

    /** For the retention job that trims published rows after the audit window. */
    index('ix_outbox_published')
      .on(t.publishedAt)
      .where(sql`${t.publishedAt} IS NOT NULL`),
  ],
);

/**
 * Processed-event ledger, for consumer-side deduplication.
 *
 * The outbox guarantees at-least-once delivery, so a handler WILL occasionally run twice —
 * a worker crash after the side effect but before the ack is enough. Handlers whose effect
 * is not naturally idempotent claim a row here first; the unique constraint makes the
 * second attempt a no-op instead of a second confirmation email.
 */
export const processedEvent = pgTable(
  'processed_event',
  {
    id: primaryId(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboxEvent.id, { onDelete: 'cascade' }),
    /** Which handler. The same event legitimately runs through several. */
    handlerName: varchar('handler_name', { length: 128 }).notNull(),
    processedAt: tsColumn('processed_at').notNull().defaultNow(),
  },
  (t) => [
    // The dedupe guarantee. Claiming is an INSERT; a unique violation means "already done".
    uniqueIndex('uq_processed_event').on(t.eventId, t.handlerName),
    index('ix_processed_event_time').on(t.processedAt),
  ],
);
