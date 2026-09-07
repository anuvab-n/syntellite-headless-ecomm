import { and, eq, lte, sql } from 'drizzle-orm';

import type { JsonValue } from '../../shared/events.js';
import type { IdempotencyStore } from '../../shared/idempotency.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import type { Database } from '../client.js';
import { idempotencyKey } from '../schema/idempotency.js';
import { executor } from '../transaction.js';

/**
 * The idempotency key store.
 *
 * All four operations are single statements, which is the point: the claim in particular must
 * resolve two concurrent requests to exactly one winner, and only the database can arbitrate
 * that.
 */

/**
 * The store contract, re-exported under a repository name so the composition root reads like
 * the other data-access modules.
 *
 * `purgeExpired` has no caller yet, deliberately. Nothing writes to this table until an
 * endpoint mounts the middleware (checkout, Increment 32), so there is nothing to purge — and
 * the scheduler's own registry documents the convention that a recurring task arrives with
 * the phase that needs it rather than ahead of it. The method is part of the contract and is
 * covered by tests so that the sweeper is a one-line registration when it is due.
 */
export type IdempotencyRepository = IdempotencyStore;

export function createIdempotencyStore(deps: { db: Database; logger: Logger }): IdempotencyStore {
  const { db, logger } = deps;

  return {
    async claim(params) {
      /**
       * INSERT ... ON CONFLICT DO NOTHING ... RETURNING, then read the existing row only if
       * nothing was inserted.
       *
       * `ON CONFLICT DO NOTHING` rather than a read-then-insert, because two requests
       * arriving together would both see nothing and both proceed. Here exactly one INSERT
       * returns a row; the loser gets an empty result and goes on to inspect what is already
       * there.
       *
       * NOT the caller's transaction — `db` directly, not `executor(db)`. A claim that rolled
       * back alongside a failed handler would release the key at the exact moment a retry was
       * most likely to arrive, letting two attempts run concurrently. Release is explicit
       * (see `release`) precisely so that it is a decision rather than a side effect.
       */
      const inserted = await db
        .insert(idempotencyKey)
        .values({
          id: newId(),
          storeId: params.storeId,
          userId: params.userId,
          key: params.key,
          endpoint: params.endpoint,
          requestHash: params.requestHash,
          status: 'in_progress',
          expiresAt: params.expiresAt,
        })
        .onConflictDoNothing({
          /**
           * Must match `uq_idempotency_key` exactly, INCLUDING `user_id`. A conflict target
           * narrower than the index would not name any unique constraint and PostgreSQL would
           * reject the statement outright; a wider one is impossible here.
           */
          target: [
            idempotencyKey.storeId,
            idempotencyKey.userId,
            idempotencyKey.key,
            idempotencyKey.endpoint,
          ],
        })
        .returning({ id: idempotencyKey.id });

      if (inserted.length > 0) return { outcome: 'claimed' };

      const [existing] = await db
        .select({
          requestHash: idempotencyKey.requestHash,
          status: idempotencyKey.status,
          responseStatus: idempotencyKey.responseStatus,
          responseBody: idempotencyKey.responseBody,
        })
        .from(idempotencyKey)
        .where(
          and(
            eq(idempotencyKey.storeId, params.storeId),
            eq(idempotencyKey.userId, params.userId),
            eq(idempotencyKey.key, params.key),
            eq(idempotencyKey.endpoint, params.endpoint),
          ),
        )
        .limit(1);

      /**
       * Gone between the failed insert and this read — another request completed and a purge
       * removed it, or an operator cleared it. Treating that as claimable is safe: there is
       * no row, so nothing is in flight and nothing can be replayed.
       */
      if (!existing) {
        logger.warn({ endpoint: params.endpoint }, 'idempotency_claim_conflict_row_disappeared');
        return { outcome: 'claimed' };
      }

      /**
       * Payload check BEFORE the status check, deliberately.
       *
       * A mismatched payload is a client bug whatever the first request is doing, and it must
       * never be served a replay. Checking status first would report `in_flight` for a
       * genuinely different request and invite the client to keep retrying it.
       */
      if (existing.requestHash !== params.requestHash) return { outcome: 'mismatch' };

      if (existing.status !== 'completed') return { outcome: 'in_flight' };

      /**
       * The CHECK constraint guarantees a completed row carries a status, so this cannot be
       * null in practice. Treated as still in flight rather than asserted, because a 409
       * inviting a retry is a better answer to a corrupt row than a 500.
       */
      if (existing.responseStatus === null) {
        logger.error({ endpoint: params.endpoint }, 'idempotency_completed_row_missing_status');
        return { outcome: 'in_flight' };
      }

      /**
       * A null body is legitimate, not an error: the original response had none (a 204). The
       * replay then reproduces the status alone, which is exactly what the client received
       * the first time.
       */
      return {
        outcome: 'replay',
        status: existing.responseStatus,
        ...(existing.responseBody === null ? {} : { body: existing.responseBody as JsonValue }),
      };
    },

    async complete(params) {
      /**
       * `executor(db)`, so a caller inside a transaction joins it. That is what will let a
       * checkout service mark the key completed atomically with the order it created.
       *
       * Scoped to `status = 'in_progress'` so completing twice is a no-op rather than
       * overwriting a stored response — a retry must always see the FIRST answer.
       */
      await executor(db)
        .update(idempotencyKey)
        .set({
          status: 'completed',
          responseStatus: params.status,
          // `null` for a bodiless success. Distinguishable from "not yet completed" because
          // `status` and `completed_at` are what the CHECK ties together.
          responseBody: params.body ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyKey.storeId, params.storeId),
            eq(idempotencyKey.userId, params.userId),
            eq(idempotencyKey.key, params.key),
            eq(idempotencyKey.endpoint, params.endpoint),
            eq(idempotencyKey.status, 'in_progress'),
          ),
        );
    },

    async release(params) {
      /**
       * DELETE, not a status change. A released key must be indistinguishable from one never
       * seen, so the next attempt claims cleanly.
       *
       * Restricted to `in_progress`: releasing must never remove a COMPLETED row, or a retry
       * would re-execute an operation that already succeeded — the precise failure this whole
       * mechanism exists to prevent.
       */
      await executor(db)
        .delete(idempotencyKey)
        .where(
          and(
            eq(idempotencyKey.storeId, params.storeId),
            eq(idempotencyKey.userId, params.userId),
            eq(idempotencyKey.key, params.key),
            eq(idempotencyKey.endpoint, params.endpoint),
            eq(idempotencyKey.status, 'in_progress'),
          ),
        );
    },

    async purgeExpired(params) {
      /**
       * Bounded by `limit` so a long-neglected table cannot produce one enormous DELETE that
       * holds locks for minutes. The scheduler simply runs it again next tick.
       */
      const deleted = await db
        .delete(idempotencyKey)
        .where(
          sql`${idempotencyKey.id} in (
            select id from ${idempotencyKey}
            where ${lte(idempotencyKey.expiresAt, params.now)}
            limit ${params.limit}
          )`,
        )
        .returning({ id: idempotencyKey.id });

      if (deleted.length > 0) {
        logger.info({ purged: deleted.length }, 'idempotency_keys_purged');
      }
      return deleted.length;
    },
  };
}
