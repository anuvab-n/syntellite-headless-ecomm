import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { refreshSession } from '../../../db/schema/identity.js';
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
 * POST /api/v1/auth/logout — against real PostgreSQL.
 *
 * The first authenticated endpoint, so this suite also covers `requireAuth`: a real RS256
 * signature is verified against the configured public key on every call, and the failure paths
 * are exercised with genuinely malformed and genuinely foreign tokens rather than stubs.
 */
describe('POST /api/v1/auth/logout (integration)', () => {
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

  /** The production assembly, optionally pinned to a different store's resolver. */
  function build(slug = testDb.config.defaultStoreSlug) {
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
      tokens,
    };
  }

  type App = ReturnType<typeof build>['app'];

  /** Register once, then sign in — producing one independent family per call. */
  async function signIn(
    app: App,
    identity: ReturnType<typeof build>['identity'],
    options: { register?: boolean; email?: string } = {},
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const email = options.email ?? EMAIL;

    if (options.register !== false) {
      await identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
      });
    }

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

  const logout = (app: App, accessToken?: string) => {
    const req = request(app).post('/api/v1/auth/logout');
    return accessToken === undefined ? req : req.set('Authorization', `Bearer ${accessToken}`);
  };

  const refresh = (app: App, refreshToken: string) =>
    request(app).post('/api/v1/auth/refresh').send({ refreshToken });

  async function sessionsFor(userId: string) {
    return db()
      .select({
        id: refreshSession.id,
        familyId: refreshSession.familyId,
        consumedAt: refreshSession.consumedAt,
        revokedAt: refreshSession.revokedAt,
        revokedReason: refreshSession.revokedReason,
      })
      .from(refreshSession)
      .where(eq(refreshSession.userId, userId))
      .orderBy(refreshSession.createdAt);
  }

  describe('successful logout', () => {
    it('returns 204 with no body', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      const response = await logout(app, accessToken);

      expect(response.status).toBe(204);
      // 204 means no body, and Express must not be sending one.
      expect(response.text).toBe('');
      expect(response.body).toEqual({});
    });

    it('revokes the session with the reason "logout"', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await logout(app, accessToken);
      const rows = await sessionsFor(userId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
      /**
       * An explicit reason, distinct from `rotation_reuse`. Without it, a deliberate sign-out
       * and a detected token theft would be indistinguishable in the audit trail — and the
       * refresh path relies on that distinction to decide whether an incident occurred.
       */
      expect(rows[0]?.revokedReason).toBe('logout');
    });

    it('does NOT delete the session row', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await logout(app, accessToken);

      /**
       * Revoked, not deleted. The row is the audit record, and it is also what makes reuse
       * detection possible afterwards: a deleted row would make a stolen token look merely
       * unknown, and the family could never be flagged.
       */
      const rows = await db()
        .select({ id: refreshSession.id })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));
      expect(rows).toHaveLength(1);
    });

    it('does not mark the session consumed', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await logout(app, accessToken);
      const rows = await sessionsFor(userId);

      // Revocation and consumption mean different things: consumed = spent by a rotation,
      // revoked = withdrawn. Conflating them would make a logged-out token look replayed and
      // trigger a spurious reuse incident on the next presentation.
      expect(rows[0]?.consumedAt).toBeNull();
      expect(rows[0]?.revokedAt).not.toBeNull();
    });
  });

  describe('refresh token invalid after logout', () => {
    it('rejects the family refresh token with 401 INVALID_REFRESH_TOKEN', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken } = await signIn(app, identity);

      await logout(app, accessToken);
      const response = await refresh(app, refreshToken);

      // The contract the client depends on, and identical to every other refresh failure.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('does not report a logged-out token differently from an unknown one', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken } = await signIn(app, identity);
      await logout(app, accessToken);

      const loggedOut = await refresh(app, refreshToken);
      const fabricated = await refresh(app, 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');

      /**
       * A distinguishable "revoked" response would tell an attacker holding a stolen token that
       * it was real and that its owner had signed out — which is exactly when you want them to
       * learn nothing.
       */
      expect(loggedOut.status).toBe(fabricated.status);
      expect(loggedOut.body.error.code).toBe(fabricated.body.error.code);
      expect(loggedOut.body.error.message).toBe(fabricated.body.error.message);
    });
  });

  describe('family-wide logout', () => {
    it('revokes descendants when logging out with a rotated session token', async () => {
      const { app, identity } = build();
      const { refreshToken: tokenA } = await signIn(app, identity);

      // Rotate A -> B. The access token from that rotation names session B.
      const rotated = await refresh(app, tokenA);
      const tokenB = rotated.body.refreshToken;
      const accessB = rotated.body.accessToken;

      await logout(app, accessB);

      // B was the live tip and is now dead.
      expect((await refresh(app, tokenB)).status).toBe(401);
    });

    it('revokes the whole chain including ancestors', async () => {
      const { app, identity } = build();
      const { refreshToken: tokenA, userId } = await signIn(app, identity);

      const b = await refresh(app, tokenA);
      const c = await refresh(app, b.body.refreshToken);

      await logout(app, c.body.accessToken);
      const rows = await sessionsFor(userId);

      /**
       * Three rows, every one revoked. The ancestors were already consumed and therefore
       * unusable, but stamping them records that they were withdrawn deliberately rather than
       * leaving them looking like a chain that simply stopped.
       */
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      expect(rows.every((r) => r.revokedReason === 'logout')).toBe(true);
    });

    it('logging out with an ANCESTOR access token still revokes the live tip', async () => {
      const { app, identity } = build();
      const { accessToken: accessA, refreshToken: tokenA } = await signIn(app, identity);

      const b = await refresh(app, tokenA);
      const c = await refresh(app, b.body.refreshToken);

      /**
       * The access token from the ORIGINAL login — its `sid` names a session that has since been
       * consumed. It is still a validly signed, unexpired token, so it still authenticates, and
       * the family it resolves to is the same one.
       *
       * This is why the repository keys on session id and derives the family, rather than
       * requiring the session to still be live: a client holding a slightly stale access token
       * must still be able to log itself out.
       */
      const response = await logout(app, accessA);
      expect(response.status).toBe(204);

      expect((await refresh(app, c.body.refreshToken)).status).toBe(401);
    });
  });

  describe('other families remain active', () => {
    it('leaves an independent login family working', async () => {
      const { app, identity } = build();

      // Two sign-ins for the same user: two devices, two independent families.
      const deviceA = await signIn(app, identity);
      const deviceB = await signIn(app, identity, { register: false });

      await logout(app, deviceA.accessToken);

      /**
       * The definition of the feature. "Log out" on a phone must not sign the user out of their
       * laptop — that is what the word means to the person pressing the button, and revoking
       * everything would make the destructive option the only option.
       */
      expect((await refresh(app, deviceA.refreshToken)).status).toBe(401);
      expect((await refresh(app, deviceB.refreshToken)).status).toBe(200);
    });

    it('revokes only the intended family in the database', async () => {
      const { app, identity } = build();
      const deviceA = await signIn(app, identity);
      await signIn(app, identity, { register: false });

      await logout(app, deviceA.accessToken);
      const rows = await sessionsFor(deviceA.userId);

      expect(new Set(rows.map((r) => r.familyId)).size).toBe(2);
      // Exactly one row revoked, out of two families.
      expect(rows.filter((r) => r.revokedAt !== null)).toHaveLength(1);
      expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
    });

    it('does not touch another USER sessions', async () => {
      const { app, identity } = build();
      const victim = await signIn(app, identity);
      const other = await signIn(app, identity, {
        register: true,
        email: 'other@example.com',
      });

      await logout(app, victim.accessToken);

      // A logout that revoked by user id, or by nothing at all, would sign out strangers.
      expect((await refresh(app, other.refreshToken)).status).toBe(200);
    });
  });

  describe('idempotency', () => {
    it('returns 204 on a second logout with the same token', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      expect((await logout(app, accessToken)).status).toBe(204);

      /**
       * 204 again, not 404 and not 500. A client retrying after a dropped response must not see
       * an error, and the identical response means the endpoint cannot be used to probe whether
       * a family is still live.
       */
      expect((await logout(app, accessToken)).status).toBe(204);
      expect((await logout(app, accessToken)).status).toBe(204);
    });

    it('leaves state unchanged across repeated logouts', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      await logout(app, accessToken);
      const afterFirst = await sessionsFor(userId);

      await logout(app, accessToken);
      const afterSecond = await sessionsFor(userId);

      // Same row count, and the original revocation timestamp is not overwritten — the second
      // call matches zero rows because of the `revoked_at IS NULL` predicate.
      expect(afterSecond).toHaveLength(afterFirst.length);
      expect(afterSecond[0]?.revokedAt?.getTime()).toBe(afterFirst[0]?.revokedAt?.getTime());
      expect(afterSecond[0]?.revokedReason).toBe('logout');
    });
  });

  describe('authentication is required', () => {
    it('rejects a request with no Authorization header', async () => {
      const { app, identity } = build();
      await signIn(app, identity);

      const response = await logout(app);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects malformed Authorization headers', async () => {
      const { app } = build();

      for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc123', 'token-with-no-scheme']) {
        const response = await request(app)
          .post('/api/v1/auth/logout')
          .set('Authorization', header);

        // All identical: "you sent no bearer token". None reaches verification.
        expect(response.status, `header: "${header}"`).toBe(401);
        expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      }
    });

    it('rejects an invalid or tampered access token', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      // Flip the last character of the signature. Structurally valid JWT, invalid signature.
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
        const response = await logout(app, token);

        /**
         * `INVALID_ACCESS_TOKEN`, distinct from `AUTHENTICATION_REQUIRED` — a token was
         * presented and did not verify, which is a different bug for a client to fix than
         * having forgotten the header. Every *reason* it failed stays opaque.
         */
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
      }
    });

    it('rejects a token signed by a different key', async () => {
      const { app } = build();

      /**
       * A real RS256 token, correctly formed, signed with a key this deployment does not trust.
       * This is the check that would silently pass if the algorithm were ever unpinned or the
       * public key were not actually consulted.
       */
      const { generateKeyPairSync } = await import('node:crypto');
      const foreign = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const { SignJWT, importPKCS8 } = await import('jose');
      const key = await importPKCS8(foreign.privateKey, 'RS256');
      const forged = await new SignJWT({
        storeId,
        isStaff: true,
        isSuperuser: true,
        sid: newId(),
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(newId())
        .setIssuer(testDb.config.jwtIssuer)
        .setAudience(testDb.config.jwtAudience)
        .setJti(newId())
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(key);

      const response = await logout(app, forged);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('does not revoke anything when authentication fails', async () => {
      const { app, identity } = build();
      const { userId, refreshToken } = await signIn(app, identity);

      await logout(app);
      await logout(app, 'not.a.jwt');

      // A failed logout must not be a denial-of-service lever.
      expect((await sessionsFor(userId)).every((r) => r.revokedAt === null)).toBe(true);
      expect((await refresh(app, refreshToken)).status).toBe(200);
    });
  });

  describe('store isolation', () => {
    it('rejects an access token issued for a different store', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken, userId } = await signIn(app, identity);

      // A second tenant, and an app whose resolver pins requests to it.
      await db()
        .insert(store)
        .values({ id: newId(), slug: 'second', name: 'Second', isActive: true });
      const { app: otherStoreApp } = build('second');

      const response = await request(otherStoreApp)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`);

      /**
       * The token is validly signed and unexpired — only its `storeId` claim disagrees with the
       * store this request resolved to. Without that check the token would authenticate, and
       * every query downstream would be scoped to one tenant while the identity came from
       * another.
       */
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');

      // And nothing was revoked in either store.
      expect((await sessionsFor(userId)).every((r) => r.revokedAt === null)).toBe(true);
      expect((await refresh(app, refreshToken)).status).toBe(200);
    });

    it('cannot revoke a session id belonging to another store', async () => {
      const { app, identity } = build();
      const { userId } = await signIn(app, identity);
      const sessionId = (await sessionsFor(userId))[0]?.id ?? '';

      const foreignStoreId = newId();
      await db()
        .insert(store)
        .values({ id: foreignStoreId, slug: 'third', name: 'Third', isActive: true });

      const sessions = createRefreshSessionRepository({ db: db() });
      const revoked = await sessions.revokeFamilyBySessionId({
        // Real session id, wrong store.
        storeId: foreignStoreId,
        sessionId,
        reason: 'logout',
        at: new Date(),
      });

      /**
       * Asserted at the repository, because this is where the guarantee lives: the store
       * predicate appears in BOTH the family subquery and the outer update, so a foreign
       * session id resolves to no family and the write matches nothing.
       */
      expect(revoked).toBe(0);
      expect((await sessionsFor(userId)).every((r) => r.revokedAt === null)).toBe(true);
    });
  });

  describe('reuse detection still works after logout', () => {
    it('still detects a replayed token and records the reuse reason', async () => {
      const { app, identity } = build();
      const { refreshToken: tokenA, userId } = await signIn(app, identity);

      const b = await refresh(app, tokenA);
      // Replay A. Increment 5 behaviour must be untouched by this increment.
      expect((await refresh(app, tokenA)).status).toBe(401);

      const rows = await sessionsFor(userId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      // `rotation_reuse`, NOT `logout` — the two reasons must stay distinguishable.
      expect(rows.every((r) => r.revokedReason === 'rotation_reuse')).toBe(true);
      expect((await refresh(app, b.body.refreshToken)).status).toBe(401);
    });

    it('does not overwrite a logout reason with a reuse reason', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken, userId } = await signIn(app, identity);

      await logout(app, accessToken);
      // Present the already-revoked token. It was never consumed, so this is a revoked-session
      // rejection, not a replay.
      expect((await refresh(app, refreshToken)).status).toBe(401);

      const rows = await sessionsFor(userId);
      /**
       * The reason must survive. `revokeFamily` only touches rows where `revoked_at IS NULL`, so
       * a later reuse cannot relabel a deliberate sign-out as a security incident — which would
       * make the audit trail actively misleading.
       */
      expect(rows[0]?.revokedReason).toBe('logout');
    });

    it('logout after a reuse incident does not error', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken: tokenA, userId } = await signIn(app, identity);

      await refresh(app, tokenA);
      await refresh(app, tokenA); // reuse → family revoked

      // The user still holds an access token and may well press "log out" next.
      expect((await logout(app, accessToken)).status).toBe(204);
      expect((await sessionsFor(userId)).every((r) => r.revokedReason === 'rotation_reuse')).toBe(
        true,
      );
    });
  });

  describe('no plaintext leakage', () => {
    it('returns no token material in the logout response', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken } = await signIn(app, identity);

      const response = await logout(app, accessToken);
      const serialised = JSON.stringify(response.body) + response.text;

      expect(serialised).not.toContain(refreshToken);
      expect(serialised).not.toContain(hashRefreshToken(refreshToken));
      expect(serialised).not.toContain(accessToken);
    });

    it('stores only hashes, and the revoked row still holds no plaintext', async () => {
      const { app, identity } = build();
      const { accessToken, refreshToken, userId } = await signIn(app, identity);
      await logout(app, accessToken);

      const rows = await db()
        .select({ tokenHash: refreshSession.tokenHash })
        .from(refreshSession)
        .where(eq(refreshSession.userId, userId));

      // Revocation must not have written the plaintext anywhere as a side effect.
      expect(rows.map((r) => r.tokenHash)).not.toContain(refreshToken);
      expect(rows.map((r) => r.tokenHash)).toContain(hashRefreshToken(refreshToken));
    });

    it('logs identifiers only, never a token or a token hash', async () => {
      const lines: string[] = [];
      const capture = { write: (chunk: string) => lines.push(chunk) };

      const { createLogger } = await import('../../../shared/logger.js');
      const logger = createLogger({ ...testDb.config, logLevel: 'debug' }, capture);

      const tokens = createTokenService({ config: testDb.config, logger });
      const identity = createIdentityService({
        repository: createIdentityRepository({ db: db() }),
        sessions: createRefreshSessionRepository({ db: db() }),
        tokens,
        db: db(),
        config: testDb.config,
        logger,
        ...testRecorders(db()),
      });

      const apiRouter = Router();
      apiRouter.use(
        resolveStore({
          resolver: createDefaultStoreResolver({
            repository: createStoreRepository({ db: db() }),
            slug: testDb.config.defaultStoreSlug,
            logger,
            cacheTtlMs: 0,
          }),
          logger,
        }),
      );
      apiRouter.use(createIdentityRoutes({ identity, tokens, logger }));
      const app = createApp({ config: testDb.config, logger, healthChecks: [], apiRouter });

      const { accessToken, refreshToken } = await signIn(app, identity);
      await logout(app, accessToken);

      const output = lines.join('');
      expect(output).toContain('logout_succeeded');

      /**
       * Neither the token NOR its hash. The raw token is an obvious credential; the hash is
       * less obvious and just as dangerous, because it is a working lookup key for the session
       * table — and log stores are read by more people than the database.
       */
      expect(output).not.toContain(refreshToken);
      expect(output).not.toContain(hashRefreshToken(refreshToken));
      expect(output).not.toContain(accessToken);
    });
  });
});
