import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { appUser, refreshSession } from '../../../db/schema/identity.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createIdentityRepository } from '../identity.repository.js';
import { createIdentityRoutes } from '../identity.routes.js';
import { createIdentityService } from '../identity.service.js';
import { createRefreshSessionRepository } from '../refresh-session.repository.js';
import { createTokenService } from '../tokens.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * POST /api/v1/users/me/password — against real PostgreSQL.
 *
 * Two invariants carry this suite, and both are security properties rather than behaviour.
 *
 * First, the CURRENT password must be proven. Without that check a stolen access token — valid
 * for fifteen minutes — becomes a permanent account takeover, because the thief can set a
 * password the owner does not know and the revocation below then cuts every one of the owner's
 * sessions. Several tests therefore assert not just the 401 but that nothing changed.
 *
 * Second, revocation is USER-WIDE. Logout is deliberately family-scoped (§20), so the mutation
 * that matters most here is "revoke only the caller's family" — which passes trivially against
 * a fixture with one session. Every revocation test consequently establishes MULTIPLE
 * independent families for the same user, and a second user whose sessions must survive.
 */
describe('POST /api/v1/users/me/password (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const NEW_PASSWORD = 'an-even-longer-new-password';
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
    const sessions = createRefreshSessionRepository({ db: db() });
    const identity = createIdentityService({
      repository,
      sessions,
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
      sessions,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  /** Register a user. Separate from signing in, so a user can hold several sessions. */
  async function givenUser(identity: Identity, email = EMAIL): Promise<string> {
    const user = await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
    return user.id;
  }

  /**
   * Sign in, producing an INDEPENDENT refresh-token family.
   *
   * Called more than once per user on purpose: each login starts its own family, which is what
   * makes "revoke only the current family" a detectable mutation rather than an invisible one.
   */
  async function signIn(
    app: App,
    email = EMAIL,
    password = PASSWORD,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const response = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(response.status).toBe(200);
    return {
      accessToken: response.body.accessToken,
      refreshToken: response.body.refreshToken,
      userId: response.body.user.id,
    };
  }

  const changePassword = (app: App, accessToken: string | undefined, body: object) => {
    const req = request(app).post('/api/v1/users/me/password');
    return (
      accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`)
    ).send(body);
  };

  const validBody = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD };

  const hashOf = async (userId: string): Promise<string> => {
    const [row] = await db()
      .select({ passwordHash: appUser.passwordHash })
      .from(appUser)
      .where(eq(appUser.id, userId));
    return row?.passwordHash ?? '';
  };

  /** How many of this user's sessions are still live. The revocation assertion. */
  const liveSessionCount = async (userId: string): Promise<number> => {
    const rows = await db()
      .select({ id: refreshSession.id })
      .from(refreshSession)
      .where(and(eq(refreshSession.userId, userId), isNull(refreshSession.revokedAt)));
    return rows.length;
  };

  const familyCount = async (userId: string): Promise<number> => {
    const rows = await db()
      .select({ familyId: refreshSession.familyId })
      .from(refreshSession)
      .where(eq(refreshSession.userId, userId));
    return new Set(rows.map((r) => r.familyId)).size;
  };

  /* ── Authentication ────────────────────────────────────────────────────── */

  describe('authentication', () => {
    it('rejects an unauthenticated request', async () => {
      const { app, identity } = build();
      await givenUser(identity);

      const response = await changePassword(app, undefined, validBody);

      expect(response.status).toBe(401);
    });

    it('rejects a malformed bearer token', async () => {
      const { app, identity } = build();
      await givenUser(identity);

      const response = await changePassword(app, 'not-a-jwt', validBody);

      expect(response.status).toBe(401);
    });

    it('does not change any password when unauthenticated', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const before = await hashOf(userId);

      await changePassword(app, undefined, validBody);

      // The endpoint must not be reachable at all without a token — asserted on the row,
      // because a 401 from the wrong middleware ordering could still have run the handler.
      expect(await hashOf(userId)).toBe(before);
    });
  });

  /* ── The happy path ────────────────────────────────────────────────────── */

  describe('successful change', () => {
    it('returns 204 with no body', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      const response = await changePassword(app, accessToken, validBody);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(response.text).toBe('');
    });

    it('actually changes the stored password hash', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      const after = await hashOf(userId);
      expect(after).not.toBe(before);
      // Still a PHC-formatted Argon2id hash, not the plaintext and not an empty column.
      expect(after).toMatch(/^\$argon2id\$/);
      expect(after).not.toContain(NEW_PASSWORD);
    });

    it('lets the NEW password authenticate', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.accessToken).toBeTruthy();
    });

    it('stops the OLD password authenticating', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(401);
    });

    it('leaks no credential material in the response', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);

      const response = await changePassword(app, accessToken, validBody);

      /**
       * A 204 has no body, so this is belt-and-braces — but it is the assertion that would fail
       * if someone later "helpfully" returned the user, and the whole body is searched rather
       * than named keys so a nested hash cannot hide.
       */
      const serialised = JSON.stringify(response.body) + response.text;
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain(await hashOf(userId));
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain(NEW_PASSWORD);
      expect(serialised).not.toMatch(/passwordHash/i);
    });
  });

  /* ── Session revocation — the security invariant ───────────────────────── */

  describe('session revocation', () => {
    it('revokes EVERY family the user holds, not only the calling one', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);

      // Three independent logins — three families. A mutation that revokes only the caller's
      // family leaves two live sessions here, which the count below catches.
      const first = await signIn(app);
      await signIn(app);
      await signIn(app);

      expect(await familyCount(userId)).toBe(3);
      expect(await liveSessionCount(userId)).toBe(3);

      expect((await changePassword(app, first.accessToken, validBody)).status).toBe(204);

      expect(await liveSessionCount(userId)).toBe(0);
    });

    it('stamps the revocation reason distinctly from a logout', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);

      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      const rows = await db()
        .select({ reason: refreshSession.revokedReason })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));

      // A distinct reason, so the forensic trail can tell a credential rotation from a sign-out.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reason).toBe('password_change');
    });

    it('makes the caller OWN refresh token unusable', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken, refreshToken } = await signIn(app);

      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      // The honest consequence of revoking everything: the caller must sign in again. A 200
      // here would mean the revocation had not really happened.
      const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
      expect(refreshed.status).toBe(401);
    });

    it('makes every OTHER session refresh token unusable too', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const caller = await signIn(app);
      const otherDevice = await signIn(app);
      const thirdDevice = await signIn(app);

      expect((await changePassword(app, caller.accessToken, validBody)).status).toBe(204);

      for (const [label, token] of [
        ['other', otherDevice.refreshToken],
        ['third', thirdDevice.refreshToken],
      ] as const) {
        const refreshed = await request(app)
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: token });
        expect(refreshed.status, label).toBe(401);
      }
    });

    it('leaves ANOTHER user sessions completely untouched', async () => {
      const { app, identity } = build();
      const victimId = await givenUser(identity, EMAIL);
      const bystanderId = await givenUser(identity, 'bystander@example.com');

      const victim = await signIn(app, EMAIL);
      await signIn(app, EMAIL);
      const bystander = await signIn(app, 'bystander@example.com');
      await signIn(app, 'bystander@example.com');

      expect((await changePassword(app, victim.accessToken, validBody)).status).toBe(204);

      // The user-scoped predicate is load-bearing: without it this statement would revoke the
      // whole store's sessions, and only a second user can show that.
      expect(await liveSessionCount(victimId)).toBe(0);
      expect(await liveSessionCount(bystanderId)).toBe(2);

      // And the bystander's refresh token still works, not merely their row.
      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: bystander.refreshToken });
      expect(refreshed.status).toBe(200);
    });

    it('does not change ANOTHER user password', async () => {
      const { app, identity } = build();
      await givenUser(identity, EMAIL);
      const bystanderId = await givenUser(identity, 'bystander@example.com');
      const before = await hashOf(bystanderId);

      const { accessToken } = await signIn(app, EMAIL);
      expect((await changePassword(app, accessToken, validBody)).status).toBe(204);

      expect(await hashOf(bystanderId)).toBe(before);
    });

    it('revokes sessions in the REPOSITORY scoped to one user and store', async () => {
      const { app, identity, sessions } = build();
      const userId = await givenUser(identity, EMAIL);
      const bystanderId = await givenUser(identity, 'bystander@example.com');
      await signIn(app, EMAIL);
      await signIn(app, EMAIL);
      await signIn(app, 'bystander@example.com');

      /**
       * Called directly, bypassing every middleware. The store predicate has to hold at the
       * layer that builds the SQL, not only at the one that resolves the store — a wrong
       * argument here must not become a cross-tenant write.
       */
      const revoked = await sessions.revokeAllForUser({
        storeId,
        userId,
        reason: 'password_change',
        at: new Date(),
      });

      expect(revoked).toBe(2);
      expect(await liveSessionCount(userId)).toBe(0);
      expect(await liveSessionCount(bystanderId)).toBe(1);

      // Idempotent: a second call revokes nothing rather than re-stamping.
      expect(
        await sessions.revokeAllForUser({
          storeId,
          userId,
          reason: 'password_change',
          at: new Date(),
        }),
      ).toBe(0);
    });

    it('does not re-stamp a session already revoked by logout', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const loggedOut = await signIn(app);
      const caller = await signIn(app);

      expect(
        (
          await request(app)
            .post('/api/v1/auth/logout')
            .set('Authorization', `Bearer ${loggedOut.accessToken}`)
        ).status,
      ).toBe(204);

      expect((await changePassword(app, caller.accessToken, validBody)).status).toBe(204);

      const rows = await db()
        .select({ reason: refreshSession.revokedReason })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));

      // The `revoked_at IS NULL` predicate preserves history: the logged-out session keeps its
      // original reason rather than being overwritten as a password change.
      expect(rows.map((r) => r.reason).sort()).toEqual(['logout', 'password_change']);
    });
  });

  /* ── Wrong current password ────────────────────────────────────────────── */

  describe('incorrect current password', () => {
    it('is rejected with a 401', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      const response = await changePassword(app, accessToken, {
        currentPassword: 'not-the-right-password',
        newPassword: NEW_PASSWORD,
      });

      expect(response.status).toBe(401);
    });

    it('does NOT change the password', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      await changePassword(app, accessToken, {
        currentPassword: 'not-the-right-password',
        newPassword: NEW_PASSWORD,
      });

      expect(await hashOf(userId)).toBe(before);

      // And the original password still works — the strongest form of "nothing changed".
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });
      expect(login.status).toBe(200);
    });

    it('does NOT revoke any session', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      await signIn(app);

      await changePassword(app, accessToken, {
        currentPassword: 'not-the-right-password',
        newPassword: NEW_PASSWORD,
      });

      /**
       * A failed attempt must not be a denial-of-service against the account. If a wrong
       * current password still revoked sessions, anyone holding a stolen access token could log
       * the real owner out of every device repeatedly without ever knowing the password.
       */
      expect(await liveSessionCount(userId)).toBe(2);
    });

    it('rejects an empty current password without touching anything', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      const response = await changePassword(app, accessToken, {
        currentPassword: '',
        newPassword: NEW_PASSWORD,
      });

      // A 400 from validation, not a 401 — the request is malformed rather than wrong.
      expect(response.status).toBe(400);
      expect(await hashOf(userId)).toBe(before);
      expect(await liveSessionCount(userId)).toBe(1);
    });

    it('does not hold the CURRENT password to the new-password policy', async () => {
      const { app, identity, repository } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);

      /**
       * A user whose stored password is shorter than today's 10-character policy must still be
       * able to change it. Applying `passwordField` to `currentPassword` would return 400 here
       * and lock them out of the only endpoint that fixes it.
       *
       * The short password is installed directly through the repository, because registration
       * would rightly refuse it.
       */
      const { hashPassword } = await import('../password.js');
      const shortPassword = 'short-1';
      const rehashed = await hashPassword(shortPassword);
      expect(
        await repository.updatePasswordHash({
          storeId,
          userId,
          expectedCurrentHash: await hashOf(userId),
          passwordHash: rehashed,
        }),
      ).toBe(true);

      const response = await changePassword(app, accessToken, {
        currentPassword: shortPassword,
        newPassword: NEW_PASSWORD,
      });

      // Accepted: the policy governs the password being CHOSEN, not the one being presented.
      expect(response.status).toBe(204);
    });
  });

  /* ── Request validation ────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects unknown body fields', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);

      /**
       * `strictObject`. Each of these is either a probe for a mass-assignment hole or a badly
       * confused client, and both deserve to be told rather than silently ignored.
       */
      for (const extra of [
        { userId: 'someone-else' },
        { storeId: 'another-store' },
        { email: 'attacker@example.com' },
        { passwordHash: 'injected' },
        { isStaff: true },
        { refreshToken: 'spare-this-one' },
        { currentpassword: PASSWORD },
      ]) {
        const response = await changePassword(app, accessToken, { ...validBody, ...extra });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }

      // Nothing changed across all of those attempts.
      expect(await liveSessionCount(userId)).toBe(1);
    });

    it('requires both fields', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      for (const body of [
        {},
        { currentPassword: PASSWORD },
        { newPassword: NEW_PASSWORD },
      ] as const) {
        expect((await changePassword(app, accessToken, body)).status, JSON.stringify(body)).toBe(
          400,
        );
      }
    });

    it('applies the registration password policy to the new password', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      for (const newPassword of ['', 'short', 'nine-char', 'x'.repeat(129)]) {
        const response = await changePassword(app, accessToken, {
          currentPassword: PASSWORD,
          newPassword,
        });
        expect(response.status, `length ${String(newPassword.length)}`).toBe(400);
      }

      // Exactly 10 is the documented floor and must be accepted.
      expect(
        (
          await changePassword(app, accessToken, {
            currentPassword: PASSWORD,
            newPassword: '0123456789',
          })
        ).status,
      ).toBe(204);

      expect(await hashOf(userId)).not.toBe(before);
    });

    it('does not trim the new password', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      const padded = '  a-password-with-spaces  ';
      expect(
        (await changePassword(app, accessToken, { currentPassword: PASSWORD, newPassword: padded }))
          .status,
      ).toBe(204);

      // Whitespace is a legitimate password character; trimming it would silently change the
      // credential a password manager stored.
      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: padded });
      expect(login.status).toBe(200);

      const trimmed = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: padded.trim() });
      expect(trimmed.status).toBe(401);
    });

    it('rejects a non-string password', async () => {
      const { app, identity } = build();
      await givenUser(identity);
      const { accessToken } = await signIn(app);

      for (const body of [
        { currentPassword: PASSWORD, newPassword: 12345678901 },
        { currentPassword: null, newPassword: NEW_PASSWORD },
        { currentPassword: PASSWORD, newPassword: { toString: 'no' } },
      ]) {
        expect((await changePassword(app, accessToken, body)).status).toBe(400);
      }
    });
  });

  /* ── The subject cannot be redirected ──────────────────────────────────── */

  describe('subject resolution', () => {
    it('changes the TOKEN holder password, whatever the body claims', async () => {
      const { app, identity } = build();
      const callerId = await givenUser(identity, EMAIL);
      const bystanderId = await givenUser(identity, 'bystander@example.com');

      const callerBefore = await hashOf(callerId);
      const bystanderBefore = await hashOf(bystanderId);

      const { accessToken } = await signIn(app, EMAIL);

      /**
       * The body names another user in three different ways. All are unknown fields, so this is
       * a 400 rather than a redirected write — but the assertion is on the ROWS, because that
       * is the property that matters: a schema change that started accepting one of these must
       * not silently begin honouring it.
       */
      await changePassword(app, accessToken, {
        ...validBody,
        userId: bystanderId,
        sub: bystanderId,
        email: 'bystander@example.com',
      });

      expect(await hashOf(bystanderId)).toBe(bystanderBefore);
      expect(await hashOf(callerId)).toBe(callerBefore);
    });

    it('rejects a token for a user who has been deactivated', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      // A valid signature is not a valid account, matching `GET /users/me` (§21).
      const response = await changePassword(app, accessToken, validBody);

      expect(response.status).toBe(401);
      expect(await hashOf(userId)).toBe(before);
    });

    it('rejects a token for a user who has been soft-deleted', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      const { accessToken } = await signIn(app);
      const before = await hashOf(userId);

      await db().update(appUser).set({ deletedAt: new Date() }).where(eq(appUser.id, userId));

      const response = await changePassword(app, accessToken, validBody);

      // The SAME 401 as a deactivated account, so a caller cannot learn which happened.
      expect(response.status).toBe(401);
      expect(await hashOf(userId)).toBe(before);
    });

    it('changes the password in the service without any HTTP layer', async () => {
      const { app, identity } = build();
      const userId = await givenUser(identity);
      await signIn(app);
      await signIn(app);
      const before = await hashOf(userId);

      // The service is callable from a CLI or a test, so the invariant must live there rather
      // than in the route.
      await identity.changePassword({
        storeId,
        userId,
        input: validBody,
      });

      expect(await hashOf(userId)).not.toBe(before);
      expect(await liveSessionCount(userId)).toBe(0);
    });
  });
});
