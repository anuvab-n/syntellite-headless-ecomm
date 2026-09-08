import { createHmac } from 'node:crypto';

import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdempotencyStore } from '../../../db/idempotency/idempotency.repository.js';
import { address } from '../../../db/schema/address.js';
import { product } from '../../../db/schema/catalogue.js';
import { auditLog } from '../../../db/schema/identity.js';
import { order, orderStatusHistory } from '../../../db/schema/orders.js';
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
import { giveSku } from '../../../../tests/helpers/catalogue.ts';
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
      payments: { stateForOrder: (input) => payments.stateForOrder(input) },
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
      gateway: createRazorpayGateway({
        credentials: CREDENTIALS,
        logger: silentLogger,
        fetchImpl,
      }),
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
