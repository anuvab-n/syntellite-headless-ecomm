import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product } from '../../../db/schema/catalogue.js';
import { store } from '../../../db/schema/store.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
import { newId } from '../../../shared/id.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCatalogueRepository } from '../catalogue.repository.js';
import { createCatalogueRoutes } from '../catalogue.routes.js';
import { createCatalogueService } from '../catalogue.service.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * GET /api/v1/products — against real PostgreSQL.
 *
 * The property that distinguishes this from the admin list is exclusion: a draft, an archived
 * product, and a deleted one must be absent from BOTH the page and the `total`. A suite copied
 * from the admin list would assert the opposite, so several cases run both endpoints over the
 * same data and compare them directly.
 *
 * As in the public-read suite, the router is wired with a token verifier and a scope guard that
 * THROW if invoked — the absence of authentication is part of the contract, not an omission.
 */
describe('GET /api/v1/products (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

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
    const repository = createCatalogueRepository({ db: db() });

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
    apiRouter.use(
      createCatalogueRoutes({
        catalogue: createCatalogueService({
          repository,
          db: db(),
          ...testRecorders(db()),
          logger: silentLogger,
        }),
        verifyAccessToken: () => {
          throw new Error('the public list must not verify a token');
        },
        requireStaff: () => {
          throw new Error('the public list must not run a scope guard');
        },
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];

  /** Explicit `createdAt`, so ordering is a property of the data rather than of insert speed. */
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
      status: overrides.status ?? 'active',
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const list = (app: App, query = '') => request(app).get(`/api/v1/products${query}`);

  const slugsOf = (response: { body: { products: { slug: string }[] } }): string[] =>
    response.body.products.map((p) => p.slug);

  describe('public access', () => {
    it('requires no Authorization header', async () => {
      await givenProduct({ slug: 'on-sale' });
      const { app } = build();

      // The router throws if a verifier or scope guard is invoked, so a 200 proves neither ran.
      const response = await list(app);

      expect(response.status).toBe(200);
      expect(slugsOf(response)).toEqual(['on-sale']);
    });

    it('returns an empty page for a store with no published products', async () => {
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      const { app } = build();

      const response = await list(app);

      // Empty, not 404 — an empty catalogue is a valid state, not a missing resource.
      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('returns 503 when no store can be resolved', async () => {
      await testDb.truncate();
      const { app } = build();

      // `resolveStore` runs on this route too. An unseeded deployment is an operational fault,
      // not a client error.
      const response = await list(app);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('only published products are visible', () => {
    it('excludes drafts from the page AND the total', async () => {
      await givenProduct({ slug: 'published', status: 'active' });
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      const { app } = build();

      const response = await list(app);

      expect(slugsOf(response)).toEqual(['published']);
      /**
       * The total matters as much as the page. A count that included the draft would tell a
       * storefront there are 2 products while paging only ever yields 1 — the classic
       * paginated-endpoint bug §28 shares one predicate to prevent.
       */
      expect(response.body.pagination.total).toBe(1);
    });

    it('excludes archived products from the page AND the total', async () => {
      await givenProduct({ slug: 'published', status: 'active' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      const { app } = build();

      const response = await list(app);

      expect(slugsOf(response)).toEqual(['published']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('excludes soft-deleted products from the page AND the total', async () => {
      await givenProduct({ slug: 'published', status: 'active' });
      await givenProduct({ slug: 'a-deleted', status: 'active', deletedAt: new Date() });
      const { app } = build();

      const response = await list(app);

      // Both predicates must hold: this row is `active` but deleted.
      expect(slugsOf(response)).toEqual(['published']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('excludes every invisible state at once', async () => {
      await givenProduct({ slug: 'visible-one', status: 'active' });
      await givenProduct({ slug: 'visible-two', status: 'active' });
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      await givenProduct({ slug: 'a-deleted', status: 'active', deletedAt: new Date() });
      const { app } = build();

      const response = await list(app);

      expect(slugsOf(response).sort()).toEqual(['visible-one', 'visible-two']);
      expect(response.body.pagination.total).toBe(2);
      // And no trace of the hidden ones anywhere in the payload.
      for (const hidden of ['a-draft', 'an-archived', 'a-deleted']) {
        expect(JSON.stringify(response.body), hidden).not.toContain(hidden);
      }
    });

    it('reflects a lifecycle change on the next request', async () => {
      const drafted = await givenProduct({ slug: 'coming-soon', status: 'draft' });
      const { app } = build();

      expect(slugsOf(await list(app))).toEqual([]);

      await db().update(product).set({ status: 'active' }).where(eq(product.id, drafted.id));

      // Visibility is evaluated per request against the database, not cached.
      expect(slugsOf(await list(app))).toEqual(['coming-soon']);
    });
  });

  describe('it differs from the admin list', () => {
    it('hides what the admin list shows, over the same data', async () => {
      await givenProduct({ slug: 'published', status: 'active' });
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      const { repository } = build();
      const { app } = build();

      const publicPage = await list(app);
      // The admin list through the repository, since this suite has no staff wiring.
      const adminPage = await repository.listForStore({ storeId, limit: 20, offset: 0 });

      /**
       * The two endpoints must NOT converge. An implementation that reused `listForStore` for
       * the storefront would publish every draft in the catalogue, and would pass a suite that
       * only ever checked the public endpoint against active products.
       */
      expect(slugsOf(publicPage)).toEqual(['published']);
      expect(publicPage.body.pagination.total).toBe(1);
      expect(adminPage.items.map((p) => p.slug).sort()).toEqual([
        'a-draft',
        'an-archived',
        'published',
      ]);
      expect(adminPage.total).toBe(3);
    });
  });

  describe('store isolation', () => {
    it('excludes another store published products from the page AND the total', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ slug: 'ours', status: 'active' });
      await givenProduct({ slug: 'theirs-one', storeId: secondStoreId, status: 'active' });
      await givenProduct({ slug: 'theirs-two', storeId: secondStoreId, status: 'active' });

      const { app } = build();
      const response = await list(app);

      expect(slugsOf(response)).toEqual(['ours']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('theirs');
    });

    it('serves each store its own catalogue', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ slug: 'ours', status: 'active' });
      await givenProduct({ slug: 'theirs', storeId: secondStoreId, status: 'active' });

      expect(slugsOf(await list(build().app))).toEqual(['ours']);
      expect(slugsOf(await list(build('second').app))).toEqual(['theirs']);
    });

    it('scopes the query in the REPOSITORY, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      await givenProduct({ slug: 'ours', status: 'active' });

      /**
       * Called directly, bypassing every middleware. If the store predicate lived only in the
       * route, any future caller reaching the repository another way would leak a tenant's
       * catalogue.
       */
      const foreign = await repository.listPublicForStore({
        storeId: secondStoreId,
        limit: 20,
        offset: 0,
      });
      expect(foreign.items).toEqual([]);
      expect(foreign.total).toBe(0);

      expect((await repository.listPublicForStore({ storeId, limit: 20, offset: 0 })).total).toBe(
        1,
      );
    });
  });

  describe('ordering', () => {
    async function givenSixPublished() {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      const slugs = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
      for (const [i, slug] of slugs.entries()) {
        await givenProduct({ slug, status: 'active', createdAt: new Date(base + i * 60_000) });
      }
      return [...slugs].reverse();
    }

    it('returns products newest first', async () => {
      const expected = await givenSixPublished();
      const { app } = build();

      expect(slugsOf(await list(app))).toEqual(expected);
    });

    it('pages through the whole set with no duplicates and no gaps', async () => {
      const expected = await givenSixPublished();
      const { app } = build();

      const pages = await Promise.all(
        [0, 2, 4].map((offset) => list(app, `?limit=2&offset=${String(offset)}`)),
      );
      const seen = pages.flatMap((p) => slugsOf(p));

      // Concatenating every page must equal the full ordered set — a per-page spot check would
      // pass under an unstable sort.
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(expected.length);
    });

    it('skips hidden products without leaving holes in a page', async () => {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      // Interleaved: visible, hidden, visible, hidden, visible.
      await givenProduct({ slug: 'v1', status: 'active', createdAt: new Date(base) });
      await givenProduct({ slug: 'h1', status: 'draft', createdAt: new Date(base + 1_000) });
      await givenProduct({ slug: 'v2', status: 'active', createdAt: new Date(base + 2_000) });
      await givenProduct({ slug: 'h2', status: 'archived', createdAt: new Date(base + 3_000) });
      await givenProduct({ slug: 'v3', status: 'active', createdAt: new Date(base + 4_000) });
      const { app } = build();

      /**
       * `LIMIT` applies AFTER the visibility predicate, so a page of 2 must contain 2 visible
       * products — not 2 rows of which some are filtered out. Getting this wrong yields
       * short pages that look like the end of the catalogue.
       */
      const first = await list(app, '?limit=2&offset=0');
      expect(slugsOf(first)).toEqual(['v3', 'v2']);
      expect(first.body.pagination.total).toBe(3);

      const second = await list(app, '?limit=2&offset=2');
      expect(slugsOf(second)).toEqual(['v1']);
    });
  });

  describe('pagination', () => {
    async function givenN(n: number) {
      const base = Date.UTC(2026, 0, 1, 12, 0, 0);
      for (let i = 0; i < n; i += 1) {
        await givenProduct({
          slug: `p-${String(i).padStart(3, '0')}`,
          status: 'active',
          createdAt: new Date(base + i * 1000),
        });
      }
    }

    it('defaults to limit 20 and offset 0', async () => {
      await givenN(25);
      const { app } = build();

      const response = await list(app);

      expect(response.body.products).toHaveLength(20);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 25 });
    });

    it('honours a custom limit and offset', async () => {
      await givenN(10);
      const { app } = build();

      const all = slugsOf(await list(app, '?limit=10'));
      const page = await list(app, '?limit=3&offset=4');

      expect(slugsOf(page)).toEqual(all.slice(4, 7));
      expect(page.body.pagination).toEqual({ limit: 3, offset: 4, total: 10 });
    });

    it('rejects a limit above the maximum rather than clamping', async () => {
      const { app } = build();

      const response = await list(app, '?limit=101');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid limits and offsets', async () => {
      const { app } = build();

      for (const q of [
        '?limit=0',
        '?limit=-1',
        '?limit=abc',
        '?limit=2.5',
        '?limit=',
        '?offset=-1',
        '?offset=',
        '?offset=1.5',
      ]) {
        expect((await list(app, q)).status, q).toBe(400);
      }
    });

    it('rejects unknown query parameters rather than ignoring them', async () => {
      await givenN(3);
      const { app } = build();

      // The same strict contract as the admin list — `?status=draft` must fail loudly rather
      // than appear to work on a public endpoint.
      for (const q of ['?limitt=1', '?status=draft', '?search=shirt', '?sort=name', '?storeId=x']) {
        expect((await list(app, q)).status, q).toBe(400);
      }
    });

    it('returns an empty page past the end without erroring', async () => {
      await givenN(3);
      const { app } = build();

      const response = await list(app, '?offset=100');

      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination.total).toBe(3);
    });
  });

  describe('response shape', () => {
    it('returns exactly products and pagination', async () => {
      await givenProduct({ status: 'active' });
      const { app } = build();

      const response = await list(app);

      expect(Object.keys(response.body).sort()).toEqual(['pagination', 'products']);
      expect(Object.keys(response.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
    });

    it('gives every item the shared product shape, exactly', async () => {
      await givenProduct({ slug: 'one', status: 'active' });
      await givenProduct({ slug: 'two', status: 'active' });
      const { app } = build();

      const response = await list(app);

      expect(response.body.products).toHaveLength(2);
      for (const item of response.body.products as Record<string, unknown>[]) {
        // The same nine keys every other product endpoint returns. An exact set per item is
        // what catches an internal column leaking into a list response.
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
        // Every item on this endpoint is published, by construction.
        expect(item['status']).toBe('active');
      }
    });

    it('leaks neither storeId nor deletedAt', async () => {
      await givenProduct({ slug: 'one', status: 'active' });
      await givenProduct({ slug: 'two', status: 'active' });
      const { app } = build();

      const response = await list(app);

      for (const item of response.body.products as Record<string, unknown>[]) {
        for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
          expect(item, field).not.toHaveProperty(field);
        }
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });
  });
});
