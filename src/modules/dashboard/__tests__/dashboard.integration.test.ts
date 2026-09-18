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

/**
 * `GET /api/v1/admin/dashboard` — the admin overview screen. Increment 57.
 *
 * Seven widgets composed from four modules, and what this file is really testing is that the
 * composition did not quietly invent a definition. Every figure has a stated business meaning,
 * and each one is asserted against an INDEPENDENT derivation — a direct `SUM`, a direct `count`,
 * a hand-computed total — rather than against a second call into the same code.
 *
 * ## Fixtures are written as SQL
 *
 * Orders are inserted directly rather than placed through checkout. This suite has no cart and
 * no payment gateway, and building both to assert an aggregate would test checkout instead. The
 * rows are real `order` and `order_line` rows satisfying every constraint, including the GST
 * determination snapshot, which is what the aggregates read.
 *
 * ## The clock
 *
 * The route takes an injected `now`, but the container wires the real one — so every window
 * assertion below supplies explicit `from`/`to` instants rather than relying on the default,
 * except the one test whose subject IS the default.
 */
describe('admin dashboard (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';
  let customerId = '';

  const PASSWORD = 'a-sufficiently-long-password';

  /** The store's configured zone, and the one every bucket assertion below is expressed in. */
  const TZ = '+05:30';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const pool = () => container.db.pool;

  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /* ── Fixture bookkeeping ──────────────────────────────────────────────── */

  const WINDOW_FROM = `2026-01-01T00:00:00${TZ}`;
  const WINDOW_TO = `2026-06-30T23:59:59.999${TZ}`;

  let seq = 0;
  const nextCode = (): string => {
    seq += 1;
    return String(seq).padStart(4, '0');
  };

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

    const staff = await register('staff.dash');
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staff.id));
    staffToken = await login(staff.email);

    const customer = await register('customer.dash');
    customerId = customer.id;
    customerToken = await login(customer.email);
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function register(prefix: string): Promise<{ id: string; email: string }> {
    const email = `${prefix}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Test', lastName: 'User' },
    });
    return { id: user.id, email };
  }

  async function login(email: string): Promise<string> {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.accessToken as string;
  }

  /** One product, with the status and liveness the caller asks for. */
  async function makeProduct(opts: {
    store?: string;
    status?: 'active' | 'draft' | 'archived';
    deleted?: boolean;
    name?: string;
  }): Promise<string> {
    const id = newId();
    await pool().query(
      `insert into product (id, store_id, slug, name, description, status, deleted_at)
       values ($1, $2, $3, $4, '', $5, $6)`,
      [
        id,
        opts.store ?? storeId,
        `p-${nextCode()}-${id.slice(0, 8)}`,
        opts.name ?? `Product ${nextCode()}`,
        opts.status ?? 'active',
        opts.deleted === true ? new Date() : null,
      ],
    );
    return id;
  }

  /** One SKU with its stock row, and optionally a reorder threshold. */
  async function makeSku(opts: {
    productId: string;
    store?: string;
    code?: string;
    name?: string;
    threshold?: number | null;
    onHand?: number;
    reserved?: number;
    isActive?: boolean;
    deleted?: boolean;
  }): Promise<{ id: string; code: string }> {
    const id = newId();
    const code = opts.code ?? `SKU-${nextCode()}`;
    await pool().query(
      `insert into sku (id, store_id, product_id, code, name, price, is_active,
                        low_stock_threshold, deleted_at)
       values ($1, $2, $3, $4, $5, '100.0000', $6, $7, $8)`,
      [
        id,
        opts.store ?? storeId,
        opts.productId,
        code,
        opts.name ?? `Variant ${code}`,
        opts.isActive ?? true,
        opts.threshold ?? null,
        opts.deleted === true ? new Date() : null,
      ],
    );
    await pool().query(
      `insert into stock_item (sku_id, store_id, on_hand, reserved) values ($1, $2, $3, $4)`,
      [id, opts.store ?? storeId, opts.onHand ?? 0, opts.reserved ?? 0],
    );
    return { id, code };
  }

  /**
   * One order with its lines.
   *
   * `total` is the goods total and `taxTotal` the GST on top; `grand_total` is their sum, which
   * `ck_order_grand_total_identity` enforces. The tax is not decoration — it is what makes a
   * mutation that sums `total` instead of `grand_total` detectable.
   */
  async function makeOrder(opts: {
    store?: string;
    userId?: string;
    placedAt: string;
    total: string;
    taxTotal: string;
    cancelled?: boolean;
    lines?: {
      skuId: string;
      code: string;
      productName: string;
      skuName: string;
      quantity: number;
      /** `lineTotal` and `taxableValue` are both `unitPrice * quantity`, per the row CHECKs. */
      unitPrice: string;
      taxTotal: string;
    }[];
  }): Promise<string> {
    const store = opts.store ?? storeId;
    const user = opts.userId ?? customerId;

    const cartId = newId();
    await pool().query(
      `insert into cart (id, user_id, store_id, status) values ($1, $2, $3, 'checked_out')`,
      [cartId, user, store],
    );

    const orderId = newId();
    await pool().query(
      `insert into "order" (
         id, store_id, user_id, cart_id, order_number, status, currency,
         subtotal, discount_total, total, tax_total, grand_total,
         ship_recipient_name, ship_phone, ship_line1, ship_city, ship_state,
         ship_postal_code, ship_country_code, placed_at,
         tax_at, supply_type, place_of_supply_state, place_of_supply_basis,
         seller_gstin, seller_legal_name, origin_line1, origin_city, origin_state,
         origin_postal_code, origin_country_code, customer_tax_category
       ) values (
         $1, $2, $3, $4, $5, $6, 'INR',
         $7, 0, $7, $8, ($7::numeric + $8::numeric),
         'Test Recipient', '+919876543210', '1 Test Street', 'Bengaluru', 'Karnataka',
         '560001', 'IN', $9,
         now(), 'intra_state', 'Karnataka', 'delivery_destination',
         '29AAAAA0000A1Z5', 'Test Seller', '1 Origin Road', 'Bengaluru', 'Karnataka',
         '560001', 'IN', 'b2c'
       )`,
      [
        orderId,
        store,
        user,
        cartId,
        `ORD-20260101-${nextCode()}AB`,
        opts.cancelled === true ? 'cancelled' : 'placed',
        opts.total,
        opts.taxTotal,
        opts.placedAt,
      ],
    );

    for (const line of opts.lines ?? []) {
      await pool().query(
        `insert into order_line (
           order_id, sku_id, store_id, sku_code, sku_name, product_name,
           quantity, unit_price, line_total, discount_amount, taxable_value, tax_total,
           hsn_code, tax_class_code, tax_class_name, cgst_rate, cgst_amount, sgst_rate, sgst_amount
         ) values ($1, $2, $3, $4, $5, $6, $7::integer, $8::numeric,
                   ($8::numeric * $7::integer), 0, ($8::numeric * $7::integer), $9::numeric,
                   /*
                    * The classification snapshot a taxed line must carry —
                    * ck_order_line_tax_needs_classification refuses tax_total > 0 without it.
                    * Split evenly as CGST + SGST, which is what an intra-state supply produces.
                    */
                   '8413', 'GST-18', 'Pumps 18%', 9, ($9::numeric / 2), 9, ($9::numeric / 2))`,
        [
          orderId,
          line.skuId,
          store,
          line.code,
          line.skuName,
          line.productName,
          line.quantity,
          line.unitPrice,
          line.taxTotal,
        ],
      );
    }

    return orderId;
  }

  const dash = (qs = '') => api().get(`/api/v1/admin/dashboard${qs}`).set(asStaff());

  const inWindow = (extra = '') =>
    dash(`?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}${extra}`);

  /* ── 1. Authentication and authorization ──────────────────────────────── */

  describe('authentication and authorization', () => {
    it('refuses an anonymous request with 401', async () => {
      expect((await api().get('/api/v1/admin/dashboard')).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect((await api().get('/api/v1/admin/dashboard').set(asCustomer())).status).toBe(403);
    });

    it('serves active staff with 200', async () => {
      expect((await dash()).status).toBe(200);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const user = await register('demote.dash');
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const auth = { Authorization: `Bearer ${await login(user.email)}` };

      expect((await api().get('/api/v1/admin/dashboard').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/dashboard').set(auth)).status).toBe(403);
    });

    /** Deactivation is checked by AUTHENTICATION, so it answers 401 rather than 403. */
    it('refuses a deactivated staff member with 401', async () => {
      const user = await register('deactivate.dash');
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const auth = { Authorization: `Bearer ${await login(user.email)}` };

      expect((await api().get('/api/v1/admin/dashboard').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/dashboard').set(auth)).status).toBe(401);
    });
  });

  /* ── 2. Request validation ────────────────────────────────────────────── */

  describe('query validation', () => {
    const status = async (qs: string) => (await dash(`?${qs}`)).status;

    it('rejects a client-supplied storeId rather than ignoring it', async () => {
      const res = await dash(`?storeId=${newId()}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unknown parameters and out-of-range limits', async () => {
      expect(await status('nope=1')).toBe(400);
      expect(await status('interval=hour')).toBe(400);
      expect(await status('topProductsLimit=0')).toBe(400);
      expect(await status('topProductsLimit=21')).toBe(400);
      expect(await status('lowStockLimit=51')).toBe(400);
      expect(await status('recentOrdersLimit=21')).toBe(400);
    });

    it('rejects an instant without an offset', async () => {
      expect(await status('from=2026-01-01')).toBe(400);
      expect(await status('from=2026-01-01T00:00:00')).toBe(400);
    });

    it('accepts the three supported intervals', async () => {
      for (const interval of ['day', 'week', 'month']) {
        expect(await status(`interval=${interval}`), interval).toBe(200);
      }
    });
  });

  /* ── 3. The empty store ───────────────────────────────────────────────── */

  /**
   * Runs BEFORE any fixture exists, deliberately. A dashboard whose zero state is untested is a
   * dashboard that will divide by zero, or render `null`, on a merchant's first day.
   */
  describe('the empty state', () => {
    it('answers with zeros, empty lists and a fully zero-filled status map', async () => {
      const res = await inWindow();
      expect(res.status).toBe(200);

      expect(res.body.kpis.revenue).toMatchObject({ value: '0', currency: 'INR', previous: '0' });
      expect(res.body.kpis.orders).toMatchObject({ value: 0, previous: 0 });
      expect(res.body.kpis.products).toMatchObject({ value: 0, previous: null });
      expect(res.body.kpis.customers.previous).toBeNull();

      expect(res.body.topProducts).toEqual([]);
      expect(res.body.lowStock).toEqual([]);
      expect(res.body.recentOrders).toEqual([]);

      expect(res.body.orderStatusCounts).toEqual({
        pending: 0,
        confirmed: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        failed: 0,
      });

      /* Six monthly buckets across the window, every one of them present and zero. */
      expect(res.body.salesSeries).toHaveLength(6);
      for (const point of res.body.salesSeries as { revenue: string; orders: number }[]) {
        expect(point).toMatchObject({ revenue: '0.0000', orders: 0 });
      }
    });
  });

  /* ── 4. The fixture, and every figure computed from it ────────────────── */

  describe('with data', () => {
    let activeProductId = '';
    let skuA = { id: '', code: '' };
    let skuB = { id: '', code: '' };

    beforeAll(async () => {
      /*
       * Products: one active, one draft, one archived, one active-but-deleted. Only the first
       * counts, which is what makes the other three worth creating.
       */
      activeProductId = await makeProduct({ status: 'active', name: 'Duroflo 2HP Pump' });
      await makeProduct({ status: 'draft' });
      await makeProduct({ status: 'archived' });
      await makeProduct({ status: 'active', deleted: true });

      skuA = await makeSku({
        productId: activeProductId,
        code: 'PUMP-2HP-BLK',
        name: '2 HP / Black',
        onHand: 4,
        reserved: 1,
        threshold: 10,
      });
      skuB = await makeSku({
        productId: activeProductId,
        code: 'PUMP-1HP-RED',
        name: '1 HP / Red',
        onHand: 50,
        reserved: 0,
        threshold: null,
      });

      const line = (
        sku: { id: string; code: string },
        skuName: string,
        quantity: number,
        unitPrice: string,
        taxTotal: string,
      ) => ({
        skuId: sku.id,
        code: sku.code,
        productName: 'Duroflo 2HP Pump',
        skuName,
        quantity,
        unitPrice,
        taxTotal,
      });

      /* In-window, counted. 1000 + 180 tax, and 2000 + 360 tax. */
      await makeOrder({
        placedAt: `2026-02-10T12:00:00${TZ}`,
        total: '1000.0000',
        taxTotal: '180.0000',
        lines: [line(skuA, '2 HP / Black', 5, '200.0000', '180.0000')],
      });
      await makeOrder({
        placedAt: `2026-03-15T12:00:00${TZ}`,
        total: '2100.0000',
        taxTotal: '378.0000',
        lines: [
          line(skuA, '2 HP / Black', 3, '400.0000', '216.0000'),
          line(skuB, '1 HP / Red', 9, '100.0000', '162.0000'),
        ],
      });

      /* In-window but CANCELLED, and deliberately the largest order in the fixture. */
      await makeOrder({
        placedAt: `2026-04-01T12:00:00${TZ}`,
        total: '99900.0000',
        taxTotal: '1.0000',
        cancelled: true,
        lines: [line(skuA, '2 HP / Black', 999, '100.0000', '1.0000')],
      });

      /* In the PREVIOUS window — the six months before 2026-01-01. */
      await makeOrder({
        placedAt: `2025-11-20T12:00:00${TZ}`,
        total: '500.0000',
        taxTotal: '90.0000',
      });

      /* Outside both windows entirely. */
      await makeOrder({
        placedAt: `2024-01-01T12:00:00${TZ}`,
        total: '7777.0000',
        taxTotal: '0.0000',
      });
    }, 180_000);

    /* ── revenue and orders ─────────────────────────────────────────────── */

    it('reports revenue as tax-inclusive billed value, excluding cancelled orders', async () => {
      const res = await inWindow();
      expect(res.status).toBe(200);
      /* (1000 + 180) + (2100 + 378) = 3658. The cancelled 99901 is absent. */
      expect(res.body.kpis.revenue.value).toBe('3658.0000');
      expect(res.body.kpis.revenue.currency).toBe('INR');
    });

    it('agrees with a direct SUM over the order table', async () => {
      const res = await inWindow();
      const { rows } = await pool().query<{ s: string | null; c: string }>(
        `select sum(grand_total)::text s, count(*)::text c from "order"
          where store_id = $1 and status <> 'cancelled'
            and placed_at >= $2 and placed_at < $3`,
        [storeId, WINDOW_FROM, '2026-07-01T00:00:00+05:30'],
      );
      expect(res.body.kpis.revenue.value).toBe(rows[0]?.s);
      expect(res.body.kpis.orders.value).toBe(Number(rows[0]?.c));
    });

    it('publishes money as a decimal string, never a JSON number', async () => {
      const res = await inWindow();
      expect(typeof res.body.kpis.revenue.value).toBe('string');
      expect(res.body.kpis.revenue.value).toMatch(/^\d+\.\d{4}$/u);
      expect(typeof res.body.kpis.revenue.previous).toBe('string');
    });

    it('counts orders excluding cancelled ones', async () => {
      const res = await inWindow();
      expect(res.body.kpis.orders.value).toBe(2);
    });

    it('reports the previous period from the window immediately before', async () => {
      const res = await inWindow();
      /* 500 + 90 = 590, placed 2025-11-20, inside the preceding six months. */
      expect(res.body.kpis.revenue.previous).toBe('590.0000');
      expect(res.body.kpis.orders.previous).toBe(1);
    });

    /* ── the window boundaries ──────────────────────────────────────────── */

    /**
     * The inclusive upper bound, at the precision the API actually speaks.
     *
     * PostgreSQL stores `placed_at` to microseconds; this API names milliseconds. An order at
     * `…:59.999500` must be included by `to=…:59.999`, because that is the timestamp the API
     * would have published for it.
     */
    it('includes an order whose stored microseconds fall inside the named upper bound', async () => {
      await makeOrder({
        placedAt: '2026-06-30T23:59:59.999500+05:30',
        total: '11.0000',
        taxTotal: '0.0000',
      });

      const included = await dash(
        `?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent('2026-06-30T23:59:59.999+05:30')}`,
      );
      expect(included.body.kpis.orders.value).toBe(3);

      const excluded = await dash(
        `?from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent('2026-06-30T23:59:59.998+05:30')}`,
      );
      expect(excluded.body.kpis.orders.value).toBe(2);
    });

    it('reports a previous period of exactly equal duration, abutting with no gap', async () => {
      const res = await inWindow();
      const range = res.body.range as {
        from: string;
        to: string;
        previousFrom: string;
        previousTo: string;
      };

      const current = Date.parse(range.to) + 1 - Date.parse(range.from);
      const previous = Date.parse(range.previousTo) + 1 - Date.parse(range.previousFrom);
      expect(previous).toBe(current);

      /* Abuts: the previous window's last millisecond is the one before `from`. */
      expect(Date.parse(range.previousTo) + 1).toBe(Date.parse(range.from));
    });

    it('echoes the window and the timezone actually used', async () => {
      const res = await inWindow();
      expect(res.body.range.timezone).toBe('Asia/Kolkata');
      expect(res.body.range.interval).toBe('month');
    });

    /* ── the series ─────────────────────────────────────────────────────── */

    it('buckets monthly in the store timezone, zero-filling empty months', async () => {
      const res = await inWindow();
      const series = res.body.salesSeries as { bucket: string; revenue: string; orders: number }[];

      expect(series.map((p) => p.bucket)).toEqual([
        '2026-01-01',
        '2026-02-01',
        '2026-03-01',
        '2026-04-01',
        '2026-05-01',
        '2026-06-01',
      ]);
      expect(series[0]).toMatchObject({ revenue: '0.0000', orders: 0 });
      expect(series[1]).toMatchObject({ revenue: '1180.0000', orders: 1 });
      expect(series[2]).toMatchObject({ revenue: '2478.0000', orders: 1 });
      /* April holds only the cancelled order, so it is zero rather than missing. */
      expect(series[3]).toMatchObject({ revenue: '0.0000', orders: 0 });
    });

    /**
     * The timezone is load-bearing, and this is the case that proves it.
     *
     * `2026-05-01T02:00+05:30` is `2026-04-30T20:30Z`. Bucketed in the STORE's zone it is May;
     * bucketed in UTC it would be April. A dashboard that got this wrong would move a month's
     * revenue into the previous bar, which a merchant notices and cannot explain.
     */
    it('assigns an order to the month it falls in LOCALLY, not in UTC', async () => {
      await makeOrder({
        placedAt: '2026-05-01T02:00:00+05:30',
        total: '100.0000',
        taxTotal: '0.0000',
      });

      const res = await inWindow();
      const series = res.body.salesSeries as { bucket: string; orders: number }[];
      expect(series.find((p) => p.bucket === '2026-05-01')?.orders).toBe(1);
      expect(series.find((p) => p.bucket === '2026-04-01')?.orders).toBe(0);
    });

    it('buckets by day and by week when asked', async () => {
      const daily = await inWindow('&interval=day');
      expect(daily.status).toBe(200);
      const days = daily.body.salesSeries as { bucket: string }[];
      expect(days[0]?.bucket).toBe('2026-01-01');
      expect(days.length).toBeGreaterThan(180);

      const weekly = await inWindow('&interval=week');
      expect(weekly.status).toBe(200);
      const weeks = weekly.body.salesSeries as { bucket: string }[];
      /* PostgreSQL truncates a week to MONDAY; so does the zero-fill. */
      for (const week of weeks) {
        expect(new Date(`${week.bucket}T00:00:00Z`).getUTCDay(), week.bucket).toBe(1);
      }
    });

    /* ── product and customer counts ────────────────────────────────────── */

    it('counts only active, non-deleted products', async () => {
      const res = await inWindow();
      const { rows } = await pool().query<{ c: string }>(
        `select count(*)::text c from product
          where store_id = $1 and status = 'active' and deleted_at is null`,
        [storeId],
      );
      expect(res.body.kpis.products.value).toBe(Number(rows[0]?.c));
      expect(res.body.kpis.products.value).toBe(1);
    });

    it('counts live customers, excluding soft-deleted accounts', async () => {
      const before = (await inWindow()).body.kpis.customers.value as number;

      const doomed = await register('erased.dash');
      expect((await inWindow()).body.kpis.customers.value).toBe(before + 1);

      await pool().query('update app_user set deleted_at = now() where id = $1', [doomed.id]);
      expect((await inWindow()).body.kpis.customers.value).toBe(before);
    });

    it('does not narrow the product or customer counts with the date range', async () => {
      const wide = await inWindow();
      const narrow = await dash(
        `?from=${encodeURIComponent('2026-02-01T00:00:00+05:30')}&to=${encodeURIComponent('2026-02-02T00:00:00+05:30')}`,
      );
      expect(narrow.body.kpis.products.value).toBe(wide.body.kpis.products.value);
      expect(narrow.body.kpis.customers.value).toBe(wide.body.kpis.customers.value);
    });

    /* ── order status ───────────────────────────────────────────────────── */

    it('publishes all seven display statuses, and is not narrowed by the range', async () => {
      const res = await inWindow();
      expect(Object.keys(res.body.orderStatusCounts).sort()).toEqual([
        'cancelled',
        'confirmed',
        'delivered',
        'failed',
        'pending',
        'processing',
        'shipped',
      ]);

      const { rows } = await pool().query<{ c: string }>(
        `select count(*)::text c from "order" where store_id = $1 and status = 'cancelled'`,
        [storeId],
      );
      expect(res.body.orderStatusCounts.cancelled).toBe(Number(rows[0]?.c));

      const narrow = await dash(
        `?from=${encodeURIComponent('2026-02-01T00:00:00+05:30')}&to=${encodeURIComponent('2026-02-02T00:00:00+05:30')}`,
      );
      expect(narrow.body.orderStatusCounts).toEqual(res.body.orderStatusCounts);
    });

    /* ── top products ───────────────────────────────────────────────────── */

    it('ranks by quantity, with tax-inclusive discounted revenue', async () => {
      const res = await inWindow();
      const top = res.body.topProducts as {
        skuCode: string;
        quantitySold: number;
        revenue: string;
        productName: string;
        skuName: string;
      }[];

      /* skuA: 5 + 3 = 8 units; revenue (1000+180) + (1200+216) = 2596. */
      /* skuB leads on QUANTITY: 9 units, revenue 900 + 162 = 1062. */
      expect(top[0]).toMatchObject({
        skuCode: 'PUMP-1HP-RED',
        skuName: '1 HP / Red',
        productName: 'Duroflo 2HP Pump',
        quantitySold: 9,
        revenue: '1062.0000',
      });
      /*
       * skuA sold 8 across two orders — (1000+180) + (1200+216) = 2596 — and ranks SECOND
       * despite earning more. The ranking is by units sold, which is what the screen shows.
       */
      expect(top[1]).toMatchObject({
        skuCode: 'PUMP-2HP-BLK',
        skuName: '2 HP / Black',
        quantitySold: 8,
        revenue: '2596.0000',
      });
    });

    it('excludes cancelled orders from the ranking', async () => {
      const res = await inWindow();
      const top = res.body.topProducts as { quantitySold: number }[];
      /* The cancelled order alone carried 999 units of skuA. */
      for (const row of top) expect(row.quantitySold).toBeLessThan(999);
    });

    /**
     * Historical truth. The line snapshotted the names at checkout; renaming the catalogue must
     * not rewrite what the product was called when it sold.
     */
    it('reports the SNAPSHOTTED names, not today’s catalogue names', async () => {
      await pool().query(`update product set name = 'RENAMED LATER' where id = $1`, [
        activeProductId,
      ]);
      await pool().query(`update sku set name = 'RENAMED VARIANT' where id = $1`, [skuA.id]);

      const res = await inWindow();
      const row = (
        res.body.topProducts as { skuCode: string; productName: string; skuName: string }[]
      ).find((r) => r.skuCode === 'PUMP-2HP-BLK');
      expect(row?.productName).toBe('Duroflo 2HP Pump');
      expect(row?.skuName).toBe('2 HP / Black');
    });

    it('respects topProductsLimit', async () => {
      const res = await inWindow('&topProductsLimit=1');
      expect(res.body.topProducts).toHaveLength(1);
    });

    /**
     * Two SKUs with identical quantity must not swap places between requests. The tiebreaker is
     * `skuCode ASC`, so the answer is stable and predictable rather than merely consistent.
     */
    /**
     * Six SKUs at the same quantity, and the codes are chosen so the CORRECT answer differs from
     * both the insertion order and its reverse.
     *
     * Two tied rows would pass half the time by luck — the aggregate emits them in some order,
     * and with two candidates "some order" is right as often as not. Six make an accidental pass
     * one chance in 720, which is what turns this from an assertion into a test.
     */
    it('breaks a quantity tie by skuCode ascending', async () => {
      const product = await makeProduct({ status: 'active', name: 'Tie Product' });

      /* Inserted 30, 10, 50, 20, 60, 40 — ascending is 10..60, neither that nor its reverse. */
      const suffixes = ['30', '10', '50', '20', '60', '40'];
      const made: { skuId: string; code: string }[] = [];
      for (const suffix of suffixes) {
        const sku = await makeSku({ productId: product, code: `TIE-${suffix}`, onHand: 5 });
        made.push({ skuId: sku.id, code: sku.code });
      }

      await makeOrder({
        placedAt: `2026-02-11T12:00:00${TZ}`,
        total: `${made.length * 70}.0000`,
        taxTotal: '0.0000',
        lines: made.map((m) => ({
          skuId: m.skuId,
          code: m.code,
          productName: 'Tie Product',
          skuName: m.code,
          quantity: 7,
          unitPrice: '10.0000',
          taxTotal: '0.0000',
        })),
      });

      const expected = [...suffixes].sort().map((suffix) => `TIE-${suffix}`);
      expect(expected).not.toEqual(made.map((m) => m.code));
      expect(expected).not.toEqual([...made].reverse().map((m) => m.code));

      const res = await inWindow('&topProductsLimit=20');
      const codes = (res.body.topProducts as { skuCode: string; quantitySold: number }[])
        .filter((r) => r.quantitySold === 7)
        .map((r) => r.skuCode);
      expect(codes).toEqual(expected);
    });

    /* ── low stock ──────────────────────────────────────────────────────── */

    describe('low stock', () => {
      it('returns a SKU at or below its threshold, with the fields the alert renders', async () => {
        const res = await inWindow();
        const rows = res.body.lowStock as Record<string, unknown>[];
        const found = rows.find((r) => r['skuCode'] === 'PUMP-2HP-BLK');

        /*
         * The NAME is deliberately not asserted here: a test above renames the catalogue, and
         * low stock reads the live `sku` and `product` rows rather than a snapshot. That
         * contrast is the subject of its own test below.
         */
        expect(found).toMatchObject({
          skuCode: 'PUMP-2HP-BLK',
          onHand: 4,
          reserved: 1,
          available: 3,
          threshold: 10,
        });
        expect(Object.keys(found ?? {}).sort()).toEqual([
          'available',
          'onHand',
          'productName',
          'reserved',
          'skuCode',
          'skuName',
          'threshold',
        ]);
      });

      /**
       * Low stock reads the LIVE catalogue; top products read the historical snapshot. The
       * contrast is deliberate and worth pinning, because both widgets show a product name and
       * a reader could reasonably assume they come from the same place.
       *
       * A low-stock alert is about stock you hold NOW, so it must say what that thing is called
       * now — an operator reordering it will search today's catalogue. A sales report is about
       * what happened, so it must say what the thing was called when it sold.
       */
      it('shows the CURRENT product name, unlike the historical top-products list', async () => {
        const res = await inWindow('&lowStockLimit=50&topProductsLimit=20');

        const low = (res.body.lowStock as { skuCode: string; skuName: string }[]).find(
          (r) => r.skuCode === 'PUMP-2HP-BLK',
        );
        const top = (res.body.topProducts as { skuCode: string; skuName: string }[]).find(
          (r) => r.skuCode === 'PUMP-2HP-BLK',
        );

        /* The rename happened in the top-products block above. */
        expect(low?.skuName).toBe('RENAMED VARIANT');
        expect(top?.skuName).toBe('2 HP / Black');
      });

      it('never returns a SKU with no threshold configured, however little is left', async () => {
        const p = await makeProduct({ status: 'active' });
        const bare = await makeSku({
          productId: p,
          code: 'NO-THRESHOLD',
          onHand: 1,
          threshold: null,
        });

        const res = await inWindow();
        expect((res.body.lowStock as { skuCode: string }[]).map((r) => r.skuCode)).not.toContain(
          bare.code,
        );
      });

      it('includes a SKU whose available EQUALS its threshold, and one below', async () => {
        const p = await makeProduct({ status: 'active' });
        const atEdge = await makeSku({ productId: p, code: 'AT-EDGE', onHand: 7, threshold: 7 });
        const below = await makeSku({ productId: p, code: 'BELOW-EDGE', onHand: 6, threshold: 7 });
        const above = await makeSku({ productId: p, code: 'ABOVE-EDGE', onHand: 8, threshold: 7 });

        const codes = (
          (await inWindow('&lowStockLimit=50')).body.lowStock as { skuCode: string }[]
        ).map((r) => r.skuCode);
        expect(codes).toContain(atEdge.code);
        expect(codes).toContain(below.code);
        expect(codes).not.toContain(above.code);
      });

      /** Out of stock is a DIFFERENT fact, and keeps its own meaning. */
      it('excludes a SKU with nothing available, even with a threshold configured', async () => {
        const p = await makeProduct({ status: 'active' });
        const gone = await makeSku({ productId: p, code: 'ALL-GONE', onHand: 0, threshold: 9 });
        const reserved = await makeSku({
          productId: p,
          code: 'ALL-RESERVED',
          onHand: 5,
          reserved: 5,
          threshold: 9,
        });

        const codes = (
          (await inWindow('&lowStockLimit=50')).body.lowStock as { skuCode: string }[]
        ).map((r) => r.skuCode);
        expect(codes).not.toContain(gone.code);
        expect(codes).not.toContain(reserved.code);
      });

      it('excludes a soft-deleted SKU but includes an inactive one', async () => {
        const p = await makeProduct({ status: 'active' });
        const erased = await makeSku({
          productId: p,
          code: 'ERASED-SKU',
          onHand: 2,
          threshold: 9,
          deleted: true,
        });
        const inactive = await makeSku({
          productId: p,
          code: 'INACTIVE-SKU',
          onHand: 2,
          threshold: 9,
          isActive: false,
        });

        const codes = (
          (await inWindow('&lowStockLimit=50')).body.lowStock as { skuCode: string }[]
        ).map((r) => r.skuCode);
        expect(codes).not.toContain(erased.code);
        expect(codes).toContain(inactive.code);
      });

      it('orders by available ascending then skuCode, and respects the limit', async () => {
        const res = await inWindow('&lowStockLimit=50');
        const rows = res.body.lowStock as { available: number; skuCode: string }[];

        for (let i = 1; i < rows.length; i += 1) {
          const prev = rows[i - 1]!;
          const here = rows[i]!;
          expect(prev.available <= here.available).toBe(true);
          if (prev.available === here.available) {
            expect(prev.skuCode.localeCompare(here.skuCode)).toBeLessThan(0);
          }
        }

        expect((await inWindow('&lowStockLimit=1')).body.lowStock).toHaveLength(1);
      });
    });

    /* ── recent orders ──────────────────────────────────────────────────── */

    it('returns the newest orders in the admin list’s own shape', async () => {
      const res = await inWindow('&recentOrdersLimit=3');
      const rows = res.body.recentOrders as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(3);

      /* The exact AdminOrderSummaryResponse shape — not a second definition of an order. */
      expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
        'currency',
        'customer',
        'displayStatus',
        'grandTotal',
        'orderNumber',
        'payment',
        'placedAt',
        'shipment',
        'status',
        'taxTotal',
        'total',
      ]);

      const times = rows.map((r) => Date.parse(String(r['placedAt'])));
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('does not narrow recent orders by the date range', async () => {
      const narrow = await dash(
        `?from=${encodeURIComponent('2026-02-01T00:00:00+05:30')}&to=${encodeURIComponent('2026-02-02T00:00:00+05:30')}&recentOrdersLimit=20`,
      );
      const wide = await inWindow('&recentOrdersLimit=20');
      expect((narrow.body.recentOrders as unknown[]).length).toBe(
        (wide.body.recentOrders as unknown[]).length,
      );
    });

    /* ── no internal identifiers ────────────────────────────────────────── */

    it('exposes no internal identifier anywhere in the payload', async () => {
      const res = await inWindow('&lowStockLimit=50&topProductsLimit=20');
      const text = JSON.stringify(res.body);

      for (const key of ['skuId', 'productId', 'orderId', 'userId', 'storeId', 'cartId']) {
        expect(text, key).not.toContain(`"${key}"`);
      }
    });

    /* ── read-only ──────────────────────────────────────────────────────── */

    it('changes nothing — no audit row, no event, no state', async () => {
      const snapshot = async (): Promise<Record<string, number>> => {
        const countOf = async (sql: string): Promise<number> => {
          const { rows } = await pool().query<{ c: string }>(sql);
          return Number(rows[0]?.c ?? '0');
        };
        return {
          orders: await countOf('select count(*)::text c from "order"'),
          lines: await countOf('select count(*)::text c from order_line'),
          products: await countOf('select count(*)::text c from product'),
          stock: await countOf('select coalesce(sum(on_hand),0)::text c from stock_item'),
          audits: await countOf('select count(*)::text c from audit_log'),
          outbox: await countOf('select count(*)::text c from outbox_event'),
        };
      };

      const before = await snapshot();
      await inWindow();
      await dash('?interval=day');
      await dash();
      expect(await snapshot()).toEqual(before);
    });

    /* ── no N+1 ─────────────────────────────────────────────────────────── */

    /**
     * Counted from the driver rather than inferred from a plan: `pg_stat_statements` is not in
     * the stock `postgres:16` image, but the pool emits every query it issues.
     *
     * The ceiling is the eight reads the service documents. A per-SKU or per-order lookup would
     * blow through it immediately, which is the failure this guards.
     */
    it('issues a bounded number of statements, with no per-row reads', async () => {
      const seen: string[] = [];
      const realQuery = container.db.pool.query.bind(container.db.pool);

      (container.db.pool as { query: unknown }).query = (...args: unknown[]) => {
        const text =
          typeof args[0] === 'string'
            ? args[0]
            : String((args[0] as { text?: string })?.text ?? '');
        seen.push(text);
        return (realQuery as (...a: unknown[]) => unknown)(...args);
      };

      try {
        const res = await inWindow('&lowStockLimit=50&topProductsLimit=20&recentOrdersLimit=20');
        expect(res.status).toBe(200);
        expect((res.body.lowStock as unknown[]).length).toBeGreaterThan(1);
        expect((res.body.topProducts as unknown[]).length).toBeGreaterThan(1);
      } finally {
        (container.db.pool as { query: unknown }).query = realQuery;
      }

      /*
       * The auth lookup plus the dashboard's own reads. Never one per row.
       *
       * Five statements name the order table: revenue, series, top products, status counts, and
       * the recent-orders page — which is a paged read, so it also runs its own count. That is a
       * fixed cost, not a per-row one, which is what this bound is here to protect.
       */
      expect(seen.length).toBeLessThanOrEqual(14);
      expect(seen.filter((t) => /from "order"/iu.test(t)).length).toBeLessThanOrEqual(6);
      expect(seen.filter((t) => /from "?stock_item"?/iu.test(t)).length).toBe(1);
    });
  });

  /* ── 5. Tenancy ───────────────────────────────────────────────────────── */

  /**
   * A second store with its own products, SKUs, stock, customer and orders.
   *
   * Every widget is checked against it. Asserting only that a made-up id is absent would pass
   * against a query with no tenant predicate at all, since a made-up id matches nothing either
   * way — so the foreign store here is fully populated and deliberately larger than ours.
   */
  describe('tenant isolation', () => {
    let foreignStoreId = '';
    let foreignSku = { id: '', code: '' };

    beforeAll(async () => {
      foreignStoreId = newId();
      const foreignUserId = newId();

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [foreignStoreId, `other-${foreignStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'argon2-placeholder', 'Foreign', 'Buyer')`,
        [foreignUserId, foreignStoreId, `foreign.dash.${foreignUserId}@example.com`],
      );

      const foreignProduct = await makeProduct({
        store: foreignStoreId,
        status: 'active',
        name: 'FOREIGN PRODUCT',
      });
      foreignSku = await makeSku({
        productId: foreignProduct,
        store: foreignStoreId,
        code: 'FOREIGN-SKU',
        onHand: 1,
        threshold: 99,
      });

      await makeOrder({
        store: foreignStoreId,
        userId: foreignUserId,
        placedAt: `2026-02-15T12:00:00${TZ}`,
        total: '450000.0000',
        taxTotal: '90000.0000',
        lines: [
          {
            skuId: foreignSku.id,
            code: 'FOREIGN-SKU',
            productName: 'FOREIGN PRODUCT',
            skuName: 'foreign',
            quantity: 900,
            unitPrice: '500.0000',
            taxTotal: '90000.0000',
          },
        ],
      });
    }, 180_000);

    it('has actually created a populated foreign store — otherwise this proves nothing', async () => {
      const { rows } = await pool().query<{ c: string }>(
        `select count(*)::text c from "order" where store_id <> $1`,
        [storeId],
      );
      expect(Number(rows[0]?.c ?? '0')).toBe(1);
    });

    it('excludes the foreign store from every widget', async () => {
      const res = await inWindow('&lowStockLimit=50&topProductsLimit=20&recentOrdersLimit=20');
      const text = JSON.stringify(res.body);

      expect(text).not.toContain('FOREIGN');
      expect(text).not.toContain('540000.0000');

      const codes = (res.body.topProducts as { skuCode: string }[]).map((r) => r.skuCode);
      expect(codes).not.toContain('FOREIGN-SKU');

      const lowCodes = (res.body.lowStock as { skuCode: string }[]).map((r) => r.skuCode);
      expect(lowCodes).not.toContain('FOREIGN-SKU');
    });

    it('counts only this store’s revenue, orders, products and customers', async () => {
      const res = await inWindow();

      const one = async (sql: string): Promise<number> => {
        const { rows } = await pool().query<{ c: string }>(sql, [storeId]);
        return Number(rows[0]?.c ?? '0');
      };

      expect(res.body.kpis.products.value).toBe(
        await one(
          `select count(*)::text c from product where store_id = $1 and status = 'active' and deleted_at is null`,
        ),
      );
      expect(res.body.kpis.customers.value).toBe(
        await one(
          `select count(*)::text c from app_user where store_id = $1 and deleted_at is null`,
        ),
      );

      const { rows } = await pool().query<{ s: string | null }>(
        `select sum(grand_total)::text s from "order"
          where store_id = $1 and status <> 'cancelled' and placed_at >= $2 and placed_at < $3`,
        [storeId, WINDOW_FROM, '2026-07-01T00:00:00+05:30'],
      );
      expect(res.body.kpis.revenue.value).toBe(rows[0]?.s);
    });

    /**
     * The aggregates' own tenancy, asserted where it lives.
     *
     * Through the route the store id is fixed by the token before any port is called, so a
     * missing predicate inside an aggregate would change no visible answer — which is exactly
     * what makes it easy to lose. These call the ports directly with a foreign store's data in
     * the database.
     */
    it('scopes every aggregate at the port level, not only at the route', async () => {
      const window = {
        from: new Date(WINDOW_FROM),
        toExclusive: new Date('2026-07-01T00:00:00+05:30'),
      };

      const revenue = await container.orders.dashboardRevenue({
        storeId,
        ...window,
        previousFrom: new Date('2025-07-01T00:00:00+05:30'),
        previousToExclusive: new Date(WINDOW_FROM),
      });
      expect(revenue.revenue).not.toContain('540000');

      const top = await container.orders.dashboardTopSkus({ storeId, ...window, limit: 50 });
      expect(top.map((r) => r.skuCode)).not.toContain('FOREIGN-SKU');

      const low = await container.inventory.listLowStock({ storeId, limit: 50 });
      expect(low.map((r) => r.skuCode)).not.toContain('FOREIGN-SKU');

      expect(await container.catalogue.countActiveProducts({ storeId })).toBeLessThan(
        await countAllActiveProducts(),
      );
    });

    async function countAllActiveProducts(): Promise<number> {
      const { rows } = await pool().query<{ c: string }>(
        `select count(*)::text c from product where status = 'active' and deleted_at is null`,
      );
      return Number(rows[0]?.c ?? '0');
    }
  });

  /* ── 6. The default window ────────────────────────────────────────────── */

  describe('the default window', () => {
    it('spans twelve months through now, bucketed monthly', async () => {
      const res = await dash();
      expect(res.status).toBe(200);
      expect(res.body.range.interval).toBe('month');

      const series = res.body.salesSeries as { bucket: string }[];
      /* Thirteen boundaries are possible: twelve whole months plus the partial current one. */
      expect(series.length).toBeGreaterThanOrEqual(12);
      expect(series.length).toBeLessThanOrEqual(14);

      const spanMs = Date.parse(res.body.range.to) - Date.parse(res.body.range.from);
      const days = spanMs / 86_400_000;
      expect(days).toBeGreaterThan(360);
      expect(days).toBeLessThan(372);
    });
  });
});
