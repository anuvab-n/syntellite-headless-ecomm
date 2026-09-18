import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product, productMedia } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
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
import { giveSku, testMediaStorage } from '../../../../tests/helpers/catalogue.ts';
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
 * The product capabilities added in Increment 58, against real PostgreSQL.
 *
 * Search, the status filter and the tab counts on the list; generated SKU codes; bulk lifecycle
 * actions; and the whole of product media — registration, the gallery, ordering, the primary
 * flag, deletion, and the upload target.
 *
 * Every figure is asserted against an independent derivation or an explicit expectation rather
 * than against a second call into the same code, and every new surface is checked for tenancy
 * with a REAL foreign row rather than against an absence.
 */
describe('admin product completeness (integration)', () => {
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

  function build(
    slug = testDb.config.defaultStoreSlug,
    storageOptions: { failUploads?: boolean } = {},
  ) {
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
          storage: testMediaStorage(storageOptions),
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

  /**
   * A gallery response as a typed array.
   *
   * `response.body` is `any` from supertest, so the cast happens here once, exactly as
   * `slugsOf` does it for the product list.
   */
  type MediaRow = { id: string; position: number; isPrimary: boolean };
  const mediaOf = (response: { body: { media: MediaRow[] } }): MediaRow[] => response.body.media;

  const staffApp = async () => {
    const built = build();
    const token = await signIn(built.app, built.identity, { staff: true });
    return { ...built, token };
  };

  const post = (app: App, path: string, body: object, token?: string) => {
    const req = request(app).post(`/api/v1/${path}`).send(body);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const patch = (app: App, path: string, body: object, token: string) =>
    request(app).patch(`/api/v1/${path}`).set('Authorization', `Bearer ${token}`).send(body);

  const del = (app: App, path: string, token?: string) => {
    const req = request(app).delete(`/api/v1/${path}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const get = (app: App, path: string, token?: string) => {
    const req = request(app).get(`/api/v1/${path}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── 1. Search and status filters ─────────────────────────────────────── */

  describe('search and status filters', () => {
    it('finds a product by a fragment of its name, case-insensitively', async () => {
      await givenProduct({ slug: 'blue-running-shoe' });
      await givenProduct({ slug: 'red-kettle' });
      const { app, token } = await staffApp();

      expect(slugsOf(await list(app, '?q=RUNNING', token))).toEqual(['blue-running-shoe']);
    });

    it('finds a product by a fragment of its slug', async () => {
      await givenProduct({ slug: 'winter-jacket' });
      await givenProduct({ slug: 'summer-hat' });
      const { app, token } = await staffApp();

      expect(slugsOf(await list(app, '?q=jack', token))).toEqual(['winter-jacket']);
    });

    /**
     * An unescaped `%` would match the whole catalogue, which reads to an operator as "the
     * filter is broken" rather than "nothing matched".
     */
    it('treats % and _ as literal characters, not wildcards', async () => {
      await givenProduct({ slug: 'plain-product' });
      const { app, token } = await staffApp();

      expect(slugsOf(await list(app, '?q=%25', token))).toEqual([]);
      expect(slugsOf(await list(app, '?q=_', token))).toEqual([]);
    });

    it('rejects a whitespace-only search rather than matching everything', async () => {
      await givenProduct({ slug: 'anything' });
      const { app, token } = await staffApp();

      expect((await list(app, '?q=%20%20', token)).status).toBe(400);
      expect((await list(app, '?q=', token)).status).toBe(400);
    });

    it('narrows to one lifecycle status', async () => {
      await givenProduct({ slug: 'a-draft', status: 'draft' });
      await givenProduct({ slug: 'b-active', status: 'active' });
      await givenProduct({ slug: 'c-archived', status: 'archived' });
      const { app, token } = await staffApp();

      expect(slugsOf(await list(app, '?status=active', token))).toEqual(['b-active']);
      expect(slugsOf(await list(app, '?status=archived', token))).toEqual(['c-archived']);
    });

    it('rejects a status outside the real vocabulary', async () => {
      const { app, token } = await staffApp();
      const response = await list(app, '?status=published', token);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('combines q with status rather than replacing it', async () => {
      await givenProduct({ slug: 'shoe-draft', status: 'draft' });
      await givenProduct({ slug: 'shoe-active', status: 'active' });
      const { app, token } = await staffApp();

      expect(slugsOf(await list(app, '?q=shoe&status=active', token))).toEqual(['shoe-active']);
    });

    it('never matches a soft-deleted product', async () => {
      await givenProduct({ slug: 'erased-shoe', deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await list(app, '?q=erased', token);
      expect(slugsOf(response)).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('never matches another store’s product', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({
          id: otherStoreId,
          slug: `other-${otherStoreId.slice(0, 8)}`,
          name: 'Other Store',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        });
      await givenProduct({ slug: 'foreign-shoe', storeId: otherStoreId });
      await givenProduct({ slug: 'local-shoe' });

      const { app, token } = await staffApp();
      expect(slugsOf(await list(app, '?q=shoe', token))).toEqual(['local-shoe']);
    });
  });

  /* ── 2. Status counts ─────────────────────────────────────────────────── */

  describe('status counts', () => {
    it('counts every lifecycle status, including at zero', async () => {
      await givenProduct({ status: 'draft' });
      await givenProduct({ status: 'draft' });
      await givenProduct({ status: 'active' });
      const { app, token } = await staffApp();

      const response = await list(app, '', token);
      expect(response.body.counts).toEqual({ total: 3, draft: 2, active: 1, archived: 0 });
    });

    /**
     * The tabs must not move as the operator types, or a count could never say how many rows
     * switching to that tab would show.
     */
    it('does not narrow the counts with the request’s own filters', async () => {
      await givenProduct({ slug: 'alpha', status: 'draft' });
      await givenProduct({ slug: 'beta', status: 'active' });
      const { app, token } = await staffApp();

      const filtered = await list(app, '?status=active&q=beta', token);
      expect(filtered.body.pagination.total).toBe(1);
      expect(filtered.body.counts).toEqual({ total: 2, draft: 1, active: 1, archived: 0 });
    });

    it('does not narrow the counts with pagination', async () => {
      for (let i = 0; i < 4; i += 1) await givenProduct({ status: 'draft' });
      const { app, token } = await staffApp();

      const page = await list(app, '?limit=1', token);
      expect(page.body.products).toHaveLength(1);
      expect(page.body.counts.total).toBe(4);
    });

    it('excludes soft-deleted products from the counts', async () => {
      await givenProduct({ status: 'active' });
      await givenProduct({ status: 'active', deletedAt: new Date() });
      const { app, token } = await staffApp();

      expect((await list(app, '', token)).body.counts).toEqual({
        total: 1,
        draft: 0,
        active: 1,
        archived: 0,
      });
    });

    it('counts only this store’s products', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({
          id: otherStoreId,
          slug: `other-${otherStoreId.slice(0, 8)}`,
          name: 'Other Store',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        });
      await givenProduct({ storeId: otherStoreId, status: 'active' });
      await givenProduct({ storeId: otherStoreId, status: 'active' });
      await givenProduct({ status: 'draft' });

      const { app, token } = await staffApp();
      expect((await list(app, '', token)).body.counts).toEqual({
        total: 1,
        draft: 1,
        active: 0,
        archived: 0,
      });
    });
  });

  /* ── 3. SKU code generation ───────────────────────────────────────────── */

  describe('SKU code generation', () => {
    const createSku = (app: App, slug: string, body: object, token: string) =>
      post(app, `admin/products/${slug}/skus`, body, token);

    it('generates a code when the caller supplies none', async () => {
      const created = await givenProduct({ slug: 'blue-shirt' });
      const { app, token } = await staffApp();

      const response = await createSku(app, created.slug, { price: '10.0000' }, token);

      expect(response.status).toBe(201);
      /* `PREFIX-XXXXXX`, the prefix derived from the slug, the suffix from a 32-symbol alphabet. */
      expect(response.body.sku.code).toMatch(/^BLUE-SHIRT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u);
    });

    it('never draws the ambiguous characters I, O, 0 or 1', async () => {
      const created = await givenProduct({ slug: 'legible' });
      const { app, token } = await staffApp();

      for (let i = 0; i < 25; i += 1) {
        const response = await createSku(app, created.slug, { price: '1.0000' }, token);
        expect(response.status).toBe(201);
        const suffix = (response.body.sku.code as string).split('-').at(-1) ?? '';
        expect(suffix, response.body.sku.code).not.toMatch(/[IO01]/u);
      }
    });

    it('produces a distinct code for every SKU of one product', async () => {
      const created = await givenProduct({ slug: 'many-variants' });
      const { app, token } = await staffApp();

      const codes = new Set<string>();
      for (let i = 0; i < 25; i += 1) {
        const response = await createSku(app, created.slug, { price: '1.0000' }, token);
        expect(response.status).toBe(201);
        codes.add(response.body.sku.code as string);
      }
      expect(codes.size).toBe(25);
    });

    /**
     * The generated code must survive the very validation a supplied one faces, or a merchant
     * could end up with a SKU whose code they cannot re-enter through the same API.
     */
    it('generates a code the create endpoint would itself accept', async () => {
      const created = await givenProduct({ slug: 'round-trip' });
      const { app, token } = await staffApp();

      const generated = await createSku(app, created.slug, { price: '5.0000' }, token);
      const code = generated.body.sku.code as string;

      expect(code.length).toBeLessThanOrEqual(64);
      expect(code).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
    });

    /**
     * Concurrency: the database constraint is the arbiter, not a preceding read. Twenty
     * simultaneous creates must produce twenty distinct SKUs and no 500s.
     */
    it('is safe under concurrent creates', async () => {
      const created = await givenProduct({ slug: 'concurrent' });
      const { app, token } = await staffApp();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => createSku(app, created.slug, { price: '2.0000' }, token)),
      );

      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(new Set(responses.map((r) => r.body.sku.code as string)).size).toBe(20);
    });

    it('falls back to a usable prefix for a slug with no usable characters', async () => {
      /* A slug is `[a-z0-9-]`, so a digits-and-hyphens slug still reduces to something. */
      const created = await givenProduct({ slug: '2024' });
      const { app, token } = await staffApp();

      const response = await createSku(app, created.slug, { price: '1.0000' }, token);
      expect(response.status).toBe(201);
      expect(response.body.sku.code).toMatch(/^2024-/u);
    });

    it('still honours a supplied code, and still refuses a duplicate', async () => {
      const created = await givenProduct({ slug: 'explicit' });
      const { app, token } = await staffApp();

      const first = await createSku(app, created.slug, { code: 'MY-CODE', price: '1.0000' }, token);
      expect(first.status).toBe(201);
      expect(first.body.sku.code).toBe('MY-CODE');

      const second = await createSku(
        app,
        created.slug,
        { code: 'MY-CODE', price: '1.0000' },
        token,
      );
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SKU_CODE_TAKEN');
    });

    it('still rejects a malformed supplied code', async () => {
      const created = await givenProduct({ slug: 'validated' });
      const { app, token } = await staffApp();

      const response = await createSku(app, created.slug, { code: '-bad', price: '1.0000' }, token);
      expect(response.status).toBe(400);
    });
  });

  /* ── 4. Bulk actions ──────────────────────────────────────────────────── */

  describe('bulk actions', () => {
    const bulk = (app: App, body: object, token?: string) =>
      post(app, 'admin/products/bulk', body, token);

    it('rejects an unauthenticated request with 401', async () => {
      const { app } = build();
      expect((await bulk(app, { action: 'publish', slugs: ['x'] })).status).toBe(401);
    });

    it('rejects a non-staff caller with 403', async () => {
      const built = build();
      const token = await signIn(built.app, built.identity, { staff: false });
      expect((await bulk(built.app, { action: 'publish', slugs: ['x'] }, token)).status).toBe(403);
    });

    it('publishes every selected product and reports what moved', async () => {
      await givenProduct({ slug: 'one', status: 'draft' });
      await givenProduct({ slug: 'two', status: 'draft' });
      await givenProduct({ slug: 'untouched', status: 'draft' });
      const { app, token } = await staffApp();

      const response = await bulk(app, { action: 'publish', slugs: ['two', 'one'] }, token);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ action: 'publish', affected: 2, slugs: ['one', 'two'] });
      expect(slugsOf(await list(app, '?status=active', token)).sort()).toEqual(['one', 'two']);
    });

    it('archives and soft-deletes in bulk', async () => {
      await givenProduct({ slug: 'live-one', status: 'active' });
      await givenProduct({ slug: 'doomed', status: 'draft' });
      const { app, token } = await staffApp();

      expect((await bulk(app, { action: 'archive', slugs: ['live-one'] }, token)).status).toBe(200);
      expect(slugsOf(await list(app, '?status=archived', token))).toEqual(['live-one']);

      expect((await bulk(app, { action: 'delete', slugs: ['doomed'] }, token)).status).toBe(200);
      expect(slugsOf(await list(app, '', token))).not.toContain('doomed');
    });

    it('collapses a slug named twice into one product', async () => {
      await givenProduct({ slug: 'dup', status: 'draft' });
      const { app, token } = await staffApp();

      const response = await bulk(app, { action: 'publish', slugs: ['dup', 'dup'] }, token);
      expect(response.body).toEqual({ action: 'publish', affected: 1, slugs: ['dup'] });
    });

    it('rejects an empty or oversized selection', async () => {
      const { app, token } = await staffApp();

      expect((await bulk(app, { action: 'publish', slugs: [] }, token)).status).toBe(400);

      const tooMany = Array.from({ length: 101 }, (_v, i) => `slug-${String(i)}`);
      expect((await bulk(app, { action: 'publish', slugs: tooMany }, token)).status).toBe(400);
    });

    it('rejects an unknown action and an unknown field', async () => {
      const { app, token } = await staffApp();

      expect((await bulk(app, { action: 'destroy', slugs: ['a'] }, token)).status).toBe(400);
      expect(
        (await bulk(app, { action: 'publish', slugs: ['a'], storeId: newId() }, token)).status,
      ).toBe(400);
    });

    /**
     * All or nothing. A partial success would leave an operator guessing which half of their
     * selection moved, so one unknown slug refuses the whole batch and NAMES it.
     */
    it('refuses the whole batch when a slug is unknown, naming it', async () => {
      await givenProduct({ slug: 'real-one', status: 'draft' });
      const { app, token } = await staffApp();

      const response = await bulk(app, { action: 'publish', slugs: ['real-one', 'ghost'] }, token);

      expect(response.status).toBe(404);
      expect(response.body.error.details.slugs).toEqual(['ghost']);
      /* And nothing moved. */
      expect(slugsOf(await list(app, '?status=active', token))).toEqual([]);
    });

    it('treats another store’s slug exactly as an unknown one, and applies nothing', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({
          id: otherStoreId,
          slug: `other-${otherStoreId.slice(0, 8)}`,
          name: 'Other Store',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        });
      await givenProduct({ slug: 'foreign', storeId: otherStoreId, status: 'draft' });
      await givenProduct({ slug: 'mine', status: 'draft' });

      const { app, token } = await staffApp();
      const response = await bulk(app, { action: 'publish', slugs: ['mine', 'foreign'] }, token);

      expect(response.status).toBe(404);
      expect(response.body.error.details.slugs).toEqual(['foreign']);
      expect(slugsOf(await list(app, '?status=active', token))).toEqual([]);
    });

    it('refuses the whole batch on an illegal transition, naming the offenders', async () => {
      await givenProduct({ slug: 'is-active', status: 'active' });
      await givenProduct({ slug: 'is-draft', status: 'draft' });
      const { app, token } = await staffApp();

      /* `archive` moves only from `active`; a draft cannot. */
      const response = await bulk(
        app,
        { action: 'archive', slugs: ['is-active', 'is-draft'] },
        token,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(response.body.error.details.slugs).toEqual(['is-draft']);
      expect(slugsOf(await list(app, '?status=archived', token))).toEqual([]);
    });

    it('writes one audit entry per product moved', async () => {
      await givenProduct({ slug: 'audited-one', status: 'draft' });
      await givenProduct({ slug: 'audited-two', status: 'draft' });
      const { app, token } = await staffApp();

      await bulk(app, { action: 'publish', slugs: ['audited-one', 'audited-two'] }, token);

      const rows = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'product.published'));
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => (row.metadata as { bulk?: boolean }).bulk === true)).toBe(true);
    });

    /**
     * Bulk and single must emit the SAME domain event.
     *
     * A subscriber invalidating a storefront cache cannot know which route a merchant used. An
     * event that fired for one and not the other would leave the cache stale exactly when the
     * merchant published in bulk — the failure would be silent and would look like a caching bug.
     */
    it('emits the same product event a single publish emits', async () => {
      await givenProduct({ slug: 'via-bulk', status: 'draft' });
      await givenProduct({ slug: 'via-single', status: 'draft' });
      const { app, token } = await staffApp();

      await bulk(app, { action: 'publish', slugs: ['via-bulk'] }, token);
      await post(app, 'admin/products/via-single/publish', {}, token);

      const events = await db()
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventName, 'product.published'));

      expect(events).toHaveLength(2);

      const payloads = new Map(
        events.map((row) => {
          const payload = row.payload as { slug: string; name: string; status: string };
          return [payload.slug, payload];
        }),
      );

      /* Not merely present — the SAME facts, so one is not a thinner second shape. */
      expect(Object.keys(payloads.get('via-bulk') ?? {}).sort()).toEqual(
        Object.keys(payloads.get('via-single') ?? {}).sort(),
      );
      expect(payloads.get('via-bulk')?.status).toBe('active');
    });

    /**
     * A bulk delete must cascade exactly as `DELETE /admin/products/:slug` does.
     *
     * Imagery in particular: a media row that outlived its product keeps a storage object
     * referenced by a row nothing can reach, and it would still occupy the product's primary
     * slot if the slug were ever reused.
     */
    it('cascades imagery when a product is deleted in bulk', async () => {
      const created = await givenProduct({ slug: 'bulk-deleted' });
      const { app, token } = await staffApp();

      const registered = await post(
        app,
        `admin/products/${created.slug}/media`,
        { storageKey: 'bulk/one.webp', contentType: 'image/webp' },
        token,
      );
      expect(registered.status).toBe(201);

      await bulk(app, { action: 'delete', slugs: ['bulk-deleted'] }, token);

      const rows = await db()
        .select()
        .from(productMedia)
        .where(eq(productMedia.id, registered.body.media.id as string));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.deletedAt).not.toBeNull();
      expect(rows[0]?.isPrimary).toBe(false);
    });
  });

  /* ── 5. Product media ─────────────────────────────────────────────────── */

  describe('product media', () => {
    const KEY = 'stores/s/products/p/one.webp';

    const addMedia = (app: App, slug: string, body: object, token?: string) =>
      post(app, `admin/products/${slug}/media`, body, token);

    const listMedia = (app: App, slug: string, token?: string) =>
      get(app, `admin/products/${slug}/media`, token);

    it('rejects unauthenticated and non-staff callers', async () => {
      const created = await givenProduct({ slug: 'guarded' });
      const built = build();
      const customer = await signIn(built.app, built.identity, { staff: false });

      expect(
        (await addMedia(built.app, created.slug, { storageKey: KEY, contentType: 'image/webp' }))
          .status,
      ).toBe(401);
      expect((await listMedia(built.app, created.slug)).status).toBe(401);
      expect((await listMedia(built.app, created.slug, customer)).status).toBe(403);
    });

    it('registers an object and makes the first image primary', async () => {
      const created = await givenProduct({ slug: 'gallery' });
      const { app, token } = await staffApp();

      const response = await addMedia(
        app,
        created.slug,
        { storageKey: KEY, contentType: 'image/webp', altText: 'A shoe', width: 800, height: 600 },
        token,
      );

      expect(response.status).toBe(201);
      expect(response.body.media).toMatchObject({
        storageKey: KEY,
        contentType: 'image/webp',
        altText: 'A shoe',
        width: 800,
        height: 600,
        position: 0,
        isPrimary: true,
        skuCode: null,
      });
      /* The URL is COMPOSED from the key and the configured delivery host. */
      expect(response.body.media.url).toBe(`https://cdn.test/${KEY}`);
    });

    it('does not expose internal identifiers', async () => {
      const created = await givenProduct({ slug: 'no-ids' });
      const { app, token } = await staffApp();

      const response = await addMedia(
        app,
        created.slug,
        { storageKey: KEY, contentType: 'image/png' },
        token,
      );

      expect(Object.keys(response.body.media).sort()).toEqual([
        'altText',
        'byteSize',
        'contentType',
        'createdAt',
        'height',
        'id',
        'isPrimary',
        'position',
        'skuCode',
        'storageKey',
        'updatedAt',
        'url',
        'width',
      ]);
      expect(JSON.stringify(response.body)).not.toContain('productId');
      expect(JSON.stringify(response.body)).not.toContain('storeId');
      expect(JSON.stringify(response.body)).not.toContain('skuId');
    });

    it('appends later images to the end rather than to the front', async () => {
      const created = await givenProduct({ slug: 'ordered' });
      const { app, token } = await staffApp();

      for (const n of [1, 2, 3]) {
        const response = await addMedia(
          app,
          created.slug,
          { storageKey: `key-${String(n)}.webp`, contentType: 'image/webp' },
          token,
        );
        expect(response.status).toBe(201);
      }

      const gallery = await listMedia(app, created.slug, token);
      expect(mediaOf(gallery).map((m) => m.position)).toEqual([0, 1, 2]);
      expect(mediaOf(gallery).map((m) => m.isPrimary)).toEqual([true, false, false]);
    });

    it('promotes a new primary and demotes the old one atomically', async () => {
      const created = await givenProduct({ slug: 'promote' });
      const { app, token } = await staffApp();

      const first = await addMedia(
        app,
        created.slug,
        { storageKey: 'a.webp', contentType: 'image/webp' },
        token,
      );
      const second = await addMedia(
        app,
        created.slug,
        { storageKey: 'b.webp', contentType: 'image/webp' },
        token,
      );

      const promoted = await patch(
        app,
        `admin/media/${second.body.media.id}`,
        { isPrimary: true },
        token,
      );
      expect(promoted.status).toBe(200);
      expect(promoted.body.media.isPrimary).toBe(true);

      const gallery = await listMedia(app, created.slug, token);
      const byId = new Map(mediaOf(gallery).map((m) => [m.id, m.isPrimary]));
      expect(byId.get(first.body.media.id)).toBe(false);
      expect(byId.get(second.body.media.id)).toBe(true);
    });

    it('edits alt text and position, and refuses an empty body', async () => {
      const created = await givenProduct({ slug: 'editable' });
      const { app, token } = await staffApp();
      const media = await addMedia(
        app,
        created.slug,
        { storageKey: 'c.webp', contentType: 'image/webp' },
        token,
      );

      const updated = await patch(
        app,
        `admin/media/${media.body.media.id}`,
        { altText: 'Updated', position: 5 },
        token,
      );
      expect(updated.status).toBe(200);
      expect(updated.body.media).toMatchObject({ altText: 'Updated', position: 5 });

      expect((await patch(app, `admin/media/${media.body.media.id}`, {}, token)).status).toBe(400);
    });

    it('attaches an image to one of the product’s own SKUs', async () => {
      const created = await givenProduct({ slug: 'with-variant' });
      const { app, token } = await staffApp();

      const variant = await post(
        app,
        `admin/products/${created.slug}/skus`,
        { code: 'VARIANT-1', price: '9.0000' },
        token,
      );
      expect(variant.status).toBe(201);

      const response = await addMedia(
        app,
        created.slug,
        { storageKey: 'v.webp', contentType: 'image/webp', skuCode: 'VARIANT-1' },
        token,
      );
      expect(response.status).toBe(201);
      expect(response.body.media.skuCode).toBe('VARIANT-1');
    });

    it('404s a SKU code that belongs to a different product', async () => {
      const mine = await givenProduct({ slug: 'mine-product' });
      const other = await givenProduct({ slug: 'other-product' });
      const { app, token } = await staffApp();

      await post(
        app,
        `admin/products/${other.slug}/skus`,
        { code: 'ELSEWHERE', price: '1.0000' },
        token,
      );

      const response = await addMedia(
        app,
        mine.slug,
        { storageKey: 'x.webp', contentType: 'image/webp', skuCode: 'ELSEWHERE' },
        token,
      );
      expect(response.status).toBe(404);
    });

    it('refuses to register the same object twice', async () => {
      const created = await givenProduct({ slug: 'duplicate-key' });
      const { app, token } = await staffApp();

      expect(
        (await addMedia(app, created.slug, { storageKey: KEY, contentType: 'image/webp' }, token))
          .status,
      ).toBe(201);
      const second = await addMedia(
        app,
        created.slug,
        { storageKey: KEY, contentType: 'image/webp' },
        token,
      );

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('MEDIA_ALREADY_REGISTERED');
    });

    it('rejects a content type nothing can render, and a traversing key', async () => {
      const created = await givenProduct({ slug: 'validated-media' });
      const { app, token } = await staffApp();

      expect(
        (
          await addMedia(
            app,
            created.slug,
            { storageKey: KEY, contentType: 'image/svg+xml' },
            token,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await addMedia(
            app,
            created.slug,
            { storageKey: 'a/../../etc/passwd', contentType: 'image/png' },
            token,
          )
        ).status,
      ).toBe(400);
      /* Half a dimension pair cannot lay anything out. */
      expect(
        (
          await addMedia(
            app,
            created.slug,
            { storageKey: KEY, contentType: 'image/png', width: 100 },
            token,
          )
        ).status,
      ).toBe(400);
    });

    it('removes an image and frees the primary slot', async () => {
      const created = await givenProduct({ slug: 'removable' });
      const { app, token } = await staffApp();

      const first = await addMedia(
        app,
        created.slug,
        { storageKey: 'd.webp', contentType: 'image/webp' },
        token,
      );
      const second = await addMedia(
        app,
        created.slug,
        { storageKey: 'e.webp', contentType: 'image/webp' },
        token,
      );

      expect((await del(app, `admin/media/${first.body.media.id}`, token)).status).toBe(204);
      /* A repeated delete is a 404, not a silent success. */
      expect((await del(app, `admin/media/${first.body.media.id}`, token)).status).toBe(404);

      /* The freed slot accepts a replacement primary. */
      const promoted = await patch(
        app,
        `admin/media/${second.body.media.id}`,
        { isPrimary: true },
        token,
      );
      expect(promoted.status).toBe(200);

      const gallery = await listMedia(app, created.slug, token);
      expect(gallery.body.media).toHaveLength(1);
    });

    it('cascades imagery when the product is deleted', async () => {
      const created = await givenProduct({ slug: 'cascade-me' });
      const { app, token } = await staffApp();
      await addMedia(app, created.slug, { storageKey: 'f.webp', contentType: 'image/webp' }, token);

      expect((await del(app, `admin/products/${created.slug}`, token)).status).toBe(204);
      expect((await listMedia(app, created.slug, token)).status).toBe(404);
    });

    it('404s another store’s image on update and delete', async () => {
      const otherStoreId = newId();
      const otherSlug = `other-${otherStoreId.slice(0, 8)}`;
      await db().insert(store).values({
        id: otherStoreId,
        slug: otherSlug,
        name: 'Other Store',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      const foreignProduct = await givenProduct({ slug: 'foreign-gallery', storeId: otherStoreId });

      /* Register the image AS the other store, through that store's own resolved app. */
      const foreignBuilt = build(otherSlug);
      const foreignToken = await signIn(foreignBuilt.app, foreignBuilt.identity, {
        staff: true,
        email: 'other-staff@example.com',
        targetStoreId: otherStoreId,
      });
      const foreign = await addMedia(
        foreignBuilt.app,
        foreignProduct.slug,
        { storageKey: 'foreign.webp', contentType: 'image/webp' },
        foreignToken,
      );
      expect(foreign.status).toBe(201);

      const { app, token } = await staffApp();
      expect(
        (await patch(app, `admin/media/${foreign.body.media.id}`, { altText: 'x' }, token)).status,
      ).toBe(404);
      expect((await del(app, `admin/media/${foreign.body.media.id}`, token)).status).toBe(404);
    });

    it('rejects a malformed media id with 400, not 404', async () => {
      const { app, token } = await staffApp();
      expect((await del(app, 'admin/media/not-a-uuid', token)).status).toBe(400);
    });

    it('404s the gallery of an unknown product', async () => {
      const { app, token } = await staffApp();
      expect((await listMedia(app, 'no-such-product', token)).status).toBe(404);
    });
  });

  /* ── 6. The upload target ─────────────────────────────────────────────── */

  describe('upload target', () => {
    it('returns a signed target from a configured adapter', async () => {
      const created = await givenProduct({ slug: 'uploadable' });
      const { app, token } = await staffApp();

      const response = await post(
        app,
        `admin/products/${created.slug}/media/upload-target`,
        { contentType: 'image/webp', byteSize: 1024 },
        token,
      );

      expect(response.status).toBe(200);
      expect(response.body.upload.uploadUrl).toContain('https://storage.test/upload/');
      expect(response.body.upload.storageKey).toContain(created.id);
      expect(typeof response.body.upload.expiresAt).toBe('string');
    });

    /**
     * The production default when no bucket is configured. This project ships no S3 SDK, so the
     * composition root wires an adapter that refuses rather than one that invents a URL — and
     * `503` is the honest answer a client can act on.
     */
    it('answers 503 when object storage is not configured', async () => {
      const created = await givenProduct({ slug: 'unconfigured' });
      const built = build(testDb.config.defaultStoreSlug, { failUploads: true });
      const token = await signIn(built.app, built.identity, { staff: true });

      const response = await post(
        built.app,
        `admin/products/${created.slug}/media/upload-target`,
        { contentType: 'image/webp', byteSize: 1024 },
        token,
      );

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    });

    it('rejects an unrenderable type and an oversized object', async () => {
      const created = await givenProduct({ slug: 'bounded' });
      const { app, token } = await staffApp();

      const bad = await post(
        app,
        `admin/products/${created.slug}/media/upload-target`,
        { contentType: 'application/pdf', byteSize: 1024 },
        token,
      );
      expect(bad.status).toBe(400);

      const huge = await post(
        app,
        `admin/products/${created.slug}/media/upload-target`,
        { contentType: 'image/webp', byteSize: 50 * 1024 * 1024 },
        token,
      );
      expect(huge.status).toBe(400);
    });
  });
});
