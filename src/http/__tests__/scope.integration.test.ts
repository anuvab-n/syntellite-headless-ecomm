import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appUser } from '../../db/schema/identity.js';
import { store } from '../../db/schema/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';
import { createIdentityRepository } from '../../modules/identity/identity.repository.js';
import { createIdentityRoutes } from '../../modules/identity/identity.routes.js';
import { createIdentityService } from '../../modules/identity/identity.service.js';
import { createRefreshSessionRepository } from '../../modules/identity/refresh-session.repository.js';
import { createPasswordResetRepository } from '../../modules/identity/password-reset.repository.js';
import { createTokenService } from '../../modules/identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../modules/stores/index.js';
import { newId } from '../../shared/id.js';
import { createApp } from '../app.js';
import { requireAuth, requireUser } from '../middleware/auth.js';
import { createScopeGuards, deriveScopes } from '../middleware/scope.js';
import { resolveStore } from '../middleware/store.js';
import { testRecorders } from '../../../tests/helpers/recording.ts';

/**
 * Scope-based authorization, against real PostgreSQL.
 *
 * No production route consumes these guards yet — Phase 2 catalogue writes are the first real
 * consumer — so this suite mounts its own protected routes. That is the honest way to test a
 * mechanism built ahead of its caller: the routes are obviously test fixtures rather than a
 * fake admin surface smuggled into the application.
 *
 * The property that matters most, and the reason authorization reads the database at all, is
 * the demotion test: a token minted while the caller was staff must stop working the moment the
 * flag is cleared, not when the token expires.
 */
describe('scope authorization (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const EMAIL = 'staff@example.com';

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
    storeId = (await seedTestStore(testDb)).id;
  });

  const db = () => testDb.handle.db;

  /** Counts loader calls, so "is this read lazy?" can be asserted rather than assumed. */
  let loads = 0;

  function build(slug = testDb.config.defaultStoreSlug) {
    loads = 0;
    const repository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });

    const identity = createIdentityService({
      repository,
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    // The same wiring the composition root uses, with a counter around the loader.
    const { requireScope, requireAnyScope } = createScopeGuards({
      loadSubject: async (params) => {
        loads += 1;
        return repository.findSubjectById(params);
      },
      logger: silentLogger,
    });

    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: createStoreRepository({ db: db() }),
          slug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );
    apiRouter.use(createIdentityRoutes({ identity, tokens, logger: silentLogger }));

    const auth = requireAuth({
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      logger: silentLogger,
    });
    const echo = (req: Parameters<typeof requireUser>[0], res: { json: (b: unknown) => void }) => {
      res.json({ scopes: requireUser(req).scopes ?? null });
    };

    // Test fixtures. Named `/t/...` so they cannot be mistaken for application routes.
    apiRouter.get('/t/staff', auth, requireScope('staff'), (req, res) => echo(req, res));
    apiRouter.get('/t/superuser', auth, requireScope('superuser'), (req, res) => echo(req, res));
    apiRouter.get('/t/both', auth, requireScope('staff', 'superuser'), (req, res) =>
      echo(req, res),
    );
    apiRouter.get('/t/any', auth, requireAnyScope('staff', 'superuser'), (req, res) =>
      echo(req, res),
    );
    // Authenticated but unscoped, to prove no loader call happens.
    apiRouter.get('/t/open', auth, (req, res) => echo(req, res));

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
    };
  }

  type App = ReturnType<typeof build>['app'];

  async function signIn(
    app: App,
    identity: ReturnType<typeof build>['identity'],
    flags: { isStaff?: boolean; isSuperuser?: boolean; email?: string } = {},
  ): Promise<{ accessToken: string; userId: string }> {
    const email = flags.email ?? EMAIL;
    const user = await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    // Registration always creates an unprivileged customer, so privileges are granted here —
    // which is also what an administrator would do.
    if (flags.isStaff || flags.isSuperuser) {
      await db()
        .update(appUser)
        .set({ isStaff: flags.isStaff ?? false, isSuperuser: flags.isSuperuser ?? false })
        .where(eq(appUser.id, user.id));
    }

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    return { accessToken: response.body.accessToken, userId: user.id };
  }

  const get = (app: App, path: string, token?: string) => {
    const req = request(app).get(`/api/v1${path}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  describe('deriveScopes', () => {
    it('maps the flags independently, with no implied hierarchy', () => {
      expect(deriveScopes({ isStaff: false, isSuperuser: false })).toEqual([]);
      expect(deriveScopes({ isStaff: true, isSuperuser: false })).toEqual(['staff']);
      expect(deriveScopes({ isStaff: true, isSuperuser: true })).toEqual(['staff', 'superuser']);
    });

    it('does NOT let superuser imply staff', () => {
      /**
       * The two columns are separate booleans in the schema. Quietly making one imply the other
       * would invent a privilege relationship the domain has never stated — the kind of
       * assumption that stays invisible until somebody is granted more than intended. A
       * deployment that wants the hierarchy sets both flags, which says so in the data.
       */
      expect(deriveScopes({ isStaff: false, isSuperuser: true })).toEqual(['superuser']);
      expect(deriveScopes({ isStaff: false, isSuperuser: true })).not.toContain('staff');
    });
  });

  describe('granting access', () => {
    it('allows a staff user through a staff guard', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      const response = await get(app, '/t/staff', accessToken);

      expect(response.status).toBe(200);
      expect(response.body.scopes).toEqual(['staff']);
    });

    it('allows a user holding both scopes through a guard requiring both', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true, isSuperuser: true });

      const response = await get(app, '/t/both', accessToken);

      expect(response.status).toBe(200);
      expect(response.body.scopes).toEqual(['staff', 'superuser']);
    });

    it('allows either scope through requireAnyScope', async () => {
      const { app, identity } = build();
      const staff = await signIn(app, identity, { isStaff: true, email: 'a@example.com' });
      const superuser = await signIn(app, identity, {
        isSuperuser: true,
        email: 'b@example.com',
      });

      expect((await get(app, '/t/any', staff.accessToken)).status).toBe(200);
      expect((await get(app, '/t/any', superuser.accessToken)).status).toBe(200);
    });

    it('attaches the fresh scopes to req.user for the handler', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isSuperuser: true });

      const response = await get(app, '/t/superuser', accessToken);

      // A handler downstream of a guard can branch on these — and only on these.
      expect(response.body.scopes).toEqual(['superuser']);
    });
  });

  describe('denying access', () => {
    it('denies an ordinary customer with 403 PERMISSION_DENIED', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      const response = await get(app, '/t/staff', accessToken);

      /**
       * 403, not 401. The caller IS authenticated and their account is fine — they simply lack
       * the privilege. Answering 401 would send a perfectly valid client off to re-authenticate,
       * which would succeed and change nothing.
       */
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('reports which scopes were required, not which are held', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      const response = await get(app, '/t/both', accessToken);

      expect(response.status).toBe(403);
      // Actionable: the client learns what it needs. It does NOT learn the caller's full
      // privilege set, which would leak the shape of an account to anyone who can provoke a 403.
      expect(response.body.error.details.missing).toEqual(['superuser']);
      expect(JSON.stringify(response.body)).not.toContain('staff');
    });

    it('denies superuser-only routes to staff, and vice versa', async () => {
      const { app, identity } = build();
      const staff = await signIn(app, identity, { isStaff: true, email: 'a@example.com' });
      const superuser = await signIn(app, identity, {
        isSuperuser: true,
        email: 'b@example.com',
      });

      // No hierarchy in either direction.
      expect((await get(app, '/t/superuser', staff.accessToken)).status).toBe(403);
      expect((await get(app, '/t/staff', superuser.accessToken)).status).toBe(403);
    });

    it('reports the whole set as missing when requireAnyScope denies', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      const response = await get(app, '/t/any', accessToken);

      // Any one would have sufficed, so naming a single scope would misstate the requirement.
      expect(response.status).toBe(403);
      expect(response.body.error.details.missing).toEqual(['staff', 'superuser']);
    });
  });

  describe('demotion takes effect immediately', () => {
    it('denies a demoted user on the very next request, with the same token', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { isStaff: true });

      expect((await get(app, '/t/staff', accessToken)).status).toBe(200);

      // An administrator revokes the flag. The token is untouched.
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, userId));

      const after = await get(app, '/t/staff', accessToken);

      /**
       * THE reason authorization reads the database. The access token still carries
       * `isStaff: true` and remains cryptographically valid for up to 15 more minutes — had the
       * guard trusted the claim, a revoked administrator would keep full privileges for that
       * entire window.
       */
      expect(after.status).toBe(403);
      expect(after.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('grants a promoted user immediately, without re-login', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      expect((await get(app, '/t/staff', accessToken)).status).toBe(403);

      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, userId));

      // Fresh state cuts both ways: a promotion does not require signing out and back in.
      expect((await get(app, '/t/staff', accessToken)).status).toBe(200);
    });

    it('does not trust the token claim even when the database disagrees', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, {
        isStaff: true,
        isSuperuser: true,
      });

      await db()
        .update(appUser)
        .set({ isStaff: false, isSuperuser: false })
        .where(eq(appUser.id, userId));

      // The token says both; the database says neither. The database wins.
      expect((await get(app, '/t/any', accessToken)).status).toBe(403);
      expect((await get(app, '/t/staff', accessToken)).status).toBe(403);
      expect((await get(app, '/t/superuser', accessToken)).status).toBe(403);
    });
  });

  describe('authentication failures come first', () => {
    it('rejects a missing token with 401 before any authorization check', async () => {
      const { app } = build();

      const response = await get(app, '/t/staff');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // No database read: the request never reached the guard.
      expect(loads).toBe(0);
    });

    it('rejects an invalid token with 401', async () => {
      const { app } = build();

      const response = await get(app, '/t/staff', 'not.a.jwt');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
      expect(loads).toBe(0);
    });

    it('returns 401, not 403, for a deactivated staff user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { isStaff: true });

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      const response = await get(app, '/t/staff', accessToken);

      /**
       * 401, matching `/users/me`. A suspended account is an authentication problem — the
       * credential no longer identifies a usable identity — not a permission problem. A 403
       * would tell a suspended administrator they merely lacked a privilege, which is both
       * wrong and a misleading hint.
       */
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 401 for a soft-deleted staff user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { isStaff: true });

      await db().update(appUser).set({ deletedAt: new Date() }).where(eq(appUser.id, userId));

      const response = await get(app, '/t/staff', accessToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('store isolation', () => {
    it('rejects a staff token presented to another store', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      await db()
        .insert(store)
        .values({ id: newId(), slug: 'second', name: 'Second', isActive: true });
      const { app: otherStoreApp } = build('second');

      const response = await get(otherStoreApp, '/t/staff', accessToken);

      // Rejected by `requireAuth` before authorization runs — staff in one tenant is not staff
      // in another, and the token cannot become so by being pointed at a different store.
      expect(response.status).toBe(401);
      expect(loads).toBe(0);
    });

    it('scopes the authorization read to the store', async () => {
      const { app, identity } = build();
      const { userId } = await signIn(app, identity, { isStaff: true });

      const foreignStoreId = newId();
      await db()
        .insert(store)
        .values({ id: foreignStoreId, slug: 'third', name: 'Third', isActive: true });

      const repository = createIdentityRepository({ db: db() });

      // The loader is store-scoped in the query, so a staff user in store A is invisible to a
      // lookup in store B even with a correct user id.
      expect(await repository.findSubjectById({ storeId: foreignStoreId, userId })).toBeUndefined();
      expect((await repository.findSubjectById({ storeId, userId }))?.isStaff).toBe(true);
    });
  });

  describe('the read is lazy', () => {
    it('does NOT load the subject on an authenticated but unscoped route', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      const response = await get(app, '/t/open', accessToken);

      expect(response.status).toBe(200);
      /**
       * The whole point of putting the read in `requireScope` rather than `requireAuth`. If this
       * were ever moved, every authenticated route in the application would silently start
       * paying for a database read it does not need — and nothing else in the suite would fail.
       */
      expect(loads).toBe(0);
      // And an unscoped route reports no scopes, rather than an empty array implying "none".
      expect(response.body.scopes).toBeNull();
    });

    it('loads exactly once per scoped request', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      await get(app, '/t/staff', accessToken);
      expect(loads).toBe(1);

      await get(app, '/t/staff', accessToken);
      expect(loads).toBe(2);
    });

    it('does not load the subject for /users/me', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { isStaff: true });

      const response = await get(app, '/users/me', accessToken);

      // `/users/me` does its own profile read; an authorization read on top would be a second
      // query for the same row.
      expect(response.status).toBe(200);
      expect(loads).toBe(0);
    });
  });

  describe('misuse fails loudly', () => {
    it('refuses to build a guard with no scopes', () => {
      const guards = createScopeGuards({
        loadSubject: async () => undefined,
        logger: silentLogger,
      });

      /**
       * Thrown at construction, so a mistake fails at boot rather than silently admitting every
       * caller. A guard with no scopes is far more likely to be a spread of an empty array than
       * a deliberate "any active user" check.
       */
      expect(() => guards.requireScope()).toThrow(/at least one scope/);
      expect(() => guards.requireAnyScope()).toThrow(/at least one scope/);
    });

    it('fails with a diagnosable error when mounted without requireAuth', async () => {
      const { requireScope } = createScopeGuards({
        loadSubject: async () => ({ isActive: true, isStaff: true, isSuperuser: false }),
        logger: silentLogger,
      });

      const apiRouter = Router();
      apiRouter.use(
        resolveStore({
          resolver: createDefaultStoreResolver({
            repository: createStoreRepository({ db: db() }),
            slug: testDb.config.defaultStoreSlug,
            logger: silentLogger,
            cacheTtlMs: 0,
          }),
          logger: silentLogger,
        }),
      );
      // Deliberately missing `requireAuth`.
      apiRouter.get('/t/broken', requireScope('staff'), (_req, res) => {
        res.json({ ok: true });
      });

      const app = createApp({
        config: testDb.config,
        logger: silentLogger,
        healthChecks: [],
        apiRouter,
      });

      const response = await request(app).get('/api/v1/t/broken');

      /**
       * 500, not 401 or 403. A router mounted without its middleware is OUR bug; reporting it
       * as an authorization failure would send someone off to check permissions while the real
       * fault sits in the composition root.
       */
      expect(response.status).toBe(500);
    });
  });
});
