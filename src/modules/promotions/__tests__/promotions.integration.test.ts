import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { auditLog } from '../../../db/schema/identity.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { promotion } from '../../../db/schema/promotions.js';
import { store } from '../../../db/schema/store.js';
import { createApp } from '../../../http/app.js';
import { createScopeGuards } from '../../../http/middleware/scope.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createPromotionsRepository } from '../promotions.repository.js';
import { createPromotionsRoutes } from '../promotions.routes.js';
import { createPromotionsService } from '../promotions.service.js';

/**
 * Promotion configuration — the staff surface, against real PostgreSQL.
 *
 * Four properties carry this suite:
 *
 *  1. **The discount shape is a database guarantee.** A promotion carrying both a percentage
 *     and an amount, or neither, is refused by `ck_promotion_shape` — asserted from direct SQL,
 *     because a test that only speaks HTTP cannot tell a Zod refinement from a CHECK.
 *
 *  2. **Coupon codes are case-insensitive and per-store.** `SAVE10` and `save10` cannot both be
 *     live in one store, and either finds the other; two stores may each have `SAVE10`.
 *
 *  3. **Staff only, every route.** Read from the database on each request, so a demotion takes
 *     effect immediately rather than at token expiry.
 *
 *  4. **Configuration is audited; nothing is published.** Three staff actions produce audit rows
 *     with field NAMES only, and the outbox stays empty because no consumer exists.
 */
describe('promotions (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const CODE = 'SAVE10';

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
    const identityRepository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const repository = createPromotionsRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const promotions = createPromotionsService({
      repository,
      db: db(),
      audit: testRecorders(db()).audit,
      logger: silentLogger,
    });

    const scopeGuards = createScopeGuards({
      loadSubject: async (params) => identityRepository.findSubjectById(params),
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
    apiRouter.use(
      createPromotionsRoutes({
        promotions,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      promotions,
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { email?: string; storeId?: string; staff?: boolean } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'staff@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    if (options.staff !== false) {
      await db().execute(sql`update app_user set is_staff = true where id = ${user.id}`);
    }

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  const staffApp = async () => {
    const built = build();
    const auth = await signIn(built.app, built.identity);
    return { ...built, ...auth };
  };

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const PERCENT = {
    code: CODE,
    name: 'Festive 10% off',
    discountType: 'percentage',
    percentRate: '10',
  };
  const FIXED = {
    code: 'FLAT250',
    name: 'Flat 250 off',
    discountType: 'fixed_amount',
    amount: '250.0000',
  };

  const create = (app: App, body: unknown, token?: string) => {
    const req = request(app).post('/api/v1/admin/promotions');
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const list = (app: App, query = '', token?: string) => {
    const req = request(app).get(`/api/v1/admin/promotions${query}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const read = (app: App, code: string, token?: string) => {
    const req = request(app).get(`/api/v1/admin/promotions/${code}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const patch = (app: App, code: string, body: unknown, token?: string) => {
    const req = request(app).patch(`/api/v1/admin/promotions/${code}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const remove = (app: App, code: string, token?: string) => {
    const req = request(app).delete(`/api/v1/admin/promotions/${code}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const rows = async () => db().select().from(promotion);

  /** Typed reader; supertest hands back `any`. */
  const codesOf = (body: { promotions: { code: string }[] }): string[] =>
    body.promotions.map((p) => p.code);

  async function expectConstraint(work: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the write to be refused').toBeDefined();
    const chain = [caught, (caught as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join(' | ');
    expect(chain).toContain(constraint);
  }

  /** Insert a row bypassing the service entirely, to test a DATABASE constraint. */
  const rawPromotion = (overrides: Record<string, unknown> = {}) =>
    db()
      .insert(promotion)
      .values({
        id: newId(),
        storeId,
        code: `RAW-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Raw',
        discountType: 'percentage',
        percentRate: '10',
        ...overrides,
      } as never);

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('rejects unauthenticated requests on every route', async () => {
      const { app } = build();

      for (const response of [
        await create(app, PERCENT),
        await list(app),
        await read(app, CODE),
        await patch(app, CODE, { name: 'x' }),
        await remove(app, CODE),
      ]) {
        expect(response.status).toBe(401);
      }
      expect(await rows()).toEqual([]);
    });

    it('rejects a CUSTOMER on every route with 403', async () => {
      const built = build();
      const customer = await signIn(built.app, built.identity, {
        email: 'customer@example.com',
        staff: false,
      });
      const { app } = built;

      for (const response of [
        await create(app, PERCENT, customer.token),
        await list(app, '', customer.token),
        await read(app, CODE, customer.token),
        await patch(app, CODE, { name: 'x' }, customer.token),
        await remove(app, CODE, customer.token),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
      }
      expect(await rows()).toEqual([]);
    });

    it('revokes access the moment staff is withdrawn, without a new token', async () => {
      const { app, token, userId } = await staffApp();
      expect((await list(app, '', token)).status).toBe(200);

      await db().execute(sql`update app_user set is_staff = false where id = ${userId}`);

      // The scope is read from the database per request (§22), so the still-valid token is not
      // enough — this is what makes a demotion immediate rather than pending token expiry.
      expect((await list(app, '', token)).status).toBe(403);
    });
  });

  /* ── Create ────────────────────────────────────────────────────────────── */

  describe('create', () => {
    it('creates a percentage promotion and returns an exact response shape', async () => {
      const { app, token } = await staffApp();

      const response = await create(app, PERCENT, token);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['promotion']);
      expect(Object.keys(response.body.promotion).sort()).toEqual([
        'amount',
        'code',
        'createdAt',
        'discountType',
        'endsAt',
        'id',
        'isActive',
        'minSubtotal',
        'name',
        'percentRate',
        'startsAt',
        'updatedAt',
      ]);
      // No tenancy or soft-delete field reaches a response, even though the row carries both.
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('storeId');
      expect(serialised).not.toContain('deletedAt');
    });

    it('defaults the optional fields the way the columns do', async () => {
      const { app, token } = await staffApp();

      const response = await create(app, PERCENT, token);

      expect(response.body.promotion.isActive).toBe(true);
      expect(response.body.promotion.minSubtotal).toBeNull();
      expect(response.body.promotion.startsAt).toBeNull();
      expect(response.body.promotion.endsAt).toBeNull();
      expect(response.body.promotion.amount).toBeNull();
      // `NUMERIC(9,6)` comes back at its full scale: the column, not the input, decides.
      expect(response.body.promotion.percentRate).toBe('10.000000');
    });

    it('creates a fixed-amount promotion', async () => {
      const { app, token } = await staffApp();

      const response = await create(app, FIXED, token);

      expect(response.status).toBe(201);
      expect(response.body.promotion.discountType).toBe('fixed_amount');
      expect(response.body.promotion.amount).toBe('250.0000');
      expect(response.body.promotion.percentRate).toBeNull();
    });

    it('stores the code in the case the merchant supplied', async () => {
      const { app, token } = await staffApp();

      const response = await create(app, { ...PERCENT, code: 'Diwali_2026' }, token);

      // Not uppercased, not lowercased. Matching is case-insensitive in the database, so there
      // is no reason to take the merchant's presentation away from them.
      expect(response.body.promotion.code).toBe('Diwali_2026');
      expect((await rows())[0]?.code).toBe('Diwali_2026');
    });

    it('trims the code and the name', async () => {
      const { app, token } = await staffApp();

      const response = await create(
        app,
        { ...PERCENT, code: '  SAVE10  ', name: '  Ten  ' },
        token,
      );

      expect(response.body.promotion.code).toBe('SAVE10');
      expect(response.body.promotion.name).toBe('Ten');
    });

    it('accepts a full window and a minimum', async () => {
      const { app, token } = await staffApp();

      const response = await create(
        app,
        {
          ...PERCENT,
          minSubtotal: '1000.0000',
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: '2026-10-31T00:00:00.000Z',
          isActive: false,
        },
        token,
      );

      expect(response.status).toBe(201);
      expect(response.body.promotion.minSubtotal).toBe('1000.0000');
      expect(response.body.promotion.startsAt).toBe('2026-10-01T00:00:00.000Z');
      expect(response.body.promotion.isActive).toBe(false);
    });

    it('accepts an offset instant as readily as a Z instant', async () => {
      const { app, token } = await staffApp();

      const response = await create(
        app,
        {
          ...PERCENT,
          startsAt: '2026-10-01T00:00:00+05:30',
          endsAt: '2026-10-01T00:00:00Z',
        },
        token,
      );

      /**
       * `+05:30` is EARLIER than the `Z` value here, so the window is valid — and a string
       * comparison of the two would have rejected it. The check compares instants, which is
       * the only reading that is correct in both notations.
       */
      expect(response.status).toBe(201);
      expect(response.body.promotion.startsAt).toBe('2026-09-30T18:30:00.000Z');
    });

    it('rejects a bare local date — no timezone is chosen silently', async () => {
      const { app, token } = await staffApp();

      const response = await create(app, { ...PERCENT, startsAt: '2026-10-01' }, token);

      // This build takes absolute instants. Accepting a date would mean interpreting it in some
      // timezone, and choosing one without being told is exactly the decision not made here.
      expect(response.status).toBe(400);
    });
  });

  /* ── The discount shape ────────────────────────────────────────────────── */

  describe('discount shape', () => {
    it('rejects a percentage with no rate, and a fixed amount with none', async () => {
      const { app, token } = await staffApp();

      const noRate = await create(
        app,
        { code: 'A1', name: 'A', discountType: 'percentage' },
        token,
      );
      expect(noRate.status).toBe(400);
      expect(JSON.stringify(noRate.body.error.details)).toContain('percentRate');

      const noAmount = await create(
        app,
        { code: 'B1', name: 'B', discountType: 'fixed_amount' },
        token,
      );
      expect(noAmount.status).toBe(400);
      expect(JSON.stringify(noAmount.body.error.details)).toContain('amount');
    });

    it('rejects a promotion carrying BOTH a rate and an amount', async () => {
      const { app, token } = await staffApp();

      for (const body of [
        { ...PERCENT, amount: '10.0000' },
        { ...FIXED, percentRate: '10' },
      ]) {
        const response = await create(app, body, token);
        expect(response.status).toBe(400);
      }
      expect(await rows()).toEqual([]);
    });

    it('rejects an unknown discount type', async () => {
      const { app, token } = await staffApp();

      const response = await create(
        app,
        { code: 'C1', name: 'C', discountType: 'buy_x_get_y', percentRate: '10' },
        token,
      );

      // Not implemented, and not silently accepted as configuration nothing evaluates.
      expect(response.status).toBe(400);
    });

    it('rejects a percentage of 0, over 100, or negative', async () => {
      const { app, token } = await staffApp();

      for (const percentRate of ['0', '0.000000', '100.000001', '101', '150']) {
        const response = await create(app, { ...PERCENT, percentRate }, token);
        expect(response.status, percentRate).toBe(400);
      }
      // A negative fails the pattern rather than the bound; both are a 400.
      expect((await create(app, { ...PERCENT, percentRate: '-10' }, token)).status).toBe(400);
    });

    it('accepts exactly 100 percent, and six decimal places', async () => {
      const { app, token } = await staffApp();

      expect((await create(app, { ...PERCENT, percentRate: '100' }, token)).status).toBe(201);
      const precise = await create(
        app,
        { ...PERCENT, code: 'THIRD', percentRate: '33.333333' },
        token,
      );
      expect(precise.status).toBe(201);
      // Carried exactly. A JSON number could not have held this.
      expect(precise.body.promotion.percentRate).toBe('33.333333');
    });

    it('rejects a zero or negative fixed amount', async () => {
      const { app, token } = await staffApp();

      for (const amount of ['0', '0.0000', '-1.0000']) {
        expect((await create(app, { ...FIXED, amount }, token)).status, amount).toBe(400);
      }
    });

    it('rejects a rate or amount sent as a JSON number', async () => {
      const { app, token } = await staffApp();

      // A double cannot hold 33.333333 exactly, which is why every monetary and rate field on
      // the wire is a string.
      expect((await create(app, { ...PERCENT, percentRate: 10 }, token)).status).toBe(400);
      expect((await create(app, { ...FIXED, amount: 250 }, token)).status).toBe(400);
    });

    it('rejects more precision than the column holds', async () => {
      const { app, token } = await staffApp();

      expect((await create(app, { ...PERCENT, percentRate: '10.0000001' }, token)).status).toBe(
        400,
      );
      expect((await create(app, { ...FIXED, amount: '250.00001' }, token)).status).toBe(400);
    });

    it('rejects a window that closes before it opens', async () => {
      const { app, token } = await staffApp();

      const response = await create(
        app,
        { ...PERCENT, startsAt: '2026-10-31T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' },
        token,
      );

      // A promotion that can never apply, and nothing would ever report it: the coupon would
      // simply always 404.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('endsAt');
    });

    it('rejects equal start and end instants', async () => {
      const { app, token } = await staffApp();

      const at = '2026-10-01T00:00:00Z';
      expect((await create(app, { ...PERCENT, startsAt: at, endsAt: at }, token)).status).toBe(400);
    });
  });

  /* ── Forged fields ─────────────────────────────────────────────────────── */

  describe('forged fields', () => {
    it('rejects every unsettable field on create, one at a time', async () => {
      const { app, token } = await staffApp();

      /**
       * One per request rather than all in one body, so a schema that happened to accept
       * exactly one of them cannot hide behind the others.
       */
      for (const extra of [
        { id: newId() },
        { storeId: newId() },
        { userId: newId() },
        { actorUserId: newId() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { deletedAt: new Date().toISOString() },
        { redeemedCount: 5 },
        { maxRedemptions: 5 },
      ]) {
        const response = await create(app, { ...PERCENT, ...extra }, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await rows()).toEqual([]);
    });

    it('rejects the same fields on update', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      for (const extra of [
        { id: newId() },
        { storeId: newId() },
        { actorUserId: newId() },
        { deletedAt: new Date().toISOString() },
      ]) {
        const response = await patch(app, CODE, extra, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
      }
      expect((await rows())[0]?.storeId).toBe(storeId);
    });

    it('rejects an empty update body', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      // A PATCH that changes nothing would still bump `updated_at` and write an audit row
      // claiming a change.
      expect((await patch(app, CODE, {}, token)).status).toBe(400);
    });
  });

  /* ── Code uniqueness and case ──────────────────────────────────────────── */

  describe('code uniqueness', () => {
    it('refuses a duplicate code with 409', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      const response = await create(app, { ...PERCENT, name: 'Another' }, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PROMOTION_CODE_TAKEN');
      expect(await rows()).toHaveLength(1);
    });

    it('refuses a duplicate differing only in CASE', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      const response = await create(app, { ...PERCENT, code: 'save10' }, token);

      // `SAVE10` and `save10` as two live coupons would make the customer lookup ambiguous and
      // force it to pick one arbitrarily.
      expect(response.status).toBe(409);
      expect(await rows()).toHaveLength(1);
    });

    it('finds a promotion by any casing of its code', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      for (const variant of ['SAVE10', 'save10', 'Save10', 'sAvE10']) {
        const response = await read(app, variant, token);
        expect(response.status, variant).toBe(200);
        expect(response.body.promotion.code).toBe('SAVE10');
      }
    });

    it('lets a DELETED code be reused immediately', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);
      expect((await remove(app, CODE, token)).status).toBe(204);

      // The uniqueness index is partial on `deleted_at IS NULL`, so a retired `DIWALI24` does
      // not block next year's.
      const response = await create(app, { ...PERCENT, name: 'This year' }, token);
      expect(response.status).toBe(201);
      expect(await rows()).toHaveLength(2);
    });

    it('lets two STORES each have the same code', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      const mine = await staffApp();
      expect((await create(mine.app, PERCENT, mine.token)).status).toBe(201);

      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });

      // Uniqueness is per store: one merchant's coupon must not block another's.
      expect((await create(theirs.app, PERCENT, bob.token)).status).toBe(201);
      expect(await rows()).toHaveLength(2);
    });

    it('rejects a malformed code before it reaches PostgreSQL', async () => {
      const { app, token } = await staffApp();

      for (const code of ['-leading', 'has space', 'a'.repeat(65), '']) {
        expect((await create(app, { ...PERCENT, code }, token)).status, code).toBe(400);
      }
    });
  });

  /* ── Read, list, update, delete ────────────────────────────────────────── */

  describe('read and list', () => {
    it('404s an unknown code', async () => {
      const { app, token } = await staffApp();

      const response = await read(app, 'NO-SUCH', token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('lists inactive and out-of-window promotions, but never deleted ones', async () => {
      const { app, token } = await staffApp();
      await create(app, { ...PERCENT, code: 'LIVE' }, token);
      await create(app, { ...PERCENT, code: 'PAUSED', isActive: false }, token);
      await create(app, { ...PERCENT, code: 'FUTURE', startsAt: '2030-01-01T00:00:00Z' }, token);
      await create(app, { ...PERCENT, code: 'GONE' }, token);
      await remove(app, 'GONE', token);

      const response = await list(app, '', token);

      /**
       * A merchant must see the coupon they paused and the one they scheduled — those are
       * exactly the rows they need to act on. A deleted one is not, because there is no restore.
       */
      expect(codesOf(response.body)).toEqual(['FUTURE', 'LIVE', 'PAUSED']);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 3 });
    });

    it('pages, and the total matches the page predicate', async () => {
      const { app, token } = await staffApp();
      for (const code of ['A1', 'B1', 'C1', 'D1', 'E1']) {
        await create(app, { ...PERCENT, code }, token);
      }

      const page = await list(app, '?limit=2&offset=2', token);

      expect(codesOf(page.body)).toEqual(['C1', 'D1']);
      // The page and the total share one predicate, so a caller on the last page is never told
      // the total counted rows it cannot see.
      expect(page.body.pagination).toEqual({ limit: 2, offset: 2, total: 5 });
    });

    it('rejects malformed pagination rather than clamping it', async () => {
      const { app, token } = await staffApp();

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=',
        '?offset=',
        '?limit=2.5',
        '?page=1',
      ]) {
        expect((await list(app, query, token)).status, query).toBe(400);
      }
    });
  });

  describe('update', () => {
    it('changes one field and leaves the rest alone', async () => {
      const { app, token } = await staffApp();
      await create(app, { ...PERCENT, minSubtotal: '500.0000' }, token);

      const response = await patch(app, CODE, { name: 'Renamed' }, token);

      expect(response.status).toBe(200);
      expect(response.body.promotion.name).toBe('Renamed');
      expect(response.body.promotion.percentRate).toBe('10.000000');
      expect(response.body.promotion.minSubtotal).toBe('500.0000');
    });

    it('distinguishes "leave alone" from "clear"', async () => {
      const { app, token } = await staffApp();
      await create(
        app,
        { ...PERCENT, minSubtotal: '500.0000', endsAt: '2030-01-01T00:00:00Z' },
        token,
      );

      // Absent: untouched.
      await patch(app, CODE, { name: 'x' }, token);
      expect((await read(app, CODE, token)).body.promotion.minSubtotal).toBe('500.0000');

      // Explicit null: cleared. Two genuinely different intentions, and a PATCH must express both.
      const cleared = await patch(app, CODE, { minSubtotal: null, endsAt: null }, token);
      expect(cleared.body.promotion.minSubtotal).toBeNull();
      expect(cleared.body.promotion.endsAt).toBeNull();
    });

    it('switches discount type and rewrites BOTH value columns', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      const response = await patch(
        app,
        CODE,
        { discountType: 'fixed_amount', amount: '99.0000' },
        token,
      );

      /**
       * The old rate must be cleared in the same statement. A row carrying a fixed amount AND
       * its former percentage would fail `ck_promotion_shape` — the constraint doing its job,
       * but a 500 for the merchant.
       */
      expect(response.status).toBe(200);
      expect(response.body.promotion.discountType).toBe('fixed_amount');
      expect(response.body.promotion.amount).toBe('99.0000');
      expect(response.body.promotion.percentRate).toBeNull();
    });

    it('rejects a value that contradicts the new type', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      const response = await patch(
        app,
        CODE,
        { discountType: 'fixed_amount', percentRate: '20' },
        token,
      );

      expect(response.status).toBe(400);
    });

    it('changes just the rate of an existing percentage promotion', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      // No `discountType` restated. The service validates the value against the STORED type,
      // so a price edit does not have to repeat what the promotion already is.
      const response = await patch(app, CODE, { percentRate: '25' }, token);

      expect(response.status).toBe(200);
      expect(response.body.promotion.percentRate).toBe('25.000000');
      expect(response.body.promotion.amount).toBeNull();
    });

    it('renames the code, case-insensitively unique', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);
      await create(app, { ...PERCENT, code: 'OTHER' }, token);

      expect((await patch(app, CODE, { code: 'other' }, token)).status).toBe(409);
      expect((await patch(app, CODE, { code: 'SAVE20' }, token)).status).toBe(200);
      expect((await read(app, 'save20', token)).status).toBe(200);
      expect((await read(app, CODE, token)).status).toBe(404);
    });

    it('allows a promotion to keep its own code on update', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      // The collision check must exclude the row being updated, or no promotion could ever be
      // edited while restating its code.
      expect((await patch(app, CODE, { code: CODE, name: 'Same code' }, token)).status).toBe(200);
    });

    it('404s an unknown code', async () => {
      const { app, token } = await staffApp();

      expect((await patch(app, 'NO-SUCH', { name: 'x' }, token)).status).toBe(404);
    });
  });

  describe('delete', () => {
    it('soft-deletes and 404s afterwards', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      expect((await remove(app, CODE, token)).status).toBe(204);
      expect((await read(app, CODE, token)).status).toBe(404);
      expect((await patch(app, CODE, { name: 'x' }, token)).status).toBe(404);
      expect((await remove(app, CODE, token)).status).toBe(404);

      // The ROW survives — which is what keeps the cart's RESTRICT foreign key satisfiable.
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.deletedAt).not.toBeNull();
    });

    it('has no restore route', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);
      await remove(app, CODE, token);

      const response = await request(app)
        .post(`/api/v1/admin/promotions/${CODE}/restore`)
        .set('Authorization', `Bearer ${token}`);

      // Reviving a retired coupon is a new promotion; an undelete would need its own
      // uniqueness story once the code had been reused.
      expect(response.status).toBe(404);
    });
  });

  /* ── Tenant isolation ──────────────────────────────────────────────────── */

  describe('tenant isolation', () => {
    it('hides another store’s promotions from every route', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      const mine = await staffApp();
      await create(mine.app, PERCENT, mine.token);

      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });

      expect((await read(theirs.app, CODE, bob.token)).status).toBe(404);
      expect((await patch(theirs.app, CODE, { name: 'Hijacked' }, bob.token)).status).toBe(404);
      expect((await remove(theirs.app, CODE, bob.token)).status).toBe(404);
      expect((await list(theirs.app, '', bob.token)).body.promotions).toEqual([]);

      // Untouched throughout.
      expect((await read(mine.app, CODE, mine.token)).body.promotion.name).toBe(PERCENT.name);
    });

    it('scopes every repository read by store', async () => {
      const built = await staffApp();
      await create(built.app, PERCENT, built.token);
      const { repository } = built;
      const at = new Date();

      /**
       * Asserted at the REPOSITORY level as well as through HTTP. A guarantee that lives only
       * in a route is one refactor from a leak, and a future caller arriving from a CLI command
       * gets no middleware at all.
       */
      expect(await repository.findByCodeForAdmin({ storeId: newId(), code: CODE })).toBeUndefined();
      expect(await repository.findLiveByCode({ storeId: newId(), code: CODE, at })).toBeUndefined();
      expect(await repository.listPromotions({ storeId: newId(), limit: 10, offset: 0 })).toEqual({
        items: [],
        total: 0,
      });
      expect(await repository.softDeletePromotion({ storeId: newId(), code: CODE, at })).toBe(
        false,
      );
      expect((await rows())[0]?.deletedAt).toBeNull();
    });
  });

  /* ── The live predicate ────────────────────────────────────────────────── */

  describe('live predicate', () => {
    /**
     * The customer-facing lookup, exercised at the repository because the customer-facing HTTP
     * route belongs to the cart module. What matters here is that ONE predicate decides
     * liveness for both the apply path and the re-evaluation path.
     */
    const at = (iso: string) => new Date(iso);
    const NOW = '2026-10-15T12:00:00Z';

    async function seed(overrides: Record<string, unknown>) {
      const built = await staffApp();
      await create(built.app, { ...PERCENT, ...overrides }, built.token);
      return built;
    }

    it('finds a live promotion by code, case-insensitively', async () => {
      const { repository } = await seed({});

      expect(
        await repository.findLiveByCode({ storeId, code: 'save10', at: at(NOW) }),
      ).toBeDefined();
    });

    it('hides an inactive promotion', async () => {
      const { repository } = await seed({ isActive: false });

      expect(await repository.findLiveByCode({ storeId, code: CODE, at: at(NOW) })).toBeUndefined();
    });

    it('hides a soft-deleted promotion', async () => {
      const built = await seed({});
      await remove(built.app, CODE, built.token);

      expect(
        await built.repository.findLiveByCode({ storeId, code: CODE, at: at(NOW) }),
      ).toBeUndefined();
    });

    it('hides a promotion that has not started', async () => {
      const { repository } = await seed({ startsAt: '2026-11-01T00:00:00Z' });

      expect(await repository.findLiveByCode({ storeId, code: CODE, at: at(NOW) })).toBeUndefined();
    });

    it('hides a promotion that has ended', async () => {
      const { repository } = await seed({ endsAt: '2026-10-01T00:00:00Z' });

      expect(await repository.findLiveByCode({ storeId, code: CODE, at: at(NOW) })).toBeUndefined();
    });

    it('treats startsAt as INCLUSIVE and endsAt as EXCLUSIVE', async () => {
      const start = '2026-10-01T00:00:00Z';
      const end = '2026-10-31T00:00:00Z';
      const { repository } = await seed({ startsAt: start, endsAt: end });

      /**
       * A half-open window, the same convention as every range in this system. The end instant
       * itself does NOT apply, so a promotion "ending 31 October" does not fire at the moment
       * that date begins — and two consecutive windows cannot both be live for one instant.
       */
      expect(await repository.findLiveByCode({ storeId, code: CODE, at: at(start) })).toBeDefined();
      expect(await repository.findLiveByCode({ storeId, code: CODE, at: at(end) })).toBeUndefined();
      expect(
        await repository.findLiveByCode({
          storeId,
          code: CODE,
          at: new Date(Date.parse(end) - 1),
        }),
      ).toBeDefined();
    });

    it('finds a live promotion by id, so a rename does not break an applied coupon', async () => {
      const built = await seed({});
      const id = (await rows())[0]!.id;
      await patch(built.app, CODE, { code: 'RENAMED' }, built.token);

      // `cart_promotion` holds the id precisely so that a merchant editing a coupon's code has
      // not handed the customer a different coupon.
      expect(await built.repository.findLiveById({ storeId, id, at: at(NOW) })).toBeDefined();
    });
  });

  /* ── Audit and events ──────────────────────────────────────────────────── */

  describe('audit and events', () => {
    it('audits create, update and delete with field NAMES only', async () => {
      const { app, token, userId } = await staffApp();
      await create(app, PERCENT, token);
      await patch(app, CODE, { name: 'Renamed', percentRate: '25' }, token);
      await remove(app, CODE, token);

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'promotion'));

      expect(entries.map((e) => e.action).sort()).toEqual([
        'promotion.created',
        'promotion.deleted',
        'promotion.updated',
      ]);
      for (const entry of entries) {
        expect(entry.actorType).toBe('staff');
        expect(entry.actorUserId).toBe(userId);
        expect(entry.storeId).toBe(storeId);
      }

      /**
       * The update records WHICH fields changed and not what they became. A coupon's terms are
       * commercially sensitive, and `audit_log`'s own doc comment notes it is read by more
       * people than the database and frequently shipped to a log aggregator with different
       * access controls — the same judgement §40 made for addresses.
       */
      const updated = entries.find((e) => e.action === 'promotion.updated');
      const metadata = JSON.stringify(updated?.metadata);
      expect(metadata).toContain('name');
      expect(metadata).toContain('percentRate');
      expect(metadata).not.toContain('Renamed');
      expect(metadata).not.toContain('25');
    });

    it('rolls the audit entry back with the write', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);

      // A duplicate is refused AFTER the transaction opens, so the audit entry the create would
      // have written must not survive. A trail claiming a creation that did not happen is worse
      // than no entry at all.
      expect((await create(app, PERCENT, token)).status).toBe(409);

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'promotion'));
      expect(entries).toHaveLength(1);
    });

    it('publishes NO events for any promotion change', async () => {
      const { app, token } = await staffApp();
      await create(app, PERCENT, token);
      await patch(app, CODE, { name: 'x' }, token);
      await remove(app, CODE, token);

      /**
       * Deliberate, and asserted so that adding one later is a conscious decision rather than
       * an accident. Nothing consumes a promotion change: the handler registry is empty and no
       * checkout exists.
       */
      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'promotion')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('promotion.'))).toEqual([]);
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * Each of these writes with direct SQL, bypassing the service and Zod entirely, and asserts
     * the NAMED constraint that refuses it. That is what distinguishes a database guarantee
     * from an application check — a seed script or an operator running SQL passes through
     * neither Zod nor the service.
     */
    it('refuses an unknown discount type', async () => {
      await expectConstraint(
        rawPromotion({ discountType: 'buy_x_get_y' }),
        'ck_promotion_discount_type',
      );
    });

    it('refuses a percentage with no rate', async () => {
      await expectConstraint(
        rawPromotion({ discountType: 'percentage', percentRate: null }),
        'ck_promotion_shape',
      );
    });

    it('refuses a fixed amount with no amount', async () => {
      await expectConstraint(
        rawPromotion({ discountType: 'fixed_amount', percentRate: null, amount: null }),
        'ck_promotion_shape',
      );
    });

    it('refuses a promotion carrying BOTH values', async () => {
      await expectConstraint(
        rawPromotion({ discountType: 'percentage', percentRate: '10', amount: '5.0000' }),
        'ck_promotion_shape',
      );
    });

    it('refuses a fixed amount that also names a rate', async () => {
      await expectConstraint(
        rawPromotion({ discountType: 'fixed_amount', amount: '5.0000', percentRate: '10' }),
        'ck_promotion_shape',
      );
    });

    it('refuses a percentage of 0 or over 100', async () => {
      for (const percentRate of ['0', '100.000001', '-5']) {
        await expectConstraint(rawPromotion({ percentRate }), 'ck_promotion_percent_range');
      }
    });

    it('refuses a non-positive fixed amount', async () => {
      for (const amount of ['0', '-1.0000']) {
        await expectConstraint(
          rawPromotion({ discountType: 'fixed_amount', percentRate: null, amount }),
          'ck_promotion_amount_positive',
        );
      }
    });

    it('refuses a negative minimum subtotal', async () => {
      await expectConstraint(rawPromotion({ minSubtotal: '-1.0000' }), 'ck_promotion_min_subtotal');
    });

    it('refuses a window that closes before it opens', async () => {
      await expectConstraint(
        rawPromotion({
          startsAt: new Date('2026-10-31T00:00:00Z'),
          endsAt: new Date('2026-10-01T00:00:00Z'),
        }),
        'ck_promotion_window',
      );
    });

    it('accepts an open-ended window', async () => {
      await rawPromotion({ code: 'OPEN1', startsAt: new Date('2026-10-01T00:00:00Z') });
      await rawPromotion({ code: 'OPEN2', endsAt: new Date('2026-10-01T00:00:00Z') });

      // Either end may be NULL: no start means already running, no end means until deactivated.
      expect(await rows()).toHaveLength(2);
    });

    it('refuses a duplicate live code differing only in case, from direct SQL', async () => {
      await rawPromotion({ code: 'SAVE10' });

      // `lower(code)` in the index is the enforcement, so a bulk import that forgets to
      // normalise cannot create a second `Save10`.
      await expectConstraint(rawPromotion({ code: 'save10' }), 'uq_promotion_code_active');
    });

    it('refuses a promotion in a nonexistent store', async () => {
      await expectConstraint(rawPromotion({ storeId: newId() }), 'promotion_store_id_store_id_fk');
    });
  });
});
