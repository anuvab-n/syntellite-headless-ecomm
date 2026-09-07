import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { DeliveredEvent, JsonObject } from '../../shared/events.js';
import type { Database } from '../client.js';
import { outboxEvent, processedEvent } from '../schema/outbox.js';
import { type Executor, executor } from '../transaction.js';

/**
 * Data access for the outbox.
 *
 * All the SQL that matters for correctness lives in this one file, so the locking story can
 * be reviewed in a single sitting.
 */

export type OutboxRepository = ReturnType<typeof createOutboxRepository>;

export type InsertOutboxEvent = {
  id: string;
  storeId: string | null;
  eventName: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonObject;
  requestId: string | null;
  occurredAt: Date;
  availableAt: Date;
};

export type OutboxStats = {
  pending: number;
  claimed: number;
  deadLettered: number;
  /** Age in seconds of the oldest unpublished event. The outbox's health signal. */
  oldestPendingAgeSeconds: number | null;
};

export function createOutboxRepository(deps: { db: Database }) {
  const { db } = deps;

  /** Row → the shape a handler receives. */
  function toDelivered(row: typeof outboxEvent.$inferSelect): DeliveredEvent {
    return {
      id: row.id,
      type: row.eventName,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: row.payload as JsonObject,
      storeId: row.storeId,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      requestId: row.requestId,
    };
  }

  return {
    /**
     * Append events.
     *
     * Uses {@link executor}, which returns the AMBIENT transaction when one is open. That
     * single detail is what makes the outbox transactional: the caller's `BEGIN` owns this
     * INSERT, so the event cannot survive a rollback of the business data beside it.
     *
     * Never opens a transaction of its own — doing so would defeat the entire mechanism.
     */
    async insert(rows: readonly InsertOutboxEvent[]): Promise<void> {
      if (rows.length === 0) return;
      await executor(db)
        .insert(outboxEvent)
        .values(rows.map((r) => ({ ...r })));
    },

    /**
     * Claim a batch of due events for exclusive processing.
     *
     * The load-bearing query in this module. Three things make it correct:
     *
     *  1. `FOR UPDATE` locks the selected rows, so a concurrent drainer cannot take them.
     *  2. `SKIP LOCKED` makes that concurrent drainer step over the locked rows and pick up
     *     different work instead of blocking behind us. Without it, N drainers serialise
     *     into one and throughput collapses to a single worker's.
     *  3. The claim is an UPDATE stamping `claimed_at`/`claimed_by`, so the exclusivity
     *     OUTLIVES the transaction. Row locks vanish at COMMIT; if the claim were only a
     *     lock, the next poll one millisecond later would hand the same event to somebody
     *     else while the first worker was still publishing it.
     *
     * `attempts` increments here rather than on failure, so a worker that dies mid-publish
     * still consumes an attempt and a poison event eventually dead-letters.
     *
     * The subquery is required: `FOR UPDATE` cannot be attached to an UPDATE directly, and
     * `LIMIT` needs an ordered inner select to be meaningful.
     */
    async claimBatch(params: {
      workerId: string;
      batchSize: number;
      now?: Date;
    }): Promise<DeliveredEvent[]> {
      const now = params.now ?? new Date();

      const claimed = await db.execute<typeof outboxEvent.$inferSelect>(sql`
        UPDATE ${outboxEvent}
        SET claimed_at = ${now},
            claimed_by = ${params.workerId},
            attempts   = ${outboxEvent.attempts} + 1
        WHERE ${outboxEvent.id} IN (
          SELECT ${outboxEvent.id}
          FROM ${outboxEvent}
          WHERE ${outboxEvent.publishedAt} IS NULL
            AND ${outboxEvent.deadLetteredAt} IS NULL
            AND ${outboxEvent.claimedAt} IS NULL
            AND ${outboxEvent.availableAt} <= ${now}
          ORDER BY ${outboxEvent.availableAt} ASC, ${outboxEvent.occurredAt} ASC
          LIMIT ${params.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);

      // `db.execute` returns snake_case columns straight from the driver, not Drizzle's
      // camelCase mapping, so map explicitly rather than trusting the shape.
      const rows = claimed.rows as unknown as OutboxRow[];

      /**
       * Re-sort in the application, because the `ORDER BY` above does NOT survive to here.
       *
       * It governs WHICH rows the subquery selects — the oldest due ones — but PostgreSQL
       * gives no ordering guarantee for `UPDATE ... RETURNING`; in practice it returns heap
       * order, which is insertion order. Publishing a batch in insertion order silently
       * violates the "events for one aggregate publish in the order they happened"
       * guarantee, and it is invisible until an out-of-order handler corrupts something.
       *
       * Honest scope of the guarantee: ordering holds WITHIN a batch. Across concurrent
       * drainers it cannot — two workers claim disjoint batches and publish in parallel by
       * design. Any handler that genuinely requires per-aggregate ordering must tolerate
       * reordering or serialise on the aggregate itself.
       */
      return rows
        .sort(
          (a, b) =>
            asTime(a.available_at) - asTime(b.available_at) ||
            asTime(a.occurred_at) - asTime(b.occurred_at) ||
            // Final tiebreaker so the order is deterministic rather than merely stable:
            // UUIDv7 ids sort chronologically by creation.
            a.id.localeCompare(b.id),
        )
        .map(fromRawRow);
    },

    /** Mark a successfully published event. Terminal — it is never claimed again. */
    async markPublished(ids: readonly string[], now = new Date()): Promise<void> {
      if (ids.length === 0) return;
      await db
        .update(outboxEvent)
        .set({ publishedAt: now, claimedAt: null, claimedBy: null, lastError: null })
        .where(inArray(outboxEvent.id, [...ids]));
    },

    /**
     * Release a failed event for a later retry.
     *
     * Clears the claim so another drainer can take it, and pushes `available_at` forward by
     * the caller's backoff so the retry is not immediate — an event failing because a
     * downstream service is down should not be hammered a thousand times a second.
     */
    async markFailed(params: { id: string; error: string; retryAt: Date }): Promise<void> {
      await db
        .update(outboxEvent)
        .set({
          claimedAt: null,
          claimedBy: null,
          // Truncated: `last_error` is a diagnostic, and a megabyte stack trace in a row
          // read by a monitoring query is its own outage.
          lastError: params.error.slice(0, 2_000),
          availableAt: params.retryAt,
        })
        .where(eq(outboxEvent.id, params.id));
    },

    /**
     * Give up on an event permanently.
     *
     * Deliberately still visible: the row stays, with its error and attempt count, so it
     * can be investigated and replayed by hand. Deleting it would destroy the only evidence
     * of what went wrong.
     */
    async markDeadLettered(params: { id: string; error: string; now?: Date }): Promise<void> {
      await db
        .update(outboxEvent)
        .set({
          deadLetteredAt: params.now ?? new Date(),
          claimedAt: null,
          claimedBy: null,
          lastError: params.error.slice(0, 2_000),
        })
        .where(eq(outboxEvent.id, params.id));
    },

    /**
     * Reclaim events whose claim has gone stale — the crash-recovery path.
     *
     * A worker that is SIGKILLed, OOM-killed, or loses its network between claiming and
     * publishing leaves `claimed_at` set forever. Nothing else will ever touch that row:
     * `claimBatch` only considers `claimed_at IS NULL`. Without this reaper, a single
     * unlucky crash silently strands a customer's confirmation email permanently.
     *
     * The timeout must exceed the longest legitimate publish, or this will yank work out
     * from under a healthy-but-slow worker and cause a duplicate delivery. Duplicates are
     * survivable (handlers are idempotent); stranded events are not.
     */
    async reclaimStale(params: { olderThan: Date; limit?: number }): Promise<number> {
      const reclaimed = await db.execute(sql`
        UPDATE ${outboxEvent}
        SET claimed_at = NULL,
            claimed_by = NULL,
            last_error = 'claim expired; reclaimed by reaper'
        WHERE ${outboxEvent.id} IN (
          SELECT ${outboxEvent.id}
          FROM ${outboxEvent}
          WHERE ${outboxEvent.publishedAt} IS NULL
            AND ${outboxEvent.deadLetteredAt} IS NULL
            AND ${outboxEvent.claimedAt} IS NOT NULL
            AND ${outboxEvent.claimedAt} < ${params.olderThan}
          LIMIT ${params.limit ?? 1_000}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING ${outboxEvent.id}
      `);
      return reclaimed.rows.length;
    },

    /**
     * Claim an event for one specific handler, for effects that are not naturally
     * idempotent.
     *
     * Returns true if this caller won the claim and should do the work; false if the
     * handler already processed this event and must skip.
     *
     * `ON CONFLICT DO NOTHING` plus the unique index on `(event_id, handler_name)` makes
     * this atomic without a lock — two workers racing on the same event produce exactly one
     * winner. Keyed per handler because the same event legitimately fans out to several,
     * and "the email handler ran" must not suppress the analytics handler.
     */
    async claimForHandler(params: {
      eventId: string;
      handlerName: string;
      id: string;
    }): Promise<boolean> {
      const inserted = await executor(db)
        .insert(processedEvent)
        .values({
          id: params.id,
          eventId: params.eventId,
          handlerName: params.handlerName,
        })
        .onConflictDoNothing()
        .returning({ id: processedEvent.id });
      return inserted.length > 0;
    },

    /** Health and alerting. Cheap enough to poll; all three counts are index-only. */
    async stats(now = new Date()): Promise<OutboxStats> {
      const [row] = await db
        .execute<{
          pending: string;
          claimed: string;
          dead_lettered: string;
          oldest_pending: Date | null;
        }>(
          sql`
        SELECT
          count(*) FILTER (
            WHERE ${outboxEvent.publishedAt} IS NULL AND ${outboxEvent.deadLetteredAt} IS NULL
          ) AS pending,
          count(*) FILTER (
            WHERE ${outboxEvent.publishedAt} IS NULL AND ${outboxEvent.claimedAt} IS NOT NULL
          ) AS claimed,
          count(*) FILTER (WHERE ${outboxEvent.deadLetteredAt} IS NOT NULL) AS dead_lettered,
          min(${outboxEvent.occurredAt}) FILTER (
            WHERE ${outboxEvent.publishedAt} IS NULL AND ${outboxEvent.deadLetteredAt} IS NULL
          ) AS oldest_pending
        FROM ${outboxEvent}
      `,
        )
        .then((r) => r.rows);

      const oldest = row?.oldest_pending ? new Date(row.oldest_pending) : null;
      return {
        pending: Number(row?.pending ?? 0),
        claimed: Number(row?.claimed ?? 0),
        deadLettered: Number(row?.dead_lettered ?? 0),
        oldestPendingAgeSeconds:
          oldest === null
            ? null
            : Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)),
      };
    },

    /** Test and admin support: read one event back. */
    async findById(
      id: string,
      tx?: Executor,
    ): Promise<typeof outboxEvent.$inferSelect | undefined> {
      const [row] = await (tx ?? executor(db))
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.id, id))
        .limit(1);
      return row;
    },

    /**
     * Re-read a queued event from PostgreSQL.
     *
     * This is what keeps Redis out of the system-of-record role: a BullMQ job carries only
     * an id, and the worker resolves the authoritative row here. A job payload that is
     * stale, truncated, or hand-edited therefore cannot make a handler act on wrong data.
     *
     * Returns undefined if the row is gone — the retention job trimming an old published
     * event. The caller acks rather than retrying.
     */
    async findDeliveredById(id: string): Promise<DeliveredEvent | undefined> {
      const [row] = await db.select().from(outboxEvent).where(eq(outboxEvent.id, id)).limit(1);
      return row ? toDelivered(row) : undefined;
    },

    /** Test and admin support: list pending events in publish order. */
    async listPending(limit = 100): Promise<(typeof outboxEvent.$inferSelect)[]> {
      return db
        .select()
        .from(outboxEvent)
        .where(and(isNull(outboxEvent.publishedAt), isNull(outboxEvent.deadLetteredAt)))
        .orderBy(asc(outboxEvent.availableAt), asc(outboxEvent.occurredAt))
        .limit(limit);
    },

    /** Retention: trim published rows once they are past the audit window. */
    async deletePublishedBefore(cutoff: Date): Promise<number> {
      const deleted = await db
        .delete(outboxEvent)
        .where(and(lte(outboxEvent.publishedAt, cutoff)))
        .returning({ id: outboxEvent.id });
      return deleted.length;
    },

    toDelivered,
  };
}

/* ── Raw row mapping ─────────────────────────────────────────────────────── */

/**
 * `db.execute` bypasses Drizzle's column mapping and hands back the driver's raw
 * snake_case row, so the claim and reap queries map by hand. Typed rather than cast so a
 * column rename is a compile error here too.
 */
type OutboxRow = {
  id: string;
  store_id: string | null;
  event_name: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: JsonObject;
  request_id: string | null;
  occurred_at: string | Date;
  /** Not exposed on `DeliveredEvent` — needed only as the primary sort key. */
  available_at: string | Date;
  attempts: number | string;
};

/** `pg` may hand back a `timestamptz` as a Date or as a string depending on parser setup. */
function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function asTime(value: string | Date): number {
  return asDate(value).getTime();
}

function fromRawRow(row: OutboxRow): DeliveredEvent {
  return {
    id: row.id,
    type: row.event_name,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    storeId: row.store_id,
    occurredAt: asDate(row.occurred_at),
    attempts: Number(row.attempts),
    requestId: row.request_id,
  };
}
