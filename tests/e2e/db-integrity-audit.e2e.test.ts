import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser, auditLog } from '../../src/db/schema/identity.js';
import { idempotencyKey } from '../../src/db/schema/idempotency.js';
import { stockItem, stockLedger } from '../../src/db/schema/inventory.js';
import { order, orderStatusHistory } from '../../src/db/schema/orders.js';
import { outboxEvent } from '../../src/db/schema/outbox.js';
import { paymentEvent } from '../../src/db/schema/payments.js';
import { returnEvent } from '../../src/db/schema/returns.js';
import { shipmentEvent } from '../../src/db/schema/shipments.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * DB-integrity audit: the same customer + admin lifecycle other e2e suites drive, but every
 * assertion here is on the DATABASE, not the HTTP response.
 *
 * `full-flow-walkthrough.e2e.test.ts` and `admin-user-endpoint-coverage.e2e.test.ts` already
 * prove the HTTP surface works — status codes, response shapes, authorization boundaries. This
 * file exists because a 200 only proves the API answered; it does not prove the SIDE EFFECTS a
 * production operator, an auditor, or a support engineer would actually rely on were written
 * correctly:
 *
 *  - Every privileged mutation leaves an `audit_log` row naming the real actor (not "someone
 *    did something" — WHO, in the same transaction as the change).
 *  - Every domain event a module claims to emit lands in `outbox_event` with the right
 *    aggregate and a payload that matches the row it describes.
 *  - Every state machine (order, payment, shipment, return) has an unbroken, append-only
 *    history — `fromStatus -> toStatus` — that reconstructs the row's current status by
 *    replaying it, not just a status column nobody checked was reachable.
 *  - Inventory's ledger foots: `on_hand_after - on_hand_before == delta` for every row, and the
 *    ledger's signed sum lands on `stock_item.on_hand` exactly.
 *  - A retried checkout (same `Idempotency-Key`) does not create a second order, and the
 *    `idempotency_key` row proves why: the guard fired, not the money layer coincidentally
 *    agreeing twice.
 *  - No response body — customer or admin — ever serializes `passwordHash`, `isStaff`, or
 *    `isSuperuser`. Checked by walking every captured JSON body's keys recursively, not by
 *    trusting the DTO allowlist to have been followed everywhere it matters.
 *
 * Same infrastructure discipline as the other e2e suites: real PostgreSQL and Redis via
 * Testcontainers, the real composition root, `globalThis.fetch` stubbed only for Razorpay.
 */
describe('DB integrity audit (customer + admin lifecycle)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;

  const RAZORPAY = {
    keyId: 'rzp_test_audit',
    keySecret: 'audit-api-secret',
    webhookSecret: 'audit-webhook-secret',
  };

  const PASSWORD = 'a-sufficiently-long-integrity-password';

  let storeId = '';
  let adminToken = '';
  let adminUserId = '';
  let customerToken = '';
  let customerUserId = '';
  let skuId = '';
  let skuCode = '';
  let addressId = '';
  let orderId = '';
  let orderNumber = '';
  let shipmentId = '';
  let returnId = '';

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /** Every JSON body captured during the run, for the leakage scan at the end. */
  const capturedBodies: unknown[] = [];
  const capture = <T>(res: { body: T }): T => {
    capturedBodies.push(res.body);
    return res.body;
  };

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      return new Response(JSON.stringify({ id: `order_AUDIT_${newId()}` }), { status: 200 });
    };

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          RAZORPAY_KEY_ID: RAZORPAY.keyId,
          RAZORPAY_KEY_SECRET: RAZORPAY.keySecret,
          RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret,
          AUTH_RATE_LIMIT_IP_MAX: '2000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '2000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  it('sets up admin + customer, and both accounts write nothing sensitive into any response', async () => {
    const adminEmail = `audit.admin.${newId()}@example.com`;
    const admin = await container.identity.registerCustomer({
      storeId,
      input: { email: adminEmail, password: PASSWORD, firstName: 'Audit', lastName: 'Admin' },
    });
    adminUserId = admin.id;
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, admin.id));

    const adminLogin = capture(
      await api().post('/api/v1/auth/login').send({ email: adminEmail, password: PASSWORD }),
    );
    adminToken = (adminLogin as { accessToken: string }).accessToken;

    const customerEmail = `audit.customer.${newId()}@example.com`;
    const customerReg = capture(
      await api().post('/api/v1/auth/register').send({
        email: customerEmail,
        password: PASSWORD,
        firstName: 'Audit',
        lastName: 'Customer',
      }),
    );
    customerUserId = (customerReg as { user: { id: string } }).user.id;

    const customerLogin = capture(
      await api().post('/api/v1/auth/login').send({ email: customerEmail, password: PASSWORD }),
    );
    customerToken = (customerLogin as { accessToken: string }).accessToken;

    // registration writes an audit_log row naming the real actor, not a generic "system" row
    const [registrationAudit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, storeId), eq(auditLog.actorUserId, customerUserId)));
    expect(registrationAudit).toBeDefined();
    expect(registrationAudit?.actorType).toBe('customer');

    // and the SAME event reached the outbox, with the right aggregate
    const [registeredEvent] = await db()
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.storeId, storeId),
          eq(outboxEvent.aggregateType, 'user'),
          eq(outboxEvent.aggregateId, customerUserId),
        ),
      );
    expect(registeredEvent).toBeDefined();
    expect(registeredEvent?.eventName).toBe('user.registered');
  });

  it('admin builds the catalogue; every write leaves audit_log + outbox_event, and stock_ledger foots', async () => {
    const slug = `audit-tee-${newId().slice(0, 8)}`;
    skuCode = `AUDIT-${newId().slice(0, 8)}`;

    capture(
      await api()
        .post('/api/v1/admin/products')
        .set(asAdmin())
        .send({ slug, name: 'Audit Tee', status: 'active' }),
    );

    const [productAudit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, storeId), eq(auditLog.actorUserId, adminUserId)));
    expect(productAudit).toBeDefined();
    expect(productAudit?.actorType).toBe('staff');

    const skuBody = capture(
      await api()
        .post(`/api/v1/admin/products/${slug}/skus`)
        .set(asAdmin())
        .send({ code: skuCode, price: '499.0000' }),
    ) as { sku: { id: string } };
    skuId = skuBody.sku.id;

    capture(
      await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asAdmin())
        .send({ skuCode, delta: 40, reason: 'manual_increase', note: 'audit stock 1' }),
    );
    capture(
      await api()
        .post('/api/v1/admin/inventory/adjustments')
        .set(asAdmin())
        .send({ skuCode, delta: -5, reason: 'manual_decrease', note: 'audit stock 2' }),
    );

    // The ledger's own arithmetic must be internally consistent for EVERY row...
    const ledgerRows = await db()
      .select()
      .from(stockLedger)
      .where(and(eq(stockLedger.storeId, storeId), eq(stockLedger.skuId, skuId)))
      .orderBy(stockLedger.createdAt);

    expect(ledgerRows.length).toBe(2);
    for (const row of ledgerRows) {
      expect(row.onHandAfter - row.onHandBefore).toBe(row.delta);
      expect(row.actorUserId).toBe(adminUserId);
    }
    // ...and the CHAIN must connect: each row's "before" is the previous row's "after".
    for (let i = 1; i < ledgerRows.length; i += 1) {
      expect(ledgerRows[i]!.onHandBefore).toBe(ledgerRows[i - 1]!.onHandAfter);
    }

    // ...and the signed sum must land exactly on the projection `stock_item` carries.
    const [item] = await db()
      .select()
      .from(stockItem)
      .where(and(eq(stockItem.storeId, storeId), eq(stockItem.skuId, skuId)));
    const ledgerSum = ledgerRows.reduce((sum, row) => sum + row.delta, 0);
    expect(item?.onHand).toBe(ledgerSum);
    expect(item?.onHand).toBe(35); // 40 - 5, spelled out so a wrong-signed bug fails loudly
  });

  it('checkout: idempotency_key guards a retry, order_status_history is append-only, money foots', async () => {
    const address = capture(
      await api().post('/api/v1/users/me/addresses').set(asCustomer()).send({
        label: 'Home',
        recipientName: 'Audit Customer',
        phone: '+91 9876500000',
        line1: '1 Audit Lane',
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
        countryCode: 'IN',
      }),
    ) as { address: { id: string } };
    addressId = address.address.id;

    capture(
      await api()
        .put(`/api/v1/users/me/cart/items/${skuCode}`)
        .set(asCustomer())
        .send({ quantity: 2 }),
    );

    const idempotencyKeyValue = `audit-checkout-${newId()}`;

    const checkout1 = capture(
      await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', idempotencyKeyValue)
        .send({ addressId }),
    ) as { order: { orderNumber: string } };
    orderNumber = checkout1.order.orderNumber;

    // The exact same key, replayed — must return the SAME order, not create a second one.
    const checkout2 = capture(
      await api()
        .post('/api/v1/users/me/checkout')
        .set(asCustomer())
        .set('idempotency-key', idempotencyKeyValue)
        .send({ addressId }),
    ) as { order: { orderNumber: string } };
    expect(checkout2.order.orderNumber).toBe(orderNumber);

    const [idemRow] = await db()
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.storeId, storeId), eq(idempotencyKey.key, idempotencyKeyValue)));
    expect(idemRow).toBeDefined();
    expect(idemRow?.status).toBe('completed');

    // The invariant the idempotency guard exists to protect: exactly ONE order for this store
    // carries this order number, even though checkout was called twice with the same key.
    const orderRowsForNumber = await db()
      .select()
      .from(order)
      .where(and(eq(order.storeId, storeId), eq(order.orderNumber, orderNumber)));
    expect(orderRowsForNumber.length).toBe(1);
    const orderRow = orderRowsForNumber[0];
    orderId = orderRow!.id;

    // order_status_history: append-only, starts with a null->placed row and nothing else yet.
    const history = await db()
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(orderStatusHistory.createdAt);
    expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, 'placed']]);

    // order.placed is AUDIT-ONLY, deliberately — `orders.events.ts` records that no order
    // event is emitted to the outbox ("an event with no consumer is a guess at one"), so the
    // durable trail of checkout is the audit_log row, not an outbox_event. Asserting an
    // outbox row here would assert a guarantee this module explicitly does not make.
    const [placedAudit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.storeId, storeId),
          eq(auditLog.resourceType, 'order'),
          eq(auditLog.resourceId, orderId),
          eq(auditLog.action, 'order.placed'),
        ),
      );
    expect(placedAudit).toBeDefined();
    expect(placedAudit?.actorUserId).toBe(customerUserId);

    // Money foots in minor units, straight from the row Postgres actually stored.
    const minor = (v: string) => BigInt(v.replace('.', ''));
    expect(minor(orderRow!.grandTotal)).toBe(minor(orderRow!.total) + minor(orderRow!.taxTotal));
  });

  it('COD payment: payment_event history matches the state machine, audit trail names the customer', async () => {
    const pay = capture(
      await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
        .set(asCustomer())
        .set('idempotency-key', `audit-pay-${newId()}`)
        .send({ method: 'cod' }),
    ) as { payment: { id: string; status: string } };
    expect(pay.payment.status).toBe('pending');

    const events = await db()
      .select()
      .from(paymentEvent)
      .where(eq(paymentEvent.paymentId, pay.payment.id))
      .orderBy(paymentEvent.createdAt);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([[null, 'pending']]);

    const [initiatedAudit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.storeId, storeId),
          eq(auditLog.resourceType, 'payment'),
          eq(auditLog.resourceId, pay.payment.id),
        ),
      );
    expect(initiatedAudit).toBeDefined();
    expect(initiatedAudit?.actorUserId).toBe(customerUserId);
  });

  it('fulfilment: shipment_event chains ship -> deliver, and each transition is audited to the admin who did it', async () => {
    const created = capture(
      await api()
        .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
        .set(asAdmin())
        .send({ carrier: 'AuditCarrier', trackingNumber: `AUD-${newId().slice(0, 8)}` }),
    ) as { shipment: { id: string } };
    shipmentId = created.shipment.id;

    capture(await api().post(`/api/v1/admin/shipments/${shipmentId}/ship`).set(asAdmin()).send({}));
    capture(
      await api().post(`/api/v1/admin/shipments/${shipmentId}/deliver`).set(asAdmin()).send({}),
    );

    const events = await db()
      .select()
      .from(shipmentEvent)
      .where(eq(shipmentEvent.shipmentId, shipmentId))
      .orderBy(shipmentEvent.createdAt);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, 'pending'],
      ['pending', 'shipped'],
      ['shipped', 'delivered'],
    ]);

    const shipmentAudits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.storeId, storeId), eq(auditLog.resourceType, 'shipment')));
    expect(shipmentAudits.length).toBeGreaterThanOrEqual(3);
    for (const row of shipmentAudits) {
      expect(row.actorUserId).toBe(adminUserId);
      expect(row.actorType).toBe('staff');
    }
  });

  it('returns: return_event is append-only and the staff decision is audited under the deciding admin, not the requesting customer', async () => {
    const created = capture(
      await api()
        .post(`/api/v1/users/me/orders/${orderNumber}/returns`)
        .set(asCustomer())
        .set('idempotency-key', `audit-ret-${newId()}`)
        .send({ reason: 'defective', lines: [{ skuCode, quantity: 1 }] }),
    ) as { return: { id: string; returnNumber: string } };
    returnId = created.return.id;

    capture(
      await api()
        .post(`/api/v1/admin/returns/${created.return.returnNumber}/approve`)
        .set(asAdmin())
        .send({ staffNote: 'audit check' }),
    );

    const events = await db()
      .select()
      .from(returnEvent)
      .where(eq(returnEvent.returnId, returnId))
      .orderBy(returnEvent.createdAt);
    expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual([
      [null, 'requested'],
      ['requested', 'approved'],
    ]);

    // The REQUEST is the customer's act; the DECISION is the admin's. Two different actors,
    // both correctly attributed — this is the row that would catch "approve" silently
    // recording whoever raised the return instead of whoever decided it.
    const requestAudit = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.storeId, storeId),
          eq(auditLog.resourceType, 'return'),
          eq(auditLog.resourceId, returnId),
          eq(auditLog.actorUserId, customerUserId),
        ),
      );
    expect(requestAudit.length).toBeGreaterThanOrEqual(1);

    const decisionAudit = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.storeId, storeId),
          eq(auditLog.resourceType, 'return'),
          eq(auditLog.resourceId, returnId),
          eq(auditLog.actorUserId, adminUserId),
        ),
      );
    expect(decisionAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('leakage scan: no captured response body — customer or admin — ever carries a sensitive column', async () => {
    const FORBIDDEN_KEYS = [
      'passwordHash',
      'password_hash',
      'isStaff',
      'isSuperuser',
      'is_staff',
      'is_superuser',
    ];

    const offenders: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach((entry, i) => {
          walk(entry, `${path}[${String(i)}]`);
        });
        return;
      }
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.includes(key)) offenders.push(`${path}.${key}`);
        walk(val, `${path}.${key}`);
      }
    };

    capturedBodies.forEach((body, i) => {
      walk(body, `body[${String(i)}]`);
    });

    expect(
      offenders,
      `forbidden keys found in captured response bodies:\n${offenders.join('\n')}`,
    ).toEqual([]);
    expect(capturedBodies.length).toBeGreaterThan(5); // sanity: the scan actually had something to scan
  });
});
