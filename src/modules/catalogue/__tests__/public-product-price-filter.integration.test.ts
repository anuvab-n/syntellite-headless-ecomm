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
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
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
 * GET /api/v1/products?price_min=&price_max= — public price filtering, against real PostgreSQL.
 *
 * Three rules drive the fixtures.
 *
 * First, prices are a deliberate SPREAD. The catalogue's other suites seed every product at
 * `10.0000`, which is fine for search but useless here — a filter that matched everything, or
 * that ignored one bound entirely, would look correct against a uniform catalogue.
 *
 * Second, inclusivity is proven by products priced EXACTLY on each boundary, not by a range
 * that happens to contain some rows. `1000..2000` over a `500/1000/1500/2000/2500` catalogue
 * fails visibly if `>=` becomes `>` or `<=` becomes `<`; a range like `900..2100` would not.
 *
 * Third, every visibility case pairs a hidden product IN the price range with a visible one, so
 * "the filter returned fewer rows" cannot be mistaken for "the filter correctly excluded the
 * draft".
 *
 * The comparison itself runs against real PostgreSQL rather than being asserted in isolation:
 * what matters is how `numeric(19,4)` treats a decimal string parameter, not what the string
 * looks like on the way there.
 */
describe('GET /api/v1/products?price_min=&price_max= (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'Correct-Horse-Battery-9';

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
   * The PUBLIC router, wired with a verifier and a scope guard that THROW if invoked.
   *
   * Adding price filtering must not quietly turn a public endpoint into an authenticated one,
   * so the absence of authentication is enforced structurally rather than asserted after the
   * fact — a 200 from this app proves neither ran.
   */
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
          throw new Error('public price filtering must not verify a token');
        },
        requireStaff: () => {
          throw new Error('public price filtering must not run a scope guard');
        },
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      repository,
    };
  }

  /**
   * A SECOND app, fully authenticated, used only to prove the ADMIN list still rejects the price
   * parameters.
   *
   * The public app above cannot show that: its admin routes answer 401 for a missing token
   * before any schema runs, so widening the shared query schema would leave that 401 unchanged
   * and the mutation would survive. Signing in first makes the assertion 400-versus-200, which
   * is the difference that actually distinguishes a strict schema from a widened one.
   */
  function buildAdmin() {
    const identityRepository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const repository = createCatalogueRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
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
          slug: testDb.config.defaultStoreSlug,
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
    };
  }

  type App = ReturnType<typeof build>['app'];

  async function signInAsStaff(
    app: App,
    identity: ReturnType<typeof buildAdmin>['identity'],
  ): Promise<string> {
    const email = 'staff@example.com';
    const user = await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  let sequence = 0;

  /**
   * Insert a product with an explicit price and `createdAt`.
   *
   * `price` has no default worth relying on here — every caller passes one, because a fixture
   * that quietly priced everything the same is precisely the blind spot this suite exists to
   * avoid. `createdAt` is explicit so ordering is a property of the data rather than of insert
   * speed.
   */
  async function givenProduct(
    overrides: {
      name?: string;
      slug?: string;
      price?: string;
      status?: string;
      storeId?: string;
      deletedAt?: Date;
      createdAt?: Date;
    } = {},
  ) {
    sequence += 1;
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? `product-${String(sequence)}-${newId().slice(-6)}`,
      name: overrides.name ?? `Product ${String(sequence)}`,
      description: '',
      status: overrides.status ?? 'active',
      createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 0, 1, 12, 0, sequence)),
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const list = (app: App, query = '') => request(app).get(`/api/v1/products${query}`);

  const namesOf = (response: { body: { products: { name: string }[] } }): string[] =>
    response.body.products.map((p) => p.name);

  /**
   * The FIRST SKU price of each product, in response order.
   *
   * Price lives on the SKU now, so a listing carries an array. These fixtures give every
   * product exactly one SKU, which is what makes indexing `[0]` meaningful here — the
   * multiple-SKU cases assert on names and counts instead.
   */
  const pricesOf = (response: { body: { products: { skus: { price: string }[] }[] } }): string[] =>
    response.body.products.map((p) => p.skus[0]?.price ?? '');

  /**
   * The boundary catalogue: five products, one on each side of and exactly on each bound.
   *
   * A `1000..2000` filter must return exactly the middle three. Both boundary products are the
   * point — drop either bound's equality and this catalogue says so immediately.
   */
  async function givenPriceSpread() {
    await givenProduct({ name: 'Below', price: '500.0000' });
    await givenProduct({ name: 'AtMin', price: '1000.0000' });
    await givenProduct({ name: 'Inside', price: '1500.0000' });
    await givenProduct({ name: 'AtMax', price: '2000.0000' });
    await givenProduct({ name: 'Above', price: '2500.0000' });
  }

  /* ── Unfiltered behaviour is unchanged ─────────────────────────────────── */

  describe('without price filters', () => {
    it('behaves exactly as before when neither bound is supplied', async () => {
      await givenPriceSpread();
      const { app } = build();

      const response = await list(app);

      expect(response.status).toBe(200);
      // All five, still newest first — the price parameters must add nothing when absent.
      expect(namesOf(response)).toEqual(['Above', 'AtMax', 'Inside', 'AtMin', 'Below']);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 5 });
    });
  });

  /* ── Bounds ────────────────────────────────────────────────────────────── */

  describe('bounds', () => {
    it('filters on price_min alone', async () => {
      await givenPriceSpread();
      const { app } = build();

      const response = await list(app, '?price_min=1500');

      expect(response.status).toBe(200);
      // Open-ended above: everything from 1500 up, nothing below it.
      expect(namesOf(response).sort()).toEqual(['Above', 'AtMax', 'Inside']);
      expect(response.body.pagination.total).toBe(3);
    });

    it('filters on price_max alone', async () => {
      await givenPriceSpread();
      const { app } = build();

      const response = await list(app, '?price_max=1500');

      expect(response.status).toBe(200);
      expect(namesOf(response).sort()).toEqual(['AtMin', 'Below', 'Inside']);
      expect(response.body.pagination.total).toBe(3);
    });

    it('filters on both bounds', async () => {
      await givenPriceSpread();
      const { app } = build();

      const response = await list(app, '?price_min=1000&price_max=2000');

      expect(response.status).toBe(200);
      expect(namesOf(response).sort()).toEqual(['AtMax', 'AtMin', 'Inside']);
      expect(response.body.pagination.total).toBe(3);
    });

    it('includes a product priced EXACTLY at price_min', async () => {
      await givenPriceSpread();
      const { app } = build();

      /**
       * The single assertion that separates `>=` from `>`. Asserted on its own rather than
       * only inside the both-bounds case, so a failure names the boundary that broke.
       */
      const response = await list(app, '?price_min=1000&price_max=1000');

      expect(namesOf(response)).toEqual(['AtMin']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('includes a product priced EXACTLY at price_max', async () => {
      await givenPriceSpread();
      const { app } = build();

      // The counterpart: separates `<=` from `<`.
      const response = await list(app, '?price_min=2000&price_max=2000');

      expect(namesOf(response)).toEqual(['AtMax']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('accepts price_min equal to price_max, selecting that exact price', async () => {
      await givenProduct({ name: 'Exact One', price: '1500.0000' });
      await givenProduct({ name: 'Exact Two', price: '1500.0000' });
      await givenProduct({ name: 'Near Below', price: '1499.9999' });
      await givenProduct({ name: 'Near Above', price: '1500.0001' });
      const { app } = build();

      const response = await list(app, '?price_min=1500&price_max=1500');

      expect(response.status).toBe(200);
      // Two products share the price; the neighbours are one ten-thousandth away and excluded.
      expect(namesOf(response).sort()).toEqual(['Exact One', 'Exact Two']);
      expect(response.body.pagination.total).toBe(2);
    });

    it('accepts zero as a bound', async () => {
      await givenProduct({ name: 'Free', price: '0.0000' });
      await givenProduct({ name: 'Cheap', price: '0.0100' });
      await givenProduct({ name: 'Paid', price: '100.0000' });
      const { app } = build();

      // Zero is a real price, not a missing one: `price_max=0` means "free items only".
      expect(namesOf(await list(app, '?price_max=0'))).toEqual(['Free']);
      // And as a lower bound it is a no-op, since the column is never negative.
      expect(namesOf(await list(app, '?price_min=0')).sort()).toEqual(['Cheap', 'Free', 'Paid']);
    });

    it('compares correctly when the bound has fewer decimal places than the column', async () => {
      await givenProduct({ name: 'Ten', price: '10.0000' });
      await givenProduct({ name: 'Eleven', price: '11.0000' });
      const { app } = build();

      /**
       * `numeric(19,4)` stores `10.0000`; the bound arrives as the string `10`. PostgreSQL
       * coerces the parameter to `numeric` and compares by VALUE, so scale does not matter —
       * asserted here rather than assumed, since it is the fact that made passing the raw
       * string safe in the first place.
       */
      for (const bound of ['10', '10.0', '10.00', '10.0000']) {
        const response = await list(app, `?price_max=${bound}`);
        expect(namesOf(response), bound).toEqual(['Ten']);
        expect(response.body.pagination.total, bound).toBe(1);
      }
    });

    it('returns an empty page rather than an error when nothing matches', async () => {
      await givenPriceSpread();
      const { app } = build();

      // A satisfiable range that happens to contain nothing is a normal, successful answer.
      const response = await list(app, '?price_min=3000&price_max=4000');

      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 0 });
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects price_min greater than price_max with a 400', async () => {
      await givenPriceSpread();
      const { app } = build();

      /**
       * A 400, deliberately not an empty 200. Same judgement as §28's "over the maximum is
       * rejected, not clamped": an empty page would tell a caller their filter was honoured and
       * simply matched nothing, when the request is impossible to satisfy. A transposed pair is
       * a bug in the caller, and the useful answer says so.
       */
      const response = await list(app, '?price_min=2000&price_max=1000');

      expect(response.status).toBe(400);
      // And it must not have silently answered with a page of anything.
      expect(response.body.products).toBeUndefined();
    });

    it('accepts the same pair the right way round', async () => {
      await givenPriceSpread();
      const { app } = build();

      // The control for the case above: the rejection is about ORDER, not about these values.
      const response = await list(app, '?price_min=1000&price_max=2000');

      expect(response.status).toBe(200);
      expect(response.body.pagination.total).toBe(3);
    });

    it('compares the bounds numerically, not as strings', async () => {
      await givenProduct({ name: 'Nine', price: '9.0000' });
      const { app } = build();

      /**
       * `'9' > '10'` lexicographically, so a string comparison in the cross-field check would
       * reject this valid range. Cheap to assert and the mistake is easy to make.
       */
      const response = await list(app, '?price_min=9&price_max=10');

      expect(response.status).toBe(200);
      expect(namesOf(response)).toEqual(['Nine']);
    });

    it('rejects a non-numeric value', async () => {
      const { app } = build();

      for (const value of ['abc', '1.2.3', '1e3', '0x10', '1,000']) {
        const response = await list(app, `?price_min=${encodeURIComponent(value)}`);
        expect(response.status, value).toBe(400);
      }
    });

    it('rejects a negative value', async () => {
      const { app } = build();

      // The pattern starts `\d`, so negatives are excluded by the shared primitive rather than
      // by a rule invented here.
      for (const query of ['?price_min=-1', '?price_max=-10.00', '?price_min=-0.0001']) {
        expect((await list(app, query)).status, query).toBe(400);
      }
    });

    it('rejects more than 4 decimal places rather than rounding', async () => {
      await givenProduct({ name: 'Ten', price: '10.0000' });
      const { app } = build();

      /**
       * `10.00001` must NOT be quietly treated as `10.0000`. A merchant or storefront that
       * typed one digit too many should be told, not overruled — the same rule the create and
       * update bodies apply to a price.
       */
      expect((await list(app, '?price_min=10.00001')).status).toBe(400);
      expect((await list(app, '?price_max=9.99999')).status).toBe(400);
    });

    it('rejects more than 15 integer digits', async () => {
      const { app } = build();

      // 16 digits exceeds what `numeric(19,4)` can hold alongside 4 decimals.
      expect((await list(app, '?price_min=1234567890123456')).status).toBe(400);
      // 15 is the boundary and is accepted.
      expect((await list(app, '?price_min=123456789012345')).status).toBe(200);
    });

    it('rejects an empty value', async () => {
      const { app } = build();

      // The client wrote the parameter and supplied nothing: a malformed request, not a
      // request for the default. `?price_min=` must not be read as "no lower bound".
      expect((await list(app, '?price_min=')).status).toBe(400);
      expect((await list(app, '?price_max=')).status).toBe(400);
    });

    it('rejects a whitespace-only value', async () => {
      const { app } = build();

      // Trimmed before the pattern check, so this reduces to the empty case above.
      expect((await list(app, '?price_min=%20%20')).status).toBe(400);
      expect((await list(app, '?price_max=%09')).status).toBe(400);
    });

    it('still rejects unknown query parameters', async () => {
      const { app } = build();

      /**
       * `.refine()` wraps the object but must not relax it. A `price_mn` typo has to fail
       * loudly — silently ignoring it would return an unfiltered page that looks filtered.
       */
      for (const query of ['?price_mn=10', '?priceMin=10', '?price_min=10&sort=price']) {
        expect((await list(app, query)).status, query).toBe(400);
      }
    });
  });

  /* ── Composition with q ────────────────────────────────────────────────── */

  describe('composition with search', () => {
    async function givenMixedCatalogue() {
      await givenProduct({ name: 'Cheap Shirt', price: '500.0000' });
      await givenProduct({ name: 'Mid Shirt', price: '1500.0000' });
      await givenProduct({ name: 'Costly Shirt', price: '2500.0000' });
      await givenProduct({ name: 'Mid Boots', price: '1500.0000' });
    }

    it('composes q with price_min', async () => {
      await givenMixedCatalogue();
      const { app } = build();

      const response = await list(app, '?q=shirt&price_min=1000');

      // Both filters must apply: the cheap shirt fails the price, the boots fail the search.
      expect(namesOf(response).sort()).toEqual(['Costly Shirt', 'Mid Shirt']);
      expect(response.body.pagination.total).toBe(2);
    });

    it('composes q with price_max', async () => {
      await givenMixedCatalogue();
      const { app } = build();

      const response = await list(app, '?q=shirt&price_max=2000');

      expect(namesOf(response).sort()).toEqual(['Cheap Shirt', 'Mid Shirt']);
      expect(response.body.pagination.total).toBe(2);
    });

    it('composes q with both bounds', async () => {
      await givenMixedCatalogue();
      const { app } = build();

      const response = await list(app, '?q=shirt&price_min=1000&price_max=2000');

      // Exactly one of four survives all three conditions — a filter dropped anywhere in the
      // chain changes this answer.
      expect(namesOf(response)).toEqual(['Mid Shirt']);
      expect(response.body.pagination.total).toBe(1);
    });
  });

  /* ── Pagination ────────────────────────────────────────────────────────── */

  describe('pagination', () => {
    /** Five in range, three out — so a lost filter changes the total, not just the page. */
    async function givenPageable() {
      for (const [index, price] of [
        '1000.0000',
        '1200.0000',
        '1400.0000',
        '1600.0000',
        '1800.0000',
      ].entries()) {
        await givenProduct({ name: `In ${String(index)}`, price });
      }
      await givenProduct({ name: 'Out Low', price: '100.0000' });
      await givenProduct({ name: 'Out High A', price: '9000.0000' });
      await givenProduct({ name: 'Out High B', price: '9500.0000' });
    }

    it('applies the filter BEFORE limit and offset', async () => {
      await givenPageable();
      const { app } = build();

      const response = await list(app, '?price_min=1000&price_max=2000&limit=2&offset=0');

      expect(response.status).toBe(200);
      // Two rows on the page, five in the filtered set — the page is a window on the FILTERED
      // catalogue, not the first two of everything then filtered.
      expect(response.body.products).toHaveLength(2);
      expect(response.body.pagination).toEqual({ limit: 2, offset: 0, total: 5 });
      expect(namesOf(response).every((name) => name.startsWith('In '))).toBe(true);
    });

    it('reports a total that matches the filtered set exactly', async () => {
      await givenPageable();
      const { app } = build();

      /**
       * The classic paginated-filter bug is a `total` counting rows the page can never show.
       * Proven by paging all the way through: the union of every page must be exactly the
       * filtered set, and `total` must equal its size.
       */
      const page = (offset: number) =>
        list(app, `?price_min=1000&price_max=2000&limit=2&offset=${String(offset)}`);

      const first = await page(0);
      expect(first.status).toBe(200);
      const total = first.body.pagination.total as number;
      const collected = [...namesOf(first)];

      for (let offset = 2; collected.length < total; offset += 2) {
        const response = await page(offset);
        expect(response.status).toBe(200);
        // The total must also be STABLE across pages, not merely correct on the first.
        expect(response.body.pagination.total).toBe(total);
        collected.push(...namesOf(response));
      }

      expect(total).toBe(5);
      expect(collected.sort()).toEqual(['In 0', 'In 1', 'In 2', 'In 3', 'In 4']);
      // No page ever leaked an out-of-range product.
      expect(collected).not.toContain('Out Low');
      expect(collected).not.toContain('Out High A');
    });

    it('keeps ordering newest-first under a price filter', async () => {
      await givenProduct({
        name: 'Oldest',
        price: '1500.0000',
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      });
      await givenProduct({
        name: 'Middle',
        price: '1100.0000',
        createdAt: new Date(Date.UTC(2026, 0, 2)),
      });
      await givenProduct({
        name: 'Newest',
        price: '1900.0000',
        createdAt: new Date(Date.UTC(2026, 0, 3)),
      });
      const { app } = build();

      const response = await list(app, '?price_min=1000&price_max=2000');

      // Still creation order, NOT price order — this increment adds no sorting control.
      expect(namesOf(response)).toEqual(['Newest', 'Middle', 'Oldest']);
      expect(pricesOf(response)).toEqual(['1900.0000', '1100.0000', '1500.0000']);
    });
  });

  /* ── Visibility ────────────────────────────────────────────────────────── */

  describe('visibility', () => {
    /**
     * Each case seeds the hidden product INSIDE the price range, alongside a visible one that is
     * also inside it. An empty result would be ambiguous; one specific product is not.
     */
    const inRange = '?price_min=1000&price_max=2000';

    it('excludes draft products', async () => {
      await givenProduct({ name: 'Visible', price: '1500.0000', status: 'active' });
      await givenProduct({ name: 'Draft', price: '1500.0000', status: 'draft' });
      const { app } = build();

      const response = await list(app, inRange);

      expect(namesOf(response)).toEqual(['Visible']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Draft');
    });

    it('excludes archived products', async () => {
      await givenProduct({ name: 'Visible', price: '1500.0000', status: 'active' });
      await givenProduct({ name: 'Archived', price: '1500.0000', status: 'archived' });
      const { app } = build();

      const response = await list(app, inRange);

      expect(namesOf(response)).toEqual(['Visible']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Archived');
    });

    it('excludes soft-deleted products', async () => {
      await givenProduct({ name: 'Visible', price: '1500.0000' });
      await givenProduct({ name: 'Deleted', price: '1500.0000', deletedAt: new Date() });
      const { app } = build();

      const response = await list(app, inRange);

      expect(namesOf(response)).toEqual(['Visible']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Deleted');
    });

    it('excludes other stores’ products', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ name: 'Ours', price: '1500.0000' });
      await givenProduct({ name: 'Theirs', price: '1500.0000', storeId: secondStoreId });
      const { app } = build();

      const response = await list(app, inRange);

      expect(namesOf(response)).toEqual(['Ours']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Theirs');
    });

    it('hides all of them at once, including from the total', async () => {
      await givenProduct({ name: 'Shown One', price: '1200.0000' });
      await givenProduct({ name: 'Shown Two', price: '1800.0000' });
      await givenProduct({ name: 'Hidden Draft', price: '1500.0000', status: 'draft' });
      await givenProduct({ name: 'Hidden Archived', price: '1500.0000', status: 'archived' });
      await givenProduct({ name: 'Hidden Deleted', price: '1500.0000', deletedAt: new Date() });
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ name: 'Hidden Foreign', price: '1500.0000', storeId: secondStoreId });
      const { app } = build();

      const response = await list(app, inRange);

      expect(namesOf(response).sort()).toEqual(['Shown One', 'Shown Two']);
      // The total must agree — a count that saw the hidden rows would say 6.
      expect(response.body.pagination.total).toBe(2);
      for (const hidden of ['Draft', 'Archived', 'Deleted', 'Foreign']) {
        expect(JSON.stringify(response.body), hidden).not.toContain(`Hidden ${hidden}`);
      }
    });

    it('scopes the filter in the REPOSITORY, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      await givenProduct({ name: 'Ours', price: '1500.0000' });
      await givenProduct({ name: 'Theirs', price: '1500.0000', storeId: secondStoreId });

      /**
       * Called directly, bypassing every middleware. A price filter must not become a way to
       * read another tenant's catalogue, and store scoping has to hold at the layer that builds
       * the SQL rather than only at the one that resolves the store.
       */
      const ours = await repository.listPublicForStore({
        storeId,
        limit: 20,
        offset: 0,
        priceMin: '1000',
        priceMax: '2000',
      });
      const theirs = await repository.listPublicForStore({
        storeId: secondStoreId,
        limit: 20,
        offset: 0,
        priceMin: '1000',
        priceMax: '2000',
      });

      expect(ours.items.map((item) => item.name)).toEqual(['Ours']);
      expect(ours.total).toBe(1);
      expect(theirs.items.map((item) => item.name)).toEqual(['Theirs']);
      expect(theirs.total).toBe(1);
    });
  });

  /* ── Public access, response shape, admin separation ───────────────────── */

  describe('public access and response shape', () => {
    it('requires no Authorization header', async () => {
      await givenPriceSpread();
      const { app } = build();

      // The router throws if a verifier or scope guard runs, so a 200 proves neither did.
      const response = await request(app).get('/api/v1/products?price_min=1000&price_max=2000');

      expect(response.status).toBe(200);
      expect(response.body.products).toHaveLength(3);
    });

    it('returns the unchanged envelope and per-item key set', async () => {
      await givenProduct({ name: 'Only', price: '1500.0000' });
      const { app } = build();

      const response = await list(app, '?price_min=1000&price_max=2000');

      // No filter echo, no match metadata, no new envelope — the response is what it was.
      expect(Object.keys(response.body).sort()).toEqual(['pagination', 'products']);
      expect(Object.keys(response.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
      expect(Object.keys(response.body.products[0]).sort()).toEqual([
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

    it('does NOT accept price_min or price_max on the ADMIN list', async () => {
      const { app, identity } = buildAdmin();
      const token = await signInAsStaff(app, identity);
      await givenProduct({ name: 'Any', price: '1500.0000' });

      /**
       * Authenticated, so the schema is genuinely what answers. The price bounds live on a
       * public-only schema: widening the shared one would have given the admin list parameters
       * it silently ignores — a request that looks honoured and is not.
       */
      for (const query of ['?price_min=1000', '?price_max=2000', '?price_min=1&price_max=2']) {
        const response = await request(app)
          .get(`/api/v1/admin/products${query}`)
          .set('Authorization', `Bearer ${token}`);
        expect(response.status, query).toBe(400);
      }

      // The control: the same request without the price bounds succeeds, so the 400s above are
      // caused by those parameters and not by the auth or the store.
      const ok = await request(app)
        .get('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`);
      expect(ok.status).toBe(200);
    });
  });
});
