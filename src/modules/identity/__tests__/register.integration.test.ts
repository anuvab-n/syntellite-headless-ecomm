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
import type { ResolvedStore } from '../../stores/index.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createIdentityRepository } from '../identity.repository.js';
import { createIdentityRoutes } from '../identity.routes.js';
import { createIdentityService } from '../identity.service.js';
import { createRefreshSessionRepository } from '../refresh-session.repository.js';
import { createTokenService } from '../tokens.js';
import { verifyPassword } from '../password.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * POST /api/v1/auth/register, against real PostgreSQL.
 *
 * Assembled the same way the composition root assembles it — repository → service → routes,
 * with `resolveStore` composed into the API router — so what is under test is the wiring
 * production uses, not a rehearsal of it. Nothing is mocked: the unique-index behaviour, the
 * `lower(email)` expression, and the partial `WHERE deleted_at IS NULL` are all properties of
 * the database.
 */
describe('POST /api/v1/auth/register (integration)', () => {
  let testDb: TestDatabase;
  let store: ResolvedStore;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
    // Re-seeded after truncate: `app_user.store_id` is NOT NULL, so without a store there
    // is nothing to register against.
    store = await seedTestStore(testDb);
  });

  const db = () => testDb.handle.db;

  /** The production assembly, minus the parts registration does not touch. */
  function buildApp() {
    /**
     * Login's dependencies are supplied even though registration does not use them: the
     * service is one object, and constructing it the way production does keeps this test
     * honest about the real wiring rather than a reduced version of it.
     */
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
          // No caching between tests: each case truncates and re-seeds, so a cached store
          // id from the previous test would point at a row that no longer exists.
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

  const validBody = {
    email: 'buyer@example.com',
    password: 'a-sufficiently-long-password',
    firstName: 'Ada',
    lastName: 'Lovelace',
  };

  /**
   * `object` rather than `unknown`: supertest's `.send()` is typed for a body, and the tests
   * deliberately pass malformed *shapes* (extra keys, missing fields) rather than non-object
   * values. The one raw-string case builds its own request.
   */
  const post = (body: object) => request(buildApp()).post('/api/v1/auth/register').send(body);

  /* ── Success ───────────────────────────────────────────────────────────── */

  describe('success', () => {
    it('returns 201 with a safe user body', async () => {
      const response = await post(validBody);

      expect(response.status).toBe(201);
      expect(response.body.user).toEqual({
        id: expect.any(String),
        email: 'buyer@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: null,
        emailVerified: false,
        acceptsMarketing: false,
        createdAt: expect.any(String),
      });
    });

    it('persists the user against the RESOLVED store', async () => {
      const response = await post(validBody);

      const [row] = await db()
        .select()
        .from(appUser)
        .where(eq(appUser.id, response.body.user.id as string));

      // The store came from `resolveStore`, never from the request body — there is no field
      // for it in the DTO at all.
      expect(row?.storeId).toBe(store.id);
    });

    it('stores an Argon2id hash that verifies, and never the plaintext', async () => {
      await post(validBody);

      const [row] = await db().select().from(appUser);

      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain(validBody.password);
      await expect(verifyPassword(validBody.password, row?.passwordHash ?? '')).resolves.toBe(true);
    });

    it('creates the account with no privileges', async () => {
      await post(validBody);

      const [row] = await db().select().from(appUser);

      expect(row?.isStaff).toBe(false);
      expect(row?.isSuperuser).toBe(false);
      expect(row?.isActive).toBe(true);
      // Registration does not verify an email; that is a later increment.
      expect(row?.emailVerifiedAt).toBeNull();
    });

    it('accepts optional phone and marketing consent', async () => {
      const response = await post({
        ...validBody,
        phone: '+91 98765 43210',
        acceptsMarketing: true,
      });

      expect(response.status).toBe(201);
      expect(response.body.user.phone).toBe('+91 98765 43210');
      expect(response.body.user.acceptsMarketing).toBe(true);
    });

    it('defaults names to empty strings when omitted', async () => {
      const response = await post({ email: 'minimal@example.com', password: 'long-enough-pass' });

      expect(response.status).toBe(201);
      expect(response.body.user.firstName).toBe('');
      expect(response.body.user.lastName).toBe('');
    });
  });

  /* ── Email normalisation ───────────────────────────────────────────────── */

  describe('email normalisation', () => {
    it('trims and lowercases before storing', async () => {
      const response = await post({ ...validBody, email: '  BUYER@Example.COM  ' });

      expect(response.status).toBe(201);
      expect(response.body.user.email).toBe('buyer@example.com');

      const [row] = await db().select().from(appUser);
      // Stored normalised, so the column and the `lower(email)` index agree.
      expect(row?.email).toBe('buyer@example.com');
    });

    it('normalises before validating, so surrounding whitespace is not an error', async () => {
      // `.trim().toLowerCase()` runs BEFORE `.email()`. Validating first would reject an
      // address the user plainly meant.
      const response = await post({ ...validBody, email: ' buyer@example.com ' });
      expect(response.status).toBe(201);
    });
  });

  /* ── Duplicates ────────────────────────────────────────────────────────── */

  describe('duplicates', () => {
    it('returns 409 for the same email in the same store', async () => {
      await post(validBody);
      const response = await post(validBody);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect(await db().select().from(appUser)).toHaveLength(1);
    });

    it('returns 409 regardless of email casing', async () => {
      await post(validBody);
      const response = await post({ ...validBody, email: 'BUYER@EXAMPLE.COM' });

      // The pre-check compares `lower(email)`, the same expression the unique index uses, so
      // the two agree about what "already taken" means.
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('returns 409 for a duplicate phone', async () => {
      await post({ ...validBody, phone: '+919876543210' });
      const response = await post({
        ...validBody,
        email: 'someone-else@example.com',
        phone: '+919876543210',
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PHONE_ALREADY_REGISTERED');
    });

    it('leaks no database detail in the conflict response', async () => {
      await post(validBody);
      const response = await post(validBody);
      const serialised = JSON.stringify(response.body);

      // No SQLSTATE, no constraint name, no table name, no SQL, and not even the address
      // that was sent — the message stays generic so the response confirms rather than
      // reflects.
      expect(serialised).not.toContain('23505');
      expect(serialised).not.toContain('uq_user_email_active');
      expect(serialised).not.toContain('app_user');
      expect(serialised).not.toContain('duplicate key');
      expect(serialised).not.toContain('buyer@example.com');
    });

    it('permits re-registration after a soft delete', async () => {
      const first = await post(validBody);

      // The unique index is partial: `WHERE deleted_at IS NULL`. Erasure under DPDP/GDPR
      // anonymises rather than deletes, so a returning customer must be able to sign up
      // again — this asserts the index was chosen for that reason and behaves accordingly.
      await db()
        .update(appUser)
        .set({ deletedAt: new Date() })
        .where(eq(appUser.id, first.body.user.id as string));

      const second = await post(validBody);

      expect(second.status).toBe(201);
      expect(second.body.user.id).not.toBe(first.body.user.id);
      // Both rows survive; the old one is retained for invoice history.
      expect(await db().select().from(appUser)).toHaveLength(2);
    });

    it('lets exactly one of several concurrent identical registrations win', async () => {
      /**
       * The race the pre-check cannot close.
       *
       * Five simultaneous requests all pass `findActiveByEmail` (none has committed yet).
       * Only the unique index can arbitrate, and the service translates the resulting
       * violation into the same 409 the pre-check would have produced.
       */
      const responses = await Promise.all(Array.from({ length: 5 }, () => post(validBody)));

      const created = responses.filter((r) => r.status === 201);
      const conflicted = responses.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(conflicted).toHaveLength(4);
      // No 500s: a lost race is a business outcome, not a crash.
      expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(await db().select().from(appUser)).toHaveLength(1);
    });
  });

  /* ── Privilege escalation ──────────────────────────────────────────────── */

  describe('privilege escalation', () => {
    it('rejects a body containing isStaff or isSuperuser', async () => {
      for (const field of ['isStaff', 'isSuperuser'] as const) {
        const response = await post({ ...validBody, [field]: true });

        // `strictObject` rejects rather than silently stripping. A client sending these is
        // either probing for a mass-assignment hole or badly confused; both deserve a 400.
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(await db().select().from(appUser)).toHaveLength(0);
      }
    });

    it('rejects a body attempting to set storeId, id, or passwordHash', async () => {
      for (const field of ['storeId', 'id', 'passwordHash', 'emailVerifiedAt'] as const) {
        const response = await post({ ...validBody, [field]: 'attacker-supplied' });
        expect(response.status).toBe(400);
      }
    });

    it('cannot grant privilege even if an unknown key were stripped', async () => {
      // Defence in depth. `InsertUserValues` has no field for either flag, so even a schema
      // change to a non-strict object could not carry one through to the insert.
      await post(validBody);
      const [row] = await db().select().from(appUser);
      expect(row?.isStaff).toBe(false);
      expect(row?.isSuperuser).toBe(false);
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects an invalid email', async () => {
      const response = await post({ ...validBody, email: 'not-an-email' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields['body.email']).toBeDefined();
    });

    it('rejects a password under 10 characters', async () => {
      const response = await post({ ...validBody, password: 'short-9!' });

      expect(response.status).toBe(400);
      expect(response.body.error.details.fields['body.password']).toBeDefined();
    });

    it('accepts a password at exactly 10 and 128 characters', async () => {
      const ten = await post({ ...validBody, password: 'x'.repeat(10) });
      expect(ten.status).toBe(201);

      const max = await post({
        ...validBody,
        email: 'other@example.com',
        password: 'y'.repeat(128),
      });
      expect(max.status).toBe(201);
    });

    it('rejects a password over 128 characters', async () => {
      const response = await post({ ...validBody, password: 'z'.repeat(129) });

      // Bounds the buffer handed to the Argon2 addon, and matches the guard inside
      // password.ts so neither can drift.
      expect(response.status).toBe(400);
      expect(response.body.error.details.fields['body.password']).toBeDefined();
    });

    it('rejects a missing email or password', async () => {
      await expect(post({ password: 'long-enough-pass' })).resolves.toMatchObject({ status: 400 });
      await expect(post({ email: 'a@b.co' })).resolves.toMatchObject({ status: 400 });
      await expect(post({})).resolves.toMatchObject({ status: 400 });
    });

    it('reports every invalid field at once', async () => {
      const response = await post({ email: 'bad', password: 'tiny' });

      // Accumulated across sources, so a client fixes both in one round trip.
      const fields = Object.keys(response.body.error.details.fields as Record<string, unknown>);
      expect(fields.sort()).toEqual(['body.email', 'body.password']);
    });

    it('never echoes the submitted password back', async () => {
      const response = await post({ ...validBody, password: 'short' });
      const serialised = JSON.stringify(response.body);

      // A validation error that quoted the offending value would put a password — very
      // likely a real one, mistyped — into logs and error trackers.
      expect(serialised).not.toContain('short');
      expect(serialised).not.toContain(validBody.password);
    });

    it('rejects a malformed JSON body with the standard envelope', async () => {
      const response = await request(buildApp())
        .post('/api/v1/auth/register')
        .set('content-type', 'application/json')
        .send('{"email": "a@b.co", password');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MALFORMED_JSON');
    });
  });

  /* ── No leakage ────────────────────────────────────────────────────────── */

  describe('response hygiene', () => {
    it('never returns a password hash on success', async () => {
      const response = await post(validBody);
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('password_hash');
      expect(serialised).not.toContain(validBody.password);
    });

    it('does not expose internal columns', async () => {
      const response = await post(validBody);

      // An allowlist mapper, so a column added in a later phase is invisible until somebody
      // publishes it deliberately.
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
  });
});
