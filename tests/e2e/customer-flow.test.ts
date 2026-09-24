import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

/**
 * IPv4 first, and no happy-eyeballs race.
 *
 * Measured on this machine: the Neon pooler's AAAA record accepts a TCP connection that
 * never completes (20s timeout), while its A records connect in ~300ms. Node's default
 * `autoSelectFamily` does not recover from it here, so every query fails with an
 * `AggregateError [ETIMEDOUT]` that names no address and reads like a credentials problem.
 *
 * Set before the container is built, because the pool resolves on first connect. This is a
 * property of the network this suite runs on rather than of the code under test, which is
 * why it lives here instead of in `package.json`.
 */
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';

/**
 * The CUSTOMER journey, end to end, against the configured database.
 *
 * Read this as the storefront's happy path: discover a product, put it in a cart, check out,
 * pay, then watch the order. Every request goes through the real HTTP stack —
 * `buildContainer()` plus supertest — so middleware, validation, auth, store resolution and
 * idempotency are exercised rather than bypassed.
 *
 * The admin calls in `beforeAll` are SETUP, not subject: a customer cannot buy what nobody
 * stocked. The admin surface is the subject of `admin-flow.test.ts`.
 *
 * Every identifier is stamped, and nothing is deleted afterwards. This suite APPENDS to
 * whatever database `DATABASE_URL` names.
 */

const PASSWORD = 'a-sufficiently-long-customer-flow-password';
const stamp = `${Date.now().toString().slice(-8)}${randomUUID().slice(0, 4)}`;

const CUSTOMER_EMAIL = `cf.customer.${stamp}@example.com`;
const ADMIN_EMAIL = `cf.admin.${stamp}@example.com`;
const SLUG = `cf-tee-${stamp}`;
const SKU = `CF-${stamp}`.toUpperCase();
const UNIT_PRICE = '499.0000';

/** Printed as the suite runs, so the output doubles as a transcript of the flow. */
const log = (s: string): void => process.stdout.write(`      ${s}\n`);

describe('customer flow (e2e)', () => {
  let container: AppContainer;
  let customerToken: string;
  let adminToken: string;
  let addressId: string;
  let orderNumber: string;

  const api = () => request(container.app);
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    container = buildContainer({ role: 'api' });
    await container.warmUp();

    /*
     * Neon's pooler can refuse the very first connection of a process while it cold-starts.
     * Retrying here keeps that from presenting as a failure of whichever test ran first.
     */
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await container.db.db.execute('select 1');
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    // A staff member, to stock the shelf the customer buys from.
    const adminReg = await api()
      .post('/api/v1/auth/register')
      .send({ email: ADMIN_EMAIL, password: PASSWORD, firstName: 'CF', lastName: 'Admin' });
    await container.db.db
      .update(appUser)
      .set({ isStaff: true })
      .where(eq(appUser.id, adminReg.body.user.id as string));
    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD });
    adminToken = adminLogin.body.accessToken as string;

    await api()
      .post('/api/v1/admin/products')
      .set(asAdmin())
      .send({ slug: SLUG, name: 'Customer Flow Tee', status: 'active' });
    await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asAdmin())
      .send({ code: SKU, price: UNIT_PRICE });
    await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asAdmin())
      .send({ skuCode: SKU, delta: 25, reason: 'manual_increase', note: 'customer flow setup' });

    log(`setup: product ${SLUG}, sku ${SKU} @ ${UNIT_PRICE}, stock +25`);
  }, 120_000);

  afterAll(async () => {
    await container?.shutdown();
  });

  it('1. registers a new customer', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD, firstName: 'CF', lastName: 'Customer' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(CUSTOMER_EMAIL);
    log(`registered ${CUSTOMER_EMAIL} -> ${res.status}`);
  });

  it('2. logs in and receives an access token', async () => {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: CUSTOMER_EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    customerToken = res.body.accessToken as string;
    log(`logged in -> ${res.status}`);
  });

  it('3. browses the public catalogue and sees the product', async () => {
    const list = await api().get('/api/v1/products').query({ q: 'Customer Flow Tee' });
    expect(list.status).toBe(200);

    const detail = await api().get(`/api/v1/products/${SLUG}`);
    expect(detail.status).toBe(200);
    log(`catalogue list -> ${list.status}, detail ${SLUG} -> ${detail.status}`);
  });

  it('4. saves a delivery address', async () => {
    const res = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'CF Customer',
      phone: '+91 9876500011',
      line1: '11 Customer Flow Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560011',
      countryCode: 'IN',
    });

    expect(res.status).toBe(201);
    addressId = res.body.address.id as string;
    log(`address saved -> ${res.status}, id ${addressId}`);
  });

  it('5. adds the item to the cart and sees it priced', async () => {
    const res = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asCustomer())
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body.cart.items).toHaveLength(1);
    log(
      `cart: qty=2 subtotal=${res.body.cart.subtotal} purchasable=${res.body.cart.items[0]?.isPurchasable}`,
    );
  });

  it('6. checks out and receives an order number', async () => {
    const res = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `cf-${randomUUID()}`)
      .send({ addressId });

    if (res.status !== 201) log(`checkout body: ${JSON.stringify(res.body)}`);
    expect(res.status).toBe(201);

    orderNumber = res.body.order.orderNumber as string;
    log(`order placed -> ${res.status}, number ${orderNumber}, total ${res.body.order.total}`);
  });

  it('7. pays for the order with cash on delivery', async () => {
    const res = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `cf-pay-${randomUUID()}`)
      .send({ method: 'cod' });

    if (res.status !== 201) log(`payment body: ${JSON.stringify(res.body)}`);
    expect(res.status).toBe(201);
    expect(res.body.payment.method).toBe('cod');
    log(`payment -> ${res.status}, method=cod status=${res.body.payment.status}`);
  });

  it('8. refuses a second payment on the same order', async () => {
    const res = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `cf-pay2-${randomUUID()}`)
      .send({ method: 'cod' });

    // One payment per order is structural (`uq_payment_order`), so this is the duplicate
    // guard rather than a validation rule.
    expect(res.status).toBe(409);
    log(`duplicate payment correctly refused -> ${res.status}`);
  });

  it('9. lists its own orders and reads the one just placed', async () => {
    const list = await api().get('/api/v1/users/me/orders').set(asCustomer());
    expect(list.status).toBe(200);

    const detail = await api().get(`/api/v1/users/me/orders/${orderNumber}`).set(asCustomer());
    expect(detail.status).toBe(200);
    expect(detail.body.order.orderNumber).toBe(orderNumber);
    log(
      `order list -> ${list.status}, detail -> ${detail.status} status=${detail.body.order.status}`,
    );
  });

  it('10. reads the shipments for its order (empty until staff ship it)', async () => {
    const res = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
      .set(asCustomer());

    expect(res.status).toBe(200);
    log(`customer tracking view -> ${res.status}, body=${JSON.stringify(res.body)}`);
  });

  it('11. cannot cancel an order that already has a payment', async () => {
    const res = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
      .set(asCustomer())
      .send({});

    expect(res.status).toBe(409);
    log(`cancel after payment correctly refused -> ${res.status}`);
  });

  it('12. cannot read an order belonging to a different customer', async () => {
    const otherEmail = `cf.other.${stamp}@example.com`;
    await api()
      .post('/api/v1/auth/register')
      .send({ email: otherEmail, password: PASSWORD, firstName: 'CF', lastName: 'Other' });
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: otherEmail, password: PASSWORD });

    const res = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}`)
      .set({ Authorization: `Bearer ${login.body.accessToken as string}` });

    // 404 rather than 403: the order is not the requester's to know about.
    expect(res.status).toBe(404);
    log(`cross-customer read correctly refused -> ${res.status}`);
  });
});
