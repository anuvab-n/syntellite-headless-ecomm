import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cart, cartLine } from '../../../db/schema/cart.js';
import { product, sku } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { stockItem } from '../../../db/schema/inventory.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
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
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createCartRepository } from '../cart.repository.js';
import { createCartRoutes } from '../cart.routes.js';
import { createCartService } from '../cart.service.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';

/**
 * The shopping cart — against real PostgreSQL.
 *
 * Five properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **PUT SETS, it does not add.** A repeated identical request must leave the quantity
 *     unchanged — that is what makes a client retry safe with no idempotency infrastructure, and
 *     it is the single assertion an increment-semantics regression would break.
 *
 *  2. **One active cart, one line per SKU.** Both under genuine concurrency, on separate pool
 *     connections. The partial unique index and the composite primary key are the mechanisms;
 *     the tests exist to prove they are load-bearing rather than decorative.
 *
 *  3. **Money is exact.** Decimal strings through `shared/money.ts`, never a JS number, asserted
 *     on 4-decimal prices where a float would visibly drift.
 *
 *  4. **A line that can no longer be bought is KEPT and FLAGGED.** Deleting a customer's basket
 *     contents because a merchant edited a listing would be worse than telling them.
 *
 *  5. **The database enforces tenancy.** Both composite foreign keys asserted by NAME from
 *     direct SQL, because a test that only speaks HTTP cannot tell an application check from a
 *     database one.
 */
describe('cart (integration)', () => {
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
    const repository = createCartRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    /**
     * The REAL promotions service behind the port, not a stub.
     *
     * A stub would let a broken port pass: the cart would compose totals from whatever the
     * double returned, and a wrong predicate in the promotions repository would go unnoticed.
     * Wiring the real one here is the same judgement `testRecorders` makes about the event bus.
     */
    const promotionsService = createPromotionsService({
      repository: createPromotionsRepository({ db: db() }),
      db: db(),
      audit: testRecorders(db()).audit,
      logger: silentLogger,
    });

    const cartService = createCartService({
      repository,
      promotions: {
        findApplicable: (input) => promotionsService.findApplicable(input),
        evaluateApplied: (input) => promotionsService.evaluateApplied(input),
      },
      db: db(),
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
      createCartRoutes({
        cart: cartService,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      cart: cartService,
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { email?: string; storeId?: string } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'ada@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  const customerApp = async () => {
    const built = build();
    const auth = await signIn(built.app, built.identity);
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

  /** A purchasable SKU under a published product, unless the overrides say otherwise. */
  async function givenSku(
    overrides: {
      code?: string;
      price?: string;
      isActive?: boolean;
      deletedAt?: Date | null;
      productStatus?: string;
      productDeletedAt?: Date;
      storeId?: string;
      productSlug?: string;
    } = {},
  ) {
    const owningStore = overrides.storeId ?? storeId;
    const parent = await givenProduct({
      slug: overrides.productSlug ?? `p-${(overrides.code ?? CODE).toLowerCase()}`,
      storeId: owningStore,
      ...(overrides.productStatus === undefined ? {} : { status: overrides.productStatus }),
      ...(overrides.productDeletedAt === undefined
        ? {}
        : { deletedAt: overrides.productDeletedAt }),
    });
    const created = await giveSku(db(), parent, {
      code: overrides.code ?? CODE,
      price: overrides.price ?? '1499.0000',
      ...(overrides.isActive === undefined ? {} : { isActive: overrides.isActive }),
      deletedAt: overrides.deletedAt ?? null,
    });
    return { ...created, storeId: owningStore, productId: parent.id };
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const getCart = (app: App, token?: string) => {
    const req = request(app).get('/api/v1/users/me/cart');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const putItem = (app: App, code: string, body: unknown, token?: string) => {
    const req = request(app).put(`/api/v1/users/me/cart/items/${code}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const deleteItem = (app: App, code: string, token?: string) => {
    const req = request(app).delete(`/api/v1/users/me/cart/items/${code}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const clearCart = (app: App, token?: string) => {
    const req = request(app).delete('/api/v1/users/me/cart');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── Row readers ───────────────────────────────────────────────────────── */

  const cartRows = async () => db().select().from(cart);
  const lineRows = async (cartId: string) =>
    db().select().from(cartLine).where(eq(cartLine.cartId, cartId));

  /** Typed readers; supertest hands back `any`. */
  const codesOf = (body: { cart: { items: { skuCode: string }[] } }): string[] =>
    body.cart.items.map((i) => i.skuCode);
  const qtyOf = (
    body: { cart: { items: { skuCode: string; quantity: number }[] } },
    code: string,
  ) => body.cart.items.find((i) => i.skuCode === code)?.quantity;

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
    it('rejects unauthenticated requests on every route', async () => {
      await givenSku();
      const { app } = build();

      for (const response of [
        await getCart(app),
        await putItem(app, CODE, { quantity: 1 }),
        await deleteItem(app, CODE),
        await clearCart(app),
      ]) {
        expect(response.status).toBe(401);
      }
      expect(await cartRows()).toEqual([]);
    });

    it('needs no staff scope — a customer manages their own basket', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      expect((await getCart(app, token)).status).toBe(200);
      expect((await putItem(app, CODE, { quantity: 1 }, token)).status).toBe(200);
    });
  });

  /* ── Cart lifecycle ────────────────────────────────────────────────────── */

  describe('lifecycle', () => {
    it('creates an empty active cart on the first GET', async () => {
      const { app, token, userId } = await customerApp();

      const response = await getCart(app, token);

      expect(response.status).toBe(200);
      expect(response.body.cart.items).toEqual([]);
      expect(response.body.cart.itemCount).toBe(0);
      expect(response.body.cart.status).toBe('active');
      // There is no explicit create endpoint: GET is the only way a cart appears.
      const rows = await cartRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(userId);
      expect(rows[0]?.storeId).toBe(storeId);
    });

    it('returns the SAME cart on a repeated GET', async () => {
      const { app, token } = await customerApp();

      const first = await getCart(app, token);
      const second = await getCart(app, token);

      expect(second.body.cart.id).toBe(first.body.cart.id);
      expect(await cartRows()).toHaveLength(1);
    });

    it('gives a NEW active cart when only a checked_out cart exists', async () => {
      const { app, token } = await customerApp();
      const first = (await getCart(app, token)).body.cart.id as string;

      /**
       * Checkout does not exist yet, so the transition is made directly — the point of the test
       * is the LIFECYCLE, not how the status changes. A `checked_out` cart is outside
       * `uq_cart_active`, so it neither blocks the next cart nor has to be deleted.
       */
      await db().update(cart).set({ status: 'checked_out' }).where(eq(cart.id, first));

      const second = await getCart(app, token);
      expect(second.status).toBe(200);
      expect(second.body.cart.id).not.toBe(first);
      expect(second.body.cart.status).toBe('active');

      // Both rows survive: a cart is never deleted.
      expect(await cartRows()).toHaveLength(2);
    });

    it('clears the lines and KEEPS the cart', async () => {
      await givenSku();
      await givenSku({ code: 'SECOND-1', productSlug: 'p-second' });
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 2 }, token);
      await putItem(app, 'SECOND-1', { quantity: 1 }, token);
      const cartId = (await getCart(app, token)).body.cart.id as string;

      expect((await clearCart(app, token)).status).toBe(204);

      const after = await getCart(app, token);
      // The SAME cart, now empty — not a new id.
      expect(after.body.cart.id).toBe(cartId);
      expect(after.body.cart.items).toEqual([]);
      expect(await lineRows(cartId)).toEqual([]);
      expect(await cartRows()).toHaveLength(1);
    });

    it('clears an already-empty cart idempotently', async () => {
      const { app, token } = await customerApp();
      await getCart(app, token);

      expect((await clearCart(app, token)).status).toBe(204);
      expect((await clearCart(app, token)).status).toBe(204);
    });

    it('keeps the cart after its last line is removed', async () => {
      await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);
      const cartId = (await getCart(app, token)).body.cart.id as string;

      expect((await deleteItem(app, CODE, token)).status).toBe(204);

      expect((await getCart(app, token)).body.cart.id).toBe(cartId);
      expect(await cartRows()).toHaveLength(1);
    });
  });

  /* ── Ownership ─────────────────────────────────────────────────────────── */

  describe('ownership', () => {
    it('isolates two customers in the same store', async () => {
      await givenSku();
      await givenSku({ code: 'GRACE-1', productSlug: 'p-grace' });
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;

      await putItem(app, CODE, { quantity: 2 }, ada.token);
      await putItem(app, 'GRACE-1', { quantity: 5 }, grace.token);

      expect(codesOf((await getCart(app, ada.token)).body)).toEqual([CODE]);
      expect(codesOf((await getCart(app, grace.token)).body)).toEqual(['GRACE-1']);
      // Two carts, one each.
      expect(await cartRows()).toHaveLength(2);
    });

    it('lets one customer’s clear and delete never touch another’s cart', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      await putItem(app, CODE, { quantity: 3 }, ada.token);

      // Grace has no such line: her delete is a 404 and her clear empties only her own cart.
      expect((await deleteItem(app, CODE, grace.token)).status).toBe(404);
      expect((await clearCart(app, grace.token)).status).toBe(204);

      expect(qtyOf((await getCart(app, ada.token)).body, CODE)).toBe(3);
    });

    it('isolates customers across STORES', async () => {
      await givenSku();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      await givenSku({
        code: 'THEIRS-1',
        storeId: otherStoreId,
        productSlug: 'p-theirs',
      });

      const mine = build();
      const ada = await signIn(mine.app, mine.identity, { email: 'ada@example.com' });
      await putItem(mine.app, CODE, { quantity: 1 }, ada.token);

      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });

      // Bob's cart is his own and empty, and our store's SKU is invisible to him.
      const bobCart = await getCart(theirs.app, bob.token);
      expect(bobCart.body.cart.items).toEqual([]);
      expect((await putItem(theirs.app, CODE, { quantity: 1 }, bob.token)).status).toBe(404);
      // And Ada cannot reach the other store's SKU either.
      expect((await putItem(mine.app, 'THEIRS-1', { quantity: 1 }, ada.token)).status).toBe(404);
    });

    it('rejects every forgeable field on PUT, one at a time', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      /**
       * One per request rather than all in one body, so a schema that happened to accept
       * exactly one of them cannot hide behind the others.
       */
      for (const extra of [
        { userId: newId() },
        { storeId: newId() },
        { actorUserId: newId() },
        { cartId: newId() },
        { skuId: newId() },
        { skuCode: 'OTHER-1' },
        { unitPrice: '1.0000' },
        { lineTotal: '1.0000' },
        { status: 'checked_out' },
        { createdAt: new Date().toISOString() },
      ]) {
        const response = await putItem(app, CODE, { quantity: 1, ...extra }, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }

      expect(await cartRows()).toEqual([]);
    });

    it('ignores a body on the three BODILESS routes', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      await putItem(app, CODE, { quantity: 4 }, ada.token);
      const adaCartId = (await getCart(app, ada.token)).body.cart.id as string;

      /**
       * GET and both DELETEs validate `params` only — they have no body to describe — so an
       * unexpected JSON body reaches `req.body` UNVALIDATED, and the strict schema on PUT does
       * not protect them. Increments 24, 26 and 27 each found a real escalation on exactly this
       * shape, so it is tested rather than assumed closed.
       */
      const forged = { userId: ada.userId, storeId, cartId: adaCartId };

      const seen = await getCart(app, grace.token).send(forged);
      expect(seen.status).toBe(200);
      expect(seen.body.cart.items).toEqual([]);
      expect(seen.body.cart.id).not.toBe(adaCartId);

      expect((await deleteItem(app, CODE, grace.token).send(forged)).status).toBe(404);
      expect((await clearCart(app, grace.token).send(forged)).status).toBe(204);

      // Ada's line is untouched throughout.
      expect(qtyOf((await getCart(app, ada.token)).body, CODE)).toBe(4);
    });
  });

  /* ── Lines and SET semantics ───────────────────────────────────────────── */

  describe('lines', () => {
    it('adds a SKU and returns an exact response key set', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      const response = await putItem(app, CODE, { quantity: 2 }, token);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(['cart']);
      expect(Object.keys(response.body.cart).sort()).toEqual([
        'cartTotal',
        'createdAt',
        'currency',
        'discountTotal',
        'id',
        'itemCount',
        'items',
        'promotion',
        'status',
        'subtotal',
        'updatedAt',
      ]);
      expect(Object.keys(response.body.cart.items[0]).sort()).toEqual([
        'isPurchasable',
        'lineTotal',
        'quantity',
        'skuCode',
        'skuName',
        'unitPrice',
      ]);
      // No internal ids leak: not the SKU's, not the product's, not the store's.
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain('skuId');
      expect(serialised).not.toContain('productId');
      expect(serialised).not.toContain('storeId');
      expect(serialised).not.toContain('userId');
    });

    it('SETS the quantity — a repeated identical PUT leaves it unchanged', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      const first = await putItem(app, CODE, { quantity: 3 }, token);
      const retry = await putItem(app, CODE, { quantity: 3 }, token);

      /**
       * **The assertion the whole write design rests on.** Under increment semantics this
       * would read 6 — measured against this PostgreSQL during the design review. Because PUT
       * SETS, a client retry after a timeout is a no-op, which is why no `Idempotency-Key`
       * infrastructure is needed.
       */
      expect(first.body.cart.items[0].quantity).toBe(3);
      expect(retry.body.cart.items[0].quantity).toBe(3);
      expect(retry.body.cart.itemCount).toBe(1);
    });

    it('REPLACES rather than accumulates on a different quantity', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      await putItem(app, CODE, { quantity: 2 }, token);
      const response = await putItem(app, CODE, { quantity: 5 }, token);

      expect(response.body.cart.items[0].quantity).toBe(5);
      expect(response.body.cart.itemCount).toBe(1);
      const cartId = response.body.cart.id as string;
      expect(await lineRows(cartId)).toHaveLength(1);
    });

    it('holds several SKUs, ordered by code', async () => {
      for (const code of ['C-3', 'A-1', 'B-2']) {
        await givenSku({ code, productSlug: `p-${code.toLowerCase()}` });
      }
      const { app, token } = await customerApp();

      for (const code of ['C-3', 'A-1', 'B-2']) {
        expect((await putItem(app, code, { quantity: 1 }, token)).status).toBe(200);
      }

      const response = await getCart(app, token);
      // Deterministic order, so a cart renders identically on every read.
      expect(codesOf(response.body)).toEqual(['A-1', 'B-2', 'C-3']);
      expect(response.body.cart.itemCount).toBe(3);
    });

    it('counts LINES, not the sum of quantities', async () => {
      await givenSku({ code: 'A-1', productSlug: 'p-a' });
      await givenSku({ code: 'B-2', productSlug: 'p-b' });
      const { app, token } = await customerApp();

      await putItem(app, 'A-1', { quantity: 10 }, token);
      await putItem(app, 'B-2', { quantity: 7 }, token);

      // Both readings are plausible, so the semantic is pinned: two distinct things in the
      // basket, not seventeen units.
      expect((await getCart(app, token)).body.cart.itemCount).toBe(2);
    });

    it('removes one line and 404s a repeated delete', async () => {
      await givenSku({ code: 'A-1', productSlug: 'p-a' });
      await givenSku({ code: 'B-2', productSlug: 'p-b' });
      const { app, token } = await customerApp();
      await putItem(app, 'A-1', { quantity: 1 }, token);
      await putItem(app, 'B-2', { quantity: 1 }, token);

      expect((await deleteItem(app, 'A-1', token)).status).toBe(204);
      expect((await deleteItem(app, 'A-1', token)).status).toBe(404);

      // Only the named line went.
      expect(codesOf((await getCart(app, token)).body)).toEqual(['B-2']);
    });

    it('404s an unknown SKU on PUT and on DELETE', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      expect((await putItem(app, 'NO-SUCH', { quantity: 1 }, token)).status).toBe(404);
      expect((await deleteItem(app, 'NO-SUCH', token)).status).toBe(404);
      // A SKU that exists but was never added is also a 404 on delete.
      expect((await deleteItem(app, CODE, token)).status).toBe(404);
    });

    it('400s a malformed SKU code before it reaches PostgreSQL', async () => {
      const { app, token } = await customerApp();

      for (const code of ['-leading', 'has%20space', 'a'.repeat(65)]) {
        const put = await putItem(app, code, { quantity: 1 }, token);
        expect(put.status, code).toBe(400);
        expect(put.body.error.code).toBe('VALIDATION_ERROR');
        expect((await deleteItem(app, code, token)).status, code).toBe(400);
      }
    });

    it('accepts a SKU code the catalogue would also accept', async () => {
      /**
       * `skuCodeField` is restated in this module because `no-cross-module-imports` forbids
       * importing the catalogue's copy. This asserts the two have not drifted — a divergence
       * would mean a SKU a merchant could create was unreachable from the cart.
       */
      await givenSku({ code: 'a.b_C_9.x-1', productSlug: 'p-dotted' });
      const { app, token } = await customerApp();

      expect((await putItem(app, 'a.b_C_9.x-1', { quantity: 1 }, token)).status).toBe(200);
    });

    it('needs a slash in a SKU code PERCENT-ENCODED in the path', async () => {
      await givenSku({ code: 'a.b_c/d-1', productSlug: 'p-slashed' });
      const { app, token } = await customerApp();

      /**
       * Measured, not assumed. `sku.code` permits `/`, but a raw slash in the path is an extra
       * URL SEGMENT, so `:skuCode` never matches and Express answers 404 before any handler
       * runs. Percent-encoded it decodes back to the literal code and works.
       *
       * Not a cart defect and not something this increment may change: `PATCH /admin/skus/:code`
       * has had exactly the same property since Increment 24, so narrowing the pattern here
       * would make the cart reject codes the catalogue still mints. Asserted so the behaviour is
       * recorded rather than discovered by a client.
       */
      expect((await putItem(app, 'a.b_c/d-1', { quantity: 1 }, token)).status).toBe(404);
      expect((await putItem(app, 'a.b_c%2Fd-1', { quantity: 1 }, token)).status).toBe(200);
      expect(codesOf((await getCart(app, token)).body)).toEqual(['a.b_c/d-1']);
      expect((await deleteItem(app, 'a.b_c%2Fd-1', token)).status).toBe(204);
    });
  });

  /* ── Purchasability ────────────────────────────────────────────────────── */

  describe('purchasability', () => {
    it('404s a SKU that is inactive, deleted, or under an unpublished or deleted product', async () => {
      await givenSku({ code: 'OFF-1', isActive: false, productSlug: 'p-off' });
      await givenSku({ code: 'GONE-1', deletedAt: new Date(), productSlug: 'p-gone' });
      await givenSku({ code: 'DRAFT-1', productStatus: 'draft', productSlug: 'p-draft' });
      await givenSku({ code: 'ARCH-1', productStatus: 'archived', productSlug: 'p-arch' });
      await givenSku({
        code: 'PDEL-1',
        productDeletedAt: new Date(),
        productSlug: 'p-pdel',
      });
      const { app, token } = await customerApp();

      // All five indistinguishable, so the response reveals nothing about the catalogue.
      for (const code of ['OFF-1', 'GONE-1', 'DRAFT-1', 'ARCH-1', 'PDEL-1']) {
        const response = await putItem(app, code, { quantity: 1 }, token);
        expect(response.status, code).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      }
      expect(await cartRows()).toHaveLength(1);
      expect(await lineRows((await cartRows())[0]!.id)).toEqual([]);
    });

    it('KEEPS an existing line whose SKU is later deactivated, and flags it', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 2 }, token);

      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));

      const response = await getCart(app, token);
      /**
       * The line stays. Silently discarding a customer's basket contents because a merchant
       * edited a listing would be worse than telling them — so it comes back flagged and the
       * client decides what to say.
       */
      expect(response.body.cart.items).toHaveLength(1);
      expect(response.body.cart.items[0].skuCode).toBe(CODE);
      expect(response.body.cart.items[0].isPurchasable).toBe(false);
      expect(response.body.cart.items[0].quantity).toBe(2);
      // Still counted in the total: what to do about it is not the cart's decision.
      expect(response.body.cart.cartTotal).toBe('2998.0000');
    });

    it('KEEPS an existing line whose SKU is later soft-deleted', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);

      await db().update(sku).set({ deletedAt: new Date() }).where(eq(sku.id, created.id));

      const response = await getCart(app, token);
      expect(response.body.cart.items).toHaveLength(1);
      expect(response.body.cart.items[0].isPurchasable).toBe(false);
    });

    it('KEEPS an existing line whose PRODUCT is later unpublished or deleted', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);

      await db()
        .update(product)
        .set({ status: 'archived' })
        .where(eq(product.id, created.productId));
      expect((await getCart(app, token)).body.cart.items[0].isPurchasable).toBe(false);

      await db()
        .update(product)
        .set({ status: 'active', deletedAt: new Date() })
        .where(eq(product.id, created.productId));
      expect((await getCart(app, token)).body.cart.items[0].isPurchasable).toBe(false);
    });

    it('lets a customer REMOVE a line that is no longer purchasable', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);
      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));

      /**
       * The delete deliberately does NOT filter on purchasability. Otherwise a customer would
       * be stuck holding something they can neither buy nor remove.
       */
      expect((await deleteItem(app, CODE, token)).status).toBe(204);
      expect((await getCart(app, token)).body.cart.items).toEqual([]);
    });

    it('refuses to UPDATE the quantity of a line that is no longer purchasable', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);
      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));

      // Asymmetric with delete, on purpose: removing is always allowed, but committing to MORE
      // of something unbuyable is not.
      expect((await putItem(app, CODE, { quantity: 5 }, token)).status).toBe(404);
      expect((await getCart(app, token)).body.cart.items[0].quantity).toBe(1);
    });
  });

  /* ── Quantity ──────────────────────────────────────────────────────────── */

  describe('quantity', () => {
    it('accepts the boundaries 1 and 999', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      expect((await putItem(app, CODE, { quantity: 1 }, token)).status).toBe(200);
      const max = await putItem(app, CODE, { quantity: 999 }, token);
      expect(max.status).toBe(200);
      expect(max.body.cart.items[0].quantity).toBe(999);
    });

    it('rejects 0, negatives, and anything above 999', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      for (const quantity of [0, -1, -999, 1000, 100_000]) {
        const response = await putItem(app, CODE, { quantity }, token);
        expect(response.status, String(quantity)).toBe(400);
        // A clean validation error, never a leaked SQLSTATE 23514 from the CHECK.
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(JSON.stringify(response.body.error.details)).toContain('quantity');
      }
      /**
       * And nothing was written — not even a cart. Validation runs BEFORE the handler, so a
       * rejected quantity does not create the customer's cart as a side effect.
       */
      expect(await cartRows()).toEqual([]);
    });

    it('rejects fractional, string, null, missing and non-finite quantities', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      const bodies: unknown[] = [
        { quantity: 1.5 },
        { quantity: 0.1 },
        { quantity: '3' },
        { quantity: null },
        { quantity: true },
        { quantity: [] },
        {},
        { quantity: Number.MAX_SAFE_INTEGER + 2 },
      ];

      for (const body of bodies) {
        const response = await putItem(app, CODE, body, token);
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('rejects an unknown body field', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      expect((await putItem(app, CODE, { quantity: 1, note: 'x' }, token)).status).toBe(400);
    });
  });

  /* ── Money ─────────────────────────────────────────────────────────────── */

  describe('money', () => {
    it('computes line totals exactly at the storage scale', async () => {
      await givenSku({ price: '1499.0000' });
      const { app, token } = await customerApp();

      const response = await putItem(app, CODE, { quantity: 3 }, token);

      expect(response.body.cart.items[0].unitPrice).toBe('1499.0000');
      expect(response.body.cart.items[0].lineTotal).toBe('4497.0000');
      expect(response.body.cart.cartTotal).toBe('4497.0000');
    });

    it('preserves FOUR decimal places without float drift', async () => {
      /**
       * `0.1 * 3` in IEEE-754 is `0.30000000000000004`. Through `shared/money.ts` it is exact,
       * which is the entire reason prices are `NUMERIC(19,4)` decimal strings and never JSON
       * numbers.
       */
      await givenSku({ price: '0.1000' });
      const { app, token } = await customerApp();

      const response = await putItem(app, CODE, { quantity: 3 }, token);

      expect(response.body.cart.items[0].lineTotal).toBe('0.3000');
      expect(response.body.cart.cartTotal).toBe('0.3000');
      expect(JSON.stringify(response.body)).not.toContain('0.30000000000000004');
    });

    it('sums several lines exactly', async () => {
      await givenSku({ code: 'A-1', price: '19.9900', productSlug: 'p-a' });
      await givenSku({ code: 'B-2', price: '0.0001', productSlug: 'p-b' });
      const { app, token } = await customerApp();

      await putItem(app, 'A-1', { quantity: 3 }, token);
      const response = await putItem(app, 'B-2', { quantity: 7 }, token);

      // 19.99 * 3 = 59.97, 0.0001 * 7 = 0.0007, total 59.9707.
      expect(response.body.cart.cartTotal).toBe('59.9707');
    });

    it('returns prices as STRINGS, never JSON numbers', async () => {
      await givenSku({ price: '10.0000' });
      const { app, token } = await customerApp();

      const response = await putItem(app, CODE, { quantity: 2 }, token);

      expect(typeof response.body.cart.items[0].unitPrice).toBe('string');
      expect(typeof response.body.cart.items[0].lineTotal).toBe('string');
      expect(typeof response.body.cart.cartTotal).toBe('string');
    });

    it('reflects a SKU price change on the next read — no cart snapshot', async () => {
      const created = await givenSku({ price: '100.0000' });
      const { app, token } = await customerApp();
      const before = await putItem(app, CODE, { quantity: 2 }, token);
      expect(before.body.cart.cartTotal).toBe('200.0000');

      await db().update(sku).set({ price: '150.0000' }).where(eq(sku.id, created.id));

      /**
       * The consequence of storing no price on the cart. §3 decision 9 puts snapshotting on
       * ORDER lines; a cart snapshot would be a second, competing one with no defined
       * precedence at checkout — and a cart three weeks old would quote a withdrawn price.
       */
      const after = await getCart(app, token);
      expect(after.body.cart.items[0].unitPrice).toBe('150.0000');
      expect(after.body.cart.cartTotal).toBe('300.0000');
      // And nothing price-shaped is stored on the line.
      const [line] = await lineRows(after.body.cart.id as string);
      expect(Object.keys(line ?? {})).not.toContain('unitPrice');
      expect(Object.keys(line ?? {})).not.toContain('price');
    });

    it('reports the STORE currency', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      const response = await putItem(app, CODE, { quantity: 1 }, token);
      // Derived from the store, which is the currency aggregate — the cart has no column.
      expect(response.body.cart.currency).toBe('INR');
    });

    it('totals an empty cart as zero at the storage scale', async () => {
      const { app, token } = await customerApp();

      expect((await getCart(app, token)).body.cart.cartTotal).toBe('0.0000');
    });
  });

  /* ── Inventory is untouched ────────────────────────────────────────────── */

  describe('inventory', () => {
    it('does NOT block on insufficient stock and does NOT reserve', async () => {
      const created = await givenSku();
      await db().insert(stockItem).values({ skuId: created.id, storeId, onHand: 2, reserved: 0 });
      const { app, token } = await customerApp();

      /**
       * A cart of 50 against 2 in stock is ACCEPTED. Without reservations an availability check
       * would be stale the instant it returned, and §39 records that authoritative allocation
       * belongs to the order increment. This is deliberate, not an oversight.
       */
      const response = await putItem(app, CODE, { quantity: 50 }, token);
      expect(response.status).toBe(200);
      expect(response.body.cart.items[0].quantity).toBe(50);

      const [stock] = await db().select().from(stockItem).where(eq(stockItem.skuId, created.id));
      expect(stock?.onHand).toBe(2);
      expect(stock?.reserved).toBe(0);
      expect(stock?.available).toBe(2);
    });

    it('does NOT require a stock row to exist at all', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      // Cart never reads inventory, so a SKU with no projection row is still addable.
      expect((await putItem(app, CODE, { quantity: 1 }, token)).status).toBe(200);
      expect(await db().select().from(stockItem)).toEqual([]);
    });

    it('leaves reserved untouched through add, update, remove and clear', async () => {
      const created = await givenSku();
      await db().insert(stockItem).values({ skuId: created.id, storeId, onHand: 10, reserved: 0 });
      const { app, token } = await customerApp();

      await putItem(app, CODE, { quantity: 3 }, token);
      await putItem(app, CODE, { quantity: 8 }, token);
      await deleteItem(app, CODE, token);
      await putItem(app, CODE, { quantity: 2 }, token);
      await clearCart(app, token);

      const [stock] = await db().select().from(stockItem).where(eq(stockItem.skuId, created.id));
      expect(stock?.reserved).toBe(0);
      expect(stock?.onHand).toBe(10);
      // And no stock ledger entries either: the cart performs no adjustments.
      const { stockLedger } = await import('../../../db/schema/inventory.js');
      expect(await db().select().from(stockLedger)).toEqual([]);
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  describe('concurrency', () => {
    /**
     * Every case runs through `Promise.all`. `DATABASE_POOL_MAX` is 5 in tests and each
     * statement takes its own connection, so these are genuinely concurrent database
     * operations rather than sequential awaits dressed up as parallel ones.
     */
    it('creates exactly ONE cart under concurrent first GETs', async () => {
      const { app, token } = await customerApp();

      const results = await Promise.all([getCart(app, token), getCart(app, token)]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const ids = results.map((r) => r.body.cart.id as string);
      /**
       * Both callers get the SAME cart, and there is exactly one row. `uq_cart_active` admits
       * one insert and the loser re-reads in a fresh snapshot — which is why the insert and the
       * read are two statements rather than one CTE: the single-statement form returns nothing
       * to the loser, measured during the design review.
       */
      expect(ids[0]).toBe(ids[1]);
      expect(await cartRows()).toHaveLength(1);
    });

    it('creates exactly ONE cart under eight concurrent first GETs', async () => {
      const { app, token } = await customerApp();

      const results = await Promise.all(Array.from({ length: 8 }, () => getCart(app, token)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      const ids = new Set(results.map((r) => r.body.cart.id as string));
      expect(ids.size).toBe(1);
      expect(await cartRows()).toHaveLength(1);
    });

    it('produces ONE line under concurrent PUTs of the same SKU', async () => {
      await givenSku();
      const { app, token } = await customerApp();
      await getCart(app, token);

      const results = await Promise.all([
        putItem(app, CODE, { quantity: 4 }, token),
        putItem(app, CODE, { quantity: 4 }, token),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const cartId = (await cartRows())[0]!.id;
      // The `(cart_id, sku_id)` primary key is the whole mechanism: never two lines.
      expect(await lineRows(cartId)).toHaveLength(1);
      expect((await lineRows(cartId))[0]?.quantity).toBe(4);
    });

    it('resolves concurrent PUTs of DIFFERENT quantities to last-writer-wins', async () => {
      await givenSku();
      const { app, token } = await customerApp();
      await getCart(app, token);

      const results = await Promise.all([
        putItem(app, CODE, { quantity: 3 }, token),
        putItem(app, CODE, { quantity: 7 }, token),
      ]);

      // Both succeed — neither is rejected — and the surviving quantity is one of the two.
      expect(results.every((r) => r.status === 200)).toBe(true);
      const cartId = (await cartRows())[0]!.id;
      const lines = await lineRows(cartId);
      expect(lines).toHaveLength(1);
      /**
       * Last writer wins. The guarantee is "exactly one line with one of the requested
       * quantities", NOT which one — claiming more than the database provides would be
       * manufacturing a promise.
       */
      expect([3, 7]).toContain(lines[0]?.quantity);
    });

    it('leaves a consistent state when a PUT races a DELETE', async () => {
      await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 2 }, token);

      const [put, del] = await Promise.all([
        putItem(app, CODE, { quantity: 9 }, token),
        deleteItem(app, CODE, token),
      ]);

      /**
       * Both orderings are legal and both are observable: either the delete lands first and the
       * PUT re-creates the line, or the PUT lands first and the delete removes it. What must
       * never happen is two lines, or a line with a quantity nobody asked for.
       */
      expect(put.status).toBe(200);
      expect([204, 404]).toContain(del.status);
      const cartId = (await cartRows())[0]!.id;
      const lines = await lineRows(cartId);
      expect(lines.length).toBeLessThanOrEqual(1);
      if (lines.length === 1) expect(lines[0]?.quantity).toBe(9);
    });

    it('keeps two customers’ concurrent carts separate', async () => {
      await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;

      await Promise.all([
        putItem(app, CODE, { quantity: 2 }, ada.token),
        putItem(app, CODE, { quantity: 5 }, grace.token),
      ]);

      // Two carts, each with its own line — the unique index is per (user, store).
      expect(await cartRows()).toHaveLength(2);
      expect(qtyOf((await getCart(app, ada.token)).body, CODE)).toBe(2);
      expect(qtyOf((await getCart(app, grace.token)).body, CODE)).toBe(5);
    });
  });

  /* ── No audit, no events ───────────────────────────────────────────────── */

  describe('audit and events', () => {
    it('writes NO audit rows and emits NO events for any cart mutation', async () => {
      await givenSku();
      const { app, token } = await customerApp();

      await getCart(app, token);
      await putItem(app, CODE, { quantity: 3 }, token);
      await putItem(app, CODE, { quantity: 1 }, token);
      await deleteItem(app, CODE, token);
      await putItem(app, CODE, { quantity: 2 }, token);
      await clearCart(app, token);

      /**
       * Deliberate, and asserted so that adding either later is a conscious decision rather
       * than an accident. Nothing consumes a cart change, and a customer adjusting their own
       * basket is neither privileged nor security-relevant — an audit row per quantity tweak
       * would bury the entries that matter.
       */
      const audit = await db().select().from(auditLog);
      expect(audit.filter((r) => r.resourceType === 'cart')).toEqual([]);
      expect(audit.filter((r) => r.action.startsWith('cart.'))).toEqual([]);

      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'cart')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('cart.'))).toEqual([]);
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * These distinguish a DATABASE guarantee from an application check. Each writes with direct
     * SQL, bypassing the service entirely, and asserts the NAMED constraint that refuses it.
     */
    it('refuses a SECOND active cart for one customer', async () => {
      const { app, token, userId } = await customerApp();
      await getCart(app, token);

      // `uq_cart_active` is what makes "exactly one active cart" true rather than hoped for.
      await expectConstraint(
        db().insert(cart).values({ id: newId(), userId, storeId, status: 'active' }),
        'uq_cart_active',
      );
    });

    it('ALLOWS a second cart once the first is checked_out', async () => {
      const { app, token, userId } = await customerApp();
      const first = (await getCart(app, token)).body.cart.id as string;
      await db().update(cart).set({ status: 'checked_out' }).where(eq(cart.id, first));

      // The partial predicate is the point: history does not block the next basket.
      await db().insert(cart).values({ id: newId(), userId, storeId, status: 'active' });
      expect(await cartRows()).toHaveLength(2);
    });

    it('refuses an unknown cart status', async () => {
      const { userId } = await customerApp();

      await expectConstraint(
        db().insert(cart).values({ id: newId(), userId, storeId, status: 'abandoned' }),
        'ck_cart_status',
      );
    });

    it('refuses a cart whose store is not its user’s store', async () => {
      const { userId } = await customerApp();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db().insert(cart).values({ id: newId(), userId, storeId: otherStoreId, status: 'active' }),
        'fk_cart_user_store',
      );
    });

    it('refuses a DUPLICATE line for one SKU in one cart', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);
      const cartId = (await cartRows())[0]!.id;

      await expectConstraint(
        db().insert(cartLine).values({ cartId, skuId: created.id, storeId, quantity: 2 }),
        'pk_cart_line',
      );
    });

    it('refuses a line whose store disagrees with its CART', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await getCart(app, token);
      const cartId = (await cartRows())[0]!.id;
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db()
          .insert(cartLine)
          .values({ cartId, skuId: created.id, storeId: otherStoreId, quantity: 1 }),
        'fk_cart_line_cart_store',
      );
    });

    it('refuses a line holding ANOTHER STORE’s SKU', async () => {
      const { app, token } = await customerApp();
      await getCart(app, token);
      const cartId = (await cartRows())[0]!.id;

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const theirs = await givenSku({
        code: 'THEIRS-1',
        storeId: otherStoreId,
        productSlug: 'p-theirs',
      });

      /**
       * The pair of composite keys makes cross-store contamination UNREPRESENTABLE: both pin
       * the same `store_id` column, so naming our store fails the SKU key and naming theirs
       * fails the cart key. Either way the row cannot exist.
       */
      await expectConstraint(
        db().insert(cartLine).values({ cartId, skuId: theirs.id, storeId, quantity: 1 }),
        'fk_cart_line_sku_store',
      );
    });

    it('refuses a quantity outside 1..999', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await getCart(app, token);
      const cartId = (await cartRows())[0]!.id;

      for (const quantity of [0, -1, 1000]) {
        await expectConstraint(
          db().insert(cartLine).values({ cartId, skuId: created.id, storeId, quantity }),
          'ck_cart_line_quantity',
        );
      }
    });

    it('refuses a HARD delete of a SKU that is in a cart', async () => {
      const created = await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);

      // RESTRICT: a customer's basket is not something to discard on a merchant's mistake.
      await expectConstraint(
        db().delete(sku).where(eq(sku.id, created.id)),
        'fk_cart_line_sku_store',
      );
    });

    it('CASCADES lines when a cart row is hard-deleted', async () => {
      await givenSku();
      const { app, token } = await customerApp();
      await putItem(app, CODE, { quantity: 1 }, token);
      const cartId = (await cartRows())[0]!.id;
      expect(await lineRows(cartId)).toHaveLength(1);

      /**
       * The one cascade in this schema. The application never hard-deletes a cart, so it fires
       * only for an operator or a future purge — where taking the lines along is exactly right,
       * because a line has no meaning without its cart and a cart is not an order.
       */
      await db().delete(cart).where(eq(cart.id, cartId));
      expect(await lineRows(cartId)).toEqual([]);
    });

    it('refuses a HARD delete of a user who has a cart', async () => {
      const { app, token, userId } = await customerApp();
      await getCart(app, token);

      await expectConstraint(
        db().delete(appUser).where(eq(appUser.id, userId)),
        'fk_cart_user_store',
      );
    });
  });

  /* ── Repository-level isolation ────────────────────────────────────────── */

  describe('repository isolation', () => {
    it('scopes every read and write by user and/or store', async () => {
      const created = await givenSku();
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      await putItem(built.app, CODE, { quantity: 3 }, ada.token);
      const adaCartId = (await cartRows())[0]!.id;
      const { repository } = built;

      /**
       * Asserted at the REPOSITORY level as well as through HTTP. A guarantee that lives only
       * in a route is one refactor from a leak, and a future caller arriving from a CLI command
       * gets no middleware at all.
       */
      expect(await repository.findActiveCart({ userId: grace.userId, storeId })).toBeUndefined();
      expect(
        await repository.findActiveCart({ userId: ada.userId, storeId: newId() }),
      ).toBeUndefined();
      expect(await repository.listLines({ cartId: adaCartId, storeId: newId() })).toEqual([]);
      expect(
        await repository.deleteLine({ cartId: adaCartId, storeId: newId(), skuId: created.id }),
      ).toBe(false);
      expect(
        await repository.findPurchasableSkuByCode({ storeId: newId(), code: CODE }),
      ).toBeUndefined();

      // Ada's line is untouched.
      expect((await lineRows(adaCartId))[0]?.quantity).toBe(3);
    });

    it('uses ONE purchasability definition for the filter and the flag', async () => {
      const created = await givenSku();
      const built = build();
      const { repository } = built;
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });

      expect(await repository.findPurchasableSkuByCode({ storeId, code: CODE })).toBeDefined();

      await db().update(sku).set({ isActive: false }).where(eq(sku.id, created.id));

      /**
       * The add path filters on it and the read path SELECTS it as a boolean. Two copies of
       * this rule is how "you cannot add this" and "this is fine in your cart" end up
       * disagreeing, so the same predicate serves both — asserted from both sides.
       */
      expect(await repository.findPurchasableSkuByCode({ storeId, code: CODE })).toBeUndefined();

      const [aCart] = await db()
        .insert(cart)
        .values({ id: newId(), userId: ada.userId, storeId })
        .returning({ id: cart.id });
      await db()
        .insert(cartLine)
        .values({ cartId: aCart!.id, skuId: created.id, storeId, quantity: 1 });

      const lines = await repository.listLines({ cartId: aCart!.id, storeId });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.isPurchasable).toBe(false);
    });
  });
});
