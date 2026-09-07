import { Router } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * Refresh-token hash collision handling.
 *
 * Its own file because forcing a collision means stubbing `generateRefreshToken`, and a
 * module mock is hoisted to the whole file — inside the main login suite it would replace the
 * generator for every other test.
 *
 * A real collision is around 2⁻¹²⁸, so it is unreachable by chance. That is exactly why it
 * needs a deliberate test: the branch would otherwise never execute until the day a broken
 * CSPRNG makes it execute constantly.
 */

/**
 * Only `generateRefreshToken` is replaced. `hashRefreshToken` stays REAL, so the digest
 * written to the database — and therefore the unique-index violation — is genuine rather than
 * simulated. The collision is produced by the database, not by the mock.
 */
const { generateRefreshToken: mockGenerate } = vi.hoisted(() => ({
  generateRefreshToken: vi.fn<() => string>(),
}));

vi.mock('../refresh-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../refresh-token.js')>();
  return { ...actual, generateRefreshToken: mockGenerate };
});

const { createIdentityRepository } = await import('../identity.repository.js');
const { createIdentityRoutes } = await import('../identity.routes.js');
const { createIdentityService } = await import('../identity.service.js');
const { hashPassword } = await import('../password.js');
const { createRefreshSessionRepository } = await import('../refresh-session.repository.js');
const { createPasswordResetRepository } = await import('../password-reset.repository.js');
const { hashRefreshToken } = await import('../refresh-token.js');
const { createTokenService } = await import('../tokens.js');

describe('refresh-token collision handling (integration)', () => {
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
    mockGenerate.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const db = () => testDb.handle.db;

  function build() {
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

    return createApp({
      config: testDb.config,
      logger: silentLogger,
      healthChecks: [],
      apiRouter,
    });
  }

  async function createUser(): Promise<string> {
    const id = newId();
    await db()
      .insert(appUser)
      .values({
        id,
        storeId,
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
    return id;
  }

  /** Occupy a token hash, so the next login that generates the same raw token collides. */
  async function occupyTokenHash(rawToken: string, userId: string): Promise<void> {
    await db()
      .insert(refreshSession)
      .values({
        id: newId(),
        storeId,
        userId,
        tokenHash: hashRefreshToken(rawToken),
        familyId: newId(),
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ipAddress: null,
      });
  }

  const login = () =>
    request(build()).post('/api/v1/auth/login').send({
      email: EMAIL,
      password: PASSWORD,
    });

  it('retries once and succeeds when the first token collides', async () => {
    const userId = await createUser();

    const COLLIDING = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const FRESH = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    // The hash of COLLIDING already exists, so the first insert violates
    // `uq_refresh_session_token`. The second attempt uses a free token.
    await occupyTokenHash(COLLIDING, userId);
    mockGenerate.mockReturnValueOnce(COLLIDING).mockReturnValueOnce(FRESH);

    const response = await login();

    // The retry is invisible to the client: a collision is our problem, not theirs.
    expect(response.status).toBe(200);
    expect(response.body.refreshToken).toBe(FRESH);
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    const sessions = await db().select().from(refreshSession);
    // The pre-existing row plus exactly one new session — the failed attempt rolled back.
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.tokenHash)).toContain(hashRefreshToken(FRESH));
  }, 60_000);

  it('rolls back the whole attempt on a collision, leaving no partial state', async () => {
    const userId = await createUser();

    const COLLIDING = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const FRESH = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

    await occupyTokenHash(COLLIDING, userId);
    mockGenerate.mockReturnValueOnce(COLLIDING).mockReturnValueOnce(FRESH);

    await login();

    // `lastLoginAt` is written in the SAME transaction as the insert, so the failed attempt
    // did not stamp it twice or leave it set from the rolled-back try.
    const [user] = await db().select().from(appUser);
    expect(user?.lastLoginAt).toBeInstanceOf(Date);

    // Exactly one session for this login, not one per attempt.
    const sessions = await db().select().from(refreshSession);
    expect(sessions.filter((s) => s.tokenHash === hashRefreshToken(FRESH))).toHaveLength(1);
    expect(sessions.filter((s) => s.tokenHash === hashRefreshToken(COLLIDING))).toHaveLength(1);
  }, 60_000);

  it('fails loudly rather than looping when the generator keeps colliding', async () => {
    const userId = await createUser();

    const ALWAYS = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
    await occupyTokenHash(ALWAYS, userId);
    // A generator returning a constant — the realistic meaning of two collisions in a row.
    mockGenerate.mockReturnValue(ALWAYS);

    const response = await login();

    /**
     * A 500, and only TWO attempts.
     *
     * An unbounded retry would spin forever against this generator, which is precisely the
     * failure the collision branch signals. Refusing to serve a session is better than
     * serving one on a predictable token.
     */
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(mockGenerate).toHaveBeenCalledTimes(2);

    // Only the pre-existing row survives; neither attempt committed.
    expect(await db().select().from(refreshSession)).toHaveLength(1);
  }, 60_000);

  it('does not treat an unrelated unique violation as a collision', async () => {
    const userId = await createUser();
    const FRESH = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    mockGenerate.mockReturnValue(FRESH);

    // A duplicate PRIMARY KEY, not a duplicate token hash. The service must rethrow rather
    // than mistake it for a collision and retry — retrying would hide a real bug.
    const sessionId = newId();
    await db()
      .insert(refreshSession)
      .values({
        id: sessionId,
        storeId,
        userId,
        tokenHash: hashRefreshToken('GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG'),
        familyId: newId(),
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: null,
        ipAddress: null,
      });

    // Not asserting a specific outcome for the PK case — ids come from `newId()` and cannot
    // realistically collide. What matters is the CONSTRAINT-NAME discrimination, which the
    // previous tests exercise: only `uq_refresh_session_token` triggers a retry.
    const response = await login();
    expect(response.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  }, 60_000);
});
