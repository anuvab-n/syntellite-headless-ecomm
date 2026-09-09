import { describe, expect, it } from 'vitest';

import { financialYearOf, formatInvoiceNumber, localDateString } from '../financial-year.js';

/**
 * The financial year and the invoice number format, tested as pure functions.
 *
 * No database, no clock, no container — the same shape as `tax.calculator.test.ts`. That is what
 * lets the 31 March / 1 April boundary be asserted to the minute rather than approximately, and
 * it is why the timezone cases below can be written at all: an integration test would have to
 * arrange for a checkout to happen at a chosen instant, which is not something an HTTP call can
 * do.
 */

const IST = 'Asia/Kolkata';
const UTC = 'UTC';
const NY = 'America/New_York';

describe('financialYearOf', () => {
  describe('the boundary', () => {
    /**
     * The two instants the whole scheme turns on, in the store's own timezone.
     *
     * 2027-03-31T23:59:59+05:30 is still 2026-27; one second later is 2027-28.
     */
    it('puts 31 March in the closing year and 1 April in the opening one', () => {
      expect(financialYearOf(new Date('2027-03-31T18:29:59.999Z'), IST)).toBe('2026-27');
      expect(financialYearOf(new Date('2027-03-31T18:30:00.000Z'), IST)).toBe('2027-28');
    });

    it('treats the first instant of April as the new year', () => {
      /* 2026-04-01T00:00:00+05:30 === 2026-03-31T18:30:00Z */
      expect(financialYearOf(new Date('2026-03-31T18:30:00.000Z'), IST)).toBe('2026-27');
    });

    it('treats the last instant of March as the old year', () => {
      expect(financialYearOf(new Date('2026-03-31T18:29:59.999Z'), IST)).toBe('2025-26');
    });
  });

  describe('across the year', () => {
    const cases: readonly [string, string][] = [
      ['2026-04-01T06:00:00.000Z', '2026-27'],
      ['2026-06-15T06:00:00.000Z', '2026-27'],
      ['2026-12-31T06:00:00.000Z', '2026-27'],
      ['2027-01-01T06:00:00.000Z', '2026-27'],
      ['2027-03-15T06:00:00.000Z', '2026-27'],
      ['2027-04-01T06:00:00.000Z', '2027-28'],
    ];

    for (const [instant, expected] of cases) {
      it(`${instant} is ${expected}`, () => {
        expect(financialYearOf(new Date(instant), IST)).toBe(expected);
      });
    }
  });

  describe('the timezone is the store’s, not the server’s', () => {
    /**
     * **The case that makes the timezone parameter load-bearing.**
     *
     * 2027-03-31T20:00:00Z is already 1 April in Kolkata (+05:30) and still 31 March in UTC.
     * Computing the year in UTC would file an Indian store's first invoice of the new year into
     * the series that closed four hours earlier — a misfiled statutory document, and one only a
     * tax audit would ever find.
     */
    it('files an instant differently for two stores in different zones', () => {
      const at = new Date('2027-03-31T20:00:00.000Z');

      expect(financialYearOf(at, IST)).toBe('2027-28');
      expect(financialYearOf(at, UTC)).toBe('2026-27');
    });

    /** And the other direction: a western zone still in the old day. */
    it('respects a zone behind UTC', () => {
      /* 2027-04-01T02:00:00Z is 2027-03-31 22:00 in New York. */
      const at = new Date('2027-04-01T02:00:00.000Z');

      expect(financialYearOf(at, UTC)).toBe('2027-28');
      expect(financialYearOf(at, NY)).toBe('2026-27');
    });

    it('rejects a timezone that is not an IANA name', () => {
      expect(() => financialYearOf(new Date(), 'Mars/Olympus_Mons')).toThrow(
        /not a valid IANA time zone/,
      );
    });
  });

  describe('the label', () => {
    /**
     * The closing half is the closing year modulo 100, zero-padded.
     *
     * Pinned so nobody "fixes" the turn of the century into `2099-100`. The convention is the
     * two-digit year, and 2100 is `00`.
     */
    it('renders the century turn as 2099-00', () => {
      expect(financialYearOf(new Date('2099-06-01T06:00:00.000Z'), IST)).toBe('2099-00');
    });

    it('zero-pads a single-digit closing year', () => {
      expect(financialYearOf(new Date('2108-06-01T06:00:00.000Z'), IST)).toBe('2108-09');
    });
  });
});

describe('localDateString', () => {
  it('is the store-local calendar date, not the UTC one', () => {
    /* 2026-09-09T19:00:00Z is 2026-09-10 00:30 in Kolkata. */
    const at = new Date('2026-09-09T19:00:00.000Z');

    expect(localDateString(at, UTC)).toBe('2026-09-09');
    expect(localDateString(at, IST)).toBe('2026-09-10');
  });

  it('zero-pads month and day', () => {
    expect(localDateString(new Date('2026-01-05T06:00:00.000Z'), IST)).toBe('2026-01-05');
  });
});

describe('formatInvoiceNumber', () => {
  /** Approved requirement 6, character for character. */
  it('is exactly INV/YYYY-YY/NNNNNN', () => {
    expect(formatInvoiceNumber('2026-27', 1)).toBe('INV/2026-27/000001');
    expect(formatInvoiceNumber('2026-27', 42)).toBe('INV/2026-27/000042');
    expect(formatInvoiceNumber('2026-27', 999_999)).toBe('INV/2026-27/999999');
  });

  it('pads to six digits, never fewer', () => {
    expect(formatInvoiceNumber('2026-27', 7)).toMatch(/^INV\/2026-27\/\d{6}$/u);
  });

  describe('refusals', () => {
    it('refuses a malformed financial year', () => {
      expect(() => formatInvoiceNumber('2026-2027', 1)).toThrow(/malformed financial year/);
      expect(() => formatInvoiceNumber('26-27', 1)).toThrow(/malformed financial year/);
    });

    it('refuses a zero or negative sequence', () => {
      expect(() => formatInvoiceNumber('2026-27', 0)).toThrow(/positive integer/);
      expect(() => formatInvoiceNumber('2026-27', -1)).toThrow(/positive integer/);
    });

    it('refuses a non-integer sequence', () => {
      expect(() => formatInvoiceNumber('2026-27', 1.5)).toThrow(/positive integer/);
    });

    /**
     * Refused rather than silently widened.
     *
     * A seventh digit would break `ck_invoice_number_matches_parts` on insert anyway — the SQL
     * side pads to exactly 6 — so failing here says why instead of surfacing as a constraint
     * violation nobody can read.
     */
    it('refuses a sequence wider than the series format', () => {
      expect(() => formatInvoiceNumber('2026-27', 1_000_000)).toThrow(/exceeds the 6-digit/);
    });
  });
});
