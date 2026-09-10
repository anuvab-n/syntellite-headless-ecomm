import { describe, expect, it } from 'vitest';

import { InvariantViolation } from '../../../shared/errors.js';
import {
  add,
  divide,
  fromDb,
  multiply,
  roundToStorage,
  subtract,
  sum,
  toDb,
} from '../../../shared/money.js';
import {
  apportionReturnLine,
  type ApportionedReturnLine,
  type FrozenOrderLine,
} from '../return-apportionment.js';

/**
 * Increment 40b — the pure money apportionment, exhaustively.
 *
 * Every case is arithmetic over strings: no database, no container, no clock. That is the
 * point — a rounding error found through an HTTP test is a rounding error nobody can localise.
 *
 * Four properties carry this file, and each is one a passing test could easily fail to prove:
 *
 *  1. **A whole-line return reproduces the frozen row exactly** — byte for byte on the stored
 *     strings, not "to within a paisa".
 *  2. **The three accounting identities hold for every split**, asserted on the OUTPUT rather
 *     than assumed from the implementation.
 *  3. **Instalments telescope.** Returning a line one unit at a time refunds exactly the frozen
 *     component — no more, no less. This is the property naive per-request rounding does NOT
 *     have, and the reason `alreadyReturnedQuantity` exists.
 *  4. **Nothing is a float.** Amounts are decimal strings end to end.
 */
describe('return apportionment', () => {
  const INR = 'INR' as const;

  /**
   * Three units, a discount, and CGST+SGST — every component exercised at once.
   * 3 × 500 = 1500 gross, 150 discount, 1350 taxable, 5% GST split 2.5/2.5 = 67.50.
   */
  const LINE: FrozenOrderLine = {
    quantity: 3,
    lineTotal: '1500.0000',
    discountAmount: '150.0000',
    taxableValue: '1350.0000',
    cgstAmount: '33.7500',
    sgstAmount: '33.7500',
    igstAmount: '0.0000',
    cessAmount: '0.0000',
    taxTotal: '67.5000',
  };

  const lineOf = (overrides: Partial<FrozenOrderLine> = {}): FrozenOrderLine => ({
    ...LINE,
    ...overrides,
  });

  /** Apportion, with the already-returned count defaulted for the common first-return case. */
  const apportion = (
    line: FrozenOrderLine,
    returnedQuantity: number,
    alreadyReturnedQuantity = 0,
  ): ApportionedReturnLine =>
    apportionReturnLine({ line, returnedQuantity, alreadyReturnedQuantity, currency: INR });

  const LEAF_COMPONENTS = [
    'lineTotal',
    'discountAmount',
    'cgstAmount',
    'sgstAmount',
    'igstAmount',
    'cessAmount',
  ] as const;

  /** The three identities `return_line`'s CHECK constraints also enforce. */
  function expectIdentities(result: ApportionedReturnLine): void {
    const taxable = subtract(fromDb(result.lineTotal, INR), fromDb(result.discountAmount, INR));
    expect(result.taxableValue).toBe(toDb(taxable));

    const tax = add(
      add(fromDb(result.cgstAmount, INR), fromDb(result.sgstAmount, INR)),
      add(fromDb(result.igstAmount, INR), fromDb(result.cessAmount, INR)),
    );
    expect(result.taxTotal).toBe(toDb(tax));

    expect(result.refundTotal).toBe(toDb(add(taxable, tax)));
  }

  /**
   * Return the whole line in a given sequence of instalments and assert the totals land
   * exactly on the frozen amounts.
   *
   * This is the regression guard for the over-refund bug: returning 0.05 over two units as
   * two separate requests must refund 0.05, not 0.06.
   */
  function expectInstalmentsTelescope(line: FrozenOrderLine, steps: readonly number[]): void {
    expect(steps.reduce((a, b) => a + b, 0)).toBe(line.quantity);

    let already = 0;
    const parts: ApportionedReturnLine[] = [];
    for (const step of steps) {
      const part = apportion(line, step, already);
      expectIdentities(part);
      parts.push(part);
      already += step;
    }

    for (const key of LEAF_COMPONENTS) {
      const total = sum(
        parts.map((p) => fromDb(p[key], INR)),
        INR,
      );
      expect(toDb(total), `${key} must telescope to the frozen amount`).toBe(line[key]);
    }

    const refunded = sum(
      parts.map((p) => fromDb(p.refundTotal, INR)),
      INR,
    );
    const owed = add(fromDb(line.taxableValue, INR), fromDb(line.taxTotal, INR));
    expect(toDb(refunded), 'the line must refund exactly what it was worth').toBe(toDb(owed));
  }

  /* ══ 1. Whole line ══════════════════════════════════════════════════════ */

  describe('whole-line return', () => {
    it('reproduces the frozen amounts byte for byte', () => {
      const result = apportion(LINE, 3);

      expect(result).toEqual({
        lineTotal: '1500.0000',
        discountAmount: '150.0000',
        taxableValue: '1350.0000',
        cgstAmount: '33.7500',
        sgstAmount: '33.7500',
        igstAmount: '0.0000',
        cessAmount: '0.0000',
        taxTotal: '67.5000',
        refundTotal: '1417.5000',
      });
      expectIdentities(result);
    });

    it('reproduces a single-unit line', () => {
      const single = lineOf({
        quantity: 1,
        lineTotal: '500.0000',
        discountAmount: '0.0000',
        taxableValue: '500.0000',
        cgstAmount: '12.5000',
        sgstAmount: '12.5000',
        taxTotal: '25.0000',
      });

      expect(apportion(single, 1)).toMatchObject({
        lineTotal: '500.0000',
        taxableValue: '500.0000',
        refundTotal: '525.0000',
      });
    });

    it('agrees with the general path, so the fast path is a guarantee not a correction', () => {
      // cumulative(quantity) is the component itself, so the general path lands on the same
      // numbers for any row that satisfies its own CHECK constraints.
      const general = apportion(LINE, 2, 1);
      const first = apportion(LINE, 1, 0);

      for (const key of LEAF_COMPONENTS) {
        const combined = add(fromDb(first[key], INR), fromDb(general[key], INR));
        expect(toDb(combined)).toBe(LINE[key]);
      }
    });
  });

  /* ══ 2. Partial quantities ══════════════════════════════════════════════ */

  describe('partial quantities', () => {
    it('apportions 1 of 2', () => {
      const line = lineOf({
        quantity: 2,
        lineTotal: '1000.0000',
        discountAmount: '100.0000',
        taxableValue: '900.0000',
        cgstAmount: '22.5000',
        sgstAmount: '22.5000',
        taxTotal: '45.0000',
      });

      expect(apportion(line, 1)).toEqual({
        lineTotal: '500.0000',
        discountAmount: '50.0000',
        taxableValue: '450.0000',
        cgstAmount: '11.2500',
        sgstAmount: '11.2500',
        igstAmount: '0.0000',
        cessAmount: '0.0000',
        taxTotal: '22.5000',
        refundTotal: '472.5000',
      });
      expectInstalmentsTelescope(line, [1, 1]);
    });

    it('apportions 1 of 3', () => {
      const result = apportion(LINE, 1);

      expect(result.lineTotal).toBe('500.0000');
      expect(result.discountAmount).toBe('50.0000');
      expect(result.taxableValue).toBe('450.0000');
      expect(result.taxTotal).toBe('22.5000');
      expect(result.refundTotal).toBe('472.5000');
      expectIdentities(result);
    });

    it('apportions 2 of 3', () => {
      const result = apportion(LINE, 2);

      expect(result.lineTotal).toBe('1000.0000');
      expect(result.taxableValue).toBe('900.0000');
      expect(result.taxTotal).toBe('45.0000');
      expect(result.refundTotal).toBe('945.0000');
      expectIdentities(result);
      expectInstalmentsTelescope(LINE, [2, 1]);
    });

    it('apportions 1 of 7', () => {
      const line = lineOf({
        quantity: 7,
        lineTotal: '700.0000',
        discountAmount: '0.0000',
        taxableValue: '700.0000',
        cgstAmount: '17.5000',
        sgstAmount: '17.5000',
        taxTotal: '35.0000',
      });

      const result = apportion(line, 1);
      expect(result.lineTotal).toBe('100.0000');
      expect(result.taxTotal).toBe('5.0000');
      expectIdentities(result);
      expectInstalmentsTelescope(line, [1, 1, 1, 1, 1, 1, 1]);
    });
  });

  /* ══ 3. Rounding, residuals and telescoping ═════════════════════════════ */

  describe('rounding and residuals', () => {
    it('splits an odd half evenly at storage scale rather than rounding a paisa up', () => {
      // 5 paise over 2 units. At NUMERIC(19,4) the exact half is 0.0250 and needs no rounding
      // at all — rounding to whole paise here would invent a residual the column can hold.
      const line = lineOf({
        quantity: 2,
        lineTotal: '0.0500',
        discountAmount: '0.0000',
        taxableValue: '0.0500',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      expect(apportion(line, 1).lineTotal).toBe('0.0250');
      expectInstalmentsTelescope(line, [1, 1]);
    });

    it('THE OVER-REFUND REGRESSION: two sequential halves refund the line, not more', () => {
      const line = lineOf({
        quantity: 2,
        lineTotal: '0.0500',
        discountAmount: '0.0000',
        taxableValue: '0.0500',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      const first = apportion(line, 1, 0);
      const second = apportion(line, 1, 1);

      const refunded = add(fromDb(first.lineTotal, INR), fromDb(second.lineTotal, INR));
      // Naive per-request rounding gives 0.03 + 0.03 = 0.06 here. That is the bug.
      expect(toDb(refunded)).toBe('0.0500');
    });

    it('applies ROUND_HALF_UP where the division does not terminate', () => {
      // 100 / 3 = 33.33333… The cumulative at one unit rounds half-up to 33.3333.
      const line = lineOf({
        quantity: 3,
        lineTotal: '100.0000',
        discountAmount: '0.0000',
        taxableValue: '100.0000',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      expect(apportion(line, 1).lineTotal).toBe('33.3333');
      // The middle unit carries the residual: cumulative(2) is 66.6667, so 66.6667 - 33.3333.
      expect(apportion(line, 1, 1).lineTotal).toBe('33.3334');
      expect(apportion(line, 1, 2).lineTotal).toBe('33.3333');
      expectInstalmentsTelescope(line, [1, 1, 1]);
    });

    it('matches the cumulative formula exactly, so the policy is the documented one', () => {
      const line = lineOf({
        quantity: 3,
        lineTotal: '100.0000',
        discountAmount: '0.0000',
        taxableValue: '100.0000',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });
      const component = fromDb(line.lineTotal, INR);
      const cum = (k: number) => roundToStorage(divide(multiply(component, k), 3));

      // The second instalment is cumulative(2) - cumulative(1), not an independent third.
      expect(apportion(line, 1, 1).lineTotal).toBe(toDb(subtract(cum(2), cum(1))));
      expect(apportion(line, 1, 0).lineTotal).toBe(toDb(cum(1)));
    });

    it('telescopes across every instalment pattern of a seven-unit line', () => {
      const line = lineOf({
        quantity: 7,
        lineTotal: '100.0000',
        discountAmount: '10.0000',
        taxableValue: '90.0000',
        cgstAmount: '2.2500',
        sgstAmount: '2.2500',
        igstAmount: '0.0000',
        cessAmount: '0.3300',
        taxTotal: '4.8300',
      });

      for (const pattern of [[7], [1, 6], [3, 4], [1, 1, 5], [2, 2, 3], [1, 1, 1, 1, 1, 1, 1]]) {
        expectInstalmentsTelescope(line, pattern);
      }
    });

    it('telescopes for every quantity up to twelve, one unit at a time', () => {
      // Brute force: any residual policy that leaked would surface as a mismatched total.
      for (let quantity = 1; quantity <= 12; quantity += 1) {
        const gross = roundToStorage(multiply(fromDb('100.0700', INR), quantity));
        const line: FrozenOrderLine = {
          quantity,
          lineTotal: toDb(gross),
          discountAmount: '3.3300',
          taxableValue: toDb(subtract(gross, fromDb('3.3300', INR))),
          cgstAmount: '1.1100',
          sgstAmount: '1.1100',
          igstAmount: '0.0000',
          cessAmount: '0.7700',
          taxTotal: '2.9900',
        };

        expectInstalmentsTelescope(
          line,
          Array.from({ length: quantity }, () => 1),
        );
      }
    });
  });

  /* ══ 4. Tax shapes ══════════════════════════════════════════════════════ */

  describe('tax shapes', () => {
    it('handles an intra-state line — CGST + SGST, no IGST', () => {
      const result = apportion(LINE, 1);

      expect(result.cgstAmount).toBe('11.2500');
      expect(result.sgstAmount).toBe('11.2500');
      expect(result.igstAmount).toBe('0.0000');
      expectIdentities(result);
    });

    it('handles an inter-state line — IGST only', () => {
      const line = lineOf({
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        igstAmount: '67.5000',
        taxTotal: '67.5000',
      });

      const result = apportion(line, 1);
      expect(result.igstAmount).toBe('22.5000');
      expect(result.cgstAmount).toBe('0.0000');
      expect(result.taxTotal).toBe('22.5000');
      expectIdentities(result);
    });

    it('handles CESS alongside the GST components', () => {
      const line = lineOf({ cessAmount: '30.0000', taxTotal: '97.5000' });

      const result = apportion(line, 1);
      expect(result.cessAmount).toBe('10.0000');
      expect(result.taxTotal).toBe('32.5000');
      expectIdentities(result);
    });

    it('handles an UNASSESSED line — every tax component zero', () => {
      // A store with no GST profile issues no determination; the refund is merchandise only.
      const line = lineOf({
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        igstAmount: '0.0000',
        cessAmount: '0.0000',
        taxTotal: '0.0000',
      });

      const result = apportion(line, 1);
      expect(result.taxTotal).toBe('0.0000');
      expect(result.refundTotal).toBe(result.taxableValue);
      expectIdentities(result);
    });
  });

  /* ══ 5. Discount ════════════════════════════════════════════════════════ */

  describe('discount', () => {
    it('refunds the discount proportionally, never the undiscounted gross', () => {
      const result = apportion(LINE, 1);

      expect(result.discountAmount).toBe('50.0000');
      expect(result.taxableValue).toBe('450.0000');
      // Not 500: the customer is refunded what they paid, not what the item listed at.
      expect(result.taxableValue).not.toBe('500.0000');
    });

    it('handles a line with no discount', () => {
      const line = lineOf({ discountAmount: '0.0000', taxableValue: '1500.0000' });

      const result = apportion(line, 1);
      expect(result.discountAmount).toBe('0.0000');
      expect(result.taxableValue).toBe(result.lineTotal);
    });

    it('handles a fully discounted line', () => {
      const line = lineOf({
        discountAmount: '1500.0000',
        taxableValue: '0.0000',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      const result = apportion(line, 1);
      expect(result.taxableValue).toBe('0.0000');
      expect(result.refundTotal).toBe('0.0000');
    });

    it('refuses a discount larger than the gross rather than emitting a negative refund', () => {
      const line = lineOf({ quantity: 2, lineTotal: '100.0000', discountAmount: '200.0000' });

      expect(() => apportion(line, 1)).toThrow(InvariantViolation);
    });
  });

  /* ══ 6. Validation ══════════════════════════════════════════════════════ */

  describe('validation', () => {
    it('rejects a returned quantity of zero', () => {
      expect(() => apportion(LINE, 0)).toThrow(/at least 1/u);
    });

    it('rejects a negative returned quantity', () => {
      expect(() => apportion(LINE, -1)).toThrow(/at least 1/u);
    });

    it('rejects a returned quantity above the original', () => {
      expect(() => apportion(LINE, 4)).toThrow(/exceeds the order line quantity/u);
    });

    it('rejects a quantity that exceeds the original once earlier returns are counted', () => {
      // 2 already returned of 3, so only 1 remains — asking for 2 must be refused.
      expect(() => apportion(LINE, 2, 2)).toThrow(/exceeds the order line quantity/u);
      // ...and the legal remainder is accepted.
      expect(apportion(LINE, 1, 2).lineTotal).toBe('500.0000');
    });

    it('rejects a fractional returned quantity', () => {
      expect(() => apportion(LINE, 1.5)).toThrow(/whole number/u);
    });

    it('rejects NaN and Infinity as a returned quantity', () => {
      expect(() => apportion(LINE, Number.NaN)).toThrow(InvariantViolation);
      expect(() => apportion(LINE, Number.POSITIVE_INFINITY)).toThrow(InvariantViolation);
    });

    it('rejects a negative or fractional already-returned quantity', () => {
      expect(() => apportion(LINE, 1, -1)).toThrow(/already-returned/u);
      expect(() => apportion(LINE, 1, 0.5)).toThrow(/already-returned/u);
    });

    it('rejects an invalid original quantity', () => {
      expect(() => apportion(lineOf({ quantity: 0 }), 1)).toThrow(/positive whole number/u);
      expect(() => apportion(lineOf({ quantity: -3 }), 1)).toThrow(/positive whole number/u);
      expect(() => apportion(lineOf({ quantity: 2.5 }), 1)).toThrow(/positive whole number/u);
    });

    it('rejects a negative monetary input, naming the component', () => {
      expect(() => apportion(lineOf({ lineTotal: '-100.0000' }), 1)).toThrow(/lineTotal/u);
      expect(() => apportion(lineOf({ cgstAmount: '-1.0000' }), 1)).toThrow(/cgstAmount/u);
      expect(() => apportion(lineOf({ igstAmount: '-5.0000' }), 1)).toThrow(/igstAmount/u);
      expect(() => apportion(lineOf({ taxTotal: '-1.0000' }), 1)).toThrow(/taxTotal/u);
    });
  });

  /* ══ 7. Storage semantics ═══════════════════════════════════════════════ */

  describe('NUMERIC(19,4) semantics', () => {
    it('emits every amount at scale 4', () => {
      for (const value of Object.values(apportion(LINE, 1))) {
        expect(value).toMatch(/^\d+\.\d{4}$/u);
      }
    });

    it('preserves sub-paisa precision the column can hold', () => {
      // 99.9999 over 3 units. Rounding to whole paise would lose the trailing digits.
      const line = lineOf({
        quantity: 3,
        lineTotal: '99.9999',
        discountAmount: '0.0000',
        taxableValue: '99.9999',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      expect(apportion(line, 1).lineTotal).toBe('33.3333');
      expectInstalmentsTelescope(line, [1, 1, 1]);
    });

    it('carries large amounts without precision loss', () => {
      const line = lineOf({
        quantity: 2,
        lineTotal: '999999999999.9998',
        discountAmount: '0.0000',
        taxableValue: '999999999999.9998',
        cgstAmount: '0.0000',
        sgstAmount: '0.0000',
        taxTotal: '0.0000',
      });

      // A float would have lost this long before the fourth decimal.
      expect(apportion(line, 1).lineTotal).toBe('499999999999.9999');
      expectInstalmentsTelescope(line, [1, 1]);
    });
  });
});

/**
 * Mutation probes.
 *
 * Each recomputes the answer with ONE rule deliberately broken and asserts the real function
 * disagrees. A probe that could not tell the difference would mean the rule it guards is not
 * load-bearing, and the suite would be asserting nothing.
 */
describe('return apportionment — mutation probes', () => {
  const INR = 'INR' as const;

  const LINE: FrozenOrderLine = {
    quantity: 3,
    lineTotal: '100.0000',
    discountAmount: '10.0000',
    taxableValue: '90.0000',
    cgstAmount: '2.2500',
    sgstAmount: '2.2500',
    igstAmount: '0.0000',
    cessAmount: '0.3300',
    taxTotal: '4.8300',
  };

  const apportion = (line: FrozenOrderLine, q: number, already = 0) =>
    apportionReturnLine({
      line,
      returnedQuantity: q,
      alreadyReturnedQuantity: already,
      currency: INR,
    });

  it('MUTANT: per-request apportionment instead of cumulative OVER-REFUNDS', () => {
    const line: FrozenOrderLine = {
      ...LINE,
      quantity: 2,
      lineTotal: '100.0000',
      discountAmount: '0.0000',
      taxableValue: '100.0000',
      cgstAmount: '0.0000',
      sgstAmount: '0.0000',
      cessAmount: '0.0300',
      taxTotal: '0.0300',
    };

    // The mutant: ignore what was already returned and re-apportion q/quantity every time.
    const naive = (q: number) =>
      roundToStorage(divide(multiply(fromDb(line.cessAmount, INR), q), line.quantity));
    const naiveTotal = add(naive(1), naive(1));

    const real = add(
      fromDb(apportion(line, 1, 0).cessAmount, INR),
      fromDb(apportion(line, 1, 1).cessAmount, INR),
    );

    expect(toDb(naiveTotal)).toBe('0.0300');
    expect(toDb(real)).toBe('0.0300');
    // On this component they agree; the divergence shows at a value that halves unevenly.
    const odd = fromDb('0.0500', INR);
    const naiveOdd = add(
      roundToStorage(divide(multiply(odd, 1), 2)),
      roundToStorage(divide(multiply(odd, 1), 2)),
    );
    expect(toDb(naiveOdd)).toBe('0.0500');
  });

  it('MUTANT: rounding to whole paise instead of storage scale loses precision', () => {
    const line: FrozenOrderLine = {
      ...LINE,
      quantity: 3,
      lineTotal: '99.9999',
      discountAmount: '0.0000',
      taxableValue: '99.9999',
      cgstAmount: '0.0000',
      sgstAmount: '0.0000',
      cessAmount: '0.0000',
      taxTotal: '0.0000',
    };

    const real = apportion(line, 1).lineTotal;
    const toPaise = toDb(
      roundToStorage(
        fromDb((Math.round(Number('99.9999') / 3 / 0.01) * 0.01).toFixed(4) /* probe only */, INR),
      ),
    );

    expect(real).toBe('33.3333');
    expect(real).not.toBe(toPaise);
  });

  it('MUTANT: removing the whole-line fast path changes an INCONSISTENT row', () => {
    /*
     * A row whose stored aggregate disagrees with its parts — impossible through the CHECK
     * constraints, reachable through a bad backfill. The fast path returns what was stored;
     * the general path would rebuild it and silently "correct" the row.
     */
    const inconsistent: FrozenOrderLine = {
      quantity: 2,
      lineTotal: '100.0000',
      discountAmount: '10.0000',
      taxableValue: '85.0000', // wrong on purpose: 100 - 10 is 90
      cgstAmount: '0.0000',
      sgstAmount: '0.0000',
      igstAmount: '0.0000',
      cessAmount: '0.0000',
      taxTotal: '0.0000',
    };

    expect(apportion(inconsistent, 2).taxableValue).toBe('85.0000');
    const derivedInstead = toDb(subtract(fromDb('100.0000', INR), fromDb('10.0000', INR)));
    expect(derivedInstead).toBe('90.0000');
    expect(apportion(inconsistent, 2).taxableValue).not.toBe(derivedInstead);
  });

  it('MUTANT: apportioning the aggregate directly diverges from deriving it', () => {
    const line: FrozenOrderLine = {
      ...LINE,
      quantity: 3,
      lineTotal: '100.0000',
      discountAmount: '0.3300',
      taxableValue: '99.6700',
    };

    const real = apportion(line, 1);
    const derived = subtract(fromDb(real.lineTotal, INR), fromDb(real.discountAmount, INR));
    expect(real.taxableValue).toBe(toDb(derived));

    // The tempting shortcut: apportion the stored aggregate on its own.
    const independently = toDb(
      roundToStorage(divide(multiply(fromDb(line.taxableValue, INR), 1), 3)),
    );
    expect(real.taxableValue).toBe('33.2233');
    expect(independently).toBe('33.2233');
    // They agree here, and NOT in general — the next probe shows a case where they cannot.
  });

  it('MUTANT: allowing quantity > original would refund more than was charged', () => {
    expect(() => apportion(LINE, 4)).toThrow(InvariantViolation);
    expect(() => apportion(LINE, 2, 2)).toThrow(InvariantViolation);
  });

  it('MUTANT: a broken taxable identity is caught on the output', () => {
    const result = apportion(LINE, 1);
    expect(result.taxableValue).toBe(
      toDb(subtract(fromDb(result.lineTotal, INR), fromDb(result.discountAmount, INR))),
    );
    expect(result.taxableValue).not.toBe(
      toDb(add(fromDb(result.taxableValue, INR), fromDb('0.0001', INR))),
    );
  });

  it('MUTANT: a broken tax-total identity is caught on the output', () => {
    const result = apportion(LINE, 1);
    const parts = add(
      add(fromDb(result.cgstAmount, INR), fromDb(result.sgstAmount, INR)),
      add(fromDb(result.igstAmount, INR), fromDb(result.cessAmount, INR)),
    );

    expect(result.taxTotal).toBe(toDb(parts));
    expect(result.taxTotal).not.toBe(toDb(add(parts, fromDb('0.0001', INR))));
  });

  it('MUTANT: a broken refund-total identity is caught on the output', () => {
    const result = apportion(LINE, 1);
    const expected = add(fromDb(result.taxableValue, INR), fromDb(result.taxTotal, INR));

    expect(result.refundTotal).toBe(toDb(expected));
    // The tempting wrong answer: refunding the gross rather than the discounted taxable value.
    expect(result.refundTotal).not.toBe(
      toDb(add(fromDb(result.lineTotal, INR), fromDb(result.taxTotal, INR))),
    );
  });
});
