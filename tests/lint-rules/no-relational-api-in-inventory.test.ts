import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The `local/no-relational-api-in-inventory` rule, exercised through the REAL project config.
 *
 * §5 rule 4, and the one guarding what docs/DECISIONS.md §6 calls "the single most dangerous
 * trap in this stack": `.for('update')` exists on Drizzle's query BUILDER and not on its
 * relational API, so `db.query.stockItem.findFirst(...)` compiles, returns the right row, and
 * takes no lock. The wrong version passes every single-threaded test and fails in production
 * as overselling.
 *
 * A lint rule with no test is a rule that can silently stop working, and a disarmed rule is
 * indistinguishable from a clean codebase. Two properties need proving, and the second is the
 * one an implementation gets wrong:
 *
 *  1. it FIRES inside `src/modules/inventory`;
 *  2. it stays SILENT everywhere else — a rule that fired repo-wide would ban the relational
 *     API from a codebase that has legitimate uses for it elsewhere, and the first person to
 *     hit that would disable the rule rather than narrow it.
 *
 * Two fixtures are therefore written, one on each side of the boundary, and both are linted.
 * The rule is SYNTACTIC, so unlike `no-money-arithmetic` it does not need type information —
 * but it does need a real path, because the path is what it keys on.
 */
describe('local/no-relational-api-in-inventory', () => {
  const RULE = 'local/no-relational-api-in-inventory';

  const insidePath = join(
    process.cwd(),
    'src',
    'modules',
    'inventory',
    'relational-api.fixture.ts',
  );
  const outsidePath = join(
    process.cwd(),
    'src',
    'modules',
    'catalogue',
    'relational-api.fixture.ts',
  );

  /**
   * Deliberately identical content in both fixtures.
   *
   * If the two files differed, a difference in the results could be explained by the content
   * rather than by the path — and the path is the entire thing under test.
   */
  const FIXTURE = `type Handle = { query: Record<string, { findFirst: () => unknown; findMany: () => unknown }> };
declare const db: Handle;
declare const tx: Handle;
declare const somethingElse: Handle;

/* violations */
export const one = db.query['stockItem']?.findFirst();
export const many = tx.query['stockItem']?.findMany();
export const destructured = db.query;

/* allowed */
export const other = somethingElse.query['x']?.findFirst();
export const computed = db['query'];
`;

  let insideLines = new Map<number, string[]>();
  let outsideCount = 0;

  const lineOf = (marker: string): number => {
    const index = FIXTURE.split('\n').findIndex((l) => l.includes(marker));
    expect(index, `fixture line for ${marker}`).toBeGreaterThanOrEqual(0);
    return index + 1;
  };

  beforeAll(async () => {
    mkdirSync(join(process.cwd(), 'src', 'modules', 'inventory'), { recursive: true });
    writeFileSync(insidePath, FIXTURE, 'utf8');
    writeFileSync(outsidePath, FIXTURE, 'utf8');

    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([insidePath, outsidePath]);

    const inside = results.find((r) => r.filePath === insidePath);
    const outside = results.find((r) => r.filePath === outsidePath);

    insideLines = new Map();
    for (const message of inside?.messages ?? []) {
      if (message.ruleId !== RULE) continue;
      const existing = insideLines.get(message.line) ?? [];
      existing.push(message.messageId ?? '');
      insideLines.set(message.line, existing);
    }

    outsideCount = (outside?.messages ?? []).filter((m) => m.ruleId === RULE).length;

    /**
     * The worst failure mode: a correct rule that nobody registered. Without this guard,
     * removing the plugin from `eslint.config.js` would make every "reports" case report
     * nothing and every assertion below would still pass.
     */
    expect(
      insideLines.size,
      'rule produced no messages at all — is it registered in eslint.config.js?',
    ).toBeGreaterThan(0);
  }, 120_000);

  afterAll(() => {
    // Removed so a stray fixture cannot fail the repo-wide `pnpm lint` or trip
    // dependency-cruiser's `no-orphans` on the next run.
    for (const path of [insidePath, outsidePath]) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone; nothing to do.
      }
    }
  });

  const at = (marker: string): string[] => insideLines.get(lineOf(marker)) ?? [];

  describe('inside the inventory module', () => {
    it('reports db.query.<table>.findFirst — the call that takes no lock', () => {
      expect(at('export const one')).toEqual(['relationalApi']);
    });

    it('reports the same through a transaction handle', () => {
      // `tx` is the receiver that matters most: it is the one a developer reaches for when
      // they believe they are inside a locked transaction.
      expect(at('export const many')).toEqual(['relationalApi']);
    });

    it('reports a bare `db.query` reference, not only a full call chain', () => {
      /**
       * Reporting at the `.query` member rather than at named methods is what makes the rule
       * complete: a destructured or passed-along reference reaches the relational API just as
       * effectively, and enumerating `findFirst`/`findMany` would need an edit every time
       * Drizzle adds a method.
       */
      expect(at('export const destructured')).toEqual(['relationalApi']);
    });

    it('allows `.query` on a receiver that is not a database handle', () => {
      // Narrow by design. A rule that fired on every `.query` in the module would be disabled
      // by the first person who wrote one for an unrelated reason.
      expect(at('export const other')).toEqual([]);
    });

    it('allows computed access, which cannot be resolved syntactically', () => {
      /**
       * `db['query']` is deliberately NOT reported. The rule is syntactic, so it cannot know
       * what a computed key holds, and guessing would produce false positives on ordinary
       * index access. This is a stated limit rather than an oversight: the honest boundary of
       * a syntactic rule, recorded so a reader does not mistake it for a hole nobody noticed.
       */
      expect(at('export const computed')).toEqual([]);
    });
  });

  describe('outside the inventory module', () => {
    it('stays completely silent on identical code', () => {
      /**
       * The scoping half of the contract. The relational API is a legitimate tool elsewhere —
       * it is only unsafe where a row lock is the difference between correct and oversold —
       * and a rule that banned it repo-wide would be one nobody could live with.
       */
      expect(outsideCount).toBe(0);
    });
  });
});
