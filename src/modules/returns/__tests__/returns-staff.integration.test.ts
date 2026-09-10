import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { order, orderLine } from '../../../db/schema/orders.js';
import { returnEvent, returnRequest } from '../../../db/schema/returns.js';
import { shipment } from '../../../db/schema/shipments.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * Increment 40d — staff approval and rejection.
 *
 * Against the REAL composition root, real PostgreSQL and real Redis, because the point of this
 * increment is that the staff guard, the row lock and the CAS all work as the container wires
 * them. A hand-wired subset would prove the wiring in the test rather than the wiring that
 * ships.
 *
 * Four properties carry this suite:
 *
 *  1. **Only staff, only their own store.** Anonymous is 401, a customer is 403, another
 *     tenant is 404 — and a staff member demoted mid-session is 403 on their next request,
 *     because authorization is read from the database rather than the token.
 *  2. **The transition table is enforced.** Every illegal move is a `409` naming both ends,
 *     never a silent no-op.
 *  3. **Concurrency resolves to exactly one transition** — one status change, one history
 *     row, one audit record — even when approve and reject race each other.
 *  4. **Approval does not edit the return.** The frozen refund snapshot is byte-identical
 *     before and after, and the request body cannot carry an amount or a quantity at all.
 */
describe('returns — staff approval and rejection (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const PRICE = '500.0000';
  let fixtureSeq = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: { AUTH_RATE_LIMIT_IP_MAX: '2000', AUTH_RATE_LIMIT_EMAIL_MAX: '2000' },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    /*
     * Seeded ONCE. The container's store resolver caches by slug, so re-seeding between tests
     * would leave it holding an id that no longer exists and every login would 401.
     */
    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /** A signed-in user, optionally promoted to staff. */
  async function signIn(options: { staff?: boolean } = {}): Promise<{ token: string; id: string }> {
    const email = `${options.staff === true ? 'ops' : 'buyer'}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'A', lastName: 'B' },
    });
    if (options.staff === true) {
      // No endpoint grants staff: that would be a privilege-escalation route on a public API.
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { token: login.body.accessToken as string, id: user.id };
  }

  /** A delivered order for a fresh customer, built through the real APIs. */
  async function givenDeliveredOrder(quantity = 3) {
    const ops = await signIn({ staff: true });
    const buyer = await signIn();
    const seq = (fixtureSeq += 1);
    const slug = `staff-p-${String(seq)}`;
    const skuCode = `STAFF-SKU-${String(seq)}`;

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff(ops.token))
          .send({ slug, name: 'Tee', status: 'active' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`/api/v1/admin/products/${slug}/skus`)
          .set(asStaff(ops.token))
          .send({ code: skuCode, price: PRICE })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff(ops.token))
          .send({ skuCode, delta: 50, reason: 'manual_increase' })
      ).status,
    ).toBe(201);

    const buyerHeaders = { Authorization: `Bearer ${buyer.token}` };
    expect(
      (
        await api()
          .put(`/api/v1/users/me/cart/items/${skuCode}`)
          .set(buyerHeaders)
          .send({ quantity })
      ).status,
    ).toBe(200);

    const address = await api().post('/api/v1/users/me/addresses').set(buyerHeaders).send({
      label: 'Home',
      recipientName: 'A B',
      phone: '+91 9876543210',
      line1: '1 Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560025',
    });
    expect(address.status).toBe(201);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(buyerHeaders)
      .set('idempotency-key', `co-${newId()}`)
      .send({ addressId: address.body.address.id });
    expect(checkout.status).toBe(201);

    const number = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, number));

    await db()
      .insert(shipment)
      .values({
        id: newId(),
        storeId,
        orderId: row!.id,
        status: 'delivered',
        carrier: 'Bluedart',
        trackingNumber: `BD-${String(seq)}`,
        trackingUrl: '',
        shippedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });

    const [line] = await db().select().from(orderLine).where(eq(orderLine.orderId, row!.id));

    return {
      staffToken: ops.token,
      staffId: ops.id,
      customerToken: buyer.token,
      orderNumber: number,
      orderId: row!.id,
      skuCode,
      skuId: line!.skuId,
    };
  }

  /** A return in `requested`, plus the actors around it. */
  async function givenRequestedReturn(quantity = 1) {
    const ctx = await givenDeliveredOrder(3);
    const created = await api()
      .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
      .set({ Authorization: `Bearer ${ctx.customerToken}` })
      .set('idempotency-key', `ret-${newId()}`)
      .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity }] });
    expect(created.status).toBe(201);
    return { ...ctx, returnNumber: created.body.return.returnNumber as string };
  }

  beforeEach(async () => {
    const ctx = await givenDeliveredOrder();
    staffToken = ctx.staffToken;
    customerToken = ctx.customerToken;
  });

  /* ══ 1. Authorization ═══════════════════════════════════════════════════ */

  describe('authorization', () => {
    const STAFF_ROUTES = [
      ['get', '/api/v1/admin/returns'],
      ['get', '/api/v1/admin/returns/RET-20260101-ABCDEF'],
      ['post', '/api/v1/admin/returns/RET-20260101-ABCDEF/approve'],
      ['post', '/api/v1/admin/returns/RET-20260101-ABCDEF/reject'],
    ] as const;

    it('rejects every staff route without a token (401)', async () => {
      for (const [method, path] of STAFF_ROUTES) {
        const response = await (method === 'get' ? api().get(path) : api().post(path).send({}));
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });

    it('rejects every staff route for a normal customer (403)', async () => {
      for (const [method, path] of STAFF_ROUTES) {
        const response = await (method === 'get'
          ? api().get(path).set(asCustomer())
          : api().post(path).set(asCustomer()).send({}));
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.body.error.code).toBe('PERMISSION_DENIED');
        expect(response.body.error.details.missing).toEqual(['staff']);
      }
    });

    it('allows staff', async () => {
      const response = await api().get('/api/v1/admin/returns').set(asStaff());
      expect(response.status).toBe(200);
    });

    it('denies a staff member DEMOTED mid-session, on the next request', async () => {
      const ctx = await givenRequestedReturn();
      expect((await api().get('/api/v1/admin/returns').set(asStaff(ctx.staffToken))).status).toBe(
        200,
      );

      // Authorization is read from the database on every request, never from the token.
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, ctx.staffId));

      const after = await api()
        .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
        .set(asStaff(ctx.staffToken))
        .send({});
      expect(after.status).toBe(403);
    });
  });

  /* ══ 2. Read ════════════════════════════════════════════════════════════ */

  describe('read', () => {
    it('lists the store queue with staff-only fields', async () => {
      const ctx = await givenRequestedReturn();

      const list = await api().get('/api/v1/admin/returns').set(asStaff(ctx.staffToken));
      expect(list.status).toBe(200);

      const found = (list.body.returns as { returnNumber: string; staffNote?: string }[]).find(
        (r) => r.returnNumber === ctx.returnNumber,
      );
      expect(found).toBeDefined();
      // The two staff-only additions.
      expect(found).toHaveProperty('staffNote');
      expect(list.body.returns[0].lines[0]).toHaveProperty('restockQuantity');
    });

    it('filters the queue by status', async () => {
      const ctx = await givenRequestedReturn();

      const requested = await api()
        .get('/api/v1/admin/returns')
        .query({ status: 'requested' })
        .set(asStaff(ctx.staffToken));
      expect(requested.status).toBe(200);
      expect(
        (requested.body.returns as { returnNumber: string }[]).some(
          (r) => r.returnNumber === ctx.returnNumber,
        ),
      ).toBe(true);

      const completed = await api()
        .get('/api/v1/admin/returns')
        .query({ status: 'completed' })
        .set(asStaff(ctx.staffToken));
      expect(
        (completed.body.returns as { returnNumber: string }[]).some(
          (r) => r.returnNumber === ctx.returnNumber,
        ),
      ).toBe(false);
    });

    it('rejects an unknown status value', async () => {
      const response = await api()
        .get('/api/v1/admin/returns')
        .query({ status: 'refunded' })
        .set(asStaff());
      expect(response.status).toBe(400);
    });

    it('reads one return, and 404s an unknown number', async () => {
      const ctx = await givenRequestedReturn();

      const read = await api()
        .get(`/api/v1/admin/returns/${ctx.returnNumber}`)
        .set(asStaff(ctx.staffToken));
      expect(read.status).toBe(200);
      expect(read.body.return.returnNumber).toBe(ctx.returnNumber);

      const unknown = await api()
        .get('/api/v1/admin/returns/RET-20200101-ABCDEF')
        .set(asStaff(ctx.staffToken));
      expect(unknown.status).toBe(404);
    });

    it('lets staff read a return raised by a DIFFERENT customer in their store', async () => {
      // Staff act for a tenant, not for one shopper — a colleague's case is theirs to see.
      const ctx = await givenRequestedReturn();

      const read = await api()
        .get(`/api/v1/admin/returns/${ctx.returnNumber}`)
        .set(asStaff(staffToken));
      expect(read.status).toBe(200);
    });
  });

  /* ══ 3. Approve ═════════════════════════════════════════════════════════ */

  describe('approve', () => {
    it('moves requested → approved and records history and audit', async () => {
      const ctx = await givenRequestedReturn();

      const response = await api()
        .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
        .set(asStaff(ctx.staffToken))
        .send({ staffNote: 'looks genuine' });

      expect(response.status).toBe(200);
      expect(response.body.return.status).toBe('approved');
      expect(response.body.return.staffNote).toBe('looks genuine');
      // Not terminal, so it stays open.
      expect(response.body.return.closedAt).toBeNull();

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      expect(header?.status).toBe('approved');

      const events = await db()
        .select()
        .from(returnEvent)
        .where(eq(returnEvent.returnId, header!.id));
      expect(events.map((e) => e.toStatus)).toEqual(['requested', 'approved']);
      expect(events[1]).toMatchObject({
        fromStatus: 'requested',
        actorType: 'staff',
        actorUserId: ctx.staffId,
      });

      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'return.approved'), eq(auditLog.resourceId, header!.id)));
      expect(audits).toHaveLength(1);
    });

    it('does NOT change the frozen refund snapshot', async () => {
      const ctx = await givenRequestedReturn(2);

      const before = await api()
        .get(`/api/v1/admin/returns/${ctx.returnNumber}`)
        .set(asStaff(ctx.staffToken));
      const after = await api()
        .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
        .set(asStaff(ctx.staffToken))
        .send({});

      expect(after.status).toBe(200);
      // Byte-identical: approval agrees to a return, it never edits one.
      expect(after.body.return.refundTaxableValue).toBe(before.body.return.refundTaxableValue);
      expect(after.body.return.refundTaxTotal).toBe(before.body.return.refundTaxTotal);
      expect(after.body.return.refundTotal).toBe(before.body.return.refundTotal);
      expect(after.body.return.lines[0].quantity).toBe(before.body.return.lines[0].quantity);
    });

    it('rejects a body carrying an amount, a status or a quantity', async () => {
      const ctx = await givenRequestedReturn();

      for (const extra of [
        { refundTotal: '9999.0000' },
        { status: 'completed' },
        { quantity: 99 },
        { storeId: newId() },
        { approvedAt: new Date().toISOString() },
      ]) {
        const response = await api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
          .set(asStaff(ctx.staffToken))
          .send(extra);
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
    });

    it('refuses to approve twice', async () => {
      const ctx = await givenRequestedReturn();
      expect(
        (
          await api()
            .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
            .set(asStaff(ctx.staffToken))
            .send({})
        ).status,
      ).toBe(200);

      const second = await api()
        .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
        .set(asStaff(ctx.staffToken))
        .send({});
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('RETURN_NOT_TRANSITIONABLE');
      expect(second.body.error.details).toMatchObject({ from: 'approved', to: 'approved' });
    });

    it('refuses to approve a rejected, cancelled, received, inspected or completed return', async () => {
      for (const status of [
        'rejected',
        'cancelled',
        'received',
        'inspected',
        'completed',
      ] as const) {
        const ctx = await givenRequestedReturn();
        const terminal = ['rejected', 'cancelled', 'completed'].includes(status);
        await db()
          .update(returnRequest)
          .set({ status, closedAt: terminal ? new Date() : null })
          .where(eq(returnRequest.returnNumber, ctx.returnNumber));

        const response = await api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
          .set(asStaff(ctx.staffToken))
          .send({});
        expect(response.status, status).toBe(409);
      }
    });
  });

  /* ══ 4. Reject ══════════════════════════════════════════════════════════ */

  describe('reject', () => {
    it('moves requested → rejected, closes it, and records history and audit', async () => {
      const ctx = await givenRequestedReturn();

      const response = await api()
        .post(`/api/v1/admin/returns/${ctx.returnNumber}/reject`)
        .set(asStaff(ctx.staffToken))
        .send({ staffNote: 'outside policy' });

      expect(response.status).toBe(200);
      expect(response.body.return.status).toBe('rejected');
      // Terminal, so it carries a closing instant.
      expect(response.body.return.closedAt).not.toBeNull();

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'return.rejected'), eq(auditLog.resourceId, header!.id)));
      expect(audits).toHaveLength(1);
    });

    it('RELEASES the quantity so the customer can return the units again', async () => {
      const ctx = await givenRequestedReturn(3);
      const buyer = { Authorization: `Bearer ${ctx.customerToken}` };

      // All three are spoken for while the return is outstanding.
      const blocked = await api()
        .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
        .set(buyer)
        .set('idempotency-key', `blk-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity: 1 }] });
      expect(blocked.status).toBe(422);

      expect(
        (
          await api()
            .post(`/api/v1/admin/returns/${ctx.returnNumber}/reject`)
            .set(asStaff(ctx.staffToken))
            .send({})
        ).status,
      ).toBe(200);

      const again = await api()
        .post(`/api/v1/users/me/orders/${ctx.orderNumber}/returns`)
        .set(buyer)
        .set('idempotency-key', `again-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode: ctx.skuCode, quantity: 3 }] });
      expect(again.status).toBe(201);
    });

    it('refuses to reject an already rejected or cancelled return', async () => {
      for (const status of ['rejected', 'cancelled'] as const) {
        const ctx = await givenRequestedReturn();
        await db()
          .update(returnRequest)
          .set({ status, closedAt: new Date() })
          .where(eq(returnRequest.returnNumber, ctx.returnNumber));

        const response = await api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/reject`)
          .set(asStaff(ctx.staffToken))
          .send({});
        expect(response.status, status).toBe(409);
      }
    });
  });

  /* ══ 5. Concurrency ═════════════════════════════════════════════════════ */

  describe('concurrency', () => {
    it('lets exactly ONE of two concurrent approvals win', async () => {
      const ctx = await givenRequestedReturn();

      const results = await Promise.all([
        api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
          .set(asStaff(ctx.staffToken))
          .send({}),
        api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
          .set(asStaff(ctx.staffToken))
          .send({}),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      const events = await db()
        .select()
        .from(returnEvent)
        .where(and(eq(returnEvent.returnId, header!.id), eq(returnEvent.toStatus, 'approved')));
      // One transition, one history row — never two.
      expect(events).toHaveLength(1);

      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'return.approved'), eq(auditLog.resourceId, header!.id)));
      expect(audits).toHaveLength(1);
    });

    it('lets exactly ONE of a concurrent approve and reject win', async () => {
      const ctx = await givenRequestedReturn();

      const [approved, rejected] = await Promise.all([
        api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
          .set(asStaff(ctx.staffToken))
          .send({}),
        api()
          .post(`/api/v1/admin/returns/${ctx.returnNumber}/reject`)
          .set(asStaff(ctx.staffToken))
          .send({}),
      ]);

      const statuses = [approved.status, rejected.status].sort();
      expect(statuses).toEqual([200, 409]);

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, ctx.returnNumber));
      // Whichever won, the row holds exactly one of the two outcomes.
      expect(['approved', 'rejected']).toContain(header?.status);

      const events = await db()
        .select()
        .from(returnEvent)
        .where(eq(returnEvent.returnId, header!.id));
      // Creation plus exactly one staff decision.
      expect(events).toHaveLength(2);
    });
  });

  /* ══ 6. Tenant isolation ════════════════════════════════════════════════ */

  describe('tenant isolation', () => {
    it('scopes the queue and the decisions to the caller own store', async () => {
      const ctx = await givenRequestedReturn();

      /*
       * The store comes from the verified token, never the request, so there is no header or
       * body field a caller could use to reach another tenant. The guarantee is asserted at
       * the repository level in `tests/audit/tenant-isolation.test.ts`, where two stores can
       * be built without defeating the container's store-resolver cache.
       */
      const read = await api()
        .get(`/api/v1/admin/returns/${ctx.returnNumber}`)
        .set(asStaff(ctx.staffToken));
      expect(read.status).toBe(200);
      expect(read.body.return).not.toHaveProperty('storeId');
      expect(read.body.return).not.toHaveProperty('userId');
    });

    it('404s a well-formed return number that does not exist', async () => {
      const response = await api()
        .post('/api/v1/admin/returns/RET-20200101-ZZZZZZ/approve')
        .set(asStaff())
        .send({});
      expect(response.status).toBe(404);
    });
  });
});
