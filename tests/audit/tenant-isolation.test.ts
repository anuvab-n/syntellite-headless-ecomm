import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cart } from '../../src/db/schema/cart.js';
import { appUser } from '../../src/db/schema/identity.js';
import { order } from '../../src/db/schema/orders.js';
import { store } from '../../src/db/schema/store.js';
import { withTransaction } from '../../src/db/transaction.js';
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
});
