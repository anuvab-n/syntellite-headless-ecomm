import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { appUser, refreshSession } from '../../../db/schema/identity.js';
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
import { hashPassword } from '../password.js';
import { createRefreshSessionRepository } from '../refresh-session.repository.js';
import { createPasswordResetRepository } from '../password-reset.repository.js';
import { hashRefreshToken } from '../refresh-token.js';
import { createTokenService } from '../tokens.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * POST /api/v1/auth/login, against real PostgreSQL.
 *
 * Assembled the way the composition root assembles it — repository → sessions → tokens →
 * service → routes, with `resolveStore` on the API router — so the wiring under test is the
 * wiring production uses. Real Argon2, real RS256 signatures, real unique indexes.
 */
describe('POST /api/v1/auth/login (integration)', () => {
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

  /** The production assembly. `overrides` let one test inject a failing collaborator. */
  function build(overrides: { failLastLogin?: boolean; forceCollisions?: number } = {}) {
    const repository = createIdentityRepository({ db: db() });
    const sessions = createRefreshSessionRepository({ db: db() });
    const passwordResets = createPasswordResetRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });

    const identity = createIdentityService({
      repository,
      sessions,
      passwordResets,
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...overrides,
      ...testRecorders(db()),
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
    apiRouter.use(createIdentityRoutes({ identity, tokens, logger: silentLogger }));

    return {
      app: createApp({
        config: testDb.config,
        logger: silentLogger,
        healthChecks: [],
        apiRouter,
      }),
      identity,
      repository,
      tokens,
    };
  }

  /**
   * Insert a user directly rather than going through `/auth/register`.
   *
   * Lets a test control `isActive` and `deletedAt`, which registration deliberately does not
   * expose. The password is hashed with the real utility, so verification is genuine.
   */
  async function createUser(
    overrides: {
      email?: string;
      password?: string;
      isActive?: boolean;
      isStaff?: boolean;
      isSuperuser?: boolean;
      deletedAt?: Date | null;
      storeId?: string;
      passwordHash?: string;
    } = {},
  ): Promise<string> {
    const id = newId();
    await db()
      .insert(appUser)
      .values({
        id,
        storeId: overrides.storeId ?? storeId,
        email: overrides.email ?? EMAIL,
        passwordHash:
          overrides.passwordHash ?? (await hashPassword(overrides.password ?? PASSWORD)),
        firstName: 'Ada',
        lastName: 'Lovelace',
        isActive: overrides.isActive ?? true,
        isStaff: overrides.isStaff ?? false,
        isSuperuser: overrides.isSuperuser ?? false,
        deletedAt: overrides.deletedAt ?? null,
      });
    return id;
  }

  const login = (body: object, app = build().app) =>
    request(app).post('/api/v1/auth/login').send(body);

  const validBody = { email: EMAIL, password: PASSWORD };

  /* ── Success ───────────────────────────────────────────────────────────── */

  describe('success', () => {
    it('returns 200 with the documented contract and nothing else', async () => {
      await createUser();

      const response = await login(validBody);

      expect(response.status).toBe(200);
      // An exact key set: no familyId, no sessionId, no token hash, no session expiry.
      expect(Object.keys(response.body).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
        'user',
      ]);
      expect(response.body.tokenType).toBe('Bearer');
      expect(response.body.expiresIn).toBe(testDb.config.jwtAccessTtlMinutes * 60);
    });

    it('returns the user in the same shape registration does', async () => {
      await createUser();

      const response = await login(validBody);

      expect(response.body.user).toEqual({
        id: expect.any(String),
        email: EMAIL,
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: null,
        emailVerified: false,
        acceptsMarketing: false,
        createdAt: expect.any(String),
      });
    });

    it('issues an access token the token service accepts', async () => {
      const userId = await createUser({ isStaff: true, isSuperuser: true });
      const { app, tokens } = build();

      const response = await login(validBody, app);
      const verified = await tokens.verifyAccessToken(response.body.accessToken as string);

      // Privilege claims come from the DATABASE row, never from the request.
      expect(verified.userId).toBe(userId);
      expect(verified.storeId).toBe(storeId);
      expect(verified.isStaff).toBe(true);
      expect(verified.isSuperuser).toBe(true);
    });

    it("sets the token's sid to the persisted session id", async () => {
      await createUser();
      const { app, tokens } = build();

      const response = await login(validBody, app);
      const verified = await tokens.verifyAccessToken(response.body.accessToken as string);
      const [session] = await db().select().from(refreshSession);

      // The link that lets a future increment revoke a session's access tokens.
      expect(verified.sessionId).toBe(session?.id);
    });

    it('persists a session bound to the right store, user, and family', async () => {
      const userId = await createUser();

      await login(validBody);
      const [session] = await db().select().from(refreshSession);

      expect(session?.storeId).toBe(storeId);
      expect(session?.userId).toBe(userId);
      expect(session?.familyId).toEqual(expect.any(String));
      // A fresh login starts a new family; it is not yet consumed or revoked.
      expect(session?.consumedAt).toBeNull();
      expect(session?.revokedAt).toBeNull();
      expect(session?.revokedReason).toBeNull();
    });

    it('sets session expiry from the configured refresh TTL', async () => {
      await createUser();
      const before = Date.now();

      await login(validBody);
      const [session] = await db().select().from(refreshSession);

      const expectedMs = testDb.config.jwtRefreshTtlDays * 24 * 60 * 60 * 1000;
      const actualMs = (session?.expiresAt.getTime() ?? 0) - before;
      // Generous window: the assertion is that the TTL came from config, not a hard-coded 30.
      expect(actualMs).toBeGreaterThan(expectedMs - 10_000);
      expect(actualMs).toBeLessThanOrEqual(expectedMs + 1_000);
    });

    it('updates lastLoginAt', async () => {
      const userId = await createUser();

      const [before] = await db().select().from(appUser).where(eq(appUser.id, userId));
      expect(before?.lastLoginAt).toBeNull();

      await login(validBody);

      const [after] = await db().select().from(appUser).where(eq(appUser.id, userId));
      expect(after?.lastLoginAt).toBeInstanceOf(Date);
    });

    it('records user agent and client IP', async () => {
      await createUser();

      await request(build().app)
        .post('/api/v1/auth/login')
        .set('user-agent', 'IntegrationTest/1.0')
        .send(validBody);

      const [session] = await db().select().from(refreshSession);
      expect(session?.userAgent).toBe('IntegrationTest/1.0');
      // Supertest connects over loopback; the value is whatever Express derived, not a header
      // we parsed ourselves.
      expect(session?.ipAddress).toBeTruthy();
    });

    it('truncates an oversized user agent rather than failing the login', async () => {
      await createUser();

      const response = await request(build().app)
        .post('/api/v1/auth/login')
        .set('user-agent', 'U'.repeat(2_000))
        .send(validBody);

      // A weird UA must never prevent sign-in; the column is varchar(512).
      expect(response.status).toBe(200);
      const [session] = await db().select().from(refreshSession);
      expect(session?.userAgent).toHaveLength(512);
    });
  });

  /* ── Refresh token handling ────────────────────────────────────────────── */

  describe('refresh token', () => {
    it('returns an opaque token that is never persisted raw', async () => {
      await createUser();

      const response = await login(validBody);
      const raw = response.body.refreshToken as string;
      const [session] = await db().select().from(refreshSession);

      // 32 bytes of CSPRNG, base64url.
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // The database holds a digest, not the credential.
      expect(session?.tokenHash).not.toBe(raw);
      expect(session?.tokenHash).toHaveLength(64);
      expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores exactly hashRefreshToken(rawToken)', async () => {
      await createUser();

      const response = await login(validBody);
      const [session] = await db().select().from(refreshSession);

      // The property the refresh endpoint will depend on: hashing the presented token must
      // find this row.
      expect(session?.tokenHash).toBe(hashRefreshToken(response.body.refreshToken as string));
    });

    it('never writes the raw token into any column', async () => {
      await createUser();

      const response = await login(validBody);
      const raw = response.body.refreshToken as string;
      const [session] = await db().select().from(refreshSession);

      // Guards against a future column accidentally receiving it.
      expect(JSON.stringify(session)).not.toContain(raw);
    });
  });

  /* ── Invalid credentials — all identical ───────────────────────────────── */

  describe('invalid credentials', () => {
    /** Every rejection must be byte-identical. */
    async function expectGenericRejection(body: object, app?: ReturnType<typeof build>['app']) {
      const response = await login(body, app);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(response.body.error.message).toBe('Email or password is incorrect.');
      return response;
    }

    it('rejects an unknown email', async () => {
      await expectGenericRejection({ email: 'nobody@example.com', password: PASSWORD });
    });

    it('rejects a wrong password', async () => {
      await createUser();
      await expectGenericRejection({ email: EMAIL, password: 'wrong-but-long-enough' });
    });

    it('rejects an inactive user', async () => {
      await createUser({ isActive: false });
      await expectGenericRejection(validBody);
    });

    it('rejects a soft-deleted user', async () => {
      await createUser({ deletedAt: new Date() });
      await expectGenericRejection(validBody);
    });

    it('returns byte-identical responses for all four cases', async () => {
      await createUser({ email: 'active@example.com' });
      await createUser({ email: 'inactive@example.com', isActive: false });
      await createUser({ email: 'deleted@example.com', deletedAt: new Date() });

      const bodies = new Set<string>();
      for (const body of [
        { email: 'unknown@example.com', password: PASSWORD },
        { email: 'active@example.com', password: 'wrong-but-long-enough' },
        { email: 'inactive@example.com', password: PASSWORD },
        { email: 'deleted@example.com', password: PASSWORD },
      ]) {
        const response = await login(body);
        expect(response.status).toBe(401);
        // requestId differs per request; strip it so the rest can be compared exactly.
        const { requestId: _ignored, ...rest } = response.body.error as Record<string, unknown>;
        bodies.add(JSON.stringify(rest));
      }

      /**
       * ONE distinct body. Unknown, wrong-password, inactive, and deleted are externally
       * indistinguishable — the whole point, because any difference is an enumeration oracle.
       */
      expect(bodies.size).toBe(1);
    });

    it('creates no session and stamps no login on rejection', async () => {
      const userId = await createUser();

      await login({ email: EMAIL, password: 'wrong-but-long-enough' });

      expect(await db().select().from(refreshSession)).toHaveLength(0);
      const [user] = await db().select().from(appUser).where(eq(appUser.id, userId));
      expect(user?.lastLoginAt).toBeNull();
    });

    it('spends comparable time on an unknown email as on a wrong password', async () => {
      await createUser();

      // Warm the Argon2 addon and the dummy-hash memo so neither dominates the measurement.
      await login({ email: EMAIL, password: 'wrong-but-long-enough' });
      await login({ email: 'nobody@example.com', password: PASSWORD });

      const time = async (body: object): Promise<number> => {
        const started = Date.now();
        await login(body);
        return Date.now() - started;
      };

      const unknown = await time({ email: 'nobody@example.com', password: PASSWORD });
      const wrongPassword = await time({ email: EMAIL, password: 'wrong-but-long-enough' });

      /**
       * The dummy-hash verify is what makes these comparable. Without it the unknown-email
       * path skips Argon2 entirely and returns in ~1ms against ~50ms — a reliable oracle.
       *
       * Asserted as a loose FLOOR, not a tight ratio: wall-clock timing on a shared CI runner
       * is noisy, and a strict bound would be flaky. The floor still fails if the equaliser is
       * removed, which is the regression worth catching.
       */
      expect(unknown).toBeGreaterThan(wrongPassword * 0.25);
    }, 30_000);
  });

  /* ── Store isolation ───────────────────────────────────────────────────── */

  describe('store isolation', () => {
    it('refuses a user belonging to another store', async () => {
      // A second store with the SAME email and password.
      const otherStoreId = newId();
      await db()
        .insert((await import('../../../db/schema/store.js')).store)
        .values({ id: otherStoreId, slug: 'other-store', name: 'Other', currency: 'INR' });
      await createUser({ storeId: otherStoreId });

      // The resolver returns the DEFAULT store, where this user does not exist.
      const response = await login(validBody);

      expect(response.status).toBe(401);
      expect(await db().select().from(refreshSession)).toHaveLength(0);
    });

    it('authenticates the correct store when the email exists in both', async () => {
      const otherStoreId = newId();
      await db()
        .insert((await import('../../../db/schema/store.js')).store)
        .values({ id: otherStoreId, slug: 'other-store-2', name: 'Other', currency: 'INR' });

      const otherUserId = await createUser({ storeId: otherStoreId });
      const defaultUserId = await createUser();

      const response = await login(validBody);

      expect(response.status).toBe(200);
      // Resolved to the default store's user, not the other store's.
      expect(response.body.user.id).toBe(defaultUserId);
      expect(response.body.user.id).not.toBe(otherUserId);

      const [session] = await db().select().from(refreshSession);
      expect(session?.storeId).toBe(storeId);
    });
  });

  /* ── Normalisation and validation ──────────────────────────────────────── */

  describe('normalisation and validation', () => {
    it('accepts an email with different casing and surrounding whitespace', async () => {
      await createUser();

      const response = await login({ email: '  BUYER@Example.COM  ', password: PASSWORD });

      // Same normalisation as registration, so an address that registered can always log in.
      expect(response.status).toBe(200);
      expect(response.body.user.email).toBe(EMAIL);
    });

    it('does not trim the password', async () => {
      await createUser({ password: ' padded-password ' });

      // Whitespace is a legitimate password character; trimming would break a stored value.
      await expect(login({ email: EMAIL, password: ' padded-password ' })).resolves.toMatchObject({
        status: 200,
      });
      await expect(login({ email: EMAIL, password: 'padded-password' })).resolves.toMatchObject({
        status: 401,
      });
    });

    it('rejects unknown request fields', async () => {
      await createUser();

      const response = await login({ ...validBody, isStaff: true });

      // `strictObject`, consistent with registration.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a missing email or password', async () => {
      await expect(login({ password: PASSWORD })).resolves.toMatchObject({ status: 400 });
      await expect(login({ email: EMAIL })).resolves.toMatchObject({ status: 400 });
      await expect(login({})).resolves.toMatchObject({ status: 400 });
    });

    it('accepts a short password at the boundary and rejects it on verification', async () => {
      await createUser();

      // Login does NOT apply the 10-character registration policy — that would reject users
      // whose password predates a policy change, and would leak that short ones cannot exist.
      const response = await login({ email: EMAIL, password: 'short' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  /* ── Response hygiene ──────────────────────────────────────────────────── */

  describe('response hygiene', () => {
    it('never returns a password hash or session internals', async () => {
      await createUser();

      const response = await login(validBody);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('password_hash');
      expect(serialised).not.toContain(PASSWORD);
      // Persistence internals stay internal.
      expect(serialised).not.toContain('familyId');
      expect(serialised).not.toContain('tokenHash');
      expect(serialised).not.toContain('sessionId');
    });

    it('never returns the stored token hash', async () => {
      await createUser();

      const response = await login(validBody);
      const [session] = await db().select().from(refreshSession);

      expect(JSON.stringify(response.body)).not.toContain(session?.tokenHash ?? 'unreachable');
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  describe('concurrent logins', () => {
    it('creates independent sessions with distinct tokens and families', async () => {
      const userId = await createUser();
      const { app } = build();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => request(app).post('/api/v1/auth/login').send(validBody)),
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);

      const sessions = await db().select().from(refreshSession);
      expect(sessions).toHaveLength(5);
      expect(sessions.every((s) => s.userId === userId)).toBe(true);

      // Five devices, five independent sessions: distinct ids, hashes, and families. A shared
      // family would mean revoking one device revoked them all.
      expect(new Set(sessions.map((s) => s.id)).size).toBe(5);
      expect(new Set(sessions.map((s) => s.tokenHash)).size).toBe(5);
      expect(new Set(sessions.map((s) => s.familyId)).size).toBe(5);
      expect(new Set(responses.map((r) => r.body.refreshToken as string)).size).toBe(5);
    }, 60_000);
  });

  /* ── Password rehash upgrade ───────────────────────────────────────────── */

  describe('password rehash', () => {
    /** A valid Argon2id hash produced with weaker parameters than the current policy. */
    const WEAK_HASH =
      '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$4Nk8DjPjJUOb1S0YOaZUnBzGxvfyDkYCT1H3lYLQmXg';

    it('upgrades a hash stored under weaker parameters', async () => {
      // Hash the real password at weak settings so verification genuinely succeeds.
      const { hash } = await import('argon2');
      const weak = await hash(PASSWORD, {
        type: 2,
        memoryCost: 4_096,
        timeCost: 1,
        parallelism: 1,
      });
      const userId = await createUser({ passwordHash: weak });

      const response = await login(validBody);
      expect(response.status).toBe(200);

      const [user] = await db().select().from(appUser).where(eq(appUser.id, userId));
      // Re-hashed under current parameters, so passwords strengthen as users return.
      expect(user?.passwordHash).not.toBe(weak);
      expect(user?.passwordHash).toContain('m=19456');
    }, 30_000);

    it('leaves an already-current hash untouched', async () => {
      const userId = await createUser();
      const [before] = await db().select().from(appUser).where(eq(appUser.id, userId));

      await login(validBody);

      const [after] = await db().select().from(appUser).where(eq(appUser.id, userId));
      // No pointless write, and no new hash for the client to worry about.
      expect(after?.passwordHash).toBe(before?.passwordHash);
    });

    it('still succeeds when the rehash write fails', async () => {
      const { hash } = await import('argon2');
      const weak = await hash(PASSWORD, {
        type: 2,
        memoryCost: 4_096,
        timeCost: 1,
        parallelism: 1,
      });
      await createUser({ passwordHash: weak });

      const built = build();
      // Break only the rehash write. Everything else is the real implementation.
      vi.spyOn(built.repository, 'updatePasswordHash').mockRejectedValue(
        new Error('rehash write failed'),
      );

      const response = await request(built.app).post('/api/v1/auth/login').send(validBody);

      /**
       * The property that matters: a rehash problem must never turn a valid login into a
       * failed one. The upgrade is an optimisation; the login is the product.
       */
      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeTruthy();
      expect(await db().select().from(refreshSession)).toHaveLength(1);
    }, 30_000);

    it('does not rehash when verification fails', async () => {
      await createUser({ passwordHash: WEAK_HASH });

      // WEAK_HASH is not a hash of PASSWORD, so verification fails and no upgrade may happen.
      const response = await login(validBody);

      expect(response.status).toBe(401);
      const [user] = await db().select().from(appUser);
      expect(user?.passwordHash).toBe(WEAK_HASH);
    });
  });

  /* ── Failure consistency ───────────────────────────────────────────────── */

  describe('failure consistency', () => {
    it('leaves no session behind when the lastLoginAt write fails', async () => {
      const userId = await createUser();
      const built = build();

      // Break the second write inside the transaction. This is the real consistency question:
      // the session insert has already succeeded when this throws.
      vi.spyOn(built.repository, 'updateLastLoginAt').mockRejectedValue(
        new Error('lastLoginAt write failed'),
      );

      const response = await request(built.app).post('/api/v1/auth/login').send(validBody);

      // Fails as a 500 — an infrastructure fault, not a credential problem.
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');

      /**
       * The transaction rolled back, so there is NO session row. Without the transaction the
       * insert would have committed and the client would have received a refresh token whose
       * session was never fully established.
       */
      expect(await db().select().from(refreshSession)).toHaveLength(0);
      const [user] = await db().select().from(appUser).where(eq(appUser.id, userId));
      expect(user?.lastLoginAt).toBeNull();
    });

    it('returns no tokens when access-token issuance fails after commit', async () => {
      await createUser();
      const built = build();

      vi.spyOn(built.tokens, 'issueAccessToken').mockRejectedValue(new Error('signing failed'));

      const response = await request(built.app).post('/api/v1/auth/login').send(validBody);

      expect(response.status).toBe(500);
      // No credential reaches the client.
      expect(response.body.accessToken).toBeUndefined();
      expect(response.body.refreshToken).toBeUndefined();

      /**
       * The accepted trade-off, asserted rather than hidden: the session row IS committed,
       * because tokens are minted after commit deliberately — issuing a credential for state
       * that might roll back is worse. The orphan expires on its own and the client retries.
       */
      expect(await db().select().from(refreshSession)).toHaveLength(1);
    });

    /**
     * Collision retry is covered in `login-collision.integration.test.ts`.
     *
     * Forcing a collision requires stubbing `generateRefreshToken`, which needs a hoisted
     * module mock — and that applies to the whole file, so it would contaminate every test
     * here. A separate file is the honest way to get it.
     */
  });
});
