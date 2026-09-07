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
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCatalogueRepository } from '../catalogue.repository.js';
import { createCatalogueRoutes } from '../catalogue.routes.js';
import { createCatalogueService } from '../catalogue.service.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * GET /api/v1/admin/products — against real PostgreSQL.
 *
 * Two things carry this suite. First, the page and the `total` must agree about visibility:
 * the classic paginated-endpoint bug is a total that counts rows the page can never show, so
 * every isolation assertion checks BOTH. Second, ordering must be deterministic, which is
 * asserted by paging through a fixed set and proving the union is exactly the set — a per-page
 * spot check would pass against an unstable sort.
 */
describe('GET /api/v1/admin/products (integration)', () => {
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
    const repository = createCatalogueRepository({ db: db() });

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
        catalogue: createCatalogueService({
          repository,
          db: db(),
          ...testRecorders(db()),
          logger: silentLogger,
        }),
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      repository,
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

  /**
   * Insert a product with an explicit `createdAt`, so ordering is a property of the data rather
   * than of insertion speed. Without this every row in a fast test shares a millisecond and the
   * ordering assertions would be measuring the tie-breaker only.
   */
  async function givenProduct(
    overrides: {
      /** The SKU price. Price lives on the SKU from Increment 24, not the product. */
      price?: string;
      slug?: string;
      status?: string;
      storeId?: string;
      deletedAt?: Date;
      createdAt?: Date;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? `product-${newId().slice(-8)}`,
      name: overrides.slug ?? 'A Product',
      description: '',
      status: overrides.status ?? 'draft',
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const list = (app: App, query = '', token?: string) => {
    const req = request(app).get(`/api/v1/admin/products${query}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /**
   * Slugs from a list response, in order.
   *
   * `response.body` is `any` from supertest, so the cast happens here once rather than at
   * every assertion — which also keeps the assertions about ORDER rather than about types.
   */
  const slugsOf = (response: { body: { products: { slug: string }[] } }): string[] =>
    response.body.products.map((p) => p.slug);

  const staffApp = async () => {
    const built = build();
    const token = await signIn(built.app, built.identity, { staff: true });
    return { ...built, token };
  };

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await givenProduct({ slug: 'secret-draft' });
      const { app } = build();

      const response = await list(app);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // No catalogue data reaches an unauthenticated caller.
      expect(JSON.stringify(response.body)).not.toContain('secret-draft');
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      await givenProduct({ slug: 'secret-draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity);

      const response = await list(app, '', token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect(JSON.stringify(response.body)).not.toContain('secret-draft');
    });

    it('allows a staff user', async () => {
      const { app, token } = await staffApp();

      expect((await list(app, '', token)).status).toBe(200);
    });

    it('denies a staff user demoted mid-session, on the next request', async () => {
      const { app, token } = await staffApp();
      expect((await list(app, '', token)).status).toBe(200);

      await db().update(appUser).set({ isStaff: false });

      expect((await list(app, '', token)).status).toBe(403);
    });
  });

  describe('visibility', () => {
    it('returns an empty page when the store has no products', async () => {
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('includes draft, active, and archived products', async () => {
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'an-active', status: 'active' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      // Every lifecycle status. A copy of the public read would return only `an-active`.
      expect(slugsOf(response).sort()).toEqual(['a-draft', 'an-active', 'an-archived']);
      expect(response.body.pagination.total).toBe(3);
    });

    it('excludes soft-deleted products from BOTH the page and the total', async () => {
      await givenProduct({ slug: 'alive', status: 'active' });
      await givenProduct({ slug: 'deleted', status: 'active', deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(slugsOf(response)).toEqual(['alive']);
      /**
       * The total is asserted too, not just the page. A count that included the deleted row
       * would tell a client there are 2 products and leave it paging for one it can never see.
       */
      expect(response.body.pagination.total).toBe(1);
    });

    it('excludes another store products from BOTH the page and the total', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ slug: 'ours', status: 'active' });
      await givenProduct({ slug: 'theirs-one', storeId: secondStoreId, status: 'active' });
      await givenProduct({ slug: 'theirs-two', storeId: secondStoreId, status: 'draft' });

      const { app, token } = await staffApp();
      const response = await list(app, '', token);

      expect(slugsOf(response)).toEqual(['ours']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('theirs');
    });

    it('scopes the query in the REPOSITORY, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      await givenProduct({ slug: 'ours' });

      /**
       * Called directly, bypassing every middleware. If the store predicate lived only in the
       * route or the service, this would return another tenant's catalogue to any future
       * caller — a CLI command, an export job.
       */
      const foreign = await repository.listForStore({
        storeId: secondStoreId,
        limit: 20,
        offset: 0,
      });
      expect(foreign.items).toEqual([]);
      expect(foreign.total).toBe(0);

      const own = await repository.listForStore({ storeId, limit: 20, offset: 0 });
      expect(own.total).toBe(1);
    });
  });

  describe('ordering', () => {
    /** Six products, one per minute, so "newest first" is unambiguous in the data. */
    async function givenSixOrdered() {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      const slugs = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
      for (const [i, slug] of slugs.entries()) {
        await givenProduct({ slug, createdAt: new Date(base + i * 60_000) });
      }
      // Newest first.
      return [...slugs].reverse();
    }

    it('returns products newest first', async () => {
      const expected = await givenSixOrdered();
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(slugsOf(response)).toEqual(expected);
    });

    it('pages through the whole set with no duplicates and no gaps', async () => {
      const expected = await givenSixOrdered();
      const { app, token } = await staffApp();

      const pages = await Promise.all(
        [0, 2, 4].map((offset) => list(app, `?limit=2&offset=${String(offset)}`, token)),
      );
      const seen = pages.flatMap((p) => slugsOf(p));

      /**
       * THE ordering assertion. Checking one page against an expected order would pass under
       * an unstable sort; requiring the concatenation of all pages to equal the full ordered
       * set is what catches a row appearing twice or being skipped between pages.
       */
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(expected.length);
    });

    it('breaks ties deterministically when createdAt is identical', async () => {
      const sameInstant = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
      for (const slug of ['tie-a', 'tie-b', 'tie-c']) {
        await givenProduct({ slug, createdAt: sameInstant });
      }
      const { app, token } = await staffApp();

      const first = await list(app, '?limit=3', token);
      const second = await list(app, '?limit=3', token);

      // Same order across two independent requests — the id tie-breaker is what guarantees it.
      expect(slugsOf(first)).toEqual(slugsOf(second));
      // And every row appears exactly once across two pages of one.
      const paged = [
        ...(await list(app, '?limit=1&offset=0', token)).body.products,
        ...(await list(app, '?limit=1&offset=1', token)).body.products,
        ...(await list(app, '?limit=1&offset=2', token)).body.products,
      ].map((p: { slug: string }) => p.slug);
      expect(new Set(paged).size).toBe(3);
    });
  });

  describe('pagination', () => {
    async function givenN(n: number) {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      for (let i = 0; i < n; i += 1) {
        await givenProduct({
          slug: `p-${String(i).padStart(3, '0')}`,
          createdAt: new Date(base + i * 1000),
        });
      }
    }

    it('defaults to limit 20 and offset 0', async () => {
      await givenN(25);
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(response.body.products).toHaveLength(20);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 25 });
    });

    it('honours a custom limit', async () => {
      await givenN(10);
      const { app, token } = await staffApp();

      const response = await list(app, '?limit=3', token);

      expect(response.body.products).toHaveLength(3);
      expect(response.body.pagination).toEqual({ limit: 3, offset: 0, total: 10 });
    });

    it('honours a custom offset', async () => {
      await givenN(10);
      const { app, token } = await staffApp();

      const all = (await list(app, '?limit=10', token)).body.products as { slug: string }[];
      const offset = await list(app, '?limit=10&offset=4', token);

      expect(offset.body.products).toHaveLength(6);
      expect((offset.body.products as { slug: string }[])[0]?.slug).toBe(all[4]?.slug);
      expect(offset.body.pagination.offset).toBe(4);
      // The total is the whole set, not the page.
      expect(offset.body.pagination.total).toBe(10);
    });

    it('returns an empty page past the end without erroring', async () => {
      await givenN(3);
      const { app, token } = await staffApp();

      const response = await list(app, '?offset=100', token);

      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      // The total still reports the real size, so a client can recover.
      expect(response.body.pagination.total).toBe(3);
    });

    it('accepts the boundary values', async () => {
      await givenN(2);
      const { app, token } = await staffApp();

      expect((await list(app, '?limit=1', token)).status).toBe(200);
      expect((await list(app, '?limit=100', token)).status).toBe(200);
      expect((await list(app, '?offset=0', token)).status).toBe(200);
    });

    it('REJECTS a limit above the maximum rather than clamping it', async () => {
      const { app, token } = await staffApp();

      const response = await list(app, '?limit=101', token);

      /**
       * 400, not a silently clamped 100. Returning 100 rows for `?limit=5000` would tell a
       * caller their page size was honoured when it was not — and a client paging on
       * `offset += limit` would then skip 4900 records without any error to notice.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid limits', async () => {
      const { app, token } = await staffApp();

      for (const q of [
        '?limit=0',
        '?limit=-1',
        '?limit=abc',
        '?limit=2.5',
        '?limit=',
        '?limit=1e3',
      ]) {
        const response = await list(app, q, token);
        expect(response.status, q).toBe(400);
      }
    });

    it('rejects invalid offsets', async () => {
      const { app, token } = await staffApp();

      for (const q of ['?offset=-1', '?offset=abc', '?offset=1.5', '?offset=']) {
        const response = await list(app, q, token);
        expect(response.status, q).toBe(400);
      }
    });

    it('rejects unknown query parameters rather than ignoring them', async () => {
      await givenN(3);
      const { app, token } = await staffApp();

      /**
       * `strictObject` on the query. `?limitt=1` returning a default page of 20 would look like
       * success while silently ignoring the caller's intent — and `?status=` or `?search=` must
       * fail loudly rather than appear to work, since neither is implemented.
       */
      for (const q of ['?limitt=1', '?status=draft', '?search=shirt', '?sort=name', '?storeId=x']) {
        const response = await list(app, q, token);
        expect(response.status, q).toBe(400);
      }
    });
  });

  describe('response shape', () => {
    it('returns exactly products and pagination', async () => {
      await givenProduct({ slug: 'one' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(Object.keys(response.body).sort()).toEqual(['pagination', 'products']);
      expect(Object.keys(response.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
    });

    it('gives every item the shared product shape, exactly', async () => {
      await givenProduct({ slug: 'one', status: 'draft' });
      await givenProduct({ slug: 'two', status: 'archived' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      expect(response.body.products).toHaveLength(2);
      for (const item of response.body.products as Record<string, unknown>[]) {
        /**
         * The same nine keys create, publish, archive, the public read, and the staff read all
         * return. An exact set per item is what catches an internal column leaking into a list
         * response specifically — a place it is easy to forget, since the mapper is applied in
         * a loop.
         */
        expect(Object.keys(item).sort()).toEqual([
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
      }
    });

    it('leaks neither storeId nor deletedAt', async () => {
      await givenProduct({ slug: 'one' });
      await givenProduct({ slug: 'two' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);

      for (const item of response.body.products as Record<string, unknown>[]) {
        for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
          expect(item, field).not.toHaveProperty(field);
        }
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('reports persisted values faithfully', async () => {
      const created = await givenProduct({ slug: 'one', status: 'archived' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);
      const [row] = await db()
        .select({ status: product.status, name: product.name })
        .from(product)
        .where(eq(product.id, created.id));

      const item = (
        response.body.products as { status: string; name: string; skus: { price: string }[] }[]
      )[0];
      expect(item?.status).toBe(row?.status);
      expect(item?.name).toBe(row?.name);
      // Price now comes from the SKU, and the admin list carries it through the same mapper.
      expect(item?.skus[0]?.price).toBe(DEFAULT_SKU_PRICE);
    });
  });
});
