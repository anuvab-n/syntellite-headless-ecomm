import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product, sku } from '../../../db/schema/catalogue.js';
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
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
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

/**
 * SKUs — the sellable unit — against real PostgreSQL.
 *
 * Three properties carry this suite, and each is one a passing test could easily fail to
 * prove:
 *
 *  1. **Store isolation is in the QUERY.** Every lookup is `(store_id, code)`, and the flat
 *     routes address a SKU by code alone. Asserted at the repository level as well as through
 *     HTTP, because a guarantee that lives only in a route is one refactor from a leak.
 *
 *  2. **Blast radius.** The update and delete predicates carry both `store_id` and `code`.
 *     Every mutation test keeps SIBLING SKUs and re-reads them, because §29's first suite
 *     passed a mutation that rewrote the whole store — every test had kept a single row.
 *
 *  3. **Deleting a product cannot leave a sellable SKU.** The cascade runs in the product's
 *     own transaction, so a rollback takes both.
 */
describe('SKUs (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const SLUG = 'blue-cotton-shirt';
  const VALID = { code: 'SHIRT-BLUE-M', name: 'Medium', price: '1499.00' };

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
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const catalogue = createCatalogueService({
      repository,
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
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { staff?: boolean; email?: string } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'staff@example.com';
    const user = await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    if (options.staff === true) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  const staffApp = async () => {
    const built = build();
    const auth = await signIn(built.app, built.identity, { staff: true });
    return { ...built, ...auth };
  };

  /** A product with NO SKUs, so each test states its own. */
  async function givenProduct(
    overrides: { slug?: string; status?: string; storeId?: string; deletedAt?: Date } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? SLUG,
      name: 'Blue Cotton Shirt',
      description: '',
      status: overrides.status ?? 'active',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    return values;
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const createSku = (app: App, body: unknown, token?: string, slug = SLUG) => {
    const req = request(app).post(`/api/v1/admin/products/${slug}/skus`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const listSkus = (app: App, token?: string, slug = SLUG) => {
    const req = request(app).get(`/api/v1/admin/products/${slug}/skus`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const patchSku = (app: App, code: string, body: unknown, token?: string) => {
    const req = request(app).patch(`/api/v1/admin/skus/${code}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const deleteSku = (app: App, code: string, token?: string) => {
    const req = request(app).delete(`/api/v1/admin/skus/${code}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── Row readers ───────────────────────────────────────────────────────── */

  const rowOf = async (code: string, scopedTo = storeId) => {
    const [row] = await db()
      .select()
      .from(sku)
      .where(and(eq(sku.storeId, scopedTo), eq(sku.code, code)));
    return row;
  };

  const allRows = async () => db().select().from(sku).orderBy(sku.code);

  /**
   * SKU codes out of a response, narrowed at the boundary.
   *
   * Supertest hands back `any`, so calling `.map` on it directly trips `no-unsafe-call` —
   * the test override relaxes member ACCESS, not calls. Narrowing once here keeps the
   * assertions readable and the types honest.
   */
  const codesOf = (body: { skus: { code: string }[] }): string[] => body.skus.map((s) => s.code);

  const productSkuCodes = (body: { product: { skus: { code: string }[] } }): string[] =>
    codesOf(body.product);

  const eventsFor = async (aggregateType: string) =>
    (await db().select().from(outboxEvent)).filter((r) => r.aggregateType === aggregateType);

  const auditFor = async (resourceType: string) =>
    (await db().select().from(auditLog)).filter((r) => r.resourceType === resourceType);

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('rejects unauthenticated requests on every SKU route', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app } = build();

      for (const response of [
        await createSku(app, VALID),
        await listSkus(app),
        await patchSku(app, VALID.code, { price: '1.00' }),
        await deleteSku(app, VALID.code),
      ]) {
        expect(response.status).toBe(401);
        expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      }

      // Nothing was written or removed on any rejected request.
      expect(await allRows()).toHaveLength(1);
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, identity } = build();
      const { token } = await signIn(app, identity);

      for (const response of [
        await createSku(app, { ...VALID, code: 'OTHER-1' }, token),
        await listSkus(app, token),
        await patchSku(app, VALID.code, { price: '1.00' }, token),
        await deleteSku(app, VALID.code, token),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
      }

      expect(await allRows()).toHaveLength(1);
      expect((await rowOf(VALID.code))?.deletedAt).toBeNull();
    });
  });

  /* ── Create ────────────────────────────────────────────────────────────── */

  describe('create', () => {
    it('creates a SKU under a product and returns 201', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await createSku(app, VALID, token);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['sku']);
      expect(Object.keys(response.body.sku).sort()).toEqual([
        'code',
        'createdAt',
        'id',
        'isActive',
        'name',
        // Increment 25. Still an EXACT key set, not a superset check: the point of this
        // assertion is that a column added later cannot reach the wire unnoticed.
        'options',
        'price',
        'productId',
        'updatedAt',
      ]);
      expect(response.body.sku.code).toBe(VALID.code);
      expect(response.body.sku.name).toBe('Medium');
      expect(response.body.sku.isActive).toBe(true);
      // A newly created SKU has no combination, and that is a legal state.
      expect(response.body.sku.options).toEqual([]);
    });

    it('normalises the price to the storage scale', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await createSku(app, { ...VALID, price: '19.9' }, token);

      /**
       * `19.9` and `19.9000` must not become two rows that compare unequal as text. The
       * service runs the validated string through `money()` and `toDb()`, so the column
       * always holds one canonical form — and the RESPONSE reports the persisted value, not
       * an echo of the request. This assertion is the only place that distinction is visible.
       */
      expect(response.body.sku.price).toBe('19.9000');
      expect((await rowOf(VALID.code))?.price).toBe('19.9000');
    });

    it('defaults name to empty and isActive to true', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await createSku(app, { code: 'MINIMAL-1', price: '5.00' }, token);

      expect(response.status).toBe(201);
      const row = await rowOf('MINIMAL-1');
      expect(row?.name).toBe('');
      // Sellable by default: the product's own status already governs customer visibility, so
      // a second activation step would be a publish flow nobody asked for.
      expect(row?.isActive).toBe(true);
    });

    it('honours an explicit isActive: false', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      await createSku(app, { ...VALID, isActive: false }, token);

      expect((await rowOf(VALID.code))?.isActive).toBe(false);
    });

    it('persists the store from the PRODUCT row and the resolved store', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      await createSku(app, VALID, token);

      const row = await rowOf(VALID.code);
      expect(row?.storeId).toBe(storeId);
      expect(row?.productId).toBe(created.id);
    });

    it('rejects a duplicate code in the same store with 409', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      const response = await createSku(app, VALID, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SKU_CODE_TAKEN');
      // The code is not echoed back — no reflection surface.
      expect(JSON.stringify(response.body)).not.toContain(VALID.code);
      expect(await allRows()).toHaveLength(1);
    });

    it('enforces uniqueness at the DATABASE, not only in the pre-check', async () => {
      const created = await givenProduct();
      const { catalogue } = build();
      const actor = { type: 'staff', userId: (await seedStaffUser()).id } as const;

      /**
       * Two concurrent creates both pass the pre-check and race to the insert; the partial
       * unique index is what actually decides. Driven through the SERVICE rather than HTTP so
       * both calls genuinely overlap, and asserted as one success plus one 409 — never two
       * rows.
       */
      const results = await Promise.allSettled([
        catalogue.createSku({
          storeId,
          productSlug: created.slug,
          currency: 'INR',
          actor,
          input: { code: 'RACER-1', price: '10.00' },
        }),
        catalogue.createSku({
          storeId,
          productSlug: created.slug,
          currency: 'INR',
          actor,
          input: { code: 'RACER-1', price: '10.00' },
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await allRows()).toHaveLength(1);
    });

    it('allows the SAME code in a different store', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'second', name: 'Second', isActive: true });
      const foreignProduct = await givenProduct({ slug: 'their-shirt', storeId: otherStoreId });
      await giveSku(db(), foreignProduct, { code: VALID.code });

      /**
       * Leading with `store_id` in the unique index is what makes the catalogue genuinely
       * multi-tenant. A global index on `code` would let the first merchant to use
       * `SHIRT-BLUE-M` block every other merchant on the platform from ever using it.
       */
      expect(await allRows()).toHaveLength(2);
    });

    it('treats codes as case-SENSITIVE', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'ABC-1' });
      const { app, token } = await staffApp();

      const response = await createSku(app, { code: 'abc-1', price: '1.00' }, token);

      /**
       * Unlike a slug or an email, a merchant code is an identifier that already exists on
       * their own paperwork, where `ABC-1` and `abc-1` may be two different things.
       * Normalising case would silently merge them.
       */
      expect(response.status).toBe(201);
      expect(await allRows()).toHaveLength(2);
    });

    it('rejects invalid prices, including JSON numbers', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      for (const price of ['abc', '-1.00', '1.000005', '', '1e5', '1,000.00', null, 1499.0]) {
        const response = await createSku(app, { code: 'P-1', price }, token);
        expect(response.status, JSON.stringify(price)).toBe(400);
      }

      expect(await allRows()).toEqual([]);
    });

    it('rejects malformed codes', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      for (const code of ['', ' ', '-leading', 'has space', 'x'.repeat(65), 'ünicode']) {
        const response = await createSku(app, { code, price: '1.00' }, token);
        expect(response.status, JSON.stringify(code)).toBe(400);
      }

      expect(await allRows()).toEqual([]);
    });

    it('rejects unknown and privileged body fields', async () => {
      const created = await givenProduct();
      const { app, token, userId } = await staffApp();

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'third', name: 'Third', isActive: true });

      /**
       * `strictObject`. Each of these is either a probe for a tenancy hole or a badly confused
       * client, and both deserve to be told rather than silently ignored.
       */
      for (const extra of [
        { storeId: otherStoreId },
        { productId: newId() },
        { id: newId() },
        { actorUserId: userId },
        { deletedAt: new Date().toISOString() },
        { createdAt: new Date().toISOString() },
        { taxClassId: newId() },
        { hsnCode: '6205' },
      ]) {
        const response = await createSku(app, { ...VALID, ...extra }, token);
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }

      expect(await allRows()).toEqual([]);
      // And the product is still where it was.
      expect(
        (await db().select().from(product).where(eq(product.id, created.id)))[0]?.storeId,
      ).toBe(storeId);
    });

    it('404s for an unknown product slug', async () => {
      const { app, token } = await staffApp();

      const response = await createSku(app, VALID, token, 'never-existed');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(await allRows()).toEqual([]);
    });

    it('404s for a DELETED product', async () => {
      await givenProduct({ deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await createSku(app, VALID, token);

      /**
       * A deleted product must not acquire new sellable units. Absent, deleted, and another
       * store's all collapse to the same 404 (§25) — a distinct "deleted" would tell a caller
       * which slugs had once existed.
       */
      expect(response.status).toBe(404);
      expect(await allRows()).toEqual([]);
    });

    it('404s for another STORE’s product', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'fourth', name: 'Fourth', isActive: true });
      await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const { app, token } = await staffApp();

      const response = await createSku(app, VALID, token, 'theirs');

      expect(response.status).toBe(404);
      expect(await allRows()).toEqual([]);
    });
  });

  /* ── List ──────────────────────────────────────────────────────────────── */

  describe('list', () => {
    it('returns active AND inactive SKUs, ordered by code', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'B-2', isActive: false });
      await giveSku(db(), created, { code: 'A-1' });
      const { app, token } = await staffApp();

      const response = await listSkus(app, token);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(['skus']);
      // A merchant manages both; only the storefront filters on active.
      expect(codesOf(response.body)).toEqual(['A-1', 'B-2']);
    });

    it('excludes deleted SKUs and other products’ SKUs', async () => {
      const created = await givenProduct();
      const other = await givenProduct({ slug: 'other-shirt' });
      await giveSku(db(), created, { code: 'KEEP-1' });
      await giveSku(db(), created, { code: 'GONE-1', deletedAt: new Date() });
      await giveSku(db(), other, { code: 'ELSEWHERE-1' });
      const { app, token } = await staffApp();

      const response = await listSkus(app, token);

      expect(codesOf(response.body)).toEqual(['KEEP-1']);
    });

    it('404s for an unknown slug rather than returning an empty list', async () => {
      const { app, token } = await staffApp();

      const response = await listSkus(app, token, 'never-existed');

      /**
       * An empty array and a mistyped slug mean different things to a merchant, and an empty
       * array for a typo is the kind of answer that sends someone looking for missing data.
       */
      expect(response.status).toBe(404);
    });
  });

  /* ── Update ────────────────────────────────────────────────────────────── */

  describe('update', () => {
    it('updates name, price and isActive', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, price: '10.0000' });
      const { app, token } = await staffApp();

      const response = await patchSku(
        app,
        VALID.code,
        { name: 'Large', price: '25.5', isActive: false },
        token,
      );

      expect(response.status).toBe(200);
      expect(response.body.sku.name).toBe('Large');
      // Persisted, not echoed: '25.5' became '25.5000'.
      expect(response.body.sku.price).toBe('25.5000');
      expect(response.body.sku.isActive).toBe(false);

      const row = await rowOf(VALID.code);
      expect(row?.name).toBe('Large');
      expect(row?.price).toBe('25.5000');
      expect(row?.isActive).toBe(false);
    });

    it('deactivates and reactivates', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      await patchSku(app, VALID.code, { isActive: false }, token);
      expect((await rowOf(VALID.code))?.isActive).toBe(false);

      /**
       * Both directions, through an ordinary PATCH field rather than a pair of actions. Both
       * transitions are always legal, so there is no state machine to enforce — which is
       * exactly why §26 made product status an explicit action and this is not.
       */
      await patchSku(app, VALID.code, { isActive: true }, token);
      expect((await rowOf(VALID.code))?.isActive).toBe(true);
    });

    it('preserves the fields it was not asked to change', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, name: 'Medium', price: '10.0000' });
      const { app, token } = await staffApp();

      await patchSku(app, VALID.code, { price: '99.99' }, token);

      const row = await rowOf(VALID.code);
      expect(row?.name).toBe('Medium');
      expect(row?.isActive).toBe(true);
      expect(row?.code).toBe(VALID.code);
    });

    it('edits ONLY the addressed SKU, leaving siblings untouched', async () => {
      const created = await givenProduct();
      const other = await givenProduct({ slug: 'other-shirt' });
      await giveSku(db(), created, { code: 'TARGET-1', price: '10.0000' });
      await giveSku(db(), created, { code: 'SIBLING-1', price: '10.0000' });
      await giveSku(db(), other, { code: 'STRANGER-1', price: '10.0000' });
      const { app, token } = await staffApp();

      const response = await patchSku(app, 'TARGET-1', { price: '77.00' }, token);

      /**
       * The §29 blast-radius test, applied to SKUs. Removing `code` from the UPDATE predicate
       * would rewrite every SKU the store owns — and would pass a suite that only ever kept
       * one row, which is how that mutation survived once before.
       */
      expect(response.status).toBe(200);
      expect((await rowOf('TARGET-1'))?.price).toBe('77.0000');
      expect((await rowOf('SIBLING-1'))?.price).toBe('10.0000');
      expect((await rowOf('STRANGER-1'))?.price).toBe('10.0000');
    });

    it('rejects an empty body and unknown or privileged fields', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, price: '10.0000' });
      const { app, token } = await staffApp();
      const before = await rowOf(VALID.code);

      for (const body of [
        {},
        { code: 'RENAMED-1' },
        { storeId: newId() },
        { productId: newId() },
        { id: newId() },
        { deletedAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { taxClassId: newId() },
        { isActive: 'yes' },
        { price: 25.5 },
      ]) {
        const response = await patchSku(app, VALID.code, body, token);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }

      // Nothing moved across all of those attempts.
      expect(await rowOf(VALID.code)).toEqual(before);
    });

    it('404s for an unknown, deleted, or foreign code', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'DELETED-1', deletedAt: new Date() });

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'fifth', name: 'Fifth', isActive: true });
      const foreign = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      await giveSku(db(), foreign, { code: 'FOREIGN-1' });

      const { app, token } = await staffApp();

      // One 404 for all three, decided by the update's own predicate.
      for (const code of ['NEVER-1', 'DELETED-1', 'FOREIGN-1']) {
        const response = await patchSku(app, code, { price: '1.00' }, token);
        expect(response.status, code).toBe(404);
      }

      // The other store's SKU is untouched.
      expect((await rowOf('FOREIGN-1', otherStoreId))?.price).toBe('10.0000');
    });
  });

  /* ── Delete ────────────────────────────────────────────────────────────── */

  describe('delete', () => {
    it('soft-deletes and returns 204', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      const response = await deleteSku(app, VALID.code, token);

      expect(response.status).toBe(204);
      const row = await rowOf(VALID.code);
      // The row SURVIVES: order lines will reference SKUs, and a hard delete would break them.
      expect(row).toBeDefined();
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(row?.createdAt.getTime() ?? 0);
    });

    it('is 404 on a repeat delete', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      expect((await deleteSku(app, VALID.code, token)).status).toBe(204);
      const first = await rowOf(VALID.code);

      /**
       * 404, matching `DELETE /admin/products/:slug`. A `PATCH` on a deleted SKU answers 404,
       * so a `DELETE` answering 204 would contradict the very next request about the code.
       */
      expect((await deleteSku(app, VALID.code, token)).status).toBe(404);
      // And the original deletion time is not re-stamped.
      expect((await rowOf(VALID.code))?.deletedAt).toEqual(first?.deletedAt);
    });

    it('frees the code for reuse', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, price: '10.0000' });
      const { app, token } = await staffApp();

      await deleteSku(app, VALID.code, token);
      const recreated = await createSku(app, { ...VALID, price: '55.00' }, token);

      /**
       * `uq_sku_code_active` is partial on `deleted_at IS NULL`, so a deleted SKU no longer
       * reserves its code. A merchant who deletes a mistake expects to be able to recreate it.
       */
      expect(recreated.status).toBe(201);
      expect(recreated.body.sku.price).toBe('55.0000');
      // Both rows exist; only the new one is live.
      expect(await allRows()).toHaveLength(2);
    });

    it('deletes ONLY the addressed SKU', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'TARGET-1' });
      await giveSku(db(), created, { code: 'SIBLING-1' });
      const { app, token } = await staffApp();

      await deleteSku(app, 'TARGET-1', token);

      expect((await rowOf('TARGET-1'))?.deletedAt).not.toBeNull();
      expect((await rowOf('SIBLING-1'))?.deletedAt).toBeNull();
    });
  });

  /* ── Product deletion cascade ──────────────────────────────────────────── */

  describe('product deletion cascade', () => {
    it('soft-deletes every SKU of the product', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'A-1', deletedAt: null });
      await giveSku(db(), created, { code: 'B-2', isActive: false, deletedAt: null });
      const { app, token } = await staffApp();

      const response = await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(204);

      /**
       * The invariant: no SKU may remain apparently sellable under a deleted product. The SKU
       * routes address a SKU by code ALONE, so a surviving row would still be reachable and
       * still look live.
       */
      for (const code of ['A-1', 'B-2']) {
        const row = await rowOf(code);
        expect(row?.deletedAt, code).not.toBeNull();
      }
    });

    it('leaves ANOTHER product’s SKUs alone', async () => {
      const created = await givenProduct();
      const other = await givenProduct({ slug: 'other-shirt' });
      await giveSku(db(), created, { code: 'DOOMED-1', deletedAt: null });
      await giveSku(db(), other, { code: 'SURVIVOR-1', deletedAt: null });
      const { app, token } = await staffApp();

      await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);

      expect((await rowOf('DOOMED-1'))?.deletedAt).not.toBeNull();
      // Without `product_id` in the cascade predicate this would go too.
      expect((await rowOf('SURVIVOR-1'))?.deletedAt).toBeNull();
    });

    it('does not re-stamp a SKU already deleted', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'ALREADY-1', deletedAt: new Date(2020, 0, 1) });
      await giveSku(db(), created, { code: 'LIVE-1', deletedAt: null });
      const { app, token } = await staffApp();

      await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);

      // `deleted_at IS NULL` in the cascade preserves the original deletion time.
      expect((await rowOf('ALREADY-1'))?.deletedAt).toEqual(new Date(2020, 0, 1));
      expect((await rowOf('LIVE-1'))?.deletedAt).not.toBeNull();
    });

    it('is ATOMIC — a failure rolls back both the product and its SKUs', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'A-1', deletedAt: null });
      const { catalogue } = build();

      /**
       * The rollback is provoked by an actor whose user does not exist: `audit_log.actor_user_id`
       * is a foreign key, so the audit insert fails AFTER both the product and the SKU have
       * been updated inside the transaction.
       *
       * That is the only assertion that proves the cascade shares the product's transaction.
       * With two separate transactions, the product would stay deleted and the SKU would not.
       */
      await expect(
        catalogue.deleteProduct({
          storeId,
          slug: SLUG,
          actor: { type: 'staff', userId: newId() },
        }),
      ).rejects.toThrow();

      const [productRow] = await db().select().from(product).where(eq(product.id, created.id));
      expect(productRow?.deletedAt).toBeNull();
      expect((await rowOf('A-1'))?.deletedAt).toBeNull();
      expect(await eventsFor('product')).toEqual([]);
      expect(await auditFor('product')).toEqual([]);
    });
  });

  /* ── Public visibility ─────────────────────────────────────────────────── */

  describe('public visibility', () => {
    const publicGet = (app: App, slug = SLUG) => request(app).get(`/api/v1/products/${slug}`);
    const publicList = (app: App, query = '') => request(app).get(`/api/v1/products${query}`);

    it('requires an ACTIVE SKU for a product to be publicly visible', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'INACTIVE-1', isActive: false, deletedAt: null });
      const { app } = build();

      /**
       * A published product with nothing sellable is not publicly readable. It collapses into
       * the SAME 404 as an unknown slug or a draft (§25), and the listing simply omits it —
       * a storefront must never render a product page with no purchasable SKU on it.
       */
      expect((await publicGet(app)).status).toBe(404);
      const list = await publicList(app);
      expect(list.body.products).toEqual([]);
      expect(list.body.pagination.total).toBe(0);
    });

    it('excludes a product whose only SKU is DELETED', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'GONE-1', deletedAt: new Date() });
      const { app } = build();

      expect((await publicGet(app)).status).toBe(404);
      expect((await publicList(app)).body.pagination.total).toBe(0);
    });

    it('excludes a product with NO SKUs at all', async () => {
      await givenProduct();
      const { app } = build();

      expect((await publicGet(app)).status).toBe(404);
      expect((await publicList(app)).body.pagination.total).toBe(0);
    });

    it('includes a product with one active SKU, exactly once', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'LIVE-1', price: '10.0000', deletedAt: null });
      const { app } = build();

      expect((await publicGet(app)).status).toBe(200);
      const list = await publicList(app);
      expect(list.body.products).toHaveLength(1);
      expect(list.body.pagination.total).toBe(1);
    });

    it('does NOT duplicate a product with several active SKUs', async () => {
      const created = await givenProduct();
      for (const code of ['A-1', 'B-2', 'C-3']) {
        await giveSku(db(), created, { code, price: '10.0000', deletedAt: null });
      }
      const { app } = build();

      const list = await publicList(app);

      /**
       * The reason the predicate is an `EXISTS` and not a join. A join multiplies the product
       * row by its matching SKUs: measured during the design review, a band matching two SKUs
       * on each of three products returned SIX rows through a join and three through `EXISTS`.
       * That corrupts the page, `pagination.total`, and pagination determinism at once.
       */
      expect(list.body.products).toHaveLength(1);
      expect(list.body.pagination.total).toBe(1);
      expect(list.body.products[0].skus).toHaveLength(3);
    });

    it('shows only ACTIVE SKUs to the public, but all of them to staff', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'LIVE-1', deletedAt: null });
      await giveSku(db(), created, { code: 'HIDDEN-1', isActive: false, deletedAt: null });
      const { app, token } = await staffApp();

      const publicResponse = await publicGet(app);
      expect(productSkuCodes(publicResponse.body)).toEqual(['LIVE-1']);

      const adminResponse = await request(app)
        .get(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);
      expect(productSkuCodes(adminResponse.body)).toEqual(['HIDDEN-1', 'LIVE-1']);
    });

    it('disappears from the storefront when its last SKU is deactivated', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'ONLY-1', deletedAt: null });
      const { app, token } = await staffApp();

      expect((await publicGet(app)).status).toBe(200);

      await patchSku(app, 'ONLY-1', { isActive: false }, token);

      /**
       * The consequence of design (a) in the review: deactivating the last SKU hides the
       * product rather than being refused. Asserted so the behaviour is a decision on record
       * rather than a surprise — the product is still there for staff, and republishing is a
       * reactivation away.
       */
      expect((await publicGet(app)).status).toBe(404);
      expect(
        (
          await request(app)
            .get(`/api/v1/admin/products/${SLUG}`)
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(200);
    });
  });

  /* ── Public price filter ───────────────────────────────────────────────── */

  describe('public price filter', () => {
    const publicList = (app: App, query = '') => request(app).get(`/api/v1/products${query}`);

    it('matches when ANY active SKU is in the band', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'CHEAP-1', price: '100.0000', deletedAt: null });
      await giveSku(db(), created, { code: 'MID-1', price: '1500.0000', deletedAt: null });
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      expect(response.body.products).toHaveLength(1);
      expect(response.body.pagination.total).toBe(1);
    });

    it('returns a product with SEVERAL matching SKUs exactly once', async () => {
      const created = await givenProduct();
      for (const price of ['1100.0000', '1500.0000', '1900.0000']) {
        await giveSku(db(), created, { code: `SKU-${price}`, price, deletedAt: null });
      }
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      // Three matching SKUs, one product. A join would return three rows and a total of 3.
      expect(response.body.products).toHaveLength(1);
      expect(response.body.pagination.total).toBe(1);
    });

    it('does NOT match when the only in-band SKU is inactive', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'OUT-1', price: '9000.0000', deletedAt: null });
      await giveSku(db(), created, {
        code: 'IN-BUT-OFF',
        price: '1500.0000',
        isActive: false,
        deletedAt: null,
      });
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      expect(response.body.pagination.total).toBe(0);
    });

    it('does NOT match when the only in-band SKU is deleted', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'OUT-1', price: '9000.0000', deletedAt: null });
      await giveSku(db(), created, {
        code: 'IN-BUT-GONE',
        price: '1500.0000',
        deletedAt: new Date(),
      });
      const { app } = build();

      expect((await publicList(app, '?price_min=1000&price_max=2000')).body.pagination.total).toBe(
        0,
      );
    });

    it('requires ONE SKU to satisfy BOTH bounds', async () => {
      const created = await givenProduct();
      // Cheap and expensive, nothing in between.
      await giveSku(db(), created, { code: 'CHEAP-1', price: '10.0000', deletedAt: null });
      await giveSku(db(), created, { code: 'DEAR-1', price: '9000.0000', deletedAt: null });
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      /**
       * Both bounds live in ONE subquery. Two separate `EXISTS` clauses would each be
       * satisfied — the cheap SKU passes `<= 2000`, the dear one passes `>= 1000` — and the
       * product would match a band it has nothing in.
       */
      expect(response.body.pagination.total).toBe(0);
    });

    it('keeps page and COUNT in agreement under a price filter', async () => {
      for (const n of [1, 2, 3, 4, 5]) {
        const created = await givenProduct({ slug: `product-${String(n)}` });
        // Two matching SKUs each: a join would report a total of 10.
        await giveSku(db(), created, {
          code: `A-${String(n)}`,
          price: '1100.0000',
          deletedAt: null,
        });
        await giveSku(db(), created, {
          code: `B-${String(n)}`,
          price: '1900.0000',
          deletedAt: null,
        });
      }
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000&limit=2');

      expect(response.body.products).toHaveLength(2);
      expect(response.body.pagination.total).toBe(5);
    });

    it('composes with the q search term', async () => {
      const shirt = await givenProduct({ slug: 'blue-shirt' });
      const boots = await givenProduct({ slug: 'leather-boots' });
      await db().update(product).set({ name: 'Blue Shirt' }).where(eq(product.id, shirt.id));
      await db().update(product).set({ name: 'Leather Boots' }).where(eq(product.id, boots.id));
      await giveSku(db(), shirt, { code: 'SH-1', price: '1500.0000', deletedAt: null });
      await giveSku(db(), boots, { code: 'BO-1', price: '1500.0000', deletedAt: null });
      const { app } = build();

      const response = await publicList(app, '?q=shirt&price_min=1000&price_max=2000');

      expect(response.body.products).toHaveLength(1);
      expect(response.body.products[0].slug).toBe('blue-shirt');
    });

    it('excludes another store’s SKUs from the match', async () => {
      const created = await givenProduct();
      // A SKU row in the right price band but belonging to another store's product.
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'sixth', name: 'Sixth', isActive: true });
      const foreign = await givenProduct({ slug: 'their-shirt', storeId: otherStoreId });
      await giveSku(db(), foreign, { code: 'THEIRS-1', price: '1500.0000', deletedAt: null });
      // Our product's own SKU is OUT of band.
      await giveSku(db(), created, { code: 'OURS-1', price: '9000.0000', deletedAt: null });
      const { app } = build();

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      // Ours does not match, and theirs is not ours to return.
      expect(response.body.pagination.total).toBe(0);
    });

    it('ignores a SKU row whose store disagrees with its product', async () => {
      const created = await givenProduct();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'eighth', name: 'Eighth', isActive: true });

      /**
       * A CORRUPT row: our product, but stamped with another store's id.
       *
       * Nothing in the application can create this — the service takes `store_id` from the
       * product row rather than from its argument — so it can only arise from direct SQL, a
       * bad import, or a future bug. That is exactly what makes the `store_id` predicate
       * inside the `EXISTS` worth stating: `product_id` already implies the store, so without
       * a row like this the predicate is unreachable and a mutation removing it survives.
       *
       * Written directly for that reason, and asserted from both sides: the corrupt SKU must
       * not make our product visible, and it must not make the other store's listing show a
       * product it does not own.
       */
      await db().insert(sku).values({
        id: newId(),
        storeId: otherStoreId,
        productId: created.id,
        code: 'MISMATCHED-1',
        name: '',
        price: '1500.0000',
        isActive: true,
      });

      const { app } = build();

      expect((await publicList(app, '?price_min=1000&price_max=2000')).body.pagination.total).toBe(
        0,
      );
      // And it does not satisfy plain visibility either.
      expect((await publicList(app)).body.pagination.total).toBe(0);
      expect((await request(app).get(`/api/v1/products/${SLUG}`)).status).toBe(404);
    });
  });

  /* ── Events and audit ──────────────────────────────────────────────────── */

  describe('events and audit', () => {
    it('records sku.created with the authenticated actor and store', async () => {
      await givenProduct();
      const { app, token, userId } = await staffApp();

      const response = await createSku(app, VALID, token);
      const skuId = response.body.sku.id as string;

      const events = await eventsFor('sku');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe('sku.created');
      expect(events[0]?.aggregateId).toBe(skuId);
      expect(events[0]?.storeId).toBe(storeId);
      const payload = events[0]?.payload as Record<string, unknown>;
      // Ids and facts. Price is carried because a pricing consumer cannot act on a bare id.
      expect(payload['code']).toBe(VALID.code);
      expect(payload['price']).toBe('1499.0000');

      const audit = await auditFor('sku');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('sku.created');
      expect(audit[0]?.actorType).toBe('staff');
      // From the verified token, never the body.
      expect(audit[0]?.actorUserId).toBe(userId);
      expect(audit[0]?.storeId).toBe(storeId);
    });

    it('records a price change and an activation change separately', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, price: '10.0000' });
      const { app, token } = await staffApp();

      await patchSku(app, VALID.code, { price: '25.00', isActive: false }, token);

      const actions = (await auditFor('sku')).map((r) => r.action).sort();
      /**
       * Three entries for one PATCH, deliberately. `sku.updated` records that an edit
       * happened; the other two are the edits an auditor searches for by name — one moves
       * money, the other decides whether the thing can be sold at all.
       */
      expect(actions).toEqual(['sku.activation_changed', 'sku.price_changed', 'sku.updated']);
    });

    it('records sku.deleted with the code, which is freed for reuse', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code, price: '10.0000' });
      const { app, token } = await staffApp();

      await deleteSku(app, VALID.code, token);

      const events = (await eventsFor('sku')).filter((r) => r.eventName === 'sku.deleted');
      expect(events).toHaveLength(1);

      const audit = (await auditFor('sku')).filter((r) => r.action === 'sku.deleted');
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      // The code is released by the partial index, so the id alone will not identify this SKU
      // to an auditor once another claims it.
      expect(metadata['code']).toBe(VALID.code);
    });

    it('records the cascaded codes on a product deletion', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'A-1', deletedAt: null });
      await giveSku(db(), created, { code: 'B-2', deletedAt: null });
      const { app, token } = await staffApp();

      await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);

      const audit = (await auditFor('product')).filter((r) => r.action === 'product.deleted');
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      // What went with the product, not merely that something did.
      expect(metadata['cascadedSkuCodes']).toEqual(['A-1', 'B-2']);
    });

    it('records NOTHING when a create is rejected', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      expect((await createSku(app, VALID, token)).status).toBe(409);

      // A rejected create must not leave an event claiming a SKU exists.
      expect(await eventsFor('sku')).toEqual([]);
      expect(await auditFor('sku')).toEqual([]);
    });

    it('takes the actor from the token even when the body claims another user', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const built = await staffApp();
      const { app, token, userId } = built;
      // A real second user, so a forged id would satisfy the audit FK and would persist.
      const victim = await signIn(app, built.identity, { email: 'victim@example.com' });

      /**
       * DELETE validates params ONLY — it has no body schema, because it has no body to
       * describe. That makes it the one SKU route where an unexpected JSON body reaches
       * `req.body` unvalidated, and therefore the only route where reading the actor from
       * the body instead of the verified token would actually succeed. Asserted here rather
       * than left to the strict schemas, which do not cover this route.
       */
      const response = await deleteSku(app, VALID.code, token).send({
        actorUserId: victim.userId,
      });
      expect(response.status).toBe(204);

      const audit = await auditFor('sku');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(userId);
      expect(audit[0]?.actorUserId).not.toBe(victim.userId);
    });

    it('rejects a body-supplied actor on the routes that do have a schema', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: VALID.code });
      const { app, token } = await staffApp();

      // The strict schemas name every writable field, so an actor is an unknown key.
      const patched = await patchSku(
        app,
        VALID.code,
        { price: '1.00', actorUserId: newId() },
        token,
      );
      expect(patched.status).toBe(400);
      expect(
        (await createSku(app, { ...VALID, code: 'OTHER-1', actorUserId: newId() }, token)).status,
      ).toBe(400);
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /** Assert a write was refused by a NAMED constraint; Drizzle wraps the driver error. */
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

    it('refuses a negative price', async () => {
      const created = await givenProduct();

      /**
       * The API is not the only writer — a bulk import or an operator running SQL during an
       * incident bypasses Zod entirely, and a negative price would flow into a cart total and
       * then an invoice as a credit nobody authorised.
       */
      await expectConstraint(
        db().insert(sku).values({
          id: newId(),
          storeId,
          productId: created.id,
          code: 'NEG-1',
          name: '',
          price: '-0.0001',
          isActive: true,
        }),
        'ck_sku_price_non_negative',
      );
    });

    it('refuses a SKU whose product does not exist', async () => {
      await expectConstraint(
        db().insert(sku).values({
          id: newId(),
          storeId,
          productId: newId(),
          code: 'ORPHAN-1',
          name: '',
          price: '1.0000',
          isActive: true,
        }),
        'sku_product_id_product_id_fk',
      );
    });

    it('refuses a duplicate live code in one store', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'DUP-1' });

      await expectConstraint(
        db().insert(sku).values({
          id: newId(),
          storeId,
          productId: created.id,
          code: 'DUP-1',
          name: '',
          price: '1.0000',
          isActive: true,
        }),
        'uq_sku_code_active',
      );
    });

    it('ALLOWS two stores to use the same code', async () => {
      /**
       * The other half of the uniqueness contract, and the half a duplicate-rejection test
       * cannot prove. `uq_sku_code_active` leads with `store_id`; a global unique index on
       * `code` alone would still reject the duplicate above, so only this assertion
       * distinguishes the two — and a global index would let the first merchant to use
       * `SHIRT-1` block every other merchant on the platform from ever using it.
       */
      const mine = await givenProduct();
      await giveSku(db(), mine, { code: 'SHARED-1' });

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'ninth', name: 'Ninth', isActive: true });
      const theirs = await givenProduct({ slug: 'their-shirt', storeId: otherStoreId });

      await db().insert(sku).values({
        id: newId(),
        storeId: otherStoreId,
        productId: theirs.id,
        code: 'SHARED-1',
        name: '',
        price: '1.0000',
        isActive: true,
      });

      const rows = (await allRows()).filter((r) => r.code === 'SHARED-1');
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.storeId))).toEqual(new Set([storeId, otherStoreId]));
    });

    it('refuses a hard DELETE of a product that still has SKUs', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'ATTACHED-1' });

      /**
       * `ON DELETE RESTRICT`, not `CASCADE`. Products are soft-deleted, so a hard delete is
       * either an operator mistake or a bug — and silently taking sellable rows with it is
       * strictly worse than failing.
       */
      await expectConstraint(
        db().delete(product).where(eq(product.id, created.id)),
        'sku_product_id_product_id_fk',
      );
    });
  });

  /* ── Repository-level store isolation ──────────────────────────────────── */

  describe('repository store isolation', () => {
    it('scopes findSkuByCode, update and delete by store', async () => {
      const { repository } = build();

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'seventh', name: 'Seventh', isActive: true });
      const ours = await givenProduct();
      const theirs = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      await giveSku(db(), ours, { code: 'SHARED-1', price: '10.0000' });
      await giveSku(db(), theirs, { code: 'SHARED-1', price: '20.0000' });

      /**
       * Called directly, bypassing every middleware. If the store predicate lived only in the
       * service or the route, these would cross the boundary — and any future caller reaching
       * the repository another way (a CLI command, an import job) would leak.
       */
      expect((await repository.findSkuByCode({ storeId, code: 'SHARED-1' }))?.price).toBe(
        '10.0000',
      );
      expect(
        (await repository.findSkuByCode({ storeId: otherStoreId, code: 'SHARED-1' }))?.price,
      ).toBe('20.0000');

      await repository.updateSkuFields({
        storeId,
        code: 'SHARED-1',
        fields: { price: '77.0000' },
        at: new Date(),
      });
      expect((await rowOf('SHARED-1', storeId))?.price).toBe('77.0000');
      // The other store's identically-coded SKU is untouched.
      expect((await rowOf('SHARED-1', otherStoreId))?.price).toBe('20.0000');

      await repository.softDeleteSku({ storeId, code: 'SHARED-1', at: new Date() });
      expect((await rowOf('SHARED-1', storeId))?.deletedAt).not.toBeNull();
      expect((await rowOf('SHARED-1', otherStoreId))?.deletedAt).toBeNull();
    });

    it('scopes the batch loader by store and by active flag', async () => {
      const { repository } = build();
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'ON-1', deletedAt: null });
      await giveSku(db(), created, { code: 'OFF-1', isActive: false, deletedAt: null });

      const all = await repository.listSkusForProducts({
        storeId,
        productIds: [created.id],
        activeOnly: false,
      });
      expect(all.map((s) => s.code)).toEqual(['OFF-1', 'ON-1']);

      const activeOnly = await repository.listSkusForProducts({
        storeId,
        productIds: [created.id],
        activeOnly: true,
      });
      expect(activeOnly.map((s) => s.code)).toEqual(['ON-1']);

      // An empty id list must not become "everything".
      expect(
        await repository.listSkusForProducts({ storeId, productIds: [], activeOnly: false }),
      ).toEqual([]);
    });
  });

  /* ── Helpers that need a real user for the audit FK ────────────────────── */

  async function seedStaffUser(): Promise<{ id: string }> {
    const { identity } = build();
    const user = await identity.registerCustomer({
      storeId,
      input: {
        email: `staff-${newId().slice(-8)}@example.com`,
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    return { id: user.id };
  }
});
