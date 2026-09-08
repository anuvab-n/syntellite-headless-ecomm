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
 * GET /api/v1/products/:slug — against real PostgreSQL.
 *
 * The property this suite exists to pin is NEGATIVE: a draft, an archived product, a
 * soft-deleted one, another store's product, and a slug that never existed must be
 * indistinguishable to an anonymous caller. Any test that merely checks "404" would pass
 * against an implementation that leaked the difference through a message or a code, so the
 * responses are compared to each other byte for byte.
 */
describe('GET /api/v1/products/:slug (integration)', () => {
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

  /**
   * The catalogue router WITHOUT any authentication wiring.
   *
   * `verifyAccessToken` throws if called and `requireStaff` refuses outright, so if the public
   * route ever acquired an auth or scope guard this suite would fail loudly rather than
   * quietly exercising a different contract. That is the point: the absence of authentication
   * is part of the endpoint's contract and has to be asserted, not assumed.
   */
  function build(slug = testDb.config.defaultStoreSlug) {
    const repository = createCatalogueRepository({ db: db() });
    const catalogue = createCatalogueService({
      repository,
      db: db(),
      ...testRecorders(db()),
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
    apiRouter.use(
      createCatalogueRoutes({
        catalogue,
        verifyAccessToken: () => {
          throw new Error('the public read must not verify a token');
        },
        requireStaff: () => {
          throw new Error('the public read must not run a scope guard');
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

  /** Insert a product directly, so a test can choose any status without an admin endpoint. */
  async function givenProduct(
    overrides: {
      /** The SKU price. Price lives on the SKU from Increment 24, not the product. */
      price?: string;
      slug?: string;
      status?: string;
      storeId?: string;
      deletedAt?: Date | null;
      name?: string;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? 'blue-cotton-shirt',
      name: overrides.name ?? 'Blue Cotton Shirt',
      description: 'A comfortable everyday shirt.',
      status: overrides.status ?? 'active',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    // 1499 rather than the helper default: this suite's assertions name it, and a fixture
    // price that drifted from them would make the response tests vacuous.
    await giveSku(db(), values, { price: overrides.price ?? '1499.0000' });
    return values;
  }

  const get = (app: App, slug: string) => request(app).get(`/api/v1/products/${slug}`);

  describe('a published product', () => {
    it('is returned with 200', async () => {
      const created = await givenProduct();
      const { app } = build();

      const response = await get(app, 'blue-cotton-shirt');

      expect(response.status).toBe(200);
      expect(response.body.product.id).toBe(created.id);
      expect(response.body.product.slug).toBe('blue-cotton-shirt');
      expect(response.body.product.status).toBe('active');
      // Price moved to the SKU. A publicly visible product always has at least one active SKU,
      // so this array is never empty on this endpoint.
      expect(response.body.product.skus).toHaveLength(1);
      expect(response.body.product.skus[0]?.price).toBe('1499.0000');
    });

    it('returns exactly the shared product shape', async () => {
      await givenProduct();
      const { app } = build();

      const response = await get(app, 'blue-cotton-shirt');

      expect(Object.keys(response.body)).toEqual(['product']);
      /**
       * An EXACT key set. This is what catches an ADDED field — the way an internal column
       * actually leaks — which a list of `not.toHaveProperty` assertions would miss for any
       * column introduced later.
       *
       * The same shape the admin create returns, deliberately: one mapper, one contract.
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
      await givenProduct();
      const { app } = build();

      const response = await get(app, 'blue-cotton-shirt');

      for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
        expect(response.body.product, field).not.toHaveProperty(field);
      }
      // The store id must not appear anywhere in the payload, under any key.
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('requires no Authorization header', async () => {
      await givenProduct();
      const { app } = build();

      // No header at all. The router in this suite throws if a token verifier or scope guard
      // is ever invoked, so a 200 here proves neither ran.
      const response = await request(app).get('/api/v1/products/blue-cotton-shirt');

      expect(response.status).toBe(200);
    });

    it('resolves a slug differing only in case', async () => {
      await givenProduct();
      const { app } = build();

      // The param is normalised exactly as the create endpoint normalised the stored value, so
      // a product cannot become unreachable at the URL a merchant was shown.
      expect((await get(app, 'BLUE-Cotton-Shirt')).status).toBe(200);
    });
  });

  describe('invisible products are indistinguishable from absent ones', () => {
    /** Every case below must produce a byte-identical body, not merely a matching status. */
    const bodyOf = (response: { body: { error: { code: string; message: string } } }) => ({
      code: response.body.error.code,
      message: response.body.error.message,
    });

    it('returns 404 for a draft', async () => {
      await givenProduct({ status: 'draft' });
      const { app } = build();

      const response = await get(app, 'blue-cotton-shirt');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for an archived product', async () => {
      await givenProduct({ status: 'archived' });
      const { app } = build();

      expect((await get(app, 'blue-cotton-shirt')).status).toBe(404);
    });

    it('returns 404 for a soft-deleted product', async () => {
      await givenProduct({ deletedAt: new Date() });
      const { app } = build();

      expect((await get(app, 'blue-cotton-shirt')).status).toBe(404);
    });

    it('returns 404 for a soft-deleted product that was ACTIVE', async () => {
      // Both predicates must hold. A row satisfying `status = active` but soft-deleted would
      // slip through an implementation that checked only one.
      await givenProduct({ status: 'active', deletedAt: new Date() });
      const { app } = build();

      expect((await get(app, 'blue-cotton-shirt')).status).toBe(404);
    });

    it('returns 404 for an unknown slug', async () => {
      const { app } = build();

      expect((await get(app, 'never-existed')).status).toBe(404);
    });

    it('gives BYTE-IDENTICAL responses for every invisible case', async () => {
      const { app } = build();

      // Four different reasons a product is not visible, each on its own slug.
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      await givenProduct({ slug: 'a-deleted', deletedAt: new Date() });

      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ slug: 'another-store', storeId: secondStoreId });

      const responses = await Promise.all(
        ['a-draft', 'an-archived', 'a-deleted', 'another-store', 'never-existed'].map((slug) =>
          get(app, slug),
        ),
      );

      /**
       * THE assertion of this increment. A distinct 403 for a draft would confirm the product
       * exists, letting a competitor enumerate an unreleased range before launch by probing
       * candidate slugs; a distinct 410 for an archived one would reveal what a merchant had
       * withdrawn. Comparing bodies rather than statuses is what makes this test able to fail
       * on a leak that a status check would miss.
       */
      const [first] = responses;
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(bodyOf(response)).toEqual(bodyOf(first!));
      }
      /*
       * And nothing about the product reaches the caller.
       *
       * `requestId` is EXCLUDED from this check, and it has to be. It is a random UUID, so its
       * 32 hex characters occasionally contain the price as a substring by pure coincidence —
       * this assertion failed with `requestId: "82707e4d-...-f99e665b1499"`, which leaks
       * nothing at all. Roughly a 1-in-2000 chance per run, which is exactly often enough to
       * erode trust in a suite while looking like a real leak.
       *
       * The narrowing is what makes the test honest: it now searches the fields that could
       * actually carry product data, and no longer searches a random identifier.
       */
      for (const response of responses) {
        const { requestId: _ignored, ...leakable } = response.body.error as Record<string, unknown>;
        const serialised = JSON.stringify(leakable);
        expect(serialised).not.toContain('Blue Cotton Shirt');
        expect(serialised).not.toContain('1499');
      }
    });
  });

  describe('store isolation', () => {
    it('returns 404 for a product belonging to another store', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ storeId: secondStoreId, status: 'active' });

      // Resolver pins to store one; the product is active, but in store two.
      const { app } = build();

      expect((await get(app, 'blue-cotton-shirt')).status).toBe(404);
    });

    it('serves each store its OWN product for the same slug', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ name: 'Store One Shirt' });
      await givenProduct({ storeId: secondStoreId, name: 'Store Two Shirt' });

      const first = await get(build().app, 'blue-cotton-shirt');
      const second = await get(build('second').app, 'blue-cotton-shirt');

      // One slug, two stores, two different products — the point of a per-store unique index.
      expect(first.body.product.name).toBe('Store One Shirt');
      expect(second.body.product.name).toBe('Store Two Shirt');
      expect(first.body.product.id).not.toBe(second.body.product.id);
    });

    it('scopes the query in the REPOSITORY, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      await givenProduct();

      /**
       * Called directly, bypassing every middleware. If the store predicate lived only in the
       * route or the service, this would return the row — and any future caller reaching the
       * repository another way would leak across tenants.
       */
      expect(
        await repository.findPublicBySlug({ storeId: secondStoreId, slug: 'blue-cotton-shirt' }),
      ).toBeUndefined();
      expect(
        (await repository.findPublicBySlug({ storeId, slug: 'blue-cotton-shirt' }))?.name,
      ).toBe('Blue Cotton Shirt');
    });
  });

  describe('the repository enforces visibility, not the service', () => {
    it('does not return invisible rows even when called directly', async () => {
      const { repository } = build();

      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'an-archived', status: 'archived' });
      await givenProduct({ slug: 'a-deleted', deletedAt: new Date() });

      /**
       * Asserted at the repository, not through HTTP. A draft that reaches application memory
       * can be logged, serialised into an error payload, or returned by a later refactor that
       * forgets a check — "never selected" is a stronger property than "filtered afterwards",
       * and it is only observable here.
       */
      for (const slug of ['a-draft', 'an-archived', 'a-deleted']) {
        expect(await repository.findPublicBySlug({ storeId, slug }), slug).toBeUndefined();
      }
    });

    it('still finds invisible rows through the ADMIN lookup', async () => {
      const { repository } = build();
      await givenProduct({ slug: 'a-draft', status: 'draft' });

      /**
       * `findBySlug` and `findPublicBySlug` answer different questions and must stay separate.
       * A draft's slug IS taken for conflict purposes, so the create path has to see it — while
       * the storefront must not. Collapsing these into one method with a flag would put both
       * behaviours one wrong argument apart.
       */
      expect((await repository.findBySlug({ storeId, slug: 'a-draft' }))?.status).toBe('draft');
    });
  });

  describe('validation and store resolution', () => {
    it('rejects a malformed slug with 400', async () => {
      const { app } = build();

      for (const slug of ['-leading', 'double--hyphen', 'punct%21']) {
        const response = await get(app, slug);
        expect(response.status, slug).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('does not treat a malformed slug as a product lookup', async () => {
      await givenProduct();
      const { app } = build();

      // 400 is the established convention for a request that cannot be interpreted, and the
      // slug format is published in the OpenAPI document — so this reveals nothing a caller
      // could not already read. What must never differ is the answer for a WELL-FORMED slug.
      const response = await get(app, '-leading');
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain('Blue Cotton Shirt');
    });

    it('returns 503 when no store can be resolved', async () => {
      await testDb.truncate();
      const { app } = build();

      /**
       * `resolveStore` still runs on this route. An unseeded deployment fails before the
       * handler, and 503 rather than 404 is deliberate — it is an operational fault, not a
       * client error. Asserted here so the public route is confirmed to sit behind the same
       * store resolution as every other `/api/v1` path.
       */
      const response = await get(app, 'blue-cotton-shirt');
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('persistence', () => {
    it('returns the row as stored, without mutating it', async () => {
      const created = await givenProduct();
      const { app } = build();

      const response = await get(app, 'blue-cotton-shirt');

      const [row] = await db()
        .select({
          id: product.id,
          status: product.status,
          deletedAt: product.deletedAt,
        })
        .from(product)
        .where(eq(product.id, created.id));

      // A read must not write. The row is exactly as inserted.
      expect(row?.status).toBe('active');
      expect(row?.deletedAt).toBeNull();
      // The SKU row is likewise untouched, and the response reports it faithfully.
      expect(response.body.product.skus[0]?.price).toBe('1499.0000');
    });

    it('reflects a status change on the next read', async () => {
      const created = await givenProduct();
      const { app } = build();

      expect((await get(app, 'blue-cotton-shirt')).status).toBe(200);

      await db().update(product).set({ status: 'archived' }).where(eq(product.id, created.id));

      // The visibility rule is evaluated per request against the database, not cached.
      expect((await get(app, 'blue-cotton-shirt')).status).toBe(404);
    });
  });
});
