import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appUser, refreshSession } from '../../../db/schema/identity.js';
import { store } from '../../../db/schema/store.js';
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
import { createPasswordResetRepository } from '../password-reset.repository.js';
import { createTokenService } from '../tokens.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * GET /api/v1/users/me — against real PostgreSQL.
 *
 * The endpoint is small; what these tests pin is the part that is easy to get wrong. Namely
 * that the response comes from the DATABASE rather than from the token's own claims, and that
 * a cryptographically valid token is not treated as proof of a valid account.
 */
describe('GET /api/v1/users/me (integration)', () => {
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
    const identity = createIdentityService({
      repository: createIdentityRepository({ db: db() }),
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
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
    };
  }

  type App = ReturnType<typeof build>['app'];

  async function signIn(
    app: App,
    identity: ReturnType<typeof build>['identity'],
    options: { email?: string; firstName?: string } = {},
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const email = options.email ?? EMAIL;

    await identity.registerCustomer({
      storeId,
      input: {
        email,
        password: PASSWORD,
        firstName: options.firstName ?? 'Ada',
        lastName: 'Lovelace',
      },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    return {
      accessToken: response.body.accessToken,
      refreshToken: response.body.refreshToken,
      userId: response.body.user.id,
    };
  }

  const me = (app: App, accessToken?: string) => {
    const req = request(app).get('/api/v1/users/me');
    return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`);
  };

  describe('successful lookup', () => {
    it('returns the authenticated user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      const response = await me(app, accessToken);

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(userId);
      expect(response.body.user.email).toBe(EMAIL);
      expect(response.body.user.firstName).toBe('Ada');
    });

    it('returns exactly the established public shape', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      const response = await me(app, accessToken);

      /**
       * The SAME key set `toUserResponse` produces for register and login, asserted exactly
       * rather than by presence. An exact set is what catches an ADDED field — which is how a
       * credential or an internal flag would actually leak, and which a per-field
       * `not.toHaveProperty` list would silently miss for any column added later.
       */
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
      // `{ user }`, matching the registration envelope rather than a bare object.
      expect(Object.keys(response.body)).toEqual(['user']);
    });

    it('matches the login response for the same user', async () => {
      const { app, identity } = build();
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send(
          await identity
            .registerCustomer({
              storeId,
              input: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
            })
            .then(() => ({ email: EMAIL, password: PASSWORD })),
        );

      const response = await me(app, login.body.accessToken);

      // One mapper, one shape. A second slightly-different user response is how clients end up
      // with two parsers that disagree about `emailVerified`.
      expect(response.body.user).toEqual(login.body.user);
    });

    it('exposes emailVerified as a boolean, not a timestamp', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await db().update(appUser).set({ emailVerifiedAt: new Date() }).where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      // WHEN an email was verified is internal; THAT it is verified is what a client renders.
      expect(response.body.user.emailVerified).toBe(true);
      expect(response.body.user).not.toHaveProperty('emailVerifiedAt');
    });
  });

  describe('the database is the source of truth', () => {
    it('returns an updated name rather than the value current when the token was issued', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { firstName: 'Ada' });

      await db()
        .update(appUser)
        .set({ firstName: 'Grace', lastName: 'Hopper' })
        .where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      /**
       * THE point of this endpoint. The access token is unchanged and still carries whatever it
       * carried at login; if this returned claims, a client would show the old name for up to
       * 15 minutes with no way to tell it was stale.
       */
      expect(response.body.user.firstName).toBe('Grace');
      expect(response.body.user.lastName).toBe('Hopper');
    });

    it('reflects an updated marketing preference and phone', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await db()
        .update(appUser)
        .set({ acceptsMarketing: true, phone: '+15550100' })
        .where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      expect(response.body.user.acceptsMarketing).toBe(true);
      expect(response.body.user.phone).toBe('+15550100');
    });

    it('reflects an updated email', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await db()
        .update(appUser)
        .set({ email: 'changed@example.com' })
        .where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      // The email is not a token claim at all, but asserting it makes the source explicit.
      expect(response.body.user.email).toBe('changed@example.com');
    });
  });

  describe('a valid token is not a valid account', () => {
    it('rejects a deactivated user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      /**
       * The token still verifies — signature, issuer, audience, expiry all fine. What changed is
       * the account, and the honest answer is that this credential no longer identifies a usable
       * identity. Returning the token's claims here would present a suspended account as active.
       */
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // And no profile data leaks alongside the error.
      expect(response.body).not.toHaveProperty('user');
      expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    });

    it('rejects a soft-deleted user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await db().update(appUser).set({ deletedAt: new Date() }).where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      // Excluded by the repository's `deleted_at IS NULL` predicate — erasure must mean the
      // account cannot be read back, not merely that it cannot log in.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects a hard-deleted user', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      // Sessions first — the FK cascades, but being explicit keeps the test's intent clear.
      await db().delete(refreshSession).where(eq(refreshSession.userId, userId));
      await db().delete(appUser).where(eq(appUser.id, userId));

      const response = await me(app, accessToken);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('does not distinguish deactivated from deleted', async () => {
      const { app, identity } = build();
      const deactivated = await signIn(app, identity, { email: 'a@example.com' });
      const deleted = await signIn(app, identity, { email: 'b@example.com' });

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, deactivated.userId));
      await db()
        .update(appUser)
        .set({ deletedAt: new Date() })
        .where(eq(appUser.id, deleted.userId));

      const first = await me(app, deactivated.accessToken);
      const second = await me(app, deleted.accessToken);

      // A caller must not learn WHY their account stopped working from this endpoint.
      expect(first.status).toBe(second.status);
      expect(first.body.error.code).toBe(second.body.error.code);
      expect(first.body.error.message).toBe(second.body.error.message);
    });

    it('still works for a user whose session was logged out', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const response = await me(app, accessToken);

      /**
       * 200, deliberately, and this documents the trade-off rather than hiding it.
       *
       * Access tokens are stateless and stay valid until `exp` — a decision recorded in
       * DECISIONS §20. Logout revokes refresh capability, not the outstanding access token.
       * Making this 401 would require a per-request session-revocation lookup, which is a
       * separate architectural change and explicitly out of scope for this increment.
       *
       * The ACCOUNT is still active, so the account check above correctly passes.
       */
      expect(response.status).toBe(200);
    });
  });

  describe('authentication is required', () => {
    it('rejects a request with no Authorization header', async () => {
      const { app, identity } = build();
      await signIn(app, identity);

      const response = await me(app);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      expect(response.body).not.toHaveProperty('user');
    });

    it('rejects malformed Authorization headers', async () => {
      const { app } = build();

      for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc123', 'token-with-no-scheme']) {
        const response = await request(app).get('/api/v1/users/me').set('Authorization', header);

        // Existing middleware behaviour, unchanged by this increment.
        expect(response.status, `header: "${header}"`).toBe(401);
        expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      }
    });

    it('rejects an invalid or tampered access token', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);
      /**
       * Flip a character INSIDE the signature, never at its end.
       *
       * The obvious version of this test — flip the last character — is silently unreliable.
       * An RS256 signature is 256 bytes, and 256 = 85*3 + 1, so the final base64url group
       * encodes ONE byte across TWO characters: six significant bits then two, leaving four
       * unused. Fifteen of the sixty-three other final characters therefore decode to the
       * IDENTICAL signature, and the "tampered" token verifies correctly about a quarter of
       * the time. This suite passed by luck until a run where it did not.
       *
       * The first character of the signature carries six significant bits of byte zero, so
       * flipping it always changes the decoded value.
       */
      const [header, payload, signature] = accessToken.split('.');
      const flippedFirst = signature?.startsWith('A') === true ? 'B' : 'A';
      const tampered = `${header}.${payload}.${flippedFirst}${signature?.slice(1) ?? ''}`;

      for (const token of [tampered, 'not.a.jwt', 'aaaa', `${accessToken}extra`]) {
        const response = await me(app, token);

        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
      }
    });

    it('rejects an expired access token', async () => {
      const { app, identity } = build();
      await signIn(app, identity);

      const { SignJWT, importPKCS8 } = await import('jose');
      const key = await importPKCS8(testDb.config.jwtPrivateKey, 'RS256');
      const expired = await new SignJWT({
        storeId,
        isStaff: false,
        isSuperuser: false,
        sid: newId(),
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(newId())
        .setIssuer(testDb.config.jwtIssuer)
        .setAudience(testDb.config.jwtAudience)
        .setJti(newId())
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3_600)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1_800)
        .sign(key);

      // Signed with the REAL key, so this pins expiry enforcement specifically rather than
      // signature verification.
      const response = await me(app, expired);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });
  });

  describe('store isolation', () => {
    it('rejects a token issued for a different store', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      await db()
        .insert(store)
        .values({ id: newId(), slug: 'second', name: 'Second', isActive: true });
      const { app: otherStoreApp } = build('second');

      const response = await request(otherStoreApp)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // No profile data in the failure response.
      expect(response.body).not.toHaveProperty('user');
      expect(JSON.stringify(response.body)).not.toContain(EMAIL);
    });

    it('enforces store scoping in the REPOSITORY, not only in middleware', async () => {
      const { app, identity } = build();
      const { userId } = await signIn(app, identity);

      const foreignStoreId = newId();
      await db()
        .insert(store)
        .values({ id: foreignStoreId, slug: 'third', name: 'Third', isActive: true });

      const repository = createIdentityRepository({ db: db() });

      /**
       * Called directly, bypassing every middleware. This is the point: if the store predicate
       * lived only in `requireAuth`, this would return the row — and any future caller reaching
       * the repository by another route (a CLI command, an admin endpoint, a job) would leak
       * across tenants. The guarantee has to be in the query.
       */
      const foreign = await repository.findSubjectById({ storeId: foreignStoreId, userId });
      expect(foreign).toBeUndefined();

      // Same id, correct store: found. Proves the id itself is valid and the store did the work.
      const own = await repository.findSubjectById({ storeId, userId });
      expect(own?.id).toBe(userId);
    });

    it('does not select passwordHash', async () => {
      const { app, identity } = build();
      const { userId } = await signIn(app, identity);

      const repository = createIdentityRepository({ db: db() });
      const subject = await repository.findSubjectById({ storeId, userId });

      /**
       * Asserted at the REPOSITORY, not the response. The response mapper is an allowlist and
       * would strip a hash anyway — but "never loaded" is a stronger property than "stripped
       * before sending": a hash in memory can be logged, serialised into an error, or picked up
       * by a future field-spreading bug.
       */
      expect(subject).toBeDefined();
      expect(subject).not.toHaveProperty('passwordHash');
      expect(Object.keys(subject ?? {})).not.toContain('passwordHash');
    });
  });

  describe('user isolation', () => {
    it('returns only the authenticated user when several exist', async () => {
      const { app, identity } = build();
      const userA = await signIn(app, identity, { email: 'a@example.com', firstName: 'Alice' });
      const userB = await signIn(app, identity, { email: 'b@example.com', firstName: 'Bob' });

      const asA = await me(app, userA.accessToken);
      const asB = await me(app, userB.accessToken);

      expect(asA.body.user.id).toBe(userA.userId);
      expect(asA.body.user.email).toBe('a@example.com');
      // A's response must contain no trace of B.
      expect(JSON.stringify(asA.body)).not.toContain('b@example.com');
      expect(JSON.stringify(asA.body)).not.toContain('Bob');

      expect(asB.body.user.id).toBe(userB.userId);
      expect(asB.body.user.email).toBe('b@example.com');
    });

    it('ignores every request-controlled attempt to select another user', async () => {
      const { app, identity } = build();
      const userA = await signIn(app, identity, { email: 'a@example.com' });
      const userB = await signIn(app, identity, { email: 'b@example.com' });

      /**
       * There is no parameter to override, and these assertions record that as a property
       * rather than an assumption. `me` is not a placeholder — the id comes from the `sub`
       * claim, so a query string has nothing to bind to.
       */
      const attempts = [
        `/api/v1/users/me?userId=${userB.userId}`,
        `/api/v1/users/me?id=${userB.userId}`,
        `/api/v1/users/me?storeId=${newId()}`,
        `/api/v1/users/me?email=b@example.com`,
      ];

      for (const path of attempts) {
        const response = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${userA.accessToken}`);

        expect(response.status, path).toBe(200);
        expect(response.body.user.id, path).toBe(userA.userId);
      }

      // A body on a GET is equally inert.
      const withBody = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ userId: userB.userId });
      expect(withBody.body.user.id).toBe(userA.userId);
    });

    it('has no route that accepts a user id', async () => {
      const { app, identity } = build();
      const userA = await signIn(app, identity, { email: 'a@example.com' });
      const userB = await signIn(app, identity, { email: 'b@example.com' });

      // The obvious adjacent shape does not exist, so there is nothing to authorize.
      const response = await request(app)
        .get(`/api/v1/users/${userB.userId}`)
        .set('Authorization', `Bearer ${userA.accessToken}`);

      expect(response.status).toBe(404);
    });
  });

  describe('no credential leakage', () => {
    it('returns no credential or internal field', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken, userId } = await signIn(app, identity);

      const response = await me(app, accessToken);
      const serialised = JSON.stringify(response.body);

      /**
       * Every column on `app_user` that is NOT part of the public shape, named explicitly. A
       * generic "does not contain a hash" check would pass by accident; this fails if any one of
       * them is ever added to the mapper.
       */
      for (const field of [
        'passwordHash',
        'password_hash',
        'storeId',
        'isActive',
        'isStaff',
        'isSuperuser',
        'phoneVerifiedAt',
        'lastLoginAt',
        'deletedAt',
        'updatedAt',
      ]) {
        expect(response.body.user, field).not.toHaveProperty(field);
      }

      // And no token material of any kind.
      expect(serialised).not.toContain(refreshToken);
      expect(serialised).not.toContain(accessToken);
      expect(serialised).not.toContain('tokenHash');
      expect(serialised).not.toContain('sessionId');
      expect(serialised).not.toContain('familyId');

      // Belt and braces: the actual stored hash must not appear anywhere in the response.
      const [row] = await db()
        .select({ passwordHash: appUser.passwordHash })
        .from(appUser)
        .where(eq(appUser.id, userId));
      expect(row?.passwordHash).toBeTruthy();
      expect(serialised).not.toContain(row?.passwordHash ?? 'unreachable');
      // An Argon2 PHC string always starts with this; a truncated leak would still be caught.
      expect(serialised).not.toContain('$argon2');
    });

    it('returns no refresh session information', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      const [session] = await db()
        .select({ id: refreshSession.id, tokenHash: refreshSession.tokenHash })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));

      const response = await me(app, accessToken);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain(session?.id ?? 'unreachable');
      expect(serialised).not.toContain(session?.tokenHash ?? 'unreachable');
    });
  });
});
