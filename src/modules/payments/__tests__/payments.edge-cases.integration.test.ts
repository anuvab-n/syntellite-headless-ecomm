import { createHmac } from 'node:crypto';

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { address } from '../../../db/schema/address.js';
import { product, sku } from '../../../db/schema/catalogue.js';
import { order } from '../../../db/schema/orders.js';
import { payment, paymentEvent } from '../../../db/schema/payments.js';
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
import { NotFound } from '../../../shared/errors.js';
import { createRazorpayGateway } from '../../../razorpay/gateway.js';
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
import { createOrdersRepository } from '../../orders/orders.repository.js';
import { createOrdersRoutes } from '../../orders/orders.routes.js';
import { createOrdersService } from '../../orders/orders.service.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsRoutes } from '../../promotions/promotions.routes.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createTaxRepository, createTaxService } from '../../tax/index.js';
import { createPaymentsRepository } from '../payments.repository.js';
import { createPaymentsRoutes } from '../payments.routes.js';
import { createPaymentsService } from '../payments.service.js';
import { createPaymentsWebhookRoutes } from '../payments.webhook.routes.js';

/**
 * Payment EDGE CASES — the boundaries the main suite does not reach.
 *
 * `payments.integration.test.ts` proves the approved behaviour. This file attacks the seams
 * around it: values at a limit, keys reused in ways a client plausibly would, provider bodies
 * that are well-signed but structurally hostile, and one business state the system can reach
 * and then cannot leave.
 *
 * Every case here was chosen because it is REACHABLE by a real client or a real provider — none
 * of them needs a constraint dropped or a private method called. Where a case documents a gap
 * rather than a guarantee, the test asserts the current behaviour and says so, so the gap is
 * visible in a test run instead of only in a report.
 */
describe('payments edge cases (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';

  /** The approved production window, so a test asserts the real rule rather than a stub. */
  const EXPIRY_MINUTES = 30;
  const CODE = 'EDGE-A';
  const CREDENTIALS = {
    keyId: 'rzp_test_edge',
    keySecret: 'edge-api-secret',
    webhookSecret: 'edge-webhook-secret',
  };
  const PROVIDER_REF = 'order_EDGE';

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

  const sign = (body: string, secret = CREDENTIALS.webhookSecret): string =>
    createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

  function build(options: { providerRef?: string } = {}) {
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

    const orders = createOrdersService({
      repository: createOrdersRepository({ db: db() }),
      cart: {
        lockCartForCheckout: (input) => cartService.lockCartForCheckout(input),
        markCheckedOut: (input) => cartService.markCheckedOut(input),
      },
      promotions: { evaluateApplied: (input) => promotions.evaluateApplied(input) },
      /*
       * Late-bound, exactly as `container.ts` does it: `payments` is constructed below and
       * needs `orders` through its own port, so the arrow defers the lookup to call time.
       */
      /**
       * A REAL fulfilment service, late-bound exactly as `container.ts` binds it.
       *
       * The cancellation guard turns on shipment state, so a stub answering "never shipped"
       * would let every cancellation test pass while the guard did nothing.
       */
      fulfilment: { hasBlockingShipment: (input) => fulfilment.hasBlockingShipment(input) },
      payments: { stateForOrder: (input) => payments.stateForOrder(input) },
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

    const providerRefs: string[] = [];
    const fetchCalls: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: unknown) => {
      fetchCalls.push(JSON.parse((init as { body: string }).body));
      const ref = options.providerRef ?? `${PROVIDER_REF}_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = createRazorpayGateway({
      credentials: CREDENTIALS,
      logger: silentLogger,
      fetchImpl,
    });

    const fulfilment = createFulfilmentService({
      repository: createFulfilmentRepository({ db: db() }),
      orders: {
        lockByNumber: (input) => orders.lockForFulfilmentByNumber(input),
        lockById: (input) => orders.lockForFulfilmentById(input),
      },
      payments: { stateForOrder: (input) => payments.stateForOrder(input) },
      inventory: { fulfilForOrder: (input) => inventory.fulfilForOrder(input) },
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });
    const payments = createPaymentsService({
      repository: createPaymentsRepository({ db: db() }),
      orders: {
        findPayable: async (input) => {
          try {
            const view = await orders.getOrder({
              userId: input.userId,
              storeId: input.storeId,
              orderNumber: input.orderNumber,
            });
            return {
              id: view.order.id,
              orderNumber: view.order.orderNumber,
              status: view.order.status,
              currency: view.order.currency,
              payableTotal: view.order.grandTotal,
            };
          } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
          }
        },
        /* The order lock the expiry path takes first, wired exactly as container.ts does. */
        lockForExpiry: (input) => orders.lockOrderForExpiry(input),
      },
      gateway,
      expiryMinutes: EXPIRY_MINUTES,
      reservations: {
        commitForOrder: (input) => inventory.commitForOrder(input),
        releaseForOrder: (input) => inventory.releaseForOrder(input),
      },
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
      createCartRoutes({
        cart: cartService,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        logger: silentLogger,
      }),
    );
    apiRouter.use(
      createPromotionsRoutes({
        promotions,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: (_req, _res, next) => {
          next();
        },
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
    apiRouter.use(
      createPaymentsRoutes({
        payments,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireIdempotency: requireIdempotency({ store: idempotency, logger: silentLogger }),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({
        config: testDb.config,
        logger: silentLogger,
        healthChecks: [],
        apiRouter,
        webhookRouter: createPaymentsWebhookRoutes({ payments, logger: silentLogger }),
      }),
      identity,
      promotions,
      fetchCalls,
      lastProviderRef: () => providerRefs.at(-1) ?? PROVIDER_REF,
    };
  }

  type Harness = ReturnType<typeof build>;

  async function signIn(
    harness: Harness,
    email = 'edge@example.com',
  ): Promise<{ token: string; userId: string }> {
    const user = await harness.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Edge', lastName: 'Case' },
    });
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  async function givenSku(overrides: { code?: string; price?: string; onHand?: number } = {}) {
    const code = overrides.code ?? CODE;
    const parent = {
      id: newId(),
      storeId,
      slug: `p-${code.toLowerCase()}`,
      name: 'Edge Product',
      description: '',
      status: 'active',
    };
    await db().insert(product).values(parent);
    return giveSku(db(), parent, {
      code,
      name: `${code} variant`,
      price: overrides.price ?? '1000.0000',
      deletedAt: null,
      onHand: overrides.onHand ?? DEFAULT_SKU_ON_HAND,
    });
  }

  async function givenAddress(userId: string) {
    const values = {
      id: newId(),
      userId,
      storeId,
      label: 'Home',
      recipientName: 'Edge Case',
      phone: '+91 98765 43210',
      line1: '221B Brigade Road',
      line2: '',
      landmark: '',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
      deletedAt: null,
    };
    await db().insert(address).values(values);
    return values;
  }

  /** Place a real order. `coupon` applies a promotion first, so totals are genuine. */
  async function givenOrder(
    harness: Harness,
    options: {
      token: string;
      userId: string;
      price?: string;
      quantity?: number;
      code?: string;
      coupon?: { code: string; percentRate?: string; amount?: string };
    },
  ): Promise<{ orderNumber: string; total: string; orderId: string; skuCode: string }> {
    const created = await givenSku({
      ...(options.price === undefined ? {} : { price: options.price }),
      ...(options.code === undefined ? {} : { code: options.code }),
    });
    const addr = await givenAddress(options.userId);

    expect(
      (
        await request(harness.app)
          .put(`/api/v1/users/me/cart/items/${created.code}`)
          .set('authorization', `Bearer ${options.token}`)
          .send({ quantity: options.quantity ?? 1 })
      ).status,
    ).toBe(200);

    if (options.coupon) {
      await harness.promotions.createPromotion({
        storeId,
        actor: { type: 'system' },
        input: {
          code: options.coupon.code,
          name: 'Edge coupon',
          ...(options.coupon.percentRate === undefined
            ? { discountType: 'fixed_amount' as const, amount: options.coupon.amount ?? '1.0000' }
            : {
                discountType: 'percentage' as const,
                percentRate: options.coupon.percentRate,
              }),
        },
      });
      expect(
        (
          await request(harness.app)
            .put('/api/v1/users/me/cart/promotion')
            .set('authorization', `Bearer ${options.token}`)
            .send({ code: options.coupon.code })
        ).status,
      ).toBe(200);
    }

    const checkout = await request(harness.app)
      .post('/api/v1/users/me/checkout')
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', `checkout-${newId()}`)
      .send({ addressId: addr.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    return {
      orderNumber,
      total: checkout.body.order.total as string,
      orderId: row!.id,
      skuCode: created.code,
    };
  }

  const initiate = (
    harness: Harness,
    options: {
      token: string;
      orderNumber: string;
      method?: string;
      key?: string;
      body?: Record<string, unknown>;
    },
  ) =>
    request(harness.app)
      .post(`/api/v1/users/me/orders/${options.orderNumber}/payments`)
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', options.key ?? 'edge-key-00000001')
      .send(options.body ?? { method: options.method ?? 'online' });

  function webhook(
    harness: Harness,
    options: {
      event?: string;
      orderId?: string;
      eventId?: string;
      signature?: string;
      rawBody?: string;
    } = {},
  ) {
    const body =
      options.rawBody ??
      JSON.stringify({
        event: options.event ?? 'payment.captured',
        payload: {
          payment: {
            entity: { id: 'pay_EDGE', order_id: options.orderId ?? harness.lastProviderRef() },
          },
        },
      });

    const req = request(harness.app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', options.signature ?? sign(body));

    if (options.eventId !== '') req.set('x-razorpay-event-id', options.eventId ?? 'evt_edge_1');
    return req.send(body);
  }

  const paymentRows = () => db().select().from(payment);
  const eventRows = () => db().select().from(paymentEvent);

  /* ══════════════════════════════════════════════════════════════════════ */
  /* A. An order that can be placed and then never paid                     */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('a fully-discounted order', () => {
    /**
     * **A REACHABLE DEAD END, and this test documents it rather than asserting it is correct.**
     *
     * `MAX_PROMOTION_PERCENT` is 100 and `ck_promotion_percent_range` permits exactly 100, so a
     * 100%-off coupon is legal. Checkout then produces a valid order whose `total` is
     * `0.0000` — `ck_order_money_non_negative` allows zero and
     * `ck_order_discount_within_subtotal` allows `discount = subtotal`.
     *
     * Payment refuses it with `422 ORDER_NOT_PAYABLE`, which is right on its own terms:
     * `ck_payment_amount_positive` requires `amount > 0`, and a zero-amount payment row could
     * not be reconciled against anything.
     *
     * The consequence is that **the order is permanently unpayable and has no other terminal
     * state** — there is no cancellation, no fulfilment, and no "paid: nothing to pay" path in
     * this increment. It sits at `placed` forever. Whether a free order should auto-complete,
     * be refused at checkout, or get a zero-value payment is a product decision, not something
     * to invent here.
     */
    it('is placed successfully but can never be paid (documents a product gap)', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);

      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price: '1000.0000',
        coupon: { code: 'FREE100', percentRate: '100' },
      });

      /* Checkout succeeded, and the order is genuinely free. */
      expect(total).toBe('0.0000');

      for (const method of ['online', 'cod']) {
        const response = await initiate(harness, {
          token,
          orderNumber,
          method,
          key: `zero-${method}-0001`,
        });
        expect(response.status, method).toBe(422);
        expect(response.body.error.code).toBe('ORDER_NOT_PAYABLE');
      }

      /* No payment row, and no gateway call was wasted on it. */
      expect(await paymentRows()).toEqual([]);
      expect(harness.fetchCalls).toEqual([]);

      /* The order remains `placed` with no way forward. */
      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');
      expect(row!.total).toBe('0.0000');
    });

    /** A 99.99% coupon still leaves something payable, so the boundary is at zero, not near it. */
    it('is payable when the discount leaves even a fraction behind', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);

      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price: '1000.0000',
        coupon: { code: 'ALMOST', percentRate: '99.99' },
      });

      expect(total).toBe('0.1000');

      const response = await initiate(harness, { token, orderNumber, method: 'cod' });
      expect(response.status).toBe(201);
      expect(response.body.payment.amount).toBe('0.1000');

      const [row] = await paymentRows();
      expect(Number(row!.amountMinor)).toBe(10);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* B. Idempotency key scoping at its edges                                */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('idempotency key scoping', () => {
    /**
     * The key identity includes the ENDPOINT, and the endpoint contains the order number.
     *
     * So one key value used against two different orders is two different keys. A client that
     * reuses a key by mistake gets two payments rather than a spurious replay of the first
     * order's response — which, on a money endpoint, is the safe direction to fail.
     */
    it('treats one key value on two different orders as two separate keys', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);

      const first = await givenOrder(harness, { token, userId, code: 'EDGE-1' });
      const second = await givenOrder(harness, { token, userId, code: 'EDGE-2' });

      const a = await initiate(harness, {
        token,
        orderNumber: first.orderNumber,
        method: 'cod',
        key: 'shared-key-0001',
      });
      const b = await initiate(harness, {
        token,
        orderNumber: second.orderNumber,
        method: 'cod',
        key: 'shared-key-0001',
      });

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replay']).toBeUndefined();
      expect(a.body.payment.orderNumber).not.toBe(b.body.payment.orderNumber);
      expect(await paymentRows()).toHaveLength(2);
    });

    /**
     * A key already used for CHECKOUT, replayed against payments.
     *
     * Different endpoint, so it must not be served checkout's stored `201` — which would hand
     * the client an order body where it expected a payment. This is exactly the case
     * `idempotency_key.endpoint`'s comment describes: *"a global key space would serve a
     * checkout response to a refund request."*
     */
    it('does not serve a checkout response to a payment request', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);

      const created = await givenSku({ code: 'EDGE-X' });
      const addr = await givenAddress(userId);
      await request(harness.app)
        .put(`/api/v1/users/me/cart/items/${created.code}`)
        .set('authorization', `Bearer ${token}`)
        .send({ quantity: 1 });

      const sharedKey = 'cross-endpoint-01';
      const checkout = await request(harness.app)
        .post('/api/v1/users/me/checkout')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', sharedKey)
        .send({ addressId: addr.id });
      expect(checkout.status).toBe(201);
      expect(checkout.body).toHaveProperty('order');

      const pay = await initiate(harness, {
        token,
        orderNumber: checkout.body.order.orderNumber as string,
        method: 'cod',
        key: sharedKey,
      });

      expect(pay.status).toBe(201);
      expect(pay.headers['idempotent-replay']).toBeUndefined();
      expect(pay.body).toHaveProperty('payment');
      expect(pay.body).not.toHaveProperty('order');
    });

    /**
     * Surrounding whitespace is trimmed, so ` key ` and `key` are the same key.
     *
     * Both the middleware and the route's `claimOf` trim, and they must agree — if only one
     * did, the service would complete a row the middleware never claimed and the key would
     * stay in flight until it expired.
     */
    it('trims whitespace around the key, so a padded retry replays', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const first = await initiate(harness, {
        token,
        orderNumber,
        method: 'cod',
        key: 'padded-key-0001',
      });
      expect(first.status).toBe(201);

      const padded = await initiate(harness, {
        token,
        orderNumber,
        method: 'cod',
        key: '   padded-key-0001   ',
      });

      expect(padded.status).toBe(201);
      expect(padded.headers['idempotent-replay']).toBe('true');
      expect(padded.body).toEqual(first.body);
      expect(await paymentRows()).toHaveLength(1);
    });

    /** A key of exactly the minimum and maximum permitted length is accepted. */
    it('accepts a key at both length boundaries', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const first = await givenOrder(harness, { token, userId, code: 'EDGE-MIN' });
      const second = await givenOrder(harness, { token, userId, code: 'EDGE-MAX' });

      const min = await initiate(harness, {
        token,
        orderNumber: first.orderNumber,
        method: 'cod',
        key: '12345678',
      });
      expect(min.status).toBe(201);

      const max = await initiate(harness, {
        token,
        orderNumber: second.orderNumber,
        method: 'cod',
        key: 'k'.repeat(255),
      });
      expect(max.status).toBe(201);

      const tooLong = await initiate(harness, {
        token,
        orderNumber: second.orderNumber,
        method: 'cod',
        key: 'k'.repeat(256),
      });
      expect(tooLong.status).toBe(400);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* C. COD is unreachable by any provider notification                     */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('COD isolation from the gateway', () => {
    /**
     * A COD payment has `provider` and `provider_ref` both NULL, so
     * `lockByProviderRef` — which matches on `(provider, provider_ref)` — can never find it.
     *
     * That is the property that stops a forged or stray notification marking a cash order paid.
     * Worth an explicit test because it is a security property that holds by construction, and
     * a future refactor of that query could silently lose it.
     */
    it('cannot be moved by a webhook, whatever reference it claims', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);
      const [cod] = await paymentRows();
      expect(cod!.provider).toBeNull();
      expect(cod!.providerRef).toBeNull();

      /* Every reference a notification could plausibly carry, including empty and null-ish. */
      for (const claimed of ['order_anything', cod!.id, cod!.orderId, '', 'null']) {
        const response = await webhook(harness, {
          orderId: claimed,
          eventId: `evt_cod_${claimed || 'empty'}`,
        });
        expect([200, 400]).toContain(response.status);
        if (response.status === 200) expect(response.body.status).toBe('ignored');
      }

      const [after] = await paymentRows();
      expect(after!.status).toBe('pending');
      expect(await eventRows()).toHaveLength(1);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* D. Hostile but correctly signed provider bodies                        */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('well-signed but structurally hostile notifications', () => {
    async function givenPending(harness: Harness) {
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);
      return { token, orderNumber };
    }

    /**
     * Each body below is SIGNED CORRECTLY — the attacker in this scenario is the provider
     * itself, or a provider whose payload shape has drifted. None may crash a handler or move
     * a payment; each must resolve to a deliberate answer.
     */
    it('answers deliberately for every malformed shape', async () => {
      const harness = build();
      await givenPending(harness);

      const bodies: Array<[string, string]> = [
        ['empty string', ''],
        ['whitespace', '   '],
        ['null literal', 'null'],
        ['bare number', '42'],
        ['bare string', '"payment.captured"'],
        ['array', '[{"event":"payment.captured"}]'],
        ['empty object', '{}'],
        ['event not a string', '{"event":123}'],
        ['event empty', '{"event":""}'],
        ['no payload', '{"event":"payment.captured"}'],
        ['payload not an object', '{"event":"payment.captured","payload":"x"}'],
        ['entity missing', '{"event":"payment.captured","payload":{"payment":{}}}'],
        [
          'order_id not a string',
          '{"event":"payment.captured","payload":{"payment":{"entity":{"order_id":5}}}}',
        ],
        [
          'order_id empty',
          '{"event":"payment.captured","payload":{"payment":{"entity":{"order_id":""}}}}',
        ],
        [
          'order_id null',
          '{"event":"payment.captured","payload":{"payment":{"entity":{"order_id":null}}}}',
        ],
        [
          'deeply nested junk',
          `{"event":"payment.captured","payload":${'{"a":'.repeat(20)}1${'}'.repeat(20)}}`,
        ],
      ];

      for (const [label, raw] of bodies) {
        const response = await webhook(harness, {
          rawBody: raw,
          signature: sign(raw),
          eventId: `evt_shape_${label.replace(/\W+/g, '_')}`,
        });

        /* Never a 5xx, never a crash, and never an applied transition. */
        expect([400, 401], label).toContain(response.status);
        if (response.status === 400) {
          expect(response.body.error.code, label).toBe('VALIDATION_ERROR');
        }
      }

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
      expect(await eventRows()).toHaveLength(1);
    });

    /**
     * A duplicate JSON key. `JSON.parse` keeps the LAST occurrence, and the signature covers
     * the raw bytes either way — so the only requirement is that the outcome is deterministic
     * and matches whatever the parse yields, not that we out-guess the provider.
     */
    it('is deterministic when a key appears twice', async () => {
      const harness = build();
      await givenPending(harness);
      const ref = harness.lastProviderRef();

      const raw = `{"event":"payment.captured","payload":{"payment":{"entity":{"order_id":"order_wrong"}}},"payload":{"payment":{"entity":{"order_id":"${ref}"}}}}`;
      const response = await webhook(harness, {
        rawBody: raw,
        signature: sign(raw),
        eventId: 'evt_dupkey',
      });

      /* Last-wins, so the real reference is used and the payment moves. */
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('applied');
      const [row] = await paymentRows();
      expect(row!.status).toBe('succeeded');
    });

    /** The event id is bounded by the column. Over the limit must be refused, not truncated. */
    it('refuses a provider event id longer than the column allows', async () => {
      const harness = build();
      await givenPending(harness);

      const atLimit = await webhook(harness, { eventId: 'e'.repeat(255) });
      expect(atLimit.status).toBe(200);
      expect(atLimit.body.status).toBe('applied');

      const [row] = await paymentRows();
      expect(row!.status).toBe('succeeded');

      const overLimit = await webhook(harness, { eventId: 'e'.repeat(256) });
      expect(overLimit.status).toBe(400);
    });

    /** A missing event id header is malformed — there is nothing to deduplicate on. */
    it('refuses a signed notification with no event id', async () => {
      const harness = build();
      await givenPending(harness);

      const response = await webhook(harness, { eventId: '' });
      expect(response.status).toBe(400);

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
    });

    /**
     * Two DIFFERENT successful events for one payment.
     *
     * The unique constraint cannot help — both ids are new — so this is the state machine
     * alone, and it is the ordinary consequence of at-least-once delivery.
     */
    it('applies only the first of two distinct success events', async () => {
      const harness = build();
      await givenPending(harness);

      const first = await webhook(harness, { eventId: 'evt_first' });
      expect(first.body.status).toBe('applied');

      const second = await webhook(harness, { eventId: 'evt_second' });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      expect(await eventRows()).toHaveLength(2);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* E. Money at the rounding boundary                                      */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('minor-unit rounding', () => {
    /**
     * `NUMERIC(19,4)` holds a tenth of a paisa; a gateway takes whole paise. `toMinorUnits`
     * rounds HALF_UP exactly once, at the charge. These are the values where a naive
     * `Math.round(total * 100)` on a float diverges.
     */
    it.each([
      ['1000.0050', 100001],
      ['1000.0049', 100000],
      ['1000.0051', 100001],
      ['0.0050', 1],
      ['0.0049', 0],
      ['2999.9950', 300000],
    ])('converts %s to %i minor units', async (price, expected) => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price,
        code: `EDGE-${price.replace('.', '')}`,
      });
      expect(total).toBe(price);

      const response = await initiate(harness, { token, orderNumber, method: 'cod' });

      if (expected === 0) {
        /*
         * A total that rounds to zero paise cannot be charged: `ck_payment_amount_positive`
         * requires `amount_minor > 0`, so the service refuses before it would violate it.
         * Another reachable dead end, for the same reason as the fully-discounted order.
         */
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('ORDER_NOT_PAYABLE');
        return;
      }

      expect(response.status).toBe(201);
      const [row] = await paymentRows();
      expect(Number(row!.amountMinor)).toBe(expected);
      /* The stored decimal is untouched by the minor-unit conversion. */
      expect(row!.amount).toBe(price);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* F. The payment is immune to later changes in its sources               */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('immutability against later edits', () => {
    /**
     * The order snapshot already survives catalogue edits — the orders suite proves that. What
     * this adds is that the PAYMENT, taken from `order.total`, is equally unaffected: repricing
     * the SKU, renaming the product, deactivating it and soft-deleting the delivery address
     * must all leave the payment byte-identical.
     */
    it('is unchanged after the SKU, product and address are all edited', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber, skuCode } = await givenOrder(harness, {
        token,
        userId,
        price: '1234.5600',
      });

      const created = await initiate(harness, { token, orderNumber, method: 'cod' });
      expect(created.status).toBe(201);
      const before = created.body.payment;
      expect(before.amount).toBe('1234.5600');

      /* Reprice, deactivate, rename, and soft-delete the address. */
      await db()
        .update(sku)
        .set({ price: '9999.0000', isActive: false })
        .where(eq(sku.code, skuCode));
      await db().update(product).set({ name: 'Renamed', status: 'archived' });
      await db().update(address).set({ deletedAt: new Date() });

      const after = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/payment`)
        .set('authorization', `Bearer ${token}`);

      expect(after.status).toBe(200);
      expect(after.body.payment.amount).toBe('1234.5600');
      expect(after.body.payment).toEqual(before);
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* G. Path handling at the edges                                          */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('order number handling', () => {
    /** The order number is case-sensitive; a lowercased one fails the pattern, not the lookup. */
    it('rejects a lowercased order number as malformed', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, {
        token,
        orderNumber: orderNumber.toLowerCase(),
        method: 'cod',
      });
      expect(response.status).toBe(400);
      expect(await paymentRows()).toEqual([]);
    });

    /** Structurally wrong shapes never reach a query. */
    it('rejects a structurally invalid order number', async () => {
      const harness = build();
      const { token } = await signIn(harness);

      for (const bad of [
        'ORD-20260907-000000', // 0 is outside [A-Z2-9]
        'ORD-20260907-111111', // so is 1
        'ORD-2026090-ABCDEF', // 7-digit date
        'ORD-20260907-ABCDE', // suffix too short
        'ORD-20260907-ABCDEFG', // suffix too long
        'XRD-20260907-ABCDEF', // wrong prefix
        'ORD-20260907-ABC DEF', // whitespace inside
        'ORD_20260907_ABCDEF', // wrong separators
      ]) {
        const response = await initiate(harness, {
          token,
          orderNumber: bad,
          method: 'cod',
          key: `bad-${bad.slice(-6).replace(/\W/g, 'x')}-01`,
        });
        expect(response.status, bad).toBe(400);
      }
    });

    /**
     * **A documented inconsistency between the generator and the validator.**
     *
     * `generateOrderNumber` draws from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, which omits `I`,
     * `O`, `0` and `1` so a number read off a printed invoice cannot be transcribed into a
     * different valid one. The validation regex is `[A-Z2-9]`, which omits only `0` and `1` —
     * `I` and `O` are inside `A-Z` and therefore accepted.
     *
     * So a number containing `I` or `O` is well-formed as far as the API is concerned and
     * resolves to `404` rather than `400`. Harmless — the generator can never produce one, so
     * both answers mean "no such order" — but the two rules disagree, and this test pins the
     * ACTUAL behaviour so a future tightening of the regex is a deliberate change with a
     * failing test to notice, rather than a silent one.
     *
     * The regex is copied verbatim from `orders/dto.ts`, so this is a pre-existing property of
     * the order-number contract and not something payments introduced.
     */
    it('accepts I and O as well-formed, answering 404 rather than 400', async () => {
      const harness = build();
      const { token } = await signIn(harness);

      for (const wellFormedButImpossible of ['ORD-20260907-IIIIII', 'ORD-20260907-OOOOOO']) {
        const response = await initiate(harness, {
          token,
          orderNumber: wellFormedButImpossible,
          method: 'cod',
          key: `io-${wellFormedButImpossible.slice(-6)}-1`,
        });
        expect(response.status, wellFormedButImpossible).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      }
    });

    /** A well-formed number that simply does not exist is a 404, not a 400. */
    it('separates malformed from merely absent', async () => {
      const harness = build();
      const { token } = await signIn(harness);

      const absent = await initiate(harness, {
        token,
        orderNumber: 'ORD-20260907-ZZZZZZ',
        method: 'cod',
        key: 'absent-key-0001',
      });
      expect(absent.status).toBe(404);
      expect(absent.body.error.code).toBe('NOT_FOUND');
    });
  });

  /* ══════════════════════════════════════════════════════════════════════ */
  /* H. Body-level edges on initiation                                      */
  /* ══════════════════════════════════════════════════════════════════════ */

  describe('request body edges', () => {
    it('rejects a non-object, an array and a null body', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      for (const [label, body] of [
        ['array', '[]'],
        ['null', 'null'],
        ['number', '7'],
        ['string', '"cod"'],
      ] as const) {
        const response = await request(harness.app)
          .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', `body-${label}-0001`)
          .set('content-type', 'application/json')
          .send(body);

        expect(response.status, label).toBe(400);
      }

      expect(await paymentRows()).toEqual([]);
    });

    it('rejects a method that differs only by case or padding', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      for (const method of ['COD', 'Cod', ' cod', 'cod ', 'ONLINE', '']) {
        const response = await initiate(harness, {
          token,
          orderNumber,
          body: { method },
          key: `case-${method.trim() || 'empty'}-001`,
        });
        expect(response.status, JSON.stringify(method)).toBe(400);
      }

      expect(await paymentRows()).toEqual([]);
    });

    it('rejects a null or numeric method', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      for (const method of [null, 1, true, [], {}]) {
        const response = await initiate(harness, {
          token,
          orderNumber,
          body: { method },
          key: `type-${String(typeof method)}-0001`,
        });
        expect(response.status, JSON.stringify(method)).toBe(400);
      }
    });
  });
});
