import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  product,
  productOption,
  productOptionValue,
  sku,
  skuOptionValue,
} from '../../../db/schema/catalogue.js';
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
import { buildOptionSignature, createCatalogueService } from '../catalogue.service.js';

/**
 * Variant options and SKU combinations — against real PostgreSQL.
 *
 * Four properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **The DATABASE enforces the graph, not the application.** Cross-product and cross-store
 *     corruption is rejected by composite foreign keys. Those are asserted by named constraint
 *     from DIRECT SQL, because a test that only speaks HTTP cannot tell an application check
 *     from a database one — and if the application check were removed tomorrow, only the
 *     direct-SQL test would still fail.
 *
 *  2. **The signature and the junction rows can never disagree.** They are written in one
 *     transaction. Proven by provoking a real rollback, not by trusting the code shape.
 *
 *  3. **Duplicate combinations are impossible, not merely unlikely.** The unique index is the
 *     arbiter; the pre-check is a courtesy. Asserted under genuine concurrency.
 *
 *  4. **Retiring an option cannot orphan a live SKU's combination.** Refused with the blocking
 *     codes named, which is what keeps every stored signature meaningful.
 */
describe('variant options (integration)', () => {
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

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

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

  /** An option row written directly, for tests that are not exercising the create endpoint. */
  async function giveOption(
    parent: { id: string; storeId: string },
    overrides: { name?: string; sortOrder?: number; deletedAt?: Date | null } = {},
  ) {
    const values = {
      id: newId(),
      storeId: parent.storeId,
      productId: parent.id,
      name: overrides.name ?? 'Size',
      sortOrder: overrides.sortOrder ?? 0,
      deletedAt: overrides.deletedAt ?? null,
    };
    await db().insert(productOption).values(values);
    return values;
  }

  async function giveValue(
    option: { id: string; storeId: string; productId: string },
    overrides: { value?: string; sortOrder?: number; deletedAt?: Date | null } = {},
  ) {
    const values = {
      id: newId(),
      storeId: option.storeId,
      optionId: option.id,
      // From the OPTION, exactly as the service does — half of `fk_pov_option_product`.
      productId: option.productId,
      value: overrides.value ?? 'Medium',
      sortOrder: overrides.sortOrder ?? 0,
      deletedAt: overrides.deletedAt ?? null,
    };
    await db().insert(productOptionValue).values(values);
    return values;
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const createOption = (app: App, body: unknown, token?: string, slug = SLUG) => {
    const req = request(app).post(`/api/v1/admin/products/${slug}/options`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const listOptions = (app: App, token?: string, slug = SLUG) => {
    const req = request(app).get(`/api/v1/admin/products/${slug}/options`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const patchOption = (app: App, id: string, body: unknown, token?: string) => {
    const req = request(app).patch(`/api/v1/admin/options/${id}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const deleteOption = (app: App, id: string, token?: string) => {
    const req = request(app).delete(`/api/v1/admin/options/${id}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const createValue = (app: App, optionId: string, body: unknown, token?: string) => {
    const req = request(app).post(`/api/v1/admin/options/${optionId}/values`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const patchValue = (app: App, id: string, body: unknown, token?: string) => {
    const req = request(app).patch(`/api/v1/admin/option-values/${id}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const deleteValue = (app: App, id: string, token?: string) => {
    const req = request(app).delete(`/api/v1/admin/option-values/${id}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const putSkuOptions = (app: App, code: string, ids: unknown, token?: string) => {
    const req = request(app).put(`/api/v1/admin/skus/${code}/options`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send({
      optionValueIds: ids,
    });
  };

  const publicList = (app: App, query = '') =>
    request(app).get(`/api/v1/products${query}`).set('Accept', 'application/json');

  /* ── Row readers ───────────────────────────────────────────────────────── */

  const signatureOf = async (code: string) => {
    const [row] = await db()
      .select({ signature: sku.optionSignature })
      .from(sku)
      .where(and(eq(sku.storeId, storeId), eq(sku.code, code)));
    return row?.signature;
  };

  const junctionFor = async (skuId: string) =>
    db().select().from(skuOptionValue).where(eq(skuOptionValue.skuId, skuId));

  const liveOptions = async () =>
    db().select().from(productOption).where(isNull(productOption.deletedAt));

  const liveValues = async () =>
    db().select().from(productOptionValue).where(isNull(productOptionValue.deletedAt));

  /**
   * Typed readers. Supertest hands back `any`, so calling `.map` on it directly trips
   * `no-unsafe-call` — the test override relaxes member ACCESS, not calls.
   */
  const optionNames = (body: { options: { name: string }[] }): string[] =>
    body.options.map((o) => o.name);

  const valueNames = (body: { options: { values: { value: string }[] }[] }): string[] =>
    body.options.flatMap((o) => o.values.map((v) => v.value));

  const skuOptionLabels = (body: { sku: { options: { optionName: string; value: string }[] } }) =>
    body.sku.options.map((o) => `${o.optionName}=${o.value}`);

  const eventsFor = async (aggregateType: string) =>
    (await db().select().from(outboxEvent)).filter((r) => r.aggregateType === aggregateType);

  const auditFor = async (resourceType: string) =>
    (await db().select().from(auditLog)).filter((r) => r.resourceType === resourceType);

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

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('rejects unauthenticated requests on every option route', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const value = await giveValue(option);
      await giveSku(db(), created, { code: 'S-1' });
      const { app } = build();

      for (const response of [
        await createOption(app, { name: 'Colour' }),
        await listOptions(app),
        await patchOption(app, option.id, { name: 'X' }),
        await deleteOption(app, option.id),
        await createValue(app, option.id, { value: 'Large' }),
        await patchValue(app, value.id, { value: 'X' }),
        await deleteValue(app, value.id),
        await putSkuOptions(app, 'S-1', [value.id]),
      ]) {
        expect(response.status).toBe(401);
      }
    });

    it('rejects a non-staff caller on every option route', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const value = await giveValue(option);
      await giveSku(db(), created, { code: 'S-1' });
      const built = build();
      const { token } = await signIn(built.app, built.identity);
      const { app } = built;

      for (const response of [
        await createOption(app, { name: 'Colour' }, token),
        await listOptions(app, token),
        await patchOption(app, option.id, { name: 'X' }, token),
        await deleteOption(app, option.id, token),
        await createValue(app, option.id, { value: 'Large' }, token),
        await patchValue(app, value.id, { value: 'X' }, token),
        await deleteValue(app, value.id, token),
        await putSkuOptions(app, 'S-1', [value.id], token),
      ]) {
        expect(response.status).toBe(403);
      }

      // Nothing was written by any rejected request.
      expect(await liveOptions()).toHaveLength(1);
      expect(await liveValues()).toHaveLength(1);
    });
  });

  /* ── Option CRUD ───────────────────────────────────────────────────────── */

  describe('option CRUD', () => {
    it('creates an option and returns 201 with an exact key set', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await createOption(app, { name: 'Size', sortOrder: 2 }, token);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['option']);
      expect(Object.keys(response.body.option).sort()).toEqual([
        'createdAt',
        'id',
        'name',
        'productId',
        'sortOrder',
        'updatedAt',
        'values',
      ]);
      // `storeId` and `deletedAt` must never appear — tenancy is not a client-visible field.
      expect(response.body.option.name).toBe('Size');
      expect(response.body.option.sortOrder).toBe(2);
      expect(response.body.option.values).toEqual([]);
    });

    it('defaults sortOrder to 0', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await createOption(app, { name: 'Size' }, token);

      expect(response.status).toBe(201);
      expect(response.body.option.sortOrder).toBe(0);
    });

    it('rejects a duplicate name in the same product', async () => {
      const created = await givenProduct();
      await giveOption(created, { name: 'Size' });
      const { app, token } = await staffApp();

      const response = await createOption(app, { name: 'Size' }, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OPTION_NAME_TAKEN');
    });

    it('rejects a duplicate name differing only in CASE', async () => {
      const created = await givenProduct();
      await giveOption(created, { name: 'Size' });
      const { app, token } = await staffApp();

      /**
       * The `lower(name)` unique index is the enforcement, in the migration — not application
       * lowercasing. "size" and "Size" are one option to every human who reads them, and
       * letting both exist would give the variant grid two identical columns.
       */
      const response = await createOption(app, { name: 'size' }, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OPTION_NAME_TAKEN');
    });

    it('PRESERVES the merchant capitalisation it stores', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      // Only the COMPARISON is case-folded. Lowercasing the stored value would silently
      // mangle a label the merchant deliberately capitalised.
      const response = await createOption(app, { name: 'SIZE' }, token);

      expect(response.status).toBe(201);
      expect(response.body.option.name).toBe('SIZE');
    });

    it('ALLOWS the same option name on a different product', async () => {
      await givenProduct();
      const second = await givenProduct({ slug: 'red-shirt' });
      await giveOption(second, { name: 'Size' });
      const { app, token } = await staffApp();

      // Uniqueness is scoped to the product, so one merchant's "Size" cannot block another
      // product from ever using the word.
      expect((await createOption(app, { name: 'Size' }, token)).status).toBe(201);
    });

    it('frees the name for reuse after deletion', async () => {
      const created = await givenProduct();
      const option = await giveOption(created, { name: 'Size' });
      const { app, token } = await staffApp();

      expect((await deleteOption(app, option.id, token)).status).toBe(204);
      // The partial index excludes deleted rows, exactly as it does for a SKU code.
      expect((await createOption(app, { name: 'Size' }, token)).status).toBe(201);
    });

    it('404s creating an option on an unknown, deleted or foreign product', async () => {
      const deleted = await givenProduct({ slug: 'gone', deletedAt: new Date() });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const { app, token } = await staffApp();

      for (const slug of ['no-such-product', deleted.slug, 'theirs']) {
        const response = await createOption(app, { name: 'Size' }, token, slug);
        expect(response.status, slug).toBe(404);
      }
    });

    it('lists options with their values nested, in sort order', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size', sortOrder: 1 });
      const colour = await giveOption(created, { name: 'Colour', sortOrder: 0 });
      await giveValue(size, { value: 'Large', sortOrder: 2 });
      await giveValue(size, { value: 'Small', sortOrder: 1 });
      await giveValue(colour, { value: 'Red', sortOrder: 0 });
      const { app, token } = await staffApp();

      const response = await listOptions(app, token);

      expect(response.status).toBe(200);
      // Colour first: sortOrder 0 before 1, not alphabetical and not insertion order.
      expect(optionNames(response.body)).toEqual(['Colour', 'Size']);
      expect(valueNames(response.body)).toEqual(['Red', 'Small', 'Large']);
    });

    it('excludes deleted options and deleted values from the list', async () => {
      const created = await givenProduct();
      const live = await giveOption(created, { name: 'Size' });
      await giveOption(created, { name: 'Colour', deletedAt: new Date() });
      await giveValue(live, { value: 'Small' });
      await giveValue(live, { value: 'Large', deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await listOptions(app, token);

      expect(optionNames(response.body)).toEqual(['Size']);
      expect(valueNames(response.body)).toEqual(['Small']);
    });

    it('404s listing options for an unknown product rather than returning []', async () => {
      const { app, token } = await staffApp();

      // An empty array for a mistyped slug is the answer that sends someone hunting for data
      // that was never there.
      expect((await listOptions(app, token, 'no-such-product')).status).toBe(404);
    });

    it('updates an option name and sortOrder', async () => {
      const created = await givenProduct();
      const option = await giveOption(created, { name: 'Size', sortOrder: 0 });
      const sibling = await giveOption(created, { name: 'Colour', sortOrder: 1 });
      const { app, token } = await staffApp();

      const response = await patchOption(app, option.id, { name: 'Fit', sortOrder: 5 }, token);

      expect(response.status).toBe(200);
      expect(response.body.option.name).toBe('Fit');
      expect(response.body.option.sortOrder).toBe(5);

      // Blast radius: the sibling is untouched. §29's first suite passed a mutation that
      // rewrote every row because every test kept exactly one.
      const [other] = await db()
        .select()
        .from(productOption)
        .where(eq(productOption.id, sibling.id));
      expect(other?.name).toBe('Colour');
      expect(other?.sortOrder).toBe(1);
    });

    it('rejects an empty PATCH, an unknown field, and a malformed id', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app, token } = await staffApp();

      expect((await patchOption(app, option.id, {}, token)).status).toBe(400);
      // `strictObject`: productId and storeId are unreachable, not ignored.
      expect((await patchOption(app, option.id, { productId: newId() }, token)).status).toBe(400);
      expect((await patchOption(app, option.id, { storeId: newId() }, token)).status).toBe(400);
      // The first UUID path parameter in the project: a malformed id is a 400 from validation,
      // never a PostgreSQL invalid-input-syntax error surfacing as a 500.
      expect((await patchOption(app, 'not-a-uuid', { name: 'X' }, token)).status).toBe(400);
    });

    it('rejects renaming an option onto a sibling name, case-insensitively', async () => {
      const created = await givenProduct();
      const option = await giveOption(created, { name: 'Size' });
      await giveOption(created, { name: 'Colour' });
      const { app, token } = await staffApp();

      const response = await patchOption(app, option.id, { name: 'COLOUR' }, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OPTION_NAME_TAKEN');
    });

    it('soft-deletes an option and cascades to its values', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      await giveValue(option, { value: 'Small' });
      await giveValue(option, { value: 'Large' });
      const { app, token } = await staffApp();

      expect((await deleteOption(app, option.id, token)).status).toBe(204);

      // Both soft, in one transaction. A live value under a deleted option is incoherent.
      expect(await liveOptions()).toEqual([]);
      expect(await liveValues()).toEqual([]);
      // And the rows still exist — soft, so history stays readable.
      expect(await db().select().from(productOptionValue)).toHaveLength(2);
    });

    it('404s a second delete of the same option', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app, token } = await staffApp();

      expect((await deleteOption(app, option.id, token)).status).toBe(204);
      expect((await deleteOption(app, option.id, token)).status).toBe(404);
    });

    it('isolates options across stores on every route', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirProduct = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const theirOption = await giveOption(theirProduct, { name: 'Size' });
      const theirValue = await giveValue(theirOption);
      const { app, token } = await staffApp();

      // Every lookup is store-scoped in the QUERY, so another store's id is simply absent.
      expect((await patchOption(app, theirOption.id, { name: 'X' }, token)).status).toBe(404);
      expect((await deleteOption(app, theirOption.id, token)).status).toBe(404);
      expect((await createValue(app, theirOption.id, { value: 'Small' }, token)).status).toBe(404);
      expect((await patchValue(app, theirValue.id, { value: 'X' }, token)).status).toBe(404);
      expect((await deleteValue(app, theirValue.id, token)).status).toBe(404);

      // And nothing was modified.
      const [untouched] = await db()
        .select()
        .from(productOption)
        .where(eq(productOption.id, theirOption.id));
      expect(untouched?.name).toBe('Size');
      expect(untouched?.deletedAt).toBeNull();
    });
  });

  /* ── Value CRUD ────────────────────────────────────────────────────────── */

  describe('option value CRUD', () => {
    it('creates a value and returns 201 with an exact key set', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app, token } = await staffApp();

      const response = await createValue(app, option.id, { value: 'Small', sortOrder: 1 }, token);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['value']);
      expect(Object.keys(response.body.value).sort()).toEqual([
        'createdAt',
        'id',
        'sortOrder',
        'updatedAt',
        'value',
      ]);
      // `optionId`, `productId`, `storeId` are all absent: parentage is not a client field.
      expect(response.body.value.value).toBe('Small');
    });

    it('copies product_id from the OPTION row, not the request', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app, token } = await staffApp();

      const response = await createValue(app, option.id, { value: 'Small' }, token);

      const [row] = await db()
        .select()
        .from(productOptionValue)
        .where(eq(productOptionValue.id, response.body.value.id as string));
      // Half of `fk_pov_option_product`. Taking it from the row rather than the body is what
      // makes the constraint unfalsifiable instead of merely enforced.
      expect(row?.productId).toBe(created.id);
      expect(row?.storeId).toBe(storeId);
    });

    it('rejects a duplicate value in one option, including by case', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      await giveValue(option, { value: 'Small' });
      const { app, token } = await staffApp();

      expect((await createValue(app, option.id, { value: 'Small' }, token)).status).toBe(409);
      const cased = await createValue(app, option.id, { value: 'SMALL' }, token);
      expect(cased.status).toBe(409);
      expect(cased.body.error.code).toBe('OPTION_VALUE_TAKEN');
    });

    it('ALLOWS the same value in a different option', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const colour = await giveOption(created, { name: 'Colour' });
      await giveValue(size, { value: 'Small' });
      const { app, token } = await staffApp();

      // Uniqueness is per option. Nothing stops two options offering the same word.
      expect((await createValue(app, colour.id, { value: 'Small' }, token)).status).toBe(201);
    });

    it('404s creating a value on an unknown or deleted option', async () => {
      const created = await givenProduct();
      const gone = await giveOption(created, { name: 'Gone', deletedAt: new Date() });
      const { app, token } = await staffApp();

      expect((await createValue(app, newId(), { value: 'Small' }, token)).status).toBe(404);
      expect((await createValue(app, gone.id, { value: 'Small' }, token)).status).toBe(404);
    });

    it('updates a value without touching its siblings', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const target = await giveValue(option, { value: 'Small' });
      const sibling = await giveValue(option, { value: 'Large' });
      const { app, token } = await staffApp();

      const response = await patchValue(app, target.id, { value: 'Tiny', sortOrder: 9 }, token);

      expect(response.status).toBe(200);
      expect(response.body.value.value).toBe('Tiny');

      const [other] = await db()
        .select()
        .from(productOptionValue)
        .where(eq(productOptionValue.id, sibling.id));
      expect(other?.value).toBe('Large');
    });

    it('rejects an empty PATCH and an attempt to move a value between options', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const value = await giveValue(option);
      const { app, token } = await staffApp();

      expect((await patchValue(app, value.id, {}, token)).status).toBe(400);
      // Moving a value between options would change what every SKU using it MEANS.
      expect((await patchValue(app, value.id, { optionId: newId() }, token)).status).toBe(400);
    });

    it('soft-deletes a value and frees its name for reuse', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const value = await giveValue(option, { value: 'Small' });
      const { app, token } = await staffApp();

      expect((await deleteValue(app, value.id, token)).status).toBe(204);
      expect(await liveValues()).toEqual([]);
      expect(await db().select().from(productOptionValue)).toHaveLength(1);
      expect((await createValue(app, option.id, { value: 'Small' }, token)).status).toBe(201);
    });

    it('404s a second delete of the same value', async () => {
      const created = await givenProduct();
      const value = await giveValue(await giveOption(created));
      const { app, token } = await staffApp();

      expect((await deleteValue(app, value.id, token)).status).toBe(204);
      expect((await deleteValue(app, value.id, token)).status).toBe(404);
    });
  });

  /* ── Grid-size caps ────────────────────────────────────────────────────── */

  describe('grid-size caps', () => {
    it('rejects an 11th option on one product with a 400 naming the limit', async () => {
      const created = await givenProduct();
      for (let i = 0; i < 10; i += 1) {
        await giveOption(created, { name: `Option ${String(i)}` });
      }
      const { app, token } = await staffApp();

      const response = await createOption(app, { name: 'Eleventh' }, token);

      // A 400, not a 409: the request itself is unacceptable, not in conflict with a resource.
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body.error.details)).toContain('at most 10 options');
      expect(await liveOptions()).toHaveLength(10);
    });

    it('counts only LIVE options toward the cap', async () => {
      const created = await givenProduct();
      for (let i = 0; i < 10; i += 1) {
        await giveOption(created, { name: `Option ${String(i)}`, deletedAt: new Date() });
      }
      const { app, token } = await staffApp();

      // Retired options must not permanently consume the merchant's budget.
      expect((await createOption(app, { name: 'Fresh' }, token)).status).toBe(201);
    });

    it('rejects a 101st value on one option', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      for (let i = 0; i < 100; i += 1) {
        await giveValue(option, { value: `Value ${String(i)}` });
      }
      const { app, token } = await staffApp();

      const response = await createValue(app, option.id, { value: 'Overflow' }, token);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('at most 100 values');
    });

    it('rejects more than 10 option values on one SKU, from the schema', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      // Enforced by the Zod array bound, because it is a property of the REQUEST — so the
      // request never reaches a transaction at all.
      const ids = Array.from({ length: 11 }, () => newId());
      const response = await putSkuOptions(app, 'S-1', ids, token);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('at most 10 option values');
    });
  });

  /* ── SKU combinations ──────────────────────────────────────────────────── */

  describe('SKU combinations', () => {
    /** A product with Size(Small,Large) and Colour(Red,Blue), plus one SKU. */
    async function givenGrid(skuCode = 'S-1') {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size', sortOrder: 0 });
      const colour = await giveOption(created, { name: 'Colour', sortOrder: 1 });
      const small = await giveValue(size, { value: 'Small', sortOrder: 0 });
      const large = await giveValue(size, { value: 'Large', sortOrder: 1 });
      const red = await giveValue(colour, { value: 'Red', sortOrder: 0 });
      const blue = await giveValue(colour, { value: 'Blue', sortOrder: 1 });
      const created1 = await giveSku(db(), created, { code: skuCode });
      return { created, size, colour, small, large, red, blue, sku: created1 };
    }

    it('attaches one value and materialises the signature', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [grid.small.id], token);

      expect(response.status).toBe(200);
      expect(skuOptionLabels(response.body)).toEqual(['Size=Small']);
      expect(await signatureOf('S-1')).toBe(buildOptionSignature([grid.small.id]));
    });

    it('attaches several values across options', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [grid.small.id, grid.red.id], token);

      expect(response.status).toBe(200);
      // Ordered by option sortOrder: Size (0) before Colour (1).
      expect(skuOptionLabels(response.body)).toEqual(['Size=Small', 'Colour=Red']);
      expect(await junctionFor(grid.sku.id)).toHaveLength(2);
    });

    it('reads the combination back on every SKU read path', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [grid.small.id, grid.red.id], token);

      const list = await request(app)
        .get(`/api/v1/admin/products/${SLUG}/skus`)
        .set('Authorization', `Bearer ${token}`);
      expect(list.body.skus[0].options).toHaveLength(2);

      const detail = await request(app).get(`/api/v1/products/${SLUG}`);
      expect(detail.body.product.skus[0].options).toHaveLength(2);

      const patched = await request(app)
        .patch('/api/v1/admin/skus/S-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Renamed' });
      // A scalar PATCH must not drop the combination from its own response.
      expect(patched.body.sku.options).toHaveLength(2);
    });

    it('replaces a combination, rewriting both rows and signature', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [grid.small.id, grid.red.id], token);

      const response = await putSkuOptions(app, 'S-1', [grid.large.id, grid.blue.id], token);

      expect(response.status).toBe(200);
      expect(skuOptionLabels(response.body)).toEqual(['Size=Large', 'Colour=Blue']);
      // Superseded rows are GONE, not accumulated: `uq_sov_sku_option` allows one per option.
      expect(await junctionFor(grid.sku.id)).toHaveLength(2);
      expect(await signatureOf('S-1')).toBe(buildOptionSignature([grid.large.id, grid.blue.id]));
    });

    it('removes every option with an empty array', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [grid.small.id], token);

      const response = await putSkuOptions(app, 'S-1', [], token);

      expect(response.status).toBe(200);
      expect(response.body.sku.options).toEqual([]);
      expect(await junctionFor(grid.sku.id)).toEqual([]);
      // Back to the empty combination, which the partial index exempts from uniqueness.
      expect(await signatureOf('S-1')).toBe('');
    });

    it('requires the field rather than treating omission as a clear', async () => {
      await givenGrid();
      const { app, token } = await staffApp();

      const response = await request(app)
        .put('/api/v1/admin/skus/S-1/options')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      // Clearing a combination is a deliberate act. If omission meant "clear", a typo in the
      // field name — which `strictObject` otherwise catches — would silently wipe the grid.
      expect(response.status).toBe(400);
    });

    it('rejects duplicate ids in the array', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [grid.small.id, grid.small.id], token);

      // Rejected rather than de-duplicated: a caller sending one value twice is confused.
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('duplicates');
    });

    it('rejects two values from the SAME option with a 409', async () => {
      const grid = await givenGrid();
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [grid.small.id, grid.large.id], token);

      // A 409, not a 400: the request is well-formed and every id valid; the COMBINATION
      // conflicts. `uq_sov_sku_option` would reject it anyway — this is the friendly error.
      expect(response.status).toBe(409);
      /**
       * The CODE matters, not just the status. This is a different conflict from a duplicate
       * combination, and a client that cannot tell them apart cannot react to either: one is
       * fixed by dropping a value, the other by choosing a different variant.
       *
       * Asserted because a mutation caught this being too weak — a catch-all on the unique
       * violation reports `uq_sov_sku_option` as `SKU_COMBINATION_TAKEN`, which a
       * status-only assertion accepts.
       */
      expect(response.body.error.code).toBe('SKU_OPTION_CONFLICT');
      expect(await junctionFor(grid.sku.id)).toEqual([]);
      expect(await signatureOf('S-1')).toBe('');
    });

    it('rejects an unknown value id', async () => {
      await givenGrid();
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [newId()], token);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('not a selectable option');
    });

    it('rejects a value belonging to ANOTHER PRODUCT', async () => {
      const grid = await givenGrid();
      const second = await givenProduct({ slug: 'red-shirt' });
      const theirOption = await giveOption(second, { name: 'Size' });
      const theirValue = await giveValue(theirOption, { value: 'Small' });
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [theirValue.id], token);

      // Indistinguishable from an unknown id, on purpose.
      expect(response.status).toBe(400);
      expect(await junctionFor(grid.sku.id)).toEqual([]);
    });

    it('rejects a value belonging to ANOTHER STORE', async () => {
      await givenGrid();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirProduct = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const theirValue = await giveValue(await giveOption(theirProduct));
      const { app, token } = await staffApp();

      const response = await putSkuOptions(app, 'S-1', [theirValue.id], token);

      // Confirming an id exists elsewhere would leak across the tenant boundary.
      expect(response.status).toBe(400);
    });

    it('rejects a DELETED value', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const gone = await giveValue(option, { value: 'Small', deletedAt: new Date() });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'S-1', [gone.id], token)).status).toBe(400);
    });

    it('rejects a live value whose OPTION is deleted', async () => {
      const created = await givenProduct();
      const goneOption = await giveOption(created, { deletedAt: new Date() });
      // The value itself was never deleted — only its parent option was.
      const orphan = await giveValue(goneOption, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      // The resolver inner-joins the option and filters both `deleted_at`s, so a deleted
      // option makes its values unselectable even when they are individually live.
      expect((await putSkuOptions(app, 'S-1', [orphan.id], token)).status).toBe(400);
    });

    it('404s an unknown or deleted SKU code', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const value = await giveValue(option);
      await giveSku(db(), created, { code: 'GONE', deletedAt: new Date() });
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'NO-SUCH', [value.id], token)).status).toBe(404);
      expect((await putSkuOptions(app, 'GONE', [value.id], token)).status).toBe(404);
    });
  });

  /* ── Combination uniqueness ────────────────────────────────────────────── */

  describe('combination uniqueness', () => {
    async function givenTwoSkus() {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size', sortOrder: 0 });
      const colour = await giveOption(created, { name: 'Colour', sortOrder: 1 });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      const red = await giveValue(colour, { value: 'Red' });
      const first = await giveSku(db(), created, { code: 'S-1' });
      const second = await giveSku(db(), created, { code: 'S-2' });
      return { created, small, large, red, first, second };
    }

    it('rejects an identical combination on the same product', async () => {
      const g = await givenTwoSkus();
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'S-1', [g.small.id, g.red.id], token)).status).toBe(200);
      const response = await putSkuOptions(app, 'S-2', [g.small.id, g.red.id], token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SKU_COMBINATION_TAKEN');

      /**
       * The loser keeps its previous state ENTIRELY — the signature AND the junction rows.
       *
       * Asserting only the signature is not enough, and a mutation proved it: if the signature
       * write were deferred past COMMIT (with `onCommit`, say), the junction rows would commit
       * first and the unique violation would arrive too late to undo them. S-2 would then be
       * left carrying a combination its own signature denies — exactly the divergent state the
       * shared transaction exists to prevent.
       */
      expect(await signatureOf('S-2')).toBe('');
      expect(await junctionFor(g.second.id)).toEqual([]);
      // And the winner is intact.
      expect(await junctionFor(g.first.id)).toHaveLength(2);
    });

    it('rejects the SAME VALUES IN A DIFFERENT ORDER', async () => {
      const g = await givenTwoSkus();
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'S-1', [g.small.id, g.red.id], token)).status).toBe(200);
      // The whole point of sorting the signature: Red+Small IS Small+Red, and a merchant who
      // sends the ids the other way round must not create a second, identical variant.
      const response = await putSkuOptions(app, 'S-2', [g.red.id, g.small.id], token);

      expect(response.status).toBe(409);
    });

    it('accepts a genuinely different combination', async () => {
      const g = await givenTwoSkus();
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'S-1', [g.small.id, g.red.id], token)).status).toBe(200);
      expect((await putSkuOptions(app, 'S-2', [g.large.id, g.red.id], token)).status).toBe(200);
    });

    it('accepts the same combination on a DIFFERENT product', async () => {
      const g = await givenTwoSkus();
      const second = await givenProduct({ slug: 'red-shirt' });
      const theirSize = await giveOption(second, { name: 'Size' });
      const theirSmall = await giveValue(theirSize, { value: 'Small' });
      await giveSku(db(), second, { code: 'T-1' });
      const { app, token } = await staffApp();

      expect((await putSkuOptions(app, 'S-1', [g.small.id], token)).status).toBe(200);
      // Uniqueness is scoped to `product_id`: two products may each have a Small variant.
      expect((await putSkuOptions(app, 'T-1', [theirSmall.id], token)).status).toBe(200);
    });

    it('lets MANY option-less SKUs coexist under one product', async () => {
      const created = await givenProduct();
      for (const code of ['A-1', 'B-2', 'C-3']) {
        await giveSku(db(), created, { code });
      }
      const { app, token } = await staffApp();

      // The `option_signature <> ''` predicate exempts them. This is invariant 11: every SKU
      // Increment 24 created is option-less, and they must all stay legal.
      for (const code of ['A-1', 'B-2', 'C-3']) {
        expect((await putSkuOptions(app, code, [], token)).status, code).toBe(200);
      }
      const rows = await db().select().from(sku).where(eq(sku.storeId, storeId));
      expect(rows.every((r) => r.optionSignature === '')).toBe(true);
    });

    it('FREES the combination when its holder is soft-deleted', async () => {
      const g = await givenTwoSkus();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [g.small.id, g.red.id], token);

      // Delete the holder, then claim the same combination with the other SKU.
      expect(
        (
          await request(app)
            .delete('/api/v1/admin/skus/S-1')
            .set('Authorization', `Bearer ${token}`)
        ).status,
      ).toBe(204);

      /**
       * This is the `deleted_at IS NULL` half of the partial index. WITHOUT it a deleted SKU
       * reserves its combination forever and a merchant can never re-create a variant they
       * deleted — a 409 with no way out.
       */
      const response = await putSkuOptions(app, 'S-2', [g.small.id, g.red.id], token);
      expect(response.status).toBe(200);
    });

    it('pins the exact signature format for a known pair of ids', async () => {
      /**
       * Storage, not display. If the ordering or the delimiter ever changed, every stored
       * signature would be invalidated with no error at the moment of the change — so the
       * format is asserted literally rather than round-tripped through the builder.
       */
      const a = '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33';
      const b = '01a04310-0f2c-7b31-8c4d-000000000001';

      expect(buildOptionSignature([a, b])).toBe(`${b},${a}`);
      expect(buildOptionSignature([b, a])).toBe(`${b},${a}`);
      expect(buildOptionSignature([])).toBe('');
      expect(buildOptionSignature([a])).toBe(a);
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  describe('concurrency', () => {
    it('lets exactly ONE of two concurrent identical combinations win', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const first = await giveSku(db(), created, { code: 'S-1' });
      const second = await giveSku(db(), created, { code: 'S-2' });
      const { app, token } = await staffApp();

      /**
       * Both requests validate against a database that shows neither combination taken, so
       * both pre-checks pass and the UNIQUE INDEX is what decides. That is the property the
       * whole design turns on: the application check is a courtesy, not the mechanism.
       */
      const [a, b] = await Promise.all([
        putSkuOptions(app, 'S-1', [small.id], token),
        putSkuOptions(app, 'S-2', [small.id], token),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);

      // Exactly one SKU carries the combination, and the loser has NO partial rows.
      const signatures = [await signatureOf('S-1'), await signatureOf('S-2')];
      expect(signatures.filter((s) => s === small.id)).toHaveLength(1);
      expect(signatures.filter((s) => s === '')).toHaveLength(1);

      const junction = [...(await junctionFor(first.id)), ...(await junctionFor(second.id))];
      expect(junction).toHaveLength(1);
    });

    it('reports the loser as a COMBINATION conflict, not some other 409', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      await giveSku(db(), created, { code: 'S-2' });
      const { app, token } = await staffApp();

      const [a, b] = await Promise.all([
        putSkuOptions(app, 'S-1', [small.id], token),
        putSkuOptions(app, 'S-2', [small.id], token),
      ]);

      const loser = a.status === 409 ? a : b;
      expect(loser.body.error.code).toBe('SKU_COMBINATION_TAKEN');
    });
  });

  /* ── Signature integrity ───────────────────────────────────────────────── */

  describe('signature integrity', () => {
    it('keeps the signature equal to the junction rows', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const colour = await giveOption(created, { name: 'Colour' });
      const small = await giveValue(size, { value: 'Small' });
      const red = await giveValue(colour, { value: 'Red' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      await putSkuOptions(app, 'S-1', [small.id, red.id], token);

      const rows = await junctionFor(target.id);
      expect(await signatureOf('S-1')).toBe(buildOptionSignature(rows.map((r) => r.optionValueId)));
    });

    it('leaves BOTH the rows and the signature unchanged when the transaction fails', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      const built = await staffApp();
      const { app, token } = built;

      // Establish a known good combination first.
      await putSkuOptions(app, 'S-1', [small.id], token);

      /**
       * Provoke a REAL rollback: `audit_log.actor_user_id` is a foreign key, so naming an
       * actor whose user does not exist fails the audit insert AFTER the junction rows have
       * been rewritten and the signature updated.
       *
       * This is the only assertion that proves the three writes share a transaction. With
       * separate transactions the rows and signature would already be Large.
       */
      await expect(
        built.catalogue.replaceSkuOptions({
          storeId,
          code: 'S-1',
          actor: { type: 'staff', userId: newId() },
          input: { optionValueIds: [large.id] },
        }),
      ).rejects.toThrow();

      const rows = await junctionFor(target.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.optionValueId).toBe(small.id);
      expect(await signatureOf('S-1')).toBe(small.id);
    });

    it('does NOT change any signature when a value is renamed', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      const before = await signatureOf('S-1');
      expect((await patchValue(app, small.id, { value: 'Tiny' }, token)).status).toBe(200);

      // Built from IDS, not names. A merchant fixing a typo must not silently redefine which
      // variant every SKU using it represents, nor make two SKUs collide.
      expect(await signatureOf('S-1')).toBe(before);
    });

    it('PRESERVES junction rows when the SKU is soft-deleted', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      await request(app).delete('/api/v1/admin/skus/S-1').set('Authorization', `Bearer ${token}`);

      // The historical record of what this SKU was. An order line will need it later.
      expect(await junctionFor(target.id)).toHaveLength(1);
    });
  });

  /* ── Product deletion ──────────────────────────────────────────────────── */

  describe('product deletion', () => {
    it('cascades to options and values, leaving a consistent historical graph', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      const response = await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(204);

      // Nothing live is left behind: a live option under a deleted product is reachable by id
      // through PATCH /admin/options/:id, exactly the gap Increment 24 closed for SKUs.
      expect(await liveOptions()).toEqual([]);
      expect(await liveValues()).toEqual([]);
      // Every row still EXISTS, and the junction is untouched, so history stays readable.
      expect(await db().select().from(productOption)).toHaveLength(1);
      expect(await junctionFor(target.id)).toHaveLength(1);
    });

    it('cannot reach a deleted product’s options through the flat routes', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const { app, token } = await staffApp();

      await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);

      expect((await patchOption(app, size.id, { name: 'X' }, token)).status).toBe(404);
      expect((await patchValue(app, small.id, { value: 'X' }, token)).status).toBe(404);
      expect((await deleteOption(app, size.id, token)).status).toBe(404);
    });

    it('records the option cascade in the product audit entry', async () => {
      const created = await givenProduct();
      await giveOption(created, { name: 'Size' });
      await giveOption(created, { name: 'Colour' });
      const { app, token } = await staffApp();

      await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`);

      const audit = (await auditFor('product')).filter((r) => r.action === 'product.deleted');
      expect(audit).toHaveLength(1);
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      // Names are freed for reuse by the partial index, so the trail must say what went.
      expect(metadata['cascadedOptionNames']).toEqual(['Size', 'Colour']);
    });
  });

  /* ── Option deletion guard ─────────────────────────────────────────────── */

  describe('deletion refused while in use', () => {
    async function givenSkuUsing() {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      return { created, size, small };
    }

    it('refuses to delete a value a live SKU uses, naming the blocking codes', async () => {
      const g = await givenSkuUsing();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [g.small.id], token);

      const response = await deleteValue(app, g.small.id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('OPTION_IN_USE');
      // Naming them is the point: the merchant decides what happens to those SKUs, and
      // cannot decide without knowing which they are.
      expect(response.body.error.details.skuCodes).toEqual(['S-1']);
      expect(await liveValues()).toHaveLength(1);
    });

    it('refuses to delete an OPTION whose value a live SKU uses', async () => {
      const g = await givenSkuUsing();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [g.small.id], token);

      const response = await deleteOption(app, g.size.id, token);

      expect(response.status).toBe(409);
      expect(response.body.error.details.skuCodes).toEqual(['S-1']);
      // Nothing was written: the guard runs inside the transaction, before the writes.
      expect(await liveOptions()).toHaveLength(1);
      expect(await liveValues()).toHaveLength(1);
    });

    it('ALLOWS deletion once the SKU is itself deleted', async () => {
      const g = await givenSkuUsing();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [g.small.id], token);
      await request(app).delete('/api/v1/admin/skus/S-1').set('Authorization', `Bearer ${token}`);

      /**
       * The guard asks only about LIVE SKUs, which is what makes retiring an option possible
       * at all once its variants are gone — and what makes the SOFT deletion safe: the
       * historical junction rows keep pointing at a value row that still exists.
       */
      expect((await deleteOption(app, g.size.id, token)).status).toBe(204);
      const rows = await db().select().from(productOptionValue);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deletedAt).not.toBeNull();
    });

    it('ALLOWS deletion once the SKU has dropped the value', async () => {
      const g = await givenSkuUsing();
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [g.small.id], token);
      await putSkuOptions(app, 'S-1', [], token);

      // Replacement hard-deletes the superseded rows, so nothing references the value.
      expect((await deleteValue(app, g.small.id, token)).status).toBe(204);
    });

    it('is not blocked by a value that no SKU uses', async () => {
      const g = await givenSkuUsing();
      const { app, token } = await staffApp();

      expect((await deleteValue(app, g.small.id, token)).status).toBe(204);
    });
  });

  /* ── Public API ────────────────────────────────────────────────────────── */

  describe('public API', () => {
    it('exposes the combination on the public product read and list', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      const detail = await request(app).get(`/api/v1/products/${SLUG}`);
      expect(detail.status).toBe(200);
      expect(detail.body.product.skus[0].options[0].value).toBe('Small');
      // Storage must never be published: the signature is an internal encoding.
      expect('optionSignature' in detail.body.product.skus[0]).toBe(false);

      const list = await publicList(app);
      expect(list.body.products[0].skus[0].options[0].optionName).toBe('Size');
    });

    it('does NOT expose an option value whose row is deleted', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      /**
       * A CORRUPT state, written with direct SQL because the API cannot produce it: deleting
       * this value is refused while S-1 is live (decision A). It can only arise from a bad
       * import, an operator, or a future bug — which is exactly what makes the public mapper's
       * `deleted_at IS NULL` filters worth stating, and what makes a mutation removing them
       * survive a suite that only ever speaks HTTP.
       */
      await db()
        .update(productOptionValue)
        .set({ deletedAt: new Date() })
        .where(eq(productOptionValue.id, small.id));

      const detail = await request(app).get(`/api/v1/products/${SLUG}`);
      expect(detail.status).toBe(200);
      expect(detail.body.product.skus[0].options).toEqual([]);
      expect((await publicList(app)).body.products[0].skus[0].options).toEqual([]);
      // The junction row survives; only its visibility is withdrawn.
      expect(await junctionFor(target.id)).toHaveLength(1);
    });

    it('does NOT expose a value whose OPTION row is deleted', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      // The other half of the same defence: the option is retired, the value is not.
      await db()
        .update(productOption)
        .set({ deletedAt: new Date() })
        .where(eq(productOption.id, size.id));

      const detail = await request(app).get(`/api/v1/products/${SLUG}`);
      expect(detail.body.product.skus[0].options).toEqual([]);
    });

    it('hides an INACTIVE SKU’s combination from the storefront but not from staff', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      await giveSku(db(), created, { code: 'LIVE-1' });
      await giveSku(db(), created, { code: 'OFF-1', isActive: false });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'LIVE-1', [small.id], token);
      await putSkuOptions(app, 'OFF-1', [large.id], token);

      const detail = await request(app).get(`/api/v1/products/${SLUG}`);
      expect(detail.body.product.skus).toHaveLength(1);
      expect(detail.body.product.skus[0].options[0].value).toBe('Small');

      const staff = await request(app)
        .get(`/api/v1/admin/products/${SLUG}/skus`)
        .set('Authorization', `Bearer ${token}`);
      expect(staff.body.skus).toHaveLength(2);
    });

    it('keeps a product hidden when it has no active SKU, options or not', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      await giveSku(db(), created, { code: 'S-1', isActive: false });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);

      // Options do not participate in visibility: sellability is a property of the SKU.
      expect((await request(app).get(`/api/v1/products/${SLUG}`)).status).toBe(404);
      expect((await publicList(app)).body.pagination.total).toBe(0);
    });

    it('returns a product exactly ONCE with several option-bearing SKUs in a price band', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      await giveSku(db(), created, { code: 'S-1', price: '1500.0000' });
      await giveSku(db(), created, { code: 'S-2', price: '1600.0000' });
      const { app, token } = await staffApp();
      await putSkuOptions(app, 'S-1', [small.id], token);
      await putSkuOptions(app, 'S-2', [large.id], token);

      const response = await publicList(app, '?price_min=1000&price_max=2000');

      // The visibility predicate is still a correlated EXISTS: two matching SKUs must not
      // duplicate the product on the page, and must not inflate `total`.
      expect(response.body.pagination.total).toBe(1);
      expect(response.body.products).toHaveLength(1);
      expect(response.body.products[0].skus).toHaveLength(2);
    });

    it('has no public option-management routes', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app } = build();

      // 401, never 200: these are staff routes and there is no anonymous equivalent.
      expect((await request(app).get(`/api/v1/products/${SLUG}/options`)).status).toBe(404);
      expect((await createOption(app, { name: 'X' })).status).toBe(401);
      expect((await deleteOption(app, option.id)).status).toBe(401);
    });
  });

  /* ── Events and audit ──────────────────────────────────────────────────── */

  describe('events and audit', () => {
    it('records product_option.created with the authenticated actor', async () => {
      await givenProduct();
      const { app, token, userId } = await staffApp();

      const response = await createOption(app, { name: 'Size' }, token);
      const optionId = response.body.option.id as string;

      const events = await eventsFor('product_option');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe('product_option.created');
      expect(events[0]?.aggregateId).toBe(optionId);
      expect(events[0]?.storeId).toBe(storeId);
      const payload = events[0]?.payload as Record<string, unknown>;
      expect(payload['name']).toBe('Size');

      const audit = await auditFor('product_option');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(userId);
      expect(audit[0]?.action).toBe('product_option.created');
    });

    it('records product_option_value events for create, update and delete', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const { app, token } = await staffApp();

      const made = await createValue(app, option.id, { value: 'Small' }, token);
      const id = made.body.value.id as string;
      await patchValue(app, id, { value: 'Tiny' }, token);
      await deleteValue(app, id, token);

      const events = await eventsFor('product_option_value');
      expect(events.map((e) => e.eventName)).toEqual([
        'product_option_value.created',
        'product_option_value.updated',
        'product_option_value.deleted',
      ]);
      expect((await auditFor('product_option_value')).map((a) => a.action)).toEqual([
        'product_option_value.created',
        'product_option_value.updated',
        'product_option_value.deleted',
      ]);
    });

    it('records sku.options_updated with the BEFORE and AFTER combination', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      await putSkuOptions(app, 'S-1', [small.id], token);
      await putSkuOptions(app, 'S-1', [large.id], token);

      const events = (await eventsFor('sku')).filter((e) => e.eventName === 'sku.options_updated');
      expect(events).toHaveLength(2);
      const payload = events[1]?.payload as Record<string, unknown>;
      expect(payload['optionSignature']).toBe(large.id);

      const audit = (await auditFor('sku')).filter((a) => a.action === 'sku.options_updated');
      expect(audit).toHaveLength(2);
      /**
       * The before/after is REQUIRED, not decorative: replacement hard-deletes the superseded
       * junction rows, so this entry is the only surviving record that S-1 was ever Small.
       */
      const metadata = audit[1]?.metadata as Record<string, unknown>;
      expect(metadata['before']).toEqual([{ optionName: 'Size', value: 'Small' }]);
      expect(metadata['after']).toEqual([{ optionValueId: large.id, value: 'Large' }]);
    });

    it('records NOTHING when an option create is rejected', async () => {
      const created = await givenProduct();
      await giveOption(created, { name: 'Size' });
      const { app, token } = await staffApp();

      expect((await createOption(app, { name: 'size' }, token)).status).toBe(409);

      expect(await eventsFor('product_option')).toEqual([]);
      expect(await auditFor('product_option')).toEqual([]);
    });

    it('records NOTHING when a combination replacement is rejected', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      // Two values of one option.
      expect((await putSkuOptions(app, 'S-1', [small.id, large.id], token)).status).toBe(409);

      expect((await eventsFor('sku')).filter((e) => e.eventName === 'sku.options_updated')).toEqual(
        [],
      );
    });

    it('takes the actor from the token even when a bodiless DELETE claims another user', async () => {
      const created = await givenProduct();
      const option = await giveOption(created);
      const built = await staffApp();
      const { app, token, userId } = built;
      // A real second user, so a forged id would satisfy the audit FK and would persist.
      const victim = await signIn(app, built.identity, { email: 'victim@example.com' });

      /**
       * The two new DELETE routes validate `params` ONLY — they have no body to describe — so
       * an unexpected JSON body reaches `req.body` unvalidated. Increment 24 found that exact
       * gap on `DELETE /admin/skus/:code`; this increment adds two more such routes, so it is
       * re-tested rather than assumed closed.
       */
      const response = await deleteOption(app, option.id, token).send({
        actorUserId: victim.userId,
      });
      expect(response.status).toBe(204);

      const audit = await auditFor('product_option');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorUserId).toBe(userId);
      expect(audit[0]?.actorUserId).not.toBe(victim.userId);
    });

    it('ignores a body-supplied storeId on a bodiless DELETE', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirProduct = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const theirOption = await giveOption(theirProduct, { name: 'Size' });
      const { app, token } = await staffApp();

      /**
       * The escalation this closes: the DELETE routes validate `params` only — they have no
       * body to describe — so an unexpected JSON body reaches `req.body` unvalidated, and the
       * strict schemas on the OTHER routes do not protect these. A handler reading the store
       * from that body instead of the verified request scope would let one merchant retire
       * another merchant's options.
       *
       * The store must come from request resolution, so naming another store changes nothing.
       */
      const response = await deleteOption(app, theirOption.id, token).send({
        storeId: otherStoreId,
      });
      expect(response.status).toBe(404);

      const [row] = await db()
        .select()
        .from(productOption)
        .where(eq(productOption.id, theirOption.id));
      expect(row?.deletedAt).toBeNull();
      expect(await auditFor('product_option')).toEqual([]);
    });

    it('rejects a body-supplied store or product id on the routes with a schema', async () => {
      const created = await givenProduct();
      await giveSku(db(), created, { code: 'S-1' });
      const { app, token } = await staffApp();

      // `strictObject` everywhere: tenancy and parentage are unreachable, not ignored.
      expect((await createOption(app, { name: 'Size', storeId: newId() }, token)).status).toBe(400);
      expect((await createOption(app, { name: 'Size', productId: newId() }, token)).status).toBe(
        400,
      );
      const put = await request(app)
        .put('/api/v1/admin/skus/S-1/options')
        .set('Authorization', `Bearer ${token}`)
        .send({ optionValueIds: [], storeId: newId() });
      expect(put.status).toBe(400);
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * These are the tests that distinguish a DATABASE guarantee from an application check.
     *
     * Each writes with direct SQL, bypassing the service entirely, and asserts the NAMED
     * constraint that refuses it. If the application validation were deleted tomorrow, only
     * these would still fail — which is what makes the composite foreign keys real rather
     * than decorative.
     */
    it('refuses a value whose option belongs to a DIFFERENT product', async () => {
      const first = await givenProduct();
      const second = await givenProduct({ slug: 'red-shirt' });
      const optionOnSecond = await giveOption(second, { name: 'Size' });

      await expectConstraint(
        db().insert(productOptionValue).values({
          id: newId(),
          storeId,
          optionId: optionOnSecond.id,
          // Lying about the product.
          productId: first.id,
          value: 'Small',
          sortOrder: 0,
        }),
        'fk_pov_option_product',
      );
    });

    it('refuses a junction row attaching another product’s value to a SKU', async () => {
      const first = await givenProduct();
      const second = await givenProduct({ slug: 'red-shirt' });
      const theirValue = await giveValue(await giveOption(second, { name: 'Size' }));
      const mySku = await giveSku(db(), first, { code: 'S-1' });

      await expectConstraint(
        db().insert(skuOptionValue).values({
          skuId: mySku.id,
          optionValueId: theirValue.id,
          optionId: theirValue.optionId,
          productId: first.id,
          storeId,
        }),
        'fk_sov_value_product',
      );
    });

    it('refuses two values of the SAME option on one SKU', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      const target = await giveSku(db(), created, { code: 'S-1' });

      await db().insert(skuOptionValue).values({
        skuId: target.id,
        optionValueId: small.id,
        optionId: size.id,
        productId: created.id,
        storeId,
      });

      await expectConstraint(
        db().insert(skuOptionValue).values({
          skuId: target.id,
          optionValueId: large.id,
          optionId: size.id,
          productId: created.id,
          storeId,
        }),
        'uq_sov_sku_option',
      );
    });

    it('refuses a FALSIFIED option_id used to dodge that unique index', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const colour = await giveOption(created, { name: 'Colour' });
      const small = await giveValue(size, { value: 'Small' });
      const large = await giveValue(size, { value: 'Large' });
      const target = await giveSku(db(), created, { code: 'S-1' });

      await db().insert(skuOptionValue).values({
        skuId: target.id,
        optionValueId: small.id,
        optionId: size.id,
        productId: created.id,
        storeId,
      });

      /**
       * The obvious attack on `uq_sov_sku_option`: claim the second Size value belongs to the
       * Colour option, and the unique index would cheerfully admit it. `fk_sov_value_option`
       * is what makes `option_id` honest, and therefore what makes that index mean anything.
       */
      await expectConstraint(
        db().insert(skuOptionValue).values({
          skuId: target.id,
          optionValueId: large.id,
          optionId: colour.id,
          productId: created.id,
          storeId,
        }),
        'fk_sov_value_option',
      );
    });

    it('refuses a junction row claiming the WRONG STORE', async () => {
      const created = await givenProduct();
      const value = await giveValue(await giveOption(created));
      const target = await giveSku(db(), created, { code: 'S-1' });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db().insert(skuOptionValue).values({
          skuId: target.id,
          optionValueId: value.id,
          optionId: value.optionId,
          productId: created.id,
          storeId: otherStoreId,
        }),
        'fk_sov_sku_store',
      );
    });

    it('refuses a duplicate combination written directly', async () => {
      const created = await givenProduct();
      const first = await giveSku(db(), created, { code: 'S-1' });
      const second = await giveSku(db(), created, { code: 'S-2' });
      const signature = buildOptionSignature([newId(), newId()]);

      await db().update(sku).set({ optionSignature: signature }).where(eq(sku.id, first.id));

      await expectConstraint(
        db().update(sku).set({ optionSignature: signature }).where(eq(sku.id, second.id)),
        'uq_sku_combination',
      );
    });

    it('refuses a hard DELETE of an option value a junction row references', async () => {
      const created = await givenProduct();
      const size = await giveOption(created, { name: 'Size' });
      const small = await giveValue(size, { value: 'Small' });
      const target = await giveSku(db(), created, { code: 'S-1' });
      await db().insert(skuOptionValue).values({
        skuId: target.id,
        optionValueId: small.id,
        optionId: size.id,
        productId: created.id,
        storeId,
      });

      // RESTRICT, not CASCADE: nothing in this graph is hard-deleted by the application, so a
      // cascade would only ever fire during an operator mistake.
      await expectConstraint(
        db().delete(productOptionValue).where(eq(productOptionValue.id, small.id)),
        'fk_sov_value',
      );
    });
  });

  /* ── Repository-level store isolation ──────────────────────────────────── */

  describe('repository store isolation', () => {
    it('scopes every option read and write by store', async () => {
      const { repository } = build();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirProduct = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const theirOption = await giveOption(theirProduct, { name: 'Size' });
      const theirValue = await giveValue(theirOption, { value: 'Small' });

      /**
       * Asserted at the REPOSITORY level as well as through HTTP. A guarantee that lives only
       * in a route is one refactor from a leak, and a future caller arriving from a CLI
       * command or a background job gets no middleware at all.
       */
      expect(await repository.findOptionById({ storeId, id: theirOption.id })).toBeUndefined();
      expect(await repository.findOptionValueById({ storeId, id: theirValue.id })).toBeUndefined();
      expect(
        await repository.listOptionsForProduct({ storeId, productId: theirProduct.id }),
      ).toEqual([]);
      expect(
        await repository.listValuesForOptions({ storeId, optionIds: [theirOption.id] }),
      ).toEqual([]);
      expect(
        await repository.findSelectableOptionValues({
          storeId,
          productId: theirProduct.id,
          ids: [theirValue.id],
        }),
      ).toEqual([]);
      expect(
        await repository.updateOptionFields({
          storeId,
          id: theirOption.id,
          fields: { name: 'Hijacked' },
          at: new Date(),
        }),
      ).toBeUndefined();
      expect(
        await repository.softDeleteOption({ storeId, id: theirOption.id, at: new Date() }),
      ).toBeUndefined();
      expect(
        await repository.softDeleteOptionValue({ storeId, id: theirValue.id, at: new Date() }),
      ).toBeUndefined();

      // Untouched.
      const [row] = await db()
        .select()
        .from(productOption)
        .where(eq(productOption.id, theirOption.id));
      expect(row?.name).toBe('Size');
      expect(row?.deletedAt).toBeNull();
    });

    it('scopes the delete guard and the combination loader by store', async () => {
      const { repository } = build();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirProduct = await givenProduct({ slug: 'theirs', storeId: otherStoreId });
      const theirValue = await giveValue(await giveOption(theirProduct));
      const theirSku = await giveSku(db(), theirProduct, { code: 'THEIRS-1' });
      await db().insert(skuOptionValue).values({
        skuId: theirSku.id,
        optionValueId: theirValue.id,
        optionId: theirValue.optionId,
        productId: theirProduct.id,
        storeId: otherStoreId,
      });

      // Our store must not learn that their SKU uses their value, and must not read their
      // combination — which would otherwise leak a variant grid across the tenant boundary.
      expect(
        await repository.liveSkuCodesUsingValues({ storeId, optionValueIds: [theirValue.id] }),
      ).toEqual([]);
      expect(
        await repository.liveSkuCodesUsingOption({ storeId, optionId: theirValue.optionId }),
      ).toEqual([]);
      expect(await repository.listSkuOptionsForSkus({ storeId, skuIds: [theirSku.id] })).toEqual(
        [],
      );
    });
  });
});
