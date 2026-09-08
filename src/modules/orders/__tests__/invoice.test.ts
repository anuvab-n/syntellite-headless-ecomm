import { describe, expect, it } from 'vitest';

import { renderInvoice, type InvoiceInput } from '../invoice.js';
import type { OrderLineRecord, OrderRecord } from '../orders.repository.js';

/**
 * The invoice document.
 *
 * `renderInvoice` is a pure function of an order, so this needs no database and no HTTP — which
 * is the point: the escaping can be attacked directly rather than through a route, and the
 * money formatting can be pinned against exact strings.
 *
 * Two properties carry this file:
 *
 *  1. **Every interpolated value is escaped.** The document contains customer-chosen text —
 *     recipient name, four address lines, a landmark — and staff-typed product names. Unescaped,
 *     any of them is stored XSS, and `app.ts` disables CSP globally on the grounds that this is
 *     "a JSON API with no HTML responses", which stops being true here.
 *  2. **The money on the document is the money on the order.** Formatted for display, never
 *     recomputed.
 */
describe('invoice document', () => {
  const ORDER: OrderRecord = {
    id: '01a07bb8-f5d6-758d-9771-d27621514b82',
    orderNumber: 'ORD-20260907-7QK4M2',
    status: 'placed',
    currency: 'INR',
    subtotal: '2497.5000',
    discountTotal: '249.7500',
    total: '2247.7500',
    promotionCode: 'SAVE10',
    promotionName: 'Festive 10% off',
    shipRecipientName: 'Ada Lovelace',
    shipPhone: '+91 98765 43210',
    shipLine1: '221B Brigade Road',
    shipLine2: 'Shanthala Nagar',
    shipLandmark: 'Opposite the water tank',
    shipCity: 'Bengaluru',
    shipState: 'Karnataka',
    shipPostalCode: '560001',
    shipCountryCode: 'IN',
    placedAt: new Date('2026-09-07T10:30:00.000Z'),

    /**
     * **Deliberately UNASSESSED.** Every tax snapshot field is null and both totals are zero-
     * equivalent, which is what an order placed before Increment 38 — or in a store with no GST
     * profile — actually looks like.
     *
     * That makes this fixture the regression guard for the property that mattered most in that
     * increment: an untaxed order must render exactly as it did before. `TAXED_ORDER` below is
     * the other half.
     */
    taxTotal: '0.0000',
    grandTotal: '2247.7500',
    taxAt: null,
    supplyType: null,
    placeOfSupplyState: null,
    placeOfSupplyBasis: null,
    sellerGstin: null,
    sellerLegalName: null,
    originLine1: null,
    originLine2: null,
    originCity: null,
    originState: null,
    originPostalCode: null,
    originCountryCode: null,
    customerTaxCategory: null,
    customerGstin: null,
    customerLegalName: null,
  };

  /** The untaxed line shape: a materialised taxable value, and nothing else. */
  const untaxed = (lineTotal: string, discountAmount: string, taxableValue: string) => ({
    taxableValue,
    hsnCode: null,
    taxClassCode: null,
    taxClassName: null,
    cgstRate: '0',
    cgstAmount: '0.0000',
    sgstRate: '0',
    sgstAmount: '0.0000',
    igstRate: '0',
    igstAmount: '0.0000',
    cessRate: '0',
    cessAmount: '0.0000',
    taxTotal: '0.0000',
    lineTotal,
    discountAmount,
  });

  const LINES: readonly OrderLineRecord[] = [
    {
      skuCode: 'TS-S-BLK',
      skuName: 'Classic Cotton T-Shirt — S / Black',
      productName: 'Classic Cotton T-Shirt',
      quantity: 2,
      unitPrice: '799.0000',
      ...untaxed('1598.0000', '159.8000', '1438.2000'),
    },
    {
      skuCode: 'TS-L-WHT',
      skuName: 'Classic Cotton T-Shirt — L / White',
      productName: 'Classic Cotton T-Shirt',
      quantity: 1,
      unitPrice: '899.5000',
      ...untaxed('899.5000', '89.9500', '809.5500'),
    },
  ];

  const render = (overrides: Partial<InvoiceInput> = {}): string =>
    renderInvoice({
      order: ORDER,
      lines: LINES,
      payment: { status: 'succeeded', method: 'online' },
      ...overrides,
    });

  /* ══ The company ═══════════════════════════════════════════════════════ */

  it('is issued by Syntellite Innovation', () => {
    const html = render();
    expect(html).toContain('Syntellite Innovation');
    expect(html).toContain('accounts@syntellite.com');
    /* Appears in the title too, so a printed page and a browser tab both identify it. */
    expect(html).toContain('<title>Invoice ORD-20260907-7QK4M2 · Syntellite Innovation</title>');
  });

  it('is a complete, self-contained HTML document', () => {
    const html = render();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);

    /**
     * No external resource of any kind: no stylesheet link, no script, no remote image, no
     * font CDN. That is what lets it render offline, print without a network round trip, and
     * be served under a `default-src 'none'` policy.
     *
     * The company logo is an `<img>`, but its source is an embedded `data:` URI — which is why
     * the "no absolute URL" assertion below still holds and must keep holding.
     */
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(html).toContain('@media print');
  });

  /* ══ The company logo ══════════════════════════════════════════════════ */

  /**
   * The logo is the one binary asset in the document, and the thing most likely to rot: a
   * refactor that moved it to a URL, or a corrupted literal, would still produce a document
   * that renders — just with a hole where the brand should be.
   */
  describe('the company logo', () => {
    it('embeds the logo as a data URI, never a remote reference', () => {
      const html = render();

      expect(html).toContain('src="data:image/png;base64,');
      /* Belt and braces with the assertion above: no <img> may point at a host. */
      expect(html).not.toMatch(/<img[^>]+src="(?!data:)/i);
    });

    /**
     * Decorative, so `alt=""`. The company name sits beside it as text; a filled `alt` would
     * make a screen reader announce "Syntellite Innovation" twice.
     */
    it('marks the logo as decorative', () => {
      expect(render()).toMatch(/<img[^>]*\salt=""/);
    });

    /** A base64 PNG that actually decodes to a PNG, rather than a truncated literal. */
    it('carries a valid PNG payload', () => {
      const match = /src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(render());
      expect(match).not.toBeNull();

      const bytes = Buffer.from(match![1]!, 'base64');
      /* The 8-byte PNG signature. A corrupted or truncated literal fails here. */
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      /* Width and height from the IHDR chunk — square, and big enough to print at 44px. */
      expect(bytes.readUInt32BE(16)).toBe(192);
      expect(bytes.readUInt32BE(20)).toBe(192);
    });

    /** Printers strip background graphics by default; a logo is not decoration to be dropped. */
    it('asks printers not to drop the logo’s colour', () => {
      expect(render()).toContain('print-color-adjust: exact');
    });
  });

  /* ══ Escaping — the security boundary ══════════════════════════════════ */

  describe('escaping', () => {
    const XSS = '<script>alert(1)</script>';

    it('escapes a script tag in the recipient name', () => {
      const html = render({ order: { ...ORDER, shipRecipientName: XSS } });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    /**
     * Every customer- or staff-supplied field, one at a time.
     *
     * Swept rather than spot-checked: a per-field test proves the field somebody remembered,
     * and the whole risk here is the field somebody forgets. A new column on the document
     * without a matching `esc()` fails this.
     */
    it('escapes every free-text field on the order', () => {
      const fields: Array<keyof OrderRecord> = [
        'shipRecipientName',
        'shipLine1',
        'shipLine2',
        'shipLandmark',
        'shipCity',
        'shipState',
        'shipPostalCode',
        'shipCountryCode',
        'orderNumber',
        'status',
        'promotionCode',
      ];

      for (const field of fields) {
        const html = render({ order: { ...ORDER, [field]: XSS } });
        expect(html, field).not.toContain('<script>alert(1)</script>');
        expect(html, field).toContain('&lt;script&gt;');
      }
    });

    it('escapes every free-text field on a line', () => {
      const fields: Array<keyof OrderLineRecord> = ['skuCode', 'skuName', 'productName'];

      for (const field of fields) {
        const html = render({ lines: [{ ...LINES[0]!, [field]: XSS }] });
        expect(html, field).not.toContain('<script>alert(1)</script>');
        expect(html, field).toContain('&lt;script&gt;');
      }
    });

    /** An attribute-breaking payload. Both quote forms must be escaped, not just `<`. */
    it('escapes quotes, so an attribute cannot be broken out of', () => {
      const html = render({
        order: { ...ORDER, shipRecipientName: `" onmouseover="alert(1)` },
      });
      expect(html).not.toContain('onmouseover="alert(1)"');
      expect(html).toContain('&quot;');

      const single = render({ order: { ...ORDER, shipCity: `' onload='x` } });
      expect(single).toContain('&#39;');
    });

    /** `&` must be escaped first, or the entities introduced afterwards get double-escaped. */
    it('escapes ampersands exactly once', () => {
      const html = render({ order: { ...ORDER, shipRecipientName: 'Tom & Jerry' } });
      expect(html).toContain('Tom &amp; Jerry');
      expect(html).not.toContain('&amp;amp;');
    });

    it('escapes an img onerror payload', () => {
      const html = render({ order: { ...ORDER, shipLine1: '<img src=x onerror=alert(1)>' } });
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
  });

  /* ══ Money ═════════════════════════════════════════════════════════════ */

  describe('money', () => {
    it('shows the order totals, formatted for India', () => {
      const html = render();
      expect(html).toContain('₹2,497.50'); // subtotal
      expect(html).toContain('₹249.75'); // discount
      expect(html).toContain('₹2,247.75'); // total
    });

    it('shows each line at its unit price and line total', () => {
      const html = render();
      expect(html).toContain('₹799.00');
      expect(html).toContain('₹1,598.00');
      expect(html).toContain('₹899.50');
    });

    it('groups lakhs the Indian way', () => {
      const html = render({
        order: {
          ...ORDER,
          subtotal: '1234567.8900',
          discountTotal: '0.0000',
          total: '1234567.8900',
          promotionCode: null,
          promotionName: null,
        },
      });
      expect(html).toContain('₹12,34,567.89');
    });

    /** No discount row when there was no promotion — an empty line item reads as a bug. */
    it('omits the discount row for an undiscounted order', () => {
      const html = render({
        order: { ...ORDER, discountTotal: '0.0000', promotionCode: null, promotionName: null },
      });
      expect(html).not.toContain('Discount');
    });

    it('refuses a currency this build does not know', () => {
      expect(() => render({ order: { ...ORDER, currency: 'XYZ' } })).toThrow(/not a supported/);
    });
  });

  /* ══ The document state ════════════════════════════════════════════════ */

  describe('state banner', () => {
    it('reads Paid for a succeeded payment', () => {
      const html = render({ payment: { status: 'succeeded', method: 'online' } });
      expect(html).toContain('>Paid<');
      expect(html).toContain('Payment received in full');
    });

    /**
     * An invoice for an unpaid order is a PROFORMA, and saying so is the difference between a
     * useful document and a misleading one.
     */
    it('reads Proforma when no payment has been started', () => {
      const html = render({ payment: { status: null, method: null } });
      expect(html).toContain('>Proforma<');
      expect(html).toContain('Payment is due');
    });

    it('names cash on delivery specifically', () => {
      const html = render({ payment: { status: 'pending', method: 'cod' } });
      expect(html).toContain('>Cash on delivery<');
      expect(html).toContain('Payable in cash when your order is delivered');
    });

    it('reads Payment pending for an in-flight online payment', () => {
      const html = render({ payment: { status: 'pending', method: 'online' } });
      expect(html).toContain('>Payment pending<');
    });

    it('reads Payment failed for a failed or expired payment', () => {
      for (const status of ['failed', 'expired']) {
        const html = render({ payment: { status, method: 'online' } });
        expect(html, status).toContain('>Payment failed<');
      }
    });

    /** A cancelled order must not read as payable, whatever the payment says. */
    it('reads Cancelled for a cancelled order, overriding the payment state', () => {
      const html = render({
        order: { ...ORDER, status: 'cancelled' },
        payment: { status: 'failed', method: 'online' },
      });
      expect(html).toContain('>Cancelled<');
      expect(html).toContain('No payment is due');
      expect(html).not.toContain('>Payment failed<');
    });
  });

  /* ══ Content ═══════════════════════════════════════════════════════════ */

  describe('content', () => {
    it('shows the delivery address, skipping blank optional lines', () => {
      const html = render({ order: { ...ORDER, shipLine2: '', shipLandmark: '' } });
      expect(html).toContain('221B Brigade Road');
      expect(html).toContain('Bengaluru, Karnataka 560001');
      /* No empty divs where the optional lines were. */
      expect(html).not.toContain('<div></div>');
    });

    it('shows every line with its quantity and codes', () => {
      const html = render();
      expect(html).toContain('TS-S-BLK');
      expect(html).toContain('TS-L-WHT');
      expect(html).toContain('Classic Cotton T-Shirt — S / Black');
    });

    it('shows the order date in long form, in UTC', () => {
      const html = render();
      expect(html).toContain('7 September 2026');
    });

    it('uses the order number as the document reference', () => {
      const html = render();
      expect(html).toContain('ORD-20260907-7QK4M2');
    });

    /**
     * **It must not claim to be a tax invoice.**
     *
     * There is no tax module: no tax columns, no HSN/SAC, no place of supply, no GSTIN. A
     * document that implied compliance without them would be worse than no document, so the
     * disclaimer is asserted rather than trusted to survive an edit.
     */
    it('states plainly that it is not a GST tax invoice', () => {
      const html = render();
      expect(html).toContain('not a GST tax invoice');
      expect(html).toContain('goods total only');
      expect(html).not.toMatch(/\bGSTIN:/);
      expect(html).not.toMatch(/\bHSN\b\s*[:=]/);
      expect(html).not.toMatch(/\b(CGST|SGST|IGST)\b\s*[:=]/);
    });

    it('renders an order with a single line', () => {
      const html = render({ lines: [LINES[0]!] });
      expect(html).toContain('TS-S-BLK');
      expect(html).not.toContain('TS-L-WHT');
    });
  });
});
