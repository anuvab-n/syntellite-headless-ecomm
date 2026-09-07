import { Decimal } from 'decimal.js';

import { InvariantViolation, invariant } from './errors.js';

/**
 * Money.
 *
 * JavaScript has no exact decimal type. `0.1 + 0.2 !== 0.3`, and at scale that becomes
 * invoices that do not foot and settlements that do not reconcile. This module is the
 * ONLY place in the codebase permitted to do arithmetic on monetary values.
 *
 * The rules, in order of importance:
 *
 *  1. `Money` is a branded type. You cannot construct one by writing an object literal,
 *     and `+`, `-`, `*` do not compile against it. An ESLint rule (`no-money-arithmetic`)
 *     catches the cases the type system cannot.
 *  2. The canonical representation is a STRING at scale 4, matching `NUMERIC(19,4)` in
 *     PostgreSQL. Drizzle returns `numeric` columns as strings for exactly this reason;
 *     we never let one become a JS `number`.
 *  3. Full precision is carried through a calculation; rounding happens ONCE, at the
 *     boundary — see {@link roundToStorage} and {@link roundToMinorUnits}. Rounding at
 *     each step compounds the error.
 *  4. Two `Money` values of different currencies never combine. That is an
 *     InvariantViolation (a bug), not a DomainError (a business outcome).
 */

/* ── Decimal configuration ───────────────────────────────────────────────── */

/**
 * 34 significant digits — comfortably above NUMERIC(19,4), so intermediate results in a
 * long promotion chain never lose precision before the single rounding at the end.
 *
 * ROUND_HALF_UP, not banker's rounding: it is what Indian GST rules, invoice
 * expectations, and every merchant's spreadsheet assume. Changing this changes historical
 * totals and requires an ADR.
 */
const MoneyDecimal = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30,
});

/** Scale of the `NUMERIC(19,4)` columns every monetary value is stored in. */
export const STORAGE_SCALE = 4;

/** Largest value `NUMERIC(19,4)` can hold: 15 integer digits. */
const MAX_ABS = new MoneyDecimal('999999999999999.9999');

/* ── Currency ────────────────────────────────────────────────────────────── */

/**
 * Supported currencies and their minor-unit exponent.
 *
 * The exponent matters at the payment boundary: gateways charge in minor units (paise,
 * cents), so a total of 100.4999 must be rounded to 100.50 exactly once, right before
 * the charge — never earlier.
 */
const CURRENCY_MINOR_UNITS = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  /** Zero-decimal currency — a reminder that 2 is a convention, not a law. */
  JPY: 0,
} as const;

export type Currency = keyof typeof CURRENCY_MINOR_UNITS;

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_MINOR_UNITS, value);
}

export function minorUnitExponent(currency: Currency): number {
  return CURRENCY_MINOR_UNITS[currency];
}

/* ── The branded type ────────────────────────────────────────────────────── */

declare const MoneyBrand: unique symbol;

/**
 * An exact monetary amount in a single currency.
 *
 * `amount` is the canonical decimal string at {@link STORAGE_SCALE} — safe to write
 * straight into a `NUMERIC(19,4)` column and safe to put in a JSON response without
 * precision loss. Read it; never parse it into a `number`.
 */
export type Money = {
  readonly amount: string;
  readonly currency: Currency;
  readonly [MoneyBrand]: 'Money';
};

/** Internal: attach the brand. The only construction path. */
function brand(amount: Decimal, currency: Currency): Money {
  if (!amount.isFinite()) {
    throw new InvariantViolation(`money amount is not finite: ${String(amount)}`);
  }
  if (amount.abs().greaterThan(MAX_ABS)) {
    throw new InvariantViolation(`money amount ${amount.toFixed()} exceeds NUMERIC(19,4) range`);
  }
  return Object.freeze({
    amount: amount.toFixed(STORAGE_SCALE),
    currency,
  }) as Money;
}

/** Internal: the working representation for arithmetic. */
function dec(m: Money): Decimal {
  return new MoneyDecimal(m.amount);
}

/* ── Construction ────────────────────────────────────────────────────────── */

/**
 * Build a Money from a decimal string.
 *
 * Accepts a string — not a `number` — on purpose: `money(0.1 + 0.2, 'INR')` is exactly
 * the bug this module exists to prevent, so the signature refuses it. Use
 * {@link fromMinorUnits} for integer input from a gateway.
 */
export function money(amount: string, currency: Currency): Money {
  invariant(typeof amount === 'string', 'money() takes a string, never a number');
  let parsed: Decimal;
  try {
    parsed = new MoneyDecimal(amount);
  } catch {
    throw new InvariantViolation(`not a valid decimal amount: ${amount}`);
  }
  return brand(parsed, currency);
}

export function zero(currency: Currency): Money {
  return brand(new MoneyDecimal(0), currency);
}

/** Read a `NUMERIC(19,4)` column (Drizzle gives us a string) back into a Money. */
export function fromDb(amount: string, currency: Currency): Money {
  return money(amount, currency);
}

/** Write to a `NUMERIC(19,4)` column. */
export function toDb(m: Money): string {
  return m.amount;
}

/**
 * Convert from a gateway's integer minor units (paise, cents).
 * Razorpay reports ₹100.50 as `10050`.
 */
export function fromMinorUnits(units: number | bigint, currency: Currency): Money {
  const asString = typeof units === 'bigint' ? units.toString() : String(units);
  invariant(/^-?\d+$/.test(asString), `minor units must be an integer, got ${asString}`);
  const scaled = new MoneyDecimal(asString).dividedBy(
    new MoneyDecimal(10).toPower(minorUnitExponent(currency)),
  );
  return brand(scaled, currency);
}

/**
 * Convert to a gateway's integer minor units.
 *
 * This is a ROUNDING BOUNDARY: the value is rounded to the currency's minor units first.
 * Call it once, immediately before charging — never mid-calculation.
 */
export function toMinorUnits(m: Money): number {
  const exponent = minorUnitExponent(m.currency);
  const units = dec(m)
    .toDecimalPlaces(exponent, Decimal.ROUND_HALF_UP)
    .times(new MoneyDecimal(10).toPower(exponent));
  invariant(units.isInteger(), `minor unit conversion produced a non-integer: ${units.toFixed()}`);
  // Safe: MAX_ABS * 100 is well inside Number.MAX_SAFE_INTEGER.
  return units.toNumber();
}

/* ── Guards ──────────────────────────────────────────────────────────────── */

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    // A bug, not a business outcome: nothing in the domain should ever attempt this.
    throw new InvariantViolation(
      `cannot combine ${a.currency} with ${b.currency}; convert explicitly first`,
    );
  }
}

/* ── Arithmetic ──────────────────────────────────────────────────────────── */

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return brand(dec(a).plus(dec(b)), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return brand(dec(a).minus(dec(b)), a.currency);
}

export function sum(values: readonly Money[], currency: Currency): Money {
  return values.reduce((acc, v) => add(acc, v), zero(currency));
}

/** Multiply by a dimensionless scalar — a quantity, or a percentage as a fraction. */
export function multiply(m: Money, factor: number | string): Money {
  return brand(dec(m).times(new MoneyDecimal(factor)), m.currency);
}

/**
 * Divide by a dimensionless scalar. Does NOT round — the caller decides where the
 * rounding boundary is. For splitting a total across lines without losing a paisa, use
 * {@link allocate}.
 */
export function divide(m: Money, divisor: number | string): Money {
  const d = new MoneyDecimal(divisor);
  invariant(!d.isZero(), 'division by zero');
  return brand(dec(m).dividedBy(d), m.currency);
}

export function negate(m: Money): Money {
  return brand(dec(m).negated(), m.currency);
}

export function abs(m: Money): Money {
  return brand(dec(m).abs(), m.currency);
}

/** Percentage of an amount. `percentOf(total, '18')` is 18% of total. */
export function percentOf(m: Money, percent: number | string): Money {
  return brand(dec(m).times(new MoneyDecimal(percent)).dividedBy(100), m.currency);
}

/** Clamps at zero. Useful for discounts that must not turn a total negative. */
export function clampAtZero(m: Money): Money {
  return isNegative(m) ? zero(m.currency) : m;
}

/* ── Rounding boundaries ─────────────────────────────────────────────────── */

/**
 * Round to the storage scale. Every Money is already at this scale, so this is a no-op
 * in practice and exists to make the boundary explicit at call sites that need to say
 * "the calculation ends here".
 */
export function roundToStorage(m: Money): Money {
  return brand(dec(m).toDecimalPlaces(STORAGE_SCALE, Decimal.ROUND_HALF_UP), m.currency);
}

/** Round to the currency's minor units — the customer-visible, chargeable amount. */
export function roundToMinorUnits(m: Money): Money {
  return brand(
    dec(m).toDecimalPlaces(minorUnitExponent(m.currency), Decimal.ROUND_HALF_UP),
    m.currency,
  );
}

/* ── Comparison ──────────────────────────────────────────────────────────── */

/** -1, 0, or 1. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return dec(a).comparedTo(dec(b)) as -1 | 0 | 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && dec(a).equals(dec(b));
}

export function greaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function greaterThanOrEqual(a: Money, b: Money): boolean {
  return compare(a, b) >= 0;
}

export function lessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function lessThanOrEqual(a: Money, b: Money): boolean {
  return compare(a, b) <= 0;
}

export function isZero(m: Money): boolean {
  return dec(m).isZero();
}

export function isNegative(m: Money): boolean {
  return dec(m).isNegative() && !dec(m).isZero();
}

export function isPositive(m: Money): boolean {
  return dec(m).isPositive() && !dec(m).isZero();
}

export function min(a: Money, b: Money): Money {
  return lessThanOrEqual(a, b) ? a : b;
}

export function max(a: Money, b: Money): Money {
  return greaterThanOrEqual(a, b) ? a : b;
}

/* ── Allocation ──────────────────────────────────────────────────────────── */

/**
 * Split an amount across weights so the parts sum EXACTLY back to the whole.
 *
 * This is the function that makes order-level discounts safe. A ₹100 cart discount
 * spread over three lines is 33.3333… each; rounding each independently yields 99.9999
 * or 100.0002, and the difference shows up as an invoice that does not foot or a refund
 * that overpays. Here the remainder is distributed one minor unit at a time to the
 * largest fractional parts (the "largest remainder" method), so the total is preserved.
 *
 * Also used in reverse for returns: refunding a line means refunding the discounted
 * amount that was actually allocated to it, not its list price.
 *
 * @param weights Non-negative. All-zero weights split evenly.
 * @returns One Money per weight, at the currency's minor-unit scale, summing to `total`.
 */
export function allocate(total: Money, weights: readonly (number | string)[]): Money[] {
  invariant(weights.length > 0, 'allocate() requires at least one weight');

  const decWeights = weights.map((w) => new MoneyDecimal(w));
  invariant(
    decWeights.every((w) => w.isFinite() && !w.isNegative()),
    'allocate() weights must be finite and non-negative',
  );

  const weightTotal = decWeights.reduce((acc, w) => acc.plus(w), new MoneyDecimal(0));
  // All-zero weights (e.g. every line free) split evenly rather than divide by zero.
  const effective = weightTotal.isZero() ? decWeights.map(() => new MoneyDecimal(1)) : decWeights;
  const effectiveTotal = weightTotal.isZero() ? new MoneyDecimal(decWeights.length) : weightTotal;

  const exponent = minorUnitExponent(total.currency);
  const step = new MoneyDecimal(10).toPower(-exponent);

  // Work in whole minor units so the remainder is an exact integer count.
  const totalUnits = dec(total).toDecimalPlaces(exponent, Decimal.ROUND_HALF_UP).dividedBy(step);

  const exact = effective.map((w) => totalUnits.times(w).dividedBy(effectiveTotal));
  const floored = exact.map((v) => v.floor());
  const assigned = floored.reduce((acc, v) => acc.plus(v), new MoneyDecimal(0));

  // Remainder is the count of minor units still to hand out. Non-negative by
  // construction because flooring only ever removes.
  let remainder = totalUnits.minus(assigned).toNumber();

  // Largest fractional part first; ties broken by index so the result is deterministic.
  const order = exact
    .map((v, index) => ({ index, fraction: v.minus(v.floor()) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);

  const units = [...floored];
  for (const { index } of order) {
    if (remainder <= 0) break;
    units[index] = units[index]!.plus(1);
    remainder -= 1;
  }

  const parts = units.map((u) => brand(u.times(step), total.currency));

  // Cheap, and it has caught real bugs during refactors of this function.
  invariant(
    equals(sum(parts, total.currency), roundToMinorUnits(total)),
    'allocate() parts do not sum to the total',
  );
  return parts;
}

/* ── Presentation ────────────────────────────────────────────────────────── */

/**
 * Human-readable string for emails, invoices, and admin views.
 * Not for API responses — those carry `{ amount, currency }` so the client formats it.
 */
export function format(m: Money, locale = 'en-IN'): string {
  /**
   * The one place a float conversion is correct, and the only `no-money-arithmetic` exemption
   * in the codebase.
   *
   * `Intl.NumberFormat.format` takes a `number`; there is no exact-decimal formatter in the
   * platform. Rounding to minor units FIRST is what makes the conversion safe rather than
   * merely unavoidable: the value handed to `Number()` has at most two decimal places, so it
   * is exactly representable as a double for any realistic amount, and nothing downstream
   * consumes the result — this returns a display string, never a value to compute with.
   */
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: minorUnitExponent(m.currency),
    /**
     * Kept INLINE rather than extracted to a `const`. Assigning `roundToMinorUnits(m).amount`
     * to a local would launder the type to a plain `string` and silence the rule with no
     * disable comment at all — dodging the guard instead of documenting the exception. The
     * explicit disable is the point: it is auditable, and it will fail loudly if the rule is
     * ever removed.
     */
    // eslint-disable-next-line local/no-money-arithmetic -- display boundary; see above.
  }).format(Number(roundToMinorUnits(m).amount));
}

/** The API wire shape. `amount` stays a string — see rule 2 at the top of this file. */
export type MoneyDto = { amount: string; currency: Currency };

export function toDto(m: Money): MoneyDto {
  return { amount: roundToMinorUnits(m).amount, currency: m.currency };
}
