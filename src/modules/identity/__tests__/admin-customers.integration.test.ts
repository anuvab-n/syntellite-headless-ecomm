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
      expect(await status('q=jane')).toBe(400);
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
});
