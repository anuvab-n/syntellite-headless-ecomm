import { sql } from 'drizzle-orm';
import { numeric, timestamp, uuid, varchar, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Column builders shared by every table.
 *
 * These encode the five irreversible decisions from the baseline. Using them is not a
 * style preference — a table that declares its own `id` or its own money column has
 * opted out of the guarantees the rest of the system relies on.
 */

/* ── Identifiers ─────────────────────────────────────────────────────────── */

/**
 * UUIDv7 primary key.
 *
 * v7 is time-ordered, so inserts land at the end of the B-tree like a sequence would,
 * instead of scattering writes across the index the way v4 does. It also does not leak a
 * row count the way an exposed serial does.
 *
 * Generated in the application (see `newId()`), not by the database: services need the id
 * before the INSERT so they can build related rows and emit events inside one
 * transaction. `defaultRandom()` is deliberately NOT used — it produces v4.
 */
export const primaryId = () => uuid('id').primaryKey().notNull();

/** A UUIDv7 foreign-key column. */
export const idRef = (name: string) => uuid(name);

/* ── Timestamps ──────────────────────────────────────────────────────────── */

/**
 * `timestamptz`, always. A naive `timestamp` column silently reinterprets values when the
 * server timezone changes, and nothing surfaces it until an order appears to have shipped
 * before it was placed.
 */
export const tsColumn = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Audit timestamps.
 *
 * Defaulted in the database rather than the application so a manual `INSERT` during an
 * incident cannot produce a row with no `created_at`. `updated_at` is set by the
 * application on every write; a trigger is deliberately avoided so that an intentional
 * backfill can leave it untouched.
 */
export const timestamps = {
  createdAt: tsColumn('created_at').notNull().defaultNow(),
  updatedAt: tsColumn('updated_at').notNull().defaultNow(),
};

/**
 * Soft delete.
 *
 * Only for rows a merchant can "delete" but whose history must survive — a product that
 * appears on past invoices, for instance. It is NOT a default: append-only ledgers and
 * order status history are never deleted at all, and genuinely transient rows
 * (reservations, sessions) are hard-deleted by a sweeper.
 *
 * Every query against a soft-deletable table must filter `deletedAt IS NULL`. That is
 * easy to forget, which is why these tables expose a repository helper rather than being
 * queried ad hoc.
 */
export const softDelete = {
  deletedAt: tsColumn('deleted_at'),
};

/* ── Money ───────────────────────────────────────────────────────────────── */

/**
 * A monetary amount: `NUMERIC(19,4)`.
 *
 * 15 integer digits and 4 decimal places. The extra two places beyond a currency's minor
 * units carry intermediate precision — a per-unit price after a 7.5% discount is not
 * expressible in paise, and rounding it early is how totals drift.
 *
 * Drizzle returns `numeric` as a STRING. That is the desired behaviour: convert with
 * `fromDb()` from shared/money.ts, never with `Number()`.
 *
 * The currency is NOT stored per column — it lives once per aggregate (`store.currency`,
 * `order.currency`) so a single order cannot end up with mixed-currency lines.
 */
export const moneyColumn = (name: string) => numeric(name, { precision: 19, scale: 4 });

/** ISO-4217 code. Constrained to the supported set by a CHECK in the migration. */
export const currencyColumn = (name = 'currency') => varchar(name, { length: 3 });

/**
 * A rate or multiplier — a tax percentage, a discount fraction.
 * Wider scale than money because 18% GST split three ways needs the precision.
 */
export const rateColumn = (name: string) => numeric(name, { precision: 9, scale: 6 });

/* ── Tenancy ─────────────────────────────────────────────────────────────── */

/**
 * `store_id` on every tenant-owned table.
 *
 * Present from the first migration even though v1 launches with one store, because
 * retrofitting tenancy means rewriting every query, every index, and every unique
 * constraint in the system. It costs one column now.
 *
 * `onDelete: 'restrict'` — deleting a store with data must fail loudly rather than
 * cascade away a year of orders.
 *
 * Called as `storeIdColumn(() => store.id)`. The thunk keeps this file free of an import
 * of the store table, which would be a cycle: store.ts needs these builders.
 *
 * Every tenant-owned table pairs this with a composite index or unique constraint that
 * leads with `store_id`. A unique constraint on `slug` alone would let one merchant's
 * product name block another's.
 */
export const storeIdColumn = (ref: () => AnyPgColumn) =>
  uuid('store_id').notNull().references(ref, { onDelete: 'restrict' });

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** `now()` for use in defaults and generated columns. */
export const dbNow = sql`now()`;

/** A short human-facing code (SKU, order number, coupon). Case-sensitive by design. */
export const codeColumn = (name: string, length = 64) => varchar(name, { length });

/** A URL slug. Uniqueness is always scoped to the store, never global. */
export const slugColumn = (name = 'slug') => varchar(name, { length: 255 });

/* ── Tax identity shapes ─────────────────────────────────────────────────── */

/**
 * GSTIN shape: 15 characters — two digits, a ten-character PAN, an entity character, a
 * literal `Z`, and a check character.
 *
 * **Shape only, and deliberately no checksum.** The layout is a documented format and
 * Increment 38's approved decision 8 requires strict shape validation, so it is asserted. The
 * check-digit ALGORITHM is a different thing: implementing it would be engineering inventing a
 * validation rule, and a wrong implementation rejects a legitimate registration — a worse
 * failure than accepting a well-shaped invalid one, which the tax authority rejects anyway.
 *
 * Lives HERE rather than in `tax.ts` because `store.ts` needs it too, and `tax.ts` already
 * imports `store.ts` for its tenancy reference — putting it there would be an import cycle
 * between two schema files, which `dependency-cruiser` rightly forbids.
 */
export const GSTIN_PATTERN = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$';

/** PAN shape: five letters, four digits, one letter. Shape only, for the same reason. */
export const PAN_PATTERN = '^[A-Z]{5}[0-9]{4}[A-Z]$';

/** Exact length of a GSTIN, so a column width and the pattern above cannot drift apart. */
export const GSTIN_LENGTH = 15;

/** Exact length of a PAN, for the same reason. */
export const PAN_LENGTH = 10;
