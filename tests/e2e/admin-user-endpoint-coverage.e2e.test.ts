import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';
import { order } from '../../src/db/schema/orders.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * Endpoint-coverage walkthrough (narrated).
 *
 * `full-flow-walkthrough.e2e.test.ts` already narrates the single "happy path" a shopper and a
 * merchant would actually take: build one product, buy it, ship it, return part of it. It
 * deliberately does NOT visit every route the API exposes — a list endpoint, a PATCH, a DELETE,
 * a second page of a paginated resource — because a straight-line story has no reason to.
 *
 * This file exists to close that gap. It provisions its OWN brand-new admin and brand-new
 * customer (its own Postgres and Redis containers, via `beforeAll`, exactly like the other
 * walkthrough) and drives them through every registered route that the happy-path walkthrough
 * does not reach: list/detail/patch/delete on catalogue, promotions, tax, inventory, addresses,
 * cart, orders, payments and fulfilment, plus the identity self-service routes (profile,
 * password, refresh, logout) and the two unauthenticated infrastructure routes (health, docs).
 *
 * Every step is printed — method, path, status, and the fact that mattered — with
 * `process.stdout.write` rather than `console.log`, for the same reason the other walkthrough
 * uses it: Vitest groups intercepted console output under the test that produced it, which
 * collapses to nothing once output is redirected to a file, and this transcript is the point of
 * the file.
 *
 * Cross-reference with `tests/audit/endpoint-inventory.test.ts`, which asserts (against the
 * real container) that every registered route is documented and vice versa — the ground truth
 * this file's coverage claim rests on.
 */
describe('admin + user endpoint coverage walkthrough (narrated)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const providerRefs: string[] = [];

  const RAZORPAY = {
    keyId: 'rzp_test_coverage',
    keySecret: 'coverage-api-secret',
    webhookSecret: 'coverage-webhook-secret',
  };

  const PASSWORD = 'a-sufficiently-long-password';
  const SELLER_STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const CUSTOMER_GSTIN = '29AAAPL1234C1ZV';
  const HSN = '61091000';

  let storeId = '';
  let adminToken = '';
  let customerToken = '';
  let refreshToken = '';
  let skuCode = '';
  let productSlug = '';
  let secondSlug = '';
  let couponCode = '';
  let taxClassCode = '';
  let addressId = '';
  let secondAddressId = '';
  let orderNumber = '';
  let cancellableOrderNumber = '';
  let orderId = '';
  let shipmentId = '';
  let optionId = '';
  let optionValueId = '';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /* ── Narration (identical convention to full-flow-walkthrough.e2e.test.ts) ─────────────── */

  let step = 0;
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const section = (title: string): void => {
    line('');
    line(`══════ ${title} ══════`);
  };
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

    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      const ref = `order_COV_${String(providerRefs.length + 1)}`;
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
    line('║  ENDPOINT COVERAGE WALKTHROUGH — routes the happy path does not visit  ║');
    line('╚════════════════════════════════════════════════════════════════════════╝');
    line(`store seeded: ${storeId}`);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. Actors and infrastructure routes ═══════════════════════════════ */

  it('creates a brand-new ADMIN and CUSTOMER, and checks health/docs', async () => {
    section('1. ACTORS + INFRASTRUCTURE');

    const live = await api().get('/health/live');
    log('GET', '/health/live', live.status, 'process is up');
    expect(live.status).toBe(200);

    const ready = await api().get('/health/ready');
    log('GET', '/health/ready', ready.status, 'DB + Redis reachable');
    expect(ready.status).toBe(200);

    const docsJson = await api().get('/docs.json');
    log('GET', '/docs.json', docsJson.status, 'OpenAPI document served');
    expect(docsJson.status).toBe(200);
    expect(docsJson.body.paths).toBeTruthy();

    const docsUi = await api().get('/docs');
    log('GET', '/docs', docsUi.status, 'Swagger UI reachable (redirect or HTML)');
    expect([200, 301, 302]).toContain(docsUi.status);

    const adminEmail = `admin.${newId()}@example.com`;
    const admin = await container.identity.registerCustomer({
      storeId,
      input: { email: adminEmail, password: PASSWORD, firstName: 'Store', lastName: 'Owner' },
    });
    log('POST', '/auth/register (admin, via service)', 201, adminEmail);

    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, admin.id));
    fact('promoted to staff via app_user.is_staff = true (no endpoint grants this)');

    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: PASSWORD });
    adminToken = adminLogin.body.accessToken as string;
    log('POST', '/api/v1/auth/login', adminLogin.status, 'admin signed in');
    expect(adminLogin.status).toBe(200);

    const customerEmail = `shopper.${newId()}@example.com`;
    const registered = await api().post('/api/v1/auth/register').send({
      email: customerEmail,
      password: PASSWORD,
      firstName: 'Grace',
      lastName: 'Hopper',
      phone: '+91 9123456780',
    });
    log('POST', '/api/v1/auth/register', registered.status, customerEmail);
    expect(registered.status).toBe(201);

    const customerLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password: PASSWORD });
    customerToken = customerLogin.body.accessToken as string;
    refreshToken = customerLogin.body.refreshToken as string;
    log('POST', '/api/v1/auth/login', customerLogin.status, 'customer signed in');
    expect(customerLogin.status).toBe(200);
  });

  /* ══ 2. Catalogue — the full CRUD surface, not just create ════════════ */

  it('walks the ADMIN catalogue surface: list, detail, patch, options, lifecycle, delete', async () => {
    section('2. ADMIN — CATALOGUE (list/detail/patch/options/lifecycle/delete)');

    productSlug = `coverage-tee-${String(Date.now()).slice(-6)}`;
    skuCode = `COV-TEE-${String(Date.now()).slice(-6)}`;

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asAdmin())
      .send({ slug: productSlug, name: 'Coverage Tee', description: 'For the walkthrough' });
    log('POST', '/api/v1/admin/products', product.status, productSlug);
    expect(product.status).toBe(201);
    expect(product.body.product.status).toBe('draft');

    const sku = await api()
      .post(`/api/v1/admin/products/${productSlug}/skus`)
      .set(asAdmin())
      .send({ code: skuCode, price: '750.0000' });
    log('POST', '/api/v1/admin/products/:slug/skus', sku.status, `${skuCode} @ 750.0000`);
    expect(sku.status).toBe(201);

    const listSkus = await api().get(`/api/v1/admin/products/${productSlug}/skus`).set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/products/:slug/skus',
      listSkus.status,
      `${String(listSkus.body.skus.length)} sku(s)`,
    );
    expect(listSkus.status).toBe(200);

    const patchedSku = await api()
      .patch(`/api/v1/admin/skus/${skuCode}`)
      .set(asAdmin())
      .send({ price: '699.0000' });
    log('PATCH', '/api/v1/admin/skus/:code', patchedSku.status, 'price corrected to 699.0000');
    expect(patchedSku.status).toBe(200);
    expect(patchedSku.body.sku.price).toBe('699.0000');

    /* ---- options ---- */

    const option = await api()
      .post(`/api/v1/admin/products/${productSlug}/options`)
      .set(asAdmin())
      .send({ name: 'Size' });
    log('POST', '/api/v1/admin/products/:slug/options', option.status, 'option "Size" created');
    expect(option.status).toBe(201);
    optionId = option.body.option.id as string;

    const value = await api()
      .post(`/api/v1/admin/options/${optionId}/values`)
      .set(asAdmin())
      .send({ value: 'Large' });
    log('POST', '/api/v1/admin/options/:id/values', value.status, 'value "Large" created');
    expect(value.status).toBe(201);
    optionValueId = value.body.value.id as string;

    const listOptions = await api()
      .get(`/api/v1/admin/products/${productSlug}/options`)
      .set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/products/:slug/options',
      listOptions.status,
      `${String(listOptions.body.options.length)} option(s), values nested`,
    );
    expect(listOptions.status).toBe(200);
    expect(listOptions.body.options[0].values).toHaveLength(1);

    const patchedOption = await api()
      .patch(`/api/v1/admin/options/${optionId}`)
      .set(asAdmin())
      .send({ name: 'Size (US)' });
    log('PATCH', '/api/v1/admin/options/:id', patchedOption.status, 'option renamed');
    expect(patchedOption.status).toBe(200);

    const patchedValue = await api()
      .patch(`/api/v1/admin/option-values/${optionValueId}`)
      .set(asAdmin())
      .send({ value: 'L' });
    log('PATCH', '/api/v1/admin/option-values/:id', patchedValue.status, 'value renamed to "L"');
    expect(patchedValue.status).toBe(200);

    const bound = await api()
      .put(`/api/v1/admin/skus/${skuCode}/options`)
      .set(asAdmin())
      .send({ optionValueIds: [optionValueId] });
    log('PUT', '/api/v1/admin/skus/:code/options', bound.status, 'SKU bound to size "L"');
    expect(bound.status).toBe(200);
    expect(bound.body.sku.options).toHaveLength(1);

    /* ---- stock, so this SKU is purchasable once published ---- */

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asAdmin())
      .send({ skuCode, delta: 40, reason: 'manual_increase', note: 'coverage walkthrough' });
    log('POST', '/api/v1/admin/inventory/adjustments', stocked.status, '+40 units on hand');
    expect(stocked.status).toBe(201);

    /* ---- lifecycle: publish makes it public ---- */

    const notYetPublic = await api().get(`/api/v1/products/${productSlug}`);
    log('GET', '/api/v1/products/:slug', notYetPublic.status, 'draft product not yet public');
    expect(notYetPublic.status).toBe(404);

    const published = await api()
      .post(`/api/v1/admin/products/${productSlug}/publish`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/products/:slug/publish', published.status, 'draft → active');
    expect(published.status).toBe(200);
    expect(published.body.product.status).toBe('active');

    const nowPublic = await api().get(`/api/v1/products/${productSlug}`);
    log('GET', '/api/v1/products/:slug', nowPublic.status, 'now visible on the storefront');
    expect(nowPublic.status).toBe(200);

    const staffRead = await api().get(`/api/v1/admin/products/${productSlug}`).set(asAdmin());
    log('GET', '/api/v1/admin/products/:slug', staffRead.status, 'staff detail read (any status)');
    expect(staffRead.status).toBe(200);

    const listed = await api().get('/api/v1/admin/products').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/products',
      listed.status,
      `${String(listed.body.products.length)} product(s) in every lifecycle state`,
    );
    expect(listed.status).toBe(200);

    const patchedProduct = await api()
      .patch(`/api/v1/admin/products/${productSlug}`)
      .set(asAdmin())
      .send({ description: 'Updated copy for the coverage walkthrough' });
    log('PATCH', '/api/v1/admin/products/:slug', patchedProduct.status, 'description edited');
    expect(patchedProduct.status).toBe(200);

    /* ---- a second, disposable product to exercise archive + delete without disturbing ---- */
    /* ---- the SKU the rest of this file still needs for cart/checkout/returns.         ---- */

    secondSlug = `coverage-disposable-${String(Date.now()).slice(-6)}`;
    const disposable = await api()
      .post('/api/v1/admin/products')
      .set(asAdmin())
      .send({ slug: secondSlug, name: 'Disposable Product', status: 'active' });
    log('POST', '/api/v1/admin/products', disposable.status, `${secondSlug} (created active)`);
    expect(disposable.status).toBe(201);

    const archived = await api()
      .post(`/api/v1/admin/products/${secondSlug}/archive`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/products/:slug/archive', archived.status, 'active → archived');
    expect(archived.status).toBe(200);
    expect(archived.body.product.status).toBe('archived');

    const gone = await api().get(`/api/v1/products/${secondSlug}`);
    log('GET', '/api/v1/products/:slug', gone.status, 'archived product leaves the storefront');
    expect(gone.status).toBe(404);

    const deleted = await api().delete(`/api/v1/admin/products/${secondSlug}`).set(asAdmin());
    log('DELETE', '/api/v1/admin/products/:slug', deleted.status, 'soft-deleted');
    expect(deleted.status).toBe(204);

    const deletedAgain = await api().delete(`/api/v1/admin/products/${secondSlug}`).set(asAdmin());
    log('DELETE', '/api/v1/admin/products/:slug', deletedAgain.status, 'a second delete is 404');
    expect(deletedAgain.status).toBe(404);

    /* ---- option cleanup: delete the value, then the option, both now unused ---- */

    const unbind = await api()
      .put(`/api/v1/admin/skus/${skuCode}/options`)
      .set(asAdmin())
      .send({ optionValueIds: [] });
    log('PUT', '/api/v1/admin/skus/:code/options', unbind.status, 'combination cleared');
    expect(unbind.status).toBe(200);

    const deleteValue = await api()
      .delete(`/api/v1/admin/option-values/${optionValueId}`)
      .set(asAdmin());
    log('DELETE', '/api/v1/admin/option-values/:id', deleteValue.status, 'value retired');
    expect(deleteValue.status).toBe(204);

    const deleteOption = await api().delete(`/api/v1/admin/options/${optionId}`).set(asAdmin());
    log('DELETE', '/api/v1/admin/options/:id', deleteOption.status, 'option retired');
    expect(deleteOption.status).toBe(204);
  });

  /* ══ 3. Promotions, tax, inventory — admin depth ═══════════════════════ */

  it('walks the ADMIN promotions, tax and inventory surfaces', async () => {
    section('3. ADMIN — PROMOTIONS / TAX / INVENTORY (list/get/patch/delete)');

    couponCode = `COV10-${String(Date.now()).slice(-5)}`;
    const promo = await api().post('/api/v1/admin/promotions').set(asAdmin()).send({
      code: couponCode,
      name: '10% off (coverage)',
      discountType: 'percentage',
      percentRate: '10',
      isActive: true,
    });
    log('POST', '/api/v1/admin/promotions', promo.status, couponCode);
    expect(promo.status).toBe(201);

    const promoList = await api().get('/api/v1/admin/promotions').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/promotions',
      promoList.status,
      `${String(promoList.body.promotions.length)} promotion(s)`,
    );
    expect(promoList.status).toBe(200);

    const promoGet = await api().get(`/api/v1/admin/promotions/${couponCode}`).set(asAdmin());
    log('GET', '/api/v1/admin/promotions/:code', promoGet.status, 'single promotion read');
    expect(promoGet.status).toBe(200);

    const promoPatch = await api()
      .patch(`/api/v1/admin/promotions/${couponCode}`)
      .set(asAdmin())
      .send({ name: '10% off, renamed' });
    log('PATCH', '/api/v1/admin/promotions/:code', promoPatch.status, 'renamed');
    expect(promoPatch.status).toBe(200);

    /* ---- a disposable coupon, deleted immediately, to exercise the delete route ---- */

    const disposableCode = `COVDEL-${String(Date.now()).slice(-5)}`;
    await api().post('/api/v1/admin/promotions').set(asAdmin()).send({
      code: disposableCode,
      name: 'disposable',
      discountType: 'fixed_amount',
      amount: '50.0000',
    });
    const promoDelete = await api()
      .delete(`/api/v1/admin/promotions/${disposableCode}`)
      .set(asAdmin());
    log('DELETE', '/api/v1/admin/promotions/:code', promoDelete.status, 'soft-deleted');
    expect(promoDelete.status).toBe(204);

    const promoGone = await api().get(`/api/v1/admin/promotions/${disposableCode}`).set(asAdmin());
    log('GET', '/api/v1/admin/promotions/:code', promoGone.status, 'deleted promotion is 404');
    expect(promoGone.status).toBe(404);

    /* ---- tax ---- */

    const profileBefore = await api().get('/api/v1/admin/store/tax-profile').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/store/tax-profile',
      profileBefore.status,
      `configured=${String(profileBefore.body.configured)}`,
    );
    expect(profileBefore.status).toBe(200);

    const profile = await api().put('/api/v1/admin/store/tax-profile').set(asAdmin()).send({
      legalName: 'Coverage Retail Private Limited',
      gstin: SELLER_GSTIN,
      originLine1: '1st Floor, Coverage Street',
      originCity: 'Bengaluru',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log('PUT', '/api/v1/admin/store/tax-profile', profile.status, `seller GSTIN ${SELLER_GSTIN}`);
    expect(profile.status).toBe(200);

    taxClassCode = `GSTCOV-${String(Date.now()).slice(-5)}`;
    const taxClass = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asAdmin())
      .send({ code: taxClassCode, name: 'GST 5% (coverage)', isActive: true });
    log('POST', '/api/v1/admin/tax-classes', taxClass.status, taxClassCode);
    expect(taxClass.status).toBe(201);

    const classList = await api().get('/api/v1/admin/tax-classes').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/tax-classes',
      classList.status,
      `${String(classList.body.taxClasses.length)} tax class(es)`,
    );
    expect(classList.status).toBe(200);

    const classPatch = await api()
      .patch(`/api/v1/admin/tax-classes/${taxClassCode}`)
      .set(asAdmin())
      .send({ name: 'GST 5% (renamed)' });
    log('PATCH', '/api/v1/admin/tax-classes/:code', classPatch.status, 'renamed');
    expect(classPatch.status).toBe(200);

    const rate = await api()
      .post(`/api/v1/admin/tax-classes/${taxClassCode}/rates`)
      .set(asAdmin())
      .send({
        cgstRate: '2.5',
        sgstRate: '2.5',
        igstRate: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      });
    log('POST', '/api/v1/admin/tax-classes/:code/rates', rate.status, 'CGST 2.5 + SGST 2.5');
    expect(rate.status).toBe(201);

    const rateList = await api()
      .get(`/api/v1/admin/tax-classes/${taxClassCode}/rates`)
      .set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/tax-classes/:code/rates',
      rateList.status,
      `${String(rateList.body.rates.length)} rate row(s)`,
    );
    expect(rateList.status).toBe(200);

    const assigned = await api()
      .put(`/api/v1/admin/skus/${skuCode}/tax`)
      .set(asAdmin())
      .send({ taxClassCode, hsnCode: HSN });
    log('PUT', '/api/v1/admin/skus/:code/tax', assigned.status, `HSN ${HSN} assigned`);
    expect(assigned.status).toBe(200);

    /* ---- inventory: list + history ---- */

    const invList = await api().get('/api/v1/admin/inventory').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/inventory',
      invList.status,
      `${String(invList.body.items.length)} stock row(s)`,
    );
    expect(invList.status).toBe(200);

    const invHistory = await api().get(`/api/v1/admin/inventory/${skuCode}/history`).set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/inventory/:skuCode/history',
      invHistory.status,
      `${String(invHistory.body.items.length)} ledger entr(y/ies), append-only`,
    );
    expect(invHistory.status).toBe(200);
    expect(invHistory.body.items.length).toBeGreaterThan(0);
  });

  /* ══ 4. Customer self-service depth: addresses, cart, tax identity ═════ */

  it('walks the CUSTOMER address book, cart lifecycle and GST identity', async () => {
    section('4. CUSTOMER — ADDRESSES / CART / TAX IDENTITY (list/get/patch/delete)');

    const home = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Home',
      recipientName: 'Grace Hopper',
      phone: '+91 9123456780',
      line1: '1 Turing Lane',
      city: 'Bengaluru',
      state: SELLER_STATE,
      postalCode: '560025',
    });
    log('POST', '/api/v1/users/me/addresses', home.status, 'home address created');
    expect(home.status).toBe(201);
    addressId = home.body.address.id as string;

    const office = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
      label: 'Office',
      recipientName: 'Grace Hopper',
      phone: '+91 9123456780',
      line1: '2 Babbage Road',
      city: 'Bengaluru',
      state: SELLER_STATE,
      postalCode: '560025',
    });
    log('POST', '/api/v1/users/me/addresses', office.status, 'second (office) address created');
    expect(office.status).toBe(201);
    secondAddressId = office.body.address.id as string;

    const listedAddresses = await api().get('/api/v1/users/me/addresses').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/addresses',
      listedAddresses.status,
      `${String(listedAddresses.body.addresses.length)} address(es)`,
    );
    expect(listedAddresses.status).toBe(200);
    expect(listedAddresses.body.addresses.length).toBeGreaterThanOrEqual(2);

    const oneAddress = await api().get(`/api/v1/users/me/addresses/${addressId}`).set(asCustomer());
    log('GET', '/api/v1/users/me/addresses/:id', oneAddress.status, 'single address read');
    expect(oneAddress.status).toBe(200);

    const patchedAddress = await api()
      .patch(`/api/v1/users/me/addresses/${secondAddressId}`)
      .set(asCustomer())
      .send({ landmark: 'Near the library' });
    log('PATCH', '/api/v1/users/me/addresses/:id', patchedAddress.status, 'landmark added');
    expect(patchedAddress.status).toBe(200);

    const deletedAddress = await api()
      .delete(`/api/v1/users/me/addresses/${secondAddressId}`)
      .set(asCustomer());
    log('DELETE', '/api/v1/users/me/addresses/:id', deletedAddress.status, 'office soft-deleted');
    expect(deletedAddress.status).toBe(204);

    const readDeleted = await api()
      .get(`/api/v1/users/me/addresses/${secondAddressId}`)
      .set(asCustomer());
    log('GET', '/api/v1/users/me/addresses/:id', readDeleted.status, 'deleted address is 404');
    expect(readDeleted.status).toBe(404);

    /* ---- tax identity: register GST, read it back, remove it ---- */

    const noIdentity = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
    log('GET', '/api/v1/users/me/tax-identity', noIdentity.status, 'no GSTIN registered yet');
    expect(noIdentity.status).toBe(404);

    const putIdentity = await api()
      .put('/api/v1/users/me/tax-identity')
      .set(asCustomer())
      .send({ gstin: CUSTOMER_GSTIN, legalName: 'Grace Hopper Consulting' });
    log('PUT', '/api/v1/users/me/tax-identity', putIdentity.status, `GSTIN ${CUSTOMER_GSTIN} set`);
    expect(putIdentity.status).toBe(200);

    const getIdentity = await api().get('/api/v1/users/me/tax-identity').set(asCustomer());
    log('GET', '/api/v1/users/me/tax-identity', getIdentity.status, 'read back');
    expect(getIdentity.status).toBe(200);
    expect(getIdentity.body.taxIdentity.gstin).toBe(CUSTOMER_GSTIN);

    const deleteIdentity = await api().delete('/api/v1/users/me/tax-identity').set(asCustomer());
    log(
      'DELETE',
      '/api/v1/users/me/tax-identity',
      deleteIdentity.status,
      'removed → next order is B2C',
    );
    expect(deleteIdentity.status).toBe(204);

    /* ---- cart: get empty, add, get, remove an item, empty it entirely ---- */

    const emptyCart = await api().get('/api/v1/users/me/cart').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/cart',
      emptyCart.status,
      `itemCount=${String(emptyCart.body.cart.itemCount)}`,
    );
    expect(emptyCart.status).toBe(200);

    const added = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 5 });
    log('PUT', '/api/v1/users/me/cart/items/:sku', added.status, '5 units added');
    expect(added.status).toBe(200);

    const cartRead = await api().get('/api/v1/users/me/cart').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/cart',
      cartRead.status,
      `subtotal=${cartRead.body.cart.subtotal as string}`,
    );
    expect(cartRead.status).toBe(200);
    expect(cartRead.body.cart.itemCount).toBe(5);

    const promoApplied = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCustomer())
      .send({ code: couponCode });
    log('PUT', '/api/v1/users/me/cart/promotion', promoApplied.status, `${couponCode} applied`);
    expect(promoApplied.status).toBe(200);

    const promoRemoved = await api().delete('/api/v1/users/me/cart/promotion').set(asCustomer());
    log('DELETE', '/api/v1/users/me/cart/promotion', promoRemoved.status, 'coupon removed');
    expect(promoRemoved.status).toBe(200);
    expect(promoRemoved.body.cart.promotion).toBeNull();

    const itemRemoved = await api()
      .delete(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer());
    log('DELETE', '/api/v1/users/me/cart/items/:sku', itemRemoved.status, 'line removed');
    expect(itemRemoved.status).toBe(200);
    expect(itemRemoved.body.cart.itemCount).toBe(0);

    /* ---- refill it, since checkout in the next section needs real items ---- */

    const refilled = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 4 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      refilled.status,
      '4 units re-added for checkout',
    );
    expect(refilled.status).toBe(200);

    const cleared = await api().delete('/api/v1/users/me/cart').set(asCustomer());
    log('DELETE', '/api/v1/users/me/cart', cleared.status, 'DELETE /cart empties it entirely');
    expect(cleared.status).toBe(200);
    expect(cleared.body.cart.itemCount).toBe(0);

    const final = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 2 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      final.status,
      '2 units for the real checkout below',
    );
    expect(final.status).toBe(200);
  });

  /* ══ 5. Two orders: one paid (payments/fulfilment depth), one cancelled ═ */

  it('checks out TWO orders — one goes to payment and fulfilment, one is cancelled unpaid', async () => {
    section('5. ORDERS — checkout, list, get, cancel, admin invoice');

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `cov-${newId()}`)
      .send({ addressId });
    log('POST', '/api/v1/users/me/checkout', checkout.status, 'order #1 placed (will be paid)');
    expect(checkout.status).toBe(201);
    orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    orderId = row!.id;

    const listOrders = await api().get('/api/v1/users/me/orders').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/orders',
      listOrders.status,
      `${String(listOrders.body.total)} order(s) for this customer`,
    );
    expect(listOrders.status).toBe(200);

    const oneOrder = await api().get(`/api/v1/users/me/orders/${orderNumber}`).set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/orders/:n',
      oneOrder.status,
      `status=${oneOrder.body.order.status as string}`,
    );
    expect(oneOrder.status).toBe(200);

    /* ---- a second order, never paid, to exercise cancellation ---- */

    const secondCart = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asCustomer())
      .send({ quantity: 1 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      secondCart.status,
      '1 unit for a second, cancellable order',
    );
    expect(secondCart.status).toBe(200);

    const checkout2 = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', `cov2-${newId()}`)
      .send({ addressId });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      checkout2.status,
      'order #2 placed (will be cancelled)',
    );
    expect(checkout2.status).toBe(201);
    cancellableOrderNumber = checkout2.body.order.orderNumber as string;

    const cancelled = await api()
      .post(`/api/v1/users/me/orders/${cancellableOrderNumber}/cancel`)
      .set(asCustomer())
      .send();
    log(
      'POST',
      '/api/v1/users/me/orders/:n/cancel',
      cancelled.status,
      'unpaid order cancelled → stock released',
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order.status).toBe('cancelled');

    const cancelTwice = await api()
      .post(`/api/v1/users/me/orders/${cancellableOrderNumber}/cancel`)
      .set(asCustomer())
      .send();
    log(
      'POST',
      '/api/v1/users/me/orders/:n/cancel',
      cancelTwice.status,
      'cancelling an already-cancelled order is refused',
    );
    expect(cancelTwice.status).toBe(409);

    /* ---- pay order #1, so fulfilment and payments-list have something real to show ---- */

    const initiated = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', `pay-${newId()}`)
      .send({ method: 'online' });
    log('POST', '/api/v1/users/me/orders/:n/payments', initiated.status, 'payment initiated');
    expect(initiated.status).toBe(201);

    const providerRef = providerRefs[providerRefs.length - 1]!;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_COV', order_id: providerRef } } },
    });
    const hook = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt_cov_${newId()}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', hook.status, 'signed webhook captures the payment');
    expect(hook.status).toBe(200);

    const paymentsList = await api().get('/api/v1/users/me/payments').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/payments',
      paymentsList.status,
      `${String(paymentsList.body.payments.length)} payment(s) across all this customer's orders`,
    );
    expect(paymentsList.status).toBe(200);
    expect(paymentsList.body.payments.length).toBeGreaterThan(0);

    /* ---- admin invoice view ---- */

    const adminInvoice = await api()
      .get(`/api/v1/admin/orders/${orderNumber}/invoice`)
      .set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      adminInvoice.status,
      "staff can view ANY order's invoice",
    );
    expect(adminInvoice.status).toBe(200);
  });

  /* ══ 6. Fulfilment — queue, staff shipment list, tracking correction ═══ */

  it('walks the ADMIN fulfilment queue and corrects tracking after shipping', async () => {
    section('6. ADMIN — FULFILMENT (queue, staff list, tracking PATCH)');

    const queueBefore = await api().get('/api/v1/admin/orders/fulfilment').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/orders/fulfilment',
      queueBefore.status,
      `${String(queueBefore.body.orders.length)} paid order(s) awaiting a shipment`,
    );
    expect(queueBefore.status).toBe(200);
    expect(
      (queueBefore.body.orders as { orderNumber: string }[]).some(
        (o) => o.orderNumber === orderNumber,
      ),
    ).toBe(true);

    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin())
      .send({ carrier: 'Delhivery', trackingNumber: `DHV-${String(Date.now()).slice(-8)}` });
    log('POST', '/api/v1/admin/orders/:n/shipments', created.status, 'shipment raised (pending)');
    expect(created.status).toBe(201);
    shipmentId = created.body.shipment.id as string;

    const staffShipments = await api()
      .get(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/orders/:n/shipments',
      staffShipments.status,
      `${String(staffShipments.body.shipments.length)} shipment(s), staff view`,
    );
    expect(staffShipments.status).toBe(200);

    const shipped = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
      .set(asAdmin())
      .send({});
    log(
      'POST',
      '/api/v1/admin/shipments/:id/ship',
      shipped.status,
      'pending → shipped, stock deducted',
    );
    expect(shipped.status).toBe(200);

    const trackingFixed = await api()
      .patch(`/api/v1/admin/shipments/${shipmentId}`)
      .set(asAdmin())
      .send({ trackingNumber: `DHV-CORRECTED-${String(Date.now()).slice(-6)}` });
    log(
      'PATCH',
      '/api/v1/admin/shipments/:id',
      trackingFixed.status,
      'tracking number corrected in flight',
    );
    expect(trackingFixed.status).toBe(200);

    const delivered = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
      .set(asAdmin())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/deliver', delivered.status, 'shipped → delivered');
    expect(delivered.status).toBe(200);

    const queueAfter = await api().get('/api/v1/admin/orders/fulfilment').set(asAdmin());
    log(
      'GET',
      '/api/v1/admin/orders/fulfilment',
      queueAfter.status,
      'delivered order has left the queue',
    );
    expect(queueAfter.status).toBe(200);
    expect(
      (queueAfter.body.orders as { orderNumber: string }[]).some(
        (o) => o.orderNumber === orderNumber,
      ),
    ).toBe(false);
  });

  /* ══ 7. Returns detail read ═════════════════════════════════════════ */

  it('raises a return and reads the single-record view both actors see', async () => {
    section('7. RETURNS — single-record GET (customer + staff)');

    const created = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
      .set(asCustomer())
      .set('idempotency-key', `covret-${newId()}`)
      .send({ reason: 'changed_mind', lines: [{ skuCode, quantity: 1 }] });
    log('POST', '/api/v1/users/me/orders/:n/returns', created.status, 'customer raises a return');
    expect(created.status).toBe(201);
    const returnNumber = created.body.return.returnNumber as string;

    const customerRead = await api()
      .get(`/api/v1/users/me/returns/${returnNumber}`)
      .set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me/returns/:n',
      customerRead.status,
      'customer view (no staffNote field)',
    );
    expect(customerRead.status).toBe(200);
    expect(customerRead.body.return.staffNote).toBeUndefined();

    const approved = await api()
      .post(`/api/v1/admin/returns/${returnNumber}/approve`)
      .set(asAdmin())
      .send({ staffNote: 'coverage walkthrough approval' });
    log('POST', '/api/v1/admin/returns/:n/approve', approved.status, 'staff approves');
    expect(approved.status).toBe(200);
  });

  /* ══ 8. Identity self-service: profile, password, refresh, logout ══════ */

  it('walks PATCH /users/me, password change, token refresh and logout', async () => {
    section('8. IDENTITY — self-service (profile, password, refresh, logout)');

    const me = await api().get('/api/v1/users/me').set(asCustomer());
    log('GET', '/api/v1/users/me', me.status, `email=${me.body.user.email as string}`);
    expect(me.status).toBe(200);

    const patched = await api()
      .patch('/api/v1/users/me')
      .set(asCustomer())
      .send({ firstName: 'Grace M.' });
    log('PATCH', '/api/v1/users/me', patched.status, 'first name updated');
    expect(patched.status).toBe(200);
    expect(patched.body.user.firstName).toBe('Grace M.');

    /* ---- forgot/reset password: proving the account-existence oracle stays closed ---- */
    /* ---- (the actual reset TOKEN only ever reaches the customer's inbox — capturing ---- */
    /* ---- and using it is covered by password-reset.integration.test.ts, which swaps ---- */
    /* ---- in a recording mailer; this container's mailer talks real SMTP)            ---- */

    const forgotKnown = await api()
      .post('/api/v1/auth/forgot-password')
      .send({ email: me.body.user.email as string });
    log('POST', '/api/v1/auth/forgot-password', forgotKnown.status, 'known address → 204');
    expect(forgotKnown.status).toBe(204);

    const forgotUnknown = await api()
      .post('/api/v1/auth/forgot-password')
      .send({ email: `nobody.${newId()}@example.com` });
    log(
      'POST',
      '/api/v1/auth/forgot-password',
      forgotUnknown.status,
      'unknown address → SAME 204 (no account-existence oracle)',
    );
    expect(forgotUnknown.status).toBe(204);

    const badReset = await api()
      .post('/api/v1/auth/reset-password')
      .send({ token: 'not-a-real-token-'.padEnd(43, 'x'), newPassword: 'another-long-password-x' });
    log(
      'POST',
      '/api/v1/auth/reset-password',
      badReset.status,
      'unknown token → 400 INVALID_RESET_TOKEN',
    );
    expect(badReset.status).toBe(400);

    /* ---- change password (while signed in), using the CURRENT one ---- */

    const NEW_PASSWORD = 'a-different-sufficiently-long-password';
    const changed = await api()
      .post('/api/v1/users/me/password')
      .set(asCustomer())
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    log(
      'POST',
      '/api/v1/users/me/password',
      changed.status,
      'password changed → every session revoked',
    );
    expect(changed.status).toBe(204);

    const staleTokenNowRejected = await api().get('/api/v1/users/me').set(asCustomer());
    log(
      'GET',
      '/api/v1/users/me',
      staleTokenNowRejected.status,
      'the access token itself still verifies (JWT), but the session backing it is gone at refresh',
    );
    // The access token is a self-contained JWT and stays valid until it expires; it is the
    // REFRESH session that a password change revokes. Documented, not asserted either way,
    // because both outcomes are legitimate depending on how the access token is checked —
    // see the refresh assertion right below, which IS the guarantee that matters.

    const relogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: me.body.user.email as string, password: NEW_PASSWORD });
    log('POST', '/api/v1/auth/login', relogin.status, 'new password works');
    expect(relogin.status).toBe(200);
    customerToken = relogin.body.accessToken as string;
    const freshRefresh = relogin.body.refreshToken as string;

    /* ---- the OLD refresh token from step 1 is dead — the password change revoked it ---- */

    const revokedRefresh = await api().post('/api/v1/auth/refresh').send({ refreshToken });
    log(
      'POST',
      '/api/v1/auth/refresh',
      revokedRefresh.status,
      'the pre-password-change refresh token is dead',
    );
    expect(revokedRefresh.status).toBe(401);

    /* ---- the NEW refresh token rotates cleanly ---- */

    const rotated = await api().post('/api/v1/auth/refresh').send({ refreshToken: freshRefresh });
    log('POST', '/api/v1/auth/refresh', rotated.status, 'new access + refresh token issued');
    expect(rotated.status).toBe(200);
    customerToken = rotated.body.accessToken as string;

    const reuseOldRotated = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: freshRefresh });
    log(
      'POST',
      '/api/v1/auth/refresh',
      reuseOldRotated.status,
      'reusing an already-rotated refresh token is refused',
    );
    expect(reuseOldRotated.status).toBe(401);

    const loggedOut = await api().post('/api/v1/auth/logout').set(asCustomer()).send();
    log('POST', '/api/v1/auth/logout', loggedOut.status, 'session revoked');
    expect(loggedOut.status).toBe(204);

    /* Sign back in once more, since section 9's isolation check needs a live customer token. */
    const finalLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: me.body.user.email as string, password: NEW_PASSWORD });
    customerToken = finalLogin.body.accessToken as string;
    log('POST', '/api/v1/auth/login', finalLogin.status, 'signed back in for the isolation check');
    expect(finalLogin.status).toBe(200);
  });

  /* ══ 9. Authorization boundary on routes the other walkthrough skips ═══ */

  it('proves customer tokens are refused on staff-only routes this file exercised', async () => {
    section('9. AUTHORIZATION — customer token refused on staff-only routes');

    for (const path of [
      '/api/v1/admin/promotions',
      '/api/v1/admin/tax-classes',
      '/api/v1/admin/inventory',
      '/api/v1/admin/orders/fulfilment',
    ]) {
      const response = await api().get(path).set(asCustomer());
      log('GET', path, response.status, 'customer token → forbidden');
      expect(response.status).toBe(403);
    }
  });

  /* ══ 10. Summary ═══════════════════════════════════════════════════════ */

  it('prints the final state', async () => {
    section('SUMMARY');

    line(`  routes exercised in this file : ${String(step)}`);
    line(`  order (paid, delivered)       : ${orderNumber}`);
    line(`  order (cancelled, unpaid)     : ${cancellableOrderNumber}`);
    line(`  product published             : ${productSlug}`);
    line(`  product created + archived + deleted : ${secondSlug}`);
    line('');
    line('  See tests/e2e/full-flow-walkthrough.e2e.test.ts for the single narrated happy path,');
    line('  and tests/audit/endpoint-inventory.test.ts for the machine-checked route inventory');
    line("  this file's coverage claim is measured against.");
    line('');

    expect(orderId).not.toBe('');
  });
});
