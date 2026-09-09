import { describe, expect, it } from 'vitest';

import type { Currency } from '../../../shared/money.js';
import { reconcile, summarise, type SummarisableLine } from '../invoice-summary.js';

/**
 * The HSN/rate-wise summary and its reconciliation, tested as pure functions.
 *
 * Every rate here is a FIXTURE this file invents. The application ships none — §47 records that
 * a GST percentage appears nowhere in the source — so a test that read one from the system would
 * be testing a hardcoded slab.
 */

const INR: Currency = 'INR';

/** One frozen order line. Defaults describe an intra-state 9/9 line on HSN 6109. */
const line = (over: Partial<SummarisableLine> = {}): SummarisableLine => ({
  hsnCode: '6109',
  taxClassCode: 'GST-STD',
  taxableValue: '1000.0000',
  cgstRate: '9.000000',
  cgstAmount: '90.0000',
  sgstRate: '9.000000',
  sgstAmount: '90.0000',
  igstRate: '0.000000',
  igstAmount: '0.0000',
  cessRate: '0.000000',
  cessAmount: '0.0000',
  taxTotal: '180.0000',
  ...over,
});

describe('summarise', () => {
  describe('grouping', () => {
    it('merges two lines that share the HSN and every rate', () => {
      const s = summarise([line(), line()], INR);

      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.hsnCode).toBe('6109');
      expect(s.rows[0]!.taxableValue).toBe('2000.0000');
      expect(s.rows[0]!.cgstAmount).toBe('180.0000');
      expect(s.rows[0]!.taxTotal).toBe('360.0000');
    });

    it('separates two lines with different HSN codes', () => {
      const s = summarise([line(), line({ hsnCode: '6205' })], INR);

      expect(s.rows).toHaveLength(2);
      expect(s.rows.map((r) => r.hsnCode)).toEqual(['6109', '6205']);
    });

    /**
     * **The reason the key has four rate parts and not just the HSN.**
     *
     * Two lines can legitimately share a code and carry different rates — a reclassification
     * between them, or a rate change mid-year. Grouping by HSN alone would produce a row whose
     * "rate" column is one of the two and therefore a lie about the other, which is the first
     * thing an assessing officer would query.
     */
    it('separates two lines that share an HSN but differ in rate', () => {
      const s = summarise(
        [
          line(),
          line({
            cgstRate: '2.500000',
            cgstAmount: '25.0000',
            sgstRate: '2.500000',
            sgstAmount: '25.0000',
            taxTotal: '50.0000',
          }),
        ],
        INR,
      );

      expect(s.rows).toHaveLength(2);
      expect(s.rows.map((r) => r.cgstRate).sort()).toEqual(['2.500000', '9.000000']);
    });

    it('separates intra-state from inter-state lines', () => {
      const s = summarise(
        [
          line(),
          line({
            cgstRate: '0.000000',
            cgstAmount: '0.0000',
            sgstRate: '0.000000',
            sgstAmount: '0.0000',
            igstRate: '18.000000',
            igstAmount: '180.0000',
          }),
        ],
        INR,
      );

      expect(s.rows).toHaveLength(2);
      expect(s.taxTotal).toBe('360.0000');
      expect(s.cgstAmount).toBe('90.0000');
      expect(s.igstAmount).toBe('180.0000');
    });

    it('separates lines that differ only in cess', () => {
      const s = summarise(
        [line(), line({ cessRate: '12.000000', cessAmount: '120.0000', taxTotal: '300.0000' })],
        INR,
      );

      expect(s.rows).toHaveLength(2);
      expect(s.cessAmount).toBe('120.0000');
    });
  });

  describe('ordering', () => {
    /**
     * Deterministic, because this summary is PRINTED: two renders of one invoice must produce
     * byte-identical documents, and `Map` insertion order would make the layout depend on the
     * order the rows came back from the database in.
     */
    it('orders by HSN regardless of input order', () => {
      const forwards = summarise([line({ hsnCode: '6205' }), line({ hsnCode: '6109' })], INR);
      const backwards = summarise([line({ hsnCode: '6109' }), line({ hsnCode: '6205' })], INR);

      expect(forwards.rows.map((r) => r.hsnCode)).toEqual(['6109', '6205']);
      expect(backwards.rows.map((r) => r.hsnCode)).toEqual(['6109', '6205']);
    });
  });

  describe('the unassessed case', () => {
    /**
     * A line with no classification is SKIPPED, not bucketed under a placeholder.
     *
     * `ck_order_line_tax_classification` makes the classification all-or-nothing, so
     * `hsnCode === null` is exactly "this line was never assessed" — and inventing an
     * `UNCLASSIFIED` row would print a code no catalogue contains.
     */
    it('produces no rows for lines with no classification', () => {
      const s = summarise(
        [
          line({
            hsnCode: null,
            taxClassCode: null,
            taxableValue: '1000.0000',
            cgstAmount: '0.0000',
            sgstAmount: '0.0000',
            taxTotal: '0.0000',
          }),
        ],
        INR,
      );

      expect(s.rows).toEqual([]);
      expect(s.taxableValue).toBe('0.0000');
      expect(s.taxTotal).toBe('0.0000');
    });

    it('summarises only the classified lines of a mixed set', () => {
      const s = summarise([line(), line({ hsnCode: null, taxClassCode: null })], INR);

      expect(s.rows).toHaveLength(1);
      expect(s.rows[0]!.taxableValue).toBe('1000.0000');
    });

    it('is empty for an empty line set', () => {
      const s = summarise([], INR);
      expect(s.rows).toEqual([]);
      expect(s.taxTotal).toBe('0.0000');
    });
  });

  describe('totals', () => {
    it('foots each component across every row', () => {
      const s = summarise(
        [
          line(),
          line({
            hsnCode: '6205',
            taxableValue: '500.0000',
            cgstAmount: '45.0000',
            sgstAmount: '45.0000',
            taxTotal: '90.0000',
          }),
        ],
        INR,
      );

      expect(s.taxableValue).toBe('1500.0000');
      expect(s.cgstAmount).toBe('135.0000');
      expect(s.sgstAmount).toBe('135.0000');
      expect(s.taxTotal).toBe('270.0000');
    });
  });
});

describe('reconcile', () => {
  /** Approved requirement 11: exact, and it throws rather than returning a verdict. */
  it('accepts a summary that matches the order exactly', () => {
    const summary = summarise([line()], INR);

    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.0000',
        orderTaxTotal: '180.0000',
        orderGrandTotal: '1180.0000',
        currency: INR,
      }),
    ).not.toThrow();
  });

  /**
   * Different STRING, same amount. `equals()` on `Money` rather than string comparison, because
   * a reconciliation that failed on formatting would be worse than none at all.
   */
  it('accepts figures that differ only in trailing zeros', () => {
    const summary = summarise([line()], INR);

    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.00',
        orderTaxTotal: '180.00',
        orderGrandTotal: '1180.0',
        currency: INR,
      }),
    ).not.toThrow();
  });

  it('refuses a taxable value that disagrees with order.total', () => {
    const summary = summarise([line()], INR);

    expect(() =>
      reconcile({
        summary,
        orderTotal: '999.0000',
        orderTaxTotal: '180.0000',
        orderGrandTotal: '1179.0000',
        currency: INR,
      }),
    ).toThrow(/taxable value does not equal order\.total/);
  });

  it('refuses a tax total that disagrees with order.tax_total', () => {
    const summary = summarise([line()], INR);

    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.0000',
        orderTaxTotal: '181.0000',
        orderGrandTotal: '1181.0000',
        currency: INR,
      }),
    ).toThrow(/tax total does not equal order\.tax_total/);
  });

  it('refuses a grand total that is not taxable plus tax', () => {
    const summary = summarise([line()], INR);

    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.0000',
        orderTaxTotal: '180.0000',
        orderGrandTotal: '1200.0000',
        currency: INR,
      }),
    ).toThrow(/does not equal order\.grand_total/);
  });

  /**
   * The check that would catch a future grouping change dropping a component.
   *
   * Built by hand rather than through `summarise`, because a correct summariser cannot produce
   * it — which is the point: the assertion exists for the version of the code that is wrong.
   */
  it('refuses a summary whose components do not foot to its own tax total', () => {
    const broken = {
      rows: [],
      taxableValue: '1000.0000',
      cgstAmount: '90.0000',
      sgstAmount: '0.0000',
      igstAmount: '0.0000',
      cessAmount: '0.0000',
      taxTotal: '180.0000',
    };

    expect(() =>
      reconcile({
        summary: broken,
        orderTotal: '1000.0000',
        orderTaxTotal: '180.0000',
        orderGrandTotal: '1180.0000',
        currency: INR,
      }),
    ).toThrow(/components do not foot/);
  });
});

/**
 * Mutation probes.
 *
 * Each asserts that a plausible mutation of the summariser or the reconciler would be CAUGHT:
 * the two branches produce different answers, so a test suite where they happened to agree
 * would pass on broken code.
 */
describe('mutation probes', () => {
  it('grouping by HSN alone would change the answer', () => {
    const differentRates = summarise(
      [
        line(),
        line({
          cgstRate: '2.500000',
          cgstAmount: '25.0000',
          sgstRate: '2.500000',
          sgstAmount: '25.0000',
          taxTotal: '50.0000',
        }),
      ],
      INR,
    );

    /* Two rows. A key of HSN alone would give one. */
    expect(differentRates.rows).toHaveLength(2);
  });

  it('skipping the reconciliation would change the answer', () => {
    const summary = summarise([line()], INR);

    /* The same call throws for one set of order totals and not for another. */
    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.0000',
        orderTaxTotal: '180.0000',
        orderGrandTotal: '1180.0000',
        currency: INR,
      }),
    ).not.toThrow();
    expect(() =>
      reconcile({
        summary,
        orderTotal: '1000.0000',
        orderTaxTotal: '0.0000',
        orderGrandTotal: '1000.0000',
        currency: INR,
      }),
    ).toThrow();
  });

  it('dropping unclassified lines vs bucketing them would change the answer', () => {
    const skipped = summarise([line({ hsnCode: null, taxClassCode: null })], INR);
    const kept = summarise([line()], INR);

    expect(skipped.rows).toHaveLength(0);
    expect(kept.rows).toHaveLength(1);
  });
});
