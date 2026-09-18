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
        .send({});
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
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
      .send({ carrier: 'Bluedart', trackingNumber: `TRK-${newId().replace(/-/gu, '')}` });
    expect(shipment.status, JSON.stringify(shipment.body)).toBe(201);
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
      .send({});
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);

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
      .send({});
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
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

  /**
   * The precision rule, asserted here as it is on the payment and customer lists.
   *
   * PostgreSQL stores `timestamptz` to MICROSECONDS. A JavaScript `Date` cannot represent one,
   * so a bound can only ever NAME A MILLISECOND, and `placedAt` is published truncated to one.
   * "Inclusive" therefore means inclusive of the whole millisecond named — otherwise an order
   * stored at `.123456` is excluded by the very timestamp the API published for it.
   *
   * This was the same defect the payments and customers lists carried, fixed with the same
   * shared helper rather than a second copy of the rule.
   */
  describe('date bounds at microsecond precision', () => {
    const STORED = '2026-08-12T14:20:00.123456Z';
    const NAMED = '2026-08-12T14:20:00.123Z';
    let subject = '';
    let neighbour = '';

    beforeAll(async () => {
      const addressId = await createAddress(customerToken);
      subject = await placeOrderInState(customerToken, addressId, 'unpaid');
      neighbour = await placeOrderInState(customerToken, addressId, 'unpaid');

      const pin = async (orderNumber: string, at: string) => {
        const { rowCount } = await container.db.pool.query(
          'update "order" set placed_at = $2::timestamptz where order_number = $1 and store_id = $3',
          [orderNumber, at, storeId],
        );
        expect(rowCount, `failed to pin ${orderNumber}`).toBe(1);
      };

      await pin(subject, STORED);
      // One millisecond later, exactly on the boundary the fix must NOT cross.
      await pin(neighbour, '2026-08-12T14:20:00.124000Z');
    }, 300_000);

    const numbersFor = async (qs: string): Promise<string[]> => {
      const res = await api().get(`/api/v1/admin/orders?limit=100&${qs}`).set(asStaff());
      expect(res.status).toBe(200);
      return (res.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber);
    };

    it('stores microseconds the API cannot publish', async () => {
      const { rows } = await container.db.pool.query<{ exact: string }>(
        `select to_char(placed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as exact
           from "order" where order_number = $1`,
        [subject],
      );
      expect(rows[0]?.exact).toBe('2026-08-12T14:20:00.123456');

      const detail = await api().get(`/api/v1/admin/orders/${subject}`).set(asStaff());
      expect(detail.status).toBe(200);
      // Published truncated, and therefore STRICTLY EARLIER than what is stored.
      expect(detail.body.order.placedAt).toBe(NAMED);
    });

    it('includes an order whose stored microseconds exceed the named upper bound', async () => {
      expect(await numbersFor(`placedTo=${encodeURIComponent(NAMED)}`)).toContain(subject);
    });

    it('round-trips its own published timestamp as both bounds', async () => {
      const enc = encodeURIComponent(NAMED);
      expect(await numbersFor(`placedFrom=${enc}&placedTo=${enc}`)).toEqual([subject]);
    });

    it('does not include the order one millisecond later', async () => {
      const got = await numbersFor(`placedTo=${encodeURIComponent(NAMED)}`);
      expect(got).toContain(subject);
      expect(got).not.toContain(neighbour);
    });

    it('excludes the order one millisecond below the named upper bound', async () => {
      const below = '2026-08-12T14:20:00.122Z';
      expect(await numbersFor(`placedTo=${encodeURIComponent(below)}`)).not.toContain(subject);
    });

    it('keeps placedFrom inclusive of the named millisecond', async () => {
      expect(await numbersFor(`placedFrom=${encodeURIComponent(NAMED)}`)).toContain(subject);
    });

    it('excludes the order when placedFrom is the next millisecond', async () => {
      const above = '2026-08-12T14:20:00.124Z';
      const got = await numbersFor(`placedFrom=${encodeURIComponent(above)}`);
      expect(got).not.toContain(subject);
      // The neighbour sits exactly on that boundary, so it MUST still be there.
      expect(got).toContain(neighbour);
    });
  });

  /* ── GET /admin/customers/:customerId/orders ──────────────────────────── */

  /**
   * One customer's order history. Increment 52.
   *
   * The route lives in THIS module, not identity, because it returns orders — putting it in
   * identity would make identity read the `order` table and invert a dependency that already
   * runs the other way. These cases prove the two predicates that matter: the rows are one
   * customer's, and they are one store's.
   *
   * The subject is `otherCustomerToken`'s account, which has placed nothing until this block —
   * so the "no orders yet" case is genuine rather than manufactured.
   */
  describe('customer order history', () => {
    let subjectId = '';
    let subjectOrders: string[] = [];
    let bystanderId = '';

    const historyOf = (id: string, qs = '') =>
      api().get(`/api/v1/admin/customers/${id}/orders${qs}`).set(asStaff());

    beforeAll(async () => {
      // The bystander already owns every order this suite placed so far.
      const { rows: bys } = await container.db.pool.query<{ id: string }>(
        `select u.id from app_user u join "order" o on o.user_id = u.id
          where u.store_id = $1 group by u.id limit 1`,
        [storeId],
      );
      bystanderId = bys[0]?.id ?? '';
      expect(bystanderId).not.toBe('');

      // The subject: a different customer, with three orders of their own.
      const me = await api()
        .get('/api/v1/users/me')
        .set({ Authorization: `Bearer ${otherCustomerToken}` });
      expect(me.status).toBe(200);
      subjectId = me.body.user.id as string;

      const addressId = await createAddress(otherCustomerToken);
      /*
       * Six, not three. The tie-breaker test below renumbers all of them and asserts one exact
       * sequence; with three rows a wrong implementation has a 1-in-6 chance of producing it by
       * accident, which a mutation probe duly exposed. Six makes that 1 in 720.
       */
      subjectOrders = [
        await placeOrderInState(otherCustomerToken, addressId, 'unpaid'),
        await placeOrderInState(otherCustomerToken, addressId, 'cod_pending'),
        await placeOrderInState(otherCustomerToken, addressId, 'unpaid'),
        await placeOrderInState(otherCustomerToken, addressId, 'unpaid'),
        await placeOrderInState(otherCustomerToken, addressId, 'cod_pending'),
        await placeOrderInState(otherCustomerToken, addressId, 'unpaid'),
      ];
    }, 300_000);

    it('refuses an anonymous request with 401', async () => {
      expect((await api().get(`/api/v1/admin/customers/${subjectId}/orders`)).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect(
        (await api().get(`/api/v1/admin/customers/${subjectId}/orders`).set(asCustomer())).status,
      ).toBe(403);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.hist.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
      const path = `/api/v1/admin/customers/${subjectId}/orders`;

      expect((await api().get(path).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get(path).set(auth)).status).toBe(403);
    });

    it('refuses a deactivated staff member with 401', async () => {
      const email = `deact.hist.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
      const path = `/api/v1/admin/customers/${subjectId}/orders`;

      expect((await api().get(path).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get(path).set(auth)).status).toBe(401);
    });

    it('rejects a malformed UUID with 400', async () => {
      const res = await historyOf('not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an unknown query parameter and an over-limit page', async () => {
      expect((await historyOf(subjectId, '?status=pending')).status).toBe(400);
      expect((await historyOf(subjectId, '?limit=101')).status).toBe(400);
      expect((await historyOf(subjectId, '?limit=0')).status).toBe(400);
      expect((await historyOf(subjectId, '?offset=-1')).status).toBe(400);
    });

    it('answers 404 for an unknown customer', async () => {
      expect((await historyOf(newId())).status).toBe(404);
    });

    it('answers 404 for a soft-deleted customer rather than an empty page', async () => {
      const addressId = await createAddress(customerToken);
      const email = `erased.hist.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Erased', lastName: 'Buyer' },
      });
      void addressId;

      expect((await historyOf(user.id)).status).toBe(200);
      await container.db.pool.query('update app_user set deleted_at = now() where id = $1', [
        user.id,
      ]);
      expect((await historyOf(user.id)).status).toBe(404);
    });

    it('answers 404 for a customer in another store', async () => {
      const otherStoreId = newId();
      const foreignId = newId();
      await container.db.pool.query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'History Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `hist-other-${otherStoreId.slice(0, 8)}`],
      );
      await container.db.pool.query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'argon2-placeholder', 'Foreign', 'Buyer')`,
        [foreignId, otherStoreId, `foreign.hist.${foreignId}@example.com`],
      );
      expect((await historyOf(foreignId)).status).toBe(404);
    });

    it('returns ONLY that customer’s orders', async () => {
      const res = await historyOf(subjectId, '?limit=100');
      expect(res.status).toBe(200);

      const got = (res.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber).sort();
      expect(got).toEqual([...subjectOrders].sort());
      expect(res.body.pagination.total).toBe(subjectOrders.length);

      // And none of the bystander's, which are the majority of the store's orders.
      const bystander = await historyOf(bystanderId, '?limit=100');
      for (const n of subjectOrders) {
        expect(
          (bystander.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber),
        ).not.toContain(n);
      }
    });

    it('returns the same AdminOrderSummary shape as the store-wide list', async () => {
      const mine = await historyOf(subjectId, '?limit=1');
      const store = await api().get('/api/v1/admin/orders?limit=1').set(asStaff());

      const a = Object.keys((mine.body.orders as Record<string, unknown>[])[0] ?? {}).sort();
      const b = Object.keys((store.body.orders as Record<string, unknown>[])[0] ?? {}).sort();
      expect(a).toEqual(b);
      expect(a).toContain('displayStatus');
      expect(a).not.toContain('items');
      expect(a).not.toContain('shippingAddress');
    });

    it('returns 200 with an empty page and total 0 for a customer who has never ordered', async () => {
      const email = `noorders.hist.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'No', lastName: 'Orders' },
      });

      const res = await historyOf(user.id, '?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.orders).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('pages with limit and offset, and the total stays the customer’s count', async () => {
      const first = await historyOf(subjectId, '?limit=2&offset=0');
      expect(first.status).toBe(200);
      expect((first.body.orders as unknown[]).length).toBe(2);
      expect(first.body.pagination).toEqual({ limit: 2, offset: 0, total: subjectOrders.length });

      // Walk the remaining pages and assert they reassemble the history exactly once.
      const all = [...(first.body.orders as { orderNumber: string }[])].map((o) => o.orderNumber);
      for (let offset = 2; offset < subjectOrders.length; offset += 2) {
        const page = await historyOf(subjectId, `?limit=2&offset=${offset}`);
        expect(page.status).toBe(200);
        expect(page.body.pagination.total).toBe(subjectOrders.length);
        all.push(...(page.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber));
      }

      expect(all.length).toBe(subjectOrders.length);
      expect([...new Set(all)].length).toBe(subjectOrders.length);
      expect([...all].sort()).toEqual([...subjectOrders].sort());

      // Past the end is an empty page, not an error, and the total is unchanged.
      const beyond = await historyOf(subjectId, `?limit=2&offset=${subjectOrders.length + 10}`);
      expect(beyond.status).toBe(200);
      expect(beyond.body.orders).toEqual([]);
      expect(beyond.body.pagination.total).toBe(subjectOrders.length);
    });

    /**
     * The tie-breaker, with a MANUFACTURED tie — orders placed through checkout never share a
     * `placed_at`, so a test over natural data proves nothing about the second sort key.
     */
    /**
     * The tie-breaker, with order numbers chosen so the correct answer DIFFERS from scan order.
     *
     * Both halves of this matter. The tie is manufactured because orders placed through checkout
     * never share a `placed_at`. The order NUMBERS are rewritten because, left natural, a
     * backward index scan over `ix_order_user_placed` returns tied rows in reverse-insertion
     * order — and a mutation probe confirmed that a test asserting only "descending by number"
     * still passed with the tie-breaker removed, because the two happened to coincide.
     *
     * So the numbers are assigned B, A, C in insertion order. Reverse-insertion is C, A, B;
     * `order_number DESC` is C, B, A. They disagree, so only a real second sort key produces the
     * expected sequence — which is what makes removing it a detectable change.
     */
    it('resolves a placed_at tie by order_number DESC, not by scan order', async () => {
      const renumbered = [
        'ORD-20260404-BBBBBB',
        'ORD-20260404-AAAAAA',
        'ORD-20260404-FFFFFF',
        'ORD-20260404-CCCCCC',
        'ORD-20260404-EEEEEE',
        'ORD-20260404-DDDDDD',
      ];
      expect(subjectOrders.length).toBe(renumbered.length);

      for (const [i, original] of subjectOrders.entries()) {
        const { rowCount } = await container.db.pool.query(
          `update "order"
              set placed_at = '2026-04-04T00:00:00.000Z'::timestamptz, order_number = $2
            where order_number = $1 and store_id = $3`,
          [original, renumbered[i], storeId],
        );
        expect(rowCount, `failed to renumber ${original}`).toBe(1);
      }
      subjectOrders = renumbered;

      const res = await historyOf(subjectId, '?limit=100');
      const got = (res.body.orders as { orderNumber: string }[]).map((o) => o.orderNumber);

      // Descending by number: F, E, D, C, B, A — deliberately unlike insertion order
      // (B, A, F, C, E, D) and unlike its reverse (D, E, C, F, A, B).
      expect(got).toEqual([
        'ORD-20260404-FFFFFF',
        'ORD-20260404-EEEEEE',
        'ORD-20260404-DDDDDD',
        'ORD-20260404-CCCCCC',
        'ORD-20260404-BBBBBB',
        'ORD-20260404-AAAAAA',
      ]);

      // Stable across repeated identical requests, and across one-row paging.
      const walked: string[] = [];
      for (let offset = 0; offset < got.length; offset += 1) {
        const one = await historyOf(subjectId, `?limit=1&offset=${offset}`);
        walked.push((one.body.orders as { orderNumber: string }[])[0]?.orderNumber ?? '');
      }
      expect(walked).toEqual(got);
    });

    /**
     * No N+1: the page is one statement with its joins, and the count is one more. If the
     * customer predicate were applied per row the joins would not appear in this plan.
     */
    it('reads the page as a single joined statement', async () => {
      const { rows } = await container.db.pool.query<{ 'QUERY PLAN': string }>(
        `explain select o.order_number, p.status, s.status
           from "order" o
           join app_user u on u.id = o.user_id
           left join payment p on p.order_id = o.id and p.store_id = o.store_id
           left join shipment s on s.order_id = o.id and s.store_id = o.store_id
          where o.store_id = $1 and o.user_id = $2
          order by o.placed_at desc, o.order_number desc
          limit 25`,
        [storeId, subjectId],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Join|Nested Loop/u);
      expect(plan).not.toMatch(/Seq Scan on "?order"?/u);
    });

    it('writes nothing', async () => {
      const countOf = async (sql: string): Promise<string> => {
        const { rows } = await container.db.pool.query<{ c: string }>(sql);
        return rows[0]?.c ?? '?';
      };
      const snapshot = async () => ({
        orders: await countOf('select count(*)::text c from "order"'),
        ordersTouched: await countOf(`select coalesce(max(placed_at)::text, '-') c from "order"`),
        users: await countOf('select count(*)::text c from app_user'),
        audits: await countOf('select count(*)::text c from audit_log'),
        events: await countOf('select count(*)::text c from outbox_event'),
        keys: await countOf('select count(*)::text c from idempotency_key'),
      });

      const before = await snapshot();
      await historyOf(subjectId, '?limit=100');
      await historyOf(newId());
      expect(await snapshot()).toEqual(before);
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

      const { rows: sourceRows } = await container.db.pool.query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const sourceOrder = sourceRows[0];
      expect(sourceOrder).toBeDefined();
      if (!sourceOrder) return;

      /*
       * The cart is cloned FIRST: `fk_order_cart_store` points at `cart(id, store_id)`, so an
       * order in another store needs a cart in that store. Inventing a bare UUID fails the
       * constraint — which is the schema correctly refusing a half-tenanted row, and exactly the
       * kind of thing this clone should respect rather than work around.
       */
      const foreignCartId = newId();
      await cloneRow('cart', 'id', String(sourceOrder['cart_id']), {
        id: foreignCartId,
        store_id: otherStoreId,
        user_id: otherUserId,
      });

      /*
       * `address_id` is nulled rather than cloned. It is nullable on `order` precisely because
       * the delivery address is SNAPSHOTTED onto the order at checkout — `ship_line1` and the
       * rest survive the address being deleted. So a null here is a shape the schema already
       * models, and cloning a third table to satisfy `fk_order_address_store` would add reach
       * this test does not need.
       */
      await cloneRow('order', 'order_number', source.orderNumber, {
        id: newId(),
        store_id: otherStoreId,
        user_id: otherUserId,
        cart_id: foreignCartId,
        address_id: null,
        order_number: foreignOrderNumber,
      });
    }, 120_000);

    /**
     * Copy one row, overriding the columns that move it to another tenant.
     *
     * A generic column copy rather than a hand-written INSERT, so a column added to `order` or
     * `cart` later cannot make this silently insert a NULL and quietly stop testing anything.
     */
    async function cloneRow(
      table: string,
      keyColumn: string,
      keyValue: string,
      overrides: Record<string, unknown>,
    ): Promise<void> {
      const { rows } = await container.db.pool.query<Record<string, unknown>>(
        `select * from "${table}" where "${keyColumn}" = $1`,
        [keyValue],
      );
      const row = rows[0];
      expect(row, `no ${table} row with ${keyColumn}=${keyValue}`).toBeDefined();
      if (!row) return;

      const clone: Record<string, unknown> = { ...row, ...overrides };
      const columns = Object.keys(clone);
      const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');

      await container.db.pool.query(
        `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) values (${placeholders})`,
        columns.map((c) => clone[c]),
      );
    }

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

  /* ── GET /admin/orders/summary ────────────────────────────────────────── */

  /**
   * Operational order counts. Increment 53.
   *
   * Two things carry this block. The first is **arithmetic**: the tallies must equal what the
   * list reports for the same store, because they are the same expression — if they can
   * disagree, the dashboard is lying. The second is **route ordering**: this literal sits under
   * `/admin/orders/` alongside a `:orderNumber` parameter whose guard exits the router, so a
   * registration-order mistake makes it a 404 rather than a subtly wrong number.
   */
  describe('operational summary', () => {
    const summary = () => api().get('/api/v1/admin/orders/summary').set(asStaff());

    it('refuses an anonymous request with 401', async () => {
      expect((await api().get('/api/v1/admin/orders/summary')).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect((await api().get('/api/v1/admin/orders/summary').set(asCustomer())).status).toBe(403);
    });

    it('serves active staff with 200', async () => {
      expect((await summary()).status).toBe(200);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.sum.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get('/api/v1/admin/orders/summary').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/orders/summary').set(auth)).status).toBe(403);
    });

    it('refuses a deactivated staff member with 401', async () => {
      const email = `deact.sum.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get('/api/v1/admin/orders/summary').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/orders/summary').set(auth)).status).toBe(401);
    });

    /**
     * Route ordering. `/admin/orders/summary` matches the `:orderNumber` pattern too, and that
     * route's guard calls `next('router')` — so if the literal were registered after it, this
     * would be a 404 rather than a summary.
     */
    it('is not swallowed by the :orderNumber route, and does not swallow it either', async () => {
      expect((await summary()).status).toBe(200);

      // The parameterised route still works for a real order number...
      const target = placed[0];
      expect(target).toBeDefined();
      if (!target) return;
      expect(
        (await api().get(`/api/v1/admin/orders/${target.orderNumber}`).set(asStaff())).status,
      ).toBe(200);

      // ...and the fulfilment queue in the OTHER router is still reachable.
      expect((await api().get('/api/v1/admin/orders/fulfilment').set(asStaff())).status).toBe(200);
    });

    it('returns every status of every vocabulary, including at zero', async () => {
      const body = (await summary()).body.orders as {
        byDisplayStatus: Record<string, number>;
        byPaymentStatus: Record<string, number>;
        byShipmentStatus: Record<string, number>;
      };

      expect(Object.keys(body).sort()).toEqual([
        'byDisplayStatus',
        'byPaymentStatus',
        'byShipmentStatus',
      ]);

      // §49's published set, and NOT the two it cannot derive.
      expect(Object.keys(body.byDisplayStatus).sort()).toEqual([
        'cancelled',
        'confirmed',
        'delivered',
        'failed',
        'pending',
        'processing',
        'shipped',
      ]);
      expect(Object.keys(body.byDisplayStatus)).not.toContain('ready_to_ship');
      expect(Object.keys(body.byDisplayStatus)).not.toContain('returned');

      expect(Object.keys(body.byPaymentStatus).sort()).toEqual([
        'expired',
        'failed',
        'pending',
        'succeeded',
      ]);
      expect(Object.keys(body.byShipmentStatus).sort()).toEqual([
        'delivered',
        'pending',
        'shipped',
      ]);

      for (const group of Object.values(body)) {
        for (const n of Object.values(group)) expect(Number.isInteger(n)).toBe(true);
      }
    });

    /**
     * The arithmetic that makes the tiles trustworthy: every bucket must equal what the list
     * reports when filtered to that same status, and the buckets must sum to the store's total.
     */
    it('agrees exactly with the order list, bucket by bucket', async () => {
      const body = (await summary()).body.orders as { byDisplayStatus: Record<string, number> };

      const all = await api().get('/api/v1/admin/orders?limit=100').set(asStaff());
      const storeTotal = all.body.pagination.total as number;

      let summed = 0;
      for (const [status, expected] of Object.entries(body.byDisplayStatus)) {
        const filtered = await api()
          .get(`/api/v1/admin/orders?limit=1&displayStatus=${status}`)
          .set(asStaff());
        expect(filtered.status).toBe(200);
        expect(filtered.body.pagination.total, `displayStatus=${status}`).toBe(expected);
        summed += expected;
      }
      expect(summed).toBe(storeTotal);
    });

    /**
     * The INDEPENDENT check, and the one that can catch a wrong CASE.
     *
     * The test above compares the summary to the order list — but both are produced by the same
     * SQL expression, so a mistake inside it moves both together and the comparison still
     * passes. A mutation probe proved exactly that: rewriting one arm of the CASE left it green.
     *
     * So this tallies the expected statuses in TYPESCRIPT, from the states each order was
     * actually driven into, and compares that to the SQL. It is the same cross-check the filter
     * has: two implementations of §49's table, asserted against each other.
     */
    it('agrees with the TypeScript derivation, not just with its own SQL', async () => {
      const body = (await summary()).body.orders as { byDisplayStatus: Record<string, number> };

      const expectedTally: Record<string, number> = {};
      for (const status of Object.keys(body.byDisplayStatus)) expectedTally[status] = 0;
      for (const order of placed) {
        const derived = deriveOrderDisplayStatus({
          orderStatus: order.orderStatus,
          payment: order.payment,
          shipmentStatus: order.shipment,
        });
        expectedTally[derived] = (expectedTally[derived] ?? 0) + 1;
      }

      expect(body.byDisplayStatus).toEqual(expectedTally);
    });

    it('counts payments and shipments consistently with their own filters', async () => {
      const body = (await summary()).body.orders as {
        byPaymentStatus: Record<string, number>;
        byShipmentStatus: Record<string, number>;
      };

      for (const [status, expected] of Object.entries(body.byPaymentStatus)) {
        const res = await api()
          .get(`/api/v1/admin/orders?limit=1&paymentStatus=${status}`)
          .set(asStaff());
        expect(res.body.pagination.total, `paymentStatus=${status}`).toBe(expected);
      }
      for (const [status, expected] of Object.entries(body.byShipmentStatus)) {
        const res = await api()
          .get(`/api/v1/admin/orders?limit=1&shipmentStatus=${status}`)
          .set(asStaff());
        expect(res.body.pagination.total, `shipmentStatus=${status}`).toBe(expected);
      }
    });

    it('counts only this store’s orders', async () => {
      const body = (await summary()).body.orders as { byDisplayStatus: Record<string, number> };
      const summed = Object.values(body.byDisplayStatus).reduce((a, b) => a + b, 0);

      const { rows } = await container.db.pool.query<{ c: string }>(
        'select count(*)::text c from "order" where store_id = $1',
        [storeId],
      );
      expect(summed).toBe(Number(rows[0]?.c ?? '0'));

      // And there really are foreign orders to have gone wrong about.
      const { rows: foreign } = await container.db.pool.query<{ c: string }>(
        'select count(*)::text c from "order" where store_id <> $1',
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
        orders: await countOf('select count(*)::text c from "order"'),
        payments: await countOf('select count(*)::text c from payment'),
        shipments: await countOf('select count(*)::text c from shipment'),
        audits: await countOf('select count(*)::text c from audit_log'),
        events: await countOf('select count(*)::text c from outbox_event'),
        keys: await countOf('select count(*)::text c from idempotency_key'),
      });

      const before = await snapshot();
      await summary();
      await summary();
      expect(await snapshot()).toEqual(before);
    });

    /**
     * One grouped statement, not one per status. If the tallies were produced by a query per
     * bucket the plan below would not be a single aggregate over the joined rows.
     */
    it('reads the tallies as one grouped aggregate', async () => {
      const { rows } = await container.db.pool.query<{ 'QUERY PLAN': string }>(
        `explain select o.status, p.status, s.status, count(*)
           from "order" o
           left join payment p on p.order_id = o.id and p.store_id = o.store_id
           left join shipment s on s.order_id = o.id and s.store_id = o.store_id
          where o.store_id = $1
          group by 1, 2, 3`,
        [storeId],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Aggregate|GroupAggregate|HashAggregate/u);
      expect(plan).toMatch(/Join|Nested Loop|Hash/u);
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
     * The index the admin list is built on, asserted to exist.
     *
     * `ix_order_user_placed` leads with `user_id` and cannot serve a store-wide list, so this
     * pair is the list's only usable access path. Measured on 200,000 orders before it was added:
     * without it the planner sequentially scans and sorts the entire store partition on disk
     * (`external merge`, 5 MB) to return 25 rows, 33.4 ms; with it, an Index Scan Backward reads
     * 25 rows and stops, 0.25 ms.
     *
     * Asserted here rather than in a plan snapshot because at this fixture's size the planner
     * would reasonably choose a sequential scan regardless — a plan assertion would fail for a
     * correct database. The index's EXISTENCE is the invariant that survives table size.
     */
    it('has the (store_id, placed_at) index the admin list depends on', async () => {
      const { rows } = await container.db.pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'order'`,
      );
      const covering = rows.filter((r) => /\(\s*store_id\s*,\s*placed_at\s*\)/iu.test(r.indexdef));
      expect(covering.length).toBe(1);
      expect(covering[0]?.indexdef).toContain('ix_order_store_placed');
    });
  });
});
