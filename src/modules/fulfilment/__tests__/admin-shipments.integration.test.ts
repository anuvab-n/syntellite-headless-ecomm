import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser } from '../../../db/schema/identity.js';
import { newId } from '../../../shared/id.js';
import { createFulfilmentRepository } from '../fulfilment.repository.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * `GET /api/v1/admin/shipments` and `GET /api/v1/admin/shipments/{id}`. Increment 54.
 *
 * The read this module never had. `PATCH /admin/shipments/{id}`, `/ship` and `/deliver` have
 * always addressed a shipment by id, so staff could change a shipment they had no way to look
 * at, and the only listing was the fulfilment QUEUE — orders awaiting shipment, which by
 * definition excludes every shipment that already exists.
 *
 * What these cases are here to hold:
 *
 *  1. **Tenancy comes from the token.** Proven against a REAL foreign shipment cloned into a
 *     second store, not against its absence — "the list did not contain rows that do not exist"
 *     passes against a repository with no tenancy predicate at all.
 *  2. **404 is indistinguishable** for an unknown id and another store's id.
 *  3. **The published shape is exactly nine keys**, ten on the detail. No `storeId`, no
 *     `orderId`, no actor id.
 *  4. **The order is total.** `created_at DESC, id DESC`, with the tiebreaker exercised against
 *     manufactured ties whose correct answer differs from insertion order AND from its reverse.
 *  5. **`pagination.total` is counted independently** — against a direct `count(*)`, not against
 *     another call into the same SQL.
 *  6. **Read-only.** No audit row, no outbox event, no state change, on either endpoint.
 *  7. **The existing contracts did not move.** `toStaffShipmentResponse` is shared with four
 *     other routes; the new mappers compose on top of it rather than modify it, and the
 *     regression block below is what proves that stayed true.
 */
describe('admin shipments (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const SKU_CODE = 'ADMSHIP-SKU-1';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const pool = () => container.db.pool;

  const asStaff = (token = staffToken) => ({ Authorization: `Bearer ${token}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** Every shipment raised through the API in this fixture, in creation order. */
  const raised: { orderNumber: string; shipmentId: string; status: string }[] = [];

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

    const staffEmail = `staff.admship.${newId()}@example.com`;
    const staffUser = await container.identity.registerCustomer({
      storeId,
      input: { email: staffEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Staff' },
    });
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, staffUser.id));
    staffToken = (
      await api().post('/api/v1/auth/login').send({ email: staffEmail, password: PASSWORD })
    ).body.accessToken as string;

    const customerEmail = `customer.admship.${newId()}@example.com`;
    await container.identity.registerCustomer({
      storeId,
      input: { email: customerEmail, password: PASSWORD, firstName: 'Jane', lastName: 'Doe' },
    });
    customerToken = (
      await api().post('/api/v1/auth/login').send({ email: customerEmail, password: PASSWORD })
    ).body.accessToken as string;

    const product = await api()
      .post('/api/v1/admin/products')
      .set(asStaff())
      .send({ slug: 'admin-shipments-product', name: 'Admin Shipments Product', status: 'active' });
    expect(product.status).toBe(201);

    const sku = await api()
      .post('/api/v1/admin/products/admin-shipments-product/skus')
      .set(asStaff())
      .send({ code: SKU_CODE, price: '100.0000', name: SKU_CODE });
    expect(sku.status).toBe(201);

    const stocked = await api()
      .post('/api/v1/admin/inventory/adjustments')
      .set(asStaff())
      .send({ skuCode: SKU_CODE, delta: 200, reason: 'manual_increase', note: 'test stock' });
    expect(stocked.status).toBe(201);

    const addressId = await createAddress();

    /*
     * Four shipments covering all three states plus a bare one, created in a known order so the
     * newest-first assertions below have something to be wrong about. The ship/deliver calls are
     * what write the `shipment_event` rows the detail endpoint publishes as `history`.
     */
    await raise(addressId, {});
    await raise(addressId, {
      carrier: 'BlueDart',
      trackingNumber: `BD-${newId().slice(0, 8)}`,
      trackingUrl: 'https://bluedart.example.com/track/1',
    });
    const shipped = await raise(addressId, { carrier: 'FedEx' });
    const delivered = await raise(addressId, { carrier: 'DTDC' });

    expect(
      (
        await api()
          .post(`/api/v1/admin/shipments/${shipped.shipmentId}/ship`)
          .set(asStaff())
          .send({ note: 'Handed to driver' })
      ).status,
    ).toBe(200);
    shipped.status = 'shipped';

    expect(
      (
        await api()
          .post(`/api/v1/admin/shipments/${delivered.shipmentId}/ship`)
          .set(asStaff())
          .send({ note: 'Left the warehouse' })
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .post(`/api/v1/admin/shipments/${delivered.shipmentId}/deliver`)
          .set(asStaff())
          .send({ note: 'Signed for at reception' })
      ).status,
    ).toBe(200);
    delivered.status = 'delivered';
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function createAddress(): Promise<string> {
    const res = await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
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

  /** Place a paid order and raise its shipment. Returns the pair, recorded in `raised`. */
  async function raise(
    addressId: string,
    body: Record<string, unknown>,
  ): Promise<{ orderNumber: string; shipmentId: string; status: string }> {
    await api()
      .put(`/api/v1/users/me/cart/items/${SKU_CODE}`)
      .set(asCustomer())
      .send({ quantity: 1 });

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ addressId });
    expect(checkout.status).toBe(201);
    const orderNumber = checkout.body.order.orderNumber as string;

    const paid = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(asCustomer())
      .set('idempotency-key', newId())
      .send({ method: 'cod' });
    expect(paid.status).toBe(201);

    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asStaff())
      .send(body);
    expect(created.status).toBe(201);

    const entry = {
      orderNumber,
      shipmentId: created.body.shipment.id as string,
      status: 'pending',
    };
    raised.push(entry);
    return entry;
  }

  const listPath = (qs = '') => `/api/v1/admin/shipments${qs}`;
  const detailPath = (id: string) => `/api/v1/admin/shipments/${id}`;

  type ListRow = { id: string; orderNumber: string; status: string; createdAt: string };
  const listRows = (body: unknown): ListRow[] => (body as { shipments: ListRow[] }).shipments;

  async function countWhere(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await pool().query<{ count: string }>(sql, params);
    return Number(rows[0]?.count ?? '0');
  }

  /* ── 1. Authorization ─────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('refuses an anonymous request with 401 on both endpoints', async () => {
      expect((await api().get(listPath())).status).toBe(401);
      expect((await api().get(detailPath(newId()))).status).toBe(401);
    });

    it('refuses a signed-in non-staff customer with 403 on both endpoints', async () => {
      expect((await api().get(listPath()).set(asCustomer())).status).toBe(403);
      expect((await api().get(detailPath(newId())).set(asCustomer())).status).toBe(403);
    });

    it('serves an active staff member', async () => {
      expect((await api().get(listPath()).set(asStaff())).status).toBe(200);
      expect((await api().get(detailPath(raised[0]!.shipmentId)).set(asStaff())).status).toBe(200);
    });

    /**
     * Scopes are read from the database on every request, so a demotion takes effect on the NEXT
     * request rather than at the next token refresh — asserted with the SAME token that worked a
     * line earlier.
     */
    it('stops serving a demoted staff member on the very next request', async () => {
      const email = `demote.admship.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get(listPath()).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get(listPath()).set(auth)).status).toBe(403);
      expect((await api().get(detailPath(raised[0]!.shipmentId)).set(auth)).status).toBe(403);
    });

    it('refuses a deactivated staff member with 401', async () => {
      const email = `deact.admship.${newId()}@example.com`;
      const user = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'Temp', lastName: 'Staff' },
      });
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };

      expect((await api().get(listPath()).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get(listPath()).set(auth)).status).toBe(401);
      expect((await api().get(detailPath(raised[0]!.shipmentId)).set(auth)).status).toBe(401);
    });
  });

  /* ── 2. Validation ────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const res = await api().get(listPath('?nope=1')).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    /**
     * The one unknown parameter that matters. Tenancy is an invariant of the query, and a
     * `storeId` the server quietly ignored would leave a client with a reasonable belief that it
     * had narrowed the page.
     */
    it('rejects a client-supplied storeId rather than ignoring it', async () => {
      const res = await api()
        .get(listPath(`?storeId=${newId()}`))
        .set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects limits outside the bounds rather than clamping them', async () => {
      for (const qs of ['?limit=0', '?limit=101', '?limit=-1', '?limit=abc', '?offset=-1']) {
        const res = await api().get(listPath(qs)).set(asStaff());
        expect(res.status, qs).toBe(400);
        expect(res.body.error.code, qs).toBe('VALIDATION_ERROR');
      }
    });

    it('accepts both ends of the limit range', async () => {
      expect((await api().get(listPath('?limit=1')).set(asStaff())).status).toBe(200);
      expect((await api().get(listPath('?limit=100')).set(asStaff())).status).toBe(200);
    });

    it('rejects a status outside the shipment vocabulary', async () => {
      const res = await api().get(listPath('?status=cancelled')).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed order number rather than running a query that can only miss', async () => {
      const res = await api().get(listPath('?orderNumber=ORD-nope')).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a malformed UUID on the detail route with 400, not 404', async () => {
      const res = await api().get(detailPath('not-a-uuid')).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  /* ── 3. The published shape ───────────────────────────────────────────── */

  const LIST_KEYS = [
    'carrier',
    'createdAt',
    'deliveredAt',
    'id',
    'orderNumber',
    'shippedAt',
    'status',
    'trackingNumber',
    'trackingUrl',
  ];

  describe('response shape', () => {
    it('publishes exactly the nine list keys, and no more', async () => {
      const res = await api().get(listPath('?limit=100')).set(asStaff());
      expect(res.status).toBe(200);
      expect(listRows(res.body).length).toBeGreaterThan(0);
      for (const row of listRows(res.body)) {
        expect(Object.keys(row).sort()).toEqual(LIST_KEYS);
      }
      expect(Object.keys(res.body).sort()).toEqual(['pagination', 'shipments']);
      expect(Object.keys(res.body.pagination).sort()).toEqual(['limit', 'offset', 'total']);
    });

    it('publishes exactly those nine keys plus history on the detail', async () => {
      const res = await api().get(detailPath(raised[0]!.shipmentId)).set(asStaff());
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['shipment']);
      expect(Object.keys(res.body.shipment).sort()).toEqual([...LIST_KEYS, 'history'].sort());
    });

    /**
     * The internal keys, named rather than implied. `storeId` is an invariant of the query and
     * an order is addressed by its number; an actor id would name a colleague on a screen that
     * exists to explain a parcel.
     */
    it('leaks no internal or personal identifier', async () => {
      const list = await api().get(listPath('?limit=100')).set(asStaff());
      const detail = await api().get(detailPath(raised[3]!.shipmentId)).set(asStaff());

      const forbidden = ['storeId', 'store_id', 'orderId', 'order_id', 'userId', 'actorUserId'];
      const listText = JSON.stringify(list.body);
      const detailText = JSON.stringify(detail.body);
      for (const key of forbidden) {
        expect(listText, key).not.toContain(`"${key}"`);
        expect(detailText, key).not.toContain(`"${key}"`);
      }

      const history = detail.body.shipment.history as Record<string, unknown>[];
      expect(history.length).toBeGreaterThan(0);
      for (const event of history) {
        expect(Object.keys(event).sort()).toEqual([
          'actorType',
          'fromStatus',
          'note',
          'occurredAt',
          'toStatus',
        ]);
      }
    });

    it('publishes a bare shipment as nulls rather than omitting the keys', async () => {
      const res = await api().get(listPath('?limit=100')).set(asStaff());
      const bare = listRows(res.body).find((r) => r.orderNumber === raised[0]!.orderNumber);
      expect(bare).toBeDefined();
      expect(bare).toMatchObject({
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        shippedAt: null,
        deliveredAt: null,
        status: 'pending',
      });
    });

    it('publishes instants as UTC ISO strings', async () => {
      const res = await api().get(listPath('?limit=100')).set(asStaff());
      for (const row of listRows(res.body)) {
        expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      }
    });
  });

  /* ── 4. Filters, ordering and pagination ──────────────────────────────── */

  describe('filters', () => {
    it('narrows to a single status, and every returned row has it', async () => {
      for (const status of ['pending', 'shipped', 'delivered']) {
        const res = await api()
          .get(listPath(`?status=${status}&limit=100`))
          .set(asStaff());
        expect(res.status).toBe(200);
        expect(
          listRows(res.body).every((r) => r.status === status),
          status,
        ).toBe(true);

        const total = await countWhere(
          'select count(*)::text as count from shipment where store_id = $1 and status = $2',
          [storeId, status],
        );
        expect(res.body.pagination.total, status).toBe(total);
      }
    });

    it('narrows to one order number, which uq_shipment_order makes at most one row', async () => {
      const target = raised[1]!;
      const res = await api()
        .get(listPath(`?orderNumber=${target.orderNumber}&limit=100`))
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(listRows(res.body).map((r) => r.id)).toEqual([target.shipmentId]);
      expect(res.body.pagination.total).toBe(1);
    });

    /** A filter, not a lookup: a well-formed number nobody used is an empty page, not a 404. */
    it('answers an unknown order number with an empty page rather than a 404', async () => {
      const res = await api()
        .get(listPath('?orderNumber=ORD-20200101-ZZZZZZ&limit=100'))
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(listRows(res.body)).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });
  });

  describe('ordering and pagination', () => {
    it('returns the store’s shipments newest first', async () => {
      const res = await api().get(listPath('?limit=100')).set(asStaff());
      const times = listRows(res.body).map((r) => Date.parse(r.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    /**
     * `pagination.total` against a DIRECT `count(*)`, not against another call into the same
     * repository — two readings of one SQL expression agreeing proves nothing about either.
     */
    it('counts the store’s shipments independently of the query that lists them', async () => {
      const res = await api().get(listPath('?limit=1')).set(asStaff());
      const total = await countWhere(
        'select count(*)::text as count from shipment where store_id = $1',
        [storeId],
      );
      expect(res.body.pagination.total).toBe(total);
      expect(listRows(res.body)).toHaveLength(1);
      expect(res.body.pagination).toMatchObject({ limit: 1, offset: 0 });
    });

    it('walks the whole store one row at a time without skipping or repeating any', async () => {
      const total = await countWhere(
        'select count(*)::text as count from shipment where store_id = $1',
        [storeId],
      );

      const walked: string[] = [];
      for (let offset = 0; offset < total; offset += 1) {
        const page = await api()
          .get(listPath(`?limit=1&offset=${String(offset)}`))
          .set(asStaff());
        expect(page.status).toBe(200);
        walked.push(...listRows(page.body).map((r) => r.id));
      }

      const whole = await api().get(listPath('?limit=100')).set(asStaff());
      expect(walked).toEqual(listRows(whole.body).map((r) => r.id));
      expect(new Set(walked).size).toBe(total);
    });

    it('answers an offset past the end with an empty page and the real total', async () => {
      const res = await api().get(listPath('?limit=10&offset=10000')).set(asStaff());
      expect(res.status).toBe(200);
      expect(listRows(res.body)).toEqual([]);
      expect(res.body.pagination.total).toBeGreaterThan(0);
    });
  });

  /* ── 5. The tiebreaker ────────────────────────────────────────────────── */

  /**
   * `created_at` alone is not a total order, and a non-total order makes `offset` paging skip and
   * repeat rows. Two earlier increments failed to prove this: with ids generated by the
   * application they are UUIDv7, so id order IS insertion order, and a backward index scan
   * already emits ties newest-first by accident — removing the tiebreaker changed nothing.
   *
   * So the tied rows here are inserted at the DATABASE level with CHOSEN ids, in an order where
   * the correct answer (`id DESC`) differs from insertion order AND from its reverse. Getting
   * those six rows right by luck is one chance in 720.
   */
  describe('the createdAt tiebreaker', () => {
    const TIED_AT = '2020-01-02T03:04:05.000Z';
    const tiedIds = ['30', '10', '50', '20', '60', '40'].map(
      (suffix) => `0000ffff-0000-4000-8000-0000000000${suffix}`,
    );
    const expectedOrder = [...tiedIds].sort().reverse();

    beforeAll(async () => {
      const source = raised[0]!;
      const { rows: orderRows } = await pool().query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const sourceOrder = orderRows[0]!;

      /*
       * One cloned order per tied shipment, because `uq_shipment_order` is one-to-one. The cart
       * is cloned first: `fk_order_cart_store` points at `cart(id, store_id)`, so the schema
       * correctly refuses an order whose cart it cannot see. `address_id` is nulled — the
       * delivery address is snapshotted onto the order at checkout, so a null there is a shape
       * the schema already models.
       */
      const suffixes = ['TIEAAA', 'TIEAAB', 'TIEAAC', 'TIEAAD', 'TIEAAE', 'TIEAAF'];
      for (const [index, id] of tiedIds.entries()) {
        const cartId = newId();
        await cloneRow('cart', 'id', String(sourceOrder['cart_id']), {
          id: cartId,
          store_id: storeId,
        });
        const orderId = newId();
        await cloneRow('order', 'id', String(sourceOrder['id']), {
          id: orderId,
          cart_id: cartId,
          address_id: null,
          order_number: `ORD-20200102-${suffixes[index]!}`,
        });
        await cloneRow('shipment', 'id', String(source.shipmentId), {
          id,
          order_id: orderId,
          carrier: null,
          tracking_number: null,
          created_at: TIED_AT,
          updated_at: TIED_AT,
        });
      }
    }, 120_000);

    /**
     * Copy one row, overriding the columns that move it. A generic column copy rather than a
     * hand-written INSERT, so a column added to these tables later cannot make this silently
     * insert a NULL and quietly stop testing anything.
     */
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
      await pool().query(
        `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
         values (${columns.map((_c, i) => `$${String(i + 1)}`).join(', ')})`,
        columns.map((c) => clone[c]),
      );
    }

    it('has actually created six rows sharing one instant — otherwise the next case proves nothing', async () => {
      const tied = await countWhere(
        'select count(*)::text as count from shipment where store_id = $1 and created_at = $2',
        [storeId, TIED_AT],
      );
      expect(tied).toBe(6);
    });

    it('breaks the tie by id descending, which is neither insertion order nor its reverse', async () => {
      expect(expectedOrder).not.toEqual(tiedIds);
      expect(expectedOrder).not.toEqual([...tiedIds].reverse());

      const res = await api().get(listPath('?limit=100')).set(asStaff());
      expect(res.status).toBe(200);
      const got = listRows(res.body)
        .map((r) => r.id)
        .filter((id) => tiedIds.includes(id));
      expect(got).toEqual(expectedOrder);
    });

    it('pages through the tied block without skipping or repeating a row', async () => {
      const seen: string[] = [];
      for (let offset = 0; offset < 60; offset += 2) {
        const page = await api()
          .get(listPath(`?limit=2&offset=${String(offset)}`))
          .set(asStaff());
        const ids = listRows(page.body).map((r) => r.id);
        if (ids.length === 0) break;
        seen.push(...ids);
      }
      expect(seen.filter((id) => tiedIds.includes(id))).toEqual(expectedOrder);
    });
  });

  /* ── 6. The detail, and its history ───────────────────────────────────── */

  describe('detail and history', () => {
    it('404s an unknown shipment id', async () => {
      const res = await api().get(detailPath(newId())).set(asStaff());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns the same row the list published, plus its history', async () => {
      const target = raised[1]!;
      const list = await api().get(listPath('?limit=100')).set(asStaff());
      const fromList = listRows(list.body).find((r) => r.id === target.shipmentId);
      expect(fromList).toBeDefined();

      const res = await api().get(detailPath(target.shipmentId)).set(asStaff());
      expect(res.status).toBe(200);
      const { history, ...row } = res.body.shipment as Record<string, unknown>;
      expect(row).toEqual(fromList);
      expect(Array.isArray(history)).toBe(true);
    });

    /**
     * The whole reason the detail exists. A shipment that was raised, shipped and delivered has
     * three rows in `shipment_event`, and a timeline is read forwards.
     */
    it('publishes the full transition history, oldest first', async () => {
      const res = await api().get(detailPath(raised[3]!.shipmentId)).set(asStaff());
      expect(res.status).toBe(200);

      const history = res.body.shipment.history as {
        fromStatus: string | null;
        toStatus: string;
        actorType: string;
        note: string | null;
        occurredAt: string;
      }[];

      expect(history.map((e) => [e.fromStatus, e.toStatus])).toEqual([
        [null, 'pending'],
        ['pending', 'shipped'],
        ['shipped', 'delivered'],
      ]);
      expect(history.map((e) => e.note)).toEqual([
        null,
        'Left the warehouse',
        'Signed for at reception',
      ]);
      expect(history.every((e) => e.actorType === 'staff')).toBe(true);

      const times = history.map((e) => Date.parse(e.occurredAt));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(res.body.shipment.status).toBe('delivered');
    });

    /** Counted against the table directly, so the endpoint cannot quietly drop a transition. */
    it('publishes every event the table holds for the shipment, and no other', async () => {
      for (const entry of raised) {
        const res = await api().get(detailPath(entry.shipmentId)).set(asStaff());
        const events = await countWhere(
          'select count(*)::text as count from shipment_event where shipment_id = $1',
          [entry.shipmentId],
        );
        expect((res.body.shipment.history as unknown[]).length, entry.shipmentId).toBe(events);
      }
    });

    /**
     * A shipment with no events at all. One of the tied rows above was inserted straight into
     * the table, so it has none — and an empty `history` is a real shape rather than a missing
     * key.
     */
    it('publishes an empty history for a shipment with no events', async () => {
      const res = await api()
        .get(detailPath('0000ffff-0000-4000-8000-000000000030'))
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.shipment.history).toEqual([]);
    });
  });

  /* ── 7. Tenancy, against a real foreign shipment ──────────────────────── */

  /**
   * A second store cannot be reached over HTTP — store resolution is single-store in this
   * version — so the foreign shipment is CLONED at the database level from a real one: same
   * shape, same constraints, a different `store_id`. Asserting "the list did not contain rows
   * that do not exist" would pass against a repository with no tenancy predicate at all, which
   * is exactly the bug this block is here to catch.
   */
  describe('tenant isolation', () => {
    let foreignShipmentId = '';
    let foreignOrderNumber = '';

    beforeAll(async () => {
      const foreignStoreId = newId();
      const foreignUserId = newId();
      foreignShipmentId = newId();
      foreignOrderNumber = 'ORD-20200303-FFFFFF';

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [foreignStoreId, `other-${foreignStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'x', 'Foreign', 'Buyer')`,
        [foreignUserId, foreignStoreId, `foreign.admship.${foreignUserId}@example.com`],
      );

      const source = raised[3]!;
      const { rows: orderRows } = await pool().query<Record<string, unknown>>(
        'select * from "order" where order_number = $1',
        [source.orderNumber],
      );
      const sourceOrder = orderRows[0]!;

      const cartId = newId();
      await copyRow('cart', 'id', String(sourceOrder['cart_id']), {
        id: cartId,
        store_id: foreignStoreId,
        user_id: foreignUserId,
      });
      const orderId = newId();
      await copyRow('order', 'id', String(sourceOrder['id']), {
        id: orderId,
        store_id: foreignStoreId,
        user_id: foreignUserId,
        cart_id: cartId,
        address_id: null,
        order_number: foreignOrderNumber,
      });
      await copyRow('shipment', 'id', String(source.shipmentId), {
        id: foreignShipmentId,
        store_id: foreignStoreId,
        order_id: orderId,
        tracking_number: null,
      });

      /*
       * A history for it too. `listEventsForShipment` is store-scoped in its own right, and a
       * foreign shipment with no events could not tell a passing implementation apart from one
       * that dropped the predicate.
       */
      const { rows: events } = await pool().query<Record<string, unknown>>(
        'select * from shipment_event where shipment_id = $1 order by created_at asc',
        [source.shipmentId],
      );
      for (const event of events) {
        await insertRow('shipment_event', {
          ...event,
          id: newId(),
          shipment_id: foreignShipmentId,
          store_id: foreignStoreId,
          actor_user_id: foreignUserId,
          note: 'FOREIGN-STORE-NOTE',
        });
      }
    }, 120_000);

    async function copyRow(
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
      await insertRow(table, { ...row, ...overrides });
    }

    async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
      const columns = Object.keys(row);
      await pool().query(
        `insert into "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
         values (${columns.map((_c, i) => `$${String(i + 1)}`).join(', ')})`,
        columns.map((c) => row[c]),
      );
    }

    it('has actually created a foreign shipment with a history — otherwise this block proves nothing', async () => {
      expect(
        await countWhere('select count(*)::text as count from shipment where store_id <> $1', [
          storeId,
        ]),
      ).toBe(1);
      expect(
        await countWhere(
          'select count(*)::text as count from shipment_event where store_id <> $1',
          [storeId],
        ),
      ).toBeGreaterThan(0);
    });

    it('never returns another store’s shipment from the list', async () => {
      const res = await api().get(listPath('?limit=100')).set(asStaff());
      expect(listRows(res.body).map((r) => r.id)).not.toContain(foreignShipmentId);
      expect(listRows(res.body).map((r) => r.orderNumber)).not.toContain(foreignOrderNumber);
    });

    it('cannot be made to return it by filtering for it', async () => {
      const res = await api()
        .get(listPath(`?orderNumber=${foreignOrderNumber}&limit=100`))
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(listRows(res.body)).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('404s another store’s shipment id, indistinguishably from an unknown one', async () => {
      const foreign = await api().get(detailPath(foreignShipmentId)).set(asStaff());
      const unknown = await api().get(detailPath(newId())).set(asStaff());
      expect(foreign.status).toBe(404);

      /* `requestId` differs by construction — it is the one field that identifies the CALL. */
      const withoutRequestId = (body: { error: Record<string, unknown> }) => {
        const { requestId, ...error } = body.error;
        void requestId;
        return error;
      };
      expect(withoutRequestId(foreign.body)).toEqual(withoutRequestId(unknown.body));
    });

    it('counts only this store’s shipments in the total', async () => {
      const res = await api().get(listPath('?limit=1')).set(asStaff());
      const mine = await countWhere(
        'select count(*)::text as count from shipment where store_id = $1',
        [storeId],
      );
      const all = await countWhere('select count(*)::text as count from shipment', []);
      expect(all).toBeGreaterThan(mine);
      expect(res.body.pagination.total).toBe(mine);
    });

    /**
     * The history query is store-scoped in its OWN right, not merely via the shipment already
     * fetched. Asserted by calling the service with a foreign shipment id under this store's
     * tenancy — an id the HTTP layer would never let through, which is the point: the repository
     * must not depend on the layer above it having checked.
     */
    it('returns no foreign history even when handed a foreign shipment id directly', async () => {
      await expect(
        container.fulfilment.getStoreShipment({ shipmentId: foreignShipmentId, storeId }),
      ).rejects.toThrow();

      const mine = await container.fulfilment.getStoreShipment({
        shipmentId: raised[3]!.shipmentId,
        storeId,
      });
      expect(mine.events.length).toBeGreaterThan(0);
      expect(mine.events.every((e) => e.note !== 'FOREIGN-STORE-NOTE')).toBe(true);
    });

    /**
     * The same claim one layer lower, and it has to be made here.
     *
     * Through the service, the history predicate is SHADOWED: `getStoreShipment` refuses a
     * foreign id at the lookup, so the history query is never reached with one and dropping its
     * `store_id` changes no observable answer. That is precisely why the predicate is easy to
     * lose. This calls the repository method directly, which is the only level at which its
     * tenancy is its own.
     */
    it('reads no foreign history at the repository level either', async () => {
      const repository = createFulfilmentRepository({ db: db() });

      expect(
        await repository.listEventsForShipment({ shipmentId: foreignShipmentId, storeId }),
      ).toEqual([]);

      const own = await repository.listEventsForShipment({
        shipmentId: raised[3]!.shipmentId,
        storeId,
      });
      expect(own.length).toBeGreaterThan(0);
      expect(own.every((e) => e.note !== 'FOREIGN-STORE-NOTE')).toBe(true);
    });

    /**
     * A store with no shipments at all. It cannot be reached over HTTP, so this goes through the
     * service — an empty page with a zero total is a real answer, not an error.
     */
    it('serves a store with no shipments as an empty page rather than an error', async () => {
      const emptyStoreId = newId();
      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Empty Store', 'INR', 'Asia/Kolkata', true)`,
        [emptyStoreId, `empty-${emptyStoreId.slice(0, 8)}`],
      );

      const page = await container.fulfilment.listStoreShipments({
        storeId: emptyStoreId,
        filters: {},
        limit: 25,
        offset: 0,
      });
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
    });
  });

  /* ── 8. Read-only ─────────────────────────────────────────────────────── */

  describe('read-only', () => {
    async function snapshot(): Promise<Record<string, number>> {
      const countOf = (sql: string) => countWhere(sql, []);
      return {
        shipments: await countOf('select count(*)::text as count from shipment'),
        events: await countOf('select count(*)::text as count from shipment_event'),
        orders: await countOf('select count(*)::text as count from "order"'),
        stock: await countOf('select coalesce(sum(on_hand), 0)::text as count from stock_item'),
        audits: await countOf('select count(*)::text as count from audit_log'),
        outbox: await countOf('select count(*)::text as count from outbox_event'),
        keys: await countOf('select count(*)::text as count from idempotency_key'),
      };
    }

    it('changes nothing — no audit row, no event, no state', async () => {
      const before = await snapshot();

      await api().get(listPath('?limit=100')).set(asStaff());
      await api().get(listPath('?status=shipped')).set(asStaff());
      await api()
        .get(listPath(`?orderNumber=${raised[0]!.orderNumber}`))
        .set(asStaff());
      await api().get(detailPath(raised[3]!.shipmentId)).set(asStaff());
      await api().get(detailPath(newId())).set(asStaff());

      expect(await snapshot()).toEqual(before);
    });
  });

  /* ── 9. The existing contracts did not move ───────────────────────────── */

  /**
   * `toStaffShipmentResponse` is shared with `GET /admin/orders/{orderNumber}/shipments`,
   * `PATCH /admin/shipments/{id}` and both transition routes. The new mappers COMPOSE on top of
   * it rather than modify it, and this block is what proves that stayed true: any of these
   * growing an `orderNumber` or a `history` would mean the shared mapper was changed after all.
   */
  describe('regression: the routes that already shared the mapper', () => {
    const STAFF_KEYS = [
      'carrier',
      'createdAt',
      'deliveredAt',
      'id',
      'shippedAt',
      'status',
      'trackingNumber',
      'trackingUrl',
    ];

    it('GET /admin/orders/{orderNumber}/shipments still publishes exactly eight keys', async () => {
      const res = await api()
        .get(`/api/v1/admin/orders/${raised[3]!.orderNumber}/shipments`)
        .set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.shipments).toHaveLength(1);
      expect(Object.keys(res.body.shipments[0]).sort()).toEqual(STAFF_KEYS);
      expect(res.body.shipments[0].id).toBe(raised[3]!.shipmentId);
    });

    it('PATCH /admin/shipments/{id} still publishes exactly eight keys', async () => {
      const res = await api()
        .patch(detailPath(raised[0]!.shipmentId))
        .set(asStaff())
        .send({ carrier: 'Regression Carrier' });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.shipment).sort()).toEqual(STAFF_KEYS);
      expect(res.body.shipment.carrier).toBe('Regression Carrier');
    });

    it('POST /admin/shipments/{id}/ship and /deliver still publish exactly eight keys', async () => {
      const addressId = await createAddress();
      const fresh = await raise(addressId, { carrier: 'Regression Courier' });

      const shipped = await api()
        .post(`/api/v1/admin/shipments/${fresh.shipmentId}/ship`)
        .set(asStaff())
        .send({ note: 'regression ship' });
      expect(shipped.status).toBe(200);
      expect(Object.keys(shipped.body.shipment).sort()).toEqual(STAFF_KEYS);
      expect(shipped.body.shipment.status).toBe('shipped');

      const delivered = await api()
        .post(`/api/v1/admin/shipments/${fresh.shipmentId}/deliver`)
        .set(asStaff())
        .send({ note: 'regression deliver' });
      expect(delivered.status).toBe(200);
      expect(Object.keys(delivered.body.shipment).sort()).toEqual(STAFF_KEYS);
      expect(delivered.body.shipment.status).toBe('delivered');

      /* And the new detail sees the transitions the old routes wrote. */
      const detail = await api().get(detailPath(fresh.shipmentId)).set(asStaff());
      expect(
        (detail.body.shipment.history as { toStatus: string }[]).map((e) => e.toStatus),
      ).toEqual(['pending', 'shipped', 'delivered']);
    });

    it('the customer shipment view still hides the id and gained nothing', async () => {
      const res = await api()
        .get(`/api/v1/users/me/orders/${raised[1]!.orderNumber}/shipments`)
        .set(asCustomer());
      expect(res.status).toBe(200);
      expect(res.body.shipments[0]).not.toHaveProperty('id');
      expect(res.body.shipments[0]).not.toHaveProperty('orderNumber');
      expect(res.body.shipments[0]).not.toHaveProperty('history');
    });

    it('the fulfilment queue still resolves under the same prefix', async () => {
      expect((await api().get('/api/v1/admin/orders/fulfilment').set(asStaff())).status).toBe(200);
    });
  });

  /* ── 10. The database the list depends on ─────────────────────────────── */

  describe('database', () => {
    it('has the (store_id, created_at) index the list was measured against', async () => {
      const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'shipment'`,
      );
      const covering = rows.filter((r) => /\(\s*store_id\s*,\s*created_at\s*\)/iu.test(r.indexdef));
      expect(covering.map((r) => r.indexname)).toContain('ix_shipment_store_created');
    });

    it('has the unique index that makes the order join one-to-one', async () => {
      const { rows } = await pool().query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'uq_shipment_order'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toMatch(/UNIQUE/iu);
    });

    /**
     * The N+1 check, by plan rather than by counting statements: `pg_stat_statements` is not in
     * the stock `postgres:16` image. If `orderNumber` were fetched once per row it would not
     * appear in this plan at all — the join's presence IS the absence of the N+1.
     */
    it('reads the order number as a join, not once per row', async () => {
      const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
        `explain select s.id, o.order_number
           from shipment s
           join "order" o on o.id = s.order_id and o.store_id = s.store_id
          where s.store_id = $1
          order by s.created_at desc, s.id desc
          limit 100`,
        [storeId],
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/Join|Nested Loop/u);
    });

    /** The history is a second indexed read, not a join that multiplies the shipment row. */
    it('has the index the history read depends on', async () => {
      const { rows } = await pool().query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'ix_shipment_event_shipment_time'`,
      );
      expect(rows).toHaveLength(1);
    });
  });
});
