import { InvariantViolation } from '../../shared/errors.js';
import {
  add,
  divide,
  equals,
  fromDb,
  isNegative,
  multiply,
  roundToStorage,
  subtract,
  toDb,
  zero,
  type Currency,
  type Money,
} from '../../shared/money.js';

/**
 * Apportioning a frozen order line to a returned quantity.
 *
 * A pure function over strings and integers. No database, no HTTP, no clock, no service — it
 * imports `shared/money` and `shared/errors` and nothing else, which is what makes the
 * accounting checkable without a container.
 *
 * ## The one input, and why nothing else is allowed to be one
 *
 * `order_line` as it was frozen at checkout. **Not** the SKU's price today, **not** the tax
 * class today, **not** a rate looked up now. A customer returning a shirt is owed what they
 * paid for it, and every one of those other sources can have moved since.
 *
 * ## Sequential returns, and the bug this design exists to prevent
 *
 * A line may be returned in instalments (approved decision 9), so this function is called more
 * than once for the same line. The obvious implementation — apportion `q / quantity` of each
 * component on every call — **over-refunds**, and silently:
 *
 * ```
 *   line total 0.05 over 2 units, returned one unit at a time
 *   naive:  round(0.05 × 1/2) = 0.03,  then round(0.05 × 1/2) = 0.03   →  0.06 refunded
 * ```
 *
 * Each call independently rounds its own half up, and the line pays out more than it was ever
 * worth. The cumulative guard on QUANTITY (decision 10) does not catch this, because the
 * quantities are legal — it is the money that is wrong.
 *
 * So the unit of calculation is not "this request's share" but **the running total**:
 *
 * ```
 *   cumulative(k) = roundToStorage(component × k / quantity)
 *   this request  = cumulative(alreadyReturned + returned) - cumulative(alreadyReturned)
 * ```
 *
 * Two consequences, both load-bearing:
 *
 *  - **The instalments sum to exactly the frozen component.** The last one ends at
 *    `cumulative(quantity)`, which is `component × quantity / quantity` — the original,
 *    unrounded and exact. Whatever the intermediate roundings did, the telescoping sum
 *    cancels them.
 *  - **No residual has to be assigned to a chosen component.** There is no tie to break and
 *    no "the difference goes to tax" rule to invent: the residual simply lands on whichever
 *    instalment the cumulative rounding boundary falls inside, which is a property of the
 *    arithmetic rather than a policy. For `0.05` over two units the shares are `0.0250` and
 *    `0.0250`; for `100.00` over three they are `33.3333`, `33.3334`, `33.3333`.
 *
 * ## Scale
 *
 * Rounding is to `STORAGE_SCALE` (4) with ROUND_HALF_UP — `roundToStorage`, the repository's
 * existing convention — not to the currency's minor unit. `order_line` is `NUMERIC(19,4)` and
 * may legitimately hold sub-paisa amounts, because `line_total = unit_price × quantity` and
 * `unit_price` has four decimals. Rounding to paise here would discard precision the source
 * row carries and break the reconciliation above. **Rounding a refund to something actually
 * payable is a payment-time concern**, and belongs to the refund aggregate in 40f, not here.
 *
 * ## The identities
 *
 * Only LEAF components are apportioned: `lineTotal`, `discountAmount`, and the four tax
 * amounts. Every aggregate is DERIVED from its own apportioned parts — `taxableValue` is
 * `lineTotal - discountAmount`, `taxTotal` is the sum of the four, `refundTotal` is their
 * sum. Apportioning an aggregate separately is what creates a residual between it and its
 * parts, so this function does not do it, and the three CHECK constraints on `return_line`
 * hold by construction rather than by correction.
 */

/**
 * The frozen `order_line` fields this calculation reads.
 *
 * Structural rather than an import of the Drizzle row type, so the module stays independent of
 * the schema and can be exercised with a literal. Every amount is a `NUMERIC(19,4)` string
 * exactly as the column holds it — never a `number`, which cannot represent 0.1.
 */
export type FrozenOrderLine = {
  readonly quantity: number;
  readonly lineTotal: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly cgstAmount: string;
  readonly sgstAmount: string;
  readonly igstAmount: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
};

/** Exactly the money columns `return_line` stores, in its own spelling. */
export type ApportionedReturnLine = {
  readonly lineTotal: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly cgstAmount: string;
  readonly sgstAmount: string;
  readonly igstAmount: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
  readonly refundTotal: string;
};

export type ApportionInput = {
  /** The frozen line. */
  readonly line: FrozenOrderLine;
  /** How many units this request returns. At least 1. */
  readonly returnedQuantity: number;
  /**
   * How many units of this line earlier NON-REJECTED returns already claimed.
   *
   * `0` for a first return. Required rather than optional: a caller that forgets it silently
   * re-apportions from the start of the line and over-refunds, which is precisely the failure
   * this parameter exists to make impossible to write by accident.
   */
  readonly alreadyReturnedQuantity: number;
  readonly currency: Currency;
};

/**
 * The running total apportioned to the first `k` units of a component.
 *
 * `k = 0` is zero and `k = quantity` is the component itself, exactly — the two anchors that
 * make the instalments telescope.
 */
function cumulative(component: Money, k: number, quantity: number, currency: Currency): Money {
  if (k === 0) return zero(currency);
  if (k === quantity) return component;
  return roundToStorage(divide(multiply(component, k), quantity));
}

/** This request's share of one component: the difference between two running totals. */
function instalment(
  component: Money,
  alreadyReturned: number,
  returned: number,
  quantity: number,
  currency: Currency,
): Money {
  return subtract(
    cumulative(component, alreadyReturned + returned, quantity, currency),
    cumulative(component, alreadyReturned, quantity, currency),
  );
}

/**
 * Apportion a frozen order line to this request's units.
 *
 * @throws InvariantViolation when the quantities are not whole numbers, when they fall outside
 * `[1, quantity]` once the already-returned units are counted, or when a monetary input is
 * negative. These are programming errors, not customer errors: the service layer decides what
 * a customer may return and turns a refusal into a `422` long before this is called. Reaching
 * here with a bad quantity means a guard is missing, and a silent clamp would turn that into a
 * wrong refund nobody notices.
 */
export function apportionReturnLine(input: ApportionInput): ApportionedReturnLine {
  const { line, returnedQuantity, alreadyReturnedQuantity, currency } = input;

  /* ── Quantities ───────────────────────────────────────────────────────── */

  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new InvariantViolation(
      `order line quantity must be a positive whole number, received ${String(line.quantity)}`,
    );
  }
  if (!Number.isInteger(returnedQuantity)) {
    throw new InvariantViolation(
      `returned quantity must be a whole number, received ${String(returnedQuantity)}`,
    );
  }
  if (!Number.isInteger(alreadyReturnedQuantity) || alreadyReturnedQuantity < 0) {
    throw new InvariantViolation(
      `already-returned quantity must be a whole number of at least 0, received ${String(alreadyReturnedQuantity)}`,
    );
  }
  if (returnedQuantity < 1) {
    throw new InvariantViolation(
      `returned quantity must be at least 1, received ${String(returnedQuantity)}`,
    );
  }
  if (alreadyReturnedQuantity + returnedQuantity > line.quantity) {
    throw new InvariantViolation(
      `returned quantity ${String(returnedQuantity)} plus ${String(alreadyReturnedQuantity)} already returned exceeds the order line quantity ${String(line.quantity)}`,
    );
  }

  /* ── Money ────────────────────────────────────────────────────────────── */

  const components = {
    lineTotal: fromDb(line.lineTotal, currency),
    discountAmount: fromDb(line.discountAmount, currency),
    cgstAmount: fromDb(line.cgstAmount, currency),
    sgstAmount: fromDb(line.sgstAmount, currency),
    igstAmount: fromDb(line.igstAmount, currency),
    cessAmount: fromDb(line.cessAmount, currency),
  };

  /*
   * A negative frozen amount is a corrupt row, not a refund of a negative sum. Checked rather
   * than trusted, because it would otherwise propagate silently into the refund.
   */
  for (const [name, value] of Object.entries(components)) {
    if (isNegative(value)) {
      throw new InvariantViolation(`order line ${name} must not be negative`);
    }
  }
  for (const name of ['taxableValue', 'taxTotal'] as const) {
    if (isNegative(fromDb(line[name], currency))) {
      throw new InvariantViolation(`order line ${name} must not be negative`);
    }
  }

  /*
   * The whole-line fast path — a first return of every unit.
   *
   * Byte-for-byte reproduction, unconditionally. The general path below agrees for any row
   * satisfying its own CHECK constraints, because `cumulative(quantity)` is the component
   * itself; this makes the guarantee hold even for a row whose stored aggregate disagrees with
   * its parts, and states the intent where a reader will look for it.
   */
  if (alreadyReturnedQuantity === 0 && returnedQuantity === line.quantity) {
    return {
      lineTotal: line.lineTotal,
      discountAmount: line.discountAmount,
      taxableValue: line.taxableValue,
      cgstAmount: line.cgstAmount,
      sgstAmount: line.sgstAmount,
      igstAmount: line.igstAmount,
      cessAmount: line.cessAmount,
      taxTotal: line.taxTotal,
      refundTotal: toDb(add(fromDb(line.taxableValue, currency), fromDb(line.taxTotal, currency))),
    };
  }

  const share = (component: Money): Money =>
    instalment(component, alreadyReturnedQuantity, returnedQuantity, line.quantity, currency);

  /* Leaf components: apportioned as a difference of running totals. */
  const lineTotal = share(components.lineTotal);
  const discountAmount = share(components.discountAmount);
  const cgstAmount = share(components.cgstAmount);
  const sgstAmount = share(components.sgstAmount);
  const igstAmount = share(components.igstAmount);
  const cessAmount = share(components.cessAmount);

  /* Aggregates: derived, so each identity holds by construction. */
  const taxableValue = subtract(lineTotal, discountAmount);
  const taxTotal = add(add(cgstAmount, sgstAmount), add(igstAmount, cessAmount));
  const refundTotal = add(taxableValue, taxTotal);

  /*
   * A discount larger than the gross it discounts would make the taxable value negative, and
   * `ck_return_line_discount_within_line` would reject the row anyway. Failing here names the
   * cause; failing at the INSERT names a constraint.
   */
  if (isNegative(taxableValue)) {
    throw new InvariantViolation(
      'apportioned discount exceeds the apportioned line total, which would make the taxable value negative',
    );
  }

  /*
   * The identities, re-asserted rather than assumed.
   *
   * They hold by construction three lines above, so this can only fire if someone later
   * rewrites the derivation into independent apportionment — which is exactly the regression
   * worth catching here rather than at an INSERT that names only a constraint.
   */
  const holds =
    equals(taxableValue, subtract(lineTotal, discountAmount)) &&
    equals(taxTotal, add(add(cgstAmount, sgstAmount), add(igstAmount, cessAmount))) &&
    equals(refundTotal, add(taxableValue, taxTotal));
  if (!holds) {
    throw new InvariantViolation('apportioned return line does not satisfy its own identities');
  }

  return {
    lineTotal: toDb(lineTotal),
    discountAmount: toDb(discountAmount),
    taxableValue: toDb(taxableValue),
    cgstAmount: toDb(cgstAmount),
    sgstAmount: toDb(sgstAmount),
    igstAmount: toDb(igstAmount),
    cessAmount: toDb(cessAmount),
    taxTotal: toDb(taxTotal),
    refundTotal: toDb(refundTotal),
  };
}
