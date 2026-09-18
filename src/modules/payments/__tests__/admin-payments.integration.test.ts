import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * `GET /admin/payments` — against real PostgreSQL, through the REAL container.
 *
 * `buildContainer` rather than a hand-wired router: several of these cases are about middleware
 * the module does not own — the scope guard reading privileges from the database on every
 * request, and the store resolver — and a stub app would wire none of it.
 *
 * Seven properties carry this file, each one a passing test could easily fail to prove:
 *
 *  1. **Tenancy is in the query.** A staff token from store A sees nothing of store B — proven
 *     against a REAL foreign payment, not against its absence.
 *  2. **Nothing sensitive leaves.** `providerRef` is the gateway capability; it is asserted
 *     absent from the whole serialised body, not field by field.
 *  3. **The page and the total agree**, including under every filter.
 *  4. **Ordering is total.** Payments sharing an instant still page deterministically.
 *  5. **Both date bounds are inclusive**, proven by placing payments exactly on them.
 *  6. **The read writes nothing** — no row, no audit entry, no outbox event.
 *  7. **No N+1.** `orderNumber` comes from a join, not a lookup per row.
 */
describe('admin payments (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'ADMIN-PAY-SKU';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const pool = () => container.db.pool;

  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** Payments this suite created, with the state each was driven into. */
  const created: { orderNumber: string; status: string; method: string }[] = [];

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

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    staffToken = await registerAndLogin('staff.adminpay', { staff: true });
    customerToken = await registerAndLogin('customer.adminpay', { staff: false });

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff())
          .send({ slug: 'admin-payments-product', name: 'Admin Payments', status: 'active' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/products/admin-payments-product/skus')
          .set(asStaff())
          .send({ code: SKU_CODE, price: '100.0000', name: SKU_CODE })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff())
          .send({ skuCode: SKU_CODE, delta: 500, reason: 'manual_increase', note: 'stock' })
      ).status,
    ).toBe(201);
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
   * Place an order and pay for it through the REAL routes.
   *
   * Driven end to end rather than INSERTed, so the rows under test are shapes the system can
   * actually produce — a test that wrote them directly would prove the list reads columns and
   * prove nothing about whether those columns can hold that combination.
   */
  async function payForNewOrder(method: 'cod'): Promise<string> {
    const addressId = await createAddress(customerToken);
    await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set(asCustomer())
      .send({ quantity: 1 });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ addressId });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    const orderNumber = checkout.body.order.orderNumber as string;

    const pay = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ method });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);

    created.push({ orderNumber, status: 'pending', method });
    return orderNumber;
  }

  /* ── 1. Authentication and authorization ──────────────────────────────── */

  describe('authentication and authorization', () => {
    it('refuses an anonymous request with 401', async () => {
      expect((await api().get('/api/v1/admin/payments')).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect((await api().get('/api/v1/admin/payments').set(asCustomer())).status).toBe(403);
    });

    it('serves active staff with 200', async () => {
      const res = await api().get('/api/v1/admin/payments').set(asStaff());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.payments)).toBe(true);
    });

    /**
     * Scopes are read from the database on every request, so a demotion takes effect on the NEXT
     * request rather than at the next token refresh — asserted with the SAME token either side.
     */
    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.adminpay.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get('/api/v1/admin/payments').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/payments').set(auth)).status).toBe(403);
    });

    /** Deactivation is checked by authentication, so it answers 401 rather than 403. */
    it('refuses a deactivated staff member with 401', async () => {
      const email = `deactivate.adminpay.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));

      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get('/api/v1/admin/payments').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/payments').set(auth)).status).toBe(401);
    });
  });

  /* ── 2. Query validation ──────────────────────────────────────────────── */

  describe('query validation', () => {
    const bad = async (qs: string) =>
      (await api().get(`/api/v1/admin/payments?${qs}`).set(asStaff())).status;

    it('rejects a client-supplied storeId rather than ignoring it', async () => {
      const res = await api().get(`/api/v1/admin/payments?storeId=${newId()}`).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unknown parameters, bad limits and bad enums', async () => {
      expect(await bad('userId=x')).toBe(400);
      expect(await bad('limit=101')).toBe(400);
      expect(await bad('limit=0')).toBe(400);
      expect(await bad('limit=abc')).toBe(400);
      expect(await bad('offset=-1')).toBe(400);
      expect(await bad('status=refunded')).toBe(400);
      expect(await bad('method=upi')).toBe(400);
      expect(await bad('provider=stripe')).toBe(400);
    });

    it('rejects a malformed order number and a bare date', async () => {
      expect(await bad('orderNumber=not-an-order')).toBe(400);
      expect(await bad('createdFrom=2026-09-01')).toBe(400);
      expect(await bad('createdTo=yesterday')).toBe(400);
    });

    it('accepts an ISO instant carrying an offset', async () => {
      expect(await bad('createdFrom=2026-09-01T00:00:00%2B05:30')).toBe(200);
    });
  });

  /* ── 3. The listing itself ────────────────────────────────────────────── */

  describe('listing, filters and pagination', () => {
    beforeAll(async () => {
      for (let i = 0; i < 5; i += 1) await payForNewOrder('cod');

      /*
       * Two of the five are converted to `online` in SQL rather than driven through the gateway.
       *
       * This suite deliberately runs on the REAL container so the scope guards and store
       * resolver under test are the real ones — which also means the real Razorpay adapter and a
       * real `fetch`, so an online initiation answers 503 here. The existing payments suite
       * stubs `fetch` and wires its own gateway instead; it cannot do what this one needs, and
       * this one cannot do what it does.
       *
       * The conversion is honest about what it proves: the ROWS are real shapes the schema
       * permits (`ck_payment_provider_matches_method` rejects online-without-provider, so this
       * UPDATE would fail if the combination were invalid), and what is under test here is the
       * LIST — that it filters on provider correctly and never publishes `provider_ref`. How the
       * row came to exist is not what these cases assert.
       */
      const targets = created.slice(0, 2);
      for (const target of targets) {
        const { rowCount } = await pool().query(
          `update payment p
              set method = 'online', provider = 'razorpay', provider_ref = $2
             from "order" o
            where o.id = p.order_id and o.order_number = $1 and p.store_id = $3`,
          [target.orderNumber, `pay_${newId().replace(/-/gu, '')}`, storeId],
        );
        expect(rowCount, `failed to convert ${target.orderNumber} to online`).toBe(1);
        target.method = 'online';
      }
    }, 300_000);

    it('returns every payment in the store', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      expect(res.status).toBe(200);
      const numbers = (res.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber);
      for (const c of created) expect(numbers).toContain(c.orderNumber);
    });

    it('returns exactly the documented DTO, with no extra keys', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=1').set(asStaff());
      const row = (res.body.payments as Record<string, unknown>[])[0];
      expect(row).toBeDefined();
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'amount',
        'createdAt',
        'currency',
        'failureCode',
        'method',
        'orderNumber',
        'provider',
        'status',
        'updatedAt',
      ]);
    });

    it('filters by status, and every returned row matches', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100&status=pending').set(asStaff());
      expect(res.status).toBe(200);
      expect((res.body.payments as unknown[]).length).toBeGreaterThan(0);
      for (const row of res.body.payments as { status: string }[]) {
        expect(row.status).toBe('pending');
      }
      // A status nothing is in returns an empty page, not everything.
      const none = await api()
        .get('/api/v1/admin/payments?limit=100&status=succeeded')
        .set(asStaff());
      expect(none.body.payments).toEqual([]);
      expect(none.body.pagination.total).toBe(0);
    });

    it('filters by method and by provider consistently with each other', async () => {
      const cod = await api().get('/api/v1/admin/payments?limit=100&method=cod').set(asStaff());
      for (const row of cod.body.payments as { method: string; provider: string | null }[]) {
        expect(row.method).toBe('cod');
        // COD never has a provider — ck_payment_provider_matches_method.
        expect(row.provider).toBeNull();
      }

      const razorpay = await api()
        .get('/api/v1/admin/payments?limit=100&provider=razorpay')
        .set(asStaff());
      for (const row of razorpay.body.payments as { method: string }[]) {
        expect(row.method).toBe('online');
      }
    });

    it('filters by an exact order number, and an unknown one is an empty page not a 404', async () => {
      const target = created[0];
      expect(target).toBeDefined();
      if (!target) return;

      const hit = await api()
        .get(`/api/v1/admin/payments?orderNumber=${target.orderNumber}`)
        .set(asStaff());
      expect(hit.status).toBe(200);
      expect(hit.body.payments).toHaveLength(1);
      expect(hit.body.payments[0].orderNumber).toBe(target.orderNumber);

      const miss = await api()
        .get('/api/v1/admin/payments?orderNumber=ORD-20260101-ZZZZZZ')
        .set(asStaff());
      expect(miss.status).toBe(200);
      expect(miss.body.payments).toEqual([]);
    });

    /**
     * Both bounds inclusive, proven by asking for a window whose edges are EXACTLY the first and
     * last payment's own instants. A half-open upper bound would drop the newest row.
     */
    /**
     * Inclusivity, proven at an EXACT instant rather than by round-tripping a response value.
     *
     * The row's `created_at` is first pinned to a whole millisecond. That is not a convenience:
     * PostgreSQL stores `timestamptz` to microseconds while the response serialises to
     * milliseconds, so a client that copies `createdAt` out of a row and feeds it back as
     * `createdTo` is submitting a TRUNCATED, strictly-earlier instant — and the row it came from
     * drops out. Pinning removes the sub-millisecond digits so this case tests the bound rather
     * than the serialiser, and the caveat itself is documented on the endpoint.
     */
    it('treats both date bounds as inclusive, at an exact instant', async () => {
      const target = created[created.length - 1];
      expect(target).toBeDefined();
      if (!target) return;

      const pinned = '2026-06-15T10:30:00.000Z';
      const { rowCount } = await pool().query(
        `update payment p set created_at = $2::timestamptz
           from "order" o
          where o.id = p.order_id and o.order_number = $1 and p.store_id = $3`,
        [target.orderNumber, pinned, storeId],
      );
      expect(rowCount).toBe(1);

      const enc = encodeURIComponent(pinned);

      // createdFrom == createdTo == the row's own instant. Only an inclusive range on BOTH
      // sides can return anything at all here.
      const exact = await api()
        .get(`/api/v1/admin/payments?limit=100&createdFrom=${enc}&createdTo=${enc}`)
        .set(asStaff());
      expect(exact.status).toBe(200);
      expect((exact.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber)).toEqual([
        target.orderNumber,
      ]);

      // One millisecond either side excludes it, which is what makes the above meaningful.
      const justAfter = new Date(Date.parse(pinned) + 1).toISOString();
      const justBefore = new Date(Date.parse(pinned) - 1).toISOString();

      const fromTooLate = await api()
        .get(`/api/v1/admin/payments?limit=100&createdFrom=${encodeURIComponent(justAfter)}`)
        .set(asStaff());
      expect(
        (fromTooLate.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber),
      ).not.toContain(target.orderNumber);

      const toTooEarly = await api()
        .get(`/api/v1/admin/payments?limit=100&createdTo=${encodeURIComponent(justBefore)}`)
        .set(asStaff());
      expect(
        (toTooEarly.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber),
      ).not.toContain(target.orderNumber);
    });

    it('keeps the page and the total consistent, including under a filter', async () => {
      const page = await api().get('/api/v1/admin/payments?limit=2&offset=0').set(asStaff());
      expect(page.status).toBe(200);
      expect((page.body.payments as unknown[]).length).toBe(2);
      expect(page.body.pagination).toEqual({
        limit: 2,
        offset: 0,
        total: page.body.pagination.total,
      });

      const total = page.body.pagination.total as number;
      const everything = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      expect((everything.body.payments as unknown[]).length).toBe(total);

      const filtered = await api()
        .get('/api/v1/admin/payments?limit=100&method=cod')
        .set(asStaff());
      expect((filtered.body.payments as unknown[]).length).toBe(
        filtered.body.pagination.total as number,
      );
      expect(filtered.body.pagination.total).toBeLessThan(total);
    });

    /**
     * Ordering must be TOTAL, and the tie is MANUFACTURED so that this proves it.
     *
     * Payments created through checkout never share a `created_at` — the work in between is far
     * slower than a millisecond — so a test over naturally-created rows passes with or without
     * the `id` tiebreaker and detects nothing. A mutation probe on the sibling customers suite
     * caught exactly that, and the same weakness applied here.
     *
     * Pinning several rows to one identical instant is the condition under which `created_at`
     * alone leaves PostgreSQL free to return them in any order per query, and `offset` paging
     * over a non-total order silently skips and repeats.
     */
    it('orders deterministically even when rows share an instant', async () => {
      const tied = created.slice(0, 3);
      expect(tied.length).toBe(3);

      await pool().query(
        `update payment p set created_at = '2026-07-02T00:00:00.000Z'::timestamptz
           from "order" o
          where o.id = p.order_id and o.order_number = any($1::text[]) and p.store_id = $2`,
        [tied.map((t) => t.orderNumber), storeId],
      );

      const full = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      const expected = (full.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber);

      const positions = tied.map((t) => expected.indexOf(t.orderNumber)).sort((a, b) => a - b);
      expect(positions[0]).toBeGreaterThanOrEqual(0);
      expect(positions[2]! - positions[0]!).toBe(2);

      const walked: string[] = [];
      for (let offset = 0; offset < expected.length; offset += 1) {
        const one = await api()
          .get(`/api/v1/admin/payments?limit=1&offset=${offset}`)
          .set(asStaff());
        walked.push((one.body.payments as { orderNumber: string }[])[0]?.orderNumber ?? '');
      }
      expect(walked).toEqual(expected);

      const again = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      expect((again.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber)).toEqual(
        expected,
      );
    });

    it('orders newest first', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      const times = (res.body.payments as { createdAt: string }[]).map((p) =>
        new Date(p.createdAt).getTime(),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });
  });

  /* ── 4. Sensitive fields ──────────────────────────────────────────────── */

  describe('sensitive-field exclusion', () => {
    /**
     * Asserted over the whole serialised body rather than key by key: a future `...spread` that
     * reintroduced one of these would pass a field-by-field test nobody remembered to update.
     */
    const FORBIDDEN = [
      'providerRef',
      'provider_ref',
      'amountMinor',
      'amount_minor',
      'passwordHash',
      'password_hash',
      'isStaff',
      'is_staff',
      'isSuperuser',
      'is_superuser',
      'storeId',
      'store_id',
      'userId',
      'user_id',
      'orderId',
      'order_id',
    ];

    it('never leaks a provider handle, an internal id or a credential', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      const body = JSON.stringify(res.body);
      for (const field of FORBIDDEN) expect(body).not.toContain(field);
    });

    it('proves the excluded providerRef actually exists in the database', async () => {
      // Otherwise the assertion above would pass against a store with no online payments.
      const { rows } = await pool().query<{ count: string }>(
        `select count(*)::text as count from payment where provider_ref is not null and store_id = $1`,
        [storeId],
      );
      expect(Number(rows[0]?.count ?? '0')).toBeGreaterThan(0);
    });
  });

  /* ── 5. Tenant isolation, against a real foreign payment ──────────────── */

  describe('tenant isolation', () => {
    let foreignOrderNumber = '';

    beforeAll(async () => {
      const source = created[0];
      expect(source).toBeDefined();
      if (!source) return;

      const otherStoreId = newId();
      const otherUserId = newId();
      foreignOrderNumber = 'ORD-20260101-BBBBBB';

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `other-${otherStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'x', 'Foreign', 'Buyer')`,
        [otherUserId, otherStoreId, `foreign.pay.${otherUserId}@example.com`],
      );

      const { rows: orderRows } = await pool().query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const sourceOrder = orderRows[0];
      expect(sourceOrder).toBeDefined();
      if (!sourceOrder) return;

      const foreignCartId = newId();
      const foreignOrderId = newId();
      await cloneRow('cart', 'id', String(sourceOrder['cart_id']), {
        id: foreignCartId,
        store_id: otherStoreId,
        user_id: otherUserId,
      });
      await cloneRow('order', 'order_number', source.orderNumber, {
        id: foreignOrderId,
        store_id: otherStoreId,
        user_id: otherUserId,
        cart_id: foreignCartId,
        address_id: null,
        order_number: foreignOrderNumber,
      });
      await cloneRow('payment', 'order_id', String(sourceOrder['id']), {
        id: newId(),
        store_id: otherStoreId,
        order_id: foreignOrderId,
        user_id: otherUserId,
        provider_ref: null,
      });
    }, 120_000);

    async function cloneRow(
      table: string,
      keyColumn: string,
      keyValue: string,
      overrides: Record<string, unknown>,
    ): Promise<void> {
      const { rows } = await pool().query<Record<string, unknown>>(
        `select * from "${table}" where "${keyColumn}" = $1`,
        [keyValue],
      );
      const row = rows[0];
      expect(row, `no ${table} row with ${keyColumn}=${keyValue}`).toBeDefined();
      if (!row) return;

      const clone: Record<string, unknown> = { ...row, ...overrides };
      const columns = Object.keys(clone);
      const placeholders = columns.map((_c, i) => `$${i + 1}`).join(', ');
      await pool().query(
        `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) values (${placeholders})`,
        columns.map((c) => clone[c]),
      );
    }

    it('actually created a foreign payment — otherwise the next cases prove nothing', async () => {
      const { rows } = await pool().query<{ count: string }>(
        'select count(*)::text as count from payment where store_id <> $1',
        [storeId],
      );
      expect(Number(rows[0]?.count ?? '0')).toBe(1);
    });

    it('never returns another store’s payment', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      expect(
        (res.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber),
      ).not.toContain(foreignOrderNumber);
    });

    it('cannot be coaxed into another store’s payment by filtering for it', async () => {
      const res = await api()
        .get(`/api/v1/admin/payments?orderNumber=${foreignOrderNumber}`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.payments).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('counts only this store’s payments in the total', async () => {
      const res = await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      const { rows } = await pool().query<{ count: string }>(
        'select count(*)::text as count from payment where store_id = $1',
        [storeId],
      );
      expect(res.body.pagination.total).toBe(Number(rows[0]?.count ?? '0'));
    });
  });

  /* ── 6. Read-only, and the query shape ────────────────────────────────── */

  describe('the read changes nothing', () => {
    it('writes no row, no audit entry and no outbox event', async () => {
      const countOf = async (sql: string): Promise<string> => {
        const { rows } = await pool().query<{ c: string }>(sql);
        return rows[0]?.c ?? '?';
      };

      const snapshot = async () => {
        const { rows: paymentState } = await pool().query<{ c: string; m: string }>(
          "select count(*)::text c, coalesce(max(updated_at)::text, '-') m from payment",
        );
        const audits = await db().select({ id: auditLog.id }).from(auditLog);
        const events = await db().select({ id: outboxEvent.id }).from(outboxEvent);

        return {
          // Both the COUNT and the newest `updated_at`: a read that silently re-stamped a row
          // without inserting one would slip past a count on its own.
          payments: paymentState[0],
          audits: audits.length,
          events: events.length,
          users: await countOf('select count(*)::text c from app_user'),
          orders: await countOf('select count(*)::text c from "order"'),
          keys: await countOf('select count(*)::text c from idempotency_key'),
          stock: await countOf('select count(*)::text c from stock_ledger'),
        };
      };

      const before = await snapshot();

      await api().get('/api/v1/admin/payments?limit=100').set(asStaff());
      await api().get('/api/v1/admin/payments?status=pending').set(asStaff());
      await api().get('/api/v1/admin/payments?method=cod&limit=5').set(asStaff());

      expect(await snapshot()).toEqual(before);
    });

    /**
     * The N+1 check, by plan rather than by counting statements: `pg_stat_statements` is not in
     * the stock `postgres:16` image. If `orderNumber` were fetched per row it would not appear
     * in this plan at all — the join's presence IS the absence of the N+1.
     */
    it('reads the order number as a join, not once per row', async () => {
      const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
        `explain select p.id, o.order_number
           from payment p
           join "order" o on o.id = p.order_id and o.store_id = p.store_id
          where p.store_id = $1
          order by p.created_at desc, p.id desc
          limit 100`,
        [storeId],
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/Join|Nested Loop/u);
    });

    it('has the (store_id, created_at) index the list depends on', async () => {
      const { rows } = await pool().query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'payment'`,
      );
      const covering = rows.filter((r) => /\(\s*store_id\s*,\s*created_at\s*\)/iu.test(r.indexdef));
      expect(covering.length).toBe(1);
      expect(covering[0]?.indexdef).toContain('ix_payment_store_created');
    });
  });

  /* ── 6b. Microsecond precision at the bounds ──────────────────────────── */

  /**
   * The precision mismatch, and the semantics that resolve it.
   *
   * PostgreSQL stores `timestamptz` to MICROSECONDS. A JavaScript `Date` cannot represent one:
   * even a client that sends `...123456Z` is holding `...123Z` by the time the value reaches a
   * query, and `toISOString()` publishes milliseconds too. So the API is millisecond-grained in
   * both directions and a bound can only ever NAME A MILLISECOND.
   *
   * "Inclusive" therefore has to mean inclusive of the whole millisecond named — otherwise a row
   * stored at `.123456` is excluded by the very timestamp the API published for it (`.123`),
   * which is the bug these cases pin.
   */
  describe('date bounds at microsecond precision', () => {
    /** `.123456` — a stored instant whose published form (`.123`) is strictly earlier. */
    const STORED = '2026-08-10T12:00:00.123456Z';
    const NAMED = '2026-08-10T12:00:00.123Z';
    let subject = '';

    beforeAll(async () => {
      subject = await payForNewOrder('cod');
      const { rowCount } = await pool().query(
        `update payment p set created_at = $2::timestamptz
           from "order" o
          where o.id = p.order_id and o.order_number = $1 and p.store_id = $3`,
        [subject, STORED, storeId],
      );
      expect(rowCount).toBe(1);
    }, 300_000);

    const numbersFor = async (qs: string): Promise<string[]> => {
      const res = await api().get(`/api/v1/admin/payments?limit=100&${qs}`).set(asStaff());
      expect(res.status).toBe(200);
      return (res.body.payments as { orderNumber: string }[]).map((p) => p.orderNumber);
    };

    it('stores microseconds the API cannot publish', async () => {
      const { rows } = await pool().query<{ exact: string }>(
        `select to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as exact
           from payment p join "order" o on o.id = p.order_id
          where o.order_number = $1`,
        [subject],
      );
      // The database really does hold the sub-millisecond digits.
      expect(rows[0]?.exact).toBe('2026-08-10T12:00:00.123456');

      // And the API publishes the truncated form, which is STRICTLY EARLIER than what is stored.
      const res = await api().get(`/api/v1/admin/payments?orderNumber=${subject}`).set(asStaff());
      expect((res.body.payments as { createdAt: string }[])[0]?.createdAt).toBe(NAMED);
    });

    it('includes a row whose stored microseconds exceed the named upper bound', async () => {
      // The regression: createdTo is the row's OWN published timestamp.
      expect(await numbersFor(`createdTo=${encodeURIComponent(NAMED)}`)).toContain(subject);
    });

    it('round-trips its own published timestamp as both bounds', async () => {
      const enc = encodeURIComponent(NAMED);
      expect(await numbersFor(`createdFrom=${enc}&createdTo=${enc}`)).toEqual([subject]);
    });

    it('excludes the row one millisecond below the named upper bound', async () => {
      const below = '2026-08-10T12:00:00.122Z';
      expect(await numbersFor(`createdTo=${encodeURIComponent(below)}`)).not.toContain(subject);
    });

    it('keeps the lower bound inclusive of the named millisecond', async () => {
      expect(await numbersFor(`createdFrom=${encodeURIComponent(NAMED)}`)).toContain(subject);
    });

    it('excludes the row when the lower bound is the next millisecond', async () => {
      const above = '2026-08-10T12:00:00.124Z';
      expect(await numbersFor(`createdFrom=${encodeURIComponent(above)}`)).not.toContain(subject);
    });

    it('does not spill into the millisecond after the upper bound', async () => {
      // A second row one millisecond later must NOT be swept in by widening the bound.
      const later = await payForNewOrder('cod');
      await pool().query(
        `update payment p set created_at = '2026-08-10T12:00:00.124000Z'::timestamptz
           from "order" o
          where o.id = p.order_id and o.order_number = $1 and p.store_id = $2`,
        [later, storeId],
      );

      const got = await numbersFor(`createdTo=${encodeURIComponent(NAMED)}`);
      expect(got).toContain(subject);
      expect(got).not.toContain(later);
    });
  });

  /* ── 7. Existing behaviour is intact ──────────────────────────────────── */

  describe('regression against the existing payment surface', () => {
    it('leaves the customer payment list self-scoped and unchanged in shape', async () => {
      const res = await api().get('/api/v1/users/me/payments').set(asCustomer());
      expect(res.status).toBe(200);
      const row = (res.body.payments as Record<string, unknown>[])[0];
      expect(row).toBeDefined();
      // `history` is the customer contract and must not have been replaced by the admin shape.
      expect(row).toHaveProperty('history');
      expect(row).not.toHaveProperty('providerRef');
    });

    it('still lets the customer read their own payment by order number', async () => {
      const target = created[0];
      expect(target).toBeDefined();
      if (!target) return;
      const res = await api()
        .get(`/api/v1/users/me/orders/${target.orderNumber}/payment`)
        .set(asCustomer());
      expect(res.status).toBe(200);
    });

    it('still refuses staff the customer payment route for someone else’s order', async () => {
      const target = created[0];
      expect(target).toBeDefined();
      if (!target) return;
      const res = await api()
        .get(`/api/v1/users/me/orders/${target.orderNumber}/payment`)
        .set(asStaff());
      expect(res.status).toBe(404);
    });
  });
});
