import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * HTTP idempotency keys.
 *
 * Cross-cutting, like the outbox and the audit log: any endpoint that a client may safely
 * retry writes here, so it is not owned by a domain module.
 *
 * See `shared/idempotency.ts` for why this exists at all, and prefer a natural unique
 * constraint wherever one is available.
 */

export const IDEMPOTENCY_STATUSES = ['in_progress', 'completed'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * **The authenticated user the key belongs to.**
     *
     * Added by Increment 30, and it closes a cross-user isolation hole rather than adding a
     * feature. With the identity scoped to `(store_id, key, endpoint)` alone, two customers in
     * one store sending the same `Idempotency-Key` to the same endpoint collided: different
     * payloads gave the second a spurious `422`, and IDENTICAL payloads served the second
     * customer **a replay of the first customer's response** — an order number, totals and a
     * delivery address belonging to someone else, on a money-bearing endpoint.
     *
     * `NOT NULL`, so the isolation cannot be opted out of by omission. That does mean the
     * middleware can only guard AUTHENTICATED endpoints, which is not a real restriction: the
     * doc comment above already excludes the unauthenticated candidates — a webhook or an
     * invoice submission has a natural key, and *"a constraint needs no header, no storage, and
     * no expiry policy"*.
     *
     * A nullable column with `NULLS NOT DISTINCT` would also have worked and PostgreSQL 16
     * supports it, but Drizzle 0.45's `uniqueIndex` builder does not expose the option, and
     * reaching for a raw index would put the constraint outside what `drizzle-kit` can diff.
     */
    userId: uuid('user_id').notNull(),

    /** The client-supplied `Idempotency-Key` header, verbatim. */
    key: varchar('key', { length: 255 }).notNull(),
    /**
     * Which operation the key belongs to, e.g. `POST /api/v1/checkout`.
     *
     * Part of the unique constraint deliberately. A client that reuses one key across two
     * different endpoints is not asking for a replay of the wrong operation — scoping by
     * endpoint means its mistake costs it nothing, whereas a global key space would serve a
     * checkout response to a refund request.
     */
    endpoint: varchar('endpoint', { length: 255 }).notNull(),

    /**
     * SHA-256 hex of the canonicalised request payload — 64 characters.
     *
     * A HASH, never the payload. A checkout body carries addresses and a cart; storing it
     * would duplicate customer PII into a table whose whole purpose is short-lived
     * bookkeeping. The hash answers the only question asked of it: same request, or not?
     */
    requestHash: varchar('request_hash', { length: 64 }).notNull(),

    status: varchar('status', { length: 20 }).notNull().default('in_progress'),

    /**
     * The recorded response, replayed verbatim on a retry.
     *
     * `responseStatus` is set exactly when the row is completed. `responseBody` is set only
     * when there WAS a body: a successful `204 No Content` completes with none, and a retry
     * of it must replay the 204 rather than invent a payload. Requiring a body here would
     * make a bodiless success impossible to record at all — it could neither complete (the
     * constraint would reject it) nor be released (the operation succeeded), so the key would
     * stay pinned until it expired and a later retry would re-execute it.
     *
     * The status is stored alongside because a replayed `201 Created` must not come back
     * as `200`.
     */
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),

    completedAt: tsColumn('completed_at'),

    /**
     * When this row may be purged.
     *
     * Two jobs. It bounds table growth, and it puts a ceiling on how long a crashed request
     * can hold a key: an `in_progress` row whose process died would otherwise answer every
     * retry with `409 in flight` forever.
     */
    expiresAt: tsColumn('expires_at').notNull(),

    ...timestamps,
  },
  (t) => [
    /**
     * The claim guarantee. Claiming is an INSERT, so a unique violation is what makes two
     * concurrent requests with one key resolve to exactly one winner — a read-then-insert
     * would let both through.
     *
     * `user_id` is part of the identity, so one customer's key can never arbitrate another
     * customer's request. `store_id` leads because it is the tenant, and `endpoint` is included
     * for the reason given on that column.
     */
    uniqueIndex('uq_idempotency_key').on(t.storeId, t.userId, t.key, t.endpoint),

    /**
     * Ownership AND tenancy in one constraint, matching every other reference to `app_user`:
     * the key's user must exist and must belong to its store. Without it a key could be written
     * against a user from another tenant, which is the very isolation this column adds.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_idempotency_user_store',
    }).onDelete('restrict'),

    /** The purge scan. Partial, so it covers only rows still worth looking at. */
    index('ix_idempotency_expiry').on(t.expiresAt),

    check('ck_idempotency_status', sql`${t.status} in ('in_progress', 'completed')`),

    /**
     * A completed row carries a status and a completion time; an in-progress row carries
     * neither. Stated as an equivalence, so both directions are enforced.
     *
     * `response_body` is deliberately NOT part of this: a bodiless success is legitimate (see
     * the column comment). What must never exist is a row claiming to be completed with no
     * status to replay, or an in-progress row that already has one.
     *
     * Enforced in the database because the replay path reads these columns and would
     * otherwise have to defend against a half-written row at every call site — the API is
     * not the only writer, and an operator resolving a stuck key during an incident is
     * exactly when this invariant matters most.
     */
    check(
      'ck_idempotency_completed_has_response',
      sql`(${t.status} = 'completed') = (${t.responseStatus} is not null and ${t.completedAt} is not null)`,
    ),
  ],
);
