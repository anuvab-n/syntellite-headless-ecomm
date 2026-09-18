import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrPromoteAdmin } from '../../scripts/create-admin.ts';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { cart } from '../../src/db/schema/cart.js';
import { appUser } from '../../src/db/schema/identity.js';
import { invoice } from '../../src/db/schema/invoicing.js';
import { order } from '../../src/db/schema/orders.js';
import { payment } from '../../src/db/schema/payments.js';
import { store } from '../../src/db/schema/store.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * QA AUDIT HARNESS — the complete customer journey, recorded as a transcript.
 *
 * This file is an AUDIT ARTIFACT, not part of the product's own test suite. It exists to
 * execute the flow a production-minded reviewer asked to see, against the REAL composition
 * root (`buildContainer`), a REAL PostgreSQL and a REAL Redis from Testcontainers, driven over
 * HTTP by supertest. It modifies no production code and asserts only what the implementation
 * actually does — where the implementation's behaviour is the finding, the behaviour is
 * RECORDED rather than corrected.
 *
 * The one substitution is at the transport boundary: `globalThis.fetch`, so the Razorpay
 * adapter talks to a stub instead of the internet. The adapter, its real HMAC verification and
 * its persistence are untouched, and the webhook this file posts is signed with the real
 * algorithm — that signed-webhook path IS the application's supported sandbox mechanism
 * (`PAYMENT_SANDBOX_MODE`, `RAZORPAY_WEBHOOK_SECRET`), not a forged success.
 *
 * Every step narrates through `process.stdout.write` rather than `console.log`, matching the
 * project's existing walkthrough files: Vitest groups intercepted console output under the
 * test that produced it, which collapses to nothing once output is redirected to a file, and
 * the transcript is the deliverable here.
 */
describe('QA AUDIT — complete customer flow', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const providerRefs: string[] = [];
  const RUN = Date.now().toString(36);

  const RAZORPAY = {
    keyId: `rzp_test_audit_${RUN}`,
    keySecret: 'audit-api-secret-value',
    webhookSecret: 'audit-webhook-secret-value',
  };

  const PASSWORD = 'a-sufficiently-long-audit-password';
  const STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const HSN = '62011000';
  const GST_PERCENT = 5;
  const COUPON_PERCENT = 10;

  /* Catalogue built by the admin for this audit. */
  const SLUG = `audit-jacket-${RUN}`;
  const SKU = `AUDIT-${RUN}-M`;
  const UNIT_PRICE = '500.0000';
  const OPENING_STOCK = 10;
  const RACE_SLUG = `audit-lastunit-${RUN}`;
  const RACE_SKU = `AUDITLAST-${RUN}`;
  const RACE_PRICE = '300.0000';
  const DRAFT_SLUG = `audit-draft-${RUN}`;
  const COUPON = `AUD${RUN}`.toUpperCase();
  const MIN_COUPON = `AUDMIN${RUN}`.toUpperCase();
  const DEAD_COUPON = `AUDDEAD${RUN}`.toUpperCase();
  const TAX_CLASS = `AUDGST${RUN}`.toUpperCase();

  const A = { email: `audit.a.${RUN}@example.com`, id: '', token: '', refresh: '', address: '' };
  const B = { email: `audit.b.${RUN}@example.com`, id: '', token: '', address: '' };
  const STAFF = { email: `audit.staff.${RUN}@example.com`, id: '', token: '' };
  const FOREIGN = { email: `audit.foreign.${RUN}@example.com`, id: '', token: '', storeId: '' };

  const state = {
    storeId: '',
    codOrderNumber: '',
    onlineOrderNumber: '',
    shipmentId: '',
    invoiceNumber: '',
    payable: '',
    qty: 0,
    returnNumber: '',
    rejectedReturnNumber: '',
  };

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asA = () => ({ Authorization: `Bearer ${A.token}` });
  const asB = () => ({ Authorization: `Bearer ${B.token}` });
  const asStaff = () => ({ Authorization: `Bearer ${STAFF.token}` });

  const minor = (v: string): bigint => BigInt(v.replace('.', ''));
  const bodyAs = <T>(r: { body: unknown }): T => r.body as T;

  const sign = (body: string): string =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  /* ── Transcript ───────────────────────────────────────────────────────── */

  let step = 0;
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const section = (t: string): void => {
    line('');
    line(`═══════════ ${t} ═══════════`);
  };
  const log = (method: string, path: string, status: number, note: string): void => {
    step += 1;
    line(
      `${String(step).padStart(3, '0')}. ${method.padEnd(6)} ${path.padEnd(50)} → ${String(status).padEnd(3)}  ${note}`,
    );
  };
  const fact = (s: string): void => line(`     · ${s}`);
  const finding = (sev: string, s: string): void => line(`     ⚑ ${sev}: ${s}`);

  async function waitFor(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await assertion();
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  type Stock = { skuCode: string; onHand: number; reserved: number; available: number };
  async function stockOf(skuCode: string): Promise<Stock> {
    const r = await api().get('/api/v1/admin/inventory').set(asStaff()).query({ limit: 100 });
    expect(r.status).toBe(200);
    const row = bodyAs<{ inventory: Stock[] }>(r).inventory.find((s) => s.skuCode === skuCode);
    expect(row, `inventory row for ${skuCode}`).toBeDefined();
    return row!;
  }
  const showStock = (label: string, s: Stock): void =>
    fact(
      `${label}: onHand=${String(s.onHand)} reserved=${String(s.reserved)} available=${String(s.available)}`,
    );

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request in audit: ${url}`);
      }
      const ref = `order_AUDIT_${RUN}_${String(providerRefs.length + 1)}`;
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
          AUTH_RATE_LIMIT_IP_MAX: '4000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '4000',
          AUTH_RATE_LIMIT_REFRESH_IP_MAX: '4000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    state.storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    line('');
    line('╔══════════════════════════════════════════════════════════════════════╗');
    line('║  E-COMMERCE BACKEND — CUSTOMER FLOW AUDIT TRANSCRIPT                 ║');
    line('╚══════════════════════════════════════════════════════════════════════╝');
    line(`store: ${state.storeId}   run: ${RUN}`);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. HEALTH ═════════════════════════════════════════════════════════ */

  it('1. health', async () => {
    section('1. HEALTH');

    const bare = await api().get('/health');
    log('GET', '/health', bare.status, 'bare /health');
    if (bare.status === 404) {
      finding('INFO', '/health is not mounted; only /health/live and /health/ready exist');
    }

    const live = await api().get('/health/live');
    log('GET', '/health/live', live.status, 'liveness');
    expect(live.status).toBe(200);

    const ready = await api().get('/health/ready');
    log('GET', '/health/ready', ready.status, `DB+Redis: ${JSON.stringify(ready.body)}`);
    expect(ready.status).toBe(200);
  });

  /* ══ 2-3. REGISTRATION + AUTH ══════════════════════════════════════════ */

  it('2-3. registration and authentication (A, B, staff, foreign-store)', async () => {
    section('2. REGISTRATION');

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ email: A.email, password: PASSWORD, firstName: 'Asha', lastName: 'Rao' });
    log('POST', '/api/v1/auth/register', reg.status, `customer A ${A.email}`);
    expect(reg.status).toBe(201);
    A.id = reg.body.user.id as string;
    fact(`customer A id = ${A.id}`);
    expect(reg.body.user).not.toHaveProperty('passwordHash');
    expect(reg.body.user.isStaff).toBeUndefined();
    fact('response exposes no passwordHash / isStaff / isSuperuser');

    const dup = await api()
      .post('/api/v1/auth/register')
      .send({ email: A.email, password: PASSWORD });
    log('POST', '/api/v1/auth/register', dup.status, `duplicate → ${dup.body.error?.code ?? ''}`);
    expect(dup.status).toBe(409);

    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ email: B.email, password: PASSWORD, firstName: 'Biju', lastName: 'Nair' });
    log('POST', '/api/v1/auth/register', regB.status, `customer B ${B.email}`);
    expect(regB.status).toBe(201);
    B.id = regB.body.user.id as string;

    section('3. AUTHENTICATION');

    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: A.email, password: PASSWORD });
    log('POST', '/api/v1/auth/login', login.status, 'customer A signs in');
    expect(login.status).toBe(200);
    A.token = login.body.accessToken as string;
    A.refresh = login.body.refreshToken as string;
    expect(login.body.tokenType).toBe('Bearer');
    fact(`token type=Bearer expiresIn=${String(login.body.expiresIn)}s`);

    const loginB = await api()
      .post('/api/v1/auth/login')
      .send({ email: B.email, password: PASSWORD });
    expect(loginB.status).toBe(200);
    B.token = loginB.body.accessToken as string;
    log('POST', '/api/v1/auth/login', loginB.status, 'customer B signs in');

    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: A.email, password: 'not-the-password' });
    log('POST', '/api/v1/auth/login', wrong.status, 'wrong password');
    expect(wrong.status).toBe(401);

    const unknown = await api()
      .post('/api/v1/auth/login')
      .send({ email: `ghost.${RUN}@example.com`, password: PASSWORD });
    log('POST', '/api/v1/auth/login', unknown.status, 'unknown email (must match wrong-password)');
    expect(unknown.status).toBe(401);

    const noAuth = await api().get('/api/v1/users/me');
    log('GET', '/api/v1/users/me', noAuth.status, 'no Authorization header');
    expect(noAuth.status).toBe(401);

    const badScheme = await api().get('/api/v1/users/me').set({ Authorization: A.token });
    log('GET', '/api/v1/users/me', badScheme.status, 'token without Bearer scheme');
    expect(badScheme.status).toBe(401);

    const garbage = await api().get('/api/v1/users/me').set({ Authorization: 'Bearer not-a-jwt' });
    log('GET', '/api/v1/users/me', garbage.status, 'malformed JWT');
    expect(garbage.status).toBe(401);

    const tampered = await api()
      .get('/api/v1/users/me')
      .set({ Authorization: `Bearer ${A.token.split('.').slice(0, 2).join('.')}.AAAA` });
    log('GET', '/api/v1/users/me', tampered.status, 'tampered signature');
    expect(tampered.status).toBe(401);

    const ok = await api().get('/api/v1/users/me').set(asA());
    log('GET', '/api/v1/users/me', ok.status, 'authenticated read works');
    expect(ok.status).toBe(200);

    /* ── Staff, through the project's own admin mechanism ──────────────── */
    section('3b. STAFF ONBOARDING (pnpm admin:create path)');

    const created = await createOrPromoteAdmin(
      { db: db(), config: container.config, logger: silentLogger },
      {
        email: STAFF.email,
        password: PASSWORD,
        firstName: 'Ops',
        lastName: 'Lead',
        promote: false,
        help: false,
      },
    );
    STAFF.id = created.userId;
    log('SCRIPT', 'createOrPromoteAdmin()', 201, `staff ${STAFF.email}`);
    fact('no HTTP route grants isStaff — DECISIONS §22; script is the only path');

    const staffLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: STAFF.email, password: PASSWORD });
    log(
      'POST',
      '/api/v1/auth/login',
      staffLogin.status,
      'staff signs in via the SHARED login route',
    );
    expect(staffLogin.status).toBe(200);
    STAFF.token = staffLogin.body.accessToken as string;

    /* ── A user belonging to a DIFFERENT store, for tenancy checks ─────── */
    const foreignStoreId = newId();
    await db()
      .insert(store)
      .values({
        id: foreignStoreId,
        slug: `foreign-${RUN}`,
        name: 'Foreign Store',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        isActive: true,
      });
    FOREIGN.storeId = foreignStoreId;
    const foreignUser = await container.identity.registerCustomer({
      storeId: foreignStoreId,
      input: { email: FOREIGN.email, password: PASSWORD, firstName: 'Far', lastName: 'Away' },
    });
    FOREIGN.id = foreignUser.id;
    const foreignTokens = await container.identity.login({
      storeId: foreignStoreId,
      input: { email: FOREIGN.email, password: PASSWORD },
      userAgent: null,
      ipAddress: null,
    });
    FOREIGN.token = foreignTokens.accessToken;
    fact(`foreign store ${foreignStoreId} + user seeded for cross-tenant probes`);
  });

  /* ══ 4. PROFILE ════════════════════════════════════════════════════════ */

  it('4. customer profile', async () => {
    section('4. CUSTOMER PROFILE');

    const me = await api().get('/api/v1/users/me').set(asA());
    log('GET', '/api/v1/users/me', me.status, `${me.body.user.email as string}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(A.id);

    const patched = await api()
      .patch('/api/v1/users/me')
      .set(asA())
      .send({ firstName: 'Ashwini', lastName: 'Rao-Patel', acceptsMarketing: true });
    log('PATCH', '/api/v1/users/me', patched.status, 'firstName/lastName/acceptsMarketing');
    expect(patched.status).toBe(200);
    expect(patched.body.user).toMatchObject({
      firstName: 'Ashwini',
      lastName: 'Rao-Patel',
      acceptsMarketing: true,
    });

    const reread = await api().get('/api/v1/users/me').set(asA());
    expect(reread.body.user.firstName).toBe('Ashwini');
    log('GET', '/api/v1/users/me', reread.status, 'change persisted across requests');

    const empty = await api().patch('/api/v1/users/me').set(asA()).send({});
    log('PATCH', '/api/v1/users/me', empty.status, 'empty patch rejected');
    expect(empty.status).toBe(400);

    const unknownField = await api()
      .patch('/api/v1/users/me')
      .set(asA())
      .send({ firstName: 'X', isStaff: true });
    log(
      'PATCH',
      '/api/v1/users/me',
      unknownField.status,
      'unknown field isStaff rejected (strict)',
    );
    expect(unknownField.status).toBe(400);

    const stillCustomer = await db().select().from(appUser).where(eq(appUser.id, A.id));
    expect(stillCustomer[0]?.isStaff).toBe(false);
    fact('privilege escalation via body is impossible: app_user.is_staff still false');

    const badType = await api().patch('/api/v1/users/me').set(asA()).send({ firstName: 123 });
    log('PATCH', '/api/v1/users/me', badType.status, 'wrong type rejected');
    expect(badType.status).toBe(400);
  });

  /* ══ 5. CATALOGUE (admin builds, customer browses) ═════════════════════ */

  it('5. catalogue — admin builds, public browses', async () => {
    section('5a. ADMIN BUILDS CATALOGUE');

    const p = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: SLUG, name: 'Audit Jacket', description: 'Shell jacket', status: 'active' });
    log('POST', '/api/v1/admin/products', p.status, SLUG);
    expect(p.status).toBe(201);

    const sku = await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asStaff())
      .send({ code: SKU, name: 'Medium', price: UNIT_PRICE, isActive: true });
    log('POST', '/api/v1/admin/products/:slug/skus', sku.status, `${SKU} @ ${UNIT_PRICE}`);
    expect(sku.status).toBe(201);

    const opt = await api()
      .post(`/api/v1/admin/products/${SLUG}/options`)
      .set(asStaff())
      .send({ name: 'Size', sortOrder: 1 });
    expect(opt.status).toBe(201);
    const val = await api()
      .post(`/api/v1/admin/options/${opt.body.option.id as string}/values`)
      .set(asStaff())
      .send({ value: 'M', sortOrder: 1 });
    expect(val.status).toBe(201);
    const bound = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: [val.body.value.id as string] });
    log('PUT', '/api/v1/admin/skus/:code/options', bound.status, 'variant Size=M bound');
    expect(bound.status).toBe(200);

    const adj = await api().post('/api/v1/admin/inventory/adjustments').set(asStaff()).send({
      skuCode: SKU,
      delta: OPENING_STOCK,
      reason: 'manual_increase',
      note: 'audit opening',
    });
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      adj.status,
      `+${String(OPENING_STOCK)} units`,
    );
    expect(adj.status).toBe(201);
    expect(adj.body.inventory).toMatchObject({ onHand: OPENING_STOCK, reserved: 0 });

    /* GST */
    const prof = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
      legalName: 'Audit Retail Private Limited',
      gstin: SELLER_GSTIN,
      originLine1: '4th Floor, MG Road',
      originCity: 'Bengaluru',
      originState: STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log('PUT', '/api/v1/admin/store/tax-profile', prof.status, `seller GSTIN ${SELLER_GSTIN}`);
    expect(prof.status).toBe(200);

    const tc = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asStaff())
      .send({ code: TAX_CLASS, name: 'GST 5%', isActive: true });
    expect(tc.status).toBe(201);
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
    const cls = await api()
      .put(`/api/v1/admin/skus/${SKU}/tax`)
      .set(asStaff())
      .send({ taxClassCode: TAX_CLASS, hsnCode: HSN });
    log('PUT', '/api/v1/admin/skus/:code/tax', cls.status, `HSN ${HSN} / ${TAX_CLASS}`);
    expect(cls.status).toBe(200);

    /* Promotions */
    const promo = await api()
      .post('/api/v1/admin/promotions')
      .set(asStaff())
      .send({
        code: COUPON,
        name: 'Audit 10%',
        discountType: 'percentage',
        percentRate: String(COUPON_PERCENT),
        isActive: true,
      });
    log('POST', '/api/v1/admin/promotions', promo.status, `${COUPON} = ${String(COUPON_PERCENT)}%`);
    expect(promo.status).toBe(201);

    const minPromo = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: MIN_COUPON,
      name: 'Audit min-subtotal',
      discountType: 'fixed_amount',
      amount: '50.0000',
      minSubtotal: '999999.0000',
      isActive: true,
    });
    expect(minPromo.status).toBe(201);
    fact(`${MIN_COUPON} requires a subtotal this cart will never reach`);

    const deadPromo = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: DEAD_COUPON,
      name: 'Audit expired',
      discountType: 'percentage',
      percentRate: '50',
      startsAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2020-02-01T00:00:00.000Z',
      isActive: true,
    });
    expect(deadPromo.status).toBe(201);
    fact(`${DEAD_COUPON} expired in 2020`);

    /* Draft product — must stay invisible publicly */
    const draft = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: DRAFT_SLUG, name: 'Unfinished', status: 'draft' });
    expect(draft.status).toBe(201);

    /* Race SKU with exactly ONE unit, for the concurrency section */
    const rp = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: RACE_SLUG, name: 'Last Unit', status: 'active' });
    expect(rp.status).toBe(201);
    const rs = await api()
      .post(`/api/v1/admin/products/${RACE_SLUG}/skus`)
      .set(asStaff())
      .send({ code: RACE_SKU, name: 'One', price: RACE_PRICE });
    expect(rs.status).toBe(201);
    const ra = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: RACE_SKU, delta: 1, reason: 'manual_increase' });
    expect(ra.status).toBe(201);
    const rc = await api()
      .put(`/api/v1/admin/skus/${RACE_SKU}/tax`)
      .set(asStaff())
      .send({ taxClassCode: TAX_CLASS, hsnCode: HSN });
    expect(rc.status).toBe(200);
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      ra.status,
      `${RACE_SKU} stocked with exactly 1`,
    );

    section('5b. PUBLIC BROWSE');

    const list = await api().get('/api/v1/products').query({ limit: 50 });
    log('GET', '/api/v1/products', list.status, `${String(list.body.products.length)} product(s)`);
    expect(list.status).toBe(200);
    type P = {
      slug: string;
      currency: string;
      skus: {
        code: string;
        price: string;
        isActive: boolean;
        options: { optionName: string; value: string }[];
      }[];
    };
    const found = bodyAs<{ products: P[] }>(list).products.find((x) => x.slug === SLUG);
    expect(found, 'published product must be listed').toBeDefined();
    expect(found!.skus.find((s) => s.code === SKU)!.price).toBe(UNIT_PRICE);
    fact(`price surfaced as decimal string "${UNIT_PRICE}", currency ${found!.currency}`);
    expect(bodyAs<{ products: P[] }>(list).products.some((x) => x.slug === DRAFT_SLUG)).toBe(false);
    fact('draft product absent from the public listing');

    const search = await api().get('/api/v1/products').query({ q: 'Audit Jacket' });
    log(
      'GET',
      '/api/v1/products?q=',
      search.status,
      `${String(search.body.products.length)} hit(s)`,
    );
    expect(search.status).toBe(200);
    expect(bodyAs<{ products: P[] }>(search).products.some((x) => x.slug === SLUG)).toBe(true);

    const miss = await api()
      .get('/api/v1/products')
      .query({ q: `zzz-${RUN}` });
    log('GET', '/api/v1/products?q=', miss.status, 'no match → empty page, not an error');
    expect(miss.status).toBe(200);
    expect(miss.body.products).toHaveLength(0);

    const paged = await api().get('/api/v1/products').query({ limit: 1, offset: 0 });
    log(
      'GET',
      '/api/v1/products?limit=1',
      paged.status,
      `pagination ${JSON.stringify(paged.body.pagination)}`,
    );
    expect(paged.status).toBe(200);
    expect(paged.body.products).toHaveLength(1);

    const overLimit = await api().get('/api/v1/products').query({ limit: 10_000 });
    log(
      'GET',
      '/api/v1/products?limit=10000',
      overLimit.status,
      'over-max limit rejected, not clamped',
    );
    expect(overLimit.status).toBe(400);

    const band = await api()
      .get('/api/v1/products')
      .query({ price_min: '100.0000', price_max: UNIT_PRICE });
    log(
      'GET',
      '/api/v1/products?price_min&max',
      band.status,
      'inclusive upper bound includes exact price',
    );
    expect(bodyAs<{ products: P[] }>(band).products.some((x) => x.slug === SLUG)).toBe(true);

    const reversed = await api()
      .get('/api/v1/products')
      .query({ price_min: '900.0000', price_max: '100.0000' });
    log('GET', '/api/v1/products (reversed band)', reversed.status, 'reversed range → 400');
    expect(reversed.status).toBe(400);

    const detail = await api().get(`/api/v1/products/${SLUG}`);
    log('GET', '/api/v1/products/:slug', detail.status, 'detail with SKUs + variant');
    expect(detail.status).toBe(200);
    const opts = bodyAs<{ product: P }>(detail).product.skus.find((s) => s.code === SKU)!.options;
    expect(opts.map((o) => o.optionName)).toContain('Size');
    fact(`variant exposed: ${opts.map((o) => `${o.optionName}=${o.value}`).join(', ')}`);

    const draftRead = await api().get(`/api/v1/products/${DRAFT_SLUG}`);
    log('GET', '/api/v1/products/:slug', draftRead.status, 'draft product → 404 publicly');
    expect(draftRead.status).toBe(404);

    const adminDraft = await api().get(`/api/v1/admin/products/${DRAFT_SLUG}`).set(asStaff());
    log('GET', '/api/v1/admin/products/:slug', adminDraft.status, 'admin can still see own draft');
    expect(adminDraft.status).toBe(200);

    const nosuch = await api().get(`/api/v1/products/no-such-${RUN}`);
    log('GET', '/api/v1/products/:slug', nosuch.status, 'unknown slug → 404');
    expect(nosuch.status).toBe(404);
  });

  /* ══ 6. ADDRESSES ══════════════════════════════════════════════════════ */

  it('6. addresses', async () => {
    section('6. ADDRESSES');

    const created = await api().post('/api/v1/users/me/addresses').set(asA()).send({
      label: 'Home',
      recipientName: 'Ashwini Rao-Patel',
      phone: '+91 9876500011',
      line1: '18 Residency Road',
      city: 'Bengaluru',
      state: STATE,
      postalCode: '560025',
      countryCode: 'IN',
    });
    log('POST', '/api/v1/users/me/addresses', created.status, 'customer A address');
    expect(created.status).toBe(201);
    A.address = created.body.address.id as string;
    fact(`address A id = ${A.address}`);

    const listed = await api().get('/api/v1/users/me/addresses').set(asA());
    log(
      'GET',
      '/api/v1/users/me/addresses',
      listed.status,
      `${String(listed.body.addresses.length)} address(es)`,
    );
    expect(listed.status).toBe(200);

    const read = await api().get(`/api/v1/users/me/addresses/${A.address}`).set(asA());
    log('GET', '/api/v1/users/me/addresses/:id', read.status, 'read own address');
    expect(read.status).toBe(200);

    const patched = await api()
      .patch(`/api/v1/users/me/addresses/${A.address}`)
      .set(asA())
      .send({ label: 'Home (updated)' });
    log('PATCH', '/api/v1/users/me/addresses/:id', patched.status, 'label updated');
    expect(patched.status).toBe(200);
    expect(patched.body.address.label).toBe('Home (updated)');

    const throwaway = await api().post('/api/v1/users/me/addresses').set(asA()).send({
      label: 'Office',
      recipientName: 'Ashwini Rao-Patel',
      phone: '+91 9876500012',
      line1: '90 Church Street',
      city: 'Bengaluru',
      state: STATE,
      postalCode: '560001',
    });
    expect(throwaway.status).toBe(201);
    const gone = await api()
      .delete(`/api/v1/users/me/addresses/${throwaway.body.address.id as string}`)
      .set(asA());
    log('DELETE', '/api/v1/users/me/addresses/:id', gone.status, 'soft-deleted');
    expect(gone.status).toBe(204);
    const afterDelete = await api()
      .get(`/api/v1/users/me/addresses/${throwaway.body.address.id as string}`)
      .set(asA());
    log('GET', '/api/v1/users/me/addresses/:id', afterDelete.status, 'deleted address → 404');
    expect(afterDelete.status).toBe(404);

    const bAddr = await api().post('/api/v1/users/me/addresses').set(asB()).send({
      label: 'B Home',
      recipientName: 'Biju Nair',
      phone: '+91 9876500022',
      line1: '5 Brigade Road',
      city: 'Bengaluru',
      state: STATE,
      postalCode: '560001',
    });
    expect(bAddr.status).toBe(201);
    B.address = bAddr.body.address.id as string;

    const idor = await api().get(`/api/v1/users/me/addresses/${A.address}`).set(asB());
    log(
      'GET',
      '/api/v1/users/me/addresses/:id',
      idor.status,
      "B reading A's address → 404 (IDOR blocked)",
    );
    expect(idor.status).toBe(404);

    const badPin = await api().post('/api/v1/users/me/addresses').set(asA()).send({
      label: 'Bad',
      recipientName: 'X',
      phone: '+91 9876500011',
      line1: '1 Nowhere',
      city: 'Bengaluru',
      state: STATE,
      postalCode: 'ABC',
      countryCode: 'IN',
    });
    log('POST', '/api/v1/users/me/addresses', badPin.status, 'malformed Indian PIN → 400');
    expect(badPin.status).toBe(400);

    const anon = await api().get('/api/v1/users/me/addresses');
    log('GET', '/api/v1/users/me/addresses', anon.status, 'unauthenticated → 401');
    expect(anon.status).toBe(401);
  });

  /* ══ 7-8. CART + PROMOTION ═════════════════════════════════════════════ */

  it('7-8. cart and promotion', async () => {
    section('7. CART');

    const empty = await api().get('/api/v1/users/me/cart').set(asA());
    log('GET', '/api/v1/users/me/cart', empty.status, 'active cart auto-created, empty');
    expect(empty.status).toBe(200);
    expect(empty.body.cart.items).toHaveLength(0);
    expect(empty.body.cart.status).toBe('active');

    const add = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 2 });
    log('PUT', '/api/v1/users/me/cart/items/:sku', add.status, '2 units added');
    expect(add.status).toBe(200);
    type Cart = {
      id: string;
      items: { skuCode: string; quantity: number; unitPrice: string; lineTotal: string }[];
      itemCount: number;
      subtotal: string;
      discountTotal: string;
      cartTotal: string;
      promotion: { code: string } | null;
    };
    let c = bodyAs<{ cart: Cart }>(add).cart;
    expect(minor(c.items[0]!.lineTotal)).toBe(minor(UNIT_PRICE) * 2n);
    fact(`line total = ${c.items[0]!.lineTotal} = ${UNIT_PRICE} × 2`);

    const setQty = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 3 });
    log('PUT', '/api/v1/users/me/cart/items/:sku', setQty.status, 'PUT is SET (→3), not increment');
    c = bodyAs<{ cart: Cart }>(setQty).cart;
    expect(c.items).toHaveLength(1);
    expect(c.items[0]!.quantity).toBe(3);
    expect(minor(c.subtotal)).toBe(minor(UNIT_PRICE) * 3n);
    state.qty = 3;

    const removed = await api().delete(`/api/v1/users/me/cart/items/${SKU}`).set(asA());
    log(
      'DELETE',
      '/api/v1/users/me/cart/items/:sku',
      removed.status,
      'line removed (204, no body)',
    );
    expect(removed.status).toBe(204);
    const afterRemove = await api().get('/api/v1/users/me/cart').set(asA());
    expect(afterRemove.body.cart.items).toHaveLength(0);

    const readd = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: state.qty });
    log('PUT', '/api/v1/users/me/cart/items/:sku', readd.status, 're-added 3 units');
    expect(readd.status).toBe(200);

    const persisted = await api().get('/api/v1/users/me/cart').set(asA());
    log('GET', '/api/v1/users/me/cart', persisted.status, 'cart persists across requests');
    expect(bodyAs<{ cart: Cart }>(persisted).cart.items[0]!.quantity).toBe(3);

    /* cart negatives */
    for (const [q, label] of [
      [0, 'quantity 0'],
      [-2, 'negative quantity'],
      [1.5, 'fractional quantity'],
    ] as const) {
      const r = await api()
        .put(`/api/v1/users/me/cart/items/${SKU}`)
        .set(asA())
        .send({ quantity: q });
      log('PUT', '/api/v1/users/me/cart/items/:sku', r.status, `${label} → 400`);
      expect(r.status).toBe(400);
    }
    const hugeQty = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 100_000 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      hugeQty.status,
      'quantity above MAX_CART_LINE_QUANTITY → 400',
    );
    expect(hugeQty.status).toBe(400);

    const priceInjection = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 1, unitPrice: '0.0100' });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      priceInjection.status,
      'client-supplied price rejected (strict body)',
    );
    expect(priceInjection.status).toBe(400);

    const unknownSku = await api()
      .put(`/api/v1/users/me/cart/items/NOPE-${RUN}`)
      .set(asA())
      .send({ quantity: 1 });
    log('PUT', '/api/v1/users/me/cart/items/:sku', unknownSku.status, 'unknown SKU → 404');
    expect(unknownSku.status).toBe(404);

    const draftSkuAdd = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: state.qty });
    expect(draftSkuAdd.status).toBe(200);

    const cartAnon = await api().get('/api/v1/users/me/cart');
    log('GET', '/api/v1/users/me/cart', cartAnon.status, 'unauthenticated cart → 401');
    expect(cartAnon.status).toBe(401);

    const bCart = await api().get('/api/v1/users/me/cart').set(asB());
    log('GET', '/api/v1/users/me/cart', bCart.status, "B's cart is B's own, empty");
    expect(bodyAs<{ cart: Cart }>(bCart).cart.items).toHaveLength(0);
    expect(bodyAs<{ cart: Cart }>(bCart).cart.id).not.toBe(c.id);
    fact('cart is addressed only as /users/me/cart — no cart id in any route to tamper with');

    section('8. PROMOTION');

    const applied = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asA())
      .send({ code: COUPON });
    log('PUT', '/api/v1/users/me/cart/promotion', applied.status, `${COUPON} applied`);
    expect(applied.status).toBe(200);
    c = bodyAs<{ cart: Cart }>(applied).cart;
    expect(c.promotion).toMatchObject({ code: COUPON });
    expect(minor(c.discountTotal)).toBe((minor(c.subtotal) * BigInt(COUPON_PERCENT)) / 100n);
    expect(minor(c.cartTotal)).toBe(minor(c.subtotal) - minor(c.discountTotal));
    fact(`subtotal=${c.subtotal} discount=${c.discountTotal} cartTotal=${c.cartTotal}`);
    expect(c.items[0]!.quantity).toBe(3);
    expect(c.items[0]!.unitPrice).toBe(UNIT_PRICE);
    fact('line quantity and unit price uncorrupted by the discount');

    const removedPromo = await api().delete('/api/v1/users/me/cart/promotion').set(asA());
    log('DELETE', '/api/v1/users/me/cart/promotion', removedPromo.status, 'coupon removed (204)');
    expect(removedPromo.status).toBe(204);
    const bare = await api().get('/api/v1/users/me/cart').set(asA());
    expect(bodyAs<{ cart: Cart }>(bare).cart.promotion).toBeNull();
    expect(minor(bodyAs<{ cart: Cart }>(bare).cart.discountTotal)).toBe(0n);

    const unknownCoupon = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asA())
      .send({ code: `NOSUCH${RUN}`.toUpperCase() });
    log('PUT', '/api/v1/users/me/cart/promotion', unknownCoupon.status, 'unknown coupon → 404');
    expect(unknownCoupon.status).toBe(404);

    const expired = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asA())
      .send({ code: DEAD_COUPON });
    log(
      'PUT',
      '/api/v1/users/me/cart/promotion',
      expired.status,
      `expired ${DEAD_COUPON} → ${expired.body.error?.code ?? ''}`,
    );
    expect(expired.status).toBe(404);

    const belowMin = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asA())
      .send({ code: MIN_COUPON });
    log(
      'PUT',
      '/api/v1/users/me/cart/promotion',
      belowMin.status,
      `below minSubtotal → ${belowMin.body.error?.code ?? ''}`,
    );
    expect(belowMin.status).toBe(422);
    expect(belowMin.body.error.code).toBe('PROMOTION_MINIMUM_SUBTOTAL');

    const reapplied = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asA())
      .send({ code: COUPON });
    log(
      'PUT',
      '/api/v1/users/me/cart/promotion',
      reapplied.status,
      'valid coupon re-applied for checkout',
    );
    expect(reapplied.status).toBe(200);
  });

  /* ══ 9. CHECKOUT ═══════════════════════════════════════════════════════ */

  it('9. checkout', async () => {
    section('9. CHECKOUT');

    const before = await stockOf(SKU);
    showStock('inventory BEFORE checkout', before);

    const noKey = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .send({ addressId: A.address });
    log('POST', '/api/v1/users/me/checkout', noKey.status, 'missing Idempotency-Key → 400');
    expect(noKey.status).toBe(400);

    const foreignAddr = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', `aud-foreign-addr-${RUN}`)
      .send({ addressId: B.address });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      foreignAddr.status,
      "checkout against B's address → 404",
    );
    expect(foreignAddr.status).toBe(404);

    const KEY = `aud-checkout-${RUN}`;
    const co = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', KEY)
      .send({ addressId: A.address });
    log('POST', '/api/v1/users/me/checkout', co.status, 'order placed');
    expect(co.status).toBe(201);

    type Order = {
      orderNumber: string;
      status: string;
      subtotal: string;
      discountTotal: string;
      total: string;
      taxTotal: string;
      grandTotal: string;
      promotion: { code: string } | null;
      shippingAddress: { city: string; state: string };
      tax: { supplyType: string; sellerGstin: string } | null;
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
    const o = bodyAs<{ order: Order }>(co).order;
    state.codOrderNumber = o.orderNumber;
    state.payable = o.grandTotal;

    fact(`order number = ${o.orderNumber} (format ORD-YYYYMMDD-XXXXXX)`);
    expect(o.orderNumber).toMatch(/^ORD-\d{8}-[A-Z2-9]{6}$/u);
    expect(o.status).toBe('placed');

    const li = o.items[0]!;
    fact(
      `line snapshot: sku=${li.skuCode} skuName="${li.skuName}" product="${li.productName}" qty=${String(li.quantity)} unit=${li.unitPrice}`,
    );
    expect(li.skuCode).toBe(SKU);
    expect(li.quantity).toBe(state.qty);
    expect(li.unitPrice).toBe(UNIT_PRICE);
    expect(minor(li.lineTotal)).toBe(minor(UNIT_PRICE) * BigInt(state.qty));

    fact(
      `money: subtotal=${o.subtotal} discount=${o.discountTotal} total=${o.total} tax=${o.taxTotal} grand=${o.grandTotal}`,
    );
    expect(minor(o.subtotal)).toBe(minor(li.lineTotal));
    expect(minor(o.discountTotal)).toBe(minor(li.discountAmount));
    expect(minor(o.discountTotal)).toBe((minor(o.subtotal) * BigInt(COUPON_PERCENT)) / 100n);
    expect(minor(o.total)).toBe(minor(o.subtotal) - minor(o.discountTotal));
    expect(minor(o.grandTotal)).toBe(minor(o.total) + minor(o.taxTotal));
    expect(minor(o.taxTotal)).toBe((minor(o.total) * BigInt(GST_PERCENT)) / 100n);

    expect(o.tax).toMatchObject({ supplyType: 'intra_state', sellerGstin: SELLER_GSTIN });
    expect(li.tax!.hsnCode).toBe(HSN);
    expect(minor(li.tax!.cgstAmount) + minor(li.tax!.sgstAmount)).toBe(minor(o.taxTotal));
    expect(minor(li.tax!.igstAmount)).toBe(0n);
    fact(
      `GST intra-state: CGST ${li.tax!.cgstAmount} + SGST ${li.tax!.sgstAmount}, IGST ${li.tax!.igstAmount}`,
    );

    const carts = await db().select().from(cart).where(eq(cart.userId, A.id));
    expect(carts.some((x) => x.status === 'checked_out')).toBe(true);
    fact('cart transitioned to checked_out; a fresh active cart is issued');
    const liveCart = await api().get('/api/v1/users/me/cart').set(asA());
    expect(liveCart.body.cart.items).toHaveLength(0);
    expect(liveCart.body.cart.promotion).toBeNull();

    await waitFor(async () => {
      const after = await stockOf(SKU);
      expect(after.reserved).toBe(before.reserved + state.qty);
      expect(after.onHand).toBe(before.onHand);
    });
    const afterCo = await stockOf(SKU);
    showStock('inventory AFTER checkout', afterCo);
    fact('reservation taken; on-hand untouched — goods still in the warehouse');

    /* Idempotency */
    const replay = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', KEY)
      .send({ addressId: A.address });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      replay.status,
      'SAME key + SAME body → replays original',
    );
    expect(replay.status).toBe(201);
    expect(bodyAs<{ order: Order }>(replay).order.orderNumber).toBe(state.codOrderNumber);
    const orders = await db().select().from(order).where(eq(order.storeId, state.storeId));
    expect(orders).toHaveLength(1);
    fact(`exactly ${String(orders.length)} order row in the store — no duplicate created`);

    const mismatched = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', KEY)
      .send({ addressId: A.address, unexpected: true });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      mismatched.status,
      'same key + DIFFERENT body → rejected',
    );
    expect([400, 422]).toContain(mismatched.status);

    const emptyCart = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', `aud-empty-${RUN}`)
      .send({ addressId: A.address });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      emptyCart.status,
      `empty cart → ${emptyCart.body.error?.code ?? ''}`,
    );
    expect(emptyCart.status).toBe(422);
    expect(emptyCart.body.error.code).toBe('CHECKOUT_CART_EMPTY');
  });

  /* ══ 10. ORDER ═════════════════════════════════════════════════════════ */

  it('10. order retrieval and ownership', async () => {
    section('10. ORDER');

    const read = await api().get(`/api/v1/users/me/orders/${state.codOrderNumber}`).set(asA());
    log(
      'GET',
      '/api/v1/users/me/orders/:n',
      read.status,
      `status=${read.body.order.status as string}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.order.status).toBe('placed');

    const list = await api().get('/api/v1/users/me/orders').set(asA());
    log(
      'GET',
      '/api/v1/users/me/orders',
      list.status,
      `${String(list.body.orders.length)} order(s) for A`,
    );
    expect(list.status).toBe(200);
    expect(
      (list.body.orders as { orderNumber: string }[]).some(
        (x) => x.orderNumber === state.codOrderNumber,
      ),
    ).toBe(true);

    const bRead = await api().get(`/api/v1/users/me/orders/${state.codOrderNumber}`).set(asB());
    log('GET', '/api/v1/users/me/orders/:n', bRead.status, "B reading A's order → 404 (not 403)");
    expect(bRead.status).toBe(404);
    fact('404 rather than 403: a 403 would confirm the order number exists');

    const bList = await api().get('/api/v1/users/me/orders').set(asB());
    expect(bList.body.orders).toHaveLength(0);
    log('GET', '/api/v1/users/me/orders', bList.status, "B's own history is empty");

    const malformed = await api().get('/api/v1/users/me/orders/NOT-AN-ORDER').set(asA());
    log('GET', '/api/v1/users/me/orders/:n', malformed.status, 'malformed order number → 400');
    expect(malformed.status).toBe(400);

    const unknown = await api().get('/api/v1/users/me/orders/ORD-20200101-ABCDEF').set(asA());
    log('GET', '/api/v1/users/me/orders/:n', unknown.status, 'well-formed unknown → 404');
    expect(unknown.status).toBe(404);

    const anon = await api().get(`/api/v1/users/me/orders/${state.codOrderNumber}`);
    log('GET', '/api/v1/users/me/orders/:n', anon.status, 'unauthenticated → 401');
    expect(anon.status).toBe(401);
  });

  /* ══ 11. PAYMENT ═══════════════════════════════════════════════════════ */

  it('11. payment — COD path and online/sandbox path', async () => {
    section('11a. PAYMENT (COD)');

    const badMethod = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', `aud-badmethod-${RUN}`)
      .send({ method: 'bitcoin' });
    log('POST', '/api/v1/.../payments', badMethod.status, 'unsupported method → 400');
    expect(badMethod.status).toBe(400);

    const amountInjection = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', `aud-amt-${RUN}`)
      .send({ method: 'cod', amount: '1.0000' });
    log('POST', '/api/v1/.../payments', amountInjection.status, 'client-supplied amount rejected');
    expect(amountInjection.status).toBe(400);

    const foreignPay = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asB())
      .set('idempotency-key', `aud-foreignpay-${RUN}`)
      .send({ method: 'cod' });
    log('POST', '/api/v1/.../payments', foreignPay.status, "B paying A's order → 404");
    expect(foreignPay.status).toBe(404);

    const PAYKEY = `aud-pay-${RUN}`;
    const pay = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', PAYKEY)
      .send({ method: 'cod' });
    log('POST', '/api/v1/.../payments', pay.status, 'COD payment initiated');
    expect(pay.status).toBe(201);
    type Pay = {
      orderNumber: string;
      method: string;
      provider: string | null;
      status: string;
      amount: string;
      history: { fromStatus: string | null; toStatus: string }[];
    };
    const p = bodyAs<{ payment: Pay; handoff?: unknown }>(pay);
    fact(`method=${p.payment.method} status=${p.payment.status} amount=${p.payment.amount}`);
    expect(p.payment.status).toBe('pending');
    expect(minor(p.payment.amount)).toBe(minor(state.payable));
    fact('amount equals the order grandTotal computed server-side');
    expect(p.handoff).toBeUndefined();
    fact('COD produced NO provider handoff — the gateway was never contacted');

    const dup = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', `${PAYKEY}-different`)
      .send({ method: 'online' });
    log(
      'POST',
      '/api/v1/.../payments',
      dup.status,
      `second payment, new key → ${dup.body.error?.code ?? ''}`,
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('PAYMENT_ALREADY_EXISTS');

    const payReplay = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', PAYKEY)
      .send({ method: 'cod' });
    log('POST', '/api/v1/.../payments', payReplay.status, 'same key replay → original payment');
    expect(payReplay.status).toBe(201);
    const payRows = await db().select().from(payment).where(eq(payment.storeId, state.storeId));
    expect(payRows).toHaveLength(1);
    fact(`exactly ${String(payRows.length)} payment row — no duplicate`);

    const readPay = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/payment`)
      .set(asA());
    log(
      'GET',
      '/api/v1/.../payment',
      readPay.status,
      `history=${JSON.stringify(bodyAs<{ payment: Pay }>(readPay).payment.history.map((h) => [h.fromStatus, h.toStatus]))}`,
    );
    expect(readPay.status).toBe(200);

    const bPay = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/payment`)
      .set(asB());
    log('GET', '/api/v1/.../payment', bPay.status, "B reading A's payment → 404");
    expect(bPay.status).toBe(404);

    const payAnon = await api().get(`/api/v1/users/me/orders/${state.codOrderNumber}/payment`);
    log('GET', '/api/v1/.../payment', payAnon.status, 'unauthenticated → 401');
    expect(payAnon.status).toBe(401);

    section('11b. PAYMENT (ONLINE — application sandbox: signed webhook)');

    /* A second, independent order so the online path is exercised without disturbing order #1. */
    const add = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 1 });
    expect(add.status).toBe(200);
    const co2 = await api()
      .post('/api/v1/users/me/checkout')
      .set(asA())
      .set('idempotency-key', `aud-checkout2-${RUN}`)
      .send({ addressId: A.address });
    expect(co2.status).toBe(201);
    state.onlineOrderNumber = co2.body.order.orderNumber as string;
    const online2Total = co2.body.order.grandTotal as string;
    log('POST', '/api/v1/users/me/checkout', co2.status, `order #2 ${state.onlineOrderNumber}`);

    const init = await api()
      .post(`/api/v1/users/me/orders/${state.onlineOrderNumber}/payments`)
      .set(asA())
      .set('idempotency-key', `aud-pay-online-${RUN}`)
      .send({ method: 'online' });
    log('POST', '/api/v1/.../payments', init.status, 'online payment initiated');
    expect(init.status).toBe(201);
    const handoff = bodyAs<{
      handoff: { provider: string; providerRef: string; publicKey: string };
    }>(init).handoff;
    fact(
      `handoff provider=${handoff.provider} ref=${handoff.providerRef} publicKey=${handoff.publicKey}`,
    );
    expect(handoff.publicKey).toBe(RAZORPAY.keyId);
    expect(JSON.stringify(init.body)).not.toContain(RAZORPAY.keySecret);
    fact('publishable key returned; API SECRET never appears in the response');
    expect(minor(bodyAs<{ payment: Pay }>(init).payment.amount)).toBe(minor(online2Total));

    const forged = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_forged', order_id: handoff.providerRef } } },
    });
    const badSig = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef')
      .set('x-razorpay-event-id', `evt-forged-${RUN}`)
      .send(forged);
    log(
      'POST',
      '/api/v1/webhooks/razorpay',
      badSig.status,
      'INVALID signature → 401, nothing changes',
    );
    expect(badSig.status).toBe(401);
    const stillPending = await api()
      .get(`/api/v1/users/me/orders/${state.onlineOrderNumber}/payment`)
      .set(asA());
    expect(bodyAs<{ payment: Pay }>(stillPending).payment.status).toBe('pending');

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_aud_${RUN}`, order_id: handoff.providerRef } } },
    });
    const hook = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt-capture-${RUN}`)
      .send(body);
    log(
      'POST',
      '/api/v1/webhooks/razorpay',
      hook.status,
      `VALID HMAC → ${JSON.stringify(hook.body)}`,
    );
    expect(hook.status).toBe(200);

    await waitFor(async () => {
      const r = await api()
        .get(`/api/v1/users/me/orders/${state.onlineOrderNumber}/payment`)
        .set(asA());
      expect(bodyAs<{ payment: Pay }>(r).payment.status).toBe('succeeded');
    });
    log('GET', '/api/v1/.../payment', 200, 'payment status → succeeded');

    const redeliver = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt-capture-redeliver-${RUN}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', redeliver.status, 'redelivery is a safe no-op');
    expect(redeliver.status).toBe(200);
    const hist = await api()
      .get(`/api/v1/users/me/orders/${state.onlineOrderNumber}/payment`)
      .set(asA());
    expect(
      bodyAs<{ payment: Pay }>(hist).payment.history.filter((h) => h.toStatus === 'succeeded'),
    ).toHaveLength(1);
    fact('exactly one pending→succeeded transition despite two deliveries');

    const lateFail = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: `pay_aud_${RUN}`, order_id: handoff.providerRef } } },
    });
    const late = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(lateFail))
      .set('x-razorpay-event-id', `evt-late-${RUN}`)
      .send(lateFail);
    log('POST', '/api/v1/webhooks/razorpay', late.status, 'out-of-order failure after capture');
    const afterLate = await api()
      .get(`/api/v1/users/me/orders/${state.onlineOrderNumber}/payment`)
      .set(asA());
    expect(bodyAs<{ payment: Pay }>(afterLate).payment.status).toBe('succeeded');
    fact('succeeded is terminal — a late failure cannot corrupt it');

    const cancelPaid = await api()
      .post(`/api/v1/users/me/orders/${state.onlineOrderNumber}/cancel`)
      .set(asA())
      .send({});
    log(
      'POST',
      '/api/v1/.../cancel',
      cancelPaid.status,
      `paid order cancel → ${cancelPaid.body.error?.details?.reason ?? ''}`,
    );
    expect(cancelPaid.status).toBe(409);
    finding('INFO', 'paid orders cannot be cancelled because refunds are not implemented');
  });

  /* ══ 12. FULFILMENT ════════════════════════════════════════════════════ */

  it('12. fulfilment', async () => {
    section('12. FULFILMENT');

    const custQueue = await api().get('/api/v1/admin/orders/fulfilment').set(asA());
    log('GET', '/api/v1/admin/orders/fulfilment', custQueue.status, 'CUSTOMER token → 403');
    expect(custQueue.status).toBe(403);

    const anonQueue = await api().get('/api/v1/admin/orders/fulfilment');
    log('GET', '/api/v1/admin/orders/fulfilment', anonQueue.status, 'unauthenticated → 401');
    expect(anonQueue.status).toBe(401);

    const queue = await api()
      .get('/api/v1/admin/orders/fulfilment')
      .set(asStaff())
      .query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/orders/fulfilment',
      queue.status,
      `${String(queue.body.orders.length)} order(s) awaiting`,
    );
    expect(queue.status).toBe(200);
    expect(
      (queue.body.orders as { orderNumber: string }[]).some(
        (x) => x.orderNumber === state.codOrderNumber,
      ),
    ).toBe(true);

    const noShip = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/shipments`)
      .set(asA());
    log('GET', '/api/v1/.../shipments', noShip.status, 'no shipment yet');
    expect(noShip.body.shipments).toHaveLength(0);

    const custCreate = await api()
      .post(`/api/v1/admin/orders/${state.codOrderNumber}/shipments`)
      .set(asA())
      .send({ carrier: 'Self' });
    log(
      'POST',
      '/api/v1/admin/orders/:n/shipments',
      custCreate.status,
      'CUSTOMER creating shipment → 403',
    );
    expect(custCreate.status).toBe(403);

    const ship = await api()
      .post(`/api/v1/admin/orders/${state.codOrderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart', trackingNumber: `BD${RUN}` });
    log('POST', '/api/v1/admin/orders/:n/shipments', ship.status, 'shipment created (pending)');
    expect(ship.status).toBe(201);
    state.shipmentId = ship.body.shipment.id as string;
    fact(`shipment id = ${state.shipmentId}`);

    const dupShip = await api()
      .post(`/api/v1/admin/orders/${state.codOrderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart' });
    log(
      'POST',
      '/api/v1/admin/orders/:n/shipments',
      dupShip.status,
      `duplicate → ${dupShip.body.error?.code ?? ''}`,
    );
    expect(dupShip.status).toBe(409);

    const beforeShip = await stockOf(SKU);
    showStock('inventory BEFORE ship', beforeShip);

    const shipped = await api()
      .post(`/api/v1/admin/shipments/${state.shipmentId}/ship`)
      .set(asStaff())
      .send({ note: 'handed to courier' });
    log('POST', '/api/v1/admin/shipments/:id/ship', shipped.status, 'SHIPPED — stock moves here');
    expect(shipped.status).toBe(200);
    expect(shipped.body.shipment.status).toBe('shipped');

    await waitFor(async () => {
      const s = await stockOf(SKU);
      expect(s.onHand).toBe(beforeShip.onHand - state.qty);
      expect(s.reserved).toBe(beforeShip.reserved - state.qty);
    });
    const afterShip = await stockOf(SKU);
    showStock('inventory AFTER ship', afterShip);
    fact(
      `reservation consumed: onHand ${String(beforeShip.onHand)}→${String(afterShip.onHand)}, reserved ${String(beforeShip.reserved)}→${String(afterShip.reserved)}`,
    );

    const ledger = await api()
      .get(`/api/v1/admin/inventory/${SKU}/history`)
      .set(asStaff())
      .query({ limit: 20 });
    log(
      'GET',
      '/api/v1/admin/inventory/:sku/history',
      ledger.status,
      `${String(ledger.body.history.length)} ledger row(s)`,
    );
    const shipRow = (ledger.body.history as { delta: number; reason: string }[]).find(
      (r) => r.reason === 'shipment' && r.delta === -state.qty,
    );
    expect(shipRow, 'ledger must record the shipment movement').toBeDefined();
    fact(`ledger entry: reason=shipment delta=${String(shipRow!.delta)}`);

    const dupShipTransition = await api()
      .post(`/api/v1/admin/shipments/${state.shipmentId}/ship`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/shipments/:id/ship',
      dupShipTransition.status,
      `re-ship → ${dupShipTransition.body.error?.code ?? ''}`,
    );
    expect(dupShipTransition.status).toBe(409);
    const afterDup = await stockOf(SKU);
    expect(afterDup.onHand).toBe(afterShip.onHand);
    fact('rejected re-ship moved NO stock — transition is idempotent-safe');

    const delivered = await api()
      .post(`/api/v1/admin/shipments/${state.shipmentId}/deliver`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/deliver', delivered.status, 'DELIVERED');
    expect(delivered.status).toBe(200);
    expect(delivered.body.shipment.status).toBe('delivered');

    const custView = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/shipments`)
      .set(asA());
    log(
      'GET',
      '/api/v1/.../shipments',
      custView.status,
      `customer sees status=${custView.body.shipments[0].status as string}`,
    );
    expect(custView.body.shipments[0]).toMatchObject({ status: 'delivered', carrier: 'Bluedart' });
    expect(custView.body.shipments[0]).not.toHaveProperty('note');
    fact('operator note is NOT exposed to the customer');

    const bShip = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/shipments`)
      .set(asB());
    log('GET', '/api/v1/.../shipments', bShip.status, "B reading A's shipments → 404");
    expect(bShip.status).toBe(404);
  });

  /* ══ 13. GST / INVOICE ═════════════════════════════════════════════════ */

  it('13. GST invoice', async () => {
    section('13. GST / INVOICE');

    const rows = await db().select().from(invoice).where(eq(invoice.storeId, state.storeId));
    expect(rows.length).toBeGreaterThan(0);
    const inv = rows.find((r) => r.invoiceNumber)!;
    state.invoiceNumber = inv.invoiceNumber;
    fact(`invoice number = ${state.invoiceNumber}`);
    expect(state.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/u);
    fact('format INV/<financial-year>/<6-digit sequence>, FY-scoped and sequential');

    const doc = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/invoice`)
      .set(asA());
    log('GET', '/api/v1/.../invoice', doc.status, `content-type=${doc.headers['content-type']}`);
    expect(doc.status).toBe(200);
    expect(doc.headers['content-type']).toMatch(/text\/html/u);
    expect(doc.headers['cache-control']).toMatch(/no-store/u);
    fact('Cache-Control: private, no-store — the document carries a delivery address');
    expect(doc.text).toContain(SELLER_GSTIN);
    expect(doc.text).toContain(HSN);
    expect(doc.text).toContain('Audit Retail Private Limited');
    expect(doc.text).toContain('Ashwini Rao-Patel');
    fact('seller + customer snapshot and HSN present in the document');
    expect(doc.text).toMatch(/CGST/u);
    expect(doc.text).toMatch(/SGST/u);
    expect(doc.text).not.toMatch(/IGST[^<]*<div class="muted">₹[1-9]/u);
    fact('intra-state supply rendered as CGST + SGST');

    const adminDoc = await api()
      .get(`/api/v1/admin/orders/${state.codOrderNumber}/invoice`)
      .set(asStaff());
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      adminDoc.status,
      'staff can re-issue any order invoice',
    );
    expect(adminDoc.status).toBe(200);

    const custAdminDoc = await api()
      .get(`/api/v1/admin/orders/${state.codOrderNumber}/invoice`)
      .set(asA());
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      custAdminDoc.status,
      'CUSTOMER on staff invoice route → 403',
    );
    expect(custAdminDoc.status).toBe(403);

    const bDoc = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/invoice`)
      .set(asB());
    log('GET', '/api/v1/.../invoice', bDoc.status, "B reading A's invoice → 404");
    expect(bDoc.status).toBe(404);

    /* Historical stability: rename + reprice the product, re-read the invoice. */
    const rename = await api()
      .patch(`/api/v1/admin/products/${SLUG}`)
      .set(asStaff())
      .send({ name: 'RENAMED AFTER INVOICE' });
    expect(rename.status).toBe(200);
    const reprice = await api()
      .patch(`/api/v1/admin/skus/${SKU}`)
      .set(asStaff())
      .send({ price: '999.0000' });
    expect(reprice.status).toBe(200);
    log(
      'PATCH',
      '/api/v1/admin/products/:slug + skus/:code',
      200,
      'product renamed and repriced AFTER invoicing',
    );

    const reread = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}/invoice`)
      .set(asA());
    expect(reread.status).toBe(200);
    expect(reread.text).toContain('Audit Jacket');
    expect(reread.text).not.toContain('RENAMED AFTER INVOICE');
    expect(reread.text).toContain(state.invoiceNumber);
    log('GET', '/api/v1/.../invoice', reread.status, 'invoice UNCHANGED — snapshot held');
    fact('renaming/repricing the catalogue did not rewrite history');

    const orderReread = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}`)
      .set(asA());
    expect(orderReread.body.order.items[0].unitPrice).toBe(UNIT_PRICE);
    expect(orderReread.body.order.items[0].productName).toBe('Audit Jacket');
    fact(`order line still reports ${UNIT_PRICE} and the original product name`);
  });

  /* ══ 14. RETURNS ═══════════════════════════════════════════════════════ */

  it('14. returns', async () => {
    section('14. RETURNS');

    const notDelivered = await api()
      .post(`/api/v1/users/me/orders/${state.onlineOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret-undelivered-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    log(
      'POST',
      '/api/v1/.../returns',
      notDelivered.status,
      `undelivered order → ${notDelivered.body.error?.code ?? ''}`,
    );
    expect(notDelivered.status).toBeGreaterThanOrEqual(400);
    fact('return requires a delivered order — the window is measured from delivery');

    const badReason = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret-badreason-${RUN}`)
      .send({ reason: 'changed_mind', lines: [{ skuCode: SKU, quantity: 1 }] });
    log('POST', '/api/v1/.../returns', badReason.status, 'reason outside RETURN_REASONS → 400');
    expect(badReason.status).toBe(400);

    const overQty = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret-over-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: state.qty + 5 }] });
    log(
      'POST',
      '/api/v1/.../returns',
      overQty.status,
      `more than was ordered → ${overQty.body.error?.code ?? ''}`,
    );
    expect(overQty.status).toBeGreaterThanOrEqual(400);

    const zeroQty = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret-zero-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 0 }] });
    log('POST', '/api/v1/.../returns', zeroQty.status, 'quantity 0 → 400');
    expect(zeroQty.status).toBe(400);

    /* PARTIAL return: 1 of the 3 delivered units. */
    const RETKEY = `aud-ret-${RUN}`;
    const created = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', RETKEY)
      .send({
        reason: 'defective',
        customerNote: 'zip broken',
        lines: [{ skuCode: SKU, quantity: 1 }],
      });
    log('POST', '/api/v1/.../returns', created.status, 'PARTIAL return: 1 of 3 units');
    expect(created.status).toBe(201);
    type Ret = {
      returnNumber: string;
      orderNumber: string;
      status: string;
      reason: string;
      refundTaxableValue: string;
      refundTaxTotal: string;
      refundTotal: string;
      lines: { skuCode: string; quantity: number }[];
    };
    const r = bodyAs<{ return: Ret }>(created).return;
    state.returnNumber = r.returnNumber;
    fact(`return number = ${r.returnNumber} status=${r.status}`);
    expect(r.returnNumber).toMatch(/^RET-\d{8}-[A-Z2-9]{6}$/u);
    expect(r.status).toBe('requested');
    expect(r.lines[0]).toMatchObject({ skuCode: SKU, quantity: 1 });
    fact(
      `refund snapshot: taxable=${r.refundTaxableValue} tax=${r.refundTaxTotal} total=${r.refundTotal}`,
    );
    expect(minor(r.refundTotal)).toBe(minor(r.refundTaxableValue) + minor(r.refundTaxTotal));
    fact('refundTotal = taxable + tax — apportioned from the order, frozen at request time');

    const replay = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', RETKEY)
      .send({
        reason: 'defective',
        customerNote: 'zip broken',
        lines: [{ skuCode: SKU, quantity: 1 }],
      });
    log(
      'POST',
      '/api/v1/.../returns',
      replay.status,
      'same idempotency key → replay, no second return',
    );
    expect(replay.status).toBe(201);
    expect(bodyAs<{ return: Ret }>(replay).return.returnNumber).toBe(state.returnNumber);

    const listed = await api().get('/api/v1/users/me/returns').set(asA());
    log(
      'GET',
      '/api/v1/users/me/returns',
      listed.status,
      `${String(listed.body.returns.length)} return(s)`,
    );
    expect(listed.status).toBe(200);

    const readOwn = await api().get(`/api/v1/users/me/returns/${state.returnNumber}`).set(asA());
    log('GET', '/api/v1/users/me/returns/:n', readOwn.status, 'customer reads own return');
    expect(readOwn.status).toBe(200);

    const bRead = await api().get(`/api/v1/users/me/returns/${state.returnNumber}`).set(asB());
    log('GET', '/api/v1/users/me/returns/:n', bRead.status, "B reading A's return → 404");
    expect(bRead.status).toBe(404);

    const custApprove = await api()
      .post(`/api/v1/admin/returns/${state.returnNumber}/approve`)
      .set(asA())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      custApprove.status,
      'CUSTOMER approving own return → 403',
    );
    expect(custApprove.status).toBe(403);

    const custReject = await api()
      .post(`/api/v1/admin/returns/${state.returnNumber}/reject`)
      .set(asA())
      .send({ staffNote: 'let me out' });
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      custReject.status,
      'CUSTOMER rejecting own return → 403',
    );
    expect(custReject.status).toBe(403);

    /* Over-allocation: the remaining returnable quantity is 2. */
    const overRemaining = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret-overalloc-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 3 }] });
    log(
      'POST',
      '/api/v1/.../returns',
      overRemaining.status,
      `1 already pending + 3 more > 3 ordered → ${overRemaining.body.error?.code ?? ''}`,
    );
    expect(overRemaining.status).toBeGreaterThanOrEqual(400);
    fact('a pending return HOLDS its quantity against further requests');

    /* Second return for the reject path. */
    const second = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret2-${RUN}`)
      .send({ reason: 'not_as_described', lines: [{ skuCode: SKU, quantity: 1 }] });
    log('POST', '/api/v1/.../returns', second.status, 'second partial return (will be rejected)');
    expect(second.status).toBe(201);
    state.rejectedReturnNumber = bodyAs<{ return: Ret }>(second).return.returnNumber;

    const adminList = await api().get('/api/v1/admin/returns').set(asStaff()).query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/returns',
      adminList.status,
      `${String(adminList.body.returns.length)} return(s) in queue`,
    );
    expect(adminList.status).toBe(200);

    const custAdminList = await api().get('/api/v1/admin/returns').set(asA());
    log(
      'GET',
      '/api/v1/admin/returns',
      custAdminList.status,
      'CUSTOMER on admin returns list → 403',
    );
    expect(custAdminList.status).toBe(403);

    const adminRead = await api().get(`/api/v1/admin/returns/${state.returnNumber}`).set(asStaff());
    log('GET', '/api/v1/admin/returns/:n', adminRead.status, 'staff reads the return');
    expect(adminRead.status).toBe(200);

    const approved = await api()
      .post(`/api/v1/admin/returns/${state.returnNumber}/approve`)
      .set(asStaff())
      .send({ staffNote: 'audit approval' });
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      approved.status,
      `status → ${approved.body.return?.status ?? ''}`,
    );
    expect(approved.status).toBe(200);
    expect(approved.body.return.status).toBe('approved');

    const reApprove = await api()
      .post(`/api/v1/admin/returns/${state.returnNumber}/approve`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/returns/:n/approve', reApprove.status, 'repeat approve → rejected');
    expect(reApprove.status).toBe(409);

    const rejected = await api()
      .post(`/api/v1/admin/returns/${state.rejectedReturnNumber}/reject`)
      .set(asStaff())
      .send({ staffNote: 'outside policy' });
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      rejected.status,
      `status → ${rejected.body.return?.status ?? ''}`,
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.return.status).toBe('rejected');

    /* The rejected quantity must become requestable again. */
    const afterReject = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-ret3-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    log(
      'POST',
      '/api/v1/.../returns',
      afterReject.status,
      'rejected quantity is requestable again',
    );
    expect(afterReject.status).toBe(201);
    const third = bodyAs<{ return: Ret }>(afterReject).return.returnNumber;

    /* Customer cancellation rules: approved may be cancelled; requested may not. */
    const cancelRequested = await api()
      .post(`/api/v1/users/me/returns/${third}/cancel`)
      .set(asA())
      .send({});
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      cancelRequested.status,
      `cancel while REQUESTED → ${cancelRequested.body.error?.code ?? ''}`,
    );
    fact(
      'transition table: requested → [approved, rejected]; cancellation is only legal from approved',
    );
    expect(cancelRequested.status).toBe(409);

    const cancelApproved = await api()
      .post(`/api/v1/users/me/returns/${state.returnNumber}/cancel`)
      .set(asA())
      .send({});
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      cancelApproved.status,
      `cancel while APPROVED → ${cancelApproved.body.return?.status ?? cancelApproved.body.error?.code ?? ''}`,
    );
    expect(cancelApproved.status).toBe(200);
    expect(cancelApproved.body.return.status).toBe('cancelled');

    const bCancel = await api()
      .post(`/api/v1/users/me/returns/${third}/cancel`)
      .set(asB())
      .send({});
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      bCancel.status,
      "B cancelling A's return → 404",
    );
    expect(bCancel.status).toBe(404);

    section('15. REFUND / DOWNSTREAM BOUNDARY');
    const receive = await api()
      .post(`/api/v1/admin/returns/${third}/receive`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/receive',
      receive.status,
      'receive while REQUESTED → 409 (illegal transition)',
    );
    expect(receive.status).toBe(409);
    fact(
      'receive/inspect/complete are routed; requested → received is not a legal transition, only approved → received is',
    );
    finding('BOUNDARY', 'no credit note, no e-invoice/IRN, no e-way bill, no partial shipment');
  });

  /* ══ SECURITY: cross-store ═════════════════════════════════════════════ */

  it('S. tenancy — a valid token from another store is refused', async () => {
    section('S. TENANT ISOLATION');

    const crossStore = await api()
      .get('/api/v1/users/me')
      .set({ Authorization: `Bearer ${FOREIGN.token}` });
    log('GET', '/api/v1/users/me', crossStore.status, 'VALID token minted for another store → 401');
    expect(crossStore.status).toBe(401);
    fact(
      'auth middleware compares the token storeId against the resolved store; mismatch is 401, not 403',
    );

    const crossOrder = await api()
      .get(`/api/v1/users/me/orders/${state.codOrderNumber}`)
      .set({ Authorization: `Bearer ${FOREIGN.token}` });
    log('GET', '/api/v1/users/me/orders/:n', crossOrder.status, 'cross-store order read → 401');
    expect(crossOrder.status).toBe(401);

    fact(
      'NOTE: store resolution is DEFAULT_STORE_SLUG only; Host-header multi-tenancy is deferred',
    );
  });

  /* ══ CONCURRENCY ═══════════════════════════════════════════════════════ */

  it('C. concurrency — last unit, duplicate checkout, duplicate payment', async () => {
    section('C. CONCURRENCY / INTEGRITY');

    /* C1: two customers race for the single unit of RACE_SKU. */
    const bAddr = B.address;
    const addA = await api()
      .put(`/api/v1/users/me/cart/items/${RACE_SKU}`)
      .set(asA())
      .send({ quantity: 1 });
    const addB = await api()
      .put(`/api/v1/users/me/cart/items/${RACE_SKU}`)
      .set(asB())
      .send({ quantity: 1 });
    expect(addA.status).toBe(200);
    expect(addB.status).toBe(200);
    fact('both carts hold the last unit — the cart deliberately does NOT reserve');

    const raceStockBefore = await stockOf(RACE_SKU);
    showStock('race SKU BEFORE', raceStockBefore);

    const [rA, rB] = await Promise.all([
      api()
        .post('/api/v1/users/me/checkout')
        .set(asA())
        .set('idempotency-key', `aud-race-a-${RUN}`)
        .send({ addressId: A.address }),
      api()
        .post('/api/v1/users/me/checkout')
        .set(asB())
        .set('idempotency-key', `aud-race-b-${RUN}`)
        .send({ addressId: bAddr }),
    ]);
    log(
      'POST',
      '/api/v1/users/me/checkout (A, concurrent)',
      rA.status,
      rA.status === 201 ? 'won' : `lost → ${rA.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/users/me/checkout (B, concurrent)',
      rB.status,
      rB.status === 201 ? 'won' : `lost → ${rB.body.error?.code ?? ''}`,
    );

    const winners = [rA, rB].filter((r) => r.status === 201);
    const losers = [rA, rB].filter((r) => r.status !== 201);
    expect(winners, 'exactly one checkout may win the last unit').toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.status).toBe(409);
    expect(losers[0]!.body.error.code).toBe('INSUFFICIENT_STOCK');
    fact('EXACTLY ONE order created; the loser got 409 INSUFFICIENT_STOCK — no oversell');

    const raceStockAfter = await stockOf(RACE_SKU);
    showStock('race SKU AFTER', raceStockAfter);
    expect(raceStockAfter.reserved).toBe(1);
    expect(raceStockAfter.available).toBe(0);
    expect(raceStockAfter.onHand).toBe(1);

    /* C2: the SAME idempotency key fired twice concurrently. */
    const addAgain = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asA())
      .send({ quantity: 1 });
    expect(addAgain.status).toBe(200);
    const CKEY = `aud-concurrent-checkout-${RUN}`;
    const [c1, c2] = await Promise.all([
      api()
        .post('/api/v1/users/me/checkout')
        .set(asA())
        .set('idempotency-key', CKEY)
        .send({ addressId: A.address }),
      api()
        .post('/api/v1/users/me/checkout')
        .set(asA())
        .set('idempotency-key', CKEY)
        .send({ addressId: A.address }),
    ]);
    log(
      'POST',
      '/api/v1/users/me/checkout (same key ×2)',
      c1.status,
      `first → ${c1.body.order?.orderNumber ?? c1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/users/me/checkout (same key ×2)',
      c2.status,
      `second → ${c2.body.order?.orderNumber ?? c2.body.error?.code ?? ''}`,
    );
    const created201 = [c1, c2].filter((r) => r.status === 201);
    const numbers = new Set(created201.map((r) => r.body.order.orderNumber as string));
    expect(numbers.size, 'the same key must never yield two different orders').toBeLessThanOrEqual(
      1,
    );
    const inFlight = [c1, c2].filter((r) => r.status === 409);
    fact(
      `same-key concurrency: ${String(created201.length)} × 201, ${String(inFlight.length)} × 409 in-flight, distinct orders = ${String(numbers.size)}`,
    );

    /* C3: duplicate payment initiation, concurrently, on one order. */
    const raceOrderNumber = winners[0]!.body.order.orderNumber as string;
    const [p1, p2] = await Promise.all([
      api()
        .post(`/api/v1/users/me/orders/${raceOrderNumber}/payments`)
        .set(winners[0] === rA ? asA() : asB())
        .set('idempotency-key', `aud-cpay-1-${RUN}`)
        .send({ method: 'cod' }),
      api()
        .post(`/api/v1/users/me/orders/${raceOrderNumber}/payments`)
        .set(winners[0] === rA ? asA() : asB())
        .set('idempotency-key', `aud-cpay-2-${RUN}`)
        .send({ method: 'cod' }),
    ]);
    log(
      'POST',
      '/api/v1/.../payments (concurrent, 2 keys)',
      p1.status,
      p1.status === 201 ? 'created' : `${p1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/.../payments (concurrent, 2 keys)',
      p2.status,
      p2.status === 201 ? 'created' : `${p2.body.error?.code ?? ''}`,
    );
    const payCreated = [p1, p2].filter((r) => r.status === 201);
    expect(payCreated, 'an order takes exactly one payment').toHaveLength(1);
    fact('one payment created; the other rejected — no double charge');

    /* C4: duplicate return creation, concurrently. */
    const [q1, q2] = await Promise.all([
      api()
        .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
        .set(asA())
        .set('idempotency-key', `aud-cret-1-${RUN}`)
        .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] }),
      api()
        .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
        .set(asA())
        .set('idempotency-key', `aud-cret-2-${RUN}`)
        .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] }),
    ]);
    log(
      'POST',
      '/api/v1/.../returns (concurrent, 2 keys)',
      q1.status,
      q1.status === 201 ? 'created' : `${q1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/.../returns (concurrent, 2 keys)',
      q2.status,
      q2.status === 201 ? 'created' : `${q2.body.error?.code ?? ''}`,
    );
    const retCreated = [q1, q2].filter((r) => r.status === 201).length;
    fact(
      `returns created concurrently: ${String(retCreated)} (delivered qty 3, 1 cancelled + 1 open already)`,
    );

    /*
     * The pair above did not itself prove over-allocation is impossible: the remaining
     * capacity happened to be exactly 2, so two successes were legitimate. The proof is that
     * capacity is now EXHAUSTED — one more unit must be refused.
     */
    const exhausted = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/returns`)
      .set(asA())
      .set('idempotency-key', `aud-cret-3-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    log(
      'POST',
      '/api/v1/.../returns',
      exhausted.status,
      `capacity exhausted → ${exhausted.body.error?.code ?? ''}`,
    );
    expect(exhausted.status).toBe(422);
    expect(exhausted.body.error.code).toBe('RETURN_QUANTITY_UNAVAILABLE');
    fact(
      'the concurrent pair allocated exactly the remaining 2 units and no more — no over-allocation',
    );

    /* C5: cancellation vs fulfilment — cancel a shipped order. */
    const cancelShipped = await api()
      .post(`/api/v1/users/me/orders/${state.codOrderNumber}/cancel`)
      .set(asA())
      .send({});
    log(
      'POST',
      '/api/v1/.../cancel',
      cancelShipped.status,
      `cancel a DELIVERED order → ${cancelShipped.body.error?.code ?? ''}`,
    );
    expect(cancelShipped.status).toBe(409);
    fact('fulfilled orders cannot be cancelled — the order lock serialises the two paths');
  });

  /* ══ FINAL RECONCILIATION ══════════════════════════════════════════════ */

  it('Z. final reconciliation', async () => {
    section('Z. FINAL DATA INTEGRITY');

    const orders = await db().select().from(order).where(eq(order.storeId, state.storeId));
    const payments = await db().select().from(payment).where(eq(payment.storeId, state.storeId));
    const invoices = await db().select().from(invoice).where(eq(invoice.storeId, state.storeId));

    fact(
      `orders=${String(orders.length)} payments=${String(payments.length)} invoices=${String(invoices.length)}`,
    );

    for (const row of payments) {
      expect(
        orders.some((o) => o.id === row.orderId),
        'every payment points at an order in this store',
      ).toBe(true);
    }
    for (const row of invoices) {
      expect(
        orders.some((o) => o.id === row.orderId),
        'every invoice points at an order in this store',
      ).toBe(true);
    }
    const numbers = invoices.map((i) => i.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    fact('invoice numbers unique; every payment/invoice bound to a real order');

    const orderNumbers = orders.map((o) => o.orderNumber);
    expect(new Set(orderNumbers).size).toBe(orderNumbers.length);
    fact('order numbers unique across the store');

    const finalStock = await stockOf(SKU);
    showStock(`${SKU} FINAL`, finalStock);
    expect(finalStock.available).toBe(finalStock.onHand - finalStock.reserved);
    fact('available = onHand − reserved holds');

    const raceFinal = await stockOf(RACE_SKU);
    showStock(`${RACE_SKU} FINAL`, raceFinal);
    expect(raceFinal.onHand).toBe(1);
    fact('the single race unit was never oversold');

    line('');
    line('══════════ TRANSCRIPT COMPLETE ══════════');
  });
});
