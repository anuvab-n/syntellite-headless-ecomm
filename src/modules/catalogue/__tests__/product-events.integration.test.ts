import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { createApp } from '../../../http/app.js';
import { createScopeGuards } from '../../../http/middleware/scope.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
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

/**
 * Product domain events and audit producers — against real PostgreSQL.
 *
 * The outbox and `audit_log` were built, tested, and wired long before anything wrote to
 * them. This suite is what makes them non-vacuous, so its assertions are about the two
 * properties that were previously unenforceable:
 *
 *  1. Every product mutation writes BOTH an `outbox_event` row and an `audit_log` row, in the
 *     same transaction as the change itself. Asserted on the tables, never on a spy — a
 *     recording double would pass just as happily against a service that emitted outside the
 *     transaction, which is the failure that matters.
 *
 *  2. A ROLLED-BACK change leaves neither. This is the whole justification for the outbox
 *     pattern, and it cannot be observed at all without a failure path, so one is provoked
 *     deliberately below.
 */
describe('product events and audit (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  // No price: it moved to the SKU in Increment 24, and the product schema is strict.
  const VALID = { slug: 'blue-cotton-shirt', name: 'Blue Cotton Shirt' };

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

  function build() {
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

  async function signInAsStaff(
    app: App,
    identity: Identity,
    email = 'staff@example.com',
  ): Promise<{ token: string; userId: string }> {
    const user = await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  /* ── Table readers ─────────────────────────────────────────────────────── */

  const eventsOf = async (aggregateId?: string) => {
    const rows = await db().select().from(outboxEvent);
    return rows
      .filter((r) => aggregateId === undefined || r.aggregateId === aggregateId)
      .sort((a, b) => a.id.localeCompare(b.id));
  };

  const auditOf = async (resourceId?: string) => {
    const rows = await db().select().from(auditLog);
    return rows
      .filter((r) => resourceId === undefined || r.resourceId === resourceId)
      .sort((a, b) => a.id.localeCompare(b.id));
  };

  const productEvents = async (aggregateId: string) =>
    (await eventsOf(aggregateId)).filter((r) => r.aggregateType === 'product');

  const productAudit = async (resourceId: string) =>
    (await auditOf(resourceId)).filter((r) => r.resourceType === 'product');

  /** Create a product through HTTP, returning its id and the acting staff user. */
  async function givenCreatedProduct(app: App, identity: Identity, slug = VALID.slug) {
    const staff = await signInAsStaff(app, identity);
    const response = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ ...VALID, slug });
    expect(response.status).toBe(201);
    return { productId: response.body.product.id as string, staff };
  }

  /* ── One event and one audit entry per mutation ────────────────────────── */

  describe('product.created', () => {
    it('writes an outbox event and an audit entry', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      const events = await productEvents(productId);
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe('product.created');
      expect(events[0]?.aggregateType).toBe('product');
      expect(events[0]?.storeId).toBe(storeId);
      // Unpublished: the drainer has not run in this test, which is correct — emitting and
      // publishing are separate concerns and only the first is the service's job.
      expect(events[0]?.publishedAt).toBeNull();

      const audit = await productAudit(productId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('product.created');
      expect(audit[0]?.actorType).toBe('staff');
      expect(audit[0]?.actorUserId).toBe(staff.userId);
      expect(audit[0]?.storeId).toBe(storeId);
    });

    it('carries ids and facts in the payload, not the entity', async () => {
      const { app, identity } = build();
      const { productId } = await givenCreatedProduct(app, identity);

      const [event] = await productEvents(productId);
      const payload = event?.payload as Record<string, unknown>;

      // Exactly the declared shape. A payload that grew a serialised product would be stale
      // the moment the product changed, which is the definition of async delivery.
      expect(Object.keys(payload).sort()).toEqual(['productId', 'slug', 'status']);
      expect(payload['productId']).toBe(productId);
      expect(payload['slug']).toBe(VALID.slug);
      expect(payload['status']).toBe('draft');
    });

    it('attributes the action to the TOKEN holder, not to anyone the body names', async () => {
      const { app, identity } = build();
      const staff = await signInAsStaff(app, identity);
      const other = await identity.registerCustomer({
        storeId,
        input: { email: 'other@example.com', password: PASSWORD, firstName: 'B', lastName: 'C' },
      });

      // `actorUserId` is not a field of the DTO, so this is a 400 — but the assertion that
      // matters is that no entry could ever name the other user.
      const rejected = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ ...VALID, actorUserId: other.id });
      expect(rejected.status).toBe(400);

      const created = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${staff.token}`)
        .send(VALID);
      expect(created.status).toBe(201);

      const audit = await productAudit(created.body.product.id as string);
      expect(audit[0]?.actorUserId).toBe(staff.userId);
      expect(audit.map((r) => r.actorUserId)).not.toContain(other.id);
    });
  });

  describe('product.updated', () => {
    it('records which fields changed', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      const response = await request(app)
        .patch(`/api/v1/admin/products/${VALID.slug}`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ name: 'Renamed Shirt', description: 'A new description.' });
      expect(response.status).toBe(200);

      const updated = (await productEvents(productId)).filter(
        (r) => r.eventName === 'product.updated',
      );
      expect(updated).toHaveLength(1);
      const payload = updated[0]?.payload as Record<string, unknown>;
      // The field NAMES, so a handler can decide whether it cares — a rename needs a search
      // reindex, a description edit may not.
      expect(payload['changedFields']).toEqual(['name', 'description']);

      const audit = (await productAudit(productId)).filter((r) => r.action === 'product.updated');
      expect(audit).toHaveLength(1);
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      // The new values of the changed fields. Price is absent because a product no longer has
      // one — SKU price changes get their own `sku.price_changed` entry.
      expect(metadata['name']).toBe('Renamed Shirt');
      expect(metadata['description']).toBe('A new description.');
      expect(metadata).not.toHaveProperty('price');
      expect(metadata['changedFields']).toEqual(['name', 'description']);
    });
  });

  describe('product.published and product.archived', () => {
    it('writes an event and an audit entry for each transition', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      for (const action of ['publish', 'archive'] as const) {
        const response = await request(app)
          .post(`/api/v1/admin/products/${VALID.slug}/${action}`)
          .set('Authorization', `Bearer ${staff.token}`);
        expect(response.status, action).toBe(200);
      }

      const names = (await productEvents(productId)).map((r) => r.eventName).sort();
      expect(names).toEqual(['product.archived', 'product.created', 'product.published']);

      const actions = (await productAudit(productId)).map((r) => r.action).sort();
      expect(actions).toEqual(['product.archived', 'product.created', 'product.published']);
    });

    it('does NOT record anything for a rejected transition', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      // A draft cannot be archived (§26). The 409 must leave no trace behind.
      const response = await request(app)
        .post(`/api/v1/admin/products/${VALID.slug}/archive`)
        .set('Authorization', `Bearer ${staff.token}`);
      expect(response.status).toBe(409);

      // Only the creation event and entry exist. A rejected action that still emitted would
      // tell a handler a product had been archived when it had not.
      expect((await productEvents(productId)).map((r) => r.eventName)).toEqual(['product.created']);
      expect((await productAudit(productId)).map((r) => r.action)).toEqual(['product.created']);
    });
  });

  describe('product.deleted', () => {
    it('records the slug and name, which the row no longer usefully identifies', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      const response = await request(app)
        .delete(`/api/v1/admin/products/${VALID.slug}`)
        .set('Authorization', `Bearer ${staff.token}`);
      expect(response.status).toBe(204);

      const deleted = (await productEvents(productId)).filter(
        (r) => r.eventName === 'product.deleted',
      );
      expect(deleted).toHaveLength(1);

      const audit = (await productAudit(productId)).filter((r) => r.action === 'product.deleted');
      expect(audit).toHaveLength(1);
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      /**
       * The slug is freed for reuse by the partial unique index, so once another product
       * claims it the resource id alone no longer tells an auditor which listing this was.
       */
      expect(metadata['slug']).toBe(VALID.slug);
      expect(metadata['name']).toBe(VALID.name);
      expect(metadata['statusAtDeletion']).toBe('draft');
    });

    it('records nothing when the delete finds no product', async () => {
      const { app, identity } = build();
      const staff = await signInAsStaff(app, identity);

      const response = await request(app)
        .delete('/api/v1/admin/products/never-existed')
        .set('Authorization', `Bearer ${staff.token}`);
      expect(response.status).toBe(404);

      // No product rows means no product events or entries at all — registration's own event
      // and entry are the only ones present.
      const events = (await eventsOf()).filter((r) => r.aggregateType === 'product');
      expect(events).toEqual([]);
      const audit = (await auditOf()).filter((r) => r.resourceType === 'product');
      expect(audit).toEqual([]);
    });
  });

  /* ── Atomicity: the whole reason for the outbox ────────────────────────── */

  describe('atomicity', () => {
    it('leaves NO event and NO audit entry when the write rolls back', async () => {
      const { app, identity, catalogue } = build();
      const staff = await signInAsStaff(app, identity);
      const actor = { type: 'staff', userId: staff.userId } as const;

      await catalogue.createProduct({ storeId, actor, input: VALID });

      const eventsBefore = (await eventsOf()).length;
      const auditBefore = (await auditOf()).length;

      /**
       * Provoke a real rollback: a duplicate slug violates the unique index INSIDE the
       * transaction, after the point where an event and an entry would have been written.
       *
       * This is the assertion the whole outbox pattern exists for, and it is unobservable
       * without a failure path. If the service emitted outside its transaction, the counts
       * below would grow even though no product was created.
       */
      await expect(catalogue.createProduct({ storeId, actor, input: VALID })).rejects.toThrow();

      expect((await eventsOf()).length).toBe(eventsBefore);
      expect((await auditOf()).length).toBe(auditBefore);

      // And exactly one product exists, so the rollback was real rather than the second call
      // having been skipped.
      const products = await db().select().from(product).where(eq(product.storeId, storeId));
      expect(products).toHaveLength(1);
    });

    it('refuses to emit outside a transaction', async () => {
      const { events } = testRecorders(db());

      /**
       * The guard that makes every producer in this increment trustworthy. Without it a
       * service could emit after its commit — losing the event if the process died — and
       * nothing would fail until production.
       */
      await expect(
        events.emit({
          type: 'product.created',
          aggregateType: 'product',
          aggregateId: newId(),
          storeId,
          payload: {},
        }),
      ).rejects.toThrow(/outside a transaction/);

      expect(await eventsOf()).toEqual([]);
    });

    it('refuses to record audit outside a transaction', async () => {
      const { audit } = testRecorders(db());

      await expect(
        audit.record({
          action: 'product.created',
          actor: { type: 'system' },
          resourceType: 'product',
          resourceId: newId(),
          storeId,
        }),
      ).rejects.toThrow(/outside a transaction/);

      expect(await auditOf()).toEqual([]);
    });
  });

  /* ── Actor cannot be influenced by the client ──────────────────────────── */

  describe('actor attribution', () => {
    it('ignores a body-supplied actor on routes that do NOT validate a body', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);
      const other = await identity.registerCustomer({
        storeId,
        input: { email: 'other@example.com', password: PASSWORD, firstName: 'B', lastName: 'C' },
      });

      /**
       * The lifecycle and delete routes call `validate({ params })` only — they take no body,
       * so nothing rejects one. A body sent here reaches the handler completely unvalidated,
       * which makes this the ONE place where "trust the client's actor" would actually be
       * reachable. The create route's `strictObject` masks the same mutation with a 400.
       */
      const published = await request(app)
        .post(`/api/v1/admin/products/${VALID.slug}/publish`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ actorUserId: other.id, actor: { type: 'staff', userId: other.id } });
      expect(published.status).toBe(200);

      const entry = (await productAudit(productId)).find((r) => r.action === 'product.published');
      expect(entry?.actorUserId).toBe(staff.userId);
      expect(entry?.actorUserId).not.toBe(other.id);
    });

    it('ignores a body-supplied actor on delete', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);
      const other = await identity.registerCustomer({
        storeId,
        input: { email: 'other2@example.com', password: PASSWORD, firstName: 'B', lastName: 'C' },
      });

      const response = await request(app)
        .delete(`/api/v1/admin/products/${VALID.slug}`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ actorUserId: other.id });
      expect(response.status).toBe(204);

      const entry = (await productAudit(productId)).find((r) => r.action === 'product.deleted');
      expect(entry?.actorUserId).toBe(staff.userId);
    });
  });

  /* ── Store scoping and correlation ─────────────────────────────────────── */

  describe('scoping and correlation', () => {
    it('stamps the resolved store on both records', async () => {
      const { app, identity } = build();
      const { productId } = await givenCreatedProduct(app, identity);

      // Neither table is store-scoped by a NOT NULL column, so an omitted `store_id` would be
      // silently accepted — and a per-tenant audit query would then miss the entry entirely.
      expect((await productEvents(productId))[0]?.storeId).toBe(storeId);
      expect((await productAudit(productId))[0]?.storeId).toBe(storeId);
    });

    it('stamps the store even with NO ambient request context', async () => {
      const { app, identity, catalogue } = build();
      const staff = await signInAsStaff(app, identity);
      const actor = { type: 'staff', userId: staff.userId } as const;

      /**
       * Driven through the service with no HTTP request in flight — the shape a CLI command,
       * a seed script, or a background job would take.
       *
       * This is what makes passing `storeId` explicitly load-bearing. Inside a request the
       * event bus and audit trail fall back to `context.storeId`, which `resolveStore` sets,
       * so dropping the explicit argument is invisible over HTTP. Here there is no context to
       * fall back to, so an omitted `storeId` lands as NULL and every per-tenant audit query
       * silently misses the record.
       */
      const created = await catalogue.createProduct({
        storeId,
        actor,
        input: { ...VALID, slug: 'cli-created' },
      });

      expect((await productEvents(created.id))[0]?.storeId).toBe(storeId);
      expect((await productAudit(created.id))[0]?.storeId).toBe(storeId);
    });

    it('correlates an event and its audit entry by request id', async () => {
      const { app, identity } = build();
      const { productId } = await givenCreatedProduct(app, identity);

      const event = (await productEvents(productId))[0];
      const entry = (await productAudit(productId))[0];

      /**
       * Both carry the request id from the ambient context, so an auditor can pivot from an
       * audit entry to the event the same request emitted — and to the access log line.
       */
      expect(event?.requestId).toBeTruthy();
      expect(entry?.requestId).toBe(event?.requestId);
    });

    it('writes no credential material into audit metadata', async () => {
      const { app, identity } = build();
      const { productId, staff } = await givenCreatedProduct(app, identity);

      await request(app)
        .patch(`/api/v1/admin/products/${VALID.slug}`)
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ name: 'Renamed' });

      const serialised = JSON.stringify(await productAudit(productId));
      for (const forbidden of ['argon2', PASSWORD, staff.token, 'passwordHash', 'password_hash']) {
        expect(serialised, forbidden).not.toContain(forbidden);
      }
    });
  });

  /* ── Identity producers ────────────────────────────────────────────────── */

  describe('identity producers', () => {
    it('emits user.registered and records the signup', async () => {
      const { app } = build();

      const response = await request(app).post('/api/v1/auth/register').send({
        email: 'buyer@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(response.status).toBe(201);
      const userId = response.body.user.id as string;

      const events = (await eventsOf(userId)).filter((r) => r.aggregateType === 'app_user');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe('user.registered');
      const payload = events[0]?.payload as Record<string, unknown>;
      // The email IS carried: a welcome-email handler cannot work without it, and re-reading
      // would race a customer who changes their address in the interim.
      expect(payload['email']).toBe('buyer@example.com');
      expect(payload).not.toHaveProperty('passwordHash');
      expect(payload).not.toHaveProperty('phone');

      const audit = (await auditOf(userId)).filter((r) => r.action === 'auth.registered');
      expect(audit).toHaveLength(1);
      // Self-service signup, so the actor is the customer themselves.
      expect(audit[0]?.actorType).toBe('customer');
      expect(audit[0]?.actorUserId).toBe(userId);
    });

    it('records nothing when registration is rejected as a duplicate', async () => {
      const { app } = build();
      const body = {
        email: 'buyer@example.com',
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'L',
      };

      expect((await request(app).post('/api/v1/auth/register').send(body)).status).toBe(201);
      const eventsAfterFirst = (await eventsOf()).length;
      const auditAfterFirst = (await auditOf()).length;

      expect((await request(app).post('/api/v1/auth/register').send(body)).status).toBe(409);

      // The rejected signup must not leave a welcome email queued for an account that was
      // never created.
      expect((await eventsOf()).length).toBe(eventsAfterFirst);
      expect((await auditOf()).length).toBe(auditAfterFirst);
    });

    it('records a password change with the number of sessions it cut', async () => {
      const { app, identity } = build();
      const staff = await signInAsStaff(app, identity, 'customer@example.com');
      // A second family, so the recorded count is not trivially 1.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'customer@example.com', password: PASSWORD });

      const changed = await request(app)
        .post('/api/v1/users/me/password')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ currentPassword: PASSWORD, newPassword: 'an-even-longer-new-password' });
      expect(changed.status).toBe(204);

      const audit = (await auditOf(staff.userId)).filter(
        (r) => r.action === 'auth.password_changed',
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorType).toBe('customer');
      const metadata = audit[0]?.metadata as Record<string, unknown>;
      // The signature an investigation looks for: an unexpectedly high count means the account
      // was signed in on more devices than the owner expected.
      expect(metadata['revokedSessionCount']).toBe(2);

      // And no credential material, on the most sensitive entry in the system.
      const serialised = JSON.stringify(audit);
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain('an-even-longer-new-password');
      expect(serialised).not.toContain('argon2');
    });

    it('records nothing when the password change is rejected', async () => {
      const { app, identity } = build();
      const staff = await signInAsStaff(app, identity, 'customer@example.com');
      const auditBefore = (await auditOf()).length;

      const rejected = await request(app)
        .post('/api/v1/users/me/password')
        .set('Authorization', `Bearer ${staff.token}`)
        .send({ currentPassword: 'wrong-password-here', newPassword: 'a-long-enough-password' });
      expect(rejected.status).toBe(401);

      // A failed attempt must not produce an entry claiming the password changed.
      expect((await auditOf()).length).toBe(auditBefore);
    });
  });
});
