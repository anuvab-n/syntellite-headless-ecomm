import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createIdempotencyStore } from '../../db/idempotency/idempotency.repository.js';
import { idempotencyKey } from '../../db/schema/idempotency.js';
import { appUser } from '../../db/schema/identity.js';
import { store } from '../../db/schema/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';
import { newId } from '../../shared/id.js';
import { createApp } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { resolveStore } from '../middleware/store.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../modules/stores/index.js';

/**
 * HTTP idempotency — against real PostgreSQL.
 *
 * The claim is arbitrated by a unique index, so this cannot be tested against a fake: the
 * property under test is that two concurrent INSERTs resolve to exactly one winner, which is
 * a database behaviour. A double would only assert that we call the functions we wrote.
 *
 * The routes below are test-only on purpose: they exercise the middleware in isolation, with
 * handlers whose execution is countable so a replay is distinguishable from a re-execution.
 * `POST /users/me/checkout` is the real consumer, and `orders.integration.test.ts` proves the
 * same properties end to end through genuine token authentication.
 *
 * ## Why these routes fake `req.user`
 *
 * Increment 30 scoped the key to (store, USER, key, endpoint), so the middleware reads the
 * authenticated user. A tiny stand-in assigns `req.user` here rather than dragging token
 * minting into a middleware suite — the point under test is the CLAIM, not authentication. That
 * the real chain works with real tokens is asserted in the orders suite, and that mounting this
 * middleware WITHOUT auth fails loudly is asserted below.
 */
describe('idempotency middleware (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const KEY = 'idem-key-0000000001';
  const BODY = { cartId: 'cart-1', note: 'first' };

  /** Two customers in ONE store — the collision case the user scope exists to prevent. */
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
    storeId = (await seedTestStore(testDb)).id;

    // Real rows, because `fk_idempotency_user_store` is a real constraint.
    userId = newId();
    otherUserId = newId();
    await db()
      .insert(appUser)
      .values([
        { id: userId, storeId, email: 'ada@example.com', passwordHash: 'x' },
        { id: otherUserId, storeId, email: 'grace@example.com', passwordHash: 'x' },
      ]);
  });

  const db = () => testDb.handle.db;

  /**
   * An app with three test-only routes:
   *
   *  - `/create`   succeeds with 201 and a counted body, so a replay is distinguishable from
   *                a re-execution: the counter only advances when the handler actually runs.
   *  - `/failing`  throws, to prove a failed request releases its key.
   *  - `/rejects`  answers 4xx, same reason.
   *  - `/no-body`  answers 204, to prove a bodiless response still releases.
   */
  function build(options: { slow?: boolean; actingAs?: () => string; noAuth?: boolean } = {}) {
    const store = createIdempotencyStore({ db: db(), logger: silentLogger });
    let executions = 0;

    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: createStoreRepository({ db: db() }),
          slug: testDb.config.defaultStoreSlug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );

    /**
     * Stands in for `requireAuth`, and mounted BEFORE the idempotency guard because the key
     * scope needs the user. `options.noAuth` omits it, to prove a mis-mounted route fails.
     */
    if (options.noAuth !== true) {
      apiRouter.use((req, _res, next) => {
        req.user = {
          id: options.actingAs === undefined ? userId : options.actingAs(),
          storeId,
          sessionId: newId(),
        };
        next();
      });
    }

    const idempotent = requireIdempotency({ store, logger: silentLogger });

    apiRouter.post(
      '/create',
      idempotent,
      asyncHandler(async (_req, res) => {
        executions += 1;
        // A deliberate delay when asked, so two concurrent requests genuinely overlap
        // rather than serialising by accident.
        if (options.slow === true) await new Promise((resolve) => setTimeout(resolve, 300));
        res.status(201).json({ orderId: `order-${String(executions)}`, executions });
      }),
    );

    apiRouter.post(
      '/failing',
      idempotent,
      asyncHandler(async () => {
        executions += 1;
        throw new Error('handler blew up');
      }),
    );

    apiRouter.post(
      '/rejects',
      idempotent,
      asyncHandler(async (_req, res) => {
        executions += 1;
        res.status(422).json({ error: { code: 'BUSINESS_RULE_VIOLATION' } });
      }),
    );

    apiRouter.post(
      '/no-body',
      idempotent,
      asyncHandler(async (_req, res) => {
        executions += 1;
        res.status(204).send();
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      store,
      executionCount: () => executions,
    };
  }

  type Built = ReturnType<typeof build>;

  const post = (built: Built, path: string, key?: string, body: object = BODY) => {
    const req = request(built.app).post(`/api/v1${path}`);
    return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
  };

  /** Store-call parameters. Declared here because two describe blocks below use it. */
  const params = (
    overrides: Partial<{ key: string; requestHash: string; userId: string }> = {},
  ) => ({
    storeId,
    userId: overrides.userId ?? userId,
    key: overrides.key ?? KEY,
    endpoint: 'POST /api/v1/checkout',
    requestHash: overrides.requestHash ?? 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  });

  const rows = async () => db().select().from(idempotencyKey);
  const rowFor = async (key: string) => {
    const [row] = await db().select().from(idempotencyKey).where(eq(idempotencyKey.key, key));
    return row;
  };

  /* ── The header is mandatory ───────────────────────────────────────────── */

  describe('key requirement', () => {
    it('rejects a request with no Idempotency-Key', async () => {
      const built = build();

      const response = await post(built, '/create');

      /**
       * Required rather than optional. An endpoint mounted with this middleware is one where
       * a duplicate is harmful, so an opt-in guard would be opted out of by exactly the
       * client most likely to retry badly.
       */
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).toContain('idempotency-key');
      expect(built.executionCount()).toBe(0);
      expect(await rows()).toEqual([]);
    });

    it('rejects a blank or too-short key', async () => {
      const built = build();

      for (const key of ['   ', 'short']) {
        const response = await post(built, '/create', key);
        expect(response.status, key).toBe(400);
      }

      expect(built.executionCount()).toBe(0);
      expect(await rows()).toEqual([]);
    });
  });

  /* ── First call, then replay ───────────────────────────────────────────── */

  describe('replay', () => {
    it('executes once and replays the stored response on retry', async () => {
      const built = build();

      const first = await post(built, '/create', KEY);
      expect(first.status).toBe(201);
      expect(first.body.orderId).toBe('order-1');
      expect(built.executionCount()).toBe(1);

      const second = await post(built, '/create', KEY);

      /**
       * The assertion that matters: the handler did NOT run again, and the client got the
       * first answer. If the middleware were absent, `executions` would be 2 and `orderId`
       * would be `order-2` — a second order.
       */
      expect(built.executionCount()).toBe(1);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replay']).toBe('true');
    });

    it('replays the original STATUS, not a generic 200', async () => {
      const built = build();

      await post(built, '/create', KEY);
      const replay = await post(built, '/create', KEY);

      // A replayed 201 returned as 200 would tell a client its retry had merely fetched
      // something rather than created it.
      expect(replay.status).toBe(201);
    });

    it('marks the row completed with the response it completed with', async () => {
      const built = build();

      await post(built, '/create', KEY);

      const row = await rowFor(KEY);
      expect(row?.status).toBe('completed');
      expect(row?.responseStatus).toBe(201);
      expect(row?.responseBody).toEqual({ orderId: 'order-1', executions: 1 });
      expect(row?.completedAt).not.toBeNull();
      expect(row?.storeId).toBe(storeId);
      expect(row?.endpoint).toContain('/create');
    });

    it('does not replay across different keys', async () => {
      const built = build();

      const first = await post(built, '/create', KEY);
      const other = await post(built, '/create', 'idem-key-0000000002');

      // Two distinct operations, two executions. The guard must not over-match.
      expect(built.executionCount()).toBe(2);
      expect(first.body.orderId).toBe('order-1');
      expect(other.body.orderId).toBe('order-2');
    });

    it('does not replay the same key across different endpoints', async () => {
      const built = build();

      await post(built, '/create', KEY);
      const elsewhere = await post(built, '/no-body', KEY);

      /**
       * The key is scoped by endpoint, so a client reusing one key on two operations gets
       * each executed rather than being handed a checkout response for a refund request.
       */
      expect(elsewhere.status).toBe(204);
      expect(built.executionCount()).toBe(2);
      // Two keys, one per (key, endpoint) pair. Both completed.
      expect(await rows()).toHaveLength(2);
    });
  });

  /* ── Cross-user isolation ──────────────────────────────────────────────── */

  describe('cross-user isolation', () => {
    /**
     * **The hole Increment 30 closed.**
     *
     * With the identity scoped to `(store_id, key, endpoint)` alone, two customers in one store
     * using the same header value collided. Different payloads gave the second a spurious 422;
     * IDENTICAL payloads served the second customer **the first one's stored response**. On
     * checkout that is another customer's order number, totals and delivery address.
     */
    it('does NOT collide when two users send the same key and the same body', async () => {
      let acting = userId;
      const built = build({ actingAs: () => acting });

      const first = await post(built, '/create', KEY, BODY);
      acting = otherUserId;
      const second = await post(built, '/create', KEY, BODY);

      // BOTH executed. Before the fix the second was a replay of the first.
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(built.executionCount()).toBe(2);

      // Two independent keys, one per user.
      const stored = await rows();
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((r) => r.userId))).toEqual(new Set([userId, otherUserId]));
    });

    it('does NOT hand one user the other user’s response body', async () => {
      let acting = userId;
      const built = build({ actingAs: () => acting });

      const first = await post(built, '/create', KEY, BODY);
      acting = otherUserId;
      const second = await post(built, '/create', KEY, BODY);

      /**
       * The counted handler makes a replay distinguishable from a fresh execution: a replay
       * would return the FIRST body verbatim, so identical `orderId` values would be the leak.
       */
      expect(first.body.orderId).toBe('order-1');
      expect(second.body.orderId).toBe('order-2');
      expect(second.headers['idempotent-replay']).toBeUndefined();
    });

    it('does NOT give one user a 422 because another used the key with a different body', async () => {
      let acting = userId;
      const built = build({ actingAs: () => acting });

      await post(built, '/create', KEY, { cartId: 'cart-1' });
      acting = otherUserId;
      const second = await post(built, '/create', KEY, { cartId: 'cart-2' });

      // Previously a mismatch, and a weak oracle that someone else held the key.
      expect(second.status).toBe(201);
    });

    it('still replays for the SAME user', async () => {
      const built = build();

      const first = await post(built, '/create', KEY);
      const retry = await post(built, '/create', KEY);

      // The scoping must not weaken the guarantee it was added to protect.
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(built.executionCount()).toBe(1);
    });

    it('arbitrates per user at the STORE level too', async () => {
      const built = build();

      // Same key, same endpoint, different users: both claim.
      expect(await built.store.claim(params())).toEqual({ outcome: 'claimed' });
      expect(await built.store.claim(params({ userId: otherUserId }))).toEqual({
        outcome: 'claimed',
      });
      // And the same user is still refused a second claim.
      expect(await built.store.claim(params())).toEqual({ outcome: 'in_flight' });

      expect(await rows()).toHaveLength(2);
    });

    it('completing one user’s key leaves the other’s in flight', async () => {
      const built = build();
      await built.store.claim(params());
      await built.store.claim(params({ userId: otherUserId }));

      await built.store.complete({ ...params(), status: 201, body: { mine: true } });

      // Scoped writes, not just scoped reads: `complete` and `release` must not cross users.
      expect(await built.store.claim(params())).toEqual({
        outcome: 'replay',
        status: 201,
        body: { mine: true },
      });
      expect(await built.store.claim(params({ userId: otherUserId }))).toEqual({
        outcome: 'in_flight',
      });
    });

    it('releasing one user’s key leaves the other’s claimed', async () => {
      const built = build();
      await built.store.claim(params());
      await built.store.claim(params({ userId: otherUserId }));

      await built.store.release(params());

      expect(await built.store.claim(params())).toEqual({ outcome: 'claimed' });
      expect(await built.store.claim(params({ userId: otherUserId }))).toEqual({
        outcome: 'in_flight',
      });
    });

    it('fails loudly when mounted without authentication', async () => {
      const built = build({ noAuth: true });

      const response = await post(built, '/create', KEY);

      /**
       * A wiring bug, not a client error: `requireUser` raises an `InvariantViolation`, which
       * the terminal handler reports as a 500. Silently claiming an unscoped key instead would
       * reintroduce the exact hole this scoping closed.
       */
      expect(response.status).toBe(500);
      expect(built.executionCount()).toBe(0);
      expect(await rows()).toEqual([]);
    });
  });

  /* ── Same key, different payload ───────────────────────────────────────── */

  describe('key reuse with a different body', () => {
    it('is a 422 and does NOT execute or replay', async () => {
      const built = build();

      await post(built, '/create', KEY, BODY);
      const reused = await post(built, '/create', KEY, { cartId: 'cart-2', note: 'different' });

      /**
       * The one case that must never be served a replay: returning the first request's answer
       * for a genuinely different request would tell the client the second one succeeded.
       */
      expect(reused.status).toBe(422);
      expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
      expect(built.executionCount()).toBe(1);
    });

    it('treats a body differing only in key ORDER as the same request', async () => {
      const built = build();

      await post(built, '/create', KEY, { cartId: 'cart-1', note: 'first' });
      const reordered = await post(built, '/create', KEY, { note: 'first', cartId: 'cart-1' });

      // JSON object key order is not semantic, so hashing must not treat it as such — or
      // every client using a different serialiser would get spurious 422s.
      expect(reordered.status).toBe(201);
      expect(built.executionCount()).toBe(1);
      expect(reordered.headers['idempotent-replay']).toBe('true');
    });

    it('stores a hash, never the request body', async () => {
      const built = build();

      await post(built, '/create', KEY, { cartId: 'cart-1', note: 'secret-note' });

      const row = await rowFor(KEY);
      // A checkout body carries addresses and a cart. The table's job is bookkeeping, not
      // becoming a second copy of customer PII.
      expect(row?.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row?.requestHash)).not.toContain('secret-note');
      expect(JSON.stringify(row?.requestHash)).not.toContain('cart-1');
    });
  });

  /* ── Concurrency: the property only a database can arbitrate ───────────── */

  describe('concurrency', () => {
    it('lets exactly one of two simultaneous requests execute', async () => {
      const built = build({ slow: true });

      /**
       * Driven with a deliberately slow handler so the two genuinely overlap — the first is
       * still inside its handler when the second claims. Without the slow path they could
       * serialise by accident and the test would pass against a broken guard.
       */
      const [a, b] = await Promise.all([post(built, '/create', KEY), post(built, '/create', KEY)]);

      // Executed once, whichever won.
      expect(built.executionCount()).toBe(1);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      /**
       * 201 plus 409. The loser is told the work is IN FLIGHT rather than being handed a
       * guess: there is no answer yet, and inventing one would be a claim about work that has
       * not finished.
       */
      expect(statuses).toEqual([201, 409]);

      const conflicted = [a, b].find((r) => r.status === 409);
      expect(conflicted?.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('replays cleanly once the in-flight request has finished', async () => {
      const built = build({ slow: true });

      const [a, b] = await Promise.all([post(built, '/create', KEY), post(built, '/create', KEY)]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);

      // The client that got the 409 retries, as the message tells it to.
      const retry = await post(built, '/create', KEY);

      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(built.executionCount()).toBe(1);
    });
  });

  /* ── Failure releases the claim ────────────────────────────────────────── */

  describe('release on failure', () => {
    it('releases the key when the handler throws, so a retry can run', async () => {
      const built = build();

      const failed = await post(built, '/failing', KEY);
      expect(failed.status).toBe(500);

      /**
       * Nothing committed, so the client must be free to retry with the same key. Storing a
       * 500 as the completed answer would make a transient failure permanent for that key —
       * the client would retry correctly and be handed the error forever.
       */
      expect(await rows()).toEqual([]);

      const retry = await post(built, '/failing', KEY);
      expect(retry.status).toBe(500);
      expect(built.executionCount()).toBe(2);
    });

    it('releases the key on a 4xx', async () => {
      const built = build();

      expect((await post(built, '/rejects', KEY)).status).toBe(422);
      expect(await rows()).toEqual([]);

      expect((await post(built, '/rejects', KEY)).status).toBe(422);
      expect(built.executionCount()).toBe(2);
    });

    it('COMPLETES a bodiless 204 rather than releasing it', async () => {
      const built = build();

      expect((await post(built, '/no-body', KEY)).status).toBe(204);

      /**
       * A 204 succeeded, so a retry must not re-run it — releasing would let it. The row is
       * completed with a status and NO body, which is why the CHECK constraint ties
       * completion to `response_status` alone.
       *
       * This case is the reason that constraint is shaped the way it is: an earlier version
       * also required a non-null body, so a 204 could neither complete (rejected) nor be
       * safely released (it had succeeded), and the key stayed pinned until expiry.
       */
      const row = await rowFor(KEY);
      expect(row?.status).toBe('completed');
      expect(row?.responseStatus).toBe(204);
      expect(row?.responseBody).toBeNull();

      const retry = await post(built, '/no-body', KEY);
      expect(retry.status).toBe(204);
      expect(retry.headers['idempotent-replay']).toBe('true');
      expect(built.executionCount()).toBe(1);
    });
  });

  /* ── The store contract, exercised directly ────────────────────────────── */

  describe('store', () => {
    it('claims once, then reports in_flight', async () => {
      const { store } = build();

      expect(await store.claim(params())).toEqual({ outcome: 'claimed' });
      expect(await store.claim(params())).toEqual({ outcome: 'in_flight' });
    });

    it('resolves concurrent claims to exactly one winner', async () => {
      const { store } = build();

      // Eight racing INSERTs on one unique index. Exactly one may win; a read-then-insert
      // would let several through.
      const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(params())));

      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'in_flight')).toHaveLength(7);
    });

    it('reports mismatch before in_flight for a different payload', async () => {
      const { store } = build();
      await store.claim(params());

      /**
       * Payload checked FIRST. A mismatched body is a client bug whatever the original
       * request is doing, and reporting `in_flight` would invite the client to keep retrying
       * a request that can never be served.
       */
      expect(await store.claim(params({ requestHash: 'b'.repeat(64) }))).toEqual({
        outcome: 'mismatch',
      });
    });

    it('completes once and ignores a second completion', async () => {
      const { store } = build();
      await store.claim(params());

      await store.complete({ ...params(), status: 201, body: { first: true } });
      await store.complete({ ...params(), status: 500, body: { second: true } });

      // A retry must always see the FIRST answer; the second completion must not overwrite it.
      const claim = await store.claim(params());
      expect(claim).toEqual({ outcome: 'replay', status: 201, body: { first: true } });
    });

    it('release removes an in-progress claim but never a completed one', async () => {
      const { store } = build();

      await store.claim(params());
      await store.release(params());
      // Released is indistinguishable from never seen, so the next attempt claims cleanly.
      expect(await store.claim(params())).toEqual({ outcome: 'claimed' });

      await store.complete({ ...params(), status: 201, body: { ok: true } });
      await store.release(params());

      /**
       * The dangerous case: releasing a COMPLETED key would let a retry re-execute an
       * operation that already succeeded — precisely the failure this mechanism prevents.
       */
      expect(await store.claim(params())).toEqual({
        outcome: 'replay',
        status: 201,
        body: { ok: true },
      });
    });

    it('never replays one store’s response to another', async () => {
      const { store: keys } = build();

      /**
       * The cross-tenant assertion, and the strong form of it.
       *
       * A weaker version — claim in store A, claim in store B, expect `claimed` — passes
       * even if the completed response is shared, because the claim path returns before
       * reading anything. What must be true is that store B gets to EXECUTE: it must not be
       * handed store A's stored answer for a key that happens to collide.
       */
      await keys.claim(params());
      await keys.complete({ ...params(), status: 201, body: { orderId: 'store-a-order' } });

      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'second', name: 'Second', isActive: true });
      /**
       * A user in THAT store, because `fk_idempotency_user_store` requires the key's user to
       * belong to its store. Reusing this store's user id is refused by the database — which is
       * itself the tenancy guarantee, so the fixture proves it rather than working around it.
       */
      const foreignUserId = newId();
      await db().insert(appUser).values({
        id: foreignUserId,
        storeId: otherStoreId,
        email: 'ada@example.com',
        passwordHash: 'x',
      });

      const foreign = await keys.claim({
        ...params(),
        storeId: otherStoreId,
        userId: foreignUserId,
      });

      expect(foreign).toEqual({ outcome: 'claimed' });
      // Explicitly not a replay, and specifically not store A's order.
      expect(JSON.stringify(foreign)).not.toContain('store-a-order');

      // And store A's own key is untouched by the other tenant's claim.
      expect(await keys.claim(params())).toEqual({
        outcome: 'replay',
        status: 201,
        body: { orderId: 'store-a-order' },
      });
    });

    it('purges only expired rows, up to the limit', async () => {
      const { store } = build();

      await store.claim({ ...params({ key: 'expired-key-000001' }), expiresAt: new Date(1) });
      await store.claim({ ...params({ key: 'expired-key-000002' }), expiresAt: new Date(1) });
      await store.claim(params({ key: 'live-key-00000001' }));

      const purged = await store.purgeExpired({ now: new Date(), limit: 10 });

      expect(purged).toBe(2);
      const remaining = await rows();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.key).toBe('live-key-00000001');
    });

    it('honours the purge limit', async () => {
      const { store } = build();
      for (const n of [1, 2, 3]) {
        await store.claim({
          ...params({ key: `expired-key-00000${String(n)}` }),
          expiresAt: new Date(1),
        });
      }

      // Bounded so a neglected table cannot produce one enormous DELETE holding locks for
      // minutes. The scheduler simply runs again next tick.
      expect(await store.purgeExpired({ now: new Date(), limit: 2 })).toBe(2);
      expect(await rows()).toHaveLength(1);
    });
  });

  /**
   * Assert a write was refused by a NAMED constraint.
   *
   * Drizzle wraps the driver error, so the constraint name lives on `cause` rather than in the
   * top-level message. Matching the name matters: `rejects.toThrow()` alone would also pass if
   * the statement failed for an entirely unrelated reason, which is how a test that proves
   * nothing looks green.
   */
  async function expectConstraint(work: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }

    expect(caught, 'expected the write to be refused').toBeDefined();
    const chain = [caught, (caught as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join(' | ');
    expect(chain).toContain(constraint);
  }

  /* ── The database is the last line of defence ──────────────────────────── */

  describe('database constraints', () => {
    it('refuses a completed row with no response', async () => {
      const { store } = build();
      await store.claim(params());

      /**
       * The replay path reads `response_status` and `response_body`, so a half-written
       * completed row would have to be defended against at every call site. The API is not
       * the only writer — an operator clearing a stuck key during an incident is exactly when
       * this matters.
       */
      await expectConstraint(
        db().update(idempotencyKey).set({ status: 'completed' }).where(eq(idempotencyKey.key, KEY)),
        'ck_idempotency_completed_has_response',
      );
    });

    it('refuses an unknown status', async () => {
      const { store } = build();
      await store.claim(params());

      await expectConstraint(
        db().update(idempotencyKey).set({ status: 'whatever' }).where(eq(idempotencyKey.key, KEY)),
        'ck_idempotency_status',
      );
    });
  });
});
