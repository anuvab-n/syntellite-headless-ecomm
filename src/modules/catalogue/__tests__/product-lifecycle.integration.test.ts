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
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCatalogueRepository } from '../catalogue.repository.js';
import { createCatalogueRoutes } from '../catalogue.routes.js';
import { createCatalogueService } from '../catalogue.service.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';

/**
 * Product lifecycle — publish and archive, against real PostgreSQL.
 *
 * Two properties carry the increment. First, a transition either happens or is rejected, never
 * silently no-ops — so an invalid transition is asserted as a 409 rather than merely "not 200".
 * Second, the lifecycle actually drives public visibility: publishing and archiving are checked
 * through `GET /products/:slug`, not just against the status column.
 */
describe('product lifecycle (integration)', () => {
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
      passwordResets: createPasswordResetRepository({ db: db() }),
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

  const act = (app: App, action: 'publish' | 'archive', slug: string, token?: string) => {
    const req = request(app).post(`/api/v1/admin/products/${slug}/${action}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const publicRead = (app: App, slug: string) => request(app).get(`/api/v1/products/${slug}`);

  const statusOf = async (id: string) => {
    const [row] = await db()
      .select({ status: product.status, updatedAt: product.updatedAt })
      .from(product)
      .where(eq(product.id, id));
    return row;
  };

  describe('authorization', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const created = await givenProduct();
      const { app } = build();

      for (const action of ['publish', 'archive'] as const) {
        const response = await act(app, action, SLUG);
        expect(response.status, action).toBe(401);
        expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      }
      // A rejected request changes nothing.
      expect((await statusOf(created.id))?.status).toBe('draft');
    });

    it('rejects an authenticated NON-staff user with 403', async () => {
      const created = await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity);

      const response = await act(app, 'publish', SLUG, token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect((await statusOf(created.id))?.status).toBe('draft');
    });

    it('allows a staff user', async () => {
      await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      expect((await act(app, 'publish', SLUG, token)).status).toBe(200);
    });

    it('denies a staff user demoted mid-session, on the next request', async () => {
      await givenProduct({ slug: 'first' });
      await givenProduct({ slug: 'second' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      expect((await act(app, 'publish', 'first', token)).status).toBe(200);

      await db().update(appUser).set({ isStaff: false });

      // Same token, still cryptographically valid — the guard re-reads the database.
      expect((await act(app, 'publish', 'second', token)).status).toBe(403);
    });
  });

  describe('publish', () => {
    it('moves a draft to active and persists it', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', SLUG, token);

      expect(response.status).toBe(200);
      expect(response.body.product.status).toBe('active');
      expect((await statusOf(created.id))?.status).toBe('active');
    });

    it('makes the product publicly readable', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      // Invisible beforehand — the public read's own contract.
      expect((await publicRead(app, SLUG)).status).toBe(404);

      await act(app, 'publish', SLUG, token);

      /**
       * The lifecycle is only meaningful if it drives visibility. Asserting the status column
       * alone would pass against an implementation that wrote a status the public read does
       * not recognise.
       */
      const read = await publicRead(app, SLUG);
      expect(read.status).toBe(200);
      expect(read.body.product.status).toBe('active');
    });

    it('restores an archived product', async () => {
      const created = await givenProduct({ status: 'archived' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      /**
       * Archiving is reversible on purpose. It is currently the only way to remove a product
       * from a storefront — there is no delete endpoint — so a terminal `archived` would let
       * one mis-click destroy a listing with no recovery path in the API.
       */
      expect((await act(app, 'publish', SLUG, token)).status).toBe(200);
      expect((await statusOf(created.id))?.status).toBe('active');
      expect((await publicRead(app, SLUG)).status).toBe(200);
    });

    it('rejects publishing an already-active product with 409', async () => {
      const created = await givenProduct({ status: 'active' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', SLUG, token);

      /**
       * 409, not a silent success. Reporting 200 for a no-op would tell a caller their request
       * changed something when it did not — and would hide a double-submit rather than surface
       * it. The current and requested statuses are named, which is safe on a staff-scoped
       * endpoint: an administrator is entitled to know their own catalogue's state.
       */
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(response.body.error.details.from).toBe('active');
      expect(response.body.error.details.to).toBe('active');
      expect((await statusOf(created.id))?.status).toBe('active');
    });
  });

  describe('archive', () => {
    it('moves an active product to archived and persists it', async () => {
      const created = await givenProduct({ status: 'active' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'archive', SLUG, token);

      expect(response.status).toBe(200);
      expect(response.body.product.status).toBe('archived');
      expect((await statusOf(created.id))?.status).toBe('archived');
    });

    it('removes the product from the storefront', async () => {
      await givenProduct({ status: 'active' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      expect((await publicRead(app, SLUG)).status).toBe(200);

      await act(app, 'archive', SLUG, token);

      // Back to the public read's ordinary 404 — indistinguishable from never having existed.
      const read = await publicRead(app, SLUG);
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects archiving an already-archived product with 409', async () => {
      const created = await givenProduct({ status: 'archived' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'archive', SLUG, token);

      expect(response.status).toBe(409);
      expect(response.body.error.details.from).toBe('archived');
      expect((await statusOf(created.id))?.status).toBe('archived');
    });

    it('rejects archiving a DRAFT with 409', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      /**
       * A draft is already invisible to customers, so there is nothing to withdraw. Supporting
       * it would add a transition nothing has asked for; rejecting it keeps the lifecycle
       * small and explicit.
       */
      const response = await act(app, 'archive', SLUG, token);
      expect(response.status).toBe(409);
      expect(response.body.error.details.from).toBe('draft');
      expect((await statusOf(created.id))?.status).toBe('draft');
    });
  });

  describe('there is no unpublish', () => {
    it('exposes no endpoint that returns a product to draft', async () => {
      await givenProduct({ status: 'active' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      /**
       * Explicit action endpoints make an unpublish UNREPRESENTABLE rather than merely
       * rejected — there is no route to call. That is the reason this design was chosen over
       * `PATCH .../status`, where `{"status":"draft"}` would be a request the server must
       * validate and refuse.
       */
      for (const path of [
        `/api/v1/admin/products/${SLUG}/unpublish`,
        `/api/v1/admin/products/${SLUG}/draft`,
        `/api/v1/admin/products/${SLUG}/status`,
      ]) {
        const response = await request(app)
          .post(path)
          .set('Authorization', `Bearer ${token}`)
          .send({ status: 'draft' });
        expect(response.status, path).toBe(404);
      }
    });
  });

  describe('store isolation', () => {
    it('cannot change a product belonging to another store', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      const foreign = await givenProduct({ storeId: secondStoreId, status: 'draft' });

      // Staff in store one; the product lives in store two.
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', SLUG, token);

      /**
       * 404, identical to a slug that never existed. `NotFound`'s own contract is that
       * ownership belongs in the query — confirming the product exists elsewhere would leak
       * across a tenant boundary, and a 403 here would do exactly that.
       */
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      // And store two's product is untouched.
      expect((await statusOf(foreign.id))?.status).toBe('draft');
    });

    it('enforces the store boundary in the UPDATE, not in the service', async () => {
      const { repository } = build();
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'third', name: 'Third', isActive: true });
      const created = await givenProduct({ status: 'draft' });

      /**
       * Called directly, bypassing every middleware. If the store predicate lived in the
       * service instead of the statement, this would mutate another tenant's row.
       */
      const wrongStore = await repository.transitionStatus({
        storeId: secondStoreId,
        slug: SLUG,
        from: ['draft'],
        to: 'active',
        at: new Date(),
      });

      expect(wrongStore).toBeUndefined();
      expect((await statusOf(created.id))?.status).toBe('draft');
    });
  });

  describe('soft-deleted products', () => {
    it('cannot be published or archived', async () => {
      const deleted = await givenProduct({ status: 'draft', deletedAt: new Date() });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      // 404, not 409: a deleted product is gone, not merely in the wrong state.
      expect((await act(app, 'publish', SLUG, token)).status).toBe(404);
      expect((await statusOf(deleted.id))?.status).toBe('draft');

      await db().update(product).set({ status: 'active' }).where(eq(product.id, deleted.id));
      expect((await act(app, 'archive', SLUG, token)).status).toBe(404);
      expect((await statusOf(deleted.id))?.status).toBe('active');
    });
  });

  describe('validation and not-found', () => {
    it('returns 404 for an unknown slug', async () => {
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', 'never-existed', token);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed slug with 400', async () => {
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      for (const slug of ['-leading', 'double--hyphen']) {
        const response = await act(app, 'publish', slug, token);
        expect(response.status, slug).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('ignores a request body, because the action carries the intent', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      // No body schema, so nothing sent can redirect the transition.
      const response = await request(app)
        .post(`/api/v1/admin/products/${SLUG}/publish`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'archived', storeId: newId() });

      expect(response.status).toBe(200);
      expect((await statusOf(created.id))?.status).toBe('active');
    });
  });

  describe('response shape', () => {
    it('returns exactly the shared product shape', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', SLUG, token);

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
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const response = await act(app, 'publish', SLUG, token);

      for (const field of ['storeId', 'store_id', 'deletedAt', 'deleted_at']) {
        expect(response.body.product, field).not.toHaveProperty(field);
      }
      expect(JSON.stringify(response.body)).not.toContain(storeId);
    });

    it('bumps updatedAt', async () => {
      const created = await givenProduct({ status: 'draft' });
      const before = await statusOf(created.id);
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      await act(app, 'publish', SLUG, token);
      const after = await statusOf(created.id);

      expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
    });
  });

  describe('concurrency', () => {
    it('lets only ONE of two simultaneous publishes succeed', async () => {
      await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      /**
       * The CONTRACT: one caller wins, the other is told the transition no longer applies.
       *
       * This asserts the contract, not the atomicity. Verified by mutation: replacing the
       * atomic UPDATE with a read-then-write left THIS test passing, because two `Promise.all`
       * requests through supertest do not reliably overlap enough to race. The guarantee is
       * pinned by the repository-level test below, which caught that mutation every time.
       *
       * Kept because the observable behaviour is worth asserting — but a reader should not
       * mistake it for proof that the update is atomic.
       */
      const [first, second] = await Promise.all([
        act(app, 'publish', SLUG, token),
        act(app, 'publish', SLUG, token),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);
    });

    it('applies the transition exactly once at the repository', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { repository } = build();

      /**
       * THE atomicity guarantee, and the test that actually enforces it.
       *
       * Driven through the repository so the two statements genuinely overlap, with no HTTP
       * stack in between to serialise them. Verified by mutation: a read-then-write
       * implementation returns TWO rows here — both callers believing they performed the
       * transition — and this is the only test in the suite that catches it.
       */
      const results = await Promise.all([
        repository.transitionStatus({
          storeId,
          slug: SLUG,
          from: ['draft'],
          to: 'active',
          at: new Date(),
        }),
        repository.transitionStatus({
          storeId,
          slug: SLUG,
          from: ['draft'],
          to: 'active',
          at: new Date(),
        }),
      ]);

      // Exactly one row returned; the other matched nothing.
      expect(results.filter((r) => r !== undefined)).toHaveLength(1);
      expect((await statusOf(created.id))?.status).toBe('active');
    });

    it('lets a publish and an archive race without producing an inconsistent state', async () => {
      const created = await givenProduct({ status: 'draft' });
      const { app, identity } = build();
      const token = await signIn(app, identity, { staff: true });

      const [publish, archive] = await Promise.all([
        act(app, 'publish', SLUG, token),
        act(app, 'archive', SLUG, token),
      ]);

      /**
       * TWO outcomes are legitimate here, and asserting either one specifically would be a
       * flaky test — as it was: this originally pinned `archive = 409`, passed in isolation,
       * and failed in a full-suite run where the timing differed.
       *
       *  - archive evaluates first or concurrently: it sees `draft`, which it cannot act on,
       *    so it is refused and the product ends `active`.
       *  - archive evaluates after publish commits: it sees `active`, succeeds, and the
       *    product ends `archived`.
       *
       * What must hold in EITHER case is the invariant: publish always succeeds from `draft`,
       * and the stored status matches exactly the transitions that reported success — never a
       * third value produced by interleaving, and never a success that did not take effect.
       */
      expect(publish.status).toBe(200);
      expect([200, 409]).toContain(archive.status);

      const finalStatus = (await statusOf(created.id))?.status;
      expect(finalStatus).toBe(archive.status === 200 ? 'archived' : 'active');
    });
  });
});
