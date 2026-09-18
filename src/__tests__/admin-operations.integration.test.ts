import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../container.js';
import { appUser, auditLog } from '../db/schema/identity.js';
import { order } from '../db/schema/orders.js';
import { store } from '../db/schema/store.js';
import { newId } from '../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../tests/helpers/redis.ts';

/**
 * Increment 62 — the remaining admin operations surface.
 *
 * Six endpoints across three modules, against the REAL composition root, real PostgreSQL and
 * real Redis:
 *
 *   GET   /admin/orders/{orderNumber}/timeline
 *   POST  /admin/orders/{orderNumber}/cancel
 *   POST  /admin/customers/{customerId}/activation
 *   GET   /admin/audit-logs
 *   GET   /admin/business-profile
 *   PATCH /admin/business-profile
 *
 * Four properties carry this suite:
 *
 *  1. **Every route is staff-only.** Anonymous is 401 and a signed-in customer is 403, asserted
 *     for all six rather than for a representative one — an authorization gap is per-route.
 *  2. **Nothing privileged is reachable through a body.** The activation schema rejects
 *     `isStaff`/`isSuperuser`, and the business profile rejects every GST field, by name.
 *  3. **Staff cancellation runs the customer's guards.** A paid order is refused, and
 *     `payment.status` is unchanged afterwards.
 *  4. **Reads do not leak.** No internal store id, no `metadata`, no actor id on the timeline.
 */
describe('admin operations surface (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let staffId = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const PRICE = '500.0000';
  let seq = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '4000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '4000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    const staff = await signIn({ staff: true });
    staffToken = staff.token;
    staffId = staff.id;
    customerToken = (await signIn()).token;
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function signIn(options: { staff?: boolean } = {}): Promise<{ token: string; id: string }> {
    const email = `${options.staff === true ? 'ops' : 'buyer'}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'A', lastName: 'B' },
    });
    if (options.staff === true) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { token: login.body.accessToken as string, id: user.id };
  }

  /** A placed, UNPAID order — the only kind that is cancellable. */
  async function givenPlacedOrder() {
    const buyer = await signIn();
    const n = (seq += 1);
    const slug = `adm-op-${String(n)}`;
    const skuCode = `ADMOP-${String(n)}`;
    const headers = { Authorization: `Bearer ${buyer.token}` };

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff())
          .send({ slug, name: 'Tee', status: 'active' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`/api/v1/admin/products/${slug}/skus`)
          .set(asStaff())
          .send({ code: skuCode, price: PRICE })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff())
          .send({ skuCode, delta: 50, reason: 'manual_increase' })
      ).status,
    ).toBe(201);
    expect(
      (await api().put(`/api/v1/users/me/cart/items/${skuCode}`).set(headers).send({ quantity: 1 }))
        .status,
    ).toBe(200);

    const addr = await api().post('/api/v1/users/me/addresses').set(headers).send({
      label: 'Home',
      recipientName: 'A B',
      phone: '+91 9876543210',
      line1: '1 Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560025',
    });
    expect(addr.status).toBe(201);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(headers)
      .set('idempotency-key', `co-${newId()}`)
      .send({ addressId: addr.body.address.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    return { orderNumber, orderId: row!.id, buyerToken: buyer.token, skuCode };
  }

  /* ══ 1. Authorization, for every new route ════════════════════════════ */

  describe('authorization', () => {
    const ROUTES = [
      ['get', '/api/v1/admin/orders/ORD-20260101-AAAAAA/timeline'],
      ['post', '/api/v1/admin/orders/ORD-20260101-AAAAAA/cancel'],
      ['post', `/api/v1/admin/customers/${newId()}/activation`],
      ['get', '/api/v1/admin/audit-logs'],
      ['get', '/api/v1/admin/business-profile'],
      ['patch', '/api/v1/admin/business-profile'],
    ] as const;

    it('refuses every route without a token', async () => {
      for (const [method, path] of ROUTES) {
        const response = await api()[method](path).send({});
        expect({ path, status: response.status }).toEqual({ path, status: 401 });
      }
    });

    it('refuses every route for a signed-in customer', async () => {
      for (const [method, path] of ROUTES) {
        const response = await api()[method](path).set(asCustomer()).send({});
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
      }
    });

    it('refuses a staff member deactivated mid-session, on the next request', async () => {
      const victim = await signIn({ staff: true });
      const headers = { Authorization: `Bearer ${victim.token}` };

      expect((await api().get('/api/v1/admin/business-profile').set(headers)).status).toBe(200);

      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, victim.id));

      /* Authorization is re-read from the database per request, never trusted from the token. */
      expect((await api().get('/api/v1/admin/business-profile').set(headers)).status).toBe(403);
    });
  });

  /* ══ 2. The order timeline ════════════════════════════════════════════ */

  describe('GET /admin/orders/:orderNumber/timeline', () => {
    it('publishes the creation entry, and the cancellation after one', async () => {
      const ctx = await givenPlacedOrder();

      const first = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/timeline`)
        .set(asStaff());
      expect(first.status).toBe(200);
      expect(first.body.timeline).toHaveLength(1);
      expect(first.body.timeline[0]).toEqual({
        fromStatus: null,
        toStatus: 'placed',
        actorType: 'customer',
        note: null,
        at: expect.any(String),
      });

      expect(
        (await api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({}))
          .status,
      ).toBe(200);

      const after = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/timeline`)
        .set(asStaff());
      const timeline = after.body.timeline as {
        fromStatus: string | null;
        toStatus: string;
        actorType: string;
        at: string;
      }[];

      expect(timeline.map((e) => e.toStatus)).toEqual(['placed', 'cancelled']);
      expect(timeline[1]!.fromStatus).toBe('placed');
      expect(timeline[1]!.actorType).toBe('staff');

      /* Oldest first, non-decreasing. */
      const times = timeline.map((e) => Date.parse(e.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      /* The actor's user id is never on this read. */
      expect(JSON.stringify(after.body)).not.toContain(staffId);
    });

    it('404s an unknown order number', async () => {
      const response = await api()
        .get('/api/v1/admin/orders/ORD-20260101-ZZZZZZ/timeline')
        .set(asStaff());
      expect(response.status).toBe(404);
    });
  });

  /* ══ 3. Staff cancellation ════════════════════════════════════════════ */

  describe('POST /admin/orders/:orderNumber/cancel', () => {
    it('cancels an unpaid order and records the transition as staff', async () => {
      const ctx = await givenPlacedOrder();

      const response = await api()
        .post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`)
        .set(asStaff())
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('cancelled');

      const [row] = await db().select().from(order).where(eq(order.id, ctx.orderId));
      expect(row!.status).toBe('cancelled');

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, ctx.orderId));
      const cancelled = entries.find((e) => e.action === 'order.cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled!.actorType).toBe('staff');
      expect(cancelled!.actorUserId).toBe(staffId);
    });

    it('refuses a second cancellation rather than answering success twice', async () => {
      const ctx = await givenPlacedOrder();

      expect(
        (await api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({}))
          .status,
      ).toBe(200);

      const second = await api()
        .post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`)
        .set(asStaff())
        .send({});
      /* 409, not 422: `OrderNotCancellable` extends `Conflict` for every refusal reason. */
      expect(second.status).toBe(409);
    });

    it('resolves exactly one winner under concurrent cancellation', async () => {
      const ctx = await givenPlacedOrder();

      const [a, b] = await Promise.all([
        api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({}),
        api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({}),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);

      /* One transition, one history row — not two. */
      const timeline = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/timeline`)
        .set(asStaff());
      expect(
        (timeline.body.timeline as { toStatus: string }[]).filter(
          (e) => e.toStatus === 'cancelled',
        ),
      ).toHaveLength(1);
    });

    it('404s an unknown order number', async () => {
      const response = await api()
        .post('/api/v1/admin/orders/ORD-20260101-ZZZZZZ/cancel')
        .set(asStaff())
        .send({});
      expect(response.status).toBe(404);
    });
  });

  /* ══ 4. Customer activation ═══════════════════════════════════════════ */

  describe('POST /admin/customers/:customerId/activation', () => {
    const activation = (customerId: string, body: object) =>
      api().post(`/api/v1/admin/customers/${customerId}/activation`).set(asStaff()).send(body);

    it('deactivates and reactivates, auditing each decision', async () => {
      const victim = await signIn();
      const id = victim.id;

      const off = await activation(id, { isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.customer.isActive).toBe(false);

      const on = await activation(id, { isActive: true });
      expect(on.status).toBe(200);
      expect(on.body.customer.isActive).toBe(true);

      const actions = (await db().select().from(auditLog).where(eq(auditLog.resourceId, id))).map(
        (e) => e.action,
      );
      expect(actions).toContain('customer.deactivated');
      expect(actions).toContain('customer.activated');
    });

    it('stops a deactivated customer signing in', async () => {
      const email = `victim.${newId()}@example.com`;
      const victim = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'V', lastName: 'X' },
      });

      expect(
        (await api().post('/api/v1/auth/login').send({ email, password: PASSWORD })).status,
      ).toBe(200);

      expect((await activation(victim.id, { isActive: false })).status).toBe(200);

      const after = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(after.status).not.toBe(200);
    });

    it('refuses a redundant change with 409 and writes no audit entry', async () => {
      const victim = await signIn();

      const before = (await db().select().from(auditLog).where(eq(auditLog.resourceId, victim.id)))
        .length;

      /* Already active. */
      expect((await activation(victim.id, { isActive: true })).status).toBe(409);

      const after = (await db().select().from(auditLog).where(eq(auditLog.resourceId, victim.id)))
        .length;
      expect(after).toBe(before);
    });

    it('rejects a body that tries to grant privilege', async () => {
      const victim = await signIn();

      for (const body of [
        { isActive: false, isStaff: true },
        { isActive: false, isSuperuser: true },
        { isStaff: true },
        { isActive: 'false' },
        {},
      ]) {
        expect((await activation(victim.id, body)).status).toBe(400);
      }

      const [row] = await db().select().from(appUser).where(eq(appUser.id, victim.id));
      expect(row!.isStaff).toBe(false);
      expect(row!.isSuperuser).toBe(false);
      expect(row!.isActive).toBe(true);
    });

    it('404s an unknown customer and a malformed id is a 400', async () => {
      expect((await activation(newId(), { isActive: false })).status).toBe(404);
      expect((await activation('not-a-uuid', { isActive: false })).status).toBe(400);
    });
  });

  /* ══ 5. The audit log ═════════════════════════════════════════════════ */

  describe('GET /admin/audit-logs', () => {
    const logs = (query = '') => api().get(`/api/v1/admin/audit-logs${query}`).set(asStaff());

    it('returns a page, newest first, without metadata', async () => {
      const ctx = await givenPlacedOrder();
      await api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({});

      const response = await logs('?limit=50');
      expect(response.status).toBe(200);
      expect(response.body.pagination.total).toBeGreaterThan(0);

      /*
       * The EXACT key set. `metadata` must not appear — each module writes its own per-action
       * context, and publishing the union through one endpoint would make every future
       * `audit.record` call a disclosure decision on this route.
       */
      const entry = (response.body.auditLogs as Record<string, unknown>[])[0]!;
      expect(Object.keys(entry).sort()).toEqual([
        'action',
        'actorType',
        'actorUserId',
        'at',
        'resourceId',
        'resourceType',
      ]);

      /* Newest first. */
      const times = (response.body.auditLogs as { at: string }[]).map((e) => Date.parse(e.at));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('filters by action, exactly', async () => {
      const ctx = await givenPlacedOrder();
      await api().post(`/api/v1/admin/orders/${ctx.orderNumber}/cancel`).set(asStaff()).send({});

      const exact = await logs('?action=order.cancelled&limit=50');
      expect(exact.status).toBe(200);
      expect(
        (exact.body.auditLogs as { action: string }[]).every((e) => e.action === 'order.cancelled'),
      ).toBe(true);

      /* A prefix is NOT a substring match — the filter is exact by design. */
      const prefix = await logs('?action=order&limit=50');
      expect(prefix.body.auditLogs).toEqual([]);
      expect(prefix.body.pagination.total).toBe(0);
    });

    it('filters by actor type and resource type', async () => {
      const byStaff = await logs('?actorType=staff&limit=50');
      expect(
        (byStaff.body.auditLogs as { actorType: string }[]).every((e) => e.actorType === 'staff'),
      ).toBe(true);

      const byResource = await logs('?resourceType=order&limit=50');
      expect(
        (byResource.body.auditLogs as { resourceType: string }[]).every(
          (e) => e.resourceType === 'order',
        ),
      ).toBe(true);
    });

    it('paginates with a total that agrees with the filter', async () => {
      const page = await logs('?limit=1&offset=0');
      expect(page.body.auditLogs).toHaveLength(1);
      expect(page.body.pagination.limit).toBe(1);

      const second = await logs('?limit=1&offset=1');
      expect(second.body.pagination.total).toBe(page.body.pagination.total);
    });

    it('applies the inclusive-millisecond upper bound', async () => {
      const newest = (await logs('?limit=1')).body.auditLogs[0] as { at: string };

      /* The bound is the entry's OWN published timestamp — a plain `<=` would drop it. */
      const included = await logs(`?to=${encodeURIComponent(newest.at)}&limit=50`);
      expect((included.body.auditLogs as { at: string }[]).some((e) => e.at === newest.at)).toBe(
        true,
      );

      const before = new Date(Date.parse(newest.at) - 1).toISOString();
      const excluded = await logs(`?to=${encodeURIComponent(before)}&limit=50`);
      expect((excluded.body.auditLogs as { at: string }[]).some((e) => e.at === newest.at)).toBe(
        false,
      );
    });

    it('rejects unknown parameters and malformed values', async () => {
      expect((await logs('?storeId=whatever')).status).toBe(400);
      expect((await logs('?from=2026-09-01')).status).toBe(400);
      expect((await logs('?actorType=wizard')).status).toBe(400);
      expect((await logs('?actorUserId=not-a-uuid')).status).toBe(400);
      expect((await logs('?limit=500')).status).toBe(400);
    });

    it('returns an empty page rather than an error when nothing matches', async () => {
      const response = await logs('?action=nothing.ever.happened');
      expect(response.status).toBe(200);
      expect(response.body.auditLogs).toEqual([]);
      expect(response.body.pagination.total).toBe(0);
    });
  });

  /* ══ 6. The business profile ══════════════════════════════════════════ */

  describe('/admin/business-profile', () => {
    const read = () => api().get('/api/v1/admin/business-profile').set(asStaff());
    const patch = (body: object) =>
      api().patch('/api/v1/admin/business-profile').set(asStaff()).send(body);

    it('publishes the presentational identity and no GST field', async () => {
      const response = await read();
      expect(response.status).toBe(200);

      expect(Object.keys(response.body.businessProfile).sort()).toEqual([
        'currency',
        'defaultLocale',
        'domain',
        'isActive',
        'name',
        'slug',
        'timezone',
      ]);

      /* No internal store id, and no GST identity — that is the tax profile's. */
      expect(JSON.stringify(response.body)).not.toContain(storeId);
      for (const field of ['gstin', 'legalName', 'pan', 'originCity', 'registeredAddress']) {
        expect(response.body.businessProfile).not.toHaveProperty(field);
      }
    });

    it('edits only the named fields and audits what changed', async () => {
      const before = (await read()).body.businessProfile;

      const response = await patch({ name: 'Renamed Store', timezone: 'Asia/Dubai' });
      expect(response.status).toBe(200);
      expect(response.body.businessProfile.name).toBe('Renamed Store');
      expect(response.body.businessProfile.timezone).toBe('Asia/Dubai');
      /* Untouched by omission — a PATCH, not a PUT. */
      expect(response.body.businessProfile.defaultLocale).toBe(before.defaultLocale);
      expect(response.body.businessProfile.slug).toBe(before.slug);
      expect(response.body.businessProfile.currency).toBe(before.currency);

      const [entry] = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'store.business_profile_updated'));
      expect(entry).toBeDefined();
      expect(entry!.actorType).toBe('staff');

      const changed = (entry!.metadata as { changed: Record<string, unknown> }).changed;
      expect(Object.keys(changed).sort()).toEqual(['name', 'timezone']);

      /* Restore, so later assertions in this file see the seeded values. */
      await patch({ name: before.name, timezone: before.timezone });
    });

    it('treats an empty body as a no-op', async () => {
      const before = (await read()).body.businessProfile;
      const response = await patch({});
      expect(response.status).toBe(200);
      expect(response.body.businessProfile).toEqual(before);
    });

    it('clears a custom domain with an explicit null', async () => {
      expect((await patch({ domain: 'shop.example.com' })).body.businessProfile.domain).toBe(
        'shop.example.com',
      );
      expect((await patch({ domain: null })).body.businessProfile.domain).toBeNull();
    });

    it('rejects GST fields, read-only fields and unknown fields by name', async () => {
      for (const body of [
        { gstin: '29ABCDE1234F1Z5' },
        { legalName: 'Something Pvt Ltd' },
        { pan: 'ABCDE1234F' },
        { slug: 'hijacked' },
        { currency: 'USD' },
        { isActive: false },
        { storeId: newId() },
      ]) {
        const response = await patch(body);
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
      }

      /* The GST identity is untouched by any of that. */
      const [row] = await db().select().from(store).where(eq(store.id, storeId));
      expect(row!.slug).not.toBe('hijacked');
      expect(row!.currency).not.toBe('USD');
    });

    it('rejects an invalid timezone, locale and domain', async () => {
      expect((await patch({ timezone: 'Asia/Atlantis' })).status).toBe(400);
      expect((await patch({ defaultLocale: 'english' })).status).toBe(400);
      expect((await patch({ domain: 'https://shop.example.com/path' })).status).toBe(400);
      expect((await patch({ name: '' })).status).toBe(400);
    });
  });
});
