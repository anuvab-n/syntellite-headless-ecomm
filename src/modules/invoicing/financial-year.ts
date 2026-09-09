import { InvariantViolation } from '../../shared/errors.js';

/**
 * The Indian financial year, and the invoice number built on it.
 *
 * **A pure module: no database, no clock, no HTTP.** Every function is a function of its
 * arguments, which is what lets the April-1 and March-31 boundaries be tested exactly rather
 * than approximately — the same shape `tax.calculator.ts`, `payments.state.ts` and
 * `shipment.state.ts` all take.
 *
 * ## The year runs 1 April to 31 March, in the STORE's timezone
 *
 * Approved requirement 5. The timezone matters more than it looks: an order placed at
 * 2027-04-01T00:30:00+05:30 is 2027-03-31T19:00:00Z, so computing the year in UTC would file it
 * under the year that ended half an hour earlier — a misfiled invoice in the wrong series, and
 * the kind of error that is only ever discovered by a tax audit.
 *
 * `store.timezone` is an IANA name (`Asia/Kolkata`), not an offset, because offsets are wrong
 * twice a year — `store.ts` recorded that when the column was created.
 */

/** 1-based month in which a financial year opens. April. */
const FY_START_MONTH = 4;

/** `INV/YYYY-YY/NNNNNN` — approved requirement 6, and the format is exact. */
const NUMBER_PREFIX = 'INV';
const SEQUENCE_WIDTH = 6;

/**
 * The store-local calendar date of an instant, as `{ year, month, day }`.
 *
 * `Intl.DateTimeFormat.formatToParts` with an explicit `timeZone`, rather than any arithmetic on
 * the `Date` itself. Two reasons, and both are correctness rather than taste: the platform's own
 * IANA database handles every historical offset change and DST rule, and `formatToParts` returns
 * the fields separately so nothing has to parse a formatted string back apart.
 *
 * `en-CA` would give an ISO-shaped string, but the parts are read individually here so the
 * locale is irrelevant and `en-US` is used to make that obvious.
 *
 * A bad timezone is an OPERATOR error — `store.timezone` is configuration — so it raises an
 * `InvariantViolation` (a 500) rather than a business error, exactly as an unsupported currency
 * does everywhere else in this codebase.
 */
export function localCalendarDate(
  at: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
  } catch {
    throw new InvariantViolation(`store timezone ${timeZone} is not a valid IANA time zone`);
  }

  const find = (type: Intl.DateTimeFormatPartTypes): number => {
    const raw = parts.find((p) => p.type === type)?.value;
    if (raw === undefined) {
      throw new InvariantViolation(`could not read ${type} for time zone ${timeZone}`);
    }
    /*
     * `Number` rather than `parseInt`: the parts are already `2-digit`/`numeric` strings with no
     * suffix, and `Number` refuses anything else instead of silently taking a prefix. Not money,
     * so `no-money-arithmetic` does not reach here.
     */
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new InvariantViolation(`unexpected ${type} value ${raw} for time zone ${timeZone}`);
    }
    return value;
  };

  return { year: find('year'), month: find('month'), day: find('day') };
}

/** The store-local date as `YYYY-MM-DD` — the string an invoice prints and stores. */
export function localDateString(at: Date, timeZone: string): string {
  const { year, month, day } = localCalendarDate(at, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The financial year an instant falls in, as `YYYY-YY`.
 *
 * April to December belong to the year that just opened; January to March belong to the one that
 * opened the previous April. So:
 *
 * | Store-local instant | Financial year |
 * | ------------------- | -------------- |
 * | 2026-03-31 23:59    | `2025-26`      |
 * | 2026-04-01 00:00    | `2026-27`      |
 * | 2026-12-31          | `2026-27`      |
 * | 2027-03-31 23:59    | `2026-27`      |
 * | 2027-04-01 00:00    | `2027-28`      |
 *
 * The second half of the label is the closing year modulo 100, zero-padded — so `2099-00` for
 * the year that closes in 2100. That is the convention the label follows rather than a special
 * case, and a test pins it so nobody "fixes" it into `2099-100`.
 */
export function financialYearOf(at: Date, timeZone: string): string {
  const { year, month } = localCalendarDate(at, timeZone);
  const opensIn = month >= FY_START_MONTH ? year : year - 1;
  const closesIn = opensIn + 1;
  return `${String(opensIn).padStart(4, '0')}-${String(closesIn % 100).padStart(2, '0')}`;
}

/**
 * Assemble an invoice number. `INV/2026-27/000001`.
 *
 * The one place the format exists. `ck_invoice_number_matches_parts` re-derives the same string
 * in SQL and refuses a row where the two disagree, so a change here that was not mirrored there
 * fails at the database rather than on a printed document.
 */
export function formatInvoiceNumber(financialYear: string, sequenceNumber: number): string {
  if (!/^\d{4}-\d{2}$/u.test(financialYear)) {
    throw new InvariantViolation(`malformed financial year: ${financialYear}`);
  }
  if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1) {
    throw new InvariantViolation(
      `invoice sequence must be a positive integer: ${String(sequenceNumber)}`,
    );
  }
  if (String(sequenceNumber).length > SEQUENCE_WIDTH) {
    /*
     * Refused rather than widened. A number wider than the format would break
     * `ck_invoice_number_matches_parts` on insert anyway; failing here says why.
     */
    throw new InvariantViolation(
      `invoice sequence ${String(sequenceNumber)} exceeds the ${String(SEQUENCE_WIDTH)}-digit series width`,
    );
  }
  return `${NUMBER_PREFIX}/${financialYear}/${String(sequenceNumber).padStart(SEQUENCE_WIDTH, '0')}`;
}
