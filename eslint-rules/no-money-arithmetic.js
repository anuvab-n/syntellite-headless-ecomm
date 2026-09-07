/**
 * Custom ESLint rule: no raw arithmetic on `Money`.
 *
 * The fourth of the five architecture rules named in docs/DECISIONS.md §5, and the one with a
 * live target today — `shared/money.ts` exists and its arithmetic half is about to acquire its
 * first production callers in order totals and GST.
 *
 * ## What actually goes wrong
 *
 * `Money.amount` is a decimal STRING, not a number. That is deliberate (a `NUMERIC(19,4)`
 * column round-trips through it without precision loss) and it is exactly why the failure is
 * invisible:
 *
 *     line.amount + tax.amount        // "10.0000" + "2.5000" === "10.00002.5000"
 *
 * String concatenation. It typechecks perfectly — `string + string` is a `string` — so neither
 * `tsc` nor `recommendedTypeChecked` says a word. It produces a plausible-looking value that
 * is silently, permanently wrong in the database.
 *
 * The other half of the sin is the escape hatch:
 *
 *     Number(line.amount) + Number(tax.amount)   // IEEE-754, and 0.1 + 0.2 again
 *
 * which is the precise thing `NUMERIC(19,4)` and decimal.js were chosen to prevent.
 *
 * Comparison is included for the same reason: `a.amount < b.amount` compares strings
 * lexicographically, so `"9.0000" < "10.0000"` is false. That is the identical trap the
 * Increment 20 price-bound comparator had to solve with zero-padding.
 *
 * ## What to use instead
 *
 * `add`, `subtract`, `sum`, `multiply`, `divide`, `allocate`, `percentOf`, `compare`,
 * `greaterThan`, `lessThan`, and friends — all exported from `shared/money.ts`, all exact.
 */

/** Type-alias names treated as money. */
const MONEY_TYPES = new Set(['Money']);

/** Functions that turn a string into a float. */
const NUMERIC_COERCERS = new Set(['Number', 'parseFloat', 'parseInt']);

const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '**']);

/**
 * Relational operators. Included because comparing decimal strings is lexicographic, which
 * is wrong in a way that looks right for most values and fails around magnitude boundaries.
 */
const RELATIONAL_OPERATORS = new Set(['<', '>', '<=', '>=']);

const COMPOUND_ASSIGNMENTS = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

/**
 * Annotated on the BINDING and exported separately, rather than `export default {...}`.
 *
 * Annotating the const pins its type to `Rule.RuleModule`, which is nameable from `eslint`.
 * Exporting the object literal directly makes TS infer the type instead, and the inferred
 * type transitively names `@types/estree` — a transitive dependency that pnpm's non-hoisted
 * layout leaves unnameable from this path, so `tsc` fails with TS2742. Same code, same
 * behaviour; this form simply gives the compiler a type it can write down.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw arithmetic, comparison, or numeric coercion on Money values and their amount strings.',
    },
    schema: [],
    messages: {
      arithmetic:
        'Raw `{{operator}}` on a Money amount. `amount` is a decimal STRING, so this concatenates or silently loses precision rather than adding. Use add/subtract/multiply/divide/sum/allocate from shared/money.ts.',
      relational:
        'Raw `{{operator}}` on a Money amount compares decimal strings lexicographically ("9.0000" < "10.0000" is false). Use compare/greaterThan/lessThan/greaterThanOrEqual/lessThanOrEqual from shared/money.ts.',
      coercion:
        '`{{callee}}()` on a Money amount converts an exact decimal to a float. That is the precision loss NUMERIC(19,4) and decimal.js exist to prevent. Keep it as Money and use the money helpers.',
    },
  },

  create(context) {
    const services = context.sourceCode.parserServices;

    // Without type information the rule cannot tell a Money amount from any other string, and
    // a syntactic guess would be noise. Stay silent rather than fire at random.
    if (!services?.program || !services.esTreeNodeToTSNodeMap) return {};

    const checker = services.program.getTypeChecker();

    /** Resolve the declared name of a type, following aliases and unwrapping unions. */
    function typeNames(type) {
      const names = [];
      const parts = type.isUnion?.() ? type.types : [type];
      for (const part of parts) {
        const alias = part.aliasSymbol?.getName();
        if (alias) names.push(alias);
        const symbol = part.getSymbol?.()?.getName();
        if (symbol) names.push(symbol);
      }
      return names;
    }

    function typeOf(node) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return tsNode ? checker.getTypeAtLocation(tsNode) : undefined;
    }

    function isMoney(node) {
      const type = typeOf(node);
      return type ? typeNames(type).some((n) => MONEY_TYPES.has(n)) : false;
    }

    /**
     * True for a Money value itself OR for a property read off one — `m` and `m.amount` are
     * both wrong to hand to an operator, and `m.amount` is the case that actually compiles.
     */
    function isMoneyish(node) {
      if (!node) return false;
      if (isMoney(node)) return true;
      if (node.type === 'MemberExpression' && !node.computed) return isMoney(node.object);
      // `(a.amount)` and `a!.amount` should not be an escape hatch.
      if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression') {
        return isMoneyish(node.expression);
      }
      return false;
    }

    return {
      BinaryExpression(node) {
        const isArithmetic = ARITHMETIC_OPERATORS.has(node.operator);
        const isRelational = RELATIONAL_OPERATORS.has(node.operator);
        if (!isArithmetic && !isRelational) return;
        if (!isMoneyish(node.left) && !isMoneyish(node.right)) return;

        context.report({
          node,
          messageId: isArithmetic ? 'arithmetic' : 'relational',
          data: { operator: node.operator },
        });
      },

      AssignmentExpression(node) {
        if (!COMPOUND_ASSIGNMENTS.has(node.operator)) return;
        if (!isMoneyish(node.left) && !isMoneyish(node.right)) return;

        context.report({ node, messageId: 'arithmetic', data: { operator: node.operator } });
      },

      /** `-m.amount` is arithmetic too. Use `negate()`. */
      UnaryExpression(node) {
        if (node.operator !== '-' && node.operator !== '+') return;
        if (!isMoneyish(node.argument)) return;

        context.report({ node, messageId: 'arithmetic', data: { operator: node.operator } });
      },

      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        if (!NUMERIC_COERCERS.has(node.callee.name)) return;
        if (!node.arguments.some((arg) => isMoneyish(arg))) return;

        context.report({
          node,
          messageId: 'coercion',
          data: { callee: node.callee.name },
        });
      },
    };
  },
};

export default rule;
