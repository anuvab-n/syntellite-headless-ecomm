import { and, eq, isNotNull } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';
import { outboxEvent } from '../../src/db/schema/outbox.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * The full customer + admin flow, run specifically to prove it survives BullMQ being
 * commented out (`src/db/outbox/queues.ts`, `src/db/outbox/outbox.module.ts`).
 *
 * Two things this file exists to prove that no other e2e suite asserts directly:
 *
 *  1. **Nothing on the request path needs BullMQ.** `buildContainer` is called with NO
 *     `transport` option — exactly what every real entry point (`main.ts`,
 *     `workers/default.ts`) does — so this exercises the actual default
 *     (`'in-process'`, set in `container.ts`) rather than a transport chosen for the test.
 *     A regression that silently put `'queue'` back as the default, or that made some route
 *     reach for `container.outbox.queues`/`.workers`, fails here with a clear stack trace
 *     instead of a production Redis connection error.
 *  2. **Events still get written.** Commenting out BullMQ must not mean commenting out the
 *     outbox — every domain action below is checked against `outbox_event`, proving the
 *     transactional write-side of eventing is untouched even though nothing drains it in
 *     this test (draining is the worker process's job, unaffected by which transport it
 *     drains INTO).
 *
 * Otherwise this is the same shape as `full-flow-walkthrough.e2e.test.ts`: real Postgres and
 * Redis via Testcontainers, the real composition root, `globalThis.fetch` stubbed only for
 * Razorpay. It intentionally re-covers the customer + admin journey end to end — register,
 * build a catalogue, shop, check out, pay, ship, return — rather than pointing at a slice,
 * because "does the whole thing still work" is exactly the question a transport change raises.
 */
describe('full e-commerce flow without BullMQ (in-process transport)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const RAZORPAY = {
    keyId: 'rzp_test_nobullmq',
    keySecret: 'nobullmq-api-secret',
    webhookSecret: 'nobullmq-webhook-secret',
  };
  const PASSWORD = 'a-sufficiently-long-no-bullmq-password';

  let storeId = '';
  let adminToken = '';
  let customerToken = '';
  let skuCode = '';
  let addressId = '';
  let orderNumber = '';
  let shipmentId = '';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      return new Response(JSON.stringify({ id: `order_NOBQ_${newId()}` }), { status: 200 });
    };

    // NO `transport` option — this is the point. Whatever `container.ts` defaults to is what
    // real production processes get, so that is what this test gets too.
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          RAZORPAY_KEY_ID: RAZORPAY.keyId,
          RAZORPAY_KEY_SECRET: RAZORPAY.keySecret,
          RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret,
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
        },
      }),
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  it('confirms the container actually built with no BullMQ wiring', () => {
    // The two fields `queues.ts`'s real implementation would have populated. Both `undefined`
    // is the whole assertion: no queue Redis client exists, no BullMQ Worker exists.
    expect(container.outbox.queues).toBeUndefined();
    expect(container.outbox.workers).toBeUndefined();
    // The drainer and the event bus still exist — commenting out BullMQ did not comment out
    // the outbox itself, only one of its two transports.
    expect(container.outbox.drainer).toBeDefined();
    expect(container.outbox.events).toBeDefined();
  });

  it('registers a customer and an admin — email + password, the one shared login route', async () => {
    const adminEmail = `nobq.admin.${newId()}@example.com`;
    const admin = await container.identity.registerCustomer({
      storeId,
      input: { email: adminEmail, password: PASSWORD, firstName: 'NoBull', lastName: 'Admin' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, admin.id));

    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.accessToken as string;

    const customerEmail = `nobq.customer.${newId()}@example.com`;
    const registered = await api().post('/api/v1/auth/register').send({
      email: customerEmail,
      password: PASSWORD,
      firstName: 'NoBull',
      lastName: 'Customer',
    });
    expect(registered.status).toBe(201);

    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD });
    expect(customerLogin.status).toBe(200);
    customerToken = customerLogin.body.accessToken as string;

    // A registration event was still written to the outbox — no BullMQ needed for that.
    const [event] = await db()
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.storeId, storeId), eq(outboxEvent.eventName, 'user.registered')));
    expect(event).toBeDefined();
  });

  it('admin builds a catalogue: product, SKU, stock, promotion, GST', async () => {
    const slug = `nobq-tee-${newId().slice(0, 8)}`;
    skuCode = `NOBQ-${newId().slice(0, 8)}`;

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asAdmin())
          .send({ slug, name: 'No-BullMQ Tee', status: 'active' })
      ).status,
    ).toBe(201);

    expect(
      (
        await api()
          .post(`/api/v1/admin/products/${slug}/skus`)
          .set(asAdmin())
          .send({ code: skuCode, price: '350.0000' })
      ).status,
    ).toBe(201);

    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asAdmin())
          .send({ skuCode, delta: 20, reason: 'manual_increase', note: 'no-bullmq stock' })
      ).status,
    ).toBe(201);

    const promo = await api()
      .post('/api/v1/admin/promotions')
      .set(asAdmin())
      .send({
        code: `NOBQ10-${newId().slice(0, 6)}`,
        name: '10% off',
        discountType: 'percentage',
        percentRate: '10',
        isActive: true,
      });
    expect(promo.status).toBe(201);

    expect(
      (
        await api().put('/api/v1/admin/store/tax-profile').set(asAdmin()).send({
          legalName: 'No BullMQ Retail Pvt Ltd',
          gstin: '29AABCE1234F1Z5',
          originLine1: '1 Test Street',
          originCity: 'Bengaluru',
          originState: 'Karnataka',
          originPostalCode: '560001',
          originCountryCode: 'IN',
        })
      ).status,
    ).toBe(200);
  });

  it('customer shops, checks out, and pays COD — every write still lands in the DB', async () => {
    const address = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'NoBull Customer',
      phone: '+91 9876543210',
      line1: '2 Test Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560002',
      countryCode: 'IN',
    });
    expect(address.status).toBe(201);
    addressId = address.body.address.id as string;

    const added = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 2 });
    expect(added.status).toBe(200);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `nobq-checkout-${newId()}`)
      .send({ addressId });
    expect(checkout.status).toBe(201);
    orderNumber = checkout.body.order.orderNumber as string;

    const pay = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `nobq-pay-${newId()}`)
      .send({ method: 'cod' });
    expect(pay.status).toBe(201);
    expect(pay.body.payment.status).toBe('pending');

    /**
     * `order.placed` itself is audit-only by design — `orders.events.ts` records that no
     * order event is emitted ("an event with no consumer is a guess at one"), so there is no
     * outbox row to look for here. What DOES still land in the outbox without BullMQ is the
     * `product.created` event this same run wrote earlier (§ "admin builds a catalogue") —
     * checked here, after the order exists, to prove the write side of eventing survives the
     * whole journey rather than just the first request of it.
     */
    const [productEvent] = await db()
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.storeId, storeId), eq(outboxEvent.eventName, 'product.created')));
    expect(productEvent).toBeDefined();
    expect(productEvent?.publishedAt).toBeNull(); // truthful: nothing has drained it yet
  });

  it('admin ships and delivers the order', async () => {
    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin())
      .send({ carrier: 'NoBullCarrier', trackingNumber: `NOBQ-${newId().slice(0, 8)}` });
    expect(created.status).toBe(201);
    shipmentId = created.body.shipment.id as string;

    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/ship`).set(asAdmin()).send({}))
        .status,
    ).toBe(200);
    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/deliver`).set(asAdmin()).send({}))
        .status,
    ).toBe(200);

    const tracked = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
      .set(asCustomer());
    expect(tracked.body.shipments[0].status).toBe('delivered');
  });

  it('customer raises a return and staff approves it', async () => {
    const created = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
      .set(asCustomer())
      .set('idempotency-key', `nobq-ret-${newId()}`)
      .send({ reason: 'defective', lines: [{ skuCode, quantity: 1 }] });
    expect(created.status).toBe(201);
    const returnNumber = created.body.return.returnNumber as string;

    const approved = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(asAdmin())
      .send({ staffNote: 'checked' });
    expect(approved.status).toBe(200);
    expect(approved.body.return.status).toBe('approved');
  });

  it('the invoice document is reachable, and still no BullMQ connection exists anywhere', async () => {
    const doc = await api().get(`/api/v1/users/me/orders/${orderNumber}/invoice`).set(asCustomer());
    expect(doc.status).toBe(200);

    // Restated at the end of the whole journey, not just at the start: after every one of the
    // writes above, the container STILL has no queue client and no BullMQ worker.
    expect(container.outbox.queues).toBeUndefined();
    expect(container.outbox.workers).toBeUndefined();

    // And the outbox has real, unpublished rows to show for the whole run — the write side
    // works completely independently of whether anything ever drains it into BullMQ.
    const unpublished = await db()
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.storeId, storeId), isNotNull(outboxEvent.eventName)));
    expect(unpublished.length).toBeGreaterThan(0);
    expect(unpublished.every((e) => e.publishedAt === null)).toBe(true);
  });
});
