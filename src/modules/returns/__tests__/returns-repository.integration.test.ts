import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cart } from '../../../db/schema/cart.js';
import { appUser } from '../../../db/schema/identity.js';
import { order } from '../../../db/schema/orders.js';
import { returnEvent, returnRequest } from '../../../db/schema/returns.js';
import { store } from '../../../db/schema/store.js';
import { withTransaction } from '../../../db/transaction.js';
import { newId } from '../../../shared/id.js';
import { createReturnsRepository, RETURN_STATUSES } from '../returns.repository.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';

/**
 * The two returns guards that the HTTP suites cannot reach.
 *
 * Both were found by mutation probes that survived the whole returns test suite, and both are
 * defence in depth rather than currently-exploitable holes — which is exactly why they need a
 * test. An unguarded guard is one a refactor deletes with nothing going red.
 *
 *  - **The store predicate on the staff lock.** Unreachable over HTTP because the store comes
 *    from the verified token, so a request cannot name another tenant. Reachable here, where
 *    two stores can be built directly.
 *  - **The compare-and-set on the status transition.** Unreachable over HTTP because the row
 *    lock serialises callers: the second request re-reads the row, sees the new status, and is
 *    refused by the transition table before the CAS is ever consulted. The CAS is the net
 *    beneath the lock, and this is the only place it can be dropped onto.
 */
describe('returns repository — guards the HTTP suites cannot reach (integration)', () => {
  let testDb: TestDatabase;

  let storeA = '';
  let storeB = '';
  let returnNumber = '';
  let returnIdA = '';

  beforeAll(async () => {
    testDb = await startTestDatabase();
    storeA = (await seedTestStore(testDb)).id;

    /*
     * A SECOND tenant, inserted directly: `seedTestStore` deletes existing stores to re-seed
     * the configured default, so it cannot be used twice.
     */
    storeB = newId();
    await testDb.handle.db.insert(store).values({
      id: storeB,
      slug: 'other-tenant',
      name: 'Other Tenant',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });

    const userId = newId();
    await testDb.handle.db.insert(appUser).values({
      id: userId,
      storeId: storeA,
      email: `repo.${userId}@example.com`,
      passwordHash: 'x',
      firstName: 'Ada',
      lastName: 'A',
    });

    const cartId = newId();
    await testDb.handle.db
      .insert(cart)
      .values({ id: cartId, storeId: storeA, userId, status: 'checked_out' });

    const orderId = newId();
    await testDb.handle.db.insert(order).values({
      id: orderId,
      storeId: storeA,
      userId,
      cartId,
      orderNumber: 'ORD-20260101-REPOAA',
      currency: 'INR',
      subtotal: '100.0000',
      discountTotal: '0.0000',
      total: '100.0000',
      taxTotal: '0.0000',
      grandTotal: '100.0000',
      shipRecipientName: 'Ada A',
      shipPhone: '+919876543210',
      shipLine1: '1 Road',
      shipCity: 'Bengaluru',
      shipState: 'Karnataka',
      shipPostalCode: '560001',
      shipCountryCode: 'IN',
    });

    returnIdA = newId();
    returnNumber = 'RET-20260101-REPOAA';
    await testDb.handle.db.insert(returnRequest).values({
      id: returnIdA,
      storeId: storeA,
      orderId,
      userId,
      returnNumber,
      status: 'requested',
      reason: 'defective',
      currency: 'INR',
      refundTaxableValue: '100.0000',
      refundTaxTotal: '0.0000',
      refundTotal: '100.0000',
      deliveredAt: new Date(),
    });

    /*
     * One lifecycle row, inserted directly because this fixture never goes through the service.
     * Without it the tenant predicate on `listReturnEvents` is untestable: an empty table
     * answers `[]` for every store, so a dropped predicate would look identical to a correct
     * one. A surviving mutation probe is what showed that.
     */
    await testDb.handle.db.insert(returnEvent).values({
      id: newId(),
      returnId: returnIdA,
      storeId: storeA,
      fromStatus: null,
      toStatus: 'requested',
      actorType: 'customer',
      actorUserId: userId,
      note: '',
    });
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  const repository = () => createReturnsRepository({ db: testDb.handle.db });

  /* ══ The store predicate on the staff reads ════════════════════════════ */

  describe('store scoping', () => {
    it('finds the return for its own store', async () => {
      const found = await repository().findStoreReturnByNumber({ returnNumber, storeId: storeA });
      expect(found?.returnNumber).toBe(returnNumber);
    });

    it('does NOT find the return for a different tenant', async () => {
      const found = await repository().findStoreReturnByNumber({ returnNumber, storeId: storeB });
      expect(found).toBeUndefined();
    });

    it('locks the return for its own store', async () => {
      const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().lockStoreReturnByNumber({ returnNumber, storeId: storeA }),
      );
      expect(locked?.returnNumber).toBe(returnNumber);
    });

    it('does NOT lock the return for a different tenant', async () => {
      // The killer for the surviving mutation: same number, wrong store.
      const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().lockStoreReturnByNumber({ returnNumber, storeId: storeB }),
      );
      expect(locked).toBeUndefined();
    });

    it('keeps the staff queue inside one tenant', async () => {
      const own = await repository().listStoreReturns({ storeId: storeA, limit: 20, offset: 0 });
      const foreign = await repository().listStoreReturns({
        storeId: storeB,
        limit: 20,
        offset: 0,
      });

      expect(own.total).toBeGreaterThan(0);
      expect(foreign.total).toBe(0);
      expect(foreign.items).toEqual([]);
    });
  });

  /* ══ The compare-and-set on the transition ═════════════════════════════ */

  describe('status compare-and-set', () => {
    it('moves the row when the expected status matches', async () => {
      const moved = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().transitionStatus({
          returnId: returnIdA,
          storeId: storeA,
          fromStatus: 'requested',
          toStatus: 'approved',
          closedAt: null,
        }),
      );

      expect(moved?.status).toBe('approved');
    });

    it('changes NOTHING when the expected status is stale', async () => {
      /*
       * The row is `approved` after the previous case. A caller still holding a stale
       * `requested` — which is precisely what a lost race looks like — must match no row and
       * come back `undefined`, so the service can refuse rather than overwrite.
       */
      const moved = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().transitionStatus({
          returnId: returnIdA,
          storeId: storeA,
          fromStatus: 'requested',
          toStatus: 'rejected',
          closedAt: new Date(),
        }),
      );

      expect(moved).toBeUndefined();

      const [row] = await testDb.handle.db
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.id, returnIdA));
      // Untouched: no silent overwrite, and no closing instant on an open row.
      expect(row?.status).toBe('approved');
      expect(row?.closedAt).toBeNull();
    });

    it('changes NOTHING when the store is a different tenant', async () => {
      const moved = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().transitionStatus({
          returnId: returnIdA,
          storeId: storeB,
          fromStatus: 'approved',
          toStatus: 'rejected',
          closedAt: new Date(),
        }),
      );

      expect(moved).toBeUndefined();

      const [row] = await testDb.handle.db
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.id, returnIdA));
      expect(row?.status).toBe('approved');
    });
  });

  /* ══ The staff queue's filters, and the tenant predicate under them ════ */

  describe('the staff queue filters', () => {
    const page = (params: Record<string, unknown>) =>
      repository().listStoreReturns({ limit: 50, offset: 0, ...params } as never);

    it('returns the store own return with no filter', async () => {
      const result = await page({ storeId: storeA });
      expect(result.items.map((r) => r.returnNumber)).toContain(returnNumber);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it('never returns it to a different tenant', async () => {
      const result = await page({ storeId: storeB });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    /*
     * The important one. A search term is client-supplied, so the tenant predicate has to hold
     * even when the term names a row that genuinely exists in ANOTHER store — the case a
     * store-less search would silently return.
     */
    it('never finds another tenant return by its return number', async () => {
      const result = await page({ storeId: storeB, q: returnNumber });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('never finds another tenant return by its order number', async () => {
      const result = await page({ storeId: storeB, q: 'ORD-20260101-REPOAA' });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('never finds another tenant return by the customer email', async () => {
      const [owner] = await testDb.handle.db
        .select()
        .from(appUser)
        .where(eq(appUser.storeId, storeA));

      const mine = await page({ storeId: storeA, q: owner!.email });
      expect(mine.items.map((r) => r.returnNumber)).toContain(returnNumber);

      const theirs = await page({ storeId: storeB, q: owner!.email });
      expect(theirs.items).toEqual([]);
      expect(theirs.total).toBe(0);
    });

    it('finds it in its own store by return number, order number and email', async () => {
      for (const q of [returnNumber, 'ORD-20260101-REPOAA', 'REPOAA']) {
        const result = await page({ storeId: storeA, q });
        expect(result.items.map((r) => r.returnNumber)).toContain(returnNumber);
      }
    });

    /*
     * The ordering guarantee the OpenAPI states, at the only point where it is observable.
     *
     * `requested_at DESC` alone is a total order in practice — PostgreSQL's clock is
     * microsecond-precise, so two returns almost never share an instant. Almost. When they do,
     * the row order is whatever the plan happens to emit, and a client paging through the queue
     * can see one return twice and another never. `return_number DESC` is the tie-breaker that
     * makes the order total rather than merely usually-stable, and this is the fixture that can
     * actually distinguish the two.
     */
    it('breaks an exact requestedAt tie by return number, descending', async () => {
      const [existing] = await testDb.handle.db
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.id, returnIdA));

      /*
       * BOTH rows are inserted with the same explicit instant. Reusing the existing return's
       * timestamp would not tie: `requested_at` is microsecond-precise in storage and a
       * JavaScript `Date` is millisecond-precise, so a value read out and written back lands
       * slightly EARLIER than the row it came from, and `requested_at DESC` would separate them
       * on its own — leaving the tie-breaker untested.
       */
      const sharedInstant = new Date('2026-01-01T00:00:00.000Z');
      const twins = [
        { id: newId(), returnNumber: 'RET-20260101-TIEAAA' },
        { id: newId(), returnNumber: 'RET-20260101-TIEZZZ' },
      ];

      for (const twin of twins) {
        await testDb.handle.db.insert(returnRequest).values({
          id: twin.id,
          storeId: storeA,
          orderId: existing!.orderId,
          userId: existing!.userId,
          returnNumber: twin.returnNumber,
          status: 'requested',
          reason: 'defective',
          currency: 'INR',
          refundTaxableValue: '1.0000',
          refundTaxTotal: '0.0000',
          refundTotal: '1.0000',
          deliveredAt: new Date(),
          requestedAt: sharedInstant,
        });
      }

      try {
        const result = await page({ storeId: storeA });
        const tied = result.items
          .filter((r) => r.requestedAt.getTime() === sharedInstant.getTime())
          .map((r) => r.returnNumber);

        /* Same instant, so only the tie-breaker can decide — and it sorts descending. */
        expect(tied).toEqual(['RET-20260101-TIEZZZ', 'RET-20260101-TIEAAA']);
      } finally {
        for (const twin of twins) {
          await testDb.handle.db.delete(returnRequest).where(eq(returnRequest.id, twin.id));
        }
      }
    });

    it('escapes LIKE wildcards so a typed % is a literal percent sign', async () => {
      const result = await page({ storeId: storeA, q: '%' });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('reports a total that agrees with the rows the same predicate returns', async () => {
      const filtered = await page({ storeId: storeA, q: returnNumber });
      expect(filtered.total).toBe(filtered.items.length);

      const missing = await page({ storeId: storeA, q: 'NOTHING-MATCHES-THIS' });
      expect(missing.total).toBe(0);
      expect(missing.items).toEqual([]);
    });

    it('applies requestedTo inclusively across the whole named millisecond', async () => {
      const [row] = await testDb.handle.db
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.id, returnIdA));

      /*
       * The bound as the API would publish it: truncated to milliseconds. With a plain `<=`
       * this drops the row whenever the stored microseconds are non-zero.
       */
      const published = new Date(row!.requestedAt.toISOString());
      const included = await page({ storeId: storeA, requestedTo: published });
      expect(included.items.map((r) => r.returnNumber)).toContain(returnNumber);

      const before = await page({
        storeId: storeA,
        requestedTo: new Date(published.getTime() - 1),
      });
      expect(before.items.map((r) => r.returnNumber)).not.toContain(returnNumber);
    });

    it('applies requestedFrom inclusively from the start of the named millisecond', async () => {
      const [row] = await testDb.handle.db
        .select()
        .from(returnRequest)
        .where(eq(returnRequest.id, returnIdA));

      const at = new Date(row!.requestedAt.toISOString());
      const included = await page({ storeId: storeA, requestedFrom: at });
      expect(included.items.map((r) => r.returnNumber)).toContain(returnNumber);

      const after = await page({ storeId: storeA, requestedFrom: new Date(at.getTime() + 1000) });
      expect(after.items.map((r) => r.returnNumber)).not.toContain(returnNumber);
    });
  });

  /* ══ The detail read, and its tenant predicate ═════════════════════════ */

  describe('the staff detail read', () => {
    it('returns the customer and the order address snapshot for its own store', async () => {
      const found = await repository().findStoreReturnDetailByNumber({
        returnNumber,
        storeId: storeA,
      });

      expect(found?.returnNumber).toBe(returnNumber);
      expect(found?.customerEmail).toContain('@example.com');
      expect(found?.customerFirstName).toBe('Ada');
      expect(found?.shipCity).toBe('Bengaluru');
      expect(found?.shipPostalCode).toBe('560001');
      /*
       * The status is narrowed at this boundary, not left as the driver's string. The VALUE is
       * whatever earlier tests in this file left the shared fixture at — asserting a specific
       * one would couple this test to their order — so what matters is that it is a member of
       * the vocabulary rather than an arbitrary string.
       */
      expect(RETURN_STATUSES).toContain(found?.status);
    });

    it('does NOT return it for a different tenant', async () => {
      const found = await repository().findStoreReturnDetailByNumber({
        returnNumber,
        storeId: storeB,
      });
      expect(found).toBeUndefined();
    });

    it('reads lifecycle events for its own store only', async () => {
      const mine = await repository().listReturnEvents({
        returnId: returnIdA,
        storeId: storeA,
      });
      const theirs = await repository().listReturnEvents({
        returnId: returnIdA,
        storeId: storeB,
      });

      /* The row exists and belongs to storeA, so this is a real predicate test, not a vacuous one. */
      expect(mine).toHaveLength(1);
      expect(mine[0]!.toStatus).toBe('requested');
      expect(mine[0]!.fromStatus).toBeNull();
      expect(theirs).toEqual([]);
    });
  });
});
