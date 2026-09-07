/**
 * Custom ESLint rule: no Drizzle relational API (`db.query.*`) inside the inventory module.
 *
 * The fourth of the five architecture rules named in docs/DECISIONS.md §5, landing with its
 * subject — the inventory module — exactly as `eslint.config.js` said it should.
 *
 * ## What actually goes wrong
 *
 * docs/DECISIONS.md §6 calls this "the single most dangerous trap in this stack", and it is
 * one rather than a style preference because Drizzle exposes two query APIs and only one of
 * them can take a row lock:
 *
 *     // CORRECT — takes the lock
 *     await tx.select().from(stockItem).where(eq(stockItem.skuId, id)).for('update');
 *
 *     // WRONG — compiles, runs, returns the right row, takes NO LOCK
 *     await tx.query.stockItem.findFirst({ where: eq(stockItem.skuId, id) });
 *
 * `.for('update')` exists on the query BUILDER and not on the relational API. The wrong
 * version passes every single-threaded test — it returns the correct row every time — and
 * fails only under concurrent load, in production, as overselling. `tsc` cannot help: both
 * are valid, well-typed calls returning the same shape.
 *
 * ## Why the rule exists NOW, when nothing here takes a lock yet
 *
 * Increment 26 deliberately uses a single atomic `UPDATE ... WHERE ... RETURNING` rather than
 * a lock, because that was measured to be both correct and roughly twice as fast, and because
 * it keeps the arithmetic in SQL where a refactor cannot quietly move it into JavaScript. So
 * there is no `.for('update')` in this module today for the rule to protect.
 *
 * It lands anyway, for two reasons. The rule must be in place BEFORE the multi-row allocation
 * increment writes the first genuine row lock — that is the increment where §6's warning is
 * live, and a guard added after the fact guards nothing that was written before it. And
 * `eslint.config.js` commits to these rules landing with their subject rather than ahead of
 * it; inventory is the subject, so this is the moment.
 *
 * ## What to use instead
 *
 * The query builder, always: `db.select().from(table).where(...)`. It can express
 * `.for('update')`, `.for('share')`, and `RETURNING` on a conditional `UPDATE`; the relational
 * API can express none of them.
 */

/** The path prefix this rule applies to. Everything else is unaffected. */
const INVENTORY_PATH = 'src/modules/inventory';

/**
 * Receivers whose `.query` is Drizzle's relational API.
 *
 * Matching by identifier name rather than by type: the rule is syntactic so it stays fast and
 * so it still fires on an `any`-typed handle, which is exactly the case a type-aware rule
 * would silently miss.
 */
const DB_RECEIVERS = new Set(['db', 'tx', 'trx', 'executor', 'database', 'handle', 'conn']);

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid the Drizzle relational API (db.query.*) inside the inventory module; it cannot express FOR UPDATE.',
    },
    schema: [],
    messages: {
      relationalApi:
        "The Drizzle relational API is forbidden in the inventory module: `{{receiver}}.query.*` cannot express `.for('update')`, so a lock silently becomes a no-op. Use the query builder — `{{receiver}}.select().from(...)` — see docs/DECISIONS.md §6.",
    },
  },

  create(context) {
    /**
     * Normalised so the check works on Windows, where `getFilename()` returns backslashes and
     * a literal comparison against a POSIX path would never match — which would leave the rule
     * silently disabled on the machine it was written on.
     */
    const filename = context.filename.split('\\').join('/');
    if (!filename.includes(INVENTORY_PATH)) return {};

    return {
      /**
       * Matches the `X.query` member expression rather than the full call chain.
       *
       * Reporting at `.query` catches every shape in one place — `db.query.t.findFirst()`,
       * `db.query.t.findMany()`, a destructured `const { t } = db.query`, and a bare reference
       * passed elsewhere — instead of enumerating the relational API's method names, which
       * would need updating every time Drizzle adds one.
       */
      MemberExpression(node) {
        if (node.computed) return;
        if (node.property.type !== 'Identifier' || node.property.name !== 'query') return;
        if (node.object.type !== 'Identifier') return;
        if (!DB_RECEIVERS.has(node.object.name)) return;

        context.report({
          node,
          messageId: 'relationalApi',
          data: { receiver: node.object.name },
        });
      },
    };
  },
};

export default rule;
