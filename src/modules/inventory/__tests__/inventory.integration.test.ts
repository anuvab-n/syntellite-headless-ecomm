import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { product, sku } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { stockItem, stockLedger } from '../../../db/schema/inventory.js';
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
import { createInventoryRepository } from '../inventory.repository.js';
import { createInventoryRoutes } from '../inventory.routes.js';
import { createInventoryService } from '../inventory.service.js';

/**
 * Inventory — against real PostgreSQL.
 *
 * Four properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **The atomic statement is the concurrency mechanism.** Proven under genuine concurrency
 *     with separate pool connections, not by reading the code. The lost-update and
 *     oversubscription tests MUST fail if the statement is replaced by read-modify-write —
 *     that shape was measured producing 15 from two concurrent `+5` on 10, and losing four
 *     units on two concurrent `-4` from 5 while reporting BOTH as successes.
 *
 *  2. **The DATABASE enforces the invariants.** Every CHECK and every composite FK is asserted
 *     by NAME from direct SQL, because a test that only speaks HTTP cannot tell an application
 *     check from a database one.
 *
 *  3. **The ledger and the projection cannot diverge.** They are written in one transaction,
 *     proven by provoking a real rollback, and `SUM(delta) = on_hand` is asserted after a long
 *     random sequence.
 *
 *  4. **The ledger is append-only and outlives its SKU.** No route writes it except the
 *     adjustment, and deleting a SKU or its product leaves it intact.
 */
describe('inventory (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const SLUG = 'blue-cotton-shirt';
  const CODE = 'SHIRT-BLUE-M';

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
    const repository = createInventoryRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const inventory = createInventoryService({
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
      createInventoryRoutes({
        inventory,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      inventory,
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
    overrides: { slug?: string; storeId?: string; deletedAt?: Date } = {},
  ) {
    const values = {
      id: newId(),
      storeId: overrides.storeId ?? storeId,
      slug: overrides.slug ?? SLUG,
      name: 'Blue Cotton Shirt',
      description: '',
      status: 'active',
      ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    };
    await db().insert(product).values(values);
    return values;
  }

  /**
   * A SKU with a stock row, exactly as the migration would have left it.
   *
   * `onHand` is written directly rather than through an adjustment where a test needs a
   * starting balance, so the ledger contains only the movements the test itself makes and an
   * assertion about ledger length means what it says.
   */
  async function givenStock(
    overrides: {
      code?: string;
      onHand?: number;
      reserved?: number;
      isActive?: boolean;
      deletedAt?: Date | null;
      storeId?: string;
      productSlug?: string;
    } = {},
  ) {
    const owningStore = overrides.storeId ?? storeId;
    const parent = await givenProduct({
      slug: overrides.productSlug ?? `p-${overrides.code ?? CODE}`.toLowerCase(),
      storeId: owningStore,
    });
    const created = await giveSku(db(), parent, {
      code: overrides.code ?? CODE,
      ...(overrides.isActive === undefined ? {} : { isActive: overrides.isActive }),
      deletedAt: overrides.deletedAt ?? null,
    });

    await db()
      .insert(stockItem)
      .values({
        skuId: created.id,
        storeId: owningStore,
        onHand: overrides.onHand ?? 0,
        reserved: overrides.reserved ?? 0,
      });

    return { ...created, storeId: owningStore, productId: parent.id };
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const listInventory = (app: App, token?: string, query = '') => {
    const req = request(app).get(`/api/v1/admin/inventory${query}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const adjust = (app: App, body: unknown, token?: string) => {
    const req = request(app).post('/api/v1/admin/inventory/adjustments');
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const history = (app: App, code: string, token?: string, query = '') => {
    const req = request(app).get(`/api/v1/admin/inventory/${code}/history${query}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── Row readers ───────────────────────────────────────────────────────── */

  const stockRow = async (skuId: string) => {
    const [row] = await db().select().from(stockItem).where(eq(stockItem.skuId, skuId));
    return row;
  };

  const ledgerRows = async (skuId: string) =>
    db()
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.skuId, skuId))
      .orderBy(stockLedger.createdAt, stockLedger.id);

  const eventsFor = async (aggregateType: string) =>
    (await db().select().from(outboxEvent)).filter((r) => r.aggregateType === aggregateType);

  const auditFor = async (resourceType: string) =>
    (await db().select().from(auditLog)).filter((r) => r.resourceType === resourceType);

  /** Typed readers, because supertest hands back `any`. */
  const codesOf = (body: { inventory: { skuCode: string }[] }): string[] =>
    body.inventory.map((r) => r.skuCode);

  const deltasOf = (body: { history: { delta: number }[] }): number[] =>
    body.history.map((r) => r.delta);

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
    it('rejects unauthenticated requests on every inventory route', async () => {
      await givenStock();
      const { app } = build();

      for (const response of [
        await listInventory(app),
        await adjust(app, { skuCode: CODE, delta: 1, reason: 'manual_increase' }),
        await history(app, CODE),
      ]) {
        expect(response.status).toBe(401);
      }
    });

    it('rejects a non-staff caller, and writes nothing', async () => {
      const created = await givenStock({ onHand: 5 });
      const built = build();
      const { token } = await signIn(built.app, built.identity);
      const { app } = built;

      for (const response of [
        await listInventory(app, token),
        await adjust(app, { skuCode: CODE, delta: 1, reason: 'manual_increase' }, token),
        await history(app, CODE, token),
      ]) {
        expect(response.status).toBe(403);
      }

      expect((await stockRow(created.id))?.onHand).toBe(5);
      expect(await ledgerRows(created.id)).toEqual([]);
    });
  });

  /* ── Initialisation ────────────────────────────────────────────────────── */

  describe('initialisation', () => {
    it('starts a SKU at zero with available equal to on_hand', async () => {
      const created = await givenStock();

      const row = await stockRow(created.id);
      expect(row?.onHand).toBe(0);
      expect(row?.reserved).toBe(0);
      // Generated by PostgreSQL, never computed by the application.
      expect(row?.available).toBe(0);
    });

    it('keeps available equal to on_hand - reserved for any values', async () => {
      const created = await givenStock({ onHand: 10, reserved: 4 });

      expect((await stockRow(created.id))?.available).toBe(6);
    });

    it('initialises a SKU created AFTER the migration, on first adjustment', async () => {
      /**
       * The migration gave every SKU that existed at the time a row. A SKU created afterwards
       * has none — and adjusting it must still work, or a merchant sees a 404 for a SKU plainly
       * visible in the catalogue. The service initialises it inside the same transaction.
       */
      const parent = await givenProduct();
      const created = await giveSku(db(), parent, { code: 'FRESH-1' });
      expect(await stockRow(created.id)).toBeUndefined();

      const { app, token } = await staffApp();
      const response = await adjust(
        app,
        { skuCode: 'FRESH-1', delta: 7, reason: 'manual_increase' },
        token,
      );

      expect(response.status).toBe(201);
      expect(response.body.inventory.onHand).toBe(7);
      // The ledger records the movement from zero, not a fabricated opening balance.
      const entries = await ledgerRows(created.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.onHandBefore).toBe(0);
      expect(entries[0]?.onHandAfter).toBe(7);
    });

    it('does NOT create a row for an unknown or deleted SKU', async () => {
      const parent = await givenProduct();
      const gone = await giveSku(db(), parent, { code: 'GONE-1', deletedAt: new Date() });
      const { app, token } = await staffApp();

      expect(
        (await adjust(app, { skuCode: 'NO-SUCH', delta: 1, reason: 'manual_increase' }, token))
          .status,
      ).toBe(404);
      expect(
        (await adjust(app, { skuCode: 'GONE-1', delta: 1, reason: 'manual_increase' }, token))
          .status,
      ).toBe(404);

      expect(await stockRow(gone.id)).toBeUndefined();
      expect(await db().select().from(stockItem)).toEqual([]);
    });
  });

  /* ── GET /admin/inventory ──────────────────────────────────────────────── */

  describe('list', () => {
    it('returns an exact response key set', async () => {
      await givenStock({ onHand: 3 });
      const { app, token } = await staffApp();

      const response = await listInventory(app, token);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['inventory', 'pagination']);
      expect(Object.keys(response.body.inventory[0]).sort()).toEqual([
        'available',
        'createdAt',
        'onHand',
        'reserved',
        'skuCode',
        'skuId',
        'updatedAt',
      ]);
      // `storeId` must never appear: tenancy is not a client-visible field.
      expect(Object.keys(response.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
    });

    it('excludes deleted SKUs and INCLUDES inactive ones', async () => {
      await givenStock({ code: 'LIVE-1' });
      await givenStock({ code: 'OFF-1', isActive: false });
      await givenStock({ code: 'GONE-1', deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await listInventory(app, token);

      /**
       * Deactivation means "not sellable", not "not stocked". A merchant managing stock needs
       * to see everything they hold, which is the same reasoning that lets an inactive SKU be
       * adjusted.
       */
      expect(codesOf(response.body).sort()).toEqual(['LIVE-1', 'OFF-1']);
      expect(response.body.pagination.total).toBe(2);
    });

    it('pages with a total under the same rules as the page', async () => {
      for (const code of ['A-1', 'B-2', 'C-3']) await givenStock({ code });
      await givenStock({ code: 'D-4', deletedAt: new Date() });
      const { app, token } = await staffApp();

      const page = await listInventory(app, token, '?limit=2&offset=0');
      expect(codesOf(page.body)).toEqual(['A-1', 'B-2']);
      // The total counts live rows only — the identical predicate as the page.
      expect(page.body.pagination.total).toBe(3);

      const second = await listInventory(app, token, '?limit=2&offset=2');
      expect(codesOf(second.body)).toEqual(['C-3']);
      expect(second.body.pagination.total).toBe(3);
    });

    it('does not duplicate a row when a product has several SKUs', async () => {
      /**
       * The join to `sku` is one-to-one — both sides are primary keys — so it cannot multiply
       * rows the way a product/SKU join would. Asserted because a JOIN that duplicates is
       * exactly the mutation this guards against, and `total` would inflate with it.
       */
      const parent = await givenProduct();
      for (const code of ['V-1', 'V-2', 'V-3']) {
        const created = await giveSku(db(), parent, { code });
        await db().insert(stockItem).values({ skuId: created.id, storeId, onHand: 1 });
      }
      const { app, token } = await staffApp();

      const response = await listInventory(app, token);
      expect(codesOf(response.body)).toEqual(['V-1', 'V-2', 'V-3']);
      expect(response.body.pagination.total).toBe(3);
    });

    it('rejects an unknown query parameter and a malformed page', async () => {
      const { app, token } = await staffApp();

      // `strictObject`: `?limitt=50` must not silently return a default page.
      expect((await listInventory(app, token, '?limitt=50')).status).toBe(400);
      expect((await listInventory(app, token, '?storeId=' + newId())).status).toBe(400);
      expect((await listInventory(app, token, '?limit=0')).status).toBe(400);
      expect((await listInventory(app, token, '?limit=101')).status).toBe(400);
      expect((await listInventory(app, token, '?limit=')).status).toBe(400);
      expect((await listInventory(app, token, '?offset=-1')).status).toBe(400);
      expect((await listInventory(app, token, '?limit=2.5')).status).toBe(400);
    });

    it('shows only this store’s stock', async () => {
      await givenStock({ code: 'MINE-1' });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      await givenStock({ code: 'THEIRS-1', storeId: otherStoreId, productSlug: 'their-shirt' });
      const { app, token } = await staffApp();

      const response = await listInventory(app, token);
      expect(codesOf(response.body)).toEqual(['MINE-1']);
      expect(response.body.pagination.total).toBe(1);
    });
  });

  /* ── Adjustment ────────────────────────────────────────────────────────── */

  describe('adjustment', () => {
    it('applies a positive delta and returns both the stock and the entry', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: CODE, delta: 5, reason: 'manual_increase', note: 'Delivery arrived' },
        token,
      );

      expect(response.status).toBe(201);
      expect(Object.keys(response.body).sort()).toEqual(['adjustment', 'inventory']);
      expect(response.body.inventory.onHand).toBe(15);
      expect(response.body.inventory.available).toBe(15);
      expect(response.body.adjustment.delta).toBe(5);
      expect(response.body.adjustment.onHandBefore).toBe(10);
      expect(response.body.adjustment.onHandAfter).toBe(15);
      expect(response.body.adjustment.note).toBe('Delivery arrived');
      expect((await stockRow(created.id))?.onHand).toBe(15);
    });

    it('applies a negative delta', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: CODE, delta: -4, reason: 'manual_decrease' },
        token,
      );

      expect(response.status).toBe(201);
      expect(response.body.inventory.onHand).toBe(6);
      expect(response.body.adjustment.onHandBefore).toBe(10);
      expect((await stockRow(created.id))?.onHand).toBe(6);
    });

    it('allows a decrement to exactly zero', async () => {
      await givenStock({ onHand: 4 });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: CODE, delta: -4, reason: 'manual_decrease' },
        token,
      );

      // Zero is legal; negative is not. The boundary must be inclusive.
      expect(response.status).toBe(201);
      expect(response.body.inventory.onHand).toBe(0);
    });

    it('returns an exact adjustment key set', async () => {
      await givenStock({ onHand: 1 });
      const { app, token } = await staffApp();

      const response = await adjust(app, { skuCode: CODE, delta: 1, reason: 'correction' }, token);

      expect(Object.keys(response.body.adjustment).sort()).toEqual([
        'actorUserId',
        'createdAt',
        'delta',
        'id',
        'note',
        'onHandAfter',
        'onHandBefore',
        'reason',
        'requestId',
        'skuId',
      ]);
    });

    it('adjusts an INACTIVE SKU', async () => {
      const created = await givenStock({ onHand: 2, isActive: false });
      const { app, token } = await staffApp();

      /**
       * The approved decision. A merchant deactivates a SKU precisely in order to count,
       * correct, or clear it; refusing adjustments would make the deactivated state a trap
       * where stock could never be fixed without first making the SKU sellable again.
       */
      const response = await adjust(app, { skuCode: CODE, delta: 3, reason: 'correction' }, token);

      expect(response.status).toBe(201);
      expect((await stockRow(created.id))?.onHand).toBe(5);
    });

    it('refuses a DELETED SKU with a 404 and writes nothing', async () => {
      const created = await givenStock({ onHand: 5, deletedAt: new Date() });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: CODE, delta: 1, reason: 'manual_increase' },
        token,
      );

      expect(response.status).toBe(404);
      expect((await stockRow(created.id))?.onHand).toBe(5);
      expect(await ledgerRows(created.id)).toEqual([]);
      expect(await eventsFor('stock_item')).toEqual([]);
      expect(await auditFor('stock_item')).toEqual([]);
    });

    it('refuses another store’s SKU with the same 404', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenStock({
        code: 'THEIRS-1',
        onHand: 9,
        storeId: otherStoreId,
        productSlug: 'their-shirt',
      });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: 'THEIRS-1', delta: -9, reason: 'manual_decrease' },
        token,
      );

      // Indistinguishable from an unknown code: confirming it exists elsewhere would leak
      // across the tenant boundary.
      expect(response.status).toBe(404);
      expect((await stockRow(theirs.id))?.onHand).toBe(9);
    });

    it('refuses an adjustment that would go negative, naming what was available', async () => {
      const created = await givenStock({ onHand: 3 });
      const { app, token } = await staffApp();

      const response = await adjust(
        app,
        { skuCode: CODE, delta: -4, reason: 'manual_decrease' },
        token,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(response.body.error.details.available).toBe(3);
      expect(response.body.error.details.requested).toBe(-4);
      // Nothing partial survives.
      expect((await stockRow(created.id))?.onHand).toBe(3);
      expect(await ledgerRows(created.id)).toEqual([]);
      expect(await eventsFor('stock_item')).toEqual([]);
    });

    it('refuses a decrement that would breach the RESERVED floor', async () => {
      const created = await givenStock({ onHand: 10, reserved: 6 });
      const { app, token } = await staffApp();

      /**
       * `available` is 4, so `-5` is refused even though `on_hand` would stay positive. The
       * atomic predicate is `on_hand + delta >= reserved`, which is simultaneously the
       * non-negative rule and the reserved floor — one expression, not two.
       */
      const response = await adjust(
        app,
        { skuCode: CODE, delta: -5, reason: 'manual_decrease' },
        token,
      );

      expect(response.status).toBe(409);
      expect(response.body.error.details.available).toBe(4);
      expect((await stockRow(created.id))?.onHand).toBe(10);

      // And exactly to the floor is allowed.
      expect(
        (await adjust(app, { skuCode: CODE, delta: -4, reason: 'manual_decrease' }, token)).status,
      ).toBe(201);
      expect((await stockRow(created.id))?.onHand).toBe(6);
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects a FRACTIONAL delta rather than rounding it', async () => {
      await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      /**
       * Inventory is counted in whole units. Silently truncating 1.5 to 1 would be a
       * merchant's stock figure changed by a validation layer, which is worse than refusing.
       */
      for (const delta of [1.5, -2.25, 0.1]) {
        const response = await adjust(app, { skuCode: CODE, delta, reason: 'correction' }, token);
        expect(response.status, String(delta)).toBe(400);
      }
      expect((await stockRow((await db().select().from(stockItem))[0]!.skuId))?.onHand).toBe(10);
    });

    it('rejects a ZERO delta', async () => {
      await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      // A ledger entry asserting that nothing happened is audit-trail noise, and
      // `ck_stock_ledger_delta_non_zero` refuses it in the database too.
      const response = await adjust(app, { skuCode: CODE, delta: 0, reason: 'correction' }, token);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('zero');
    });

    it('rejects a delta beyond the hygiene bound', async () => {
      await givenStock();
      const { app, token } = await staffApp();

      for (const delta of [1_000_001, -1_000_001]) {
        expect(
          (await adjust(app, { skuCode: CODE, delta, reason: 'manual_increase' }, token)).status,
          String(delta),
        ).toBe(400);
      }
    });

    it('rejects a non-numeric or missing delta', async () => {
      await givenStock();
      const { app, token } = await staffApp();

      for (const body of [
        { skuCode: CODE, reason: 'correction' },
        { skuCode: CODE, delta: '5', reason: 'correction' },
        { skuCode: CODE, delta: null, reason: 'correction' },
      ]) {
        expect((await adjust(app, body, token)).status).toBe(400);
      }
    });

    it('rejects an invalid or missing reason', async () => {
      await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();

      for (const reason of [undefined, '', 'damage', 'theft', 'write_off', 'MANUAL_INCREASE']) {
        const body =
          reason === undefined ? { skuCode: CODE, delta: 1 } : { skuCode: CODE, delta: 1, reason };
        const response = await adjust(app, body, token);
        // `damage`, `theft` and `write_off` are accounting classifications and are
        // deliberately NOT in the vocabulary. Rejecting them is the contract, not a gap.
        expect(response.status, String(reason)).toBe(400);
      }
    });

    it('accepts each of the three approved reasons and no others', async () => {
      await givenStock({ onHand: 100 });
      const { app, token } = await staffApp();

      for (const reason of ['manual_increase', 'manual_decrease', 'correction']) {
        expect((await adjust(app, { skuCode: CODE, delta: 1, reason }, token)).status, reason).toBe(
          201,
        );
      }
    });

    it('rejects a malformed SKU code at VALIDATION, not in PostgreSQL', async () => {
      const { app, token } = await staffApp();

      for (const skuCode of ['', '-leading', 'has space', 'a'.repeat(65), '../etc/passwd']) {
        const response = await adjust(app, { skuCode, delta: 1, reason: 'manual_increase' }, token);
        // A 400 from Zod, never a 500 from a database error.
        expect(response.status, JSON.stringify(skuCode)).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects a malformed SKU code on the history path too', async () => {
      const { app, token } = await staffApp();

      expect((await history(app, 'has%20space', token)).status).toBe(400);
      expect((await history(app, '-leading', token)).status).toBe(400);
    });

    it('rejects every forgeable field individually', async () => {
      await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();

      /**
       * `strictObject` makes each of these unreachable rather than ignored. Listed one at a
       * time rather than in one body, so a schema that happened to accept exactly one of them
       * cannot hide behind the others.
       */
      const forgeable: Record<string, unknown>[] = [
        { storeId: newId() },
        { actorUserId: newId() },
        { actorId: newId() },
        { skuId: newId() },
        { productId: newId() },
        { onHand: 999 },
        { available: 999 },
        { reserved: 999 },
        { onHandBefore: 0 },
        { onHandAfter: 999 },
        { requestId: newId() },
        { createdAt: new Date().toISOString() },
      ];

      for (const extra of forgeable) {
        const response = await adjust(
          app,
          { skuCode: CODE, delta: 1, reason: 'manual_increase', ...extra },
          token,
        );
        expect(response.status, Object.keys(extra)[0]).toBe(400);
      }

      // None of them took effect.
      expect((await db().select().from(stockItem))[0]?.onHand).toBe(5);
    });

    it('accepts a SKU code the catalogue would also accept', async () => {
      /**
       * `skuCodeField` is restated in this module because `no-cross-module-imports` forbids
       * importing the catalogue's copy. This asserts the two have not drifted — a divergence
       * would mean a SKU created as `ABC-1` was unreachable from inventory.
       */
      await givenStock({ code: 'a.b_c/d-1' });
      const { app, token } = await staffApp();

      expect(
        (await adjust(app, { skuCode: 'a.b_c/d-1', delta: 1, reason: 'correction' }, token)).status,
      ).toBe(201);
    });
  });

  /* ── Actor, audit and events ───────────────────────────────────────────── */

  describe('actor, audit and events', () => {
    it('records the adjustment with the TOKEN actor and full arithmetic', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token, userId } = await staffApp();

      await adjust(
        app,
        { skuCode: CODE, delta: -3, reason: 'manual_decrease', note: 'Broken in transit' },
        token,
      );

      const audit = await auditFor('stock_item');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.action).toBe('inventory.adjusted');
      expect(audit[0]?.actorUserId).toBe(userId);
      expect(audit[0]?.actorType).toBe('staff');
      expect(audit[0]?.storeId).toBe(storeId);
      expect(audit[0]?.resourceId).toBe(created.id);
      // Correlation, written by the shared audit infrastructure.
      expect(audit[0]?.requestId).not.toBeNull();

      const metadata = audit[0]?.metadata as Record<string, unknown>;
      expect(metadata['skuCode']).toBe(CODE);
      expect(metadata['delta']).toBe(-3);
      expect(metadata['onHandBefore']).toBe(10);
      expect(metadata['onHandAfter']).toBe(7);
      expect(metadata['reason']).toBe('manual_decrease');
      expect(metadata['note']).toBe('Broken in transit');
    });

    it('stamps the ledger entry with the same actor and request id as the audit row', async () => {
      const created = await givenStock({ onHand: 5 });
      const { app, token, userId } = await staffApp();

      await adjust(app, { skuCode: CODE, delta: 2, reason: 'manual_increase' }, token);

      const [entry] = await ledgerRows(created.id);
      const [audit] = await auditFor('stock_item');
      expect(entry?.actorUserId).toBe(userId);
      // The same ambient request context feeds both, so an operator can line them up.
      expect(entry?.requestId).toBe(audit?.requestId);
    });

    it('emits inventory.adjusted with the minimum useful facts', async () => {
      const created = await givenStock({ onHand: 10, reserved: 2 });
      const { app, token } = await staffApp();

      await adjust(app, { skuCode: CODE, delta: 5, reason: 'manual_increase' }, token);

      const events = await eventsFor('stock_item');
      expect(events).toHaveLength(1);
      expect(events[0]?.eventName).toBe('inventory.adjusted');
      expect(events[0]?.aggregateId).toBe(created.id);
      expect(events[0]?.storeId).toBe(storeId);

      const payload = events[0]?.payload as Record<string, unknown>;
      expect(payload['skuId']).toBe(created.id);
      expect(payload['skuCode']).toBe(CODE);
      expect(payload['delta']).toBe(5);
      expect(payload['onHandBefore']).toBe(10);
      expect(payload['onHandAfter']).toBe(15);
      expect(payload['available']).toBe(13);
      expect(payload['reason']).toBe('manual_increase');
      // The actor is deliberately absent: an event is a fact about the domain, and WHO did it
      // belongs in the audit trail, which has access controls an event stream does not.
      expect('actorUserId' in payload).toBe(false);
      expect('note' in payload).toBe(false);
    });

    it('emits nothing and audits nothing when the adjustment is rejected', async () => {
      await givenStock({ onHand: 1 });
      const { app, token } = await staffApp();

      expect(
        (await adjust(app, { skuCode: CODE, delta: -5, reason: 'manual_decrease' }, token)).status,
      ).toBe(409);

      expect(await eventsFor('stock_item')).toEqual([]);
      expect(await auditFor('stock_item')).toEqual([]);
    });
  });

  /* ── Transactionality ──────────────────────────────────────────────────── */

  describe('transactionality', () => {
    it('leaves stock, ledger, event and audit ALL unchanged when the transaction fails', async () => {
      const created = await givenStock({ onHand: 10 });
      const built = await staffApp();

      /**
       * Provoke a REAL rollback: `audit_log.actor_user_id` is a foreign key, so naming an
       * actor whose user does not exist fails the audit insert AFTER the stock update, the
       * ledger insert and the event emission have all happened.
       *
       * This is the only assertion that proves the four writes share one transaction. With
       * separate transactions the stock would already be 15 and the ledger would hold a row.
       */
      await expect(
        built.inventory.adjustStock({
          storeId,
          actor: { type: 'staff', userId: newId() },
          input: { skuCode: CODE, delta: 5, reason: 'manual_increase' },
        }),
      ).rejects.toThrow();

      expect((await stockRow(created.id))?.onHand).toBe(10);
      expect(await ledgerRows(created.id)).toEqual([]);
      expect(await eventsFor('stock_item')).toEqual([]);
      expect(await auditFor('stock_item')).toEqual([]);
    });

    it('leaves no partial state when the ledger insert fails', async () => {
      const created = await givenStock({ onHand: 10 });
      const built = await staffApp();

      /**
       * A different failure point, to prove the transaction is not merely wrapping the audit
       * call: a reason the database CHECK refuses reaches the ledger insert and fails there,
       * after the stock update has already been applied within the transaction.
       */
      await expect(
        built.inventory.adjustStock({
          storeId,
          actor: { type: 'staff', userId: built.userId },
          // Bypasses Zod deliberately — the DTO would reject this. The point is that the
          // DATABASE also refuses it, and that the refusal rolls the stock update back.
          input: { skuCode: CODE, delta: 5, reason: 'damage' as 'correction' },
        }),
      ).rejects.toThrow();

      expect((await stockRow(created.id))?.onHand).toBe(10);
      expect(await ledgerRows(created.id)).toEqual([]);
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  describe('concurrency', () => {
    /**
     * Every case below runs through `Promise.all` against the SAME SKU.
     *
     * `DATABASE_POOL_MAX` is 5 in tests, and each `withTransaction` checks out its own
     * connection, so these are genuinely concurrent database transactions rather than
     * sequential awaits dressed up as parallel ones.
     */
    it('does not lose an update when two positive adjustments race', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      const results = await Promise.all([
        adjust(app, { skuCode: CODE, delta: 5, reason: 'manual_increase' }, token),
        adjust(app, { skuCode: CODE, delta: 5, reason: 'manual_increase' }, token),
      ]);

      expect(results.map((r) => r.status)).toEqual([201, 201]);
      /**
       * 20, not 15. Read-modify-write produces 15 here — measured against this PostgreSQL —
       * because both requests read 10 and both write 15. This assertion is what MUST fail if
       * the atomic statement is ever replaced.
       */
      expect((await stockRow(created.id))?.onHand).toBe(20);

      const entries = await ledgerRows(created.id);
      expect(entries).toHaveLength(2);
      // The two entries must chain: one 10 -> 15 and one 15 -> 20, in some order.
      expect(entries.map((e) => e.onHandBefore).sort((a, b) => a - b)).toEqual([10, 15]);
      expect(entries.map((e) => e.onHandAfter).sort((a, b) => a - b)).toEqual([15, 20]);
    });

    it('does not lose an update across MANY concurrent mixed adjustments', async () => {
      const created = await givenStock({ onHand: 100 });
      const { app, token } = await staffApp();

      const deltas: number[] = [];
      for (let i = 0; i < 8; i += 1) deltas.push(3, -1);
      const expected = 100 + deltas.reduce((a, b) => a + b, 0);

      const results = await Promise.all(
        deltas.map((delta) =>
          adjust(
            app,
            { skuCode: CODE, delta, reason: delta > 0 ? 'manual_increase' : 'manual_decrease' },
            token,
          ),
        ),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect((await stockRow(created.id))?.onHand).toBe(expected);

      /**
       * The ledger reconciles against the projection — the property that makes it the source
       * of truth rather than a log beside it.
       */
      const entries = await ledgerRows(created.id);
      expect(entries).toHaveLength(deltas.length);
      expect(100 + entries.reduce((sum, e) => sum + e.delta, 0)).toBe(expected);
    });

    it('lets concurrent decrements that FIT both succeed', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      const results = await Promise.all([
        adjust(app, { skuCode: CODE, delta: -4, reason: 'manual_decrease' }, token),
        adjust(app, { skuCode: CODE, delta: -4, reason: 'manual_decrease' }, token),
      ]);

      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect((await stockRow(created.id))?.onHand).toBe(2);
    });

    it('lets exactly ONE of two oversubscribing decrements succeed', async () => {
      const created = await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();

      const results = await Promise.all([
        adjust(app, { skuCode: CODE, delta: -4, reason: 'manual_decrease' }, token),
        adjust(app, { skuCode: CODE, delta: -4, reason: 'manual_decrease' }, token),
      ]);

      /**
       * The negative-stock race. Under read-modify-write this leaves 1 and BOTH requests
       * report success — four units vanish and no CHECK constraint fires, because every value
       * written is individually legal. That is why the atomic predicate is the mechanism and
       * the CHECK is only a backstop.
       */
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409]);
      expect((await stockRow(created.id))?.onHand).toBe(1);

      const loser = results.find((r) => r.status === 409);
      expect(loser?.body.error.code).toBe('INSUFFICIENT_STOCK');

      // Exactly one movement was recorded, not two.
      expect(await ledgerRows(created.id)).toHaveLength(1);
    });

    it('never goes negative under a burst of oversubscribing decrements', async () => {
      const created = await givenStock({ onHand: 10 });
      const { app, token } = await staffApp();

      // Twelve requests of -1 against 10 units: ten must succeed, two must be refused.
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          adjust(app, { skuCode: CODE, delta: -1, reason: 'manual_decrease' }, token),
        ),
      );

      const created201 = results.filter((r) => r.status === 201).length;
      const rejected = results.filter((r) => r.status === 409).length;
      expect(created201).toBe(10);
      expect(rejected).toBe(2);
      expect((await stockRow(created.id))?.onHand).toBe(0);
      expect(await ledgerRows(created.id)).toHaveLength(10);
    });

    it('keeps the store predicate under concurrency', async () => {
      const mine = await givenStock({ code: 'SHARED-1', onHand: 5 });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenStock({
        code: 'SHARED-1',
        onHand: 5,
        storeId: otherStoreId,
        productSlug: 'their-shirt',
      });
      const { app, token } = await staffApp();

      // The same code exists in both stores — legal, per the per-store unique index. Concurrent
      // adjustments must each land in the caller's own store only.
      await Promise.all([
        adjust(app, { skuCode: 'SHARED-1', delta: -1, reason: 'manual_decrease' }, token),
        adjust(app, { skuCode: 'SHARED-1', delta: -1, reason: 'manual_decrease' }, token),
      ]);

      expect((await stockRow(mine.id))?.onHand).toBe(3);
      expect((await stockRow(theirs.id))?.onHand).toBe(5);
    });
  });

  /* ── Ledger reconciliation ─────────────────────────────────────────────── */

  describe('reconciliation', () => {
    it('keeps SUM(delta) equal to on_hand over a long mixed sequence', async () => {
      const created = await givenStock({ onHand: 0 });
      const { app, token } = await staffApp();

      /**
       * **The property that makes the ledger the source of truth** rather than a log sitting
       * beside it: the projection must always be derivable from the entries.
       *
       * PostgreSQL cannot express "this UPDATE must be accompanied by that INSERT" without a
       * trigger, and a trigger would hide the arithmetic from the code that reasons about it.
       * So this assertion is the guard, and it is the reason a mutation removing either write
       * is caught.
       *
       * A deliberately awkward sequence — some sequential, some concurrent, some rejected —
       * because a clean run of increments would pass even if the two writes were only
       * accidentally consistent.
       */
      const sequential = [10, -3, 7, -1, 25, -20, 4];
      for (const delta of sequential) {
        const response = await adjust(
          app,
          { skuCode: CODE, delta, reason: delta > 0 ? 'manual_increase' : 'manual_decrease' },
          token,
        );
        expect(response.status, String(delta)).toBe(201);
      }

      // A burst, to interleave the writes.
      await Promise.all(
        [2, -1, 3, -2, 5].map((delta) =>
          adjust(
            app,
            { skuCode: CODE, delta, reason: delta > 0 ? 'manual_increase' : 'manual_decrease' },
            token,
          ),
        ),
      );

      // And some rejections, which must leave no trace in either place.
      await Promise.all([
        adjust(app, { skuCode: CODE, delta: -100_000, reason: 'manual_decrease' }, token),
        adjust(app, { skuCode: CODE, delta: 0, reason: 'correction' }, token),
        adjust(app, { skuCode: 'NO-SUCH', delta: 1, reason: 'correction' }, token),
      ]);

      /**
       * Two plain queries rather than one correlated subquery. The clever version was written
       * first and disagreed with the projection — the subquery, not the code, was wrong — which
       * is a good argument for the boring form in a test whose whole job is to be trusted.
       */
      const onHandNow = (await stockRow(created.id))?.onHand;
      const entries = await ledgerRows(created.id);
      const ledgerSum = entries.reduce((sum, e) => sum + e.delta, 0);

      // Started at zero, so the sum of every recorded movement IS the current stock.
      expect(onHandNow).toBe(ledgerSum);

      /**
       * Every entry's own arithmetic is self-consistent. Also enforced by
       * `ck_stock_ledger_arithmetic`, asserted here so a mutation removing that constraint is
       * caught by behaviour as well as by the named-constraint test.
       */
      for (const entry of entries) {
        expect(entry.onHandBefore + entry.delta).toBe(entry.onHandAfter);
      }

      /**
       * The entries form an unbroken CHAIN — asserted order-independently, which matters.
       *
       * The ledger's `(created_at, id)` order is a DISPLAY order, not a causal one:
       * PostgreSQL's `now()` is transaction-start time, so concurrent transactions share it,
       * and UUIDv7 encodes when an id was generated rather than when its update took effect.
       * An earlier version of this test walked the rows in that order and failed on exactly
       * that — the data was correct and the assumption was wrong.
       *
       * What IS true regardless of order: exactly one entry starts from the initial zero, and
       * every other intermediate level is both some entry's `after` and some entry's
       * `before`. If a movement had been lost or applied twice, that pairing would not
       * balance.
       */
      const asc = (a: number, b: number) => a - b;
      const befores = entries.map((e) => e.onHandBefore);
      const afters = entries.map((e) => e.onHandAfter);

      expect(befores.filter((v) => v === 0)).toHaveLength(1);

      const beforesWithoutStart = [...befores];
      beforesWithoutStart.splice(beforesWithoutStart.indexOf(0), 1);
      const aftersWithoutEnd = [...afters];
      aftersWithoutEnd.splice(aftersWithoutEnd.indexOf(onHandNow as number), 1);

      expect(beforesWithoutStart.sort(asc)).toEqual(aftersWithoutEnd.sort(asc));
    });
  });

  /* ── History ───────────────────────────────────────────────────────────── */

  describe('history', () => {
    it('returns entries newest first, paged, with an exact key set', async () => {
      await givenStock({ onHand: 0 });
      const { app, token } = await staffApp();

      for (const delta of [1, 2, 3]) {
        expect(
          (await adjust(app, { skuCode: CODE, delta, reason: 'manual_increase' }, token)).status,
        ).toBe(201);
      }

      const response = await history(app, CODE, token);
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['history', 'pagination']);
      // Newest first.
      expect(deltasOf(response.body)).toEqual([3, 2, 1]);
      expect(response.body.pagination.total).toBe(3);

      const page = await history(app, CODE, token, '?limit=2&offset=0');
      expect(deltasOf(page.body)).toEqual([3, 2]);
      expect(page.body.pagination.total).toBe(3);
    });

    it('returns an empty page for a SKU never adjusted', async () => {
      await givenStock();
      const { app, token } = await staffApp();

      const response = await history(app, CODE, token);
      expect(response.status).toBe(200);
      expect(response.body.history).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });

    it('404s an unknown, deleted or another store’s SKU', async () => {
      await givenStock({ code: 'GONE-1', deletedAt: new Date() });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      await givenStock({ code: 'THEIRS-1', storeId: otherStoreId, productSlug: 'their-shirt' });
      const { app, token } = await staffApp();

      for (const code of ['NO-SUCH', 'GONE-1', 'THEIRS-1']) {
        expect((await history(app, code, token)).status, code).toBe(404);
      }
    });

    it('is APPEND-ONLY: there is no route that edits or deletes an entry', async () => {
      const created = await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();
      await adjust(app, { skuCode: CODE, delta: 1, reason: 'manual_increase' }, token);
      const [entry] = await ledgerRows(created.id);

      /**
       * Every plausible mutation route must be absent. The table itself has no `updated_at`
       * and no `deleted_at`, so even a route that wanted to could not hide an entry — but the
       * absence of the route is what a client can observe, so it is what is asserted.
       */
      const attempts = [
        request(app).patch(`/api/v1/admin/inventory/${CODE}/history`),
        request(app).delete(`/api/v1/admin/inventory/${CODE}/history`),
        request(app).put(`/api/v1/admin/inventory/${CODE}/history`),
        request(app).patch(`/api/v1/admin/inventory/adjustments/${entry?.id ?? ''}`),
        request(app).delete(`/api/v1/admin/inventory/adjustments/${entry?.id ?? ''}`),
        request(app).patch(`/api/v1/admin/inventory/${CODE}`),
      ];

      for (const attempt of attempts) {
        const response = await attempt.set('Authorization', `Bearer ${token}`).send({ delta: 99 });
        expect(response.status).toBe(404);
      }

      // The entry is untouched.
      const [after] = await ledgerRows(created.id);
      expect(after?.delta).toBe(1);
      expect(after?.id).toBe(entry?.id);
    });

    it('ignores a body-supplied storeId on the bodiless history GET', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenStock({
        code: 'THEIRS-1',
        onHand: 5,
        storeId: otherStoreId,
        productSlug: 'their-shirt',
      });
      // One sign-in for the whole test: a second `staffApp()` would reuse the same email and
      // be rejected as a duplicate registration.
      const { app, token, userId } = await staffApp();

      // Give their SKU some history, so a leak would have something to reveal.
      await db().insert(stockLedger).values({
        id: newId(),
        storeId: otherStoreId,
        skuId: theirs.id,
        delta: 5,
        onHandBefore: 0,
        onHandAfter: 5,
        reason: 'manual_increase',
        note: '',
        actorUserId: userId,
        requestId: null,
      });

      /**
       * The escalation this closes: the two `GET` routes validate `params` and `query` only —
       * they have no body to describe — so an unexpected JSON body reaches `req.body`
       * UNVALIDATED, and the strict schema on the `POST` does not protect them. A handler
       * reading the store from that body instead of from request resolution would hand one
       * merchant another merchant's stock movements.
       *
       * Increment 24 found this exact gap on a bodiless `DELETE`; it is re-tested here rather
       * than assumed closed, because this increment adds two more bodiless routes.
       */
      const response = await request(app)
        .get('/api/v1/admin/inventory/THEIRS-1/history')
        .set('Authorization', `Bearer ${token}`)
        .send({ storeId: otherStoreId });

      expect(response.status).toBe(404);

      // And the same for the list route, whose store scope is equally body-independent.
      const list = await request(app)
        .get('/api/v1/admin/inventory')
        .set('Authorization', `Bearer ${token}`)
        .send({ storeId: otherStoreId });
      expect(list.status).toBe(200);
      expect(list.body.pagination.total).toBe(0);
    });

    it('rejects unknown history query parameters', async () => {
      await givenStock();
      const { app, token } = await staffApp();

      expect((await history(app, CODE, token, '?storeId=' + newId())).status).toBe(400);
      expect((await history(app, CODE, token, '?limit=101')).status).toBe(400);
    });
  });

  /* ── SKU and product deletion ──────────────────────────────────────────── */

  describe('deletion', () => {
    it('PRESERVES ledger history when the SKU is soft-deleted', async () => {
      const created = await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();
      await adjust(app, { skuCode: CODE, delta: 3, reason: 'manual_increase' }, token);

      await db().update(sku).set({ deletedAt: new Date() }).where(eq(sku.id, created.id));

      // The rows survive — they are the historical record an order line or a reconciliation
      // will need — and every id in them still resolves, because the deletion is SOFT.
      expect(await ledgerRows(created.id)).toHaveLength(1);
      expect((await stockRow(created.id))?.onHand).toBe(8);
    });

    it('PRESERVES ledger history when the product is soft-deleted', async () => {
      const created = await givenStock({ onHand: 5 });
      const { app, token } = await staffApp();
      await adjust(app, { skuCode: CODE, delta: -2, reason: 'manual_decrease' }, token);

      // Mirrors what the catalogue's product deletion does: product and SKUs, both soft.
      await db()
        .update(product)
        .set({ deletedAt: new Date() })
        .where(eq(product.id, created.productId));
      await db().update(sku).set({ deletedAt: new Date() }).where(eq(sku.id, created.id));

      expect(await ledgerRows(created.id)).toHaveLength(1);
      // And it is no longer reachable or adjustable through the API.
      expect((await listInventory(app, token)).body.pagination.total).toBe(0);
      expect(
        (await adjust(app, { skuCode: CODE, delta: 1, reason: 'manual_increase' }, token)).status,
      ).toBe(404);
    });

    it('refuses a HARD delete of a SKU that has inventory', async () => {
      const created = await givenStock({ onHand: 1 });

      /**
       * `RESTRICT`, not `CASCADE`. SKUs are soft-deleted, so a hard delete is either an
       * operator mistake or a bug — and silently discarding stock history is strictly worse
       * than failing loudly.
       */
      await expectConstraint(
        db().delete(sku).where(eq(sku.id, created.id)),
        'fk_stock_item_sku_store',
      );
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * These distinguish a DATABASE guarantee from an application check.
     *
     * Each writes with direct SQL, bypassing the service entirely, and asserts the NAMED
     * constraint that refuses it. If the Zod schema and the atomic predicate were both deleted
     * tomorrow, only these would still fail.
     */
    it('refuses a negative on_hand', async () => {
      const created = await givenStock({ onHand: 5 });

      await expectConstraint(
        db().update(stockItem).set({ onHand: -1 }).where(eq(stockItem.skuId, created.id)),
        'ck_stock_on_hand_non_negative',
      );
    });

    it('refuses a negative reserved', async () => {
      const created = await givenStock({ onHand: 5 });

      await expectConstraint(
        db().update(stockItem).set({ reserved: -1 }).where(eq(stockItem.skuId, created.id)),
        'ck_stock_reserved_non_negative',
      );
    });

    it('refuses reserved exceeding on_hand', async () => {
      const created = await givenStock({ onHand: 5 });

      await expectConstraint(
        db().update(stockItem).set({ reserved: 6 }).where(eq(stockItem.skuId, created.id)),
        'ck_stock_reserved_within_on_hand',
      );
    });

    it('refuses TWO stock rows for one SKU', async () => {
      const created = await givenStock();

      // The primary key IS `sku_id`, which is what makes one-row-per-SKU structural rather
      // than a separate unique index somebody could drop.
      await expectConstraint(
        db().insert(stockItem).values({ skuId: created.id, storeId, onHand: 3 }),
        'stock_item_pkey',
      );
    });

    it('refuses a stock row claiming the WRONG STORE', async () => {
      const parent = await givenProduct();
      const created = await giveSku(db(), parent, { code: 'X-1' });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db().insert(stockItem).values({ skuId: created.id, storeId: otherStoreId, onHand: 1 }),
        'fk_stock_item_sku_store',
      );
    });

    it('refuses a stock row for a SKU that does not exist', async () => {
      await expectConstraint(
        db().insert(stockItem).values({ skuId: newId(), storeId, onHand: 1 }),
        'fk_stock_item_sku_store',
      );
    });

    it('refuses writing the GENERATED available column', async () => {
      const created = await givenStock({ onHand: 5 });

      /**
       * The invariant made structurally impossible rather than merely asserted: PostgreSQL
       * itself refuses, so no code path, migration, or operator can make `available` disagree
       * with `on_hand - reserved`.
       */
      await expectConstraint(
        db().execute(
          sql`update ${stockItem} set available = 99 where ${stockItem.skuId} = ${created.id}`,
        ),
        'can only be updated to DEFAULT',
      );
    });

    it('refuses a zero-delta ledger entry', async () => {
      const created = await givenStock();
      const { userId } = await staffApp();

      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId,
          skuId: created.id,
          delta: 0,
          onHandBefore: 0,
          onHandAfter: 0,
          reason: 'correction',
          note: '',
          actorUserId: userId,
          requestId: null,
        }),
        'ck_stock_ledger_delta_non_zero',
      );
    });

    it('refuses a ledger entry whose arithmetic does not add up', async () => {
      const created = await givenStock();
      const { userId } = await staffApp();

      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId,
          skuId: created.id,
          delta: 5,
          onHandBefore: 10,
          // 10 + 5 is not 20. Without this constraint the ledger would stop being
          // reconcilable against the projection, which is what makes it the truth.
          onHandAfter: 20,
          reason: 'correction',
          note: '',
          actorUserId: userId,
          requestId: null,
        }),
        'ck_stock_ledger_arithmetic',
      );
    });

    it('refuses a ledger entry with a negative quantity', async () => {
      const created = await givenStock();
      const { userId } = await staffApp();

      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId,
          skuId: created.id,
          delta: -5,
          onHandBefore: 3,
          onHandAfter: -2,
          reason: 'manual_decrease',
          note: '',
          actorUserId: userId,
          requestId: null,
        }),
        'ck_stock_ledger_quantities_non_negative',
      );
    });

    it('refuses a ledger reason outside the approved vocabulary', async () => {
      const created = await givenStock();
      const { userId } = await staffApp();

      // The database, not only Zod. A bulk import or an operator running SQL bypasses
      // application validation entirely.
      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId,
          skuId: created.id,
          delta: 1,
          onHandBefore: 0,
          onHandAfter: 1,
          reason: 'damage',
          note: '',
          actorUserId: userId,
          requestId: null,
        }),
        'ck_stock_ledger_reason',
      );
    });

    it('refuses a ledger entry with no real actor', async () => {
      const created = await givenStock();

      // `actor_user_id` is NOT NULL with a real FK — invariant 9. An unattributed movement is
      // a bug, not a missing optional field.
      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId,
          skuId: created.id,
          delta: 1,
          onHandBefore: 0,
          onHandAfter: 1,
          reason: 'correction',
          note: '',
          actorUserId: newId(),
          requestId: null,
        }),
        'stock_ledger_actor_user_id_app_user_id_fk',
      );
    });

    it('refuses a ledger entry claiming the wrong store', async () => {
      const created = await givenStock();
      const { userId } = await staffApp();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db().insert(stockLedger).values({
          id: newId(),
          storeId: otherStoreId,
          skuId: created.id,
          delta: 1,
          onHandBefore: 0,
          onHandAfter: 1,
          reason: 'correction',
          note: '',
          actorUserId: userId,
          requestId: null,
        }),
        'fk_stock_ledger_sku_store',
      );
    });
  });

  /* ── Repository-level store isolation ──────────────────────────────────── */

  describe('repository store isolation', () => {
    it('scopes every read and the adjustment by store', async () => {
      const { repository } = build();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenStock({
        code: 'THEIRS-1',
        onHand: 9,
        storeId: otherStoreId,
        productSlug: 'their-shirt',
      });

      /**
       * Asserted at the REPOSITORY level as well as through HTTP. A guarantee that lives only
       * in a route is one refactor from a leak, and a future caller arriving from a CLI command
       * or a background job gets no middleware at all.
       */
      expect(await repository.findStockByCode({ storeId, code: 'THEIRS-1' })).toBeUndefined();
      expect(await repository.findLiveSkuRefByCode({ storeId, code: 'THEIRS-1' })).toBeUndefined();
      expect(
        await repository.adjustStock({ storeId, code: 'THEIRS-1', delta: -9, at: new Date() }),
      ).toBeUndefined();
      expect(
        (await repository.listLedgerForSku({ storeId, skuId: theirs.id, limit: 10, offset: 0 }))
          .total,
      ).toBe(0);
      expect((await repository.listStockForStore({ storeId, limit: 10, offset: 0 })).total).toBe(0);

      // Untouched.
      expect((await stockRow(theirs.id))?.onHand).toBe(9);
    });

    it('reads and adjusts use the SAME liveness predicate', async () => {
      const { repository } = build();
      await givenStock({ code: 'OFF-1', onHand: 5, isActive: false });
      await givenStock({ code: 'GONE-1', onHand: 5, deletedAt: new Date() });

      /**
       * A SKU must never be readable but unadjustable, or the reverse — that divergence is a
       * mutation target, and it is the kind of bug that only shows up when a merchant tries to
       * fix a figure they can see.
       */
      expect(await repository.findStockByCode({ storeId, code: 'OFF-1' })).toBeDefined();
      expect(
        await repository.adjustStock({ storeId, code: 'OFF-1', delta: 1, at: new Date() }),
      ).toBeDefined();

      expect(await repository.findStockByCode({ storeId, code: 'GONE-1' })).toBeUndefined();
      expect(
        await repository.adjustStock({ storeId, code: 'GONE-1', delta: 1, at: new Date() }),
      ).toBeUndefined();
    });
  });
});
