import { Router } from 'express';
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
import { createCatalogueRepository, escapeLikePattern } from '../catalogue.repository.js';
import { createCatalogueRoutes } from '../catalogue.routes.js';
import { createCatalogueService } from '../catalogue.service.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * GET /api/v1/products?q= — public product search, against real PostgreSQL.
 *
 * Two design rules drive the fixtures. Every case uses SEVERAL products, so a query that
 * accidentally matches everything cannot look correct; and every visibility case pairs a
 * matching hidden product with a matching visible one, so "search returns nothing" cannot be
 * mistaken for "search correctly excluded the draft".
 *
 * The escaping cases run against real PostgreSQL rather than asserting the transform in
 * isolation — the property that matters is what the database does with the pattern, not what
 * the string looks like on the way there.
 */
describe('GET /api/v1/products?q= (integration)', () => {
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
   * The public router, wired with a verifier and a scope guard that THROW if invoked.
   *
   * Adding `q` must not quietly turn a public endpoint into an authenticated one, so the
   * absence of authentication is enforced structurally rather than asserted after the fact.
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
          throw new Error('public search must not verify a token');
        },
        requireStaff: () => {
          throw new Error('public search must not run a scope guard');
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

  let sequence = 0;

  /** Explicit `createdAt`, so ordering is a property of the data rather than of insert speed. */
  async function givenProduct(
    overrides: {
      /** The SKU price. Price lives on the SKU from Increment 24, not the product. */
      price?: string;
      name?: string;
      slug?: string;
      description?: string;
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
      description: overrides.description ?? '',
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
  const search = (app: App, q: string, extra = '') =>
    list(app, `?q=${encodeURIComponent(q)}${extra}`);

  const namesOf = (response: { body: { products: { name: string }[] } }): string[] =>
    response.body.products.map((p) => p.name);

  /** A catalogue where a naive "match everything" query would be obvious. */
  async function givenCatalogue() {
    await givenProduct({ name: 'Blue Cotton Shirt' });
    await givenProduct({ name: 'Red Silk Shirt' });
    await givenProduct({ name: 'Leather Boots' });
    await givenProduct({ name: 'Wool Scarf' });
  }

  describe('matching', () => {
    it('matches a substring of the name', async () => {
      await givenCatalogue();
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(response.status).toBe(200);
      // Two of four — a query that matched everything, or nothing, would be visible here.
      expect(namesOf(response).sort()).toEqual(['Blue Cotton Shirt', 'Red Silk Shirt']);
      expect(response.body.pagination.total).toBe(2);
    });

    it('matches in the middle and at the start of a name', async () => {
      await givenCatalogue();
      const { app } = build();

      // Substring, not prefix: "cotton" appears mid-name and must still match.
      expect(namesOf(await search(app, 'cotton'))).toEqual(['Blue Cotton Shirt']);
      expect(namesOf(await search(app, 'Blue'))).toEqual(['Blue Cotton Shirt']);
      expect(namesOf(await search(app, 'Boots'))).toEqual(['Leather Boots']);
    });

    it('is case-insensitive in both directions', async () => {
      await givenProduct({ name: 'Blue Cotton SHIRT' });
      await givenProduct({ name: 'lowercase shirt' });
      const { app } = build();

      for (const term of ['shirt', 'SHIRT', 'ShIrT']) {
        const response = await search(app, term);
        expect(namesOf(response).sort(), term).toEqual(['Blue Cotton SHIRT', 'lowercase shirt']);
      }
    });

    it('trims the term before searching', async () => {
      await givenCatalogue();
      const { app } = build();

      // `%  shirt  %` would match nothing; trimming is what makes this work.
      expect(namesOf(await search(app, '   shirt   ')).sort()).toEqual([
        'Blue Cotton Shirt',
        'Red Silk Shirt',
      ]);
    });

    it('returns 200 with an empty page when nothing matches', async () => {
      await givenCatalogue();
      const { app } = build();

      const response = await search(app, 'umbrella');

      // Not 404 — "no results" is a valid answer to a search, not a missing resource.
      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('behaves exactly as before when q is absent', async () => {
      await givenCatalogue();
      const { app } = build();

      const withoutQ = await list(app);

      // The un-searched listing must be byte-for-byte what Increment 18 produced.
      expect(namesOf(withoutQ)).toHaveLength(4);
      expect(withoutQ.body.pagination).toEqual({ limit: 20, offset: 0, total: 4 });
    });
  });

  describe('it searches the NAME and nothing else', () => {
    it('does not match the description', async () => {
      await givenProduct({ name: 'Leather Boots', description: 'Goes well with a shirt.' });
      await givenProduct({ name: 'Cotton Shirt', description: 'Plain.' });
      const { app } = build();

      const response = await search(app, 'shirt');

      /**
       * Only the name. With no relevance ranking a description match would sort equal to a name
       * match, ordered by date — so a product that merely MENTIONS "shirt" would outrank the
       * shirt itself whenever it happened to be newer.
       */
      expect(namesOf(response)).toEqual(['Cotton Shirt']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('does not match the slug', async () => {
      await givenProduct({ name: 'Leather Boots', slug: 'winter-shirt-alternative' });
      await givenProduct({ name: 'Cotton Shirt', slug: 'cs-001' });
      const { app } = build();

      expect(namesOf(await search(app, 'shirt'))).toEqual(['Cotton Shirt']);
    });

    it('does not match the status', async () => {
      await givenProduct({ name: 'Ordinary Product', status: 'active' });
      const { app } = build();

      // "active" is a status value, not name text — searching it must find nothing.
      const response = await search(app, 'active');
      expect(response.body.products).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });
  });

  describe('search never widens visibility', () => {
    /**
     * Each case pairs a MATCHING hidden product with a MATCHING visible one, so an empty result
     * cannot be mistaken for correct exclusion — exactly one product must come back.
     */
    it('still excludes drafts', async () => {
      await givenProduct({ name: 'Visible Shirt', status: 'active' });
      await givenProduct({ name: 'Draft Shirt', status: 'draft' });
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(namesOf(response)).toEqual(['Visible Shirt']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Draft Shirt');
    });

    it('still excludes archived products', async () => {
      await givenProduct({ name: 'Visible Shirt', status: 'active' });
      await givenProduct({ name: 'Archived Shirt', status: 'archived' });
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(namesOf(response)).toEqual(['Visible Shirt']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('still excludes soft-deleted products', async () => {
      await givenProduct({ name: 'Visible Shirt', status: 'active' });
      await givenProduct({ name: 'Deleted Shirt', status: 'active', deletedAt: new Date() });
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(namesOf(response)).toEqual(['Visible Shirt']);
      expect(response.body.pagination.total).toBe(1);
    });

    it('still excludes other stores', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ name: 'Our Shirt', status: 'active' });
      await givenProduct({ name: 'Their Shirt', storeId: secondStoreId, status: 'active' });
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(namesOf(response)).toEqual(['Our Shirt']);
      expect(response.body.pagination.total).toBe(1);
      expect(JSON.stringify(response.body)).not.toContain('Their Shirt');
    });

    it('excludes every hidden state at once while still finding the visible ones', async () => {
      await givenProduct({ name: 'Shirt One', status: 'active' });
      await givenProduct({ name: 'Shirt Two', status: 'active' });
      await givenProduct({ name: 'Shirt Draft', status: 'draft' });
      await givenProduct({ name: 'Shirt Archived', status: 'archived' });
      await givenProduct({ name: 'Shirt Deleted', status: 'active', deletedAt: new Date() });
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ name: 'Shirt Foreign', storeId: secondStoreId, status: 'active' });
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(namesOf(response).sort()).toEqual(['Shirt One', 'Shirt Two']);
      expect(response.body.pagination.total).toBe(2);
      for (const hidden of ['Draft', 'Archived', 'Deleted', 'Foreign']) {
        expect(JSON.stringify(response.body), hidden).not.toContain(`Shirt ${hidden}`);
      }
    });
  });

  describe('pagination reflects the filter', () => {
    async function givenTwelveShirtsAndFourOthers() {
      for (let i = 1; i <= 12; i += 1) {
        await givenProduct({ name: `Shirt ${String(i).padStart(2, '0')}` });
      }
      for (let i = 1; i <= 4; i += 1) {
        await givenProduct({ name: `Boots ${String(i)}` });
      }
    }

    it('reports the FILTERED total, not the catalogue total', async () => {
      await givenTwelveShirtsAndFourOthers();
      const { app } = build();

      const searched = await search(app, 'shirt');
      const unsearched = await list(app);

      /**
       * The classic paginated-search bug: a total taken from the unfiltered set. 12 versus 16
       * is the whole assertion, and it is why the search term joins the SHARED predicate rather
       * than only the page query.
       */
      expect(searched.body.pagination.total).toBe(12);
      expect(unsearched.body.pagination.total).toBe(16);
    });

    it('pages through the filtered set with no gaps and no duplicates', async () => {
      await givenTwelveShirtsAndFourOthers();
      const { app } = build();

      const pages = await Promise.all(
        [0, 5, 10].map((offset) => search(app, 'shirt', `&limit=5&offset=${String(offset)}`)),
      );
      const seen = pages.flatMap((p) => namesOf(p));

      // 5 + 5 + 2, every one a shirt, each exactly once.
      // `body` is `any` from supertest, so the cast keeps the assertion typed.
      expect(pages.map((p) => (p.body.products as unknown[]).length)).toEqual([5, 5, 2]);
      expect(new Set(seen).size).toBe(12);
      expect(seen.every((n) => n.startsWith('Shirt'))).toBe(true);
    });

    it('applies LIMIT after the filter, so a page is full of matches', async () => {
      // Interleaved, so a limit applied before the filter would yield short pages.
      for (let i = 1; i <= 6; i += 1) {
        await givenProduct({ name: `Shirt ${String(i)}` });
        await givenProduct({ name: `Boots ${String(i)}` });
      }
      const { app } = build();

      const page = await search(app, 'shirt', '&limit=4');

      expect(page.body.products).toHaveLength(4);
      expect(namesOf(page).every((n) => n.startsWith('Shirt'))).toBe(true);
      expect(page.body.pagination.total).toBe(6);
    });

    it('keeps the ordering deterministic among matches', async () => {
      const base = Date.UTC(2026, 5, 1, 12, 0, 0);
      const names = ['Shirt A', 'Shirt B', 'Shirt C', 'Shirt D'];
      for (const [i, name] of names.entries()) {
        await givenProduct({ name, createdAt: new Date(base + i * 60_000) });
      }
      const { app } = build();

      // Newest first, unchanged by searching.
      expect(namesOf(await search(app, 'shirt'))).toEqual([...names].reverse());
    });

    it('returns an empty page past the end of the filtered set', async () => {
      await givenTwelveShirtsAndFourOthers();
      const { app } = build();

      const response = await search(app, 'shirt', '&offset=50');

      expect(response.status).toBe(200);
      expect(response.body.products).toEqual([]);
      // The total still describes the real filtered set, so a client can recover.
      expect(response.body.pagination.total).toBe(12);
    });
  });

  describe('LIKE metacharacters are literal', () => {
    it('treats % as a literal percent sign', async () => {
      await givenProduct({ name: '50% Cotton Shirt' });
      await givenProduct({ name: 'Leather Boots' });
      await givenProduct({ name: 'Wool Scarf' });
      const { app } = build();

      /**
       * Three products, exactly ONE of which contains a literal `%`.
       *
       * That asymmetry is the assertion. Escaped, `?q=%` is a search for a percent sign and
       * finds the one product that has one. UNESCAPED it is a LIKE wildcard and returns the
       * entire catalogue — so `1` versus `3` distinguishes correct behaviour from the bug,
       * where an empty-result assertion would have distinguished neither.
       */
      const wildcard = await search(app, '%');
      expect(namesOf(wildcard)).toEqual(['50% Cotton Shirt']);
      expect(wildcard.body.pagination.total).toBe(1);

      // And a percent sign inside a longer term behaves the same way.
      expect(namesOf(await search(app, '50%'))).toEqual(['50% Cotton Shirt']);
      expect(namesOf(await search(app, '0% Cot'))).toEqual(['50% Cotton Shirt']);
    });

    it('treats _ as a literal underscore', async () => {
      await givenProduct({ name: 'Model_X Shirt' });
      await givenProduct({ name: 'ModelYShirt' });
      const { app } = build();

      /**
       * Unescaped, `_` matches any single character, so `Model_X` would also match `ModelYX`.
       * Both products exist precisely so that difference is observable.
       */
      expect(namesOf(await search(app, 'Model_'))).toEqual(['Model_X Shirt']);
      expect(namesOf(await search(app, 'l_X'))).toEqual(['Model_X Shirt']);
    });

    it('treats a backslash as a literal backslash', async () => {
      await givenProduct({ name: 'Back\\Slash Product' });
      await givenProduct({ name: 'Ordinary Product' });
      const { app } = build();

      /**
       * The subtle one. A backslash is PostgreSQL's LIKE escape character, so an unescaped one
       * would consume the character after it — and escaping it in the wrong ORDER would
       * double-escape. Both failure modes are visible here.
       */
      expect(namesOf(await search(app, 'Back\\Slash'))).toEqual(['Back\\Slash Product']);
      expect(namesOf(await search(app, '\\'))).toEqual(['Back\\Slash Product']);
    });

    it('cannot be used to match everything', async () => {
      await givenCatalogue();
      const { app } = build();

      // Every shape of wildcard abuse returns nothing, because none of them is a real name.
      for (const term of ['%', '%%', '%_%', '_', '____', '%shirt%']) {
        const response = await search(app, term);
        expect(response.body.products, term).toEqual([]);
        expect(response.body.pagination.total, term).toBe(0);
      }
    });

    it('escapes exactly the three metacharacters and nothing else', () => {
      // Asserted directly too, because the DB tests above prove the OUTCOME while this pins the
      // transform — including that ordinary text is passed through untouched.
      expect(escapeLikePattern('shirt')).toBe('shirt');
      expect(escapeLikePattern('50%')).toBe('50\\%');
      expect(escapeLikePattern('a_b')).toBe('a\\_b');
      expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
      expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
      // Not an escape character in LIKE — must be left alone.
      expect(escapeLikePattern("O'Brien & Sons")).toBe("O'Brien & Sons");
    });
  });

  describe('validation', () => {
    it('rejects an empty q', async () => {
      await givenCatalogue();
      const { app } = build();

      for (const query of ['?q=', '?q=%20', '?q=%20%20%20']) {
        const response = await list(app, query);
        expect(response.status, query).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects a q longer than 100 characters', async () => {
      const { app } = build();

      expect((await search(app, 'x'.repeat(100))).status).toBe(200);
      expect((await search(app, 'x'.repeat(101))).status).toBe(400);
    });

    it('still rejects unknown query parameters', async () => {
      await givenCatalogue();
      const { app } = build();

      for (const query of [
        '?query=shirt',
        '?search=shirt',
        '?q=shirt&status=draft',
        '?q=shirt&storeId=x',
      ]) {
        expect((await list(app, query)).status, query).toBe(400);
      }
    });

    it('still enforces the existing limit and offset rules alongside q', async () => {
      const { app } = build();

      expect((await search(app, 'shirt', '&limit=101')).status).toBe(400);
      expect((await search(app, 'shirt', '&limit=0')).status).toBe(400);
      expect((await search(app, 'shirt', '&offset=-1')).status).toBe(400);
      expect((await search(app, 'shirt', '&limit=abc')).status).toBe(400);
    });

    it('does NOT accept q on the ADMIN list', async () => {
      const { app } = build();

      /**
       * `q` lives on a public-only schema. Widening the shared one would have given the admin
       * list a parameter it silently ignores — a request that looks honoured and is not.
       * Admin search is its own increment.
       */
      const response = await request(app).get('/api/v1/admin/products?q=shirt');

      // 401 rather than 400: the admin route rejects the missing token first. What matters is
      // that it is NOT a 200 with searched results.
      expect(response.status).toBe(401);
    });
  });

  describe('public access and response shape', () => {
    it('requires no Authorization header', async () => {
      await givenCatalogue();
      const { app } = build();

      // The router throws if a verifier or scope guard runs, so a 200 proves neither did.
      const response = await request(app).get('/api/v1/products?q=shirt');

      expect(response.status).toBe(200);
      expect(response.body.products).toHaveLength(2);
    });

    it('returns the unchanged envelope and per-item key set', async () => {
      await givenCatalogue();
      const { app } = build();

      const response = await search(app, 'shirt');

      expect(Object.keys(response.body).sort()).toEqual(['pagination', 'products']);
      expect(Object.keys(response.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
      for (const item of response.body.products as Record<string, unknown>[]) {
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
        expect(item['status']).toBe('active');
      }
    });

    it('leaks neither storeId nor deletedAt', async () => {
      await givenCatalogue();
      const { app } = build();

      const response = await search(app, 'shirt');

      for (const item of response.body.products as Record<string, unknown>[]) {
        for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
          expect(item, field).not.toHaveProperty(field);
        }
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('scopes the search in the REPOSITORY, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      await givenProduct({ name: 'Our Shirt' });
      await givenProduct({ name: 'Their Shirt', storeId: secondStoreId });

      // Called directly, bypassing every middleware — a search must not become a way to read
      // another tenant's catalogue.
      const foreign = await repository.listPublicForStore({
        storeId: secondStoreId,
        limit: 20,
        offset: 0,
        search: 'Our',
      });
      expect(foreign.items).toEqual([]);
      expect(foreign.total).toBe(0);

      const own = await repository.listPublicForStore({
        storeId,
        limit: 20,
        offset: 0,
        search: 'Our',
      });
      expect(own.items.map((p) => p.name)).toEqual(['Our Shirt']);
    });
  });
});
