import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { returnEvent, returnLine, returnRequest } from '../../../db/schema/returns.js';
import { order, orderLine } from '../../../db/schema/orders.js';
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
 * Increment 40c — customer return creation, read and cancellation.
 *
 * Against the REAL composition root, a real PostgreSQL and a real Redis. Not a hand-wired
 * subset: the point of this increment is that returns reaches orders and fulfilment through
 * PORTS the container supplies, and a test that wired its own doubles would prove the doubles
 * work rather than the wiring.
 *
 * Five properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **The money is the frozen snapshot.** Changing the SKU price after delivery must not
 *     change what a return credits — asserted by mutating the catalogue between the order and
 *     the return.
 *  2. **The cumulative cap holds under genuine concurrency**, on separate pool connections.
 *     Two requests for the last unit produce exactly one return.
 *  3. **Eligibility is server-derived.** Delivery comes from `shipment.delivered_at`; no
 *     request body can supply or move it.
 *  4. **Isolation is a 404, not a 403.** Another customer's return is indistinguishable from
 *     one that does not exist.
 *  5. **Every transition leaves an append-only event AND an audit row**, exactly once.
 */
describe('returns — customer (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let customerToken = '';
  let customerId = '';
  let orderNumber = '';
  let orderId = '';
  let skuIdSmall = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU = 'RET-TEE-S';
  const PRICE = '500.0000';

  /** Monotonic, so two fixtures in the same millisecond cannot collide on a slug. */
  let fixtureSeq = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asCustomer = (token = customerToken) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        // A long sequential suite authenticates far more than the production default allows.
        extraEnv: { AUTH_RATE_LIMIT_IP_MAX: '2000', AUTH_RATE_LIMIT_EMAIL_MAX: '2000' },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    /*
     * Seeded ONCE, not per test.
     *
     * The container's store resolver caches the resolved store by slug, so truncating and
     * re-seeding between tests would leave it holding an id that no longer exists — every
     * subsequent login then 401s against a store that was deleted underneath it. Isolation
     * comes from each test creating its own customer and order instead, which is also
     * closer to how the system actually runs.
     */
    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /** A staff token, minted once per test, for the admin fixtures below. */
  async function givenStaffToken(): Promise<string> {
    const email = `ops.${newId()}@example.com`;
    const staff = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ops', lastName: 'Staff' },
    });
    // No endpoint grants staff: that would be a privilege-escalation route on a public API.
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staff.id));
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return login.body.accessToken as string;
  }

  /**
   * A customer with a DELIVERED order.
   *
   * Built through the real admin and customer APIs rather than by reaching into services,
   * so the fixture exercises the same contracts a merchant and a shopper would. Only the
   * shipment row is written directly: fulfilment owns its transitions, 40c does not touch
   * them, and what matters here is that a delivered shipment exists with an instant.
   */
  async function givenDeliveredOrder(options: { quantity?: number } = {}) {
    const quantity = options.quantity ?? 3;
    const staffToken = await givenStaffToken();
    const asStaff = { Authorization: `Bearer ${staffToken}` };

    const email = `ret.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;
    const asBuyer = { Authorization: `Bearer ${token}` };

    /*
     * A counter, NOT a slice of `newId()`.
     *
     * Ids here are UUIDv7, whose leading characters are a millisecond timestamp — two fixtures
     * built in the same millisecond produced the same slug and the second got a `409`.
     */
    const seq = (fixtureSeq += 1);
    const slug = `p-${String(seq)}`;
    const skuCode = `${SKU}-${String(seq)}`.toUpperCase();

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asStaff)
      .send({ slug, name: 'Tee', status: 'active' });
    expect(product.status).toBe(201);

    const sku = await api()
      .post(`/api/v1/admin/products/${slug}/skus`)
      .set(asStaff)
      .send({ code: skuCode, price: PRICE });
    expect(sku.status).toBe(201);

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff)
      .send({ skuCode, delta: 50, reason: 'manual_increase' });
    expect(stocked.status).toBe(201);

    const added = await api()
      .put(`/api/v1/users/me/cart/items/${skuCode}`)
      .set(asBuyer)
      .send({ quantity });
    expect(added.status).toBe(200);

    const address = await api().post('/api/v1/users/me/addresses').set(asBuyer).send({
      label: 'Home',
      recipientName: 'Ada Lovelace',
      phone: '+91 9876543210',
      line1: '12 Residency Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560025',
    });
    expect(address.status).toBe(201);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asBuyer)
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
        // `uq_shipment_tracking` is (store, carrier, trackingNumber) — one per fixture.
        trackingNumber: `BD-${String(seq)}`,
        trackingUrl: '',
        shippedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });

    const [line] = await db().select().from(orderLine).where(eq(orderLine.orderId, row!.id));

    return {
      token,
      userId: user.id,
      orderNumber: number,
      orderId: row!.id,
      skuCode,
      skuId: line!.skuId,
    };
  }
  beforeEach(async () => {
    const seeded = await givenDeliveredOrder();
    customerToken = seeded.token;
    customerId = seeded.userId;
    orderNumber = seeded.orderNumber;
    orderId = seeded.orderId;
    skuIdSmall = seeded.skuId;
    currentSku = seeded.skuCode;
  });

  let currentSku = '';

  const createReturn = (
    body: Record<string, unknown>,
    opts: { token?: string; key?: string; orderNumber?: string } = {},
  ) =>
    api()
      .post(`/api/v1/users/me/orders/${opts.orderNumber ?? orderNumber}/returns`)
      .set(asCustomer(opts.token ?? customerToken))
      .set('idempotency-key', opts.key ?? `ret-${newId()}`)
      .send(body);

  const oneUnit = (quantity = 1) => ({
    reason: 'defective',
    lines: [{ skuCode: currentSku, quantity }],
  });

  /* ══ 1. Creation ════════════════════════════════════════════════════════ */

  describe('creation', () => {
    it('creates a return and freezes the apportioned money', async () => {
      const response = await createReturn(oneUnit(1));

      expect(response.status).toBe(201);
      const created = response.body.return;
      expect(created.returnNumber).toMatch(/^RET-\d{8}-[A-Z2-9]{6}$/u);
      expect(created.status).toBe('requested');
      expect(created.orderNumber).toBe(orderNumber);
      expect(created.lines).toHaveLength(1);
      expect(created.lines[0]).toMatchObject({ skuCode: currentSku, quantity: 1 });
      // One of three units of a 1500.0000 line.
      expect(created.lines[0].lineTotal).toBe('500.0000');
      expect(created.refundTotal).toBe(created.lines[0].refundTotal);
      // The response must not leak the merchant's internal note.
      expect(created).not.toHaveProperty('staffNote');
    });

    it('persists the header, lines and the creation event', async () => {
      const response = await createReturn(oneUnit(2));
      expect(response.status).toBe(201);

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, response.body.return.returnNumber));
      expect(header?.userId).toBe(customerId);
      expect(header?.orderId).toBe(orderId);
      expect(header?.status).toBe('requested');
      expect(header?.closedAt).toBeNull();

      const lines = await db().select().from(returnLine).where(eq(returnLine.returnId, header!.id));
      expect(lines).toHaveLength(1);
      expect(lines[0]?.quantity).toBe(2);
      expect(lines[0]?.skuId).toBe(skuIdSmall);
      // Untouched until inspection, which is 40e.
      expect(lines[0]?.restockQuantity).toBe(0);

      const events = await db()
        .select()
        .from(returnEvent)
        .where(eq(returnEvent.returnId, header!.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'requested',
        actorType: 'customer',
      });
    });

    it('writes exactly one audit row', async () => {
      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(201);

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, response.body.return.returnNumber));
      const rows = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'return.requested'), eq(auditLog.resourceId, header!.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resourceType).toBe('return');
    });

    it('uses the FROZEN price even after the catalogue changes', async () => {
      // Reprice the SKU to a tenth of what was paid. The refund must not move.
      const staffToken = await givenStaffToken();
      const repriced = await api()
        .patch(`/api/v1/admin/skus/${currentSku}`)
        .set({ Authorization: `Bearer ${staffToken}` })
        .send({ price: '50.0000' });
      expect(repriced.status).toBe(200);

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(201);
      // 500, the price at checkout — not 50, the price now.
      expect(response.body.return.lines[0].lineTotal).toBe('500.0000');
    });
  });

  /* ══ 2. Eligibility ═════════════════════════════════════════════════════ */

  describe('eligibility', () => {
    it('refuses an order that has not been delivered', async () => {
      await db().delete(shipment).where(eq(shipment.orderId, orderId));

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('ORDER_NOT_RETURNABLE');
      expect(response.body.error.details.reason).toBe('not_delivered');
    });

    it('refuses a shipment that is still in transit', async () => {
      await db()
        .update(shipment)
        .set({ status: 'shipped', deliveredAt: null })
        .where(eq(shipment.orderId, orderId));

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('not_delivered');
    });

    it('refuses a delivery older than the 7-day window', async () => {
      await db()
        .update(shipment)
        .set({
          // Both, together: ck_shipment_delivered_after_shipped forbids delivery first.
          shippedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
          deliveredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        })
        .where(eq(shipment.orderId, orderId));

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('window_closed');
    });

    it('accepts a delivery just inside the window', async () => {
      await db()
        .update(shipment)
        .set({
          shippedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          deliveredAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        })
        .where(eq(shipment.orderId, orderId));

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(201);
    });

    it('refuses a cancelled order', async () => {
      await db().update(order).set({ status: 'cancelled' }).where(eq(order.id, orderId));

      const response = await createReturn(oneUnit(1));
      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('cancelled');
    });

    it('refuses a SKU that is not on the order', async () => {
      const response = await createReturn({
        reason: 'defective',
        lines: [{ skuCode: 'NOT-ON-THIS-ORDER', quantity: 1 }],
      });

      expect(response.status).toBe(422);
      expect(response.body.error.details.reason).toBe('unknown_sku');
    });

    it('404s an unknown order number', async () => {
      const response = await createReturn(oneUnit(1), {
        orderNumber: 'ORD-20200101-ABCDEF',
      });
      expect(response.status).toBe(404);
    });
  });

  /* ══ 3. Quantity ════════════════════════════════════════════════════════ */

  describe('quantity', () => {
    it('refuses more units than were ordered', async () => {
      const response = await createReturn(oneUnit(4));

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('RETURN_QUANTITY_UNAVAILABLE');
      expect(response.body.error.details).toMatchObject({ requested: 4, remaining: 3 });
    });

    it('accumulates across sequential returns until the line is exhausted', async () => {
      expect((await createReturn(oneUnit(1))).status).toBe(201);
      expect((await createReturn(oneUnit(1))).status).toBe(201);
      expect((await createReturn(oneUnit(1))).status).toBe(201);

      // Three of three are now spoken for.
      const fourth = await createReturn(oneUnit(1));
      expect(fourth.status).toBe(422);
      expect(fourth.body.error.details.remaining).toBe(0);
    });

    it('refunds exactly the line across sequential partial returns', async () => {
      const first = await createReturn(oneUnit(1));
      const second = await createReturn(oneUnit(2));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const minor = (v: string) => BigInt(v.replace('.', ''));
      const total = minor(first.body.return.refundTotal) + minor(second.body.return.refundTotal);
      // 1500.0000 of goods, no tax configured in this suite.
      expect(total).toBe(minor('1500.0000'));
    });

    it('releases quantity when an earlier return was REJECTED', async () => {
      const first = await createReturn(oneUnit(3));
      expect(first.status).toBe(201);

      // A refused return consumed nothing: no refund, no restock, no physical return.
      await db()
        .update(returnRequest)
        .set({ status: 'rejected', closedAt: new Date() })
        .where(eq(returnRequest.returnNumber, first.body.return.returnNumber));

      const second = await createReturn(oneUnit(3));
      expect(second.status).toBe(201);
    });

    /**
     * A CANCELLED return releases its units, exactly as a rejected one does.
     *
     * The customer withdrew before the goods were ever received: nothing came back and nothing
     * was refunded, so nothing may be permanently deducted from what they can still return.
     * The cap exists to stop a line refunding more than it was worth, and a return that
     * refunds nothing cannot threaten that.
     *
     * Driven through the real cancel ENDPOINT rather than an UPDATE, so the release is proved
     * against the path a customer actually takes.
     */
    it('releases quantity when a return is CANCELLED, and the units can be returned again', async () => {
      const single = await givenDeliveredOrder({ quantity: 1 });
      const headers = { Authorization: `Bearer ${single.token}` };
      const body = { reason: 'defective', lines: [{ skuCode: single.skuCode, quantity: 1 }] };

      // 1. A quantity-1 return on a quantity-1 line: the whole line is now spoken for.
      const first = await api()
        .post(`/api/v1/users/me/orders/${single.orderNumber}/returns`)
        .set(headers)
        .set('idempotency-key', `c-a-${newId()}`)
        .send(body);
      expect(first.status).toBe(201);
      const number = first.body.return.returnNumber as string;

      // While it is outstanding, a second return must be refused.
      const blocked = await api()
        .post(`/api/v1/users/me/orders/${single.orderNumber}/returns`)
        .set(headers)
        .set('idempotency-key', `c-b-${newId()}`)
        .send(body);
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.details.remaining).toBe(0);

      // 2. Approved (40d owns this transition; moved directly here).
      await db()
        .update(returnRequest)
        .set({ status: 'approved' })
        .where(eq(returnRequest.returnNumber, number));

      // 3. Cancelled by the customer, through the endpoint.
      const cancelled = await api()
        .post(`/api/v1/users/me/returns/${number}/cancel`)
        .set(headers)
        .send({});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.return.status).toBe('cancelled');

      // 4. The units are returnable again.
      const second = await api()
        .post(`/api/v1/users/me/orders/${single.orderNumber}/returns`)
        .set(headers)
        .set('idempotency-key', `c-c-${newId()}`)
        .send(body);
      expect(second.status).toBe(201);
      expect(second.body.return.returnNumber).not.toBe(number);
    });

    it('excludes cancelled units from the cumulative count on a multi-unit line', async () => {
      // Three ordered. Take one, cancel it, then take all three: the cancelled one is free.
      const first = await createReturn(oneUnit(1));
      expect(first.status).toBe(201);
      await db()
        .update(returnRequest)
        .set({ status: 'approved' })
        .where(eq(returnRequest.returnNumber, first.body.return.returnNumber));
      expect(
        (
          await api()
            .post(`/api/v1/users/me/returns/${first.body.return.returnNumber as string}/cancel`)
            .set(asCustomer())
            .send({})
        ).status,
      ).toBe(200);

      const all = await createReturn(oneUnit(3));
      expect(all.status).toBe(201);

      // And the line is now genuinely exhausted by the three that DO count.
      const overflow = await createReturn(oneUnit(1));
      expect(overflow.status).toBe(422);
      expect(overflow.body.error.details.remaining).toBe(0);
    });

    it('keeps creation and cancellation transactionally safe when they race', async () => {
      // Two units of three are outstanding; cancelling one races a request for two more.
      const three = await givenDeliveredOrder({ quantity: 3 });
      const headers = { Authorization: `Bearer ${three.token}` };
      const two = { reason: 'defective', lines: [{ skuCode: three.skuCode, quantity: 2 }] };

      const held = await api()
        .post(`/api/v1/users/me/orders/${three.orderNumber}/returns`)
        .set(headers)
        .set('idempotency-key', `r-a-${newId()}`)
        .send(two);
      expect(held.status).toBe(201);
      await db()
        .update(returnRequest)
        .set({ status: 'approved' })
        .where(eq(returnRequest.returnNumber, held.body.return.returnNumber));

      const [cancelResult, createResult] = await Promise.all([
        api()
          .post(`/api/v1/users/me/returns/${held.body.return.returnNumber as string}/cancel`)
          .set(headers)
          .send({}),
        api()
          .post(`/api/v1/users/me/orders/${three.orderNumber}/returns`)
          .set(headers)
          .set('idempotency-key', `r-b-${newId()}`)
          .send(two),
      ]);

      expect(cancelResult.status).toBe(200);
      /*
       * The creation either saw the cancellation (2 free of 3 → 201) or did not (1 free → 422).
       * Both are correct; what must never happen is a state where the counted quantity exceeds
       * what was ordered.
       */
      expect([201, 422]).toContain(createResult.status);

      const counted = await db()
        .select()
        .from(returnLine)
        .innerJoin(returnRequest, eq(returnLine.returnId, returnRequest.id))
        .where(
          and(
            eq(returnRequest.orderId, three.orderId),
            inArray(returnRequest.status, [
              'requested',
              'approved',
              'received',
              'inspected',
              'completed',
            ]),
          ),
        );
      const total = counted.reduce((acc, r) => acc + r.return_line.quantity, 0);
      expect(total).toBeLessThanOrEqual(3);
    });

    it('rejects a duplicate SKU in one request', async () => {
      const response = await createReturn({
        reason: 'defective',
        lines: [
          { skuCode: currentSku, quantity: 1 },
          { skuCode: currentSku, quantity: 1 },
        ],
      });

      expect(response.status).toBe(400);
    });

    it('lets exactly ONE of two concurrent requests take the last unit', async () => {
      const single = await givenDeliveredOrder({ quantity: 1 });

      const body = { reason: 'defective', lines: [{ skuCode: single.skuCode, quantity: 1 }] };
      const results = await Promise.all([
        api()
          .post(`/api/v1/users/me/orders/${single.orderNumber}/returns`)
          .set({ Authorization: `Bearer ${single.token}` })
          .set('idempotency-key', `c1-${newId()}`)
          .send(body),
        api()
          .post(`/api/v1/users/me/orders/${single.orderNumber}/returns`)
          .set({ Authorization: `Bearer ${single.token}` })
          .set('idempotency-key', `c2-${newId()}`)
          .send(body),
      ]);

      const created = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 422);
      expect(created).toHaveLength(1);
      expect(refused).toHaveLength(1);

      const rows = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.orderId, single.orderId));
      expect(rows).toHaveLength(1);
    });

    it('never exceeds the ordered quantity under a concurrent burst', async () => {
      const three = await givenDeliveredOrder({ quantity: 3 });

      const attempt = (n: number) =>
        api()
          .post(`/api/v1/users/me/orders/${three.orderNumber}/returns`)
          .set({ Authorization: `Bearer ${three.token}` })
          .set('idempotency-key', `burst-${String(n)}-${newId()}`)
          .send({ reason: 'defective', lines: [{ skuCode: three.skuCode, quantity: 2 }] });

      const results = await Promise.all([attempt(1), attempt(2), attempt(3)]);
      const accepted = results.filter((r) => r.status === 201);
      // Two units each, three units available: exactly one can succeed.
      expect(accepted).toHaveLength(1);

      const lines = await db()
        .select()
        .from(returnLine)
        .innerJoin(returnRequest, eq(returnLine.returnId, returnRequest.id))
        .where(eq(returnRequest.orderId, three.orderId));
      const total = lines.reduce((acc, r) => acc + r.return_line.quantity, 0);
      expect(total).toBeLessThanOrEqual(3);
    });
  });

  /* ══ 4. Idempotency ═════════════════════════════════════════════════════ */

  describe('idempotency', () => {
    it('requires a key', async () => {
      const response = await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
        .set(asCustomer())
        .send(oneUnit(1));

      expect(response.status).toBe(400);
    });

    it('replays the same key to the same return', async () => {
      const key = `idem-${newId()}`;
      const first = await createReturn(oneUnit(1), { key });
      const replay = await createReturn(oneUnit(1), { key });

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.body.return.returnNumber).toBe(first.body.return.returnNumber);

      const rows = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.orderId, orderId));
      expect(rows).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const key = `idem-${newId()}`;
      expect((await createReturn(oneUnit(1), { key })).status).toBe(201);

      const different = await createReturn(oneUnit(2), { key });
      expect(different.status).toBe(422);
      expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
    });
  });

  /* ══ 5. Validation ══════════════════════════════════════════════════════ */

  describe('validation', () => {
    it('rejects a reason outside the closed list', async () => {
      const response = await createReturn({
        reason: 'changed_my_mind',
        lines: [{ skuCode: currentSku, quantity: 1 }],
      });
      expect(response.status).toBe(400);
    });

    it('rejects an empty line list', async () => {
      expect((await createReturn({ reason: 'defective', lines: [] })).status).toBe(400);
    });

    it('rejects quantity zero and negative', async () => {
      expect((await createReturn(oneUnit(0))).status).toBe(400);
      expect((await createReturn(oneUnit(-1))).status).toBe(400);
    });

    it('rejects client-supplied money, status and identifiers', async () => {
      for (const extra of [
        { refundTotal: '9999.0000' },
        { status: 'completed' },
        { storeId: newId() },
        { userId: newId() },
        { deliveredAt: new Date().toISOString() },
      ]) {
        const response = await createReturn({ ...oneUnit(1), ...extra });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
    });

    it('rejects a monetary field on a line', async () => {
      const response = await createReturn({
        reason: 'defective',
        lines: [{ skuCode: currentSku, quantity: 1, lineTotal: '1.0000' }],
      });
      expect(response.status).toBe(400);
    });
  });

  /* ══ 6. Read ════════════════════════════════════════════════════════════ */

  describe('read', () => {
    it('lists and reads the customer own returns', async () => {
      const created = await createReturn(oneUnit(1));
      const number = created.body.return.returnNumber as string;

      const list = await api().get('/api/v1/users/me/returns').set(asCustomer());
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.returns[0].returnNumber).toBe(number);
      expect(list.body.returns[0].lines).toHaveLength(1);

      const read = await api().get(`/api/v1/users/me/returns/${number}`).set(asCustomer());
      expect(read.status).toBe(200);
      expect(read.body.return.returnNumber).toBe(number);
    });

    it('400s a malformed return number and 404s an unknown one', async () => {
      expect((await api().get('/api/v1/users/me/returns/nope').set(asCustomer())).status).toBe(400);
      expect(
        (await api().get('/api/v1/users/me/returns/RET-20200101-ABCDEF').set(asCustomer())).status,
      ).toBe(404);
    });

    it('requires authentication', async () => {
      expect((await api().get('/api/v1/users/me/returns')).status).toBe(401);
    });
  });

  /* ══ 7. Cancellation ════════════════════════════════════════════════════ */

  describe('cancellation', () => {
    /** 40d builds the staff approval; this suite moves the row directly to reach the state. */
    async function givenApprovedReturn(): Promise<string> {
      const created = await createReturn(oneUnit(1));
      expect(created.status).toBe(201);
      const number = created.body.return.returnNumber as string;
      await db()
        .update(returnRequest)
        .set({ status: 'approved' })
        .where(eq(returnRequest.returnNumber, number));
      return number;
    }

    it('cancels an approved return', async () => {
      const number = await givenApprovedReturn();

      const response = await api()
        .post(`/api/v1/users/me/returns/${number}/cancel`)
        .set(asCustomer())
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.return.status).toBe('cancelled');
      expect(response.body.return.closedAt).not.toBeNull();
    });

    it('records the transition as an event and an audit row', async () => {
      const number = await givenApprovedReturn();
      await api().post(`/api/v1/users/me/returns/${number}/cancel`).set(asCustomer()).send({});

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, number));
      const events = await db()
        .select()
        .from(returnEvent)
        .where(eq(returnEvent.returnId, header!.id));
      expect(events.map((e) => e.toStatus)).toEqual(['requested', 'cancelled']);

      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, 'return.cancelled'), eq(auditLog.resourceId, header!.id)));
      expect(audits).toHaveLength(1);
    });

    it('refuses to cancel twice', async () => {
      const number = await givenApprovedReturn();
      expect(
        (await api().post(`/api/v1/users/me/returns/${number}/cancel`).set(asCustomer()).send({}))
          .status,
      ).toBe(200);

      const second = await api()
        .post(`/api/v1/users/me/returns/${number}/cancel`)
        .set(asCustomer())
        .send({});
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('RETURN_NOT_TRANSITIONABLE');
    });

    it('refuses to cancel a return that is still only requested', async () => {
      const created = await createReturn(oneUnit(1));
      const number = created.body.return.returnNumber as string;

      const response = await api()
        .post(`/api/v1/users/me/returns/${number}/cancel`)
        .set(asCustomer())
        .send({});
      // `approved` is the one cancellable state the approved rules name.
      expect(response.status).toBe(409);
    });

    it('lets exactly one of two concurrent cancellations win', async () => {
      const number = await givenApprovedReturn();

      const results = await Promise.all([
        api().post(`/api/v1/users/me/returns/${number}/cancel`).set(asCustomer()).send({}),
        api().post(`/api/v1/users/me/returns/${number}/cancel`).set(asCustomer()).send({}),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(1);

      const [header] = await db()
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.returnNumber, number));
      const events = await db()
        .select()
        .from(returnEvent)
        .where(and(eq(returnEvent.returnId, header!.id), eq(returnEvent.toStatus, 'cancelled')));
      // One transition, one event — never two.
      expect(events).toHaveLength(1);
    });
  });

  /* ══ 8. Isolation ═══════════════════════════════════════════════════════ */

  describe('isolation', () => {
    it('hides another customer return behind a 404', async () => {
      const created = await createReturn(oneUnit(1));
      const number = created.body.return.returnNumber as string;

      const other = await givenDeliveredOrder({ quantity: 1 });
      const headers = { Authorization: `Bearer ${other.token}` };

      expect((await api().get(`/api/v1/users/me/returns/${number}`).set(headers)).status).toBe(404);
      expect(
        (await api().post(`/api/v1/users/me/returns/${number}/cancel`).set(headers).send({}))
          .status,
      ).toBe(404);

      const list = await api().get('/api/v1/users/me/returns').set(headers);
      expect(list.body.total).toBe(0);
    });

    it('cannot return against another customer order', async () => {
      const other = await givenDeliveredOrder({ quantity: 1 });

      const response = await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
        .set({ Authorization: `Bearer ${other.token}` })
        .set('idempotency-key', `x-${newId()}`)
        .send(oneUnit(1));

      // The order is not theirs, so it is absent rather than forbidden.
      expect(response.status).toBe(404);
    });

    it('does not let a staff token read a customer return through the customer route', async () => {
      const created = await createReturn(oneUnit(1));
      const number = created.body.return.returnNumber as string;

      const staffEmail = `ops.${newId()}@example.com`;
      const staff = await container.identity.registerCustomer({
        storeId,
        input: { email: staffEmail, password: PASSWORD, firstName: 'Ops', lastName: 'S' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staff.id));
      const login = await api()
        .post('/api/v1/auth/login')
        .send({ email: staffEmail, password: PASSWORD });

      const response = await api()
        .get(`/api/v1/users/me/returns/${number}`)
        .set({ Authorization: `Bearer ${login.body.accessToken as string}` });
      // `/users/me` means the CALLER, whoever they are. Staff see their own returns, not others'.
      expect(response.status).toBe(404);
    });
  });
});
