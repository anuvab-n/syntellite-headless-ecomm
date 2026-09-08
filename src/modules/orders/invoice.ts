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
 * ## What this document is NOT
 *
 * **Still NOT a statutory GST tax invoice, even now that tax is computed.**
 *
 * Increment 38 gave the order a real determination — rates, per-line CGST/SGST/IGST, HSN codes,
 * place of supply, both parties' GSTIN — and this document now SHOWS them, because withholding
 * figures the customer has actually been charged would make it misleading in the other
 * direction. What it does not do is claim compliance.
 *
 * Three things a statutory invoice needs that this still has none of, and each is Increment 39:
 *
 *  1. **An invoice number.** A tax-compliant series is sequential, gapless and scoped to a
 *     financial year; choosing that scheme is a decision with legal consequences. The order
 *     number is used as the document reference instead — unique per store and immutable, but
 *     not a series.
 *  2. **An HSN-wise and rate-wise summary**, and the several other prescribed particulars.
 *  3. **IRN and QR**, where e-invoicing applies. Deferred by approved decision 18.
 *
 * So the disclaimer stays, reworded to say what is true NOW rather than deleted. A document
 * that quietly stopped disclaiming the moment it grew a tax row would be the worst possible
 * outcome of this increment, and a test asserts the wording survives.
 *
 * An order placed before this increment, or in a store with no GST profile, carries no
 * determination at all: it renders exactly as it did before, with no tax rows and no GSTIN.
 * That is not the same as showing zero — see `ck_order_tax_snapshot`.
 */

/** The issuing company. */
const COMPANY = {
  name: 'Syntellite Innovation',
  tagline: 'Engineering that ships',
  email: 'accounts@syntellite.com',
  site: 'syntellite.com',
} as const;

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

export type InvoiceInput = {
  readonly order: OrderRecord;
  readonly lines: readonly OrderLineRecord[];
  readonly payment: InvoicePaymentState;
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
  const currency = requireCurrency(order.currency);
  const money = (amount: string): string => esc(format(fromDb(amount, currency)));
  const state = documentState(order, payment);

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
   * `COMPANY` above is still the letterhead and is deliberately NOT presented as the seller of
   * record: approved decision 2 makes the STORE the seller, and this block is what names it.
   * Reconciling the letterhead with the seller identity belongs to Increment 39, alongside the
   * invoice series.
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
    <title>Invoice ${esc(order.orderNumber)} · ${esc(COMPANY.name)}</title>
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
          />
          <div>
            <div class="company">${esc(COMPANY.name)}</div>
            <div class="tagline">${esc(COMPANY.tagline)}</div>
          </div>
        </div>
        <div class="doc">
          <h1>Invoice</h1>
          <div class="ref">${esc(order.orderNumber)}</div>
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
          <div class="row"><span class="muted">Order date</span><span>${esc(longDate(order.placedAt))}</span></div>
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

      <p class="note">${esc(state.note)}</p>

      <footer>
        <div>
          <div>${esc(COMPANY.name)}</div>
          <div>${esc(COMPANY.email)} · ${esc(COMPANY.site)}</div>
        </div>
        <div style="max-width: 46ch">
          <div class="disclaimer">
            ${
              assessed
                ? 'This document is NOT a statutory GST tax invoice. The tax shown was calculated and charged, but the document carries no sequential invoice number, no HSN-wise summary, and no IRN or QR code.'
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
