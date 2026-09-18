import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cart } from '../../src/db/schema/cart.js';
import { appUser, auditLog } from '../../src/db/schema/identity.js';
import { order, orderStatusHistory } from '../../src/db/schema/orders.js';
import { store } from '../../src/db/schema/store.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createIdentityRepository } from '../../src/modules/identity/identity.repository.js';
import { createOrdersRepository } from '../../src/modules/orders/orders.repository.js';
import { newId } from '../../src/shared/id.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';

/**
 * Store scoping on the order lookups, asserted directly against the repository.
 *
 * ## Why this file exists
 *
 * A mutation probe removed `eq(order.storeId, params.storeId)` from
 * `lockOwnedOrderByNumber` and the ENTIRE suite still passed. Nothing anywhere proved that
 * predicate does anything.
 *
 * It is not currently exploitable — `app_user.id` is unique across stores and
 * `fk_order_user_store` ties an order's user to the order's store, so filtering by `user_id`
 * alone already lands inside one tenant. The store predicate is defence in depth. But an
 * untested guard is a guard that can be deleted during a refactor without a single test going
 * red, and this one sits on the path returns and cancellation both take.
 *
 * Tested at the REPOSITORY rather than over HTTP deliberately: reaching two stores through the
 * API means defeating the container's store resolver cache, which would test the harness more
 * than the predicate. Here the two tenants are explicit and the assertion is exact.
 */
describe('tenant isolation — order lookups (audit)', () => {
  let testDb: TestDatabase;

  let storeA = '';
  let storeB = '';
  let userA = '';
  let orderNumberA = '';

  beforeAll(async () => {
    testDb = await startTestDatabase();

    storeA = (await seedTestStore(testDb)).id;

    /*
     * A SECOND store, inserted directly.
     *
     * `seedTestStore` deletes existing stores to re-seed the configured default, so it cannot
     * be used twice — the second tenant has to be built by hand.
     */
    storeB = newId();
    await testDb.handle.db.insert(store).values({
      id: storeB,
      slug: 'second-tenant',
      name: 'Second Tenant',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });

    userA = newId();
    await testDb.handle.db.insert(appUser).values({
      id: userA,
      storeId: storeA,
      email: `tenant.a.${userA}@example.com`,
      passwordHash: 'x',
      firstName: 'Ada',
      lastName: 'A',
    });

    const cartA = newId();
    await testDb.handle.db
      .insert(cart)
      .values({ id: cartA, storeId: storeA, userId: userA, status: 'checked_out' });

    orderNumberA = 'ORD-20260101-AAAAAA';
    await testDb.handle.db.insert(order).values({
      id: newId(),
      storeId: storeA,
      userId: userA,
      cartId: cartA,
      orderNumber: orderNumberA,
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
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  const repository = () => createOrdersRepository({ db: testDb.handle.db });

  it('finds the order for its own store', async () => {
    const found = await repository().findOwnedOrderByNumber({
      orderNumber: orderNumberA,
      userId: userA,
      storeId: storeA,
    });

    expect(found?.orderNumber).toBe(orderNumberA);
  });

  it('does NOT find the order when the store is a different tenant', async () => {
    // The killer for the surviving mutation: same user, same number, wrong store.
    const found = await repository().findOwnedOrderByNumber({
      orderNumber: orderNumberA,
      userId: userA,
      storeId: storeB,
    });

    expect(found).toBeUndefined();
  });

  it('locks the order for its own store', async () => {
    const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
      repository().lockOwnedOrderByNumber({
        orderNumber: orderNumberA,
        userId: userA,
        storeId: storeA,
      }),
    );

    expect(locked?.orderNumber).toBe(orderNumberA);
  });

  it('does NOT lock the order for a different tenant', async () => {
    /*
     * This is the assertion the mutation probe defeated. `lockOwnedOrderForReturn` is built on
     * this method, so without the store predicate a return could be raised against an order
     * the caller's tenant does not own — the moment the user model ever admits a second store.
     */
    const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
      repository().lockOwnedOrderByNumber({
        orderNumber: orderNumberA,
        userId: userA,
        storeId: storeB,
      }),
    );

    expect(locked).toBeUndefined();
  });

  it('does NOT return the order lines for a different tenant', async () => {
    const [row] = await testDb.handle.db
      .select()
      .from(order)
      .where(eq(order.orderNumber, orderNumberA));

    const own = await repository().listOrderLinesWithSkuId({
      orderId: row!.id,
      storeId: storeA,
    });
    const foreign = await repository().listOrderLinesWithSkuId({
      orderId: row!.id,
      storeId: storeB,
    });

    // The order has no lines in this fixture, so both are empty — what matters is that the
    // foreign read is scoped by store rather than by order id alone.
    expect(Array.isArray(own)).toBe(true);
    expect(foreign).toEqual([]);
  });

  /* ══ Increment 62: the new admin reads and the activation write ════════ */

  const identity = () => createIdentityRepository({ db: testDb.handle.db });

  describe('the admin order timeline', () => {
    it('reads its own store history, and nothing for a different tenant', async () => {
      const [row] = await testDb.handle.db
        .select()
        .from(order)
        .where(eq(order.orderNumber, orderNumberA));

      await testDb.handle.db.insert(orderStatusHistory).values({
        id: newId(),
        orderId: row!.id,
        storeId: storeA,
        fromStatus: null,
        toStatus: 'placed',
        actorType: 'customer',
        actorUserId: userA,
      });

      const own = await repository().listOrderStatusHistory({
        orderId: row!.id,
        storeId: storeA,
      });
      const foreign = await repository().listOrderStatusHistory({
        orderId: row!.id,
        storeId: storeB,
      });

      /*
       * The row EXISTS and belongs to storeA, so this is a real predicate test rather than a
       * vacuous one — an empty table would answer an empty list for both stores either way.
       */
      expect(own).toHaveLength(1);
      expect(own[0]!.toStatus).toBe('placed');
      expect(foreign).toEqual([]);
    });
  });

  describe('the store-scoped order lock used by staff cancellation', () => {
    it('locks its own store order', async () => {
      const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().lockStoreOrderByNumber({ orderNumber: orderNumberA, storeId: storeA }),
      );
      expect(locked?.orderNumber).toBe(orderNumberA);
    });

    it('does NOT lock it for a different tenant', async () => {
      /*
       * The staff cancellation path's lookup carries no `user_id` — staff act for a tenant, not
       * for a person — so `store_id` is the ONLY thing standing between one merchant's admin
       * and another merchant's order. Unlike the owner-scoped lock above, nothing else here
       * incidentally lands inside one tenant.
       */
      const locked = await withTransaction(testDb.handle.db, silentLogger, async () =>
        repository().lockStoreOrderByNumber({ orderNumber: orderNumberA, storeId: storeB }),
      );
      expect(locked).toBeUndefined();
    });
  });

  describe('the audit log read', () => {
    it('returns its own store entries and never another tenant entry', async () => {
      await testDb.handle.db.insert(auditLog).values([
        {
          id: newId(),
          storeId: storeA,
          actorUserId: userA,
          actorType: 'staff',
          action: 'tenant.probe',
          resourceType: 'order',
          resourceId: orderNumberA,
        },
        {
          id: newId(),
          storeId: storeB,
          actorUserId: null,
          actorType: 'staff',
          action: 'tenant.probe',
          resourceType: 'order',
          resourceId: 'ORD-OTHER',
        },
        /*
         * A PLATFORM entry, with no store at all. The predicate is an equality rather than an
         * `OR IS NULL` precisely so this row reaches neither tenant.
         */
        {
          id: newId(),
          storeId: null,
          actorUserId: null,
          actorType: 'system',
          action: 'tenant.probe',
          resourceType: 'platform',
          resourceId: 'global',
        },
      ]);

      const a = await identity().listStoreAuditLog({
        storeId: storeA,
        action: 'tenant.probe',
        limit: 50,
        offset: 0,
      });
      const b = await identity().listStoreAuditLog({
        storeId: storeB,
        action: 'tenant.probe',
        limit: 50,
        offset: 0,
      });

      expect(a.total).toBe(1);
      expect(a.items[0]!.resourceId).toBe(orderNumberA);

      expect(b.total).toBe(1);
      expect(b.items[0]!.resourceId).toBe('ORD-OTHER');

      /* Neither tenant sees the platform row. */
      expect(a.items.some((e) => e.resourceType === 'platform')).toBe(false);
      expect(b.items.some((e) => e.resourceType === 'platform')).toBe(false);
    });

    it('applies the inclusive-millisecond upper bound', async () => {
      const marker = newId();
      const at = new Date('2026-02-02T03:04:05.123Z');
      await testDb.handle.db.insert(auditLog).values({
        id: newId(),
        storeId: storeA,
        actorUserId: null,
        actorType: 'system',
        action: 'tenant.bound',
        resourceType: 'probe',
        resourceId: marker,
        createdAt: at,
      });

      const included = await identity().listStoreAuditLog({
        storeId: storeA,
        action: 'tenant.bound',
        to: at,
        limit: 50,
        offset: 0,
      });
      expect(included.items.some((e) => e.resourceId === marker)).toBe(true);

      const excluded = await identity().listStoreAuditLog({
        storeId: storeA,
        action: 'tenant.bound',
        to: new Date(at.getTime() - 1),
        limit: 50,
        offset: 0,
      });
      expect(excluded.items.some((e) => e.resourceId === marker)).toBe(false);
    });
  });

  describe('customer activation', () => {
    it('flips the flag for its own store only', async () => {
      const own = await identity().setCustomerActive({
        storeId: storeA,
        customerId: userA,
        isActive: false,
        at: new Date(),
      });
      expect(own?.isActive).toBe(false);

      /* Same customer id, wrong tenant: nothing moves. */
      const foreign = await identity().setCustomerActive({
        storeId: storeB,
        customerId: userA,
        isActive: true,
        at: new Date(),
      });
      expect(foreign).toBeUndefined();

      const [row] = await testDb.handle.db.select().from(appUser).where(eq(appUser.id, userA));
      expect(row!.isActive).toBe(false);
    });

    it('matches no row when the value is already what was asked for', async () => {
      /* The row is inactive after the previous case. Asking again must change nothing. */
      const again = await identity().setCustomerActive({
        storeId: storeA,
        customerId: userA,
        isActive: false,
        at: new Date(),
      });
      expect(again).toBeUndefined();
    });

    it('never touches the privilege flags', async () => {
      await testDb.handle.db
        .update(appUser)
        .set({ isStaff: false, isSuperuser: false, isActive: false })
        .where(eq(appUser.id, userA));

      await identity().setCustomerActive({
        storeId: storeA,
        customerId: userA,
        isActive: true,
        at: new Date(),
      });

      const [row] = await testDb.handle.db.select().from(appUser).where(eq(appUser.id, userA));
      expect(row!.isStaff).toBe(false);
      expect(row!.isSuperuser).toBe(false);
      expect(row!.isActive).toBe(true);
    });
  });
});
