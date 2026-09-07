import type { JsonObject } from '../shared/events.js';
import type { RequestStore } from './middleware/store.js';

/**
 * Express request augmentation.
 *
 * Deliberately minimal. Every field added here is a field some middleware sets and some
 * handler trusts, and `Request` is global — a wide surface here becomes an implicit
 * contract nobody can see. Three fields, each with a stated owner.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express augmentation requires it.
  namespace Express {
    interface Request {
      /**
       * Output of the `validate()` middleware.
       *
       * Present ONLY on routes that ran it. Handlers read `req.validated`, never
       * `req.body` — the distinction is the whole point: an unvalidated body is
       * indistinguishable from a validated one at a glance, so we keep them in
       * different places.
       */
      validated?: ValidatedInput;

      /** Set by `contextMiddleware`. Also available via `getContext()` anywhere. */
      requestId?: string;

      /**
       * Set by `resolveStore`, which is mounted on the API router only.
       *
       * Optional because `/health` deliberately runs without it — a readiness probe must
       * not require a seeded database. Route code should read it through
       * `requireStore(req)` rather than asserting non-null, so a router mounted without the
       * middleware fails with a diagnosable message instead of a TypeError.
       */
      store?: RequestStore;

      /**
       * Set by `requireAuth`, which is mounted per route rather than globally.
       *
       * Optional because most routes are public — a catalogue browse must not require a
       * token. Route code should read it through `requireUser(req)` rather than asserting
       * non-null, so a route mounted without the middleware fails with a diagnosable
       * message instead of a TypeError.
       */
      user?: AuthenticatedUser;
    }
  }
}

/**
 * What a caller may be permitted to do.
 *
 * Declared HERE rather than in `middleware/scope.ts`, and the placement was forced by a real
 * dependency cycle that `depcruise` caught on its first run:
 *
 *   auth.ts -> types.ts -> scope.ts -> auth.ts
 *
 * `types.ts` needed `Scope` for `AuthenticatedUser`, `scope.ts` needed `requireUser` from `auth.ts`,
 * and `auth.ts` needed `AuthenticatedUser`. Type-only, so it was invisible to the compiler and
 * harmless at runtime — but it made three files impossible to reason about separately.
 *
 * It also belongs here on its own merits: `Scope` is part of the request contract, alongside
 * `AuthenticatedUser` and `ValidatedInput`. The middleware re-exports it so existing importers
 * are unaffected.
 *
 * Two values, mapped one-to-one onto the two boolean columns that already exist. No roles
 * table and no permission matrix — see docs/DECISIONS.md §22.
 */
export type Scope = 'staff' | 'superuser';

export type ValidatedInput = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  headers?: unknown;
};

/**
 * The verified identity behind a request.
 *
 * `id`, `storeId`, and `sessionId` are signed claims from the access token, so establishing
 * them requires no database read — which is what lets an authenticated route stay as cheap as
 * a public one.
 *
 * `sessionId` is the `sid` claim — the `refresh_session` row this token descends from. It is
 * what lets logout revoke the caller's own session without the client naming it.
 *
 * The token's `isStaff` and `isSuperuser` claims are deliberately NOT carried here, even
 * though they are present and signed. They are up to 15 minutes stale, which makes them the
 * wrong basis for an authorization decision: an administrator revoking someone's staff flag
 * would otherwise leave that person fully privileged until their token expired. Authorization
 * reads the database instead, through `requireScope`. Omitting the claims makes the stale
 * values *unreachable* rather than merely discouraged — the same reasoning that removed the
 * placeholder `scopes` field before anything could derive it.
 */
export type AuthenticatedUser = {
  id: string;
  storeId: string;
  sessionId: string;
  /**
   * The caller's CURRENT scopes, read from the database by a scope guard.
   *
   * Present only on routes that ran `requireScope` or `requireAnyScope`, matching the rule
   * `req.validated`, `req.store`, and `req.user` itself all follow. A route that never asked
   * about privileges has no business reading an answer, and populating this eagerly would
   * charge every authenticated request for a database read it does not need.
   */
  scopes?: readonly Scope[];
};

/** Re-exported so route modules get JSON typing without reaching into shared/events. */
export type { JsonObject };
export type { RequestStore };
