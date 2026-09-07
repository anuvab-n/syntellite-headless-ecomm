import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The `local/no-money-arithmetic` rule, exercised through the REAL project config.
 *
 * A lint rule with no test is a rule that can silently stop working — a config refactor, a
 * typescript-eslint upgrade, or a change to the `Money` type would each disarm it, and a
 * disarmed rule is indistinguishable from a clean codebase. §5 calls these rules the thing
 * that actually enforces the architecture, so the rule needs the scepticism every increment
 * applies to everything else.
 *
 * ## Why a real file on disk rather than `RuleTester` or `lintText`
 *
 * The rule is TYPE-AWARE: it asks the checker whether an operand is a `Money`. A snippet
 * linted through `lintText` under a made-up path is in no TypeScript program, so there is no
 * type information, the rule bails out by design, and every assertion would report zero
 * messages — the tests would all pass while proving nothing.
 *
 * So a single fixture is written into `tests/`, which `tsconfig.test.json` already covers,
 * and linted once. One TypeScript program build for the whole suite rather than one per case,
 * which is also the difference between ~1s and ~11s per assertion.
 */
describe('local/no-money-arithmetic', () => {
  const fixturePath = join(process.cwd(), 'tests', 'lint-rules', 'money-arithmetic.fixture.ts');

  /** messageId per 1-based line of the fixture. */
  let byLine = new Map<number, string[]>();

  /**
   * Every case, in one file, with the line of each assertion pinned by a named constant
   * below. Violations first, then the cases that must stay quiet.
   */
  const FIXTURE = `import { money, add, compare, type Money } from '../../src/shared/money.js';

const a: Money = money('10.0000', 'INR');
const b: Money = money('2.5000', 'INR');
const maybe: Money | undefined = a;

/* violations */
export const concat = a.amount + b.amount;
export const times = a.amount * 3;
export const minus = a.amount - b.amount;
export const over = a.amount / 2;
export const ltCmp = a.amount < b.amount;
export const gtCmp = a.amount > b.amount;
export const gteCmp = a.amount >= b.amount;
export const lteCmp = a.amount <= b.amount;
export const asNumber = Number(a.amount);
export const asFloat = parseFloat(a.amount);
export const asInt = parseInt(a.amount, 10);
export const negated = -a.amount;
export const bang = maybe!.amount + b.amount;

/* allowed */
export const viaAdd = add(a, b);
export const viaCompare = compare(a, b);
export const plainNumbers = 2 + 3;
export const plainStrings = 'x' + 'y';
export const plainCompare = 'x' < 'y';
export const exactEquality = a.amount === b.amount;
export const justRead = a.amount;
export const interpolated = \`total \${a.amount}\`;
export const inObject = { price: a.amount };
`;

  /** 1-based fixture lines, derived so an edit above cannot silently shift them. */
  const lineOf = (marker: string): number => {
    const index = FIXTURE.split('\n').findIndex((l) => l.includes(marker));
    expect(index, `fixture line for ${marker}`).toBeGreaterThanOrEqual(0);
    return index + 1;
  };

  beforeAll(async () => {
    writeFileSync(fixturePath, FIXTURE, 'utf8');

    // Constructed AFTER the fixture exists, so the TypeScript program includes it.
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintFiles([fixturePath]);

    byLine = new Map();
    for (const message of result?.messages ?? []) {
      if (message.ruleId !== 'local/no-money-arithmetic') continue;
      const existing = byLine.get(message.line) ?? [];
      existing.push(message.messageId ?? '');
      byLine.set(message.line, existing);
    }

    /**
     * Guard against the worst failure mode: a correct rule that nobody registered. Without
     * this, dropping the plugin from `eslint.config.js` would make every "reports" case
     * report nothing and every "allows" case pass.
     */
    expect(byLine.size, 'rule produced no messages at all — is it registered?').toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    // Removed so a stray fixture cannot fail the repo-wide `pnpm lint` on the next run.
    try {
      unlinkSync(fixturePath);
    } catch {
      // Already gone; nothing to do.
    }
  });

  const at = (marker: string): string[] => byLine.get(lineOf(marker)) ?? [];

  /* ── Violations ────────────────────────────────────────────────────────── */

  describe('reports', () => {
    it('string concatenation of two amounts — the silent failure', () => {
      /**
       * The case the whole rule exists for. `"10.0000" + "2.5000"` is `"10.00002.5000"`: it
       * typechecks as `string + string`, passes every other rule, and writes a
       * plausible-looking wrong number into a NUMERIC column.
       */
      expect(at('export const concat')).toEqual(['arithmetic']);
    });

    it('multiplication, subtraction and division', () => {
      expect(at('export const times')).toEqual(['arithmetic']);
      expect(at('export const minus')).toEqual(['arithmetic']);
      expect(at('export const over')).toEqual(['arithmetic']);
    });

    it('lexicographic comparison, on every relational operator', () => {
      // `"9.0000" < "10.0000"` is FALSE as strings — the identical trap the Increment 20
      // price-bound comparator had to solve by zero-padding.
      expect(at('export const ltCmp')).toEqual(['relational']);
      expect(at('export const gtCmp')).toEqual(['relational']);
      expect(at('export const gteCmp')).toEqual(['relational']);
      expect(at('export const lteCmp')).toEqual(['relational']);
    });

    it('numeric coercion via Number, parseFloat and parseInt', () => {
      expect(at('export const asNumber')).toEqual(['coercion']);
      expect(at('export const asFloat')).toEqual(['coercion']);
      expect(at('export const asInt')).toEqual(['coercion']);
    });

    it('unary negation', () => {
      expect(at('export const negated')).toEqual(['arithmetic']);
    });

    it('a non-null assertion is not an escape hatch', () => {
      expect(at('export const bang')).toEqual(['arithmetic']);
    });
  });

  /* ── Non-violations ────────────────────────────────────────────────────── */

  describe('allows', () => {
    it('the money helpers', () => {
      expect(at('export const viaAdd')).toEqual([]);
      expect(at('export const viaCompare')).toEqual([]);
    });

    it('arithmetic and comparison on ordinary numbers and strings', () => {
      /**
       * The rule must be quiet on everything that is not money, or it becomes noise that
       * gets disabled — which is the same as not existing.
       */
      expect(at('export const plainNumbers')).toEqual([]);
      expect(at('export const plainStrings')).toEqual([]);
      expect(at('export const plainCompare')).toEqual([]);
    });

    it('exact equality on amounts', () => {
      // `===` on two canonical decimal strings at the same scale is exact and correct.
      expect(at('export const exactEquality')).toEqual([]);
    });

    it('reading, interpolating and storing an amount', () => {
      expect(at('export const justRead')).toEqual([]);
      expect(at('export const interpolated')).toEqual([]);
      expect(at('export const inObject')).toEqual([]);
    });
  });

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  it('is enabled as an error by the project config', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const config = await eslint.calculateConfigForFile('src/shared/money.ts');

    // ESLint normalises severity to a number: 2 is error.
    expect(config.rules?.['local/no-money-arithmetic']?.[0]).toBe(2);
  });
});
