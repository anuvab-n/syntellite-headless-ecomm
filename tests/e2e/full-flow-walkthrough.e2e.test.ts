import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';
import { invoice } from '../../src/db/schema/invoicing.js';
import { stockItem } from '../../src/db/schema/inventory.js';
import { order } from '../../src/db/schema/orders.js';
import { returnEvent, returnRequest } from '../../src/db/schema/returns.js';
import { shipment } from '../../src/db/schema/shipments.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * A narrated walkthrough of the whole implemented system.
 *
 * Unlike `customer-journey.e2e.test.ts`, which asserts hard and says little, this file exists
 * to be READ while it runs: every step prints the method, path, status and the fact that
 * mattered, so a human can watch the system work end to end in one scroll.
 *
 * It provisions BOTH actors from scratch — a brand-new customer and a brand-new admin — and
 * drives them through the real composition root against real PostgreSQL and real Redis. The
 * only substitution is `globalThis.fetch`, so the Razorpay adapter talks to a stub instead of
 * the internet; its HMAC verification, persistence and webhook de-duplication are real.
 *
 * **It stops where the implementation stops.** Staff return approval is Increment 40d and does
 * not exist yet, so the return flow runs as far as a customer can take it and then says so.
 * Nothing here pretends a feature works that has not been written.
 */
describe('full flow walkthrough (narrated)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const providerRefs: string[] = [];

  const RAZORPAY = {
    keyId: 'rzp_test_walkthrough',
    keySecret: 'walkthrough-api-secret',
    webhookSecret: 'walkthrough-webhook-secret',
  };

  const PASSWORD = 'a-sufficiently-long-password';
  const SELLER_STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const HSN = '61091000';

  let storeId = '';
  let adminToken = '';
  let customerToken = '';
  let customerId = '';
  let skuCode = '';
  let addressId = '';
  let orderNumber = '';
  let orderId = '';
  let shipmentId = '';
  let returnNumber = '';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /* ── Narration ─────────────────────────────────────────────────────────── */

  let step = 0;
  /**
   * Written straight to stdout, NOT through `console.log`.
   *
   * Vitest intercepts console output and re-emits it grouped under the test that produced it,
   * which collapses to nothing once output is redirected to a file. `process.stdout.write`
   * bypasses the interception, so the transcript survives `> log.txt` and CI capture alike —
   * and this file is worthless if its transcript does not reach the terminal.
   */
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const section = (title: string): void => {
    line('');
    line(`══════ ${title} ══════`);
  };
  /** One numbered row: what was called, what came back, and why it matters. */
  const log = (method: string, path: string, status: number, note: string): void => {
    step += 1;
    line(
      `${String(step).padStart(2, '0')}. ${method.padEnd(6)} ${path.padEnd(52)} → ${String(status).padEnd(3)}  ${note}`,
    );
  };
  const fact = (note: string): void => line(`    · ${note}`);

  const sign = (body: string): string =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    // Stubbed BEFORE the container: the gateway captures `fetch` at construction.
    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      const ref = `order_WALK_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    };

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
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    line('');
    line('╔════════════════════════════════════════════════════════════════════════╗');
    line('║  FULL FLOW WALKTHROUGH — real container, real Postgres, real Redis     ║');
    line('╚════════════════════════════════════════════════════════════════════════╝');
    line(`store seeded: ${storeId}`);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. Create both actors ═════════════════════════════════════════════ */

  it('creates a brand-new ADMIN and a brand-new CUSTOMER', async () => {
    section('1. ACTORS');

    /* ---- admin ---- */
    const adminEmail = `admin.${newId()}@example.com`;
    const admin = await container.identity.registerCustomer({
      storeId,
      input: { email: adminEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Admin' },
    });
    log('POST', '/auth/register (admin, via service)', 201, adminEmail);

    /*
     * Promoted by UPDATE, deliberately. No endpoint grants staff — that would be a
     * privilege-escalation route on a public API.
     */
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, admin.id));
    fact('promoted to staff via app_user.is_staff = true (no endpoint grants this)');

    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD });
    adminToken = adminLogin.body.accessToken as string;
    log('POST', '/api/v1/auth/login', adminLogin.status, 'admin signed in (SHARED login)');
    expect(adminLogin.status).toBe(200);
    fact(
      `tokenType=${adminLogin.body.tokenType as string} expiresIn=${String(adminLogin.body.expiresIn)}s`,
    );

    /* ---- customer ---- */
    const customerEmail = `shopper.${newId()}@example.com`;
    const registered = await api().post('/api/v1/auth/register').send({
      email: customerEmail,
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+91 9876543210',
    });
    log('POST', '/api/v1/auth/register', registered.status, customerEmail);
    expect(registered.status).toBe(201);
    customerId = registered.body.user.id as string;

    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD });
    customerToken = customerLogin.body.accessToken as string;
    log('POST', '/api/v1/auth/login', customerLogin.status, 'customer signed in');
    expect(customerLogin.status).toBe(200);
  });

  /* ══ 2. Authorization boundary ═════════════════════════════════════════ */

  it('proves the admin boundary: 401 anonymous, 403 customer, 200 admin', async () => {
    section('2. ADMIN AUTHORIZATION');

    const anon = await api().get('/api/v1/admin/products');
    log('GET', '/api/v1/admin/products', anon.status, 'no token → refused');
    expect(anon.status).toBe(401);

    const asShopper = await api().get('/api/v1/admin/products').set(asCustomer());
    log('GET', '/api/v1/admin/products', asShopper.status, 'customer token → forbidden');
    expect(asShopper.status).toBe(403);
    fact(
      `error.code=${asShopper.body.error.code as string} missing=${JSON.stringify(asShopper.body.error.details.missing)}`,
    );

    const asOps = await api().get('/api/v1/admin/products').set(asAdmin());
    log('GET', '/api/v1/admin/products', asOps.status, 'admin token → allowed');
    expect(asOps.status).toBe(200);
  });

  /* ══ 3. Admin builds the catalogue ═════════════════════════════════════ */

  it('lets the ADMIN build a catalogue, stock it, and configure GST', async () => {
    section('3. ADMIN — CATALOGUE, STOCK, PROMOTION, GST');

    const slug = `walkthrough-tee-${String(Date.now()).slice(-6)}`;
    skuCode = `WALK-TEE-${String(Date.now()).slice(-6)}`;

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asAdmin())
      .send({ slug, name: 'Walkthrough Tee', description: 'Soft cotton', status: 'active' });
    log('POST', '/api/v1/admin/products', product.status, slug);
    expect(product.status).toBe(201);

    const sku = await api()
      .post(`/api/v1/admin/products/${slug}/skus`)
      .set(asAdmin())
      .send({ code: skuCode, price: '500.0000' });
    log('POST', `/api/v1/admin/products/:slug/skus`, sku.status, `${skuCode} @ 500.0000`);
    expect(sku.status).toBe(201);

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asAdmin())
      .send({ skuCode, delta: 25, reason: 'manual_increase', note: 'walkthrough' });
    log('POST', '/api/v1/admin/inventory/adjustments', stocked.status, '+25 units on hand');
    expect(stocked.status).toBe(201);

    const promo = await api()
      .post('/api/v1/admin/promotions')
      .set(asAdmin())
      .send({
        code: `WALK10-${String(Date.now()).slice(-5)}`,
        name: '10% off',
        discountType: 'percentage',
        percentRate: '10',
        isActive: true,
      });
    log('POST', '/api/v1/admin/promotions', promo.status, '10% percentage promotion');
    expect(promo.status).toBe(201);
    couponCode = promo.body.promotion.code as string;

    const profile = await api().put('/api/v1/admin/store/tax-profile').set(asAdmin()).send({
      legalName: 'Walkthrough Retail Private Limited',
      gstin: SELLER_GSTIN,
      originLine1: '4th Floor, MG Road',
      originCity: 'Bengaluru',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log('PUT', '/api/v1/admin/store/tax-profile', profile.status, `seller GSTIN ${SELLER_GSTIN}`);
    expect(profile.status).toBe(200);

    const taxClass = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asAdmin())
      .send({ code: 'GST5', name: 'GST 5%', isActive: true });
    log('POST', '/api/v1/admin/tax-classes', taxClass.status, 'GST5');
    expect(taxClass.status).toBe(201);

    const rate = await api().post('/api/v1/admin/tax-classes/GST5/rates').set(asAdmin()).send({
      cgstRate: '2.5',
      sgstRate: '2.5',
      igstRate: '5',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    log('POST', '/api/v1/admin/tax-classes/:code/rates', rate.status, 'CGST 2.5 + SGST 2.5');
    expect(rate.status).toBe(201);

    const assigned = await api()
      .put(`/api/v1/admin/skus/${skuCode}/tax`)
      .set(asAdmin())
      .send({ taxClassCode: 'GST5', hsnCode: HSN });
    log('PUT', '/api/v1/admin/skus/:code/tax', assigned.status, `HSN ${HSN}`);
    expect(assigned.status).toBe(200);
  });

  let couponCode = '';

  /* ══ 4. Customer shops ═════════════════════════════════════════════════ */

  it('lets the CUSTOMER browse, search, build a cart and apply a promotion', async () => {
    section('4. CUSTOMER — BROWSE & CART');

    const list = await api().get('/api/v1/products');
    log(
      'GET',
      '/api/v1/products',
      list.status,
      `${String(list.body.products.length)} product(s), no auth needed`,
    );
    expect(list.status).toBe(200);

    const search = await api().get('/api/v1/products').query({ q: 'Walkthrough' });
    log(
      'GET',
      '/api/v1/products?q=Walkthrough',
      search.status,
      `${String(search.body.products.length)} match(es)`,
    );
    expect(search.status).toBe(200);

    const filtered = await api()
      .get('/api/v1/products')
      .query({ price_min: '100.0000', price_max: '600.0000' });
    log('GET', '/api/v1/products?price_min&price_max', filtered.status, 'price filter applied');
    expect(filtered.status).toBe(200);

    const added = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 3 });
    log('PUT', '/api/v1/users/me/cart/items/:sku', added.status, '3 units in cart');
    expect(added.status).toBe(200);
    fact(`subtotal=${added.body.cart.subtotal as string}`);

    const promo = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCustomer())
      .send({ code: couponCode });
    log('PUT', '/api/v1/users/me/cart/promotion', promo.status, `${couponCode} applied`);
    expect(promo.status).toBe(200);
    fact(`discountTotal=${promo.body.cart.discountTotal as string}`);

    const address = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'Ada Lovelace',
      phone: '+91 9876543210',
      line1: '12 Residency Road',
      city: 'Bengaluru',
      state: SELLER_STATE,
      postalCode: '560025',
    });
    log('POST', '/api/v1/users/me/addresses', address.status, 'shipping address created');
    expect(address.status).toBe(201);
    addressId = address.body.address.id as string;
  });

  /* ══ 5. Checkout ═══════════════════════════════════════════════════════ */

  it('checks out, freezing money and GST onto the order', async () => {
    section('5. CHECKOUT');

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `walk-${newId()}`)
      .send({ addressId });
    log('POST', '/api/v1/users/me/checkout', checkout.status, 'order placed');
    expect(checkout.status).toBe(201);

    const o = checkout.body.order;
    orderNumber = o.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    orderId = row!.id;

    fact(`orderNumber   = ${orderNumber}`);
    fact(`subtotal      = ${o.subtotal as string}`);
    fact(`discountTotal = ${o.discountTotal as string}`);
    fact(`total (goods) = ${o.total as string}`);
    fact(`taxTotal      = ${o.taxTotal as string}`);
    fact(`grandTotal    = ${o.grandTotal as string}   <- payable`);
    fact(`supplyType    = ${o.tax.supplyType as string} (seller and buyer both ${SELLER_STATE})`);
    fact(
      `line tax      = CGST ${o.items[0].tax.cgstAmount as string} + SGST ${o.items[0].tax.sgstAmount as string}, HSN ${o.items[0].tax.hsnCode as string}`,
    );

    // The money must foot, in minor units — never floats.
    const minor = (v: string) => BigInt(v.replace('.', ''));
    expect(minor(o.total)).toBe(minor(o.subtotal) - minor(o.discountTotal));
    expect(minor(o.grandTotal)).toBe(minor(o.total) + minor(o.taxTotal));

    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    fact(
      `inventory     = onHand ${String(stock[0]?.onHand)} / reserved ${String(stock[0]?.reserved)} (reserved, not deducted)`,
    );
    expect(stock[0]?.reserved).toBe(3);
  });

  /* ══ 6. Invoice ════════════════════════════════════════════════════════ */

  it('issued a statutory invoice at checkout', async () => {
    section('6. INVOICE');

    const [inv] = await db().select().from(invoice).where(eq(invoice.orderId, orderId));
    fact(`invoiceNumber = ${inv!.invoiceNumber}`);
    expect(inv!.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/u);

    const doc = await api().get(`/api/v1/users/me/orders/${orderNumber}/invoice`).set(asCustomer());
    log('GET', '/api/v1/users/me/orders/:n/invoice', doc.status, 'HTML document rendered');
    expect(doc.status).toBe(200);
    expect(doc.text).toContain(inv!.invoiceNumber);
    fact('document carries the invoice number, seller GSTIN and HSN summary');
  });

  /* ══ 7. Payment ════════════════════════════════════════════════════════ */

  it('takes an online payment and settles it via a signed webhook', async () => {
    section('7. PAYMENT (online / Razorpay)');

    const initiated = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `pay-${newId()}`)
      .send({ method: 'online' });
    log('POST', '/api/v1/users/me/orders/:n/payments', initiated.status, 'payment initiated');
    expect(initiated.status).toBe(201);
    fact(
      `status=${initiated.body.payment.status as string} provider=${initiated.body.handoff.provider as string} publicKey=${initiated.body.handoff.publicKey as string}`,
    );
    expect(JSON.stringify(initiated.body)).not.toContain(RAZORPAY.keySecret);
    fact('the API secret never appears in the response');

    const providerRef = providerRefs[providerRefs.length - 1]!;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_WALK', order_id: providerRef } } },
    });

    const hook = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt_walk_${newId()}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', hook.status, 'signed webhook accepted');
    expect(hook.status).toBe(200);

    const bad = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef')
      .set('x-razorpay-event-id', `evt_bad_${newId()}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', bad.status, 'BAD signature rejected');
    expect(bad.status).toBe(401);

    const state = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}/payment`)
      .set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/orders/:n/payment',
      state.status,
      `status=${state.body.payment.status as string}`,
    );
    expect(state.body.payment.status).toBe('succeeded');
  });

  /* ══ 8. Fulfilment ═════════════════════════════════════════════════════ */

  it('lets the ADMIN ship and deliver, and the customer track it', async () => {
    section('8. ADMIN — FULFILMENT');

    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin())
      .send({ carrier: 'Bluedart', trackingNumber: `BD-${String(Date.now()).slice(-8)}` });
    log('POST', '/api/v1/admin/orders/:n/shipments', created.status, 'shipment created (pending)');
    expect(created.status).toBe(201);
    shipmentId = created.body.shipment.id as string;

    const shipped = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/ship', shipped.status, 'pending → shipped');
    expect(shipped.status).toBe(200);

    const delivered = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/deliver', delivered.status, 'shipped → delivered');
    expect(delivered.status).toBe(200);

    const tracked = await api()
      .get(`/api/v1/users/me/orders/${orderNumber}/shipments`)
      .set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/orders/:n/shipments',
      tracked.status,
      `customer sees status=${tracked.body.shipments[0].status as string}`,
    );
    expect(tracked.body.shipments[0].status).toBe('delivered');

    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    fact(
      `inventory = onHand ${String(stock[0]?.onHand)} / reserved ${String(stock[0]?.reserved)} (deducted on fulfilment)`,
    );
    expect(stock[0]?.reserved).toBe(0);
  });

  /* ══ 9. Returns ════════════════════════════════════════════════════════ */

  it('runs the return lifecycle: customer raises, STAFF approves and rejects', async () => {
    section('9. RETURNS — customer raises, staff decides (40c + 40d)');

    const created = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
      .set(asCustomer())
      .set('idempotency-key', `ret-${newId()}`)
      .send({ reason: 'defective', customerNote: 'seam split', lines: [{ skuCode, quantity: 1 }] });
    log('POST', '/api/v1/users/me/orders/:n/returns', created.status, 'customer raises a return');
    expect(created.status).toBe(201);

    const r = created.body.return;
    returnNumber = r.returnNumber as string;
    fact(`returnNumber  = ${returnNumber}  status=${r.status as string}`);
    fact(`refund goods  = ${r.refundTaxableValue as string}`);
    fact(`refund tax    = ${r.refundTaxTotal as string}`);
    fact(
      `refund total  = ${r.refundTotal as string}  (1 of 3 units, apportioned from the FROZEN order line)`,
    );

    const listed = await api().get('/api/v1/users/me/returns').set(asCustomer());
    log('GET', '/api/v1/users/me/returns', listed.status, `${String(listed.body.total)} return(s)`);
    expect(listed.status).toBe(200);

    /* ---- the staff queue ---- */

    const queue = await api()
      .get('/api/v1/admin/returns')
      .query({ status: 'requested' })
      .set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/returns?status=requested',
      queue.status,
      `${String(queue.body.total)} awaiting a decision`,
    );
    expect(queue.status).toBe(200);
    expect(
      (queue.body.returns as { returnNumber: string }[]).some(
        (x) => x.returnNumber === returnNumber,
      ),
    ).toBe(true);
    fact('staff see staffNote and the per-line inspection counts; customers see neither');

    const staffRead = await api().get(`/api/v1/admin/returns/${returnNumber}`).set(asAdmin());
    log('GET', '/api/v1/admin/returns/:n', staffRead.status, 'staff read the full record');
    expect(staffRead.status).toBe(200);

    /* ---- a customer cannot decide their own case ---- */

    const selfApprove = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(asCustomer())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      selfApprove.status,
      'CUSTOMER cannot approve their own return',
    );
    expect(selfApprove.status).toBe(403);

    /* ---- the cancellation boundary, now reached honestly ---- */

    const tooEarly = await api()
      .post(`/api/v1/users/me/returns/${returnNumber}/cancel`)
      .set(asCustomer())
      .send({});
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      tooEarly.status,
      'refused: only cancellable once APPROVED',
    );
    expect(tooEarly.status).toBe(409);

    const approved = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(asAdmin())
      .send({ staffNote: 'photos check out' });
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      approved.status,
      'STAFF approve → requested becomes approved',
    );
    expect(approved.status).toBe(200);
    expect(approved.body.return.status).toBe('approved');
    fact(
      `staffNote     = ${approved.body.return.staffNote as string} (internal, never shown to the customer)`,
    );
    // Approval agrees to a return; it never edits one.
    expect(approved.body.return.refundTotal).toBe(r.refundTotal);
    fact('refund total unchanged by approval — the frozen snapshot is not recomputed');

    const twice = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/returns/:n/approve', twice.status, 'approving twice is refused');
    expect(twice.status).toBe(409);

    const cancelled = await api()
      .post(`/api/v1/users/me/returns/${returnNumber}/cancel`)
      .set(asCustomer())
      .send({});
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      cancelled.status,
      'customer withdraws the approved return',
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.return.status).toBe('cancelled');

    /* ---- rejection releases the quantity ---- */

    const second = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
      .set(asCustomer())
      .set('idempotency-key', `ret2-${newId()}`)
      .send({ reason: 'not_as_described', lines: [{ skuCode, quantity: 3 }] });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/returns',
      second.status,
      'all 3 units returnable again after the cancel',
    );
    expect(second.status).toBe(201);
    const secondNumber = second.body.return.returnNumber as string;

    const rejected = await api()
      .post(`/api/v1/admin/returns/${secondNumber}/reject`)
      .set(asAdmin())
      .send({ staffNote: 'outside the policy window' });
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      rejected.status,
      'STAFF reject → no refund, no restock',
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.return.status).toBe('rejected');
    expect(rejected.body.return.closedAt).not.toBeNull();

    const third = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
      .set(asCustomer())
      .set('idempotency-key', `ret3-${newId()}`)
      .send({ reason: 'defective', lines: [{ skuCode, quantity: 3 }] });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/returns',
      third.status,
      'a rejected return also RELEASES its quantity',
    );
    expect(third.status).toBe(201);
    returnNumber = third.body.return.returnNumber as string;

    /* ---- the append-only history ---- */

    const [header] = await db()
      .select()
      .from(returnRequest)
      .where(eq(returnRequest.returnNumber, secondNumber));
    const events = await db()
      .select()
      .from(returnEvent)
      .where(eq(returnEvent.returnId, header!.id));
    fact(`history       = ${events.map((e) => e.toStatus).join(' → ')} (append-only)`);
    expect(events.map((e) => e.toStatus)).toEqual(['requested', 'rejected']);
  });
  /* ══ 10. Isolation ═════════════════════════════════════════════════════ */

  it('keeps one customer out of another customer data', async () => {
    section('10. ISOLATION');

    const email = `intruder.${newId()}@example.com`;
    await api()
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, firstName: 'Mallory', lastName: 'X' });
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const headers = { Authorization: `Bearer ${login.body.accessToken as string}` };
    log('POST', '/api/v1/auth/login', login.status, 'a second, unrelated customer');

    for (const [path, label] of [
      [`/api/v1/users/me/orders/${orderNumber}`, 'order'],
      [`/api/v1/users/me/orders/${orderNumber}/invoice`, 'invoice'],
      [`/api/v1/users/me/orders/${orderNumber}/payment`, 'payment'],
      [`/api/v1/users/me/returns/${returnNumber}`, 'return'],
    ] as const) {
      const response = await api().get(path).set(headers);
      log(
        'GET',
        path.replace(orderNumber, ':n').replace(returnNumber, ':r'),
        response.status,
        `${label} hidden (404, not 403)`,
      );
      expect(response.status).toBe(404);
    }
  });

  /* ══ 11. Summary ═══════════════════════════════════════════════════════ */

  it('prints the final state', async () => {
    section('SUMMARY');

    const orders = await db().select().from(order).where(eq(order.storeId, storeId));
    const invoices = await db().select().from(invoice).where(eq(invoice.storeId, storeId));
    const returns = await db()
      .select()
      .from(returnRequest)
      .where(eq(returnRequest.storeId, storeId));
    const shipments = await db().select().from(shipment).where(eq(shipment.storeId, storeId));
    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));

    line(`  orders      : ${String(orders.length)}  (${orders.map((o) => o.status).join(', ')})`);
    line(
      `  invoices    : ${String(invoices.length)}  (${invoices.map((i) => i.invoiceNumber).join(', ')})`,
    );
    line(
      `  shipments   : ${String(shipments.length)}  (${shipments.map((s) => s.status).join(', ')})`,
    );
    line(`  returns     : ${String(returns.length)}  (${returns.map((r) => r.status).join(', ')})`);
    line(
      `  inventory   : onHand ${String(stock[0]?.onHand)} / reserved ${String(stock[0]?.reserved)}`,
    );
    line(`  customer    : ${customerId}`);
    line('');
    line('  NOT YET IMPLEMENTED (out of scope for this build):');
    line('    · return receipt, inspection, restock    — Increment 40e');
    line('    · refund execution (COD + Razorpay)      — Increment 40f');
    line('    · credit notes for returned GST          — not approved');
    line('');

    expect(orders.length).toBeGreaterThan(0);
  });
});
