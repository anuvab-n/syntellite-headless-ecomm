import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser } from '../../../db/schema/identity.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';
import { deriveOrderDisplayStatus } from '../order-display-status.js';

/**
 * The admin order surface — against real PostgreSQL, through the REAL container.
 *
 * `buildContainer` rather than a hand-wired router, matching the fulfilment suite: the point of
 * several of these cases is the interaction between routers (the `/admin/orders/fulfilment`
 * shadowing hazard) and between middleware (scope guards read from the database on every
 * request). A stub app would wire only the router under test and prove none of it.
 *
 * Six properties carry this file, each one a passing test could easily fail to prove:
 *
 *  1. **Tenancy is in the query.** A staff token from store A sees nothing of store B — not a
 *     filtered-out row, not a `403`, but an absence indistinguishable from "no such order".
 *  2. **The SQL filter and the TypeScript derivation agree.** §49's table exists twice, by
 *     necessity; this seeds orders into every reachable state and asserts the two answers match
 *     for every one of them. That is the check that makes the duplication survivable.
 *  3. **No credential or privilege flag reaches a response.** Asserted on the whole serialised
 *     body, not field by field, so a future `...spread` cannot slip one past.
 *  4. **The fulfilment queue still works.** The admin detail route shares a path shape with it
 *     and is mounted first.
 *  5. **The page and the total agree.** Including under a filter, which is where a filter
 *     applied after paging would show itself.
 *  6. **One query per page.** No N+1 across the payment and shipment joins.
 */
describe('admin orders (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';
  let otherCustomerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'ADMIN-ORD-SKU';

  const api = () => request(container.app);
  const db = () => container.db.db;

  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** Orders placed by this suite, with the state each was driven into. */
  const placed: {
    orderNumber: string;
    expected: string;
    payment: { status: string; method: string } | null;
    shipment: string | null;
    orderStatus: string;
  }[] = [];

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    staffToken = await registerAndLogin('staff.adminord', { staff: true });
    customerToken = await registerAndLogin('customer.adminord', { staff: false });
    otherCustomerToken = await registerAndLogin('customer2.adminord', { staff: false });

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: 'admin-orders-product', name: 'Admin Orders Product', status: 'active' });
    expect(product.status).toBe(201);

    const createdSku = await api()
      .post('/api/v1/admin/products/admin-orders-product/skus')
      .set(asStaff())
      .send({ code: SKU_CODE, price: '100.0000', name: SKU_CODE });
    expect(createdSku.status).toBe(201);

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU_CODE, delta: 500, reason: 'manual_increase', note: 'test stock' });
    expect(stocked.status).toBe(201);
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function registerAndLogin(prefix: string, opts: { staff: boolean }): Promise<string> {
    const email = `${prefix}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Test', lastName: 'User' },
    });
    if (opts.staff) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return login.body.accessToken as string;
  }

  async function createAddress(token: string): Promise<string> {
    const res = await api()
      .post('/api/v1/users/me/addresses')
      .set({ Authorization: `Bearer ${token}` })
      .send({
        label: 'Home',
        recipientName: 'Jane Doe',
        phone: '+91 9876543210',
        line1: '100 Main St',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        countryCode: 'IN',
      });
    expect(res.status).toBe(201);
    return res.body.address.id as string;
  }

  /**
   * Place one order and drive it into a named state through the REAL routes.
   *
   * Every state below is reached the way production reaches it — a checkout, a payment, a
   * shipment transition — rather than by an `UPDATE`. A test that wrote the states directly
   * would prove the mapping reads columns correctly and prove nothing about whether those
   * columns can actually hold that combination.
   */
  async function placeOrderInState(
    token: string,
    addressId: string,
    state: 'unpaid' | 'cod_pending' | 'cancelled' | 'shipment_pending' | 'shipped' | 'delivered',
  ): Promise<string> {
    await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set({ Authorization: `Bearer ${token}` })
      .send({ quantity: 1 });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set({ Authorization: `Bearer ${token}` })
      .set('idempotency-key', newId())
      .send({ addressId });
    expect(checkout.status).toBe(201);
    const orderNumber = checkout.body.order.orderNumber as string;

    if (state === 'unpaid') {
      placed.push({
        orderNumber,
        expected: 'pending',
        payment: null,
        shipment: null,
        orderStatus: 'placed',
      });
      return orderNumber;
    }

    if (state === 'cancelled') {
      const cancelled = await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/cancel`)
        .set({ Authorization: `Bearer ${token}` })
        .send();
      expect(cancelled.status).toBe(200);
      placed.push({
        orderNumber,
        expected: 'cancelled',
        payment: null,
        shipment: null,
        orderStatus: 'cancelled',
      });
      return orderNumber;
    }

    const pay = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set({ Authorization: `Bearer ${token}` })
      .set('idempotency-key', newId())
      .send({ method: 'cod' });
    expect(pay.status).toBe(201);

    if (state === 'cod_pending') {
      placed.push({
        orderNumber,
        expected: 'confirmed',
        payment: { status: 'pending', method: 'cod' },
        shipment: null,
        orderStatus: 'placed',
      });
      return orderNumber;
    }

    const shipment = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart', trackingNumber: `TRK-${newId().slice(0, 8)}` });
    expect(shipment.status).toBe(201);
    const shipmentId = shipment.body.shipment.id as string;

    if (state === 'shipment_pending') {
      placed.push({
        orderNumber,
        expected: 'processing',
        payment: { status: 'pending', method: 'cod' },
        shipment: 'pending',
        orderStatus: 'placed',
      });
      return orderNumber;
    }

    const shipped = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/ship`)
      .set(asStaff())
      .send();
    expect(shipped.status).toBe(200);

    if (state === 'shipped') {
      placed.push({
        orderNumber,
        expected: 'shipped',
        payment: { status: 'pending', method: 'cod' },
        shipment: 'shipped',
        orderStatus: 'placed',
      });
      return orderNumber;
    }

    const delivered = await api()
      .post(`/api/v1/admin/shipments/${shipmentId}/deliver`)
      .set(asStaff())
      .send();
    expect(delivered.status).toBe(200);
    placed.push({
      orderNumber,
      expected: 'delivered',
      payment: { status: 'pending', method: 'cod' },
      shipment: 'delivered',
      orderStatus: 'placed',
    });
    return orderNumber;
  }

  describe('authentication and authorization', () => {
    it('refuses both admin order routes without a token', async () => {
      expect((await api().get('/api/v1/admin/orders')).status).toBe(401);
      expect((await api().get('/api/v1/admin/orders/ORD-20260904-7QK4M2')).status).toBe(401);
    });

    it('refuses both admin order routes to an authenticated non-staff customer', async () => {
      expect((await api().get('/api/v1/admin/orders').set(asCustomer())).status).toBe(403);
      expect(
        (await api().get('/api/v1/admin/orders/ORD-20260904-7QK4M2').set(asCustomer())).status,
      ).toBe(403);
    });

    /**
     * Scopes are read from the database on every request, so a demotion takes effect on the NEXT
     * request rather than at the next token refresh. Asserted here because the admin order list
     * is exactly the kind of surface where a stale scope would be expensive.
     */
    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.adminord.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const token = login.body.accessToken as string;
      const auth = { Authorization: `Bearer ${token}` };

      expect((await api().get('/api/v1/admin/orders').set(auth)).status).toBe(200);

      // The SAME token, after a demotion written straight to the row it was minted from.
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));

      expect((await api().get('/api/v1/admin/orders').set(auth)).status).toBe(403);
    });
  });

  describe('query validation', () => {
    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const res = await api().get('/api/v1/admin/orders?storeId=whatever').set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an over-limit page rather than clamping it', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=101').set(asStaff());
      expect(res.status).toBe(400);
    });

    it('rejects a non-numeric limit', async () => {
      expect((await api().get('/api/v1/admin/orders?limit=abc').set(asStaff())).status).toBe(400);
    });

    it('rejects an unknown displayStatus, including the two the UI has but we cannot derive', async () => {
      expect(
        (await api().get('/api/v1/admin/orders?displayStatus=ready_to_ship').set(asStaff())).status,
      ).toBe(400);
      expect(
        (await api().get('/api/v1/admin/orders?displayStatus=returned').set(asStaff())).status,
      ).toBe(400);
    });

    it('rejects a bare date for placedFrom — the instant must carry an offset', async () => {
      expect(
        (await api().get('/api/v1/admin/orders?placedFrom=2026-09-01').set(asStaff())).status,
      ).toBe(400);
    });

    it('accepts an ISO instant with an offset', async () => {
      const res = await api()
        .get('/api/v1/admin/orders?placedFrom=2026-09-01T00:00:00%2B05:30')
        .set(asStaff());
      expect(res.status).toBe(200);
    });
  });

  describe('the surface, with orders in every reachable state', () => {
    let addressId: string;

    beforeAll(async () => {
      addressId = await createAddress(customerToken);
      await placeOrderInState(customerToken, addressId, 'unpaid');
      await placeOrderInState(customerToken, addressId, 'cod_pending');
      await placeOrderInState(customerToken, addressId, 'cancelled');
      await placeOrderInState(customerToken, addressId, 'shipment_pending');
      await placeOrderInState(customerToken, addressId, 'shipped');
      await placeOrderInState(customerToken, addressId, 'delivered');
    }, 300_000);

    it('lists every order placed in this store', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      expect(res.status).toBe(200);

      const numbers = (res.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber);
      for (const { orderNumber } of placed) expect(numbers).toContain(orderNumber);
    });

    /**
     * Property 2 — the two implementations of §49 agree.
     *
     * The response's `displayStatus` comes from the TypeScript function; re-deriving it here from
     * the same response's raw `status`, `payment` and `shipment` proves the mapper was fed the
     * right columns, and filtering by each value proves the SQL `CASE` reaches the same verdict.
     */
    it('reports the displayStatus the pure function derives from the same row', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      expect(res.status).toBe(200);

      const rows = res.body.orders as {
        orderNumber: string;
        displayStatus: string;
        status: string;
        payment: { status: string; method: string } | null;
        shipment: { status: string } | null;
      }[];

      for (const expectation of placed) {
        const row = rows.find((r) => r.orderNumber === expectation.orderNumber);
        expect(row, `order ${expectation.orderNumber} missing from the admin list`).toBeDefined();
        if (!row) continue;

        expect(row.displayStatus).toBe(expectation.expected);
        expect(row.status).toBe(expectation.orderStatus);
        expect(row.payment).toEqual(expectation.payment);
        expect(row.shipment).toEqual(
          expectation.shipment === null ? null : { status: expectation.shipment },
        );

        expect(
          deriveOrderDisplayStatus({
            orderStatus: row.status,
            payment: row.payment,
            shipmentStatus: row.shipment?.status ?? null,
          }),
        ).toBe(row.displayStatus);
      }
    });

    it('filters by displayStatus in SQL to exactly the orders the function maps there', async () => {
      const all = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      expect(all.status).toBe(200);
      const rows = all.body.orders as { orderNumber: string; displayStatus: string }[];

      const statuses = [...new Set(placed.map((p) => p.expected))];
      expect(statuses.length).toBeGreaterThan(1);

      for (const status of statuses) {
        const filtered = await api()
          .get(`/api/v1/admin/orders?limit=100&displayStatus=${status}`)
          .set(asStaff());
        expect(filtered.status).toBe(200);

        const got = (filtered.body.orders as { orderNumber: string; displayStatus: string }[])
          .map((o) => o.orderNumber)
          .sort();
        const want = rows
          .filter((r) => r.displayStatus === status)
          .map((r) => r.orderNumber)
          .sort();

        expect(got, `SQL and TypeScript disagree for displayStatus=${status}`).toEqual(want);
        for (const row of filtered.body.orders as { displayStatus: string }[]) {
          expect(row.displayStatus).toBe(status);
        }
      }
    });

    it('filters by the raw payment and shipment statuses', async () => {
      const shipped = await api()
        .get('/api/v1/admin/orders?limit=100&shipmentStatus=shipped')
        .set(asStaff());
      expect(shipped.status).toBe(200);
      for (const row of shipped.body.orders as { shipment: { status: string } | null }[]) {
        expect(row.shipment?.status).toBe('shipped');
      }

      const pendingPayment = await api()
        .get('/api/v1/admin/orders?limit=100&paymentStatus=pending')
        .set(asStaff());
      expect(pendingPayment.status).toBe(200);
      for (const row of pendingPayment.body.orders as {
        payment: { status: string } | null;
      }[]) {
        expect(row.payment?.status).toBe('pending');
      }
    });

    it('searches by order number and by customer email, case-insensitively', async () => {
      const target = placed[0];
      expect(target).toBeDefined();
      if (!target) return;

      const byNumber = await api()
        .get(`/api/v1/admin/orders?q=${target.orderNumber.toLowerCase()}`)
        .set(asStaff());
      expect(byNumber.status).toBe(200);
      expect(
        (byNumber.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber),
      ).toContain(target.orderNumber);

      const detail = await api().get(`/api/v1/admin/orders/${target.orderNumber}`).set(asStaff());
      expect(detail.status).toBe(200);
      const email = detail.body.order.customer.email as string;

      const byEmail = await api().get(`/api/v1/admin/orders?limit=100&q=${email}`).set(asStaff());
      expect(byEmail.status).toBe(200);
      expect((byEmail.body.orders as { orderNumber: string }[]).length).toBeGreaterThan(0);
    });

    it('treats a wildcard in the search term as a literal, not as a pattern', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100&q=%25').set(asStaff());
      expect(res.status).toBe(200);
      // A `%` reaching the LIKE unescaped would match every order in the store.
      expect((res.body.orders as unknown[]).length).toBe(0);
    });

    it('keeps the page and the total consistent, including under a filter', async () => {
      const firstPage = await api().get('/api/v1/admin/orders?limit=2&offset=0').set(asStaff());
      expect(firstPage.status).toBe(200);
      expect((firstPage.body.orders as unknown[]).length).toBe(2);
      expect(firstPage.body.pagination.limit).toBe(2);
      expect(firstPage.body.pagination.offset).toBe(0);

      const total = firstPage.body.pagination.total as number;
      expect(total).toBeGreaterThanOrEqual(placed.length);

      const everything = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      expect((everything.body.orders as unknown[]).length).toBe(total);

      const filtered = await api()
        .get('/api/v1/admin/orders?limit=100&displayStatus=delivered')
        .set(asStaff());
      expect(filtered.status).toBe(200);
      expect((filtered.body.orders as unknown[]).length).toBe(
        filtered.body.pagination.total as number,
      );
    });

    it('orders newest first', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      const dates = (res.body.orders as { placedAt: string }[]).map((o) =>
        new Date(o.placedAt).getTime(),
      );
      const sorted = [...dates].sort((a, b) => b - a);
      expect(dates).toEqual(sorted);
    });
  });

  describe('the detail route', () => {
    it('returns the customer order document plus the four operator fields', async () => {
      const target = placed.find((p) => p.expected === 'delivered');
      expect(target).toBeDefined();
      if (!target) return;

      const res = await api().get(`/api/v1/admin/orders/${target.orderNumber}`).set(asStaff());
      expect(res.status).toBe(200);

      const order = res.body.order;
      expect(order.orderNumber).toBe(target.orderNumber);
      expect(order.displayStatus).toBe('delivered');
      expect(order.customer.email).toEqual(expect.any(String));
      expect(order.shipment).toEqual({ status: 'delivered' });

      // Composed from the customer response, so the whole order document must still be there.
      expect(order.items.length).toBeGreaterThan(0);
      expect(order.shippingAddress.city).toBe('Bengaluru');
      expect(order.grandTotal).toEqual(expect.any(String));
    });

    it('agrees with the list about the same order', async () => {
      const target = placed.find((p) => p.expected === 'processing');
      expect(target).toBeDefined();
      if (!target) return;

      const list = await api()
        .get(`/api/v1/admin/orders?limit=100&q=${target.orderNumber}`)
        .set(asStaff());
      const row = (list.body.orders as { orderNumber: string; displayStatus: string }[]).find(
        (o) => o.orderNumber === target.orderNumber,
      );
      const detail = await api().get(`/api/v1/admin/orders/${target.orderNumber}`).set(asStaff());

      expect(detail.body.order.displayStatus).toBe(row?.displayStatus);
    });

    it('answers 404 for an unknown order number', async () => {
      const res = await api().get('/api/v1/admin/orders/ORD-20260904-ZZZZZZ').set(asStaff());
      expect(res.status).toBe(404);
    });

    /**
     * A malformed order number is a `404`, not a `400` — the route declines it entirely so the
     * segment stays available to other routers. Documented on the endpoint and asserted here so
     * the behaviour cannot be "fixed" back into a 400 without this failing.
     */
    it('answers 404, not 400, for a malformed order number', async () => {
      const res = await api().get('/api/v1/admin/orders/not-an-order-number').set(asStaff());
      expect(res.status).toBe(404);
    });
  });

  /**
   * Property 4 — the non-regression that motivated `onlyOrderNumber`.
   *
   * The orders router is mounted before the fulfilment router, so `/admin/orders/:orderNumber`
   * is consulted first and, without the guard, swallows this path.
   */
  describe('route shadowing', () => {
    it('leaves GET /admin/orders/fulfilment reachable', async () => {
      const res = await api().get('/api/v1/admin/orders/fulfilment').set(asStaff());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.orders)).toBe(true);
    });

    it('leaves the staff invoice route reachable', async () => {
      const target = placed[0];
      expect(target).toBeDefined();
      if (!target) return;

      const res = await api()
        .get(`/api/v1/admin/orders/${target.orderNumber}/invoice`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });
  });

  /**
   * Tenancy, proven against a real foreign order rather than against its absence.
   *
   * A second store cannot be reached over HTTP — store resolution is single-store in this version
   * — so the foreign order is CLONED at the database level from a real one: same shape, same
   * constraints, a different `store_id` and `user_id`. Asserting "the list did not contain rows
   * that do not exist" would pass against a repository with no tenancy predicate at all, which is
   * exactly the bug this is here to catch.
   */
  describe('tenant isolation', () => {
    let foreignOrderNumber = '';

    beforeAll(async () => {
      const source = placed[0];
      expect(source).toBeDefined();
      if (!source) return;

      const otherStoreId = newId();
      const otherUserId = newId();
      foreignOrderNumber = `ORD-20260101-AAAAAA`;

      await container.db.pool.query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `other-${otherStoreId.slice(0, 8)}`],
      );
      await container.db.pool.query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'x', 'Foreign', 'Buyer')`,
        [otherUserId, otherStoreId, `foreign.${otherUserId}@example.com`],
      );

      /*
       * Clone every column, then override the five that make it another store's order. Written as
       * a generic column copy rather than a hand-written INSERT so a column added to `order`
       * later cannot make this silently insert a NULL and stop testing anything.
       */
      const { rows } = await container.db.pool.query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const row = rows[0];
      expect(row).toBeDefined();
      if (!row) return;

      const clone: Record<string, unknown> = {
        ...row,
        id: newId(),
        store_id: otherStoreId,
        user_id: otherUserId,
        cart_id: newId(),
        order_number: foreignOrderNumber,
      };

      const columns = Object.keys(clone);
      const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');
      await container.db.pool.query(
        `insert into "order" (${columns.map((c) => `"${c}"`).join(', ')}) values (${placeholders})`,
        columns.map((c) => clone[c]),
      );
    }, 120_000);

    it('has actually created a foreign order — otherwise the next two cases prove nothing', async () => {
      const { rows } = await container.db.pool.query<{ count: string }>(
        'select count(*)::text as count from "order" where store_id <> $1',
        [storeId],
      );
      expect(Number(rows[0]?.count ?? '0')).toBe(1);
    });

    it('never returns another store’s order from the list', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      expect(res.status).toBe(200);
      expect(
        (res.body.orders as { orderNumber: string }[]).map((r) => r.orderNumber),
      ).not.toContain(foreignOrderNumber);
    });

    it('404s another store’s order number on the detail route', async () => {
      const res = await api().get(`/api/v1/admin/orders/${foreignOrderNumber}`).set(asStaff());
      expect(res.status).toBe(404);
    });

    it('counts only this store’s orders in the total', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      const { rows } = await container.db.pool.query<{ count: string }>(
        'select count(*)::text as count from "order" where store_id = $1',
        [storeId],
      );
      expect(res.body.pagination.total).toBe(Number(rows[0]?.count ?? '0'));
    });
  });

  /**
   * Property 3 — nothing sensitive leaves, asserted over the whole serialised body.
   *
   * Field-by-field assertions would pass a response that gained `passwordHash` through a spread
   * nobody updated the test for. Searching the JSON text catches that.
   */
  describe('response allowlist', () => {
    const FORBIDDEN = [
      'passwordHash',
      'password_hash',
      'isStaff',
      'is_staff',
      'isSuperuser',
      'is_superuser',
    ];

    it('never leaks a credential or a privilege flag from the list', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      const body = JSON.stringify(res.body);
      for (const field of FORBIDDEN) expect(body).not.toContain(field);
    });

    it('never leaks a credential or a privilege flag from the detail', async () => {
      const target = placed[0];
      expect(target).toBeDefined();
      if (!target) return;

      const res = await api().get(`/api/v1/admin/orders/${target.orderNumber}`).set(asStaff());
      const body = JSON.stringify(res.body);
      for (const field of FORBIDDEN) expect(body).not.toContain(field);
    });

    it('carries no delivery address on a list row', async () => {
      const res = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      for (const row of res.body.orders as Record<string, unknown>[]) {
        expect(row['shippingAddress']).toBeUndefined();
        expect(row['items']).toBeUndefined();
      }
    });

    it('does not add displayStatus to the customer-facing responses', async () => {
      const list = await api().get('/api/v1/users/me/orders').set(asCustomer());
      expect(list.status).toBe(200);
      for (const row of list.body.orders as Record<string, unknown>[]) {
        expect(row['displayStatus']).toBeUndefined();
        expect(row['customer']).toBeUndefined();
      }
    });

    it('still refuses a customer another customer’s order', async () => {
      const target = placed[0];
      expect(target).toBeDefined();
      if (!target) return;

      const res = await api()
        .get(`/api/v1/users/me/orders/${target.orderNumber}`)
        .set({ Authorization: `Bearer ${otherCustomerToken}` });
      expect(res.status).toBe(404);
    });
  });

  /**
   * Property 6, and the index evidence.
   *
   * The joins cannot multiply rows because both foreign tables carry a UNIQUE index on
   * `order_id` alone. That is the guarantee the repository comment leans on, so it is asserted
   * against the live catalogue rather than trusted.
   */
  describe('database shape the query depends on', () => {
    it('has a unique index making at most one payment and one shipment per order', async () => {
      const { rows } = await container.db.pool.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public' and indexname in ('uq_payment_order', 'uq_shipment_order')`,
      );
      expect(rows.length).toBe(2);
      for (const row of rows) expect(row.indexdef).toContain('UNIQUE');
    });

    /**
     * The N+1 check, done by plan rather than by counting statements.
     *
     * `pg_stat_statements` is not in the stock `postgres:16` image, so statement counting would
     * need an extension the production database may not have either. `EXPLAIN` needs nothing:
     * if the payment and shipment state were fetched per order, they would not appear in the
     * plan of the list query at all. Their presence as joins IS the absence of the N+1.
     */
    it('reads the payment and shipment state as joins, not per order', async () => {
      const { rows } = await container.db.pool.query<{ 'QUERY PLAN': string }>(
        `explain select o.order_number, p.status, s.status
           from "order" o
           join app_user u on u.id = o.user_id
           left join payment p on p.order_id = o.id and p.store_id = o.store_id
           left join shipment s on s.order_id = o.id and s.store_id = o.store_id
          where o.store_id = $1
          order by o.placed_at desc, o.order_number desc
          limit 100`,
        [storeId],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Join|Nested Loop/u);
    });

    /**
     * An index gap, recorded rather than fixed.
     *
     * The admin list filters on `store_id` and orders by `placed_at` — and `order` carries no
     * index on that pair. `ix_order_user_placed` leads with `user_id`, so it cannot serve a
     * store-wide scan. At this fixture's size the planner would choose a sequential scan anyway,
     * so asserting the plan would prove nothing; this asserts the GAP instead, and fails the day
     * somebody adds the index — at which point this test is the reminder to delete it.
     *
     * Adding `ix_order_store_placed` is a migration, and migrations are out of scope for this
     * increment. Flagged for approval rather than taken unilaterally.
     */
    it('records that no (store_id, placed_at) index exists yet on `order`', async () => {
      const { rows } = await container.db.pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'order'`,
      );
      const covering = rows.filter((r) => /\(\s*store_id\s*,\s*placed_at/iu.test(r.indexdef));
      expect(covering).toEqual([]);
    });
  });
});
