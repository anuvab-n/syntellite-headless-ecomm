import { createHmac } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { order, orderLine } from '../../../db/schema/orders.js';
import { payment } from '../../../db/schema/payments.js';
import { refund } from '../../../db/schema/refunds.js';
import { stockItem, stockLedger } from '../../../db/schema/inventory.js';
import { returnRequest } from '../../../db/schema/returns.js';
import { shipment } from '../../../db/schema/shipments.js';
import { address } from '../../../db/schema/address.js';
import { cart } from '../../../db/schema/cart.js';
import { store } from '../../../db/schema/store.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * Increment 59 — refunds, and the return lifecycle that spends them.
 *
 * Against the REAL composition root, real PostgreSQL and real Redis. The provider is the only
 * stub, scoped to `api.razorpay.com`, and it is stubbed rather than mocked at the port so that
 * the adapter's own three-way outcome mapping — 4xx is failure, 5xx is silence — is exercised
 * rather than assumed.
 *
 * Five properties carry this suite, and each is asserted against an independent derivation
 * rather than against a second call into the same code:
 *
 *  1. **Σ(claimed refunds) ≤ captured.** Under sequential partials, under an exact-to-the-paisa
 *     final refund, and under two simultaneous requests for the same remaining balance.
 *  2. **An unknown provider outcome is neither success nor failure.** It persists as
 *     `processing`, it keeps consuming balance, and it does not complete the return.
 *  3. **Payment status never moves.** Asserted directly against the column after every path.
 *  4. **Restock happens exactly once**, proven against the `stock_ledger` rather than against
 *     the projection, because the ledger is the thing that cannot be made to agree with itself.
 *  5. **Reservations are untouched**, because a returned unit was shipped and its reservation
 *     was settled at fulfilment.
 */
describe('refunds and return completion (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let staffId = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const PRICE = '500.0000';
  let fixtureSeq = 0;

  const CREDENTIALS = {
    keyId: 'rzp_test_publishable',
    keySecret: 'the-api-secret-never-published',
    webhookSecret: 'the-webhook-secret-never-published',
  };

  /**
   * What the stubbed provider does on the NEXT refund call.
   *
   * A mutable switch rather than a per-test stub, so every test drives the same adapter through
   * the same code path and only the provider's answer differs — which is exactly the variable
   * under test.
   */
  type RefundBehaviour =
    | { kind: 'ok' }
    | { kind: 'status'; status: number }
    | { kind: 'unparseable' }
    | { kind: 'network' };

  let refundBehaviour: RefundBehaviour = { kind: 'ok' };

  /** Every refund request the provider received, so a duplicate call is detectable. */
  const refundCalls: { url: string; body: string; idempotency: string | null }[] = [];

  let refCounter = 0;
  let refundCounter = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });

  const sign = (body: string): string =>
    createHmac('sha256', CREDENTIALS.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    /*
     * Scoped to the provider's host, exactly as `admin-payment-detail` scopes it. A blanket
     * stub would silently break Testcontainers and anything else that fetches, and this suite
     * would not be the place that reported it.
     */
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : ((input as { url?: string }).url ?? '');

      if (!url.includes('api.razorpay.com')) return realFetch(...args);

      if (url.includes('/refund')) {
        const headers = new Headers(init?.headers);
        refundCalls.push({
          url,
          body: typeof init?.body === 'string' ? init.body : '',
          idempotency: headers.get('x-razorpay-idempotency'),
        });

        if (refundBehaviour.kind === 'network') throw new Error('socket hang up');
        if (refundBehaviour.kind === 'status') {
          return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR' } }), {
            status: refundBehaviour.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (refundBehaviour.kind === 'unparseable') {
          return new Response(JSON.stringify({ nothing: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        refundCounter += 1;
        return new Response(
          JSON.stringify({ id: `rfnd_STUB${String(refundCounter).padStart(4, '0')}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      refCounter += 1;
      return new Response(
        JSON.stringify({ id: `order_STUB${String(refCounter).padStart(4, '0')}` }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '4000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '4000',
          RAZORPAY_KEY_ID: CREDENTIALS.keyId,
          RAZORPAY_KEY_SECRET: CREDENTIALS.keySecret,
          RAZORPAY_WEBHOOK_SECRET: CREDENTIALS.webhookSecret,
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    const staff = await signIn({ staff: true });
    staffToken = staff.token;
    staffId = staff.id;
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function signIn(options: { staff?: boolean } = {}): Promise<{ token: string; id: string }> {
    const email = `${options.staff === true ? 'ops' : 'buyer'}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'A', lastName: 'B' },
    });
    if (options.staff === true) {
      /* No endpoint grants staff: that would be a privilege-escalation route on a public API. */
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { token: login.body.accessToken as string, id: user.id };
  }

  /**
   * A DELIVERED, PAID order, built through the real APIs end to end.
   *
   * `method` decides whether the payment goes through the gateway (and therefore whether a
   * refund can reach a provider) or is COD (and therefore manual). Everything else is identical,
   * which is what makes the two paths comparable.
   */
  async function givenDeliveredPaidOrder(options: { method: 'online' | 'cod'; quantity?: number }) {
    const quantity = options.quantity ?? 3;
    const buyer = await signIn();
    const seq = (fixtureSeq += 1);
    const slug = `rfnd-p-${String(seq)}`;
    const skuCode = `RFND-SKU-${String(seq)}`;
    const buyerHeaders = { Authorization: `Bearer ${buyer.token}` };

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff())
          .send({ slug, name: 'Tee', status: 'active' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`/api/v1/admin/products/${slug}/skus`)
          .set(asStaff())
          .send({ code: skuCode, price: PRICE })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff())
          .send({ skuCode, delta: 50, reason: 'manual_increase' })
      ).status,
    ).toBe(201);

    expect(
      (
        await api()
          .put(`/api/v1/users/me/cart/items/${skuCode}`)
          .set(buyerHeaders)
          .send({ quantity })
      ).status,
    ).toBe(200);

    const address = await api().post('/api/v1/users/me/addresses').set(buyerHeaders).send({
      label: 'Home',
      recipientName: 'A B',
      phone: '+91 9876543210',
      line1: '1 Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560025',
    });
    expect(address.status).toBe(201);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(buyerHeaders)
      .set('idempotency-key', `co-${newId()}`)
      .send({ addressId: address.body.address.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));

    const initiated = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(buyerHeaders)
      .set('idempotency-key', `pay-${newId()}`)
      .send({ method: options.method });
    expect(initiated.status).toBe(201);

    if (options.method === 'online') {
      const providerRef = initiated.body.handoff.providerRef as string;
      const chargeId = `pay_CHG${String(seq).padStart(5, '0')}`;
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: chargeId, order_id: providerRef } } },
      });
      const hook = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt_${newId()}`)
        .send(body);
      expect(hook.status).toBe(200);
    }

    /* Ship and deliver through the real fulfilment API, so the reservation settles properly. */
    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart', trackingNumber: `BD-${String(seq)}` });
    expect(created.status).toBe(201);
    const shipmentId = created.body.shipment.id as string;

    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/ship`).set(asStaff()).send({}))
        .status,
    ).toBe(200);
    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/deliver`).set(asStaff()).send({}))
        .status,
    ).toBe(200);

    /*
     * Backdate the whole shipment so the seven-day return window is open on an order that
     * still looks real. BOTH instants move — `ck_shipment_delivered_after_shipped` rightly
     * refuses a delivery that precedes its own despatch.
     */
    await db()
      .update(shipment)
      .set({
        shippedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .where(eq(shipment.id, shipmentId));

    const [line] = await db().select().from(orderLine).where(eq(orderLine.orderId, row!.id));

    return {
      buyerToken: buyer.token,
      orderNumber,
      orderId: row!.id,
      skuCode,
      skuId: line!.skuId,
      grandTotal: row!.grandTotal,
    };
  }

  /** A return sitting in `inspected`, ready to complete. */
  async function givenInspectedReturn(options: {
    method: 'online' | 'cod';
    quantity?: number;
    restock?: number;
  }) {
    const ctx = await givenDeliveredPaidOrder({ method: options.method, quantity: 3 });
    const quantity = options.quantity ?? 1;
    const restock = options.restock ?? quantity;

    const created = await api()
      .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
      .set({ Authorization: `Bearer ${ctx.buyerToken}` })
      .set('idempotency-key', `ret-${newId()}`)
      .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity }] });
    expect(created.status).toBe(201);

    const returnNumber = created.body.return.returnNumber as string;

    expect((await act(returnNumber, 'approve')).status).toBe(200);
    expect((await act(returnNumber, 'receive')).status).toBe(200);
    const inspected = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/inspect`)
      .set(asStaff())
      .send({
        lines: [
          { skuCode: ctx.skuCode, restockQuantity: restock, writeOffQuantity: quantity - restock },
        ],
      });
    expect(inspected.status).toBe(200);

    return { ...ctx, returnNumber, refundTotal: inspected.body.return.refundTotal as string };
  }

  const act = (returnNumber: string, action: string, body: object = {}) =>
    api().post(`/api/v1/admin/returns/${returnNumber}/${action}`).set(asStaff()).send(body);

  const refundOrder = (orderNumber: string, amount: string, key = `rf-${newId()}`) =>
    api()
      .post(`/api/v1/admin/orders/${orderNumber}/refund`)
      .set(asStaff())
      .set('idempotency-key', key)
      .send({ amount });

  const paymentOf = async (orderId: string) => {
    const [row] = await db().select().from(payment).where(eq(payment.orderId, orderId));
    return row!;
  };

  const refundsOf = async (orderId: string) =>
    db().select().from(refund).where(eq(refund.orderId, orderId));

  /* ══ 1. The refund aggregate and the balance invariant ═════════════════ */

  describe('the refundable balance', () => {
    it('refunds part of a captured payment and reports what is left', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      const response = await refundOrder(ctx.orderNumber, '100.0000');

      expect(response.status).toBe(201);
      expect(response.body.refund.status).toBe('succeeded');
      expect(response.body.refund.mode).toBe('provider');
      expect(response.body.refund.amount).toBe('100.0000');
      expect(response.body.refund.providerRefundId).toMatch(/^rfnd_STUB\d{4}$/);

      /* Derived independently from the order's own total, not read back from the response. */
      const expectedRemaining = (Number.parseFloat(ctx.grandTotal) - 100).toFixed(4);
      expect(response.body.refundBalance.captured).toBe(ctx.grandTotal);
      expect(response.body.refundBalance.refunded).toBe('100.0000');
      expect(response.body.refundBalance.remaining).toBe(expectedRemaining);
    });

    it('accumulates partial refunds and refuses the one that would exceed the balance', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      expect((await refundOrder(ctx.orderNumber, '100.0000')).status).toBe(201);
      expect((await refundOrder(ctx.orderNumber, '200.0000')).status).toBe(201);

      const remaining = (Number.parseFloat(ctx.grandTotal) - 300).toFixed(4);

      /* One paisa more than remains. */
      const over = await refundOrder(
        ctx.orderNumber,
        (Number.parseFloat(remaining) + 0.0001).toFixed(4),
      );
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');
      expect(over.body.error.details.remaining).toBe(remaining);

      /* And exactly the remainder is allowed, to the paisa. */
      const exact = await refundOrder(ctx.orderNumber, remaining);
      expect(exact.status).toBe(201);
      expect(exact.body.refundBalance.remaining).toBe('0.0000');

      /* Σ succeeded === captured, derived from the rows rather than from the last response. */
      const rows = await refundsOf(ctx.orderId);
      const settled = rows
        .filter((row) => row.status === 'succeeded')
        .reduce((total, row) => total + Number.parseFloat(row.amount), 0);
      expect(settled.toFixed(4)).toBe(ctx.grandTotal);
    });

    it('refuses any refund once the balance is exhausted', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      expect((await refundOrder(ctx.orderNumber, ctx.grandTotal)).status).toBe(201);

      const again = await refundOrder(ctx.orderNumber, '0.0001');
      expect(again.status).toBe(422);
      expect(again.body.error.details.remaining).toBe('0.0000');
    });

    it('refuses a refund against a payment that never succeeded', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      /* Force the payment back to pending, the state a never-captured payment holds. */
      await db().update(payment).set({ status: 'pending' }).where(eq(payment.orderId, ctx.orderId));

      const response = await refundOrder(ctx.orderNumber, '1.0000');
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
      expect(response.body.error.details.reason).toBe('payment_not_captured');
    });

    it('rejects a zero, negative, over-precise or non-numeric amount', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });

      const zero = await refundOrder(ctx.orderNumber, '0.0000');
      expect(zero.status).toBe(422);
      expect(zero.body.error.details.reason).toBe('amount_not_positive');

      for (const amount of ['-1.0000', '1.00000', 'abc', '1e3', '']) {
        const response = await refundOrder(ctx.orderNumber, amount);
        expect(response.status, amount).toBe(400);
      }
    });

    it('rejects an unknown body field rather than ignoring it', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      const response = await api()
        .post(`/api/v1/admin/orders/${ctx.orderNumber}/refund`)
        .set(asStaff())
        .set('idempotency-key', `rf-${newId()}`)
        .send({ amount: '1.0000', currency: 'USD', paymentId: newId() });

      expect(response.status).toBe(400);
    });
  });

  /* ══ 2. Provider outcomes ═════════════════════════════════════════════ */

  describe('provider outcomes', () => {
    it('records a 4xx as a FAILED refund, which frees the balance again', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 400 };

      const response = await refundOrder(ctx.orderNumber, '100.0000');
      expect(response.status).toBe(201);
      expect(response.body.refund.status).toBe('failed');
      expect(response.body.refund.failureCode).toBe('http_400');
      expect(response.body.refund.providerRefundId).toBeNull();

      /* A failure is evidence, so the amount is released and the whole total is refundable. */
      expect(response.body.refundBalance.refunded).toBe('0.0000');
      expect(response.body.refundBalance.remaining).toBe(ctx.grandTotal);

      /* And a retry is allowed. */
      refundBehaviour = { kind: 'ok' };
      expect((await refundOrder(ctx.orderNumber, '100.0000')).status).toBe(201);
    });

    it('records a 5xx as PROCESSING, and keeps the balance claimed', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 503 };

      const response = await refundOrder(ctx.orderNumber, '100.0000');
      expect(response.status).toBe(201);
      expect(response.body.refund.status).toBe('processing');
      expect(response.body.refund.providerRefundId).toBeNull();

      /*
       * The point of the whole increment: nothing went back as far as we know, but the amount
       * is still claimed — so nobody can refund around an attempt that may have succeeded.
       */
      expect(response.body.refundBalance.refunded).toBe('0.0000');
      expect(response.body.refundBalance.claimed).toBe('100.0000');
      expect(response.body.refundBalance.remaining).toBe(
        (Number.parseFloat(ctx.grandTotal) - 100).toFixed(4),
      );
    });

    it('treats a network failure and an unparseable 200 as PROCESSING, never as failure', async () => {
      for (const behaviour of [{ kind: 'network' } as const, { kind: 'unparseable' } as const]) {
        const ctx = await givenDeliveredPaidOrder({ method: 'online' });
        refundBehaviour = behaviour;

        const response = await refundOrder(ctx.orderNumber, '50.0000');
        expect(response.status, behaviour.kind).toBe(201);
        expect(response.body.refund.status, behaviour.kind).toBe('processing');
        expect(response.body.refund.settledAt, behaviour.kind).toBeNull();
      }
    });

    it('sends the CHARGE id and our refund id as the provider idempotency reference', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      refundCalls.length = 0;

      expect((await refundOrder(ctx.orderNumber, '10.0000')).status).toBe(201);

      expect(refundCalls).toHaveLength(1);
      const call = refundCalls[0]!;

      /* The provider CHARGE (`pay_…`), never the provider ORDER (`order_…`) nor our UUID. */
      const pay = await paymentOf(ctx.orderId);
      expect(call.url).toContain(`/payments/${pay.providerTransactionId!}/refund`);
      expect(call.url).not.toContain(pay.providerRef!);
      expect(call.url).not.toContain(pay.id);

      /*
       * Minor units, converted once by money.ts — 10.0000 INR is 1000 paise — plus the note
       * carrying our own refund id. Increment 60 added `notes`: Razorpay echoes it on every
       * later refund entity, which is what lets a `refund.processed` notification name the
       * attempt it resolves. The header below is not echoed, so it cannot serve.
       */
      const [row] = await refundsOf(ctx.orderId);
      expect(JSON.parse(call.body)).toEqual({ amount: 1000, notes: { refund_id: row!.id } });

      /* The idempotency reference is our refund row's id, so a retry returns the original. */
      expect(call.idempotency).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('does not call the provider at all for a manual refund', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'cod' });
      refundCalls.length = 0;

      const response = await refundOrder(ctx.orderNumber, '100.0000');
      expect(response.status).toBe(201);
      expect(response.body.refund.mode).toBe('manual');
      expect(response.body.refund.status).toBe('pending');
      expect(response.body.refund.provider).toBeNull();
      expect(refundCalls).toHaveLength(0);
    });
  });

  /* ══ 3. Payment state is never touched ════════════════════════════════ */

  describe('payment state preservation', () => {
    it('leaves payment.status at succeeded through every refund outcome', async () => {
      for (const behaviour of [
        { kind: 'ok' } as const,
        { kind: 'status', status: 400 } as const,
        { kind: 'status', status: 500 } as const,
      ]) {
        const ctx = await givenDeliveredPaidOrder({ method: 'online' });
        const before = await paymentOf(ctx.orderId);
        expect(before.status).toBe('succeeded');

        refundBehaviour = behaviour;
        expect((await refundOrder(ctx.orderNumber, '100.0000')).status).toBe(201);

        const after = await paymentOf(ctx.orderId);
        expect(after.status, behaviour.kind).toBe('succeeded');
        expect(after.amount, behaviour.kind).toBe(before.amount);
        expect(after.providerTransactionId, behaviour.kind).toBe(before.providerTransactionId);
      }
    });

    it('leaves a COD payment untouched when a manual refund is raised and settled', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'cod' });
      const before = await paymentOf(ctx.orderId);

      const raised = await refundOrder(ctx.orderNumber, '100.0000');
      expect(raised.status).toBe(201);

      const settled = await api()
        .post(`/api/v1/admin/refunds/${raised.body.refund.refundNumber}/settle`)
        .set(asStaff())
        .send({});
      expect(settled.status).toBe(200);
      expect(settled.body.refund.status).toBe('succeeded');

      const after = await paymentOf(ctx.orderId);
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });

  /* ══ 4. Manual settlement ═════════════════════════════════════════════ */

  describe('manual settlement', () => {
    it('refuses to settle a PROVIDER refund', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 500 };
      const raised = await refundOrder(ctx.orderNumber, '100.0000');
      expect(raised.body.refund.status).toBe('processing');

      const response = await api()
        .post(`/api/v1/admin/refunds/${raised.body.refund.refundNumber}/settle`)
        .set(asStaff())
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('REFUND_NOT_SETTLEABLE');
    });

    it('refuses a second settlement of the same manual refund', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'cod' });
      const raised = await refundOrder(ctx.orderNumber, '100.0000');
      const path = `/api/v1/admin/refunds/${raised.body.refund.refundNumber}/settle`;

      expect((await api().post(path).set(asStaff()).send({})).status).toBe(200);
      expect((await api().post(path).set(asStaff()).send({})).status).toBe(409);
    });

    it('rejects a malformed refund number with 400, and an unknown one with 404', async () => {
      expect(
        (await api().post('/api/v1/admin/refunds/not-a-number/settle').set(asStaff()).send({}))
          .status,
      ).toBe(400);
      expect(
        (
          await api()
            .post('/api/v1/admin/refunds/RFD-20260101-ABCDEF/settle')
            .set(asStaff())
            .send({})
        ).status,
      ).toBe(404);
    });
  });

  /* ══ 5. Idempotency ═══════════════════════════════════════════════════ */

  describe('idempotency', () => {
    it('replays the same key rather than refunding twice', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      const key = `rf-${newId()}`;

      const first = await refundOrder(ctx.orderNumber, '100.0000', key);
      const second = await refundOrder(ctx.orderNumber, '100.0000', key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);

      /* One row, and the balance moved once. */
      const rows = await refundsOf(ctx.orderId);
      expect(rows).toHaveLength(1);
    });

    it('rejects a reused key carrying a different amount', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      const key = `rf-${newId()}`;

      expect((await refundOrder(ctx.orderNumber, '100.0000', key)).status).toBe(201);
      const second = await refundOrder(ctx.orderNumber, '200.0000', key);
      expect(second.status).toBe(422);
    });

    it('requires an idempotency key', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      const response = await api()
        .post(`/api/v1/admin/orders/${ctx.orderNumber}/refund`)
        .set(asStaff())
        .send({ amount: '1.0000' });

      expect(response.status).toBe(400);
    });

    it('lets two simultaneous refunds of the whole balance settle to exactly one', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      const [a, b] = await Promise.all([
        refundOrder(ctx.orderNumber, ctx.grandTotal),
        refundOrder(ctx.orderNumber, ctx.grandTotal),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(201);
      /* The loser is refused — either by the balance check or as an in-flight conflict. */
      expect([409, 422]).toContain(statuses[1]);

      /* Whatever the shape of the refusal, the money invariant holds. */
      const rows = await refundsOf(ctx.orderId);
      const claimed = rows
        .filter((row) => row.status !== 'failed')
        .reduce((total, row) => total + Number.parseFloat(row.amount), 0);
      expect(claimed).toBeLessThanOrEqual(Number.parseFloat(ctx.grandTotal));
    });
  });

  /* ══ 6. Return lifecycle ══════════════════════════════════════════════ */

  describe('return lifecycle', () => {
    it('walks approved → received → inspected → completed', async () => {
      const ctx = await givenInspectedReturn({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      const completed = await act(ctx.returnNumber, 'complete');
      expect(completed.status).toBe(200);
      expect(completed.body.return.status).toBe('completed');
      expect(completed.body.refunds).toHaveLength(1);
      expect(completed.body.refunds[0].status).toBe('succeeded');
      expect(completed.body.refunds[0].amount).toBe(ctx.refundTotal);
    });

    it('refuses every out-of-order transition with 409', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      const created = await api()
        .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
        .set({ Authorization: `Bearer ${ctx.buyerToken}` })
        .set('idempotency-key', `ret-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity: 1 }] });
      const rn = created.body.return.returnNumber as string;

      /* From `requested`: receive, inspect and complete are all illegal. */
      expect((await act(rn, 'receive')).status).toBe(409);
      expect(
        (
          await api()
            .post(`/api/v1/admin/returns/${rn}/inspect`)
            .set(asStaff())
            .send({ lines: [{ skuCode: ctx.skuCode, restockQuantity: 1, writeOffQuantity: 0 }] })
        ).status,
      ).toBe(409);
      expect((await act(rn, 'complete')).status).toBe(409);

      expect((await act(rn, 'approve')).status).toBe(200);
      /* From `approved`: complete is still illegal. */
      expect((await act(rn, 'complete')).status).toBe(409);

      expect((await act(rn, 'receive')).status).toBe(200);
      /* From `received`: a second receive is illegal. */
      expect((await act(rn, 'receive')).status).toBe(409);
    });

    it('preserves the existing reject path from received', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      const created = await api()
        .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
        .set({ Authorization: `Bearer ${ctx.buyerToken}` })
        .set('idempotency-key', `ret-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity: 1 }] });
      const rn = created.body.return.returnNumber as string;

      expect((await act(rn, 'approve')).status).toBe(200);
      expect((await act(rn, 'receive')).status).toBe(200);

      const rejected = await act(rn, 'reject', { staffNote: 'not as described' });
      expect(rejected.status).toBe(200);
      expect(rejected.body.return.status).toBe('rejected');

      /* Nothing was refunded and nothing restocked. */
      expect(await refundsOf(ctx.orderId)).toHaveLength(0);
    });

    it('refuses an inspection that does not account for every returned unit', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      const created = await api()
        .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
        .set({ Authorization: `Bearer ${ctx.buyerToken}` })
        .set('idempotency-key', `ret-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity: 2 }] });
      const rn = created.body.return.returnNumber as string;
      await act(rn, 'approve');
      await act(rn, 'receive');

      const inspect = (lines: unknown) =>
        api().post(`/api/v1/admin/returns/${rn}/inspect`).set(asStaff()).send({ lines });

      /* One unit short. */
      const short = await inspect([
        { skuCode: ctx.skuCode, restockQuantity: 1, writeOffQuantity: 0 },
      ]);
      expect(short.status).toBe(422);
      expect(short.body.error.code).toBe('RETURN_INSPECTION_INCOMPLETE');
      expect(short.body.error.details.accounted).toBe(1);
      expect(short.body.error.details.returned).toBe(2);

      /* A SKU that is not on this return. */
      const foreign = await inspect([
        { skuCode: 'NOT-ON-THIS-RETURN', restockQuantity: 2, writeOffQuantity: 0 },
      ]);
      expect(foreign.status).toBe(422);

      /* Negative counts are a 400, not a 422 — the shape is wrong, not the arithmetic. */
      expect(
        (await inspect([{ skuCode: ctx.skuCode, restockQuantity: -1, writeOffQuantity: 3 }]))
          .status,
      ).toBe(400);

      /* And the honest split is accepted. */
      const ok = await inspect([{ skuCode: ctx.skuCode, restockQuantity: 1, writeOffQuantity: 1 }]);
      expect(ok.status).toBe(200);
      expect(ok.body.return.lines[0].restockQuantity).toBe(1);
      expect(ok.body.return.lines[0].writeOffQuantity).toBe(1);
    });
  });

  /* ══ 7. Refund before completion ══════════════════════════════════════ */

  describe('refund before completion', () => {
    it('refuses to complete when the provider refund FAILED, and leaves the return inspected', async () => {
      const ctx = await givenInspectedReturn({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 400 };

      const response = await act(ctx.returnNumber, 'complete');
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('RETURN_REFUND_NOT_SETTLED');
      expect(response.body.error.details.refundStatus).toBe('failed');

      const [row] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      expect(row!.status).toBe('inspected');
      expect(row!.closedAt).toBeNull();

      /* And a retry after the cause is fixed succeeds. */
      refundBehaviour = { kind: 'ok' };
      expect((await act(ctx.returnNumber, 'complete')).status).toBe(200);
    });

    it('refuses to complete on an UNRESOLVED refund and says it must not be retried', async () => {
      const ctx = await givenInspectedReturn({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 500 };

      const response = await act(ctx.returnNumber, 'complete');
      expect(response.status).toBe(422);
      expect(response.body.error.details.refundStatus).toBe('processing');
      expect(response.body.error.message).toContain('reconciled');

      /*
       * And the unresolved refund BLOCKS a second attempt — `uq_refund_return_live` holds the
       * slot, so a blind retry cannot create a second provider refund for the same return.
       */
      refundBehaviour = { kind: 'ok' };
      const retry = await act(ctx.returnNumber, 'complete');
      expect(retry.status).toBe(409);

      const rows = await refundsOf(ctx.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('processing');
    });

    it('completes a COD return with a PENDING manual refund recorded', async () => {
      const ctx = await givenInspectedReturn({ method: 'cod' });
      refundCalls.length = 0;

      const response = await act(ctx.returnNumber, 'complete');
      expect(response.status).toBe(200);
      expect(response.body.return.status).toBe('completed');
      expect(response.body.refunds[0].mode).toBe('manual');
      expect(response.body.refunds[0].status).toBe('pending');
      expect(refundCalls).toHaveLength(0);

      /* And staff can then record the offline disbursement. */
      const settled = await api()
        .post(`/api/v1/admin/refunds/${response.body.refunds[0].refundNumber}/settle`)
        .set(asStaff())
        .send({});
      expect(settled.status).toBe(200);
      expect(settled.body.refund.settledAt).not.toBeNull();
    });

    it('never lets a return refund exceed what the payment captured', async () => {
      const ctx = await givenInspectedReturn({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      /* Drain the balance first, directly against the payment. */
      expect((await refundOrder(ctx.orderNumber, ctx.grandTotal)).status).toBe(201);

      const response = await act(ctx.returnNumber, 'complete');
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');

      const [row] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      expect(row!.status).toBe('inspected');
    });
  });

  /* ══ 8. Inventory ═════════════════════════════════════════════════════ */

  describe('inventory', () => {
    const stockOf = async (skuId: string) => {
      const [row] = await db().select().from(stockItem).where(eq(stockItem.skuId, skuId));
      return row!;
    };

    const restockLedger = async (skuId: string) =>
      db()
        .select()
        .from(stockLedger)
        .where(and(eq(stockLedger.skuId, skuId), eq(stockLedger.reason, 'return_restock')));

    it('restocks only the good-to-sell units, exactly once, and leaves reservations alone', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 3, restock: 2 });
      refundBehaviour = { kind: 'ok' };

      const before = await stockOf(ctx.skuId);

      expect((await act(ctx.returnNumber, 'complete')).status).toBe(200);

      const after = await stockOf(ctx.skuId);
      /* Two of the three units came back; the written-off one never re-enters stock. */
      expect(after.onHand).toBe(before.onHand + 2);
      expect(after.reserved).toBe(before.reserved);

      /* One ledger row, with the delta the projection moved by. */
      const ledger = await restockLedger(ctx.skuId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.delta).toBe(2);
      expect(ledger[0]!.onHandBefore).toBe(before.onHand);
      expect(ledger[0]!.onHandAfter).toBe(before.onHand + 2);
      expect(ledger[0]!.actorUserId).toBe(staffId);

      /* A second completion is refused and adds nothing. */
      expect((await act(ctx.returnNumber, 'complete')).status).toBe(409);
      expect(await restockLedger(ctx.skuId)).toHaveLength(1);
      expect((await stockOf(ctx.skuId)).onHand).toBe(before.onHand + 2);
    });

    it('restocks nothing when every returned unit is written off', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 2, restock: 0 });
      refundBehaviour = { kind: 'ok' };

      const before = await stockOf(ctx.skuId);
      expect((await act(ctx.returnNumber, 'complete')).status).toBe(200);

      expect((await stockOf(ctx.skuId)).onHand).toBe(before.onHand);
      expect(await restockLedger(ctx.skuId)).toHaveLength(0);
    });

    it('restocks nothing when the refund fails', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 2, restock: 2 });
      refundBehaviour = { kind: 'status', status: 400 };

      const before = await stockOf(ctx.skuId);
      expect((await act(ctx.returnNumber, 'complete')).status).toBe(422);

      expect((await stockOf(ctx.skuId)).onHand).toBe(before.onHand);
      expect(await restockLedger(ctx.skuId)).toHaveLength(0);
    });

    it('lets two simultaneous completions restock exactly once', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 2, restock: 2 });
      refundBehaviour = { kind: 'ok' };

      const before = await stockOf(ctx.skuId);
      const [a, b] = await Promise.all([
        act(ctx.returnNumber, 'complete'),
        act(ctx.returnNumber, 'complete'),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 422]).toContain(statuses[1]);

      expect((await stockOf(ctx.skuId)).onHand).toBe(before.onHand + 2);
      expect(await restockLedger(ctx.skuId)).toHaveLength(1);
      const rows = await refundsOf(ctx.orderId);
      expect(rows.filter((row) => row.status !== 'failed')).toHaveLength(1);
    });
  });

  /* ══ 9. Money ═════════════════════════════════════════════════════════ */

  describe('money', () => {
    it('refunds the FROZEN snapshot, not a figure recomputed from the catalogue', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 1 });

      /* Triple the SKU price AFTER the return was raised. */
      expect(
        (
          await api()
            .patch(`/api/v1/admin/skus/${ctx.skuCode}`)
            .set(asStaff())
            .send({ price: '1500.0000' })
        ).status,
      ).toBe(200);

      refundBehaviour = { kind: 'ok' };
      const completed = await act(ctx.returnNumber, 'complete');

      expect(completed.status).toBe(200);
      /* The frozen figure, unchanged by the price rise. */
      expect(completed.body.refunds[0].amount).toBe(ctx.refundTotal);
    });

    it('refunds merchandise plus GST, matching the return header exactly', async () => {
      const ctx = await givenInspectedReturn({ method: 'online', quantity: 1 });
      refundBehaviour = { kind: 'ok' };

      const completed = await act(ctx.returnNumber, 'complete');
      expect(completed.status).toBe(200);

      const [row] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));

      /* Independently derived: taxable + tax, from the stored header. */
      const expected = (
        Number.parseFloat(row!.refundTaxableValue) + Number.parseFloat(row!.refundTaxTotal)
      ).toFixed(4);

      expect(completed.body.refunds[0].amount).toBe(expected);
      expect(completed.body.refunds[0].amount).toBe(row!.refundTotal);
    });

    it('stores amounts as NUMERIC(19,4) strings, never as floats', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      expect((await refundOrder(ctx.orderNumber, '0.1000')).status).toBe(201);
      expect((await refundOrder(ctx.orderNumber, '0.2000')).status).toBe(201);

      const rows = await refundsOf(ctx.orderId);
      for (const row of rows) expect(typeof row.amount).toBe('string');

      /*
       * 0.1 + 0.2 is the canonical float trap. The database sums it as NUMERIC, so it is
       * exactly 0.3000 rather than 0.30000000000000004.
       */
      const balance = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/payment`)
        .set(asStaff());
      expect(balance.body.payment.refundBalance.refunded).toBe('0.3000');
    });
  });

  /* ══ 10. Tenancy and authorization ════════════════════════════════════ */

  describe('tenancy and authorization', () => {
    const ROUTES = [
      ['post', '/api/v1/admin/orders/ORD-20260101-ABCDEF/refund'],
      ['post', '/api/v1/admin/refunds/RFD-20260101-ABCDEF/settle'],
      ['post', '/api/v1/admin/returns/RET-20260101-ABCDEF/receive'],
      ['post', '/api/v1/admin/returns/RET-20260101-ABCDEF/inspect'],
      ['post', '/api/v1/admin/returns/RET-20260101-ABCDEF/complete'],
    ] as const;

    it('refuses every new route without a token', async () => {
      for (const [, path] of ROUTES) {
        const response = await api().post(path).set('idempotency-key', `k-${newId()}`).send({});
        expect(response.status, path).toBe(401);
      }
    });

    it('refuses every new route for a customer', async () => {
      const customer = await signIn();
      for (const [, path] of ROUTES) {
        const response = await api()
          .post(path)
          .set({ Authorization: `Bearer ${customer.token}` })
          .set('idempotency-key', `k-${newId()}`)
          .send({});
        expect(response.status, path).toBe(403);
        expect(response.body.error.details.missing).toEqual(['staff']);
      }
    });

    it('refuses a staff member demoted mid-session', async () => {
      const ops = await signIn({ staff: true });
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });

      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, ops.id));

      const response = await api()
        .post(`/api/v1/admin/orders/${ctx.orderNumber}/refund`)
        .set({ Authorization: `Bearer ${ops.token}` })
        .set('idempotency-key', `rf-${newId()}`)
        .send({ amount: '1.0000' });

      expect(response.status).toBe(403);
    });

    it('cannot reach another store’s order, refund or return', async () => {
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({
          id: otherStoreId,
          slug: `other-${otherStoreId.slice(0, 8)}`,
          name: 'Other Store',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        });

      const ctx = await givenInspectedReturn({ method: 'online' });

      /* A refund raised in THIS store, then addressed from the other tenant's scope. */
      refundBehaviour = { kind: 'ok' };
      const raised = await refundOrder(ctx.orderNumber, '10.0000');
      expect(raised.status).toBe(201);

      /*
       * Cross-store is asserted at the REPOSITORY, because a second store's HTTP scope needs a
       * second resolved host. The predicate is what carries the guarantee, and a row that
       * exists in one store must be invisible in the other.
       */
      const [row] = await db()
        .select()
        .from(refund)
        .where(
          and(
            eq(refund.refundNumber, raised.body.refund.refundNumber as string),
            eq(refund.storeId, otherStoreId),
          ),
        );
      expect(row).toBeUndefined();
    });

    /**
     * The predicate, proven through HTTP with a REAL foreign row.
     *
     * A second store with its own order, user and succeeded payment, seeded directly because
     * this app instance resolves exactly one store from its host. The refund route is then
     * asked for that order NUMBER with this store's staff token: the order exists, the payment
     * exists and is refundable, and the only thing standing between the caller and another
     * tenant's money is the store predicate on the lookup.
     *
     * Asserting against an absence — a number nothing owns — would pass with the predicate
     * removed, which is why this seeds the row rather than omitting it.
     */
    it('404s another store’s order even though its payment is refundable', async () => {
      const foreignStoreId = newId();
      await db()
        .insert(store)
        .values({
          id: foreignStoreId,
          slug: `foreign-${foreignStoreId.slice(0, 8)}`,
          name: 'Foreign Store',
          currency: 'INR',
          timezone: 'Asia/Kolkata',
        });

      const foreignUserId = newId();
      await db()
        .insert(appUser)
        .values({
          id: foreignUserId,
          email: `foreign.${foreignUserId}@example.com`,
          passwordHash: 'x'.repeat(32),
          firstName: 'F',
          lastName: 'S',
        });

      /* Copy a real order of ours into the foreign store, so every column is valid. */
      const mine = await givenDeliveredPaidOrder({ method: 'online' });
      const [source] = await db().select().from(order).where(eq(order.id, mine.orderId));

      /* The order's address must live in the foreign store too — the FK is composite. */
      const [sourceAddress] = await db()
        .select()
        .from(address)
        .where(eq(address.id, source!.addressId as string));
      const foreignAddressId = newId();
      await db()
        .insert(address)
        .values({
          ...sourceAddress!,
          id: foreignAddressId,
          storeId: foreignStoreId,
          userId: foreignUserId,
        });

      const foreignCartId = newId();
      await db()
        .insert(cart)
        .values({ id: foreignCartId, storeId: foreignStoreId, userId: foreignUserId });

      const foreignOrderId = newId();
      const foreignOrderNumber = 'ORD-20260101-FRGN99';
      await db()
        .insert(order)
        .values({
          ...source!,
          id: foreignOrderId,
          storeId: foreignStoreId,
          userId: foreignUserId,
          orderNumber: foreignOrderNumber,
          addressId: foreignAddressId,
          /* `uq_order_cart` is global, so the copy needs a cart of its own. */
          cartId: foreignCartId,
        });

      const [sourcePayment] = await db()
        .select()
        .from(payment)
        .where(eq(payment.orderId, mine.orderId));

      await db()
        .insert(payment)
        .values({
          ...sourcePayment!,
          id: newId(),
          storeId: foreignStoreId,
          orderId: foreignOrderId,
          userId: foreignUserId,
          providerRef: `order_FOREIGN${foreignOrderId.slice(0, 6)}`,
          providerTransactionId: `pay_FOREIGN${foreignOrderId.slice(0, 6)}`,
        });

      /* Refundable in ITS store — and invisible in ours. */
      const response = await refundOrder(foreignOrderNumber, '1.0000');
      expect(response.status).toBe(404);

      /* And nothing was written against it. */
      const rows = await db().select().from(refund).where(eq(refund.orderId, foreignOrderId));
      expect(rows).toHaveLength(0);
    });

    it('404s an order that does not exist in this store', async () => {
      const response = await refundOrder('ORD-20260101-ZZZZZZ', '1.0000');
      expect(response.status).toBe(404);
    });
  });

  /* ══ 11. Audit ════════════════════════════════════════════════════════ */

  describe('audit', () => {
    it('records the raise and the outcome, attributed and without secrets', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };

      const raised = await refundOrder(ctx.orderNumber, '100.0000');
      expect(raised.status).toBe(201);

      const rows = await db().select().from(auditLog).where(eq(auditLog.resourceType, 'refund'));

      const actions = rows.map((row) => row.action);
      expect(actions).toContain('refund.raised');
      expect(actions).toContain('refund.succeeded');

      for (const row of rows) {
        expect(row.actorUserId).toBe(staffId);
        expect(row.storeId).toBe(storeId);
        const text = JSON.stringify(row.metadata);
        for (const secret of [
          CREDENTIALS.keySecret,
          CREDENTIALS.webhookSecret,
          'authorization',
          'Basic ',
        ]) {
          expect(text).not.toContain(secret);
        }
      }
    });

    it('records an unresolved outcome distinctly from a failure', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'status', status: 500 };
      await refundOrder(ctx.orderNumber, '100.0000');

      const rows = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'refund.unresolved'));

      expect(rows.length).toBeGreaterThan(0);
    });

    it('records the return lifecycle transitions', async () => {
      const ctx = await givenInspectedReturn({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      expect((await act(ctx.returnNumber, 'complete')).status).toBe(200);

      const rows = await db().select().from(auditLog).where(eq(auditLog.resourceType, 'return'));

      const actions = new Set(rows.map((row) => row.action));
      for (const action of [
        'return.approved',
        'return.received',
        'return.inspected',
        'return.completed',
      ]) {
        expect(actions.has(action), action).toBe(true);
      }
    });
  });

  /* ══ 12. Payment detail visibility ════════════════════════════════════ */

  describe('admin payment detail', () => {
    it('shows the refund history and the remaining refundable amount', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      expect((await refundOrder(ctx.orderNumber, '100.0000')).status).toBe(201);
      refundBehaviour = { kind: 'status', status: 400 };
      expect((await refundOrder(ctx.orderNumber, '50.0000')).status).toBe(201);

      const detail = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/payment`)
        .set(asStaff());

      expect(detail.status).toBe(200);
      expect(detail.body.payment.refunds).toHaveLength(2);
      expect(detail.body.payment.refundBalance.refunded).toBe('100.0000');
      expect(detail.body.payment.refundBalance.remaining).toBe(
        (Number.parseFloat(ctx.grandTotal) - 100).toFixed(4),
      );

      /* Internal identifiers stay internal. */
      const text = JSON.stringify(detail.body);
      for (const key of ['paymentId', 'returnId', 'initiatedBy', 'amountMinor', 'requestKey']) {
        expect(text).not.toContain(key);
      }
    });

    it('exposes exactly the refund fields the screen needs, and no more', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'online' });
      refundBehaviour = { kind: 'ok' };
      await refundOrder(ctx.orderNumber, '10.0000');

      const detail = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/payment`)
        .set(asStaff());

      expect(Object.keys(detail.body.payment.refunds[0]).sort()).toEqual([
        'amount',
        'createdAt',
        'currency',
        'failureCode',
        'mode',
        'provider',
        'providerRefundId',
        'refundNumber',
        'settledAt',
        'status',
      ]);
      expect(Object.keys(detail.body.payment.refundBalance).sort()).toEqual([
        'captured',
        'claimed',
        'currency',
        'refunded',
        'remaining',
      ]);
    });
  });
});
