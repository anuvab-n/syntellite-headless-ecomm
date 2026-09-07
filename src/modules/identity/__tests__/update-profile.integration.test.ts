import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appUser } from '../../../db/schema/identity.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { newId } from '../../../shared/id.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createIdentityRepository } from '../identity.repository.js';
import { createIdentityRoutes } from '../identity.routes.js';
import { createIdentityService } from '../identity.service.js';
import { createRefreshSessionRepository } from '../refresh-session.repository.js';
import { createTokenService } from '../tokens.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * PATCH /api/v1/users/me — against real PostgreSQL.
 *
 * The endpoint writes three harmless columns, so the interesting half of this suite is about
 * the columns it must NOT write. `strictObject` is a security boundary here rather than input
 * hygiene: `isStaff` and `isSuperuser` are privilege escalation, `storeId` is a tenancy
 * escape, `passwordHash` is account takeover, and `email` moves the login identifier past its
 * uniqueness index and verification state.
 *
 * Every rejection test therefore asserts on the ROW as well as the status. A 400 proves the
 * schema refused the request; only the row proves nothing was written on the way to refusing.
 */
describe('PATCH /api/v1/users/me (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const EMAIL = 'buyer@example.com';

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

  function build(slug = testDb.config.defaultStoreSlug) {
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const repository = createIdentityRepository({ db: db() });
    const identity = createIdentityService({
      repository,
      sessions: createRefreshSessionRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
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

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function givenUser(
    identity: Identity,
    overrides: { email?: string; firstName?: string; lastName?: string } = {},
  ): Promise<string> {
    const user = await identity.registerCustomer({
      storeId,
      input: {
        email: overrides.email ?? EMAIL,
        password: PASSWORD,
        firstName: overrides.firstName ?? 'Ada',
        lastName: overrides.lastName ?? 'Lovelace',
      },
    });
    return user.id;
  }

  async function signIn(app: App, email = EMAIL): Promise<string> {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  const patch = (app: App, accessToken: string | undefined, body: object) => {
    const req = request(app).patch('/api/v1/users/me');
    return (
      accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`)
    ).send(body);
  };

  /** The whole row, so a test can assert on any column the endpoint must not have touched. */
  const rowOf = async (userId: string) => {
    const [row] = await db().select().from(appUser).where(eq(appUser.id, userId));
    return row;
  };

  /* ── Authentication ────────────────────────────────────────────────────── */

  describe('authentication', () => {
    it('rejects an unauthenticated request', async () => {
      const { app, identity } = build();
      await givenUser(identity);

      const response = await patch(app, undefined, { firstName: 'Grace' });

      expect(response.status).toBe(401);
    });

    it('changes nothing when unauthenticated', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);

      await patch(app, undefined, { firstName: 'Grace' });

      // Asserted on the row: a 401 from the wrong middleware order could still have written.
      expect((await rowOf(userId))?.firstName).toBe('Ada');
    });

    it('rejects a malformed bearer token', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);

      expect((await patch(app, 'not-a-jwt', { firstName: 'Grace' })).status).toBe(401);
      expect((await rowOf(userId))?.firstName).toBe('Ada');
    });

    it('requires no staff scope', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const token = await signIn(app);

      /**
       * A plain customer, `isStaff = false`. A scope guard on this route would lock every
       * customer out of their own profile, so the 200 is the assertion.
       */
      expect((await patch(app, token, { firstName: 'Grace' })).status).toBe(200);
    });
  });

  /* ── The three writable fields ─────────────────────────────────────────── */

  describe('allowed fields', () => {
    it('updates firstName', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { firstName: 'Grace' });

      expect(response.status).toBe(200);
      expect(response.body.user.firstName).toBe('Grace');
      expect((await rowOf(userId))?.firstName).toBe('Grace');
    });

    it('updates lastName', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { lastName: 'Hopper' });

      expect(response.status).toBe(200);
      expect(response.body.user.lastName).toBe('Hopper');
      expect((await rowOf(userId))?.lastName).toBe('Hopper');
    });

    it('updates acceptsMarketing in both directions', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      // Registration defaults it to false, so both transitions are exercised rather than
      // assuming the interesting one.
      expect((await rowOf(userId))?.acceptsMarketing).toBe(false);

      const on = await patch(app, token, { acceptsMarketing: true });
      expect(on.body.user.acceptsMarketing).toBe(true);
      expect((await rowOf(userId))?.acceptsMarketing).toBe(true);

      const off = await patch(app, token, { acceptsMarketing: false });
      expect(off.body.user.acceptsMarketing).toBe(false);
      expect((await rowOf(userId))?.acceptsMarketing).toBe(false);
    });

    it('updates all three at once', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, {
        firstName: 'Grace',
        lastName: 'Hopper',
        acceptsMarketing: true,
      });

      expect(response.status).toBe(200);
      const row = await rowOf(userId);
      expect(row?.firstName).toBe('Grace');
      expect(row?.lastName).toBe('Hopper');
      expect(row?.acceptsMarketing).toBe(true);
    });

    it('trims a name', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      await patch(app, token, { firstName: '  Grace  ' });

      // Same normalisation registration applies, so a name cannot differ by whitespace
      // depending on which endpoint wrote it.
      expect((await rowOf(userId))?.firstName).toBe('Grace');
    });

    it('clears a name with an empty string', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { firstName: '' });

      // An empty string is a valid CLEAR to the column default, matching how the catalogue
      // treats a cleared description (§29). The column is NOT NULL, so it becomes ''.
      expect(response.status).toBe(200);
      expect(response.body.user.firstName).toBe('');
      expect((await rowOf(userId))?.firstName).toBe('');
    });

    it('bumps updatedAt', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);
      const before = (await rowOf(userId))?.updatedAt;

      await patch(app, token, { firstName: 'Grace' });

      expect((await rowOf(userId))?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before?.getTime() ?? 0,
      );
    });
  });

  /* ── Partial semantics ─────────────────────────────────────────────────── */

  describe('partial update', () => {
    it('preserves the fields the caller omitted', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity, { firstName: 'Ada', lastName: 'Lovelace' });
      const token = await signIn(app);
      await patch(app, token, { acceptsMarketing: true });

      // Only lastName is supplied. firstName and acceptsMarketing must survive untouched —
      // this is the test that fails if the service spreads the parsed body instead of
      // building the field set from explicit `!== undefined` checks.
      const response = await patch(app, token, { lastName: 'Hopper' });

      expect(response.status).toBe(200);
      const row = await rowOf(userId);
      expect(row?.firstName).toBe('Ada');
      expect(row?.lastName).toBe('Hopper');
      expect(row?.acceptsMarketing).toBe(true);
    });

    it('does not overwrite a name with an empty string when the field is absent', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity, { firstName: 'Ada', lastName: 'Lovelace' });
      const token = await signIn(app);

      await patch(app, token, { acceptsMarketing: true });

      /**
       * A regression guard rather than a mutation catcher, and worth being honest about why.
       *
       * Forwarding an omitted field as `firstName: undefined` does NOT corrupt the row: Drizzle
       * filters undefined out of the SET clause, so the generated SQL is identical. Mutating
       * the service to spread `input` therefore SURVIVES this suite — checked, not assumed.
       *
       * What this test does pin is the observable contract: an absent field keeps its stored
       * value. That has to hold whatever the driver does, and it would fail loudly if a future
       * change built the SET clause from a column list, coerced undefined to null, or moved to
       * a driver without that filtering.
       */
      const row = await rowOf(userId);
      expect(row?.firstName).toBe('Ada');
      expect(row?.lastName).toBe('Lovelace');
    });

    it('rejects an empty body rather than reporting a no-op success', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);
      const before = (await rowOf(userId))?.updatedAt;

      const response = await patch(app, token, {});

      // A PATCH that asks for nothing would bump `updated_at`, return 200, and leave the
      // caller believing something changed. Same rule as `UpdateProductRequestSchema` (§29).
      expect(response.status).toBe(400);
      expect((await rowOf(userId))?.updatedAt.getTime()).toBe(before?.getTime());
    });
  });

  /* ── Mass assignment — the security boundary ───────────────────────────── */

  describe('forbidden fields', () => {
    it('rejects isStaff', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { firstName: 'Grace', isStaff: true });

      expect(response.status).toBe(400);
      // Privilege escalation. The row assertion is the one that matters.
      expect((await rowOf(userId))?.isStaff).toBe(false);
      expect((await rowOf(userId))?.firstName).toBe('Ada');
    });

    it('rejects isSuperuser', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { isSuperuser: true });

      expect(response.status).toBe(400);
      expect((await rowOf(userId))?.isSuperuser).toBe(false);
    });

    it('rejects storeId', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, {
        firstName: 'Grace',
        storeId: newId(),
      });

      // A tenancy escape: a user who could rewrite their own `store_id` would appear in
      // another merchant's customer list.
      expect(response.status).toBe(400);
      expect((await rowOf(userId))?.storeId).toBe(storeId);
    });

    it('rejects passwordHash', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);
      const before = (await rowOf(userId))?.passwordHash;

      const response = await patch(app, token, { passwordHash: 'injected-hash' });

      // Account takeover: setting a hash directly would bypass the current-password check that
      // `POST /users/me/password` exists to enforce.
      expect(response.status).toBe(400);
      expect((await rowOf(userId))?.passwordHash).toBe(before);
    });

    it('rejects email', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { email: 'attacker@example.com' });

      // The login identifier, carrying a uniqueness index and a verification timestamp.
      // Changing it is a verification flow, not a profile field.
      expect(response.status).toBe(400);
      expect((await rowOf(userId))?.email).toBe(EMAIL);
    });

    it('rejects every other unlisted column', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);
      const before = await rowOf(userId);

      /**
       * The complete list of columns a request must not reach, each tried alongside a valid
       * field so the rejection cannot be attributed to an otherwise-empty body.
       */
      for (const forbidden of [
        { id: newId() },
        { isActive: false },
        { phone: '+91 90000 00000' },
        { emailVerifiedAt: new Date().toISOString() },
        { phoneVerifiedAt: new Date().toISOString() },
        { lastLoginAt: new Date().toISOString() },
        { deletedAt: new Date().toISOString() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { emailVerified: true },
        { userId: newId() },
        { firstname: 'wrong-case' },
        { accepts_marketing: true },
      ]) {
        const response = await patch(app, token, { firstName: 'Grace', ...forbidden });
        expect(response.status, JSON.stringify(forbidden)).toBe(400);
      }

      // Nothing was written across all of those attempts, including the valid `firstName`
      // that accompanied each one.
      const after = await rowOf(userId);
      expect(after).toEqual(before);
    });

    it('names the rejected field in the error', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { isStaff: true });

      // A 400 that says which field is what distinguishes "we refused" from "we ignored it".
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('isStaff');
    });

    it('rejects wrongly typed allowed fields', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);
      const before = await rowOf(userId);

      for (const body of [
        { firstName: 123 },
        { firstName: null },
        { lastName: ['Hopper'] },
        { acceptsMarketing: 'true' },
        { acceptsMarketing: 1 },
        { firstName: 'x'.repeat(151) },
      ]) {
        expect((await patch(app, token, body)).status, JSON.stringify(body)).toBe(400);
      }

      expect(await rowOf(userId)).toEqual(before);
    });
  });

  /* ── Response shape and isolation ──────────────────────────────────────── */

  describe('response and isolation', () => {
    it('returns exactly the established public user shape', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { firstName: 'Grace' });

      // The SAME key set `toUserResponse` produces for register, login, and GET /users/me.
      expect(Object.keys(response.body).sort()).toEqual(['user']);
      expect(Object.keys(response.body.user).sort()).toEqual([
        'acceptsMarketing',
        'createdAt',
        'email',
        'emailVerified',
        'firstName',
        'id',
        'lastName',
        'phone',
      ]);
    });

    it('leaks no credential or internal material', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      const response = await patch(app, token, { firstName: 'Grace' });

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain((await rowOf(userId))?.passwordHash ?? 'never');
      expect(serialised).not.toContain(storeId);
      for (const leaked of [
        'passwordHash',
        'storeId',
        'isStaff',
        'isSuperuser',
        'isActive',
        'deletedAt',
        'lastLoginAt',
      ]) {
        expect(serialised, leaked).not.toContain(leaked);
      }
    });

    it('agrees with GET /users/me afterwards', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const token = await signIn(app);

      const patched = await patch(app, token, { firstName: 'Grace', acceptsMarketing: true });
      const fetched = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`);

      // Two endpoints, one representation. A divergence here means a client would see the
      // update and then see it undone on the next read.
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(patched.body);
    });

    it('cannot modify ANOTHER user record', async () => {
      const { app, identity } = build();
      await givenUser(identity, { email: EMAIL, firstName: 'Ada' });
      const bystanderId = await givenUser(identity, {
        email: 'bystander@example.com',
        firstName: 'Alan',
      });
      const token = await signIn(app, EMAIL);
      const before = await rowOf(bystanderId);

      /**
       * The body names the other user three ways. All are unknown fields, so this is a 400 —
       * but the row assertion is the point: a schema change that began accepting one of these
       * must not silently start honouring it.
       */
      await patch(app, token, {
        firstName: 'Grace',
        userId: bystanderId,
        id: bystanderId,
        sub: bystanderId,
      });

      expect(await rowOf(bystanderId)).toEqual(before);
    });

    it('updates only the token holder when two users are active', async () => {
      const { app, identity } = build();
      const callerId = await givenUser(identity, { email: EMAIL, firstName: 'Ada' });
      const bystanderId = await givenUser(identity, {
        email: 'bystander@example.com',
        firstName: 'Alan',
      });
      const token = await signIn(app, EMAIL);

      expect((await patch(app, token, { firstName: 'Grace' })).status).toBe(200);

      // The `user_id` predicate is load-bearing: without it this statement would rewrite every
      // row in the store, and only a second user can show that.
      expect((await rowOf(callerId))?.firstName).toBe('Grace');
      expect((await rowOf(bystanderId))?.firstName).toBe('Alan');
    });

    it('rejects a token for a deactivated user and writes nothing', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      const response = await patch(app, token, { firstName: 'Grace' });

      /**
       * A valid signature is not a valid account, matching `GET /users/me` (§21). The write is
       * rolled back rather than merely reported as failed — without the transaction the row
       * would carry the new name alongside the 401.
       */
      expect(response.status).toBe(401);
      expect((await rowOf(userId))?.firstName).toBe('Ada');
    });

    it('rejects a token for a soft-deleted user and writes nothing', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const token = await signIn(app);

      await db().update(appUser).set({ deletedAt: new Date() }).where(eq(appUser.id, userId));

      const response = await patch(app, token, { firstName: 'Grace' });

      // The SAME 401 as a deactivated account, so a caller cannot learn which happened.
      expect(response.status).toBe(401);
      expect((await rowOf(userId))?.firstName).toBe('Ada');
    });

    it('updates the profile in the service without any HTTP layer', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      await signIn(app);

      const updated = await identity.updateProfile({
        storeId,
        userId,
        input: { firstName: 'Grace', acceptsMarketing: true },
      });

      // The service is callable from a CLI or a test, so the behaviour lives there rather than
      // in the route.
      expect(updated.firstName).toBe('Grace');
      expect(updated.acceptsMarketing).toBe(true);
      expect((await rowOf(userId))?.lastName).toBe('Lovelace');
    });

    it('does not revoke any session', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const token = await signIn(app);
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });

      expect((await patch(app, token, { firstName: 'Grace' })).status).toBe(200);

      // A profile edit is not a credential rotation. Only a password change revokes sessions.
      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(refreshed.status).toBe(200);
    });
  });
});
