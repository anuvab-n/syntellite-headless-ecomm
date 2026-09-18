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
 * `GET /admin/customers` — against real PostgreSQL, through the REAL container.
 *
 * `buildContainer` rather than a hand-wired router: the scope guard reads privileges from the
 * database on every request and the store resolver runs ahead of it, and a stub app would wire
 * neither — so the demotion and deactivation cases below would prove nothing.
 *
 * Seven properties carry this file:
 *
 *  1. **Tenancy is in the query**, proven against a REAL account in another store.
 *  2. **No credential or privilege flag leaves**, asserted over the whole serialised body.
 *  3. **The page and the total agree**, including under filters.
 *  4. **Ordering is total**, so `offset` paging cannot skip or repeat.
 *  5. **Both date bounds are inclusive**, proven at an exact instant.
 *  6. **The read writes nothing** — no row, no audit entry, no outbox event, no session.
 *  7. **Soft-deleted accounts are invisible**, matching every other read in this module.
 */
describe('admin customers (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';
  let customerToken = '';
  let staffUserId = '';

  const PASSWORD = 'a-sufficiently-long-password';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const pool = () => container.db.pool;

  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** Accounts this suite registered in the store under test. */
  const registered: { id: string; email: string }[] = [];

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

    const staff = await register('staff.admincust', { staff: true });
    staffUserId = staff.id;
    staffToken = await login(staff.email);

    const customer = await register('customer.admincust', { staff: false });
    customerToken = await login(customer.email);

    // Four more plain customers, so paging and filtering have something to work with.
    for (let i = 0; i < 4; i += 1) await register(`extra${i}.admincust`, { staff: false });
  }, 300_000);

  afterAll(async () => {
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  async function register(
    prefix: string,
    opts: { staff: boolean },
  ): Promise<{ id: string; email: string }> {
    const email = `${prefix}.${newId()}@example.com`;
    const user = await container.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Test', lastName: 'User' },
    });
    if (opts.staff) {
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    registered.push({ id: user.id, email });
    return { id: user.id, email };
  }

  async function login(email: string): Promise<string> {
    const res = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.accessToken as string;
  }

  /* ── 1. Authentication and authorization ──────────────────────────────── */

  describe('authentication and authorization', () => {
    it('refuses an anonymous request with 401', async () => {
      expect((await api().get('/api/v1/admin/customers')).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      expect((await api().get('/api/v1/admin/customers').set(asCustomer())).status).toBe(403);
    });

    it('serves active staff with 200', async () => {
      const res = await api().get('/api/v1/admin/customers').set(asStaff());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.customers)).toBe(true);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const user = await register('demote.admincust', { staff: true });
      const auth = { Authorization: `Bearer ${await login(user.email)}` };

      expect((await api().get('/api/v1/admin/customers').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/customers').set(auth)).status).toBe(403);
    });

    /** Deactivation is checked by AUTHENTICATION, so it answers 401 rather than 403. */
    it('refuses a deactivated staff member with 401', async () => {
      const user = await register('deactivate.admincust', { staff: true });
      const auth = { Authorization: `Bearer ${await login(user.email)}` };

      expect((await api().get('/api/v1/admin/customers').set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get('/api/v1/admin/customers').set(auth)).status).toBe(401);
    });
  });

  /* ── 2. Query validation ──────────────────────────────────────────────── */

  describe('query validation', () => {
    const status = async (qs: string) =>
      (await api().get(`/api/v1/admin/customers?${qs}`).set(asStaff())).status;

    it('rejects a client-supplied storeId rather than ignoring it', async () => {
      const res = await api().get(`/api/v1/admin/customers?storeId=${newId()}`).set(asStaff());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unknown parameters and out-of-range paging', async () => {
      /*
       * `q` became a REAL parameter in Increment 56 and is asserted in its own block below.
       * `email` stays unknown deliberately: searching is `q`'s job, and a second spelling of the
       * same intent is a second thing to keep consistent.
       */
      expect(await status('email=jane@example.com')).toBe(400);
      expect(await status('isStaff=true')).toBe(400);
      expect(await status('limit=101')).toBe(400);
      expect(await status('limit=0')).toBe(400);
      expect(await status('limit=abc')).toBe(400);
      expect(await status('offset=-1')).toBe(400);
    });

    /**
     * `isActive` is parsed from two exact strings rather than coerced. A boolean coercion treats
     * every non-empty string as `true`, so `?isActive=false` would have filtered to ACTIVE
     * accounts — the precise opposite of the request, with no error to notice.
     */
    it('rejects an isActive that is not exactly true or false', async () => {
      expect(await status('isActive=yes')).toBe(400);
      expect(await status('isActive=1')).toBe(400);
      expect(await status('isActive=')).toBe(400);
      expect(await status('isActive=true')).toBe(200);
      expect(await status('isActive=false')).toBe(200);
    });

    it('rejects a bare date and accepts an ISO instant with an offset', async () => {
      expect(await status('createdFrom=2026-09-01')).toBe(400);
      expect(await status('createdTo=tomorrow')).toBe(400);
      expect(await status('createdFrom=2026-09-01T00:00:00%2B05:30')).toBe(200);
    });
  });

  /* ── 3. The listing itself ────────────────────────────────────────────── */

  describe('listing, filters and pagination', () => {
    it('returns every live account in the store, staff included', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect(res.status).toBe(200);

      const ids = (res.body.customers as { id: string }[]).map((c) => c.id);
      for (const r of registered) expect(ids).toContain(r.id);

      // Staff are rows in this table too; hiding them would make the list disagree with the DB.
      expect(ids).toContain(staffUserId);
    });

    it('returns exactly the documented DTO, with no extra keys', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=1').set(asStaff());
      const row = (res.body.customers as Record<string, unknown>[])[0];
      expect(row).toBeDefined();
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'createdAt',
        'email',
        'firstName',
        'id',
        'isActive',
        'lastName',
        'lastOrderAt',
        'orderCount',
        'phone',
        'totalSpent',
        'updatedAt',
      ]);
    });

    it('filters by isActive in both directions', async () => {
      const target = await register('inactive.admincust', { staff: false });
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, target.id));

      const inactive = await api()
        .get('/api/v1/admin/customers?limit=100&isActive=false')
        .set(asStaff());
      expect(inactive.status).toBe(200);
      const inactiveIds = (inactive.body.customers as { id: string; isActive: boolean }[]).map(
        (c) => {
          expect(c.isActive).toBe(false);
          return c.id;
        },
      );
      expect(inactiveIds).toContain(target.id);

      const active = await api()
        .get('/api/v1/admin/customers?limit=100&isActive=true')
        .set(asStaff());
      for (const c of active.body.customers as { isActive: boolean }[])
        expect(c.isActive).toBe(true);
      expect((active.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(target.id);

      // The two halves partition the whole list — neither drops nor duplicates a row.
      const all = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect(
        (active.body.pagination.total as number) + (inactive.body.pagination.total as number),
      ).toBe(all.body.pagination.total as number);
    });

    /** See the payments suite for why the instant is pinned rather than read back from a row. */
    it('treats both date bounds as inclusive, at an exact instant', async () => {
      const target = await register('dated.admincust', { staff: false });
      const pinned = '2026-05-20T08:15:00.000Z';
      await pool().query('update app_user set created_at = $2::timestamptz where id = $1', [
        target.id,
        pinned,
      ]);

      const enc = encodeURIComponent(pinned);
      const exact = await api()
        .get(`/api/v1/admin/customers?limit=100&createdFrom=${enc}&createdTo=${enc}`)
        .set(asStaff());
      expect(exact.status).toBe(200);
      expect((exact.body.customers as { id: string }[]).map((c) => c.id)).toEqual([target.id]);

      const justAfter = new Date(Date.parse(pinned) + 1).toISOString();
      const justBefore = new Date(Date.parse(pinned) - 1).toISOString();

      const late = await api()
        .get(`/api/v1/admin/customers?limit=100&createdFrom=${encodeURIComponent(justAfter)}`)
        .set(asStaff());
      expect((late.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(target.id);

      const early = await api()
        .get(`/api/v1/admin/customers?limit=100&createdTo=${encodeURIComponent(justBefore)}`)
        .set(asStaff());
      expect((early.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(target.id);
    });

    it('keeps the page and the total consistent, including under a filter', async () => {
      const page = await api().get('/api/v1/admin/customers?limit=2&offset=0').set(asStaff());
      expect(page.status).toBe(200);
      expect((page.body.customers as unknown[]).length).toBe(2);
      expect(page.body.pagination.limit).toBe(2);
      expect(page.body.pagination.offset).toBe(0);

      const total = page.body.pagination.total as number;
      const everything = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect((everything.body.customers as unknown[]).length).toBe(total);

      const filtered = await api()
        .get('/api/v1/admin/customers?limit=100&isActive=true')
        .set(asStaff());
      expect((filtered.body.customers as unknown[]).length).toBe(
        filtered.body.pagination.total as number,
      );
    });

    /**
     * Ordering must be TOTAL, and this forces the condition that proves it.
     *
     * Registration runs Argon2, which takes long enough that naturally-created accounts never
     * share a `created_at` — so a test over them passes with or without the `id` tiebreaker and
     * detects nothing. A mutation probe caught exactly that: dropping `desc(appUser.id)` from
     * the ORDER BY left an earlier version of this test green.
     *
     * So the tie is MANUFACTURED: several accounts are pinned to one identical instant, which is
     * the condition under which `created_at` alone leaves PostgreSQL free to return rows in any
     * order per query — and `offset` paging over a non-total order silently skips and repeats.
     */
    it('orders deterministically even when rows share an instant', async () => {
      const tied = [
        await register('tie0.admincust', { staff: false }),
        await register('tie1.admincust', { staff: false }),
        await register('tie2.admincust', { staff: false }),
      ];
      await pool().query(
        `update app_user set created_at = '2026-07-01T00:00:00.000Z'::timestamptz
          where id = any($1::uuid[])`,
        [tied.map((t) => t.id)],
      );

      const full = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const expected = (full.body.customers as { id: string }[]).map((c) => c.id);
      expect(expected.length).toBeGreaterThan(5);

      /*
       * The tied rows must be adjacent and in descending id order.
       *
       * **A caveat worth recording rather than hiding.** A mutation probe removed
       * `desc(appUser.id)` from the ORDER BY and every assertion in this test still passed —
       * including this one. The reason is that the backward index scan over
       * `ix_app_user_store_created` already emits tied rows newest-id-first, so at this fixture's
       * size the tiebreaker changes nothing observable.
       *
       * The tiebreaker is kept anyway, as defence in depth: that plan is not guaranteed. A
       * parallel sequential scan, a different index, or a large enough table can all reorder
       * rows that tie on `created_at`, and `offset` paging over a non-total order silently skips
       * and repeats. So these assertions prove the ordering is STABLE and correct; they do not,
       * and at this scale cannot, prove the second sort key is present.
       */
      const tiedPositions = tied.map((t) => expected.indexOf(t.id)).sort((a, b) => a - b);
      expect(tiedPositions[0]).toBeGreaterThanOrEqual(0);
      expect(tiedPositions[2]! - tiedPositions[0]!).toBe(2);

      const tiedInListOrder = expected.slice(tiedPositions[0], tiedPositions[2]! + 1);
      expect(tiedInListOrder).toEqual([...tied.map((t) => t.id)].sort().reverse());

      // Walking one row at a time must reproduce the single big page exactly.
      const walked: string[] = [];
      for (let offset = 0; offset < expected.length; offset += 1) {
        const one = await api()
          .get(`/api/v1/admin/customers?limit=1&offset=${offset}`)
          .set(asStaff());
        walked.push((one.body.customers as { id: string }[])[0]?.id ?? '');
      }
      expect(walked).toEqual(expected);

      // And the full page itself must be stable across repeated identical requests.
      const again = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect((again.body.customers as { id: string }[]).map((c) => c.id)).toEqual(expected);
    });

    it('orders newest first', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const times = (res.body.customers as { createdAt: string }[]).map((c) =>
        new Date(c.createdAt).getTime(),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('excludes soft-deleted accounts', async () => {
      const target = await register('erased.admincust', { staff: false });
      await pool().query('update app_user set deleted_at = now() where id = $1', [target.id]);

      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect((res.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(target.id);
    });
  });

  /* ── 4. Sensitive fields ──────────────────────────────────────────────── */

  describe('sensitive-field exclusion', () => {
    const FORBIDDEN = [
      'passwordHash',
      'password_hash',
      'isStaff',
      'is_staff',
      'isSuperuser',
      'is_superuser',
      'storeId',
      'store_id',
      'deletedAt',
      'deleted_at',
      'tokenHash',
      'token_hash',
      'refreshToken',
      'accessToken',
    ];

    it('never leaks a credential, a privilege flag or a token field', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const body = JSON.stringify(res.body);
      for (const field of FORBIDDEN) expect(body).not.toContain(field);
    });

    /** Otherwise the assertion above could pass against a response that had no rows at all. */
    it('proves the excluded hashes and flags really are in the database', async () => {
      const { rows } = await pool().query<{ hashes: string; staff: string }>(
        `select count(*) filter (where password_hash <> '')::text as hashes,
                count(*) filter (where is_staff)::text as staff
           from app_user where store_id = $1`,
        [storeId],
      );
      expect(Number(rows[0]?.hashes ?? '0')).toBeGreaterThan(0);
      expect(Number(rows[0]?.staff ?? '0')).toBeGreaterThan(0);
    });

    it('does not turn the list into a password-reset or session probe', async () => {
      // Those tables are not reachable from this query at all; assert they exist and are ignored.
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('password_reset');
      expect(body).not.toContain('refresh_session');
    });
  });

  /* ── 5. Tenant isolation, against a real foreign account ──────────────── */

  describe('tenant isolation', () => {
    let foreignUserId = '';
    let foreignEmail = '';

    beforeAll(async () => {
      const otherStoreId = newId();
      foreignUserId = newId();
      foreignEmail = `foreign.cust.${foreignUserId}@example.com`;

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `other-${otherStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'argon2-placeholder', 'Foreign', 'Person')`,
        [foreignUserId, otherStoreId, foreignEmail],
      );
    }, 120_000);

    it('actually created a foreign account — otherwise the next cases prove nothing', async () => {
      const { rows } = await pool().query<{ count: string }>(
        'select count(*)::text as count from app_user where store_id <> $1',
        [storeId],
      );
      expect(Number(rows[0]?.count ?? '0')).toBe(1);
    });

    it('never returns another store’s account', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const body = JSON.stringify(res.body);
      expect((res.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(
        foreignUserId,
      );
      expect(body).not.toContain(foreignEmail);
    });

    it('counts only this store’s accounts in the total', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const { rows } = await pool().query<{ count: string }>(
        'select count(*)::text as count from app_user where store_id = $1 and deleted_at is null',
        [storeId],
      );
      expect(res.body.pagination.total).toBe(Number(rows[0]?.count ?? '0'));
    });

    it('cannot be widened past the tenant by any filter combination', async () => {
      const res = await api()
        .get('/api/v1/admin/customers?limit=100&isActive=true&createdFrom=1970-01-01T00:00:00Z')
        .set(asStaff());
      expect(res.status).toBe(200);
      expect((res.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(
        foreignUserId,
      );
    });
  });

  /* ── 6. Read-only, and the index the list depends on ──────────────────── */

  describe('the read changes nothing', () => {
    it('writes no row, no audit entry, no outbox event and no session', async () => {
      const countOf = async (sql: string): Promise<string> => {
        const { rows } = await pool().query<{ c: string }>(sql);
        return rows[0]?.c ?? '?';
      };

      const snapshot = async () => {
        const { rows: userState } = await pool().query<{ c: string; m: string }>(
          "select count(*)::text c, coalesce(max(updated_at)::text, '-') m from app_user",
        );
        return {
          // Count AND newest updated_at: a read that silently re-stamped a row without
          // inserting one would slip past a count on its own.
          users: userState[0],
          audits: (await db().select({ id: auditLog.id }).from(auditLog)).length,
          events: (await db().select({ id: outboxEvent.id }).from(outboxEvent)).length,
          sessions: await countOf('select count(*)::text c from refresh_session'),
          resets: await countOf('select count(*)::text c from password_reset_token'),
          keys: await countOf('select count(*)::text c from idempotency_key'),
        };
      };

      const before = await snapshot();

      await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      await api().get('/api/v1/admin/customers?isActive=true').set(asStaff());
      await api().get('/api/v1/admin/customers?limit=5&offset=1').set(asStaff());

      expect(await snapshot()).toEqual(before);
    });

    it('has the partial (store_id, created_at) index the list depends on', async () => {
      const { rows } = await pool().query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'app_user'`,
      );
      const covering = rows.filter((r) => /\(\s*store_id\s*,\s*created_at\s*\)/iu.test(r.indexdef));
      expect(covering.length).toBe(1);
      expect(covering[0]?.indexdef).toContain('ix_app_user_store_created');
      // Partial, matching the list's own `deleted_at IS NULL` predicate.
      expect(covering[0]?.indexdef).toMatch(/WHERE .*deleted_at IS NULL/iu);
    });

    it('reads the page from app_user alone — no join, so no N+1 to avoid', async () => {
      const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
        `explain select id, email from app_user
          where store_id = $1 and deleted_at is null
          order by created_at desc, id desc limit 100`,
        [storeId],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).not.toMatch(/Join|Nested Loop|SubPlan/u);
    });
  });

  /* ── 6b. Microsecond precision at the bounds ──────────────────────────── */

  /**
   * The same precision rule as `GET /admin/payments`, asserted independently here.
   *
   * PostgreSQL stores `timestamptz` to MICROSECONDS; a JavaScript `Date` cannot represent one,
   * so a bound can only ever NAME A MILLISECOND and `createdAt` is published truncated to one.
   * "Inclusive" therefore means inclusive of the whole millisecond named — otherwise an account
   * stored at `.123456` is excluded by the very timestamp the API published for it.
   */
  describe('date bounds at microsecond precision', () => {
    const STORED = '2026-08-11T09:45:00.987654Z';
    const NAMED = '2026-08-11T09:45:00.987Z';
    let subject = { id: '', email: '' };

    beforeAll(async () => {
      subject = await register('micros.admincust', { staff: false });
      const res = await pool().query(
        'update app_user set created_at = $2::timestamptz where id = $1',
        [subject.id, STORED],
      );
      expect(res.rowCount).toBe(1);
    }, 120_000);

    const idsFor = async (qs: string): Promise<string[]> => {
      const res = await api().get(`/api/v1/admin/customers?limit=100&${qs}`).set(asStaff());
      expect(res.status).toBe(200);
      return (res.body.customers as { id: string }[]).map((c) => c.id);
    };

    it('stores microseconds the API cannot publish', async () => {
      const { rows } = await pool().query<{ exact: string }>(
        `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as exact
           from app_user where id = $1`,
        [subject.id],
      );
      expect(rows[0]?.exact).toBe('2026-08-11T09:45:00.987654');

      const listed = await api()
        .get(`/api/v1/admin/customers?limit=100&createdFrom=${encodeURIComponent(NAMED)}`)
        .set(asStaff());
      const row = (listed.body.customers as { id: string; createdAt: string }[]).find(
        (c) => c.id === subject.id,
      );
      // Published truncated, and therefore STRICTLY EARLIER than what is stored.
      expect(row?.createdAt).toBe(NAMED);
    });

    it('includes an account whose stored microseconds exceed the named upper bound', async () => {
      expect(await idsFor(`createdTo=${encodeURIComponent(NAMED)}`)).toContain(subject.id);
    });

    it('round-trips its own published timestamp as both bounds', async () => {
      const enc = encodeURIComponent(NAMED);
      expect(await idsFor(`createdFrom=${enc}&createdTo=${enc}`)).toEqual([subject.id]);
    });

    it('excludes the account one millisecond below the named upper bound', async () => {
      const below = '2026-08-11T09:45:00.986Z';
      expect(await idsFor(`createdTo=${encodeURIComponent(below)}`)).not.toContain(subject.id);
    });

    it('keeps the lower bound inclusive of the named millisecond', async () => {
      expect(await idsFor(`createdFrom=${encodeURIComponent(NAMED)}`)).toContain(subject.id);
    });

    it('excludes the account when the lower bound is the next millisecond', async () => {
      const above = '2026-08-11T09:45:00.988Z';
      expect(await idsFor(`createdFrom=${encodeURIComponent(above)}`)).not.toContain(subject.id);
    });

    it('does not spill into the millisecond after the upper bound', async () => {
      const later = await register('micros2.admincust', { staff: false });
      await pool().query('update app_user set created_at = $2::timestamptz where id = $1', [
        later.id,
        '2026-08-11T09:45:00.988000Z',
      ]);

      const got = await idsFor(`createdTo=${encodeURIComponent(NAMED)}`);
      expect(got).toContain(subject.id);
      expect(got).not.toContain(later.id);
    });
  });

  /* ── 6c. GET /admin/customers/:customerId — the detail route ──────────── */

  /**
   * The single-customer read. Increment 52.
   *
   * Shares the list's projection and mapper, so most of what could go wrong here is already
   * covered above. What is genuinely new is the NOT-FOUND surface: three different reasons a
   * customer is unreachable — unknown, foreign, erased — which must be indistinguishable, and
   * which a naive implementation would answer differently (404 / 200 / 200).
   */
  describe('customer detail', () => {
    const detail = (id: string) => api().get(`/api/v1/admin/customers/${id}`).set(asStaff());

    it('refuses an anonymous request with 401', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;
      expect((await api().get(`/api/v1/admin/customers/${target.id}`)).status).toBe(401);
    });

    it('refuses an authenticated non-staff customer with 403', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;
      expect(
        (await api().get(`/api/v1/admin/customers/${target.id}`).set(asCustomer())).status,
      ).toBe(403);
    });

    it('serves active staff with 200 and the seven documented fields', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;

      const res = await detail(target.id);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.customer as Record<string, unknown>).sort()).toEqual([
        'createdAt',
        'email',
        'firstName',
        'id',
        'isActive',
        'lastName',
        'lastOrderAt',
        'orderCount',
        'phone',
        'totalSpent',
        'updatedAt',
      ]);
      expect(res.body.customer.id).toBe(target.id);
      expect(res.body.customer.email).toBe(target.email);
    });

    it('stops serving a demoted staff member on the very next request', async () => {
      const user = await register('demote.detail.admincust', { staff: true });
      const auth = { Authorization: `Bearer ${await login(user.email)}` };
      const path = `/api/v1/admin/customers/${user.id}`;

      expect((await api().get(path).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, user.id));
      expect((await api().get(path).set(auth)).status).toBe(403);
    });

    it('refuses a deactivated staff member with 401', async () => {
      const user = await register('deactivate.detail.admincust', { staff: true });
      const auth = { Authorization: `Bearer ${await login(user.email)}` };
      const path = `/api/v1/admin/customers/${user.id}`;

      expect((await api().get(path).set(auth)).status).toBe(200);
      await db().update(appUser).set({ isActive: false }).where(eq(appUser.id, user.id));
      expect((await api().get(path).set(auth)).status).toBe(401);
    });

    it('rejects a malformed UUID with 400', async () => {
      const res = await detail('not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('answers 404 for an unknown customer', async () => {
      expect((await detail(newId())).status).toBe(404);
    });

    /**
     * The three not-found reasons must be indistinguishable. A soft-deleted customer is the one
     * most likely to leak: the row is right there, and only the `deleted_at IS NULL` predicate
     * keeps it from being served.
     */
    it('answers 404 for a soft-deleted customer, identically to an unknown one', async () => {
      const target = await register('erased.detail.admincust', { staff: false });
      expect((await detail(target.id)).status).toBe(200);

      await pool().query('update app_user set deleted_at = now() where id = $1', [target.id]);

      const erased = await detail(target.id);
      const unknown = await detail(newId());
      expect(erased.status).toBe(404);
      expect(erased.body.error.code).toBe(unknown.body.error.code);
    });

    /**
     * Tenancy, proven against a REAL customer in another store rather than against an absence.
     * Asserting only that an invented id 404s would pass against a repository with no tenant
     * predicate at all, since an invented id matches nothing either way.
     */
    it('answers 404 for a customer belonging to another store', async () => {
      const otherStoreId = newId();
      const foreignId = newId();
      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Detail Other Store', 'INR', 'Asia/Kolkata', true)`,
        [otherStoreId, `detail-other-${otherStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name)
         values ($1, $2, $3, 'argon2-placeholder', 'Foreign', 'Detail')`,
        [foreignId, otherStoreId, `foreign.detail.${foreignId}@example.com`],
      );

      // The row exists and is live — only the tenant predicate keeps it out.
      const { rows } = await pool().query<{ c: string }>(
        'select count(*)::text c from app_user where id = $1 and deleted_at is null',
        [foreignId],
      );
      expect(Number(rows[0]?.c ?? '0')).toBe(1);

      expect((await detail(foreignId)).status).toBe(404);
    });

    it('never leaks a credential, a privilege flag or a token field', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;

      const body = JSON.stringify((await detail(target.id)).body);
      for (const field of [
        'passwordHash',
        'password_hash',
        'isStaff',
        'is_staff',
        'isSuperuser',
        'is_superuser',
        'storeId',
        'store_id',
        'deletedAt',
        'deleted_at',
        'tokenHash',
        'refreshToken',
      ]) {
        expect(body).not.toContain(field);
      }
    });

    /** The list and the detail must describe the same customer identically. */
    it('agrees field for field with the list row for the same customer', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;

      const list = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const fromList = (list.body.customers as { id: string }[]).find((c) => c.id === target.id);
      expect(fromList).toBeDefined();

      expect((await detail(target.id)).body.customer).toEqual(fromList);
    });

    it('writes nothing', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;

      const countOf = async (sql: string): Promise<string> => {
        const { rows } = await pool().query<{ c: string }>(sql);
        return rows[0]?.c ?? '?';
      };
      const snapshot = async () => {
        const { rows: userState } = await pool().query<{ c: string; m: string }>(
          "select count(*)::text c, coalesce(max(updated_at)::text, '-') m from app_user",
        );
        return {
          users: userState[0],
          audits: (await db().select({ id: auditLog.id }).from(auditLog)).length,
          events: (await db().select({ id: outboxEvent.id }).from(outboxEvent)).length,
          sessions: await countOf('select count(*)::text c from refresh_session'),
          resets: await countOf('select count(*)::text c from password_reset_token'),
          keys: await countOf('select count(*)::text c from idempotency_key'),
        };
      };

      const before = await snapshot();
      await detail(target.id);
      await detail(newId());
      expect(await snapshot()).toEqual(before);
    });
  });

  /* ── 7. Existing behaviour is intact ──────────────────────────────────── */

  describe('regression against the existing identity surface', () => {
    it('leaves /users/me self-scoped and unchanged in shape', async () => {
      const res = await api().get('/api/v1/users/me').set(asCustomer());
      expect(res.status).toBe(200);
      expect(res.body.user).toHaveProperty('emailVerified');
      expect(res.body.user).not.toHaveProperty('isActive');
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });

    it('does not let staff read another account through /users/me', async () => {
      const res = await api().get('/api/v1/users/me').set(asStaff());
      expect(res.status).toBe(200);
      // Staff see THEMSELVES, not the store — privilege does not widen the self-scoped route.
      expect(res.body.user.id).toBe(staffUserId);
    });

    it('still authenticates normally', async () => {
      const target = registered[1];
      expect(target).toBeDefined();
      if (!target) return;
      const res = await api()
        .post('/api/v1/auth/login')
        .send({ email: target.email, password: PASSWORD });
      expect(res.status).toBe(200);
    });
  });

  /* ── 8. Phone, order aggregates and search. Increment 56. ─────────────── */

  /**
   * The Customers screen's four missing columns: Mobile, Orders, Total Spent, Last Order Date.
   *
   * The three aggregates come from the ORDERS module through a port, so what is under test here
   * is not just a SQL sum — it is that identity asked the right question about the right
   * customers and put each answer on the right row.
   *
   * Orders are inserted directly rather than placed through checkout: this suite has no
   * catalogue, no stock and no cart, and building all three to assert an aggregate would test
   * checkout instead. The rows are real `order` rows satisfying every constraint, which is what
   * the aggregate reads.
   */
  describe('phone, order aggregates and search', () => {
    /** Customers created for this block alone, so the rest of the suite is unaffected. */
    let noOrders = { id: '', email: '' };
    let oneOrder = { id: '', email: '' };
    let manyOrders = { id: '', email: '' };
    let allCancelled = { id: '', email: '' };

    /**
     * The three counted orders total 5100.0000, INCLUDING 200.0000 of GST on the middle one.
     *
     * The tax is load-bearing: `grandTotal` is tax-inclusive and `total` is not, so an aggregate
     * that summed the wrong column would be short by exactly that 200 — and in an untaxed
     * fixture the two columns are equal and the mistake is invisible.
     */
    const MANY_EXPECTED_TOTAL = '5100.0000';
    let manyNewestPlacedAt = '';

    beforeAll(async () => {
      noOrders = await register('agg.none.admincust', { staff: false });
      oneOrder = await register('agg.one.admincust', { staff: false });
      manyOrders = await register('agg.many.admincust', { staff: false });
      allCancelled = await register('agg.cancelled.admincust', { staff: false });

      await pool().query('update app_user set phone = $2 where id = $1', [
        manyOrders.id,
        '+919876500011',
      ]);
      await pool().query('update app_user set first_name = $2, last_name = $3 where id = $1', [
        manyOrders.id,
        'Meera',
        'Rajagopalan',
      ]);

      await placeOrder({ userId: oneOrder.id, total: '500.0000', taxTotal: '0.0000', daysAgo: 9 });

      /* Newest last, so the assertion below is about `max` rather than about insertion order. */
      await placeOrder({
        userId: manyOrders.id,
        total: '1200.5000',
        taxTotal: '0.0000',
        daysAgo: 30,
      });
      await placeOrder({
        userId: manyOrders.id,
        total: '699.5000',
        taxTotal: '200.0000',
        daysAgo: 20,
      });
      manyNewestPlacedAt = await placeOrder({
        userId: manyOrders.id,
        total: '3000.0000',
        taxTotal: '0.0000',
        daysAgo: 10,
      });

      /* A cancelled order for the SAME customer, newer and larger than every counted one. */
      await placeOrder({
        userId: manyOrders.id,
        total: '99999.0000',
        taxTotal: '0.0000',
        daysAgo: 1,
        cancelled: true,
      });

      await placeOrder({
        userId: allCancelled.id,
        total: '777.0000',
        taxTotal: '0.0000',
        daysAgo: 5,
        cancelled: true,
      });
      await placeOrder({
        userId: allCancelled.id,
        total: '888.0000',
        taxTotal: '0.0000',
        daysAgo: 4,
        cancelled: true,
      });
    }, 180_000);

    /**
     * One real `order` row, with a cart to satisfy `fk_order_cart_store`.
     *
     * `address_id` is null, which the schema models: the delivery address is snapshotted onto
     * the order at checkout, so the `ship_*` columns below are the record and the address row is
     * not required to survive.
     */
    async function placeOrder(params: {
      userId: string;
      /** Goods total, before tax. `subtotal` and `total` both take this value. */
      total: string;
      /** GST on top. `grandTotal` is `total + taxTotal`, which the schema enforces. */
      taxTotal: string;
      daysAgo: number;
      cancelled?: boolean;
    }): Promise<string> {
      const cartId = newId();
      await pool().query(
        `insert into cart (id, user_id, store_id, status) values ($1, $2, $3, 'checked_out')`,
        [cartId, params.userId, storeId],
      );

      const orderId = newId();
      const suffix = orderSeq().toString().padStart(6, '0').replace(/0/gu, 'A');
      const { rows } = await pool().query<{ placed_at: Date }>(
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
           '560001', 'IN', now() - ($9 || ' days')::interval,
           /*
            * The GST determination snapshot: all-or-nothing per ck_order_tax_snapshot, and
            * required at all only when tax_total is non-zero per
            * ck_order_tax_needs_determination. Supplied for every row here so a taxed and an
            * untaxed fixture order differ in exactly one thing: the tax.
            */
           now(), 'intra_state', 'Karnataka', 'delivery_destination',
           '29AAAAA0000A1Z5', 'Test Seller', '1 Origin Road', 'Bengaluru', 'Karnataka',
           '560001', 'IN', 'b2c'
         ) returning placed_at`,
        [
          orderId,
          storeId,
          params.userId,
          cartId,
          `ORD-20260101-${suffix}`,
          params.cancelled === true ? 'cancelled' : 'placed',
          params.total,
          params.taxTotal,
          String(params.daysAgo),
        ],
      );
      return (rows[0]?.placed_at ?? new Date()).toISOString();
    }

    let seq = 0;
    function orderSeq(): number {
      seq += 1;
      return seq;
    }

    const rowFor = async (id: string): Promise<Record<string, unknown>> => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect(res.status).toBe(200);
      const found = (res.body.customers as Record<string, unknown>[]).find((c) => c['id'] === id);
      expect(found, `customer ${id} not on the page`).toBeDefined();
      return found ?? {};
    };

    /* ── phone ──────────────────────────────────────────────────────────── */

    it('publishes the customer’s phone, and null when there is none', async () => {
      expect((await rowFor(manyOrders.id))['phone']).toBe('+919876500011');
      expect((await rowFor(noOrders.id))['phone']).toBeNull();
    });

    /* ── aggregates ─────────────────────────────────────────────────────── */

    it('reports zero and null for a customer who has never ordered', async () => {
      expect(await rowFor(noOrders.id)).toMatchObject({
        orderCount: 0,
        totalSpent: '0.0000',
        lastOrderAt: null,
      });
    });

    /** Zero rather than absent: "never ordered" is a fact, not a missing field. */
    it('publishes the zero keys rather than omitting them', async () => {
      const row = await rowFor(noOrders.id);
      expect(Object.keys(row)).toContain('totalSpent');
      expect(Object.keys(row)).toContain('lastOrderAt');
      expect(Object.keys(row)).toContain('orderCount');
    });

    it('reports one order exactly', async () => {
      const row = await rowFor(oneOrder.id);
      expect(row).toMatchObject({ orderCount: 1, totalSpent: '500.0000' });
      expect(typeof row['lastOrderAt']).toBe('string');
    });

    /**
     * The arithmetic, and the exclusion, in one row.
     *
     * The cancelled order is the NEWEST and by far the LARGEST, so a bug that forgot to exclude
     * it would be visible in all three fields at once rather than in only the sum.
     */
    it('sums, counts and dates only the non-cancelled orders', async () => {
      const row = await rowFor(manyOrders.id);
      expect(row['orderCount']).toBe(3);
      expect(row['totalSpent']).toBe(MANY_EXPECTED_TOTAL);
      expect(row['lastOrderAt']).toBe(manyNewestPlacedAt);
    });

    /** Money stays a decimal string at NUMERIC(19,4) scale — never a JSON number. */
    it('publishes the total as a decimal string, not a number', async () => {
      const row = await rowFor(manyOrders.id);
      expect(typeof row['totalSpent']).toBe('string');
      expect(row['totalSpent']).toMatch(/^\d+\.\d{4}$/u);
    });

    /**
     * Independently derived, not compared against another call into the same repository.
     * Two readings of one SQL expression agreeing proves nothing about either.
     */
    it('agrees with a direct SUM over the order table', async () => {
      const { rows } = await pool().query<{ c: string; s: string | null; m: Date | null }>(
        `select count(*)::text c, sum(grand_total)::text s, max(placed_at) m
           from "order" where store_id = $1 and user_id = $2 and status <> 'cancelled'`,
        [storeId, manyOrders.id],
      );
      const row = await rowFor(manyOrders.id);
      expect(row['orderCount']).toBe(Number(rows[0]?.c ?? '0'));
      expect(row['totalSpent']).toBe(rows[0]?.s);
      expect(row['lastOrderAt']).toBe(rows[0]?.m?.toISOString());
    });

    it('treats a customer whose every order was cancelled as having none', async () => {
      expect(await rowFor(allCancelled.id)).toMatchObject({
        orderCount: 0,
        totalSpent: '0.0000',
        lastOrderAt: null,
      });
    });

    /** Several customers on one page, each with their own answer and nobody else's. */
    it('keys the aggregates to the right customer across a page', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      const byId = new Map(
        (res.body.customers as Record<string, unknown>[]).map((c) => [c['id'], c]),
      );
      expect(byId.get(noOrders.id)).toMatchObject({ orderCount: 0 });
      expect(byId.get(oneOrder.id)).toMatchObject({ orderCount: 1, totalSpent: '500.0000' });
      expect(byId.get(manyOrders.id)).toMatchObject({
        orderCount: 3,
        totalSpent: MANY_EXPECTED_TOTAL,
      });
      expect(byId.get(allCancelled.id)).toMatchObject({ orderCount: 0 });
    });

    /* ── the detail endpoint reports the same numbers ───────────────────── */

    it('publishes identical aggregates on the detail endpoint', async () => {
      const listRow = await rowFor(manyOrders.id);
      const res = await api().get(`/api/v1/admin/customers/${manyOrders.id}`).set(asStaff());
      expect(res.status).toBe(200);
      expect(res.body.customer).toEqual(listRow);
    });

    /* ── search ─────────────────────────────────────────────────────────── */

    const search = (q: string) =>
      api()
        .get(`/api/v1/admin/customers?limit=100&q=${encodeURIComponent(q)}`)
        .set(asStaff());

    const idsFrom = (body: unknown): string[] =>
      (body as { customers: { id: string }[] }).customers.map((c) => c.id);

    it('finds a customer by a fragment of their first name', async () => {
      expect(idsFrom((await search('eera')).body)).toContain(manyOrders.id);
    });

    it('finds a customer by a fragment of their last name', async () => {
      expect(idsFrom((await search('rajagop')).body)).toContain(manyOrders.id);
    });

    it('finds a customer by a fragment of their email', async () => {
      const local = oneOrder.email.split('@')[0] ?? '';
      expect(idsFrom((await search(local)).body)).toEqual([oneOrder.id]);
    });

    it('finds a customer by a fragment of their phone', async () => {
      expect(idsFrom((await search('9876500011')).body)).toContain(manyOrders.id);
    });

    /** Separators are stripped for the phone arm, so a typed number matches a stored one. */
    it('finds a customer by a phone fragment typed with separators', async () => {
      expect(idsFrom((await search('+91 98765 00011')).body)).toContain(manyOrders.id);
    });

    it('is case-insensitive', async () => {
      expect(idsFrom((await search('MEERA')).body)).toContain(manyOrders.id);
    });

    it('answers an unmatched term with an empty page and a zero total', async () => {
      const res = await search('zzz-nobody-matches-this');
      expect(res.status).toBe(200);
      expect(res.body.customers).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    /**
     * An unescaped `%` would match every row, which reads to an operator as "the filter is
     * broken" rather than "nothing matched".
     */
    it('treats a percent sign as a literal, not a wildcard', async () => {
      const res = await search('%');
      expect(res.status).toBe(200);
      expect(res.body.customers).toEqual([]);
    });

    it('treats an underscore as a literal, not a single-character wildcard', async () => {
      const res = await search('_');
      expect(res.status).toBe(200);
      expect(res.body.customers).toEqual([]);
    });

    it('narrows rather than replaces the other filters', async () => {
      await pool().query('update app_user set is_active = false where id = $1', [oneOrder.id]);
      const local = oneOrder.email.split('@')[0] ?? '';

      const active = await api()
        .get(`/api/v1/admin/customers?q=${encodeURIComponent(local)}&isActive=true`)
        .set(asStaff());
      expect(idsFrom(active.body)).toEqual([]);

      const inactive = await api()
        .get(`/api/v1/admin/customers?q=${encodeURIComponent(local)}&isActive=false`)
        .set(asStaff());
      expect(idsFrom(inactive.body)).toEqual([oneOrder.id]);

      await pool().query('update app_user set is_active = true where id = $1', [oneOrder.id]);
    });

    it('rejects an empty or over-long search term', async () => {
      expect((await api().get('/api/v1/admin/customers?q=').set(asStaff())).status).toBe(400);
      expect(
        (
          await api()
            .get(`/api/v1/admin/customers?q=${'x'.repeat(321)}`)
            .set(asStaff())
        ).status,
      ).toBe(400);
    });

    it('never matches a soft-deleted customer', async () => {
      const target = await register('erased.search.admincust', { staff: false });
      await pool().query('update app_user set first_name = $2 where id = $1', [
        target.id,
        'Zephyrine',
      ]);
      expect(idsFrom((await search('Zephyrine')).body)).toEqual([target.id]);

      await pool().query('update app_user set deleted_at = now() where id = $1', [target.id]);
      const after = await search('Zephyrine');
      expect(idsFrom(after.body)).toEqual([]);
      expect(after.body.pagination.total).toBe(0);
    });

    /* ── status counts ──────────────────────────────────────────────────── */

    it('publishes counts that agree with a direct count of the store', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=1').set(asStaff());
      expect(res.status).toBe(200);

      const { rows } = await pool().query<{ active: string; inactive: string }>(
        `select
           count(*) filter (where is_active)::text as active,
           count(*) filter (where not is_active)::text as inactive
           from app_user where store_id = $1 and deleted_at is null`,
        [storeId],
      );

      expect(res.body.counts.active).toBe(Number(rows[0]?.active ?? '0'));
      expect(res.body.counts.inactive).toBe(Number(rows[0]?.inactive ?? '0'));
      expect(res.body.counts.total).toBe(res.body.counts.active + res.body.counts.inactive);
    });

    /**
     * The tabs must not move as the operator types, or the count could never say how many rows
     * switching to that tab would show. So `counts` is the store and `pagination.total` is the
     * query, and the two differing under a filter is correct.
     */
    it('does not narrow the counts with the request’s own filters', async () => {
      const unfiltered = await api().get('/api/v1/admin/customers?limit=1').set(asStaff());
      const filtered = await search('zzz-nobody-matches-this');

      expect(filtered.body.counts).toEqual(unfiltered.body.counts);
      expect(filtered.body.pagination.total).toBe(0);
      expect(unfiltered.body.counts.total).toBeGreaterThan(0);
    });

    it('excludes soft-deleted accounts from the counts', async () => {
      const before = (await api().get('/api/v1/admin/customers?limit=1').set(asStaff())).body
        .counts;

      const target = await register('erased.counts.admincust', { staff: false });
      const during = (await api().get('/api/v1/admin/customers?limit=1').set(asStaff())).body
        .counts;
      expect(during.total).toBe(before.total + 1);

      await pool().query('update app_user set deleted_at = now() where id = $1', [target.id]);
      const after = (await api().get('/api/v1/admin/customers?limit=1').set(asStaff())).body.counts;
      expect(after.total).toBe(before.total);
    });
  });

  /* ── 9. Tenancy of the aggregates and the search. ─────────────────────── */

  /**
   * A foreign store with its own customer AND its own orders.
   *
   * The aggregate is the new tenancy risk: it is keyed by `user_id`, so a query that forgot its
   * store predicate would still return the right SHAPE — one row per customer — while silently
   * totalling another merchant's orders. Asserting against an absence could not catch that; this
   * builds a foreign customer whose id is passed to the port alongside ours.
   */
  describe('tenant isolation of aggregates and search', () => {
    let foreignStoreId = '';
    let foreignUserId = '';
    let localTwinId = '';

    beforeAll(async () => {
      foreignStoreId = newId();
      foreignUserId = newId();

      await pool().query(
        `insert into store (id, slug, name, currency, timezone, is_active)
         values ($1, $2, 'Aggregate Other Store', 'INR', 'Asia/Kolkata', true)`,
        [foreignStoreId, `agg-other-${foreignStoreId.slice(0, 8)}`],
      );
      await pool().query(
        `insert into app_user (id, store_id, email, password_hash, first_name, last_name, phone)
         values ($1, $2, $3, 'argon2-placeholder', 'Zarina', 'Foreignsson', '+915550001111')`,
        [foreignUserId, foreignStoreId, `foreign.agg.${foreignUserId}@example.com`],
      );

      const cartId = newId();
      await pool().query(
        `insert into cart (id, user_id, store_id, status) values ($1, $2, $3, 'checked_out')`,
        [cartId, foreignUserId, foreignStoreId],
      );
      await pool().query(
        `insert into "order" (
           id, store_id, user_id, cart_id, order_number, status, currency,
           subtotal, discount_total, total, tax_total, grand_total,
           ship_recipient_name, ship_phone, ship_line1, ship_city, ship_state,
           ship_postal_code, ship_country_code, placed_at
         ) values (
           $1, $2, $3, $4, 'ORD-20260101-ZZZZZZ', 'placed', 'INR',
           50000, 0, 50000, 0, 50000,
           'Foreign Recipient', '+915550001111', '9 Other Street', 'Chennai', 'Tamil Nadu',
           '600001', 'IN', now()
         )`,
        [newId(), foreignStoreId, foreignUserId, cartId],
      );

      const twin = await register('twin.agg.admincust', { staff: false });
      localTwinId = twin.id;
    }, 180_000);

    it('has actually created a foreign customer with an order — otherwise this proves nothing', async () => {
      const { rows } = await pool().query<{ c: string }>(
        `select count(*)::text c from "order" o
           join app_user u on u.id = o.user_id
          where o.store_id <> $1 and u.store_id <> $1`,
        [storeId],
      );
      expect(Number(rows[0]?.c ?? '0')).toBe(1);
    });

    it('never returns the foreign customer, by list or by search', async () => {
      const page = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
      expect((page.body.customers as { id: string }[]).map((c) => c.id)).not.toContain(
        foreignUserId,
      );

      const byName = await api().get('/api/v1/admin/customers?q=Zarina').set(asStaff());
      expect(byName.body.customers).toEqual([]);

      const byPhone = await api().get('/api/v1/admin/customers?q=5550001111').set(asStaff());
      expect(byPhone.body.customers).toEqual([]);
    });

    it('does not count the foreign store’s customers in the status counts', async () => {
      const res = await api().get('/api/v1/admin/customers?limit=1').set(asStaff());
      const { rows } = await pool().query<{ c: string }>(
        'select count(*)::text c from app_user where store_id = $1 and deleted_at is null',
        [storeId],
      );
      expect(res.body.counts.total).toBe(Number(rows[0]?.c ?? '0'));
    });

    /**
     * The aggregate's own tenancy, asserted where it lives.
     *
     * Through the list the port is only ever handed ids the customer query already filtered, so
     * a missing store predicate there would change no visible answer — which is exactly what
     * makes it easy to lose. This calls the port's implementation directly with a foreign id.
     */
    it('reports nothing for a foreign customer id handed to the aggregate directly', async () => {
      const foreign = await container.orders.orderStatsForCustomers({
        storeId,
        customerIds: [foreignUserId],
      });
      expect(foreign).toEqual([]);

      const mixed = await container.orders.orderStatsForCustomers({
        storeId,
        customerIds: [foreignUserId, localTwinId],
      });
      expect(mixed.map((row) => row.userId)).not.toContain(foreignUserId);
    });
  });

  /* ── 10. No N+1. ──────────────────────────────────────────────────────── */

  /**
   * The aggregate must cost ONE statement for the whole page, not one per customer.
   *
   * Counted from the driver rather than inferred from a plan: `pg_stat_statements` is not in the
   * stock `postgres:16` image, but the pool emits every query it issues, so wrapping it for the
   * duration of one request counts exactly what the request ran.
   */
  describe('no N+1', () => {
    it('issues one aggregate statement for a page of many customers', async () => {
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
        const res = await api().get('/api/v1/admin/customers?limit=100').set(asStaff());
        expect(res.status).toBe(200);
        expect((res.body.customers as unknown[]).length).toBeGreaterThan(5);
      } finally {
        (container.db.pool as { query: unknown }).query = realQuery;
      }

      const aggregates = seen.filter((text) => /group by/iu.test(text) && /"order"/u.test(text));
      expect(aggregates).toHaveLength(1);

      /* And no per-customer order read of any kind. */
      const orderReads = seen.filter((text) => /from "order"/iu.test(text));
      expect(orderReads).toHaveLength(1);
    });
  });
});
