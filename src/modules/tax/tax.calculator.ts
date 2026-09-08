import {
  add,
  fromDb,
  percentOf,
  roundToMinorUnits,
  subtract,
  sum,
  toDb,
  zero,
  type Currency,
} from '../../shared/money.js';
import {
  CUSTOMER_TAX_CATEGORIES,
  PLACE_OF_SUPPLY_BASES,
  SUPPLY_TYPES,
  type CustomerTaxCategory,
  type PlaceOfSupplyBasis,
  type SupplyType,
} from './tax.repository.js';

/**
 * GST calculation. **A pure module: no database, no HTTP, no clock, no container.**
 *
 * Everything here is a function of its arguments, which is what makes the whole determination
 * testable without starting anything — the same shape `payments.state.ts` and
 * `shipment.state.ts` chose, and the reason `tax.calculator.test.ts` needs no Docker.
 *
 * ## The one arithmetic path
 *
 * Every figure below goes through `shared/money.ts`. There is no second path, no `Number()`,
 * no float, and no local rounding helper. §42 recorded that promotions *"added no money code
 * at all"* and called that the one thing it must not do; the same discipline applies here, and
 * the `no-money-arithmetic` ESLint rule makes a lapse a build failure rather than a review
 * comment.
 *
 * ## What this module does not decide
 *
 * It does not decide rates — they arrive as arguments, read from effective-dated master data.
 * It does not decide classification — that arrives resolved. It does not decide whether tax
 * applies at all — the service does, from whether the store has a GST profile. This module
 * answers exactly one question: given a taxable value, a supply type and a set of rates, what
 * are the components.
 */

/* ── Place of supply ─────────────────────────────────────────────────────── */

/** The single basis this increment implements. Approved decision 9. */
export const DELIVERY_DESTINATION_BASIS: PlaceOfSupplyBasis = 'delivery_destination';

export { CUSTOMER_TAX_CATEGORIES, PLACE_OF_SUPPLY_BASES, SUPPLY_TYPES };
export type { CustomerTaxCategory, PlaceOfSupplyBasis, SupplyType };

/**
 * Normalise a state name for comparison.
 *
 * **This is the weakest link in the whole determination, and naming it here is deliberate.**
 *
 * `address.state` and `store.origin_state` are both free text. §43 declined to invent a GST
 * state-code catalogue — *"a GST state-code catalogue is not this increment's to invent"* —
 * and Increment 38 was told the same, so the comparison has no codes to compare and must work
 * on the strings a merchant and a customer typed.
 *
 * What normalising fixes: case, surrounding whitespace, and runs of internal whitespace. So
 * `"  karnataka "` and `"Karnataka"` compare equal, which is the overwhelmingly common case.
 *
 * What it does NOT fix, and cannot: two genuinely different spellings of one state
 * (`"Orissa"` versus `"Odisha"`), abbreviations (`"TN"`), or a misspelling. Those compare
 * UNEQUAL and produce IGST where CGST+SGST was due. That is a real limitation, it is recorded
 * in DECISIONS §47 as requiring a state catalogue to close, and it is the reason the
 * normalised value is SNAPSHOTTED onto the order — so an incorrect determination can at least
 * be found and explained after the fact rather than merely suspected.
 */
export function normaliseStateName(state: string): string {
  return state.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
}

/**
 * Where the supply was made, and under which rule.
 *
 * One rule today: the delivery destination — approved decision 9, *"For the ordinary domestic
 * goods flow, place of supply is based on the delivery destination."*
 *
 * Returned as a value carrying its own `basis` rather than as a bare string, which is the rest
 * of that decision: *"Do not hide statutory exceptions inside a generic state comparison.
 * Represent the calculation so future statutory exceptions can be added explicitly."* A future
 * exception — services, bill-to/ship-to divergence, exports — becomes a new branch here
 * returning a new basis, and every order already records which branch decided it.
 */
export type PlaceOfSupply = {
  readonly state: string;
  readonly basis: PlaceOfSupplyBasis;
};

export function resolvePlaceOfSupply(input: { destinationState: string }): PlaceOfSupply {
  return {
    state: normaliseStateName(input.destinationState),
    basis: DELIVERY_DESTINATION_BASIS,
  };
}

/**
 * Intra-state or inter-state — approved decision 10, and nothing more.
 *
 * *"supplier state == place-of-supply state => CGST + SGST; supplier state != place-of-supply
 * state => IGST."* Both sides are normalised by {@link normaliseStateName} before comparing;
 * see that function for what normalisation can and cannot repair.
 */
export function resolveSupplyType(input: {
  originState: string;
  placeOfSupply: PlaceOfSupply;
}): SupplyType {
  return normaliseStateName(input.originState) === input.placeOfSupply.state
    ? 'intra_state'
    : 'inter_state';
}

/**
 * B2B or B2C — approved decision 8, and nothing more.
 *
 * A GSTIN supplied for the transaction means B2B; its absence means B2C. The GSTIN's SHAPE was
 * already validated when it was stored, so "valid" here means "present": re-deriving validity
 * at checkout from a second, possibly different rule is how two answers to one question
 * appear.
 */
export function resolveCustomerTaxCategory(input: {
  customerGstin: string | null;
}): CustomerTaxCategory {
  return input.customerGstin === null ? 'b2c' : 'b2b';
}

/* ── Rates ───────────────────────────────────────────────────────────────── */

/**
 * One resolved rate set, as this module consumes it.
 *
 * Percentages as decimal STRINGS, straight from `NUMERIC(9,6)`. Never parsed into a `number`:
 * `money.ts` rule 2 says a numeric column stays a string, and `percentOf` accepts one.
 */
export type ResolvedRates = {
  readonly cgstRate: string;
  readonly sgstRate: string;
  readonly igstRate: string;
  readonly cessRate: string;
};

/* ── Line tax ────────────────────────────────────────────────────────────── */

/** What one line's determination produced. Every figure a decimal string at storage scale. */
export type LineTax = {
  readonly taxableValue: string;
  readonly cgstRate: string;
  readonly cgstAmount: string;
  readonly sgstRate: string;
  readonly sgstAmount: string;
  readonly igstRate: string;
  readonly igstAmount: string;
  readonly cessRate: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
};

/** Zero, in the currency's own shape. Used where a rate component does not apply. */
const NIL_RATE = '0';

/**
 * Tax one line.
 *
 * ## The basis
 *
 * `taxable_value = line_total - discount_amount`, and NOTHING else. Approved decision 12 and
 * §42 both fix this, and the discount is emphatically NOT recalculated here: it arrives
 * already allocated by `allocate()` at checkout, which is the whole reason §42 introduced that
 * function. Recomputing it would produce a second answer that differs from the stored one by
 * up to half a paisa per line — exactly the drift `allocate()` exists to prevent.
 *
 * ## The split
 *
 * Intra-state applies CGST and SGST and leaves IGST at zero; inter-state does the reverse.
 * They are mutually exclusive, and `ck_order_line_tax_split` refuses a row where both appear.
 * Cess applies to either.
 *
 * ## Rounding
 *
 * **Once per component, at the currency's minor unit.** Not per line and not per invoice.
 *
 * Per-component is what makes the stored breakdown add up: `ck_order_line_tax_total` requires
 * `tax_total` to equal the sum of the four amounts exactly, so if the components were carried
 * unrounded and only the total rounded, the constraint would reject the row. Rounding each and
 * summing the rounded values makes the identity hold by construction.
 *
 * ROUND_HALF_UP, inherited from `money.ts`, whose own comment records why: *"it is what Indian
 * GST rules, invoice expectations, and every merchant's spreadsheet assume."* Approved
 * decision 13 restates it. No rounding rule is defined here — there is exactly one in the
 * codebase.
 */
export function calculateLineTax(input: {
  lineTotal: string;
  discountAmount: string;
  currency: Currency;
  supplyType: SupplyType;
  rates: ResolvedRates;
}): LineTax {
  const { currency, rates } = input;

  const taxableValue = subtract(
    fromDb(input.lineTotal, currency),
    fromDb(input.discountAmount, currency),
  );

  const intra = input.supplyType === 'intra_state';

  const cgstRate = intra ? rates.cgstRate : NIL_RATE;
  const sgstRate = intra ? rates.sgstRate : NIL_RATE;
  const igstRate = intra ? NIL_RATE : rates.igstRate;
  const { cessRate } = rates;

  const cgstAmount = roundToMinorUnits(percentOf(taxableValue, cgstRate));
  const sgstAmount = roundToMinorUnits(percentOf(taxableValue, sgstRate));
  const igstAmount = roundToMinorUnits(percentOf(taxableValue, igstRate));
  const cessAmount = roundToMinorUnits(percentOf(taxableValue, cessRate));

  const taxTotal = add(add(cgstAmount, sgstAmount), add(igstAmount, cessAmount));

  return {
    taxableValue: toDb(taxableValue),
    cgstRate,
    cgstAmount: toDb(cgstAmount),
    sgstRate,
    sgstAmount: toDb(sgstAmount),
    igstRate,
    igstAmount: toDb(igstAmount),
    cessRate,
    cessAmount: toDb(cessAmount),
    taxTotal: toDb(taxTotal),
  };
}

/**
 * The order's tax total: the sum of its lines', and nothing recomputed.
 *
 * Derived from the parts for exactly the reason §43 derives `discount_total` from the
 * allocated shares — *"an invoice whose lines do not foot to its header is precisely what §42
 * introduced `allocate()` to prevent"*. Recomputing the header from the order's taxable value
 * would produce a figure that can differ from the sum of the rounded lines, and
 * `ck_order_grand_total_identity` would then be enforcing an inconsistency.
 */
export function sumLineTax(lines: readonly LineTax[], currency: Currency): string {
  return toDb(
    sum(
      lines.map((line) => fromDb(line.taxTotal, currency)),
      currency,
    ),
  );
}

/** `grand_total = total + tax_total`, the identity `ck_order_grand_total_identity` enforces. */
export function grandTotalOf(input: {
  total: string;
  taxTotal: string;
  currency: Currency;
}): string {
  return toDb(add(fromDb(input.total, input.currency), fromDb(input.taxTotal, input.currency)));
}

/** An untaxed line: the shape a checkout produces when its store has no GST profile. */
export function untaxedLine(input: {
  lineTotal: string;
  discountAmount: string;
  currency: Currency;
}): LineTax {
  const taxableValue = subtract(
    fromDb(input.lineTotal, input.currency),
    fromDb(input.discountAmount, input.currency),
  );
  const nil = toDb(zero(input.currency));
  return {
    taxableValue: toDb(taxableValue),
    cgstRate: NIL_RATE,
    cgstAmount: nil,
    sgstRate: NIL_RATE,
    sgstAmount: nil,
    igstRate: NIL_RATE,
    igstAmount: nil,
    cessRate: NIL_RATE,
    cessAmount: nil,
    taxTotal: nil,
  };
}
