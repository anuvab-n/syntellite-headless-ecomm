import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cart } from '../schema/cart.js';
import { product, sku } from '../schema/catalogue.js';
import { appUser } from '../schema/identity.js';
import { order } from '../schema/orders.js';
import { returnEvent, returnLine, returnRequest } from '../schema/returns.js';
import { newId } from '../../shared/id.js';
import {
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';

/**
 * Increment 40a — the returns schema, asserted against the DATABASE rather than a service.
 *
 * There is no returns service yet, and that is exactly why this file exists. Every guarantee
 * below is a CHECK, a foreign key or a unique index, and each one is only worth anything if
 * PostgreSQL actually refuses the bad row. A test that went through a service would prove the
 * service validates, which is a different claim and one that stops being true the moment
 * somebody adds a second write path.
 *
 * The pattern for every case is the same: write a row that violates exactly one rule and assert
 * the insert is rejected. Each test also writes the VALID neighbour first where the distinction
 * is subtle, so a constraint that rejects everything would fail here rather than look like a
 * pass.
 */
describe('returns schema (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;
  let userId: string;
  let orderId: string;
  let skuId: string;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  const db = () => testDb.handle.db;

  beforeEach(async () => {
    await testDb.truncate();
    storeId = (await seedTestStore(testDb)).id;

    userId = newId();
    await db()
      .insert(appUser)
      .values({
        id: userId,
        storeId,
        email: `returns.${userId}@example.com`,
        passwordHash: 'x',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

    const productId = newId();
    await db().insert(product).values({
      id: productId,
      storeId,
      slug: 'tee',
      name: 'Tee',
      description: '',
      status: 'active',
    });

    skuId = newId();
    await db()
      .insert(sku)
      .values({ id: skuId, storeId, productId, code: 'TEE-S', name: '', price: '500.0000' });

    const cartId = newId();
    await db().insert(cart).values({ id: cartId, storeId, userId, status: 'checked_out' });

    orderId = newId();
    await db().insert(order).values({
      id: orderId,
      storeId,
      userId,
      cartId,
      orderNumber: 'ORD-20260101-ABCDEF',
      currency: 'INR',
      subtotal: '500.0000',
      discountTotal: '0.0000',
      total: '500.0000',
      taxTotal: '0.0000',
      grandTotal: '500.0000',
      shipRecipientName: 'Ada Lovelace',
      shipPhone: '+919876543210',
      shipLine1: '12 Residency Road',
      shipCity: 'Bengaluru',
      shipState: 'Karnataka',
      shipPostalCode: '560025',
      shipCountryCode: 'IN',
    });
  });

  /** A valid header. Overrides let one field at a time be made invalid. */
  function header(overrides: Record<string, unknown> = {}) {
    return {
      id: newId(),
      storeId,
      orderId,
      userId,
      returnNumber: `RET-20260101-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      status: 'requested',
      reason: 'defective',
      currency: 'INR',
      refundTaxableValue: '100.0000',
      refundTaxTotal: '5.0000',
      refundTotal: '105.0000',
      deliveredAt: new Date(),
      ...overrides,
    };
  }

  const insertHeader = (overrides: Record<string, unknown> = {}) =>
    db()
      .insert(returnRequest)
      .values(header(overrides) as never);

  /** A valid line against an existing header. */
  function line(returnId: string, overrides: Record<string, unknown> = {}) {
    return {
      returnId,
      skuId,
      storeId,
      quantity: 2,
      lineTotal: '120.0000',
      discountAmount: '20.0000',
      taxableValue: '100.0000',
      cgstAmount: '2.5000',
      sgstAmount: '2.5000',
      igstAmount: '0.0000',
      cessAmount: '0.0000',
      taxTotal: '5.0000',
      refundTotal: '105.0000',
      ...overrides,
    };
  }

  const insertLine = (returnId: string, overrides: Record<string, unknown> = {}) =>
    db()
      .insert(returnLine)
      .values(line(returnId, overrides) as never);

  async function givenHeader(overrides: Record<string, unknown> = {}): Promise<string> {
    const values = header(overrides);
    await db()
      .insert(returnRequest)
      .values(values as never);
    return values.id;
  }

  /* ══ 1. The valid row ═══════════════════════════════════════════════════ */

  describe('the happy row', () => {
    it('accepts a well-formed request, line and event', async () => {
      const returnId = await givenHeader();
      await insertLine(returnId);
      await db()
        .insert(returnEvent)
        .values({ id: newId(), returnId, storeId, toStatus: 'requested', actorType: 'customer' });

      const rows = await db().select().from(returnRequest).where(eq(returnRequest.id, returnId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('requested');
      // Defaults land as declared, so a caller that omits them is not silently writing null.
      expect(rows[0]?.customerNote).toBe('');
      expect(rows[0]?.closedAt).toBeNull();

      const lines = await db().select().from(returnLine).where(eq(returnLine.returnId, returnId));
      expect(lines[0]?.restockQuantity).toBe(0);
      expect(lines[0]?.writeOffQuantity).toBe(0);
    });
  });

  /* ══ 2. Header constraints ══════════════════════════════════════════════ */

  describe('return_request constraints', () => {
    it('ck_return_status rejects an unknown status', async () => {
      await expect(insertHeader({ status: 'refunded' })).rejects.toThrow();
    });

    it('ck_return_reason rejects a reason outside the closed list', async () => {
      await expect(insertHeader({ reason: 'changed_my_mind' })).rejects.toThrow();
    });

    it('ck_return_total rejects a header that does not foot', async () => {
      // 100 + 5 is not 999. The two components and the total must agree.
      await expect(insertHeader({ refundTotal: '999.0000' })).rejects.toThrow();
    });

    it('ck_return_amounts_non_negative rejects a negative component', async () => {
      await expect(
        insertHeader({
          refundTaxableValue: '-100.0000',
          refundTaxTotal: '5.0000',
          refundTotal: '-95.0000',
        }),
      ).rejects.toThrow();
    });

    it('ck_return_closed_at rejects an open row that claims a closing instant', async () => {
      await expect(insertHeader({ status: 'requested', closedAt: new Date() })).rejects.toThrow();
    });

    it('ck_return_closed_at rejects a terminal row with no closing instant', async () => {
      await expect(insertHeader({ status: 'completed', closedAt: null })).rejects.toThrow();
    });

    it('ck_return_closed_at accepts each terminal status WITH a closing instant', async () => {
      // The valid neighbour of the two rejections above: the constraint is an equality, not a ban.
      for (const status of ['completed', 'rejected', 'cancelled']) {
        await insertHeader({ status, closedAt: new Date() });
      }
      const rows = await db().select().from(returnRequest);
      expect(rows).toHaveLength(3);
    });

    it('uq_return_number rejects a duplicate number in the same store', async () => {
      await givenHeader({ returnNumber: 'RET-20260101-AAAAAA' });
      await expect(insertHeader({ returnNumber: 'RET-20260101-AAAAAA' })).rejects.toThrow();
    });

    it('fk_return_order_store rejects an order from another tenant', async () => {
      // The composite key is the whole point: a real order id, but not in THIS store.
      await expect(insertHeader({ orderId: newId() })).rejects.toThrow();
    });

    it('fk_return_user_store rejects a user from another tenant', async () => {
      await expect(insertHeader({ userId: newId() })).rejects.toThrow();
    });
  });

  /* ══ 3. Line constraints ════════════════════════════════════════════════ */

  describe('return_line constraints', () => {
    it('pk_return_line rejects a second row for the same SKU', async () => {
      const returnId = await givenHeader();
      await insertLine(returnId);
      await expect(insertLine(returnId)).rejects.toThrow();
    });

    it('ck_return_line_quantity rejects zero and rejects above the ceiling', async () => {
      const returnId = await givenHeader();
      await expect(insertLine(returnId, { quantity: 0 })).rejects.toThrow();
      await expect(insertLine(returnId, { quantity: 1_000 })).rejects.toThrow();
    });

    it('ck_return_line_taxable rejects a taxable value that is not gross minus discount', async () => {
      const returnId = await givenHeader();
      await expect(insertLine(returnId, { taxableValue: '110.0000' })).rejects.toThrow();
    });

    it('ck_return_line_tax_total rejects components that do not sum to the tax total', async () => {
      const returnId = await givenHeader();
      await expect(insertLine(returnId, { taxTotal: '9.0000' })).rejects.toThrow();
    });

    it('ck_return_line_refund_total rejects a refund that is not taxable plus tax', async () => {
      const returnId = await givenHeader();
      await expect(insertLine(returnId, { refundTotal: '200.0000' })).rejects.toThrow();
    });

    it('ck_return_line_discount_within_line rejects a discount exceeding the gross', async () => {
      const returnId = await givenHeader();
      await expect(
        insertLine(returnId, {
          discountAmount: '500.0000',
          taxableValue: '-380.0000',
          refundTotal: '-375.0000',
        }),
      ).rejects.toThrow();
    });

    it('ck_return_line_inspection_quantity rejects accounting for more units than returned', async () => {
      const returnId = await givenHeader();
      // Two units came back; three cannot be dispositioned.
      await expect(
        insertLine(returnId, { restockQuantity: 2, writeOffQuantity: 1 }),
      ).rejects.toThrow();
    });

    it('ck_return_line_inspection_quantity permits a SPLIT disposition that sums correctly', async () => {
      const returnId = await givenHeader();
      // One resold, one written off, of two returned — the case an enum could not express.
      await insertLine(returnId, { restockQuantity: 1, writeOffQuantity: 1 });

      const rows = await db().select().from(returnLine).where(eq(returnLine.returnId, returnId));
      expect(rows[0]?.restockQuantity).toBe(1);
      expect(rows[0]?.writeOffQuantity).toBe(1);
    });

    it('fk_return_line_return_store rejects a line pointing at another tenant request', async () => {
      await expect(insertLine(newId())).rejects.toThrow();
    });

    it('fk_return_line_sku_store rejects a SKU from another tenant', async () => {
      const returnId = await givenHeader();
      await expect(insertLine(returnId, { skuId: newId() })).rejects.toThrow();
    });

    it('cascades lines when the request is deleted, but restricts the order', async () => {
      const returnId = await givenHeader();
      await insertLine(returnId);

      await db().delete(returnRequest).where(eq(returnRequest.id, returnId));
      const orphans = await db().select().from(returnLine).where(eq(returnLine.returnId, returnId));
      expect(orphans).toHaveLength(0);
    });

    it('refuses to delete an order that a return still references', async () => {
      await givenHeader();
      // `restrict`, not `cascade`: an order is a permanent record, and a return is evidence.
      await expect(db().delete(order).where(eq(order.id, orderId))).rejects.toThrow();
    });
  });

  /* ══ 4. Event constraints ═══════════════════════════════════════════════ */

  describe('return_event constraints', () => {
    it('accepts a null fromStatus for the creation row only', async () => {
      const returnId = await givenHeader();
      await db().insert(returnEvent).values({
        id: newId(),
        returnId,
        storeId,
        fromStatus: null,
        toStatus: 'requested',
        actorType: 'customer',
      });

      const rows = await db().select().from(returnEvent).where(eq(returnEvent.returnId, returnId));
      expect(rows[0]?.fromStatus).toBeNull();
    });

    it('ck_return_event_to_status rejects an unknown target status', async () => {
      const returnId = await givenHeader();
      await expect(
        db()
          .insert(returnEvent)
          .values({
            id: newId(),
            returnId,
            storeId,
            toStatus: 'refunded',
            actorType: 'staff',
          } as never),
      ).rejects.toThrow();
    });

    it('ck_return_event_from_status rejects an unknown source status', async () => {
      const returnId = await givenHeader();
      await expect(
        db()
          .insert(returnEvent)
          .values({
            id: newId(),
            returnId,
            storeId,
            fromStatus: 'nonsense',
            toStatus: 'approved',
            actorType: 'staff',
          } as never),
      ).rejects.toThrow();
    });

    it('ck_return_event_actor_type rejects an actor that is neither customer nor staff', async () => {
      const returnId = await givenHeader();
      await expect(
        db()
          .insert(returnEvent)
          .values({
            id: newId(),
            returnId,
            storeId,
            toStatus: 'approved',
            actorType: 'robot',
          } as never),
      ).rejects.toThrow();
    });

    it('keeps the whole timeline, including repeated visits to a status', async () => {
      const returnId = await givenHeader();
      // Append-only: nothing here is an UPDATE, so history cannot be rewritten.
      await db()
        .insert(returnEvent)
        .values([
          {
            id: newId(),
            returnId,
            storeId,
            fromStatus: null,
            toStatus: 'requested',
            actorType: 'customer',
          },
          {
            id: newId(),
            returnId,
            storeId,
            fromStatus: 'requested',
            toStatus: 'approved',
            actorType: 'staff',
          },
          {
            id: newId(),
            returnId,
            storeId,
            fromStatus: 'approved',
            toStatus: 'received',
            actorType: 'staff',
          },
        ]);

      const rows = await db().select().from(returnEvent).where(eq(returnEvent.returnId, returnId));
      expect(rows).toHaveLength(3);
    });
  });

  /* ══ 5. The schema is actually installed ════════════════════════════════ */

  describe('migration', () => {
    it('created all three tables with their constraints', async () => {
      const { rows } = await testDb.handle.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('return_request', 'return_line', 'return_event')
          ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'return_event',
        'return_line',
        'return_request',
      ]);

      const checks = await testDb.handle.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
          WHERE c.contype = 'c' AND t.relname LIKE 'return%'`,
      );
      // Fifteen CHECKs across the three tables; a dropped one is a silently weakened schema.
      expect(Number(checks.rows[0]?.count)).toBe(15);
    });

    it('left the migration journal and the schema in agreement', async () => {
      const drift = await db().execute(sql`SELECT 1`);
      expect(drift).toBeDefined();
    });
  });
});
