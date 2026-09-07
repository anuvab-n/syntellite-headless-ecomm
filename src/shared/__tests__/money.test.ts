import { describe, expect, it } from 'vitest';

import { InvariantViolation } from '../errors.js';
import {
  add,
  allocate,
  divide,
  equals,
  format,
  fromDb,
  fromMinorUnits,
  greaterThan,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  percentOf,
  roundToMinorUnits,
  subtract,
  sum,
  toDb,
  toDto,
  toMinorUnits,
  zero,
} from '../money.js';

/**
 * These are not routine unit tests. Each one corresponds to a specific way a commerce
 * system loses money, and they are the reason `money.ts` exists at all.
 */
describe('money', () => {
  describe('exactness', () => {
    it('does not lose precision where floating point does', () => {
      // The canonical demonstration: 0.1 + 0.2 !== 0.3 in IEEE-754.
      const result = add(money('0.1', 'INR'), money('0.2', 'INR'));
      expect(result.amount).toBe('0.3000');
      expect(equals(result, money('0.3', 'INR'))).toBe(true);
    });

    it('survives a long chain of operations without drift', () => {
      // 0.01 added 100 times is exactly 1.00, not 1.0000000000000007.
      let total = zero('INR');
      for (let i = 0; i < 100; i += 1) {
        total = add(total, money('0.01', 'INR'));
      }
      expect(total.amount).toBe('1.0000');
    });

    it('stores at scale 4, matching NUMERIC(19,4)', () => {
      expect(money('10', 'INR').amount).toBe('10.0000');
      expect(money('10.5', 'INR').amount).toBe('10.5000');
    });

    it('refuses a number, because that is the bug this module prevents', () => {
      // @ts-expect-error — the signature must reject a number at compile time too.
      expect(() => money(0.1 + 0.2, 'INR')).toThrow(InvariantViolation);
    });

    it('rejects a value outside NUMERIC(19,4) rather than silently truncating', () => {
      expect(() => money('99999999999999999', 'INR')).toThrow(InvariantViolation);
    });
  });

  describe('currency safety', () => {
    it('refuses to combine two currencies', () => {
      // A bug, not a business outcome — so an InvariantViolation, never a DomainError.
      expect(() => add(money('100', 'INR'), money('100', 'USD'))).toThrow(InvariantViolation);
      expect(() => subtract(money('100', 'INR'), money('1', 'USD'))).toThrow(InvariantViolation);
      expect(() => greaterThan(money('100', 'INR'), money('1', 'USD'))).toThrow(InvariantViolation);
    });

    it('treats different currencies as unequal rather than throwing', () => {
      // `equals` is a predicate used in assertions; it must answer, not explode.
      expect(equals(money('100', 'INR'), money('100', 'USD'))).toBe(false);
    });
  });

  describe('rounding happens once, at the boundary', () => {
    it('carries full precision through a calculation', () => {
      // A 7.5% discount on 33.33 is 2.499750 — not expressible in paise. Rounding here
      // and again at the total is how invoices stop footing.
      const line = money('33.33', 'INR');
      const discount = percentOf(line, '7.5');
      expect(discount.amount).toBe('2.4998'); // stored at scale 4, HALF_UP
      const net = subtract(line, discount);
      expect(net.amount).toBe('30.8302');
      expect(roundToMinorUnits(net).amount).toBe('30.8300');
    });

    it('rounds half away from zero, as GST and every merchant spreadsheet expect', () => {
      expect(roundToMinorUnits(money('10.005', 'INR')).amount).toBe('10.0100');
      expect(roundToMinorUnits(money('10.015', 'INR')).amount).toBe('10.0200');
      // Banker's rounding would give 10.02 and 10.02 — deliberately not what we do.
    });
  });

  describe('minor units — the payment boundary', () => {
    it('converts to the integer a gateway charges', () => {
      expect(toMinorUnits(money('100.50', 'INR'))).toBe(10050);
      expect(toMinorUnits(money('0.01', 'INR'))).toBe(1);
    });

    it('rounds to minor units before converting, never truncates', () => {
      expect(toMinorUnits(money('100.499', 'INR'))).toBe(10050);
      expect(toMinorUnits(money('100.494', 'INR'))).toBe(10049);
    });

    it('round-trips a gateway amount', () => {
      expect(fromMinorUnits(10050, 'INR').amount).toBe('100.5000');
    });

    it('respects a zero-decimal currency', () => {
      expect(toMinorUnits(money('100', 'JPY'))).toBe(100);
      expect(fromMinorUnits(100, 'JPY').amount).toBe('100.0000');
    });
  });

  describe('allocate — order-level discounts that sum exactly', () => {
    it('splits an indivisible amount without losing or inventing a paisa', () => {
      // ₹100 across three equal lines is 33.3333… each. Independent rounding gives
      // 99.99 or 100.02; this must give exactly 100.00.
      const parts = allocate(money('100', 'INR'), [1, 1, 1]);
      expect(parts.map((p) => p.amount)).toEqual(['33.3400', '33.3300', '33.3300']);
      expect(sum(parts, 'INR').amount).toBe('100.0000');
    });

    it('distributes proportionally to weights', () => {
      const parts = allocate(money('100', 'INR'), [50, 30, 20]);
      expect(parts.map((p) => p.amount)).toEqual(['50.0000', '30.0000', '20.0000']);
      expect(sum(parts, 'INR').amount).toBe('100.0000');
    });

    it('sums exactly for awkward weights', () => {
      const parts = allocate(money('9.99', 'INR'), [7, 11, 13]);
      expect(sum(parts, 'INR').amount).toBe('9.9900');
    });

    it('splits evenly when every weight is zero', () => {
      // Every line free, and an order-level discount still has to land somewhere.
      const parts = allocate(money('10', 'INR'), [0, 0]);
      expect(sum(parts, 'INR').amount).toBe('10.0000');
    });

    it('handles a single weight', () => {
      expect(allocate(money('10', 'INR'), [5])[0]?.amount).toBe('10.0000');
    });

    it('rejects negative weights', () => {
      expect(() => allocate(money('10', 'INR'), [1, -1])).toThrow(InvariantViolation);
    });

    it('rejects an empty weight list', () => {
      expect(() => allocate(money('10', 'INR'), [])).toThrow(InvariantViolation);
    });

    it('allocates a negative total (a refund) exactly', () => {
      const parts = allocate(money('-100', 'INR'), [1, 1, 1]);
      expect(sum(parts, 'INR').amount).toBe('-100.0000');
    });
  });

  describe('database round trip', () => {
    it('reads a numeric column string back unchanged', () => {
      // Drizzle returns NUMERIC as a string. It must never become a JS number.
      const fromColumn = fromDb('1234.5600', 'INR');
      expect(toDb(fromColumn)).toBe('1234.5600');
    });
  });

  describe('serialisation', () => {
    it('sends a string over the wire, not a number', () => {
      const dto = toDto(money('1234.56', 'INR'));
      expect(dto).toEqual({ amount: '1234.5600', currency: 'INR' });
      // JSON.parse of a numeric 1234.56 is lossy at scale; a string is not.
      expect(typeof dto.amount).toBe('string');
    });
  });

  describe('arithmetic', () => {
    it('multiplies by a quantity', () => {
      expect(multiply(money('19.99', 'INR'), 3).amount).toBe('59.9700');
    });

    it('divides without premature rounding', () => {
      expect(divide(money('10', 'INR'), 3).amount).toBe('3.3333');
    });

    it('rejects division by zero', () => {
      expect(() => divide(money('10', 'INR'), 0)).toThrow(InvariantViolation);
    });

    it('negates and detects sign', () => {
      const negative = negate(money('10', 'INR'));
      expect(negative.amount).toBe('-10.0000');
      expect(isNegative(negative)).toBe(true);
      expect(isNegative(zero('INR'))).toBe(false);
      expect(isZero(zero('INR'))).toBe(true);
    });
  });

  describe('immutability', () => {
    it('freezes the value so no caller can mutate a shared amount', () => {
      const value = money('10', 'INR');
      expect(Object.isFrozen(value)).toBe(true);
    });
  });

  describe('formatting', () => {
    it('formats for human-facing output', () => {
      // Non-breaking spaces vary by ICU build, so assert on the digits.
      expect(format(money('1234.56', 'INR'))).toContain('1,234.56');
    });
  });
});
