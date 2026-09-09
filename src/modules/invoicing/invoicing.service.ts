import type { Database } from '../../db/client.js';
import { isInTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { InvariantViolation } from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { isCurrency, type Currency } from '../../shared/money.js';
import { financialYearOf, formatInvoiceNumber, localDateString } from './financial-year.js';
import {
  reconcile,
  summarise,
  type InvoiceSummary,
  type SummarisableLine,
} from './invoice-summary.js';
import { INVOICE_AUDIT, INVOICE_RESOURCE } from './invoicing.events.js';
import type { InvoiceRecord, InvoicingRepository } from './invoicing.repository.js';

/**
 * Statutory invoice issuance.
 *
 * ## When an invoice is issued
 *
 * At CHECKOUT, inside the order's own transaction, and only for an order that carries a GST
 * determination. Two approved requirements pin that:
 *
 *  - **Requirement 2: no payment-success dependency.** An invoice is issued the moment the
 *    supply is recorded, not when money arrives. A COD order — whose payment is created
 *    `pending` and which §44–§46 record no code path ever terminalises — gets its invoice like
 *    any other. Waiting for payment would leave every COD sale permanently uninvoiced.
 *  - **Requirement 16: an unassessed order gets no statutory number.** A store with no GST
 *    profile assesses no tax, so there is nothing to invoice statutorily; `issueForOrder`
 *    answers `null` and the order simply has no invoice row. That is the same distinction §47
 *    drew for the tax snapshot: "not assessed" is not "assessed at nil".
 *
 * ## Why it is inside the checkout transaction
 *
 * Because the number must be released if the order is not written. The counter is a ROW, not a
 * sequence, so a rollback un-increments it — but only if the increment shares the transaction
 * with the order. Called on the pool instead, a failed checkout would leave a consumed number
 * and a gap in a series that may not have one.
 *
 * `issueForOrder` asserts it is in a transaction rather than trusting the caller, exactly as
 * `lockCartForCheckout`, `reserveForOrder` and `determineForCheckout` do.
 */

export type InvoicingService = ReturnType<typeof createInvoicingService>;

/**
 * The order, as issuance needs it.
 *
 * Deliberately the frozen fields only. There is no `store` parameter carrying a live GSTIN and
 * no way to pass a seller name: approved requirement 12 makes the order's own snapshot the
 * source of historical seller identity, and this signature is what makes any other source
 * unreachable.
 */
export type InvoiceableOrder = {
  readonly id: string;
  readonly orderNumber: string;
  readonly currency: string;
  /** The taxable value: `subtotal - discount_total`. */
  readonly total: string;
  readonly taxTotal: string;
  readonly grandTotal: string;
  /** `null` when the order carries no determination — the unassessed case. */
  readonly taxAt: Date | null;
};

/** The rendered summary plus the invoice row, as the read path consumes it. */
export type IssuedInvoice = {
  readonly invoice: InvoiceRecord;
  readonly summary: InvoiceSummary;
};

export function createInvoicingService(deps: {
  repository: InvoicingRepository;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, audit, logger } = deps;

  const requireCurrency = (storeId: string, code: string): Currency => {
    if (!isCurrency(code)) {
      throw new InvariantViolation(`store ${storeId} has an unsupported currency: ${code}`);
    }
    return code;
  };

  return {
    /**
     * **Issue the statutory invoice for a freshly placed order.**
     *
     * Returns `null` for an unassessed order — no number, no row, no error.
     *
     * The sequence, and every step is load-bearing:
     *
     *  1. Refuse to run outside a transaction.
     *  2. Answer `null` if the order carries no tax determination.
     *  3. Compute the financial year and the document date from the ISSUING INSTANT in the
     *     STORE's timezone. The instant is the caller's `at` — the same one the order is stamped
     *     `placed_at` and `tax_at` with — so all three agree by construction.
     *  4. Build the HSN/rate-wise summary from the frozen lines.
     *  5. RECONCILE it against the order's stored totals. A mismatch throws and the checkout
     *     rolls back; a numbered invoice that does not foot is never written.
     *  6. Allocate the next number from the store's series for that year, in one statement.
     *  7. Insert the invoice. `uq_invoice_order` is the backstop for one-per-order.
     *  8. Audit.
     */
    async issueForOrder(params: {
      storeId: string;
      order: InvoiceableOrder;
      lines: readonly SummarisableLine[];
      /** IANA name from the resolved store. Offsets are wrong twice a year. */
      storeTimezone: string;
      /** The issuing instant. The same `at` the order is placed with. */
      at: Date;
      actor: AuditActor;
    }): Promise<IssuedInvoice | null> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'issueForOrder must be called inside the checkout transaction; the series counter is ' +
            'a row, and it is the rollback of that increment that keeps the series gapless',
        );
      }

      /* Requirement 16: an unassessed order receives no statutory invoice number. */
      if (params.order.taxAt === null) return null;

      const currency = requireCurrency(params.storeId, params.order.currency);

      const financialYear = financialYearOf(params.at, params.storeTimezone);
      const invoiceDate = localDateString(params.at, params.storeTimezone);

      const summary = summarise(params.lines, currency);

      /* Requirement 11. Throws rather than returning, because there is no recovery. */
      reconcile({
        summary,
        orderTotal: params.order.total,
        orderTaxTotal: params.order.taxTotal,
        orderGrandTotal: params.order.grandTotal,
        currency,
      });

      const sequenceNumber = await repository.allocateNumber({
        seriesId: newId(),
        storeId: params.storeId,
        financialYear,
      });

      const invoiceNumber = formatInvoiceNumber(financialYear, sequenceNumber);

      const row = await repository.insertInvoice({
        id: newId(),
        storeId: params.storeId,
        orderId: params.order.id,
        invoiceNumber,
        financialYear,
        sequenceNumber,
        issuedAt: params.at,
        invoiceDate,
        /*
         * From the SUMMARY, not from the order, and the two are already proved equal by the
         * reconciliation above. Taking them from the summary means the stored figures are the
         * ones the printed rows add up to.
         */
        taxableValue: summary.taxableValue,
        taxTotal: summary.taxTotal,
        grandTotal: params.order.grandTotal,
      });

      await audit.record({
        action: INVOICE_AUDIT.issued,
        actor: params.actor,
        resourceType: INVOICE_RESOURCE,
        resourceId: row.id,
        storeId: params.storeId,
        metadata: {
          invoiceNumber: row.invoiceNumber,
          orderNumber: params.order.orderNumber,
          financialYear,
          sequenceNumber,
        },
      });

      logger.info(
        {
          storeId: params.storeId,
          orderNumber: params.order.orderNumber,
          invoiceNumber: row.invoiceNumber,
          financialYear,
        },
        'invoice_issued',
      );

      return { invoice: row, summary };
    },

    /**
     * The issued invoice for an order, with its summary re-derived from the frozen lines.
     *
     * **A read. It issues nothing** — approved requirement 15 keeps the existing GET routes
     * read-only, so an order that has no invoice stays without one no matter how often it is
     * fetched. Backfilling on read would allocate numbers in the order people happened to look
     * at documents, which is not a series.
     *
     * `null` when the order has no invoice: unassessed, or placed before this increment.
     */
    async findForOrder(params: {
      storeId: string;
      orderId: string;
      currency: string;
      lines: readonly SummarisableLine[];
    }): Promise<IssuedInvoice | null> {
      const row = await repository.findByOrderId({
        orderId: params.orderId,
        storeId: params.storeId,
      });
      if (row === undefined) return null;

      const currency = requireCurrency(params.storeId, params.currency);
      return { invoice: row, summary: summarise(params.lines, currency) };
    },

    /** The series counter, for an operator's reconciliation and for the concurrency tests. */
    async getSeries(params: { storeId: string; financialYear: string }) {
      return (await repository.findSeries(params)) ?? null;
    },
  };
}
