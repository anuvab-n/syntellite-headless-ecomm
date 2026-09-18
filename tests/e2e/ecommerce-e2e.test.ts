import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrPromoteAdmin } from '../../scripts/create-admin.ts';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { cart } from '../../src/db/schema/cart.js';
import { appUser } from '../../src/db/schema/identity.js';
import { stockItem } from '../../src/db/schema/inventory.js';
import { order, orderLine } from '../../src/db/schema/orders.js';
import { payment } from '../../src/db/schema/payments.js';
import { format, fromDb } from '../../src/shared/money.js';
import {
  buildTestConfig,
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * THE E-commerce flow, end to end, against the real stack.
 *
 * ```
 * new customer -> login -> new admin -> admin login -> admin creates product
 *   -> customer browses -> cart -> update cart -> checkout -> order
 *   -> initiate payment -> payment succeeds -> order/payment state
 *   -> inventory -> cart cleared -> order history -> admin order management
 * ```
 *
 * ## What is real
 *
 * Everything. `buildContainer` is the same composition root `main.ts` calls, wired to a real
 * PostgreSQL and a real Redis from Testcontainers and driven over HTTP with supertest. Every
 * service, every piece of middleware (store resolution, auth, rate limiting, idempotency) and
 * every database constraint is the production one. No internal business logic is doubled —
 * a stubbed cart or a stubbed inventory service would let a broken contract between two
 * modules pass, and catching exactly those breaks is the point.
 *
 * ## What is substituted, and only that
 *
 * One thing, at the transport boundary: `globalThis.fetch`, so the Razorpay adapter talks to a
 * stub instead of the internet. The adapter, its HMAC signature verification and its
 * persistence are the real ones — the webhooks this file posts are signed with the real
 * algorithm and rejected by the real check when the signature is wrong. No real money moves
 * and no sandbox account is needed.
 *
 * ## The admin is created the way an operator creates one
 *
 * Through `createOrPromoteAdmin` — the function behind `pnpm admin:create`, which is the
 * project's ONLY admin onboarding mechanism. `docs/DECISIONS.md` §22 records that no request
 * body may ever carry `isStaff`: `InsertUserValues` has no such field, so `POST /auth/register`
 * cannot grant privilege whatever a client sends. There is therefore no HTTP route to call
 * here, and this test does not invent one or flip the column behind the API's back. Login
 * afterwards is the ordinary, unchanged `POST /api/v1/auth/login`.
 *
 * ## The steps are sequential and share state on purpose
 *
 * `it()` blocks run in order within a file and each consumes what the previous produced: the
 * customer registered in step 1 is the customer charged in step 10 and whose parcel is
 * delivered in step 12. There is no `beforeEach` truncate — that would reset the journey
 * between steps and turn one end-to-end flow into forty disconnected ones. A failure part-way
 * therefore cascades, which is the honest signal: the flow stops here.
 *
 * ## Repeatability
 *
 * Every identifier is suffixed with a per-run token, and the database is a throwaway container
 * created in `beforeAll` and destroyed in `afterAll`. Nothing outside the container is read or
 * written, so the file is safe to run any number of times and cannot touch real data.
 */
describe('e-commerce end-to-end flow', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  /** Restored in `afterAll`, so the stub cannot leak into another file in the same worker. */
  const realFetch = globalThis.fetch;

  /** Unique per run, so re-running the file never collides on a slug, code or email. */
  const RUN = Date.now().toString(36);

  const RAZORPAY = {
    keyId: `rzp_test_${RUN}`,
    keySecret: 'e2e-api-secret-value',
    webhookSecret: 'e2e-webhook-secret-value',
  };

  /* ── Catalogue the admin will create ───────────────────────────────────── */

  const PRODUCT_SLUG = `e2e-riverstone-jacket-${RUN}`;
  const PRODUCT_NAME = 'Riverstone Jacket';
  const SKU_CODE = `E2E-RIVER-${RUN}-M`;
  const SKU_SPARE = `E2E-RIVER-${RUN}-L`;
  /** Chosen so 10% off and 5% GST are both exact at scale 4 — no rounding to argue about. */
  const UNIT_PRICE = '500.0000';
  const SPARE_PRICE = '650.0000';
  const INITIAL_STOCK = 12;
  const COUPON = `E2E${RUN}`.toUpperCase();
  const COUPON_PERCENT = 10;
  const TAX_CLASS = `GST5${RUN}`.toUpperCase();
  const HSN = '62011000';
  const GST_RATE_PERCENT = 5;
  /** Seller and buyer in the same state, so GST must split CGST + SGST and never IGST. */
  const STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';

  const CUSTOMER = {
    email: `e2e.customer.${RUN}@example.com`,
    password: 'a-sufficiently-long-customer-password',
  };
  const ADMIN = {
    email: `e2e.admin.${RUN}@example.com`,
    password: 'a-sufficiently-long-admin-password',
  };
  const OTHER = {
    email: `e2e.other.${RUN}@example.com`,
    password: 'a-sufficiently-long-other-password',
  };

  /* ── Everything written by one step and read by later ones ─────────────── */

  const flow: {
    storeId: string;
    customerId: string;
    customerToken: string;
    customerRefreshToken: string;
    adminId: string;
    adminToken: string;
    otherToken: string;
    addressId: string;
    otherAddressId: string;
    orderNumber: string;
    failedOrderNumber: string;
    shipmentId: string;
    /** The grand total the checkout response reported, carried into the payment assertions. */
    payableAmount: string;
    /** Cart line quantity at the moment of checkout — everything downstream is derived from it. */
    orderedQuantity: number;
  } = {
    storeId: '',
    customerId: '',
    customerToken: '',
    customerRefreshToken: '',
    adminId: '',
    adminToken: '',
    otherToken: '',
    addressId: '',
    otherAddressId: '',
    orderNumber: '',
    failedOrderNumber: '',
    shipmentId: '',
    payableAmount: '',
    orderedQuantity: 0,
  };

  /** Every provider order id the stubbed transport has handed back, in order. */
  const providerRefs: string[] = [];

  const api = () => request(container.app);
  const db = () => container.db.db;

  const asCustomer = () => ({ Authorization: `Bearer ${flow.customerToken}` });
  const asAdmin = () => ({ Authorization: `Bearer ${flow.adminToken}` });
  const asOther = () => ({ Authorization: `Bearer ${flow.otherToken}` });

  /**
   * Money as an integer of minor units.
   *
   * Every monetary string in this API is a decimal at scale 4, so stripping the point yields an
   * exact integer. `BigInt`, never `Number`: a float comparison on money is the bug this
   * codebase's `no-money-arithmetic` lint rule exists to prevent, and a test that used one
   * would be asserting something subtly different from what the server computed.
   */
  const minor = (value: string): bigint => BigInt(value.replace('.', ''));

  /** Supertest types `body` as `any`; one narrowing helper keeps the assertions type-checked. */
  const bodyAs = <T>(response: { body: unknown }): T => response.body as T;

  type ProductShape = {
    id: string;
    slug: string;
    name: string;
    status: string;
    currency: string;
    skus: { code: string; price: string; isActive: boolean; options: { optionName: string }[] }[];
  };
  type CartShape = {
    id: string;
    status: string;
    items: {
      skuCode: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
      isPurchasable: boolean;
    }[];
    itemCount: number;
    subtotal: string;
    discountTotal: string;
    cartTotal: string;
    promotion: { code: string; discountTotal: string } | null;
  };
  type OrderShape = {
    orderNumber: string;
    status: string;
    currency: string;
    subtotal: string;
    discountTotal: string;
    total: string;
    taxTotal: string;
    grandTotal: string;
    placedAt: string;
    promotion: { code: string } | null;
    shippingAddress: { city: string; state: string };
    tax: { sellerGstin: string; supplyType: string } | null;
    items: {
      skuCode: string;
      skuName: string;
      productName: string;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
      discountAmount: string;
      tax: { hsnCode: string; cgstAmount: string; sgstAmount: string; igstAmount: string } | null;
    }[];
  };
  type PaymentShape = {
    orderNumber: string;
    method: string;
    provider: string | null;
    status: string;
    currency: string;
    amount: string;
    failureCode: string | null;
    history: { fromStatus: string | null; toStatus: string }[];
  };
  type StockShape = { skuCode: string; onHand: number; reserved: number; available: number };

  /** Razorpay signs the RAW body; the adapter verifies the same bytes. */
  const sign = (body: string): string =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  /**
   * Retry an assertion until it holds, or give up.
   *
   * Some state settles just after the response is sent — the idempotency middleware completes
   * its claim post-response, and reservation bookkeeping is driven off the outbox drainer. A
   * test that reads once is racing a write it never awaited. Bounded, so a genuine regression
   * still fails the run rather than hanging it.
   */
  async function waitFor(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
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

  /** The admin's view of one SKU's stock counters, read through the real admin API. */
  async function readStock(skuCode: string): Promise<StockShape> {
    const response = await api().get('/api/v1/admin/inventory').set(asAdmin()).query({ limit: 50 });
    expect(response.status, 'admin inventory list must be readable by staff').toBe(200);
    const row = bodyAs<{ inventory: StockShape[] }>(response).inventory.find(
      (item) => item.skuCode === skuCode,
    );
    expect(row, `inventory must carry a row for ${skuCode}`).toBeDefined();
    return row!;
  }

  /** Place a second, independent order from a fresh cart — used by the failure-path steps. */
  async function placeOrder(quantity: number, idempotencyKey: string): Promise<OrderShape> {
    const added = await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set(asCustomer())
      .send({ quantity });
    expect(added.status, 'adding to a fresh cart must succeed').toBe(200);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', idempotencyKey)
      .send({ addressId: flow.addressId });
    expect(checkout.status, 'checkout must create an order').toBe(201);
    return bodyAs<{ order: OrderShape }>(checkout).order;
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
      const ref = `order_E2E_${RUN}_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    };

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          /* All three are required together, or the container builds no gateway and answers 503. */
          RAZORPAY_KEY_ID: RAZORPAY.keyId,
          RAZORPAY_KEY_SECRET: RAZORPAY.keySecret,
          RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret,
          /*
           * This flow legitimately authenticates far more than the production default of 10
           * attempts per IP per minute — three accounts, several logins, a refresh. Raised
           * rather than disabled, so the limiter is still wired and still counting.
           */
          AUTH_RATE_LIMIT_IP_MAX: '1000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '1000',
          AUTH_RATE_LIMIT_REFRESH_IP_MAX: '1000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    flow.storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. A brand-new customer ═══════════════════════════════════════════ */

  describe('1. new customer registration and authentication', () => {
    it('registers a new customer and returns the created user, never the hash', async () => {
      const response = await api().post('/api/v1/auth/register').send({
        email: CUSTOMER.email,
        password: CUSTOMER.password,
        firstName: 'Rhea',
        lastName: 'Menon',
        phone: '+91 9876500011',
      });

      expect(response.status, 'registration must create the account').toBe(201);
      expect(response.body.user, 'the registered profile must echo what was sent').toMatchObject({
        email: CUSTOMER.email,
        firstName: 'Rhea',
        lastName: 'Menon',
        emailVerified: false,
      });
      expect(response.body.user.id).toEqual(expect.any(String));
      expect(
        response.body.user,
        'a password hash must never be part of the response contract',
      ).not.toHaveProperty('passwordHash');

      flow.customerId = response.body.user.id as string;

      const rows = await db().select().from(appUser).where(eq(appUser.id, flow.customerId));
      expect(rows, 'the account must be persisted exactly once').toHaveLength(1);
      expect(rows[0]?.storeId, 'the account belongs to the resolved store').toBe(flow.storeId);
      expect(
        rows[0]?.isStaff,
        'registration must never be able to grant staff — DECISIONS §22',
      ).toBe(false);
    });

    it('refuses a duplicate registration for the same email', async () => {
      const response = await api()
        .post('/api/v1/auth/register')
        .send({ email: CUSTOMER.email, password: CUSTOMER.password });

      expect(response.status, 'a taken email is a conflict, not a second account').toBe(409);
      expect(response.body.error.code).toBeDefined();
    });

    it('logs in and issues a token pair bound to this customer', async () => {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: CUSTOMER.password });

      expect(response.status, 'correct credentials must authenticate').toBe(200);
      expect(response.body).toMatchObject({ tokenType: 'Bearer' });
      expect(response.body.accessToken).toEqual(expect.any(String));
      expect(response.body.refreshToken).toEqual(expect.any(String));
      expect(response.body.expiresIn, 'the access token must carry a lifetime').toBeGreaterThan(0);
      expect(response.body.user.id, 'the token must belong to the registered customer').toBe(
        flow.customerId,
      );

      flow.customerToken = response.body.accessToken as string;
      flow.customerRefreshToken = response.body.refreshToken as string;
    });

    it('rejects a wrong password and an unknown email identically', async () => {
      const wrongPassword = await api()
        .post('/api/v1/auth/login')
        .send({ email: CUSTOMER.email, password: 'definitely-not-the-password' });
      expect(wrongPassword.status).toBe(401);

      const unknownEmail = await api()
        .post('/api/v1/auth/login')
        .send({ email: `nobody.${RUN}@example.com`, password: CUSTOMER.password });
      expect(
        unknownEmail.status,
        'an unknown email must answer as a wrong password does, or login enumerates accounts',
      ).toBe(401);
    });

    it('lets the authenticated customer read a protected endpoint', async () => {
      const response = await api().get('/api/v1/users/me').set(asCustomer());

      expect(response.status, 'a valid access token must open the protected profile').toBe(200);
      expect(response.body.user).toMatchObject({
        id: flow.customerId,
        email: CUSTOMER.email,
        phone: '+91 9876500011',
      });
    });

    it('rejects missing, malformed and forged authentication', async () => {
      const missing = await api().get('/api/v1/users/me');
      expect(missing.status, 'no Authorization header must be 401').toBe(401);

      const malformed = await api()
        .get('/api/v1/users/me')
        .set({ Authorization: flow.customerToken });
      expect(malformed.status, 'a bearer token without the scheme must be 401').toBe(401);

      const garbage = await api()
        .get('/api/v1/users/me')
        .set({ Authorization: 'Bearer not-a-real-token' });
      expect(garbage.status, 'an unverifiable token must be 401').toBe(401);

      /* A structurally valid JWS whose signature was produced by nobody. */
      const forged = await api()
        .get('/api/v1/users/me')
        .set({ Authorization: `Bearer ${flow.customerToken.split('.').slice(0, 2).join('.')}.x` });
      expect(forged.status, 'a tampered signature must be 401').toBe(401);
    });

    it('creates the shipping address the order will be delivered to', async () => {
      const response = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
        label: 'Home',
        recipientName: 'Rhea Menon',
        phone: '+91 9876500011',
        line1: '18 Residency Road',
        city: 'Bengaluru',
        state: STATE,
        postalCode: '560025',
        countryCode: 'IN',
      });

      expect(response.status, 'the address must be created').toBe(201);
      expect(response.body.address).toMatchObject({ label: 'Home', city: 'Bengaluru' });
      flow.addressId = response.body.address.id as string;
    });
  });

  /* ══ 2. A brand-new admin ══════════════════════════════════════════════ */

  describe('2. new admin onboarding and authorization', () => {
    it('creates a new admin through the project’s own admin mechanism', async () => {
      /*
       * `createOrPromoteAdmin` is the function behind `pnpm admin:create`. It validates through
       * the SAME `RegisterRequestSchema` the HTTP register route uses and hashes with the SAME
       * Argon2id `hashPassword`, so this admin satisfies every rule a customer account does.
       * There is deliberately no HTTP route that grants staff, so there is none to call here.
       */
      const created = await createOrPromoteAdmin(
        { db: db(), config: container.config, logger: silentLogger },
        {
          email: ADMIN.email,
          password: ADMIN.password,
          firstName: 'Ops',
          lastName: 'Owner',
          promote: false,
          help: false,
        },
      );

      expect(created.created, 'this must be a newly created account, not a promotion').toBe(true);
      expect(created.email).toBe(ADMIN.email);
      flow.adminId = created.userId;

      const rows = await db().select().from(appUser).where(eq(appUser.id, flow.adminId));
      expect(rows, 'the admin account must be persisted').toHaveLength(1);
      expect(rows[0]?.isStaff, 'the admin must actually hold staff').toBe(true);
      expect(rows[0]?.storeId, 'the admin belongs to the same store as the customer').toBe(
        flow.storeId,
      );
      expect(rows[0]?.id, 'the admin must be a different account from the customer').not.toBe(
        flow.customerId,
      );
    });

    it('logs the admin in through the ordinary login route', async () => {
      const response = await api()
        .post('/api/v1/auth/login')
        .send({ email: ADMIN.email, password: ADMIN.password });

      expect(response.status, 'an admin signs in exactly as a customer does').toBe(200);
      expect(response.body.user.id).toBe(flow.adminId);
      expect(response.body.accessToken).toEqual(expect.any(String));

      flow.adminToken = response.body.accessToken as string;
    });

    it('opens admin-only endpoints to the admin token', async () => {
      const response = await api().get('/api/v1/admin/inventory').set(asAdmin());

      expect(response.status, 'staff must reach the admin surface').toBe(200);
      expect(Array.isArray(response.body.inventory)).toBe(true);
      expect(response.body.pagination).toMatchObject({ limit: expect.any(Number) });
    });

    it('closes admin-only endpoints to the customer token and to anonymous callers', async () => {
      const asShopper = await api().get('/api/v1/admin/inventory').set(asCustomer());
      expect(
        asShopper.status,
        'an authenticated non-staff caller must be forbidden, not merely unauthenticated',
      ).toBe(403);

      const anonymous = await api().get('/api/v1/admin/inventory');
      expect(anonymous.status, 'an anonymous caller must be 401').toBe(401);

      const write = await api()
        .post('/api/v1/admin/products')
        .set(asCustomer())
        .send({ slug: `sneaky-${RUN}`, name: 'Sneaky', status: 'active' });
      expect(write.status, 'a customer must not be able to create catalogue').toBe(403);

      const listed = await api().get('/api/v1/products').query({ q: 'Sneaky' });
      expect(
        bodyAs<{ products: ProductShape[] }>(listed).products,
        'the forbidden write must have created nothing',
      ).toHaveLength(0);
    });

    it('registers a second customer, used later to prove resource isolation', async () => {
      const registered = await api()
        .post('/api/v1/auth/register')
        .send({ email: OTHER.email, password: OTHER.password, firstName: 'Ira', lastName: 'Rao' });
      expect(registered.status).toBe(201);

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email: OTHER.email, password: OTHER.password });
      expect(login.status).toBe(200);
      flow.otherToken = login.body.accessToken as string;

      const address = await api().post('/api/v1/users/me/addresses').set(asOther()).send({
        label: 'Other home',
        recipientName: 'Ira Rao',
        phone: '+91 9876500022',
        line1: '5 Brigade Road',
        city: 'Bengaluru',
        state: STATE,
        postalCode: '560001',
        countryCode: 'IN',
      });
      expect(address.status).toBe(201);
      flow.otherAddressId = address.body.address.id as string;
    });
  });

  /* ══ 3. The admin builds the catalogue ═════════════════════════════════ */

  describe('3. admin creates the product, its price, stock and variant', () => {
    it('creates the product', async () => {
      const response = await api().post('/api/v1/admin/products').set(asAdmin()).send({
        slug: PRODUCT_SLUG,
        name: PRODUCT_NAME,
        description: 'Water-resistant shell with a brushed lining.',
        status: 'active',
      });

      expect(response.status, 'the admin must be able to create a product').toBe(201);
      const product = bodyAs<{ product: ProductShape }>(response).product;
      expect(product).toMatchObject({
        slug: PRODUCT_SLUG,
        name: PRODUCT_NAME,
        status: 'active',
      });
      expect(product.id).toEqual(expect.any(String));
      expect(
        product.skus,
        'a product is not sellable on its own — it starts with no SKUs',
      ).toHaveLength(0);
    });

    it('rejects a duplicate slug and a malformed product body', async () => {
      const duplicate = await api()
        .post('/api/v1/admin/products')
        .set(asAdmin())
        .send({ slug: PRODUCT_SLUG, name: 'Copy', status: 'active' });
      expect(duplicate.status, 'a slug is unique per store').toBe(409);

      const malformed = await api()
        .post('/api/v1/admin/products')
        .set(asAdmin())
        .send({ slug: 'Not A Slug', name: '', colour: 'blue' });
      expect(malformed.status, 'a bad slug, an empty name and an unknown field are all 400').toBe(
        400,
      );
    });

    it('adds the sellable SKU with its price', async () => {
      const response = await api()
        .post(`/api/v1/admin/products/${PRODUCT_SLUG}/skus`)
        .set(asAdmin())
        .send({ code: SKU_CODE, name: 'Medium', price: UNIT_PRICE, isActive: true });

      expect(response.status, 'the SKU carries the price, not the product').toBe(201);
      expect(response.body.sku).toMatchObject({
        code: SKU_CODE,
        name: 'Medium',
        price: UNIT_PRICE,
        isActive: true,
      });

      const spare = await api()
        .post(`/api/v1/admin/products/${PRODUCT_SLUG}/skus`)
        .set(asAdmin())
        .send({ code: SKU_SPARE, name: 'Large', price: SPARE_PRICE });
      expect(spare.status).toBe(201);
      expect(spare.body.sku.isActive, 'a SKU defaults to sellable').toBe(true);
    });

    it('rejects a price sent as a JSON number', async () => {
      const response = await api()
        .post(`/api/v1/admin/products/${PRODUCT_SLUG}/skus`)
        .set(asAdmin())
        .send({ code: `${SKU_CODE}-BAD`, price: 500 });

      expect(
        response.status,
        'money is a decimal string; a float would silently lose precision',
      ).toBe(400);
    });

    it('updates the price and the change is visible immediately', async () => {
      const raised = await api()
        .patch(`/api/v1/admin/skus/${SKU_SPARE}`)
        .set(asAdmin())
        .send({ price: '675.0000' });
      expect(raised.status).toBe(200);
      expect(raised.body.sku.price).toBe('675.0000');

      const read = await api().get(`/api/v1/products/${PRODUCT_SLUG}`);
      const spare = bodyAs<{ product: ProductShape }>(read).product.skus.find(
        (s) => s.code === SKU_SPARE,
      );
      expect(spare?.price, 'the public read must reflect the new price').toBe('675.0000');
    });

    it('adds stock through the inventory ledger', async () => {
      const response = await api().post('/api/v1/admin/inventory/adjustments').set(asAdmin()).send({
        skuCode: SKU_CODE,
        delta: INITIAL_STOCK,
        reason: 'manual_increase',
        note: 'e2e opening stock',
      });

      expect(response.status, 'the adjustment must be accepted').toBe(201);
      expect(
        response.body.inventory,
        'the resulting stock comes back with the entry',
      ).toMatchObject({
        skuCode: SKU_CODE,
        onHand: INITIAL_STOCK,
        reserved: 0,
        available: INITIAL_STOCK,
      });
      expect(response.body.adjustment).toMatchObject({
        delta: INITIAL_STOCK,
        reason: 'manual_increase',
      });

      const spare = await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asAdmin())
        .send({ skuCode: SKU_SPARE, delta: 4, reason: 'manual_increase' });
      expect(spare.status).toBe(201);
    });

    it('refuses an adjustment that would drive stock negative', async () => {
      const response = await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asAdmin())
        .send({ skuCode: SKU_CODE, delta: -(INITIAL_STOCK + 1), reason: 'manual_decrease' });

      expect(response.status, 'stock cannot go below zero').toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(response.body.error.details.available).toBe(INITIAL_STOCK);

      const unchanged = await readStock(SKU_CODE);
      expect(unchanged.onHand, 'the rejected adjustment must have moved nothing').toBe(
        INITIAL_STOCK,
      );
    });

    it('describes the variant with an option and attaches it to the SKU', async () => {
      const option = await api()
        .post(`/api/v1/admin/products/${PRODUCT_SLUG}/options`)
        .set(asAdmin())
        .send({ name: 'Size', sortOrder: 1 });
      expect(option.status, 'the product must accept a variant axis').toBe(201);
      const optionId = option.body.option.id as string;

      const value = await api()
        .post(`/api/v1/admin/options/${optionId}/values`)
        .set(asAdmin())
        .send({ value: 'M', sortOrder: 1 });
      expect(value.status).toBe(201);
      const valueId = value.body.value.id as string;

      const assigned = await api()
        .put(`/api/v1/admin/skus/${SKU_CODE}/options`)
        .set(asAdmin())
        .send({ optionValueIds: [valueId] });
      expect(assigned.status, 'the SKU must take the combination').toBe(200);
      expect(assigned.body.sku.options).toHaveLength(1);
      expect(assigned.body.sku.options[0]).toMatchObject({ optionName: 'Size', value: 'M' });
    });

    it('sets the store tax profile, a GST class and the SKU classification', async () => {
      const profile = await api().put('/api/v1/admin/store/tax-profile').set(asAdmin()).send({
        legalName: 'Riverstone Retail Private Limited',
        gstin: SELLER_GSTIN,
        originLine1: '4th Floor, MG Road',
        originCity: 'Bengaluru',
        originState: STATE,
        originPostalCode: '560001',
        originCountryCode: 'IN',
      });
      expect(profile.status, 'the seller identity is required before tax can be determined').toBe(
        200,
      );

      const taxClass = await api()
        .post('/api/v1/admin/tax-classes')
        .set(asAdmin())
        .send({ code: TAX_CLASS, name: 'GST 5%', isActive: true });
      expect(taxClass.status).toBe(201);

      const rate = await api()
        .post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`)
        .set(asAdmin())
        .send({
          cgstRate: '2.5',
          sgstRate: '2.5',
          igstRate: String(GST_RATE_PERCENT),
          effectiveFrom: '2020-01-01T00:00:00.000Z',
        });
      expect(rate.status).toBe(201);

      for (const code of [SKU_CODE, SKU_SPARE]) {
        const assigned = await api()
          .put(`/api/v1/admin/skus/${code}/tax`)
          .set(asAdmin())
          .send({ taxClassCode: TAX_CLASS, hsnCode: HSN });
        expect(assigned.status, `the SKU ${code} must carry an HSN and a class`).toBe(200);
      }
    });

    it('creates the discount coupon the customer will use', async () => {
      const response = await api()
        .post('/api/v1/admin/promotions')
        .set(asAdmin())
        .send({
          code: COUPON,
          name: 'E2E launch discount',
          discountType: 'percentage',
          percentRate: String(COUPON_PERCENT),
          isActive: true,
        });

      expect(response.status, 'the admin must be able to create a promotion').toBe(201);
      expect(response.body.promotion).toMatchObject({
        code: COUPON,
        discountType: 'percentage',
        isActive: true,
      });
    });

    it('rejects a percentage promotion that also names a fixed amount', async () => {
      const response = await api()
        .post('/api/v1/admin/promotions')
        .set(asAdmin())
        .send({
          code: `${COUPON}X`,
          name: 'Contradictory',
          discountType: 'percentage',
          percentRate: '10',
          amount: '50.0000',
        });

      expect(response.status, 'a discount has one shape or the other, never both').toBe(400);
    });
  });

  /* ══ 4. The customer browses ═══════════════════════════════════════════ */

  describe('4. customer browses the catalogue', () => {
    it('finds the new product in the public listing, with its price and currency', async () => {
      const response = await api().get('/api/v1/products').query({ limit: 50 });

      expect(response.status, 'the storefront listing needs no authentication').toBe(200);
      const listing = bodyAs<{ products: ProductShape[]; pagination: { total: number } }>(response);
      const found = listing.products.find((p) => p.slug === PRODUCT_SLUG);

      expect(found, 'the product the admin published must be on the shelf').toBeDefined();
      expect(found!.name).toBe(PRODUCT_NAME);
      expect(found!.currency, 'currency comes from the store, not from the product').toBe(
        container.config.defaultCurrency,
      );

      const sellable = found!.skus.find((s) => s.code === SKU_CODE);
      expect(sellable, 'the sellable SKU must be listed').toBeDefined();
      expect(sellable!.price, 'the listed price must be the price the admin set').toBe(UNIT_PRICE);
      expect(sellable!.isActive, 'an unsellable SKU must not look available').toBe(true);
      expect(listing.pagination.total).toBeGreaterThan(0);
    });

    it('searches by term, and a miss is an empty page rather than an error', async () => {
      const hit = await api().get('/api/v1/products').query({ q: 'Riverstone' });
      expect(hit.status).toBe(200);
      expect(
        bodyAs<{ products: ProductShape[] }>(hit).products.some((p) => p.slug === PRODUCT_SLUG),
        'a search for the product name must return it',
      ).toBe(true);

      const miss = await api()
        .get('/api/v1/products')
        .query({ q: `no-such-thing-${RUN}` });
      expect(miss.status).toBe(200);
      expect(bodyAs<{ products: ProductShape[] }>(miss).products).toHaveLength(0);
    });

    it('filters by price range around the SKU price', async () => {
      const inRange = await api()
        .get('/api/v1/products')
        .query({ price_min: '100.0000', price_max: UNIT_PRICE });
      expect(inRange.status).toBe(200);
      expect(
        bodyAs<{ products: ProductShape[] }>(inRange).products.some((p) => p.slug === PRODUCT_SLUG),
        'an inclusive upper bound must include a SKU priced exactly at it',
      ).toBe(true);

      const above = await api().get('/api/v1/products').query({ price_min: '99999.0000' });
      expect(above.status).toBe(200);
      expect(bodyAs<{ products: ProductShape[] }>(above).products).toHaveLength(0);

      const reversed = await api()
        .get('/api/v1/products')
        .query({ price_min: '900.0000', price_max: '100.0000' });
      expect(
        reversed.status,
        'an impossible range is a 400, not a 200 that looks like an empty shelf',
      ).toBe(400);
    });

    it('reads the product detail with its SKUs and variant', async () => {
      const response = await api().get(`/api/v1/products/${PRODUCT_SLUG}`);

      expect(response.status).toBe(200);
      const product = bodyAs<{ product: ProductShape }>(response).product;
      expect(product.slug).toBe(PRODUCT_SLUG);
      expect(product.status).toBe('active');

      const sellable = product.skus.find((s) => s.code === SKU_CODE);
      expect(sellable, 'the detail must carry the SKU the listing showed').toBeDefined();
      expect(sellable!.price).toBe(UNIT_PRICE);
      expect(
        sellable!.options.map((o) => o.optionName),
        'the variant must be described',
      ).toContain('Size');
    });

    it('404s an unknown product and a draft one alike', async () => {
      const unknown = await api().get(`/api/v1/products/no-such-product-${RUN}`);
      expect(unknown.status).toBe(404);

      const draftSlug = `e2e-draft-${RUN}`;
      const draft = await api()
        .post('/api/v1/admin/products')
        .set(asAdmin())
        .send({ slug: draftSlug, name: 'Unfinished', status: 'draft' });
      expect(draft.status).toBe(201);

      const publicRead = await api().get(`/api/v1/products/${draftSlug}`);
      expect(publicRead.status, 'an unpublished product must be invisible, not merely empty').toBe(
        404,
      );

      const adminRead = await api().get(`/api/v1/admin/products/${draftSlug}`).set(asAdmin());
      expect(adminRead.status, 'the admin must still be able to see their own draft').toBe(200);
    });
  });

  /* ══ 5. The cart ═══════════════════════════════════════════════════════ */

  describe('5. cart', () => {
    it('starts empty for a customer who has never shopped', async () => {
      const response = await api().get('/api/v1/users/me/cart').set(asCustomer());

      expect(response.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(response).cart;
      expect(state.items).toHaveLength(0);
      expect(state.itemCount).toBe(0);
      expect(minor(state.subtotal), 'an empty cart is worth nothing').toBe(0n);
      expect(state.status).toBe('active');
    });

    it('adds the product and prices the line from the catalogue', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 2 });

      expect(response.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(response).cart;
      expect(state.items, 'one line, for the one SKU added').toHaveLength(1);

      const line = state.items[0]!;
      expect(line.skuCode).toBe(SKU_CODE);
      expect(line.quantity).toBe(2);
      expect(line.unitPrice, 'the cart price must be the catalogue price').toBe(UNIT_PRICE);
      expect(line.isPurchasable).toBe(true);
      expect(minor(line.lineTotal), 'lineTotal must be unitPrice × quantity').toBe(
        minor(UNIT_PRICE) * 2n,
      );
      expect(minor(state.subtotal), 'subtotal must be the sum of the line totals').toBe(
        minor(line.lineTotal),
      );
      expect(minor(state.cartTotal), 'with no promotion, cartTotal equals subtotal').toBe(
        minor(state.subtotal),
      );
    });

    it('treats PUT as set, not increment, and re-totals the cart', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 3 });

      expect(response.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(response).cart;
      expect(state.items, 'setting a quantity must not add a second line').toHaveLength(1);
      expect(state.items[0]!.quantity, 'PUT sets the quantity to 3, it does not make it 5').toBe(3);
      expect(minor(state.subtotal)).toBe(minor(UNIT_PRICE) * 3n);

      flow.orderedQuantity = 3;
    });

    it('adds a second line and removes it again', async () => {
      const added = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_SPARE}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      expect(added.status).toBe(200);

      const twoLines = bodyAs<{ cart: CartShape }>(added).cart;
      expect(twoLines.items).toHaveLength(2);
      expect(twoLines.itemCount, 'itemCount counts LINES, not units').toBe(2);
      expect(
        minor(twoLines.subtotal),
        'the subtotal must absorb the second line at its own price',
      ).toBe(minor(UNIT_PRICE) * 3n + minor('675.0000'));

      const removed = await api()
        .delete(`/api/v1/users/me/cart/items/${SKU_SPARE}`)
        .set(asCustomer());
      expect(removed.status, 'removing a line answers 204').toBe(204);

      const after = await api().get('/api/v1/users/me/cart').set(asCustomer());
      const state = bodyAs<{ cart: CartShape }>(after).cart;
      expect(state.items, 'only the first line survives').toHaveLength(1);
      expect(minor(state.subtotal), 'the subtotal must fall back to the first line alone').toBe(
        minor(UNIT_PRICE) * 3n,
      );
    });

    it('applies the coupon and discounts the cart', async () => {
      const applied = await api()
        .put('/api/v1/users/me/cart/promotion')
        .set(asCustomer())
        .send({ code: COUPON });

      expect(applied.status, 'a valid coupon must apply').toBe(200);
      const state = bodyAs<{ cart: CartShape }>(applied).cart;

      expect(state.promotion, 'the applied coupon must be named in the cart').toMatchObject({
        code: COUPON,
      });
      expect(minor(state.discountTotal), 'a 10% coupon must actually discount').toBeGreaterThan(0n);
      expect(
        minor(state.discountTotal),
        `${String(COUPON_PERCENT)}% of the subtotal, in minor units`,
      ).toBe((minor(state.subtotal) * BigInt(COUPON_PERCENT)) / 100n);
      expect(minor(state.cartTotal), 'cartTotal must be subtotal − discountTotal').toBe(
        minor(state.subtotal) - minor(state.discountTotal),
      );
    });

    /* ── Validation, at the layer that actually owns each rule ──────────── */

    it('rejects quantity zero and a fractional quantity', async () => {
      const zero = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 0 });
      expect(zero.status, 'zero is not a quantity — DELETE removes a line').toBe(400);

      const negative = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: -2 });
      expect(negative.status).toBe(400);

      const fractional = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 1.5 });
      expect(fractional.status, 'a fractional quantity must be rejected, not truncated').toBe(400);

      const unchanged = await api().get('/api/v1/users/me/cart').set(asCustomer());
      expect(
        bodyAs<{ cart: CartShape }>(unchanged).cart.items[0]!.quantity,
        'none of the rejected requests may have changed the cart',
      ).toBe(flow.orderedQuantity);
    });

    it('404s an unknown SKU and an unpublished one alike', async () => {
      const unknown = await api()
        .put(`/api/v1/users/me/cart/items/NO-SUCH-SKU-${RUN}`)
        .set(asCustomer())
        .send({ quantity: 1 });
      expect(unknown.status).toBe(404);

      const unknownCoupon = await api()
        .put('/api/v1/users/me/cart/promotion')
        .set(asCustomer())
        .send({ code: `NOSUCH${RUN}`.toUpperCase() });
      expect(unknownCoupon.status).toBe(404);
    });

    it('rejects an unknown field in the cart body', async () => {
      const response = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: 1, unitPrice: '0.0100' });

      expect(
        response.status,
        'a client must not be able to name its own price — the body is strict',
      ).toBe(400);

      /* Restore the quantity the flow depends on. */
      const restored = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: flow.orderedQuantity });
      expect(restored.status).toBe(200);
    });

    it('refuses cart access without authentication', async () => {
      const read = await api().get('/api/v1/users/me/cart');
      expect(read.status).toBe(401);

      const write = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .send({ quantity: 1 });
      expect(write.status).toBe(401);
    });

    it('gives each customer their own cart — one token can never reach another’s', async () => {
      /*
       * There is no `/carts/{id}` route to attack: a cart is addressed only as `/users/me/cart`
       * and resolved from the verified token. The reachable test of isolation is therefore that
       * a second customer sees their OWN cart, never this one's — which is the property that
       * route shape is designed to guarantee.
       */
      const theirs = await api().get('/api/v1/users/me/cart').set(asOther());
      expect(theirs.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(theirs).cart;

      expect(state.items, 'the second customer’s cart must be empty').toHaveLength(0);
      expect(state.promotion, 'and must not carry the first customer’s coupon').toBeNull();

      const mine = await api().get('/api/v1/users/me/cart').set(asCustomer());
      expect(bodyAs<{ cart: CartShape }>(mine).cart.id, 'the two carts must be different').not.toBe(
        state.id,
      );
    });
  });

  /* ══ 6. Checkout ═══════════════════════════════════════════════════════ */

  describe('6. checkout', () => {
    const CHECKOUT_KEY = `e2e-checkout-${RUN}`;

    it('requires an idempotency key', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .send({ addressId: flow.addressId });

      expect(
        response.status,
        'without a key a retry would place a second order and take a second payment',
      ).toBe(400);
    });

    it('404s another customer’s address rather than confirming it exists', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', `e2e-foreign-address-${RUN}`)
        .send({ addressId: flow.otherAddressId });

      expect(
        response.status,
        'a 403 here would confirm that an address id belongs to somebody',
      ).toBe(404);
    });

    it('places the order, and every total foots from the API’s own numbers', async () => {
      const before = await readStock(SKU_CODE);

      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', CHECKOUT_KEY)
        .send({ addressId: flow.addressId });

      expect(response.status, 'checkout must create the order').toBe(201);
      const placed = bodyAs<{ order: OrderShape }>(response).order;
      flow.orderNumber = placed.orderNumber;
      flow.payableAmount = placed.grandTotal;

      /* Identity and shape. */
      expect(placed.orderNumber, 'the order number must match the published format').toMatch(
        /^ORD-\d{8}-[A-Z0-9]{6}$/u,
      );
      expect(placed.status, 'a new order is `placed`').toBe('placed');
      expect(placed.placedAt).toEqual(expect.any(String));
      expect(placed.items, 'the order must carry the one cart line').toHaveLength(1);

      /* The line is a SNAPSHOT of what was bought. */
      const line = placed.items[0]!;
      expect(line.skuCode).toBe(SKU_CODE);
      expect(line.skuName).toBe('Medium');
      expect(line.productName).toBe(PRODUCT_NAME);
      expect(line.quantity, 'the ordered quantity must be the cart quantity').toBe(
        flow.orderedQuantity,
      );
      expect(line.unitPrice, 'the ordered price must be the catalogue price').toBe(UNIT_PRICE);
      expect(minor(line.lineTotal)).toBe(minor(UNIT_PRICE) * BigInt(flow.orderedQuantity));

      /* The address is a snapshot too. */
      expect(placed.shippingAddress).toMatchObject({ city: 'Bengaluru', state: STATE });

      /* The coupon carried through from the cart. */
      expect(placed.promotion, 'the applied coupon must survive into the order').toMatchObject({
        code: COUPON,
      });

      /* The money, derived — nothing here is a hardcoded expected total. */
      expect(minor(placed.subtotal), 'subtotal = Σ lineTotal').toBe(minor(line.lineTotal));
      expect(minor(placed.discountTotal), 'discountTotal = Σ line discountAmount, exactly').toBe(
        minor(line.discountAmount),
      );
      expect(minor(placed.discountTotal), `the coupon is ${String(COUPON_PERCENT)}%`).toBe(
        (minor(placed.subtotal) * BigInt(COUPON_PERCENT)) / 100n,
      );
      expect(minor(placed.total), 'total = subtotal − discountTotal').toBe(
        minor(placed.subtotal) - minor(placed.discountTotal),
      );
      expect(minor(placed.grandTotal), 'grandTotal = total + taxTotal — the payable amount').toBe(
        minor(placed.total) + minor(placed.taxTotal),
      );
      expect(minor(placed.taxTotal), 'a classified line must be taxed').toBeGreaterThan(0n);
      expect(minor(placed.taxTotal), `GST at ${String(GST_RATE_PERCENT)}% of the goods total`).toBe(
        (minor(placed.total) * BigInt(GST_RATE_PERCENT)) / 100n,
      );

      /* The GST determination itself. */
      expect(placed.tax, 'an assessed order must name the determination').toMatchObject({
        sellerGstin: SELLER_GSTIN,
        supplyType: 'intra_state',
      });
      expect(line.tax, 'a classified line carries a nested tax block, never null').not.toBeNull();
      expect(line.tax!.hsnCode).toBe(HSN);
      expect(
        minor(line.tax!.cgstAmount) + minor(line.tax!.sgstAmount),
        'same state on both sides: CGST + SGST carry the whole charge',
      ).toBe(minor(placed.taxTotal));
      expect(minor(line.tax!.igstAmount), 'IGST must be nil on an intra-state supply').toBe(0n);

      /* Inventory was RESERVED, not deducted: the goods are still in the warehouse. */
      await waitFor(async () => {
        const after = await readStock(SKU_CODE);
        expect(after.reserved, 'checkout must hold the stock it sold').toBe(
          before.reserved + flow.orderedQuantity,
        );
        expect(after.onHand, 'a reservation must not move on-hand stock').toBe(before.onHand);
        expect(after.available, 'available = onHand − reserved').toBe(
          after.onHand - after.reserved,
        );
      });
    });

    it('persisted the order header and its lines', async () => {
      const rows = await db().select().from(order).where(eq(order.orderNumber, flow.orderNumber));
      expect(rows, 'exactly one order row').toHaveLength(1);
      expect(rows[0]?.userId, 'the order belongs to the customer who placed it').toBe(
        flow.customerId,
      );
      expect(rows[0]?.storeId).toBe(flow.storeId);
      expect(rows[0]?.status).toBe('placed');

      const lines = await db().select().from(orderLine).where(eq(orderLine.orderId, rows[0]!.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity).toBe(flow.orderedQuantity);
      expect(lines[0]?.hsnCode, 'the HSN must be snapshotted onto the line').toBe(HSN);
    });

    it('replays the same idempotency key to the same order, creating nothing new', async () => {
      const replay = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', CHECKOUT_KEY)
        .send({ addressId: flow.addressId });

      expect(replay.status).toBe(201);
      expect(
        bodyAs<{ order: OrderShape }>(replay).order.orderNumber,
        'a replay must reproduce the original response, not place a second order',
      ).toBe(flow.orderNumber);

      const orders = await db().select().from(order).where(eq(order.storeId, flow.storeId));
      expect(orders, 'the store must still hold exactly one order').toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', CHECKOUT_KEY)
        .send({ addressId: flow.otherAddressId });

      expect(
        response.status,
        'a settled key reused with a different body is the caller’s bug',
      ).toBe(422);
      expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    });

    it('cleared the cart: the checked-out one is history and a fresh one is active', async () => {
      const carts = await db().select().from(cart).where(eq(cart.userId, flow.customerId));
      expect(
        carts.some((row) => row.status === 'checked_out'),
        'the cart that became the order must be marked checked out',
      ).toBe(true);

      const current = await api().get('/api/v1/users/me/cart').set(asCustomer());
      expect(current.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(current).cart;
      expect(state.items, 'the customer’s live cart must be empty after checkout').toHaveLength(0);
      expect(state.status).toBe('active');
      expect(state.promotion, 'the spent coupon must not linger on the new cart').toBeNull();
      expect(minor(state.subtotal)).toBe(0n);
    });

    it('refuses to check out an empty cart', async () => {
      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', `e2e-empty-${RUN}`)
        .send({ addressId: flow.addressId });

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('CHECKOUT_CART_EMPTY');
    });

    it('refuses to check out more units than are in stock', async () => {
      /*
       * The stock rule lives at CHECKOUT, not in the cart: `cart.service` documents that it
       * makes no availability check, because a check without a reservation is stale the instant
       * it returns. So the over-order is accepted into the basket and rejected when it tries to
       * hold the goods — which is the behaviour to assert, rather than a cart-level 409 the
       * design deliberately does not have.
       */
      const stock = await readStock(SKU_CODE);
      const tooMany = stock.available + 1;

      const added = await api()
        .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
        .set(asCustomer())
        .send({ quantity: tooMany });
      expect(added.status, 'the cart itself does not police availability').toBe(200);

      const response = await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', `e2e-oversell-${RUN}`)
        .send({ addressId: flow.addressId });

      expect(response.status, 'the system must refuse to sell stock it does not have').toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(
        response.body.error.details.skuCodes,
        'the customer is told which line failed, never the merchant’s quantities',
      ).toContain(SKU_CODE);
      expect(response.body.error.details).not.toHaveProperty('available');

      const unchanged = await readStock(SKU_CODE);
      expect(unchanged.reserved, 'a failed checkout must leave no reservation behind').toBe(
        stock.reserved,
      );

      const cleared = await api().delete('/api/v1/users/me/cart').set(asCustomer());
      expect(cleared.status).toBe(204);
    });
  });

  /* ══ 7. The order, to the customer and to the admin ════════════════════ */

  describe('7. order visibility', () => {
    it('lists the order in the customer’s own order history', async () => {
      const response = await api().get('/api/v1/users/me/orders').set(asCustomer());

      expect(response.status).toBe(200);
      const page = bodyAs<{ orders: OrderShape[]; pagination: { total: number } }>(response);
      const found = page.orders.find((o) => o.orderNumber === flow.orderNumber);

      expect(found, 'the order the customer just placed must be in their history').toBeDefined();
      expect(found!.status).toBe('placed');
      expect(minor(found!.grandTotal), 'the history must report the same payable amount').toBe(
        minor(flow.payableAmount),
      );
      expect(page.pagination.total).toBeGreaterThan(0);
    });

    it('reads the single order with its full contents', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      const read = bodyAs<{ order: OrderShape }>(response).order;
      expect(read.orderNumber).toBe(flow.orderNumber);
      expect(read.items[0]!.skuCode).toBe(SKU_CODE);
      expect(read.items[0]!.quantity).toBe(flow.orderedQuantity);
      expect(minor(read.grandTotal)).toBe(minor(flow.payableAmount));
    });

    it('hides the order from another customer entirely', async () => {
      const read = await api().get(`/api/v1/users/me/orders/${flow.orderNumber}`).set(asOther());
      expect(read.status, 'another customer’s order is absent, not forbidden').toBe(404);

      const list = await api().get('/api/v1/users/me/orders').set(asOther());
      expect(list.status).toBe(200);
      expect(
        bodyAs<{ orders: OrderShape[] }>(list).orders,
        'the second customer’s history must be empty',
      ).toHaveLength(0);

      const invoice = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/invoice`)
        .set(asOther());
      expect(invoice.status).toBe(404);
    });

    it('rejects a malformed order number and 404s a well-formed unknown one', async () => {
      const malformed = await api().get('/api/v1/users/me/orders/NOT-AN-ORDER').set(asCustomer());
      expect(malformed.status, 'the param schema rejects it before any query runs').toBe(400);

      const unknown = await api()
        .get('/api/v1/users/me/orders/ORD-20200101-ABCDEF')
        .set(asCustomer());
      expect(unknown.status, 'a well-formed number that matches nothing is a 404').toBe(404);
    });

    it('gives the admin the order’s invoice through the staff route', async () => {
      const response = await api()
        .get(`/api/v1/admin/orders/${flow.orderNumber}/invoice`)
        .set(asAdmin());

      expect(response.status, 'staff must be able to re-issue any order’s invoice').toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/u);
      expect(response.text, 'the invoice must name the seller').toContain(SELLER_GSTIN);
      expect(response.text, 'and the classification of what was sold').toContain(HSN);
      expect(response.text, 'and the product bought').toContain(PRODUCT_NAME);

      const asShopper = await api()
        .get(`/api/v1/admin/orders/${flow.orderNumber}/invoice`)
        .set(asCustomer());
      expect(asShopper.status, 'a customer must not reach the staff invoice route').toBe(403);
    });
  });

  /* ══ 8. Payment ════════════════════════════════════════════════════════ */

  describe('8. payment initiation', () => {
    const PAY_KEY = `e2e-pay-${RUN}`;

    it('rejects an unknown payment method and an unknown order', async () => {
      const badMethod = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', `e2e-bad-method-${RUN}`)
        .send({ method: 'bitcoin' });
      expect(badMethod.status, 'only the approved methods exist').toBe(400);

      const extraField = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', `e2e-extra-field-${RUN}`)
        .send({ method: 'online', amount: '1.0000' });
      expect(
        extraField.status,
        'a client must never be able to name the amount it is charged',
      ).toBe(400);

      const unknownOrder = await api()
        .post('/api/v1/users/me/orders/ORD-20200101-ABCDEF/payments')
        .set(asCustomer())
        .set('idempotency-key', `e2e-unknown-order-${RUN}`)
        .send({ method: 'online' });
      expect(unknownOrder.status).toBe(404);

      const foreignOrder = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asOther())
        .set('idempotency-key', `e2e-foreign-order-${RUN}`)
        .send({ method: 'online' });
      expect(foreignOrder.status, 'nobody may pay against another customer’s order').toBe(404);

      const noKey = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        .send({ method: 'online' });
      expect(noKey.status, 'a payment without an idempotency key could be taken twice').toBe(400);

      const rows = await db().select().from(payment).where(eq(payment.storeId, flow.storeId));
      expect(rows, 'none of those rejections may have created a payment').toHaveLength(0);
    });

    it('initiates an online payment for exactly the order’s payable amount', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', PAY_KEY)
        .send({ method: 'online' });

      expect(response.status, 'the payment must be created').toBe(201);
      const created = bodyAs<{
        payment: PaymentShape;
        handoff: { provider: string; providerRef: string; publicKey: string };
      }>(response);

      expect(created.payment.orderNumber, 'the payment must name the order it settles').toBe(
        flow.orderNumber,
      );
      expect(created.payment.method).toBe('online');
      expect(created.payment.provider).toBe('razorpay');
      expect(created.payment.status, 'a fresh payment is pending').toBe('pending');
      expect(
        minor(created.payment.amount),
        'the amount must be the order’s grandTotal, computed by the server',
      ).toBe(minor(flow.payableAmount));

      expect(created.handoff, 'an online payment must hand off to the provider').toMatchObject({
        provider: 'razorpay',
        publicKey: RAZORPAY.keyId,
      });
      expect(created.handoff.providerRef, 'the provider order must have been created').toBe(
        providerRefs.at(-1),
      );
      expect(
        JSON.stringify(response.body),
        'the publishable key may reach a browser; the secret never may',
      ).not.toContain(RAZORPAY.keySecret);

      const rows = await db().select().from(payment).where(eq(payment.storeId, flow.storeId));
      expect(rows, 'exactly one payment row').toHaveLength(1);
      expect(minor(rows[0]!.amount)).toBe(minor(flow.payableAmount));
    });

    it('refuses a duplicate payment for the same order', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        /* A DIFFERENT key, so this tests the business rule and not the idempotency replay. */
        .set('idempotency-key', `${PAY_KEY}-second`)
        .send({ method: 'cod' });

      expect(response.status, 'an order takes one payment').toBe(409);
      expect(response.body.error.code).toBe('PAYMENT_ALREADY_EXISTS');

      const rows = await db().select().from(payment).where(eq(payment.storeId, flow.storeId));
      expect(rows, 'and the rejected attempt created nothing').toHaveLength(1);
    });

    it('replays the original key to the original payment', async () => {
      const replay = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', PAY_KEY)
        .send({ method: 'online' });

      expect(replay.status).toBe(201);
      expect(bodyAs<{ payment: PaymentShape }>(replay).payment.orderNumber).toBe(flow.orderNumber);

      const rows = await db().select().from(payment).where(eq(payment.storeId, flow.storeId));
      expect(rows, 'a replay must not create a second payment').toHaveLength(1);
    });

    it('shows the pending payment to the customer and hides it from everyone else', async () => {
      const mine = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
        .set(asCustomer());
      expect(mine.status).toBe(200);
      const view = bodyAs<{ payment: PaymentShape }>(mine).payment;
      expect(view.status).toBe('pending');
      expect(minor(view.amount)).toBe(minor(flow.payableAmount));
      expect(Array.isArray(view.history)).toBe(true);

      const theirs = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
        .set(asOther());
      expect(theirs.status).toBe(404);

      const anonymous = await api().get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('9. successful payment', () => {
    it('rejects a webhook whose signature does not verify', async () => {
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_forged', order_id: providerRefs.at(-1) } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', 'deadbeef')
        .set('x-razorpay-event-id', `evt-forged-${RUN}`)
        .send(body);

      expect(response.status, 'an unsigned caller must not be able to mark orders paid').toBe(401);

      const unchanged = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
        .set(asCustomer());
      expect(
        bodyAs<{ payment: PaymentShape }>(unchanged).payment.status,
        'the forged webhook must have changed nothing',
      ).toBe('pending');
    });

    it('marks the payment succeeded on a correctly signed capture', async () => {
      const providerRef = providerRefs.at(-1)!;
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: `pay_e2e_${RUN}`, order_id: providerRef } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt-capture-${RUN}`)
        .send(body);

      expect(response.status, 'a valid webhook is accepted').toBe(200);
      expect(response.body.status).toBe('applied');

      await waitFor(async () => {
        const read = await api()
          .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
          .set(asCustomer());
        const view = bodyAs<{ payment: PaymentShape }>(read).payment;

        expect(view.status, 'the capture must settle the payment').toBe('succeeded');
        expect(view.failureCode, 'a successful payment has no failure code').toBeNull();
        expect(minor(view.amount), 'settlement must not alter the amount that was authorised').toBe(
          minor(flow.payableAmount),
        );
        expect(
          view.history.some((e) => e.fromStatus === 'pending' && e.toStatus === 'succeeded'),
          'the transition must be recorded in the append-only history',
        ).toBe(true);
      });
    });

    it('treats a redelivered capture as a no-op rather than a second transition', async () => {
      const providerRef = providerRefs.at(-1)!;
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: `pay_e2e_${RUN}`, order_id: providerRef } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt-capture-redelivered-${RUN}`)
        .send(body);

      expect(response.status, 'at-least-once delivery is ordinary, not an error').toBe(200);

      const read = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
        .set(asCustomer());
      const view = bodyAs<{ payment: PaymentShape }>(read).payment;
      expect(view.status).toBe('succeeded');
      expect(
        view.history.filter((e) => e.toStatus === 'succeeded'),
        'a redelivery must not append a second transition row',
      ).toHaveLength(1);
    });

    it('refuses a late failure notification for an already-captured payment', async () => {
      const providerRef = providerRefs.at(-1)!;
      const body = JSON.stringify({
        event: 'payment.failed',
        payload: { payment: { entity: { id: `pay_e2e_${RUN}`, order_id: providerRef } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt-late-failure-${RUN}`)
        .send(body);

      expect(response.status).toBe(200);

      const read = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/payment`)
        .set(asCustomer());
      expect(
        bodyAs<{ payment: PaymentShape }>(read).payment.status,
        'succeeded is terminal — an out-of-order failure must not corrupt it',
      ).toBe('succeeded');
    });
  });

  /* ══ 10. The state the payment left behind ═════════════════════════════ */

  describe('10. post-payment state', () => {
    it('keeps the order `placed` — payment is a separate axis, by design', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      /*
       * `ORDER_STATUSES` is `['placed', 'cancelled']` and the schema documents at length why
       * `paid` is deliberately absent: whether money moved is answered entirely by the payment
       * table, and folding it into `order.status` is the shortcut that makes fulfilment and
       * payment impossible to model separately. Asserting `paid` here would be asserting a
       * design this project explicitly rejected.
       */
      expect(
        bodyAs<{ order: OrderShape }>(response).order.status,
        'order status records the ORDER’s own lifecycle, not the payment’s',
      ).toBe('placed');

      const row = await db().select().from(order).where(eq(order.orderNumber, flow.orderNumber));
      expect(row[0]?.status).toBe('placed');
    });

    it('reports the settled payment in the customer’s payment list', async () => {
      const response = await api().get('/api/v1/users/me/payments').set(asCustomer());

      expect(response.status).toBe(200);
      const found = bodyAs<{ payments: PaymentShape[] }>(response).payments.find(
        (p) => p.orderNumber === flow.orderNumber,
      );
      expect(found, 'the payment must appear in the customer’s own list').toBeDefined();
      expect(found!.status).toBe('succeeded');
      expect(minor(found!.amount)).toBe(minor(flow.payableAmount));
    });

    it('committed the reservation without yet moving the goods', async () => {
      await waitFor(async () => {
        const stock = await readStock(SKU_CODE);
        /*
         * A successful payment commits the reservation — the sale is recognised — but moves no
         * counter: the goods are still in the warehouse until someone ships them. So `onHand` is
         * untouched and `reserved` still holds the units.
         */
        expect(stock.onHand, 'payment must not deduct stock; shipping does').toBe(INITIAL_STOCK);
        expect(stock.reserved, 'the units stay held for this order').toBe(flow.orderedQuantity);
        expect(stock.available).toBe(INITIAL_STOCK - flow.orderedQuantity);
      });
    });

    it('refuses to cancel a paid order, because refunds do not exist', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${flow.orderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
      expect(response.body.error.details.reason).toBe('paid');
    });

    it('left the customer with a clean, empty cart for their next order', async () => {
      const response = await api().get('/api/v1/users/me/cart').set(asCustomer());

      expect(response.status).toBe(200);
      const state = bodyAs<{ cart: CartShape }>(response).cart;
      expect(state.items, 'nothing from the paid order may remain in the basket').toHaveLength(0);
      expect(minor(state.cartTotal)).toBe(0n);
    });
  });

  /* ══ 11. Admin order management ════════════════════════════════════════ */

  describe('11. admin order management and fulfilment', () => {
    it('surfaces the paid order on the admin fulfilment queue', async () => {
      const response = await api()
        .get('/api/v1/admin/orders/fulfilment')
        .set(asAdmin())
        .query({ limit: 50 });

      expect(response.status, 'staff must be able to see what needs picking').toBe(200);
      const row = bodyAs<{
        orders: {
          orderNumber: string;
          recipientName: string;
          city: string;
          shipmentStatus: string | null;
        }[];
      }>(response).orders.find((o) => o.orderNumber === flow.orderNumber);

      expect(row, 'the order awaiting fulfilment must be on the queue').toBeDefined();
      expect(row!.recipientName, 'with the recipient the parcel goes to').toBe('Rhea Menon');
      expect(row!.city).toBe('Bengaluru');
      expect(row!.shipmentStatus, 'and no shipment yet').toBeNull();
    });

    it('refuses the fulfilment queue to a customer and to an anonymous caller', async () => {
      const asShopper = await api().get('/api/v1/admin/orders/fulfilment').set(asCustomer());
      expect(asShopper.status).toBe(403);

      const anonymous = await api().get('/api/v1/admin/orders/fulfilment');
      expect(anonymous.status).toBe(401);
    });

    it('shows the customer no shipment before the admin raises one', async () => {
      const response = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/shipments`)
        .set(asCustomer());

      expect(response.status).toBe(200);
      expect(response.body.shipments).toHaveLength(0);
    });

    it('creates the shipment', async () => {
      const response = await api()
        .post(`/api/v1/admin/orders/${flow.orderNumber}/shipments`)
        .set(asAdmin())
        .send({ carrier: 'Bluedart', trackingNumber: `BD${RUN}001` });

      expect(response.status, 'the admin must be able to raise a shipment').toBe(201);
      expect(response.body.shipment).toMatchObject({
        carrier: 'Bluedart',
        trackingNumber: `BD${RUN}001`,
        status: 'pending',
      });
      flow.shipmentId = response.body.shipment.id as string;

      const duplicate = await api()
        .post(`/api/v1/admin/orders/${flow.orderNumber}/shipments`)
        .set(asAdmin())
        .send({ carrier: 'Bluedart' });
      expect(duplicate.status, 'an order carries one shipment').toBe(409);
      expect(duplicate.body.error.code).toBe('SHIPMENT_ALREADY_EXISTS');
    });

    it('ships it, and THAT is what deducts the stock', async () => {
      const before = await readStock(SKU_CODE);

      const response = await api()
        .post(`/api/v1/admin/shipments/${flow.shipmentId}/ship`)
        .set(asAdmin())
        .send({ note: 'handed to courier' });

      expect(response.status, 'the shipment must move to shipped').toBe(200);
      expect(response.body.shipment.status).toBe('shipped');
      expect(response.body.shipment.shippedAt).toEqual(expect.any(String));

      await waitFor(async () => {
        const after = await readStock(SKU_CODE);
        expect(after.onHand, 'goods physically left the building').toBe(
          before.onHand - flow.orderedQuantity,
        );
        expect(after.reserved, 'the reservation is consumed with them').toBe(0);
        expect(after.available).toBe(after.onHand);
      });

      const history = await api()
        .get(`/api/v1/admin/inventory/${SKU_CODE}/history`)
        .set(asAdmin())
        .query({ limit: 20 });
      expect(history.status).toBe(200);
      expect(
        bodyAs<{ history: { delta: number; reason: string }[] }>(history).history.some(
          /*
           * `shipment` is the ledger vocabulary for "goods physically left the building" — a
           * MECHANISM, not an accounting treatment, which is why `STOCK_REASONS` has it and has
           * no `fulfilment`, `damage` or `write_off`.
           */
          (entry) => entry.reason === 'shipment' && entry.delta === -flow.orderedQuantity,
        ),
        'the movement must be written to the ledger with its cause',
      ).toBe(true);
    });

    it('refuses to ship the same shipment twice', async () => {
      const response = await api()
        .post(`/api/v1/admin/shipments/${flow.shipmentId}/ship`)
        .set(asAdmin())
        .send({});

      expect(response.status, 'a second click must not move the stock again').toBe(409);
      expect(response.body.error.code).toBe('SHIPMENT_NOT_TRANSITIONABLE');
    });

    it('delivers it, and the customer sees the updated status', async () => {
      const delivered = await api()
        .post(`/api/v1/admin/shipments/${flow.shipmentId}/deliver`)
        .set(asAdmin())
        .send({});

      expect(delivered.status).toBe(200);
      expect(delivered.body.shipment.status).toBe('delivered');

      const customerView = await api()
        .get(`/api/v1/users/me/orders/${flow.orderNumber}/shipments`)
        .set(asCustomer());

      expect(customerView.status).toBe(200);
      expect(customerView.body.shipments, 'one shipment, the one the admin raised').toHaveLength(1);
      expect(
        customerView.body.shipments[0],
        'the customer must see the status change the admin made',
      ).toMatchObject({
        status: 'delivered',
        carrier: 'Bluedart',
        trackingNumber: `BD${RUN}001`,
      });
      expect(
        customerView.body.shipments[0],
        'and must not see the operator’s internal note',
      ).not.toHaveProperty('note');
    });

    it('refuses shipment transitions to a customer token', async () => {
      const ship = await api()
        .post(`/api/v1/admin/shipments/${flow.shipmentId}/ship`)
        .set(asCustomer())
        .send({});
      expect(ship.status, 'a customer must not be able to advance their own order').toBe(403);

      const create = await api()
        .post(`/api/v1/admin/orders/${flow.orderNumber}/shipments`)
        .set(asCustomer())
        .send({ carrier: 'Self' });
      expect(create.status).toBe(403);

      const adjust = await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asCustomer())
        .send({ skuCode: SKU_CODE, delta: 100, reason: 'manual_increase' });
      expect(adjust.status, 'nor conjure stock').toBe(403);
    });

    it('gives the admin the customer’s invoice for the fulfilled order', async () => {
      const response = await api()
        .get(`/api/v1/admin/orders/${flow.orderNumber}/invoice`)
        .set(asAdmin());

      expect(response.status).toBe(200);
      /*
       * Formatted with the project's OWN `format()` — the same function the renderer calls —
       * rather than a hand-rolled `₹1,417.50`. Reimplementing the grouping and the minor-unit
       * rounding here would be asserting against a second, divergent formatter, and it would
       * break the moment a locale or a currency changed for reasons that have nothing to do
       * with whether the invoice reconciles.
       */
      const payable = format(fromDb(flow.payableAmount, container.config.defaultCurrency));
      expect(response.text, 'the document must still reconcile to the amount paid').toContain(
        payable,
      );
    });
  });

  /* ══ 12. The failure path ══════════════════════════════════════════════ */

  describe('12. payment failure releases what it held', () => {
    it('places a second order and initiates a payment for it', async () => {
      const placed = await placeOrder(2, `e2e-checkout-fail-${RUN}`);
      flow.failedOrderNumber = placed.orderNumber;

      expect(placed.orderNumber, 'this must be a different order').not.toBe(flow.orderNumber);
      expect(placed.items[0]!.quantity).toBe(2);
      expect(
        placed.promotion,
        'the coupon was spent on the first order and must not reapply itself',
      ).toBeNull();

      const initiated = await api()
        .post(`/api/v1/users/me/orders/${flow.failedOrderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', `e2e-pay-fail-${RUN}`)
        .send({ method: 'online' });

      expect(initiated.status).toBe(201);
      expect(minor(bodyAs<{ payment: PaymentShape }>(initiated).payment.amount)).toBe(
        minor(placed.grandTotal),
      );

      await waitFor(async () => {
        const stock = await readStock(SKU_CODE);
        expect(stock.reserved, 'the second order holds its own stock').toBe(2);
      });
    });

    it('fails the payment and returns the stock to the shelf', async () => {
      const providerRef = providerRefs.at(-1)!;
      const body = JSON.stringify({
        event: 'payment.failed',
        payload: { payment: { entity: { id: `pay_fail_${RUN}`, order_id: providerRef } } },
      });

      const response = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt-failure-${RUN}`)
        .send(body);

      expect(response.status).toBe(200);

      await waitFor(async () => {
        const read = await api()
          .get(`/api/v1/users/me/orders/${flow.failedOrderNumber}/payment`)
          .set(asCustomer());
        expect(bodyAs<{ payment: PaymentShape }>(read).payment.status).toBe('failed');
      });

      await waitFor(async () => {
        const stock = await readStock(SKU_CODE);
        expect(stock.reserved, 'a failed payment must release the units it was holding').toBe(0);
        expect(stock.available, 'and make them sellable again').toBe(stock.onHand);
      });
    });

    it('lets the customer cancel the unpaid order', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${flow.failedOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status, 'an order whose payment failed is cancellable').toBe(200);
      expect(bodyAs<{ order: OrderShape }>(response).order.status).toBe('cancelled');

      const twice = await api()
        .post(`/api/v1/users/me/orders/${flow.failedOrderNumber}/cancel`)
        .set(asCustomer())
        .send({});
      expect(twice.status, 'cancelling twice is a conflict, not a second cancellation').toBe(409);
    });
  });

  /* ══ 13. The whole flow, reconciled ════════════════════════════════════ */

  describe('13. final reconciliation', () => {
    it('leaves the order, payment and inventory records mutually consistent', async () => {
      const orders = await db().select().from(order).where(eq(order.storeId, flow.storeId));
      const payments = await db().select().from(payment).where(eq(payment.storeId, flow.storeId));

      expect(
        orders,
        'two orders were placed: the fulfilled one and the cancelled one',
      ).toHaveLength(2);
      expect(orders.filter((o) => o.status === 'placed')).toHaveLength(1);
      expect(orders.filter((o) => o.status === 'cancelled')).toHaveLength(1);

      expect(payments, 'one payment per order').toHaveLength(2);
      for (const row of payments) {
        expect(
          orders.some((o) => o.id === row.orderId),
          'every payment must point at an order in this store',
        ).toBe(true);
      }
      expect(payments.filter((p) => p.status === 'succeeded')).toHaveLength(1);
      expect(payments.filter((p) => p.status === 'failed')).toHaveLength(1);

      const succeeded = payments.find((p) => p.status === 'succeeded')!;
      const fulfilled = orders.find((o) => o.orderNumber === flow.orderNumber)!;
      expect(succeeded.orderId, 'the money that moved settled the order that shipped').toBe(
        fulfilled.id,
      );
      expect(minor(succeeded.amount), 'and it was for exactly the order’s grand total').toBe(
        minor(fulfilled.grandTotal),
      );
    });

    it('leaves the stock ledger reconciled to what actually shipped', async () => {
      const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, flow.storeId));
      const row = stock.find((s) => s.onHand === INITIAL_STOCK - flow.orderedQuantity);

      expect(row, 'exactly the shipped units left the warehouse, and no more').toBeDefined();
      expect(row!.reserved, 'nothing is held once every order is settled or cancelled').toBe(0);
    });

    it('ends the session, and the refresh token dies with it', async () => {
      const response = await api().post('/api/v1/auth/logout').set(asCustomer()).send({});
      expect(response.status).toBe(204);

      const replay = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: flow.customerRefreshToken });
      expect(replay.status, 'logout must revoke the session, not merely the access token').toBe(
        401,
      );
    });
  });
});
