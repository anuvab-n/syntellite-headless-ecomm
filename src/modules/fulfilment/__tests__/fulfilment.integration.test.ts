import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser } from '../../../db/schema/identity.js';
import { stockItem } from '../../../db/schema/inventory.js';
import { shipment } from '../../../db/schema/shipments.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

describe('fulfilment (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';
  let customerId = '';
  let secondCustomerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'FULFIL-SKU-1';

  const api = () => request(container.app);
  const db = () => container.db.db;

  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });
  const asCustomer = (token = customerToken) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    // Register staff user
    const staffEmail = `staff.fulfil.${newId()}@example.com`;
    const staffUser = await container.identity.registerCustomer({
      storeId,
      input: { email: staffEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Staff' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staffUser.id));

    const staffLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: PASSWORD });
    staffToken = staffLogin.body.accessToken as string;

    // Register customer user
    const customerEmail = `customer.fulfil.${newId()}@example.com`;
    const customerUser = await container.identity.registerCustomer({
      storeId,
      input: { email: customerEmail, password: PASSWORD, firstName: 'Jane', lastName: 'Doe' },
    });
    customerId = customerUser.id;

    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD });
    customerToken = customerLogin.body.accessToken as string;

    // Register second customer user
    const customer2Email = `customer2.fulfil.${newId()}@example.com`;
    await container.identity.registerCustomer({
      storeId,
      input: { email: customer2Email, password: PASSWORD, firstName: 'Bob', lastName: 'Smith' },
    });
    const customer2Login = await api()
      .post('/api/v1/auth/login')
      .send({ email: customer2Email, password: PASSWORD });
    secondCustomerToken = customer2Login.body.accessToken as string;

    // Create product, SKU, and stock
    const product = await api().post('/api/v1/admin/products').set(asStaff()).send({
      slug: 'fulfilment-test-product',
      name: 'Fulfilment Product',
      status: 'active',
    });
    expect(product.status).toBe(201);

    const createdSku = await api()
      .post('/api/v1/admin/products/fulfilment-test-product/skus')
      .set(asStaff())
      .send({ code: SKU_CODE, price: '100.0000', name: SKU_CODE });
    expect(createdSku.status).toBe(201);

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU_CODE, delta: 50, reason: 'manual_increase', note: 'test stock' });
    expect(stocked.status).toBe(201);
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function createAddress(token: string): Promise<string> {
    const res = await api()
      .post('/api/v1/users/me/addresses')
      .set({ Authorization: `Bearer ${token}` })
      .send({
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

  async function placeOrder(
    token: string,
    addressId: string,
    payMethod: 'cod' | 'none' = 'cod',
  ): Promise<string> {
    await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ quantity: 1 });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set({ Authorization: `Bearer ${token}` })
      .set('idempotency-key', newId())
      .send({ addressId });
    expect(checkout.status).toBe(201);
    const orderNumber = checkout.body.order.orderNumber as string;

    if (payMethod === 'cod') {
      const pay = await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
        .set({ Authorization: `Bearer ${token}` })
        .set('idempotency-key', newId())
        .send({ method: 'cod' });
      expect(pay.status).toBe(201);
    }

    return orderNumber;
  }

  describe('authorization & security', () => {
    it('requires authentication for all admin fulfilment endpoints', async () => {
      expect((await api().get('/api/v1/admin/orders/fulfilment')).status).toBe(401);
      expect((await api().get('/api/v1/admin/orders/ORD-123/shipments')).status).toBe(401);
      expect((await api().post('/api/v1/admin/orders/ORD-123/shipments')).status).toBe(401);
      expect((await api().post(`/api/v1/admin/shipments/${newId()}/ship`)).status).toBe(401);
      expect((await api().post(`/api/v1/admin/shipments/${newId()}/deliver`)).status).toBe(401);
      expect((await api().patch(`/api/v1/admin/shipments/${newId()}`)).status).toBe(401);
    });

    it('refuses non-staff users from admin fulfilment endpoints', async () => {
      expect((await api().get('/api/v1/admin/orders/fulfilment').set(asCustomer())).status).toBe(
        403,
      );
      expect(
        (await api().get('/api/v1/admin/orders/ORD-123/shipments').set(asCustomer())).status,
      ).toBe(403);
      expect(
        (await api().post('/api/v1/admin/orders/ORD-123/shipments').set(asCustomer())).status,
      ).toBe(403);
      expect(
        (await api().post(`/api/v1/admin/shipments/${newId()}/ship`).set(asCustomer())).status,
      ).toBe(403);
      expect(
        (await api().post(`/api/v1/admin/shipments/${newId()}/deliver`).set(asCustomer())).status,
      ).toBe(403);
      expect(
        (await api().patch(`/api/v1/admin/shipments/${newId()}`).set(asCustomer())).status,
      ).toBe(403);
    });
  });

  describe('fulfilment workflow', () => {
    let addressId: string;
    let orderNumber: string;
    let shipmentId: string;

    beforeAll(async () => {
      addressId = await createAddress(customerToken);
      orderNumber = await placeOrder(customerToken, addressId, 'cod');
    });

    it('lists order in staff fulfilment work queue', async () => {
      const res = await api().get('/api/v1/admin/orders/fulfilment').set(asStaff());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.orders)).toBe(true);
      const found = res.body.orders.find((o: { orderNumber: string }) => o.orderNumber === orderNumber);
      expect(found).toBeDefined();
      expect(found.shipmentStatus).toBeNull();
    });

    it('raises a shipment for the order', async () => {
      const res = await api()
        .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
        .set(asStaff())
        .send({
          carrier: 'BlueDart',
          trackingNumber: 'BD123456789',
          trackingUrl: 'https://bluedart.example.com/track/BD123456789',
        });

      expect(res.status).toBe(201);
      expect(res.body.shipment).toMatchObject({
        status: 'pending',
        carrier: 'BlueDart',
        trackingNumber: 'BD123456789',
        trackingUrl: 'https://bluedart.example.com/track/BD123456789',
      });
      expect(res.body.shipment.id).toBeDefined();
      shipmentId = res.body.shipment.id as string;
    });

    it('refuses duplicate shipment creation for the same order (409)', async () => {
      const res = await api()
        .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
        .set(asStaff())
        .send({ carrier: 'BlueDart' });

      expect(res.status).toBe(409);
    });

    it('customer can list shipments for their own order', async () => {
      const res = await api()
        .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
        .set(asCustomer());

      expect(res.status).toBe(200);
      expect(res.body.shipments).toHaveLength(1);
      expect(res.body.shipments[0]).toMatchObject({
        status: 'pending',
        carrier: 'BlueDart',
        trackingNumber: 'BD123456789',
      });
      // Verification: Customer view does not leak internal DB IDs or sensitive staff notes
      expect(res.body.shipments[0]).not.toHaveProperty('id');
    });

    it('404s customer shipment list if requested by a different customer', async () => {
      const res = await api()
        .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
        .set({ Authorization: `Bearer ${secondCustomerToken}` });

      expect(res.status).toBe(404);
    });

    it('staff can read shipments for the order', async () => {
      const res = await api()
        .get(`/api/v1/admin/orders/${orderNumber}/shipments`)
        .set(asStaff());

      expect(res.status).toBe(200);
      expect(res.body.shipments).toHaveLength(1);
      expect(res.body.shipments[0].id).toBe(shipmentId);
    });

    it('updates shipment tracking details via PATCH', async () => {
      const res = await api()
        .patch(`/api/v1/admin/shipments/${shipmentId}`)
        .set(asStaff())
        .send({
          carrier: 'FedEx',
          trackingNumber: 'FX987654321',
        });

      expect(res.status).toBe(200);
      expect(res.body.shipment).toMatchObject({
        id: shipmentId,
        carrier: 'FedEx',
        trackingNumber: 'FX987654321',
      });
    });

    it('ships the shipment (COD order allows ship when payment is pending)', async () => {
      const stockBefore = await db()
        .select()
        .from(stockItem)
        .where(eq(stockItem.storeId, storeId));
      expect(stockBefore.length).toBeGreaterThan(0);
      const onHandBefore = stockBefore[0]!.onHand;

      const res = await api()
        .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
        .set(asStaff())
        .send({ note: 'Handed to driver' });

      expect(res.status).toBe(200);
      expect(res.body.shipment.status).toBe('shipped');
      expect(res.body.shipment.shippedAt).toBeDefined();

      const stockAfter = await db()
        .select()
        .from(stockItem)
        .where(eq(stockItem.storeId, storeId));
      expect(stockAfter[0]!.onHand).toBe(onHandBefore - 1);
    });

    it('refuses to ship an already shipped shipment (409)', async () => {
      const res = await api()
        .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
        .set(asStaff())
        .send({});

      expect(res.status).toBe(409);
    });

    it('delivers the shipment', async () => {
      const res = await api()
        .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
        .set(asStaff())
        .send({ note: 'Delivered at front porch' });

      expect(res.status).toBe(200);
      expect(res.body.shipment.status).toBe('delivered');
      expect(res.body.shipment.deliveredAt).toBeDefined();
    });

    it('refuses to deliver an already delivered shipment (409)', async () => {
      const res = await api()
        .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
        .set(asStaff())
        .send({});

      expect(res.status).toBe(409);
    });
  });

  describe('order payment prerequisite validation', () => {
    it('refuses to raise shipment on an order without payment (422)', async () => {
      const addrId = await createAddress(customerToken);
      const unpaidOrderNumber = await placeOrder(customerToken, addrId, 'none');

      const shipRes = await api()
        .post(`/api/v1/admin/orders/${unpaidOrderNumber}/shipments`)
        .set(asStaff())
        .send({ carrier: 'Courier' });

      expect(shipRes.status).toBe(422);
      expect(shipRes.body.error.code).toBe('ORDER_NOT_FULFILLABLE');
    });
  });
});
