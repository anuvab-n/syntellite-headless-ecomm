import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product } from '../../../db/schema/catalogue.js';
import { appUser } from '../../../db/schema/identity.js';
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
import { newId } from '../../../shared/id.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCatalogueRepository } from '../catalogue.repository.js';
import { createCatalogueRoutes } from '../catalogue.routes.js';
import { createCatalogueService } from '../catalogue.service.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * POST /api/v1/admin/products — against real PostgreSQL.
 *
 * The first production consumer of `requireScope`, so this suite is as much about the
 * authorization boundary as about the catalogue: an unprivileged customer, a staff member, and
 * a staff member demoted mid-session all have to behave correctly against a real database.
 *
 * Assembled the way the composition root assembles it, including the cross-module wiring — the
 * catalogue router receives a token verifier and a pre-built guard, because it is forbidden
 * from importing identity.
 */
describe('POST /api/v1/admin/products (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';

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

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const catalogue = createCatalogueService({
      repository: createCatalogueRepository({ db: db() }),
      db: db(),
      ...testRecorders(db()),
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
      createCatalogueRoutes({
        catalogue,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      catalogue,
    };
  }

  type App = ReturnType<typeof build>['app'];

  /** Register, optionally grant staff, then sign in. */
  async function signIn(
    app: App,
    identity: ReturnType<typeof build>['identity'],
    options: { staff?: boolean; email?: string; targetStoreId?: string } = {},
  ): Promise<{ accessToken: string; userId: string }> {
    const email = options.email ?? 'staff@example.com';
    const user = await identity.registerCustomer({
      storeId: options.targetStoreId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    if (options.staff === true) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);

    return { accessToken: response.body.accessToken, userId: user.id };
  }

  const create = (app: App, body: unknown, token?: string) => {
    const req = request(app).post('/api/v1/admin/products');
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  /**
   * A valid product body — with NO price.
   *
   * Price moved to the SKU in Increment 24, and the create schema is strict, so a body still
   * carrying one is a 400. That is asserted deliberately further down rather than left as an
   * incidental consequence of this constant.
   */
  const VALID = { slug: 'blue-cotton-shirt', name: 'Blue Cotton Shirt' };

  const productsIn = async (targetStoreId: string) =>
    db()
      .select({
        id: product.id,
        slug: product.slug,
        name: product.name,
        description: product.description,
        status: product.status,
        storeId: product.storeId,
      })
      .from(product)
      .where(eq(product.storeId, targetStoreId));

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const { app } = build();

      const response = await create(app, VALID);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // Nothing written on a rejected request.
      expect(await productsIn(storeId)).toHaveLength(0);
    });

    it('rejects an invalid access token with 401', async () => {
      const { app } = build();

      const response = await create(app, VALID, 'not.a.jwt');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      const response = await create(app, VALID, accessToken);

      /**
       * 403, not 401. The caller is authenticated and their account is fine — they simply lack
       * the privilege. A 401 would send a valid client off to re-authenticate, which would
       * succeed and change nothing.
       */
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect(await productsIn(storeId)).toHaveLength(0);
    });

    it('allows a staff user', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);

      expect(response.status).toBe(201);
    });

    it('authorizes BEFORE validating, so an unprivileged caller cannot probe the schema', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity);

      // A body that would certainly fail validation, sent by a non-staff caller.
      const response = await create(app, { nonsense: true }, accessToken);

      /**
       * 403, not 400. Validation error messages describe the shape of an admin endpoint; a
       * caller who may not use it should not be able to enumerate its fields by sending
       * garbage. The authorization read is one indexed query, so ordering it first costs
       * nothing worth saving.
       */
      expect(response.status).toBe(403);
    });
  });

  describe('privilege demotion', () => {
    it('denies the next request after staff is revoked, with the same token', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { staff: true });

      expect((await create(app, VALID, accessToken)).status).toBe(201);

      // An administrator revokes the flag. The token is untouched and still valid.
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, userId));

      const after = await create(app, { ...VALID, slug: 'second-shirt' }, accessToken);

      /**
       * The whole reason authorization reads the database. The access token still carries
       * `isStaff: true` and remains cryptographically valid for up to 15 more minutes — a guard
       * that trusted the claim would leave a revoked administrator writing to the catalogue for
       * that entire window.
       */
      expect(after.status).toBe(403);
      expect(await productsIn(storeId)).toHaveLength(1);
    });

    it('grants a promoted user immediately, without re-login', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity);

      expect((await create(app, VALID, accessToken)).status).toBe(403);

      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, userId));

      expect((await create(app, VALID, accessToken)).status).toBe(201);
    });

    it('returns 401, not 403, when a staff account is deactivated', async () => {
      const { app, identity } = build();
      const { accessToken, userId } = await signIn(app, identity, { staff: true });

      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, userId));

      const response = await create(app, VALID, accessToken);

      // A suspended account is an authentication problem, not a permission problem — matching
      // `/users/me`. Telling them they merely lack a privilege would be a misleading hint.
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('successful creation', () => {
    it('returns 201 with the public product shape', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(
        app,
        { ...VALID, description: 'A comfortable everyday shirt.' },
        accessToken,
      );

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['product']);
      /**
       * An EXACT key set, not a presence check. This is what catches an ADDED field — which is
       * how an internal column actually leaks — and a per-field `not.toHaveProperty` list would
       * silently miss any column introduced later.
       */
      expect(Object.keys(response.body.product).sort()).toEqual([
        'createdAt',
        'currency',
        'description',
        'id',
        'name',
        'skus',
        'slug',
        'status',
        'updatedAt',
      ]);
      expect(response.body.product.slug).toBe('blue-cotton-shirt');
      expect(response.body.product.name).toBe('Blue Cotton Shirt');
      expect(response.body.product.description).toBe('A comfortable everyday shirt.');
    });

    it('does not expose storeId or deletedAt', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);

      // `updatedAt` is deliberately NOT here: increment 12 added it to the shared public
      // shape for cache validation. `storeId` and `deletedAt` remain internal.
      for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
        expect(response.body.product, field).not.toHaveProperty(field);
      }
      // The store id must not appear anywhere in the payload, under any key.
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('persists the row with the resolved store', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);
      const rows = await productsIn(storeId);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(response.body.product.id);
      // The store came from resolution, not from the request.
      expect(rows[0]?.storeId).toBe(storeId);
    });

    it('defaults status to draft, so creating never publishes', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);

      expect(response.body.product.status).toBe('draft');
      expect((await productsIn(storeId))[0]?.status).toBe('draft');
    });

    it('honours an explicit status', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, { ...VALID, status: 'active' }, accessToken);

      expect(response.body.product.status).toBe('active');
    });

    it('defaults description to an empty string, never null', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);

      expect(response.body.product.description).toBe('');
      expect((await productsIn(storeId))[0]?.description).toBe('');
    });

    it('REJECTS a price, which now belongs to the SKU', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, { ...VALID, price: '19.9' }, accessToken);

      /**
       * The migration contract test. Price moved to the SKU, and the schema is `strictObject`,
       * so a stale client still sending one is told rather than silently ignored — which would
       * leave a merchant believing they had set a price that went nowhere.
       *
       * Normalisation through `money()`/`toDb()` still happens, on the SKU create path; that is
       * asserted in the SKU suite.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('price');
      expect(await productsIn(storeId)).toHaveLength(0);
    });

    it('returns the STORE currency, which the product does not carry', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, VALID, accessToken);

      expect(response.body.product.currency).toBe('INR');
      // Asserted against the schema: adding a currency column would make this fail, which is
      // the intent — multi-currency is a deliberate later feature with its own design.
      expect(Object.keys(product)).not.toContain('currency');
    });

    it('normalises the slug before storing it', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, { ...VALID, slug: '  Blue-Cotton-Shirt  ' }, accessToken);

      // Trimmed and lowercased, so the stored value matches the unique index exactly.
      expect(response.status).toBe(201);
      expect(response.body.product.slug).toBe('blue-cotton-shirt');
    });
  });

  describe('validation', () => {
    it('rejects a client-supplied storeId', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, { ...VALID, storeId: newId() }, accessToken);

      /**
       * 400, not a silent ignore. `strictObject` means a client probing for a tenancy hole is
       * told plainly that the field does not exist, rather than being led to believe it worked.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(await productsIn(storeId)).toHaveLength(0);
    });

    it('rejects missing required fields', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      /**
       * `slug` and `name` are the only required product fields now. The former "no price"
       * case is gone because a product legitimately has none — it is a 201, and the
       * REJECTS-a-price test above covers the opposite direction.
       */
      for (const body of [{}, { name: 'No slug' }, { slug: 'no-name' }]) {
        const response = await create(app, body, accessToken);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('rejects malformed slugs', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      for (const slug of ['-leading', 'trailing-', 'double--hyphen', 'has space', 'punct!', '']) {
        const response = await create(app, { ...VALID, slug }, accessToken);
        expect(response.status, `slug: "${slug}"`).toBe(400);
      }
    });

    it('rejects malformed prices, including numbers', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      for (const price of ['abc', '-1.00', '1.000005', '', '1e5', '1,000.00']) {
        const response = await create(app, { ...VALID, price }, accessToken);
        expect(response.status, `price: "${String(price)}"`).toBe(400);
      }

      /**
       * A JSON number is rejected outright rather than coerced. `19.99` is already
       * `19.989999...` by the time it is parsed, and silently accepting it would put a
       * rounding error into a catalogue price that later sums into an invoice.
       */
      const numeric = await create(app, { ...VALID, price: 1499.0 }, accessToken);
      expect(numeric.status).toBe(400);
    });

    it('rejects an unknown status', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const response = await create(app, { ...VALID, status: 'published' }, accessToken);
      expect(response.status).toBe(400);
    });
  });

  describe('duplicate slugs', () => {
    it('rejects a duplicate within the same store with 409', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      expect((await create(app, VALID, accessToken)).status).toBe(201);
      const second = await create(app, { ...VALID, name: 'Different name' }, accessToken);

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('PRODUCT_SLUG_TAKEN');
      // The slug is not echoed back — no reflection surface.
      expect(JSON.stringify(second.body)).not.toContain('blue-cotton-shirt');
      expect(await productsIn(storeId)).toHaveLength(1);
    });

    it('enforces uniqueness at the DATABASE, not only in the pre-check', async () => {
      const { catalogue, identity } = build();

      /**
       * A REAL staff user, because `audit_log.actor_user_id` is a foreign key to `app_user`.
       *
       * That constraint is deliberate — an audit entry must not be able to attribute an action
       * to a user who does not exist — and it caught a synthetic id here first.
       */
      const staff = await identity.registerCustomer({
        storeId,
        input: { email: 'racer@example.com', password: PASSWORD, firstName: 'Ada', lastName: 'L' },
      });
      const actor = { type: 'staff', userId: staff.id } as const;

      await catalogue.createProduct({ storeId, actor, input: VALID });

      /**
       * Two concurrent creates both pass the pre-check and race to the insert; the unique index
       * is what actually decides. Driven through the service rather than HTTP so both calls
       * genuinely overlap, and asserted as one success plus one 409 — never two rows.
       */
      const results = await Promise.allSettled([
        catalogue.createProduct({
          storeId,
          actor,
          input: { ...VALID, slug: 'racer' },
        }),
        catalogue.createProduct({
          storeId,
          actor,
          input: { ...VALID, slug: 'racer' },
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

      const racers = (await productsIn(storeId)).filter((r) => r.slug === 'racer');
      expect(racers).toHaveLength(1);
    });
  });

  describe('store isolation', () => {
    it('lets two different stores use the SAME slug', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });
      expect((await create(app, VALID, accessToken)).status).toBe(201);

      // A second tenant, with its own staff user and its own resolver.
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      const second = build('second');
      const secondStaff = await signIn(second.app, second.identity, {
        staff: true,
        email: 'other-staff@example.com',
        targetStoreId: secondStoreId,
      });

      const response = await create(second.app, VALID, secondStaff.accessToken);

      /**
       * The point of a per-store unique index. A global one would let the first merchant to
       * claim `blue-cotton-shirt` block every other merchant on the platform from ever using
       * that URL.
       */
      expect(response.status).toBe(201);
      expect(await productsIn(storeId)).toHaveLength(1);
      expect(await productsIn(secondStoreId)).toHaveLength(1);
    });

    it('writes to the RESOLVED store, not the token store', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });

      // A store-one token presented to the store-three app.
      const other = build('third');
      const response = await create(other.app, VALID, accessToken);

      /**
       * Rejected by `requireAuth` before authorization or the handler run — a token minted for
       * one store cannot act against another. Crucially nothing is written to EITHER store.
       */
      expect(response.status).toBe(401);
      expect(await productsIn(storeId)).toHaveLength(0);
      expect(await productsIn(secondStoreId)).toHaveLength(0);
    });

    it('scopes the slug lookup in the REPOSITORY, not only in the service', async () => {
      const repository = createCatalogueRepository({ db: db() });
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'fourth', name: 'Fourth', isActive: true });

      await repository.insertProduct({
        id: newId(),
        storeId,
        slug: 'shared-slug',
        name: 'Store one product',
        description: '',
        status: 'draft',
      });

      /**
       * Called directly, bypassing every middleware. If the store predicate lived only in the
       * service or the route, this would find the row — and any future caller reaching the
       * repository another way (a CLI command, an import job) would leak across tenants. The
       * guarantee has to be in the query.
       */
      expect(
        await repository.findBySlug({ storeId: secondStoreId, slug: 'shared-slug' }),
      ).toBeUndefined();
      expect((await repository.findBySlug({ storeId, slug: 'shared-slug' }))?.name).toBe(
        'Store one product',
      );
    });

    it('does not let one store staff member write into another store', async () => {
      const { app, identity } = build();
      const { accessToken } = await signIn(app, identity, { staff: true });

      await create(app, VALID, accessToken);

      // Every row created through this app belongs to the resolved store, and there is no
      // request-controlled way to select a different one.
      const all = await db()
        .select({ storeId: product.storeId })
        .from(product)
        .where(and(eq(product.slug, 'blue-cotton-shirt')));
      expect(all.every((r) => r.storeId === storeId)).toBe(true);
    });
  });
});
