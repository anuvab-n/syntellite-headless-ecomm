import { Router } from 'express';
import { eq } from 'drizzle-orm';
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
import { DEFAULT_SKU_PRICE, giveSku } from '../../../../tests/helpers/catalogue.ts';
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
 * GET /api/v1/admin/products/:slug — against real PostgreSQL.
 *
 * The distinguishing property is that this endpoint sees EVERY lifecycle status, where the
 * public read sees only `active`. So the tests that matter are the ones a copy of the public
 * suite would get wrong: draft and archived must be 200 here and 404 there, for the same slug
 * in the same store, within one test.
 *
 * Repository-level coverage is not repeated here. Cross-store scoping of `findBySlug` is
 * asserted in `create-product.integration.test.ts`, and its any-status behaviour in
 * `public-product.integration.test.ts`; this suite covers the HTTP surface those two do not.
 */
describe('GET /api/v1/admin/products/:slug (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const SLUG = 'blue-cotton-shirt';

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
    };
  }

  type App = ReturnType<typeof build>['app'];

  async function signIn(
    app: App,
    identity: ReturnType<typeof build>['identity'],
    options: { staff?: boolean; email?: string; targetStoreId?: string } = {},
  ): Promise<string> {
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
    return response.body.accessToken as string;
  }

  async function givenProduct(
    overrides: {
      /** The SKU price. Price lives on the SKU from Increment 24, not the product. */
      price?: string;
      slug?: string;
      status?: string;
      storeId?: string;
      deletedAt?: Date;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? SLUG,
      name: 'Blue Cotton Shirt',
      description: 'A comfortable everyday shirt.',
      status: overrides.status ?? 'draft',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const adminRead = (app: App, slug: string, token?: string) => {
    const req = request(app).get(`/api/v1/admin/products/${slug}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const publicRead = (app: App, slug: string) => request(app).get(`/api/v1/products/${slug}`);

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await givenProduct();
      const { app } = build();

      const response = await adminRead(app, SLUG);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // No product data reaches an unauthenticated caller.
      expect(JSON.stringify(response.body)).not.toContain('Blue Cotton Shirt');
    });

    it('rejects an invalid access token with 401', async () => {
      await givenProduct();
      const { app } = build();

      const response = await adminRead(app, SLUG, 'not.a.jwt');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity);

      const response = await adminRead(app, SLUG, token);

      /**
       * 403 rather than 404, deliberately different from the cross-store case below. The caller
       * is a legitimate customer of THIS store — the product is not hidden from them by
       * tenancy, they simply may not use an admin endpoint. Answering 404 would misreport a
       * permission problem as a missing resource.
       */
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect(JSON.stringify(response.body)).not.toContain('Blue Cotton Shirt');
    });

    it('denies a staff user demoted mid-session, on the next request', async () => {
      await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      expect((await adminRead(app, SLUG, token)).status).toBe(200);

      await db().update(appUser).set({ isStaff: false });

      // Same token, still cryptographically valid — the guard re-reads the database.
      expect((await adminRead(app, SLUG, token)).status).toBe(403);
    });
  });

  describe('reads every lifecycle status', () => {
    it.each(['draft', 'active', 'archived'])('returns a %s product with 200', async (status) => {
      const created = await givenProduct({ status });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, SLUG, token);

      expect(response.status).toBe(200);
      expect(response.body.product.id).toBe(created.id);
      // The stored status is reported as-is, not normalised or hidden.
      expect(response.body.product.status).toBe(status);
    });

    it('shows staff what the storefront hides, for the same slug and store', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      /**
       * THE property of this increment, asserted in one test so the two endpoints cannot
       * silently converge. A copy of the public suite would get this backwards; an
       * implementation that reused `findPublicBySlug` would fail here.
       */
      expect((await adminRead(app, SLUG, token)).status).toBe(200);
      expect((await publicRead(app, SLUG)).status).toBe(404);
    });

    it('tracks a lifecycle change without a new token', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      expect((await adminRead(app, SLUG, token)).body.product.status).toBe('draft');

      await db().update(product).set({ status: 'archived' }).where(eq(product.id, created.id));

      // Read fresh from the database on every request, like every other read in the project.
      expect((await adminRead(app, SLUG, token)).body.product.status).toBe('archived');
    });
  });

  describe('absent products', () => {
    /** Compared body-to-body, so a leak through the message cannot pass as a matching status. */
    const bodyOf = (response: { body: { error: { code: string; message: string } } }) => ({
      code: response.body.error.code,
      message: response.body.error.message,
    });

    it('returns 404 for an unknown slug', async () => {
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, 'never-existed', token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for a product in another store', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ storeId: secondStoreId, status: 'active' });

      // Staff of store one; the product is active, but belongs to store two.
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, SLUG, token);

      /**
       * 404, not 403. Staff privilege is scoped to a store, and confirming a product exists in
       * another tenant's catalogue would leak across that boundary — `NotFound`'s own contract
       * is that ownership belongs in the query.
       */
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Blue Cotton Shirt');
    });

    it('returns 404 for a soft-deleted product', async () => {
      await givenProduct({ status: 'active', deletedAt: new Date() });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      // Deleted means gone, even to an administrator, and even when the row was active.
      expect((await adminRead(app, SLUG, token)).status).toBe(404);
    });

    it('gives BYTE-IDENTICAL responses for unknown, cross-store, and deleted', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ slug: 'another-store', storeId: secondStoreId, status: 'active' });
      await givenProduct({ slug: 'a-deleted', status: 'active', deletedAt: new Date() });

      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const responses = await Promise.all(
        ['another-store', 'a-deleted', 'never-existed'].map((slug) => adminRead(app, slug, token)),
      );

      const [first] = responses;
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(bodyOf(response)).toEqual(bodyOf(first!));
      }
    });
  });

  describe('validation', () => {
    it('rejects a malformed slug with 400', async () => {
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      for (const slug of ['-leading', 'double--hyphen', 'punct%21']) {
        const response = await adminRead(app, slug, token);
        expect(response.status, slug).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('resolves a slug differing only in case', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      // Normalised by the shared param schema, exactly as the create endpoint normalised the
      // value it stored.
      expect((await adminRead(app, 'BLUE-Cotton-Shirt', token)).status).toBe(200);
    });
  });

  describe('response shape', () => {
    it('returns exactly the shared product shape', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, SLUG, token);

      expect(Object.keys(response.body)).toEqual(['product']);
      /**
       * The SAME nine keys create, publish, archive, and the public read all return. An exact
       * set is what catches an ADDED field — the way an internal column actually leaks — and
       * asserting it here is what stops an admin-only field being introduced on the quiet.
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
    });

    it('leaks no internal database fields', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, SLUG, token);

      for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
        expect(response.body.product, field).not.toHaveProperty(field);
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('reports persisted values faithfully', async () => {
      const created = await givenProduct({ status: 'archived' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await adminRead(app, SLUG, token);

      const [row] = await db()
        .select({ status: product.status, name: product.name })
        .from(product)
        .where(eq(product.id, created.id));

      expect(response.body.product.status).toBe(row?.status);
      expect(response.body.product.name).toBe(row?.name);
      // Price is the SKU's now. The admin read shows inactive SKUs too, so the array is the
      // merchant's full view of what this product can be sold as.
      expect(response.body.product.skus[0]?.price).toBe(DEFAULT_SKU_PRICE);
      // A read must not write.
      expect(row?.status).toBe('archived');
    });
  });
});
