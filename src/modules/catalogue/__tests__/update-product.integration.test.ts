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
 * PATCH /api/v1/admin/products/:slug — against real PostgreSQL.
 *
 * Two properties carry this suite. First, what an edit must NOT be able to change: the forbidden
 * fields are asserted one at a time, and the surviving row is re-read to prove nothing moved.
 * Second, that the response is the PERSISTED row rather than an echo of the request — a
 * distinction only visible where the two differ, which is why the price normalisation case
 * matters more than it looks.
 */
describe('PATCH /api/v1/admin/products/:slug (integration)', () => {
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
    options: { staff?: boolean; email?: string } = {},
  ): Promise<string> {
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
      description: 'The original description.',
      status: overrides.status ?? 'draft',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const patch = (app: App, body: unknown, token?: string, slug = SLUG) => {
    const req = request(app).patch(`/api/v1/admin/products/${slug}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  /** The full stored row, for proving what an edit did and did not touch. */
  const rowOf = async (id: string) => {
    const [row] = await db()
      .select({
        id: product.id,
        storeId: product.storeId,
        slug: product.slug,
        name: product.name,
        description: product.description,
        status: product.status,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        deletedAt: product.deletedAt,
      })
      .from(product)
      .where(eq(product.id, id));
    return row;
  };

  const staffApp = async () => {
    const built = build();
    const token = await signIn(built.app, built.identity, { staff: true });
    return { ...built, token };
  };

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const created = await givenProduct();
      const { app } = build();

      const response = await patch(app, { name: 'Hacked' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      const created = await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity);

      const response = await patch(app, { name: 'Hacked' }, token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('denies a staff user demoted mid-session, on the next request', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      expect((await patch(app, { name: 'First' }, token)).status).toBe(200);

      await db().update(appUser).set({ isStaff: false });

      expect((await patch(app, { name: 'Second' }, token)).status).toBe(403);
      expect((await rowOf(created.id))?.name).toBe('First');
    });
  });

  describe('editing', () => {
    it('updates the name', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Green Cotton Shirt' }, token);

      expect(response.status).toBe(200);
      expect(response.body.product.name).toBe('Green Cotton Shirt');
      expect((await rowOf(created.id))?.name).toBe('Green Cotton Shirt');
      // Untouched fields keep their values — this is a PATCH, not a replace.
      expect((await rowOf(created.id))?.description).toBe('The original description.');
      expect((await rowOf(created.id))?.status).toBe('draft');
    });

    it('updates the description', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { description: 'Rewritten copy.' }, token);

      expect(response.body.product.description).toBe('Rewritten copy.');
      expect((await rowOf(created.id))?.description).toBe('Rewritten copy.');
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('clears the description with an empty string', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { description: '' }, token);

      // An empty string is a legitimate value, not an omission — `null` is what is rejected.
      expect(response.status).toBe(200);
      expect((await rowOf(created.id))?.description).toBe('');
    });

    it('REJECTS a price, which now belongs to the SKU', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { price: '1599.50' }, token);

      /**
       * The migration contract test. Price moved to the SKU, and the body is a
       * `strictObject`, so a stale client is told rather than silently ignored — which would
       * leave a merchant believing they had repriced something.
       *
       * `PATCH /admin/skus/:code` is where a price is edited now, and the SKU suite asserts
       * the persisted-not-submitted normalisation that used to live here.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('price');
      // Nothing changed, including the name it was not asked to change.
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('updates several fields at once', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'New Name', description: 'New copy.' }, token);

      expect(response.status).toBe(200);
      const row = await rowOf(created.id);
      expect(row?.name).toBe('New Name');
      expect(row?.description).toBe('New copy.');
    });

    it('edits ONLY the addressed product, leaving siblings untouched', async () => {
      const target = await givenProduct({ slug: 'the-target' });
      const sibling = await givenProduct({ slug: 'the-sibling' });
      const third = await givenProduct({ slug: 'the-third' });
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token, 'the-target');

      /**
       * Added after mutation testing found this gap: removing `slug` from the UPDATE predicate
       * passed all 37 other tests, because every one of them had a single product in the store.
       * Without that predicate the statement matches every non-deleted row the store owns, so a
       * PATCH to one product silently rewrites the entire catalogue — the worst possible
       * outcome, and invisible to a suite that never keeps two products at once.
       */
      expect(response.status).toBe(200);
      expect(response.body.product.slug).toBe('the-target');
      expect((await rowOf(target.id))?.name).toBe('Edited');

      for (const untouched of [sibling, third]) {
        const row = await rowOf(untouched.id);
        expect(row?.name, untouched.slug).toBe('Blue Cotton Shirt');
      }
    });

    it('returns 404 for an unknown slug even when the store HAS products', async () => {
      const existing = await givenProduct({ slug: 'a-real-product' });
      const { app, token } = await staffApp();

      // The companion to the empty-store case: an unmatched slug must not fall through to
      // whatever else the store happens to own.
      const response = await patch(app, { name: 'Hacked' }, token, 'never-existed');

      expect(response.status).toBe(404);
      expect((await rowOf(existing.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('trims whitespace, matching the create endpoint', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      await patch(app, { name: '  Padded Name  ' }, token);

      // The shared field primitives are what guarantee this: a PATCH must not be able to store
      // a value the create endpoint would have normalised.
      expect((await rowOf(created.id))?.name).toBe('Padded Name');
    });
  });

  describe('lifecycle is preserved', () => {
    it.each(['draft', 'active', 'archived'])(
      'leaves a %s product in that status',
      async (status) => {
        const created = await givenProduct({ status });
        const { app, token } = await staffApp();

        const response = await patch(app, { name: 'Edited' }, token);

        /**
         * Editing must not publish or unpublish. `status` is not expressible in the update
         * type at all, so this is preserved by construction — but a test is what proves the
         * construction holds end to end.
         */
        expect(response.status).toBe(200);
        expect(response.body.product.status).toBe(status);
        expect((await rowOf(created.id))?.status).toBe(status);
      },
    );
  });

  describe('forbidden fields', () => {
    it.each([
      ['storeId', { storeId: '00000000-0000-0000-0000-000000000000' }],
      ['slug', { slug: 'a-new-slug' }],
      ['status', { status: 'active' }],
      ['deletedAt', { deletedAt: '2026-01-01T00:00:00.000Z' }],
      ['id', { id: '00000000-0000-0000-0000-000000000000' }],
      ['currency', { currency: 'USD' }],
      ['createdAt', { createdAt: '2026-01-01T00:00:00.000Z' }],
      ['updatedAt', { updatedAt: '2026-01-01T00:00:00.000Z' }],
      ['an unknown field', { colour: 'blue' }],
    ])('rejects %s with 400', async (_label, extra) => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      // Paired with a VALID field, so a 400 proves the forbidden key was rejected rather than
      // the request merely being empty.
      const response = await patch(app, { name: 'Edited', ...extra }, token);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      // And nothing changed — not even the legitimate field alongside it.
      const row = await rowOf(created.id);
      expect(row?.name).toBe('Blue Cotton Shirt');
      expect(row?.slug).toBe(SLUG);
      expect(row?.status).toBe('draft');
      expect(row?.storeId).toBe(storeId);
      expect(row?.deletedAt).toBeNull();
    });

    it('names the rejected field in the error details', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited', status: 'active' }, token);

      // A 400 that does not say which field is unhelpful; a caller sending `status` is either
      // probing or confused, and both deserve to be told plainly.
      expect(JSON.stringify(response.body.error.details)).toContain('status');
    });
  });

  describe('validation', () => {
    it('rejects an empty body with 400, without touching the row', async () => {
      const created = await givenProduct();
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      const response = await patch(app, {}, token);
      const after = await rowOf(created.id);

      /**
       * A PATCH that asks for nothing would bump `updated_at`, return 200, and leave a caller
       * believing something changed. Rejecting it removes a silent no-op.
       *
       * `updatedAt` is compared BEFORE against AFTER — the first version of this assertion
       * compared the row to itself and was true by construction whatever the endpoint did.
       */
      expect(response.status).toBe(400);
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
      expect(after?.name).toBe('Blue Cotton Shirt');
    });

    it('rejects invalid names', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      for (const name of ['', '   ', 'x'.repeat(301), null, 42, {}]) {
        const response = await patch(app, { name }, token);
        expect(response.status, JSON.stringify(name)).toBe(400);
      }
    });

    it('rejects invalid descriptions', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      // `null` is rejected while `''` is accepted — clearing is done with an empty string.
      for (const description of [null, 42, 'x'.repeat(10_001), []]) {
        const response = await patch(app, { description }, token);
        expect(response.status, JSON.stringify(description)).toBe(400);
      }
    });

    it('rejects any price value, valid or not — the field moved to the SKU', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      // Including the WELL-FORMED '1499.00': the field is unreachable now, not merely
      // validated. A schema that still accepted it would be a silent no-op.
      for (const price of ['1499.00', 'abc', '-1.00', '1.000005', '', '1e5', null, 1499.0]) {
        const response = await patch(app, { price }, token);
        expect(response.status, JSON.stringify(price)).toBe(400);
      }
    });

    it('rejects a malformed slug in the path', async () => {
      const { app, token } = await staffApp();

      for (const slug of ['-leading', 'double--hyphen']) {
        const response = await patch(app, { name: 'Edited' }, token, slug);
        expect(response.status, slug).toBe(400);
      }
    });
  });

  describe('not found', () => {
    /** Compared body-to-body, so a leak through the message cannot pass as a matching status. */
    const bodyOf = (r: { body: { error: { code: string; message: string } } }) => ({
      code: r.body.error.code,
      message: r.body.error.message,
    });

    it('returns 404 for an unknown slug', async () => {
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token, 'never-existed');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for a product in another store, leaving it unchanged', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      const foreign = await givenProduct({ storeId: secondStoreId, status: 'active' });

      const { app, token } = await staffApp();
      const response = await patch(app, { name: 'Hacked' }, token);

      expect(response.status).toBe(404);
      // The other tenant's row is untouched — asserted, not assumed.
      const row = await rowOf(foreign.id);
      expect(row?.name).toBe('Blue Cotton Shirt');
      expect(row?.status).toBe('active');
    });

    it('returns 404 for a soft-deleted product, leaving it unchanged', async () => {
      const deleted = await givenProduct({ deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Hacked' }, token);

      expect(response.status).toBe(404);
      expect((await rowOf(deleted.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('gives BYTE-IDENTICAL responses for unknown, cross-store, and deleted', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ slug: 'another-store', storeId: secondStoreId });
      await givenProduct({ slug: 'a-deleted', deletedAt: new Date() });

      const { app, token } = await staffApp();
      const responses = await Promise.all(
        ['another-store', 'a-deleted', 'never-existed'].map((slug) =>
          patch(app, { name: 'Edited' }, token, slug),
        ),
      );

      const [first] = responses;
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(bodyOf(response)).toEqual(bodyOf(first!));
      }
    });

    it('scopes the UPDATE in the repository, not only in the route', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      const created = await givenProduct();

      /**
       * Called directly, bypassing every middleware. If the store predicate lived in the
       * service instead of the statement, this would mutate another tenant's row.
       */
      const wrongStore = await repository.updateProductFields({
        storeId: secondStoreId,
        slug: SLUG,
        fields: { name: 'Hacked' },
        at: new Date(),
      });

      expect(wrongStore).toBeUndefined();
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });
  });

  describe('response and persistence', () => {
    it('returns exactly the shared product shape', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token);

      expect(Object.keys(response.body)).toEqual(['product']);
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

    it('leaks no internal fields', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token);

      for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
        expect(response.body.product, field).not.toHaveProperty(field);
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('leaves id, storeId, slug, currency, and createdAt unchanged', async () => {
      const created = await givenProduct();
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token);
      const after = await rowOf(created.id);

      expect(after?.id).toBe(before?.id);
      expect(after?.storeId).toBe(before?.storeId);
      expect(after?.slug).toBe(before?.slug);
      expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
      expect(after?.deletedAt).toBeNull();
      // Currency is the store's and has no product column; the response reports it unchanged.
      expect(response.body.product.currency).toBe('INR');
    });

    it('advances updatedAt', async () => {
      const created = await givenProduct();
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      const response = await patch(app, { name: 'Edited' }, token);
      const after = await rowOf(created.id);

      expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
      // The response reports the same instant the database stored, not a separately computed one.
      expect(response.body.product.updatedAt).toBe(after?.updatedAt.toISOString());
    });
  });
});
