/**
 * Architecture enforcement.
 *
 * Scoped as Phase 0 Step 8, skipped at the time, and written here against five modules that
 * had until now kept their layering by hand. Every rule below was VERIFIED to already hold
 * before it was written — with one exception, `no-http-to-modules`, which had a single real
 * violation (`http/middleware/auth.ts` importing `TokenService`). That was fixed by narrowing
 * the dependency to an `AccessTokenVerifier` port rather than by weakening the rule.
 *
 * That ordering matters. A ruleset tuned until it passes is a ruleset that documents whatever
 * the code already does; these rules were chosen first and the code was made to comply.
 *
 * Every rule states its own violation in plain terms, because the audience is somebody six
 * months from now who has just been told their PR breaks the architecture and has no idea why.
 */

/** Files that adapt a module to the HTTP boundary, and may therefore depend on it. */
const HTTP_ADAPTERS = '(routes|resolver)\\.ts$';

/** Process entry points, which are allowed to construct the composition root. */
const ENTRY_POINTS = '^src/(main|cli)\\.ts$|^src/workers/';

module.exports = {
  forbidden: [
    /* ── Cycles ────────────────────────────────────────────────────────── */
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A dependency cycle. Neither file can be understood, tested, or loaded without the ' +
        'other, and module initialisation order becomes load-bearing in a way nobody can see. ' +
        'Break it by extracting the shared piece, or by inverting one direction with a port ' +
        '(see AccessTokenVerifier in http/middleware/auth.ts for the pattern).',
      from: {},
      to: { circular: true },
    },

    /* ── Layering ──────────────────────────────────────────────────────── */
    {
      name: 'no-http-to-modules',
      severity: 'error',
      comment:
        'The HTTP layer must not import a domain module. HTTP is a delivery mechanism: it ' +
        'translates requests and knows nothing about identity, catalogue, or orders. Depend on ' +
        'a narrow PORT declared in http/ and let the composition root supply the ' +
        'implementation — StoreResolver, AuthorizationSubjectLoader, and AccessTokenVerifier ' +
        'are all examples. This is what keeps middleware testable without standing up a module.',
      from: { path: '^src/http/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-modules-to-http',
      severity: 'error',
      comment:
        'A domain module must not import the HTTP layer. A service that reaches for Express ' +
        'cannot be driven from a CLI command, a queue worker, or a seed script. The only ' +
        'exceptions are *.routes.ts and *.resolver.ts, which exist precisely to adapt a module ' +
        'to that boundary — if this fired on a service or a repository, move the HTTP concern ' +
        'into the routes file instead of widening the exception.',
      from: { path: '^src/modules/', pathNot: HTTP_ADAPTERS },
      to: { path: '^src/http/' },
    },
    {
      name: 'no-cross-module-imports',
      severity: 'error',
      comment:
        'One domain module imported another directly. Modules must stay independently ' +
        'deployable and independently testable; a direct import couples their lifecycles and ' +
        'is how a modular monolith quietly becomes a single tangled one. Communicate through ' +
        'the composition root, or through an outbox event if the coupling is genuinely async.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'shared-is-the-base-layer',
      severity: 'error',
      comment:
        'shared/ imported something above it. It is the bottom of the stack — errors, logging, ' +
        'money, ids, request context — and everything else depends on it. A dependency in this ' +
        'direction creates a cycle across the whole codebase and makes shared/ impossible to ' +
        'reuse or reason about in isolation.',
      from: { path: '^src/shared/' },
      to: { path: '^src/(http|modules|db|redis)/' },
    },

    /* ── Data access ───────────────────────────────────────────────────── */
    {
      name: 'schema-only-in-repositories',
      severity: 'error',
      comment:
        'A table definition was imported outside the data layer. Only *.repository.ts files, ' +
        'db/ itself, and the migrate/seed scripts may touch db/schema — a service that builds ' +
        'its own query spreads persistence knowledge across the codebase, and the store-scoping ' +
        'rules that live in the repositories stop being the single place tenancy is enforced.',
      from: {
        path: '^src/',
        pathNot: '\\.repository\\.ts$|^src/db/|^src/scripts/|\\.test\\.ts$',
      },
      to: { path: '^src/db/schema/' },
    },

    /* ── Cryptography containment ──────────────────────────────────────── */
    {
      name: 'jose-only-in-token-service',
      severity: 'error',
      comment:
        'jose was imported outside modules/identity/tokens.ts. JWT signing and verification ' +
        'live in exactly one file so that algorithm pinning, key handling, the claim contract, ' +
        'and the single opaque failure mode cannot drift. A route or middleware that verifies ' +
        'its own token will eventually accept one this service would have rejected.',
      from: { pathNot: '^src/modules/identity/tokens\\.ts$|\\.test\\.ts$' },
      /**
       * Matched on the RESOLVED path, not the bare specifier.
       *
       * `path: '^jose$'` was the first attempt and matched nothing: dependency-cruiser resolves
       * an npm import to something like
       * `node_modules/.pnpm/jose@6.2.10/node_modules/jose/dist/types/index.d.ts`. The rule
       * therefore reported a clean codebase while a probe importing jose into middleware sailed
       * straight through — a security rule that existed only as a comment.
       *
       * Found by deliberately violating it rather than by reading it. See docs/DECISIONS.md §23.
       */
      to: { dependencyTypes: ['npm'], path: '/node_modules/jose/' },
    },
    {
      name: 'argon2-only-in-password-module',
      severity: 'error',
      comment:
        'argon2 was imported outside modules/identity/password.ts. The cost parameters, the ' +
        'input length guard, and the rule that every verification failure returns false rather ' +
        'than throwing all live in one file. A second call site is a second, unreviewed ' +
        'password policy.',
      from: { pathNot: '^src/modules/identity/password\\.ts$|\\.test\\.ts$' },
      // Resolved path, for exactly the same reason as the jose rule above.
      to: { dependencyTypes: ['npm'], path: '/node_modules/argon2/' },
    },

    /* ── Composition root ──────────────────────────────────────────────── */
    {
      name: 'container-only-from-entry-points',
      severity: 'error',
      comment:
        'Something other than a process entry point imported the composition root. That is the ' +
        'service-locator pattern: a module that reaches into the container to find a dependency ' +
        'is coupled to every implementation choice made there, and its own dependencies stop ' +
        'being visible in its signature. Accept what you need as a function argument instead.',
      from: { path: '^src/', pathNot: `${ENTRY_POINTS}|\\.test\\.ts$` },
      to: { path: '^src/container\\.ts$' },
    },

    /* ── Hygiene ───────────────────────────────────────────────────────── */
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'A module nobody imports. Usually dead code left after a refactor, occasionally a file ' +
        'someone forgot to wire up. Type declaration files and config are excluded because ' +
        'they are legitimately reached by the compiler rather than by an import.',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', '(^|/)tsconfig\\.json$'],
      },
      to: {},
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Production code imported a devDependency. It is installed locally and in CI, and ' +
        'absent from the production image — so this fails at runtime after deploy, not here.',
      from: { path: '^src/', pathNot: '\\.test\\.ts$|^src/scripts/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-deprecated-core',
      severity: 'error',
      comment: 'A deprecated Node core module. It will be removed in a future major version.',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|_linklist|constants)$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    /**
     * Test files are excluded from the graph.
     *
     * They legitimately break several of these rules on purpose — the scope suite mounts its
     * own routes, the identity tests import schema to assert what was persisted. Including them
     * would mean either noisy failures or exceptions so broad they hollow out the rules.
     */
    exclude: { path: '(__tests__|\\.test\\.ts$|^tests/)' },
    tsConfig: { fileName: 'tsconfig.json' },
    /**
     * Analyse imports BEFORE TypeScript erases types. Load-bearing, twice.
     *
     * 1. **Without it, the layering rules are nearly vacuous.** The one real violation this
     *    increment found — `http/middleware/auth.ts` importing `TokenService` — was an
     *    `import type`, so it leaves no runtime edge and `no-http-to-modules` would have
     *    reported a clean codebase while the dependency sat there in the source. A rule that
     *    only sees value imports cannot enforce an architecture written in types.
     *
     * 2. **Without it, type-only modules look like dead code.** `shared/events.ts` and
     *    `http/types.ts` export nothing but types, so post-erasure nothing imports them and
     *    `no-orphans` flagged both — despite seven files depending on the first. Excluding them
     *    by path would have hidden the symptom and left problem (1) in place.
     */
    tsPreCompilationDeps: true,
    /** Resolve the project's NodeNext `.js` specifiers back to their `.ts` sources. */
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
