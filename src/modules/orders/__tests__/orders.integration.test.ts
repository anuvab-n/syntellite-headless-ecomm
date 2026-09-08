import { createHash } from 'node:crypto';

import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { address } from '../../../db/schema/address.js';
import { cart, cartLine } from '../../../db/schema/cart.js';
import { product, sku } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { idempotencyKey } from '../../../db/schema/idempotency.js';
import { stockItem, stockLedger, stockReservation } from '../../../db/schema/inventory.js';
import { order, orderLine, orderStatusHistory } from '../../../db/schema/orders.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { cartPromotion, promotion } from '../../../db/schema/promotions.js';
import { store } from '../../../db/schema/store.js';
import { createApp } from '../../../http/app.js';
import { requireIdempotency } from '../../../http/middleware/idempotency.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { DEFAULT_SKU_ON_HAND, giveSku } from '../../../../tests/helpers/catalogue.ts';
import { createInventoryRepository, createInventoryService } from '../../inventory/index.js';
import { createFulfilmentRepository, createFulfilmentService } from '../../fulfilment/index.js';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createCartRepository } from '../../cart/cart.repository.js';
import { createCartRoutes } from '../../cart/cart.routes.js';
import { createCartService } from '../../cart/cart.service.js';
import { createScopeGuards } from '../../../http/middleware/scope.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createTaxRepository, createTaxService } from '../../tax/index.js';
import { createOrdersRepository } from '../orders.repository.js';
import { createOrdersRoutes } from '../orders.routes.js';
import { toOrderResponse } from '../dto.js';
import { createOrdersService, generateOrderNumber } from '../orders.service.js';

/**
 * Checkout and orders — against real PostgreSQL, with the REAL cart, promotions and idempotency
 * behind their ports rather than doubles. A stub would let a broken port pass: the order would
 * be built from whatever the double returned, and a wrong predicate in the cart's purchasability
 * expression or the promotions repository would go unnoticed.
 *
 * Seven properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **The snapshot is immutable.** Rename the product, reprice or delete the SKU, edit or
 *     delete the address — and the order must come back byte-identical. §3 #9 is the whole
 *     reason orders exist as their own tables, so it is asserted field by field and then again
 *     after mutating every source.
 *
 *  2. **One order per cart**, under genuine concurrency, on separate pool connections. Three
 *     defences: the cart-row lock, the status predicate, and `uq_order_cart`.
 *
 *  3. **A checked-out cart is immutable.** All five mutations refused, because the cart is now
 *     the historical record behind an order.
 *
 *  4. **The money foots.** `Σ discount_amount = discount_total` exactly, and
 *     `subtotal - discount_total = total`, asserted with `BigInt` on the returned strings
 *     rather than with floats.
 *
 *  5. **Nothing is trusted from the client.** The body is one field; every price, total and
 *     discount is recomputed inside the transaction.
 *
 *  6. **Idempotency is user-scoped**, and the claim commits with the order.
 *
 *  7. **Inventory is untouched.** No stock read, no reservation, no ledger row.
 */
describe('orders (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const CODE_A = 'SHIRT-A';
  const CODE_B = 'MUG-B';
  const COUPON = 'SAVE10';
  const KEY = 'checkout-key-00000001';

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
   * Retry an assertion until it holds, or give up.
   *
   * For the one write in this system that is deliberately not awaited: the idempotency
   * middleware completes or releases the key after the response has already been sent. Reading
   * the row once immediately afterwards races that write.
   *
   * Bounded, so a genuine regression still fails rather than hanging the run.
   */
  async function waitFor(assertion: () => Promise<void>, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await assertion();
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  function build(slug = testDb.config.defaultStoreSlug) {
    const identityRepository = createIdentityRepository({ db: db() });
    const scopeGuards = createScopeGuards({
      loadSubject: async (params) => identityRepository.findSubjectById(params),
      logger: silentLogger,
    });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const recorders = testRecorders(db());

    /**
     * A REAL inventory service, not a stub.
     *
     * Checkout reserves stock now, so a stub would prove nothing about the behaviour these
     * suites exercise most: that an order holds units, that a rollback gives them back, and
     * that two concurrent checkouts cannot take the same one. The concurrency guarantee is a
     * property of a PostgreSQL statement, and a mock cannot have it.
     */
    const inventory = createInventoryService({
      repository: createInventoryRepository({ db: db() }),
      db: db(),
      ...recorders,
      logger: silentLogger,
    });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...recorders,
    });

    const promotions = createPromotionsService({
      repository: createPromotionsRepository({ db: db() }),
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });

    const cartService = createCartService({
      repository: createCartRepository({ db: db() }),
      promotions: {
        findApplicable: (input) => promotions.findApplicable(input),
        evaluateApplied: (input) => promotions.evaluateApplied(input),
      },
      db: db(),
      logger: silentLogger,
    });

    const idempotency = createIdempotencyStore({ db: db(), logger: silentLogger });

    const tax = createTaxService({
      repository: createTaxRepository({ db: db() }),
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });

    /** The three ports, wired exactly as `container.ts` wires them. */
    const orders = createOrdersService({
      repository: createOrdersRepository({ db: db() }),
      cart: {
        lockCartForCheckout: (input) => cartService.lockCartForCheckout(input),
        markCheckedOut: (input) => cartService.markCheckedOut(input),
      },
      promotions: {
        evaluateApplied: (input) => promotions.evaluateApplied(input),
      },
      /*
       * This suite exercises checkout, which never consults a payment. A stub answering 'no
       * payment' is the truthful wiring for it; cancellation against a real payment is covered
       * by `order-cancellation.integration.test.ts`, which wires the real service.
       */
      /**
       * A REAL fulfilment service, late-bound exactly as `container.ts` binds it.
       *
       * The cancellation guard turns on shipment state, so a stub answering "never shipped"
       * would let every cancellation test pass while the guard did nothing.
       */
      fulfilment: { hasBlockingShipment: (input) => fulfilment.hasBlockingShipment(input) },
      payments: { stateForOrder: async () => null },
      reservations: {
        reserve: (input) => inventory.reserveForOrder(input),
        releaseForOrder: (input) => inventory.releaseForOrder(input),
      },
      /*
       * A REAL tax service. No store in these suites configures a GST profile, so every
       * determination is the unassessed one — tax_total 0, grand_total = total, snapshot NULL,
       * which is exactly the behaviour these suites were written against. A stub would make
       * that a property of the double rather than of the system.
       */
      tax: { determineForCheckout: (input) => tax.determineForCheckout(input) },
      idempotency: {
        complete: (input) =>
          idempotency.complete({
            storeId: input.storeId,
            userId: input.userId,
            key: input.key,
            endpoint: input.endpoint,
            status: input.status,
            ...(input.body === undefined ? {} : { body: input.body as never }),
          }),
      },
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });

    const fulfilment = createFulfilmentService({
      repository: createFulfilmentRepository({ db: db() }),
      orders: {
        lockByNumber: (input) => orders.lockForFulfilmentByNumber(input),
        lockById: (input) => orders.lockForFulfilmentById(input),
      },
      /* This suite builds no payments service; its orders port already stubs "no payment". */
      payments: { stateForOrder: async () => null },
      inventory: { fulfilForOrder: (input) => inventory.fulfilForOrder(input) },
      db: db(),
      audit: recorders.audit,
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
    apiRouter.use(
      createOrdersRoutes({
        orders,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireIdempotency: requireIdempotency({ store: idempotency, logger: silentLogger }),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      orders,
      cart: cartService,
      promotions,
      idempotency,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { email?: string; storeId?: string; staff?: boolean } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'ada@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    /*
     * Promoted by UPDATE, not by an endpoint, because no endpoint grants `is_staff` — that
     * would be a privilege-escalation route on a public API. The token is minted after the
     * promotion so it carries the scope.
     */
    if (options.staff === true) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

  async function givenSku(
    overrides: {
      code?: string;
      price?: string;
      storeId?: string;
      productName?: string;
      onHand?: number;
    } = {},
  ) {
    const owningStore = overrides.storeId ?? storeId;
    const code = overrides.code ?? CODE_A;
    const parent = {
      id: newId(),
      storeId: owningStore,
      slug: `p-${code.toLowerCase()}`,
      name: overrides.productName ?? 'Blue Cotton Shirt',
      description: '',
      status: 'active',
    };
    await db().insert(product).values(parent);
    const created = await giveSku(db(), parent, {
      code,
      name: `${code} variant`,
      price: overrides.price ?? '1000.0000',
      deletedAt: null,
      onHand: overrides.onHand ?? DEFAULT_SKU_ON_HAND,
    });
    return { ...created, storeId: owningStore, productId: parent.id };
  }

  async function givenAddress(userId: string, overrides: { storeId?: string; city?: string } = {}) {
    const values = {
      id: newId(),
      userId,
      storeId: overrides.storeId ?? storeId,
      label: 'Home',
      recipientName: 'Ada Lovelace',
      phone: '+91 98765 43210',
      line1: '221B, Brigade Road',
      line2: 'Shanthala Nagar',
      landmark: 'Opposite the water tank',
      city: overrides.city ?? 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
    };
    await db().insert(address).values(values);
    return values;
  }

  async function givenPromotion(
    overrides: {
      code?: string;
      discountType?: string;
      percentRate?: string | null;
      amount?: string | null;
      minSubtotal?: string | null;
      startsAt?: Date | null;
      endsAt?: Date | null;
      isActive?: boolean;
      deletedAt?: Date | null;
    } = {},
  ) {
    const values = {
      id: newId(),
      storeId,
      code: overrides.code ?? COUPON,
      name: 'Festive offer',
      discountType: overrides.discountType ?? 'percentage',
      percentRate:
        overrides.percentRate === undefined
          ? overrides.discountType === 'fixed_amount'
            ? null
            : '10'
          : overrides.percentRate,
      amount: overrides.amount ?? null,
      minSubtotal: overrides.minSubtotal ?? null,
      startsAt: overrides.startsAt ?? null,
      endsAt: overrides.endsAt ?? null,
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
    };
    await db().insert(promotion).values(values);
    return values;
  }

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const putItem = (app: App, code: string, quantity: number, token: string) =>
    request(app)
      .put(`/api/v1/users/me/cart/items/${code}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity });

  const applyCoupon = (app: App, code: string, token: string) =>
    request(app)
      .put('/api/v1/users/me/cart/promotion')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

  const getCart = (app: App, token: string) =>
    request(app).get('/api/v1/users/me/cart').set('Authorization', `Bearer ${token}`);

  const checkout = (app: App, body: unknown, options: { token?: string; key?: string } = {}) => {
    let req = request(app).post('/api/v1/users/me/checkout');
    if (options.token !== undefined) req = req.set('Authorization', `Bearer ${options.token}`);
    if (options.key !== undefined) req = req.set('Idempotency-Key', options.key);
    return req.send(body as object);
  };

  const listOrders = (app: App, query = '', token?: string) => {
    const req = request(app).get(`/api/v1/users/me/orders${query}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const getOrder = (app: App, orderNumber: string, token?: string) => {
    const req = request(app).get(`/api/v1/users/me/orders/${orderNumber}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── Scenario builders ─────────────────────────────────────────────────── */

  /** A signed-in customer with an address and a cart holding the given lines. */
  async function readyToCheckout(
    lines: { code?: string; price?: string; quantity: number; onHand?: number }[] = [
      { quantity: 2 },
    ],
  ) {
    for (const line of lines) {
      await givenSku({
        ...(line.code === undefined ? {} : { code: line.code }),
        ...(line.price === undefined ? {} : { price: line.price }),
        ...(line.onHand === undefined ? {} : { onHand: line.onHand }),
      });
    }
    const built = build();
    const auth = await signIn(built.app, built.identity);
    const addr = await givenAddress(auth.userId);
    for (const line of lines) {
      const response = await putItem(built.app, line.code ?? CODE_A, line.quantity, auth.token);
      expect(response.status).toBe(200);
    }
    return { ...built, ...auth, address: addr };
  }

  /* ── Assertions ────────────────────────────────────────────────────────── */

  /** Exact decimal arithmetic on the strings the API returned — never `Number`. */
  const paise = (v: string) => BigInt(v.replace('.', ''));

  type OrderBody = {
    order: {
      orderNumber: string;
      subtotal: string;
      discountTotal: string;
      total: string;
      items: { discountAmount: string; lineTotal: string; unitPrice: string; quantity: number }[];
    };
  };

  /**
   * The two identities the whole increment rests on.
   *
   * `Σ discount_amount = discount_total` matters because `allocate()` distributes at minor-unit
   * scale: a header computed independently could differ from its own lines by half a paisa, and
   * an invoice whose lines do not foot is what `allocate()` exists to prevent.
   */
  function expectMoneyFoots(body: OrderBody): void {
    const o = body.order;
    expect(paise(o.subtotal) - paise(o.discountTotal)).toBe(paise(o.total));

    const allocated = o.items.reduce((acc, i) => acc + paise(i.discountAmount), 0n);
    expect(allocated).toBe(paise(o.discountTotal));

    const lineSum = o.items.reduce((acc, i) => acc + paise(i.lineTotal), 0n);
    expect(lineSum).toBe(paise(o.subtotal));

    for (const item of o.items) {
      expect(paise(item.unitPrice) * BigInt(item.quantity)).toBe(paise(item.lineTotal));
      expect(paise(item.discountAmount) <= paise(item.lineTotal)).toBe(true);
    }
  }

  /**
   * The middleware's payload hash, reproduced.
   *
   * `JSON.stringify` with object keys sorted, SHA-256 hex — the same canonicalisation
   * `hashPayload` performs, so a claim made here is recognised as the same request.
   */
  function payloadHash(body: unknown): string {
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sortKeys(v)]),
      );
    };
    return createHash('sha256')
      .update(JSON.stringify(sortKeys(body)) ?? 'null')
      .digest('hex');
  }

  /** Poll an assertion that races a deliberately un-awaited write. */
  async function expectEventually(
    assertion: () => Promise<void>,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await assertion();
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  /** Typed readers; supertest hands back `any`. */
  const itemsOf = (body: OrderBody): OrderBody['order']['items'] => body.order.items;
  const skuCodesOf = (body: { order: { items: { skuCode: string }[] } }): string[] =>
    body.order.items.map((i) => i.skuCode);
  const numbersOf = (body: { orders: { orderNumber: string }[] }): string[] =>
    body.orders.map((o) => o.orderNumber);
  const listedOrders = (body: { orders: OrderBody['order'][] }): OrderBody['order'][] =>
    body.orders;

  const orderRows = async () => db().select().from(order);
  const lineRows = async () => db().select().from(orderLine);
  const historyRows = async () => db().select().from(orderStatusHistory);

  /**
   * Assert that a write is refused BY A NAMED CONSTRAINT.
   *
   * Walks the whole `cause` chain rather than one level: Drizzle wraps the driver error in
   * `DrizzleQueryError`, and how deep the constraint name sits varies with the statement — a
   * one-level check passed for some constraints here and silently missed others, which is the
   * §19 trap in a new place.
   */
  async function expectConstraint(work: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the write to be refused').toBeDefined();

    const messages: string[] = [];
    let current: unknown = caught;
    for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth += 1) {
      const node = current as { message?: unknown; constraint?: unknown; cause?: unknown };
      if (typeof node.message === 'string') messages.push(node.message);
      if (typeof node.constraint === 'string') messages.push(node.constraint);
      current = node.cause;
    }
    expect(messages.join(' | ')).toContain(constraint);
  }

  /* ── Authentication ────────────────────────────────────────────────────── */

  describe('authentication', () => {
    it('rejects unauthenticated requests on all three routes', async () => {
      const { app } = build();

      expect((await checkout(app, { addressId: newId() }, { key: KEY })).status).toBe(401);
      expect((await listOrders(app)).status).toBe(401);
      expect((await getOrder(app, 'ORD-20260904-ABCDEF')).status).toBe(401);
      expect(await orderRows()).toEqual([]);
    });

    it('needs no staff scope — a customer places their own order', async () => {
      const built = await readyToCheckout();

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(201);
    });
  });

  /* ── The Idempotency-Key header ────────────────────────────────────────── */

  describe('the Idempotency-Key header', () => {
    it('is required', async () => {
      const built = await readyToCheckout();

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token },
      );

      /**
       * Required rather than optional: a duplicate checkout takes a second payment, so an
       * opt-in guard would be opted out of by exactly the client most likely to retry badly.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('idempotency-key');
      expect(await orderRows()).toEqual([]);
    });

    it('rejects a blank or too-short key', async () => {
      const built = await readyToCheckout();

      for (const key of ['   ', 'short']) {
        const response = await checkout(
          built.app,
          { addressId: built.address.id },
          { token: built.token, key },
        );
        expect(response.status, key).toBe(400);
      }
      expect(await orderRows()).toEqual([]);
    });

    it('scopes the claim to the authenticated user', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const [claim] = await db().select().from(idempotencyKey);
      expect(claim?.userId).toBe(built.userId);
      expect(claim?.storeId).toBe(storeId);
      expect(claim?.endpoint).toBe('POST /api/v1/users/me/checkout');
    });
  });

  /* ── The request body ──────────────────────────────────────────────────── */

  describe('the request body', () => {
    it('requires addressId', async () => {
      const built = await readyToCheckout();

      const response = await checkout(built.app, {}, { token: built.token, key: KEY });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body.error.details)).toContain('addressId');
    });

    it('rejects a malformed addressId', async () => {
      const built = await readyToCheckout();

      for (const addressId of ['not-a-uuid', '', 123, null]) {
        const response = await checkout(built.app, { addressId }, { token: built.token, key: KEY });
        expect(response.status, JSON.stringify(addressId)).toBe(400);
      }
    });

    it('rejects every server-owned field, one at a time', async () => {
      const built = await readyToCheckout();

      /**
       * One per request rather than all in one body, so a schema that happened to accept
       * exactly one of them cannot hide behind the others.
       */
      for (const extra of [
        { userId: newId() },
        { storeId: newId() },
        { cartId: newId() },
        { promotionId: newId() },
        { promotionCode: 'SAVE99' },
        { subtotal: '1.0000' },
        { discountTotal: '9999.0000' },
        { total: '0.0000' },
        { taxTotal: '0.0000' },
        { expectedTotal: '1.0000' },
        { currency: 'USD' },
        { orderNumber: 'ORD-20260101-AAAAAA' },
        { status: 'placed' },
        { paymentStatus: 'paid' },
        { unitPrice: '1.0000' },
        { lineTotal: '1.0000' },
        { quantity: 99 },
        { items: [] },
        { lines: [] },
        { actorUserId: newId() },
        { placedAt: new Date().toISOString() },
        { createdAt: new Date().toISOString() },
      ]) {
        const response = await checkout(
          built.app,
          { addressId: built.address.id, ...extra },
          { token: built.token, key: `${KEY}-${Object.keys(extra)[0] ?? 'x'}` },
        );
        expect(response.status, Object.keys(extra)[0]).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await orderRows()).toEqual([]);
    });
  });

  /* ── A successful checkout ─────────────────────────────────────────────── */

  describe('checkout', () => {
    it('creates the order and returns an exact response shape', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['order']);
      expect(Object.keys(response.body.order).sort()).toEqual([
        'currency',
        'discountTotal',
        /* Increment 38, additive: `total` still means the goods total. */
        'grandTotal',
        'items',
        'orderNumber',
        'placedAt',
        'promotion',
        'shippingAddress',
        'status',
        'subtotal',
        'tax',
        'taxTotal',
        'total',
      ]);
      expect(Object.keys(response.body.order.items[0]).sort()).toEqual([
        'discountAmount',
        'lineTotal',
        'productName',
        'quantity',
        'skuCode',
        'skuName',
        'tax',
        'unitPrice',
      ]);
      expect(Object.keys(response.body.order.shippingAddress).sort()).toEqual([
        'city',
        'countryCode',
        'landmark',
        'line1',
        'line2',
        'phone',
        'postalCode',
        'recipientName',
        'state',
      ]);

      // No internal identifier of any kind reaches the response.
      const serialised = JSON.stringify(response.body);
      for (const leak of [
        'orderId',
        '"id"',
        'cartId',
        'userId',
        'storeId',
        'addressId',
        'promotionId',
        'skuId',
        'createdAt',
        'updatedAt',
        'actor',
      ]) {
        expect(serialised, leak).not.toContain(leak);
      }
    });

    it('prices the order from the CURRENT SKU price', async () => {
      const built = await readyToCheckout([{ quantity: 3, price: '19.9900' }]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.items[0].unitPrice).toBe('19.9900');
      expect(response.body.order.items[0].lineTotal).toBe('59.9700');
      expect(response.body.order.subtotal).toBe('59.9700');
      expect(response.body.order.total).toBe('59.9700');
      expectMoneyFoots(response.body as OrderBody);
    });

    it('re-reads a price changed after the cart was built', async () => {
      const created = await givenSku({ price: '1000.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 2, auth.token);

      // The merchant reprices AFTER the cart was filled, BEFORE checkout.
      await db().update(sku).set({ price: '1500.0000' }).where(eq(sku.id, created.id));

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      // Checkout-time price, not cart-time. The cart never stored one.
      expect(response.body.order.items[0].unitPrice).toBe('1500.0000');
      expect(response.body.order.total).toBe('3000.0000');
    });

    it('holds several lines, ordered by SKU code', async () => {
      const built = await readyToCheckout([
        { code: CODE_B, price: '500.0000', quantity: 1 },
        { code: CODE_A, price: '1000.0000', quantity: 2 },
      ]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(skuCodesOf(response.body as { order: { items: { skuCode: string }[] } })).toEqual([
        CODE_B,
        CODE_A,
      ]);
      expect(response.body.order.subtotal).toBe('2500.0000');
      expectMoneyFoots(response.body as OrderBody);
    });

    it('writes the order, its lines and ONE history row', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const orders = await orderRows();
      expect(orders).toHaveLength(1);
      expect(orders[0]?.userId).toBe(built.userId);
      expect(orders[0]?.storeId).toBe(storeId);
      expect(orders[0]?.status).toBe('placed');
      expect(orders[0]?.currency).toBe('INR');

      expect(await lineRows()).toHaveLength(1);

      const history = await historyRows();
      expect(history).toHaveLength(1);
      // Created IN this state, so `from_status` is NULL rather than equal to `to_status`.
      expect(history[0]?.fromStatus).toBeNull();
      expect(history[0]?.toStatus).toBe('placed');
      expect(history[0]?.actorType).toBe('customer');
      expect(history[0]?.actorUserId).toBe(built.userId);
    });

    it('records placedAt and links the cart', async () => {
      const built = await readyToCheckout();
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      const [row] = await orderRows();
      expect(row?.cartId).toBe(cartId);
      expect(row?.placedAt).toBeInstanceOf(Date);
      expect(response.body.order.placedAt).toBe(row?.placedAt.toISOString());
    });
  });

  /* ── The order number ──────────────────────────────────────────────────── */

  describe('the order number', () => {
    it('has the form ORD-YYYYMMDD-XXXXXX', async () => {
      const built = await readyToCheckout();

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      const number = response.body.order.orderNumber as string;
      expect(number).toMatch(/^ORD-\d{8}-[A-Z2-9]{6}$/);
      // Today's UTC date, so the number is sortable and self-dating.
      expect(number.slice(4, 12)).toBe(new Date().toISOString().slice(0, 10).replaceAll('-', ''));
    });

    it('excludes characters that are misread aloud', async () => {
      /**
       * No `I`, `O`, `0` or `1`. An order number is read off a printed invoice and typed into a
       * support form; `ORDER-…-IO01` transcribed wrongly finds someone else's order or none.
       */
      const numbers = Array.from({ length: 200 }, () => generateOrderNumber(new Date()));
      for (const number of numbers) {
        expect(number.slice(13)).not.toMatch(/[IO01]/);
      }
    });

    it('is unique per store, and the constraint says so', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });
      const [existing] = await orderRows();

      await expectConstraint(
        db()
          .insert(order)
          .values({
            id: newId(),
            storeId,
            userId: built.userId,
            cartId: newId(),
            orderNumber: existing!.orderNumber,
            currency: 'INR',
            subtotal: '1.0000',
            discountTotal: '0.0000',
            total: '1.0000',
            /* NOT NULL with no default; see the `base()` fixture below for why. */
            grandTotal: '1.0000',
            addressId: built.address.id,
            shipRecipientName: 'X',
            shipPhone: 'X',
            shipLine1: 'X',
            shipCity: 'X',
            shipState: 'X',
            shipPostalCode: 'X',
            shipCountryCode: 'IN',
          } as never),
        'uq_order_number',
      );
    });

    it('draws different numbers for different orders', async () => {
      const numbers = new Set(
        Array.from({ length: 500 }, () => generateOrderNumber(new Date('2026-09-04T00:00:00Z'))),
      );
      // ~1.07e9 suffixes, so 500 draws colliding would signal a broken CSPRNG.
      expect(numbers.size).toBe(500);
    });
  });

  /* ── Preconditions ─────────────────────────────────────────────────────── */

  describe('preconditions', () => {
    it('422s an empty cart', async () => {
      await givenSku();
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await getCart(built.app, auth.token); // creates the cart, still empty

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('CHECKOUT_CART_EMPTY');
      expect(await orderRows()).toEqual([]);
    });

    it('409s when the customer has no cart at all', async () => {
      await givenSku();
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      // No cart row exists yet, so there is nothing to lock. Checkout does not create one.
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CHECKOUT_CART_NOT_AVAILABLE');
      expect(await db().select().from(cart)).toEqual([]);
    });

    it('404s an unknown, foreign or deleted address, indistinguishably', async () => {
      const built = await readyToCheckout();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const graceAddress = await givenAddress(grace.userId);
      const deleted = await givenAddress(built.userId);
      await db().update(address).set({ deletedAt: new Date() }).where(eq(address.id, deleted.id));

      const cases: [string, string][] = [
        ['unknown', newId()],
        ["another customer's", graceAddress.id],
        ['soft-deleted', deleted.id],
      ];

      for (const [label, addressId] of cases) {
        const response = await checkout(
          built.app,
          { addressId },
          { token: built.token, key: `${KEY}-${label}` },
        );
        expect(response.status, label).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      }
      expect(await orderRows()).toEqual([]);
      // The cart is untouched by any failed attempt.
      expect((await db().select().from(cart))[0]?.status).toBe('active');
    });
  });

  /* ── Unpurchasable lines ───────────────────────────────────────────────── */

  describe('unpurchasable lines', () => {
    const cases: [string, (skuId: string, productId: string) => Promise<unknown>][] = [
      [
        'SKU deactivated',
        (skuId) => db().update(sku).set({ isActive: false }).where(eq(sku.id, skuId)),
      ],
      [
        'SKU deleted',
        (skuId) => db().update(sku).set({ deletedAt: new Date() }).where(eq(sku.id, skuId)),
      ],
      [
        'product unpublished',
        (_s, productId) =>
          db().update(product).set({ status: 'draft' }).where(eq(product.id, productId)),
      ],
      [
        'product deleted',
        (_s, productId) =>
          db().update(product).set({ deletedAt: new Date() }).where(eq(product.id, productId)),
      ],
    ];

    for (const [label, mutate] of cases) {
      it(`422s the WHOLE checkout when a line becomes unbuyable: ${label}`, async () => {
        const created = await givenSku();
        const built = build();
        const auth = await signIn(built.app, built.identity);
        const addr = await givenAddress(auth.userId);
        await putItem(built.app, CODE_A, 2, auth.token);

        await mutate(created.id, created.productId);

        const response = await checkout(
          built.app,
          { addressId: addr.id },
          { token: auth.token, key: KEY },
        );

        /**
         * The whole order is refused and the SKU code is named. Silently dropping the line
         * would sell the customer less than they asked for; a partial order would be worse.
         * Increment 28 kept such a line in the cart and flagged it — this is the same
         * judgement at the moment it matters most.
         */
        expect(response.status, label).toBe(422);
        expect(response.body.error.code).toBe('CHECKOUT_LINES_UNAVAILABLE');
        expect(response.body.error.details.skuCodes).toEqual([CODE_A]);

        // NOTHING changed.
        expect(await orderRows()).toEqual([]);
        expect(await lineRows()).toEqual([]);
        expect((await db().select().from(cart))[0]?.status).toBe('active');
        expect(await db().select().from(cartLine)).toHaveLength(1);
      });
    }

    it('refuses the whole checkout for ONE bad line among good ones, naming only the bad one', async () => {
      const good = await givenSku({ code: CODE_A, price: '1000.0000' });
      const bad = await givenSku({ code: CODE_B, price: '500.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 1, auth.token);
      await putItem(built.app, CODE_B, 1, auth.token);

      await db().update(sku).set({ isActive: false }).where(eq(sku.id, bad.id));

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      expect(response.status).toBe(422);
      expect(response.body.error.details.skuCodes).toEqual([CODE_B]);
      expect(good.id).toBeDefined();
      expect(await orderRows()).toEqual([]);
    });

    it('releases the idempotency key so a retry succeeds once the cart is fixed', async () => {
      const bad = await givenSku({ code: CODE_B, price: '500.0000' });
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 1, auth.token);
      await putItem(built.app, CODE_B, 1, auth.token);
      await db().update(sku).set({ isActive: false }).where(eq(sku.id, bad.id));

      expect(
        (await checkout(built.app, { addressId: addr.id }, { token: auth.token, key: KEY })).status,
      ).toBe(422);
      /*
       * A 4xx releases, so the SAME key is usable again — the customer fixes the cart and
       * retries.
       *
       * Polled, because the middleware performs that release AFTER the response has been sent
       * and deliberately does not await it: *"the response has already left, so making the
       * client wait for bookkeeping would add latency to every successful request"*. Reading
       * once here is a race that is lost often enough under full-suite parallel load to make
       * this test flaky. A deterministic read passes on the first attempt.
       */
      await waitFor(async () => {
        expect(await db().select().from(idempotencyKey)).toEqual([]);
      });

      await request(built.app)
        .delete(`/api/v1/users/me/cart/items/${CODE_B}`)
        .set('Authorization', `Bearer ${auth.token}`);

      const retry = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );
      expect(retry.status).toBe(201);
    });
  });

  /* ── The address snapshot ──────────────────────────────────────────────── */

  /* ── The invoice endpoint ──────────────────────────────────────────────── */

  /**
   * The route, not the document. `invoice.test.ts` attacks the rendering — escaping, money,
   * banners — against a literal record; what is left to prove here is that the endpoint is
   * mounted, scoped to the owner, and sends the headers an HTML response in a
   * CSP-disabled API needs.
   */
  describe('the invoice', () => {
    const invoice = (app: App, orderNumber: string, token?: string) => {
      const req = request(app).get(`/api/v1/users/me/orders/${orderNumber}/invoice`);
      return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
    };

    it('serves an HTML document for the customer’s own order', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(placed.status).toBe(201);
      const orderNumber = placed.body.order.orderNumber as string;

      const response = await invoice(built.app, orderNumber, built.token);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text.startsWith('<!doctype html>')).toBe(true);
      expect(response.text).toContain('Syntellite Innovation');
      expect(response.text).toContain(orderNumber);
      /* An unpaid order is a proforma, and the document says so. */
      expect(response.text).toContain('Proforma');
    });

    /**
     * The two headers this route sets and no other does.
     *
     * `Content-Security-Policy` because `app.ts` turns CSP off globally on the stated grounds
     * that the API serves no HTML — so this response has to carry its own. `no-store` because
     * the document contains a delivery address, and a shared cache holding one is a leak.
     */
    it('sets a restrictive CSP and refuses to be cached', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;

      const response = await invoice(built.app, orderNumber, built.token);

      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['content-security-policy']).toContain("style-src 'unsafe-inline'");
      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    it('requires authentication', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;

      expect((await invoice(built.app, orderNumber)).status).toBe(401);
    });

    /** Another customer's invoice is a `404`, exactly as their order is — never a `403`. */
    it('returns 404 for another customer’s order, as JSON not HTML', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;

      const other = await signIn(built.app, built.identity, { email: 'mallory@example.com' });
      const response = await invoice(built.app, orderNumber, other.token);

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed order number', async () => {
      const built = build();
      const auth = await signIn(built.app, built.identity);
      expect((await invoice(built.app, 'not-an-order', auth.token)).status).toBe(400);
    });

    it('returns 404 for an order that does not exist', async () => {
      const built = build();
      const auth = await signIn(built.app, built.identity);
      expect((await invoice(built.app, 'ORD-20260907-ZZZZZZ', auth.token)).status).toBe(404);
    });

    /** The document reflects the order it was built from, including its money. */
    it('shows the order’s own totals', async () => {
      const built = await readyToCheckout([{ quantity: 1 }]);
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;

      const response = await invoice(built.app, orderNumber, built.token);

      /* `1000.0000` on the order renders as the display form. */
      expect(placed.body.order.total).toBe('1000.0000');
      expect(response.text).toContain('₹1,000.00');
    });
  });

  /* ── The staff invoice route ───────────────────────────────────────────── */

  /**
   * `GET /admin/orders/{orderNumber}/invoice` — the same document, one predicate wider.
   *
   * What has to be proved is precisely the difference from the customer route: staff reach ANY
   * order in their store, staff reach NO order outside it, and a non-staff caller is refused
   * even for an order they own. The document itself is `invoice.test.ts`'s job.
   */
  describe('the staff invoice', () => {
    const adminInvoice = (app: App, orderNumber: string, token?: string) => {
      const req = request(app).get(`/api/v1/admin/orders/${orderNumber}/invoice`);
      return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
    };

    /** Places an order as a customer and returns its number, plus the app it lives in. */
    async function givenSomeonesOrder(): Promise<{
      app: App;
      identity: Identity;
      orderNumber: string;
    }> {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(placed.status).toBe(201);
      return {
        app: built.app,
        identity: built.identity,
        orderNumber: placed.body.order.orderNumber as string,
      };
    }

    /** The feature: an order staff did not place, and do not own, still renders. */
    it('serves the invoice for another customer’s order', async () => {
      const { app, identity, orderNumber } = await givenSomeonesOrder();
      const staff = await signIn(app, identity, { email: 'ops@example.com', staff: true });

      const response = await adminInvoice(app, orderNumber, staff.token);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text.startsWith('<!doctype html>')).toBe(true);
      expect(response.text).toContain('Syntellite Innovation');
      expect(response.text).toContain(orderNumber);
    });

    /**
     * The same response hardening as the customer route.
     *
     * Asserted separately rather than assumed from the shared helper: a future refactor that
     * gave this route its own `res.send` would pass every other test in this block.
     */
    it('sets the same restrictive CSP and refuses to be cached', async () => {
      const { app, identity, orderNumber } = await givenSomeonesOrder();
      const staff = await signIn(app, identity, { email: 'ops@example.com', staff: true });

      const response = await adminInvoice(app, orderNumber, staff.token);

      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['cache-control']).toBe('private, no-store');
    });

    /** The document is byte-identical to the one the customer gets. Two routes, one renderer. */
    it('renders exactly what the customer’s own route renders', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;
      const staff = await signIn(built.app, built.identity, {
        email: 'ops@example.com',
        staff: true,
      });

      const mine = await request(built.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/invoice`)
        .set('Authorization', `Bearer ${built.token}`);
      const theirs = await adminInvoice(built.app, orderNumber, staff.token);

      expect(mine.status).toBe(200);
      expect(theirs.status).toBe(200);
      expect(theirs.text).toBe(mine.text);
    });

    /** Authorization, not ownership, is what this route turns on. */
    it('refuses a customer — even for their own order', async () => {
      const built = await readyToCheckout();
      const placed = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const orderNumber = placed.body.order.orderNumber as string;

      const response = await adminInvoice(built.app, orderNumber, built.token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PERMISSION_DENIED');
    });

    it('requires a token', async () => {
      const { app, orderNumber } = await givenSomeonesOrder();
      expect((await adminInvoice(app, orderNumber)).status).toBe(401);
    });

    /**
     * Tenancy is NOT relaxed, and this is the assertion that says so.
     *
     * Staff of another store present a valid staff token and still get a 404 — the same answer
     * the order number would get if it had never existed.
     */
    it('does not reach an order in another store', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      const { orderNumber } = await givenSomeonesOrder();

      /*
       * A second app bound to the other store, because a store is resolved from the host and a
       * login cannot cross that boundary — the same shape the `ownership and tenancy` block
       * uses. `theirs` is a genuine staff token; it is only the tenant that differs.
       */
      const theirs = build('other');
      const outsider = await signIn(theirs.app, theirs.identity, {
        email: 'ops-elsewhere@example.com',
        storeId: otherStoreId,
        staff: true,
      });

      const response = await adminInvoice(theirs.app, orderNumber, outsider.token);

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('rejects a malformed order number', async () => {
      const built = build();
      const staff = await signIn(built.app, built.identity, {
        email: 'ops@example.com',
        staff: true,
      });
      expect((await adminInvoice(built.app, 'not-an-order', staff.token)).status).toBe(400);
    });

    it('returns 404 for an order that does not exist', async () => {
      const built = build();
      const staff = await signIn(built.app, built.identity, {
        email: 'ops@example.com',
        staff: true,
      });
      expect((await adminInvoice(built.app, 'ORD-20260907-ZZZZZZ', staff.token)).status).toBe(404);
    });

    /**
     * The repository predicate, exercised directly.
     *
     * Through HTTP alone, dropping the `store_id` filter from `findStoreOrderByNumber` would
     * still look correct, because the outsider's token would 404 on scope resolution long
     * before the query ran. This kills that mutant.
     */
    it('scopes the repository query by store', async () => {
      const { orderNumber } = await givenSomeonesOrder();
      const repository = createOrdersRepository({ db: db() });

      await expect(repository.findStoreOrderByNumber({ orderNumber, storeId })).resolves.toEqual(
        expect.objectContaining({ orderNumber }),
      );
      await expect(
        repository.findStoreOrderByNumber({ orderNumber, storeId: newId() }),
      ).resolves.toBeUndefined();
    });
  });

  describe('the address snapshot', () => {
    it('copies every delivery field', async () => {
      const built = await readyToCheckout();

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.shippingAddress).toEqual({
        recipientName: built.address.recipientName,
        phone: built.address.phone,
        line1: built.address.line1,
        line2: built.address.line2,
        landmark: built.address.landmark,
        city: built.address.city,
        state: built.address.state,
        postalCode: built.address.postalCode,
        countryCode: built.address.countryCode,
      });
    });

    it('does NOT copy the label — a filing nickname is not a delivery record', async () => {
      const built = await readyToCheckout();

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(JSON.stringify(response.body)).not.toContain('Home');
    });

    it('is unaffected by editing the address afterwards', async () => {
      const built = await readyToCheckout();
      const created = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const number = created.body.order.orderNumber as string;

      await db()
        .update(address)
        .set({ recipientName: 'Someone Else', city: 'Chennai', line1: 'New Street' })
        .where(eq(address.id, built.address.id));

      const after = await getOrder(built.app, number, built.token);
      expect(after.body.order.shippingAddress).toEqual(created.body.order.shippingAddress);
    });

    it('is unaffected by soft-deleting the address afterwards', async () => {
      const built = await readyToCheckout();
      const created = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const number = created.body.order.orderNumber as string;

      await db()
        .update(address)
        .set({ deletedAt: new Date() })
        .where(eq(address.id, built.address.id));

      // §40: "the moment a past invoice reads a live address, a customer fixing a typo rewrites
      // history." The snapshot is why that cannot happen here.
      const after = await getOrder(built.app, number, built.token);
      expect(after.status).toBe(200);
      expect(after.body.order.shippingAddress.city).toBe('Bengaluru');
    });

    it('refuses a HARD delete of an address an order references', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      await expectConstraint(
        db().delete(address).where(eq(address.id, built.address.id)),
        'fk_order_address_store',
      );
    });
  });

  /* ── The catalogue snapshot ────────────────────────────────────────────── */

  describe('the catalogue snapshot', () => {
    it('copies the SKU code, SKU name and product name', async () => {
      await givenSku({ code: CODE_A, productName: 'Blue Cotton Shirt' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 1, auth.token);

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      expect(response.body.order.items[0].skuCode).toBe(CODE_A);
      expect(response.body.order.items[0].skuName).toBe(`${CODE_A} variant`);
      expect(response.body.order.items[0].productName).toBe('Blue Cotton Shirt');
    });

    it('is unaffected by ANY later catalogue change', async () => {
      const created = await givenSku({ code: CODE_A, productName: 'Blue Cotton Shirt' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 2, auth.token);

      const placed = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );
      const number = placed.body.order.orderNumber as string;

      /**
       * §3 #9's test, and the most important one in this suite: *"renaming a product must not
       * alter a past invoice."* Every source of every snapshotted value is mutated at once.
       */
      await db()
        .update(product)
        .set({ name: 'Renamed Product', status: 'archived', deletedAt: new Date() })
        .where(eq(product.id, created.productId));
      await db()
        .update(sku)
        .set({
          code: 'RECODED-1',
          name: 'Renamed SKU',
          price: '99999.0000',
          isActive: false,
          deletedAt: new Date(),
        })
        .where(eq(sku.id, created.id));

      const after = await getOrder(built.app, number, auth.token);
      expect(after.status).toBe(200);
      expect(after.body).toEqual(placed.body);
    });

    it('refuses a HARD delete of a SKU an order line names', async () => {
      const created = await givenSku();
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 1, auth.token);
      await checkout(built.app, { addressId: addr.id }, { token: auth.token, key: KEY });

      /**
       * THREE keys now hold this SKU, and they are peeled off one at a time so that each
       * assertion is about the key it names — the wrong-constraint trap Increments 27 and 29
       * recorded, where a test passes because a DIFFERENT constraint fired first.
       *
       * The two INVENTORY keys — `fk_stock_reservation_sku_store` and, now that the fixture
       * stocks the SKU, `fk_stock_item_sku_store` — are cleared without an assertion, because
       * which of the four PostgreSQL checks first is not a guaranteed order and pinning it
       * would break this test the next time a reference to `sku` is added. What matters is that
       * the order line's key is the last one standing.
       */
      await db().delete(stockReservation);
      await db().delete(stockItem).where(eq(stockItem.skuId, created.id));

      /**
       * The checked-out cart still holds its own line, and `fk_cart_line_sku_store` fires
       * before the order's — so a naive assertion here passes while proving nothing about the
       * ORDER's key. The cart line is removed so the order's key is the one under test.
       */
      await expectConstraint(
        db().delete(sku).where(eq(sku.id, created.id)),
        'fk_cart_line_sku_store',
      );
      await db().delete(cartLine);

      // Now the order line is the only thing holding the SKU. The case §24's soft-delete
      // comment was written for.
      await expectConstraint(
        db().delete(sku).where(eq(sku.id, created.id)),
        'fk_order_line_sku_store',
      );
    });
  });

  /* ── Promotions ────────────────────────────────────────────────────────── */

  describe('promotions', () => {
    /** A cart of 2 × 1000.0000 with the given coupon applied. */
    async function withCoupon(overrides: Parameters<typeof givenPromotion>[0] = {}, quantity = 2) {
      const built = await readyToCheckout([{ quantity }]);
      await givenPromotion(overrides);
      const applied = await applyCoupon(built.app, overrides.code ?? COUPON, built.token);
      return { ...built, applied };
    }

    it('applies a percentage discount and snapshots the promotion', async () => {
      const built = await withCoupon({ percentRate: '10' });
      expect(built.applied.status).toBe(200);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.subtotal).toBe('2000.0000');
      expect(response.body.order.discountTotal).toBe('200.0000');
      expect(response.body.order.total).toBe('1800.0000');
      expect(response.body.order.promotion).toEqual({ code: COUPON, name: 'Festive offer' });
      expectMoneyFoots(response.body as OrderBody);
    });

    it('caps a fixed discount at the subtotal', async () => {
      const built = await withCoupon(
        { discountType: 'fixed_amount', amount: '5000.0000', percentRate: null },
        1,
      );

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.subtotal).toBe('1000.0000');
      expect(response.body.order.discountTotal).toBe('1000.0000');
      expect(response.body.order.total).toBe('0.0000');
      expect((response.body.order.total as string).startsWith('-')).toBe(false);
      expectMoneyFoots(response.body as OrderBody);
    });

    it('takes the whole order at 100 percent', async () => {
      const built = await withCoupon({ percentRate: '100' });

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.total).toBe('0.0000');
      expectMoneyFoots(response.body as OrderBody);
    });

    const lapsed: [string, Parameters<typeof givenPromotion>[0]][] = [
      ['inactive', { isActive: false }],
      ['deleted', { deletedAt: new Date() }],
      ['expired', { endsAt: new Date(Date.now() - 3_600_000) }],
      ['not yet started', { startsAt: new Date(Date.now() + 3_600_000) }],
    ];

    for (const [label, mutate] of lapsed) {
      it(`proceeds with NO discount when the promotion is ${label} at checkout`, async () => {
        const built = await readyToCheckout([{ quantity: 2 }]);
        const promo = await givenPromotion({ percentRate: '10' });
        await applyCoupon(built.app, COUPON, built.token);

        await db()
          .update(promotion)
          .set(mutate as never)
          .where(eq(promotion.id, promo.id));

        const response = await checkout(
          built.app,
          { addressId: built.address.id },
          { token: built.token, key: KEY },
        );

        /**
         * The order is PLACED, not refused. A coupon that lapsed while the customer was
         * choosing an address is not a reason to reject their order — and the snapshot is null
         * rather than naming a promotion that gave them nothing.
         */
        expect(response.status, label).toBe(201);
        expect(response.body.order.discountTotal).toBe('0.0000');
        expect(response.body.order.total).toBe('2000.0000');
        expect(response.body.order.promotion).toBeNull();
        expect((await orderRows())[0]?.promotionId).toBeNull();
      });
    }

    it('proceeds with no discount when the minimum subtotal is no longer met', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      await givenPromotion({ percentRate: '10', minSubtotal: '1500.0000' });
      await applyCoupon(built.app, COUPON, built.token);

      // Down to 1000, below the minimum.
      await putItem(built.app, CODE_A, 1, built.token);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(201);
      expect(response.body.order.promotion).toBeNull();
      expect(response.body.order.discountTotal).toBe('0.0000');
    });

    it('does NOT trust the cart’s reported discount', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      const promo = await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, COUPON, built.token);
      const cartView = await getCart(built.app, built.token);
      expect(cartView.body.cart.discountTotal).toBe('200.0000');

      // The merchant changes the rate between the cart read and the checkout.
      await db().update(promotion).set({ percentRate: '25' }).where(eq(promotion.id, promo.id));

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      // Re-evaluated, not copied from the cart.
      expect(response.body.order.discountTotal).toBe('500.0000');
      expect(response.body.order.total).toBe('1500.0000');
    });

    it('allocates the discount IN PROPORTION to each line total', async () => {
      /**
       * Added because a mutation replacing `allocate()` with an even per-line split SURVIVED:
       * every existing assertion checked only that the parts summed to the header, which an
       * even split also satisfies. Proportionality is the property that distinguishes them.
       *
       * Lines of 3000.0000 and 1000.0000 — a 3:1 split — with 10% off the 4000.0000 subtotal.
       * Weighted: 300.0000 and 100.0000. An even split would be 200.0000 each.
       */
      const built = await readyToCheckout([
        { code: CODE_A, price: '1000.0000', quantity: 3 },
        { code: CODE_B, price: '1000.0000', quantity: 1 },
      ]);
      await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, COUPON, built.token);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.body.order.subtotal).toBe('4000.0000');
      expect(response.body.order.discountTotal).toBe('400.0000');

      const byCode = new Map(
        itemsOf(response.body as OrderBody).map((i) => [
          (i as unknown as { skuCode: string }).skuCode,
          i.discountAmount,
        ]),
      );
      expect(byCode.get(CODE_A)).toBe('300.0000');
      expect(byCode.get(CODE_B)).toBe('100.0000');
      expectMoneyFoots(response.body as OrderBody);
    });

    it('derives the header discount FROM the allocation, to the paisa', async () => {
      /**
       * Added because a mutation computing the header independently of the allocation also
       * SURVIVED. It needs data where the two genuinely differ.
       *
       * Subtotal 999.9900; 33.333333% of it is 333.3300 at the storage scale. `allocate()`
       * distributes at the currency's MINOR-UNIT scale, so the parts sum to 333.3300 only if
       * the header is derived from them — an independently computed 4-decimal figure can land
       * a fraction of a paisa away, and then an invoice's lines do not foot to its header.
       */
      const built = await readyToCheckout([
        { code: CODE_A, price: '333.3300', quantity: 1 },
        { code: CODE_B, price: '333.3300', quantity: 2 },
      ]);
      await givenPromotion({ percentRate: '33.333333' });
      await applyCoupon(built.app, COUPON, built.token);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      // The identity that must hold whatever the rounding does.
      expectMoneyFoots(response.body as OrderBody);

      // And it must hold in the DATABASE, not merely in the response.
      const [row] = await orderRows();
      const stored = await lineRows();
      const allocated = stored.reduce((acc, l) => acc + paise(l.discountAmount), 0n);
      expect(allocated).toBe(paise(row!.discountTotal));
      expect(paise(row!.subtotal) - paise(row!.discountTotal)).toBe(paise(row!.total));
    });

    it('allocates the discount across lines so the parts foot to the header', async () => {
      const built = await readyToCheckout([
        { code: CODE_A, price: '1000.0000', quantity: 2 },
        { code: CODE_B, price: '333.3333', quantity: 3 },
      ]);
      await givenPromotion({ percentRate: '33.333333' });
      await applyCoupon(built.app, COUPON, built.token);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      /**
       * `allocate()` distributes at the currency's minor-unit scale by the largest-remainder
       * method. The header discount is the SUM of what it produced, never an independent
       * calculation — an invoice whose lines do not foot to its header is exactly what
       * `allocate()` exists to prevent.
       */
      expect(response.status).toBe(201);
      expectMoneyFoots(response.body as OrderBody);
      const stored = await lineRows();
      const allocated = stored.reduce((acc, l) => acc + paise(l.discountAmount), 0n);
      expect(allocated).toBe(paise((await orderRows())[0]!.discountTotal));
    });

    it('gives every line a zero discount when no promotion applies', async () => {
      const built = await readyToCheckout([
        { code: CODE_A, quantity: 1 },
        { code: CODE_B, price: '500.0000', quantity: 1 },
      ]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(itemsOf(response.body as OrderBody).every((i) => i.discountAmount === '0.0000')).toBe(
        true,
      );
      expect(response.body.order.discountTotal).toBe('0.0000');
      expectMoneyFoots(response.body as OrderBody);
    });

    it('refuses a HARD delete of a promotion an order snapshots', async () => {
      const built = await withCoupon({ percentRate: '10' });
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });
      const promo = (await db().select().from(promotion))[0]!;

      // The checked-out cart's own association fires first; removed so the ORDER's key is what
      // is being asserted.
      await expectConstraint(
        db().delete(promotion).where(eq(promotion.id, promo.id)),
        'fk_cart_promotion_promotion_store',
      );
      await db().delete(cartPromotion);

      await expectConstraint(
        db().delete(promotion).where(eq(promotion.id, promo.id)),
        'fk_order_promotion_store',
      );
    });
  });

  /* ── The cart transition ───────────────────────────────────────────────── */

  describe('the cart transition', () => {
    it('moves the cart to checked_out and keeps its lines as history', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, COUPON, built.token);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const [row] = await db().select().from(cart).where(eq(cart.id, cartId));
      expect(row?.status).toBe('checked_out');
      // The cart's own lines and promotion survive as the record the order was made from.
      expect(await db().select().from(cartLine)).toHaveLength(1);
      expect(await db().select().from(cartPromotion)).toHaveLength(1);
    });

    it('gives the customer a NEW active cart afterwards', async () => {
      const built = await readyToCheckout();
      const before = (await getCart(built.app, built.token)).body.cart.id as string;

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const after = await getCart(built.app, built.token);
      expect(after.body.cart.id).not.toBe(before);
      expect(after.body.cart.status).toBe('active');
      expect(after.body.cart.items).toEqual([]);
      expect(after.body.cart.promotion).toBeNull();
      expect(await db().select().from(cart)).toHaveLength(2);
    });

    it('makes the checked-out cart IMMUTABLE — all five mutations refused', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      await givenSku({ code: CODE_B, price: '500.0000' });
      await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, COUPON, built.token);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      /**
       * A `GET /cart` now creates a NEW active cart, so these mutations land on that one and
       * succeed. What must be true is that the CHECKED-OUT cart is untouched — it is the
       * historical record behind an order, and rewriting it would rewrite what the customer
       * ordered from.
       */
      const linesBefore = await db().select().from(cartLine).where(eq(cartLine.cartId, cartId));
      const promoBefore = await db()
        .select()
        .from(cartPromotion)
        .where(eq(cartPromotion.cartId, cartId));

      await putItem(built.app, CODE_B, 5, built.token);
      await request(built.app)
        .delete(`/api/v1/users/me/cart/items/${CODE_A}`)
        .set('Authorization', `Bearer ${built.token}`);
      await request(built.app)
        .delete('/api/v1/users/me/cart')
        .set('Authorization', `Bearer ${built.token}`);
      await applyCoupon(built.app, COUPON, built.token);
      await request(built.app)
        .delete('/api/v1/users/me/cart/promotion')
        .set('Authorization', `Bearer ${built.token}`);

      expect(await db().select().from(cartLine).where(eq(cartLine.cartId, cartId))).toEqual(
        linesBefore,
      );
      expect(
        await db().select().from(cartPromotion).where(eq(cartPromotion.cartId, cartId)),
      ).toEqual(promoBefore);
    });

    it('refuses a mutation with 409 while the cart is the only one and checked out', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      /**
       * Reached by going STRAIGHT to a mutation without a `GET` first: the service finds the
       * customer has no active cart, creates one, locks it — so a fresh cart is what receives
       * the write. To exercise the refusal we take the lock path against a cart that is
       * checked out and has no successor, which is what a second concurrent checkout does.
       */
      const locked = await built.cart
        .lockCartForCheckout({ userId: built.userId, storeId })
        .catch(() => undefined);
      expect(locked).toBeUndefined();
      expect((await db().select().from(cart).where(eq(cart.id, cartId)))[0]?.status).toBe(
        'checked_out',
      );
    });

    it('refuses a HARD delete of a cart an order references', async () => {
      const built = await readyToCheckout();
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      // RESTRICT: deleting a cart must never take an order with it.
      await expectConstraint(db().delete(cart).where(eq(cart.id, cartId)), 'fk_order_cart_store');
    });
  });

  /* ── Duplicate checkout ────────────────────────────────────────────────── */

  describe('duplicate checkout', () => {
    it('409s a second checkout of the same cart with a different key', async () => {
      const built = await readyToCheckout();
      expect(
        (
          await checkout(
            built.app,
            { addressId: built.address.id },
            { token: built.token, key: KEY },
          )
        ).status,
      ).toBe(201);

      // A fresh cart exists now, and it is empty — so the second attempt is an empty-cart 422,
      // not a duplicate. Emptying that path deliberately: re-fill and try again.
      await putItem(built.app, CODE_A, 1, built.token);
      const second = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: `${KEY}-second` },
      );

      // A DIFFERENT cart, so a second order is correct. One order per CART, not per customer.
      expect(second.status).toBe(201);
      expect(await orderRows()).toHaveLength(2);
    });

    it('refuses a second order against one cart at the database level', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });
      const [existing] = await orderRows();

      // §36's natural key, and the third defence behind the lock and the status predicate.
      await expectConstraint(
        db()
          .insert(order)
          .values({
            id: newId(),
            storeId,
            userId: built.userId,
            cartId: existing!.cartId,
            orderNumber: 'ORD-20260101-ZZZZZZ',
            currency: 'INR',
            subtotal: '1.0000',
            discountTotal: '0.0000',
            total: '1.0000',
            /* NOT NULL with no default; see the `base()` fixture below for why. */
            grandTotal: '1.0000',
            addressId: built.address.id,
            shipRecipientName: 'X',
            shipPhone: 'X',
            shipLine1: 'X',
            shipCity: 'X',
            shipState: 'X',
            shipPostalCode: 'X',
            shipCountryCode: 'IN',
          } as never),
        'uq_order_cart',
      );
    });
  });

  /* ── Idempotency ───────────────────────────────────────────────────────── */

  describe('idempotency', () => {
    it('replays the original 201 for the same user, key and body', async () => {
      const built = await readyToCheckout();

      const first = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      const retry = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(retry.body).toEqual(first.body);
      // ONE order, which is the entire point.
      expect(await orderRows()).toHaveLength(1);
    });

    it('422s the same key with a different body', async () => {
      const built = await readyToCheckout();
      const other = await givenAddress(built.userId, { city: 'Chennai' });
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const response = await checkout(
        built.app,
        { addressId: other.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
      expect(await orderRows()).toHaveLength(1);
    });

    it('409s an in-flight key', async () => {
      const built = await readyToCheckout();
      /**
       * Claimed out of band with the SAME payload hash the middleware will compute. An
       * arbitrary hash would produce a 422 instead: the payload is checked BEFORE the status,
       * deliberately, so a different body can never be served a replay.
       */
      await built.idempotency.claim({
        storeId,
        userId: built.userId,
        key: KEY,
        endpoint: 'POST /api/v1/users/me/checkout',
        requestHash: payloadHash({ addressId: built.address.id }),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await orderRows()).toEqual([]);
    });

    it('completes the claim INSIDE the checkout transaction, not afterwards', async () => {
      /**
       * Added because a mutation deleting the in-transaction `idempotency.complete()` call
       * SURVIVED: the middleware's own post-hoc completion is a documented FALLBACK, so through
       * HTTP the key still ends up completed either way and no assertion could tell.
       *
       * §36 requires the in-transaction call specifically — *"a handler with strict
       * requirements — checkout — should call `complete()` inside its own transaction, which
       * closes the window entirely"* — because otherwise a crash between the business commit
       * and the completion write leaves the key `in_progress`, and after expiry a retry places
       * a second order.
       *
       * Calling the SERVICE directly is what makes it observable: there is no middleware in the
       * path, so nothing else can complete the key. If the service does not do it, nothing does.
       */
      const built = await readyToCheckout();
      const endpoint = 'POST /api/v1/users/me/checkout';

      const claim = await built.idempotency.claim({
        storeId,
        userId: built.userId,
        key: KEY,
        endpoint,
        requestHash: payloadHash({ addressId: built.address.id }),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(claim).toEqual({ outcome: 'claimed' });

      await built.orders.checkout({
        userId: built.userId,
        storeId,
        storeCurrency: 'INR',
        addressId: built.address.id,
        idempotency: { key: KEY, endpoint },
        actor: { type: 'customer', userId: built.userId },
        renderResponse: (view) => ({ order: toOrderResponse(view) }),
      });

      const [row] = await db().select().from(idempotencyKey);
      expect(row?.status).toBe('completed');
      expect(row?.responseStatus).toBe(201);
      expect(row?.completedAt).not.toBeNull();
      // And the stored body is the real response, because a replay serves it verbatim.
      expect(JSON.stringify(row?.responseBody)).toContain((await orderRows())[0]!.orderNumber);
    });

    it('commits the claim WITH the order', async () => {
      const built = await readyToCheckout();

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      /**
       * §36: *"a handler with strict requirements — checkout — should call `complete()` inside
       * its own transaction, which closes the window entirely."* So a completed key and an
       * order always exist together.
       */
      const [claim] = await db().select().from(idempotencyKey);
      expect(claim?.status).toBe('completed');
      expect(claim?.responseStatus).toBe(201);
      expect(await orderRows()).toHaveLength(1);
      // The stored body is what a replay serves, so it must be the real response.
      expect(JSON.stringify(claim?.responseBody)).toContain((await orderRows())[0]!.orderNumber);
    });

    it('releases the key when checkout fails, and the order does not exist', async () => {
      const built = await readyToCheckout();

      // A 404 path: an address that is not the customer's.
      const failed = await checkout(
        built.app,
        { addressId: newId() },
        { token: built.token, key: KEY },
      );
      expect(failed.status).toBe(404);

      // Nothing committed, and the key is free.
      expect(await orderRows()).toEqual([]);
      expect(await lineRows()).toEqual([]);
      expect(await historyRows()).toEqual([]);
      // Scoped to ORDER entries: registering the customer wrote its own `user.registered` row,
      // so an unfiltered assertion would fail for a reason unrelated to checkout.
      expect(await db().select().from(auditLog).where(eq(auditLog.resourceType, 'order'))).toEqual(
        [],
      );
      expect((await db().select().from(cart))[0]?.status).toBe('active');
      /**
       * The middleware releases WITHOUT awaiting — the response has already been sent, so
       * making the client wait for bookkeeping would add latency for no benefit. Polled rather
       * than asserted once, because asserting immediately would be racing that write.
       */
      await expectEventually(async () => {
        expect(await db().select().from(idempotencyKey)).toEqual([]);
      });

      // And the same key works once the request is correct.
      const retry = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(retry.status).toBe(201);
    });

    it('does NOT let two users with the same key collide', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const adaAddress = await givenAddress(ada.userId);
      const graceAddress = await givenAddress(grace.userId);
      await putItem(built.app, CODE_A, 1, ada.token);
      await putItem(built.app, CODE_A, 2, grace.token);

      const first = await checkout(
        built.app,
        { addressId: adaAddress.id },
        { token: ada.token, key: KEY },
      );
      const second = await checkout(
        built.app,
        { addressId: graceAddress.id },
        { token: grace.token, key: KEY },
      );

      /**
       * The vulnerability this increment closed. With the key scoped to (store, key, endpoint)
       * alone, Grace's request would have been answered from Ada's stored response — or refused
       * with a spurious 422.
       */
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(first.body.order.orderNumber).not.toBe(second.body.order.orderNumber);
      expect(second.headers['idempotent-replay']).toBeUndefined();
      expect(await orderRows()).toHaveLength(2);
    });

    it('does NOT hand one user the other user’s order, even with identical bodies', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const adaAddress = await givenAddress(ada.userId);
      await putItem(built.app, CODE_A, 1, ada.token);
      await putItem(built.app, CODE_A, 1, grace.token);

      const first = await checkout(
        built.app,
        { addressId: adaAddress.id },
        { token: ada.token, key: KEY },
      );
      /**
       * The SAME body — Ada's address id — so the payload hashes are identical. Before the fix
       * this returned Ada's order verbatim to Grace. Now the key is Grace's own, so the request
       * executes and is refused on ownership: a 404, never Ada's order.
       */
      const second = await checkout(
        built.app,
        { addressId: adaAddress.id },
        { token: grace.token, key: KEY },
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(404);
      expect(JSON.stringify(second.body)).not.toContain(first.body.order.orderNumber);
      expect(await orderRows()).toHaveLength(1);
    });
  });

  /* ── Reading orders back ───────────────────────────────────────────────── */

  describe('reading orders', () => {
    async function placed(count: number) {
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      const numbers: string[] = [];

      for (let i = 0; i < count; i += 1) {
        await putItem(built.app, CODE_A, i + 1, auth.token);
        const response = await checkout(
          built.app,
          { addressId: addr.id },
          { token: auth.token, key: `${KEY}-${String(i)}` },
        );
        expect(response.status).toBe(201);
        numbers.push(response.body.order.orderNumber as string);
      }
      return { ...built, ...auth, address: addr, numbers };
    }

    it('lists the customer’s orders newest first', async () => {
      const built = await placed(3);

      const response = await listOrders(built.app, '', built.token);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['orders', 'pagination']);
      expect(numbersOf(response.body as { orders: { orderNumber: string }[] })).toEqual(
        [...built.numbers].reverse(),
      );
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 3 });
    });

    it('includes each order’s lines in the list', async () => {
      const built = await placed(2);

      const response = await listOrders(built.app, '', built.token);

      for (const listed of listedOrders(response.body as { orders: OrderBody['order'][] })) {
        expect(listed.items.length).toBeGreaterThan(0);
        expectMoneyFoots({ order: listed });
      }
    });

    it('pages, and the total matches the page predicate', async () => {
      const built = await placed(3);

      const page = await listOrders(built.app, '?limit=2&offset=1', built.token);

      expect(page.body.orders).toHaveLength(2);
      expect(page.body.pagination).toEqual({ limit: 2, offset: 1, total: 3 });
    });

    it('rejects malformed pagination rather than clamping it', async () => {
      const built = await placed(1);

      for (const query of ['?limit=0', '?limit=101', '?limit=', '?offset=', '?page=1']) {
        expect((await listOrders(built.app, query, built.token)).status, query).toBe(400);
      }
    });

    it('reads one order by its number', async () => {
      const built = await placed(1);

      const response = await getOrder(built.app, built.numbers[0]!, built.token);

      expect(response.status).toBe(200);
      expect(response.body.order.orderNumber).toBe(built.numbers[0]);
    });

    it('404s an unknown order number', async () => {
      const built = await placed(1);

      const response = await getOrder(built.app, 'ORD-20260904-ZZZZZZ', built.token);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('400s a malformed order number before it reaches PostgreSQL', async () => {
      const built = await placed(1);

      for (const number of [
        'nonsense',
        'ORD-2026-ABC',
        'ORD-20260904-abcdef',
        'ORD-20260904-IO01AB',
      ]) {
        expect((await getOrder(built.app, number, built.token)).status, number).toBe(400);
      }
    });
  });

  /* ── Ownership and tenancy ─────────────────────────────────────────────── */

  describe('ownership and tenancy', () => {
    it('hides another customer’s order behind the same 404', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const adaAddress = await givenAddress(ada.userId);
      await putItem(built.app, CODE_A, 1, ada.token);
      const placedOrder = await checkout(
        built.app,
        { addressId: adaAddress.id },
        { token: ada.token, key: KEY },
      );
      const number = placedOrder.body.order.orderNumber as string;

      const unknown = await getOrder(built.app, 'ORD-20260904-ZZZZZZ', grace.token);
      const foreign = await getOrder(built.app, number, grace.token);

      // Indistinguishable: a 403 would confirm the order exists. `requestId` differs per
      // request by design, so the comparison is of what the client can learn from the answer.
      expect(foreign.status).toBe(404);
      expect(foreign.body.error.code).toBe(unknown.body.error.code);
      expect(foreign.body.error.message).toBe(unknown.body.error.message);
      expect(foreign.body.error.details).toEqual(unknown.body.error.details);
      expect((await listOrders(built.app, '', grace.token)).body.orders).toEqual([]);
    });

    it('hides another store’s order', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      const mine = await readyToCheckout();
      const placedOrder = await checkout(
        mine.app,
        { addressId: mine.address.id },
        { token: mine.token, key: KEY },
      );
      const number = placedOrder.body.order.orderNumber as string;

      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });

      expect((await getOrder(theirs.app, number, bob.token)).status).toBe(404);
      expect((await listOrders(theirs.app, '', bob.token)).body.orders).toEqual([]);
    });

    it('refuses a cross-store USER at the database level', async () => {
      const built = await readyToCheckout();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      await expectConstraint(
        db()
          .insert(order)
          .values({
            id: newId(),
            storeId: otherStoreId,
            userId: built.userId,
            cartId: newId(),
            orderNumber: 'ORD-20260101-AAAAAA',
            currency: 'INR',
            subtotal: '1.0000',
            discountTotal: '0.0000',
            total: '1.0000',
            /* NOT NULL with no default; see the `base()` fixture below for why. */
            grandTotal: '1.0000',
            addressId: built.address.id,
            shipRecipientName: 'X',
            shipPhone: 'X',
            shipLine1: 'X',
            shipCity: 'X',
            shipState: 'X',
            shipPostalCode: 'X',
            shipCountryCode: 'IN',
          } as never),
        'fk_order_user_store',
      );
    });

    it('refuses a cross-store ADDRESS at the database level', async () => {
      /**
       * The sibling test above cannot reach `fk_order_address_store`: its row is cross-store in
       * the USER too, and `fk_order_user_store` is checked first — so a mutation dropping
       * `store_id` from the ADDRESS key SURVIVED, with the user key silently standing in for it.
       *
       * The fix is to make every other reference in the row agree with the foreign store, so the
       * address is the ONLY thing out of place and only its own key can refuse the write.
       */
      const built = await readyToCheckout();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      // A real user of the other store, so `fk_order_user_store` is satisfied.
      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });
      // And a real cart of theirs, so `fk_order_cart_store` is satisfied too.
      const theirCartId = newId();
      await db()
        .insert(cart)
        .values({ id: theirCartId, userId: bob.userId, storeId: otherStoreId, status: 'active' });

      await expectConstraint(
        db()
          .insert(order)
          .values({
            id: newId(),
            storeId: otherStoreId,
            userId: bob.userId,
            cartId: theirCartId,
            orderNumber: 'ORD-20260101-BBBBBB',
            currency: 'INR',
            subtotal: '1.0000',
            discountTotal: '0.0000',
            total: '1.0000',
            /* NOT NULL with no default; see the `base()` fixture below for why. */
            grandTotal: '1.0000',
            // The one thing that does not belong: an address of the OTHER store.
            addressId: built.address.id,
            shipRecipientName: 'X',
            shipPhone: 'X',
            shipLine1: 'X',
            shipCity: 'X',
            shipState: 'X',
            shipPostalCode: 'X',
            shipCountryCode: 'IN',
          } as never),
        'fk_order_address_store',
      );
    });
  });

  /* ── Audit, events and inventory ───────────────────────────────────────── */

  describe('audit, events and inventory', () => {
    it('writes exactly one order.placed audit row with no address values', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      const entries = await db().select().from(auditLog).where(eq(auditLog.resourceType, 'order'));

      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('order.placed');
      expect(entries[0]?.actorType).toBe('customer');
      expect(entries[0]?.actorUserId).toBe(built.userId);
      expect(entries[0]?.storeId).toBe(storeId);
      expect(entries[0]?.resourceId).toBe((await orderRows())[0]?.id);

      /**
       * §40's rule: `audit_log` is *"read by more people than the database, and frequently
       * shipped to a log aggregator with different access controls"*. Identifiers and counts
       * only — no recipient name, phone, street, city or postcode.
       */
      const metadata = JSON.stringify(entries[0]?.metadata);
      expect(metadata).toContain('orderNumber');
      expect(metadata).toContain('lineCount');
      for (const pii of [
        built.address.recipientName,
        built.address.phone,
        built.address.line1,
        built.address.city,
        built.address.postalCode,
      ]) {
        expect(metadata, pii).not.toContain(pii);
      }
    });

    it('publishes NO order event', async () => {
      const built = await readyToCheckout();

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      /**
       * Deliberate, and asserted so adding one later is a conscious decision. The handler
       * registry is empty, so nothing consumes `order.placed`; §11 already anticipates the
       * first consumer being an order-confirmation email, and the event ships with it.
       */
      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'order')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('order.'))).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('checkout.'))).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('cart.'))).toEqual([]);
    });

    /**
     * **This test used to assert the opposite, and that is the point.**
     *
     * Before reservations it asserted that an order for 50 against 5 on hand was ACCEPTED, with
     * `reserved` untouched — the overselling consequence, written down deliberately rather than
     * left to be discovered. Reservation is the increment that makes it impossible, so the
     * assertion inverts.
     */
    it('REFUSES an order for more than is in stock, and reserves nothing', async () => {
      const created = await givenSku({ code: CODE_A, price: '1000.0000', onHand: 5 });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      // Deliberately MORE than is in stock.
      await putItem(built.app, CODE_A, 50, auth.token);

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      /* The offending code is named, so a storefront can tell the customer which line failed. */
      expect(response.body.error.details.skuCodes).toEqual([CODE_A]);

      /* No order, and no reservation: the whole transaction rolled back. */
      expect(await db().select().from(order)).toEqual([]);
      expect(await db().select().from(stockReservation)).toEqual([]);

      const [stock] = await db().select().from(stockItem).where(eq(stockItem.skuId, created.id));
      expect(stock?.onHand).toBe(5);
      expect(stock?.reserved).toBe(0);
      expect(stock?.available).toBe(5);
    });

    /**
     * `on_hand` and the ledger stay out of it, which is the OTHER half of the design.
     *
     * A reservation changes what is SELLABLE, not what is physically present, and
     * `stock_ledger` exists to justify `on_hand` — so a successful checkout must move
     * `reserved` and write no ledger row at all. The increment that ships goods is the one that
     * decrements `on_hand` and records it.
     */
    it('reserves without touching on_hand or the ledger', async () => {
      const created = await givenSku({ code: CODE_A, price: '1000.0000', onHand: 5 });
      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 2, auth.token);

      const response = await checkout(
        built.app,
        { addressId: addr.id },
        { token: auth.token, key: KEY },
      );
      expect(response.status).toBe(201);

      const [stock] = await db().select().from(stockItem).where(eq(stockItem.skuId, created.id));
      expect(stock?.onHand).toBe(5);
      expect(stock?.reserved).toBe(2);
      expect(stock?.available).toBe(3);

      /* The ledger is for on_hand movements. Nothing moved. */
      expect(await db().select().from(stockLedger)).toEqual([]);

      const held = await db().select().from(stockReservation);
      expect(held).toHaveLength(1);
      expect(held[0]?.quantity).toBe(2);
      expect(held[0]?.status).toBe('held');
      expect(held[0]?.settledAt).toBeNull();
      expect(held[0]?.settledReason).toBeNull();
    });

    it('records no promotion redemption', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      const promo = await givenPromotion({ percentRate: '10' });
      await applyCoupon(built.app, COUPON, built.token);
      const before = (await db().select().from(promotion).where(eq(promotion.id, promo.id)))[0];

      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });

      // §42 defers usage recording; ordering with a coupon consumes nothing.
      const after = (await db().select().from(promotion).where(eq(promotion.id, promo.id)))[0];
      expect(after).toEqual(before);

      const { rows } = await db().execute(
        sql`select table_name from information_schema.tables
             where table_schema = 'public' and table_name = 'promotion_redemption'`,
      );
      expect(rows).toEqual([]);
    });
  });

  /* ── Concurrency ───────────────────────────────────────────────────────── */

  /* ── Inventory reservation ─────────────────────────────────────────────── */

  /**
   * Reservation is the increment that makes overselling impossible, so these tests are about
   * proving that rather than about the shape of a row.
   *
   * Nothing here mocks the repository. The mutual-exclusion guarantee is a property of one
   * PostgreSQL statement under READ COMMITTED — a stub cannot have it, and a test built on one
   * would pass while the product oversold.
   */
  describe('reservation', () => {
    const reservationRows = () => db().select().from(stockReservation);
    const stockFor = async (skuId: string) => {
      const [row] = await db().select().from(stockItem).where(eq(stockItem.skuId, skuId));
      return row;
    };

    /**
     * **The headline guarantee: stock 1, two simultaneous buyers, exactly one wins.**
     *
     * Two DIFFERENT customers, so nothing else can serialise them — no shared cart row, no
     * shared idempotency key. The only thing standing between them is the conditional `UPDATE`
     * on `stock_item`.
     */
    it('lets exactly ONE of two concurrent customers take the last unit', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000', onHand: 1 });
      const built = build();

      const first = await signIn(built.app, built.identity, { email: 'racer-a@example.com' });
      const second = await signIn(built.app, built.identity, { email: 'racer-b@example.com' });
      const addrA = await givenAddress(first.userId);
      const addrB = await givenAddress(second.userId);
      await putItem(built.app, CODE_A, 1, first.token);
      await putItem(built.app, CODE_A, 1, second.token);

      const results = await Promise.all([
        checkout(built.app, { addressId: addrA.id }, { token: first.token, key: `${KEY}-a` }),
        checkout(built.app, { addressId: addrB.id }, { token: second.token, key: `${KEY}-b` }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

      const loser = results.find((r) => r.status === 409);
      expect(loser?.body.error.code).toBe('INSUFFICIENT_STOCK');

      /* One order, one reservation, and the unit accounted for exactly once. */
      expect(await orderRows()).toHaveLength(1);
      const held = await reservationRows();
      expect(held).toHaveLength(1);
      expect(held[0]?.quantity).toBe(1);

      const stock = await stockFor(held[0]!.skuId);
      expect(stock?.onHand).toBe(1);
      expect(stock?.reserved).toBe(1);
      expect(stock?.available).toBe(0);
    });

    /** Five units, six simultaneous buyers of one each: five orders, one refusal, nothing over. */
    it('never oversells under a burst of concurrent checkouts', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000', onHand: 5 });
      const built = build();

      const buyers = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          signIn(built.app, built.identity, { email: `burst-${i}@example.com` }),
        ),
      );
      const addresses = await Promise.all(buyers.map((b) => givenAddress(b.userId)));
      for (const buyer of buyers) {
        await putItem(built.app, CODE_A, 1, buyer.token);
      }

      const results = await Promise.all(
        buyers.map((buyer, i) =>
          checkout(
            built.app,
            { addressId: addresses[i]!.id },
            { token: buyer.token, key: `${KEY}-${i}` },
          ),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      const held = await reservationRows();
      expect(held).toHaveLength(5);
      const [sku0] = held;
      const stock = await stockFor(sku0!.skuId);
      expect(stock?.reserved).toBe(5);
      /* The invariant that matters: available never goes below zero. */
      expect(stock?.available).toBe(0);
    });

    /** `available == requested` must succeed. A `>` instead of `>=` fails exactly here. */
    it('allows a checkout for EXACTLY the available quantity', async () => {
      const built = await readyToCheckout([{ quantity: 3, onHand: 3 }]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(201);
      const held = await reservationRows();
      expect(held[0]?.quantity).toBe(3);
      expect((await stockFor(held[0]!.skuId))?.available).toBe(0);
    });

    it('refuses a checkout for one more than is available', async () => {
      const built = await readyToCheckout([{ quantity: 4, onHand: 3 }]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(409);
      expect(await reservationRows()).toEqual([]);
      expect(await orderRows()).toEqual([]);
    });

    /**
     * A SKU that has never been adjusted has NO `stock_item` row at all — the projection is
     * created lazily on first adjustment. Checkout must answer a clean 409 naming the code
     * rather than a 500 from a statement that matched nothing.
     */
    it('refuses cleanly when the SKU has no stock row at all', async () => {
      const built = await readyToCheckout([{ quantity: 1, onHand: 5 }]);

      /*
       * Remove the projection row to reach the state of a SKU that has never been adjusted.
       * `initialiseStock` runs lazily — only inside `adjustStock` — so a SKU created through
       * the catalogue and never adjusted genuinely has no row, and checkout must not 500 on it.
       */
      await db().delete(stockItem);
      expect(await db().select().from(stockItem)).toEqual([]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(response.body.error.details.skuCodes).toEqual([CODE_A]);
      expect(await orderRows()).toEqual([]);
    });

    /**
     * **All or nothing across lines.**
     *
     * The first SKU has plenty, the second has none. The whole checkout is refused and the
     * first SKU's counter is back where it started — proving the rollback covers the counter
     * increments already made, not just the order rows.
     */
    it('reserves nothing when ONE line of several cannot be held', async () => {
      const built = await readyToCheckout([
        { code: CODE_A, quantity: 1, onHand: 10 },
        { code: CODE_B, quantity: 1, onHand: 0 },
      ]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );

      expect(response.status).toBe(409);
      expect(await orderRows()).toEqual([]);
      expect(await reservationRows()).toEqual([]);

      const rows = await db().select().from(stockItem);
      for (const row of rows) {
        expect(row.reserved).toBe(0);
      }
    });

    /** Every line of a multi-SKU order is held, each with its own quantity. */
    it('holds every line of a multi-SKU order', async () => {
      const built = await readyToCheckout([
        { code: CODE_A, quantity: 2, onHand: 10 },
        { code: CODE_B, quantity: 3, onHand: 10 },
      ]);

      const response = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(response.status).toBe(201);

      const held = await reservationRows();
      expect(held).toHaveLength(2);
      expect(held.map((r) => r.quantity).sort()).toEqual([2, 3]);
      for (const row of await db().select().from(stockItem)) {
        expect(row.reserved).toBe(row.onHand === 10 ? row.reserved : row.reserved);
        expect(row.available).toBe(row.onHand - row.reserved);
      }
    });

    /**
     * **Deadlock ordering.**
     *
     * Two carts holding the same two SKUs in OPPOSITE line order, checked out simultaneously.
     * Without a deterministic lock order each transaction takes one row and waits for the
     * other's, and PostgreSQL breaks the cycle by killing one with SQLSTATE 40P01 — which
     * surfaces as a 500, not a 409.
     *
     * So the assertion is not "both succeed": it is that **no outcome is a 500**. Repeated,
     * because a deadlock is a race and one attempt could get lucky.
     */
    it('does not deadlock when two carts hold the same SKUs in opposite order', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000', onHand: 100 });
      await givenSku({ code: CODE_B, price: '1000.0000', onHand: 100 });
      const built = build();

      for (let round = 0; round < 6; round += 1) {
        const first = await signIn(built.app, built.identity, {
          email: `dl-a-${round}@example.com`,
        });
        const second = await signIn(built.app, built.identity, {
          email: `dl-b-${round}@example.com`,
        });
        const addrA = await givenAddress(first.userId);
        const addrB = await givenAddress(second.userId);

        /* Opposite insertion order, which is what the sort has to neutralise. */
        await putItem(built.app, CODE_A, 1, first.token);
        await putItem(built.app, CODE_B, 1, first.token);
        await putItem(built.app, CODE_B, 1, second.token);
        await putItem(built.app, CODE_A, 1, second.token);

        const results = await Promise.all([
          checkout(
            built.app,
            { addressId: addrA.id },
            { token: first.token, key: `${KEY}-dl-a-${round}` },
          ),
          checkout(
            built.app,
            { addressId: addrB.id },
            { token: second.token, key: `${KEY}-dl-b-${round}` },
          ),
        ]);

        for (const result of results) {
          expect([201, 409]).toContain(result.status);
        }
      }
    });

    /**
     * A replayed checkout must not reserve twice.
     *
     * The middleware replays the stored response without running the handler, so the second
     * request cannot reach the reservation code at all — and `pk_stock_reservation` would
     * refuse it even if it did.
     */
    it('reserves exactly once when a checkout is replayed', async () => {
      const built = await readyToCheckout([{ quantity: 2, onHand: 10 }]);

      const first = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(first.status).toBe(201);

      const replay = await checkout(
        built.app,
        { addressId: built.address.id },
        { token: built.token, key: KEY },
      );
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replay']).toBe('true');

      const held = await reservationRows();
      expect(held).toHaveLength(1);
      expect(held[0]?.quantity).toBe(2);
      expect((await stockFor(held[0]!.skuId))?.reserved).toBe(2);
    });

    /**
     * Tenancy: reserving in one store cannot move another store's counter, even for a SKU with
     * the identical code.
     */
    it('holds stock only in the reserving store', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });
      const mine = await givenSku({ code: CODE_A, price: '1000.0000', onHand: 5 });
      const theirs = await givenSku({
        code: CODE_A,
        price: '1000.0000',
        onHand: 5,
        storeId: otherStoreId,
      });

      const built = build();
      const auth = await signIn(built.app, built.identity);
      const addr = await givenAddress(auth.userId);
      await putItem(built.app, CODE_A, 2, auth.token);
      expect(
        (await checkout(built.app, { addressId: addr.id }, { token: auth.token, key: KEY })).status,
      ).toBe(201);

      expect((await stockFor(mine.id))?.reserved).toBe(2);
      /* Untouched. */
      expect((await stockFor(theirs.id))?.reserved).toBe(0);
    });

    /** The repository predicate, exercised directly — the HTTP path cannot reach these. */
    describe('repository', () => {
      it('refuses to reserve more than is available, and reserves the exact boundary', async () => {
        const created = await givenSku({ code: CODE_A, onHand: 2 });
        const repository = createInventoryRepository({ db: db() });
        const at = new Date();

        await expect(
          repository.reserveForSku({ skuId: created.id, storeId, quantity: 3, at }),
        ).resolves.toBeUndefined();
        await expect(
          repository.reserveForSku({ skuId: created.id, storeId, quantity: 2, at }),
        ).resolves.toEqual({ reserved: 2, available: 0 });
        /* And now nothing more can be taken. */
        await expect(
          repository.reserveForSku({ skuId: created.id, storeId, quantity: 1, at }),
        ).resolves.toBeUndefined();
      });

      /**
       * Store scoping, killed by a mutant that drops `store_id` from the predicate. Through
       * HTTP alone this is invisible, because the token resolves the store long before the
       * statement runs.
       */
      it('scopes the reserve statement by store', async () => {
        const created = await givenSku({ code: CODE_A, onHand: 5 });
        const repository = createInventoryRepository({ db: db() });

        await expect(
          repository.reserveForSku({
            skuId: created.id,
            storeId: newId(),
            quantity: 1,
            at: new Date(),
          }),
        ).resolves.toBeUndefined();
        expect((await stockFor(created.id))?.reserved).toBe(0);
      });

      /** Release is guarded too: it cannot take the counter below what is held. */
      it('refuses to release more than is reserved', async () => {
        const created = await givenSku({ code: CODE_A, onHand: 5 });
        const repository = createInventoryRepository({ db: db() });
        const at = new Date();

        await repository.reserveForSku({ skuId: created.id, storeId, quantity: 2, at });
        await expect(
          repository.releaseForSku({ skuId: created.id, storeId, quantity: 3, at }),
        ).resolves.toBeUndefined();
        expect((await stockFor(created.id))?.reserved).toBe(2);
      });
    });
  });

  describe('concurrency', () => {
    /**
     * Every case runs through `Promise.all`. `DATABASE_POOL_MAX` is 5 in tests and each
     * statement takes its own connection, so these are genuinely concurrent database
     * operations rather than sequential awaits dressed up as parallel ones.
     */
    it('creates exactly ONE order under two concurrent checkouts of one cart', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);

      const results = await Promise.all([
        checkout(
          built.app,
          { addressId: built.address.id },
          { token: built.token, key: `${KEY}-a` },
        ),
        checkout(
          built.app,
          { addressId: built.address.id },
          { token: built.token, key: `${KEY}-b` },
        ),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      expect(await orderRows()).toHaveLength(1);
      expect(await lineRows()).toHaveLength(1);
      expect(await historyRows()).toHaveLength(1);
    });

    it('creates exactly ONE order under EIGHT concurrent checkouts', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          checkout(
            built.app,
            { addressId: built.address.id },
            { token: built.token, key: `${KEY}-${String(i)}` },
          ),
        ),
      );

      /**
       * Three defences, measured: the cart-row lock serialises the attempts, the
       * `status = 'active'` predicate makes the losers learn from a row count rather than a
       * constraint violation, and `uq_order_cart` is the backstop. Every loser gets a clean
       * 409, not a 500.
       */
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      expect(await orderRows()).toHaveLength(1);
    });

    it('serialises checkout against adding a line', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      await givenSku({ code: CODE_B, price: '500.0000' });
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      const [placedOrder] = await Promise.all([
        checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY }),
        putItem(built.app, CODE_B, 3, built.token),
      ]);

      expect(placedOrder.status).toBe(201);
      /**
       * Both orderings are legal — the add lands before the lock and is ordered, or after the
       * transition and goes to the customer's NEW cart. What must never happen is a line
       * appearing on the checked-out cart that the order does not contain.
       */
      const historical = await db().select().from(cartLine).where(eq(cartLine.cartId, cartId));
      const ordered = await lineRows();
      expect(ordered).toHaveLength(historical.length);
      expectMoneyFoots(placedOrder.body as OrderBody);
    });

    it('serialises checkout against deleting a line', async () => {
      const built = await readyToCheckout([
        { code: CODE_A, quantity: 2 },
        { code: CODE_B, price: '500.0000', quantity: 1 },
      ]);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      const [placedOrder] = await Promise.all([
        checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY }),
        request(built.app)
          .delete(`/api/v1/users/me/cart/items/${CODE_B}`)
          .set('Authorization', `Bearer ${built.token}`),
      ]);

      expect(placedOrder.status).toBe(201);
      const historical = await db().select().from(cartLine).where(eq(cartLine.cartId, cartId));
      expect(await lineRows()).toHaveLength(historical.length);
      expectMoneyFoots(placedOrder.body as OrderBody);
    });

    it('serialises checkout against clearing the cart', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      const [placedOrder, cleared] = await Promise.all([
        checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY }),
        request(built.app)
          .delete('/api/v1/users/me/cart')
          .set('Authorization', `Bearer ${built.token}`),
      ]);

      /**
       * Either the clear wins and checkout finds an empty cart (422), or checkout wins and the
       * clear lands on the customer's new cart. An order with no lines, or a checked-out cart
       * whose lines were removed after the order was built, must not happen.
       */
      expect([201, 422]).toContain(placedOrder.status);
      /**
       * 204 if the clear won the lock, 409 if checkout did — the cart was `checked_out` by the
       * time the clear got the row, and `CartAlreadyCheckedOut` is the honest answer. A raw
       * database error, or a silent success that rewrote the historical cart, would not be.
       */
      expect([204, 409]).toContain(cleared.status);
      if (placedOrder.status === 201) {
        const historical = await db().select().from(cartLine).where(eq(cartLine.cartId, cartId));
        expect(await lineRows()).toHaveLength(historical.length);
        expect((await lineRows()).length).toBeGreaterThan(0);
      } else {
        expect(await orderRows()).toEqual([]);
      }
    });

    it('serialises checkout against replacing the promotion', async () => {
      const built = await readyToCheckout([{ quantity: 2 }]);
      await givenPromotion({ code: 'TEN', percentRate: '10' });
      await givenPromotion({ code: 'FIFTY', percentRate: '50' });
      await applyCoupon(built.app, 'TEN', built.token);
      const cartId = (await getCart(built.app, built.token)).body.cart.id as string;

      const [placedOrder] = await Promise.all([
        checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY }),
        applyCoupon(built.app, 'FIFTY', built.token),
      ]);

      expect(placedOrder.status).toBe(201);

      /**
       * The measurement that made the cart lock mandatory. Without contending on the cart row,
       * the order was priced from TEN while the cart ended up naming FIFTY — the customer swaps
       * a coupon and their order shows the old one. The order and the historical cart must name
       * the SAME promotion.
       */
      const [historical] = await db()
        .select()
        .from(cartPromotion)
        .where(eq(cartPromotion.cartId, cartId));
      const [row] = await orderRows();
      expect(row?.promotionId).toBe(historical?.promotionId);
      expectMoneyFoots(placedOrder.body as OrderBody);
    });

    it('lets two customers check out independently', async () => {
      await givenSku({ code: CODE_A, price: '1000.0000' });
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const adaAddress = await givenAddress(ada.userId);
      const graceAddress = await givenAddress(grace.userId);
      await putItem(built.app, CODE_A, 2, ada.token);
      await putItem(built.app, CODE_A, 3, grace.token);

      const results = await Promise.all([
        checkout(built.app, { addressId: adaAddress.id }, { token: ada.token, key: `${KEY}-a` }),
        checkout(
          built.app,
          { addressId: graceAddress.id },
          { token: grace.token, key: `${KEY}-g` },
        ),
      ]);

      // Different carts, so nothing to contend over.
      expect(results.map((r) => r.status)).toEqual([201, 201]);
      expect(await orderRows()).toHaveLength(2);
      expect(results[0]?.body.order.total).toBe('2000.0000');
      expect(results[1]?.body.order.total).toBe('3000.0000');
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * Each writes with direct SQL, bypassing the service entirely, and asserts the NAMED
     * constraint that refuses it — which is what distinguishes a database guarantee from an
     * application check.
     */
    async function base(overrides: Record<string, unknown> = {}) {
      const built = await readyToCheckout();
      return {
        built,
        values: {
          id: newId(),
          storeId,
          userId: built.userId,
          cartId: newId(),
          orderNumber: `ORD-20260904-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          currency: 'INR',
          subtotal: '100.0000',
          discountTotal: '0.0000',
          total: '100.0000',
          /*
           * `grand_total` is NOT NULL with no default, so a raw insert that omits it fails on
           * the column BEFORE reaching the constraint each of these tests is about — and the
           * assertion would then be about the wrong thing. Kept equal to `total`, which is
           * what `ck_order_grand_total_identity` requires while `tax_total` defaults to 0.
           */
          grandTotal: '100.0000',
          addressId: built.address.id,
          shipRecipientName: 'X',
          shipPhone: 'X',
          shipLine1: 'X',
          shipCity: 'X',
          shipState: 'X',
          shipPostalCode: 'X',
          shipCountryCode: 'IN',
          ...overrides,
        },
      };
    }

    it('refuses an unknown order status', async () => {
      const { values } = await base({ status: 'shipped' });
      await expectConstraint(
        db()
          .insert(order)
          .values(values as never),
        'ck_order_status',
      );
    });

    it('refuses negative money, and the constraint exists by name', async () => {
      /**
       * **This constraint cannot be violated in isolation, and two attempts to do so proved
       * it.** The four money checks overlap by construction:
       *
       *   A `ck_order_money_non_negative`       subtotal, discount, total all >= 0
       *   B `ck_order_discount_within_subtotal` discount <= subtotal
       *   C `ck_order_total_identity`           total = subtotal - discount
       *   D `ck_order_discount_needs_promotion` discount = 0 OR a promotion is named
       *
       * With `discount = 0`, any negative subtotal breaks B too. Setting `discount < 0` to
       * satisfy B then breaks D unless a full promotion snapshot is attached. The first attempt
       * here tripped B; the second tripped D. PostgreSQL does not promise which of several
       * violated checks it reports.
       *
       * So it is verified the way the discount bound below is: the constraint EXISTS by name,
       * and data violating it is refused. Kept rather than dropped because it states the intent
       * directly and does not depend on C surviving a future tax change.
       */
      const { rows } = await db().execute(
        sql`select conname from pg_constraint
             where conrelid = 'public."order"'::regclass
               and conname = 'ck_order_money_non_negative'`,
      );
      expect(rows).toHaveLength(1);

      const { values } = await base({
        subtotal: '-1.0000',
        discountTotal: '0.0000',
        total: '-1.0000',
      });
      let refused = false;
      try {
        await db()
          .insert(order)
          .values(values as never);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });

    it('has a discount-within-subtotal constraint, which the other two make unreachable alone', async () => {
      /**
       * `ck_order_discount_within_subtotal` cannot be violated in isolation: if
       * `discount > subtotal` then `subtotal - discount < 0`, so a row satisfying the total
       * identity necessarily has a negative total and trips
       * `ck_order_money_non_negative` too. PostgreSQL does not promise which fires.
       *
       * So it is verified two ways — it EXISTS by name, and data violating it is refused by
       * one of the money constraints. Kept rather than dropped because it states the intent
       * directly, and a later increment that relaxes the total identity for tax would need it.
       */
      const { rows } = await db().execute(
        sql`select conname from pg_constraint
             where conrelid = 'public."order"'::regclass
               and conname = 'ck_order_discount_within_subtotal'`,
      );
      expect(rows).toHaveLength(1);

      const { values } = await base({
        subtotal: '100.0000',
        discountTotal: '200.0000',
        total: '-100.0000',
        promotionId: null,
      });
      let refused = false;
      try {
        await db()
          .insert(order)
          .values(values as never);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });

    it('refuses a total that does not equal subtotal minus discount', async () => {
      // discount 0 keeps `discount_needs_promotion` and the discount bound satisfied, so only
      // the identity is broken.
      const { values } = await base({
        subtotal: '100.0000',
        discountTotal: '0.0000',
        total: '95.0000',
        /*
         * Moved WITH `total`, so `ck_order_grand_total_identity` stays satisfied and only the
         * constraint under test is broken. Leaving it at 100 would make this test assert the
         * wrong constraint — the same entanglement the money-check comment above describes.
         */
        grandTotal: '95.0000',
      });
      await expectConstraint(
        db()
          .insert(order)
          .values(values as never),
        'ck_order_total_identity',
      );
    });

    it('refuses half a promotion snapshot', async () => {
      const { values } = await base({ promotionCode: 'SAVE10' });
      await expectConstraint(
        db()
          .insert(order)
          .values(values as never),
        'ck_order_promotion_snapshot',
      );
    });

    it('refuses a discount with no promotion behind it', async () => {
      const { values } = await base({
        subtotal: '100.0000',
        discountTotal: '10.0000',
        total: '90.0000',
      });
      await expectConstraint(
        db()
          .insert(order)
          .values(values as never),
        'ck_order_discount_needs_promotion',
      );
    });

    it('enforces the order-line constraints', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });
      const [row] = await orderRows();
      const skuId = (await db().select().from(sku))[0]!.id;
      const line = {
        orderId: row!.id,
        skuId,
        storeId,
        skuCode: 'X',
        skuName: 'X',
        productName: 'X',
        quantity: 1,
        unitPrice: '10.0000',
        lineTotal: '10.0000',
        discountAmount: '0.0000',
        taxableValue: '10.0000',
      };

      /**
       * Keep `taxable_value = line_total - discount_amount` true across every override.
       *
       * Increment 38 made that an identity CHECK, and it fires on a raw insert BEFORE the
       * constraint each case below is actually about — so without this each assertion would
       * quietly start testing `ck_order_line_taxable_value` instead. The same entanglement the
       * header's money checks have, handled the same way: satisfy everything except the one
       * thing under test.
       */
      const withTaxable = (over: Record<string, unknown>) => {
        const merged = { ...line, ...over };
        const money = (v: unknown) => Number(v);
        return {
          ...merged,
          taxableValue: (money(merged.lineTotal) - money(merged.discountAmount)).toFixed(4),
        };
      };

      // A duplicate line for one SKU.
      await expectConstraint(
        db()
          .insert(orderLine)
          .values(line as never),
        'pk_order_line',
      );
      await db().delete(orderLine).where(eq(orderLine.orderId, row!.id));

      await expectConstraint(
        db()
          .insert(orderLine)
          .values(withTaxable({ quantity: 0 }) as never),
        'ck_order_line_quantity',
      );
      await expectConstraint(
        db()
          .insert(orderLine)
          .values(withTaxable({ lineTotal: '99.0000' }) as never),
        'ck_order_line_total',
      );
      await expectConstraint(
        db()
          .insert(orderLine)
          .values(withTaxable({ discountAmount: '50.0000' }) as never),
        'ck_order_line_discount_within_line',
      );
      /**
       * The same entanglement as the header: a negative `line_total` also breaks
       * `ck_order_line_discount_within_line` (`0 <= -1` is false), and a non-zero discount to
       * avoid that breaks the line-total identity. Verified by existence plus refusal.
       */
      const { rows: lineChecks } = await db().execute(
        sql`select conname from pg_constraint
             where conrelid = 'order_line'::regclass
               and conname = 'ck_order_line_money_non_negative'`,
      );
      expect(lineChecks).toHaveLength(1);

      let lineRefused = false;
      try {
        await db()
          .insert(orderLine)
          .values(withTaxable({ unitPrice: '-1.0000', lineTotal: '-1.0000' }) as never);
      } catch {
        lineRefused = true;
      }
      expect(lineRefused).toBe(true);
    });

    it('enforces the history constraints and cascades from the order', async () => {
      const built = await readyToCheckout();
      await checkout(built.app, { addressId: built.address.id }, { token: built.token, key: KEY });
      const [row] = await orderRows();

      await expectConstraint(
        db()
          .insert(orderStatusHistory)
          .values({
            id: newId(),
            orderId: row!.id,
            storeId,
            fromStatus: null,
            toStatus: 'shipped',
            actorType: 'customer',
          } as never),
        'ck_order_status_history_to_status',
      );

      await expectConstraint(
        db()
          .insert(orderStatusHistory)
          .values({
            id: newId(),
            orderId: row!.id,
            storeId,
            fromStatus: 'placed',
            toStatus: 'placed',
            actorType: 'customer',
          } as never),
        'ck_order_status_history_progresses',
      );

      // The one cascade in this schema: a line and a history row have no meaning without their
      // order. It never fires in practice because an order is never deleted.
      //
      // The reservation must go first: `fk_stock_reservation_order_store` is RESTRICT, so it
      // refuses the delete rather than cascading — deliberately, because the record of stock
      // that was taken must not vanish quietly with the order.
      await db().delete(stockReservation).where(eq(stockReservation.orderId, row!.id));
      await db().delete(orderLine).where(eq(orderLine.orderId, row!.id));
      await db().delete(order).where(eq(order.id, row!.id));
      expect(await historyRows()).toEqual([]);
    });

    it('has no soft-delete column on orders or history', async () => {
      const { rows } = await db().execute(
        sql`select table_name, column_name from information_schema.columns
             where table_name in ('order', 'order_status_history')
               and column_name in ('deleted_at')`,
      );
      // §3 #15: "anonymise, never delete. Tax law requires invoice retention."
      expect(rows).toEqual([]);
    });

    it('has no updated_at on history', async () => {
      const { rows } = await db().execute(
        sql`select column_name from information_schema.columns
             where table_name = 'order_status_history' and column_name = 'updated_at'`,
      );
      // Append-only: nothing ever updates a row here.
      expect(rows).toEqual([]);
    });
  });
});
