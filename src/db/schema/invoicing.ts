import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { moneyColumn, primaryId, storeIdColumn, timestamps, tsColumn } from './_shared.js';
import { order } from './orders.js';
import { store } from './store.js';

/**
 * Statutory invoice issuance: the numbering series, and the issued invoice itself.
 *
 * Two tables, and the split is the whole design. `invoice_series` is a MUTABLE counter — one
 * row per store per financial year, and the only row in this schema that is meant to change.
 * `invoice` is IMMUTABLE: once a number is allocated to an order it is that order's number for
 * ever, and there is no `UPDATE` path and no `deleted_at`.
 *
 * ## Why a counter row and not a PostgreSQL sequence
 *
 * **A sequence would produce gaps, and a gap is the one thing a statutory series may not have.**
 * `nextval()` is deliberately non-transactional: it advances even when the transaction that
 * called it rolls back, because that is what makes it fast and lock-free. For a surrogate key
 * that is exactly right. For an invoice series it is fatal — a checkout that fails on
 * insufficient stock would burn a number, and the books would show 000001, 000003, 000004 with
 * nothing to account for the missing one.
 *
 * A counter ROW increments inside the caller's transaction, so a rollback un-increments it and
 * the number is handed to the next order instead. That is the property Increment 39 requires,
 * and a test proves it by rolling back a checkout and watching the next one take the same
 * number.
 *
 * **`MAX(sequence_number) + 1` is equally wrong**, for the more familiar reason: under READ
 * COMMITTED two concurrent readers both see the same maximum and both write the same next
 * number. One would lose to `uq_invoice_number` and the customer would see a 500 on a
 * successful order. The counter row's own lock is what serialises them instead.
 *
 * ## What is deliberately absent
 *
 * No IRN, no QR payload, no acknowledgement number, no IRP status. Increment 39 issues a
 * numbered invoice; e-invoicing is a registered integration with a government portal and
 * inventing a column for it would invite something to write a plausible-looking fake into it.
 * No credit note, no debit note, no revision — an invoice is not amended in this build.
 */

/** `INV/2026-27/000001`. The prefix is fixed, and the width below fixes the rest. */
export const INVOICE_NUMBER_PREFIX = 'INV';

/**
 * Zero-padding width for the sequence part.
 *
 * Six digits, so a store may issue 999,999 invoices in one financial year before the format
 * would have to widen. Stated as a constant because the format is asserted character for
 * character by a test and referenced by the CHECK below — three copies of `6` would drift.
 */
export const INVOICE_SEQUENCE_WIDTH = 6;

/**
 * The shape of a financial-year label: `YYYY-YY`.
 *
 * Applied in the database as well as in the service, because the API is not the only writer and
 * a malformed label would silently start a second series for the same year.
 */
export const FINANCIAL_YEAR_PATTERN = '^[0-9]{4}-[0-9]{2}$';

/**
 * The shape of a whole invoice number, `INV/YYYY-YY/NNNNNN`.
 *
 * A CHECK rather than a convention: this string is printed on a document with legal
 * consequences, and a row that does not match it is not something a reader should have to
 * detect by eye.
 */
export const INVOICE_NUMBER_PATTERN = '^INV/[0-9]{4}-[0-9]{2}/[0-9]{6}$';

/* ── The series ──────────────────────────────────────────────────────────── */

/**
 * One counter per store per financial year.
 *
 * `last_number` is the highest number ISSUED, so a fresh series starts at 0 and the first
 * allocation returns 1. Named for what it holds rather than `next_number`, which would make the
 * row's meaning depend on whether you read it before or after an allocation.
 *
 * Allocation is a single `INSERT … ON CONFLICT … DO UPDATE … RETURNING` statement — see
 * `invoicing.repository.ts`. One statement, so there is no window between creating the series
 * and incrementing it, and no ordering for two concurrent first-invoices to get wrong.
 */
export const invoiceSeries = pgTable(
  'invoice_series',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /** `2026-27`. Computed from the issuing instant in the STORE's timezone. */
    financialYear: varchar('financial_year', { length: 7 }).notNull(),

    /**
     * The highest number issued in this series. Zero would mean "created but never used",
     * which the allocation statement never produces — it inserts with 1 already claimed.
     */
    lastNumber: integer('last_number').notNull(),

    ...timestamps,
  },
  (t) => [
    /**
     * **The arbiter of the whole numbering scheme.**
     *
     * One series row per store per year, and it is what two concurrent first-invoices collide
     * on: the loser blocks on this index, then takes the `DO UPDATE` branch and reads the
     * winner's value. Without it both would insert a row and both would issue 000001.
     */
    uniqueIndex('uq_invoice_series').on(t.storeId, t.financialYear),

    check(
      'ck_invoice_series_year',
      sql`${t.financialYear} ~ ${sql.raw(`'${FINANCIAL_YEAR_PATTERN}'`)}`,
    ),

    /** A series that has issued nothing should not exist; the allocation starts at 1. */
    check('ck_invoice_series_last_number', sql`${t.lastNumber} >= 1`),
  ],
);

/* ── The invoice ─────────────────────────────────────────────────────────── */

/**
 * An issued statutory invoice. **Immutable, and one per order.**
 *
 * No `deleted_at` and no revision column. §3 #15 ties order retention to tax law, and that
 * applies with more force here: this row is the record that a numbered invoice exists, and a
 * gapless series is only gapless if nothing can remove a number from the middle of it.
 *
 * ## What it does NOT duplicate
 *
 * The seller's identity, the place of supply, the supply type, both parties' GSTIN and every
 * per-line rate and amount are already frozen on `order` and `order_line` by Increment 38. They
 * are NOT copied here. Approved requirement 12 says the historical seller identity comes from
 * the frozen order tax snapshot, and a second copy would be a second thing that could disagree
 * with the first — which is the failure §43 avoided by deriving `discount_total` from the
 * allocated parts rather than computing it twice.
 *
 * What IS stored here is what the ORDER cannot answer: the number, the series it came from, the
 * date the document bears, and the money totals as they stood when the number was allocated.
 */
export const invoice = pgTable(
  'invoice',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    orderId: uuid('order_id').notNull(),

    /**
     * `INV/2026-27/000001`, assembled once at issue time and stored whole.
     *
     * Stored rather than derived from the three parts below, deliberately: this exact string is
     * what appears on the document, what a customer quotes, and what a return references.
     * Re-assembling it on every read would make the printed number a function of today's
     * formatting code rather than a recorded fact.
     */
    invoiceNumber: varchar('invoice_number', { length: 32 }).notNull(),

    /** The two parts the number was built from, kept so the series can be audited. */
    financialYear: varchar('financial_year', { length: 7 }).notNull(),
    sequenceNumber: integer('sequence_number').notNull(),

    /**
     * When the invoice was issued, and the DATE it bears.
     *
     * Both, and they are not the same thing. `issued_at` is the instant — bookkeeping, in UTC
     * like every other timestamp here. `invoice_date` is the store-local calendar date the
     * document prints and the one the financial year was computed from; deriving it at render
     * time would make a historical invoice's date depend on the reader's timezone and on
     * whatever `store.timezone` says today.
     *
     * Approved requirement 14 is exactly this: persist them, do not derive historical values at
     * render time.
     */
    issuedAt: tsColumn('issued_at').notNull(),
    invoiceDate: varchar('invoice_date', { length: 10 }).notNull(),

    /**
     * The money, as it stood when the number was allocated.
     *
     *   `taxable_value` = Σ `order_line.taxable_value`  = `order.total`
     *   `tax_total`     = Σ `order_line.tax_total`      = `order.tax_total`
     *   `grand_total`   = `taxable_value` + `tax_total` = `order.grand_total`
     *
     * Copied so the invoice row is self-verifying — `ck_invoice_grand_total_identity` below
     * checks its own arithmetic without a join — and so a reconciliation query can compare the
     * invoice against the order it was issued for and find a disagreement rather than assume
     * there is none. The service asserts all three equalities BEFORE inserting, so a mismatch
     * fails the checkout rather than producing an invoice nobody can foot.
     */
    taxableValue: moneyColumn('taxable_value').notNull(),
    taxTotal: moneyColumn('tax_total').notNull(),
    grandTotal: moneyColumn('grand_total').notNull(),

    ...timestamps,
  },
  (t) => [
    /**
     * **One invoice per order — approved requirement 9, in the database.**
     *
     * NOT store-scoped, and for the reason `uq_shipment_order` records: `order_id` is a UUIDv7
     * primary key, globally unique on its own, so adding `store_id` would WEAKEN the constraint
     * rather than scope it — a composite unique would permit two invoices for one order if a
     * caller ever supplied the wrong store. Tenancy comes from `fk_invoice_order_store` and from
     * every repository predicate.
     */
    uniqueIndex('uq_invoice_order').on(t.orderId),

    /**
     * **The number is unique per store.** Two merchants may each issue `INV/2026-27/000001`;
     * one must never be able to block or duplicate the other's.
     *
     * This is the backstop behind the counter row. If the allocation logic were ever replaced
     * with something that could produce a duplicate, this index turns it into a failed
     * transaction rather than two invoices bearing one number.
     */
    uniqueIndex('uq_invoice_number').on(t.storeId, t.invoiceNumber),

    /**
     * The same guarantee stated over the parts, so a hand-written `INSERT` that got the
     * assembled string right but the sequence wrong is still refused.
     *
     * It also SERVES the series audit read — "every invoice this store issued this year, in
     * order" — so there is deliberately no second, non-unique index on the same three columns.
     * A plain `index()` beside this one would be dead weight PostgreSQL would never choose:
     * identical columns in identical order, and the unique one is already the cheaper scan.
     */
    uniqueIndex('uq_invoice_sequence').on(t.storeId, t.financialYear, t.sequenceNumber),

    /**
     * Tenancy AND parenthood in one constraint: the invoice's order must exist, and its store
     * must be that order's store. An invoice against another tenant's order is unrepresentable
     * rather than merely refused in application code.
     *
     * RESTRICT: an order that has been invoiced cannot be hard-deleted. Orders are never
     * deleted anyway, and this makes the retention rule structural rather than a convention.
     */
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_invoice_order_store',
    }).onDelete('restrict'),

    check(
      'ck_invoice_number_shape',
      sql`${t.invoiceNumber} ~ ${sql.raw(`'${INVOICE_NUMBER_PATTERN}'`)}`,
    ),
    check(
      'ck_invoice_year_shape',
      sql`${t.financialYear} ~ ${sql.raw(`'${FINANCIAL_YEAR_PATTERN}'`)}`,
    ),

    /** `2026-09-09`. Shape only — the value's correctness is the service's business. */
    check('ck_invoice_date_shape', sql`${t.invoiceDate} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),

    /** A series is 1-based; 0 would mean a number nobody issued. */
    check('ck_invoice_sequence_positive', sql`${t.sequenceNumber} >= 1`),

    /**
     * **The number must agree with the parts it is made of.**
     *
     * Assembled in the service and stored whole, so without this a typo in the assembly would
     * produce a document whose printed number and recorded sequence disagree — the single worst
     * defect this table could carry, and one no reader would spot.
     */
    check(
      'ck_invoice_number_matches_parts',
      sql`${t.invoiceNumber} = 'INV/' || ${t.financialYear} || '/' || lpad(${t.sequenceNumber}::text, 6, '0')`,
    ),

    check(
      'ck_invoice_money_non_negative',
      sql`${t.taxableValue} >= 0 AND ${t.taxTotal} >= 0 AND ${t.grandTotal} >= 0`,
    ),

    /** The invoice's own arithmetic, checkable without a join. */
    check(
      'ck_invoice_grand_total_identity',
      sql`${t.grandTotal} = ${t.taxableValue} + ${t.taxTotal}`,
    ),
  ],
);
