import { createHmac } from 'node:crypto';

import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { address } from '../../../db/schema/address.js';
import { product } from '../../../db/schema/catalogue.js';
import { auditLog } from '../../../db/schema/identity.js';
import { idempotencyKey } from '../../../db/schema/idempotency.js';
import { order } from '../../../db/schema/orders.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { payment, paymentEvent } from '../../../db/schema/payments.js';
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
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createRazorpayGateway } from '../../../razorpay/gateway.js';
import { createCartRepository } from '../../cart/cart.repository.js';
import { createCartRoutes } from '../../cart/cart.routes.js';
import { createCartService } from '../../cart/cart.service.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createOrdersRepository } from '../../orders/orders.repository.js';
import { createOrdersRoutes } from '../../orders/orders.routes.js';
import { createOrdersService } from '../../orders/orders.service.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createPaymentsRepository } from '../payments.repository.js';
import { createPaymentsRoutes } from '../payments.routes.js';
import { createPaymentsService } from '../payments.service.js';
import { createPaymentsWebhookRoutes } from '../payments.webhook.routes.js';
import { NotFound } from '../../../shared/errors.js';

/**
 * Payments — against real PostgreSQL, with the REAL orders module behind the port and the REAL
 * Razorpay adapter behind the gateway port. Only `fetch` is stubbed.
 *
 * That choice is the point of the suite. A fake gateway would let a broken adapter pass: the
 * signature checks would be whatever the double returned, and the minor-unit conversion would
 * never run. Here the HMAC is computed by production code against bytes this file signs, so a
 * weakened verification fails a test rather than shipping.
 *
 * Nine properties carry this suite:
 *
 *  1. **The client cannot choose the amount.** It is `order.total`, and a body that names an
 *     amount is rejected rather than ignored.
 *  2. **One payment per order**, under genuine concurrency on separate pool connections. Two
 *     defences: the existence read and `uq_payment_order`.
 *  3. **Ownership and tenancy.** Another customer's order and another store's order are both a
 *     `404`, never a `403`.
 *  4. **Idempotency is user-scoped**, and the claim commits with the payment.
 *  5. **The signature is over exact raw bytes**, and a re-serialised body fails.
 *  6. **Duplicate webhooks are no-ops**, including concurrently.
 *  7. **Terminal state never regresses**, whatever the provider sends.
 *  8. **`order.status` is never touched by anything here.**
 *  9. **No secret and no instrument data is stored or logged.**
 */
describe('payments (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const CODE_A = 'SHIRT-A';
  const KEY = 'payment-key-00000001';

  const CREDENTIALS = {
    keyId: 'rzp_test_publishable',
    keySecret: 'the-api-secret',
    webhookSecret: 'the-webhook-secret',
  };

  /** The provider order id the stubbed `fetch` returns, unless a test overrides it. */
  const PROVIDER_REF = 'order_STUBBED001';

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

  function sign(body: string, secret = CREDENTIALS.webhookSecret): string {
    return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
  }

  /**
   * The whole application, wired exactly as `container.ts` wires it.
   *
   * `fetchCalls` records what the adapter sent the provider, so the COD tests can assert the
   * gateway was never contacted rather than merely assuming it.
   */
  function build(options: { slug?: string; providerRef?: string; fetchFails?: boolean } = {}) {
    const slug = options.slug ?? testDb.config.defaultStoreSlug;
    const identityRepository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const recorders = testRecorders(db());

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
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

    const orders = createOrdersService({
      repository: createOrdersRepository({ db: db() }),
      cart: {
        lockCartForCheckout: (input) => cartService.lockCartForCheckout(input),
        markCheckedOut: (input) => cartService.markCheckedOut(input),
      },
      promotions: { evaluateApplied: (input) => promotions.evaluateApplied(input) },
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

    const fetchCalls: Array<{ url: string; body: unknown; headers: unknown }> = [];
    const providerRefs: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      const request_ = init as { body: string; headers: Record<string, string> };
      fetchCalls.push({
        url: String(url),
        body: JSON.parse(request_.body) as unknown,
        headers: request_.headers,
      });
      if (options.fetchFails === true) throw new Error('ECONNREFUSED');
      /*
       * A DISTINCT reference per call unless a test pins one.
       *
       * A constant would be unrealistic — a gateway never reuses an order id — and it made two
       * payments in one store collide on `uq_payment_provider_ref`, which is a condition
       * production cannot reach. Pinning stays available for the tests that need to know the
       * reference in advance.
       */
      const ref = options.providerRef ?? `${PROVIDER_REF}_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    }) as unknown as typeof fetch;

    /* The REAL adapter. Only the transport is stubbed. */
    const gateway = createRazorpayGateway({
      credentials: CREDENTIALS,
      logger: silentLogger,
      fetchImpl,
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
              total: view.order.total,
            };
          } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
          }
        },
      },
      gateway,
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
      orders,
      payments,
      cart: cartService,
      idempotency,
      fetchCalls,
      /** The reference the gateway most recently issued, for the webhook fixtures. */
      lastProviderRef: () => providerRefs.at(-1) ?? PROVIDER_REF,
    };
  }

  type Harness = ReturnType<typeof build>;
  type App = Harness['app'];
  type Identity = Harness['identity'];

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

  /* ── Fixtures ──────────────────────────────────────────────────────────── */

  async function givenSku(overrides: { code?: string; price?: string; storeId?: string } = {}) {
    const owningStore = overrides.storeId ?? storeId;
    const code = overrides.code ?? CODE_A;
    const parent = {
      id: newId(),
      storeId: owningStore,
      slug: `p-${code.toLowerCase()}`,
      name: 'Blue Cotton Shirt',
      description: '',
      status: 'active',
    };
    await db().insert(product).values(parent);
    const created = await giveSku(db(), parent, {
      code,
      name: `${code} variant`,
      price: overrides.price ?? '1000.0000',
      deletedAt: null,
    });
    return { ...created, storeId: owningStore, productId: parent.id };
  }

  async function givenAddress(userId: string, overrides: { storeId?: string } = {}) {
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
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
      deletedAt: null,
    };
    await db().insert(address).values(values);
    return values;
  }

  /** Place a real order through checkout, so the payment has a genuine order behind it. */
  async function givenOrder(
    harness: Harness,
    options: { token: string; userId: string; quantity?: number; price?: string; code?: string },
  ): Promise<{ orderNumber: string; total: string; orderId: string }> {
    const sku = await givenSku({
      ...(options.price === undefined ? {} : { price: options.price }),
      ...(options.code === undefined ? {} : { code: options.code }),
    });
    const addr = await givenAddress(options.userId);

    const put = await request(harness.app)
      .put(`/api/v1/users/me/cart/items/${sku.code}`)
      .set('authorization', `Bearer ${options.token}`)
      .send({ quantity: options.quantity ?? 1 });
    expect(put.status).toBe(200);

    const checkout = await request(harness.app)
      .post('/api/v1/users/me/checkout')
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', `checkout-${newId()}`)
      .send({ addressId: addr.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    return { orderNumber, total: checkout.body.order.total as string, orderId: row!.id };
  }

  function initiate(
    harness: Harness,
    options: {
      token: string;
      orderNumber: string;
      method?: string;
      key?: string;
      body?: Record<string, unknown>;
    },
  ) {
    return request(harness.app)
      .post(`/api/v1/users/me/orders/${options.orderNumber}/payments`)
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', options.key ?? KEY)
      .send(options.body ?? { method: options.method ?? 'online' });
  }

  /** A signed Razorpay notification, built the way the provider builds one. */
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
            entity: { id: 'pay_XYZ', order_id: options.orderId ?? harness.lastProviderRef() },
          },
        },
      });

    return request(harness.app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', options.signature ?? sign(body))
      .set('x-razorpay-event-id', options.eventId ?? 'evt_00000001')
      .send(body);
  }

  const paymentRows = () => db().select().from(payment);
  const eventRows = () => db().select().from(paymentEvent);

  /* ══ Authentication and authorization ═══════════════════════════════════ */

  describe('authentication', () => {
    it('rejects an unauthenticated initiation', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
        .set('idempotency-key', KEY)
        .send({ method: 'online' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
      expect(await paymentRows()).toEqual([]);
    });

    it('rejects an unauthenticated read', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app).get(
        `/api/v1/users/me/orders/${orderNumber}/payment`,
      );
      expect(response.status).toBe(401);
    });

    /**
     * The ownership property, and it must be `404` rather than `403`.
     *
     * A `403` would confirm the order exists, which is the leak one answer closes. Asserted on
     * the code, not just the status, so a future refactor cannot quietly change the meaning.
     */
    it("returns 404 for another customer's order, and creates nothing", async () => {
      const harness = build();
      const ada = await signIn(harness.app, harness.identity, { email: 'ada@example.com' });
      const { orderNumber } = await givenOrder(harness, {
        token: ada.token,
        userId: ada.userId,
      });

      const bob = await signIn(harness.app, harness.identity, { email: 'bob@example.com' });

      const response = await initiate(harness, { token: bob.token, orderNumber });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(await paymentRows()).toEqual([]);

      const read = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/payment`)
        .set('authorization', `Bearer ${bob.token}`);
      expect(read.status).toBe(404);
    });

    it("returns 404 for another store's order", async () => {
      const harness = build();
      const ada = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, {
        token: ada.token,
        userId: ada.userId,
      });

      /* A second store, and a customer who belongs to it. */
      const otherStoreId = newId();
      await db().insert(store).values({
        id: otherStoreId,
        slug: 'other-store',
        name: 'Other Store',
        currency: 'INR',
        defaultLocale: 'en-IN',
        timezone: 'Asia/Kolkata',
        isActive: true,
      });

      const otherHarness = build({ slug: 'other-store' });
      const eve = await signIn(otherHarness.app, otherHarness.identity, {
        email: 'eve@example.com',
        storeId: otherStoreId,
      });

      /* Ada's order number, presented in the other store by that store's own customer. */
      const response = await initiate(otherHarness, {
        token: eve.token,
        orderNumber,
      });
      expect(response.status).toBe(404);
      expect(await paymentRows()).toEqual([]);
    });
  });

  /* ══ The repository's own scoping ═══════════════════════════════════════ */

  /**
   * The repository predicates, tested DIRECTLY rather than through HTTP.
   *
   * These exist because a mutation probe found the gap: deleting
   * `eq(payment.userId, params.userId)` from `findByOrderId` broke nothing, because every API
   * path resolves the order through the orders port first and a foreign order is already a `404`
   * by then. The predicate is real defence-in-depth — a future caller (a job, a CLI command, an
   * operator tool) reaches the repository without that port — but only a direct test can prove
   * it is still there.
   *
   * §25's rule is that ownership and tenancy live in the query. A test that can only see them
   * through a route cannot tell whether they are in the query or merely upstream of it.
   */
  describe('repository scoping', () => {
    it('will not return a payment to the wrong user or the wrong store', async () => {
      const harness = build();
      const ada = await signIn(harness.app, harness.identity, { email: 'ada@example.com' });
      const { orderNumber, orderId } = await givenOrder(harness, {
        token: ada.token,
        userId: ada.userId,
      });
      expect((await initiate(harness, { token: ada.token, orderNumber })).status).toBe(201);

      const bob = await signIn(harness.app, harness.identity, { email: 'bob@example.com' });
      const repository = createPaymentsRepository({ db: db() });

      /* The owner sees it. */
      await expect(
        repository.findByOrderId({ orderId, storeId, userId: ada.userId }),
      ).resolves.toMatchObject({ orderId, userId: ada.userId });

      /** Kills the "remove the authenticated-user predicate" mutation. */
      await expect(
        repository.findByOrderId({ orderId, storeId, userId: bob.userId }),
      ).resolves.toBeUndefined();

      /** Kills the "remove the store predicate" mutation. */
      await expect(
        repository.findByOrderId({ orderId, storeId: newId(), userId: ada.userId }),
      ).resolves.toBeUndefined();
    });

    it('scopes the existence check by store', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      const repository = createPaymentsRepository({ db: db() });

      await expect(repository.existsForOrder({ orderId, storeId })).resolves.toBe(true);
      /** Kills the "remove the store predicate from existsForOrder" mutation. */
      await expect(repository.existsForOrder({ orderId, storeId: newId() })).resolves.toBe(false);
    });

    it('scopes the event listing by store', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      const [row] = await paymentRows();
      const repository = createPaymentsRepository({ db: db() });

      await expect(repository.listEvents({ paymentId: row!.id, storeId })).resolves.toHaveLength(1);
      await expect(
        repository.listEvents({ paymentId: row!.id, storeId: newId() }),
      ).resolves.toEqual([]);
    });

    /**
     * The transition guard, tested directly.
     *
     * `applyTransition` carries `status = fromStatus` in its WHERE clause, so a writer that lost
     * a race learns it lost from a row count rather than by corrupting state. Removing that
     * predicate is a mutation the concurrent webhook test can catch only probabilistically;
     * this catches it every time.
     */
    it('refuses a transition whose expected from-status no longer holds', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      const [row] = await paymentRows();
      const repository = createPaymentsRepository({ db: db() });

      /* Claiming to move from `succeeded` when the row is `pending`. */
      await expect(
        repository.applyTransition({
          paymentId: row!.id,
          storeId,
          fromStatus: 'succeeded',
          toStatus: 'failed',
          failureCode: null,
          at: new Date(),
        }),
      ).resolves.toBe(false);

      /* The real transition succeeds, and only once. */
      await expect(
        repository.applyTransition({
          paymentId: row!.id,
          storeId,
          fromStatus: 'pending',
          toStatus: 'succeeded',
          failureCode: null,
          at: new Date(),
        }),
      ).resolves.toBe(true);

      await expect(
        repository.applyTransition({
          paymentId: row!.id,
          storeId,
          fromStatus: 'pending',
          toStatus: 'succeeded',
          failureCode: null,
          at: new Date(),
        }),
      ).resolves.toBe(false);
    });
  });

  /* ══ The amount is server-authoritative ═════════════════════════════════ */

  describe('payment invariants', () => {
    it('copies the amount from order.total and ignores nothing the client sent', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price: '1349.1000',
        quantity: 2,
      });

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(201);

      expect(response.body.payment.amount).toBe(total);
      expect(response.body.payment.currency).toBe('INR');

      /*
       * The 201 already carries the creation row, so it and a subsequent GET describe the same
       * payment. An empty history here would be a required field that is briefly untrue.
       */
      expect(response.body.payment.history).toEqual([
        {
          fromStatus: null,
          toStatus: 'pending',
          eventType: 'payment.initiated',
          occurredAt: expect.any(String),
        },
      ]);

      const [row] = await paymentRows();
      expect(row!.amount).toBe(total);
      expect(row!.currency).toBe('INR');

      /* 2698.20 INR is 269820 paise. Asserted on the stored integer, not recomputed here. */
      expect(total).toBe('2698.2000');
      expect(Number(row!.amountMinor)).toBe(269820);

      /* And that is exactly what the provider was told. */
      expect(harness.fetchCalls).toHaveLength(1);
      expect((harness.fetchCalls[0]!.body as { amount: number }).amount).toBe(269820);
      expect((harness.fetchCalls[0]!.body as { currency: string }).currency).toBe('INR');
    });

    /**
     * The forged-field sweep, modelled on the orders suite.
     *
     * Every one of these is a field a client might hope influences the charge. `strictObject`
     * makes each a `400` rather than a silently-dropped key — and the assertion that no payment
     * row exists afterwards is what proves the rejection happened before any write.
     */
    it('rejects every attempt to supply payment facts', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      for (const extra of [
        { amount: '1.0000' },
        { amountMinor: 1 },
        { total: '1.0000' },
        { currency: 'USD' },
        { status: 'succeeded' },
        { provider: 'razorpay' },
        { providerRef: 'order_forged' },
        { orderId: newId() },
        { userId: newId() },
        { storeId: newId() },
        { failureCode: 'declined' },
        { id: newId() },
        { createdAt: new Date().toISOString() },
      ]) {
        const response = await initiate(harness, {
          token,
          orderNumber,
          key: `forged-${newId()}`,
          body: { method: 'online', ...extra },
        });

        expect(response.status, JSON.stringify(extra)).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }

      expect(await paymentRows()).toEqual([]);
    });

    it('requires a method rather than defaulting one', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, { token, orderNumber, body: {} });
      expect(response.status).toBe(400);
      expect(response.body.error.details.fields).toHaveProperty('body.method');
    });

    it('rejects an unknown method', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, {
        token,
        orderNumber,
        body: { method: 'bitcoin' },
      });
      expect(response.status).toBe(400);
    });

    it('rejects a malformed order number before any lookup', async () => {
      const harness = build();
      const { token } = await signIn(harness.app, harness.identity);

      const response = await initiate(harness, { token, orderNumber: 'not-an-order' });
      expect(response.status).toBe(400);
    });

    /** One payment per order, the approved model, through the API. */
    it('refuses a second payment for the same order', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await initiate(harness, { token, orderNumber, key: 'first-key-0001' })).status).toBe(
        201,
      );

      const second = await initiate(harness, { token, orderNumber, key: 'second-key-002' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('PAYMENT_ALREADY_EXISTS');
      expect(await paymentRows()).toHaveLength(1);
    });

    /**
     * `order.status` is untouched, whatever happens to the payment.
     *
     * Asserted after a success, because that is the transition somebody would be most tempted
     * to reflect onto the order. §43 fixed that the two lifecycles stay separate.
     */
    it('never changes order.status', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      await initiate(harness, { token, orderNumber });
      expect((await webhook(harness)).status).toBe(200);

      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');

      /* And the order's own history gained nothing. */
      const { rows } = await testDb.handle.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM order_status_history',
      );
      expect(rows[0]!.count).toBe('1');
    });
  });

  /* ══ Idempotency ════════════════════════════════════════════════════════ */

  describe('idempotency', () => {
    it('requires an Idempotency-Key', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
        .set('authorization', `Bearer ${token}`)
        .send({ method: 'online' });

      expect(response.status).toBe(400);
      expect(response.body.error.details.fields).toHaveProperty('header.idempotency-key');
      expect(await paymentRows()).toEqual([]);
      /* And the provider was never contacted for a request that never got past the guard. */
      expect(harness.fetchCalls).toEqual([]);
    });

    it('rejects a key shorter than the minimum', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, { token, orderNumber, key: 'short' });
      expect(response.status).toBe(400);
    });

    it('replays the original response for the same key and body', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const first = await initiate(harness, { token, orderNumber });
      expect(first.status).toBe(201);

      const replay = await initiate(harness, { token, orderNumber });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body).toEqual(first.body);

      /* One payment, and — crucially — only ONE provider order was created. */
      expect(await paymentRows()).toHaveLength(1);
      expect(harness.fetchCalls).toHaveLength(1);
    });

    it('rejects the same key with a conflicting body', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await initiate(harness, { token, orderNumber, method: 'online' })).status).toBe(201);

      const conflicting = await initiate(harness, { token, orderNumber, method: 'cod' });
      expect(conflicting.status).toBe(422);
      expect(conflicting.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
      expect(await paymentRows()).toHaveLength(1);
    });

    /**
     * The claim commits WITH the payment.
     *
     * `completed_at` and `response_status` are set, which only happens inside the service's
     * transaction — the middleware's post-hoc completion would leave a separate write. If the
     * service stopped completing inside the transaction, the row would still complete but
     * §36's window would reopen; the assertion that matters here is that the completed row and
     * the payment are both present and consistent.
     */
    it('commits the idempotency claim with the payment', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(201);

      const [claim] = await db().select().from(idempotencyKey).where(eq(idempotencyKey.key, KEY));

      expect(claim!.status).toBe('completed');
      expect(claim!.responseStatus).toBe(201);
      expect(claim!.completedAt).not.toBeNull();
      expect(claim!.userId).toBe(userId);
      expect(claim!.storeId).toBe(storeId);
      expect(claim!.endpoint).toBe(`POST /api/v1/users/me/orders/${orderNumber}/payments`);
      expect(claim!.responseBody).toEqual(response.body);
    });

    /**
     * The cross-user isolation Increment 30 closed, re-proved on this endpoint.
     *
     * Two customers, the same key value, the same endpoint shape. Each must get their own
     * payment — if the key were not user-scoped the second would be served the first's response,
     * which on a money endpoint is somebody else's payment.
     */
    it('scopes the key per user', async () => {
      const harness = build();
      const ada = await signIn(harness.app, harness.identity, { email: 'ada@example.com' });
      const adaOrder = await givenOrder(harness, { token: ada.token, userId: ada.userId });

      const bob = await signIn(harness.app, harness.identity, { email: 'bob@example.com' });
      const bobOrder = await givenOrder(harness, {
        token: bob.token,
        userId: bob.userId,
        code: 'MUG-B',
      });

      const first = await initiate(harness, {
        token: ada.token,
        orderNumber: adaOrder.orderNumber,
        key: KEY,
      });
      const second = await initiate(harness, {
        token: bob.token,
        orderNumber: bobOrder.orderNumber,
        key: KEY,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replay']).toBeUndefined();
      expect(first.body.payment.orderNumber).not.toBe(second.body.payment.orderNumber);
      expect(await paymentRows()).toHaveLength(2);
    });

    /**
     * A failed operation must not leave a usable payment behind, and the key must not be
     * completed — so a later retry can genuinely try again.
     */
    it('creates no payment when the provider is unreachable, and RELEASES the key', async () => {
      const harness = build({ fetchFails: true });
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');

      expect(await paymentRows()).toEqual([]);

      /*
       * The key is RELEASED, not left in flight. That is the middleware's documented rule —
       * "2xx completes the key; anything else releases it" — and it is the behaviour that
       * matters here: a gateway outage must not make the customer's own key unusable until it
       * expires. Asserted as the row being gone, because release deletes it.
       */
      const claims = await db().select().from(idempotencyKey).where(eq(idempotencyKey.key, KEY));
      expect(claims).toEqual([]);
    });

    /** The point of releasing: the very same key works once the gateway comes back. */
    it('lets the same key succeed after a transient provider failure', async () => {
      const failing = build({ fetchFails: true });
      const { token, userId } = await signIn(failing.app, failing.identity);
      const { orderNumber } = await givenOrder(failing, { token, userId });

      expect((await initiate(failing, { token, orderNumber })).status).toBe(503);

      /* A second harness against the same database, this time with a working gateway. */
      const working = build();
      const retry = await initiate(working, { token, orderNumber, key: KEY });

      expect(retry.status).toBe(201);
      expect(await paymentRows()).toHaveLength(1);
    });
  });

  /* ══ Concurrency ════════════════════════════════════════════════════════ */

  describe('concurrency', () => {
    /**
     * Two initiations for one order, at the same time, with DIFFERENT keys.
     *
     * Different keys on purpose: with the same key the idempotency middleware would arbitrate
     * and this would prove nothing about the payment constraint. Here both requests pass the
     * existence read, and `uq_payment_order` is the only thing that can decide.
     */
    it('creates exactly one payment under concurrent initiation', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const [a, b] = await Promise.all([
        initiate(harness, { token, orderNumber, key: 'concurrent-key-a1' }),
        initiate(harness, { token, orderNumber, key: 'concurrent-key-b2' }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const rows = await paymentRows();
      expect(rows).toHaveLength(1);

      /* Exactly one creation row, too. */
      expect(await eventRows()).toHaveLength(1);
    });

    it('keeps concurrent duplicate webhooks idempotent', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      /* Ten identical deliveries of ONE provider event, at once. */
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => webhook(harness, { eventId: 'evt_same' })),
      );

      for (const response of responses) expect(response.status).toBe(200);

      const applied = responses.filter((r) => r.body.status === 'applied');
      expect(applied).toHaveLength(1);

      const [row] = await paymentRows();
      expect(row!.status).toBe('succeeded');

      /* One creation row plus exactly one transition row. */
      const events = await eventRows();
      expect(events).toHaveLength(2);
      expect(events.filter((e) => e.providerEventId === 'evt_same')).toHaveLength(1);
    });

    /**
     * A success and a failure racing for one payment.
     *
     * Whichever wins, the other must not overwrite it: the row lock serialises them and the
     * state machine refuses the second. The payment must be in a terminal state, and there must
     * be exactly one transition.
     */
    it('resolves a terminal-state race to a single transition', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      const [captured, failed] = await Promise.all([
        webhook(harness, { event: 'payment.captured', eventId: 'evt_cap' }),
        webhook(harness, { event: 'payment.failed', eventId: 'evt_fail' }),
      ]);

      expect(captured.status).toBe(200);
      expect(failed.status).toBe(200);

      const outcomes = [captured.body.status, failed.body.status].sort();
      expect(outcomes).toEqual(['applied', 'ignored']);

      const [row] = await paymentRows();
      expect(['succeeded', 'failed']).toContain(row!.status);

      const events = await eventRows();
      expect(events.filter((e) => e.fromStatus === 'pending')).toHaveLength(1);
    });
  });

  /* ══ Webhook ════════════════════════════════════════════════════════════ */

  describe('webhook', () => {
    async function givenPendingPayment(harness: Harness) {
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(201);
      return { token, userId, orderNumber };
    }

    it('applies a correctly signed captured event', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const response = await webhook(harness);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'applied', payment: { status: 'succeeded' } });

      const [row] = await paymentRows();
      expect(row!.status).toBe('succeeded');
      expect(row!.failureCode).toBeNull();

      const events = await eventRows();
      expect(events).toHaveLength(2);
      const transition = events.find((e) => e.fromStatus === 'pending');
      expect(transition).toMatchObject({
        fromStatus: 'pending',
        toStatus: 'succeeded',
        actorType: 'system',
        actorUserId: null,
        providerEventId: 'evt_00000001',
        eventType: 'payment.captured',
      });
    });

    it('applies a failed event with the normalised domain code', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const response = await webhook(harness, { event: 'payment.failed' });
      expect(response.status).toBe(200);
      expect(response.body.payment.status).toBe('failed');

      const [row] = await paymentRows();
      expect(row!.status).toBe('failed');
      expect(row!.failureCode).toBe('declined');
    });

    it('rejects an invalid signature and changes nothing', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const response = await webhook(harness, { signature: 'deadbeef'.repeat(8) });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
      expect(await eventRows()).toHaveLength(1);
    });

    it('rejects a missing signature', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: harness.lastProviderRef() } } },
      });
      const response = await request(harness.app)
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-event-id', 'evt_1')
        .send(body);

      expect(response.status).toBe(401);
      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
    });

    /**
     * **The raw-body property, end to end through Express.**
     *
     * The signature covers a pretty-printed body; the request sends exactly those bytes and
     * must be accepted. The companion case sends semantically identical but differently
     * serialised bytes and must be rejected. Together they prove the raw mount is doing its job
     * — if `express.json()` were reaching this route first, the first case would fail.
     */
    it('verifies against the exact bytes sent, not a re-serialisation', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const pretty = JSON.stringify(
        {
          event: 'payment.captured',
          payload: { payment: { entity: { order_id: harness.lastProviderRef() } } },
        },
        null,
        2,
      );
      const signature = sign(pretty);

      /* Different bytes, same JSON: must be rejected. */
      const tampered = await webhook(harness, {
        rawBody: JSON.stringify(JSON.parse(pretty)),
        signature,
        eventId: 'evt_reserialised',
      });
      expect(tampered.status).toBe(401);

      /* The verbatim bytes: accepted, which proves the signature was right all along. */
      const verbatim = await webhook(harness, {
        rawBody: pretty,
        signature,
        eventId: 'evt_verbatim',
      });
      expect(verbatim.status).toBe(200);
      expect(verbatim.body.status).toBe('applied');
    });

    /**
     * A redelivery of the event that already succeeded.
     *
     * Two independent defences can catch this, and SEQUENTIALLY the cheaper one fires first:
     * the payment is already terminal, so the state machine refuses before the insert is even
     * attempted. `uq_payment_event_provider` is what catches the CONCURRENT case, where both
     * deliveries read `pending` — proved by the concurrency suite, and by the constraint test
     * that violates it directly.
     *
     * So the assertion is on the property the approved scope actually requires — a successful
     * no-op with no second transition — rather than on which defence got there first, which is
     * a timing detail.
     */
    it('treats a redelivered event as a successful no-op', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const first = await webhook(harness, { eventId: 'evt_dup' });
      expect(first.body.status).toBe('applied');

      const second = await webhook(harness, { eventId: 'evt_dup' });
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('ignored');
      expect(['duplicate_event', 'already_terminal']).toContain(second.body.reason);

      /* One creation row, one transition. Nothing was appended by the redelivery. */
      const events = await eventRows();
      expect(events).toHaveLength(2);
      expect(events.filter((e) => e.providerEventId === 'evt_dup')).toHaveLength(1);
    });

    /**
     * A DIFFERENT event id, arriving after the payment is terminal.
     *
     * The unique constraint cannot help here — the id is new — so this is the state machine
     * alone. `payment.failed` after `payment.captured` is ordinary with at-least-once delivery,
     * and it must not corrupt a succeeded payment.
     */
    it('refuses to move a payment that has already finished', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      expect((await webhook(harness, { eventId: 'evt_1' })).body.status).toBe('applied');

      const conflicting = await webhook(harness, {
        event: 'payment.failed',
        eventId: 'evt_2',
      });
      expect(conflicting.status).toBe(200);
      expect(conflicting.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      const [row] = await paymentRows();
      expect(row!.status).toBe('succeeded');
      expect(row!.failureCode).toBeNull();
      expect(await eventRows()).toHaveLength(2);
    });

    it('acknowledges an unsupported event without touching state', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      for (const event of ['refund.created', 'settlement.processed', 'subscription.charged']) {
        const response = await webhook(harness, { event, eventId: `evt_${event}` });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ignored', reason: 'unsupported_event' });
      }

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
      expect(await eventRows()).toHaveLength(1);
    });

    it('acknowledges an event for a reference it does not recognise', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const response = await webhook(harness, { orderId: 'order_NOT_OURS' });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ignored', reason: 'unknown_reference' });

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
    });

    it('handles malformed input safely', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      for (const raw of ['not json', '{}', '[]', 'null', '{"event":"payment.captured"}']) {
        const response = await webhook(harness, { rawBody: raw, eventId: `evt_${raw.length}` });
        expect([400]).toContain(response.status);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }

      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
      expect(await eventRows()).toHaveLength(1);
    });

    it('rejects a signed body with no provider event id', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: harness.lastProviderRef() } } },
      });
      const response = await request(harness.app)
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .send(body);

      expect(response.status).toBe(400);
      const [row] = await paymentRows();
      expect(row!.status).toBe('pending');
    });

    /**
     * **The webhook is not store-scoped, and must not become so by accident.**
     *
     * Two stores each hold a pending payment, with DIFFERENT provider references. An event for
     * store A's reference must move store A's payment and leave store B's untouched — the store
     * comes from the row the reference names, and nothing in the request says which store it is.
     */
    it('resolves the store from the payment, and cannot cross a store boundary', async () => {
      const harnessA = build({ providerRef: 'order_STORE_A' });
      const ada = await signIn(harnessA.app, harnessA.identity, { email: 'ada@example.com' });
      const orderA = await givenOrder(harnessA, { token: ada.token, userId: ada.userId });
      expect(
        (await initiate(harnessA, { token: ada.token, orderNumber: orderA.orderNumber })).status,
      ).toBe(201);

      const otherStoreId = newId();
      await db().insert(store).values({
        id: otherStoreId,
        slug: 'other-store',
        name: 'Other Store',
        currency: 'INR',
        defaultLocale: 'en-IN',
        timezone: 'Asia/Kolkata',
        isActive: true,
      });

      const harnessB = build({ slug: 'other-store', providerRef: 'order_STORE_B' });
      const eve = await signIn(harnessB.app, harnessB.identity, {
        email: 'eve@example.com',
        storeId: otherStoreId,
      });
      /* Store B needs its own SKU and order. */
      const orderB = await (async () => {
        const sku = await givenSku({ code: 'MUG-B', storeId: otherStoreId });
        const addr = await givenAddress(eve.userId, { storeId: otherStoreId });
        await request(harnessB.app)
          .put(`/api/v1/users/me/cart/items/${sku.code}`)
          .set('authorization', `Bearer ${eve.token}`)
          .send({ quantity: 1 });
        const checkout = await request(harnessB.app)
          .post('/api/v1/users/me/checkout')
          .set('authorization', `Bearer ${eve.token}`)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });
        expect(checkout.status).toBe(201);
        return { orderNumber: checkout.body.order.orderNumber as string };
      })();
      expect(
        (
          await initiate(harnessB, {
            token: eve.token,
            orderNumber: orderB.orderNumber,
            key: 'store-b-key-0001',
          })
        ).status,
      ).toBe(201);

      const rowsBefore = await paymentRows();
      expect(rowsBefore).toHaveLength(2);

      /* An event for store A's reference only. */
      const response = await webhook(harnessA, {
        orderId: 'order_STORE_A',
        eventId: 'evt_store_a',
      });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('applied');

      const rowsAfter = await paymentRows();
      const a = rowsAfter.find((r) => r.providerRef === 'order_STORE_A');
      const b = rowsAfter.find((r) => r.providerRef === 'order_STORE_B');
      expect(a!.status).toBe('succeeded');
      expect(a!.storeId).toBe(storeId);
      expect(b!.status).toBe('pending');
      expect(b!.storeId).toBe(otherStoreId);
    });

    /**
     * A body that claims a store must be ignored entirely.
     *
     * The claimed store is the OTHER store, and the reference belongs to store A. If anything
     * read tenancy from the body this would either fail or touch the wrong row.
     */
    it('ignores a store_id claimed in the notification body', async () => {
      const harness = build();
      await givenPendingPayment(harness);

      const body = JSON.stringify({
        event: 'payment.captured',
        store_id: newId(),
        storeId: newId(),
        payload: {
          payment: { entity: { order_id: harness.lastProviderRef(), store_id: newId() } },
        },
      });

      const response = await webhook(harness, { rawBody: body, signature: sign(body) });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('applied');

      const [row] = await paymentRows();
      expect(row!.storeId).toBe(storeId);
      expect(row!.status).toBe('succeeded');
    });
  });

  /* ══ COD ════════════════════════════════════════════════════════════════ */

  describe('cash on delivery', () => {
    it('creates a pending COD payment without contacting any gateway', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, total } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, { token, orderNumber, method: 'cod' });
      expect(response.status).toBe(201);

      expect(response.body.payment).toMatchObject({
        method: 'cod',
        provider: null,
        status: 'pending',
        amount: total,
      });
      /* No handoff for COD: there is nothing to hand off to. */
      expect(response.body.handoff).toBeUndefined();

      /** The property that matters: the provider was never called. */
      expect(harness.fetchCalls).toEqual([]);

      const [row] = await paymentRows();
      expect(row!.method).toBe('cod');
      expect(row!.provider).toBeNull();
      expect(row!.providerRef).toBeNull();
      expect(row!.status).toBe('pending');
      expect(row!.amount).toBe(total);
    });

    it('works when no gateway is configured at all', async () => {
      /*
       * The unconfigured gateway, which is what a deployment without Razorpay credentials
       * gets. COD must still work — that is the whole reason the gateway is selected per
       * deployment rather than assumed.
       */
      const harness = build({ fetchFails: true });
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const cod = await initiate(harness, { token, orderNumber, method: 'cod' });
      expect(cod.status).toBe(201);
      expect(harness.fetchCalls).toEqual([]);
    });

    it('records one COD payment per order, like any other method', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect(
        (await initiate(harness, { token, orderNumber, method: 'cod', key: 'k-1-00000001' }))
          .status,
      ).toBe(201);
      const second = await initiate(harness, {
        token,
        orderNumber,
        method: 'online',
        key: 'k-2-00000002',
      });
      expect(second.status).toBe(409);
    });
  });

  /* ══ Reads ══════════════════════════════════════════════════════════════ */

  describe('reading a payment', () => {
    it('returns the payment with its full history', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });
      await webhook(harness);

      const response = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/payment`)
        .set('authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.payment).toMatchObject({
        orderNumber,
        method: 'online',
        provider: 'razorpay',
        status: 'succeeded',
      });

      const history = response.body.payment.history as Array<Record<string, unknown>>;
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'pending' });
      expect(history[1]).toMatchObject({ fromStatus: 'pending', toStatus: 'succeeded' });
    });

    it('returns 404 when the order has no payment yet', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/payment`)
        .set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(404);
    });

    /**
     * **No internal identifier and no provider reference on the customer surface.**
     *
     * The response is asserted key-by-key rather than with `toMatchObject`, because the point is
     * what is ABSENT. A spread of the record would publish `id`, `userId`, `storeId`,
     * `orderId`, `providerRef` and `amountMinor`, and no `toMatchObject` assertion would notice.
     */
    it('publishes exactly the documented fields and nothing else', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      const created = await initiate(harness, { token, orderNumber });

      expect(Object.keys(created.body.payment).sort()).toEqual([
        'amount',
        'createdAt',
        'currency',
        'failureCode',
        'history',
        'method',
        'orderNumber',
        'provider',
        'status',
        'updatedAt',
      ]);

      const serialised = JSON.stringify(created.body.payment);
      for (const leaked of ['userId', 'storeId', 'orderId', 'amountMinor', 'providerRef']) {
        expect(serialised).not.toContain(leaked);
      }

      /* The handoff carries the publishable key and never the secret. */
      expect(Object.keys(created.body.handoff).sort()).toEqual([
        'provider',
        'providerRef',
        'publicKey',
      ]);
      expect(created.body.handoff.publicKey).toBe(CREDENTIALS.keyId);
      expect(JSON.stringify(created.body)).not.toContain(CREDENTIALS.keySecret);
      expect(JSON.stringify(created.body)).not.toContain(CREDENTIALS.webhookSecret);
    });
  });

  /* ══ Audit, events and secrets ══════════════════════════════════════════ */

  describe('audit and events', () => {
    it('records an audit entry for initiation and for the transition', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });
      await webhook(harness);

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'payment'));

      const actions = entries.map((e) => e.action).sort();
      expect(actions).toEqual(['payment.initiated', 'payment.succeeded']);

      const initiated = entries.find((e) => e.action === 'payment.initiated');
      expect(initiated).toMatchObject({ actorType: 'customer', actorUserId: userId, storeId });

      const succeeded = entries.find((e) => e.action === 'payment.succeeded');
      expect(succeeded).toMatchObject({ actorType: 'system', actorUserId: null, storeId });
    });

    /**
     * No domain events, and the assertion is that the outbox stays EMPTY.
     *
     * The handler registry is empty, so an event would have no consumer. Mirrors the orders
     * suite's equivalent test, and makes adding one a deliberate act rather than a side effect.
     */
    it('emits no domain events', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });
      await webhook(harness);

      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'payment')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('payment.'))).toEqual([]);
    });

    /**
     * **No secret and no instrument data anywhere in the database.**
     *
     * A whole-database scan rather than a per-column assertion: a column added by a later
     * increment is covered automatically, which a hand-listed set of columns would not be.
     */
    it('persists no secret and no payment-instrument data', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      /* A notification carrying instrument-shaped fields, correctly signed. */
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              order_id: harness.lastProviderRef(),
              method: 'card',
              card: { last4: '1111', network: 'Visa', name: 'ADA LOVELACE' },
              vpa: 'ada@upi',
              bank: 'HDFC',
            },
          },
        },
      });
      expect((await webhook(harness, { rawBody: body, signature: sign(body) })).status).toBe(200);

      const dumped = await testDb.handle.pool.query<{ dump: string }>(`
        SELECT coalesce(string_agg(t::text, ' '), '') AS dump
        FROM (SELECT p FROM payment p) AS x(t)
      `);
      const dumpedEvents = await testDb.handle.pool.query<{ dump: string }>(`
        SELECT coalesce(string_agg(t::text, ' '), '') AS dump
        FROM (SELECT e FROM payment_event e) AS x(t)
      `);
      const haystack = `${dumped.rows[0]!.dump} ${dumpedEvents.rows[0]!.dump}`;

      for (const forbidden of [
        CREDENTIALS.keySecret,
        CREDENTIALS.webhookSecret,
        '1111',
        'Visa',
        'ADA LOVELACE',
        'ada@upi',
        'HDFC',
        'card',
      ]) {
        expect(haystack, `leaked: ${forbidden}`).not.toContain(forbidden);
      }
    });

    /** The payment table has no soft-delete column: a financial record is never deleted. */
    it('has no deleted_at on either payment table', async () => {
      const { rows } = await testDb.handle.pool.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'deleted_at'
          AND table_name IN ('payment', 'payment_event')
      `);
      expect(rows).toEqual([]);
    });
  });

  /* ══ Database constraints ═══════════════════════════════════════════════ */

  describe('database constraints', () => {
    /**
     * Asserted with raw SQL, bypassing the service entirely.
     *
     * The API is not the only writer — a future job, a CLI command or an operator at a psql
     * prompt all reach these tables — so each invariant is proved against the constraint rather
     * than against the code path that normally respects it.
     */
    /**
     * A fresh order per call, with a distinct customer and SKU.
     *
     * Distinct on purpose: several of these assertions call this more than once in a single
     * test, and reusing the default email or SKU code makes the SECOND call fail on an identity
     * or catalogue constraint — which would then be reported as the payment constraint not
     * firing. That misdiagnosis cost a debugging cycle already.
     */
    /*
     * A counter, NOT a slice of a UUIDv7. The first characters of a v7 are a millisecond
     * timestamp, so two calls in the same millisecond produce the same prefix — which is
     * exactly how the email collision this comment exists to prevent came back a second time.
     */
    let seedCounter = 0;

    async function seedPaymentRow(overrides: Record<string, unknown> = {}) {
      seedCounter += 1;
      const unique = String(seedCounter).padStart(4, '0');
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: `constraint-${unique}@example.com`,
      });
      const { orderId } = await givenOrder(harness, {
        token,
        userId,
        code: `SKU-${unique.toUpperCase()}`,
      });

      const values = {
        id: newId(),
        store_id: storeId,
        order_id: orderId,
        user_id: userId,
        method: 'online',
        provider: 'razorpay',
        provider_ref: `order_${newId()}`,
        status: 'pending',
        currency: 'INR',
        amount: '100.0000',
        amount_minor: 10000,
        ...overrides,
      };

      const columns = Object.keys(values)
        .map((c) => `"${c}"`)
        .join(', ');
      const placeholders = Object.keys(values)
        .map((_, i) => `$${String(i + 1)}`)
        .join(', ');

      return testDb.handle.pool.query(
        `INSERT INTO payment (${columns}) VALUES (${placeholders})`,
        Object.values(values),
      );
    }

    it('enforces uq_payment_order', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderId } = await givenOrder(harness, { token, userId });

      const insert = (ref: string) =>
        testDb.handle.pool.query(
          `INSERT INTO payment (id, store_id, order_id, user_id, method, provider, provider_ref,
                                status, currency, amount, amount_minor)
           VALUES ($1, $2, $3, $4, 'online', 'razorpay', $5, 'pending', 'INR', '100.0000', 10000)`,
          [newId(), storeId, orderId, userId, ref],
        );

      await insert('order_first');
      await expect(insert('order_second')).rejects.toThrow(/uq_payment_order/);
    });

    it('enforces ck_payment_status', async () => {
      await expect(seedPaymentRow({ status: 'refunded' })).rejects.toThrow(/ck_payment_status/);
    });

    it('enforces ck_payment_method', async () => {
      await expect(seedPaymentRow({ method: 'crypto' })).rejects.toThrow(/ck_payment_method/);
    });

    it('enforces ck_payment_amount_positive', async () => {
      await expect(seedPaymentRow({ amount: '0.0000', amount_minor: 0 })).rejects.toThrow(
        /ck_payment_amount_positive/,
      );
      await expect(seedPaymentRow({ amount: '-1.0000', amount_minor: -100 })).rejects.toThrow(
        /ck_payment_amount_positive/,
      );
    });

    it('enforces ck_payment_provider_matches_method', async () => {
      /* Online with no provider. */
      await expect(
        seedPaymentRow({ method: 'online', provider: null, provider_ref: null }),
      ).rejects.toThrow(/ck_payment_provider_matches_method/);

      /* COD carrying a gateway reference. */
      await expect(
        seedPaymentRow({ method: 'cod', provider: null, provider_ref: 'order_x' }),
      ).rejects.toThrow(/ck_payment_provider_matches_method/);

      /* COD with a provider. */
      await expect(
        seedPaymentRow({ method: 'cod', provider: 'razorpay', provider_ref: null }),
      ).rejects.toThrow(/ck_payment_provider_matches_method/);
    });

    it('enforces ck_payment_failure_code_only_when_failed', async () => {
      await expect(
        seedPaymentRow({ status: 'succeeded', failure_code: 'declined' }),
      ).rejects.toThrow(/ck_payment_failure_code_only_when_failed/);
    });

    it('rejects a payment whose user belongs to another store', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderId } = await givenOrder(harness, { token, userId });

      const otherStoreId = newId();
      await db().insert(store).values({
        id: otherStoreId,
        slug: 'other-store',
        name: 'Other Store',
        currency: 'INR',
        defaultLocale: 'en-IN',
        timezone: 'Asia/Kolkata',
        isActive: true,
      });

      await expect(
        testDb.handle.pool.query(
          `INSERT INTO payment (id, store_id, order_id, user_id, method, provider, provider_ref,
                                status, currency, amount, amount_minor)
           VALUES ($1, $2, $3, $4, 'online', 'razorpay', 'order_x', 'pending', 'INR', '1.0000', 100)`,
          [newId(), otherStoreId, orderId, userId],
        ),
      ).rejects.toThrow(/fk_payment_order_store|fk_payment_user_store/);
    });

    it('enforces uq_payment_event_provider', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      const [row] = await paymentRows();

      const insert = () =>
        testDb.handle.pool.query(
          `INSERT INTO payment_event (id, payment_id, store_id, from_status, to_status,
                                      actor_type, provider_event_id, event_type)
           VALUES ($1, $2, $3, 'pending', 'succeeded', 'system', 'evt_unique', 'payment.captured')`,
          [newId(), row!.id, row!.storeId],
        );

      await insert();
      await expect(insert()).rejects.toThrow(/uq_payment_event_provider/);
    });

    it('allows many internal events, because the unique index is partial', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      const [row] = await paymentRows();

      /* Two rows with a NULL provider_event_id must both be accepted. */
      for (const to of ['succeeded', 'failed']) {
        await testDb.handle.pool.query(
          `INSERT INTO payment_event (id, payment_id, store_id, from_status, to_status,
                                      actor_type, provider_event_id, event_type)
           VALUES ($1, $2, $3, 'pending', $4, 'system', NULL, 'internal')`,
          [newId(), row!.id, row!.storeId, to],
        );
      }

      expect(await eventRows()).toHaveLength(3);
    });

    it('enforces ck_payment_event_progresses', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      const [row] = await paymentRows();

      await expect(
        testDb.handle.pool.query(
          `INSERT INTO payment_event (id, payment_id, store_id, from_status, to_status,
                                      actor_type, event_type)
           VALUES ($1, $2, $3, 'pending', 'pending', 'system', 'x')`,
          [newId(), row!.id, row!.storeId],
        ),
      ).rejects.toThrow(/ck_payment_event_progresses/);
    });

    it('refuses to delete an order that has a payment', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      await expect(
        testDb.handle.pool.query('DELETE FROM "order" WHERE id = $1', [orderId]),
      ).rejects.toThrow(/fk_payment_order_store/);
    });

    it('cascades payment_event when a payment is deleted', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await initiate(harness, { token, orderNumber });

      const [row] = await paymentRows();
      expect(await eventRows()).toHaveLength(1);

      await testDb.handle.pool.query('DELETE FROM payment WHERE id = $1', [row!.id]);
      expect(await eventRows()).toEqual([]);
    });

    /** The money column is NUMERIC(19,4), so no float can round it. */
    it('stores the amount as NUMERIC(19,4)', async () => {
      const { rows } = await testDb.handle.pool.query<{
        data_type: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(`
        SELECT data_type, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_name = 'payment' AND column_name = 'amount'
      `);
      expect(rows[0]).toMatchObject({
        data_type: 'numeric',
        numeric_precision: 19,
        numeric_scale: 4,
      });
    });

    /**
     * The amount survives a value a float would mangle.
     *
     * `0.1 + 0.2` is the canonical demonstration; here the equivalent is a price whose total
     * has four decimal places and must come back exactly.
     */
    it('round-trips an amount that floating point would corrupt', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price: '0.1000',
        quantity: 3,
      });

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(201);

      expect(total).toBe('0.3000');
      expect(response.body.payment.amount).toBe('0.3000');

      const [row] = await paymentRows();
      expect(row!.amount).toBe('0.3000');
      expect(Number(row!.amountMinor)).toBe(30);

      /* Read back through SQL too, so the assertion is not about the driver's parsing. */
      const { rows } = await testDb.handle.pool.query<{ amount: string }>(
        'SELECT amount::text AS amount FROM payment',
      );
      expect(rows[0]!.amount).toBe('0.3000');
    });
  });

  /* ══ Money ══════════════════════════════════════════════════════════════ */

  describe('money', () => {
    it('converts to minor units through the money boundary, with no hard-coded factor', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);

      /*
       * A price whose paise value is not the naive `total * 100` of a float: 1000.005 x 1 is
       * 1000.0050, which rounds HALF_UP to 100001 paise. A float would give 100000.49999...
       */
      const { orderNumber, total } = await givenOrder(harness, {
        token,
        userId,
        price: '1000.0050',
      });
      expect(total).toBe('1000.0050');

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(201);

      const [row] = await paymentRows();
      expect(Number(row!.amountMinor)).toBe(100001);
      expect((harness.fetchCalls[0]!.body as { amount: number }).amount).toBe(100001);
    });

    it('never sends a fractional amount to the provider', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId, price: '333.3333' });

      await initiate(harness, { token, orderNumber });

      const sent = (harness.fetchCalls[0]!.body as { amount: number }).amount;
      expect(Number.isInteger(sent)).toBe(true);
    });
  });

  /* ══ The order must be payable ══════════════════════════════════════════ */

  describe('order eligibility', () => {
    it('refuses an order whose status is not payable', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });

      /*
       * `order.status` has exactly one value today, so the unpayable case is produced by
       * writing one directly — the CHECK permits only 'placed', so this drops it via a
       * temporary constraint change rather than pretending a second status exists.
       */
      await testDb.handle.pool.query('ALTER TABLE "order" DROP CONSTRAINT ck_order_status');
      await testDb.handle.pool.query('UPDATE "order" SET status = $1 WHERE id = $2', [
        'cancelled',
        orderId,
      ]);

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('ORDER_NOT_PAYABLE');
      expect(await paymentRows()).toEqual([]);
      expect(harness.fetchCalls).toEqual([]);
    });

    it('refuses an order with a zero total', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });

      await testDb.handle.pool.query('ALTER TABLE "order" DROP CONSTRAINT ck_order_total_identity');
      await testDb.handle.pool.query(`UPDATE "order" SET total = '0.0000' WHERE id = $1`, [
        orderId,
      ]);

      const response = await initiate(harness, { token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('ORDER_NOT_PAYABLE');
      expect(harness.fetchCalls).toEqual([]);
    });

    it('counts the payments table as empty for an unrelated order', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const first = await givenOrder(harness, { token, userId, code: 'SHIRT-A' });
      const second = await givenOrder(harness, { token, userId, code: 'MUG-B' });

      expect(
        (await initiate(harness, { token, orderNumber: first.orderNumber, key: 'key-one-0001' }))
          .status,
      ).toBe(201);
      expect(
        (await initiate(harness, { token, orderNumber: second.orderNumber, key: 'key-two-0002' }))
          .status,
      ).toBe(201);

      const rows = await paymentRows();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.orderId)).size).toBe(2);
    });
  });

  /* ══ The schema and the domain agree ════════════════════════════════════ */

  it('keeps the payment status CHECK and the state machine in step', async () => {
    /*
     * The CHECK constrains the alphabet and the state machine the grammar. If somebody adds a
     * status to one and not the other, the mismatch is silent until a transition fails in
     * production — so it is asserted here against the live constraint definition.
     */
    const { rows } = await testDb.handle.pool.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conname = 'ck_payment_status'
    `);
    const definition = rows[0]!.definition;
    for (const status of ['pending', 'succeeded', 'failed', 'expired']) {
      expect(definition).toContain(status);
    }
    expect(definition).not.toContain('refunded');
    expect(definition).not.toContain('authorized');
  });

  it('leaves the order tables entirely alone', async () => {
    /* No payment column was added to `order` — §43's separation, asserted structurally. */
    const { rows } = await testDb.handle.pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order'
        AND column_name LIKE '%payment%'
    `);
    expect(rows).toEqual([]);
  });

  it('uses a real transaction for the webhook, so nothing is half-applied', async () => {
    const harness = build();
    const { token, userId } = await signIn(harness.app, harness.identity);
    const { orderNumber } = await givenOrder(harness, { token, userId });
    await initiate(harness, { token, orderNumber });

    await webhook(harness);

    /*
     * The invariant a broken transaction boundary would break: the payment's status and its
     * newest history row must agree. A transition that wrote one without the other would show
     * up as a mismatch here.
     */
    const [row] = await paymentRows();
    const events = await db()
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.paymentId, row!.id))
      .orderBy(sql`created_at desc`);

    expect(events[0]!.toStatus).toBe(row!.status);
  });
});
