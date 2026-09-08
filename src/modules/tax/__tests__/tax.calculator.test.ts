import { describe, expect, it } from 'vitest';

import { fromDb, sum, toDb, type Currency } from '../../../shared/money.js';
import {
  calculateLineTax,
  grandTotalOf,
  normaliseStateName,
  resolveCustomerTaxCategory,
  resolvePlaceOfSupply,
  resolveSupplyType,
  sumLineTax,
  untaxedLine,
  type LineTax,
  type ResolvedRates,
} from '../tax.calculator.js';

/**
 * The GST calculation, tested as pure functions.
 *
 * No database, no container, no HTTP, no clock — the same shape as `payments.state.test.ts` and
 * `shipment.state.test.ts`. Every rate in this file is a FIXTURE this test invents for itself;
 * nothing here reads a rate from the application, because the application contains none.
 *
 * The numbers below are chosen to make rounding visible. `18%` and `9%` appear repeatedly not
 * because the system knows anything about them but because they are convenient arithmetic and
 * they are what a reader checking this file by hand will expect to be able to verify.
 */

const INR: Currency = 'INR';

/** A rate fixture. Named so it is unmistakably a test's invention rather than configuration. */
const fixtureRates = (over: Partial<ResolvedRates> = {}): ResolvedRates => ({
  cgstRate: '9',
  sgstRate: '9',
  igstRate: '18',
  cessRate: '0',
  ...over,
});

describe('place of supply', () => {
  it('is the delivery destination, and says so', () => {
    const pos = resolvePlaceOfSupply({ destinationState: 'Karnataka' });

    expect(pos.state).toBe('karnataka');
    /*
     * The basis is the whole of approved decision 9: a future statutory exception becomes a new
     * value here, and every historical order already records which rule decided it.
     */
    expect(pos.basis).toBe('delivery_destination');
  });

  describe('normalisation', () => {
    it('ignores case, surrounding space and internal runs', () => {
      expect(normaliseStateName('  TAMIL   NADU ')).toBe('tamil nadu');
      expect(normaliseStateName('Tamil Nadu')).toBe('tamil nadu');
    });

    /**
     * The limitation, asserted rather than left to be discovered.
     *
     * There is no state-code catalogue — §43 declined to invent one and Increment 38 was told
     * the same — so two genuine spellings of one state do not compare equal, and the
     * determination that follows is IGST where CGST+SGST was due. This test exists so that
     * anybody who adds a catalogue later finds the case already written down.
     */
    it('does NOT reconcile two different spellings of one state', () => {
      expect(normaliseStateName('Orissa')).not.toBe(normaliseStateName('Odisha'));
    });
  });
});

describe('supply type', () => {
  it('is intra-state when the seller and the destination share a state', () => {
    expect(
      resolveSupplyType({
        originState: 'Karnataka',
        placeOfSupply: resolvePlaceOfSupply({ destinationState: 'karnataka' }),
      }),
    ).toBe('intra_state');
  });

  it('is inter-state when they differ', () => {
    expect(
      resolveSupplyType({
        originState: 'Karnataka',
        placeOfSupply: resolvePlaceOfSupply({ destinationState: 'Maharashtra' }),
      }),
    ).toBe('inter_state');
  });

  it('compares normalised, so casing and spacing do not change the tax', () => {
    expect(
      resolveSupplyType({
        originState: '  karnataka ',
        placeOfSupply: resolvePlaceOfSupply({ destinationState: 'KARNATAKA' }),
      }),
    ).toBe('intra_state');
  });
});

describe('customer tax category', () => {
  it('is b2b when a GSTIN was supplied', () => {
    expect(resolveCustomerTaxCategory({ customerGstin: '29ABCDE1234F1Z5' })).toBe('b2b');
  });

  it('is b2c when none was', () => {
    expect(resolveCustomerTaxCategory({ customerGstin: null })).toBe('b2c');
  });
});

describe('line tax', () => {
  describe('the split', () => {
    it('charges CGST and SGST on an intra-state supply, and no IGST', () => {
      const tax = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates(),
      });

      expect(tax.cgstAmount).toBe('90.0000');
      expect(tax.sgstAmount).toBe('90.0000');
      expect(tax.igstAmount).toBe('0.0000');
      /* The RATE is zeroed too, not just the amount — `ck_order_line_tax_split` tests both. */
      expect(tax.igstRate).toBe('0');
      expect(tax.taxTotal).toBe('180.0000');
    });

    /**
     * **CGST and SGST are read from their OWN columns, not from one another.**
     *
     * Every other test in this file uses the conventional symmetric split, where cgst and sgst
     * are equal — and a mutation that read `cgstRate` for both would be invisible to all of
     * them. Nothing in this system enforces symmetry (a deliberate decision: that is an
     * accounting relationship, not a mathematical one), so an asymmetric fixture is the only
     * thing that can catch the swap.
     */
    it('reads each component from its own rate, even when they differ', () => {
      const tax = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates({ cgstRate: '6', sgstRate: '11' }),
      });

      expect(tax.cgstRate).toBe('6');
      expect(tax.sgstRate).toBe('11');
      expect(tax.cgstAmount).toBe('60.0000');
      expect(tax.sgstAmount).toBe('110.0000');
      expect(tax.taxTotal).toBe('170.0000');
    });

    it('charges IGST on an inter-state supply, and no CGST or SGST', () => {
      const tax = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'inter_state',
        rates: fixtureRates(),
      });

      expect(tax.igstAmount).toBe('180.0000');
      expect(tax.cgstAmount).toBe('0.0000');
      expect(tax.sgstAmount).toBe('0.0000');
      expect(tax.cgstRate).toBe('0');
      expect(tax.sgstRate).toBe('0');
      expect(tax.taxTotal).toBe('180.0000');
    });

    /** The invariant `ck_order_line_tax_split` enforces, asserted at the source of the values. */
    it('never produces both an intra-state and an inter-state component', () => {
      for (const supplyType of ['intra_state', 'inter_state'] as const) {
        const tax = calculateLineTax({
          lineTotal: '1234.5600',
          discountAmount: '12.3400',
          currency: INR,
          supplyType,
          rates: fixtureRates({ cessRate: '1' }),
        });

        const hasIgst = tax.igstAmount !== '0.0000' || tax.igstRate !== '0';
        const hasIntra =
          tax.cgstAmount !== '0.0000' ||
          tax.sgstAmount !== '0.0000' ||
          tax.cgstRate !== '0' ||
          tax.sgstRate !== '0';

        expect(hasIgst && hasIntra, `${supplyType} produced both halves`).toBe(false);
      }
    });
  });

  describe('the taxable basis', () => {
    /**
     * **Discount before tax.** Approved decision 12 and §42.
     *
     * The discount arrives ALREADY ALLOCATED by `allocate()` at checkout, and this asserts it
     * is subtracted rather than recomputed: taxing the undiscounted line would over-charge
     * every discounted order.
     */
    it('taxes lineTotal minus discountAmount, never lineTotal', () => {
      const tax = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '100.0000',
        currency: INR,
        supplyType: 'inter_state',
        rates: fixtureRates(),
      });

      expect(tax.taxableValue).toBe('900.0000');
      /* 18% of 900, not of 1000. */
      expect(tax.igstAmount).toBe('162.0000');
    });

    it('taxes nothing when the discount consumes the whole line', () => {
      const tax = calculateLineTax({
        lineTotal: '500.0000',
        discountAmount: '500.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates(),
      });

      expect(tax.taxableValue).toBe('0.0000');
      expect(tax.taxTotal).toBe('0.0000');
    });
  });

  describe('rounding', () => {
    /**
     * ROUND_HALF_UP, inherited from `money.ts` — whose own comment records that it is *"what
     * Indian GST rules, invoice expectations, and every merchant's spreadsheet assume"*.
     *
     * 9% of 100.05 is 9.0045, which rounds to 9.00; 9% of 100.10 is 9.009, which rounds to
     * 9.01. The second is the half-up case: 9.009 is nearer 9.01 either way, so the sharper
     * probe is below.
     */
    it('rounds each component to the minor unit, half away from zero', () => {
      const tax = calculateLineTax({
        /* 18% of 61.25 is 11.025 — exactly half a paisa, so the rule decides. */
        lineTotal: '61.2500',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'inter_state',
        rates: fixtureRates(),
      });

      expect(tax.igstAmount).toBe('11.0300');
    });

    /**
     * The INTRA-state components round too, not just IGST.
     *
     * Written separately because every other intra-state case in this file uses figures that
     * divide exactly, so removing the rounding from `cgstAmount` would change nothing they
     * assert — a mutation probe proved exactly that and this test is the answer to it.
     *
     * 9% of 61.25 is 5.5125, which must land on 5.51; unrounded it would carry four decimals
     * into a column the invoice then prints.
     */
    it('rounds the intra-state components as well', () => {
      const tax = calculateLineTax({
        lineTotal: '61.2500',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates(),
      });

      expect(tax.cgstAmount).toBe('5.5100');
      expect(tax.sgstAmount).toBe('5.5100');
      expect(tax.taxTotal).toBe('11.0200');
    });

    /**
     * Each component is rounded and THEN summed, never the reverse.
     *
     * This is what makes `ck_order_line_tax_total` satisfiable: the constraint requires
     * `tax_total` to equal the sum of the four stored amounts exactly, so carrying components
     * unrounded and rounding only the total would produce a row the database refuses.
     */
    it('sums the ROUNDED components, so the stored total matches its own parts', () => {
      const tax = calculateLineTax({
        lineTotal: '61.2500',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates({ cessRate: '1' }),
      });

      const parts = sum(
        [tax.cgstAmount, tax.sgstAmount, tax.igstAmount, tax.cessAmount].map((a) => fromDb(a, INR)),
        INR,
      );
      expect(tax.taxTotal).toBe(toDb(parts));
    });

    it('carries exact decimals rather than binary floating point', () => {
      const tax = calculateLineTax({
        lineTotal: '0.1000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'inter_state',
        /* A rate with six decimal places, the full width of NUMERIC(9,6). */
        rates: fixtureRates({ igstRate: '18.123456' }),
      });

      /* 0.1 * 18.123456 / 100 = 0.018123456 -> 0.02 at the minor unit. */
      expect(tax.igstAmount).toBe('0.0200');
    });
  });

  describe('zero and cess', () => {
    /**
     * A zero-rate class is a real configuration and is NOT the same as an unassessed order.
     *
     * The line carries a classification and a determination; only the rates are nil. The
     * distinction lives on the order header, where `tax_at` says whether an assessment
     * happened at all.
     */
    it('produces a complete, zero-valued determination for a zero-rate class', () => {
      const tax = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates({ cgstRate: '0', sgstRate: '0', igstRate: '0' }),
      });

      expect(tax.taxTotal).toBe('0.0000');
      expect(tax.taxableValue).toBe('1000.0000');
    });

    it('applies cess alongside either supply type', () => {
      const intra = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'intra_state',
        rates: fixtureRates({ cessRate: '12' }),
      });
      const inter = calculateLineTax({
        lineTotal: '1000.0000',
        discountAmount: '0.0000',
        currency: INR,
        supplyType: 'inter_state',
        rates: fixtureRates({ cessRate: '12' }),
      });

      expect(intra.cessAmount).toBe('120.0000');
      expect(inter.cessAmount).toBe('120.0000');
      expect(intra.taxTotal).toBe('300.0000');
      expect(inter.taxTotal).toBe('300.0000');
    });
  });
});

describe('order totals', () => {
  const line = (over: Partial<LineTax> = {}): LineTax => ({
    ...untaxedLine({ lineTotal: '100.0000', discountAmount: '0.0000', currency: INR }),
    ...over,
  });

  it('sums the lines rather than recomputing from the order', () => {
    expect(sumLineTax([line({ taxTotal: '12.3400' }), line({ taxTotal: '0.6600' })], INR)).toBe(
      '13.0000',
    );
  });

  it('is zero for an order with no taxed lines', () => {
    expect(sumLineTax([line(), line()], INR)).toBe('0.0000');
  });

  /** The identity `ck_order_grand_total_identity` enforces, computed the same way. */
  it('grandTotal is total plus taxTotal', () => {
    expect(grandTotalOf({ total: '2698.2000', taxTotal: '485.6800', currency: INR })).toBe(
      '3183.8800',
    );
  });

  it('grandTotal equals total when no tax was assessed', () => {
    expect(grandTotalOf({ total: '2698.2000', taxTotal: '0.0000', currency: INR })).toBe(
      '2698.2000',
    );
  });
});

describe('untaxed line', () => {
  /**
   * The shape a checkout produces when its store has no GST profile.
   *
   * `taxableValue` is still materialised, because `ck_order_line_taxable_value` is an identity
   * that holds whether or not tax was assessed. Everything else is nil, and the CLASSIFICATION
   * is absent — which is how a reader tells "not assessed" from "assessed at nil".
   */
  it('carries the taxable basis but no tax and no classification', () => {
    const tax = untaxedLine({
      lineTotal: '1000.0000',
      discountAmount: '250.0000',
      currency: INR,
    });

    expect(tax.taxableValue).toBe('750.0000');
    expect(tax.taxTotal).toBe('0.0000');
    expect(tax.cgstAmount).toBe('0.0000');
    expect(tax.sgstAmount).toBe('0.0000');
    expect(tax.igstAmount).toBe('0.0000');
    expect(tax.cessAmount).toBe('0.0000');
  });
});

/**
 * Mutation probes.
 *
 * Each asserts that a specific plausible mutation of the calculator would be CAUGHT — the
 * branch is exercised in both directions, and the two directions produce different answers.
 * A test suite where every case happens to agree with the mutant is a suite that passes on
 * broken code, which is the failure mode these exist to rule out.
 */
describe('mutation probes', () => {
  const base = {
    lineTotal: '1000.0000',
    discountAmount: '100.0000',
    currency: INR,
    rates: fixtureRates(),
  } as const;

  it('swapping the same-state branch changes the answer', () => {
    const intra = calculateLineTax({ ...base, supplyType: 'intra_state' });
    const inter = calculateLineTax({ ...base, supplyType: 'inter_state' });

    /* Same total, different composition — so a branch flip is invisible to a total-only test. */
    expect(intra.taxTotal).toBe(inter.taxTotal);
    expect(intra.cgstAmount).not.toBe(inter.cgstAmount);
    expect(intra.igstAmount).not.toBe(inter.igstAmount);
  });

  it('ignoring the discount changes the answer', () => {
    const discounted = calculateLineTax({ ...base, supplyType: 'inter_state' });
    const undiscounted = calculateLineTax({
      ...base,
      discountAmount: '0.0000',
      supplyType: 'inter_state',
    });

    expect(discounted.igstAmount).not.toBe(undiscounted.igstAmount);
  });

  it('applying the wrong rate component changes the answer', () => {
    const correct = calculateLineTax({ ...base, supplyType: 'intra_state' });
    const swapped = calculateLineTax({
      ...base,
      supplyType: 'intra_state',
      rates: fixtureRates({ cgstRate: '18' }),
    });

    expect(correct.cgstAmount).not.toBe(swapped.cgstAmount);
  });

  it('rounding down instead of half-up changes the answer', () => {
    /* 18% of 61.25 = 11.025. Half-up gives 11.03; truncation would give 11.02. */
    const tax = calculateLineTax({
      lineTotal: '61.2500',
      discountAmount: '0.0000',
      currency: INR,
      supplyType: 'inter_state',
      rates: fixtureRates(),
    });

    expect(tax.igstAmount).toBe('11.0300');
    expect(tax.igstAmount).not.toBe('11.0200');
  });

  it('dropping the tax from grandTotal changes the answer', () => {
    expect(grandTotalOf({ total: '100.0000', taxTotal: '18.0000', currency: INR })).not.toBe(
      '100.0000',
    );
  });
});
