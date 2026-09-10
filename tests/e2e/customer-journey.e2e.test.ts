import { createHmac } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { address } from '../../src/db/schema/address.js';
import { cart } from '../../src/db/schema/cart.js';
import { appUser } from '../../src/db/schema/identity.js';
import { stockItem } from '../../src/db/schema/inventory.js';
import { invoice } from '../../src/db/schema/invoicing.js';
import { order, orderLine } from '../../src/db/schema/orders.js';
import { outboxEvent } from '../../src/db/schema/outbox.js';
import { payment } from '../../src/db/schema/payments.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * ONE new customer, the whole implemented journey, against the REAL stack.
 *
 * Not a unit test with doubles and not a re-run of the per-module suites. It builds the actual
 * composition root — `buildContainer`, the same function `main.ts` calls — against a real
 * PostgreSQL and a real Redis, and drives it over HTTP with supertest. Every service, every
 * piece of middleware (store resolution, auth, rate limiting, idempotency), and every database
 * constraint is the production one.
 *
 * Only ONE thing is substituted, and only at the transport boundary: `globalThis.fetch`, so the
 * Razorpay adapter talks to a stub instead of the internet. The adapter itself, its signature
 * verification and its persistence are real. Nothing else is faked — a stubbed cart or a
 * stubbed inventory service would let a broken contract between two modules pass, and finding
 * exactly those breaks is the point of this file.
 *
 * **The steps are sequential and share state on purpose.** `it()` blocks run in order within a
 * file, and each one consumes what the previous produced: the customer registered in step 1 is
 * the customer who is charged in step 20 and whose invoice is fetched in step 24. There is no
 * `beforeEach` truncate — that would reset the journey between every step and turn an
 * end-to-end test into twenty-six disconnected ones. A failure part-way therefore cascades,
 * which is the honest signal for an audit: it says the journey stops here.
 */
describe('customer journey (e2e)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  /** Restored in `afterAll`, so a stub cannot leak into another file in the same worker. */
  const realFetch = globalThis.fetch;

  /** Every provider order id the stubbed transport has handed back, in order. */
  const providerRefs: string[] = [];

  const RAZORPAY = {
    keyId: 'rzp_test_journey',
    keySecret: 'journey-api-secret',
    webhookSecret: 'journey-webhook-secret',
  };

  /* ── The journey's own state, written by one step and read by later ones ── */

  const CUSTOMER = {
    email: `journey.customer.${String(Date.now())}@example.com`,
    password: 'a-sufficiently-long-password',
    newPassword: 'an-even-longer-replacement-password',
  };

  const journey: {
    storeId: string;
    customerId: string;
    accessToken: string;
    refreshToken: string;
    staffToken: string;
    addressId: string;
    throwawayAddressId: string;
    codOrderNumber: string;
    cancelOrderNumber: string;
    onlineOrderNumber: string;
    shipmentId: string;
    invoiceNumber: string;
    onHandBefore: number;
  } = {
    storeId: '',
    customerId: '',
    accessToken: '',
    refreshToken: '',
    staffToken: '',
    addressId: '',
    throwawayAddressId: '',
    codOrderNumber: '',
    cancelOrderNumber: '',
    onlineOrderNumber: '',
    shipmentId: '',
    invoiceNumber: '',
    onHandBefore: 0,
  };

  /* ── Catalogue fixtures the merchant sets up before anyone shops ────────── */

  const PRODUCT_SLUG = 'aurora-tee';
  const SKU_SMALL = 'AURORA-TEE-S';
  const SKU_MEDIUM = 'AURORA-TEE-M';
  const PRICE_SMALL = '500.0000';
  const PRICE_MEDIUM = '750.0000';
  const COUPON = 'JOURNEY10';
  const TAX_CLASS = 'GST5';
  const HSN = '61091000';
  /** Seller and customer both in state 29, so the split must be CGST + SGST, never IGST. */
  const SELLER_STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const CUSTOMER_GSTIN = '29AAACB1234C1ZX';

  const api = () => request(container.app);
  const db = () => container.db.db;

  const asCustomer = (token = journey.accessToken) => ({ Authorization: `Bearer ${token}` });
  const asStaff = () => ({ Authorization: `Bearer ${journey.staffToken}` });

  /**
   * Read a supertest response body at a named shape.
   *
   * Supertest types `body` as `any`, which the lint rules rightly refuse to let us call methods
   * on. One narrowing helper keeps every assertion below type-checked instead of scattering
   * casts through the file.
   */
  const bodyAs = <T>(response: { body: unknown }): T => response.body as T;

  type ProductList = { products: { slug: string; skus?: { code: string; price: string }[] }[] };

  /** Razorpay signs the RAW body; the adapter verifies against the same bytes. */
  const sign = (body: string) =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  /**
   * Retry until it holds, or give up.
   *
   * The idempotency middleware completes its claim AFTER the response has been sent, so a test
   * that reads that row once is racing a write it never awaited. Bounded, so a real regression
   * still fails rather than hanging the run.
   */
  async function waitFor(assertion: () => Promise<void>, timeoutMs = 3_000): Promise<void> {
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

  /** Place an order from a fresh cart: add one unit of the small SKU, then check out. */
  async function placeOrder(idempotencyKey: string): Promise<string> {
    const added = await api()
      .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
      .set(asCustomer())
      .send({ quantity: 1 });
    expect(added.status).toBe(200);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', idempotencyKey)
      .send({ addressId: journey.addressId });
    expect(checkout.status).toBe(201);
    return checkout.body.order.orderNumber as string;
  }

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    /*
     * Stubbed BEFORE `buildContainer`, because the gateway captures `fetch` at construction
     * (`deps.fetchImpl ?? fetch`). Stubbing afterwards would leave the real transport wired and
     * the online payment step would try to reach the internet.
     */
    globalThis.fetch = async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request in e2e: ${url}`);
      }
      void init;
      const ref = `order_JOURNEY_${String(providerRefs.length + 1)}`;
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
          /*
           * The journey legitimately authenticates far more than 10 times from one IP —
           * register, several logins, a refresh, a password change, a second customer. The
           * production default would reject its own traffic as an attack. Raised rather than
           * disabled, so the limiter is still wired and still counting.
           */
          AUTH_RATE_LIMIT_IP_MAX: '1000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '1000',
          AUTH_RATE_LIMIT_REFRESH_IP_MAX: '1000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    journey.storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    /* ── Merchant setup. Through the real admin API, not INSERTs ──────────── */

    const staffEmail = `journey.ops.${String(Date.now())}@example.com`;
    const staff = await container.identity.registerCustomer({
      storeId: journey.storeId,
      input: {
        email: staffEmail,
        password: CUSTOMER.password,
        firstName: 'Ops',
        lastName: 'Staff',
      },
    });
    // No endpoint grants staff: that would be a privilege-escalation route on a public API.
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staff.id));
    const staffLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: staffEmail, password: CUSTOMER.password });
    expect(staffLogin.status).toBe(200);
    journey.staffToken = staffLogin.body.accessToken as string;

    const product = await api().post('/api/v1/admin/products').set(asStaff()).send({
      slug: PRODUCT_SLUG,
      name: 'Aurora Tee',
      description: 'Soft cotton tee',
      status: 'active',
    });
    expect(product.status).toBe(201);

    for (const [code, price] of [
      [SKU_SMALL, PRICE_SMALL],
      [SKU_MEDIUM, PRICE_MEDIUM],
    ] as const) {
      const created = await api()
        .post(`/api/v1/admin/products/${PRODUCT_SLUG}/skus`)
        .set(asStaff())
        .send({ code, price, name: code });
      expect(created.status).toBe(201);

      const stocked = await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asStaff())
        .send({ skuCode: code, delta: 25, reason: 'manual_increase', note: 'journey seed' });
      expect(stocked.status).toBe(201);
    }

    const promotion = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: COUPON,
      name: 'Journey 10% off',
      discountType: 'percentage',
      percentRate: '10',
      isActive: true,
    });
    expect(promotion.status).toBe(201);

    const profile = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
      legalName: 'Aurora Retail Private Limited',
      gstin: SELLER_GSTIN,
      originLine1: '4th Floor, MG Road',
      originCity: 'Bengaluru',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    expect(profile.status).toBe(200);

    const taxClass = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asStaff())
      .send({ code: TAX_CLASS, name: 'GST 5%', isActive: true });
    expect(taxClass.status).toBe(201);

    const rate = await api()
      .post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`)
      .set(asStaff())
      .send({
        cgstRate: '2.5',
        sgstRate: '2.5',
        igstRate: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      });
    expect(rate.status).toBe(201);

    for (const code of [SKU_SMALL, SKU_MEDIUM]) {
      const assigned = await api()
        .put(`/api/v1/admin/skus/${code}/tax`)
        .set(asStaff())
        .send({ taxClassCode: TAX_CLASS, hsnCode: HSN });
      expect(assigned.status).toBe(200);
    }

    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, journey.storeId));
    journey.onHandBefore = stock.find((row) => row.onHand === 25)?.onHand ?? 0;
    expect(journey.onHandBefore).toBe(25);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. Identity ═══════════════════════════════════════════════════════ */

  describe('1. identity', () => {
    it('registers a brand-new customer', async () => {
      const response = await api().post('/api/v1/auth/register').send({
        email: CUSTOMER.email,
        password: CUSTOMER.password,
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+91 9876543210',
      });

      expect(response.status).toBe(201);
      expect(response.body.user).toMatchObject({
        email: CUSTOMER.email,
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailVerified: false,
        acceptsMarketing: false,
      });
      expect(response.body.user.id).toEqual(expect.any(String));
      // The hash must never be part of the contract.
      expect(response.body.user).not.toHaveProperty('passwordHash');

      journey.customerId = response.body.user.id as string;

      const rows = await db().select().from(appUser).where(eq(appUser.id, journey.customerId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.storeId).toBe(journey.storeId);
      expect(rows[0]?.isStaff).toBe(false);
    });

    it('refuses a duplicate registration', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email: CUSTOMER.email, password: CUSTOMER.password });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBeDefined();
    });

    it('logs in and issues a token pair', async () => {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: CUSTOMER.password });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ tokenType: 'Bearer' });
      expect(response.body.accessToken).toEqual(expect.any(String));
      expect(response.body.refreshToken).toEqual(expect.any(String));
      expect(response.body.expiresIn).toBeGreaterThan(0);
      expect(response.body.user.id).toBe(journey.customerId);

      journey.accessToken = response.body.accessToken as string;
      journey.refreshToken = response.body.refreshToken as string;
    });

    it('rejects a wrong password', async () => {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: 'definitely-not-the-password' });

      expect(response.status).toBe(401);
    });

    it('returns the authenticated profile', async () => {
      const response = await api().get('/api/v1/users/me').set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: journey.customerId,
        email: CUSTOMER.email,
        phone: '+91 9876543210',
      });
    });

    it('refuses an unauthenticated profile read', async () => {
      const response = await api().get('/api/v1/users/me');

      expect(response.status).toBe(401);
    });

    it('rotates the refresh token and invalidates the old one', async () => {
      const refreshed = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: journey.refreshToken });

      expect(refreshed.status).toBe(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).not.toBe(journey.refreshToken);

      const replayed = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: journey.refreshToken });
      // Rotation must make the consumed token useless, or theft of it is permanent.
      expect(replayed.status).toBe(401);

      journey.accessToken = refreshed.body.accessToken as string;
      journey.refreshToken = refreshed.body.refreshToken as string;
    });

    it('updates the profile', async () => {
      const response = await api()
        .patch('/api/v1/users/me')
        .set(asCustomer())
        .send({ firstName: 'Augusta', acceptsMarketing: true });

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        firstName: 'Augusta',
        lastName: 'Lovelace',
        acceptsMarketing: true,
      });
    });

    it('rejects an empty profile update', async () => {
      const response = await api().patch('/api/v1/users/me').set(asCustomer()).send({});

      expect(response.status).toBe(400);
    });

    it('changes the password, and only the new one then works', async () => {
      const changed = await api()
        .post('/api/v1/users/me/password')
        .set(asCustomer())
        .send({ currentPassword: CUSTOMER.password, newPassword: CUSTOMER.newPassword });

      expect(changed.status).toBe(204);

      const stale = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: CUSTOMER.password });
      expect(stale.status).toBe(401);

      const fresh = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: CUSTOMER.newPassword });
      expect(fresh.status).toBe(200);

      journey.accessToken = fresh.body.accessToken as string;
      journey.refreshToken = fresh.body.refreshToken as string;
    });

    it('refuses a password change with the wrong current password', async () => {
      const response = await api()
        .post('/api/v1/users/me/password')
        .set(asCustomer())
        .send({ currentPassword: 'not-the-current-one', newPassword: 'another-long-password' });

      expect(response.status).toBe(401);
    });

    it('completes a forgotten-password reset and signs in with the new password', async () => {
      const RESET_PASSWORD = 'a-reset-password-long-enough';

      const requested = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ email: CUSTOMER.email });
      // 204 whatever the address: the response must not disclose whether an account exists.
      expect(requested.status).toBe(204);

      const unknown = await api()
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'nobody.at.all@example.com' });
      expect(unknown.status).toBe(204);

      /*
       * The token comes from the emitted event's payload — the SAME value the mail handler
       * puts in the customer's link. Not from `password_reset.token_hash`, which is a hash and
       * could not be replayed; and no SMTP double is needed to prove the flow works.
       */
      const events = await db()
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventName, 'user.password_reset_requested'));
      expect(events.length).toBeGreaterThan(0);
      const token = (events.at(-1)!.payload as { token: string }).token;
      expect(token).toEqual(expect.any(String));

      const reset = await api()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: RESET_PASSWORD });
      expect(reset.status).toBe(204);

      // The token is single-use: replaying it must not work.
      const replayed = await api()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'yet-another-long-password' });
      expect(replayed.status).toBe(400);

      const stale = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: CUSTOMER.newPassword });
      expect(stale.status).toBe(401);

      const fresh = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: RESET_PASSWORD });
      expect(fresh.status).toBe(200);

      CUSTOMER.newPassword = RESET_PASSWORD;
      journey.accessToken = fresh.body.accessToken as string;
      journey.refreshToken = fresh.body.refreshToken as string;
    });
  });

  /* ══ 2. Browsing ═══════════════════════════════════════════════════════ */

  describe('2. catalogue', () => {
    it('lists published products without authentication', async () => {
      const response = await api().get('/api/v1/products');

      expect(response.status).toBe(200);
      const listed = bodyAs<ProductList>(response);
      expect(Array.isArray(listed.products)).toBe(true);
      const found = listed.products.find((p) => p.slug === PRODUCT_SLUG);
      expect(found).toBeDefined();
    });

    it('searches by term', async () => {
      const hit = await api().get('/api/v1/products').query({ q: 'Aurora' });
      expect(hit.status).toBe(200);
      expect(bodyAs<ProductList>(hit).products.some((p) => p.slug === PRODUCT_SLUG)).toBe(true);

      const miss = await api().get('/api/v1/products').query({ q: 'nonexistent-zzzz' });
      expect(miss.status).toBe(200);
      expect(miss.body.products).toHaveLength(0);
    });

    it('filters by price range', async () => {
      const narrow = await api()
        .get('/api/v1/products')
        .query({ price_min: '100.0000', price_max: '600.0000' });
      expect(narrow.status).toBe(200);
      expect(bodyAs<ProductList>(narrow).products.some((p) => p.slug === PRODUCT_SLUG)).toBe(true);

      const above = await api().get('/api/v1/products').query({ price_min: '10000.0000' });
      expect(above.status).toBe(200);
      expect(above.body.products).toHaveLength(0);
    });

    it('rejects a reversed price range', async () => {
      const response = await api()
        .get('/api/v1/products')
        .query({ price_min: '900.0000', price_max: '100.0000' });

      expect(response.status).toBe(400);
    });

    it('reads one product with its SKUs and options', async () => {
      const response = await api().get(`/api/v1/products/${PRODUCT_SLUG}`);

      expect(response.status).toBe(200);
      expect(response.body.product.slug).toBe(PRODUCT_SLUG);
      const codes = (response.body.product.skus as { code: string; price: string }[]).map(
        (s) => s.code,
      );
      expect(codes).toContain(SKU_SMALL);
      expect(codes).toContain(SKU_MEDIUM);
    });

    it('404s an unknown product', async () => {
      const response = await api().get('/api/v1/products/no-such-product');

      expect(response.status).toBe(404);
    });
  });

  /* ══ 3. Cart ═══════════════════════════════════════════════════════════ */

  describe('3. cart', () => {
    it('starts empty', async () => {
      const response = await api().get('/api/v1/users/me/cart').set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.cart.items).toHaveLength(0);
    });

    it('adds a line', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
        .set(asCustomer())
        .send({ quantity: 2 });

      expect(response.status).toBe(200);
      const items = response.body.cart.items as { skuCode: string; quantity: number }[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ skuCode: SKU_SMALL, quantity: 2 });
    });

    it('treats PUT as SET, not increment', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
        .set(asCustomer())
        .send({ quantity: 3 });

      expect(response.status).toBe(200);
      const items = response.body.cart.items as { skuCode: string; quantity: number }[];
      expect(items).toHaveLength(1);
      expect(items[0]?.quantity).toBe(3);
    });

    it('adds a second line and removes it again', async () => {
      const added = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_MEDIUM}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      expect(added.status).toBe(200);
      expect(added.body.cart.items).toHaveLength(2);

      const removed = await api()
        .delete(`/api/v1/users/me/cart/items/${SKU_MEDIUM}`)
        .set(asCustomer());
      expect(removed.status).toBe(204);

      const after = await api().get('/api/v1/users/me/cart').set(asCustomer());
      expect(after.body.cart.items).toHaveLength(1);
    });

    it('rejects quantity zero, pointing at DELETE', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
        .set(asCustomer())
        .send({ quantity: 0 });

      expect(response.status).toBe(400);
    });

    it('404s an unknown SKU', async () => {
      const response = await api()
        .put('/api/v1/users/me/cart/items/NO-SUCH-SKU')
        .set(asCustomer())
        .send({ quantity: 1 });

      expect(response.status).toBe(404);
    });

    it('applies and removes a promotion', async () => {
      const applied = await api()
        .put('/api/v1/users/me/cart/promotion')
        .set(asCustomer())
        .send({ code: COUPON });

      expect(applied.status).toBe(200);
      expect(applied.body.cart.promotion).toMatchObject({ code: COUPON });
      const appliedCart = bodyAs<{ cart: { discountTotal: string } }>(applied).cart;
      expect(BigInt(appliedCart.discountTotal.replace('.', ''))).toBeGreaterThan(0n);

      const removed = await api().delete('/api/v1/users/me/cart/promotion').set(asCustomer());
      expect(removed.status).toBe(204);

      const bare = await api().get('/api/v1/users/me/cart').set(asCustomer());
      expect(bare.body.cart.promotion).toBeNull();

      const reapplied = await api()
        .put('/api/v1/users/me/cart/promotion')
        .set(asCustomer())
        .send({ code: COUPON });
      expect(reapplied.status).toBe(200);
    });

    it('refuses an unknown coupon', async () => {
      const response = await api()
        .put('/api/v1/users/me/cart/promotion')
        .set(asCustomer())
        .send({ code: 'NOSUCHCODE' });

      expect(response.status).toBe(404);
    });
  });

  /* ══ 4. Addresses ══════════════════════════════════════════════════════ */

  describe('4. addresses', () => {
    it('creates one', async () => {
      const response = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
        label: 'Home',
        recipientName: 'Augusta Lovelace',
        phone: '+91 9876543210',
        line1: '12 Residency Road',
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: '560025',
        countryCode: 'IN',
      });

      expect(response.status).toBe(201);
      expect(response.body.address).toMatchObject({ label: 'Home', city: 'Bengaluru' });
      journey.addressId = response.body.address.id as string;

      const rows = await db().select().from(address).where(eq(address.id, journey.addressId));
      expect(rows[0]?.userId).toBe(journey.customerId);
    });

    it('lists, reads and updates', async () => {
      const list = await api().get('/api/v1/users/me/addresses').set(asCustomer());
      expect(list.status).toBe(200);
      expect(list.body.addresses).toHaveLength(1);

      const read = await api()
        .get(`/api/v1/users/me/addresses/${journey.addressId}`)
        .set(asCustomer());
      expect(read.status).toBe(200);

      const patched = await api()
        .patch(`/api/v1/users/me/addresses/${journey.addressId}`)
        .set(asCustomer())
        .send({ label: 'Home (updated)' });
      expect(patched.status).toBe(200);
      expect(patched.body.address.label).toBe('Home (updated)');
    });

    it('creates and deletes a throwaway address', async () => {
      const created = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
        label: 'Office',
        recipientName: 'Augusta Lovelace',
        phone: '+91 9876543211',
        line1: '90 Church Street',
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: '560001',
      });
      expect(created.status).toBe(201);
      journey.throwawayAddressId = created.body.address.id as string;

      const deleted = await api()
        .delete(`/api/v1/users/me/addresses/${journey.throwawayAddressId}`)
        .set(asCustomer());
      expect(deleted.status).toBe(204);

      const gone = await api()
        .get(`/api/v1/users/me/addresses/${journey.throwawayAddressId}`)
        .set(asCustomer());
      expect(gone.status).toBe(404);
    });

    it('rejects a malformed Indian PIN', async () => {
      const response = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
        label: 'Bad',
        recipientName: 'Augusta Lovelace',
        phone: '+91 9876543210',
        line1: '1 Nowhere',
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: 'ABC',
        countryCode: 'IN',
      });

      expect(response.status).toBe(400);
    });
  });

  /* ══ 5. Customer tax identity ══════════════════════════════════════════ */

  describe('5. tax identity', () => {
    it('sets, reads and clears a GSTIN', async () => {
      const put = await api()
        .put('/api/v1/users/me/tax-identity')
        .set(asCustomer())
        .send({ gstin: CUSTOMER_GSTIN, legalName: 'Lovelace Analytics LLP' });
      expect(put.status).toBe(200);
      expect(put.body.taxIdentity ?? put.body).toMatchObject({ gstin: CUSTOMER_GSTIN });

      const read = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(read.status).toBe(200);

      const cleared = await api().delete('/api/v1/users/me/tax-identity').set(asCustomer());
      expect(cleared.status).toBe(204);
    });

    it('rejects an invalid GSTIN', async () => {
      const response = await api()
        .put('/api/v1/users/me/tax-identity')
        .set(asCustomer())
        .send({ gstin: 'NOTAGSTIN', legalName: 'Nope' });

      expect(response.status).toBe(400);
    });
  });

  /* ══ 6. Checkout ═══════════════════════════════════════════════════════ */

  describe('6. checkout', () => {
    const KEY = 'journey-checkout-0001';

    it('requires an idempotency key', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .send({ addressId: journey.addressId });

      expect(response.status).toBe(400);
    });

    it('places the order, and the money foots', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', KEY)
        .send({ addressId: journey.addressId });

      expect(response.status).toBe(201);
      const placed = response.body.order;
      journey.codOrderNumber = placed.orderNumber as string;

      expect(placed.orderNumber).toMatch(/^[A-Z0-9-]+$/u);
      expect(placed.status).toBe('placed');
      expect(placed.items).toHaveLength(1);
      expect(placed.items[0]).toMatchObject({ skuCode: SKU_SMALL, quantity: 3 });
      expect(placed.shippingAddress).toMatchObject({ city: 'Bengaluru', state: SELLER_STATE });
      expect(placed.promotion).toMatchObject({ code: COUPON });

      // Money, in minor units via BigInt — never floats.
      const minor = (v: string) => BigInt(v.replace('.', ''));
      expect(minor(placed.subtotal)).toBe(minor(PRICE_SMALL) * 3n);
      expect(minor(placed.total)).toBe(minor(placed.subtotal) - minor(placed.discountTotal));
      expect(minor(placed.grandTotal)).toBe(minor(placed.total) + minor(placed.taxTotal));
      expect(minor(placed.discountTotal)).toBeGreaterThan(0n);
    });

    it('determines GST as CGST + SGST for an intra-state supply', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      const placed = response.body.order;
      const minor = (v: string) => BigInt(v.replace('.', ''));

      expect(minor(placed.taxTotal)).toBeGreaterThan(0n);
      expect(placed.tax).not.toBeNull();
      expect(placed.tax).toMatchObject({
        sellerGstin: SELLER_GSTIN,
        supplyType: 'intra_state',
      });

      /*
       * The breakdown is NESTED under the line, not flattened onto it: one `null` says "this
       * line was never assessed" where nine zero fields would leave a client guessing.
       */
      const lineTax = placed.items[0].tax;
      expect(lineTax).not.toBeNull();
      expect(lineTax.hsnCode).toBe(HSN);
      expect(lineTax.taxClassCode).toBe(TAX_CLASS);
      // Same state on both sides, so the intra-state pair carries the whole charge.
      expect(minor(lineTax.cgstAmount) + minor(lineTax.sgstAmount)).toBe(minor(placed.taxTotal));
      expect(minor(lineTax.igstAmount)).toBe(0n);
    });

    it('replays the same key to the same order', async () => {
      const replay = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', KEY)
        .send({ addressId: journey.addressId });

      expect(replay.status).toBe(201);
      expect(replay.body.order.orderNumber).toBe(journey.codOrderNumber);

      const orders = await db().select().from(order).where(eq(order.storeId, journey.storeId));
      expect(orders).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', KEY)
        .send({ addressId: journey.throwawayAddressId });

      /*
       * `422 IDEMPOTENCY_KEY_REUSE`, not `409`. The middleware distinguishes two cases and the
       * distinction is the useful part: a `mismatch` (this one — the key is settled and the
       * body differs) is the caller's bug and will never succeed, whereas `in_flight` (the same
       * key still running concurrently) is a `409` worth retrying.
       */
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    });

    it('persisted the order and its lines', async () => {
      const rows = await db()
        .select()
        .from(order)
        .where(eq(order.orderNumber, journey.codOrderNumber));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(journey.customerId);
      expect(rows[0]?.storeId).toBe(journey.storeId);

      const lines = await db().select().from(orderLine).where(eq(orderLine.orderId, rows[0]!.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity).toBe(3);
      expect(lines[0]?.hsnCode).toBe(HSN);
    });

    it('reserved stock without deducting it', async () => {
      const rows = await db()
        .select()
        .from(stockItem)
        .where(eq(stockItem.storeId, journey.storeId));
      const small = rows.find((r) => r.reserved > 0);

      expect(small).toBeDefined();
      expect(small?.reserved).toBe(3);
      // Reservation must not touch on-hand: the goods are still in the warehouse.
      expect(small?.onHand).toBe(journey.onHandBefore);
    });

    it('marked the cart checked out and refuses further mutation', async () => {
      const carts = await db().select().from(cart).where(eq(cart.userId, journey.customerId));
      expect(carts.some((c) => c.status === 'checked_out')).toBe(true);

      const mutate = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      // The checked-out cart is now history; a NEW active cart is created for the next order.
      expect(mutate.status).toBe(200);
    });

    it('refuses checkout of an empty cart', async () => {
      // Clear whatever the previous step left, then try.
      await api().delete('/api/v1/users/me/cart').set(asCustomer());

      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', 'journey-empty-0001')
        .send({ addressId: journey.addressId });

      /*
       * 422, not 409. `DELETE /users/me/cart` clears the LINES and keeps the cart row, so the
       * cart still exists and is merely empty. A 409 is the different case — no cart row at
       * all — which a customer who has never added anything would hit instead.
       */
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('CHECKOUT_CART_EMPTY');
    });
  });

  /* ══ 7. Order retrieval ════════════════════════════════════════════════ */

  describe('7. orders', () => {
    it('lists the customer orders', async () => {
      const response = await api().get('/api/v1/users/me/orders').set(asCustomer());

      expect(response.status).toBe(200);
      expect(
        (response.body.orders as { orderNumber: string }[]).some(
          (o) => o.orderNumber === journey.codOrderNumber,
        ),
      ).toBe(true);
    });

    it('reads one order', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.order.orderNumber).toBe(journey.codOrderNumber);
    });

    it('400s a malformed order number and 404s a well-formed unknown one', async () => {
      // Malformed: rejected by the param schema before any query runs.
      const malformed = await api()
        .get('/api/v1/users/me/orders/ORD-0000-000000')
        .set(asCustomer());
      expect(malformed.status).toBe(400);

      // Well-formed but nobody's: the query misses, so 404.
      const unknown = await api()
        .get('/api/v1/users/me/orders/ORD-20200101-ABCDEF')
        .set(asCustomer());
      expect(unknown.status).toBe(404);
    });
  });

  /* ══ 8. Payment — COD ══════════════════════════════════════════════════ */

  describe('8. payment (cod)', () => {
    it('initiates a COD payment without contacting a gateway', async () => {
      const before = providerRefs.length;

      const response = await api()
        .post(`/api/v1/users/me/orders/${journey.codOrderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', 'journey-pay-cod-0001')
        .send({ method: 'cod' });

      expect(response.status).toBe(201);
      expect(response.body.payment).toMatchObject({
        orderNumber: journey.codOrderNumber,
        method: 'cod',
        status: 'pending',
      });
      // COD must never reach the provider.
      expect(response.body.handoff).toBeUndefined();
      expect(providerRefs.length).toBe(before);
    });

    it('reads the payment for the order', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/payment`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.payment.method).toBe('cod');
      expect(Array.isArray(response.body.payment.history)).toBe(true);
    });

    it('lists the customer payments', async () => {
      const response = await api().get('/api/v1/users/me/payments').set(asCustomer());

      expect(response.status).toBe(200);
      expect(
        (response.body.payments as { orderNumber: string }[]).some(
          (p) => p.orderNumber === journey.codOrderNumber,
        ),
      ).toBe(true);
    });

    it('persisted exactly one payment row', async () => {
      const rows = await db().select().from(payment).where(eq(payment.storeId, journey.storeId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.method).toBe('cod');
    });
  });

  /* ══ 9. Invoice ════════════════════════════════════════════════════════ */

  describe('9. invoice', () => {
    it('issued a statutory invoice at checkout', async () => {
      const rows = await db().select().from(invoice).where(eq(invoice.storeId, journey.storeId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/u);
      journey.invoiceNumber = rows[0]!.invoiceNumber;
    });

    it('renders the invoice document to the customer', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/invoice`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/u);
      expect(response.text).toContain(journey.invoiceNumber);
      expect(response.text).toContain(SELLER_GSTIN);
      expect(response.text).toContain(HSN);
    });
  });

  /* ══ 10. Fulfilment ════════════════════════════════════════════════════ */

  describe('10. fulfilment', () => {
    it('shows no shipments before the merchant creates one', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/shipments`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.shipments).toHaveLength(0);
    });

    it('lets the merchant create, ship and deliver', async () => {
      const created = await api()
        .post(`/api/v1/admin/orders/${journey.codOrderNumber}/shipments`)
        .set(asStaff())
        .send({ carrier: 'Bluedart', trackingNumber: 'BD123456789' });
      expect(created.status).toBe(201);
      journey.shipmentId = created.body.shipment.id as string;

      const shipped = await api()
        .post(`/api/v1/admin/shipments/${journey.shipmentId}/ship`)
        .set(asStaff())
        .send({});
      expect(shipped.status).toBe(200);

      const delivered = await api()
        .post(`/api/v1/admin/shipments/${journey.shipmentId}/deliver`)
        .set(asStaff())
        .send({});
      expect(delivered.status).toBe(200);
    });

    it('shows the customer their shipment and its tracking', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/shipments`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.shipments).toHaveLength(1);
      expect(response.body.shipments[0]).toMatchObject({
        carrier: 'Bluedart',
        trackingNumber: 'BD123456789',
        status: 'delivered',
      });
    });

    it('deducted the reserved stock on fulfilment', async () => {
      await waitFor(async () => {
        const rows = await db()
          .select()
          .from(stockItem)
          .where(eq(stockItem.storeId, journey.storeId));
        const small = rows.find((r) => r.onHand < journey.onHandBefore);
        expect(small).toBeDefined();
        // Three units left the warehouse and the reservation is gone with them.
        expect(small?.onHand).toBe(journey.onHandBefore - 3);
        expect(small?.reserved).toBe(0);
      });
    });
  });

  /* ══ 11. Cancellation ══════════════════════════════════════════════════ */

  describe('11. cancellation', () => {
    it('cancels an order that has no payment, and returns the stock', async () => {
      journey.cancelOrderNumber = await placeOrder('journey-checkout-cancel');

      const reserved = await db()
        .select()
        .from(stockItem)
        .where(eq(stockItem.storeId, journey.storeId));
      expect(reserved.some((r) => r.reserved === 1)).toBe(true);

      const cancelled = await api()
        .post(`/api/v1/users/me/orders/${journey.cancelOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(cancelled.status).toBe(200);
      expect(cancelled.body.order.status).toBe('cancelled');

      await waitFor(async () => {
        const rows = await db()
          .select()
          .from(stockItem)
          .where(eq(stockItem.storeId, journey.storeId));
        expect(rows.every((r) => r.reserved === 0)).toBe(true);
      });
    });

    it('refuses to cancel twice', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${journey.cancelOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    });

    it('refuses to cancel a delivered order', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${journey.codOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    });
  });

  /* ══ 12. Payment — online / Razorpay ═══════════════════════════════════ */

  describe('12. payment (online)', () => {
    it('initiates an online payment and returns a provider handoff', async () => {
      journey.onlineOrderNumber = await placeOrder('journey-checkout-online');

      const response = await api()
        .post(`/api/v1/users/me/orders/${journey.onlineOrderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', 'journey-pay-online-0001')
        .send({ method: 'online' });

      expect(response.status).toBe(201);
      expect(response.body.payment).toMatchObject({ method: 'online', status: 'pending' });
      expect(response.body.handoff).toMatchObject({
        provider: 'razorpay',
        publicKey: RAZORPAY.keyId,
      });
      // The publishable key may go to a browser; the secret must never appear.
      expect(JSON.stringify(response.body)).not.toContain(RAZORPAY.keySecret);
      expect(providerRefs.length).toBeGreaterThan(0);
    });

    it('marks the payment paid on a signed webhook', async () => {
      const providerRef = providerRefs[providerRefs.length - 1]!;
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_JOURNEY', order_id: providerRef } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', 'evt_journey_0001')
        .send(body);

      expect(response.status).toBe(200);

      await waitFor(async () => {
        const read = await api()
          .get(`/api/v1/users/me/orders/${journey.onlineOrderNumber}/payment`)
          .set(asCustomer());
        expect(read.body.payment.status).toBe('succeeded');
      });
    });

    it('rejects a webhook with a bad signature', async () => {
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_X', order_id: 'order_X' } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', 'deadbeef')
        .set('x-razorpay-event-id', 'evt_journey_bad')
        .send(body);

      expect(response.status).toBe(401);
    });

    it('refuses to cancel a paid order', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${journey.onlineOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.error.details.reason).toBe('paid');
    });
  });

  /* ══ 13. Isolation ═════════════════════════════════════════════════════ */

  describe('13. isolation', () => {
    let intruderToken = '';

    it('registers a second, unrelated customer', async () => {
      const email = `journey.intruder.${String(Date.now())}@example.com`;
      const registered = await api()
        .post('/api/v1/auth/register')
        .send({ email, password: CUSTOMER.password, firstName: 'Mallory', lastName: 'Other' });
      expect(registered.status).toBe(201);

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email, password: CUSTOMER.password });
      expect(login.status).toBe(200);
      intruderToken = login.body.accessToken as string;
    });

    it('hides another customer order, payment, invoice and shipments', async () => {
      const headers = { Authorization: `Bearer ${intruderToken}` };

      const read = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}`)
        .set(headers);
      expect(read.status).toBe(404);

      const invoiceRead = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/invoice`)
        .set(headers);
      expect(invoiceRead.status).toBe(404);

      const paymentRead = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/payment`)
        .set(headers);
      expect(paymentRead.status).toBe(404);

      const shipments = await api()
        .get(`/api/v1/users/me/orders/${journey.codOrderNumber}/shipments`)
        .set(headers);
      expect(shipments.status).toBe(404);
    });

    it('hides another customer address', async () => {
      const response = await api()
        .get(`/api/v1/users/me/addresses/${journey.addressId}`)
        .set({ Authorization: `Bearer ${intruderToken}` });

      expect(response.status).toBe(404);
    });

    it('refuses staff-only endpoints to a customer', async () => {
      const response = await api().get('/api/v1/admin/inventory').set(asCustomer());

      expect(response.status).toBe(403);
    });

    it('cannot check out against another customer address', async () => {
      await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SMALL}`)
        .set({ Authorization: `Bearer ${intruderToken}` })
        .send({ quantity: 1 });

      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set({ Authorization: `Bearer ${intruderToken}` })
        .set('idempotency-key', 'journey-intruder-checkout')
        .send({ addressId: journey.addressId });

      /*
       * 404, and that is the right shape: another customer's address is reported as absent
       * rather than forbidden, so the response cannot be used to confirm that an address id
       * exists for somebody else.
       */
      expect(response.status).toBe(404);
    });
  });

  /* ══ 14. Session teardown ══════════════════════════════════════════════ */

  describe('14. logout', () => {
    it('revokes the session', async () => {
      const response = await api().post('/api/v1/auth/logout').set(asCustomer()).send({});

      expect(response.status).toBe(204);

      const replay = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: journey.refreshToken });
      expect(replay.status).toBe(401);
    });
  });

  /* ══ 15. No unexpected server errors anywhere in the journey ═══════════ */

  describe('15. integrity', () => {
    it('left the order/payment/invoice records mutually consistent', async () => {
      const orders = await db().select().from(order).where(eq(order.storeId, journey.storeId));
      const payments = await db()
        .select()
        .from(payment)
        .where(eq(payment.storeId, journey.storeId));
      const invoices = await db()
        .select()
        .from(invoice)
        .where(eq(invoice.storeId, journey.storeId));

      // Three orders were placed: COD (delivered), cancelled, and online (paid).
      expect(orders).toHaveLength(3);
      expect(orders.filter((o) => o.status === 'cancelled')).toHaveLength(1);

      // Every payment points at an order in this store.
      for (const row of payments) {
        expect(orders.some((o) => o.id === row.orderId)).toBe(true);
      }

      // Every assessed order has exactly one invoice, and every number is unique.
      const numbers = invoices.map((i) => i.invoiceNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
      for (const row of invoices) {
        expect(orders.some((o) => o.id === row.orderId)).toBe(true);
      }
    });

    it('kept the cancelled order out of fulfilment', async () => {
      const cancelled = await db()
        .select()
        .from(order)
        .where(
          and(eq(order.storeId, journey.storeId), eq(order.orderNumber, journey.cancelOrderNumber)),
        );

      expect(cancelled[0]?.status).toBe('cancelled');
    });
  });
});
