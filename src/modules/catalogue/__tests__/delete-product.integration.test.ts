import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
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
 * DELETE /api/v1/admin/products/:slug — against real PostgreSQL.
 *
 * The invariant this suite exists to protect is BLAST RADIUS: deleting one product must never
 * touch another. Increment 16 found that a missing `slug` predicate is invisible to any suite
 * that keeps a single product, so every destructive case here runs against a store holding
 * several and re-reads the survivors afterwards.
 *
 * The second property is that "deleted" means invisible EVERYWHERE, not just to the endpoint
 * that deleted it — so the admin list, the admin read, the public read, and the lifecycle
 * actions are all checked after the fact.
 */
describe('DELETE /api/v1/admin/products/:slug (integration)', () => {
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
      slug?: string;
      status?: string;
      storeId?: string;
      deletedAt?: Date;
      name?: string;
      price?: string;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? SLUG,
      name: overrides.name ?? 'Blue Cotton Shirt',
      description: 'The original description.',
      status: overrides.status ?? 'active',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    // A product is only sellable through a SKU, and only publicly visible with an active
    // one — see Increment 24. Mirrors the migration's one-SKU-per-product backfill.
    await giveSku(db(), values, overrides.price === undefined ? {} : { price: overrides.price });
    return values;
  }

  const del = (app: App, slug: string, token?: string) => {
    const req = request(app).delete(`/api/v1/admin/products/${slug}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /** The complete stored row, including columns no response exposes. */
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

      const response = await del(app, SLUG);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      // Nothing was deleted.
      expect((await rowOf(created.id))?.deletedAt).toBeNull();
    });

    it('rejects an invalid access token with 401', async () => {
      const created = await givenProduct();
      const { app } = build();

      const response = await del(app, SLUG, 'not.a.jwt');

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_ACCESS_TOKEN');
      expect((await rowOf(created.id))?.deletedAt).toBeNull();
    });

    it('rejects an authenticated NON-staff customer with 403', async () => {
      const created = await givenProduct();
      const { app, identity } = build();
      const token = await signIn(app, identity);

      const response = await del(app, SLUG, token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
      expect(response.body.error.details.missing).toEqual(['staff']);
      expect((await rowOf(created.id))?.deletedAt).toBeNull();
    });

    it('allows a staff user', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      expect((await del(app, SLUG, token)).status).toBe(204);
    });

    it('denies a staff user demoted mid-session, on the next request', async () => {
      await givenProduct({ slug: 'first' });
      const second = await givenProduct({ slug: 'second' });
      const { app, token } = await staffApp();

      expect((await del(app, 'first', token)).status).toBe(204);

      await db().update(appUser).set({ isStaff: false });

      expect((await del(app, 'second', token)).status).toBe(403);
      expect((await rowOf(second.id))?.deletedAt).toBeNull();
    });
  });

  describe('the response contract', () => {
    it('returns 204 with no body', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const response = await del(app, SLUG, token);

      expect(response.status).toBe(204);
      // 204 means no body, and Express must not be sending one.
      expect(response.text).toBe('');
      expect(response.body).toEqual({});
    });

    it('ignores a request body, because the slug carries the intent', async () => {
      const created = await givenProduct();
      const other = await givenProduct({ slug: 'other-product' });
      const { app, token } = await staffApp();

      // No body schema, so nothing sent can redirect the deletion at another product.
      const response = await request(app)
        .delete(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: 'other-product', storeId: newId(), hard: true });

      expect(response.status).toBe(204);
      expect((await rowOf(created.id))?.deletedAt).not.toBeNull();
      expect((await rowOf(other.id))?.deletedAt).toBeNull();
    });

    it('rejects a malformed slug with 400', async () => {
      const { app, token } = await staffApp();

      for (const slug of ['-leading', 'double--hyphen']) {
        const response = await del(app, slug, token);
        expect(response.status, slug).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('soft delete', () => {
    it('keeps the row and stamps deleted_at', async () => {
      const created = await givenProduct();
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      await del(app, SLUG, token);
      const after = await rowOf(created.id);

      /**
       * The row SURVIVES. Order lines and invoices will reference products, so a hard delete
       * would either break those or force a cascade that rewrites history — which is exactly
       * what the schema's soft-delete helper says this column is for.
       */
      expect(after).toBeDefined();
      expect(after?.deletedAt).toBeInstanceOf(Date);
      expect(before?.deletedAt).toBeNull();
    });

    it('preserves every other column', async () => {
      const created = await givenProduct({ status: 'active' });
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      await del(app, SLUG, token);
      const after = await rowOf(created.id);

      // Deletion is not a rewrite. The record must still describe what was sold.
      expect(after?.name).toBe(before?.name);
      expect(after?.description).toBe(before?.description);
      expect(after?.slug).toBe(before?.slug);
      expect(after?.status).toBe(before?.status);
      expect(after?.storeId).toBe(before?.storeId);
      expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    });

    it('does NOT change the lifecycle status', async () => {
      const created = await givenProduct({ status: 'active' });
      const { app, token } = await staffApp();

      await del(app, SLUG, token);

      /**
       * Deletion and archiving are different operations with different meanings. Using
       * `archived` as a stand-in for deletion would make the two indistinguishable in the
       * record, and archiving is reversible (§26) while deletion is not.
       */
      expect((await rowOf(created.id))?.status).toBe('active');
    });

    it('bumps updated_at', async () => {
      const created = await givenProduct();
      const before = await rowOf(created.id);
      const { app, token } = await staffApp();

      await del(app, SLUG, token);
      const after = await rowOf(created.id);

      expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);
    });
  });

  describe('a deleted product is invisible everywhere', () => {
    it('disappears from the admin list and the total', async () => {
      await givenProduct({ slug: 'doomed' });
      await givenProduct({ slug: 'survivor' });
      const { app, token } = await staffApp();

      const before = await request(app)
        .get('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`);
      expect(before.body.pagination.total).toBe(2);

      await del(app, 'doomed', token);

      const after = await request(app)
        .get('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`);

      // Gone from the page AND from the count — a total that still said 2 would leave a client
      // paging for a product it can never see.
      expect((after.body.products as { slug: string }[]).map((p) => p.slug)).toEqual(['survivor']);
      expect(after.body.pagination.total).toBe(1);
    });

    it('disappears from the admin read', async () => {
      await givenProduct();
      const { app, token } = await staffApp();

      const read = () =>
        request(app).get(`/api/v1/admin/products/${SLUG}`).set('Authorization', `Bearer ${token}`);

      expect((await read()).status).toBe(200);
      await del(app, SLUG, token);
      // 404, indistinguishable from a slug that never existed — even to staff.
      expect((await read()).status).toBe(404);
    });

    it('disappears from the public read', async () => {
      await givenProduct({ status: 'active' });
      const { app, token } = await staffApp();

      const publicRead = () => request(app).get(`/api/v1/products/${SLUG}`);

      expect((await publicRead()).status).toBe(200);
      await del(app, SLUG, token);

      const after = await publicRead();
      expect(after.status).toBe(404);
      expect(after.body.error.code).toBe('NOT_FOUND');
      // No trace of the product in the failure body.
      expect(JSON.stringify(after.body)).not.toContain('Blue Cotton Shirt');
    });

    it('cannot be published or archived afterwards', async () => {
      await givenProduct({ status: 'draft' });
      const { app, token } = await staffApp();

      await del(app, SLUG, token);

      // The lifecycle actions filter `deleted_at IS NULL` too, so a deleted product cannot be
      // resurrected through the back door of a status change.
      for (const action of ['publish', 'archive'] as const) {
        const response = await request(app)
          .post(`/api/v1/admin/products/${SLUG}/${action}`)
          .set('Authorization', `Bearer ${token}`);
        expect(response.status, action).toBe(404);
      }
    });

    it('cannot be edited afterwards', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      await del(app, SLUG, token);

      const response = await request(app)
        .patch(`/api/v1/admin/products/${SLUG}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Resurrected' });

      expect(response.status).toBe(404);
      expect((await rowOf(created.id))?.name).toBe('Blue Cotton Shirt');
    });

    it('frees the slug for reuse', async () => {
      const original = await givenProduct();
      const { app, token } = await staffApp();

      await del(app, SLUG, token);

      /**
       * `uq_product_slug_active` is partial on `deleted_at IS NULL`, so a deleted product no
       * longer reserves its slug. Asserted because it is a real consequence of the index
       * design, not an accident — and because a merchant who deletes a mistake expects to be
       * able to recreate it under the same URL.
       */
      const recreated = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: SLUG, name: 'The Replacement' });

      expect(recreated.status).toBe(201);
      expect(recreated.body.product.id).not.toBe(original.id);
      // Both rows now exist; only the new one is visible.
      expect((await rowOf(original.id))?.deletedAt).not.toBeNull();
    });
  });

  describe('blast radius', () => {
    it('deletes ONLY the addressed product, leaving siblings byte-identical', async () => {
      const target = await givenProduct({ slug: 'the-target', name: 'Target', price: '1.0000' });
      const siblings = [
        await givenProduct({ slug: 'sibling-a', name: 'Sibling A', price: '2.0000' }),
        await givenProduct({
          slug: 'sibling-b',
          name: 'Sibling B',
          price: '3.0000',
          status: 'draft',
        }),
        await givenProduct({
          slug: 'sibling-c',
          name: 'Sibling C',
          price: '4.0000',
          status: 'archived',
        }),
      ];
      const before = await Promise.all(siblings.map((s) => rowOf(s.id)));
      const { app, token } = await staffApp();

      expect((await del(app, 'the-target', token)).status).toBe(204);

      /**
       * THE invariant. Increment 16 found that a missing `slug` predicate is invisible to a
       * suite keeping one product — here it would delete the entire catalogue. Every column of
       * every sibling is compared before and after, not merely `deletedAt`, because a mutation
       * could equally stamp the wrong column across the store.
       */
      expect((await rowOf(target.id))?.deletedAt).not.toBeNull();

      const after = await Promise.all(siblings.map((s) => rowOf(s.id)));
      for (const [i, row] of after.entries()) {
        expect(row, siblings[i]?.slug).toEqual(before[i]);
      }
    });

    it('leaves an already-deleted sibling untouched', async () => {
      const alreadyGone = await givenProduct({
        slug: 'already-gone',
        deletedAt: new Date(2020, 0, 1),
      });
      await givenProduct({ slug: 'the-target' });
      const before = await rowOf(alreadyGone.id);
      const { app, token } = await staffApp();

      await del(app, 'the-target', token);

      // The original deletion timestamp must survive — re-stamping it would destroy the record
      // of when the product actually went away.
      expect((await rowOf(alreadyGone.id))?.deletedAt?.getTime()).toBe(
        before?.deletedAt?.getTime(),
      );
    });
  });

  describe('not found', () => {
    /** Compared body-to-body, so a leak through the message cannot pass as a matching status. */
    const bodyOf = (r: { body: { error: { code: string; message: string } } }) => ({
      code: r.body.error.code,
      message: r.body.error.message,
    });

    it('returns 404 for an unknown slug in an EMPTY store', async () => {
      const { app, token } = await staffApp();

      const response = await del(app, 'never-existed', token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 404 for an unknown slug when the store HAS products', async () => {
      const existing = await givenProduct({ slug: 'a-real-product' });
      const { app, token } = await staffApp();

      /**
       * The companion to the empty-store case, and the one that matters: without a `slug`
       * predicate the statement would match whatever else the store owns and report success
       * while deleting the wrong thing.
       */
      const response = await del(app, 'never-existed', token);

      expect(response.status).toBe(404);
      expect((await rowOf(existing.id))?.deletedAt).toBeNull();
    });

    it('returns 404 when deleting an ALREADY-deleted product', async () => {
      const created = await givenProduct();
      const { app, token } = await staffApp();

      expect((await del(app, SLUG, token)).status).toBe(204);
      const afterFirst = await rowOf(created.id);

      const second = await del(app, SLUG, token);

      /**
       * NOT idempotent, and deliberately so. Every other catalogue endpoint answers 404 for a
       * deleted product, so a 204 here would contradict the very next request about it. This
       * differs from logout (§20), which IS idempotent because it must not disclose whether a
       * session was still live — there is no such secret here.
       *
       * The original `deleted_at` must also survive: re-stamping it would lose the record of
       * when the product actually went away.
       */
      expect(second.status).toBe(404);
      expect(second.body.error.code).toBe('NOT_FOUND');
      expect((await rowOf(created.id))?.deletedAt?.getTime()).toBe(
        afterFirst?.deletedAt?.getTime(),
      );
    });

    it('gives BYTE-IDENTICAL responses for unknown, cross-store, and already-deleted', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      await givenProduct({ slug: 'another-store', storeId: secondStoreId });
      await givenProduct({ slug: 'a-deleted', deletedAt: new Date() });

      const { app, token } = await staffApp();
      const responses = await Promise.all(
        ['another-store', 'a-deleted', 'never-existed'].map((slug) => del(app, slug, token)),
      );

      const [first] = responses;
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(bodyOf(response)).toEqual(bodyOf(first!));
      }
    });
  });

  describe('store isolation', () => {
    it('cannot delete a product belonging to another store', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });
      const foreign = await givenProduct({ storeId: secondStoreId, status: 'active' });
      const before = await rowOf(foreign.id);

      // Staff of store one; the product lives in store two.
      const { app, token } = await staffApp();
      const response = await del(app, SLUG, token);

      expect(response.status).toBe(404);
      // Byte-identical afterwards — not merely still present.
      expect(await rowOf(foreign.id)).toEqual(before);
    });

    it('deleting in one store does not affect the same slug in another', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      const ours = await givenProduct({ name: 'Ours' });
      const theirs = await givenProduct({ storeId: secondStoreId, name: 'Theirs' });
      const before = await rowOf(theirs.id);

      const { app, token } = await staffApp();
      expect((await del(app, SLUG, token)).status).toBe(204);

      // Same slug, two stores: only ours goes.
      expect((await rowOf(ours.id))?.deletedAt).not.toBeNull();
      expect(await rowOf(theirs.id)).toEqual(before);
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
       * service instead of the statement, this would delete another tenant's product.
       */
      const wrongStore = await repository.softDeleteProduct({
        storeId: secondStoreId,
        slug: SLUG,
        at: new Date(),
      });

      expect(wrongStore).toBeUndefined();
      expect((await rowOf(created.id))?.deletedAt).toBeNull();
    });

    it('never leaves a store with rows it did not own marked deleted', async () => {
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      await givenProduct({ slug: 'ours-one' });
      await givenProduct({ slug: 'ours-two' });
      await givenProduct({ slug: 'theirs-one', storeId: secondStoreId });
      await givenProduct({ slug: 'theirs-two', storeId: secondStoreId });

      const { app, token } = await staffApp();
      await del(app, 'ours-one', token);

      // The other tenant still has both products live, counted directly against the table.
      const live = await db()
        .select({ slug: product.slug })
        .from(product)
        .where(and(eq(product.storeId, secondStoreId), isNull(product.deletedAt)));
      expect(live.map((r) => r.slug).sort()).toEqual(['theirs-one', 'theirs-two']);
    });
  });
});
