/**
 * The invoicing module's public surface.
 *
 * Everything another module or the composition root may name. The issuance types are exported
 * because `container.ts` adapts this service onto the port ORDERS declares — orders never
 * imports this module, and this module never imports orders.
 *
 * Deliberately absent: the repository's table imports, the column map, and `allocateNumber`
 * itself. Nothing outside this module may allocate a number — that capability exists only
 * behind `issueForOrder`, which is what keeps the series the property of one code path.
 */

export {
  createInvoicingService,
  type InvoiceableOrder,
  type InvoicingService,
  type IssuedInvoice,
} from './invoicing.service.js';

export {
  createInvoicingRepository,
  FINANCIAL_YEAR_PATTERN,
  INVOICE_NUMBER_PATTERN,
  INVOICE_NUMBER_PREFIX,
  INVOICE_SEQUENCE_WIDTH,
  type InvoiceRecord,
  type InvoicingRepository,
} from './invoicing.repository.js';

export {
  financialYearOf,
  formatInvoiceNumber,
  localCalendarDate,
  localDateString,
} from './financial-year.js';

export {
  reconcile,
  summarise,
  type InvoiceSummary,
  type SummarisableLine,
  type SummaryRow,
} from './invoice-summary.js';

export { INVOICE_AUDIT, INVOICE_RESOURCE } from './invoicing.events.js';
