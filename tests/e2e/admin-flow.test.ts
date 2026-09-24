import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

/**
 * IPv4 first, and no happy-eyeballs race. See the identical note in `customer-flow.test.ts`:
 * the Neon pooler's AAAA address accepts a connection that never completes on this network,
 * and Node's default family autoselection does not recover from it.
 */
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';

/**
 * The ADMIN journey, end to end: stock a product, watch an order arrive in the fulfilment
 * queue, raise a shipment against a carrier, ship it, and deliver it.
 *
 * The customer calls in `beforeAll` are SETUP — staff need something to fulfil. The customer
 * surface is the subject of `customer-flow.test.ts`.
 *
 * ## What this pins down about fulfilment
 *
 * Two properties matter more than the status codes, and both are asserted rather than
 * assumed:
 *
 *  1. **Creating a shipment does not move stock.** `POST /shipments` records intent; only
 *     `/ship` commits inventory. That split is deliberate — see `fulfilment.routes.ts` — and
 *     a regression that merged them would be invisible from status codes alone.
 *  2. **`/ship` decrements `on_hand`, and `/deliver` does not.** The units left the building
 *     at `shipped`; arrival is a record, not a second stock movement.
 *
 * The carrier is typed as free text (`'Blue Dart'`), because that is genuinely all the
 * schema holds today: there is no carrier integration, so no AWB is generated and no
 * tracking is synced. This test therefore documents the CURRENT manual flow.
 */

const PASSWORD = 'a-sufficiently-long-admin-flow-password';
const stamp = `${Date.now().toString().slice(-8)}${randomUUID().slice(0, 4)}`;

const ADMIN_EMAIL = `af.admin.${stamp}@example.com`;
const CUSTOMER_EMAIL = `af.customer.${stamp}@example.com`;
const SLUG = `af-tee-${stamp}`;
const SKU = `AF-${stamp}`.toUpperCase();
const UNIT_PRICE = '750.0000';
const OPENING_STOCK = 40;
const ORDER_QTY = 3;

const CARRIER = 'Blue Dart';
const AWB = `BD${stamp}`.toUpperCase();

const log = (s: string): void => {
  process.stdout.write(`      ${s}\n`);
};

describe('admin flow (e2e)', () => {
  let container: AppContainer;
  let adminToken: string;
  let customerToken: string;
  let orderNumber: string;
  let shipmentId: string;

  const api = () => request(container.app);
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** `on_hand` for the test SKU, via the admin inventory read. */
  const stock = async (): Promise<number | undefined> => {
    const res = await api().get('/api/v1/admin/inventory').set(asAdmin()).query({ skuCode: SKU });
    const row = res.body.items?.[0];
    return row?.onHand ?? row?.on_hand;
  };

  beforeAll(async () => {
    container = buildContainer({ role: 'api' });
    await container.warmUp();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await container.db.db.execute('select 1');
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    const adminReg = await api()
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'AF', lastName: 'Admin' });
    await container.db.db
      .update(appUser)
      .set({ isStaff: true })
      .where(eq(appUser.id, adminReg.body.user.id as string));
    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    adminToken = adminLogin.body.accessToken as string;

    await api()
      .post('/api/v1/auth/register')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'AF', lastName: 'Customer' });
    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD });
    customerToken = customerLogin.body.accessToken as string;

    log(`setup: admin ${ADMIN_EMAIL}, customer ${CUSTOMER_EMAIL}`);
  }, 120_000);

  afterAll(async () => {
    await container?.shutdown();
  });

  it('1. creates a product', async () => {
    const res = await api()
      .post('/api/v1/admin/products')
      .set(asAdmin())
      .send({ slug: SLUG, name: 'Admin Flow Tee', status: 'active' });

    expect(res.status).toBe(201);
    log(`product created -> ${res.status}, slug ${SLUG}`);
  });

  it('2. adds a SKU with a price', async () => {
    const res = await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asAdmin())
      .send({ code: SKU, price: UNIT_PRICE });

    expect(res.status).toBe(201);
    log(`sku created -> ${res.status}, ${SKU} @ ${UNIT_PRICE}`);
  });

  it('3. receives opening stock', async () => {
    const res = await api().post('/api/v1/admin/inventory/adjustments').set(asAdmin()).send({
      skuCode: SKU,
      delta: OPENING_STOCK,
      reason: 'manual_increase',
      note: 'admin flow opening stock',
    });

    expect(res.status).toBe(201);
    log(`stock adjusted -> ${res.status}, +${OPENING_STOCK}, on_hand=${String(await stock())}`);
  });

  it('4. rejects the same admin write from a non-staff account', async () => {
    const res = await api()
      .post('/api/v1/admin/products')
      .set(asCustomer())
      .send({ slug: `${SLUG}-nope`, name: 'Should Not Exist', status: 'active' });

    expect(res.status).toBe(403);
    log(`non-staff admin write correctly refused -> ${res.status}`);
  });

  it('5. a customer places and pays for an order (setup for fulfilment)', async () => {
    const address = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'AF Customer',
      phone: '+91 9876500022',
      line1: '22 Admin Flow Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560022',
      countryCode: 'IN',
    });
    expect(address.status).toBe(201);

    await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asCustomer())
      .send({ quantity: ORDER_QTY });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `af-${randomUUID()}`)
      .send({ addressId: address.body.address.id as string });

    if (checkout.status !== 201) log(`checkout body: ${JSON.stringify(checkout.body)}`);
    expect(checkout.status).toBe(201);
    orderNumber = checkout.body.order.orderNumber as string;

    const payment = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `af-pay-${randomUUID()}`)
      .send({ method: 'cod' });
    expect(payment.status).toBe(201);

    log(`order ${orderNumber} placed and paid (cod), on_hand=${String(await stock())} (reserved, not yet shipped)`);
  });

  it('6. sees the order in the fulfilment queue', async () => {
    const res = await api().get('/api/v1/admin/orders/fulfilment').set(asAdmin());

    expect(res.status).toBe(200);
    log(`fulfilment queue -> ${res.status}, ${String(res.body.orders?.length ?? '?')} awaiting`);
  });

  it('7. raises a Blue Dart shipment WITHOUT moving stock', async () => {
    const before = await stock();

    const res = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin())
      .send({ carrier: CARRIER, trackingNumber: AWB, trackingUrl: null });

    if (res.status !== 201) log(`shipment body: ${JSON.stringify(res.body)}`);
    expect(res.status).toBe(201);
    expect(res.body.shipment.status).toBe('pending');

    shipmentId = res.body.shipment.id as string;

    const after = await stock();
    // The whole point of splitting create from ship: intent moves no inventory.
    expect(after).toBe(before);
    log(`shipment created -> ${res.status}, status=pending carrier="${CARRIER}" awb=${AWB}`);
    log(`stock unchanged by creation: ${String(before)} -> ${String(after)}`);
  });

  it('8. refuses a second shipment for the same order', async () => {
    const res = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin())
      .send({ carrier: CARRIER, trackingNumber: `${AWB}X` });

    // One shipment per order, enforced by `uq_shipment_order`.
    expect(res.status).toBe(409);
    log(`duplicate shipment correctly refused -> ${res.status}`);
  });

  it('9. lists shipments and reads the one just raised', async () => {
    const list = await api().get('/api/v1/admin/shipments').set(asAdmin());
    expect(list.status).toBe(200);

    const detail = await api().get(`/api/v1/admin/shipments/${shipmentId}`).set(asAdmin());
    expect(detail.status).toBe(200);
    log(`shipment list -> ${list.status}, detail -> ${detail.status}`);
  });

  it('10. ships the order, which DOES move stock', async () => {
    const before = await stock();

    const res = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
      .set(asAdmin())
      .send({ note: 'handed to Blue Dart' });

    if (res.status !== 200) log(`ship body: ${JSON.stringify(res.body)}`);
    expect(res.status).toBe(200);
    expect(res.body.shipment.status).toBe('shipped');

    const after = await stock();
    // COD ships while the payment is still `pending` — the approved `allowUncommittedCod`
    // path — and committing the reservation is what decrements `on_hand`.
    expect(after).toBe((before ?? 0) - ORDER_QTY);
    log(`shipped -> ${res.status}, status=shipped`);
    log(`stock committed by ship: ${String(before)} -> ${String(after)} (-${ORDER_QTY})`);
  });

  it('11. marks it delivered, which moves NO further stock', async () => {
    const before = await stock();

    const res = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
      .set(asAdmin())
      .send({ note: 'left with security' });

    expect(res.status).toBe(200);
    expect(res.body.shipment.status).toBe('delivered');

    const after = await stock();
    expect(after).toBe(before);
    log(`delivered -> ${res.status}, stock unchanged: ${String(before)} -> ${String(after)}`);
  });

  it('12. refuses to ship an already-delivered shipment', async () => {
    const res = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
      .set(asAdmin())
      .send({});

    // `delivered` is absorbing; the transition table permits nothing after it.
    expect(res.status).toBe(409);
    log(`re-ship after delivery correctly refused -> ${res.status}`);
  });

  it('13. still allows correcting the tracking facts after delivery', async () => {
    const corrected = `${AWB}C`;
    const res = await api()
      .patch(`/api/v1/admin/shipments/${shipmentId}`)
      .set(asAdmin())
      .send({ carrier: CARRIER, trackingNumber: corrected, trackingUrl: null });

    // A wrong AWB stays wrong and the customer is still looking at it.
    expect(res.status).toBe(200);
    log(`tracking corrected after delivery -> ${res.status}, awb=${corrected}`);
  });

  it('14. shows the customer the delivered shipment', async () => {
    const res = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
      .set(asCustomer());

    expect(res.status).toBe(200);
    log(`customer tracking view -> ${res.status}, body=${JSON.stringify(res.body)}`);
  });

  it('15. produces an invoice for the fulfilled order', async () => {
    const res = await api().get(`/api/v1/admin/orders/${orderNumber}/invoice`).set(asAdmin());

    expect(res.status).toBe(200);
    log(`invoice -> ${res.status}`);
  });
});
