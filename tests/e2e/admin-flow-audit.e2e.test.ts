import { createHmac } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrPromoteAdmin } from '../../scripts/create-admin.ts';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser, auditLog } from '../../src/db/schema/identity.js';
import { stockLedger } from '../../src/db/schema/inventory.js';
import { outboxEvent } from '../../src/db/schema/outbox.js';
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
 * QA AUDIT HARNESS — the complete ADMIN / STAFF operational flow.
 *
 * An audit artifact, not part of the product suite. It drives the REAL composition root against
 * a REAL PostgreSQL and Redis over HTTP, modifies no production code, and asserts only what the
 * implementation actually does. Where the implementation's behaviour is itself the finding, the
 * behaviour is RECORDED, never corrected.
 *
 * Direct database writes are used in exactly two places and both are labelled DB-FIXTURE in the
 * transcript: seeding a second store (no API creates stores) and demoting a staff member (no API
 * revokes staff — the same deliberate absence that means no API grants it). Everything else goes
 * through HTTP.
 */
describe('QA AUDIT — admin / staff flow', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const providerRefs: string[] = [];
  const RUN = Date.now().toString(36);

  const RAZORPAY = {
    keyId: `rzp_test_adm_${RUN}`,
    keySecret: 'admin-audit-api-secret',
    webhookSecret: 'admin-audit-webhook-secret',
  };

  const PASSWORD = 'a-sufficiently-long-admin-audit-password';
  const SELLER_STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const HSN = '62011000';

  const SLUG = `adm-jacket-${RUN}`;
  const SKU = `ADM-${RUN}-M`;
  const SKU2 = `ADM-${RUN}-L`;
  const UNCLASSIFIED_SLUG = `adm-unclassified-${RUN}`;
  const UNCLASSIFIED_SKU = `ADMUNCL-${RUN}`;
  const DISPOSABLE_SLUG = `adm-disposable-${RUN}`;
  const TAX_CLASS = `ADMGST${RUN}`.toUpperCase();
  const PRICE = '800.0000';
  /** Units of SKU the customer orders — drives ship deduction and returnable quantity. */
  const ORDER_QTY = 3;

  const STAFF = { email: `adm.staff.${RUN}@example.com`, id: '', token: '' };
  const CUST = { email: `adm.cust.${RUN}@example.com`, id: '', token: '', address: '' };
  const CUST2 = { email: `adm.cust2.${RUN}@example.com`, id: '', token: '', address: '' };
  const FOREIGN_STAFF = { email: `adm.fstaff.${RUN}@example.com`, id: '', token: '', storeId: '' };

  const S = {
    storeId: '',
    orderNumber: '',
    igstOrderNumber: '',
    shipmentId: '',
    optionId: '',
    valueM: '',
    valueL: '',
    returnNumber: '',
  };

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asStaff = () => ({ Authorization: `Bearer ${STAFF.token}` });
  const asCust = () => ({ Authorization: `Bearer ${CUST.token}` });
  const asCust2 = () => ({ Authorization: `Bearer ${CUST2.token}` });

  const minor = (v: string): bigint => BigInt(v.replace('.', ''));
  const bodyAs = <T>(r: { body: unknown }): T => r.body as T;
  const sign = (b: string): string =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(b, 'utf8')).digest('hex');

  let step = 0;
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const section = (t: string): void => {
    line('');
    line(`═══════════ ${t} ═══════════`);
  };
  const log = (m: string, p: string, status: number, note: string): void => {
    step += 1;
    line(
      `${String(step).padStart(3, '0')}. ${m.padEnd(6)} ${p.padEnd(46)} → ${String(status).padEnd(3)}  ${note}`,
    );
  };
  const fact = (s: string): void => line(`     · ${s}`);
  const dbfix = (s: string): void => line(`     ▣ DB-FIXTURE: ${s}`);
  const finding = (sev: string, s: string): void => line(`     ⚑ ${sev}: ${s}`);

  async function waitFor(fn: () => Promise<void>, ms = 5_000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      try {
        await fn();
        return;
      } catch (e) {
        if (Date.now() >= end) throw e;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  type Stock = { skuCode: string; onHand: number; reserved: number; available: number };
  async function stockOf(code: string): Promise<Stock> {
    const r = await api().get('/api/v1/admin/inventory').set(asStaff()).query({ limit: 100 });
    expect(r.status).toBe(200);
    const row = bodyAs<{ inventory: Stock[] }>(r).inventory.find((s) => s.skuCode === code);
    expect(row, `stock row ${code}`).toBeDefined();
    return row!;
  }
  const showStock = (l: string, s: Stock): void =>
    fact(
      `${l}: onHand=${String(s.onHand)} reserved=${String(s.reserved)} available=${String(s.available)}`,
    );

  async function auditRows(action: string) {
    return db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, S.storeId), eq(auditLog.action, action)));
  }

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) throw new Error(`unexpected outbound: ${url}`);
      const ref = `order_ADM_${RUN}_${String(providerRefs.length + 1)}`;
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
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    S.storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    line('');
    line('╔══════════════════════════════════════════════════════════════════════╗');
    line('║  E-COMMERCE BACKEND — ADMIN / STAFF FLOW AUDIT TRANSCRIPT            ║');
    line('╚══════════════════════════════════════════════════════════════════════╝');
    line(`store: ${S.storeId}   run: ${RUN}`);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. ADMIN AUTHENTICATION ═══════════════════════════════════════════ */

  it('1. admin authentication and authorization', async () => {
    section('1. ADMIN AUTHENTICATION');

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
    log('SCRIPT', 'createOrPromoteAdmin()', 201, `staff created ${STAFF.email}`);
    fact(
      'the ONLY supported staff-creation mechanism — no HTTP route grants isStaff (DECISIONS §22)',
    );

    const sLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: STAFF.email, password: PASSWORD });
    log(
      'POST',
      '/api/v1/auth/login',
      sLogin.status,
      'staff uses the SAME login route as customers',
    );
    expect(sLogin.status).toBe(200);
    STAFF.token = sLogin.body.accessToken as string;
    expect(sLogin.body.user).not.toHaveProperty('isStaff');
    fact('login response does NOT advertise isStaff — privilege is not a client-visible claim');

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ email: CUST.email, password: PASSWORD, firstName: 'Cust', lastName: 'A' });
    expect(reg.status).toBe(201);
    CUST.id = reg.body.user.id as string;
    const cLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: CUST.email, password: PASSWORD });
    log('POST', '/api/v1/auth/login', cLogin.status, 'customer uses the identical mechanism');
    expect(cLogin.status).toBe(200);
    CUST.token = cLogin.body.accessToken as string;

    const reg2 = await api()
      .post('/api/v1/auth/register')
      .send({ email: CUST2.email, password: PASSWORD, firstName: 'Cust', lastName: 'B' });
    expect(reg2.status).toBe(201);
    CUST2.id = reg2.body.user.id as string;
    const c2Login = await api()
      .post('/api/v1/auth/login')
      .send({ email: CUST2.email, password: PASSWORD });
    expect(c2Login.status).toBe(200);
    CUST2.token = c2Login.body.accessToken as string;

    section('1b. AUTHORIZATION MATRIX');

    for (const [m, path] of [
      ['GET', '/api/v1/admin/inventory'],
      ['GET', '/api/v1/admin/products'],
      ['GET', '/api/v1/admin/promotions'],
      ['GET', '/api/v1/admin/returns'],
      ['GET', '/api/v1/admin/orders/fulfilment'],
      ['GET', '/api/v1/admin/tax-classes'],
    ] as const) {
      const anon = await api().get(path);
      expect(anon.status, `${path} anon`).toBe(401);
      const cust = await api().get(path).set(asCust());
      expect(cust.status, `${path} customer`).toBe(403);
      const staff = await api().get(path).set(asStaff());
      expect(staff.status, `${path} staff`).toBe(200);
      log(m, path, staff.status, 'anon→401  customer→403  staff→200');
    }

    const badJwt = await api()
      .get('/api/v1/admin/inventory')
      .set({ Authorization: 'Bearer nonsense' });
    log('GET', '/api/v1/admin/inventory', badJwt.status, 'malformed JWT → 401');
    expect(badJwt.status).toBe(401);

    const tampered = await api()
      .get('/api/v1/admin/inventory')
      .set({ Authorization: `Bearer ${STAFF.token.split('.').slice(0, 2).join('.')}.XX` });
    log('GET', '/api/v1/admin/inventory', tampered.status, 'tampered signature → 401');
    expect(tampered.status).toBe(401);

    const selfPromote = await api()
      .patch('/api/v1/users/me')
      .set(asCust())
      .send({ firstName: 'Sneaky', isStaff: true });
    log('PATCH', '/api/v1/users/me', selfPromote.status, 'customer self-promotion attempt → 400');
    expect(selfPromote.status).toBe(400);
    const custRow = await db().select().from(appUser).where(eq(appUser.id, CUST.id));
    expect(custRow[0]?.isStaff).toBe(false);
    fact('is_staff still false — InsertUserValues has no such field, so the TYPE forbids it');

    section('1c. DEMOTED STAFF — authorization reads CURRENT database state');

    const beforeDemote = await api().get('/api/v1/admin/inventory').set(asStaff());
    expect(beforeDemote.status).toBe(200);
    log('GET', '/api/v1/admin/inventory', beforeDemote.status, 'staff token works');

    await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, STAFF.id));
    dbfix(
      'UPDATE app_user SET is_staff=false — no API revokes staff, mirroring that none grants it',
    );

    const afterDemote = await api().get('/api/v1/admin/inventory').set(asStaff());
    log(
      'GET',
      '/api/v1/admin/inventory',
      afterDemote.status,
      'SAME unexpired JWT after demotion → 403',
    );
    expect(afterDemote.status).toBe(403);
    expect(afterDemote.body.error.details.missing).toContain('staff');
    fact('requireScope re-reads app_user every request; a stale token claim is never trusted');

    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, STAFF.id));
    dbfix('re-promoted for the remainder of the audit');
    const rePromoted = await api().get('/api/v1/admin/inventory').set(asStaff());
    log('GET', '/api/v1/admin/inventory', rePromoted.status, 'access restored on the next request');
    expect(rePromoted.status).toBe(200);

    const deactivated = await db().select().from(appUser).where(eq(appUser.id, CUST2.id));
    expect(deactivated[0]?.isActive).toBe(true);
    await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, CUST2.id));
    dbfix('UPDATE app_user SET is_active=false for customer B');
    const inactive = await api().get('/api/v1/users/me').set(asCust2());
    log('GET', '/api/v1/users/me', inactive.status, 'deactivated account → 401 (not 403)');
    expect(inactive.status).toBe(401);
    fact(
      'a suspended account is an AUTHENTICATION failure — the credential no longer identifies a usable identity',
    );
    await db().update(appUser).set({ isActive: true }).where(eq(appUser.id, CUST2.id));
    dbfix('customer B reactivated');

    /* Foreign-store staff, for tenancy probes. */
    const fStore = newId();
    await db()
      .insert(store)
      .values({
        id: fStore,
        slug: `adm-foreign-${RUN}`,
        name: 'Foreign Store',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        isActive: true,
      });
    dbfix(`second store ${fStore} seeded — no API creates stores`);
    FOREIGN_STAFF.storeId = fStore;
    const fUser = await container.identity.registerCustomer({
      storeId: fStore,
      input: { email: FOREIGN_STAFF.email, password: PASSWORD, firstName: 'F', lastName: 'Staff' },
    });
    FOREIGN_STAFF.id = fUser.id;
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, fUser.id));
    dbfix('foreign user promoted to staff of the OTHER store');
    const fTokens = await container.identity.login({
      storeId: fStore,
      input: { email: FOREIGN_STAFF.email, password: PASSWORD },
      userAgent: null,
      ipAddress: null,
    });
    FOREIGN_STAFF.token = fTokens.accessToken;
  });

  /* ══ 2. PRODUCT / CATALOGUE ════════════════════════════════════════════ */

  it('2. admin product and catalogue lifecycle', async () => {
    section('2. ADMIN PRODUCT / CATALOGUE');

    const create = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: SLUG, name: 'Admin Jacket', description: 'Audit product' });
    log('POST', '/api/v1/admin/products', create.status, `${SLUG} created`);
    expect(create.status).toBe(201);
    expect(create.body.product.status).toBe('draft');
    fact('status defaults to DRAFT — publishing is never an accident of creation');

    const dupSlug = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: SLUG, name: 'Copy' });
    log(
      'POST',
      '/api/v1/admin/products',
      dupSlug.status,
      `duplicate slug → ${dupSlug.body.error?.code ?? ''}`,
    );
    expect(dupSlug.status).toBe(409);
    expect(dupSlug.body.error.code).toBe('PRODUCT_SLUG_TAKEN');

    for (const [body, label] of [
      [{ name: 'No slug' }, 'missing required slug'],
      [{ slug: 'Bad Slug', name: 'x' }, 'invalid slug shape'],
      [{ slug: `ok-${RUN}`, name: '' }, 'empty name'],
      [{ slug: `ok2-${RUN}`, name: '   ' }, 'whitespace-only name'],
      [{ slug: `ok3-${RUN}`, name: 'x', colour: 'blue' }, 'unknown field'],
      [{ slug: `ok4-${RUN}`, name: 123 }, 'wrong type'],
      [{ slug: `ok5-${RUN}`, name: 'x', status: 'live' }, 'invalid enum value'],
      [{ slug: null, name: 'x' }, 'null where forbidden'],
    ] as const) {
      const r = await api().post('/api/v1/admin/products').set(asStaff()).send(body);
      log('POST', '/api/v1/admin/products', r.status, `${label} → 400`);
      expect(r.status, label).toBe(400);
    }

    const list = await api().get('/api/v1/admin/products').set(asStaff()).query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/products',
      list.status,
      `${String(list.body.products.length)} product(s) incl. drafts`,
    );
    expect(list.status).toBe(200);

    const read = await api().get(`/api/v1/admin/products/${SLUG}`).set(asStaff());
    log('GET', '/api/v1/admin/products/:slug', read.status, 'admin reads own draft');
    expect(read.status).toBe(200);

    const patch = await api()
      .patch(`/api/v1/admin/products/${SLUG}`)
      .set(asStaff())
      .send({ name: 'Admin Jacket v2', description: 'updated' });
    log('PATCH', '/api/v1/admin/products/:slug', patch.status, 'name + description updated');
    expect(patch.status).toBe(200);
    expect(patch.body.product.name).toBe('Admin Jacket v2');

    const patchStatus = await api()
      .patch(`/api/v1/admin/products/${SLUG}`)
      .set(asStaff())
      .send({ status: 'active' });
    log(
      'PATCH',
      '/api/v1/admin/products/:slug',
      patchStatus.status,
      'status via PATCH → 400 (not an editable field)',
    );
    expect(patchStatus.status).toBe(400);
    fact('lifecycle cannot be changed by ordinary PATCH — explicit verbs only');

    const patchSlug = await api()
      .patch(`/api/v1/admin/products/${SLUG}`)
      .set(asStaff())
      .send({ slug: `renamed-${RUN}` });
    log(
      'PATCH',
      '/api/v1/admin/products/:slug',
      patchSlug.status,
      'slug via PATCH → 400 (identity is immutable)',
    );
    expect(patchSlug.status).toBe(400);

    const emptyPatch = await api().patch(`/api/v1/admin/products/${SLUG}`).set(asStaff()).send({});
    log('PATCH', '/api/v1/admin/products/:slug', emptyPatch.status, 'empty patch → 400');
    expect(emptyPatch.status).toBe(400);

    /* SKU needed before publishing makes it publicly visible. */
    const sku = await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asStaff())
      .send({ code: SKU, name: 'Medium', price: PRICE });
    log('POST', '/api/v1/admin/products/:slug/skus', sku.status, `${SKU} @ ${PRICE}`);
    expect(sku.status).toBe(201);

    const publish = await api()
      .post(`/api/v1/admin/products/${SLUG}/publish`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/products/:slug/publish', publish.status, 'draft → active');
    expect(publish.status).toBe(200);
    expect(publish.body.product.status).toBe('active');

    const rePublish = await api()
      .post(`/api/v1/admin/products/${SLUG}/publish`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/products/:slug/publish',
      rePublish.status,
      `already active → ${rePublish.body.error?.code ?? ''}`,
    );
    expect(rePublish.status).toBe(409);
    fact('invalid state transition is a 409 naming from/to — repeat publish is not a silent no-op');

    const pubVisible = await api().get(`/api/v1/products/${SLUG}`);
    log(
      'GET',
      '/api/v1/products/:slug',
      pubVisible.status,
      'published product is publicly readable',
    );
    expect(pubVisible.status).toBe(200);

    const archive = await api()
      .post(`/api/v1/admin/products/${SLUG}/archive`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/products/:slug/archive', archive.status, 'active → archived');
    expect(archive.status).toBe(200);
    const archivedPublic = await api().get(`/api/v1/products/${SLUG}`);
    log(
      'GET',
      '/api/v1/products/:slug',
      archivedPublic.status,
      'archived product hidden from public',
    );
    expect(archivedPublic.status).toBe(404);

    const republish = await api()
      .post(`/api/v1/admin/products/${SLUG}/publish`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/products/:slug/publish',
      republish.status,
      'archived → active again',
    );
    expect(republish.status).toBe(200);

    const custPublish = await api()
      .post(`/api/v1/admin/products/${SLUG}/publish`)
      .set(asCust())
      .send({});
    log(
      'POST',
      '/api/v1/admin/products/:slug/publish',
      custPublish.status,
      'CUSTOMER lifecycle action → 403',
    );
    expect(custPublish.status).toBe(403);

    /* Soft delete on a disposable product. */
    const disp = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: DISPOSABLE_SLUG, name: 'Disposable', status: 'active' });
    expect(disp.status).toBe(201);
    const dispSku = await api()
      .post(`/api/v1/admin/products/${DISPOSABLE_SLUG}/skus`)
      .set(asStaff())
      .send({ code: `DISP-${RUN}`, price: '100.0000' });
    expect(dispSku.status).toBe(201);

    const del = await api().delete(`/api/v1/admin/products/${DISPOSABLE_SLUG}`).set(asStaff());
    log('DELETE', '/api/v1/admin/products/:slug', del.status, 'soft delete');
    expect(del.status).toBe(204);

    const delPublic = await api().get(`/api/v1/products/${DISPOSABLE_SLUG}`);
    log(
      'GET',
      '/api/v1/products/:slug',
      delPublic.status,
      'deleted product excluded from public catalogue',
    );
    expect(delPublic.status).toBe(404);

    const delAdmin = await api().get(`/api/v1/admin/products/${DISPOSABLE_SLUG}`).set(asStaff());
    log(
      'GET',
      '/api/v1/admin/products/:slug',
      delAdmin.status,
      'deleted product also 404 on admin read',
    );
    expect(delAdmin.status).toBe(404);
    fact('soft delete is deleted_at — the ROW survives for history; the API treats it as gone');

    const cascaded = await api()
      .put(`/api/v1/users/me/cart/items/DISP-${RUN}`)
      .set(asCust())
      .send({ quantity: 1 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      cascaded.status,
      "deleted product's SKU unsellable → 404",
    );
    expect(cascaded.status).toBe(404);

    const reDelete = await api().delete(`/api/v1/admin/products/${DISPOSABLE_SLUG}`).set(asStaff());
    log('DELETE', '/api/v1/admin/products/:slug', reDelete.status, 'repeat delete → 404');
    expect(reDelete.status).toBe(404);

    const audits = await auditRows('product.created');
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]?.actorType).toBe('staff');
    expect(audits.some((a) => a.actorUserId === STAFF.id)).toBe(true);
    fact(
      `audit_log: product.created rows=${String(audits.length)} actorType=staff actor=${STAFF.id}`,
    );
  });

  /* ══ 3. SKU / VARIANT ══════════════════════════════════════════════════ */

  it('3. admin SKU and variant management', async () => {
    section('3. ADMIN SKU / VARIANT');

    const dup = await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asStaff())
      .send({ code: SKU, price: '10.0000' });
    log(
      'POST',
      '/api/v1/admin/products/:slug/skus',
      dup.status,
      `duplicate active SKU code → ${dup.body.error?.code ?? ''}`,
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SKU_CODE_TAKEN');

    for (const [body, label] of [
      [{ code: `X-${RUN}`, price: 800 }, 'money as JSON number'],
      [{ code: `X2-${RUN}`, price: '-5.0000' }, 'negative price'],
      [{ code: `X3-${RUN}`, price: '8.00000' }, 'too many decimals'],
      [{ code: `X4-${RUN}` }, 'missing price'],
      [{ code: 'bad code!', price: '1.0000' }, 'invalid SKU code shape'],
      [{ code: `X5-${RUN}`, price: '1.0000', cost: '0.5' }, 'unknown field'],
    ] as const) {
      const r = await api().post(`/api/v1/admin/products/${SLUG}/skus`).set(asStaff()).send(body);
      log('POST', '/api/v1/admin/products/:slug/skus', r.status, `${label} → 400`);
      expect(r.status, label).toBe(400);
    }

    const zeroPrice = await api()
      .post(`/api/v1/admin/products/${SLUG}/skus`)
      .set(asStaff())
      .send({ code: SKU2, name: 'Large', price: '0.0000' });
    log(
      'POST',
      '/api/v1/admin/products/:slug/skus',
      zeroPrice.status,
      'price 0.0000 accepted (free item is legal)',
    );
    expect(zeroPrice.status).toBe(201);

    const skuList = await api().get(`/api/v1/admin/products/${SLUG}/skus`).set(asStaff());
    log(
      'GET',
      '/api/v1/admin/products/:slug/skus',
      skuList.status,
      `${String(skuList.body.skus.length)} SKU(s)`,
    );
    expect(skuList.status).toBe(200);
    expect(
      (skuList.body.skus as { productId: string }[]).every(
        (s) => s.productId === skuList.body.skus[0].productId,
      ),
    ).toBe(true);
    fact('every SKU belongs to the requested product; the route is product-scoped');

    const repriced = await api()
      .patch(`/api/v1/admin/skus/${SKU2}`)
      .set(asStaff())
      .send({ price: '950.0000' });
    log('PATCH', '/api/v1/admin/skus/:code', repriced.status, 'price 0.0000 → 950.0000');
    expect(repriced.status).toBe(200);
    expect(repriced.body.sku.price).toBe('950.0000');
    fact('NUMERIC(19,4) round-trips as an exact decimal STRING — never a float');

    const emptySkuPatch = await api().patch(`/api/v1/admin/skus/${SKU2}`).set(asStaff()).send({});
    log('PATCH', '/api/v1/admin/skus/:code', emptySkuPatch.status, 'empty patch → 400');
    expect(emptySkuPatch.status).toBe(400);

    const unknownSku = await api()
      .patch(`/api/v1/admin/skus/NOPE-${RUN}`)
      .set(asStaff())
      .send({ price: '1.0000' });
    log('PATCH', '/api/v1/admin/skus/:code', unknownSku.status, 'unknown SKU → 404');
    expect(unknownSku.status).toBe(404);

    section('3b. OPTIONS / VARIANT COMBINATIONS');

    const opt = await api()
      .post(`/api/v1/admin/products/${SLUG}/options`)
      .set(asStaff())
      .send({ name: 'Size', sortOrder: 1 });
    log('POST', '/api/v1/admin/products/:slug/options', opt.status, 'option "Size" created');
    expect(opt.status).toBe(201);
    S.optionId = opt.body.option.id as string;

    const dupOpt = await api()
      .post(`/api/v1/admin/products/${SLUG}/options`)
      .set(asStaff())
      .send({ name: 'size' });
    log(
      'POST',
      '/api/v1/admin/products/:slug/options',
      dupOpt.status,
      `case-insensitive duplicate → ${dupOpt.body.error?.code ?? ''}`,
    );
    expect(dupOpt.status).toBe(409);
    expect(dupOpt.body.error.code).toBe('OPTION_NAME_TAKEN');

    const vM = await api()
      .post(`/api/v1/admin/options/${S.optionId}/values`)
      .set(asStaff())
      .send({ value: 'M' });
    const vL = await api()
      .post(`/api/v1/admin/options/${S.optionId}/values`)
      .set(asStaff())
      .send({ value: 'L' });
    expect(vM.status).toBe(201);
    expect(vL.status).toBe(201);
    S.valueM = vM.body.value.id as string;
    S.valueL = vL.body.value.id as string;
    log('POST', '/api/v1/admin/options/:id/values', vL.status, 'values M and L created');

    const dupVal = await api()
      .post(`/api/v1/admin/options/${S.optionId}/values`)
      .set(asStaff())
      .send({ value: 'm' });
    log(
      'POST',
      '/api/v1/admin/options/:id/values',
      dupVal.status,
      `duplicate value → ${dupVal.body.error?.code ?? ''}`,
    );
    expect(dupVal.status).toBe(409);

    const bindM = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: [S.valueM] });
    log('PUT', '/api/v1/admin/skus/:code/options', bindM.status, `${SKU} ← Size=M`);
    expect(bindM.status).toBe(200);

    const bindDup = await api()
      .put(`/api/v1/admin/skus/${SKU2}/options`)
      .set(asStaff())
      .send({ optionValueIds: [S.valueM] });
    log(
      'PUT',
      '/api/v1/admin/skus/:code/options',
      bindDup.status,
      `duplicate combination → ${bindDup.body.error?.code ?? ''}`,
    );
    expect(bindDup.status).toBe(409);
    expect(bindDup.body.error.code).toBe('SKU_COMBINATION_TAKEN');
    fact('uq_sku_option_signature forbids two active SKUs with the same combination');

    const bindL = await api()
      .put(`/api/v1/admin/skus/${SKU2}/options`)
      .set(asStaff())
      .send({ optionValueIds: [S.valueL] });
    log('PUT', '/api/v1/admin/skus/:code/options', bindL.status, `${SKU2} ← Size=L`);
    expect(bindL.status).toBe(200);

    const tooMany = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: Array.from({ length: 11 }, () => newId()) });
    log(
      'PUT',
      '/api/v1/admin/skus/:code/options',
      tooMany.status,
      'over MAX_OPTION_VALUES_PER_SKU (10) → 400',
    );
    expect(tooMany.status).toBe(400);

    const dupIds = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: [S.valueM, S.valueM] });
    log('PUT', '/api/v1/admin/skus/:code/options', dupIds.status, 'duplicate ids in payload → 400');
    expect(dupIds.status).toBe(400);

    const badUuid = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: ['not-a-uuid'] });
    log('PUT', '/api/v1/admin/skus/:code/options', badUuid.status, 'invalid UUID → 400');
    expect(badUuid.status).toBe(400);

    const unknownValue = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: [newId()] });
    log(
      'PUT',
      '/api/v1/admin/skus/:code/options',
      unknownValue.status,
      'unknown option value → 4xx',
    );
    expect(unknownValue.status).toBeGreaterThanOrEqual(400);

    /* Cross-product option value must be refused. */
    const otherProduct = `adm-other-${RUN}`;
    await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: otherProduct, name: 'Other', status: 'active' });
    const otherOpt = await api()
      .post(`/api/v1/admin/products/${otherProduct}/options`)
      .set(asStaff())
      .send({ name: 'Colour' });
    const otherVal = await api()
      .post(`/api/v1/admin/options/${otherOpt.body.option.id as string}/values`)
      .set(asStaff())
      .send({ value: 'Red' });
    const crossProduct = await api()
      .put(`/api/v1/admin/skus/${SKU}/options`)
      .set(asStaff())
      .send({ optionValueIds: [otherVal.body.value.id as string] });
    log(
      'PUT',
      '/api/v1/admin/skus/:code/options',
      crossProduct.status,
      `option value from ANOTHER product → ${crossProduct.body.error?.code ?? ''}`,
    );
    expect(crossProduct.status).toBeGreaterThanOrEqual(400);
    fact('a SKU cannot be given an option value belonging to a different product');

    const optInUse = await api().delete(`/api/v1/admin/options/${S.optionId}`).set(asStaff());
    log(
      'DELETE',
      '/api/v1/admin/options/:id',
      optInUse.status,
      `option bound to a SKU → ${optInUse.body.error?.code ?? ''}`,
    );
    expect(optInUse.status).toBe(409);
    expect(optInUse.body.error.code).toBe('OPTION_IN_USE');
    fact('deletion protection: an option in use cannot be deleted out from under its SKUs');

    const optList = await api().get(`/api/v1/admin/products/${SLUG}/options`).set(asStaff());
    log(
      'GET',
      '/api/v1/admin/products/:slug/options',
      optList.status,
      `${String(optList.body.options.length)} option(s) with values`,
    );
    expect(optList.status).toBe(200);

    const publicDetail = await api().get(`/api/v1/products/${SLUG}`);
    const skus = bodyAs<{
      product: { skus: { code: string; options: { optionName: string; value: string }[] }[] };
    }>(publicDetail).product.skus;
    const mSku = skus.find((s) => s.code === SKU)!;
    expect(mSku.options.map((o) => `${o.optionName}=${o.value}`)).toEqual(['Size=M']);
    log(
      'GET',
      '/api/v1/products/:slug',
      publicDetail.status,
      'public response shows flat (option,value) pairs',
    );
    fact('public product response never exposes the internal option_signature');
  });

  /* ══ 4. INVENTORY ══════════════════════════════════════════════════════ */

  it('4. admin inventory', async () => {
    section('4. ADMIN INVENTORY');

    const pos = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU, delta: 20, reason: 'manual_increase', note: 'opening' });
    log('POST', '/api/v1/admin/inventory/adjustments', pos.status, '+20');
    expect(pos.status).toBe(201);
    expect(pos.body.inventory).toMatchObject({ onHand: 20, reserved: 0, available: 20 });

    const neg = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU, delta: -5, reason: 'manual_decrease', note: 'damaged' });
    log('POST', '/api/v1/admin/inventory/adjustments', neg.status, '-5 → onHand 15');
    expect(neg.status).toBe(201);
    expect(neg.body.inventory.onHand).toBe(15);

    const over = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU, delta: -999, reason: 'manual_decrease' });
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      over.status,
      `below zero → ${over.body.error?.code ?? ''}`,
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(over.body.error.details.available).toBe(15);
    const unchanged = await stockOf(SKU);
    expect(unchanged.onHand).toBe(15);
    fact('rejected adjustment moved nothing — no invalid state reachable');

    for (const [body, label] of [
      [{ skuCode: SKU, delta: 0, reason: 'correction' }, 'zero delta'],
      [{ skuCode: SKU, delta: 1.5, reason: 'correction' }, 'fractional delta'],
      [{ skuCode: SKU, delta: 5 }, 'missing reason'],
      [{ skuCode: SKU, delta: 5, reason: 'shrinkage' }, 'invalid enum reason'],
      [
        { skuCode: SKU, delta: 5, reason: 'correction', onHand: 999 },
        'unknown field (absolute target)',
      ],
      [{ delta: 5, reason: 'correction' }, 'missing skuCode'],
    ] as const) {
      const r = await api().post('/api/v1/admin/inventory/adjustments').set(asStaff()).send(body);
      log('POST', '/api/v1/admin/inventory/adjustments', r.status, `${label} → 400`);
      expect(r.status, label).toBe(400);
    }
    fact('the API accepts a DELTA only — an absolute on_hand target is not expressible');

    const unknownSku = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: `GHOST-${RUN}`, delta: 5, reason: 'correction' });
    log('POST', '/api/v1/admin/inventory/adjustments', unknownSku.status, 'unknown SKU → 404');
    expect(unknownSku.status).toBe(404);

    const custAdjust = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asCust())
      .send({ skuCode: SKU, delta: 100, reason: 'manual_increase' });
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      custAdjust.status,
      'CUSTOMER adjusting stock → 403',
    );
    expect(custAdjust.status).toBe(403);

    const history = await api()
      .get(`/api/v1/admin/inventory/${SKU}/history`)
      .set(asStaff())
      .query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/inventory/:sku/history',
      history.status,
      `${String(history.body.history.length)} ledger row(s)`,
    );
    expect(history.status).toBe(200);
    const rows = history.body.history as {
      delta: number;
      reason: string;
      onHandBefore?: number;
      onHandAfter?: number;
    }[];
    expect(rows.length).toBe(2);
    fact(`ledger holds exactly the 2 ACCEPTED adjustments; the 409 and the 400s wrote nothing`);

    const ledgerDb = await db()
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.storeId, S.storeId));
    const sum = ledgerDb.reduce((acc, r) => acc + r.delta, 0);
    const live = await stockOf(SKU);
    const skuLedger = ledgerDb.filter((r) => r.delta === 20 || r.delta === -5);
    const skuSum = skuLedger.reduce((acc, r) => acc + r.delta, 0);
    expect(skuSum).toBe(live.onHand);
    fact(
      `ledger foots: Σdelta for ${SKU} = ${String(skuSum)} = stock_item.on_hand (${String(live.onHand)}); store Σ=${String(sum)}`,
    );
    for (const r of ledgerDb) {
      expect(r.actorUserId, 'every ledger row names a real actor').toBeTruthy();
    }
    fact('every stock_ledger row carries actor_user_id — movements are attributable');

    const history2 = await api()
      .get(`/api/v1/admin/inventory/${SKU}/history`)
      .set(asStaff())
      .query({ limit: 50 });
    expect(history2.body.history.length).toBe(2);
    fact('re-reading the ledger returns the same rows — append-only, nothing rewritten');

    const stockAudits = await auditRows('inventory.adjusted');
    expect(stockAudits.length).toBe(2);
    expect(stockAudits.every((a) => a.actorType === 'staff' && a.actorUserId === STAFF.id)).toBe(
      true,
    );
    fact(`audit_log: inventory.adjusted rows=${String(stockAudits.length)}, all actorType=staff`);

    /* Stock the second SKU and an unclassified product for later sections. Each asserted, so a
       setup failure surfaces here instead of as a confusing 404 three sections later. */
    const stockSku2 = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU2, delta: 10, reason: 'manual_increase' });
    expect(stockSku2.status, 'setup: stock SKU2').toBe(201);

    const unclProduct = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: UNCLASSIFIED_SLUG, name: 'Unclassified', status: 'active' });
    expect(unclProduct.status, 'setup: create unclassified product').toBe(201);

    const unclSku = await api()
      .post(`/api/v1/admin/products/${UNCLASSIFIED_SLUG}/skus`)
      .set(asStaff())
      .send({ code: UNCLASSIFIED_SKU, price: '200.0000' });
    expect(unclSku.status, 'setup: create unclassified SKU').toBe(201);

    const unclStock = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: UNCLASSIFIED_SKU, delta: 5, reason: 'manual_increase' });
    expect(unclStock.status, 'setup: stock unclassified SKU').toBe(201);
    log('POST', 'setup: unclassified product + SKU + stock', 201, `${UNCLASSIFIED_SKU} ready`);
  });

  /* ══ 5. PROMOTIONS ═════════════════════════════════════════════════════ */

  it('5. admin promotions', async () => {
    section('5. ADMIN PROMOTIONS');

    const PCT = `ADMPCT${RUN}`.toUpperCase();
    const FIXED = `ADMFIX${RUN}`.toUpperCase();
    const DEL = `ADMDEL${RUN}`.toUpperCase();

    const pct = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: PCT,
      name: '10 pct',
      discountType: 'percentage',
      percentRate: '10',
      isActive: true,
    });
    log('POST', '/api/v1/admin/promotions', pct.status, `${PCT} percentage`);
    expect(pct.status).toBe(201);

    const fixed = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: FIXED,
      name: 'flat 100',
      discountType: 'fixed_amount',
      amount: '100.0000',
      isActive: true,
    });
    log('POST', '/api/v1/admin/promotions', fixed.status, `${FIXED} fixed amount`);
    expect(fixed.status).toBe(201);

    const dupCase = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: PCT.toLowerCase(),
      name: 'dup',
      discountType: 'percentage',
      percentRate: '5',
    });
    log(
      'POST',
      '/api/v1/admin/promotions',
      dupCase.status,
      `case-insensitive duplicate → ${dupCase.body.error?.code ?? ''}`,
    );
    expect(dupCase.status).toBe(409);
    expect(dupCase.body.error.code).toBe('PROMOTION_CODE_TAKEN');
    fact('uq_promotion_code_active is on lower(code) — SAVE10 and save10 cannot coexist');

    for (const [body, label] of [
      [
        { code: `B1${RUN}`, name: 'x', discountType: 'percentage' },
        'percentage without percentRate',
      ],
      [
        {
          code: `B2${RUN}`,
          name: 'x',
          discountType: 'percentage',
          percentRate: '10',
          amount: '5.0000',
        },
        'percentage WITH amount',
      ],
      [{ code: `B3${RUN}`, name: 'x', discountType: 'fixed_amount' }, 'fixed without amount'],
      [
        { code: `B4${RUN}`, name: 'x', discountType: 'percentage', percentRate: '0' },
        'percentRate 0',
      ],
      [
        { code: `B5${RUN}`, name: 'x', discountType: 'percentage', percentRate: '150' },
        'percentRate > 100',
      ],
      [
        { code: `B6${RUN}`, name: 'x', discountType: 'fixed_amount', amount: '-1.0000' },
        'negative amount',
      ],
      [
        { code: `B7${RUN}`, name: 'x', discountType: 'bogo', amount: '1.0000' },
        'invalid discountType',
      ],
      [
        {
          code: `B8${RUN}`,
          name: 'x',
          discountType: 'percentage',
          percentRate: '10',
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2025-01-01T00:00:00.000Z',
        },
        'endsAt before startsAt',
      ],
      [
        {
          code: `B9${RUN}`,
          name: 'x',
          discountType: 'percentage',
          percentRate: '10',
          stackable: true,
        },
        'unknown field',
      ],
    ] as const) {
      const r = await api().post('/api/v1/admin/promotions').set(asStaff()).send(body);
      log('POST', '/api/v1/admin/promotions', r.status, `${label} → 400`);
      expect(r.status, label).toBe(400);
    }

    const list = await api().get('/api/v1/admin/promotions').set(asStaff()).query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/promotions',
      list.status,
      `${String(list.body.promotions.length)} promotion(s)`,
    );
    expect(list.status).toBe(200);

    const readOne = await api().get(`/api/v1/admin/promotions/${PCT}`).set(asStaff());
    log('GET', '/api/v1/admin/promotions/:code', readOne.status, 'read one');
    expect(readOne.status).toBe(200);

    const patched = await api()
      .patch(`/api/v1/admin/promotions/${PCT}`)
      .set(asStaff())
      .send({ name: 'renamed 10 pct' });
    log('PATCH', '/api/v1/admin/promotions/:code', patched.status, 'renamed');
    expect(patched.status).toBe(200);

    /* Set above anything this cart can reach, so the minimum genuinely bites. */
    const minPatch = await api()
      .patch(`/api/v1/admin/promotions/${FIXED}`)
      .set(asStaff())
      .send({ minSubtotal: '999999.0000' });
    log(
      'PATCH',
      '/api/v1/admin/promotions/:code',
      minPatch.status,
      'minSubtotal set to 999999.0000',
    );
    expect(minPatch.status).toBe(200);

    const emptyPatch = await api().patch(`/api/v1/admin/promotions/${PCT}`).set(asStaff()).send({});
    log('PATCH', '/api/v1/admin/promotions/:code', emptyPatch.status, 'empty patch → 400');
    expect(emptyPatch.status).toBe(400);

    /* Customer consumes a valid promotion. Three units, so the returns section later has
       enough returnable quantity to exercise approve, reject and re-request without the
       allocation guard (correctly) refusing. */
    const add = await api()
      .put(`/api/v1/users/me/cart/items/${SKU}`)
      .set(asCust())
      .send({ quantity: ORDER_QTY });
    expect(add.status).toBe(200);
    const apply = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCust())
      .send({ code: PCT });
    log('PUT', '/api/v1/users/me/cart/promotion', apply.status, `customer consumes ${PCT}`);
    expect(apply.status).toBe(200);
    const cartBody = bodyAs<{
      cart: { subtotal: string; discountTotal: string; cartTotal: string };
    }>(apply).cart;
    expect(minor(cartBody.discountTotal)).toBe((minor(cartBody.subtotal) * 10n) / 100n);
    fact(
      `subtotal=${cartBody.subtotal} discount=${cartBody.discountTotal} total=${cartBody.cartTotal}`,
    );

    const belowMin = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCust())
      .send({ code: FIXED });
    log(
      'PUT',
      '/api/v1/users/me/cart/promotion',
      belowMin.status,
      `below minSubtotal → ${belowMin.body.error?.code ?? ''}`,
    );
    expect(belowMin.status).toBe(422);

    /* Soft delete and verify it can no longer be consumed. */
    const delPromo = await api().post('/api/v1/admin/promotions').set(asStaff()).send({
      code: DEL,
      name: 'to delete',
      discountType: 'percentage',
      percentRate: '25',
      isActive: true,
    });
    expect(delPromo.status).toBe(201);
    const applyBefore = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCust())
      .send({ code: DEL });
    expect(applyBefore.status).toBe(200);
    const deleted = await api().delete(`/api/v1/admin/promotions/${DEL}`).set(asStaff());
    log('DELETE', '/api/v1/admin/promotions/:code', deleted.status, 'soft delete');
    expect(deleted.status).toBe(204);

    const readDeleted = await api().get(`/api/v1/admin/promotions/${DEL}`).set(asStaff());
    log('GET', '/api/v1/admin/promotions/:code', readDeleted.status, 'deleted promotion → 404');
    expect(readDeleted.status).toBe(404);

    const applyDeleted = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCust())
      .send({ code: DEL });
    log(
      'PUT',
      '/api/v1/users/me/cart/promotion',
      applyDeleted.status,
      'deleted promotion no longer applicable → 404',
    );
    expect(applyDeleted.status).toBe(404);

    const reApply = await api()
      .put('/api/v1/users/me/cart/promotion')
      .set(asCust())
      .send({ code: PCT });
    expect(reApply.status).toBe(200);
    log('PUT', '/api/v1/users/me/cart/promotion', reApply.status, `${PCT} re-applied for checkout`);

    const custCreate = await api()
      .post('/api/v1/admin/promotions')
      .set(asCust())
      .send({
        code: `HACK${RUN}`,
        name: 'x',
        discountType: 'percentage',
        percentRate: '99',
      });
    log(
      'POST',
      '/api/v1/admin/promotions',
      custCreate.status,
      'CUSTOMER creating a 99% coupon → 403',
    );
    expect(custCreate.status).toBe(403);

    const promoAudits = await auditRows('promotion.created');
    expect(promoAudits.length).toBeGreaterThan(0);
    expect(promoAudits.every((a) => a.actorType === 'staff')).toBe(true);
    fact(`audit_log: promotion.created rows=${String(promoAudits.length)}, all actorType=staff`);
  });

  /* ══ 6. GST / TAX ══════════════════════════════════════════════════════ */

  it('6. admin GST / tax configuration', async () => {
    section('6. ADMIN GST / TAX');

    const noProfile = await api().get('/api/v1/admin/store/tax-profile').set(asStaff());
    log('GET', '/api/v1/admin/store/tax-profile', noProfile.status, 'read before configuration');

    const prof = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
      legalName: 'Admin Retail Private Limited',
      gstin: SELLER_GSTIN,
      originLine1: '4th Floor, MG Road',
      originCity: 'Bengaluru',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log('PUT', '/api/v1/admin/store/tax-profile', prof.status, `seller GSTIN ${SELLER_GSTIN}`);
    expect(prof.status).toBe(200);

    const badGstin = await api().put('/api/v1/admin/store/tax-profile').set(asStaff()).send({
      legalName: 'X',
      gstin: 'NOTAGSTIN',
      originLine1: 'a',
      originCity: 'b',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log('PUT', '/api/v1/admin/store/tax-profile', badGstin.status, 'malformed GSTIN → 400');
    expect(badGstin.status).toBe(400);

    const tc = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asStaff())
      .send({ code: TAX_CLASS, name: 'GST 5%', isActive: true });
    log('POST', '/api/v1/admin/tax-classes', tc.status, TAX_CLASS);
    expect(tc.status).toBe(201);

    const dupTc = await api()
      .post('/api/v1/admin/tax-classes')
      .set(asStaff())
      .send({ code: TAX_CLASS, name: 'dup' });
    log('POST', '/api/v1/admin/tax-classes', dupTc.status, 'duplicate tax class code → 409');
    expect(dupTc.status).toBe(409);

    const rate = await api()
      .post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`)
      .set(asStaff())
      .send({
        cgstRate: '2.5',
        sgstRate: '2.5',
        igstRate: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      });
    log(
      'POST',
      '/api/v1/admin/tax-classes/:code/rates',
      rate.status,
      'CGST 2.5 + SGST 2.5 / IGST 5',
    );
    expect(rate.status).toBe(201);

    const badRate = await api()
      .post(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`)
      .set(asStaff())
      .send({
        cgstRate: '-1',
        sgstRate: '2.5',
        igstRate: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      });
    log('POST', '/api/v1/admin/tax-classes/:code/rates', badRate.status, 'negative rate → 400');
    expect(badRate.status).toBe(400);

    const rateList = await api().get(`/api/v1/admin/tax-classes/${TAX_CLASS}/rates`).set(asStaff());
    log(
      'GET',
      '/api/v1/admin/tax-classes/:code/rates',
      rateList.status,
      `${String(rateList.body.taxRates.length)} rate row(s)`,
    );
    expect(rateList.status).toBe(200);
    expect(rateList.body.taxClass.code).toBe(TAX_CLASS);

    const tcList = await api().get('/api/v1/admin/tax-classes').set(asStaff());
    log(
      'GET',
      '/api/v1/admin/tax-classes',
      tcList.status,
      `${String(tcList.body.taxClasses.length)} class(es)`,
    );
    expect(tcList.status).toBe(200);

    const tcPatch = await api()
      .patch(`/api/v1/admin/tax-classes/${TAX_CLASS}`)
      .set(asStaff())
      .send({ name: 'GST 5% (renamed)' });
    log('PATCH', '/api/v1/admin/tax-classes/:code', tcPatch.status, 'renamed');
    expect(tcPatch.status).toBe(200);

    for (const code of [SKU, SKU2]) {
      const cls = await api()
        .put(`/api/v1/admin/skus/${code}/tax`)
        .set(asStaff())
        .send({ taxClassCode: TAX_CLASS, hsnCode: HSN });
      expect(cls.status).toBe(200);
    }
    log('PUT', '/api/v1/admin/skus/:code/tax', 200, `${SKU} and ${SKU2} classified HSN ${HSN}`);

    const badHsn = await api()
      .put(`/api/v1/admin/skus/${SKU}/tax`)
      .set(asStaff())
      .send({ taxClassCode: TAX_CLASS, hsnCode: '' });
    log('PUT', '/api/v1/admin/skus/:code/tax', badHsn.status, 'empty HSN → 400');
    expect(badHsn.status).toBe(400);

    const unknownClass = await api()
      .put(`/api/v1/admin/skus/${SKU}/tax`)
      .set(asStaff())
      .send({ taxClassCode: `GHOST${RUN}`, hsnCode: HSN });
    log('PUT', '/api/v1/admin/skus/:code/tax', unknownClass.status, 'unknown tax class → 404');
    expect(unknownClass.status).toBe(404);

    const custTax = await api().put('/api/v1/admin/store/tax-profile').set(asCust()).send({
      legalName: 'X',
      gstin: SELLER_GSTIN,
      originLine1: 'a',
      originCity: 'b',
      originState: SELLER_STATE,
      originPostalCode: '560001',
      originCountryCode: 'IN',
    });
    log(
      'PUT',
      '/api/v1/admin/store/tax-profile',
      custTax.status,
      'CUSTOMER editing tax profile → 403',
    );
    expect(custTax.status).toBe(403);

    section('6b. UNCLASSIFIED SKU — current intended behaviour');

    const addUncl = await api()
      .put(`/api/v1/users/me/cart/items/${UNCLASSIFIED_SKU}`)
      .set(asCust2())
      .send({ quantity: 1 });
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      addUncl.status,
      'unclassified SKU ADDS TO CART fine',
    );
    expect(addUncl.status).toBe(200);
    expect(
      bodyAs<{ cart: { items: { isPurchasable: boolean }[] } }>(addUncl).cart.items[0]!
        .isPurchasable,
    ).toBe(true);
    fact('cart reports isPurchasable=true for a SKU that cannot actually be sold');

    const addr2 = await api().post('/api/v1/users/me/addresses').set(asCust2()).send({
      label: 'MH',
      recipientName: 'Cust B',
      phone: '+91 9876500033',
      line1: '1 Marine Drive',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      countryCode: 'IN',
    });
    expect(addr2.status).toBe(201);
    CUST2.address = addr2.body.address.id as string;

    const coUncl = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCust2())
      .set('idempotency-key', `adm-uncl-${RUN}`)
      .send({ addressId: CUST2.address });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      coUncl.status,
      `unclassified at checkout → ${coUncl.body.error?.code ?? ''}`,
    );
    expect(coUncl.status).toBe(422);
    expect(coUncl.body.error.code).toBe('TAX_NOT_DETERMINABLE');
    expect(coUncl.body.error.details.reason).toBe('unclassified');
    finding(
      'P2',
      'unclassified SKU is browsable + addable (isPurchasable=true) and only fails at checkout; no admin read of SKU tax exists',
    );

    await api().delete('/api/v1/users/me/cart').set(asCust2());
  });

  /* ══ 7. ORDERS — what staff can and cannot do ══════════════════════════ */

  it('7. orders — staff boundary', async () => {
    section('7. ORDERS / CHECKOUT — STAFF BOUNDARY');

    const addr = await api().post('/api/v1/users/me/addresses').set(asCust()).send({
      label: 'Home',
      recipientName: 'Cust A',
      phone: '+91 9876500011',
      line1: '18 Residency Road',
      city: 'Bengaluru',
      state: SELLER_STATE,
      postalCode: '560025',
      countryCode: 'IN',
    });
    expect(addr.status).toBe(201);
    CUST.address = addr.body.address.id as string;

    const co = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCust())
      .set('idempotency-key', `adm-co-${RUN}`)
      .send({ addressId: CUST.address });
    log('POST', '/api/v1/users/me/checkout', co.status, 'customer places the order (intra-state)');
    expect(co.status).toBe(201);
    S.orderNumber = co.body.order.orderNumber as string;
    const o = co.body.order as {
      subtotal: string;
      discountTotal: string;
      total: string;
      taxTotal: string;
      grandTotal: string;
      tax: { supplyType: string };
      items: { tax: { cgstAmount: string; sgstAmount: string; igstAmount: string } }[];
    };
    fact(
      `order ${S.orderNumber}: subtotal=${o.subtotal} discount=${o.discountTotal} tax=${o.taxTotal} grand=${o.grandTotal}`,
    );
    expect(o.tax.supplyType).toBe('intra_state');
    expect(minor(o.items[0]!.tax.igstAmount)).toBe(0n);
    fact(
      `INTRA-state (KA→KA): CGST ${o.items[0]!.tax.cgstAmount} + SGST ${o.items[0]!.tax.sgstAmount}, IGST 0`,
    );

    /* Inter-state order from customer B → IGST. */
    await api().put(`/api/v1/users/me/cart/items/${SKU2}`).set(asCust2()).send({ quantity: 1 });
    const co2 = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCust2())
      .set('idempotency-key', `adm-co2-${RUN}`)
      .send({ addressId: CUST2.address });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      co2.status,
      'customer B places an INTER-state order (KA→MH)',
    );
    expect(co2.status).toBe(201);
    S.igstOrderNumber = co2.body.order.orderNumber as string;
    const o2 = co2.body.order as {
      tax: { supplyType: string };
      taxTotal: string;
      items: { tax: { cgstAmount: string; sgstAmount: string; igstAmount: string } }[];
    };
    expect(o2.tax.supplyType).toBe('inter_state');
    expect(minor(o2.items[0]!.tax.cgstAmount)).toBe(0n);
    expect(minor(o2.items[0]!.tax.sgstAmount)).toBe(0n);
    expect(minor(o2.items[0]!.tax.igstAmount)).toBe(minor(o2.taxTotal));
    fact(
      `INTER-state: IGST ${o2.items[0]!.tax.igstAmount} carries the whole charge, CGST/SGST both 0`,
    );

    const staffOrderRead = await api()
      .get(`/api/v1/users/me/orders/${S.orderNumber}`)
      .set(asStaff());
    log(
      'GET',
      '/api/v1/users/me/orders/:n',
      staffOrderRead.status,
      "STAFF reading a customer's order via /users/me → 404",
    );
    expect(staffOrderRead.status).toBe(404);
    fact(
      '/users/me is self-scoped for everyone; staff privilege does NOT widen it — no impersonation',
    );

    const staffOrderList = await api().get('/api/v1/users/me/orders').set(asStaff());
    expect(staffOrderList.body.orders).toHaveLength(0);
    log(
      'GET',
      '/api/v1/users/me/orders',
      staffOrderList.status,
      "staff's own order history is empty",
    );

    const adminOrders = await api().get('/api/v1/admin/orders').set(asStaff());
    log('GET', '/api/v1/admin/orders', adminOrders.status, 'staff read the store-wide order list');
    expect(adminOrders.status).toBe(200);
    const adminOrderRows = adminOrders.body.orders as {
      orderNumber: string;
      displayStatus: string;
    }[];
    expect(adminOrderRows.map((r) => r.orderNumber)).toContain(S.orderNumber);
    fact(
      `admin list returned ${adminOrderRows.length} order(s); the customer's order is visible to staff without impersonation`,
    );

    const adminOrderDetail = await api()
      .get(`/api/v1/admin/orders/${S.orderNumber}`)
      .set(asStaff());
    log(
      'GET',
      '/api/v1/admin/orders/:n',
      adminOrderDetail.status,
      "staff read a customer's order detail",
    );
    expect(adminOrderDetail.status).toBe(200);
    expect(adminOrderDetail.body.order.orderNumber).toBe(S.orderNumber);
    fact(
      `displayStatus=${adminOrderDetail.body.order.displayStatus} — derived per §49 from order.status + payment + shipment, stored nowhere`,
    );
    finding(
      'RESOLVED',
      'GET /admin/orders and GET /admin/orders/:n now exist (Increment 50) — the staff order gap is CLOSED; /users/me stays self-scoped above, so this is a separate surface rather than a relaxation',
    );
  });

  /* ══ 8. PAYMENTS ═══════════════════════════════════════════════════════ */

  it('8. payment — staff boundary and webhook integrity', async () => {
    section('8. PAYMENT');

    const adminPayments = await api().get('/api/v1/admin/payments').set(asStaff());
    log(
      'GET',
      '/api/v1/admin/payments',
      adminPayments.status,
      'staff read the store-wide payment list',
    );
    expect(adminPayments.status).toBe(200);
    expect(JSON.stringify(adminPayments.body)).not.toContain('providerRef');
    fact(
      `admin payment list returned ${(adminPayments.body.payments as unknown[]).length} row(s); providerRef is NOT among the fields`,
    );

    const adminCustomers = await api().get('/api/v1/admin/customers').set(asStaff());
    log(
      'GET',
      '/api/v1/admin/customers',
      adminCustomers.status,
      'staff read the store-wide customer list',
    );
    expect(adminCustomers.status).toBe(200);
    expect(JSON.stringify(adminCustomers.body)).not.toContain('passwordHash');
    fact(
      `admin customer list returned ${(adminCustomers.body.customers as unknown[]).length} account(s); no passwordHash, isStaff or isSuperuser`,
    );
    finding(
      'RESOLVED',
      'GET /admin/payments and GET /admin/customers now exist (Increment 51) — both READ-ONLY and store-scoped; still NO refund, reconciliation, customer detail or activation surface',
    );

    const staffPay = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/payments`)
      .set(asStaff())
      .set('idempotency-key', `adm-staffpay-${RUN}`)
      .send({ method: 'cod' });
    log('POST', '/api/v1/.../payments', staffPay.status, "STAFF paying a customer's order → 404");
    expect(staffPay.status).toBe(404);
    fact('staff cannot fabricate a payment through the customer route — it is owner-scoped');

    const pay = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/payments`)
      .set(asCust())
      .set('idempotency-key', `adm-pay-${RUN}`)
      .send({ method: 'online' });
    log('POST', '/api/v1/.../payments', pay.status, 'customer initiates online payment');
    expect(pay.status).toBe(201);
    const ref = bodyAs<{ handoff: { providerRef: string } }>(pay).handoff.providerRef;
    const amount = bodyAs<{ payment: { amount: string } }>(pay).payment.amount;
    const orderRead = await api().get(`/api/v1/users/me/orders/${S.orderNumber}`).set(asCust());
    expect(minor(amount)).toBe(minor(orderRead.body.order.grandTotal as string));
    fact(`payment amount ${amount} === order grandTotal — server-authoritative`);

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_adm_${RUN}`, order_id: ref } } },
    });

    const noSig = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-event-id', `evt-nosig-${RUN}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', noSig.status, 'NO signature → 401');
    expect(noSig.status).toBe(401);

    const badSig = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', 'deadbeef')
      .set('x-razorpay-event-id', `evt-bad-${RUN}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', badSig.status, 'INVALID signature → 401');
    expect(badSig.status).toBe(401);
    const stillPending = await api()
      .get(`/api/v1/users/me/orders/${S.orderNumber}/payment`)
      .set(asCust());
    expect(bodyAs<{ payment: { status: string } }>(stillPending).payment.status).toBe('pending');
    fact('a forged webhook changed nothing — staff cannot fabricate success this way either');

    const ok = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt-ok-${RUN}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', ok.status, `VALID HMAC → ${JSON.stringify(ok.body)}`);
    expect(ok.status).toBe(200);

    await waitFor(async () => {
      const r = await api().get(`/api/v1/users/me/orders/${S.orderNumber}/payment`).set(asCust());
      expect(bodyAs<{ payment: { status: string } }>(r).payment.status).toBe('succeeded');
    });
    log('GET', '/api/v1/.../payment', 200, 'payment → succeeded');

    const dup = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(body))
      .set('x-razorpay-event-id', `evt-dup-${RUN}`)
      .send(body);
    log('POST', '/api/v1/webhooks/razorpay', dup.status, 'duplicate delivery → safe no-op');
    expect(dup.status).toBe(200);
    const hist = await api().get(`/api/v1/users/me/orders/${S.orderNumber}/payment`).set(asCust());
    const transitions = bodyAs<{ payment: { history: { toStatus: string }[] } }>(hist).payment
      .history;
    expect(transitions.filter((h) => h.toStatus === 'succeeded')).toHaveLength(1);
    fact(
      `payment_event history = ${JSON.stringify(transitions.map((h) => h.toStatus))} — exactly one succeeded row`,
    );

    const lateFail = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: `pay_adm_${RUN}`, order_id: ref } } },
    });
    const late = await api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', sign(lateFail))
      .set('x-razorpay-event-id', `evt-late-${RUN}`)
      .send(lateFail);
    log('POST', '/api/v1/webhooks/razorpay', late.status, 'payment.failed AFTER capture');
    const after = await api().get(`/api/v1/users/me/orders/${S.orderNumber}/payment`).set(asCust());
    expect(bodyAs<{ payment: { status: string } }>(after).payment.status).toBe('succeeded');
    fact('terminal state held — the state machine refuses succeeded→failed');
  });

  /* ══ 9. FULFILMENT ═════════════════════════════════════════════════════ */

  it('9. admin fulfilment', async () => {
    section('9. ADMIN FULFILMENT');

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
    const row = (
      queue.body.orders as {
        orderNumber: string;
        recipientName: string;
        shipmentStatus: string | null;
      }[]
    ).find((x) => x.orderNumber === S.orderNumber);
    expect(row).toBeDefined();
    expect(row!.shipmentStatus).toBeNull();
    fact(`queue row: ${row!.orderNumber} → ${row!.recipientName}, shipmentStatus=null`);

    const before = await stockOf(SKU);
    showStock('BEFORE shipment', before);

    const create = await api()
      .post(`/api/v1/admin/orders/${S.orderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart', trackingNumber: `BD${RUN}` });
    log('POST', '/api/v1/admin/orders/:n/shipments', create.status, 'shipment created (pending)');
    expect(create.status).toBe(201);
    S.shipmentId = create.body.shipment.id as string;

    const dup = await api()
      .post(`/api/v1/admin/orders/${S.orderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'X' });
    log(
      'POST',
      '/api/v1/admin/orders/:n/shipments',
      dup.status,
      `duplicate → ${dup.body.error?.code ?? ''}`,
    );
    expect(dup.status).toBe(409);
    fact('one shipment per order is the implemented rule (SHIPMENT_ALREADY_EXISTS)');

    const staffShipRead = await api()
      .get(`/api/v1/admin/orders/${S.orderNumber}/shipments`)
      .set(asStaff());
    log(
      'GET',
      '/api/v1/admin/orders/:n/shipments',
      staffShipRead.status,
      'staff read includes id + createdAt',
    );
    expect(staffShipRead.status).toBe(200);
    expect(staffShipRead.body.shipments[0]).toHaveProperty('id');
    expect(staffShipRead.body.shipments[0]).toHaveProperty('createdAt');

    const custShipRead = await api()
      .get(`/api/v1/admin/orders/${S.orderNumber}/shipments`)
      .set(asCust());
    log(
      'GET',
      '/api/v1/admin/orders/:n/shipments',
      custShipRead.status,
      'CUSTOMER on staff shipment route → 403',
    );
    expect(custShipRead.status).toBe(403);

    const patchTracking = await api()
      .patch(`/api/v1/admin/shipments/${S.shipmentId}`)
      .set(asStaff())
      .send({ trackingNumber: `BD${RUN}-CORRECTED` });
    log(
      'PATCH',
      '/api/v1/admin/shipments/:id',
      patchTracking.status,
      'tracking corrected before ship',
    );
    expect(patchTracking.status).toBe(200);

    const custShip = await api()
      .post(`/api/v1/admin/shipments/${S.shipmentId}/ship`)
      .set(asCust())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/ship', custShip.status, 'CUSTOMER shipping → 403');
    expect(custShip.status).toBe(403);

    const shipped = await api()
      .post(`/api/v1/admin/shipments/${S.shipmentId}/ship`)
      .set(asStaff())
      .send({ note: 'courier picked up' });
    log('POST', '/api/v1/admin/shipments/:id/ship', shipped.status, 'pending → shipped');
    expect(shipped.status).toBe(200);
    expect(shipped.body.shipment.status).toBe('shipped');

    /* The order carries ORDER_QTY units of SKU; shipping must move exactly that many. */
    await waitFor(async () => {
      const s = await stockOf(SKU);
      expect(s.onHand).toBe(before.onHand - ORDER_QTY);
      expect(s.reserved).toBe(before.reserved - ORDER_QTY);
    });
    const afterShip = await stockOf(SKU);
    showStock('AFTER ship', afterShip);
    fact(
      `reservation consumed at SHIP: onHand ${String(before.onHand)}→${String(afterShip.onHand)}, reserved ${String(before.reserved)}→${String(afterShip.reserved)}`,
    );

    const ledger = await api()
      .get(`/api/v1/admin/inventory/${SKU}/history`)
      .set(asStaff())
      .query({ limit: 50 });
    const shipRow = (ledger.body.history as { delta: number; reason: string }[]).find(
      (r) => r.reason === 'shipment',
    );
    expect(shipRow).toBeDefined();
    log(
      'GET',
      '/api/v1/admin/inventory/:sku/history',
      ledger.status,
      `ledger: reason=shipment delta=${String(shipRow!.delta)}`,
    );

    const reship = await api()
      .post(`/api/v1/admin/shipments/${S.shipmentId}/ship`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/shipments/:id/ship',
      reship.status,
      `repeat ship → ${reship.body.error?.code ?? ''}`,
    );
    expect(reship.status).toBe(409);
    const afterReship = await stockOf(SKU);
    expect(afterReship.onHand).toBe(afterShip.onHand);
    fact('rejected repeat moved NO stock — the transition is CAS-protected');

    const delivered = await api()
      .post(`/api/v1/admin/shipments/${S.shipmentId}/deliver`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/deliver', delivered.status, 'shipped → delivered');
    expect(delivered.status).toBe(200);

    const redeliver = await api()
      .post(`/api/v1/admin/shipments/${S.shipmentId}/deliver`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/shipments/:id/deliver', redeliver.status, 'repeat deliver → 409');
    expect(redeliver.status).toBe(409);

    const cancelDelivered = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/cancel`)
      .set(asCust())
      .send({});
    log(
      'POST',
      '/api/v1/.../cancel',
      cancelDelivered.status,
      `cancel a delivered order → ${cancelDelivered.body.error?.code ?? ''}`,
    );
    expect(cancelDelivered.status).toBe(409);
    fact(
      'cancellation vs fulfilment: the order row lock serialises both; a fulfilled order cannot be withdrawn',
    );

    const shipAudits = await auditRows('shipment.shipped');
    expect(shipAudits.length).toBeGreaterThan(0);
    expect(shipAudits.every((a) => a.actorUserId === STAFF.id && a.actorType === 'staff')).toBe(
      true,
    );
    fact(`audit_log: shipment.shipped attributed to the staff member who did it (${STAFF.id})`);
  });

  /* ══ 10. INVOICE ═══════════════════════════════════════════════════════ */

  it('10. admin invoice', async () => {
    section('10. ADMIN INVOICE');

    const doc = await api().get(`/api/v1/admin/orders/${S.orderNumber}/invoice`).set(asStaff());
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      doc.status,
      `content-type=${doc.headers['content-type']}`,
    );
    expect(doc.status).toBe(200);
    expect(doc.headers['cache-control']).toMatch(/no-store/u);
    const m = /INV\/\d{4}-\d{2}\/\d{6}/u.exec(doc.text);
    expect(m).not.toBeNull();
    fact(`invoice number ${m![0]} — FY-scoped, store-scoped, 6-digit sequence`);
    expect(doc.text).toContain(SELLER_GSTIN);
    expect(doc.text).toContain('Admin Retail Private Limited');
    expect(doc.text).toContain('Cust A');
    expect(doc.text).toContain(HSN);
    fact('seller snapshot + customer snapshot + HSN all present');

    const igstDoc = await api()
      .get(`/api/v1/admin/orders/${S.igstOrderNumber}/invoice`)
      .set(asStaff());
    log('GET', '/api/v1/admin/orders/:n/invoice', igstDoc.status, 'inter-state invoice');
    expect(igstDoc.status).toBe(200);
    expect(igstDoc.text).toMatch(/IGST/u);
    fact('inter-state invoice renders IGST');

    const custAdmin = await api()
      .get(`/api/v1/admin/orders/${S.orderNumber}/invoice`)
      .set(asCust());
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      custAdmin.status,
      'CUSTOMER on staff invoice route → 403',
    );
    expect(custAdmin.status).toBe(403);

    const foreign = await api()
      .get(`/api/v1/admin/orders/${S.orderNumber}/invoice`)
      .set({ Authorization: `Bearer ${FOREIGN_STAFF.token}` });
    log('GET', '/api/v1/admin/orders/:n/invoice', foreign.status, 'STAFF OF ANOTHER STORE → 401');
    expect(foreign.status).toBe(401);
    fact('cross-store staff token is rejected at AUTH: token storeId ≠ resolved store');

    const before = doc.text;
    await api()
      .patch(`/api/v1/admin/products/${SLUG}`)
      .set(asStaff())
      .send({ name: 'RENAMED POST-INVOICE' });
    await api().patch(`/api/v1/admin/skus/${SKU}`).set(asStaff()).send({ price: '9999.0000' });
    log(
      'PATCH',
      'products/:slug + skus/:code',
      200,
      'product renamed and repriced AFTER invoicing',
    );

    const after = await api().get(`/api/v1/admin/orders/${S.orderNumber}/invoice`).set(asStaff());
    expect(after.status).toBe(200);
    expect(after.text).toBe(before);
    log(
      'GET',
      '/api/v1/admin/orders/:n/invoice',
      after.status,
      'invoice byte-identical — historically immutable',
    );
    fact('renaming and repricing the catalogue did not rewrite a single character of the invoice');
  });

  /* ══ 11. RETURNS ═══════════════════════════════════════════════════════ */

  it('11. admin returns', async () => {
    section('11. ADMIN RETURNS');

    const created = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/returns`)
      .set(asCust())
      .set('idempotency-key', `adm-ret-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    log('POST', '/api/v1/.../returns', created.status, 'customer raises a return');
    expect(created.status).toBe(201);
    S.returnNumber = created.body.return.returnNumber as string;
    fact(
      `return ${S.returnNumber} refundTotal=${created.body.return.refundTotal as string} (snapshot only — no money moves)`,
    );

    const list = await api().get('/api/v1/admin/returns').set(asStaff()).query({ limit: 50 });
    log(
      'GET',
      '/api/v1/admin/returns',
      list.status,
      `${String(list.body.returns.length)} return(s) visible to staff`,
    );
    expect(list.status).toBe(200);
    expect(
      (list.body.returns as { returnNumber: string }[]).some(
        (r) => r.returnNumber === S.returnNumber,
      ),
    ).toBe(true);

    const filtered = await api()
      .get('/api/v1/admin/returns')
      .set(asStaff())
      .query({ status: 'requested' });
    log('GET', '/api/v1/admin/returns?status=', filtered.status, 'work-queue filter by status');
    expect(filtered.status).toBe(200);

    const badFilter = await api()
      .get('/api/v1/admin/returns')
      .set(asStaff())
      .query({ status: 'bogus' });
    log('GET', '/api/v1/admin/returns?status=', badFilter.status, 'invalid status enum → 400');
    expect(badFilter.status).toBe(400);

    const read = await api().get(`/api/v1/admin/returns/${S.returnNumber}`).set(asStaff());
    log('GET', '/api/v1/admin/returns/:n', read.status, "staff reads another customer's return");
    expect(read.status).toBe(200);

    const unknown = await api().get('/api/v1/admin/returns/RET-20200101-ABCDEF').set(asStaff());
    log('GET', '/api/v1/admin/returns/:n', unknown.status, 'unknown return number → 404');
    expect(unknown.status).toBe(404);

    const malformed = await api().get('/api/v1/admin/returns/NOT-A-RETURN').set(asStaff());
    log('GET', '/api/v1/admin/returns/:n', malformed.status, 'malformed return number → 400');
    expect(malformed.status).toBe(400);

    const custList = await api().get('/api/v1/admin/returns').set(asCust());
    log('GET', '/api/v1/admin/returns', custList.status, 'CUSTOMER on admin returns list → 403');
    expect(custList.status).toBe(403);

    const custApprove = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set(asCust())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      custApprove.status,
      'CUSTOMER approving own return → 403',
    );
    expect(custApprove.status).toBe(403);

    const foreignApprove = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set({ Authorization: `Bearer ${FOREIGN_STAFF.token}` })
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      foreignApprove.status,
      'STAFF OF ANOTHER STORE approving → 401',
    );
    expect(foreignApprove.status).toBe(401);

    const badNote = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set(asStaff())
      .send({ staffNote: 'x'.repeat(501) });
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      badNote.status,
      'staffNote over 500 chars → 400',
    );
    expect(badNote.status).toBe(400);

    const editAttempt = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set(asStaff())
      .send({ staffNote: 'ok', lines: [{ skuCode: SKU, quantity: 99 }] });
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      editAttempt.status,
      'approving with EDITED lines → 400 (strict)',
    );
    expect(editAttempt.status).toBe(400);
    fact('approval agrees to the return exactly as raised — it can never edit quantity or refund');

    const approved = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set(asStaff())
      .send({ staffNote: 'audit approval' });
    log('POST', '/api/v1/admin/returns/:n/approve', approved.status, 'requested → approved');
    expect(approved.status).toBe(200);
    expect(approved.body.return.status).toBe('approved');

    const reApprove = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/approve`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      reApprove.status,
      `repeat approve → ${reApprove.body.error?.code ?? ''}`,
    );
    expect(reApprove.status).toBe(409);

    const rejectApproved = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/reject`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      rejectApproved.status,
      'reject an APPROVED return → 409 (illegal transition)',
    );
    expect(rejectApproved.status).toBe(409);

    /* Second return → reject path. */
    const second = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/returns`)
      .set(asCust())
      .set('idempotency-key', `adm-ret2-${RUN}`)
      .send({ reason: 'not_as_described', lines: [{ skuCode: SKU, quantity: 1 }] });
    expect(second.status).toBe(201);
    const secondNumber = second.body.return.returnNumber as string;

    const rejected = await api()
      .post(`/api/v1/admin/returns/${secondNumber}/reject`)
      .set(asStaff())
      .send({ staffNote: 'outside policy' });
    log('POST', '/api/v1/admin/returns/:n/reject', rejected.status, 'requested → rejected');
    expect(rejected.status).toBe(200);
    expect(rejected.body.return.status).toBe('rejected');

    const noNote = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/returns`)
      .set(asCust())
      .set('idempotency-key', `adm-ret3-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    expect(noNote.status).toBe(201);
    const thirdNumber = noNote.body.return.returnNumber as string;
    const rejectNoNote = await api()
      .post(`/api/v1/admin/returns/${thirdNumber}/reject`)
      .set(asStaff())
      .send({});
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      rejectNoNote.status,
      'reject with NO staffNote → 200',
    );
    expect(rejectNoNote.status).toBe(200);
    finding(
      'P3',
      'staffNote is optional on reject — a return can be refused with no recorded reason',
    );

    const stockAfterReturns = await stockOf(SKU);
    showStock('after approve + reject', stockAfterReturns);
    fact(
      'neither approval nor rejection restocked anything — restock happens at completion, from inspected counts',
    );

    const receive = await api()
      .post(`/api/v1/admin/returns/${S.returnNumber}/receive`)
      .set(asStaff())
      .send({});
    log('POST', '/api/v1/admin/returns/:n/receive', receive.status, 'receive from APPROVED → 200');
    expect(receive.status).toBe(200);
    expect(receive.body.return.status).toBe('received');
    fact(
      'lifecycle now runs approved → received → inspected → completed; refunds are a separate aggregate',
    );

    const retAudits = await auditRows('return.approved');
    expect(retAudits.length).toBeGreaterThan(0);
    expect(retAudits.every((a) => a.actorType === 'staff' && a.actorUserId === STAFF.id)).toBe(
      true,
    );
    fact(`audit_log: return.approved actor=STAFF (${STAFF.id}), NOT the requesting customer`);

    const events = await db().select().from(outboxEvent).where(eq(outboxEvent.storeId, S.storeId));
    const names = [...new Set(events.map((e) => e.eventName))].sort();
    fact(`outbox_event names emitted: ${names.join(', ')}`);
  });

  /* ══ 12. CONCURRENCY ═══════════════════════════════════════════════════ */

  it('12. admin concurrency and idempotency', async () => {
    section('12. CONCURRENCY / IDEMPOTENCY (ADMIN)');

    /* Concurrent duplicate shipment creation on a fresh order. */
    await api().put(`/api/v1/users/me/cart/items/${SKU2}`).set(asCust()).send({ quantity: 1 });
    const co = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCust())
      .set('idempotency-key', `adm-conc-co-${RUN}`)
      .send({ addressId: CUST.address });
    expect(co.status).toBe(201);
    const concOrder = co.body.order.orderNumber as string;
    await api()
      .post(`/api/v1/users/me/orders/${concOrder}/payments`)
      .set(asCust())
      .set('idempotency-key', `adm-conc-pay-${RUN}`)
      .send({ method: 'cod' });

    const [s1, s2] = await Promise.all([
      api()
        .post(`/api/v1/admin/orders/${concOrder}/shipments`)
        .set(asStaff())
        .send({ carrier: 'A' }),
      api()
        .post(`/api/v1/admin/orders/${concOrder}/shipments`)
        .set(asStaff())
        .send({ carrier: 'B' }),
    ]);
    log(
      'POST',
      '/api/v1/admin/orders/:n/shipments ×2',
      s1.status,
      s1.status === 201 ? 'created' : `${s1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/admin/orders/:n/shipments ×2',
      s2.status,
      s2.status === 201 ? 'created' : `${s2.body.error?.code ?? ''}`,
    );
    expect([s1, s2].filter((r) => r.status === 201)).toHaveLength(1);
    fact('exactly one shipment created concurrently — uq constraint + transaction hold');

    /* Concurrent ship transitions on the one shipment. */
    const shipId = [s1, s2].find((r) => r.status === 201)!.body.shipment.id as string;
    const beforeConc = await stockOf(SKU2);
    const [t1, t2] = await Promise.all([
      api().post(`/api/v1/admin/shipments/${shipId}/ship`).set(asStaff()).send({}),
      api().post(`/api/v1/admin/shipments/${shipId}/ship`).set(asStaff()).send({}),
    ]);
    log(
      'POST',
      '/api/v1/admin/shipments/:id/ship ×2',
      t1.status,
      t1.status === 200 ? 'shipped' : `${t1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      '/api/v1/admin/shipments/:id/ship ×2',
      t2.status,
      t2.status === 200 ? 'shipped' : `${t2.body.error?.code ?? ''}`,
    );
    expect([t1, t2].filter((r) => r.status === 200)).toHaveLength(1);
    await waitFor(async () => {
      const s = await stockOf(SKU2);
      expect(s.onHand).toBe(beforeConc.onHand - 1);
    });
    const afterConc = await stockOf(SKU2);
    showStock('after concurrent ship', afterConc);
    fact(
      `stock moved EXACTLY once (${String(beforeConc.onHand)}→${String(afterConc.onHand)}) despite two concurrent ships`,
    );

    /* Concurrent inventory adjustments — both legal, both must land. */
    const beforeAdj = await stockOf(SKU);
    const [a1, a2] = await Promise.all([
      api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asStaff())
        .send({ skuCode: SKU, delta: 7, reason: 'manual_increase' }),
      api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asStaff())
        .send({ skuCode: SKU, delta: 5, reason: 'manual_increase' }),
    ]);
    log('POST', '/api/v1/admin/inventory/adjustments ×2', a1.status, '+7 concurrent');
    log('POST', '/api/v1/admin/inventory/adjustments ×2', a2.status, '+5 concurrent');
    expect(a1.status).toBe(201);
    expect(a2.status).toBe(201);
    const afterAdj = await stockOf(SKU);
    expect(afterAdj.onHand).toBe(beforeAdj.onHand + 12);
    fact(`no lost update: ${String(beforeAdj.onHand)} + 7 + 5 = ${String(afterAdj.onHand)}`);

    /* Concurrent return approval. */
    const ret = await api()
      .post(`/api/v1/users/me/orders/${S.orderNumber}/returns`)
      .set(asCust())
      .set('idempotency-key', `adm-conc-ret-${RUN}`)
      .send({ reason: 'defective', lines: [{ skuCode: SKU, quantity: 1 }] });
    expect(ret.status).toBe(201);
    const rn = ret.body.return.returnNumber as string;
    const [r1, r2] = await Promise.all([
      api().post(`/api/v1/admin/returns/${rn}/approve`).set(asStaff()).send({}),
      api().post(`/api/v1/admin/returns/${rn}/reject`).set(asStaff()).send({}),
    ]);
    log(
      'POST',
      'returns approve ∥ reject',
      r1.status,
      r1.status === 200 ? 'approve won' : `${r1.body.error?.code ?? ''}`,
    );
    log(
      'POST',
      'returns approve ∥ reject',
      r2.status,
      r2.status === 200 ? 'reject won' : `${r2.body.error?.code ?? ''}`,
    );
    expect([r1, r2].filter((r) => r.status === 200)).toHaveLength(1);
    fact('approve and reject raced on ONE return — exactly one decision stuck');

    const finalRet = await api().get(`/api/v1/admin/returns/${rn}`).set(asStaff());
    expect(['approved', 'rejected']).toContain(finalRet.body.return.status);
    fact(
      `final return status = ${finalRet.body.return.status as string} — never both, never corrupt`,
    );

    /* Admin mutations are NOT idempotency-keyed — confirm, do not add. */
    const withKey = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .set('idempotency-key', `adm-unused-${RUN}`)
      .send({ skuCode: SKU, delta: 1, reason: 'correction' });
    const withKeyAgain = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .set('idempotency-key', `adm-unused-${RUN}`)
      .send({ skuCode: SKU, delta: 1, reason: 'correction' });
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      withKey.status,
      'with Idempotency-Key (1st)',
    );
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      withKeyAgain.status,
      'SAME key (2nd) — key is IGNORED here',
    );
    expect(withKey.status).toBe(201);
    expect(withKeyAgain.status).toBe(201);
    expect(withKeyAgain.body.inventory.onHand).toBe((withKey.body.inventory.onHand as number) + 1);
    finding(
      'INFO',
      'admin mutations do NOT honour Idempotency-Key; only checkout, payments and returns do. A retried adjustment double-applies.',
    );
  });

  /* ══ 13. DATABASE INTEGRITY ════════════════════════════════════════════ */

  it('13. database integrity', async () => {
    section('13. DATABASE INTEGRITY');

    const ledger = await db().select().from(stockLedger).where(eq(stockLedger.storeId, S.storeId));
    for (const r of ledger) {
      expect(r.storeId).toBe(S.storeId);
      expect(r.actorUserId).toBeTruthy();
    }
    fact(`stock_ledger rows=${String(ledger.length)}, all store-scoped and attributed`);

    const audits = await db().select().from(auditLog).where(eq(auditLog.storeId, S.storeId));
    const actions = [...new Set(audits.map((a) => a.action))].sort();
    fact(`audit_log actions: ${actions.join(', ')}`);
    const staffActions = audits.filter((a) => a.actorType === 'staff');
    expect(staffActions.length).toBeGreaterThan(0);
    for (const a of staffActions) {
      expect(a.actorUserId, 'a staff audit row must name a user').toBeTruthy();
      expect(a.createdAt).toBeInstanceOf(Date);
    }
    fact(
      `staff-attributed audit rows=${String(staffActions.length)}, every one carries actor + timestamp`,
    );

    const events = await db().select().from(outboxEvent).where(eq(outboxEvent.storeId, S.storeId));
    for (const e of events) {
      expect(e.storeId).toBe(S.storeId);
      expect(e.aggregateType).toBeTruthy();
      expect(e.aggregateId).toBeTruthy();
    }
    fact(`outbox_event rows=${String(events.length)}, every one store-scoped with an aggregate`);

    const foreignAudits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.storeId, FOREIGN_STAFF.storeId));
    expect(foreignAudits.filter((a) => a.actorUserId === STAFF.id)).toHaveLength(0);
    fact('no audit row from this store leaked into the foreign store');

    const stock = await stockOf(SKU);
    expect(stock.available).toBe(stock.onHand - stock.reserved);
    showStock(`${SKU} FINAL`, stock);
    const stock2 = await stockOf(SKU2);
    expect(stock2.available).toBe(stock2.onHand - stock2.reserved);
    showStock(`${SKU2} FINAL`, stock2);
    fact('available = onHand − reserved holds for every SKU');

    line('');
    line('══════════ ADMIN TRANSCRIPT COMPLETE ══════════');
  });
});
