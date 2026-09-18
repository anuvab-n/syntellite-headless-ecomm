import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../container.js';
import { sku } from '../db/schema/catalogue.js';
import { appUser, refreshSession } from '../db/schema/identity.js';
import { promotion } from '../db/schema/promotions.js';
import { newId } from '../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../tests/helpers/redis.ts';

/**
 * Increment 63 — the remaining admin list filters, plus customer addresses and sessions.
 *
 * Against the REAL composition root, real PostgreSQL and real Redis:
 *
 *   GET    /admin/products         ?stockState
 *   GET    /admin/promotions       ?q ?status
 *   GET    /admin/inventory        ?q ?stockState
 *   GET    /admin/customers/{id}/addresses
 *   GET    /admin/customers/{id}/sessions
 *   DELETE /admin/customers/{id}/sessions/{sessionId}
 *
 * Four properties carry this suite:
 *
 *  1. **Every filter narrows, and its total agrees with its rows.** A page whose `total` came
 *     from a different predicate is how an operator pages past the end of a filter.
 *  2. **Wildcards are literal.** A typed `%` must not match everything.
 *  3. **A multi-SKU product stays ONE row** under the stock filter — the EXISTS, not a join.
 *  4. **No credential material is ever published**, and no session leaves its customer.
 */
describe('admin list filters, addresses and sessions (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  let seq = 0;
  let promoSeq = 0;

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
          AUTH_RATE_LIMIT_IP_MAX: '9000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '9000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
    staffToken = (await signIn({ staff: true })).token;
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

  /**
   * A published product with SKUs at chosen stock levels.
   *
   * `threshold` configures the reorder point; `onHand` is set through the real adjustment
   * endpoint, so `available` is whatever the generated column computes.
   */
  async function givenProduct(
    skus: { onHand: number; threshold?: number }[],
    namePrefix = 'Filter',
  ) {
    const n = (seq += 1);
    const slug = `filt-${String(n)}-${newId().slice(0, 6)}`;
    const codes: string[] = [];

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff())
          .send({ slug, name: `${namePrefix} Product ${String(n)}`, status: 'active' })
      ).status,
    ).toBe(201);

    for (const [index, spec] of skus.entries()) {
      const code = `FILT-${String(n)}-${String(index)}`;
      codes.push(code);
      expect(
        (
          await api()
            .post(`/api/v1/admin/products/${slug}/skus`)
            .set(asStaff())
            .send({ code, price: '100.0000' })
        ).status,
      ).toBe(201);

      if (spec.threshold !== undefined) {
        await db().update(sku).set({ lowStockThreshold: spec.threshold }).where(eq(sku.code, code));
      }
      const adjust = async (delta: number, reason: string) => {
        expect(
          (
            await api()
              .post('/api/v1/admin/inventory/adjustments')
              .set(asStaff())
              .send({ skuCode: code, delta, reason })
          ).status,
        ).toBe(201);
      };

      if (spec.onHand > 0) {
        await adjust(spec.onHand, 'manual_increase');
      } else {
        /*
         * A genuine ZERO row, not an absent one. The inventory list selects FROM `stock_item`,
         * so a SKU that was never adjusted has no row and cannot appear under any stock filter
         * — which is correct behaviour, and would make an `out_of_stock` assertion vacuous.
         * Adjusting up then back down materialises the row at zero, which is the state a
         * sold-out SKU is actually in.
         */
        await adjust(1, 'manual_increase');
        await adjust(-1, 'manual_decrease');
      }
    }

    return { slug, codes };
  }

  /* ══ 1. Product stock-state filter ════════════════════════════════════ */

  describe('GET /admin/products?stockState', () => {
    const list = (query: string) => api().get(`/api/v1/admin/products${query}`).set(asStaff());

    it('classifies a product by its live SKUs, counting it once', async () => {
      /* Two SKUs: one sold out, one in stock. The product is IN stock, on ONE row. */
      const mixed = await givenProduct([{ onHand: 0 }, { onHand: 10 }], 'Mixed');

      const inStock = await list('?stockState=in_stock&limit=100');
      expect(inStock.status).toBe(200);

      const rows = (inStock.body.products as { slug: string }[]).filter(
        (p) => p.slug === mixed.slug,
      );
      /* EXACTLY one. A join to stock_item would have emitted one row per matching SKU. */
      expect(rows).toHaveLength(1);

      const outOfStock = await list('?stockState=out_of_stock&limit=100');
      expect(
        (outOfStock.body.products as { slug: string }[]).some((p) => p.slug === mixed.slug),
      ).toBe(false);
    });

    it('treats a product with no stock at all as out of stock', async () => {
      const empty = await givenProduct([{ onHand: 0 }], 'Empty');

      const out = await list('?stockState=out_of_stock&limit=100');
      expect((out.body.products as { slug: string }[]).some((p) => p.slug === empty.slug)).toBe(
        true,
      );
    });

    it('treats a product with no SKUs at all as out of stock', async () => {
      const bare = await givenProduct([], 'Bare');

      const out = await list('?stockState=out_of_stock&limit=100');
      expect((out.body.products as { slug: string }[]).some((p) => p.slug === bare.slug)).toBe(
        true,
      );
    });

    it('reports low stock only for a SKU with a configured threshold', async () => {
      const watched = await givenProduct([{ onHand: 2, threshold: 5 }], 'Watched');
      const unwatched = await givenProduct([{ onHand: 2 }], 'Unwatched');

      const low = await list('?stockState=low_stock&limit=100');
      const slugs = (low.body.products as { slug: string }[]).map((p) => p.slug);

      expect(slugs).toContain(watched.slug);
      /* No threshold means the merchant never said what low means for it. */
      expect(slugs).not.toContain(unwatched.slug);

      /* A low SKU is still sellable, so it is in stock too. */
      const inStock = await list('?stockState=in_stock&limit=100');
      expect((inStock.body.products as { slug: string }[]).map((p) => p.slug)).toContain(
        watched.slug,
      );
    });

    it('leaves the store-wide counts unnarrowed by the filter', async () => {
      const all = await list('?limit=1');
      const filtered = await list('?stockState=out_of_stock&limit=1');

      /* `counts` answers "how many rows would each tab hold", not "how many did this page". */
      expect(filtered.body.counts).toEqual(all.body.counts);
    });

    it('combines with status and q, and rejects an invalid value', async () => {
      const ctx = await givenProduct([{ onHand: 5 }], 'Combo');

      const combined = await list(`?stockState=in_stock&status=active&q=${ctx.slug}&limit=50`);
      expect(combined.status).toBe(200);
      expect((combined.body.products as { slug: string }[]).map((p) => p.slug)).toEqual([ctx.slug]);

      expect((await list('?stockState=plenty')).status).toBe(400);
      expect((await list('?stock_state=in_stock')).status).toBe(400);
    });
  });

  /* ══ 2. Inventory filters ═════════════════════════════════════════════ */

  describe('GET /admin/inventory?q&stockState', () => {
    const list = (query: string) => api().get(`/api/v1/admin/inventory${query}`).set(asStaff());

    it('searches by SKU code', async () => {
      const ctx = await givenProduct([{ onHand: 7 }], 'Searchable');
      const code = ctx.codes[0]!;

      const found = await list(`?q=${code}&limit=50`);
      expect(found.status).toBe(200);
      expect((found.body.inventory as { skuCode: string }[]).map((s) => s.skuCode)).toEqual([code]);
      /* The total shares the predicate with the page. */
      expect(found.body.pagination.total).toBe(1);
    });

    it('filters out-of-stock and low-stock by this module own definitions', async () => {
      const ctx = await givenProduct([{ onHand: 0 }, { onHand: 3, threshold: 5 }], 'Levels');
      const [soldOut, low] = ctx.codes;

      const out = (await list('?stockState=out_of_stock&limit=100')).body.inventory as {
        skuCode: string;
      }[];
      expect(out.map((s) => s.skuCode)).toContain(soldOut);
      expect(out.map((s) => s.skuCode)).not.toContain(low);

      const lowRows = (await list('?stockState=low_stock&limit=100')).body.inventory as {
        skuCode: string;
      }[];
      expect(lowRows.map((s) => s.skuCode)).toContain(low);
      expect(lowRows.map((s) => s.skuCode)).not.toContain(soldOut);

      /* In stock includes the low one — it is still sellable. */
      const inRows = (await list('?stockState=in_stock&limit=100')).body.inventory as {
        skuCode: string;
      }[];
      expect(inRows.map((s) => s.skuCode)).toContain(low);
      expect(inRows.map((s) => s.skuCode)).not.toContain(soldOut);
    });

    it('treats LIKE wildcards as literal characters', async () => {
      await givenProduct([{ onHand: 1 }], 'Wildcard');

      expect((await list('?q=%25&limit=50')).body.inventory).toEqual([]);
      expect((await list('?q=_&limit=50')).body.inventory).toEqual([]);
    });

    it('paginates, and returns an empty page rather than an error', async () => {
      const page = await list('?limit=1&offset=0');
      expect(page.body.inventory).toHaveLength(1);
      expect(page.body.pagination.limit).toBe(1);

      const none = await list('?q=NO-SUCH-SKU-ANYWHERE');
      expect(none.status).toBe(200);
      expect(none.body.inventory).toEqual([]);
      expect(none.body.pagination.total).toBe(0);
    });

    it('rejects the list filters on the ledger HISTORY endpoint', async () => {
      const ctx = await givenProduct([{ onHand: 4 }], 'History');
      const code = ctx.codes[0]!;

      expect(
        (await api().get(`/api/v1/admin/inventory/${code}/history`).set(asStaff())).status,
      ).toBe(200);
      /*
       * The history shares pagination but NOT the filters. A parameter it would silently ignore
       * must be a 400 naming the field.
       */
      expect(
        (await api().get(`/api/v1/admin/inventory/${code}/history?q=x`).set(asStaff())).status,
      ).toBe(400);
      expect(
        (
          await api()
            .get(`/api/v1/admin/inventory/${code}/history?stockState=low_stock`)
            .set(asStaff())
        ).status,
      ).toBe(400);
    });

    it('rejects an unknown parameter and an invalid state', async () => {
      expect((await list('?storeId=whatever')).status).toBe(400);
      expect((await list('?stockState=plenty')).status).toBe(400);
      expect((await list('?q=')).status).toBe(400);
    });
  });

  /* ══ 3. Promotion filters ═════════════════════════════════════════════ */

  describe('GET /admin/promotions?q&status', () => {
    const list = (query: string) => api().get(`/api/v1/admin/promotions${query}`).set(asStaff());

    /** A promotion placed deliberately in one lifecycle state. */
    async function givenPromotion(spec: {
      isActive: boolean;
      startsAt?: Date | null;
      endsAt?: Date | null;
      name?: string;
    }) {
      /*
       * A COUNTER, not a slice of `newId()`. UUIDv7 encodes time in its leading characters, so
       * codes minted in the same window collide on the per-store unique index and the create
       * answers `409`.
       */
      promoSeq += 1;
      const code = `PROMO${String(promoSeq).padStart(4, '0')}`;
      const created = await api()
        .post('/api/v1/admin/promotions')
        .set(asStaff())
        .send({
          code,
          name: spec.name ?? 'Filter Promo',
          discountType: 'percentage',
          percentRate: '10.00',
        });
      expect(created.status).toBe(201);

      await db()
        .update(promotion)
        .set({
          isActive: spec.isActive,
          startsAt: spec.startsAt ?? null,
          endsAt: spec.endsAt ?? null,
        })
        .where(eq(promotion.code, code));

      return code;
    }

    it('classifies active, scheduled, expired and disabled', async () => {
      const past = new Date(Date.now() - 7 * 86_400_000);
      const future = new Date(Date.now() + 7 * 86_400_000);

      const active = await givenPromotion({ isActive: true, startsAt: past, endsAt: future });
      const unbounded = await givenPromotion({ isActive: true });
      const scheduled = await givenPromotion({ isActive: true, startsAt: future });
      const expired = await givenPromotion({ isActive: true, endsAt: past });
      const disabled = await givenPromotion({ isActive: false });

      const codesIn = async (status: string) =>
        ((await list(`?status=${status}&limit=100`)).body.promotions as { code: string }[]).map(
          (p) => p.code,
        );

      const activeCodes = await codesIn('active');
      expect(activeCodes).toContain(active);
      /* No bounds at all means already running and never ending. */
      expect(activeCodes).toContain(unbounded);
      expect(activeCodes).not.toContain(scheduled);
      expect(activeCodes).not.toContain(expired);
      expect(activeCodes).not.toContain(disabled);

      expect(await codesIn('scheduled')).toContain(scheduled);
      expect(await codesIn('expired')).toContain(expired);

      /* Disabled outranks the window: this one is both expired-by-date and switched off. */
      const disabledCodes = await codesIn('disabled');
      expect(disabledCodes).toContain(disabled);
      expect(await codesIn('expired')).not.toContain(disabled);
    });

    it('searches by code and by name', async () => {
      const code = await givenPromotion({ isActive: true, name: 'Diwali Doorbuster' });

      expect(
        ((await list(`?q=${code}&limit=50`)).body.promotions as { code: string }[]).map(
          (p) => p.code,
        ),
      ).toEqual([code]);

      expect(
        ((await list('?q=Doorbuster&limit=50')).body.promotions as { code: string }[]).map(
          (p) => p.code,
        ),
      ).toContain(code);
    });

    it('treats LIKE wildcards as literal characters', async () => {
      await givenPromotion({ isActive: true });
      expect((await list('?q=%25&limit=50')).body.promotions).toEqual([]);
    });

    it('never publishes a usage count', async () => {
      await givenPromotion({ isActive: true });
      const row = (await list('?limit=1')).body.promotions[0] as Record<string, unknown>;

      /*
       * The Figma list shows a "Used" column. Nothing counts redemptions — no redemption table,
       * no counter — so no such figure is published rather than one being derived from data
       * that cannot support it.
       */
      for (const field of ['usedCount', 'used', 'redemptions', 'timesUsed']) {
        expect(row).not.toHaveProperty(field);
      }
    });

    it('keeps the total in step with the filter, and rejects bad input', async () => {
      const none = await list('?q=NO-SUCH-PROMOTION');
      expect(none.status).toBe(200);
      expect(none.body.promotions).toEqual([]);
      expect(none.body.pagination.total).toBe(0);

      expect((await list('?status=paused')).status).toBe(400);
      expect((await list('?storeId=x')).status).toBe(400);
    });
  });

  /* ══ 4. Customer addresses ════════════════════════════════════════════ */

  describe('GET /admin/customers/:customerId/addresses', () => {
    async function givenCustomerWithAddress() {
      const customer = await signIn();
      const headers = { Authorization: `Bearer ${customer.token}` };
      const created = await api().post('/api/v1/users/me/addresses').set(headers).send({
        label: 'Home',
        recipientName: 'A B',
        phone: '+91 9876543210',
        line1: '1 Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560025',
      });
      expect(created.status).toBe(201);
      return customer;
    }

    it('lists one customer addresses for staff', async () => {
      const customer = await givenCustomerWithAddress();

      const response = await api()
        .get(`/api/v1/admin/customers/${customer.id}/addresses`)
        .set(asStaff());

      expect(response.status).toBe(200);
      expect(response.body.addresses).toHaveLength(1);
      expect(response.body.addresses[0].city).toBe('Bengaluru');
    });

    it('never returns another customer addresses', async () => {
      const mine = await givenCustomerWithAddress();
      const other = await givenCustomerWithAddress();

      const response = await api()
        .get(`/api/v1/admin/customers/${other.id}/addresses`)
        .set(asStaff());

      expect(response.body.addresses).toHaveLength(1);
      expect(JSON.stringify(response.body)).not.toContain(mine.id);
    });

    it('returns an empty list for a customer with none, and for an unknown id', async () => {
      const bare = await signIn();

      expect(
        (await api().get(`/api/v1/admin/customers/${bare.id}/addresses`).set(asStaff())).body
          .addresses,
      ).toEqual([]);

      /*
       * 200 with an empty list, NOT 404. A 404 here would be an oracle for which customer ids
       * exist in other stores; existence is established by the customer DETAIL endpoint.
       */
      const unknown = await api()
        .get(`/api/v1/admin/customers/${newId()}/addresses`)
        .set(asStaff());
      expect(unknown.status).toBe(200);
      expect(unknown.body.addresses).toEqual([]);
    });

    it('refuses anonymous and non-staff callers, and a malformed id', async () => {
      const customer = await givenCustomerWithAddress();
      const path = `/api/v1/admin/customers/${customer.id}/addresses`;

      expect((await api().get(path)).status).toBe(401);
      expect((await api().get(path).set(asCustomer())).status).toBe(403);
      expect(
        (await api().get('/api/v1/admin/customers/not-a-uuid/addresses').set(asStaff())).status,
      ).toBe(400);
    });
  });

  /* ══ 5. Customer sessions ═════════════════════════════════════════════ */

  describe('/admin/customers/:customerId/sessions', () => {
    const sessionsOf = (customerId: string) =>
      api().get(`/api/v1/admin/customers/${customerId}/sessions`).set(asStaff());

    it('lists sessions without any token material', async () => {
      const customer = await signIn();

      const response = await sessionsOf(customer.id);
      expect(response.status).toBe(200);
      expect(response.body.sessions.length).toBeGreaterThan(0);

      const session = response.body.sessions[0] as Record<string, unknown>;
      /*
       * The EXACT key set. `tokenHash` and `userId` must not appear — the first is never
       * selected by the query, the second is redundant because the caller named the customer.
       */
      expect(Object.keys(session).sort()).toEqual([
        'active',
        'consumedAt',
        'createdAt',
        'expiresAt',
        'familyId',
        'id',
        'ipAddress',
        'revokedAt',
        'revokedReason',
        'updatedAt',
        'userAgent',
      ]);
      expect(session['active']).toBe(true);

      /* The stored hash must appear nowhere in the payload. */
      const [row] = await db()
        .select()
        .from(refreshSession)
        .where(eq(refreshSession.userId, customer.id));
      expect(JSON.stringify(response.body)).not.toContain(row!.tokenHash);
      for (const field of ['tokenHash', 'token', 'refreshToken', 'userId']) {
        expect(session).not.toHaveProperty(field);
      }
    });

    it('404s an unknown customer rather than returning an empty page', async () => {
      /* Unlike addresses, the customer is resolved first — so an operator can tell a typo. */
      expect((await sessionsOf(newId())).status).toBe(404);
    });

    it('revokes a session, and the refresh token stops working', async () => {
      const email = `revoke.${newId()}@example.com`;
      const victim = await container.identity.registerCustomer({
        storeId,
        input: { email, password: PASSWORD, firstName: 'V', lastName: 'X' },
      });
      const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(login.status).toBe(200);
      const refreshToken = login.body.refreshToken as string;

      const listed = await sessionsOf(victim.id);
      const sessionId = (listed.body.sessions as { id: string }[])[0]!.id;

      const revoked = await api()
        .delete(`/api/v1/admin/customers/${victim.id}/sessions/${sessionId}`)
        .set(asStaff());
      expect(revoked.status).toBe(204);

      /* The session is now inactive, and the token it minted is refused. */
      const after = await sessionsOf(victim.id);
      const session = (
        after.body.sessions as { id: string; active: boolean; revokedReason: string | null }[]
      ).find((s) => s.id === sessionId);
      expect(session!.active).toBe(false);
      expect(session!.revokedReason).toBe('staff_revoked');

      expect((await api().post('/api/v1/auth/refresh').send({ refreshToken })).status).not.toBe(
        200,
      );
    });

    it('404s a repeated revoke, an unknown session and another customer session', async () => {
      const a = await signIn();
      const b = await signIn();

      const sessionId = ((await sessionsOf(a.id)).body.sessions as { id: string }[])[0]!.id;

      expect(
        (await api().delete(`/api/v1/admin/customers/${a.id}/sessions/${sessionId}`).set(asStaff()))
          .status,
      ).toBe(204);
      /* Already revoked is indistinguishable from never yours — nothing changed either way. */
      expect(
        (await api().delete(`/api/v1/admin/customers/${a.id}/sessions/${sessionId}`).set(asStaff()))
          .status,
      ).toBe(404);

      expect(
        (await api().delete(`/api/v1/admin/customers/${a.id}/sessions/${newId()}`).set(asStaff()))
          .status,
      ).toBe(404);

      /*
       * B's session id under A's path. The ownership predicate is in the QUERY, so this matches
       * no row — and B's session must still be live afterwards.
       */
      const bSessionId = ((await sessionsOf(b.id)).body.sessions as { id: string }[])[0]!.id;
      expect(
        (
          await api()
            .delete(`/api/v1/admin/customers/${a.id}/sessions/${bSessionId}`)
            .set(asStaff())
        ).status,
      ).toBe(404);

      const bAfter = (await sessionsOf(b.id)).body.sessions as { id: string; active: boolean }[];
      expect(bAfter.find((s) => s.id === bSessionId)!.active).toBe(true);
    });

    it('refuses anonymous and non-staff callers', async () => {
      const customer = await signIn();
      const listPath = `/api/v1/admin/customers/${customer.id}/sessions`;
      const sessionId = ((await sessionsOf(customer.id)).body.sessions as { id: string }[])[0]!.id;
      const deletePath = `${listPath}/${sessionId}`;

      expect((await api().get(listPath)).status).toBe(401);
      expect((await api().get(listPath).set(asCustomer())).status).toBe(403);
      expect((await api().delete(deletePath)).status).toBe(401);
      expect((await api().delete(deletePath).set(asCustomer())).status).toBe(403);

      /* Nothing was revoked by any of those. */
      const after = (await sessionsOf(customer.id)).body.sessions as {
        id: string;
        active: boolean;
      }[];
      expect(after.find((s) => s.id === sessionId)!.active).toBe(true);
    });

    it('rejects malformed ids and unknown query parameters', async () => {
      const customer = await signIn();
      expect(
        (await api().get('/api/v1/admin/customers/not-a-uuid/sessions').set(asStaff())).status,
      ).toBe(400);
      expect(
        (
          await api()
            .get(`/api/v1/admin/customers/${customer.id}/sessions?limit=500`)
            .set(asStaff())
        ).status,
      ).toBe(400);
      expect(
        (
          await api()
            .get(`/api/v1/admin/customers/${customer.id}/sessions?storeId=x`)
            .set(asStaff())
        ).status,
      ).toBe(400);
      expect(
        (
          await api()
            .delete(`/api/v1/admin/customers/${customer.id}/sessions/not-a-uuid`)
            .set(asStaff())
        ).status,
      ).toBe(400);
    });
  });
});
