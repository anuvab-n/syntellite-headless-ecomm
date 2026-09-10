import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cart } from '../../../db/schema/cart.js';
import { appUser } from '../../../db/schema/identity.js';
import { order } from '../../../db/schema/orders.js';
import { returnRequest } from '../../../db/schema/returns.js';
import { store } from '../../../db/schema/store.js';
import { withTransaction } from '../../../db/transaction.js';
import { newId } from '../../../shared/id.js';
import { createReturnsRepository } from '../returns.repository.js';
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
});
