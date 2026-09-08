import { createHmac } from 'node:crypto';

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { withTransaction } from '../../../db/transaction.js';
import { address } from '../../../db/schema/address.js';
import { cartLine } from '../../../db/schema/cart.js';
import { product, sku } from '../../../db/schema/catalogue.js';
import { auditLog } from '../../../db/schema/identity.js';
import { stockItem, stockReservation } from '../../../db/schema/inventory.js';
import { store } from '../../../db/schema/store.js';
import { order, orderLine, orderStatusHistory } from '../../../db/schema/orders.js';
import { payment } from '../../../db/schema/payments.js';
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
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createPaymentsRepository } from '../../payments/payments.repository.js';
import { createPaymentsRoutes } from '../../payments/payments.routes.js';
import { createPaymentsService } from '../../payments/payments.service.js';
import { createPaymentsWebhookRoutes } from '../../payments/payments.webhook.routes.js';
import { createPromotionsRepository } from '../../promotions/promotions.repository.js';
import { createPromotionsService } from '../../promotions/promotions.service.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createTaxRepository, createTaxService } from '../../tax/index.js';
import { createOrdersRepository } from '../orders.repository.js';
import { createOrdersRoutes } from '../orders.routes.js';
import { createOrdersService } from '../orders.service.js';

/**
 * Order cancellation.
 *
 * Wired with the REAL payments module behind the `OrderPayments` port, because the whole rule
 * is about payment state: a stub answering "no payment" would let every case pass while the
 * money check did nothing.
 *
 * The rule under test:
 *
 * | Payment state       | Cancel? |
 * | ------------------- | ------- |
 * | none                | yes     |
 * | `failed`, `expired` | yes     |
 * | `pending`           | no      |
 * | `succeeded`         | no      |
 *
 * `pending` and `succeeded` are refused for the same underlying reason — refunds do not exist,
 * so nothing here may create money the system cannot return. `pending` is the subtle one: an
 * online capture can land at any moment, so allowing it would race real money.
 */
describe('order cancellation (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';

  /** The approved production window, so a test asserts the real rule rather than a stub. */
  const EXPIRY_MINUTES = 30;
  const CREDENTIALS = {
    keyId: 'rzp_test_cancel',
    keySecret: 'cancel-api-secret',
    webhookSecret: 'cancel-webhook-secret',
  };

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

  const sign = (body: string): string =>
    createHmac('sha256', CREDENTIALS.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  function build() {
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
      /** The REAL payment lookup, late-bound exactly as `container.ts` binds it. */
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
      db: db(),
      audit: recorders.audit,
      logger: silentLogger,
    });

    const providerRefs: string[] = [];
    const fetchImpl = vi.fn(async () => {
      const ref = `order_CANCEL_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    }) as unknown as typeof fetch;

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
      gateway: createRazorpayGateway({
        credentials: CREDENTIALS,
        logger: silentLogger,
        fetchImpl,
      }),
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
      inventory,
      lastProviderRef: () => providerRefs.at(-1) ?? 'order_CANCEL_1',
    };
  }

  type Harness = ReturnType<typeof build>;

  async function signIn(
    harness: Harness,
    email = 'ada@example.com',
  ): Promise<{ token: string; userId: string }> {
    const user = await harness.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
    const response = await request(harness.app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  async function givenOrder(
    harness: Harness,
    options: { token: string; userId: string; code?: string },
  ): Promise<{ orderNumber: string; orderId: string }> {
    const code = options.code ?? 'CANCEL-A';
    const parent = {
      id: newId(),
      storeId,
      slug: `p-${code.toLowerCase()}`,
      name: 'Cancellable Thing',
      description: '',
      status: 'active',
    };
    await db().insert(product).values(parent);
    const created = await giveSku(db(), parent, {
      code,
      name: `${code} variant`,
      price: '500.0000',
      deletedAt: null,
      onHand: DEFAULT_SKU_ON_HAND,
    });

    await db().insert(address).values({
      id: newId(),
      userId: options.userId,
      storeId,
      label: 'Home',
      recipientName: 'Ada Lovelace',
      phone: '+91 98765 43210',
      line1: '221B Brigade Road',
      line2: '',
      landmark: '',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
      deletedAt: null,
    });
    const [addr] = await db().select().from(address).where(eq(address.userId, options.userId));

    await request(harness.app)
      .put(`/api/v1/users/me/cart/items/${created.code}`)
      .set('authorization', `Bearer ${options.token}`)
      .send({ quantity: 1 });

    const checkout = await request(harness.app)
      .post('/api/v1/users/me/checkout')
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', `checkout-${newId()}`)
      .send({ addressId: addr!.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    return { orderNumber, orderId: row!.id };
  }

  const cancel = (harness: Harness, options: { token: string; orderNumber: string }) =>
    request(harness.app)
      .post(`/api/v1/users/me/orders/${options.orderNumber}/cancel`)
      .set('authorization', `Bearer ${options.token}`)
      .send();

  const pay = (
    harness: Harness,
    options: { token: string; orderNumber: string; method?: string },
  ) =>
    request(harness.app)
      .post(`/api/v1/users/me/orders/${options.orderNumber}/payments`)
      .set('authorization', `Bearer ${options.token}`)
      .set('idempotency-key', `pay-${newId()}`)
      .send({ method: options.method ?? 'online' });

  /** Drive a real signed webhook so the payment reaches a genuine terminal state. */
  const webhook = (harness: Harness, event: 'payment.captured' | 'payment.failed') => {
    const body = JSON.stringify({
      event,
      payload: { payment: { entity: { order_id: harness.lastProviderRef() } } },
    });
    return request(harness.app)
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt_${event}_${newId()}`)
      .send(body);
  };

  /* ══ The happy path ════════════════════════════════════════════════════ */

  describe('an unpaid order', () => {
    it('cancels, writes history, and audits', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });

      const response = await cancel(harness, { token, orderNumber });
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('cancelled');
      expect(response.body.order.orderNumber).toBe(orderNumber);

      const [row] = await db().select().from(order).where(eq(order.id, orderId));
      expect(row!.status).toBe('cancelled');

      /** Append-only: the creation row plus the transition, never an overwrite. */
      const history = await db()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(history).toHaveLength(2);
      expect(history.find((h) => h.fromStatus === null)).toMatchObject({ toStatus: 'placed' });
      expect(history.find((h) => h.fromStatus === 'placed')).toMatchObject({
        toStatus: 'cancelled',
        actorType: 'customer',
        actorUserId: userId,
      });

      const audit = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'order.cancelled'));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata).toMatchObject({ orderNumber, paymentStatus: 'none' });
    });

    it('is still readable, and still carries its lines and totals', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const before = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}`)
        .set('authorization', `Bearer ${token}`);

      expect((await cancel(harness, { token, orderNumber })).status).toBe(200);

      const after = await request(harness.app)
        .get(`/api/v1/users/me/orders/${orderNumber}`)
        .set('authorization', `Bearer ${token}`);

      expect(after.status).toBe(200);
      expect(after.body.order.status).toBe('cancelled');
      /* Nothing but the status changed. */
      expect({ ...after.body.order, status: 'placed' }).toEqual(before.body.order);
    });

    it('appears as cancelled in the order list', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });
      await cancel(harness, { token, orderNumber });

      const list = await request(harness.app)
        .get('/api/v1/users/me/orders')
        .set('authorization', `Bearer ${token}`);

      expect(list.status).toBe(200);
      expect(list.body.orders).toHaveLength(1);
      expect(list.body.orders[0].status).toBe('cancelled');
    });
  });

  /* ══ Cancelling is terminal ════════════════════════════════════════════ */

  describe('cancelling twice', () => {
    /**
     * A second cancellation is a `409`, deliberately NOT an idempotent `200`.
     *
     * A client told "cancelled" twice cannot tell whether it cancelled something or nothing,
     * and for a state change that distinction is worth reporting.
     */
    it('is refused with a status reason, and writes no second history row', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });

      expect((await cancel(harness, { token, orderNumber })).status).toBe(200);

      const again = await cancel(harness, { token, orderNumber });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
      expect(again.body.error.details.reason).toBe('status');

      const history = await db()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(history).toHaveLength(2);
    });

    /**
     * Concurrency: the row lock plus the `status = 'placed'` predicate must resolve two
     * simultaneous cancellations to exactly one transition.
     */
    it('resolves concurrent cancellations to one transition', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber, orderId } = await givenOrder(harness, { token, userId });

      const [a, b] = await Promise.all([
        cancel(harness, { token, orderNumber }),
        cancel(harness, { token, orderNumber }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);

      const history = await db()
        .select()
        .from(orderStatusHistory)
        .where(eq(orderStatusHistory.orderId, orderId));
      expect(history.filter((h) => h.toStatus === 'cancelled')).toHaveLength(1);

      const audit = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'order.cancelled'));
      expect(audit).toHaveLength(1);
    });
  });

  /* ══ The payment rule ══════════════════════════════════════════════════ */

  describe('an order with a payment', () => {
    /** A pending payment blocks cancellation: an online capture may still land. */
    it('is refused while a payment is pending', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await pay(harness, { token, orderNumber })).status).toBe(201);

      const response = await cancel(harness, { token, orderNumber });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
      expect(response.body.error.details.reason).toBe('payment_in_progress');

      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');
    });

    /** The same applies to a pending COD payment — the rule is about state, not method. */
    it('is refused while a COD payment is pending', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await pay(harness, { token, orderNumber, method: 'cod' })).status).toBe(201);

      const response = await cancel(harness, { token, orderNumber });
      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe('payment_in_progress');
    });

    /**
     * **A paid order can never be cancelled**, because refunds do not exist and cancelling
     * would take money the system has no way to return.
     */
    it('is refused once the payment has succeeded', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await pay(harness, { token, orderNumber })).status).toBe(201);
      expect((await webhook(harness, 'payment.captured')).status).toBe(200);

      const [paid] = await db().select().from(payment);
      expect(paid!.status).toBe('succeeded');

      const response = await cancel(harness, { token, orderNumber });
      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe('paid');
      expect(response.body.error.message).toMatch(/refund/i);

      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');
    });

    /** A failed payment is terminal and unpaid, so the customer may cancel and move on. */
    it('CAN be cancelled once the payment has failed', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await pay(harness, { token, orderNumber })).status).toBe(201);
      expect((await webhook(harness, 'payment.failed')).status).toBe(200);

      const [failed] = await db().select().from(payment);
      expect(failed!.status).toBe('failed');

      const response = await cancel(harness, { token, orderNumber });
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('cancelled');

      /* The audit records WHY it was allowed. */
      const audit = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'order.cancelled'));
      expect(audit[0]!.metadata).toMatchObject({ paymentStatus: 'failed' });
    });

    /** The payment survives the cancellation. It is history, and history is not rewritten. */
    it('leaves the failed payment untouched', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      await pay(harness, { token, orderNumber });
      await webhook(harness, 'payment.failed');
      const [before] = await db().select().from(payment);

      expect((await cancel(harness, { token, orderNumber })).status).toBe(200);

      const [after] = await db().select().from(payment);
      expect(after).toEqual(before);
    });

    /**
     * The mirror hazard: paying an order that has been cancelled.
     *
     * Payment initiation checks the order status inside its own transaction, so a cancelled
     * order is not payable. Without that, a customer could cancel and then pay, ending up with
     * a cancelled order that had been charged.
     */
    it('cannot be paid for after cancellation', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      expect((await cancel(harness, { token, orderNumber })).status).toBe(200);

      const response = await pay(harness, { token, orderNumber });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('ORDER_NOT_PAYABLE');
      expect(await db().select().from(payment)).toEqual([]);
    });
  });

  /* ══ Ownership and shape ═══════════════════════════════════════════════ */

  /* ── Reservation release ───────────────────────────────────────────────── */

  describe('reservation release', () => {
    const reservations = () => db().select().from(stockReservation);
    const stockFor = async (skuId: string) => {
      const [row] = await db().select().from(stockItem).where(eq(stockItem.skuId, skuId));
      return row;
    };

    it('gives the held stock back and records why', async () => {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });

      const before = await reservations();
      expect(before).toHaveLength(1);
      expect(before[0]?.status).toBe('held');
      expect((await stockFor(before[0]!.skuId))?.reserved).toBe(1);

      const response = await cancel(harness, {
        token: auth.token,
        orderNumber: placed.orderNumber,
      });
      expect(response.status).toBe(200);

      const after = await reservations();
      expect(after).toHaveLength(1);
      expect(after[0]?.status).toBe('released');
      expect(after[0]?.settledReason).toBe('order_cancelled');
      expect(after[0]?.settledAt).not.toBeNull();
      /* The row is RETAINED, not deleted — the history of stock that was taken. */
      expect(after[0]?.quantity).toBe(1);

      const stock = await stockFor(after[0]!.skuId);
      expect(stock?.reserved).toBe(0);
      expect(stock?.available).toBe(stock!.onHand);
    });

    /**
     * A second cancellation must not release twice.
     *
     * Two independent guards make that true: the order status CAS refuses it, and the release
     * itself is a CAS on `status = 'held'`. The `settled_at` assertion is the one that proves
     * the second attempt changed nothing — a blind re-stamp would move it.
     */
    it('does not release twice on a repeated cancellation', async () => {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });

      expect(
        (await cancel(harness, { token: auth.token, orderNumber: placed.orderNumber })).status,
      ).toBe(200);
      const [first] = await reservations();
      const settledAt = first!.settledAt;

      const second = await cancel(harness, {
        token: auth.token,
        orderNumber: placed.orderNumber,
      });
      expect(second.status).toBe(409);

      const [after] = await reservations();
      expect(after?.settledAt).toEqual(settledAt);
      expect((await stockFor(after!.skuId))?.reserved).toBe(0);
    });

    /**
     * Releasing is idempotent at the service level too, not only behind the order CAS.
     *
     * Called directly and twice, so the order-status guard is out of the picture entirely and
     * the reservation CAS is the only thing preventing a double decrement. A mutant that drops
     * the `status = 'held'` predicate dies exactly here.
     */
    it('is a no-op when the service releases an order twice', async () => {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });
      const [held] = await reservations();

      const release = async () =>
        withTransaction(db(), silentLogger, async () =>
          harness.inventory.releaseForOrder({
            orderId: placed.orderId,
            storeId,
            reason: 'order_cancelled',
          }),
        );

      await release();
      expect((await stockFor(held!.skuId))?.reserved).toBe(0);

      await release();
      expect((await stockFor(held!.skuId))?.reserved).toBe(0);
    });

    /**
     * A COMMITTED reservation is never released.
     *
     * Committed first, then released — the release must find no `held` row and leave the
     * counter alone. This is what stops a cancellation racing a payment success from giving
     * away stock that has been sold.
     */
    it('never releases a committed reservation', async () => {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });
      const [held] = await reservations();

      await withTransaction(db(), silentLogger, async () =>
        harness.inventory.commitForOrder({ orderId: placed.orderId, storeId }),
      );
      expect((await reservations())[0]?.status).toBe('committed');
      /* Commit deliberately moves NO counter: the units are sold, not returned. */
      expect((await stockFor(held!.skuId))?.reserved).toBe(1);

      await withTransaction(db(), silentLogger, async () =>
        harness.inventory.releaseForOrder({
          orderId: placed.orderId,
          storeId,
          reason: 'order_cancelled',
        }),
      );

      const after = await reservations();
      expect(after[0]?.status).toBe('committed');
      expect(after[0]?.settledReason).toBe('payment_succeeded');
      expect((await stockFor(held!.skuId))?.reserved).toBe(1);
    });

    /** Committing twice is a no-op, for the same CAS reason. */
    it('does not commit twice', async () => {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });

      const commit = async () =>
        withTransaction(db(), silentLogger, async () =>
          harness.inventory.commitForOrder({ orderId: placed.orderId, storeId }),
        );

      await commit();
      const [first] = await reservations();
      const settledAt = first!.settledAt;

      await commit();
      const [after] = await reservations();
      expect(after?.settledAt).toEqual(settledAt);
      expect(after?.status).toBe('committed');
    });
  });

  describe('authorization and validation', () => {
    it('rejects an unauthenticated cancellation', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
        .send();
      expect(response.status).toBe(401);

      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');
    });

    it("returns 404 for another customer's order, not 403", async () => {
      const harness = build();
      const ada = await signIn(harness, 'ada@example.com');
      const { orderNumber } = await givenOrder(harness, {
        token: ada.token,
        userId: ada.userId,
      });

      const bob = await signIn(harness, 'bob@example.com');
      const response = await cancel(harness, { token: bob.token, orderNumber });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');

      const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
      expect(row!.status).toBe('placed');
    });

    it('rejects a malformed order number', async () => {
      const harness = build();
      const { token } = await signIn(harness);

      expect((await cancel(harness, { token, orderNumber: 'not-an-order' })).status).toBe(400);
    });

    it('returns 404 for an order that does not exist', async () => {
      const harness = build();
      const { token } = await signIn(harness);

      const response = await cancel(harness, { token, orderNumber: 'ORD-20260907-ZZZZZZ' });
      expect(response.status).toBe(404);
    });

    /** No body is accepted: there is nothing a client could usefully supply. */
    it('ignores any body sent with the request', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderNumber } = await givenOrder(harness, { token, userId });

      const response = await request(harness.app)
        .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
        .set('authorization', `Bearer ${token}`)
        .send({ reason: 'changed my mind', status: 'refunded' });

      /* Accepted and ignored — the route validates params only. */
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('cancelled');
    });
  });

  /* ══ The database refuses what the service would ═══════════════════════ */

  /**
   * Assert a write was refused BY A NAMED CONSTRAINT.
   *
   * Naming it matters: a constraint test that only asserts "the write failed" passes when a
   * DIFFERENT constraint fired first, which is the recurring §43 finding. The cause chain is
   * walked because Drizzle wraps the driver error.
   */
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

  /* ── stock_reservation constraints ─────────────────────────────────────── */

  /**
   * The reservation table's own invariants, asserted at the DATABASE.
   *
   * Every case names the constraint it expects and isolates the row so a DIFFERENT constraint
   * cannot fire first — the trap §43 recorded, where a constraint test passes while proving
   * nothing.
   *
   * These probe the MIGRATION, not the Drizzle schema file: the test database is built from
   * `src/db/migrations`, so a probe that edits the schema file is a no-op.
   */
  describe('reservation constraints', () => {
    /**
     * A REAL placed order, through checkout.
     *
     * Both composite FKs are RESTRICT and `order` itself has a foreign key to `cart`, so a
     * hand-rolled row fought the order-number format CHECK and the cart key. Going through the
     * front door is shorter and truer to what the constraints will actually see.
     *
     * Checkout already reserved, so the reservation it created is cleared here and each test
     * then writes the malformed row it is actually about.
     */
    async function givenOrderRow() {
      const harness = build();
      const auth = await signIn(harness);
      const placed = await givenOrder(harness, { token: auth.token, userId: auth.userId });
      const [existing] = await db().select().from(stockReservation);
      await db().delete(stockReservation);
      return { orderId: placed.orderId, skuId: existing!.skuId };
    }
    const held = (over: Record<string, unknown> = {}) => ({
      storeId,
      quantity: 1,
      status: 'held',
      ...over,
    });

    it('refuses a quantity below one', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(held({ orderId, skuId, quantity: 0 }) as never),
        'ck_stock_reservation_quantity',
      );
    });

    /** The ceiling mirrors `ck_order_line_quantity`, so the two can never disagree. */
    it('refuses a quantity above the order-line ceiling', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(held({ orderId, skuId, quantity: 1000 }) as never),
        'ck_stock_reservation_quantity',
      );
    });

    it('refuses a status outside the lifecycle', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              status: 'pending',
              /*
               * The settlement pair must be COHERENT, or `ck_stock_reservation_settled_at`
               * fires first and this test passes while proving nothing about the vocabulary.
               */
              heldAt: new Date(Date.now() - 60_000),
              settledAt: new Date(),
              settledReason: 'order_cancelled',
            }) as never,
          ),
        'ck_stock_reservation_status',
      );
    });

    /**
     * Held and settled are mutually exclusive, and the CHECK enforces it BOTH ways. Two
     * separate assertions because two separate constraints — a combined one would make these
     * two different bugs indistinguishable.
     */
    it('refuses a HELD row that carries a settlement timestamp', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              /* Pinned earlier, or `ck_stock_reservation_settled_after_held` fires first. */
              heldAt: new Date(Date.now() - 60_000),
              settledAt: new Date(),
            }) as never,
          ),
        'ck_stock_reservation_settled_at',
      );
    });

    it('refuses a SETTLED row with no settlement timestamp', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              status: 'released',
              settledReason: 'order_cancelled',
            }) as never,
          ),
        'ck_stock_reservation_settled_at',
      );
    });

    it('refuses a settled row with no reason', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              status: 'released',
              /* `held_at` defaults to the DB's now(), which is AFTER a Date built here. */
              heldAt: new Date(Date.now() - 60_000),
              settledAt: new Date(),
            }) as never,
          ),
        'ck_stock_reservation_settled_reason',
      );
    });

    /** The reason vocabulary is TECHNICAL: one value per code path, nothing accounting-shaped. */
    it('refuses a reason outside the approved vocabulary', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              status: 'released',
              settledAt: new Date(),
              settledReason: 'refunded',
            }) as never,
          ),
        'ck_stock_reservation_reason_values',
      );
    });

    it('refuses a settlement earlier than its hold', async () => {
      const { orderId, skuId } = await givenOrderRow();
      const now = new Date();

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(
            held({
              orderId,
              skuId,
              status: 'released',
              heldAt: now,
              settledAt: new Date(now.getTime() - 1_000),
              settledReason: 'order_cancelled',
            }) as never,
          ),
        'ck_stock_reservation_settled_after_held',
      );
    });

    /**
     * One reservation per order per SKU, structurally — the free idempotency backstop. A code
     * path that reserved twice for one order fails here rather than double-counting units.
     */
    it('refuses TWO reservations for the same order and SKU', async () => {
      const { orderId, skuId } = await givenOrderRow();

      await db()
        .insert(stockReservation)
        .values(held({ orderId, skuId }) as never);

      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(held({ orderId, skuId, quantity: 2 }) as never),
        'pk_stock_reservation',
      );
    });

    /**
     * Tenancy is structural: a reservation cannot name another store's order.
     *
     * The other store must actually EXIST. A random UUID trips the plain
     * `stock_reservation_store_id_store_id_fk` first, which proves only that stores are real —
     * not that the ORDER has to belong to the store the reservation claims.
     */
    it('refuses a reservation claiming the wrong store', async () => {
      const { orderId, skuId } = await givenOrderRow();
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other-res', name: 'Other', isActive: true });

      /*
       * One `store_id` column feeds BOTH composite keys, so a wrong store violates the order's
       * and the SKU's at once and which PostgreSQL reports is not a guaranteed order. Asserting
       * the shared prefix keeps this deterministic while still proving a composite key refused
       * it — not the plain store key, and not a CHECK.
       */
      await expectConstraint(
        db()
          .insert(stockReservation)
          .values(held({ orderId, skuId, storeId: otherStoreId }) as never),
        'fk_stock_reservation_',
      );
    });

    /**
     * `RESTRICT`, not `CASCADE`: a hard delete of a SKU with reservations must fail loudly
     * rather than quietly discarding the record of stock that was taken.
     */
    it('refuses a HARD delete of a SKU that has a reservation', async () => {
      const { orderId, skuId } = await givenOrderRow();
      await db()
        .insert(stockReservation)
        .values(held({ orderId, skuId }) as never);

      /*
       * `stock_item` references `sku` too and fires first, so its row goes before the
       * assertion — otherwise this passes on the WRONG key, the §43 trap again.
       */
      await db().delete(stockItem).where(eq(stockItem.skuId, skuId));
      /*
       * FOUR keys reference `sku`: stock_item, cart_line, order_line and ours. The other three
       * are cleared so the assertion is about the key it names — the §43 trap, where a test
       * passes because a different constraint fired first.
       */
      await db().delete(cartLine);
      await db().delete(orderLine);

      await expectConstraint(
        db().delete(sku).where(eq(sku.id, skuId)),
        'fk_stock_reservation_sku_store',
      );
    });
  });

  describe('database constraints', () => {
    it('permits only placed and cancelled as a status', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderId } = await givenOrder(harness, { token, userId });

      await expect(
        testDb.handle.pool.query('UPDATE "order" SET status = $1 WHERE id = $2', ['paid', orderId]),
      ).rejects.toThrow(/ck_order_status/);

      /* Both legal values are accepted. */
      await testDb.handle.pool.query('UPDATE "order" SET status = $1 WHERE id = $2', [
        'cancelled',
        orderId,
      ]);
      await testDb.handle.pool.query('UPDATE "order" SET status = $1 WHERE id = $2', [
        'placed',
        orderId,
      ]);
    });

    it('permits only placed and cancelled in the history', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderId } = await givenOrder(harness, { token, userId });

      await expect(
        testDb.handle.pool.query(
          `INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_type)
           VALUES ($1, $2, $3, 'placed', 'refunded', 'system')`,
          [newId(), orderId, storeId],
        ),
      ).rejects.toThrow(/ck_order_status_history_to_status/);

      await expect(
        testDb.handle.pool.query(
          `INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_type)
           VALUES ($1, $2, $3, 'shipped', 'cancelled', 'system')`,
          [newId(), orderId, storeId],
        ),
      ).rejects.toThrow(/ck_order_status_history_from_status/);
    });

    it('still refuses a transition to the state it came from', async () => {
      const harness = build();
      const { token, userId } = await signIn(harness);
      const { orderId } = await givenOrder(harness, { token, userId });

      await expect(
        testDb.handle.pool.query(
          `INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_type)
           VALUES ($1, $2, $3, 'cancelled', 'cancelled', 'system')`,
          [newId(), orderId, storeId],
        ),
      ).rejects.toThrow(/ck_order_status_history_progresses/);
    });
  });
});
