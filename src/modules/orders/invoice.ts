import { format, fromDb, isCurrency, sum, toDb, type Currency } from '../../shared/money.js';
import { InvariantViolation } from '../../shared/errors.js';
import { COMPANY_LOGO_DATA_URI } from './invoice-logo.js';
import type { OrderLineRecord, OrderRecord } from './orders.repository.js';

/**
 * The invoice document, rendered as self-contained HTML.
 *
 * A pure function of an order: no I/O, no database, no HTTP. That makes it testable against a
 * literal record, and it is why the escaping below can be asserted directly rather than through
 * a route.
 *
 * ## HTML, not PDF
 *
 * Deliberate, and the reason is dependencies. A PDF renderer means `pdfkit` (its own layout
 * engine and font handling) or headless Chromium via `puppeteer` — hundreds of megabytes, a
 * browser process per request, and a new class of production failure. This document prints to
 * PDF from any browser via `@media print`, which is what an invoice is actually used for.
 *
 * If a server-generated PDF becomes a genuine requirement — an emailed attachment, say — that
 * is a dependency decision worth taking on its own terms rather than smuggling in here.
 *
 * ## Everything is escaped. This is the security boundary.
 *
 * The document interpolates values a customer chose: the recipient name, four address lines, a
 * landmark, city and state, plus product and SKU names a staff member typed. **Unescaped, any
 * of those is stored XSS** — and it would be worse than usual here, because `app.ts` disables
 * Content-Security-Policy globally on the stated grounds that this is "a JSON API with no HTML
 * responses". That assumption stops being true at this file.
 *
 * Two defences, both required:
 *
 *  1. `esc()` on every interpolated value, with no exceptions. There is no "this field is safe"
 *     shortcut; the moment one exists somebody adds a second.
 *  2. The route sets a restrictive `Content-Security-Policy` on the response itself, so even a
 *     miss in (1) cannot load a remote script or exfiltrate to one. The policy permits exactly
 *     two things: the inline style block, and `data:` images for the embedded company logo.
 *     Nothing may be fetched from the network, which is also why the logo is inlined rather
 *     than linked — see `invoice-logo.ts`.
 *
 * ## Three documents, one renderer
 *
 * What this function produces depends entirely on what the ORDER carries, and the three cases
 * are deliberately distinguishable on the page:
 *
 * | Order | Number | Seller | Tax rows | HSN summary |
 * | ----- | ------ | ------ | -------- | ----------- |
 * | Unassessed (no GST profile, or pre-Increment-38) | order number | none | none | none |
 * | Assessed, pre-Increment-39 | order number | frozen snapshot | yes | yes |
 * | Assessed and invoiced | `INV/YYYY-YY/NNNNNN` | frozen snapshot | yes | yes |
 *
 * ## The seller is the STORE, from the order's frozen snapshot
 *
 * There is no hardcoded company on this document any more. Increment 38's approved decision 2
 * made the STORE the seller of record and the platform explicitly not; a constant in this file
 * naming a company was the last place that decision was contradicted, and Increment 39's
 * requirement 13 removed it.
 *
 * So the letterhead reads `order.seller_legal_name` — a value frozen at checkout. A merchant
 * who re-registers, renames or moves does not restate a single historical document, which is
 * the whole point of snapshotting it. An UNASSESSED order has no seller snapshot and therefore
 * shows no seller: it is not a statutory invoice, has no seller of record, and inventing one
 * for the letterhead would be the same mistake in a smaller font.
 *
 * The logo survives because it is decorative — `alt=""`, and it makes no claim about who sold
 * anything.
 *
 * ## What this document is STILL NOT
 *
 * **Not e-invoiced.** There is no IRN, no acknowledgement number and no signed QR code, because
 * obtaining them means registering with the government portal and calling it — an integration,
 * not a rendering change. Approved requirement 17 forbids inventing a plausible-looking
 * substitute, and a test asserts none of those strings appears.
 *
 * The disclaimer therefore stays, and it is reworded a second time to say what is true now: the
 * document carries a sequential number and an HSN summary, and it carries no IRN or QR. A
 * document that quietly stopped disclaiming the moment it grew a number would be the worst
 * possible outcome of this increment.
 */

/**
 * Escape text for HTML.
 *
 * All five characters, including both quote forms: an attribute context needs `"` and `'`
 * escaped, and this helper is used in both text and attribute positions. `&` goes first, or it
 * would double-escape the entities the later replacements introduce.
 */
function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The payment state, as the document needs it. `null` means no payment has been started. */
export type InvoicePaymentState = {
  readonly status: string | null;
  readonly method: string | null;
};

/**
 * One HSN/rate-wise summary row. Structurally the invoicing module's `SummaryRow`, restated
 * here because `no-cross-module-imports` forbids reaching into that module for the type.
 */
export type InvoiceSummaryRow = {
  readonly hsnCode: string;
  readonly cgstRate: string;
  readonly sgstRate: string;
  readonly igstRate: string;
  readonly cessRate: string;
  readonly taxableValue: string;
  readonly cgstAmount: string;
  readonly sgstAmount: string;
  readonly igstAmount: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
};

/**
 * The issued statutory invoice, or `null`.
 *
 * `null` covers two genuinely different orders — one never assessed for tax, and one assessed
 * before Increment 39 existed — and both render the same way: with the order number as the
 * document reference and no statutory series. Distinguishing them on the page would require the
 * document to explain this system's release history, which is not a customer's concern.
 */
export type InvoiceDocumentRecord = {
  readonly invoiceNumber: string;
  readonly invoiceDate: string;
  readonly issuedAt: Date;
  readonly financialYear: string;
  readonly summary: {
    readonly rows: readonly InvoiceSummaryRow[];
    readonly taxableValue: string;
    readonly taxTotal: string;
  };
};

export type InvoiceInput = {
  readonly order: OrderRecord;
  readonly lines: readonly OrderLineRecord[];
  readonly payment: InvoicePaymentState;
  /**
   * The issued invoice, or `null`.
   *
   * `undefined` is accepted alongside `null` so a caller that has no invoice concept — the
   * unit tests render literal records — need not spell one out. Both mean the same thing:
   * this order has no statutory number.
   */
  readonly invoice?: InvoiceDocumentRecord | null | undefined;
};

/**
 * The banner across the top of the document.
 *
 * An invoice for an unpaid order is a PROFORMA — a request for payment, not a record of one —
 * and saying so is the difference between a useful document and a misleading one. A cancelled
 * order gets its own state so nobody pays against a withdrawn order.
 */
function documentState(
  order: OrderRecord,
  payment: InvoicePaymentState,
): {
  label: string;
  tone: 'paid' | 'due' | 'void';
  note: string;
} {
  if (order.status === 'cancelled') {
    return {
      label: 'Cancelled',
      tone: 'void',
      note: 'This order was cancelled. No payment is due.',
    };
  }
  if (payment.status === 'succeeded') {
    return { label: 'Paid', tone: 'paid', note: 'Payment received in full. Thank you.' };
  }
  if (payment.status === 'pending' && payment.method === 'cod') {
    return {
      label: 'Cash on delivery',
      tone: 'due',
      note: 'Payable in cash when your order is delivered.',
    };
  }
  if (payment.status === 'pending') {
    return {
      label: 'Payment pending',
      tone: 'due',
      note: 'A payment for this order is in progress.',
    };
  }
  if (payment.status === 'failed' || payment.status === 'expired') {
    return {
      label: 'Payment failed',
      tone: 'due',
      note: 'The last payment attempt did not complete. Please try again.',
    };
  }
  return { label: 'Proforma', tone: 'due', note: 'This is a proforma invoice. Payment is due.' };
}

/**
 * The currency, as `money.ts` understands it.
 *
 * A stored currency this build does not know is an operator error rather than a business
 * outcome, exactly as it is on the payment path — so it raises rather than silently rendering
 * an unformatted number.
 */
function requireCurrency(value: string): Currency {
  if (!isCurrency(value)) {
    throw new InvariantViolation(`order currency ${value} is not a supported currency`);
  }
  return value;
}

/** The storage-scale spelling of nothing, for the "did this component apply?" test. */
const ZERO_AT_STORAGE_SCALE = '0.0000';

/**
 * Total one tax component across the lines.
 *
 * Through `shared/money.ts`, like every other figure on this document — the invoice is a
 * display surface, but summing four columns of `NUMERIC(19,4)` is still arithmetic and the
 * `no-money-arithmetic` rule makes doing it any other way a build failure.
 *
 * Summed from the LINES rather than read from a header column, deliberately: there is no
 * `order.cgst_total`, and adding one would be a second figure that could disagree with the
 * lines it came from. §43 made exactly this call for `discount_total` — derive the header from
 * the parts, so the two cannot drift.
 */
function sumLineAmounts(
  lines: readonly OrderLineRecord[],
  field: 'cgstAmount' | 'sgstAmount' | 'igstAmount' | 'cessAmount',
  currency: Currency,
): string {
  return toDb(
    sum(
      lines.map((line) => fromDb(line[field], currency)),
      currency,
    ),
  );
}

/**
 * `2026-09-07` → `7 September 2026`, from the STORED store-local date string.
 *
 * Deliberately parses the persisted `invoice_date` rather than re-deriving a local date from
 * `issued_at`: requirement 14 is that historical values are not derived at render time, and the
 * date printed on a statutory document is exactly the kind of value that must not shift when
 * `store.timezone` is edited years later.
 *
 * Read as a UTC calendar date, which is safe because the string has no time part — so no
 * timezone conversion can move it across a day boundary.
 */
function longDateFromIsoDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvariantViolation(`stored invoice date is not a calendar date: ${value}`);
  }
  return longDate(parsed);
}

/** `2026-09-07` → `7 September 2026`. UTC, matching every other instant in this system. */
function longDate(at: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/**
 * Render the invoice.
 *
 * Returns a complete HTML document. Self-contained by design: no external stylesheet, no font
 * CDN, no image — so it renders identically offline, prints without a network round trip, and
 * gives the response's `Content-Security-Policy` nothing it needs to allow.
 */
export function renderInvoice(input: InvoiceInput): string {
  const { order, lines, payment } = input;
  const invoice = input.invoice ?? null;
  const currency = requireCurrency(order.currency);
  const money = (amount: string): string => esc(format(fromDb(amount, currency)));
  const state = documentState(order, payment);

  /**
   * The document's identity: its title, its reference and its date.
   *
   * An invoiced order is a **Tax invoice** bearing its statutory number and the date the number
   * was allocated. Everything else keeps the pre-Increment-39 presentation — titled "Invoice",
   * referenced by order number, dated by `placed_at`.
   *
   * The reference is the one field a customer quotes to support, so it changes only when there
   * is genuinely a different identifier to quote.
   */
  const heading = invoice === null ? 'Invoice' : 'Tax invoice';
  const reference = invoice === null ? order.orderNumber : invoice.invoiceNumber;
  const documentDate =
    invoice === null ? longDate(order.placedAt) : longDateFromIsoDate(invoice.invoiceDate);

  const address = [
    order.shipRecipientName,
    order.shipLine1,
    order.shipLine2,
    order.shipLandmark,
    `${order.shipCity}, ${order.shipState} ${order.shipPostalCode}`,
    order.shipCountryCode,
  ]
    .filter((part) => part.trim().length > 0)
    .map((part) => `<div>${esc(part)}</div>`)
    .join('\n            ');

  const rows = lines
    .map((line, index) => {
      /* Net of this line's allocated share of the cart-level discount. */
      const net = fromDb(line.lineTotal, currency);
      const discount = fromDb(line.discountAmount, currency);
      const hasDiscount = discount.amount !== '0.0000';
      return `          <tr>
            <td class="num">${String(index + 1)}</td>
            <td>
              <div class="item">${esc(line.productName)}</div>
              <div class="muted">${esc(line.skuName)}</div>
              <div class="sku">${esc(line.skuCode)}${
                line.hsnCode === null ? '' : ` · HSN ${esc(line.hsnCode)}`
              }</div>
            </td>
            <td class="num">${String(line.quantity)}</td>
            <td class="num">${money(line.unitPrice)}</td>
            <td class="num">${money(net.amount)}${
              hasDiscount ? `<div class="off">− ${money(discount.amount)}</div>` : ''
            }</td>
          </tr>`;
    })
    .join('\n');

  const promotionRow =
    order.promotionCode === null
      ? ''
      : `            <tr>
              <th>Discount <span class="muted">(${esc(order.promotionCode)})</span></th>
              <td class="num off">− ${money(order.discountTotal)}</td>
            </tr>`;

  /**
   * The tax block, or nothing at all.
   *
   * Rendered ONLY when the order carries a determination. An order that was never assessed —
   * placed before Increment 38, or in a store with no GST profile — gets no tax row, no GSTIN
   * line and no supply type, which is honest: it was not taxed, as opposed to taxed at nil.
   * `ck_order_tax_snapshot` guarantees the fields below are present together, so one test
   * settles it.
   *
   * Components are shown SEPARATELY rather than as one "Tax" line, because CGST and SGST are
   * two different taxes payable to two different governments and a merged figure is not a
   * breakdown anybody can reconcile.
   */
  const assessed = order.taxAt !== null && order.supplyType !== null;

  const taxRows = !assessed
    ? ''
    : (
        [
          ['CGST', sumLineAmounts(lines, 'cgstAmount', currency)],
          ['SGST', sumLineAmounts(lines, 'sgstAmount', currency)],
          ['IGST', sumLineAmounts(lines, 'igstAmount', currency)],
          ['Cess', sumLineAmounts(lines, 'cessAmount', currency)],
        ] as const
      )
        /*
         * A component that did not apply is omitted, not shown as zero: an intra-state supply
         * has no IGST at all, and printing "IGST 0.00" invites the reader to wonder why.
         */
        .filter(([, amount]) => amount !== ZERO_AT_STORAGE_SCALE)
        .map(
          ([label, amount]) => `            <tr>
              <th>${esc(label)}</th>
              <td class="num">${money(amount)}</td>
            </tr>`,
        )
        .join('\n');

  /**
   * **The HSN-wise and rate-wise summary — approved requirement 10.**
   *
   * Rendered only when there is an issued invoice, because that is when the document claims to
   * be a tax invoice; an assessed-but-uninvoiced order shows its per-line tax and stops there.
   *
   * Every figure comes from the summary the invoicing module derived from the order's FROZEN
   * line snapshots and reconciled against the order's stored totals before the number was
   * allocated. Nothing here is recomputed, and nothing reads master data — so a rate change or
   * a reclassification cannot alter a summary printed years later.
   *
   * The rate columns show the components that apply and a dash for the ones that do not: an
   * intra-state supply has no IGST at all, and printing "0" invites the reader to wonder
   * whether it was charged and refunded.
   */
  const rate = (value: string): string => {
    const asMoney = fromDb(value === '' ? '0' : value, currency);
    return asMoney.amount === ZERO_AT_STORAGE_SCALE ? '—' : `${esc(value)}%`;
  };

  const summaryTable =
    invoice === null || invoice.summary.rows.length === 0
      ? ''
      : `
      <h2 class="section">Tax summary by HSN and rate</h2>
      <table class="summary">
        <thead>
          <tr>
            <th>HSN/SAC</th>
            <th class="num">Taxable value</th>
            <th class="num">CGST</th>
            <th class="num">SGST</th>
            <th class="num">IGST</th>
            <th class="num">Cess</th>
            <th class="num">Total tax</th>
          </tr>
        </thead>
        <tbody>
${invoice.summary.rows
  .map(
    (row) => `          <tr>
            <td class="num">${esc(row.hsnCode)}</td>
            <td class="num">${money(row.taxableValue)}</td>
            <td class="num">${rate(row.cgstRate)}<div class="muted">${money(row.cgstAmount)}</div></td>
            <td class="num">${rate(row.sgstRate)}<div class="muted">${money(row.sgstAmount)}</div></td>
            <td class="num">${rate(row.igstRate)}<div class="muted">${money(row.igstAmount)}</div></td>
            <td class="num">${rate(row.cessRate)}<div class="muted">${money(row.cessAmount)}</div></td>
            <td class="num">${money(row.taxTotal)}</td>
          </tr>`,
  )
  .join('\n')}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th class="num">${money(invoice.summary.taxableValue)}</th>
            <th class="num" colspan="4"></th>
            <th class="num">${money(invoice.summary.taxTotal)}</th>
          </tr>
        </tfoot>
      </table>`;

  const grandRow = !assessed
    ? ''
    : `            <tr class="grand">
              <th>Amount payable</th>
              <td class="num">${money(order.grandTotal)}</td>
            </tr>`;

  /**
   * The GST parties and the place of supply.
   *
   * Every value comes from the ORDER's snapshot, never from the live store or the customer's
   * current registration — that is the whole point of snapshotting them, and reading either
   * here would restate a historical invoice the next time one changed.
   *
   * The letterhead now reads the SAME snapshot — Increment 39's requirement 13 removed the
   * hardcoded company that used to sit there — so this block no longer has to explain that the
   * name at the top is not the seller. It is.
   */
  const gstBlock =
    !assessed || order.sellerGstin === null || order.sellerLegalName === null
      ? ''
      : `
        <div>
          <h2>GST</h2>
          <div class="row"><span class="muted">Seller GSTIN</span><span class="num">${esc(
            order.sellerGstin,
          )}</span></div>
          <div class="row"><span class="muted">Seller</span><span>${esc(
            order.sellerLegalName,
          )}</span></div>
          <div class="row"><span class="muted">Place of supply</span><span>${esc(
            order.placeOfSupplyState ?? '',
          )}</span></div>
          <div class="row"><span class="muted">Supply type</span><span>${esc(
            order.supplyType === 'intra_state' ? 'Intra-state' : 'Inter-state',
          )}</span></div>${
            invoice === null
              ? ''
              : `
          <div class="row"><span class="muted">Invoice number</span><span class="num">${esc(
            invoice.invoiceNumber,
          )}</span></div>
          <div class="row"><span class="muted">Financial year</span><span class="num">${esc(
            invoice.financialYear,
          )}</span></div>`
          }${
            order.customerGstin === null
              ? ''
              : `
          <div class="row"><span class="muted">Buyer GSTIN</span><span class="num">${esc(
            order.customerGstin,
          )}</span></div>`
          }
        </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(heading)} ${esc(reference)}</title>
    <style>
      :root {
        --ink: #14161a;
        --muted: #6b7280;
        --line: #e5e7eb;
        --brand: #4f46e5;
        --brand-soft: #eef2ff;
        --paid: #047857;
        --paid-soft: #ecfdf5;
        --due: #b45309;
        --due-soft: #fffbeb;
        --void: #6b7280;
        --void-soft: #f3f4f6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 40px 20px;
        background: #f6f7f9;
        color: var(--ink);
        font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .sheet {
        max-width: 820px;
        margin: 0 auto;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 14px;
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 8px 24px rgba(16, 24, 40, 0.06);
        overflow: hidden;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        padding: 32px 36px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, var(--brand-soft), #fff);
      }
      .brand { display: flex; gap: 14px; align-items: center; }
      /*
       * The company logo, an embedded PNG with a transparent background — so no tile is
       * painted behind it, and no radius is applied to artwork that already has its own shape.
       *
       * print-color-adjust: exact because browsers strip background graphics when printing to
       * save ink, and a logo printed as a grey block is worse than no logo. The -webkit- form
       * comes first for Chromium, which is what most people print from.
       *
       * NOTE: no backticks in this comment. It sits inside a JS template literal, so one would
       * end the string and the file would stop parsing.
       */
      .mark {
        width: 44px; height: 44px; flex: 0 0 44px;
        object-fit: contain;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .company { font-size: 18px; font-weight: 650; letter-spacing: -0.2px; }
      .tagline { color: var(--muted); font-size: 13px; }
      .doc { text-align: right; }
      .doc h1 {
        margin: 0 0 4px;
        font-size: 13px; font-weight: 650;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--muted);
      }
      .ref { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .badge {
        display: inline-block;
        margin-top: 10px;
        padding: 4px 11px;
        border-radius: 999px;
        font-size: 12px; font-weight: 650;
        letter-spacing: 0.02em;
      }
      .badge.paid { background: var(--paid-soft); color: var(--paid); }
      .badge.due  { background: var(--due-soft);  color: var(--due); }
      .badge.void { background: var(--void-soft); color: var(--void); }
      .meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 28px;
        padding: 28px 36px;
        border-bottom: 1px solid var(--line);
      }
      .meta h2 {
        margin: 0 0 8px;
        font-size: 11px; font-weight: 650;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--muted);
      }
      .meta .row { display: flex; justify-content: space-between; gap: 12px; }
      .meta .row + .row { margin-top: 3px; }
      table { width: 100%; border-collapse: collapse; }
      thead th {
        padding: 12px 36px;
        font-size: 11px; font-weight: 650;
        letter-spacing: 0.1em; text-transform: uppercase;
        color: var(--muted);
        text-align: left;
        background: #fafafa;
        border-bottom: 1px solid var(--line);
      }
      thead th.num, tbody td.num { text-align: right; }
      /*
       * The row-number column is right-aligned and needs a gap before the item name, or the two
       * run together as "1Classic Cotton T-Shirt". Wide enough for a three-digit order.
       */
      thead th:first-child, tbody td:first-child {
        width: 58px;
        padding-left: 36px;
        padding-right: 14px;
        text-align: right;
      }
      thead th:not(:first-child):not(:last-child) { padding-left: 0; padding-right: 0; }
      tbody td { padding: 14px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
      tbody td:first-child { color: var(--muted); font-variant-numeric: tabular-nums; }
      /* Breathing room between the item description and the numeric columns. */
      tbody td:nth-child(2) { padding-right: 24px; }
      thead th:nth-child(3), tbody td:nth-child(3) { padding-left: 8px; }
      tbody td:last-child { padding-right: 36px; }
      .item { font-weight: 600; }
      .muted { color: var(--muted); font-size: 13px; }
      .sku { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; }
      .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .off { color: var(--paid); font-size: 13px; }
      .totals { display: flex; justify-content: flex-end; padding: 22px 36px 28px; }
      .totals table { width: min(320px, 100%); }
      .totals th {
        text-align: left; font-weight: 450; color: var(--muted);
        padding: 5px 0; border: 0;
      }
      .totals td { padding: 5px 0; border: 0; }
      .totals tr.grand th, .totals tr.grand td {
        border-top: 2px solid var(--ink);
        padding-top: 12px; margin-top: 4px;
        font-size: 18px; font-weight: 700; color: var(--ink);
      }
      /* The HSN/rate-wise summary. Scrolls in its own container so a six-column table on a
         narrow screen never makes the page itself scroll sideways. */
      .section {
        margin: 0 36px 10px;
        font-size: 12px; font-weight: 600; letter-spacing: .06em;
        text-transform: uppercase; color: var(--muted);
      }
      table.summary { margin-bottom: 28px; font-size: 13px; }
      table.summary th, table.summary td { padding: 8px 12px; }
      table.summary thead th {
        font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted);
      }
      table.summary tfoot th {
        border-top: 2px solid var(--ink);
        font-weight: 700; color: var(--ink);
      }
      table.summary .muted { font-size: 12px; }
      .note {
        margin: 0 36px 28px;
        padding: 13px 16px;
        border-left: 3px solid var(--brand);
        background: var(--brand-soft);
        border-radius: 0 8px 8px 0;
        font-size: 14px;
      }
      footer {
        padding: 20px 36px 28px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 12px;
        display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      }
      .disclaimer { margin-top: 10px; font-size: 11.5px; line-height: 1.5; }
      @media print {
        body { background: #fff; padding: 0; }
        .sheet { border: 0; border-radius: 0; box-shadow: none; max-width: none; }
        header { background: #fff; }
        @page { margin: 14mm; }
      }
      @media (max-width: 640px) {
        header, .meta { flex-direction: column; grid-template-columns: 1fr; }
        .doc { text-align: left; }
      }
    </style>
  </head>
  <body>
    <main class="sheet">
      <header>
        <div class="brand">
          <img
            class="mark"
            src="${COMPANY_LOGO_DATA_URI}"
            width="44"
            height="44"
            alt=""
          />${
            order.sellerLegalName === null
              ? ''
              : `
          <div>
            <div class="company">${esc(order.sellerLegalName)}</div>${
              order.sellerGstin === null
                ? ''
                : `
            <div class="tagline">GSTIN ${esc(order.sellerGstin)}</div>`
            }
          </div>`
          }
        </div>
        <div class="doc">
          <h1>${esc(heading)}</h1>
          <div class="ref">${esc(reference)}</div>
          <span class="badge ${state.tone}">${esc(state.label)}</span>
        </div>
      </header>

      <section class="meta">
        <div>
          <h2>Billed to</h2>
          <div>
            ${address}
          </div>
        </div>
        <div>
          <h2>Details</h2>
          <div class="row"><span class="muted">${
            invoice === null ? 'Order date' : 'Invoice date'
          }</span><span>${esc(documentDate)}</span></div>
          <div class="row"><span class="muted">Order number</span><span class="num">${esc(order.orderNumber)}</span></div>
          <div class="row"><span class="muted">Order status</span><span>${esc(order.status)}</span></div>
          <div class="row"><span class="muted">Payment</span><span>${esc(
            payment.status ?? 'not started',
          )}${payment.method === null ? '' : ` · ${esc(payment.method)}`}</span></div>
          <div class="row"><span class="muted">Currency</span><span>${esc(order.currency)}</span></div>
        </div>${gstBlock}
      </section>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th class="num">Qty</th>
            <th class="num">Unit</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>

      <div class="totals">
        <table>
          <tbody>
            <tr>
              <th>Subtotal</th>
              <td class="num">${money(order.subtotal)}</td>
            </tr>
${promotionRow}
            <tr${assessed ? '' : ' class="grand"'}>
              <th>${assessed ? 'Taxable value' : 'Total'}</th>
              <td class="num">${money(order.total)}</td>
            </tr>
${taxRows}
${grandRow}
          </tbody>
        </table>
      </div>

${summaryTable}

      <p class="note">${esc(state.note)}</p>

      <footer>
        <div>${
          order.sellerLegalName === null
            ? ''
            : `
          <div>${esc(order.sellerLegalName)}</div>`
        }${
          order.originLine1 === null
            ? ''
            : `
          <div class="muted">${esc(
            [
              order.originLine1,
              order.originLine2,
              order.originCity,
              order.originState,
              order.originPostalCode,
            ]
              .filter((part) => part !== null && part.trim().length > 0)
              .join(', '),
          )}</div>`
        }
        </div>
        <div style="max-width: 46ch">
          <div class="disclaimer">
            ${
              invoice !== null
                ? 'Issued under a sequential, financial-year-scoped invoice series, with an HSN/SAC and rate-wise tax summary. **This document is not e-invoiced**: it carries no IRN, no acknowledgement number and no signed QR code, because this system is not registered with the Invoice Registration Portal.'
                : assessed
                  ? 'This document is NOT a statutory GST tax invoice. The tax shown was calculated and charged, but the document carries no invoice-series number and no HSN-wise summary.'
                  : 'This document shows the goods total only. It is not a GST tax invoice: no tax has been calculated or charged, and no GSTIN, HSN/SAC code or place of supply is stated.'
            }
            Amounts are in ${esc(order.currency)}.
          </div>
        </div>
      </footer>
    </main>
  </body>
</html>
`;
}
