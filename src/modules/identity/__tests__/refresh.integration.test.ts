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
import { hashRefreshToken } from '../refresh-token.js';
import { createTokenService } from '../tokens.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * POST /api/v1/auth/refresh — rotation and reuse detection, against real PostgreSQL.
 *
 * Assembled the way the composition root assembles it, so the wiring under test is the wiring
 * production uses: real RS256 signatures, real unique indexes, real row locking. Nothing about
 * the security behaviour is mocked — in particular the concurrency test runs two genuine
 * overlapping transactions rather than asserting that a stub was called once.
 */
describe('POST /api/v1/auth/refresh (integration)', () => {
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

  /** The production assembly. No rate limiting: this suite is about rotation, not throttling. */
  function build() {
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const identity = createIdentityService({
      repository: createIdentityRepository({ db: db() }),
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
          slug: testDb.config.defaultStoreSlug,
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

  /** Register then log in, returning the first refresh token of a fresh family. */
  async function login(email = EMAIL): Promise<{
    app: ReturnType<typeof build>['app'];
    identity: ReturnType<typeof build>['identity'];
    refreshToken: string;
    accessToken: string;
    userId: string;
  }> {
    const { app, identity } = build();

    await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(200);
    return {
      app,
      identity,
      refreshToken: response.body.refreshToken,
      accessToken: response.body.accessToken,
      userId: response.body.user.id,
    };
  }

  const refresh = async (app: ReturnType<typeof build>['app'], refreshToken: unknown) =>
    request(app).post('/api/v1/auth/refresh').send({ refreshToken });

  /** Every session row for one user, oldest first. */
  async function sessionsFor(userId: string) {
    return db()
      .select({
        id: refreshSession.id,
        familyId: refreshSession.familyId,
        consumedAt: refreshSession.consumedAt,
        revokedAt: refreshSession.revokedAt,
        revokedReason: refreshSession.revokedReason,
        expiresAt: refreshSession.expiresAt,
      })
      .from(refreshSession)
      .where(eq(refreshSession.userId, userId))
      .orderBy(refreshSession.createdAt);
  }

  describe('successful rotation', () => {
    it('returns a new access token and a new refresh token', async () => {
      const { app, refreshToken: tokenA, accessToken: accessA } = await login();

      const response = await refresh(app, tokenA);

      expect(response.status).toBe(200);
      // The exact login contract, so a client needs no second code path for refresh.
      expect(Object.keys(response.body).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
        'user',
      ]);
      expect(response.body.tokenType).toBe('Bearer');

      const tokenB = response.body.refreshToken;
      // The rotation itself. Returning the same token would mean no rotation happened at all.
      expect(tokenB).not.toBe(tokenA);
      expect(tokenB).toHaveLength(43);
      expect(response.body.accessToken).not.toBe(accessA);
    });

    it('issues an access token that verifies with the real key and carries the new session id', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      const response = await refresh(app, tokenA);
      const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
      const verified = await tokens.verifyAccessToken(response.body.accessToken);

      /**
       * Verified through the token service rather than decoded, so this asserts a real RS256
       * signature against the configured public key — the same path `requireAuth` will take.
       */
      expect(verified.userId).toBe(userId);
      expect(verified.storeId).toBe(storeId);

      // `sid` must name the REPLACEMENT session. Reusing the parent's id would make the access
      // token outlive the row it refers to, and a future logout-by-session would miss it.
      const rows = await sessionsFor(userId);
      expect(rows).toHaveLength(2);
      expect(verified.sessionId).toBe(rows[1]?.id);
      expect(verified.sessionId).not.toBe(rows[0]?.id);
    });

    it('consumes the parent and keeps the replacement in the same family', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      await refresh(app, tokenA);
      const rows = await sessionsFor(userId);

      expect(rows).toHaveLength(2);
      // Parent consumed, not revoked: it was spent normally, which is not a security event.
      expect(rows[0]?.consumedAt).toBeInstanceOf(Date);
      expect(rows[0]?.revokedAt).toBeNull();
      // Child live, and in the same family — that is what makes family revocation reach it.
      expect(rows[1]?.consumedAt).toBeNull();
      expect(rows[1]?.revokedAt).toBeNull();
      expect(rows[1]?.familyId).toBe(rows[0]?.familyId);
    });

    it('rotates repeatedly, keeping one family across the whole chain', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      const b = (await refresh(app, tokenA)).body.refreshToken;
      const c = (await refresh(app, b)).body.refreshToken;
      const d = (await refresh(app, c)).body.refreshToken;

      expect(new Set([tokenA, b, c, d]).size).toBe(4);

      const rows = await sessionsFor(userId);
      expect(rows).toHaveLength(4);
      // One family for the whole chain. A new family per rotation would make reuse detection
      // useless, because revoking a family would only ever reach one token.
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
      // Exactly one live session: the tip.
      expect(rows.filter((r) => r.consumedAt === null)).toHaveLength(1);
    });

    it('does NOT slide the expiry', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      await refresh(app, tokenA);
      const rows = await sessionsFor(userId);

      /**
       * The replacement inherits the parent's expiry, so a family dies a fixed interval after
       * the LOGIN that created it. A sliding window would let a stolen token be refreshed
       * indefinitely — a thief who never misses a rotation window would never be forced out.
       * The cost is that an active user re-authenticates on that schedule; see DECISIONS §19.
       */
      expect(rows[1]?.expiresAt.getTime()).toBe(rows[0]?.expiresAt.getTime());
    });
  });

  describe('old token invalidation', () => {
    it('rejects the parent token after a successful rotation', async () => {
      const { app, refreshToken: tokenA } = await login();

      expect((await refresh(app, tokenA)).status).toBe(200);
      const replay = await refresh(app, tokenA);

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('never returns the presented token back', async () => {
      const { app, refreshToken: tokenA } = await login();

      const response = await refresh(app, tokenA);

      // A handler that echoed the input on some path would look like a working rotation while
      // leaving the old credential alive.
      expect(JSON.stringify(response.body)).not.toContain(tokenA);
    });
  });

  describe('reuse detection and family revocation', () => {
    it('revokes the whole family when a consumed token is replayed', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      const tokenB = (await refresh(app, tokenA)).body.refreshToken;

      // The attack: A leaked, and someone replays it after the real user moved on to B.
      const replay = await refresh(app, tokenA);
      expect(replay.status).toBe(401);

      const rows = await sessionsFor(userId);
      // EVERY row revoked, with the reason recorded for forensics.
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(rows.every((r) => r.revokedReason === 'rotation_reuse')).toBe(true);

      /**
       * The part that matters. B was a perfectly valid token a moment ago and belonged to the
       * legitimate user — revoking it logs them out too. That is deliberate: the system cannot
       * tell the victim from the thief, so it trusts neither.
       */
      const afterRevocation = await refresh(app, tokenB);
      expect(afterRevocation.status).toBe(401);
      expect(afterRevocation.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('revokes descendants several generations deep', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      const b = (await refresh(app, tokenA)).body.refreshToken;
      const c = (await refresh(app, b)).body.refreshToken;
      const d = (await refresh(app, c)).body.refreshToken;

      // Replay the ORIGINAL, three rotations later.
      await refresh(app, tokenA);

      const rows = await sessionsFor(userId);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

      // The live tip dies with the rest, which is the whole point of family revocation.
      for (const token of [b, c, d]) {
        expect((await refresh(app, token)).status).toBe(401);
      }
    });

    it('detects reuse regardless of the ORDER attacker and user act in', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      /**
       * The inverse ordering: the ATTACKER rotates A first, then the legitimate user — who
       * still holds A because their own rotation never completed — presents it.
       *
       * The second presentation is the replay, whoever makes it. The system has no way to tell
       * which party is which and does not try; it revokes the family either way.
       */
      const attackerToken = (await refresh(app, tokenA)).body.refreshToken;
      const victimReplay = await refresh(app, tokenA);

      expect(victimReplay.status).toBe(401);
      expect((await refresh(app, attackerToken)).status).toBe(401);

      const rows = await sessionsFor(userId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it('is idempotent when a replayed token is presented repeatedly', async () => {
      const { app, refreshToken: tokenA, userId } = await login();
      await refresh(app, tokenA);

      // An attacker retrying. Already-revoked rows must not error, and nothing new is created.
      for (let i = 0; i < 3; i += 1) {
        expect((await refresh(app, tokenA)).status).toBe(401);
      }

      const rows = await sessionsFor(userId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it('does NOT revoke a family for an unknown token', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      // A fabricated token must not be a denial-of-service lever against a real user's family.
      const response = await refresh(app, 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');

      expect(response.status).toBe(401);
      const rows = await sessionsFor(userId);
      expect(rows.every((r) => r.revokedAt === null)).toBe(true);
      // And the real token still works.
      expect((await refresh(app, tokenA)).status).toBe(200);
    });

    it('does not revoke OTHER families belonging to the same user', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      // A second device: a separate login, so a separate family.
      const secondLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });
      const otherDeviceToken = secondLogin.body.refreshToken;

      await refresh(app, tokenA);
      await refresh(app, tokenA); // replay → revoke family one

      /**
       * Revocation is scoped to the compromised FAMILY, not the user. A leak on a phone must
       * not sign the user out of their laptop — over-revoking would train users to expect
       * random logouts and hide the real incident in the noise.
       */
      expect((await refresh(app, otherDeviceToken)).status).toBe(200);

      const rows = await sessionsFor(userId);
      const families = new Set(rows.map((r) => r.familyId));
      expect(families.size).toBe(2);
    });
  });

  describe('rejected tokens', () => {
    it('rejects an expired token', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      // Age the row rather than waiting 30 days. The expiry predicate lives in the claiming
      // UPDATE, so this exercises the real check.
      await db()
        .update(refreshSession)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(refreshSession.userId, userId));

      const response = await refresh(app, tokenA);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_REFRESH_TOKEN');

      /**
       * Expiry is NOT a theft signal. An unconsumed token that simply ran out proves nothing
       * about whether it leaked, so revoking the family here would log people out for the
       * ordinary crime of leaving a tab open over a holiday.
       */
      const rows = await sessionsFor(userId);
      expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    });

    it('rejects an explicitly revoked session without touching the family', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      // What logout will do in the next increment: revoke without consuming.
      await db()
        .update(refreshSession)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(eq(refreshSession.userId, userId));

      const response = await refresh(app, tokenA);

      expect(response.status).toBe(401);
      const rows = await sessionsFor(userId);
      // The reason must survive: overwriting `logout` with `rotation_reuse` would misreport a
      // deliberate sign-out as a security incident.
      expect(rows[0]?.revokedReason).toBe('logout');
    });

    it('rejects a random token, a malformed token, and an empty body', async () => {
      const { app } = build();

      // 401 for anything token-shaped, 400 only for a body that is not a request at all. A
      // malformed token must not answer differently from a well-formed unknown one.
      expect((await refresh(app, 'not-a-real-token')).status).toBe(401);
      expect((await refresh(app, 'a'.repeat(43))).status).toBe(401);
      expect((await refresh(app, '!!!invalid-base64!!!')).status).toBe(401);

      expect((await request(app).post('/api/v1/auth/refresh').send({})).status).toBe(400);
      expect((await refresh(app, 42)).status).toBe(400);
      expect((await refresh(app, null)).status).toBe(400);
      // `strictObject`, so a snake_case field is a 400 rather than a baffling 401.
      expect(
        (await request(app).post('/api/v1/auth/refresh').send({ refresh_token: 'x' })).status,
      ).toBe(400);
    });

    it('rejects refresh for a deactivated user', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      const response = await refresh(app, tokenA);

      /**
       * Suspension must take effect at the refresh boundary. The access token is 15 minutes of
       * unavoidable staleness, but a 30-day refresh token that kept working would make a
       * suspension meaningless for a month.
       */
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous rotations win', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      /**
       * Two genuinely overlapping requests, not a simulation. Both hit the same
       * `UPDATE ... WHERE consumed_at IS NULL`, so PostgreSQL serialises them on the row lock:
       * the second blocks, re-evaluates the predicate after the first commits, and matches
       * nothing.
       */
      const [first, second] = await Promise.all([refresh(app, tokenA), refresh(app, tokenA)]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 401]);

      const winner = first.status === 200 ? first : second;
      expect(winner.body.refreshToken).not.toBe(tokenA);

      /**
       * The row count is asserted as well as the status pair, and that is not redundant.
       *
       * Verified by mutation: replacing the atomic claim with a read-then-write left THIS
       * test's status assertion passing on three consecutive runs, because two `Promise.all`
       * requests do not reliably overlap enough to race. The sibling tests caught the broken
       * version every time — via exactly this row count, which is the real invariant. A status
       * pair is a symptom that only sometimes appears; a forked family is the defect itself.
       */
      expect(await sessionsFor(userId)).toHaveLength(2);
    });

    it('leaves session state consistent after a concurrent race', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      await Promise.all([refresh(app, tokenA), refresh(app, tokenA)]);
      const rows = await sessionsFor(userId);

      /**
       * Exactly TWO rows: the parent and one replacement. Three would mean both requests
       * rotated — the fork this design exists to prevent — and the family would have two live
       * tips, each able to rotate forever.
       */
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    });

    it('treats the losing request as a replay and revokes the family', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      await Promise.all([refresh(app, tokenA), refresh(app, tokenA)]);
      const rows = await sessionsFor(userId);

      /**
       * The accepted trade-off, stated plainly: the loser of a legitimate race is
       * indistinguishable from a thief replaying a stolen token, so it is treated as one and
       * the family dies. A client that fires two refreshes at once therefore logs itself out.
       *
       * The alternative — a grace window that forgives a replay within a few seconds — cannot
       * return the same replacement token, because only its hash is stored. So it would have to
       * reject without revoking, which is exactly the hole a thief racing the real user would
       * walk through. Strict wins; clients must serialise their own refreshes. DECISIONS §19.
       */
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(rows.every((r) => r.revokedReason === 'rotation_reuse')).toBe(true);
    });

    it('serialises a burst of five without forking the family', async () => {
      const { app, refreshToken: tokenA, userId } = await login();

      const responses = await Promise.all(Array.from({ length: 5 }, () => refresh(app, tokenA)));

      // One winner however many pile on, and no request errors with a 500.
      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 401)).toHaveLength(4);
      expect(responses.some((r) => r.status >= 500)).toBe(false);

      expect(await sessionsFor(userId)).toHaveLength(2);
    });
  });

  describe('store isolation', () => {
    it('rejects a token presented against a different store', async () => {
      const { refreshToken: tokenA } = await login();

      // A second tenant, with its own resolver so requests land on it.
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
      const identity = createIdentityService({
        repository: createIdentityRepository({ db: db() }),
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
            slug: 'second',
            logger: silentLogger,
            cacheTtlMs: 0,
          }),
          logger: silentLogger,
        }),
      );
      apiRouter.use(createIdentityRoutes({ identity, tokens, logger: silentLogger }));

      const otherStoreApp = createApp({
        config: testDb.config,
        logger: silentLogger,
        healthChecks: [],
        apiRouter,
      });

      const response = await request(otherStoreApp)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenA });

      /**
       * The token hash is globally unique, so the row EXISTS — it is the store predicate in the
       * claiming UPDATE that refuses it. Without that predicate a leaked token would rotate
       * against the wrong tenant and mint an access token scoped to a store the user has no
       * account in.
       */
      expect(response.status).toBe(401);
    });

    it('does not let one store revoke another store family', async () => {
      const { app, refreshToken: tokenA, userId } = await login();
      await refresh(app, tokenA);

      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });

      const sessions = createRefreshSessionRepository({ db: db() });
      const revoked = await sessions.revokeFamily({
        storeId: secondStoreId,
        familyId: (await sessionsFor(userId))[0]?.familyId ?? '',
        reason: 'rotation_reuse',
        at: new Date(),
      });

      // Right family id, wrong store: nothing revoked. A cross-tenant revoke would be a
      // trivial denial-of-service against a competitor's customers.
      expect(revoked).toBe(0);
      expect((await sessionsFor(userId)).every((r) => r.revokedAt === null)).toBe(true);
    });
  });

  describe('no plaintext secrets', () => {
    it('stores only the hash, never the token', async () => {
      const { app, refreshToken: tokenA, userId } = await login();
      const tokenB = (await refresh(app, tokenA)).body.refreshToken;

      const rows = await db()
        .select({ tokenHash: refreshSession.tokenHash })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));

      const stored = rows.map((r) => r.tokenHash);
      // Neither token appears anywhere in the table.
      expect(stored).not.toContain(tokenA);
      expect(stored).not.toContain(tokenB);
      // What IS stored is the digest of each, at the column's exact width.
      expect(stored).toContain(hashRefreshToken(tokenA));
      expect(stored).toContain(hashRefreshToken(tokenB));
      expect(stored.every((h) => h.length === 64)).toBe(true);
    });

    it('finds no row by the raw token, even though the hash matches one', async () => {
      const { refreshToken: tokenA } = await login();

      const [byRaw] = await db()
        .select({ id: refreshSession.id })
        .from(refreshSession)
        .where(eq(refreshSession.tokenHash, tokenA));

      /**
       * A direct proof rather than an inference: if any code path had written the plaintext,
       * this query would find it. It cannot, because the repository's signatures accept only a
       * `RefreshTokenHash` — the guarantee is enforced by the compiler, and asserted here.
       */
      expect(byRaw).toBeUndefined();
    });
  });
});
