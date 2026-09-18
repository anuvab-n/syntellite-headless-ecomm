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

  /* ── GET /admin/returns/summary ───────────────────────────────────────── */

  /**
   * Return counts by status. Increment 53.
   *
   * The arithmetic is what makes the tile trustworthy: each bucket must equal what
   * `GET /admin/returns?status=…` reports, because a dashboard that disagrees with the page it
   * links to is worse than no dashboard.
   *
   * Tenancy is proven against a REAL foreign row. This suite cannot build a second store over
   * HTTP — the container caches its store resolver, as the block above records — so the foreign
   * return is cloned straight into the database. That is enough here: the summary never resolves
   * a store from a request, it takes one from the token, so the only question is whether the
   * query filters by it.
   */
  describe('operational summary', () => {
    let foreignReturnCreated = false;

    beforeAll(async () => {
      const ctx = await givenRequestedReturn();
      const pool = container.db.pool;

      const otherStoreId = newId();
      const otherUserId = newId();

      await pool.query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Summary Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `sum-other-${otherStoreId.slice(0, 8)}`],
      );
      await pool.query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'argon2-placeholder', 'Foreign', 'Returner')`,
        [otherUserId, otherStoreId, `foreign.sum.${otherUserId}@example.com`],
      );

      /* Clone the order and the return, moving both to the other store. */
      const clone = async (
        table: string,
        keyColumn: string,
        keyValue: string,
        overrides: Record<string, unknown>,
      ): Promise<void> => {
        const { rows } = await pool.query<Record<string, unknown>>(
          `select * from "${table}" where "${keyColumn}" = $1`,
          [keyValue],
        );
        const row = rows[0];
        expect(row, `no ${table} row for ${keyValue}`).toBeDefined();
        if (!row) return;
        const merged = { ...row, ...overrides };
        const columns = Object.keys(merged);
        await pool.query(
          `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
           values (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
          columns.map((c) => merged[c]),
        );
      };

      const { rows: src } = await pool.query<Record<string, unknown>>(
        'select * from return_request where return_number = $1',
        [ctx.returnNumber],
      );
      const source = src[0];
      expect(source).toBeDefined();
      if (!source) return;

      const foreignOrderId = newId();
      const foreignCartId = newId();
      await clone('cart', 'id', String((await orderRow(String(source['order_id'])))['cart_id']), {
        id: foreignCartId,
        store_id: otherStoreId,
        user_id: otherUserId,
      });
      await clone('order', 'id', String(source['order_id']), {
        id: foreignOrderId,
        store_id: otherStoreId,
        user_id: otherUserId,
        cart_id: foreignCartId,
        address_id: null,
        order_number: 'ORD-20260101-FFFFFF',
      });
      await clone('return_request', 'return_number', ctx.returnNumber, {
        id: newId(),
        store_id: otherStoreId,
        user_id: otherUserId,
        order_id: foreignOrderId,
        return_number: 'RET-20260101-FFFFFF',
      });

      foreignReturnCreated = true;

      async function orderRow(id: string): Promise<Record<string, unknown>> {
        const { rows } = await pool.query<Record<string, unknown>>(
          'select * from "order" where id = $1',
          [id],
        );
        return rows[0] ?? {};
      }
    }, 300_000);

    const summary = () => api().get('/api/v1/admin/returns/summary').set(asStaff());

    it('refuses an anonymous request with 401', async () => {
      expect((await api().get('/api/v1/admin/returns/summary')).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect((await api().get('/api/v1/admin/returns/summary').set(asCustomer())).status).toBe(403);
    });

    it('serves active staff with 200', async () => {
      expect((await summary()).status).toBe(200);
    });

    it('returns every return status, including the ones at zero', async () => {
      const body = (await summary()).body.returns as { byStatus: Record<string, number> };
      expect(Object.keys(body.byStatus).sort()).toEqual([
        'approved',
        'cancelled',
        'completed',
        'inspected',
        'received',
        'rejected',
        'requested',
      ]);
      for (const n of Object.values(body.byStatus)) expect(Number.isInteger(n)).toBe(true);
    });

    it('agrees exactly with the staff return queue, bucket by bucket', async () => {
      const body = (await summary()).body.returns as { byStatus: Record<string, number> };

      for (const [status, expected] of Object.entries(body.byStatus)) {
        const res = await api()
          .get(`/api/v1/admin/returns?limit=1&status=${status}`)
          .set(asStaff());
        expect(res.status).toBe(200);
        // This list predates the shared `pagination` envelope and reports a flat `total`.
        expect(res.body.total, `status=${status}`).toBe(expected);
      }
    });

    it('counts only this store’s returns', async () => {
      expect(foreignReturnCreated).toBe(true);

      const body = (await summary()).body.returns as { byStatus: Record<string, number> };
      const summed = Object.values(body.byStatus).reduce((a, b) => a + b, 0);

      const { rows } = await container.db.pool.query<{ c: string }>(
        'select count(*)::text c from return_request where store_id = $1',
        [storeId],
      );
      expect(summed).toBe(Number(rows[0]?.c ?? '0'));

      const { rows: foreign } = await container.db.pool.query<{ c: string }>(
        'select count(*)::text c from return_request where store_id <> $1',
        [storeId],
      );
      expect(Number(foreign[0]?.c ?? '0')).toBeGreaterThan(0);
    });

    it('writes nothing', async () => {
      const countOf = async (sql: string): Promise<string> => {
        const { rows } = await container.db.pool.query<{ c: string }>(sql);
        return rows[0]?.c ?? '?';
      };
      const snapshot = async () => ({
        returns: await countOf('select count(*)::text c from return_request'),
        events: await countOf('select count(*)::text c from return_event'),
        audits: await countOf('select count(*)::text c from audit_log'),
        outbox: await countOf('select count(*)::text c from outbox_event'),
      });

      const before = await snapshot();
      await summary();
      await summary();
      expect(await snapshot()).toEqual(before);
    });
  });

  /* ══ 6. The admin queue: search, dates, projection. Increment 61. ══════ */

  describe('the admin queue', () => {
    const list = (query = '') => api().get(`/api/v1/admin/returns${query}`).set(asStaff());

    const returnRow = async (returnNumber: string) => {
      const [row] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, returnNumber));
      return row!;
    };

    it('projects the customer onto every row, with no internal ids', async () => {
      const ctx = await givenRequestedReturn();

      const response = await list();
      expect(response.status).toBe(200);

      const row = (response.body.returns as Record<string, unknown>[]).find(
        (r) => r['returnNumber'] === ctx.returnNumber,
      );
      expect(row).toBeDefined();
      expect(row!['customer']).toEqual({
        email: expect.stringContaining('@example.com'),
        firstName: 'A',
        lastName: 'B',
      });

      expect(JSON.stringify(row)).not.toContain(ctx.orderId);
      expect(JSON.stringify(row)).not.toContain(ctx.skuId);
    });

    it('orders deterministically by requestedAt then returnNumber, newest first', async () => {
      await givenRequestedReturn();
      await givenRequestedReturn();

      const rows = (await list('?limit=50')).body.returns as {
        requestedAt: string;
        returnNumber: string;
      }[];
      expect(rows.length).toBeGreaterThanOrEqual(2);

      const sorted = [...rows].sort((a, b) =>
        a.requestedAt === b.requestedAt
          ? b.returnNumber.localeCompare(a.returnNumber)
          : b.requestedAt.localeCompare(a.requestedAt),
      );
      expect(rows).toEqual(sorted);
    });

    it('paginates with a total that agrees with the filter', async () => {
      await givenRequestedReturn();
      await givenRequestedReturn();

      const page = (await list('?limit=1&offset=0')).body;
      expect(page.returns).toHaveLength(1);
      expect(page.limit).toBe(1);
      expect(page.offset).toBe(0);
      expect(page.total).toBeGreaterThanOrEqual(2);

      const second = (await list('?limit=1&offset=1')).body;
      expect(second.total).toBe(page.total);
      expect(second.returns[0].returnNumber).not.toBe(page.returns[0].returnNumber);
    });

    it('filters by status', async () => {
      const ctx = await givenRequestedReturn();
      expect(
        (
          await api()
            .post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`)
            .set(asStaff())
            .send({})
        ).status,
      ).toBe(200);

      const approved = (await list('?status=approved&limit=50')).body.returns as {
        returnNumber: string;
        status: string;
      }[];
      expect(approved.every((r) => r.status === 'approved')).toBe(true);
      expect(approved.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);

      const requested = (await list('?status=requested&limit=50')).body.returns as {
        returnNumber: string;
      }[];
      expect(requested.some((r) => r.returnNumber === ctx.returnNumber)).toBe(false);
    });

    it('finds a return by its exact number, and by a substring of it', async () => {
      const ctx = await givenRequestedReturn();

      const exact = (await list(`?q=${ctx.returnNumber}`)).body.returns as {
        returnNumber: string;
      }[];
      expect(exact).toHaveLength(1);
      expect(exact[0]!.returnNumber).toBe(ctx.returnNumber);

      /* Contains, not prefix: the distinctive tail alone finds it. */
      const partial = (await list(`?q=${ctx.returnNumber.slice(-6)}`)).body.returns as {
        returnNumber: string;
      }[];
      expect(partial.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);
    });

    it('finds a return by its order number', async () => {
      const ctx = await givenRequestedReturn();

      const rows = (await list(`?q=${ctx.orderNumber}`)).body.returns as {
        returnNumber: string;
        orderNumber: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orderNumber).toBe(ctx.orderNumber);
    });

    it('finds a return by the customer email', async () => {
      const ctx = await givenRequestedReturn();
      const detail = await api().get(`/api/v1/admin/returns/${ctx.returnNumber}`).set(asStaff());
      const email = detail.body.return.customer.email as string;

      const rows = (await list(`?q=${encodeURIComponent(email)}`)).body.returns as {
        returnNumber: string;
      }[];
      expect(rows.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);
    });

    it('finds a return by a SKU code on one of its lines, without duplicating the row', async () => {
      const ctx = await givenRequestedReturn();

      const body = (await list(`?q=${ctx.skuCode}&limit=50`)).body;
      const matching = (body.returns as { returnNumber: string }[]).filter(
        (r) => r.returnNumber === ctx.returnNumber,
      );
      /*
       * EXACTLY one row. The SKU arm is an EXISTS rather than a join for this reason: a join
       * would emit one row per matching line and inflate both the page and the total.
       */
      expect(matching).toHaveLength(1);
      expect(body.total).toBe((body.returns as unknown[]).length);
    });

    it('treats LIKE wildcards in the search term as literal characters', async () => {
      await givenRequestedReturn();

      /* An unescaped `%` would match every return in the store. */
      expect((await list('?q=%25&limit=50')).body.returns).toEqual([]);
      expect((await list('?q=_&limit=50')).body.returns).toEqual([]);
    });

    it('returns an empty page rather than an error when nothing matches', async () => {
      const body = (await list('?q=NO-SUCH-RETURN-ANYWHERE')).body;
      expect(body.returns).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('filters by requestedFrom', async () => {
      const ctx = await givenRequestedReturn();
      const row = await returnRow(ctx.returnNumber);

      const after = new Date(row.requestedAt.getTime() + 1000).toISOString();
      const excluded = (await list(`?requestedFrom=${encodeURIComponent(after)}&limit=50`)).body
        .returns as { returnNumber: string }[];
      expect(excluded.some((r) => r.returnNumber === ctx.returnNumber)).toBe(false);

      const at = row.requestedAt.toISOString();
      const included = (await list(`?requestedFrom=${encodeURIComponent(at)}&limit=50`)).body
        .returns as { returnNumber: string }[];
      expect(included.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);
    });

    it('includes the whole millisecond named by requestedTo', async () => {
      const ctx = await givenRequestedReturn();
      const row = await returnRow(ctx.returnNumber);

      /*
       * The bound is the return's OWN published timestamp, which `toISOString()` truncates to
       * milliseconds. A plain `<=` would drop the row whenever the stored microseconds are
       * non-zero — the exact bug `exclusiveEndOfMillisecond` exists to prevent, and the reason
       * this asserts against the value a client would copy off the response.
       */
      const bound = row.requestedAt.toISOString();
      const rows = (await list(`?requestedTo=${encodeURIComponent(bound)}&limit=50`)).body
        .returns as { returnNumber: string }[];
      expect(rows.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);
    });

    it('excludes a return one millisecond before its own requestedAt', async () => {
      const ctx = await givenRequestedReturn();
      const row = await returnRow(ctx.returnNumber);

      const before = new Date(row.requestedAt.getTime() - 1).toISOString();
      const rows = (await list(`?requestedTo=${encodeURIComponent(before)}&limit=50`)).body
        .returns as { returnNumber: string }[];
      expect(rows.some((r) => r.returnNumber === ctx.returnNumber)).toBe(false);
    });

    it('combines a date window with a status filter', async () => {
      const ctx = await givenRequestedReturn();
      const row = await returnRow(ctx.returnNumber);
      const at = encodeURIComponent(row.requestedAt.toISOString());

      const rows = (await list(`?status=requested&requestedFrom=${at}&requestedTo=${at}&limit=50`))
        .body.returns as { returnNumber: string }[];
      expect(rows.some((r) => r.returnNumber === ctx.returnNumber)).toBe(true);
    });

    it('rejects an unknown query field', async () => {
      expect((await list('?storeId=whatever')).status).toBe(400);
      expect((await list('?sort=asc')).status).toBe(400);
    });

    it('rejects a malformed date and an out-of-range search term', async () => {
      /* A date-only bound is refused rather than silently widened into a timezone. */
      expect((await list('?requestedFrom=2026-09-01')).status).toBe(400);
      expect((await list('?requestedTo=not-a-date')).status).toBe(400);
      expect((await list(`?q=${'x'.repeat(321)}`)).status).toBe(400);
      expect((await list('?q=')).status).toBe(400);
    });
  });

  /* ══ 7. The admin detail. Increment 61. ════════════════════════════════ */

  describe('the admin detail', () => {
    const detailOf = (returnNumber: string) =>
      api().get(`/api/v1/admin/returns/${returnNumber}`).set(asStaff());

    const returnRow = async (returnNumber: string) => {
      const [row] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, returnNumber));
      return row!;
    };

    it('publishes the customer, the order snapshot address and the delivery fact', async () => {
      const ctx = await givenRequestedReturn();

      const response = await detailOf(ctx.returnNumber);
      expect(response.status).toBe(200);
      const body = response.body.return;

      expect(body.customer).toEqual({
        email: expect.stringContaining('@example.com'),
        firstName: 'A',
        lastName: 'B',
      });

      const [orderRow] = await db().select().from(order).where(eq(order.id, ctx.orderId));
      expect(body.shippingAddress).toEqual({
        recipientName: orderRow!.shipRecipientName,
        phone: orderRow!.shipPhone,
        line1: orderRow!.shipLine1,
        line2: orderRow!.shipLine2,
        landmark: orderRow!.shipLandmark,
        city: orderRow!.shipCity,
        state: orderRow!.shipState,
        postalCode: orderRow!.shipPostalCode,
        countryCode: orderRow!.shipCountryCode,
      });

      expect(body.deliveredAt).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain(ctx.orderId);
      expect(JSON.stringify(body)).not.toContain(ctx.skuId);
    });

    it('reads the order snapshot, so a later edit to it is what moves the address', async () => {
      const ctx = await givenRequestedReturn();
      const before = (await detailOf(ctx.returnNumber)).body.return.shippingAddress;

      await db().update(order).set({ shipCity: 'SomewhereElse' }).where(eq(order.id, ctx.orderId));

      const after = (await detailOf(ctx.returnNumber)).body.return.shippingAddress;
      expect(after.city).toBe('SomewhereElse');
      expect(before.city).not.toBe(after.city);
    });

    it('publishes the append-only lifecycle timeline, oldest first', async () => {
      const ctx = await givenRequestedReturn();
      await api().post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`).set(asStaff()).send({});
      await api().post(`/api/v1/admin/returns/${ctx.returnNumber}/receive`).set(asStaff()).send({});

      const timeline = (await detailOf(ctx.returnNumber)).body.return.timeline as {
        fromStatus: string | null;
        toStatus: string;
        actorType: string;
        at: string;
      }[];

      expect(timeline.map((e) => e.toStatus)).toEqual(['requested', 'approved', 'received']);
      expect(timeline[0]!.fromStatus).toBeNull();
      expect(timeline[1]!.fromStatus).toBe('requested');
      expect(timeline[1]!.actorType).toBe('staff');

      const times = timeline.map((e) => Date.parse(e.at));
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      /* Actor USER ids are never published on this read. */
      expect(JSON.stringify(timeline)).not.toContain(ctx.staffId);
    });

    it('agrees exactly with the stored return_event rows', async () => {
      const ctx = await givenRequestedReturn();
      await api().post(`/api/v1/admin/returns/${ctx.returnNumber}/approve`).set(asStaff()).send({});

      const row = await returnRow(ctx.returnNumber);
      const stored = await db().select().from(returnEvent).where(eq(returnEvent.returnId, row.id));

      const timeline = (await detailOf(ctx.returnNumber)).body.return.timeline as unknown[];
      expect(timeline).toHaveLength(stored.length);
    });

    it('publishes the product name, inspection counts and remaining returnable quantity', async () => {
      /* Three ordered, one returned: two units must still be returnable. */
      const ctx = await givenRequestedReturn(1);

      const lines = (await detailOf(ctx.returnNumber)).body.return.lines as {
        skuCode: string;
        productName: string;
        quantity: number;
        restockQuantity: number;
        writeOffQuantity: number;
        remainingReturnable: number;
      }[];

      expect(lines).toHaveLength(1);
      expect(lines[0]!.skuCode).toBe(ctx.skuCode);
      expect(lines[0]!.productName.length).toBeGreaterThan(0);
      expect(lines[0]!.quantity).toBe(1);
      expect(lines[0]!.restockQuantity).toBe(0);
      expect(lines[0]!.writeOffQuantity).toBe(0);
      expect(lines[0]!.remainingReturnable).toBe(2);
    });

    it('keeps money as strings, never as numbers', async () => {
      const ctx = await givenRequestedReturn();
      const body = (await detailOf(ctx.returnNumber)).body.return;

      for (const field of ['refundTotal', 'refundTaxableValue', 'refundTaxTotal']) {
        expect(typeof body[field]).toBe('string');
        expect(body[field]).toMatch(/^\d+\.\d{4}$/);
      }
      expect(typeof body.lines[0].refundTotal).toBe('string');
    });

    it('publishes an empty refunds array before a refund is ever raised', async () => {
      const ctx = await givenRequestedReturn();
      expect((await detailOf(ctx.returnNumber)).body.return.refunds).toEqual([]);
    });

    it('404s an unknown return number', async () => {
      expect((await detailOf('RET-20260101-ZZZZZZ')).status).toBe(404);
    });
  });

  /* ══ 8. The new surfaces leak no tenancy. Increment 61. ════════════════ */

  describe('tenancy on the new surfaces', () => {
    /*
     * Cross-TENANT search is asserted in `returns-repository.integration.test.ts`, where two
     * stores can be built directly — the container's store-resolver cache makes a second tenant
     * unreachable over HTTP in this harness, which is the same reason the existing store-scoping
     * test above stops where it does.
     *
     * What IS assertable here: no tenancy identifier reaches a response.
     */
    it('publishes no store or user identifier on the queue or the detail', async () => {
      const ctx = await givenRequestedReturn();

      const row = (
        (await api().get('/api/v1/admin/returns?limit=50').set(asStaff())).body.returns as Record<
          string,
          unknown
        >[]
      ).find((r) => r['returnNumber'] === ctx.returnNumber);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('storeId');
      expect(row).not.toHaveProperty('userId');
      expect(row!['customer']).not.toHaveProperty('id');

      const detail = (await api().get(`/api/v1/admin/returns/${ctx.returnNumber}`).set(asStaff()))
        .body.return;
      expect(detail).not.toHaveProperty('storeId');
      expect(detail).not.toHaveProperty('userId');
      expect(detail.customer).not.toHaveProperty('id');
      expect(JSON.stringify(detail)).not.toContain(storeId);
    });
  });
});
