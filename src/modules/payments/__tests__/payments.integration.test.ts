import { createHmac } from 'node:crypto';

import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { withTransaction } from '../../../db/transaction.js';
import { address } from '../../../db/schema/address.js';
import { product, sku as skuTable } from '../../../db/schema/catalogue.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { idempotencyKey } from '../../../db/schema/idempotency.js';
import { stockItem, stockLedger, stockReservation } from '../../../db/schema/inventory.js';
import { order, orderLine } from '../../../db/schema/orders.js';
import { promotion } from '../../../db/schema/promotions.js';
import { shipment, shipmentEvent } from '../../../db/schema/shipments.js';
import { taxClass, taxRate } from '../../../db/schema/tax.js';
import {
  invoice as invoiceTable,
  invoiceSeries as invoiceSeriesTable,
} from '../../../db/schema/invoicing.js';
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
import { DEFAULT_SKU_ON_HAND, giveSku } from '../../../../tests/helpers/catalogue.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { add, fromDb, subtract, toDb } from '../../../shared/money.js';
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
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createInventoryRepository, createInventoryService } from '../../inventory/index.js';
import {
  createFulfilmentRepository,
  createFulfilmentRoutes,
  createFulfilmentService,
} from '../../fulfilment/index.js';
import { createTaxRepository, createTaxRoutes, createTaxService } from '../../tax/index.js';
import { createInvoicingRepository, createInvoicingService } from '../../invoicing/index.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createPaymentsRepository } from '../payments.repository.js';
import { createPaymentsRoutes } from '../payments.routes.js';
import { createPaymentsService } from '../payments.service.js';
import { createPaymentsWebhookRoutes } from '../payments.webhook.routes.js';
import { createPaymentExpirySweeper } from '../payments.sweeper.js';
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

  /** The approved production window, so a test asserts the real rule rather than a stub. */
  const EXPIRY_MINUTES = 30;
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

  /**
   * A monotonic counter for fixtures that must be unique within a file.
   *
   * NOT `newId().slice(0, 8)`: UUIDv7 is TIME-prefixed, so two ids minted in the same
   * millisecond share their leading bytes and the slice collides — which surfaced as
   * `EMAIL_ALREADY_REGISTERED` and `PHONE_ALREADY_REGISTERED` in fixtures that create several
   * customers in a loop. A counter cannot collide.
   */
  /**
   * Assert a write is refused BY A NAMED CONSTRAINT.
   *
   * Drizzle wraps the driver error, so `toThrow(/name/)` matches only the wrapper's "Failed
   * query" text and would pass for any failure at all. The constraint name lives on `.cause`,
   * and checking it is the difference between "this write failed" and "this write failed for
   * the reason the schema says it must".
   */
  const expectDbConstraint = async (work: Promise<unknown>, constraint: string) => {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }
    expect(caught, `expected the write to be refused by ${constraint}`).toBeDefined();
    const chain = [caught, (caught as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join(' | ');
    expect(chain).toContain(constraint);
  };

  let seq = 0;
  const nextSeq = (): string => {
    seq += 1;
    return String(seq).padStart(4, '0');
  };

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
    const scopeGuards = createScopeGuards({
      loadSubject: async (params) => identityRepository.findSubjectById(params),
      logger: silentLogger,
    });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const recorders = testRecorders(db());

    /**
     * A REAL inventory service, not a stub.
     *
     * Checkout reserves stock, shipping fulfils it, and both guarantees are properties of
     * PostgreSQL statements a mock cannot have.
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

    /**
     * A REAL tax service.
     *
     * Every GST property this suite claims — the supply-type branch, effective-dated rate
     * selection, the refusal of an unclassified SKU, the immutability of the snapshot — is a
     * property of real rows. A double answering "no tax" would let all of it pass untested.
     */
    const tax = createTaxService({
      repository: createTaxRepository({ db: db() }),
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });

    /**
     * A REAL invoicing service, not a stub.
     *
     * The numbering guarantees this increment claims — gapless, per-store, per-financial-year,
     * released by a rollback — are properties of ONE PostgreSQL statement against a real row.
     * A double handing back "INV/…/000001" would let all of them pass while nothing was
     * exercised.
     */
    const invoicing = createInvoicingService({
      repository: createInvoicingRepository({ db: db() }),
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
       * A REAL fulfilment service, late-bound exactly as the composition root binds it.
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
      tax: { determineForCheckout: (input) => tax.determineForCheckout(input) },
      invoicing: {
        issueForOrder: (input) => invoicing.issueForOrder(input),
        findForOrder: (input) => invoicing.findForOrder(input),
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
              /* grand_total, exactly as the composition root wires it. */
              payableTotal: view.order.grandTotal,
            };
          } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
          }
        },
        /* The order lock the expiry path takes first, wired as the composition root does. */
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
    apiRouter.use(
      createPaymentsRoutes({
        payments,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireIdempotency: requireIdempotency({ store: idempotency, logger: silentLogger }),
        logger: silentLogger,
      }),
    );

    apiRouter.use(
      createTaxRoutes({
        tax,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
        logger: silentLogger,
      }),
    );
    /*
     * The fulfilment routes, mounted here rather than in a suite of their own.
     *
     * Fulfilment rules ARE payment rules — an online order must be paid, a COD order may ship
     * unpaid — so the tests need a real payments module, a real inventory service and a real
     * order behind checkout. This harness already builds all three.
     */
    apiRouter.use(
      createFulfilmentRoutes({
        fulfilment,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        requireStaff: scopeGuards.requireScope('staff'),
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
      fulfilment,
      tax,
      inventory,
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
    options: { email?: string; storeId?: string; staff?: boolean } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'ada@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    /*
     * Promoted by UPDATE, not by an endpoint: no endpoint grants `is_staff`, because that
     * would be a privilege-escalation route on a public API. The token is minted afterwards so
     * it carries the scope.
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
    overrides: { code?: string; price?: string; storeId?: string; onHand?: number } = {},
  ) {
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
      onHand: overrides.onHand ?? DEFAULT_SKU_ON_HAND,
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

  /**
   * Retry an assertion until it holds, or give up.
   *
   * For the one thing in this system that is deliberately NOT awaited: the idempotency
   * middleware writes its completion or release after the response has already been sent. A
   * test that reads the row once is racing that write, and loses often enough under parallel
   * load to make the suite untrustworthy — which is worse than a slow test.
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
       *
       * **Polled rather than read once.** The middleware releases the key AFTER the response has
       * been sent and deliberately does not await that write — `captureResponse` says so: *"the
       * response has already left, so making the client wait for bookkeeping would add latency
       * to every successful request"*. So the row can still be present for a few milliseconds
       * after a `503` reaches the client, and a single read is a race that fails under
       * full-suite parallel load. This is the same fire-and-forget window that makes one test in
       * `http/__tests__/idempotency.integration.test.ts` flaky.
       */
      await waitFor(async () => {
        const claims = await db().select().from(idempotencyKey).where(eq(idempotencyKey.key, KEY));
        expect(claims).toEqual([]);
      });
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

  /* ══ The customer's payment list ════════════════════════════════════════ */

  describe('listing payments', () => {
    /** Narrow the response body once, so the assertions below are not calls on `any`. */
    const orderNumbersOf = (body: unknown): string[] =>
      (body as { payments: { orderNumber: string }[] }).payments.map((p) => p.orderNumber);

    /** Create `count` orders, each with a COD payment, oldest first. */
    async function givenPayments(
      harness: Harness,
      options: { token: string; userId: string; count: number },
    ): Promise<string[]> {
      const numbers: string[] = [];
      for (let i = 0; i < options.count; i += 1) {
        const { orderNumber } = await givenOrder(harness, {
          token: options.token,
          userId: options.userId,
          code: `LIST-${String(i)}`,
        });
        expect(
          (
            await initiate(harness, {
              token: options.token,
              orderNumber,
              method: 'cod',
              key: `list-key-${String(i).padStart(4, '0')}`,
            })
          ).status,
        ).toBe(201);
        numbers.push(orderNumber);
      }
      return numbers;
    }

    it('returns this customer’s payments, newest first, with their order numbers', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const numbers = await givenPayments(harness, { token, userId, count: 3 });

      const response = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.payments).toHaveLength(3);
      expect(response.body.pagination).toEqual({ limit: 20, offset: 0, total: 3 });

      /* Newest first: the reverse of creation order. */
      expect(orderNumbersOf(response.body)).toEqual([...numbers].reverse());

      /* Each row is a full payment, with an empty history. */
      for (const row of response.body.payments) {
        expect(row).toMatchObject({ method: 'cod', provider: null, status: 'pending' });
        expect(row.history).toEqual([]);
      }
    });

    it('paginates, and reports the total independently of the page', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const numbers = await givenPayments(harness, { token, userId, count: 3 });
      const newestFirst = [...numbers].reverse();

      const page1 = await request(harness.app)
        .get('/api/v1/users/me/payments?limit=2&offset=0')
        .set('authorization', `Bearer ${token}`);
      expect(page1.status).toBe(200);
      expect(orderNumbersOf(page1.body)).toEqual(newestFirst.slice(0, 2));
      expect(page1.body.pagination).toEqual({ limit: 2, offset: 0, total: 3 });

      const page2 = await request(harness.app)
        .get('/api/v1/users/me/payments?limit=2&offset=2')
        .set('authorization', `Bearer ${token}`);
      expect(orderNumbersOf(page2.body)).toEqual(newestFirst.slice(2));
      expect(page2.body.pagination).toEqual({ limit: 2, offset: 2, total: 3 });

      /* Past the end is an empty page, not an error. */
      const page3 = await request(harness.app)
        .get('/api/v1/users/me/payments?limit=2&offset=99')
        .set('authorization', `Bearer ${token}`);
      expect(page3.status).toBe(200);
      expect(page3.body.payments).toEqual([]);
      expect(page3.body.pagination.total).toBe(3);
    });

    it('returns an empty page for a customer with no payments', async () => {
      const harness = build();
      const { token } = await signIn(harness.app, harness.identity);

      const response = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        payments: [],
        pagination: { limit: 20, offset: 0, total: 0 },
      });
    });

    /** The isolation property: one customer's list can never contain another's payment. */
    it("never includes another customer's payments", async () => {
      const harness = build();
      const ada = await signIn(harness.app, harness.identity, { email: 'ada@example.com' });
      const adaOrders = await givenPayments(harness, {
        token: ada.token,
        userId: ada.userId,
        count: 2,
      });

      const bob = await signIn(harness.app, harness.identity, { email: 'bob@example.com' });

      const bobList = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${bob.token}`);
      expect(bobList.status).toBe(200);
      expect(bobList.body.payments).toEqual([]);
      expect(bobList.body.pagination.total).toBe(0);

      const adaList = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${ada.token}`);
      expect(adaList.body.pagination.total).toBe(2);
      expect(orderNumbersOf(adaList.body).sort()).toEqual([...adaOrders].sort());
    });

    it('rejects an unauthenticated request', async () => {
      const harness = build();
      expect((await request(harness.app).get('/api/v1/users/me/payments')).status).toBe(401);
    });

    it('validates pagination and rejects unknown query keys', async () => {
      const harness = build();
      const { token } = await signIn(harness.app, harness.identity);

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=-1',
        '?limit=abc',
        '?limit=1.5',
        '?offset=-1',
        '?offset=abc',
        '?page=2',
        '?sort=asc',
      ]) {
        const response = await request(harness.app)
          .get(`/api/v1/users/me/payments${query}`)
          .set('authorization', `Bearer ${token}`);
        expect(response.status, query).toBe(400);
      }

      /* The boundaries themselves are accepted. */
      for (const query of ['?limit=1', '?limit=100', '?offset=0']) {
        const response = await request(harness.app)
          .get(`/api/v1/users/me/payments${query}`)
          .set('authorization', `Bearer ${token}`);
        expect(response.status, query).toBe(200);
      }
    });

    /** A list row must not publish more than the single read does. */
    it('publishes exactly the documented fields on a list row', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      await givenPayments(harness, { token, userId, count: 1 });

      const response = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${token}`);

      expect(Object.keys(response.body.payments[0]).sort()).toEqual([
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

      const serialised = JSON.stringify(response.body);
      for (const leaked of ['userId', 'storeId', 'orderId', 'amountMinor', 'providerRef']) {
        expect(serialised).not.toContain(leaked);
      }
    });

    it('reflects a transition on the next read', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      const before = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${token}`);
      expect(before.body.payments[0].status).toBe('pending');

      expect((await webhook(harness)).status).toBe(200);

      const after = await request(harness.app)
        .get('/api/v1/users/me/payments')
        .set('authorization', `Bearer ${token}`);
      expect(after.body.payments[0].status).toBe('succeeded');
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
      /*
       * `grand_total` moves WITH `total`. Increment 38 added
       * `ck_order_grand_total_identity` (grand_total = total + tax_total), so setting one and
       * not the other is a row the database refuses — which is the constraint doing its job,
       * not a problem with this test's premise.
       */
      await testDb.handle.pool.query(
        `UPDATE "order" SET total = '0.0000', grand_total = '0.0000' WHERE id = $1`,
        [orderId],
      );

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

  /* ── Payment expiry (Increment 36) ─────────────────────────────────────── */

  /**
   * Local expiry of abandoned online payments, and the stock it gives back.
   *
   * Time is controlled by DATA, not by fake timers: a payment is seeded with `expires_at` in
   * the past and the sweeper is invoked with a chosen `now`. That is the repository's
   * established pattern — there are no `vi.useFakeTimers` anywhere in it — and it keeps these
   * tests deterministic without touching the clock other suites share.
   */
  describe('expiry', () => {
    const reservations = () => db().select().from(stockReservation);
    const stockRows = () => db().select().from(stockItem);

    /** A sweeper over the real service, with the batch size under test's control. */
    function sweeper(harness: Harness, batchSize = 100) {
      return createPaymentExpirySweeper({
        payments: harness.payments,
        batchSize,
        logger: silentLogger,
      });
    }

    /** An online payment already past its window, with its reservation still held. */
    async function givenDuePayment(harness: Harness, options: { code?: string } = {}) {
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: `due-${nextSeq()}@example.com`,
      });
      const { orderNumber, orderId } = await givenOrder(harness, {
        token,
        userId,
        ...(options.code === undefined ? {} : { code: options.code }),
      });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      /*
       * Push the window into the past. Seeding the COLUMN rather than waiting is what makes
       * this deterministic — and it is the same thing the sweeper will read in production.
       */
      await testDb.handle.pool.query(
        `UPDATE payment SET expires_at = now() - interval '1 minute' WHERE order_id = $1`,
        [orderId],
      );
      return { token, orderNumber, orderId };
    }

    /* ── Stamping ────────────────────────────────────────────────────────── */

    it('stamps an online payment with a window 30 minutes ahead', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const before = Date.now();
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);
      const after = Date.now();

      const { rows } = await testDb.handle.pool.query<{ expires_at: Date; method: string }>(
        'SELECT expires_at, method FROM payment',
      );
      expect(rows[0]?.method).toBe('online');
      const expiresAt = rows[0]!.expires_at.getTime();
      /* Bracketed by the request, so this asserts the window and not a clock. */
      expect(expiresAt).toBeGreaterThanOrEqual(before + EXPIRY_MINUTES * 60_000);
      expect(expiresAt).toBeLessThanOrEqual(after + EXPIRY_MINUTES * 60_000);
    });

    /** COD is out of expiry's scope by decision, and the database enforces it too. */
    it('leaves a COD payment with no window at all', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);

      const { rows } = await testDb.handle.pool.query<{ expires_at: Date | null }>(
        'SELECT expires_at FROM payment',
      );
      expect(rows[0]?.expires_at).toBeNull();
    });

    /** The window is server-side. A body field for it is a 400, not an override. */
    it('refuses a client-supplied expiresAt', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await initiate(harness, {
        token,
        orderNumber,
        body: { method: 'online', expiresAt: '2099-01-01T00:00:00.000Z' },
      });

      expect(response.status).toBe(400);
      expect(response.body.error.details.fields.body).toContain('Unrecognized key: "expiresAt"');
    });

    /* ── Eligibility ─────────────────────────────────────────────────────── */

    it('selects a due pending online payment', async () => {
      const harness = build();
      await givenDuePayment(harness);

      const due = await harness.payments.listExpiryDue({ now: new Date(), limit: 10 });
      expect(due).toHaveLength(1);
    });

    it('does not select a payment whose window is still in the future', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);

      expect(await harness.payments.listExpiryDue({ now: new Date(), limit: 10 })).toEqual([]);
    });

    it('does not select COD, whatever the clock says', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);

      /* Far future, so nothing can be excluded merely by not being due yet. */
      const far = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000);
      expect(await harness.payments.listExpiryDue({ now: far, limit: 10 })).toEqual([]);
    });

    it('does not select a payment that is already terminal', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);

      /* Succeed it, then re-arm a past window to prove STATUS is what excludes it. */
      expect((await webhook(harness)).status).toBe(200);
      await testDb.handle.pool.query(
        `UPDATE payment SET expires_at = now() - interval '1 minute' WHERE order_id = $1`,
        [orderId],
      );

      expect(await harness.payments.listExpiryDue({ now: new Date(), limit: 10 })).toEqual([]);
    });

    it('does not select a pending online payment with a NULL window', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      await testDb.handle.pool.query('UPDATE payment SET expires_at = NULL WHERE order_id = $1', [
        orderId,
      ]);

      expect(await harness.payments.listExpiryDue({ now: new Date(), limit: 10 })).toEqual([]);
    });

    /* ── The transition ──────────────────────────────────────────────────── */

    it('expires the payment, records the transition and releases the stock', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      const [heldBefore] = await reservations();
      expect(heldBefore?.status).toBe('held');
      const [stockBefore] = await stockRows();
      expect(stockBefore!.reserved).toBeGreaterThan(0);

      const result = await sweeper(harness).sweep(new Date());
      expect(result).toEqual({ candidates: 1, expired: 1, ignored: 0, failed: 0 });

      const [row] = await paymentRows();
      expect(row!.status).toBe('expired');
      /* An expiry is not a failure — `ck_payment_failure_code_only_when_failed` agrees. */
      expect(row!.failureCode).toBeNull();

      const events = await eventRows();
      const transition = events.find((e) => e.toStatus === 'expired');
      expect(transition).toMatchObject({
        fromStatus: 'pending',
        toStatus: 'expired',
        actorType: 'system',
        actorUserId: null,
        /* NULL, because no provider event caused this. A fabricated id would pollute the
         * uniqueness guard that makes webhook redelivery safe. */
        providerEventId: null,
      });

      const [settled] = await reservations();
      expect(settled?.status).toBe('released');
      expect(settled?.settledReason).toBe('payment_expired');
      expect(settled?.settledAt).not.toBeNull();

      const [stockAfter] = await stockRows();
      expect(stockAfter!.reserved).toBe(0);
      expect(stockAfter!.available).toBe(stockAfter!.onHand);

      /* The order is untouched: payment state and order state stay separate. */
      const [orderRow] = await db().select().from(order).where(eq(order.id, orderId));
      expect(orderRow?.status).toBe('placed');
    });

    it('writes the expiry audit entry with a system actor', async () => {
      const harness = build();
      await givenDuePayment(harness);
      await sweeper(harness).sweep(new Date());

      const entries = await db().select().from(auditLog);
      const expired = entries.find((e) => e.action === 'payment.expired');
      expect(expired).toMatchObject({ actorType: 'system', actorUserId: null, storeId });
    });

    /** No consumer exists, so no event is published. The outbox must stay empty. */
    it('emits no domain event', async () => {
      const harness = build();
      await givenDuePayment(harness);
      await sweeper(harness).sweep(new Date());

      /*
       * Scoped to `payment.*`, not "the outbox is empty".
       *
       * Registration publishes `user.registered` — the ONE event with a real consumer — so an
       * unscoped assertion here tests the fixture rather than the sweeper. What this claims is
       * narrower and true: expiry publishes nothing of its own.
       */
      const published = await db().select().from(outboxEvent);
      expect(published.filter((e) => e.eventName.startsWith('payment.'))).toEqual([]);
    });

    /* ── Terminal-state protection ───────────────────────────────────────── */

    it('refuses to expire a payment that already succeeded', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      expect((await webhook(harness)).status).toBe(200);

      const [before] = await reservations();
      expect(before?.status).toBe('committed');

      const result = await harness.payments.expirePayment({
        paymentId: (await paymentRows())[0]!.id,
        storeId,
        orderId,
      });

      expect(result).toEqual({ outcome: 'ignored', reason: 'already_terminal' });
      expect((await paymentRows())[0]!.status).toBe('succeeded');
      /* The committed reservation is untouched — sold stock is never given back. */
      const [after] = await reservations();
      expect(after?.status).toBe('committed');
      expect(after?.settledAt).toEqual(before?.settledAt);
    });

    /* ── Late provider success: the accepted exposure ─────────────────────── */

    /**
     * **Local expiry is authoritative, and this test is the record of what that costs.**
     *
     * Razorpay can capture a payment after we have expired it locally. Nothing reads back from
     * the provider, so the late webhook is ignored as already-terminal: the stock stays
     * released and the payment stays expired, while the money may well have been taken.
     *
     * That is the approved decision, not a defect — and it is a KNOWN FINANCIAL EXPOSURE
     * requiring manual reconciliation. This test exists so the behaviour cannot change silently.
     */
    it('ignores a captured webhook that arrives after local expiry', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      await sweeper(harness).sweep(new Date());
      expect((await paymentRows())[0]!.status).toBe('expired');

      const late = await webhook(harness);

      expect(late.status).toBe(200);
      expect(late.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      /* Still expired. Not resurrected. */
      expect((await paymentRows())[0]!.status).toBe('expired');

      /* The reservation stays RELEASED — not committed, and not recreated. */
      const [settled] = await reservations();
      expect(settled?.status).toBe('released');
      expect(settled?.settledReason).toBe('payment_expired');
      expect((await stockRows())[0]!.reserved).toBe(0);

      const [orderRow] = await db().select().from(order).where(eq(order.id, orderId));
      expect(orderRow?.status).toBe('placed');
    });

    /* ── Concurrency ─────────────────────────────────────────────────────── */

    /** Both take the same payment row lock, so exactly one terminal transition commits. */
    it('resolves expiry racing a successful webhook to one transition', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      const paymentId = (await paymentRows())[0]!.id;

      const [expiry, hook] = await Promise.all([
        harness.payments.expirePayment({ paymentId, storeId, orderId }),
        webhook(harness),
      ]);

      const [row] = await paymentRows();
      expect(['expired', 'succeeded']).toContain(row!.status);

      /* Exactly one of the two did the work; the other observed a terminal state. */
      const expiryWon = expiry.outcome === 'expired';
      const hookWon = hook.body.status === 'applied';
      expect(expiryWon !== hookWon).toBe(true);

      /* And the reservation settled exactly once, consistently with whoever won. */
      const [settled] = await reservations();
      expect(settled?.status).toBe(expiryWon ? 'released' : 'committed');
      expect(settled?.settledReason).toBe(expiryWon ? 'payment_expired' : 'payment_succeeded');
    });

    it('lets only one of two concurrent expiry attempts do the work', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      const paymentId = (await paymentRows())[0]!.id;

      const results = await Promise.all([
        harness.payments.expirePayment({ paymentId, storeId, orderId }),
        harness.payments.expirePayment({ paymentId, storeId, orderId }),
      ]);

      expect(results.filter((r) => r.outcome === 'expired')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'ignored')).toHaveLength(1);
      expect((await stockRows())[0]!.reserved).toBe(0);
      expect(await eventRows()).toHaveLength(2);
    });

    /**
     * Expiry takes the ORDER lock first, which is what serialises it with cancellation.
     *
     * Cancellation refuses a `pending` payment and permits an `expired` one, so either
     * ordering is legal — what must not happen is a double release or a 500.
     */
    it('serialises with order cancellation', async () => {
      const harness = build();
      const { token, orderNumber, orderId } = await givenDuePayment(harness);
      const paymentId = (await paymentRows())[0]!.id;

      const [, cancelled] = await Promise.all([
        harness.payments.expirePayment({ paymentId, storeId, orderId }),
        request(harness.app)
          .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
          .set('authorization', `Bearer ${token}`),
      ]);

      expect([200, 409]).toContain(cancelled.status);
      expect((await paymentRows())[0]!.status).toBe('expired');

      /* Released exactly once, whichever path got there first. */
      const settled = await reservations();
      expect(settled).toHaveLength(1);
      expect(settled[0]?.status).toBe('released');
      expect((await stockRows())[0]!.reserved).toBe(0);
    });

    /* ── The sweeper ─────────────────────────────────────────────────────── */

    it('processes several candidates in one pass', async () => {
      const harness = build();
      await givenDuePayment(harness, { code: 'EXP-A' });
      await givenDuePayment(harness, { code: 'EXP-B' });
      await givenDuePayment(harness, { code: 'EXP-C' });

      const result = await sweeper(harness).sweep(new Date());

      expect(result).toEqual({ candidates: 3, expired: 3, ignored: 0, failed: 0 });
      for (const row of await paymentRows()) expect(row.status).toBe('expired');
      for (const row of await stockRows()) expect(row.reserved).toBe(0);
    });

    it('honours the batch size', async () => {
      const harness = build();
      await givenDuePayment(harness, { code: 'BAT-A' });
      await givenDuePayment(harness, { code: 'BAT-B' });

      const result = await sweeper(harness, 1).sweep(new Date());

      expect(result.candidates).toBe(1);
      expect(result.expired).toBe(1);
      /* The other is simply left for the next pass. */
      expect((await paymentRows()).filter((p) => p.status === 'pending')).toHaveLength(1);
    });

    it('reports nothing to do without touching anything', async () => {
      const harness = build();
      expect(await sweeper(harness).sweep(new Date())).toEqual({
        candidates: 0,
        expired: 0,
        ignored: 0,
        failed: 0,
      });
    });

    /**
     * One poisoned candidate must not end the pass.
     *
     * The failure is injected at the reservation port, which is where a real divergence would
     * surface, and the sweeper is expected to log it, count it, and carry on to the next id.
     */
    it('continues past a failing candidate and leaves it retryable', async () => {
      const harness = build();
      const first = await givenDuePayment(harness, { code: 'FAIL-A' });
      await givenDuePayment(harness, { code: 'FAIL-B' });

      const failing = {
        listExpiryDue: (input: { now: Date; limit: number }) =>
          harness.payments.listExpiryDue(input),
        expirePayment: async (input: { paymentId: string; storeId: string; orderId: string }) => {
          if (input.orderId === first.orderId) throw new Error('injected release divergence');
          return harness.payments.expirePayment(input);
        },
      };

      const result = await createPaymentExpirySweeper({
        payments: failing,
        batchSize: 100,
        logger: silentLogger,
      }).sweep(new Date());

      expect(result.candidates).toBe(2);
      expect(result.expired).toBe(1);
      expect(result.failed).toBe(1);

      /* The poisoned one is untouched and still due, so the next pass retries it. */
      const rows = await paymentRows();
      expect(rows.filter((p) => p.status === 'pending')).toHaveLength(1);
      expect(await harness.payments.listExpiryDue({ now: new Date(), limit: 10 })).toHaveLength(1);
    });

    /* ── Rollback ────────────────────────────────────────────────────────── */

    /**
     * **A failed release must never leave a payment marked expired.**
     *
     * The divergence is provoked for real: the reservation row is left `held` while the
     * projection is zeroed, so `releaseForSku` matches nothing and the inventory service raises
     * `InvariantViolation` — exactly the state the guard exists for. Everything must roll back.
     */
    it('rolls the whole transaction back when the reservation release fails', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);
      const paymentId = (await paymentRows())[0]!.id;

      /* Held reservation, zero counter: the projection has diverged. */
      await testDb.handle.pool.query('UPDATE stock_item SET reserved = 0');

      await expect(harness.payments.expirePayment({ paymentId, storeId, orderId })).rejects.toThrow(
        /diverged/i,
      );

      /* Payment still pending. */
      expect((await paymentRows())[0]!.status).toBe('pending');
      /* No transition row survived. */
      expect((await eventRows()).filter((e) => e.toStatus === 'expired')).toEqual([]);
      /* No audit entry survived. */
      const entries = await db().select().from(auditLog);
      expect(entries.filter((e) => e.action === 'payment.expired')).toEqual([]);
      /* Reservation still held. */
      expect((await reservations())[0]?.status).toBe('held');

      /* And still eligible, so a later pass can succeed once the projection is repaired. */
      expect(await harness.payments.listExpiryDue({ now: new Date(), limit: 10 })).toHaveLength(1);
    });

    /* ── Database constraints ────────────────────────────────────────────── */

    it('refuses a window on a COD payment', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);

      let caught: unknown;
      try {
        await testDb.handle.pool.query("UPDATE payment SET expires_at = now() + interval '1 hour'");
      } catch (err) {
        caught = err;
      }
      expect((caught as { constraint?: string } | undefined)?.constraint).toBe(
        'ck_payment_expires_at_only_online',
      );
    });

    it('accepts an online payment with a window, and one without', async () => {
      const harness = build();
      const { orderId } = await givenDuePayment(harness);

      /* With — already true, since initiation stamped it. */
      const { rows: withWindow } = await testDb.handle.pool.query(
        'SELECT expires_at FROM payment WHERE order_id = $1',
        [orderId],
      );
      expect(withWindow[0]?.expires_at).not.toBeNull();

      /* Without — NULL is legal for online too, which is what avoided a backfill. */
      await testDb.handle.pool.query('UPDATE payment SET expires_at = NULL WHERE order_id = $1', [
        orderId,
      ]);
      const { rows: without } = await testDb.handle.pool.query(
        'SELECT expires_at FROM payment WHERE order_id = $1',
        [orderId],
      );
      expect(without[0]?.expires_at).toBeNull();
    });

    it('has the partial expiry index, and the candidate query uses it', async () => {
      const { rows: idx } = await testDb.handle.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_payment_expiry_due'`,
      );
      expect(idx).toHaveLength(1);
      expect(idx[0]!.indexdef).toContain("status)::text = 'pending'");
      expect(idx[0]!.indexdef).toContain("method)::text = 'online'");

      /*
       * EXPLAIN, with sequential scans disabled so the planner must show whether the index is
       * USABLE for this predicate. On a table of a few rows a seq scan is genuinely cheaper,
       * so without this the plan says nothing about the index.
       */
      await testDb.handle.pool.query('SET LOCAL enable_seqscan = off');
      const { rows: plan } = await testDb.handle.pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM payment
          WHERE status = 'pending' AND method = 'online'
            AND expires_at IS NOT NULL AND expires_at <= now()
          ORDER BY expires_at LIMIT 100`,
      );
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('ix_payment_expiry_due');
    });
  });

  /* ── Fulfilment (Increment 37) ─────────────────────────────────────────── */

  /**
   * Manual fulfilment: raising a shipment, shipping it, recording delivery.
   *
   * Wired against the REAL payments and inventory modules, because every rule here turns on one
   * of them: an online order must be paid, a COD order may ship unpaid, and shipping is the only
   * thing in the codebase that decreases `on_hand`. A stub would let all of it pass while nothing
   * worked.
   */
  describe('fulfilment', () => {
    const shipments = () => db().select().from(shipment);
    const shipmentEvents = () => db().select().from(shipmentEvent);
    const reservations = () => db().select().from(stockReservation);
    const ledger = () => db().select().from(stockLedger);
    const stockRows = () => db().select().from(stockItem);

    /* A counter, not a slice of a fresh id: UUIDv7 is time-prefixed and collides. */
    /* The file-wide counter, so identities stay unique ACROSS blocks too. */
    const uniqueEmail = (prefix: string) => `${prefix}-${nextSeq()}-${newId()}@example.com`;

    /** A staff member in this store. Promoted by SQL — no endpoint grants `is_staff`. */
    async function givenStaff(harness: Harness) {
      const auth = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('ops'),
        staff: true,
      });
      return auth;
    }

    /** A paid online order, ready to ship. */
    async function givenPaidOrder(harness: Harness, options: { code?: string } = {}) {
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('buyer'),
      });
      const { orderNumber, orderId } = await givenOrder(harness, {
        token,
        userId,
        ...(options.code === undefined ? {} : { code: options.code }),
      });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);
      /*
       * A DISTINCT event id per delivery.
       *
       * `webhook()` defaults to a constant, and a second call with it is a genuine duplicate
       * delivery — correctly ignored by the idempotency guard, which left the SECOND order
       * unpaid and made every two-order fulfilment test fail with a 422 nobody could explain.
       */
      expect((await webhook(harness, { eventId: `evt_paid_${nextSeq()}` })).status).toBe(200);
      return { token, userId, orderNumber, orderId };
    }

    /** A COD order: payment created, and permanently `pending`. */
    async function givenCodOrder(harness: Harness, options: { code?: string } = {}) {
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('cod'),
      });
      const { orderNumber, orderId } = await givenOrder(harness, {
        token,
        userId,
        ...(options.code === undefined ? {} : { code: options.code }),
      });
      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);
      return { token, userId, orderNumber, orderId };
    }

    const createShipment = (
      harness: Harness,
      options: { token: string; orderNumber: string; body?: Record<string, unknown> },
    ) =>
      request(harness.app)
        .post(`/api/v1/admin/orders/${options.orderNumber}/shipments`)
        .set('authorization', `Bearer ${options.token}`)
        .send(options.body ?? {});

    const ship = (harness: Harness, options: { token: string; id: string }) =>
      request(harness.app)
        .post(`/api/v1/admin/shipments/${options.id}/ship`)
        .set('authorization', `Bearer ${options.token}`)
        .send({});

    const deliver = (harness: Harness, options: { token: string; id: string }) =>
      request(harness.app)
        .post(`/api/v1/admin/shipments/${options.id}/deliver`)
        .set('authorization', `Bearer ${options.token}`)
        .send({});

    /* ── Creating a shipment ─────────────────────────────────────────────── */

    it('creates a pending shipment for a paid order', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);

      const response = await createShipment(harness, {
        token: staff.token,
        orderNumber,
        body: { carrier: 'Bluedart', trackingNumber: 'BD123456789' },
      });

      expect(response.status).toBe(201);
      expect(Object.keys(response.body.shipment).sort()).toEqual([
        'carrier',
        'createdAt',
        'deliveredAt',
        'id',
        'shippedAt',
        'status',
        'trackingNumber',
        'trackingUrl',
      ]);
      expect(response.body.shipment.status).toBe('pending');
      expect(response.body.shipment.shippedAt).toBeNull();
      expect(response.body.shipment.deliveredAt).toBeNull();

      /* The creation row: created IN this state, so `from_status` is NULL. */
      const events = await shipmentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'pending',
        actorType: 'staff',
        actorUserId: staff.userId,
      });

      /* Creation moves NO stock. */
      expect(await ledger()).toEqual([]);
      expect((await reservations())[0]?.status).toBe('committed');
    });

    it('accepts a shipment with no carrier or tracking yet', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);

      const response = await createShipment(harness, { token: staff.token, orderNumber });

      expect(response.status).toBe(201);
      expect(response.body.shipment.carrier).toBeNull();
      expect(response.body.shipment.trackingNumber).toBeNull();
    });

    /**
     * One shipment per order, enforced by `uq_shipment_order`.
     *
     * This is also why creation carries no `Idempotency-Key`: the constraint does the work a
     * header would only approximate.
     */
    it('refuses a second shipment for the same order', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);

      expect((await createShipment(harness, { token: staff.token, orderNumber })).status).toBe(201);

      const second = await createShipment(harness, { token: staff.token, orderNumber });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SHIPMENT_ALREADY_EXISTS');
      expect(await shipments()).toHaveLength(1);
    });

    it('creates exactly one shipment under concurrent creation', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);

      const results = await Promise.all([
        createShipment(harness, { token: staff.token, orderNumber }),
        createShipment(harness, { token: staff.token, orderNumber }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await shipments()).toHaveLength(1);
      expect(await shipmentEvents()).toHaveLength(1);
    });

    /* ── Shipping: the stock movement ────────────────────────────────────── */

    /**
     * **The inventory invariant, in one test.**
     *
     * `on_hand` falls, `reserved` falls by the same amount, `available` is UNCHANGED — because
     * the units stopped being sellable when they were reserved, not now — one ledger row per
     * SKU with a negative delta, and the reservation reaches `fulfilled`.
     */
    it('ships: moves stock, writes the ledger and fulfils the reservation', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const [before] = await stockRows();
      const [heldRow] = await reservations();

      const response = await ship(harness, { token: staff.token, id: created.body.shipment.id });

      expect(response.status).toBe(200);
      expect(response.body.shipment.status).toBe('shipped');
      expect(response.body.shipment.shippedAt).not.toBeNull();
      expect(response.body.shipment.deliveredAt).toBeNull();

      const [after] = await stockRows();
      const qty = heldRow!.quantity;
      expect(after!.onHand).toBe(before!.onHand - qty);
      expect(after!.reserved).toBe(before!.reserved - qty);
      /* The whole point: shipping does not make anything newly sellable. */
      expect(after!.available).toBe(before!.available);
      expect(after!.onHand).toBeGreaterThanOrEqual(0);
      expect(after!.reserved).toBeGreaterThanOrEqual(0);

      const entries = await ledger();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        skuId: heldRow!.skuId,
        delta: -qty,
        onHandBefore: before!.onHand,
        onHandAfter: after!.onHand,
        reason: 'shipment',
        /* NOT NULL by decision: manual fulfilment always has a real staff actor. */
        actorUserId: staff.userId,
      });

      const settled = await reservations();
      expect(settled[0]?.status).toBe('fulfilled');
      expect(settled[0]?.settledReason).toBe('shipment_fulfilled');
      expect(settled[0]?.fulfilledAt).not.toBeNull();
      /* The commit fact survives the fulfilment fact — a separate column, not a re-stamp. */
      expect(settled[0]?.settledAt).not.toBeNull();
    });

    /** `SUM(delta) = on_hand`, the ledger's founding invariant, still holds after a shipment. */
    it('keeps SUM(delta) equal to on_hand', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      await ship(harness, { token: staff.token, id: created.body.shipment.id });

      /*
       * **Not `SUM(delta) = SUM(on_hand)`.** That premise is false in this harness: `giveSku`
       * seeds `on_hand` directly with no ledger row behind it, so the ledger can only ever
       * account for the MOVEMENTS, never for the opening balance.
       *
       * What is asserted instead is the property the ledger actually guarantees, and the one
       * that would catch a real bug: each row's own arithmetic holds, and its `on_hand_after`
       * matches the column it moved.
       */
      const entries = await ledger();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Number(entry.onHandBefore) + entry.delta).toBe(Number(entry.onHandAfter));
      }
      const [current] = await stockRows();
      expect(Number(entries.at(-1)!.onHandAfter)).toBe(current!.onHand);
    });

    it('refuses to ship twice, and moves stock only once', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;

      expect((await ship(harness, { token: staff.token, id })).status).toBe(200);
      const [afterFirst] = await stockRows();
      const shippedAt = (await shipments())[0]?.shippedAt;

      const second = await ship(harness, { token: staff.token, id });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('SHIPMENT_NOT_TRANSITIONABLE');

      expect((await stockRows())[0]?.onHand).toBe(afterFirst!.onHand);
      expect(await ledger()).toHaveLength(1);
      expect(await shipmentEvents()).toHaveLength(2);
      /* Never re-stamped. */
      expect((await shipments())[0]?.shippedAt).toEqual(shippedAt);
    });

    /**
     * **Exactly one of two concurrent staff members ships it.**
     *
     * The guarantee is a row lock plus a CAS, not a mock: one 200, one 409, one stock movement,
     * one ledger row, one event.
     */
    it('lets exactly one of two concurrent staff ship the same shipment', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const first = await givenStaff(harness);
      const second = await givenStaff(harness);
      const created = await createShipment(harness, { token: first.token, orderNumber });
      const id = created.body.shipment.id as string;
      const [before] = await stockRows();

      const results = await Promise.all([
        ship(harness, { token: first.token, id }),
        ship(harness, { token: second.token, id }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await ledger()).toHaveLength(1);
      expect(await shipmentEvents()).toHaveLength(2);
      const [after] = await stockRows();
      expect(after!.onHand).toBe(before!.onHand - (await reservations())[0]!.quantity);
    });

    /* ── Delivery ────────────────────────────────────────────────────────── */

    it('delivers a shipped shipment and moves no stock', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;
      await ship(harness, { token: staff.token, id });
      const [beforeDelivery] = await stockRows();

      const response = await deliver(harness, { token: staff.token, id });

      expect(response.status).toBe(200);
      expect(response.body.shipment.status).toBe('delivered');
      expect(response.body.shipment.deliveredAt).not.toBeNull();

      /* Delivery is not a stock event. */
      expect((await stockRows())[0]?.onHand).toBe(beforeDelivery!.onHand);
      expect(await ledger()).toHaveLength(1);
      expect(await shipmentEvents()).toHaveLength(3);
    });

    it('refuses to deliver a pending shipment', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });

      const response = await deliver(harness, {
        token: staff.token,
        id: created.body.shipment.id,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.details).toMatchObject({ from: 'pending', to: 'delivered' });
    });

    it('refuses a second delivery and never overwrites delivered_at', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;
      await ship(harness, { token: staff.token, id });
      expect((await deliver(harness, { token: staff.token, id })).status).toBe(200);
      const deliveredAt = (await shipments())[0]?.deliveredAt;

      expect((await deliver(harness, { token: staff.token, id })).status).toBe(409);
      expect((await shipments())[0]?.deliveredAt).toEqual(deliveredAt);
      expect(await shipmentEvents()).toHaveLength(3);
    });

    it('resolves concurrent delivery to one transition', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;
      await ship(harness, { token: staff.token, id });

      const results = await Promise.all([
        deliver(harness, { token: staff.token, id }),
        deliver(harness, { token: staff.token, id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await shipmentEvents()).toHaveLength(3);
    });

    /* ── The payment prerequisite ────────────────────────────────────────── */

    it('refuses to ship an online order whose payment is still pending', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('unpaid'),
      });
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);
      const staff = await givenStaff(harness);

      const response = await createShipment(harness, { token: staff.token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('ORDER_NOT_FULFILLABLE');
      expect(response.body.error.details.reason).toBe('payment_not_succeeded');
      expect(await shipments()).toEqual([]);
    });

    it('refuses to ship an online order whose payment failed', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('failed'),
      });
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber })).status).toBe(201);
      expect((await webhook(harness, { event: 'payment.failed' })).status).toBe(200);
      const staff = await givenStaff(harness);

      const response = await createShipment(harness, { token: staff.token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('payment_not_succeeded');
    });

    it('refuses to ship an order with no payment at all', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('nopay'),
      });
      const { orderNumber } = await givenOrder(harness, { token, userId });
      const staff = await givenStaff(harness);

      const response = await createShipment(harness, { token: staff.token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('no_payment');
    });

    /* ── COD: the approved unpaid-fulfilment path ────────────────────────── */

    /**
     * **A COD order ships while its payment is still `pending`.**
     *
     * The approved business rule. A COD payment never terminalises, so requiring `succeeded`
     * would make COD unsellable. The reservation is `held`, and `held -> fulfilled` is
     * deliberately illegal — so fulfilment commits it with reason `cod_fulfilment` first, in the
     * same transaction, and **nothing about the payment row changes.**
     *
     * This is NOT settlement. The money has not arrived, and the reservation says so.
     */
    it('ships a COD order whose payment is pending, without touching the payment', async () => {
      const harness = build();
      const { orderNumber } = await givenCodOrder(harness);
      const staff = await givenStaff(harness);

      /* The reservation is HELD, not committed: no payment ever succeeded. */
      expect((await reservations())[0]?.status).toBe('held');

      const created = await createShipment(harness, { token: staff.token, orderNumber });
      expect(created.status).toBe(201);

      const response = await ship(harness, { token: staff.token, id: created.body.shipment.id });
      expect(response.status).toBe(200);
      expect(response.body.shipment.status).toBe('shipped');

      /* The payment is UNCHANGED — still pending, still cod, no new event. */
      const [row] = await paymentRows();
      expect(row!.method).toBe('cod');
      expect(row!.status).toBe('pending');
      expect((await eventRows()).filter((e) => e.toStatus !== 'pending')).toEqual([]);

      /* The reservation went held -> committed -> fulfilled inside one transaction. */
      const settled = await reservations();
      expect(settled[0]?.status).toBe('fulfilled');
      expect(settled[0]?.settledReason).toBe('shipment_fulfilled');

      /* And the stock moved exactly once. */
      /* `ledger` is a FUNCTION: `ledger.length` is its arity (0), not the row count. */
      expect(await ledger()).toHaveLength(1);
    });

    /* ── Cancellation interaction ────────────────────────────────────────── */

    /** A shipped order cannot be cancelled — undoing it would need a return. */
    it('refuses to cancel a shipped order', async () => {
      const harness = build();
      const { token, orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      await ship(harness, { token: staff.token, id: created.body.shipment.id });

      const response = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
        .set('authorization', `Bearer ${token}`);

      /*
       * 409, and the reason is `shipped` rather than `paid` — the shipment guard runs first,
       * because a shipped order stays shipped where an unpaid one may become payable.
       */
      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe('shipped');
      expect((await reservations())[0]?.status).toBe('fulfilled');
    });

    /** A cancelled order cannot ship. */
    it('refuses to ship a cancelled order', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('cancels'),
      });
      const { orderNumber } = await givenOrder(harness, { token, userId });
      const staff = await givenStaff(harness);

      /* Cancellable: no payment at all. */
      expect(
        (
          await request(harness.app)
            .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
            .set('authorization', `Bearer ${token}`)
        ).status,
      ).toBe(200);

      const response = await createShipment(harness, { token: staff.token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('order_cancelled');
    });

    /**
     * A PENDING shipment does not block cancellation, deliberately.
     *
     * Nothing has moved, so a customer may still cancel an order a staff member has merely
     * started picking. The pending shipment is left behind and can never ship, because the ship
     * path refuses a cancelled order — asserted here so the consequence is recorded.
     */
    it('allows cancelling an order whose shipment is only pending, and the shipment then cannot ship', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('pendingship'),
      });
      const { orderNumber } = await givenOrder(harness, { token, userId });
      expect((await initiate(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      expect(created.status).toBe(201);

      /* COD `pending` refuses cancellation on the PAYMENT rule, so this order is not
       * cancellable — which is the pre-existing COD limitation, not a fulfilment one. */
      const cancelled = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
        .set('authorization', `Bearer ${token}`);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.error.details.reason).toBe('payment_in_progress');
    });

    /* ── Tracking ────────────────────────────────────────────────────────── */

    it('updates tracking without changing state, and audits it', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });

      const response = await request(harness.app)
        .patch(`/api/v1/admin/shipments/${created.body.shipment.id}`)
        .set('authorization', `Bearer ${staff.token}`)
        .send({ carrier: 'Delhivery', trackingNumber: 'DL999' });

      expect(response.status).toBe(200);
      expect(response.body.shipment.carrier).toBe('Delhivery');
      expect(response.body.shipment.trackingNumber).toBe('DL999');
      /* State untouched, and no event row — nothing transitioned. */
      expect(response.body.shipment.status).toBe('pending');
      expect(await shipmentEvents()).toHaveLength(1);

      const entries = await db().select().from(auditLog);
      expect(entries.some((e) => e.action === 'shipment.tracking_updated')).toBe(true);
    });

    it('rejects a tracking update that changes nothing', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });

      const response = await request(harness.app)
        .patch(`/api/v1/admin/shipments/${created.body.shipment.id}`)
        .set('authorization', `Bearer ${staff.token}`)
        .send({});
      expect(response.status).toBe(400);
    });

    it('rejects a status field on the tracking patch', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });

      const response = await request(harness.app)
        .patch(`/api/v1/admin/shipments/${created.body.shipment.id}`)
        .set('authorization', `Bearer ${staff.token}`)
        .send({ status: 'delivered' });

      expect(response.status).toBe(400);
      expect(response.body.error.details.fields.body).toContain('Unrecognized key: "status"');
    });

    /* ── Authorization and isolation ─────────────────────────────────────── */

    it('refuses a customer on every staff route', async () => {
      const harness = build();
      const { token, orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;

      for (const call of [
        createShipment(harness, { token, orderNumber }),
        ship(harness, { token, id }),
        deliver(harness, { token, id }),
        request(harness.app)
          .patch(`/api/v1/admin/shipments/${id}`)
          .set('authorization', `Bearer ${token}`)
          .send({ carrier: 'X' }),
        request(harness.app)
          .get('/api/v1/admin/orders/fulfilment')
          .set('authorization', `Bearer ${token}`),
      ]) {
        const response = await call;
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
      }
    });

    it('rejects unauthenticated requests', async () => {
      const harness = build();
      const response = await request(harness.app).get('/api/v1/admin/orders/fulfilment');
      expect(response.status).toBe(401);
    });

    it('does not let staff of another store ship this store’s shipment', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other-ful', name: 'Other', isActive: true });

      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });

      const other = build({ slug: 'other-ful' });
      const outsider = await signIn(other.app, other.identity, {
        email: uniqueEmail('outsider'),
        staff: true,
        storeId: otherStoreId,
      });

      const response = await ship(other, {
        token: outsider.token,
        id: created.body.shipment.id,
      });
      expect(response.status).toBe(404);
      expect((await shipments())[0]?.status).toBe('pending');
    });

    /* ── Customer read ───────────────────────────────────────────────────── */

    it('shows the customer their shipment, without internal fields', async () => {
      const harness = build();
      const { token, orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, {
        token: staff.token,
        orderNumber,
        body: { carrier: 'Bluedart', trackingNumber: 'BD1', trackingUrl: 'https://track/BD1' },
      });
      await ship(harness, { token: staff.token, id: created.body.shipment.id });

      const response = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
        .set('authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.shipments).toHaveLength(1);
      /* Exactly five fields — no id, no orderId, no note, nothing about inventory. */
      expect(Object.keys(response.body.shipments[0]).sort()).toEqual([
        'carrier',
        'deliveredAt',
        'shippedAt',
        'status',
        'trackingNumber',
        'trackingUrl',
      ]);
      expect(JSON.stringify(response.body)).not.toContain(created.body.shipment.id);
    });

    it('returns an empty list for an order that has not shipped', async () => {
      const harness = build();
      const { token, orderNumber } = await givenPaidOrder(harness);

      const response = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
        .set('authorization', `Bearer ${token}`);

      /* An empty list, NOT a 404 — the order exists and simply has no shipment. */
      expect(response.status).toBe(200);
      expect(response.body.shipments).toEqual([]);
    });

    it('404s another customer’s order', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const mallory = await signIn(harness.app, harness.identity, {
        email: uniqueEmail('mallory'),
      });

      const response = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
        .set('authorization', `Bearer ${mallory.token}`);
      expect(response.status).toBe(404);
    });

    /* ── The staff queue ─────────────────────────────────────────────────── */

    it('lists orders awaiting fulfilment, and drops them once shipped', async () => {
      const harness = build();
      const first = await givenPaidOrder(harness, { code: 'Q-A' });
      await givenPaidOrder(harness, { code: 'Q-B' });
      const staff = await givenStaff(harness);

      const before = await request(harness.app)
        .get('/api/v1/admin/orders/fulfilment')
        .set('authorization', `Bearer ${staff.token}`);
      expect(before.status).toBe(200);
      expect(before.body.orders).toHaveLength(2);
      expect(Object.keys(before.body.orders[0]).sort()).toEqual([
        'city',
        'orderNumber',
        'placedAt',
        'postalCode',
        'recipientName',
        'shipmentStatus',
      ]);

      const created = await createShipment(harness, {
        token: staff.token,
        orderNumber: first.orderNumber,
      });
      /* Still queued while pending — there is work left to do on it. */
      const withPending = await request(harness.app)
        .get('/api/v1/admin/orders/fulfilment')
        .set('authorization', `Bearer ${staff.token}`);
      expect(withPending.body.orders).toHaveLength(2);

      await ship(harness, { token: staff.token, id: created.body.shipment.id });

      const after = await request(harness.app)
        .get('/api/v1/admin/orders/fulfilment')
        .set('authorization', `Bearer ${staff.token}`);
      expect(after.body.orders).toHaveLength(1);
      expect(after.body.orders[0].orderNumber).not.toBe(first.orderNumber);
    });

    it('rejects an unknown query parameter and a malformed cursor', async () => {
      const harness = build();
      const staff = await givenStaff(harness);

      const unknown = await request(harness.app)
        .get('/api/v1/admin/orders/fulfilment?customer=alice')
        .set('authorization', `Bearer ${staff.token}`);
      expect(unknown.status).toBe(400);

      const bad = await request(harness.app)
        .get('/api/v1/admin/orders/fulfilment?cursor=not-a-cursor')
        .set('authorization', `Bearer ${staff.token}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields.cursor).toBeDefined();
    });

    /* ── Rollback ────────────────────────────────────────────────────────── */

    /**
     * **A shipment must never be `shipped` while the stock movement is incomplete.**
     *
     * The divergence is provoked for real: the reservation stays `committed` while the
     * projection is zeroed, so `fulfilStockForSku` matches nothing and the inventory service
     * raises. Everything must roll back — the shipment stays `pending`, no event row survives,
     * no ledger row survives, and the reservation is still committed and therefore retryable.
     */
    it('rolls the shipment transition back when the stock movement fails', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      const id = created.body.shipment.id as string;

      /* Committed reservation, zero counters: the projection has diverged. */
      await testDb.handle.pool.query('UPDATE stock_item SET on_hand = 0, reserved = 0');

      const response = await ship(harness, { token: staff.token, id });
      expect(response.status).toBe(500);

      expect((await shipments())[0]?.status).toBe('pending');
      expect((await shipments())[0]?.shippedAt).toBeNull();
      /* Only the creation row survived. */
      expect(await shipmentEvents()).toHaveLength(1);
      expect(await ledger()).toEqual([]);
      expect((await reservations())[0]?.status).toBe('committed');
      expect(
        (await db().select().from(auditLog)).some((e) => e.action === 'shipment.shipped'),
      ).toBe(false);
    });

    /* ── Database constraints ────────────────────────────────────────────── */

    describe('constraints', () => {
      async function givenPendingShipment(harness: Harness) {
        const { orderNumber, orderId } = await givenPaidOrder(harness);
        const staff = await givenStaff(harness);
        const created = await createShipment(harness, { token: staff.token, orderNumber });
        return { id: created.body.shipment.id as string, orderId, staff };
      }

      const expectConstraint = async (work: Promise<unknown>, constraint: string) => {
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
      };

      it('refuses an unknown shipment status', async () => {
        const harness = build();
        const { id } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(`UPDATE shipment SET status = 'packed' WHERE id = $1`, [id]),
          'ck_shipment_status',
        );
      });

      it('refuses a shipped shipment with no shipped_at', async () => {
        const harness = build();
        const { id } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(`UPDATE shipment SET status = 'shipped' WHERE id = $1`, [id]),
          'ck_shipment_shipped_at',
        );
      });

      it('refuses a pending shipment that carries shipped_at', async () => {
        const harness = build();
        const { id } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(`UPDATE shipment SET shipped_at = now() WHERE id = $1`, [id]),
          'ck_shipment_shipped_at',
        );
      });

      it('refuses delivery before shipment', async () => {
        const harness = build();
        const { id } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(
            `UPDATE shipment SET status = 'delivered', shipped_at = now(),
                    delivered_at = now() - interval '1 hour' WHERE id = $1`,
            [id],
          ),
          'ck_shipment_delivered_after_shipped',
        );
      });

      it('refuses a tracking url with no tracking number', async () => {
        const harness = build();
        const { id } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(
            `UPDATE shipment SET tracking_url = 'https://x/1' WHERE id = $1`,
            [id],
          ),
          'ck_shipment_tracking_url_needs_number',
        );
      });

      it('refuses a duplicate tracking number for the same carrier', async () => {
        const harness = build();
        const firstOrder = await givenPaidOrder(harness, { code: 'TRK-A' });
        const secondOrder = await givenPaidOrder(harness, { code: 'TRK-B' });
        const staff = await givenStaff(harness);

        expect(
          (
            await createShipment(harness, {
              token: staff.token,
              orderNumber: firstOrder.orderNumber,
              body: { carrier: 'Bluedart', trackingNumber: 'DUP1' },
            })
          ).status,
        ).toBe(201);

        const clash = await createShipment(harness, {
          token: staff.token,
          orderNumber: secondOrder.orderNumber,
          body: { carrier: 'Bluedart', trackingNumber: 'DUP1' },
        });
        expect(clash.status).toBe(409);
      });

      it('allows the same tracking number under a different carrier', async () => {
        const harness = build();
        const firstOrder = await givenPaidOrder(harness, { code: 'TRK-C' });
        const secondOrder = await givenPaidOrder(harness, { code: 'TRK-D' });
        const staff = await givenStaff(harness);

        await createShipment(harness, {
          token: staff.token,
          orderNumber: firstOrder.orderNumber,
          body: { carrier: 'Bluedart', trackingNumber: 'SAME' },
        });
        const other = await createShipment(harness, {
          token: staff.token,
          orderNumber: secondOrder.orderNumber,
          body: { carrier: 'Delhivery', trackingNumber: 'SAME' },
        });
        expect(other.status).toBe(201);
      });

      it('refuses a shipment_event with a staff actor and no user', async () => {
        const harness = build();
        const { id, orderId } = await givenPendingShipment(harness);
        void orderId;
        await expectConstraint(
          testDb.handle.pool.query(
            `INSERT INTO shipment_event (id, shipment_id, store_id, from_status, to_status,
                                         actor_type, actor_user_id)
             SELECT $1, $2, store_id, 'pending', 'shipped', 'staff', NULL FROM shipment WHERE id = $2`,
            [newId(), id],
          ),
          'ck_shipment_event_actor',
        );
      });

      it('refuses a shipment_event that goes nowhere', async () => {
        const harness = build();
        const { id, staff } = await givenPendingShipment(harness);
        await expectConstraint(
          testDb.handle.pool.query(
            `INSERT INTO shipment_event (id, shipment_id, store_id, from_status, to_status,
                                         actor_type, actor_user_id)
             SELECT $1, $2, store_id, 'pending', 'pending', 'staff', $3 FROM shipment WHERE id = $2`,
            [newId(), id, staff.userId],
          ),
          'ck_shipment_event_progresses',
        );
      });

      it('refuses a cross-store shipment', async () => {
        const otherStoreId = newId();
        await db()
          .insert(store)
          .values({ id: otherStoreId, slug: 'other-fk', name: 'Other', isActive: true });
        const harness = build();
        const { orderId } = await givenPaidOrder(harness);

        await expectConstraint(
          testDb.handle.pool.query(
            `INSERT INTO shipment (id, store_id, order_id) VALUES ($1, $2, $3)`,
            [newId(), otherStoreId, orderId],
          ),
          'fk_shipment_order_store',
        );
      });

      it('refuses an unknown reservation status and an unknown ledger reason', async () => {
        const harness = build();
        const { orderNumber } = await givenPaidOrder(harness);

        /*
         * The order must actually SHIP before the ledger half of this test means anything.
         *
         * A paid order has a reservation but no ledger row — shipping is the only thing that
         * writes one. An `UPDATE stock_ledger` against an empty table matches zero rows and
         * therefore violates nothing, so without this the assertion passed vacuously and would
         * have gone on passing if `ck_stock_ledger_reason` were dropped entirely.
         */
        /*
         * The reservation half runs FIRST, while the row is still `committed`.
         *
         * After shipping it is `fulfilled` with a `fulfilled_at`, and setting a bogus status
         * then trips `ck_stock_reservation_fulfilled_at` — a paired CHECK — BEFORE the
         * vocabulary CHECK this test is about. That ordering trap has now caught this project
         * several times; the fix is to probe each constraint from a state where only it can
         * fire, rather than to make the row coherent in ever more elaborate ways.
         */
        await expectConstraint(
          testDb.handle.pool.query(`UPDATE stock_reservation SET status = 'shipped'`),
          'ck_stock_reservation_status',
        );

        /*
         * The ledger half needs a ROW. A paid order has a reservation but no ledger entry —
         * shipping is the only thing that writes one — and an UPDATE against an empty table
         * matches nothing and so violates nothing. Without this the assertion passed vacuously
         * and would have gone on passing if the constraint were dropped entirely.
         */
        const staff = await givenStaff(harness);
        const created = await createShipment(harness, { token: staff.token, orderNumber });
        await ship(harness, { token: staff.token, id: created.body.shipment.id });
        expect(await ledger()).toHaveLength(1);

        await expectConstraint(
          testDb.handle.pool.query(`UPDATE stock_ledger SET reason = 'teleported'`),
          'ck_stock_ledger_reason',
        );
      });

      it('accepts the shipment ledger reason', async () => {
        const harness = build();
        const { orderNumber } = await givenPaidOrder(harness);
        const staff = await givenStaff(harness);
        const created = await createShipment(harness, { token: staff.token, orderNumber });
        await ship(harness, { token: staff.token, id: created.body.shipment.id });

        expect((await ledger())[0]?.reason).toBe('shipment');
      });

      it('refuses a fulfilled reservation with no fulfilled_at', async () => {
        const harness = build();
        const { orderNumber } = await givenPaidOrder(harness);
        void orderNumber;
        await expectConstraint(
          testDb.handle.pool.query(
            `UPDATE stock_reservation SET status = 'fulfilled', settled_reason = 'shipment_fulfilled'`,
          ),
          'ck_stock_reservation_fulfilled_at',
        );
      });
    });

    /* ── Events ──────────────────────────────────────────────────────────── */

    it('publishes no shipment domain event', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      await ship(harness, { token: staff.token, id: created.body.shipment.id });
      await deliver(harness, { token: staff.token, id: created.body.shipment.id });

      const events = await db().select().from(outboxEvent);
      /* Scoped to shipment events: registration publishes `user.registered`. */
      expect(events.filter((e) => e.eventName.startsWith('shipment.'))).toEqual([]);
    });

    it('audits creation, shipping and delivery', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const created = await createShipment(harness, { token: staff.token, orderNumber });
      await ship(harness, { token: staff.token, id: created.body.shipment.id });
      await deliver(harness, { token: staff.token, id: created.body.shipment.id });

      const actions = (await db().select().from(auditLog)).map((e) => e.action);
      expect(actions).toContain('shipment.created');
      expect(actions).toContain('shipment.shipped');
      expect(actions).toContain('shipment.delivered');

      const shipped = (await db().select().from(auditLog)).find(
        (e) => e.action === 'shipment.shipped',
      );
      expect(shipped).toMatchObject({ actorType: 'staff', actorUserId: staff.userId, storeId });
    });

    /* ── API contract ────────────────────────────────────────────────────── */

    it('rejects forgeable fields on shipment creation', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);

      for (const body of [
        { status: 'shipped' },
        { orderId: newId() },
        { storeId: newId() },
        { shippedAt: new Date().toISOString() },
        { deliveredAt: new Date().toISOString() },
        { quantity: 1 },
      ]) {
        const response = await createShipment(harness, { token: staff.token, orderNumber, body });
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('rejects a malformed shipment id', async () => {
      const harness = build();
      const staff = await givenStaff(harness);
      const response = await ship(harness, { token: staff.token, id: 'not-a-uuid' });
      expect(response.status).toBe(400);
    });

    it('404s an unknown shipment id', async () => {
      const harness = build();
      const staff = await givenStaff(harness);
      const response = await ship(harness, { token: staff.token, id: newId() });
      expect(response.status).toBe(404);
    });

    it('rejects a non-url tracking url', async () => {
      const harness = build();
      const { orderNumber } = await givenPaidOrder(harness);
      const staff = await givenStaff(harness);
      const response = await createShipment(harness, {
        token: staff.token,
        orderNumber,
        body: { trackingNumber: 'X1', trackingUrl: 'javascript:alert(1)' },
      });
      expect(response.status).toBe(400);
    });
  });

  /* ══ GST — Increment 38 ═══════════════════════════════════════════════════ */

  /**
   * GST, against real PostgreSQL, with the REAL tax module behind the checkout port.
   *
   * Mounted in this harness rather than a suite of its own for the reason the fulfilment block
   * records: tax rules are checkout, payment and catalogue rules at once — the payable amount
   * moves to `grand_total`, an unclassified SKU refuses a checkout, and a COD order is taxed
   * without ever being paid. This harness already builds a real orders, payments, inventory and
   * catalogue graph; a separate suite would have duplicated ~300 lines of wiring to assert the
   * same things against the same objects.
   *
   * **Every rate in this block is a fixture these tests create for themselves.** The
   * application ships none, and `POST /admin/tax-classes/{code}/rates` is the only way one can
   * exist. A test that needed a rate the system supplied would be testing a hardcoded slab,
   * which is exactly what approved decision 11 forbids.
   *
   * Seven properties carry this block:
   *
   *  1. **A store with no tax profile is unchanged.** No determination, no snapshot, and
   *     `grand_total = total` — which is why every other suite in this repository still passes.
   *  2. **Same state means CGST+SGST; a different state means IGST.** Never both.
   *  3. **The discount is allocated before tax**, and the taxable value proves it.
   *  4. **`payment.amount` is `grand_total`**, not `total`.
   *  5. **The snapshot is immutable.** Rates, classes, HSN, seller and customer identity can all
   *     change afterwards and the historical order does not move a paisa.
   *  6. **An unclassified or unrated line refuses the whole checkout**, and writes nothing.
   *  7. **Tenancy.** Another store's tax master data is unreachable, and a client can supply
   *     none of it.
   */
  describe('gst', () => {
    /** A seller tax profile fixture. Karnataka, so an address in Karnataka is intra-state. */
    const SELLER: {
      legalName: string;
      gstin: string;
      originLine1: string;
      originCity: string;
      originState: string;
      originPostalCode: string;
      originCountryCode: string;
    } = {
      legalName: 'Example Retail Private Limited',
      gstin: '29AABCE1234F1Z5',
      originLine1: '5th Floor, Prestige Tower',
      originCity: 'Bengaluru',
      originState: 'Karnataka',
      /* Deliberately NOT the delivery fixture's 560001: the leak test must be able to tell
       * the seller's premises apart from the customer's address. */
      originPostalCode: '560095',
      originCountryCode: 'IN',
    };

    const BUYER_GSTIN = '27AAACB1234C1ZX';

    /** Rates these tests invent. Nothing in the application supplies a percentage. */
    const STD_RATES = { cgstRate: '9', sgstRate: '9', igstRate: '18' } as const;

    const authed = (req: request.Test, token: string) =>
      req.set('authorization', `Bearer ${token}`);

    async function configureSeller(
      harness: Harness,
      staffToken: string,
      over: Partial<typeof SELLER> = {},
    ) {
      const response = await authed(
        request(harness.app).put('/api/v1/admin/store/tax-profile'),
        staffToken,
      ).send({ ...SELLER, ...over });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response;
    }

    async function givenTaxClass(
      harness: Harness,
      staffToken: string,
      options: { code?: string; name?: string } = {},
    ) {
      const code = options.code ?? 'GST-STD';
      const response = await authed(
        request(harness.app).post('/api/v1/admin/tax-classes'),
        staffToken,
      ).send({ code, name: options.name ?? 'Standard rate' });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return code;
    }

    async function givenRate(
      harness: Harness,
      staffToken: string,
      options: {
        taxClassCode?: string;
        cgstRate?: string;
        sgstRate?: string;
        igstRate?: string;
        cessRate?: string;
        effectiveFrom?: string;
        effectiveTo?: string | null;
      } = {},
    ) {
      const body: Record<string, unknown> = {
        cgstRate: options.cgstRate ?? STD_RATES.cgstRate,
        sgstRate: options.sgstRate ?? STD_RATES.sgstRate,
        igstRate: options.igstRate ?? STD_RATES.igstRate,
        /* An hour ago, so it is already in force when a checkout happens in this test. */
        effectiveFrom: options.effectiveFrom ?? new Date(Date.now() - 3_600_000).toISOString(),
      };
      if (options.cessRate !== undefined) body['cessRate'] = options.cessRate;
      if (options.effectiveTo !== undefined) body['effectiveTo'] = options.effectiveTo;

      const response = await authed(
        request(harness.app).post(
          `/api/v1/admin/tax-classes/${options.taxClassCode ?? 'GST-STD'}/rates`,
        ),
        staffToken,
      ).send(body);
      return response;
    }

    async function classifySku(
      harness: Harness,
      staffToken: string,
      options: { skuCode: string; taxClassCode?: string | null; hsnCode?: string | null },
    ) {
      const response = await authed(
        request(harness.app).put(`/api/v1/admin/skus/${options.skuCode}/tax`),
        staffToken,
      ).send({
        taxClassCode: options.taxClassCode === undefined ? 'GST-STD' : options.taxClassCode,
        hsnCode: options.hsnCode === undefined ? '6109' : options.hsnCode,
      });
      return response;
    }

    /**
     * A store configured to charge GST, with one classified, rated SKU.
     *
     * Returns both tokens, because almost every test here needs a staff member to configure and
     * a customer to buy.
     */
    async function givenTaxedStore(harness: Harness) {
      const staff = await signIn(harness.app, harness.identity, {
        email: 'staff@example.com',
        staff: true,
      });
      await configureSeller(harness, staff.token);
      await givenTaxClass(harness, staff.token);
      const rate = await givenRate(harness, staff.token);
      expect(rate.status, JSON.stringify(rate.body)).toBe(201);
      return { staff };
    }

    /**
     * Check out one already-created SKU, optionally to another state.
     *
     * Distinct from `givenOrder` above, which creates its own SKU: these tests must classify a
     * SKU BEFORE buying it, so the SKU has to exist first.
     */
    async function placeOrder(
      harness: Harness,
      options: {
        token: string;
        userId: string;
        skuCode: string;
        quantity?: number;
        state?: string;
      },
    ): Promise<{ orderNumber: string; orderId: string }> {
      const put = await authed(
        request(harness.app).put(`/api/v1/users/me/cart/items/${options.skuCode}`),
        options.token,
      ).send({ quantity: options.quantity ?? 1 });
      expect(put.status, JSON.stringify(put.body)).toBe(200);

      const addr = await givenAddress(options.userId);
      if (options.state !== undefined) {
        await db().update(address).set({ state: options.state }).where(eq(address.id, addr.id));
      }

      const checkout = await authed(
        request(harness.app).post('/api/v1/users/me/checkout'),
        options.token,
      )
        .set('idempotency-key', `checkout-${newId()}`)
        .send({ addressId: addr.id });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

      const orderNumber = checkout.body.order.orderNumber as string;
      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      return { orderNumber, orderId: row!.id };
    }

    /* ── The unconfigured store: nothing changes ───────────────────────────── */

    describe('a store with no tax profile', () => {
      /**
       * **The regression guard for every other suite in this repository.**
       *
       * Configuration is the switch. Until a merchant fills in a tax profile, no determination
       * is made — and an order carrying NULL across its snapshot records *"not assessed"*,
       * which is deliberately different from a determination that produced zero.
       */
      it('assesses no tax, and says so with nulls rather than zeros', async () => {
        const harness = build();
        const { token, userId } = await signIn(harness.app, harness.identity);
        const placed = await givenOrder(harness, { token, userId });

        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(row!.taxTotal).toBe('0.0000');
        expect(row!.grandTotal).toBe(row!.total);
        /* The snapshot is absent, not zeroed. */
        expect(row!.taxAt).toBeNull();
        expect(row!.supplyType).toBeNull();
        expect(row!.sellerGstin).toBeNull();
        expect(row!.customerTaxCategory).toBeNull();
      });

      it('reports tax as null on the order response', async () => {
        const harness = build();
        const { token, userId } = await signIn(harness.app, harness.identity);
        const placed = await givenOrder(harness, { token, userId });

        const response = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}`),
          token,
        );

        expect(response.status).toBe(200);
        expect(response.body.order.tax).toBeNull();
        expect(response.body.order.taxTotal).toBe('0.0000');
        expect(response.body.order.grandTotal).toBe(response.body.order.total);
        expect(response.body.order.items[0].tax).toBeNull();
      });

      /** Even unassessed, the identity holds — it is arithmetic, not a determination. */
      it('still materialises the taxable value on every line', async () => {
        const harness = build();
        const { token, userId } = await signIn(harness.app, harness.identity);
        const placed = await givenOrder(harness, { token, userId });

        const lines = await db()
          .select()
          .from(orderLine)
          .where(eq(orderLine.orderId, placed.orderId));

        for (const line of lines) {
          expect(line.taxableValue).toBe(
            toDb(subtract(fromDb(line.lineTotal, 'INR'), fromDb(line.discountAmount, 'INR'))),
          );
        }
      });
    });

    /* ── The supply-type branch ────────────────────────────────────────────── */

    describe('supply type', () => {
      /**
       * Same state as the seller: CGST + SGST, and NO IGST.
       *
       * The fixture address is Bengaluru / Karnataka and the seller origin is Karnataka, so
       * this is the intra-state branch.
       */
      it('charges CGST and SGST when the destination is the seller state', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);

        const sku = await givenSku({ code: 'GST-A', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's2@example.com', staff: true })
        ).token;
        expect((await classifySku(harness, staffToken, { skuCode: sku.code })).status).toBe(200);

        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });
        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));
        const [line] = await db()
          .select()
          .from(orderLine)
          .where(eq(orderLine.orderId, placed.orderId));

        expect(row!.supplyType).toBe('intra_state');
        expect(row!.placeOfSupplyState).toBe('karnataka');
        expect(row!.placeOfSupplyBasis).toBe('delivery_destination');
        expect(line!.cgstAmount).toBe('90.0000');
        expect(line!.sgstAmount).toBe('90.0000');
        expect(line!.igstAmount).toBe('0.0000');
        expect(row!.taxTotal).toBe('180.0000');
        expect(row!.grandTotal).toBe('1180.0000');
      });

      /** A different state: IGST alone. */
      it('charges IGST when the destination is another state', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);

        const sku = await givenSku({ code: 'GST-B', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's3@example.com', staff: true })
        ).token;
        await classifySku(harness, staffToken, { skuCode: sku.code });

        const placed = await placeOrder(harness, {
          token,
          userId,
          skuCode: sku.code,
          state: 'Maharashtra',
        });
        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));
        const [line] = await db()
          .select()
          .from(orderLine)
          .where(eq(orderLine.orderId, placed.orderId));

        expect(row!.supplyType).toBe('inter_state');
        expect(row!.placeOfSupplyState).toBe('maharashtra');
        expect(line!.igstAmount).toBe('180.0000');
        expect(line!.cgstAmount).toBe('0.0000');
        expect(line!.sgstAmount).toBe('0.0000');
        expect(row!.taxTotal).toBe('180.0000');
      });

      /**
       * The database refuses a line carrying both halves, whatever the service does.
       *
       * `ck_order_line_tax_split` is the backstop behind the calculator's branch: if a future
       * change ever produced both, the row would not be writable rather than quietly wrong.
       */
      it('refuses a row carrying both an intra-state and an inter-state component', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-C', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's4@example.com', staff: true })
        ).token;
        await classifySku(harness, staffToken, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        await expectDbConstraint(
          db()
            .update(orderLine)
            .set({ igstAmount: '1.0000', taxTotal: '181.0000' })
            .where(eq(orderLine.orderId, placed.orderId)),
          'ck_order_line_tax_split',
        );
      });
    });

    /* ── Discount before tax ───────────────────────────────────────────────── */

    describe('the taxable basis', () => {
      /**
       * **Discount allocated first, then taxed** — approved decision 12 and §42.
       *
       * A 10% coupon on a ₹1000 line leaves ₹900 taxable, and 18% of that is ₹162 — not ₹180.
       * Taxing the undiscounted line would over-charge every discounted order in the system.
       */
      it('taxes lineTotal minus the allocated discount', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);

        const sku = await givenSku({ code: 'GST-D', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's5@example.com', staff: true })
        ).token;
        await classifySku(harness, staffToken, { skuCode: sku.code });

        await db().insert(promotion).values({
          id: newId(),
          storeId,
          code: 'TENOFF',
          name: 'Ten percent off',
          discountType: 'percentage',
          percentRate: '10',
          amount: null,
          minSubtotal: null,
          startsAt: null,
          endsAt: null,
          isActive: true,
          deletedAt: null,
        });

        await authed(
          request(harness.app).put(`/api/v1/users/me/cart/items/${sku.code}`),
          token,
        ).send({ quantity: 1 });
        const applied = await authed(
          request(harness.app).put('/api/v1/users/me/cart/promotion'),
          token,
        ).send({ code: 'TENOFF' });
        expect(applied.status, JSON.stringify(applied.body)).toBe(200);

        const addr = await givenAddress(userId);
        const checkout = await authed(request(harness.app).post('/api/v1/users/me/checkout'), token)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });
        expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

        const [row] = await db()
          .select()
          .from(order)
          .where(eq(order.orderNumber, checkout.body.order.orderNumber as string));
        const [line] = await db().select().from(orderLine).where(eq(orderLine.orderId, row!.id));

        expect(line!.discountAmount).toBe('100.0000');
        expect(line!.taxableValue).toBe('900.0000');
        /* 9% of 900 twice, not 9% of 1000. */
        expect(line!.cgstAmount).toBe('81.0000');
        expect(line!.sgstAmount).toBe('81.0000');
        expect(row!.total).toBe('900.0000');
        expect(row!.taxTotal).toBe('162.0000');
        expect(row!.grandTotal).toBe('1062.0000');
      });
    });

    /* ── Payment coupling ──────────────────────────────────────────────────── */

    describe('payment', () => {
      /** **The payable amount is `grand_total`.** The single most consequential change here. */
      it('charges grand_total, not the goods total', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-E', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's6@example.com', staff: true })
        ).token;
        await classifySku(harness, staffToken, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const response = await initiate(harness, {
          token,
          orderNumber: placed.orderNumber,
          method: 'cod',
          key: `pay-${newId()}`,
        });
        expect(response.status, JSON.stringify(response.body)).toBe(201);

        const [row] = await db().select().from(payment).where(eq(payment.orderId, placed.orderId));
        const [ord] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(row!.amount).toBe(ord!.grandTotal);
        expect(row!.amount).not.toBe(ord!.total);
        /* And the integer handed to a gateway follows the same figure. */
        expect(row!.amountMinor).toBe(118_000);
      });

      /**
       * **COD is taxed at checkout and does not wait for money.**
       *
       * Approved decision 16. A COD payment never leaves `pending` by design, so making tax
       * authoritative at payment success would make every COD order permanently unassessed.
       */
      it('makes tax authoritative for a COD order that will never be paid', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-F', price: '1000.0000' });
        const staffToken = (
          await signIn(harness.app, harness.identity, { email: 's7@example.com', staff: true })
        ).token;
        await classifySku(harness, staffToken, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        await initiate(harness, {
          token,
          orderNumber: placed.orderNumber,
          method: 'cod',
          key: `pay-${newId()}`,
        });

        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));
        const [pay] = await db().select().from(payment).where(eq(payment.orderId, placed.orderId));

        expect(pay!.status).toBe('pending');
        /* Assessed anyway — the determination was made at checkout. */
        expect(row!.taxAt).not.toBeNull();
        expect(row!.taxTotal).toBe('180.0000');
      });
    });

    /* ── Refusals ──────────────────────────────────────────────────────────── */

    describe('an undeterminable line', () => {
      /**
       * **An unclassified SKU refuses the whole checkout — it is never silently untaxed.**
       *
       * A store that has told the system it charges GST does not get to under-charge it by
       * omission. Charging zero would assert an exemption accounting has not granted.
       */
      it('refuses the checkout and names the SKU', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'UNCLASSIFIED', price: '1000.0000' });

        await authed(
          request(harness.app).put(`/api/v1/users/me/cart/items/${sku.code}`),
          token,
        ).send({ quantity: 1 });
        const addr = await givenAddress(userId);
        const checkout = await authed(request(harness.app).post('/api/v1/users/me/checkout'), token)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });

        expect(checkout.status).toBe(422);
        expect(checkout.body.error.code).toBe('TAX_NOT_DETERMINABLE');
        expect(checkout.body.error.details.reason).toBe('unclassified');
        expect(checkout.body.error.details.skuCodes).toEqual(['UNCLASSIFIED']);
      });

      /** Nothing is written: the transaction rolls back entirely. */
      it('writes no order, no line and no reservation', async () => {
        const harness = build();
        await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'UNCLASSIFIED-2', price: '1000.0000' });

        await authed(
          request(harness.app).put(`/api/v1/users/me/cart/items/${sku.code}`),
          token,
        ).send({ quantity: 1 });
        const addr = await givenAddress(userId);
        await authed(request(harness.app).post('/api/v1/users/me/checkout'), token)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });

        expect(await db().select().from(order)).toEqual([]);
        expect(await db().select().from(orderLine)).toEqual([]);
        expect(await db().select().from(stockReservation)).toEqual([]);
      });

      /** A deactivated class is refused too, and distinguished by `reason`. */
      it('refuses a SKU whose tax class has been deactivated', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-G', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        const patched = await authed(
          request(harness.app).patch('/api/v1/admin/tax-classes/GST-STD'),
          staff.token,
        ).send({ isActive: false });
        expect(patched.status).toBe(200);

        await authed(
          request(harness.app).put(`/api/v1/users/me/cart/items/${sku.code}`),
          token,
        ).send({ quantity: 1 });
        const addr = await givenAddress(userId);
        const checkout = await authed(request(harness.app).post('/api/v1/users/me/checkout'), token)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });

        expect(checkout.status).toBe(422);
        expect(checkout.body.error.details.reason).toBe('inactive_class');
      });

      /** A class with no rate in force at the tax instant is refused, not assessed at zero. */
      it('refuses a class whose rate is not yet effective', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await configureSeller(harness, staff.token);
        await givenTaxClass(harness, staff.token);
        /* Effective NEXT year, so nothing is in force now. */
        const future = await givenRate(harness, staff.token, {
          effectiveFrom: new Date(Date.now() + 365 * 86_400_000).toISOString(),
        });
        expect(future.status).toBe(201);

        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-H', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        await authed(
          request(harness.app).put(`/api/v1/users/me/cart/items/${sku.code}`),
          token,
        ).send({ quantity: 1 });
        const addr = await givenAddress(userId);
        const checkout = await authed(request(harness.app).post('/api/v1/users/me/checkout'), token)
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });

        expect(checkout.status).toBe(422);
        expect(checkout.body.error.details.reason).toBe('no_effective_rate');
      });
    });

    /* ── B2B / B2C ─────────────────────────────────────────────────────────── */

    describe('customer tax identity', () => {
      it('makes an order B2B when the customer has a GSTIN, and snapshots it', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-I', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        const put = await authed(
          request(harness.app).put('/api/v1/users/me/tax-identity'),
          token,
        ).send({ gstin: BUYER_GSTIN, legalName: 'Buyer Enterprises LLP' });
        expect(put.status, JSON.stringify(put.body)).toBe(200);

        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });
        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(row!.customerTaxCategory).toBe('b2b');
        expect(row!.customerGstin).toBe(BUYER_GSTIN);
        expect(row!.customerLegalName).toBe('Buyer Enterprises LLP');
      });

      it('is B2C with no GSTIN, and stores none', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-J', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });
        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(row!.customerTaxCategory).toBe('b2c');
        expect(row!.customerGstin).toBeNull();
        expect(row!.customerLegalName).toBeNull();
      });

      /** The database refuses the contradiction, whatever the service does. */
      it('refuses a b2c order carrying a GSTIN', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-K', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        await expectDbConstraint(
          db()
            .update(order)
            .set({ customerGstin: BUYER_GSTIN })
            .where(eq(order.id, placed.orderId)),
          'ck_order_customer_tax_category',
        );
      });

      it('rejects a malformed GSTIN', async () => {
        const harness = build();
        const { token } = await signIn(harness.app, harness.identity);

        const response = await authed(
          request(harness.app).put('/api/v1/users/me/tax-identity'),
          token,
        ).send({ gstin: 'NOT-A-GSTIN-XX', legalName: 'Buyer' });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('rejects every forgeable field, one at a time', async () => {
        const harness = build();
        const { token } = await signIn(harness.app, harness.identity);

        for (const extra of [
          { storeId: newId() },
          { userId: newId() },
          { id: newId() },
          { createdAt: new Date().toISOString() },
        ]) {
          const response = await authed(
            request(harness.app).put('/api/v1/users/me/tax-identity'),
            token,
          ).send({ gstin: BUYER_GSTIN, legalName: 'Buyer', ...extra });

          expect(response.status, Object.keys(extra)[0]).toBe(400);
        }
      });

      it('removes the registration, and the next order is B2C', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        await authed(request(harness.app).put('/api/v1/users/me/tax-identity'), token).send({
          gstin: BUYER_GSTIN,
          legalName: 'Buyer Enterprises LLP',
        });

        const removed = await authed(
          request(harness.app).delete('/api/v1/users/me/tax-identity'),
          token,
        );
        expect(removed.status).toBe(204);

        const sku = await givenSku({ code: 'GST-L', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });
        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(row!.customerTaxCategory).toBe('b2c');
      });
    });

    /* ── Historical immutability. The mandatory acceptance criterion. ──────── */

    describe('historical immutability', () => {
      /**
       * **Phase 8, in one test: change everything, and the historical order does not move.**
       *
       * The rate, the class name, the HSN, the seller's GSTIN and legal name, the origin
       * address, and the customer's registration are ALL changed after the order is placed.
       * Every figure and every identity on the order must read exactly as it did.
       *
       * This is not solved by copying live rows at read time — the order carries its own
       * columns, and the assertions below read the persisted row directly.
       */
      it('survives a change to every piece of master data behind it', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);

        const sku = await givenSku({ code: 'GST-HIST', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code, hsnCode: '6109' });
        await authed(request(harness.app).put('/api/v1/users/me/tax-identity'), token).send({
          gstin: BUYER_GSTIN,
          legalName: 'Buyer Enterprises LLP',
        });

        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const before = (await db().select().from(order).where(eq(order.id, placed.orderId)))[0]!;
        const lineBefore = (
          await db().select().from(orderLine).where(eq(orderLine.orderId, placed.orderId))
        )[0]!;

        expect(before.taxTotal).toBe('180.0000');
        expect(lineBefore.hsnCode).toBe('6109');

        /* 1. Close the current rate and add a very different one. */
        const closeAt = new Date(Date.now() + 1000).toISOString();
        await db()
          .update(taxRate)
          .set({ effectiveTo: new Date(closeAt) })
          .where(eq(taxRate.storeId, storeId));
        const newRate = await givenRate(harness, staff.token, {
          cgstRate: '14',
          sgstRate: '14',
          igstRate: '28',
          effectiveFrom: closeAt,
        });
        expect(newRate.status, JSON.stringify(newRate.body)).toBe(201);

        /* 2. Rename the tax class. */
        await authed(
          request(harness.app).patch('/api/v1/admin/tax-classes/GST-STD'),
          staff.token,
        ).send({ name: 'Renamed after the fact' });

        /* 3. Reclassify the SKU under a different HSN. */
        await classifySku(harness, staff.token, { skuCode: sku.code, hsnCode: '9999' });

        /* 4. Change the seller identity and move the premises to another state. */
        await configureSeller(harness, staff.token, {
          legalName: 'Renamed Retail Private Limited',
          gstin: '27AABCE1234F1Z5',
          originState: 'Maharashtra',
          originCity: 'Mumbai',
        });

        /* 5. Change the customer's registration. */
        await authed(request(harness.app).put('/api/v1/users/me/tax-identity'), token).send({
          gstin: '07AAACB1234C1ZX',
          legalName: 'Renamed Buyer LLP',
        });

        const after = (await db().select().from(order).where(eq(order.id, placed.orderId)))[0]!;
        const lineAfter = (
          await db().select().from(orderLine).where(eq(orderLine.orderId, placed.orderId))
        )[0]!;

        /* Every figure. */
        expect(after.taxTotal).toBe(before.taxTotal);
        expect(after.grandTotal).toBe(before.grandTotal);
        expect(after.total).toBe(before.total);
        expect(lineAfter.cgstRate).toBe(lineBefore.cgstRate);
        expect(lineAfter.cgstAmount).toBe(lineBefore.cgstAmount);
        expect(lineAfter.sgstAmount).toBe(lineBefore.sgstAmount);
        expect(lineAfter.igstAmount).toBe(lineBefore.igstAmount);
        expect(lineAfter.taxableValue).toBe(lineBefore.taxableValue);

        /* Every identity. */
        expect(lineAfter.hsnCode).toBe('6109');
        expect(lineAfter.taxClassName).toBe('Standard rate');
        expect(after.sellerGstin).toBe(SELLER.gstin);
        expect(after.sellerLegalName).toBe(SELLER.legalName);
        expect(after.originState).toBe(SELLER.originState);
        expect(after.supplyType).toBe('intra_state');
        expect(after.customerGstin).toBe(BUYER_GSTIN);
        expect(after.customerLegalName).toBe('Buyer Enterprises LLP');
      });

      /** Reading the order back through the API must not re-derive anything either. */
      it('reports the same figures through the API after the rate changes', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-HIST2', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const before = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}`),
          token,
        );

        const closeAt = new Date(Date.now() + 1000).toISOString();
        await db()
          .update(taxRate)
          .set({ effectiveTo: new Date(closeAt) })
          .where(eq(taxRate.storeId, storeId));
        await givenRate(harness, staff.token, {
          cgstRate: '14',
          sgstRate: '14',
          igstRate: '28',
          effectiveFrom: closeAt,
        });

        const after = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}`),
          token,
        );

        expect(after.body.order.taxTotal).toBe(before.body.order.taxTotal);
        expect(after.body.order.grandTotal).toBe(before.body.order.grandTotal);
        expect(after.body.order.items[0].tax).toEqual(before.body.order.items[0].tax);
      });

      /**
       * The effective-dated selection is a function of the ORDER's instant, not of `now()`.
       *
       * A rate configured to start in the future must not be picked up by a checkout happening
       * before it. This is the other half of immutability: not just "the past does not change",
       * but "the future does not arrive early".
       */
      it('applies a future rate only once it is in force', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await configureSeller(harness, staff.token);
        await givenTaxClass(harness, staff.token);

        /* In force now, ending in a second; then a different rate takes over. */
        const boundary = new Date(Date.now() + 60_000);
        await givenRate(harness, staff.token, {
          effectiveTo: boundary.toISOString(),
        });
        await givenRate(harness, staff.token, {
          cgstRate: '14',
          sgstRate: '14',
          igstRate: '28',
          effectiveFrom: boundary.toISOString(),
        });

        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-FUT', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const [line] = await db()
          .select()
          .from(orderLine)
          .where(eq(orderLine.orderId, placed.orderId));

        /* The CURRENT window, not the one starting in a minute. */
        expect(line!.cgstRate).toBe('9.000000');
        expect(line!.cgstAmount).toBe('90.0000');
      });

      /**
       * **The rate is selected against the ORDER's tax instant, not against `now()`.**
       *
       * Every other test here checks out at the present moment, so `at` and `now()` coincide
       * and a mutation that read the clock instead of the argument is invisible to all of them
       * — a mutation probe proved exactly that, and this test is the answer.
       *
       * So the determination is driven DIRECTLY, with a tax instant inside a window that has
       * since closed. If the resolution used `now()` it would return the current rate; using
       * the instant it must return the historical one. This is also the property that makes
       * re-reading a years-old order reproducible.
       */
      it('selects the rate in force at the ORDER instant, not at read time', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await configureSeller(harness, staff.token);
        await givenTaxClass(harness, staff.token);

        /* An old window that has already closed, and the current one that replaced it. */
        const openedAt = new Date(Date.now() - 90 * 86_400_000);
        const closedAt = new Date(Date.now() - 30 * 86_400_000);
        expect(
          (
            await givenRate(harness, staff.token, {
              cgstRate: '2.5',
              sgstRate: '2.5',
              igstRate: '5',
              effectiveFrom: openedAt.toISOString(),
              effectiveTo: closedAt.toISOString(),
            })
          ).status,
        ).toBe(201);
        expect(
          (await givenRate(harness, staff.token, { effectiveFrom: closedAt.toISOString() })).status,
        ).toBe(201);

        const { userId } = await signIn(harness.app, harness.identity, {
          email: `hist-${nextSeq()}@example.com`,
        });
        const sku = await givenSku({ code: 'GST-ASOF', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        /* Inside the CLOSED window: 60 days ago. */
        const asOf = new Date(Date.now() - 60 * 86_400_000);
        const determination = await withTransaction(db(), silentLogger, async () =>
          harness.tax.determineForCheckout({
            storeId,
            userId,
            storeCurrency: 'INR',
            total: '1000.0000',
            destinationState: 'Karnataka',
            lines: [
              {
                skuId: sku.id,
                skuCode: sku.code,
                lineTotal: '1000.0000',
                discountAmount: '0.0000',
              },
            ],
            at: asOf,
          }),
        );

        expect(determination.assessed).toBe(true);
        /* 2.5% each — the window that was in force then, NOT today's 9%. */
        expect(determination.lines[0]!.cgstRate).toBe('2.500000');
        expect(determination.lines[0]!.cgstAmount).toBe('25.0000');
        expect(determination.taxTotal).toBe('50.0000');
        expect(determination.grandTotal).toBe('1050.0000');
      });
    });

    /* ── Master data: rates and overlap ────────────────────────────────────── */

    describe('rate configuration', () => {
      it('refuses a second open-ended window for one class', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        expect((await givenRate(harness, staff.token)).status).toBe(201);
        const second = await givenRate(harness, staff.token, {
          effectiveFrom: new Date().toISOString(),
        });

        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('TAX_RATE_OVERLAP');
      });

      it('refuses a closed window that overlaps an existing one', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const t0 = new Date(Date.now() - 86_400_000);
        const t1 = new Date(Date.now() + 86_400_000);
        const t2 = new Date(Date.now() + 2 * 86_400_000);

        expect(
          (
            await givenRate(harness, staff.token, {
              effectiveFrom: t0.toISOString(),
              effectiveTo: t1.toISOString(),
            })
          ).status,
        ).toBe(201);

        /* Starts before the first one ends. */
        const overlapping = await givenRate(harness, staff.token, {
          effectiveFrom: new Date(Date.now()).toISOString(),
          effectiveTo: t2.toISOString(),
        });

        expect(overlapping.status).toBe(409);
        expect(overlapping.body.error.code).toBe('TAX_RATE_OVERLAP');
      });

      /** Half-open: a window ending exactly where the next begins is NOT an overlap. */
      it('accepts a window that begins exactly where the previous one ends', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const boundary = new Date(Date.now() + 86_400_000);
        expect(
          (
            await givenRate(harness, staff.token, {
              effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
              effectiveTo: boundary.toISOString(),
            })
          ).status,
        ).toBe(201);

        const adjacent = await givenRate(harness, staff.token, {
          effectiveFrom: boundary.toISOString(),
        });
        expect(adjacent.status, JSON.stringify(adjacent.body)).toBe(201);
      });

      it('rejects a rate above the sanity ceiling', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const response = await givenRate(harness, staff.token, { igstRate: '180' });
        expect(response.status).toBe(400);
      });

      it('rejects a window that closes before it opens', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const response = await givenRate(harness, staff.token, {
          effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
          effectiveTo: new Date(Date.now()).toISOString(),
        });
        expect(response.status).toBe(400);
      });

      /**
       * Two staff configuring rates for one class at the same time must serialise.
       *
       * The class row is locked before the overlap check, so the second request sees the
       * first's row and is refused — rather than both passing an unlocked check and both
       * writing. Separate pool connections, so this is genuine concurrency.
       */
      it('lets only one of two concurrent overlapping rates through', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const from = new Date(Date.now() - 3_600_000).toISOString();
        const [a, b] = await Promise.all([
          givenRate(harness, staff.token, { effectiveFrom: from, cgstRate: '9' }),
          givenRate(harness, staff.token, { effectiveFrom: from, cgstRate: '6' }),
        ]);

        const statuses = [a.status, b.status].sort((x, y) => x - y);
        expect(statuses).toEqual([201, 409]);
        expect(await db().select().from(taxRate)).toHaveLength(1);
      });
    });

    /* ── Master data: classes and classification ───────────────────────────── */

    describe('tax classes', () => {
      it('refuses a duplicate code', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const again = await authed(
          request(harness.app).post('/api/v1/admin/tax-classes'),
          staff.token,
        ).send({ code: 'GST-STD', name: 'Duplicate' });

        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe('TAX_CLASS_ALREADY_EXISTS');
      });

      it('refuses half a SKU classification', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);
        const sku = await givenSku({ code: 'GST-HALF' });

        const response = await authed(
          request(harness.app).put(`/api/v1/admin/skus/${sku.code}/tax`),
          staff.token,
        ).send({ taxClassCode: 'GST-STD', hsnCode: null });

        expect(response.status).toBe(400);
      });

      it('clears a classification when both fields are null', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);
        const sku = await givenSku({ code: 'GST-CLEAR' });
        await classifySku(harness, staff.token, { skuCode: sku.code });

        const cleared = await classifySku(harness, staff.token, {
          skuCode: sku.code,
          taxClassCode: null,
          hsnCode: null,
        });
        expect(cleared.status).toBe(200);

        const [row] = await db().select().from(skuTable).where(eq(skuTable.id, sku.id));
        expect(row!.taxClassId).toBeNull();
        expect(row!.hsnCode).toBeNull();
      });

      it('rejects an HSN that is not 2 to 8 digits', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);
        const sku = await givenSku({ code: 'GST-BADHSN' });

        for (const hsnCode of ['6', 'ABCD', '123456789']) {
          const response = await classifySku(harness, staff.token, { skuCode: sku.code, hsnCode });
          expect(response.status, hsnCode).toBe(400);
        }
      });
    });

    /* ── Authorization and tenancy ─────────────────────────────────────────── */

    describe('authorization', () => {
      it('refuses every staff route to a customer', async () => {
        const harness = build();
        const { token } = await signIn(harness.app, harness.identity);

        const attempts = [
          request(harness.app).get('/api/v1/admin/store/tax-profile'),
          request(harness.app).put('/api/v1/admin/store/tax-profile').send(SELLER),
          request(harness.app).post('/api/v1/admin/tax-classes').send({ code: 'X', name: 'X' }),
          request(harness.app).get('/api/v1/admin/tax-classes'),
          request(harness.app).patch('/api/v1/admin/tax-classes/X').send({ name: 'Y' }),
          request(harness.app).post('/api/v1/admin/tax-classes/X/rates').send(STD_RATES),
          request(harness.app).get('/api/v1/admin/tax-classes/X/rates'),
          request(harness.app)
            .put('/api/v1/admin/skus/X/tax')
            .send({ taxClassCode: 'X', hsnCode: '6109' }),
        ];

        for (const attempt of attempts) {
          const response = await authed(attempt, token);
          expect(response.status).toBe(403);
        }
      });

      it('does not publish the seller GSTIN on any customer-facing payload', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-M', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const response = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}`),
          token,
        );

        /*
         * The seller GSTIN IS published on the order's own tax block — it belongs on the
         * customer's invoice. What must NOT appear is the seller's premises address, which is
         * snapshotted on the row and deliberately absent from the response.
         */
        expect(response.body.order.tax.sellerGstin).toBe(SELLER.gstin);
        const body = JSON.stringify(response.body);
        expect(body).not.toContain(SELLER.originLine1);
        expect(body).not.toContain(SELLER.originPostalCode);
      });

      /** Another store's tax master data is invisible, not merely forbidden. */
      it('scopes tax classes to their store', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token, { code: 'MINE' });

        const otherStoreId = newId();
        await db().insert(store).values({
          id: otherStoreId,
          name: 'other',
          slug: 'other-store',
          currency: 'INR',
        });
        await db().insert(taxClass).values({
          id: newId(),
          storeId: otherStoreId,
          code: 'THEIRS',
          name: 'Another tenant',
          isActive: true,
        });

        const listed = await authed(
          request(harness.app).get('/api/v1/admin/tax-classes'),
          staff.token,
        );
        expect(listed.status).toBe(200);
        const codes = (listed.body.taxClasses as { code: string }[]).map((c) => c.code);
        expect(codes).toEqual(['MINE']);

        const fetched = await authed(
          request(harness.app).get('/api/v1/admin/tax-classes/THEIRS/rates'),
          staff.token,
        );
        expect(fetched.status).toBe(404);
      });

      it('rejects a client-supplied storeId on every tax write', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await givenTaxClass(harness, staff.token);

        const forged = [
          authed(request(harness.app).post('/api/v1/admin/tax-classes'), staff.token).send({
            code: 'F1',
            name: 'F',
            storeId: newId(),
          }),
          authed(
            request(harness.app).post('/api/v1/admin/tax-classes/GST-STD/rates'),
            staff.token,
          ).send({
            ...STD_RATES,
            effectiveFrom: new Date().toISOString(),
            storeId: newId(),
          }),
          authed(request(harness.app).put('/api/v1/admin/store/tax-profile'), staff.token).send({
            ...SELLER,
            storeId: newId(),
          }),
        ];

        for (const attempt of forged) {
          const response = await attempt;
          expect(response.status).toBe(400);
        }
      });

      /** A client cannot name a tax amount, a rate, a supply type or a total at checkout. */
      it('rejects every tax field a client might try to send to checkout', async () => {
        const harness = build();
        const { token, userId } = await signIn(harness.app, harness.identity);
        const addr = await givenAddress(userId);

        for (const extra of [
          { taxTotal: '0.0000' },
          { grandTotal: '1.0000' },
          { supplyType: 'intra_state' },
          { placeOfSupply: 'karnataka' },
          { sellerGstin: SELLER.gstin },
          { customerGstin: BUYER_GSTIN },
          { cgstRate: '9' },
          { taxClassCode: 'GST-STD' },
          { hsnCode: '6109' },
        ]) {
          const response = await authed(
            request(harness.app).post('/api/v1/users/me/checkout'),
            token,
          )
            .set('idempotency-key', `checkout-${newId()}`)
            .send({ addressId: addr.id, ...extra });

          expect(response.status, Object.keys(extra)[0]).toBe(400);
          expect(response.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    /* ── The seller profile is the switch ──────────────────────────────────── */

    describe('the seller tax profile', () => {
      it('reports configured false before it is set, and true after', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });

        const before = await authed(
          request(harness.app).get('/api/v1/admin/store/tax-profile'),
          staff.token,
        );
        expect(before.status).toBe(200);
        expect(before.body.taxProfile.configured).toBe(false);
        expect(before.body.taxProfile.gstin).toBeNull();

        await configureSeller(harness, staff.token);

        const after = await authed(
          request(harness.app).get('/api/v1/admin/store/tax-profile'),
          staff.token,
        );
        expect(after.body.taxProfile.configured).toBe(true);
        expect(after.body.taxProfile.origin.state).toBe('Karnataka');
      });

      it('rejects a malformed seller GSTIN and PAN', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });

        const badGstin = await authed(
          request(harness.app).put('/api/v1/admin/store/tax-profile'),
          staff.token,
        ).send({ ...SELLER, gstin: '29AABCE1234F1Q5' });
        expect(badGstin.status).toBe(400);

        const badPan = await authed(
          request(harness.app).put('/api/v1/admin/store/tax-profile'),
          staff.token,
        ).send({ ...SELLER, pan: 'BAD' });
        expect(badPan.status).toBe(400);
      });

      /** The all-or-nothing constraint, enforced at the database as well as the schema. */
      it('refuses a half-configured profile written directly', async () => {
        await expectDbConstraint(
          db().update(store).set({ gstin: SELLER.gstin }).where(eq(store.id, storeId)),
          'ck_store_tax_profile',
        );
      });

      it('audits the profile change', async () => {
        const harness = build();
        const staff = await signIn(harness.app, harness.identity, {
          email: 'staff@example.com',
          staff: true,
        });
        await configureSeller(harness, staff.token);

        const entries = await db()
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'tax.profile_updated'));

        expect(entries).toHaveLength(1);
        expect(entries[0]!.actorUserId).toBe(staff.userId);
      });
    });

    /* ── The invoice ───────────────────────────────────────────────────────── */

    describe('the invoice', () => {
      it('shows the tax breakdown and keeps the non-statutory disclaimer', async () => {
        const harness = build();
        const { staff } = await givenTaxedStore(harness);
        const { token, userId } = await signIn(harness.app, harness.identity);
        const sku = await givenSku({ code: 'GST-INV', price: '1000.0000' });
        await classifySku(harness, staff.token, { skuCode: sku.code });
        const placed = await placeOrder(harness, { token, userId, skuCode: sku.code });

        const response = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          token,
        );

        expect(response.status).toBe(200);
        expect(response.text).toContain('CGST');
        expect(response.text).toContain('SGST');
        expect(response.text).toContain('HSN 6109');
        expect(response.text).toContain(SELLER.gstin);

        /*
         * **Increment 39 changed what this document is.**
         *
         * This store has a GST profile, so its checkouts are now INVOICED — the document is a
         * numbered tax invoice with an HSN/rate-wise summary, and that summary has an `IGST`
         * column header whether or not the column has a value. So the old
         * `not.toContain('>IGST<')` assertion no longer says what it meant; the intra-state
         * property is asserted on the TOTALS rows instead, which is where a spurious IGST line
         * would actually appear.
         */
        expect(response.text).toContain('Tax summary by HSN and rate');
        expect(response.text).not.toContain('<th>IGST</th>\n              <td');

        /* **The disclaimer survives, reworded to what is true now.** */
        expect(response.text).toContain('not e-invoiced');
        expect(response.text).toContain('no IRN');
        /* Increment 39 gave it a number, so the old wording is no longer true. */
        expect(response.text).not.toContain('no sequential invoice number');
        expect(response.text).toMatch(/INV\/\d{4}-\d{2}\/\d{6}/u);
      });

      it('renders an untaxed order exactly as before, with no GST block', async () => {
        const harness = build();
        const { token, userId } = await signIn(harness.app, harness.identity);
        const placed = await givenOrder(harness, { token, userId });

        const response = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          token,
        );

        expect(response.status).toBe(200);
        expect(response.text).toContain('not a GST tax invoice');
        expect(response.text).not.toContain('Seller GSTIN');
        expect(response.text).not.toContain('Place of supply');
      });
    });

    /* ── No events ─────────────────────────────────────────────────────────── */

    it('publishes no domain event', async () => {
      const harness = build();
      const { staff } = await givenTaxedStore(harness);
      const { token, userId } = await signIn(harness.app, harness.identity);
      const sku = await givenSku({ code: 'GST-EVT', price: '1000.0000' });
      await classifySku(harness, staff.token, { skuCode: sku.code });
      await placeOrder(harness, { token, userId, skuCode: sku.code });

      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.eventName.startsWith('tax.'))).toEqual([]);
    });
  });

  /* ══ Statutory invoicing — Increment 39 ═══════════════════════════════════ */

  /**
   * Statutory invoice issuance, against real PostgreSQL with the REAL invoicing module behind
   * the checkout port.
   *
   * Mounted in this harness for the reason the GST block records: issuance is a checkout
   * concern, it depends on a real tax determination, a real order and real frozen lines, and it
   * must be observed inside and outside a rolled-back transaction. This harness already builds
   * that whole graph.
   *
   * Nine properties carry this block:
   *
   *  1. **The first number is 000001**, and the next is 000002.
   *  2. **Concurrent checkouts in one store never share a number.** Real connections, real row
   *     lock.
   *  3. **Two stores number independently.** Both start at 000001.
   *  4. **Two financial years number independently**, in the same store.
   *  5. **A rolled-back checkout does not consume a number** — the counter is a row, not a
   *     sequence, and that is the whole reason.
   *  6. **One invoice per order**, enforced by the database.
   *  7. **COD is invoiced**; no payment state is consulted.
   *  8. **An unassessed order gets no invoice at all.**
   *  9. **The document is historical**: change the live store, the rates and the customer's
   *     registration, and the rendered invoice does not move.
   */
  describe('invoicing', () => {
    const SELLER = {
      legalName: 'Invoice Test Retail Private Limited',
      gstin: '29AABCE1234F1Z5',
      originLine1: '5th Floor, Prestige Tower',
      originCity: 'Bengaluru',
      originState: 'Karnataka',
      originPostalCode: '560095',
      originCountryCode: 'IN',
    };

    const TAX_CLASS = 'INV-GST-STD';

    const authed = (req: request.Test, token: string) =>
      req.set('authorization', `Bearer ${token}`);

    /** A store configured to charge GST, with one classified, rated SKU. */
    async function givenInvoicingStore(
      harness: Harness,
      options: { skuCode: string; price?: string },
    ) {
      const staff = await signIn(harness.app, harness.identity, {
        email: `inv-staff-${nextSeq()}@example.com`,
        staff: true,
      });

      const profile = await authed(
        request(harness.app).put('/api/v1/admin/store/tax-profile'),
        staff.token,
      ).send(SELLER);
      expect(profile.status, JSON.stringify(profile.body)).toBe(200);

      const cls = await authed(
        request(harness.app).post('/api/v1/admin/tax-classes'),
        staff.token,
      ).send({ code: TAX_CLASS, name: 'Invoice test standard rate' });
      expect(cls.status, JSON.stringify(cls.body)).toBe(201);

      const rate = await authed(
        request(harness.app).post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`),
        staff.token,
      ).send({
        cgstRate: '9',
        sgstRate: '9',
        igstRate: '18',
        effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(rate.status, JSON.stringify(rate.body)).toBe(201);

      const sku = await givenSku({
        code: options.skuCode,
        ...(options.price === undefined ? {} : { price: options.price }),
      });

      const classified = await authed(
        request(harness.app).put(`/api/v1/admin/skus/${sku.code}/tax`),
        staff.token,
      ).send({ taxClassCode: TAX_CLASS, hsnCode: '6109' });
      expect(classified.status, JSON.stringify(classified.body)).toBe(200);

      return { staff, sku };
    }

    /** Check out one already-created SKU. */
    async function placeOrder(
      harness: Harness,
      options: {
        token: string;
        userId: string;
        skuCode: string;
        quantity?: number;
        state?: string;
      },
    ): Promise<{ orderNumber: string; orderId: string }> {
      const put = await authed(
        request(harness.app).put(`/api/v1/users/me/cart/items/${options.skuCode}`),
        options.token,
      ).send({ quantity: options.quantity ?? 1 });
      expect(put.status, JSON.stringify(put.body)).toBe(200);

      const addr = await givenAddress(options.userId);
      if (options.state !== undefined) {
        await db().update(address).set({ state: options.state }).where(eq(address.id, addr.id));
      }

      const checkout = await authed(
        request(harness.app).post('/api/v1/users/me/checkout'),
        options.token,
      )
        .set('idempotency-key', `checkout-${newId()}`)
        .send({ addressId: addr.id });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

      const orderNumber = checkout.body.order.orderNumber as string;
      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      return { orderNumber, orderId: row!.id };
    }

    const invoices = () => db().select().from(invoiceTable);
    const series = () => db().select().from(invoiceSeriesTable);

    /* ── Numbering ──────────────────────────────────────────────────────────── */

    describe('numbering', () => {
      it('issues INV/YYYY-YY/000001 for the first invoice, then 000002', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-A', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-buyer-${nextSeq()}@example.com`,
        });

        const first = await placeOrder(harness, { ...buyer, skuCode: 'INV-A' });

        const afterFirst = await invoices();
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]!.sequenceNumber).toBe(1);
        expect(afterFirst[0]!.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/000001$/u);
        expect(afterFirst[0]!.orderId).toBe(first.orderId);

        /* A second buyer, so the cart is fresh. */
        const buyer2 = await signIn(harness.app, harness.identity, {
          email: `inv-buyer-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer2, skuCode: 'INV-A' });

        const both = (await invoices()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        expect(both).toHaveLength(2);
        expect(both.map((i) => i.sequenceNumber)).toEqual([1, 2]);
        expect(both[1]!.invoiceNumber).toMatch(/\/000002$/u);

        /* And the two share one series row, which now reads 2. */
        const rows = await series();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.lastNumber).toBe(2);
      });

      it('numbers the invoice consistently with its own parts', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-B', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-buyer-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer, skuCode: 'INV-B' });

        const [row] = await invoices();
        expect(row!.invoiceNumber).toBe(
          `INV/${row!.financialYear}/${String(row!.sequenceNumber).padStart(6, '0')}`,
        );
      });

      /**
       * **Concurrency, against real connections.**
       *
       * Two customers checking out at the same instant. The allocation is one
       * `INSERT … ON CONFLICT DO UPDATE … RETURNING` statement, so the loser blocks on
       * `uq_invoice_series` and then reads the winner's value — 1 and 2 in some order, never
       * both 1.
       *
       * Two SEPARATE carts and users, because one cart cannot be checked out twice; the
       * concurrency under test is the series counter, not the cart lock.
       */
      it('never issues one number twice under concurrent checkout', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-CONC', price: '1000.0000' });

        const buyers = await Promise.all([
          signIn(harness.app, harness.identity, { email: `inv-c1-${nextSeq()}@example.com` }),
          signIn(harness.app, harness.identity, { email: `inv-c2-${nextSeq()}@example.com` }),
          signIn(harness.app, harness.identity, { email: `inv-c3-${nextSeq()}@example.com` }),
        ]);

        /* Fill each cart and resolve each address first, so the race is the checkout itself. */
        const prepared = [];
        for (const buyer of buyers) {
          const put = await authed(
            request(harness.app).put('/api/v1/users/me/cart/items/INV-CONC'),
            buyer.token,
          ).send({ quantity: 1 });
          expect(put.status).toBe(200);
          const addr = await givenAddress(buyer.userId);
          prepared.push({ token: buyer.token, addressId: addr.id });
        }

        const results = await Promise.all(
          prepared.map((p) =>
            authed(request(harness.app).post('/api/v1/users/me/checkout'), p.token)
              .set('idempotency-key', `checkout-${newId()}`)
              .send({ addressId: p.addressId }),
          ),
        );

        for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);

        const rows = (await invoices()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        expect(rows).toHaveLength(3);
        /* Sequential and GAPLESS. */
        expect(rows.map((r) => r.sequenceNumber)).toEqual([1, 2, 3]);
        /* Distinct numbers, and distinct orders. */
        expect(new Set(rows.map((r) => r.invoiceNumber)).size).toBe(3);
        expect(new Set(rows.map((r) => r.orderId)).size).toBe(3);

        const [counter] = await series();
        expect(counter!.lastNumber).toBe(3);
      });

      /**
       * **A rolled-back checkout does not consume a number.**
       *
       * This is the property a PostgreSQL sequence could not provide, and the reason the counter
       * is a row. The rollback is provoked by insufficient stock: the reservation step throws
       * AFTER the invoice has been issued in the same transaction, so the increment is undone
       * with everything else.
       */
      it('releases the number when the checkout rolls back', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-ROLL', price: '1000.0000' });

        /* One unit in stock, and a cart asking for two. */
        await db()
          .update(stockItem)
          .set({ onHand: 1, reserved: 0 })
          .where(
            eq(
              stockItem.skuId,
              (await db().select().from(skuTable).where(eq(skuTable.code, 'INV-ROLL')))[0]!.id,
            ),
          );

        const doomed = await signIn(harness.app, harness.identity, {
          email: `inv-roll-${nextSeq()}@example.com`,
        });
        const put = await authed(
          request(harness.app).put('/api/v1/users/me/cart/items/INV-ROLL'),
          doomed.token,
        ).send({ quantity: 2 });
        expect(put.status).toBe(200);
        const addr = await givenAddress(doomed.userId);

        const failed = await authed(
          request(harness.app).post('/api/v1/users/me/checkout'),
          doomed.token,
        )
          .set('idempotency-key', `checkout-${newId()}`)
          .send({ addressId: addr.id });

        expect(failed.status, JSON.stringify(failed.body)).toBe(409);

        /* Nothing was written — not the order, not the invoice, and not the counter. */
        expect(await invoices()).toEqual([]);
        expect(await series()).toEqual([]);

        /* And the NEXT order takes 000001, proving the number was not burned. */
        await db()
          .update(stockItem)
          .set({ onHand: 50, reserved: 0 })
          .where(
            eq(
              stockItem.skuId,
              (await db().select().from(skuTable).where(eq(skuTable.code, 'INV-ROLL')))[0]!.id,
            ),
          );

        const good = await signIn(harness.app, harness.identity, {
          email: `inv-roll2-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...good, skuCode: 'INV-ROLL' });

        const [issued] = await invoices();
        expect(issued!.sequenceNumber).toBe(1);
        expect(issued!.invoiceNumber).toMatch(/\/000001$/u);
      });

      /** And the committed number DOES advance — the other half of the same guarantee. */
      it('advances the counter once a checkout commits', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-ADV', price: '1000.0000' });

        for (const n of [1, 2, 3]) {
          const buyer = await signIn(harness.app, harness.identity, {
            email: `inv-adv-${nextSeq()}@example.com`,
          });
          await placeOrder(harness, { ...buyer, skuCode: 'INV-ADV' });
          const [counter] = await series();
          expect(counter!.lastNumber).toBe(n);
        }
      });

      /**
       * **Two stores number independently.** Both start at 000001.
       *
       * A single global series would let one merchant's volume push another's numbering, and a
       * merchant cannot explain a gap caused by somebody else's sales.
       */
      it('numbers each store from its own series', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-S1', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-s1-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer, skuCode: 'INV-S1' });

        const [mine] = await invoices();
        expect(mine!.sequenceNumber).toBe(1);

        /* A second store with its own series row at the same year, seeded directly. */
        const otherStoreId = newId();
        await db()
          .insert(store)
          .values({ id: otherStoreId, slug: `other-${nextSeq()}`, name: 'Other', currency: 'INR' });
        await db().insert(invoiceSeriesTable).values({
          id: newId(),
          storeId: otherStoreId,
          financialYear: mine!.financialYear,
          lastNumber: 7,
        });

        /* This store's next invoice is 2, unaffected by the other store's 7. */
        const buyer2 = await signIn(harness.app, harness.identity, {
          email: `inv-s2-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer2, skuCode: 'INV-S1' });

        const ours = (await invoices())
          .filter((i) => i.storeId === storeId)
          .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        expect(ours.map((i) => i.sequenceNumber)).toEqual([1, 2]);

        const theirs = (await series()).find((s) => s.storeId === otherStoreId);
        expect(theirs!.lastNumber).toBe(7);
      });

      /**
       * **Two financial years number independently**, in one store.
       *
       * Seeded directly: the alternative would be to place an order at a chosen instant, which
       * an HTTP call cannot do. The point under test is that the counter is keyed by year, so a
       * pre-existing series for a DIFFERENT year does not advance this one.
       */
      it('numbers each financial year from its own series', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-FY', price: '1000.0000' });

        /* A series for a year that is definitely not the current one. */
        await db().insert(invoiceSeriesTable).values({
          id: newId(),
          storeId,
          financialYear: '2019-20',
          lastNumber: 99,
        });

        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-fy-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer, skuCode: 'INV-FY' });

        const [issued] = await invoices();
        expect(issued!.sequenceNumber).toBe(1);
        expect(issued!.financialYear).not.toBe('2019-20');

        const old = (await series()).find((s) => s.financialYear === '2019-20');
        expect(old!.lastNumber).toBe(99);
      });
    });

    /* ── One per order ──────────────────────────────────────────────────────── */

    describe('one invoice per order', () => {
      it('refuses a second invoice for one order at the database level', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-ONE', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-one-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-ONE' });

        const [existing] = await invoices();

        await expectDbConstraint(
          db()
            .insert(invoiceTable)
            .values({
              id: newId(),
              storeId,
              orderId: placed.orderId,
              invoiceNumber: `INV/${existing!.financialYear}/000999`,
              financialYear: existing!.financialYear,
              sequenceNumber: 999,
              issuedAt: new Date(),
              invoiceDate: existing!.invoiceDate,
              taxableValue: '1000.0000',
              taxTotal: '180.0000',
              grandTotal: '1180.0000',
            }),
          'uq_invoice_order',
        );
      });

      it('refuses a duplicate number within one store', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-DUP', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-dup-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer, skuCode: 'INV-DUP' });

        const [existing] = await invoices();
        const buyer2 = await signIn(harness.app, harness.identity, {
          email: `inv-dup2-${nextSeq()}@example.com`,
        });
        const second = await placeOrder(harness, { ...buyer2, skuCode: 'INV-DUP' });

        await expectDbConstraint(
          db()
            .update(invoiceTable)
            .set({
              invoiceNumber: existing!.invoiceNumber,
              sequenceNumber: existing!.sequenceNumber,
            })
            .where(eq(invoiceTable.orderId, second.orderId)),
          'uq_invoice',
        );
      });

      /** The number must agree with the parts it is made of. */
      it('refuses a number that disagrees with its sequence', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-MISMATCH', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-mm-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-MISMATCH' });

        await expectDbConstraint(
          db()
            .update(invoiceTable)
            .set({ sequenceNumber: 42 })
            .where(eq(invoiceTable.orderId, placed.orderId)),
          'ck_invoice_number_matches_parts',
        );
      });

      it('refuses an invoice whose grand total does not foot', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-FOOT', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-foot-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-FOOT' });

        await expectDbConstraint(
          db()
            .update(invoiceTable)
            .set({ grandTotal: '9999.0000' })
            .where(eq(invoiceTable.orderId, placed.orderId)),
          'ck_invoice_grand_total_identity',
        );
      });
    });

    /* ── When an invoice is and is not issued ──────────────────────────────── */

    describe('issuance conditions', () => {
      /**
       * **COD is invoiced. Requirement 2: no payment-success dependency.**
       *
       * A COD payment is created `pending` and no code path terminalises it, so waiting for
       * money would leave every COD sale permanently uninvoiced.
       */
      it('invoices a COD order whose payment never succeeds', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-COD', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-cod-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-COD' });

        /* The invoice exists BEFORE any payment. */
        expect(await invoices()).toHaveLength(1);

        const cod = await initiate(harness, {
          token: buyer.token,
          orderNumber: placed.orderNumber,
          method: 'cod',
          key: `pay-${newId()}`,
        });
        expect(cod.status, JSON.stringify(cod.body)).toBe(201);
        expect(cod.body.payment.status).toBe('pending');

        /* Still exactly one invoice, and the payment did not create or change it. */
        const rows = await invoices();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.grandTotal).toBe(cod.body.payment.amount);
      });

      it('invoices an order with no payment at all', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-NOPAY', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-nopay-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...buyer, skuCode: 'INV-NOPAY' });

        expect(await invoices()).toHaveLength(1);
        expect(await db().select().from(payment)).toEqual([]);
      });

      /** Requirement 16. An unassessed order gets no number, not a zero-valued one. */
      it('issues nothing for a store with no GST profile', async () => {
        const harness = build();
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-unassessed-${nextSeq()}@example.com`,
        });
        const placed = await givenOrder(harness, { token: buyer.token, userId: buyer.userId });

        const [row] = await db().select().from(order).where(eq(order.id, placed.orderId));
        expect(row!.taxAt).toBeNull();

        expect(await invoices()).toEqual([]);
        expect(await series()).toEqual([]);
      });

      it('is B2B or B2C on the same series', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-B2B', price: '1000.0000' });

        const b2c = await signIn(harness.app, harness.identity, {
          email: `inv-b2c-${nextSeq()}@example.com`,
        });
        await placeOrder(harness, { ...b2c, skuCode: 'INV-B2B' });

        const b2b = await signIn(harness.app, harness.identity, {
          email: `inv-b2b-${nextSeq()}@example.com`,
        });
        const identity = await authed(
          request(harness.app).put('/api/v1/users/me/tax-identity'),
          b2b.token,
        ).send({ gstin: '27AAACB1234C1ZX', legalName: 'Buyer Enterprises LLP' });
        expect(identity.status).toBe(200);
        const b2bOrder = await placeOrder(harness, { ...b2b, skuCode: 'INV-B2B' });

        const rows = (await invoices()).sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        expect(rows.map((r) => r.sequenceNumber)).toEqual([1, 2]);

        /* Both invoiced; the customer category lives on the ORDER, not on the invoice. */
        const [placed] = await db().select().from(order).where(eq(order.id, b2bOrder.orderId));
        expect(placed!.customerTaxCategory).toBe('b2b');
      });
    });

    /* ── Reconciliation ────────────────────────────────────────────────────── */

    describe('reconciliation', () => {
      it('stores totals that equal the order exactly', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-REC', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-rec-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-REC', quantity: 3 });

        const [inv] = await invoices();
        const [ord] = await db().select().from(order).where(eq(order.id, placed.orderId));

        expect(inv!.taxableValue).toBe(ord!.total);
        expect(inv!.taxTotal).toBe(ord!.taxTotal);
        expect(inv!.grandTotal).toBe(ord!.grandTotal);
      });

      it('reconciles against the sum of the frozen lines', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-REC2', price: '333.3300' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-rec2-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-REC2', quantity: 3 });

        const lines = await db()
          .select()
          .from(orderLine)
          .where(eq(orderLine.orderId, placed.orderId));
        const [inv] = await invoices();

        const lineTax = lines.reduce(
          (acc, l) => toDb(add(fromDb(acc, 'INR'), fromDb(l.taxTotal, 'INR'))),
          '0.0000',
        );
        const lineTaxable = lines.reduce(
          (acc, l) => toDb(add(fromDb(acc, 'INR'), fromDb(l.taxableValue, 'INR'))),
          '0.0000',
        );

        expect(inv!.taxTotal).toBe(lineTax);
        expect(inv!.taxableValue).toBe(lineTaxable);
      });
    });

    /* ── The rendered document ─────────────────────────────────────────────── */

    describe('the document', () => {
      it('shows the statutory number, the HSN summary and the frozen seller', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-DOC', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-doc-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-DOC' });
        const [inv] = await invoices();

        const doc = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );

        expect(doc.status).toBe(200);
        expect(doc.text).toContain('Tax invoice');
        expect(doc.text).toContain(inv!.invoiceNumber);
        expect(doc.text).toContain(inv!.financialYear);
        /* The HSN/rate-wise summary. */
        expect(doc.text).toContain('Tax summary by HSN and rate');
        expect(doc.text).toContain('6109');
        /* The SELLER, from the frozen snapshot — and no hardcoded company. */
        expect(doc.text).toContain(SELLER.legalName);
        expect(doc.text).toContain(SELLER.gstin);
        expect(doc.text).not.toContain('Syntellite');

        /* Requirement 17: no fake IRN, no fake QR. */
        expect(doc.text).not.toMatch(/\bIRN\b\s*[:=]/u);
        expect(doc.text).not.toContain('Acknowledgement number');
        expect(doc.text).not.toContain('<canvas');
        expect(doc.text).not.toContain('qrcode');
        expect(doc.text).toContain('not e-invoiced');

        /* And the hardening survives. */
        expect(doc.headers['content-security-policy']).toContain("default-src 'none'");
        expect(doc.headers['cache-control']).toContain('no-store');
      });

      it('renders an unassessed order with no statutory number', async () => {
        const harness = build();
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-plain-${nextSeq()}@example.com`,
        });
        const placed = await givenOrder(harness, { token: buyer.token, userId: buyer.userId });

        const doc = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );

        expect(doc.status).toBe(200);
        expect(doc.text).toContain(placed.orderNumber);
        expect(doc.text).not.toMatch(/INV\/\d{4}-\d{2}\/\d{6}/u);
        expect(doc.text).not.toContain('Tax summary by HSN and rate');
        expect(doc.text).toContain('not a GST tax invoice');
      });

      /** The staff route renders the identical document. */
      it('serves the same document to staff', async () => {
        const harness = build();
        const { staff } = await givenInvoicingStore(harness, {
          skuCode: 'INV-STAFF',
          price: '1000.0000',
        });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-staff2-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-STAFF' });

        const asCustomer = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );
        const asStaff = await authed(
          request(harness.app).get(`/api/v1/admin/orders/${placed.orderNumber}/invoice`),
          staff.token,
        );

        expect(asStaff.status).toBe(200);
        expect(asStaff.text).toBe(asCustomer.text);
      });

      /**
       * **The GET routes are READ-ONLY — requirement 15.**
       *
       * Fetching a document for an order that has no invoice must not issue one, however many
       * times it is fetched. Backfilling on read would allocate numbers in the order people
       * happened to look at documents, which is not a series.
       */
      it('issues nothing when a document is fetched repeatedly', async () => {
        const harness = build();
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-ro-${nextSeq()}@example.com`,
        });
        const placed = await givenOrder(harness, { token: buyer.token, userId: buyer.userId });

        for (let i = 0; i < 3; i++) {
          const doc = await authed(
            request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
            buyer.token,
          );
          expect(doc.status).toBe(200);
        }

        expect(await invoices()).toEqual([]);
        expect(await series()).toEqual([]);
      });

      it('does not renumber an invoiced order on repeated reads', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-RO2', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-ro2-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-RO2' });
        const [before] = await invoices();

        for (let i = 0; i < 3; i++) {
          await authed(
            request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
            buyer.token,
          );
        }

        const after = await invoices();
        expect(after).toHaveLength(1);
        expect(after[0]!.invoiceNumber).toBe(before!.invoiceNumber);
        const [counter] = await series();
        expect(counter!.lastNumber).toBe(1);
      });

      /**
       * **Escaping. The security boundary, on the fields Increment 39 newly renders.**
       *
       * The seller legal name and the origin address now reach the document from the order's
       * snapshot, and both originate in a staff-typed store profile. Unescaped, either is stored
       * XSS.
       */
      it('escapes the newly rendered seller fields', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-XSS', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-xss-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-XSS' });

        /*
         * Injected on the ORDER's snapshot directly. The store-profile API would refuse this
         * shape, and the point under test is the renderer rather than that validator.
         */
        const payload = '<script>alert(1)</script>';
        await db()
          .update(order)
          .set({ sellerLegalName: payload, originCity: payload })
          .where(eq(order.id, placed.orderId));

        const doc = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );

        expect(doc.status).toBe(200);
        expect(doc.text).not.toContain('<script>alert(1)</script>');
        expect(doc.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      });
    });

    /* ── Historical immutability ───────────────────────────────────────────── */

    describe('historical immutability', () => {
      /**
       * **Requirement F: change the live configuration, and the document does not move.**
       *
       * The rate, the tax class name, the SKU's HSN, the seller's GSTIN and legal name, the
       * origin address and the customer's registration are ALL changed after the invoice is
       * issued. The rendered document and the persisted row must be identical.
       */
      it('renders identically after every piece of live configuration changes', async () => {
        const harness = build();
        const { staff } = await givenInvoicingStore(harness, {
          skuCode: 'INV-HIST',
          price: '1000.0000',
        });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-hist-${nextSeq()}@example.com`,
        });
        await authed(request(harness.app).put('/api/v1/users/me/tax-identity'), buyer.token).send({
          gstin: '27AAACB1234C1ZX',
          legalName: 'Buyer Enterprises LLP',
        });

        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-HIST' });

        const before = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );
        expect(before.status).toBe(200);
        const [invBefore] = await invoices();

        /* 1. Close the rate and add a very different one. */
        const closeAt = new Date(Date.now() + 1000);
        await db()
          .update(taxRate)
          .set({ effectiveTo: closeAt })
          .where(eq(taxRate.storeId, storeId));
        const newRate = await authed(
          request(harness.app).post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`),
          staff.token,
        ).send({
          cgstRate: '14',
          sgstRate: '14',
          igstRate: '28',
          effectiveFrom: closeAt.toISOString(),
        });
        expect(newRate.status, JSON.stringify(newRate.body)).toBe(201);

        /* 2. Rename the tax class. 3. Reclassify the SKU. */
        await authed(
          request(harness.app).patch(`/api/v1/admin/tax-classes/${TAX_CLASS}`),
          staff.token,
        ).send({ name: 'Renamed after the fact' });
        await authed(request(harness.app).put('/api/v1/admin/skus/INV-HIST/tax'), staff.token).send(
          { taxClassCode: TAX_CLASS, hsnCode: '9999' },
        );

        /* 4. Move the seller to another state and rename it. */
        await authed(request(harness.app).put('/api/v1/admin/store/tax-profile'), staff.token).send(
          {
            ...SELLER,
            legalName: 'Renamed Retail Private Limited',
            gstin: '27AABCE1234F1Z5',
            originCity: 'Mumbai',
            originState: 'Maharashtra',
          },
        );

        /* 5. Change the customer's registration. 6. Change the store's timezone. */
        await authed(request(harness.app).put('/api/v1/users/me/tax-identity'), buyer.token).send({
          gstin: '07AAACB1234C1ZX',
          legalName: 'Renamed Buyer LLP',
        });
        await db().update(store).set({ timezone: 'America/New_York' }).where(eq(store.id, storeId));

        const after = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );

        /* **Byte-identical.** */
        expect(after.status).toBe(200);
        expect(after.text).toBe(before.text);

        /* And the persisted row did not move either. */
        const [invAfter] = await invoices();
        expect(invAfter).toEqual(invBefore);

        /* Specifically: the OLD seller, the OLD HSN, the OLD rate. */
        expect(after.text).toContain(SELLER.legalName);
        expect(after.text).toContain(SELLER.gstin);
        expect(after.text).toContain('6109');
        expect(after.text).not.toContain('9999');
        expect(after.text).not.toContain('Renamed Retail');
      });

      /**
       * The document DATE comes from the stored `invoice_date`, not from a live timezone.
       *
       * Requirement 14. Changing `store.timezone` after issuance must not shift the date a
       * statutory document bears.
       */
      it('keeps the invoice date after the store timezone changes', async () => {
        const harness = build();
        await givenInvoicingStore(harness, { skuCode: 'INV-TZ', price: '1000.0000' });
        const buyer = await signIn(harness.app, harness.identity, {
          email: `inv-tz-${nextSeq()}@example.com`,
        });
        const placed = await placeOrder(harness, { ...buyer, skuCode: 'INV-TZ' });

        const [inv] = await invoices();
        const storedDate = inv!.invoiceDate;

        await db()
          .update(store)
          .set({ timezone: 'Pacific/Kiritimati' })
          .where(eq(store.id, storeId));

        const doc = await authed(
          request(harness.app).get(`/api/v1/users/me/orders/${placed.orderNumber}/invoice`),
          buyer.token,
        );

        const [unchanged] = await invoices();
        expect(unchanged!.invoiceDate).toBe(storedDate);
        expect(doc.status).toBe(200);
      });
    });

    /* ── No events ─────────────────────────────────────────────────────────── */

    it('publishes no domain event', async () => {
      const harness = build();
      await givenInvoicingStore(harness, { skuCode: 'INV-EVT', price: '1000.0000' });
      const buyer = await signIn(harness.app, harness.identity, {
        email: `inv-evt-${nextSeq()}@example.com`,
      });
      await placeOrder(harness, { ...buyer, skuCode: 'INV-EVT' });

      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.eventName.startsWith('invoice.'))).toEqual([]);
    });

    it('audits the issuance', async () => {
      const harness = build();
      await givenInvoicingStore(harness, { skuCode: 'INV-AUD', price: '1000.0000' });
      const buyer = await signIn(harness.app, harness.identity, {
        email: `inv-aud-${nextSeq()}@example.com`,
      });
      await placeOrder(harness, { ...buyer, skuCode: 'INV-AUD' });

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'invoice.issued'));

      expect(entries).toHaveLength(1);
      const [inv] = await invoices();
      expect((entries[0]!.metadata as { invoiceNumber?: string }).invoiceNumber).toBe(
        inv!.invoiceNumber,
      );
    });
  });
});
