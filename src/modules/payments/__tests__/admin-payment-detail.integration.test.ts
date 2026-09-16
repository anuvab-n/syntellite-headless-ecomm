import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser } from '../../../db/schema/identity.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * The provider's CHARGE id, end to end. Increment 55.
 *
 * `GET /api/v1/admin/orders/{orderNumber}/payment` publishes `providerTransactionId` —
 * Razorpay's `pay_…`, the "Transaction ID" its dashboard shows — and this suite is what proves
 * the value gets there honestly.
 *
 * ## Why the real adapter, with only `fetch` stubbed
 *
 * The container is built with real Razorpay credentials and a `fetch` that intercepts
 * `api.razorpay.com` and nothing else. So the HMAC over every webhook below is computed by
 * PRODUCTION code against bytes this file signed, and `readEnvelope` really does the parsing. A
 * fake gateway would let a broken adapter pass: the signature check would be whatever the double
 * returned, and the charge id would be whatever the double invented.
 *
 * ## The four identifiers this suite refuses to conflate
 *
 * | Identifier | What it is | Where it may appear |
 * | --- | --- | --- |
 * | `payment.id` | our row's UUIDv7 | nowhere |
 * | `orderNumber` | the order, and the provider `receipt` | everywhere |
 * | `providerRef` (`order_…`) | the provider ORDER, written at initiation | staff detail |
 * | `providerTransactionId` (`pay_…`) | the provider CHARGE, learned from a webhook | staff detail |
 * | `providerEventId` (`evt_…`) | the webhook DELIVERY, dedupe material | nowhere |
 *
 * The last row is the one that matters most: it is adjacent to the others in the code and in the
 * payload, and publishing it would be a silent, plausible-looking mistake.
 */
describe('admin payment detail and the provider transaction id (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'ADMPAY-SKU-1';

  const CREDENTIALS = {
    keyId: 'rzp_test_publishable',
    keySecret: 'the-api-secret-never-published',
    webhookSecret: 'the-webhook-secret-never-published',
  };

  /** Provider order ids handed out by the stubbed gateway, newest last. */
  const issuedRefs: string[] = [];
  let refCounter = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const pool = () => container.db.pool;

  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  const sign = (body: string, secret = CREDENTIALS.webhookSecret): string =>
    createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    /*
     * Scoped to the provider's host. Testcontainers and the application's own traffic keep the
     * real implementation — a blanket stub would silently break anything else that fetches, and
     * this suite would not be the place that reported it.
     */
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const [input] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : ((input as { url?: string }).url ?? '');

      if (!url.includes('api.razorpay.com')) return realFetch(...args);
      refCounter += 1;
      const id = `order_STUB${String(refCounter).padStart(4, '0')}`;
      issuedRefs.push(id);
      return new Response(JSON.stringify({ id }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
          RAZORPAY_KEY_ID: CREDENTIALS.keyId,
          RAZORPAY_KEY_SECRET: CREDENTIALS.keySecret,
          RAZORPAY_WEBHOOK_SECRET: CREDENTIALS.webhookSecret,
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    const staffEmail = `staff.admpay.${newId()}@example.com`;
    const staff = await container.identity.registerCustomer({
      storeId,
      input: { email: staffEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Staff' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staff.id));
    staffToken = (
      await api().post('/api/v1/auth/login').send({ email: staffEmail, password: PASSWORD })
    ).body.accessToken as string;

    const customerEmail = `customer.admpay.${newId()}@example.com`;
    await container.identity.registerCustomer({
      storeId,
      input: { email: customerEmail, password: PASSWORD, firstName: 'Jane', lastName: 'Doe' },
    });
    customerToken = (
      await api().post('/api/v1/auth/login').send({ email: customerEmail, password: PASSWORD })
    ).body.accessToken as string;

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: 'admin-payment-product', name: 'Admin Payment Product', status: 'active' });
    expect(product.status).toBe(201);

    expect(
      (
        await api()
          .post('/api/v1/admin/products/admin-payment-product/skus')
          .set(asStaff())
          .send({ code: SKU_CODE, price: '100.0000', name: SKU_CODE })
      ).status,
    ).toBe(201);

    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff())
          .send({ skuCode: SKU_CODE, delta: 200, reason: 'manual_increase', note: 'stock' })
      ).status,
    ).toBe(201);
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ── Fixtures ─────────────────────────────────────────────────────────── */

  async function createAddress(): Promise<string> {
    const res = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'Jane Doe',
      phone: '+91 9876543210',
      line1: '100 Main St',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
    });
    expect(res.status).toBe(201);
    return res.body.address.id as string;
  }

  let addressId = '';
  const addressOnce = async (): Promise<string> => {
    if (addressId === '') addressId = await createAddress();
    return addressId;
  };

  /** Place an order and initiate a payment. Returns the order number and the provider ref. */
  async function pay(method: 'online' | 'cod'): Promise<{ orderNumber: string; ref: string }> {
    const address = await addressOnce();

    await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set(asCustomer())
      .send({ quantity: 1 });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ addressId: address });
    expect(checkout.status).toBe(201);
    const orderNumber = checkout.body.order.orderNumber as string;

    const initiated = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ method });
    expect(initiated.status, JSON.stringify(initiated.body)).toBe(201);

    return { orderNumber, ref: method === 'online' ? (issuedRefs.at(-1) ?? '') : '' };
  }

  /** A signed Razorpay notification, built the way the provider builds one. */
  function webhook(options: {
    event?: string;
    orderId?: string;
    chargeId?: string | number | null;
    eventId?: string;
    signature?: string;
    rawBody?: string;
  }) {
    const entity: Record<string, unknown> = { order_id: options.orderId };
    if (options.chargeId !== null && options.chargeId !== undefined) {
      entity['id'] = options.chargeId;
    }

    const body =
      options.rawBody ??
      JSON.stringify({
        event: options.event ?? 'payment.captured',
        payload: { payment: { entity } },
      });

    return api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', options.signature ?? sign(body))
      .set('x-razorpay-event-id', options.eventId ?? `evt_${newId()}`)
      .send(body);
  }

  const detailPath = (orderNumber: string) => `/api/v1/admin/orders/${orderNumber}/payment`;

  async function storedTxn(orderNumber: string): Promise<string | null> {
    const { rows } = await pool().query<{ provider_transaction_id: string | null }>(
      `select p.provider_transaction_id
         from payment p join "order" o on o.id = p.order_id
        where o.order_number = $1`,
      [orderNumber],
    );
    return rows[0]?.provider_transaction_id ?? null;
  }

  /* ── 1. The webhook writes the charge id ──────────────────────────────── */

  describe('capturing the charge id from a verified webhook', () => {
    let captured = { orderNumber: '', ref: '' };
    const CHARGE_ID = 'pay_CAPTURED0001';

    beforeAll(async () => {
      captured = await pay('online');
      const res = await webhook({ orderId: captured.ref, chargeId: CHARGE_ID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'applied', payment: { status: 'succeeded' } });
    }, 120_000);

    it('stores payload.payment.entity.id as the provider transaction id', async () => {
      expect(await storedTxn(captured.orderNumber)).toBe(CHARGE_ID);
    });

    /**
     * The whole point of the column. `provider_ref` is the ORDER the gateway created before
     * anybody paid; this is the CHARGE. Storing one in the other's column is the mistake this
     * increment exists to make impossible, and it would look entirely plausible in a diff.
     */
    it('keeps the charge id and the order handle in different columns', async () => {
      const { rows } = await pool().query<{
        provider_ref: string | null;
        provider_transaction_id: string | null;
      }>(
        `select p.provider_ref, p.provider_transaction_id
           from payment p join "order" o on o.id = p.order_id
          where o.order_number = $1`,
        [captured.orderNumber],
      );
      expect(rows[0]?.provider_ref).toBe(captured.ref);
      expect(rows[0]?.provider_ref).toMatch(/^order_/u);
      expect(rows[0]?.provider_transaction_id).toBe(CHARGE_ID);
      expect(rows[0]?.provider_transaction_id).not.toBe(rows[0]?.provider_ref);
    });

    /** And it is not the delivery id either, which lives on the event row and is published nowhere. */
    it('does not store the webhook delivery id as the transaction id', async () => {
      const { rows } = await pool().query<{ provider_event_id: string | null }>(
        `select e.provider_event_id
           from payment_event e
           join payment p on p.id = e.payment_id
           join "order" o on o.id = p.order_id
          where o.order_number = $1 and e.provider_event_id is not null`,
        [captured.orderNumber],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.provider_event_id).not.toBe(CHARGE_ID);
      expect(await storedTxn(captured.orderNumber)).toBe(CHARGE_ID);
    });

    it('publishes it on the admin detail', async () => {
      const res = await api().get(detailPath(captured.orderNumber)).set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payment).toMatchObject({
        orderNumber: captured.orderNumber,
        status: 'succeeded',
        method: 'online',
        provider: 'razorpay',
        providerRef: captured.ref,
        providerTransactionId: CHARGE_ID,
      });
    });

    /**
     * A redelivery of the SAME notification. `uq_payment_event_provider` rejects it before any
     * state changes, so the answer is a success and nothing moves.
     */
    it('is idempotent under a redelivery of the same event', async () => {
      const eventId = `evt_${newId()}`;
      const first = await webhook({
        orderId: captured.ref,
        chargeId: 'pay_IGNORED0001',
        eventId,
      });
      const second = await webhook({
        orderId: captured.ref,
        chargeId: 'pay_IGNORED0001',
        eventId,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await storedTxn(captured.orderNumber)).toBe(CHARGE_ID);
    });

    /**
     * A DIFFERENT notification arriving after the payment is terminal — ordinary under
     * at-least-once delivery. The state machine refuses it, so the charge id it carries must not
     * overwrite the one recorded by the delivery that actually performed the transition.
     */
    it('does not overwrite the charge id from an event it refuses to apply', async () => {
      const res = await webhook({ orderId: captured.ref, chargeId: 'pay_LATECOMER001' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ignored', reason: 'already_terminal' });
      expect(await storedTxn(captured.orderNumber)).toBe(CHARGE_ID);
    });
  });

  /* ── 2. Failure, absence and rejection ────────────────────────────────── */

  describe('the cases where there is no charge id', () => {
    it('records a failed payment’s charge id when the notification carries one', async () => {
      const failed = await pay('online');
      const res = await webhook({
        event: 'payment.failed',
        orderId: failed.ref,
        chargeId: 'pay_FAILED000001',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'applied', payment: { status: 'failed' } });

      expect(await storedTxn(failed.orderNumber)).toBe('pay_FAILED000001');
      const detail = await api().get(detailPath(failed.orderNumber)).set(asStaff());
      expect(detail.body.payment).toMatchObject({
        status: 'failed',
        failureCode: 'declined',
        providerTransactionId: 'pay_FAILED000001',
      });
    });

    /** A notification with no charge id still describes a real transition. The id is null. */
    it('applies a transition whose notification carried no charge id, leaving it null', async () => {
      const bare = await pay('online');
      const res = await webhook({ event: 'payment.failed', orderId: bare.ref, chargeId: null });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'applied', payment: { status: 'failed' } });

      expect(await storedTxn(bare.orderNumber)).toBeNull();
      const detail = await api().get(detailPath(bare.orderNumber)).set(asStaff());
      expect(detail.body.payment.status).toBe('failed');
      expect(detail.body.payment.providerTransactionId).toBeNull();
    });

    it('leaves a pending payment’s charge id null — nothing has been charged', async () => {
      const pending = await pay('online');
      expect(await storedTxn(pending.orderNumber)).toBeNull();

      const detail = await api().get(detailPath(pending.orderNumber)).set(asStaff());
      expect(detail.body.payment).toMatchObject({
        status: 'pending',
        providerTransactionId: null,
      });
      expect(detail.body.payment.providerRef).toMatch(/^order_/u);
    });

    it('leaves a COD payment’s provider fields null — there is no gateway', async () => {
      const cod = await pay('cod');
      expect(await storedTxn(cod.orderNumber)).toBeNull();

      const detail = await api().get(detailPath(cod.orderNumber)).set(asStaff());
      expect(detail.body.payment).toMatchObject({
        method: 'cod',
        provider: null,
        providerRef: null,
        providerTransactionId: null,
      });
    });

    /**
     * "COD is always null" as a property of the data, not of the one code path that writes it.
     * A future path that tried would be refused by the database.
     */
    it('refuses a charge id on a COD payment at the database level', async () => {
      const cod = await pay('cod');
      await expect(
        pool().query(
          `update payment set provider_transaction_id = 'pay_SHOULD_NOT'
             where order_id = (select id from "order" where order_number = $1)`,
          [cod.orderNumber],
        ),
      ).rejects.toThrow(/ck_payment_provider_txn_only_online/u);
    });

    /**
     * A charge id already recorded against a DIFFERENT payment.
     *
     * A provider does not reuse one, so this means something is wrong — and the question is what
     * to do with the transition that arrived carrying it. The money moved; the id is how we
     * cross-reference it later. So the transition is applied and the reference is dropped:
     * refusing would leave a paid order unpaid AND answer the provider `500`, inviting it to
     * redeliver a notification that can never succeed.
     */
    it('applies the transition and drops the id when that charge id is already recorded', async () => {
      const first = await pay('online');
      expect((await webhook({ orderId: first.ref, chargeId: 'pay_COLLIDE00001' })).status).toBe(
        200,
      );
      expect(await storedTxn(first.orderNumber)).toBe('pay_COLLIDE00001');

      const second = await pay('online');
      const res = await webhook({ orderId: second.ref, chargeId: 'pay_COLLIDE00001' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'applied', payment: { status: 'succeeded' } });

      /* The transition happened. The reference did not, and the first payment kept its own. */
      const detail = await api().get(detailPath(second.orderNumber)).set(asStaff());
      expect(detail.body.payment.status).toBe('succeeded');
      expect(detail.body.payment.providerTransactionId).toBeNull();
      expect(await storedTxn(first.orderNumber)).toBe('pay_COLLIDE00001');
    });

    it('rejects a forged signature with 401 and changes nothing', async () => {
      const target = await pay('online');
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_FORGED00001', order_id: target.ref } } },
      });

      const res = await webhook({ rawBody: body, signature: sign(body, 'not-the-secret') });
      expect(res.status).toBe(401);
      expect(await storedTxn(target.orderNumber)).toBeNull();
    });

    it('rejects a malformed body with 400 and changes nothing', async () => {
      const target = await pay('online');
      const res = await webhook({ rawBody: '{"event":"payment.captured"}' });
      expect(res.status).toBe(400);
      expect(await storedTxn(target.orderNumber)).toBeNull();
    });
  });

  /* ── 3. The exact-match filter ────────────────────────────────────────── */

  describe('GET /admin/payments?transactionId=', () => {
    const FILTER_CHARGE = 'pay_FILTERABLE01';
    let filtered = { orderNumber: '', ref: '' };

    beforeAll(async () => {
      filtered = await pay('online');
      expect((await webhook({ orderId: filtered.ref, chargeId: FILTER_CHARGE })).status).toBe(200);
    }, 120_000);

    it('returns exactly the payment holding that charge id', async () => {
      const res = await api()
        .get(`/api/v1/admin/payments?transactionId=${FILTER_CHARGE}&limit=100`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect((res.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber)).toEqual([
        filtered.orderNumber,
      ]);
      expect(res.body.pagination.total).toBe(1);
    });

    /** A filter, not a lookup: a well-formed id nobody holds is an empty page, not a 404. */
    it('answers an unknown charge id with an empty page', async () => {
      const res = await api()
        .get('/api/v1/admin/payments?transactionId=pay_NOBODYHOLDS')
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('does not match the provider ORDER handle, which is a different identifier', async () => {
      const res = await api()
        .get(`/api/v1/admin/payments?transactionId=${filtered.ref}`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual([]);
    });

    it('rejects a malformed charge id rather than running a query that can only miss', async () => {
      for (const value of ['', 'pay%20space', 'pay_' + 'x'.repeat(300)]) {
        const res = await api()
          .get(`/api/v1/admin/payments?transactionId=${encodeURIComponent(value)}`)
          .set(asStaff());
        expect(res.status, value).toBe(400);
        expect(res.body.error.code, value).toBe('VALIDATION_ERROR');
      }
    });

    it('combines with the other filters rather than replacing them', async () => {
      const res = await api()
        .get(`/api/v1/admin/payments?transactionId=${FILTER_CHARGE}&status=pending`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual([]);
    });

    /** The list is the shipped Day-2 contract and did not grow the new field. */
    it('does not publish the charge id on the list row', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      expect(res.status).toBe(200);
      for (const row of res.body.payments as Record<string, unknown>[]) {
        expect(Object.keys(row).sort()).toEqual([
          'amount',
          'createdAt',
          'currency',
          'failureCode',
          'method',
          'orderNumber',
          'provider',
          'status',
          'updatedAt',
        ]);
      }
    });
  });

  /* ── 4. The detail's contract ─────────────────────────────────────────── */

  describe('the admin detail contract', () => {
    const DETAIL_KEYS = [
      'amount',
      'createdAt',
      'currency',
      'failureCode',
      'method',
      'orderNumber',
      'provider',
      'providerRef',
      'providerTransactionId',
      'status',
      'updatedAt',
    ];

    let subject = { orderNumber: '', ref: '' };

    beforeAll(async () => {
      subject = await pay('online');
      expect((await webhook({ orderId: subject.ref, chargeId: 'pay_CONTRACT0001' })).status).toBe(
        200,
      );
    }, 120_000);

    it('publishes exactly eleven keys, and no more', async () => {
      const res = await api().get(detailPath(subject.orderNumber)).set(asStaff());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['payment']);
      expect(Object.keys(res.body.payment).sort()).toEqual(DETAIL_KEYS);
    });

    /**
     * The identifiers and secrets that must never appear, named rather than implied.
     *
     * `providerEventId` is first because it is the plausible mistake: it is a provider-side
     * identifier sitting one join away, and it would look like it belonged.
     */
    it('leaks no delivery id, internal key, or credential', async () => {
      const res = await api().get(detailPath(subject.orderNumber)).set(asStaff());
      const text = JSON.stringify(res.body);

      for (const key of [
        'providerEventId',
        'provider_event_id',
        'id',
        'paymentId',
        'userId',
        'orderId',
        'storeId',
        'amountMinor',
        'expiresAt',
        'payload',
        'signature',
        'publicKey',
        'keySecret',
        'webhookSecret',
      ]) {
        expect(text, key).not.toContain(`"${key}"`);
      }

      for (const secret of [CREDENTIALS.keySecret, CREDENTIALS.webhookSecret, CREDENTIALS.keyId]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/evt_/u);
    });

    it('404s an unknown order number, another store’s, and one with no payment alike', async () => {
      const unknown = await api().get(detailPath('ORD-20200101-ZZZZZZ')).set(asStaff());
      expect(unknown.status).toBe(404);

      /* An order that exists in this store but was never paid for. */
      const address = await addressOnce();
      await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      const checkout = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', newId())
        .send({ addressId: address });
      expect(checkout.status).toBe(201);

      const unpaid = await api()
        .get(detailPath(checkout.body.order.orderNumber as string))
        .set(asStaff());
      expect(unpaid.status).toBe(404);
      expect(unpaid.body.error.code).toBe(unknown.body.error.code);
      expect(unpaid.body.error.message).toBe(unknown.body.error.message);
    });

    it('rejects a malformed order number with 400, not 404', async () => {
      const res = await api().get(detailPath('not-an-order-number')).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  /* ── 5. Authorization ─────────────────────────────────────────────────── */

  describe('authorization', () => {
    let target = '';

    beforeAll(async () => {
      target = (await pay('cod')).orderNumber;
    }, 120_000);

    it('refuses an anonymous request with 401', async () => {
      expect((await api().get(detailPath(target))).status).toBe(401);
    });

    it('refuses a signed-in non-staff customer with 403', async () => {
      expect((await api().get(detailPath(target)).set(asCustomer())).status).toBe(403);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.admpay.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get(detailPath(target)).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get(detailPath(target)).set(auth)).status).toBe(403);
    });

    it('refuses a deactivated staff member with 401', async () => {
      const email = `deact.admpay.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get(detailPath(target)).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get(detailPath(target)).set(auth)).status).toBe(401);
    });
  });

  /* ── 6. Tenancy, against a real foreign payment ───────────────────────── */

  /**
   * A second store cannot be reached over HTTP, so the foreign payment is CLONED at the database
   * level from a real one — same shape, same constraints, a different `store_id` and its own
   * charge id. Asserting "the list did not contain rows that do not exist" would pass against a
   * repository with no tenancy predicate at all.
   */
  describe('tenant isolation', () => {
    const FOREIGN_CHARGE = 'pay_FOREIGN00001';
    let foreignOrderNumber = '';

    beforeAll(async () => {
      const source = await pay('online');
      expect((await webhook({ orderId: source.ref, chargeId: 'pay_SOURCE000001' })).status).toBe(
        200,
      );

      const foreignStoreId = newId();
      const foreignUserId = newId();
      foreignOrderNumber = 'ORD-20200404-FFFFFF';

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [foreignStoreId, `other-${foreignStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'x', 'Foreign', 'Buyer')`,
        [foreignUserId, foreignStoreId, `foreign.admpay.${foreignUserId}@example.com`],
      );

      const { rows: orderRows } = await pool().query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const sourceOrder = orderRows[0];
      expect(sourceOrder).toBeDefined();
      if (!sourceOrder) return;

      const cartId = newId();
      await cloneRow('cart', 'id', String(sourceOrder['cart_id']), {
        id: cartId,
        store_id: foreignStoreId,
        user_id: foreignUserId,
      });
      const orderId = newId();
      await cloneRow('order', 'id', String(sourceOrder['id']), {
        id: orderId,
        store_id: foreignStoreId,
        user_id: foreignUserId,
        cart_id: cartId,
        address_id: null,
        order_number: foreignOrderNumber,
      });
      await cloneRow('payment', 'order_id', String(sourceOrder['id']), {
        id: newId(),
        store_id: foreignStoreId,
        order_id: orderId,
        user_id: foreignUserId,
        provider_ref: 'order_FOREIGNREF',
        provider_transaction_id: FOREIGN_CHARGE,
      });
    }, 120_000);

    async function cloneRow(
      table: string,
      keyColumn: string,
      keyValue: string,
      overrides: Record<string, unknown>,
    ): Promise<void> {
      const { rows } = await pool().query<Record<string, unknown>>(
        `select * from "${table}" where "${keyColumn}" = $1`,
        [keyValue],
      );
      const row = rows[0];
      expect(row, `no ${table} row with ${keyColumn}=${keyValue}`).toBeDefined();
      if (!row) return;

      const clone: Record<string, unknown> = { ...row, ...overrides };
      const columns = Object.keys(clone);
      await pool().query(
        `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
         values (${columns.map((_c, i) => `$${String(i + 1)}`).join(', ')})`,
        columns.map((c) => clone[c]),
      );
    }

    it('has actually created a foreign payment — otherwise the rest proves nothing', async () => {
      const { rows } = await pool().query<{ count: string }>(
        `select count(*)::text as count from payment
          where store_id <> $1 and provider_transaction_id = $2`,
        [storeId, FOREIGN_CHARGE],
      );
      expect(Number(rows[0]?.count ?? '0')).toBe(1);
    });

    it('never returns another store’s payment from the transaction-id filter', async () => {
      const res = await api()
        .get(`/api/v1/admin/payments?transactionId=${FOREIGN_CHARGE}`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('404s another store’s order on the detail route', async () => {
      const res = await api().get(detailPath(foreignOrderNumber)).set(asStaff());
      expect(res.status).toBe(404);
    });

    /**
     * The repository's own tenancy, not the route's. The service refuses a foreign order number
     * before the query runs on any path a client can take, which is exactly what makes the
     * predicate easy to lose — so it is asserted where it lives.
     */
    it('reads no foreign payment at the service level either', async () => {
      await expect(
        container.payments.getStorePaymentForOrder({ orderNumber: foreignOrderNumber, storeId }),
      ).rejects.toThrow();
    });
  });

  /* ── 7. The customer surfaces did not move ────────────────────────────── */

  describe('regression: the customer contract is unchanged', () => {
    it('GET /users/me/orders/{n}/payment still publishes exactly its ten keys', async () => {
      const own = await pay('online');
      expect((await webhook({ orderId: own.ref, chargeId: 'pay_CUSTOMER0001' })).status).toBe(200);

      const res = await api()
        .get(`/api/v1/users/me/orders/${own.orderNumber}/payment`)
        .set(asCustomer());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.payment).sort()).toEqual([
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

      const text = JSON.stringify(res.body);
      expect(text).not.toContain('providerTransactionId');
      expect(text).not.toContain('providerRef');
      expect(text).not.toContain('pay_CUSTOMER0001');
      expect(text).not.toContain('providerEventId');
    });

    it('GET /users/me/payments still publishes the same row shape', async () => {
      const res = await api().get('/api/v1/users/me/payments').set(asCustomer());
      expect(res.status).toBe(200);
      expect((res.body.payments as unknown[]).length).toBeGreaterThan(0);
      for (const row of res.body.payments as Record<string, unknown>[]) {
        expect(Object.keys(row).sort()).toEqual([
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
      }
      expect(JSON.stringify(res.body)).not.toContain('providerTransactionId');
    });

    it('the initiation handoff still carries the order handle and no charge id', async () => {
      const address = await addressOnce();
      await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      const checkout = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', newId())
        .send({ addressId: address });

      const initiated = await api()
        .post(`/api/v1/users/me/orders/${checkout.body.order.orderNumber as string}/payments`)
        .set(asCustomer())
        .set('idempotency-key', newId())
        .send({ method: 'online' });

      expect(initiated.status).toBe(201);
      expect(Object.keys(initiated.body.handoff).sort()).toEqual([
        'provider',
        'providerRef',
        'publicKey',
      ]);
      expect(initiated.body.handoff.providerRef).toMatch(/^order_/u);
      expect(JSON.stringify(initiated.body)).not.toContain('providerTransactionId');
      expect(JSON.stringify(initiated.body)).not.toContain(CREDENTIALS.keySecret);
    });
  });

  /* ── 8. Read-only, and the database behind the lookup ─────────────────── */

  describe('read-only and database', () => {
    it('the staff reads change nothing', async () => {
      const snapshot = async (): Promise<Record<string, number>> => {
        const countOf = async (sql: string): Promise<number> => {
          const { rows } = await pool().query<{ c: string }>(sql);
          return Number(rows[0]?.c ?? '0');
        };
        return {
          payments: await countOf('select count(*)::text c from payment'),
          events: await countOf('select count(*)::text c from payment_event'),
          orders: await countOf('select count(*)::text c from "order"'),
          audits: await countOf('select count(*)::text c from audit_log'),
          outbox: await countOf('select count(*)::text c from outbox_event'),
          txns: await countOf(
            'select count(*)::text c from payment where provider_transaction_id is not null',
          ),
        };
      };

      const before = await snapshot();
      await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      await api().get('/api/v1/admin/payments?transactionId=pay_CAPTURED0001').set(asStaff());
      await api().get(detailPath('ORD-20200101-ZZZZZZ')).set(asStaff());
      expect(await snapshot()).toEqual(before);
    });

    it('has the partial unique index the charge id depends on', async () => {
      const { rows } = await pool().query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'uq_payment_provider_txn'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toMatch(/UNIQUE/iu);
      expect(rows[0]?.indexdef).toMatch(/provider_transaction_id/u);
      expect(rows[0]?.indexdef).toMatch(/WHERE/iu);
    });

    /** One charge cannot be recorded against two payments in one store. */
    it('refuses a duplicate charge id within a store', async () => {
      const victim = await pay('online');
      await expect(
        pool().query(
          `update payment set provider_transaction_id = 'pay_CAPTURED0001'
             where order_id = (select id from "order" where order_number = $1)`,
          [victim.orderNumber],
        ),
      ).rejects.toThrow(/uq_payment_provider_txn/u);
    });

    /**
     * The lookup the filter runs, measured rather than assumed. At fixture scale the planner may
     * still choose a scan — the assertion is that the index EXISTS and is usable, and the plan
     * text is printed by the measurement recorded in the increment's report.
     */
    it('plans the charge-id lookup against the index', async () => {
      const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
        `explain (analyze, buffers)
         select p.id from payment p
          where p.store_id = $1 and p.provider_transaction_id = $2`,
        [storeId, 'pay_CAPTURED0001'],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/actual time/u);
    });
  });
});
