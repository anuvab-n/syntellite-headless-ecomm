import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { invoice, invoiceSeries } from '../../db/schema/invoicing.js';
import { executor } from '../../db/transaction.js';

/**
 * Invoice persistence: the series counter, and the issued invoice.
 *
 * The only file in this module permitted to import a table — `dependency-cruiser`'s
 * `schema-only-in-repositories` rule. Every method takes `storeId` and puts it in the predicate,
 * so tenancy is enforced here rather than trusted from the caller.
 *
 * `executor(db)` rather than `db` throughout, so a method called inside `withTransaction` joins
 * the ambient transaction. That is not a convenience here, it is the entire numbering
 * guarantee: `allocateNumber` MUST run in the checkout transaction, because a rollback is what
 * releases the number.
 */

export {
  FINANCIAL_YEAR_PATTERN,
  INVOICE_NUMBER_PATTERN,
  INVOICE_NUMBER_PREFIX,
  INVOICE_SEQUENCE_WIDTH,
} from '../../db/schema/invoicing.js';

export type InvoicingRepository = ReturnType<typeof createInvoicingRepository>;

/** An issued invoice, as this module hands it out. */
export type InvoiceRecord = {
  readonly id: string;
  readonly orderId: string;
  readonly invoiceNumber: string;
  readonly financialYear: string;
  readonly sequenceNumber: number;
  readonly issuedAt: Date;
  readonly invoiceDate: string;
  readonly taxableValue: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
};

const INVOICE_COLUMNS = {
  id: invoice.id,
  orderId: invoice.orderId,
  invoiceNumber: invoice.invoiceNumber,
  financialYear: invoice.financialYear,
  sequenceNumber: invoice.sequenceNumber,
  issuedAt: invoice.issuedAt,
  invoiceDate: invoice.invoiceDate,
  taxableValue: invoice.taxableValue,
  taxTotal: invoice.taxTotal,
  grandTotal: invoice.grandTotal,
} as const;

export function createInvoicingRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * **Allocate the next number in a store's financial-year series. ONE statement.**
     *
     * ```sql
     * INSERT INTO invoice_series (id, store_id, financial_year, last_number)
     * VALUES ($1, $2, $3, 1)
     * ON CONFLICT (store_id, financial_year)
     *   DO UPDATE SET last_number = invoice_series.last_number + 1, updated_at = now()
     * RETURNING last_number;
     * ```
     *
     * Why this shape, and not any of the obvious alternatives:
     *
     *  - **Not `nextval()`.** A sequence advances outside the transaction, so a rolled-back
     *    checkout would burn a number and leave a gap. A statutory series may not have gaps.
     *    See `db/schema/invoicing.ts` for the full argument.
     *  - **Not `MAX(sequence_number) + 1`.** Under READ COMMITTED two concurrent readers see the
     *    same maximum and both write it.
     *  - **Not read-then-update, and not create-then-increment.** Two statements leave a window.
     *    In particular `INSERT … DO NOTHING` followed by an `UPDATE` has a real failure mode: if
     *    the transaction that inserted the series row then rolls back, a concurrent transaction
     *    that had already decided to "do nothing" finds no row to update and allocates nothing.
     *    `DO UPDATE` has no such gap — the row either arrives from this statement or is locked
     *    and incremented by it.
     *
     * Concurrency, exactly: two transactions issuing the first invoice of a year both attempt the
     * INSERT. One wins `uq_invoice_series`; the other BLOCKS on that index until the winner
     * commits or rolls back, then proceeds down the `DO UPDATE` branch and reads the committed
     * value. So the two allocations are 1 and 2, in some order, and never both 1.
     *
     * `for update` is not written anywhere here because `DO UPDATE` takes the row lock itself.
     */
    async allocateNumber(input: {
      seriesId: string;
      storeId: string;
      financialYear: string;
    }): Promise<number> {
      const rows = await executor(db)
        .insert(invoiceSeries)
        .values({
          id: input.seriesId,
          storeId: input.storeId,
          financialYear: input.financialYear,
          lastNumber: 1,
        })
        .onConflictDoUpdate({
          target: [invoiceSeries.storeId, invoiceSeries.financialYear],
          set: {
            lastNumber: sql`${invoiceSeries.lastNumber} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({ lastNumber: invoiceSeries.lastNumber });

      const allocated = rows[0]?.lastNumber;
      if (allocated === undefined) {
        /*
         * Unreachable: an upsert with `DO UPDATE` always returns its row. Stated so that if it
         * ever were reachable the checkout fails loudly rather than issuing an invoice with an
         * undefined number.
         */
        throw new Error('invoice series allocation returned no row');
      }
      return allocated;
    },

    /** The series counter as it stands. For tests and for an operator's reconciliation. */
    async findSeries(input: {
      storeId: string;
      financialYear: string;
    }): Promise<{ financialYear: string; lastNumber: number } | undefined> {
      const [row] = await executor(db)
        .select({
          financialYear: invoiceSeries.financialYear,
          lastNumber: invoiceSeries.lastNumber,
        })
        .from(invoiceSeries)
        .where(
          and(
            eq(invoiceSeries.storeId, input.storeId),
            eq(invoiceSeries.financialYear, input.financialYear),
          ),
        )
        .limit(1);
      return row;
    },

    async insertInvoice(values: {
      id: string;
      storeId: string;
      orderId: string;
      invoiceNumber: string;
      financialYear: string;
      sequenceNumber: number;
      issuedAt: Date;
      invoiceDate: string;
      taxableValue: string;
      taxTotal: string;
      grandTotal: string;
    }): Promise<InvoiceRecord> {
      const [row] = await executor(db).insert(invoice).values(values).returning(INVOICE_COLUMNS);
      if (!row) throw new Error('invoice insert returned no row');
      return row;
    },

    /**
     * The invoice for one order, or `undefined`.
     *
     * `undefined` is a NORMAL answer, not an error: an order placed before Increment 39, or one
     * whose store had no GST profile, has no invoice and never will. The read path renders such
     * an order without a statutory number rather than refusing it.
     */
    async findByOrderId(input: {
      orderId: string;
      storeId: string;
    }): Promise<InvoiceRecord | undefined> {
      const [row] = await executor(db)
        .select(INVOICE_COLUMNS)
        .from(invoice)
        .where(and(eq(invoice.orderId, input.orderId), eq(invoice.storeId, input.storeId)))
        .limit(1);
      return row;
    },
  };
}
