import type { RequestHandler } from 'express';

import {
  AuthenticationRequired,
  InvariantViolation,
  PermissionDenied,
} from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { asyncHandler } from '../async-handler.js';
import type { Scope } from '../types.js';
import { requireUser } from './auth.js';

/**
 * Scope-based authorization.
 *
 * The companion to `requireAuth`, and deliberately separate from it. `requireAuth` answers
 * "who are you"; this answers "may you". Keeping them apart is what lets an authenticated but
 * unprivileged route — `/users/me`, a cart, an order history — cost exactly one query, while
 * only the routes that actually gate on a privilege pay for the check.
 *
 * **Authorization state is read from the DATABASE, never from the token.**
 *
 * The access token carries `isStaff` and `isSuperuser` claims, and they are the wrong source
 * for this decision: a token lives 15 minutes, so an administrator revoking someone's staff
 * flag would leave them fully privileged for the rest of that window. Reading the row means a
 * demotion takes effect on the caller's very next scoped request.
 *
 *   isStaff = true  ->  requireScope('staff')  ->  DB: ['staff']       ->  200
 *   ... administrator sets isStaff = false ...
 *   token still valid  ->  requireScope('staff')  ->  DB: []           ->  403
 *
 * This is the same principle `GET /users/me` follows: the token proves who the caller is, the
 * database determines what they currently are. It is also why `AuthenticatedUser` no longer
 * carries the token's `isStaff`/`isSuperuser` claims at all — a stale flag that cannot be
 * reached cannot be trusted by mistake.
 *
 * The cost is one indexed read per scoped request. That is the price of fresh authorization,
 * and it is charged only where authorization is actually required.
 */

export type { Scope };

/** The authorization-relevant state of a user, as read from the database. */
export type AuthorizationSubject = {
  isActive: boolean;
  isStaff: boolean;
  isSuperuser: boolean;
};

/**
 * How this middleware reaches the database.
 *
 * A narrow port rather than the identity repository, mirroring `StoreResolver` in `store.ts`.
 * The HTTP layer stays ignorant of Drizzle, of the `app_user` table, and of which module owns
 * users — the composition root supplies the function. It also means these guards can be
 * exercised against a fake in a unit test without standing up PostgreSQL.
 */
export type AuthorizationSubjectLoader = (params: {
  storeId: string;
  userId: string;
}) => Promise<AuthorizationSubject | undefined>;

/**
 * Map database flags onto scopes.
 *
 * Independently, with **no implied hierarchy**: `superuser` does not grant `staff`. The two
 * columns are separate booleans in the schema, and quietly making one imply the other would
 * invent a privilege relationship the domain has never stated — the kind of assumption that is
 * invisible until someone is granted more than an administrator intended.
 *
 * A deployment that wants the hierarchy should set both flags, which says so explicitly in the
 * data rather than implicitly in this function.
 *
 *   { isStaff: false, isSuperuser: false }  ->  []
 *   { isStaff: true,  isSuperuser: false }  ->  ['staff']
 *   { isStaff: false, isSuperuser: true  }  ->  ['superuser']
 *   { isStaff: true,  isSuperuser: true  }  ->  ['staff', 'superuser']
 */
export function deriveScopes(subject: {
  isStaff: boolean;
  isSuperuser: boolean;
}): readonly Scope[] {
  const scopes: Scope[] = [];
  if (subject.isStaff) scopes.push('staff');
  if (subject.isSuperuser) scopes.push('superuser');
  return scopes;
}

/**
 * Build the scope guards against one subject loader.
 *
 * A factory so the dependency is bound once in the composition root and the call sites read as
 * plainly as the policy they express:
 *
 *   router.post('/admin/products', requireAuth(...), requireScope('staff'), handler)
 */
export function createScopeGuards(deps: {
  loadSubject: AuthorizationSubjectLoader;
  logger: Logger;
}) {
  const { loadSubject, logger } = deps;

  /**
   * Resolve the caller's current scopes, or reject.
   *
   * Returns 401 rather than 403 when the account is gone or deactivated, matching
   * `/users/me`: a suspended account is an authentication problem — the credential no longer
   * identifies a usable identity — not a permission problem. Answering 403 would tell a
   * suspended user they merely lacked a privilege, which is both wrong and a worse hint.
   */
  const resolveScopes = async (req: Parameters<RequestHandler>[0]): Promise<readonly Scope[]> => {
    const user = requireUser(req);

    const subject = await loadSubject({ storeId: user.storeId, userId: user.id });

    if (!subject || !subject.isActive) {
      logger.warn(
        { storeId: user.storeId, userId: user.id, found: subject !== undefined },
        'authorization_rejected_not_active',
      );
      throw new AuthenticationRequired();
    }

    const scopes = deriveScopes(subject);

    /**
     * Attached so a handler downstream can branch on the FRESH scopes — never on a token
     * claim. Present only on routes that ran a guard, matching how `req.validated`,
     * `req.store`, and `req.user` all behave: a route that never asked about privileges has
     * no business reading an answer.
     */
    req.user = { ...user, scopes };
    return scopes;
  };

  /** Reject with the scopes that were missing, so the 403 is actionable. */
  const deny = (
    req: Parameters<RequestHandler>[0],
    held: readonly Scope[],
    missing: readonly Scope[],
  ): never => {
    const user = requireUser(req);
    logger.warn(
      { storeId: user.storeId, userId: user.id, held, missing },
      'authorization_denied_insufficient_scope',
    );
    /**
     * `missing` names the required scopes, not the caller's. Telling a client what it needs is
     * standard and useful; enumerating what it HAS would leak the privilege shape of an
     * account to anyone who can provoke a 403.
     */
    throw new PermissionDenied({ missing });
  };

  /**
   * A guard with no scopes guards nothing, and is far more likely to be a mistake — a spread
   * of an empty array, a forgotten argument — than a deliberate "any active user" check.
   * Thrown at construction, so it fails at boot rather than silently permitting traffic.
   */
  const assertRequested = (scopes: readonly Scope[], guard: string): void => {
    if (scopes.length === 0) {
      throw new InvariantViolation(`${guard}() requires at least one scope`);
    }
  };

  /**
   * Arrow properties, NOT method shorthand.
   *
   * The intended call site destructures — `const { requireScope } = createScopeGuards(...)` —
   * and method shorthand makes that unsafe in principle, because a detached method carries no
   * guarantee about `this`. The lint rule flagged it, and it was right to: these close over
   * `loadSubject` and `logger` and never touch `this`, so arrows say so at the type level
   * rather than leaving every caller to prove it.
   */
  return {
    /**
     * Require EVERY listed scope.
     *
     * `requireScope('staff')` is the common case. `requireScope('staff', 'superuser')` demands
     * both, which given the deliberate absence of a hierarchy is the only way to express
     * "a superuser who is also staff".
     */
    requireScope: (...required: readonly Scope[]): RequestHandler => {
      assertRequested(required, 'requireScope');

      return asyncHandler(async (req, _res, next) => {
        const held = await resolveScopes(req);
        const missing = required.filter((scope) => !held.includes(scope));

        if (missing.length > 0) deny(req, held, missing);
        next();
      });
    },

    /**
     * Require AT LEAST ONE of the listed scopes.
     *
     * For an endpoint two different kinds of privileged user may reach by different routes.
     * On denial the whole set is reported as missing, because any one of them would have
     * sufficed and naming a single one would misstate the requirement.
     */
    requireAnyScope: (...required: readonly Scope[]): RequestHandler => {
      assertRequested(required, 'requireAnyScope');

      return asyncHandler(async (req, _res, next) => {
        const held = await resolveScopes(req);

        if (!required.some((scope) => held.includes(scope))) deny(req, held, required);
        next();
      });
    },
  };
}
