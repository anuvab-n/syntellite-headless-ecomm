import { createHmac } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildContainer, type AppContainer } from '../../../container.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { order } from '../../../db/schema/orders.js';
import { payment } from '../../../db/schema/payments.js';
import { refund } from '../../../db/schema/refunds.js';
import { newId } from '../../../shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../../tests/helpers/redis.ts';

/**
 * Increment 60 — resolving a `processing` refund from a verified provider notification.
 *
 * Against the REAL composition root, real PostgreSQL and real Redis, with the provider stubbed
 * only at `api.razorpay.com`. The webhook is posted as raw signed bytes through the actual
 * route, so the HMAC, the raw-body ordering in `app.ts`, the adapter's event vocabulary and the
 * refund state machine are all exercised rather than assumed.
 *
 * Four properties carry this suite:
 *
 *  1. **Only a `processing`, `provider`-mode refund whose amount matches may move.** Every other
 *     combination is a `200` no-op and the row is re-read to prove it did not move.
 *  2. **A duplicate delivery is harmless.** Terminal states survive redelivery, and no second
 *     refund row is ever created — asserted by counting rows, not by trusting a response.
 *  3. **`payment.status` is never written on this path.** Read off the column after every test
 *     that resolves anything.
 *  4. **Nothing unverified can move money.** A bad signature, a forged `notes.refund_id` and a
 *     rewritten event-id header are each shown to leave the row exactly as it was.
 */
describe('refund resolution webhook (integration)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  let storeId = '';
  let staffToken = '';

  const PASSWORD = 'a-sufficiently-long-password';
  const PRICE = '500.0000';
  let fixtureSeq = 0;

  const CREDENTIALS = {
    keyId: 'rzp_test_publishable',
    keySecret: 'the-api-secret-never-published',
    webhookSecret: 'the-webhook-secret-never-published',
  };

  /**
   * What the stubbed provider does on the next refund call.
   *
   * `network` is the default here, because an unanswered call is the only way to reach the
   * `processing` state this entire suite is about.
   */
  type RefundBehaviour = { kind: 'ok' } | { kind: 'network' };
  let refundBehaviour: RefundBehaviour = { kind: 'network' };

  /** Every refund request the provider received, so a second attempt would be visible. */
  const refundCalls: { url: string; body: string }[] = [];

  let refCounter = 0;
  let refundCounter = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asStaff = () => ({ Authorization: `Bearer ${staffToken}` });

  const sign = (body: string): string =>
    createHmac('sha256', CREDENTIALS.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : ((input as { url?: string }).url ?? '');

      if (!url.includes('api.razorpay.com')) return realFetch(...args);

      if (url.includes('/refund')) {
        refundCalls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
        if (refundBehaviour.kind === 'network') throw new Error('socket hang up');
        refundCounter += 1;
        return new Response(JSON.stringify({ id: `rfnd_stub_${String(refundCounter)}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      refCounter += 1;
      return new Response(JSON.stringify({ id: `order_stub_${String(refCounter)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          AUTH_RATE_LIMIT_IP_MAX: '4000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '4000',
          RAZORPAY_KEY_ID: CREDENTIALS.keyId,
          RAZORPAY_KEY_SECRET: CREDENTIALS.keySecret,
          RAZORPAY_WEBHOOK_SECRET: CREDENTIALS.webhookSecret,
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    const staff = await signIn({ staff: true });
    staffToken = staff.token;
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
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
      /* No endpoint grants staff: that would be a privilege-escalation route on a public API. */
      await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, user.id));
    }
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { token: login.body.accessToken as string, id: user.id };
  }

  /** A delivered, paid order whose payment can be refunded. */
  async function givenDeliveredPaidOrder(options: { method: 'online' | 'cod' }) {
    const buyer = await signIn();
    const seq = (fixtureSeq += 1);
    const slug = `rfw-p-${String(seq)}`;
    const skuCode = `RFW-SKU-${String(seq)}`;
    const buyerHeaders = { Authorization: `Bearer ${buyer.token}` };

    expect(
      (
        await api()
          .post('/api/v1/admin/products')
          .set(asStaff())
          .send({ slug, name: 'Tee', status: 'active' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`/api/v1/admin/products/${slug}/skus`)
          .set(asStaff())
          .send({ code: skuCode, price: PRICE })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/admin/inventory/adjustments')
          .set(asStaff())
          .send({ skuCode, delta: 50, reason: 'manual_increase' })
      ).status,
    ).toBe(201);

    expect(
      (
        await api().put(`/api/v1/users/me/cart/items/${skuCode}`).set(buyerHeaders).send({
          quantity: 2,
        })
      ).status,
    ).toBe(200);

    const addr = await api().post('/api/v1/users/me/addresses').set(buyerHeaders).send({
      label: 'Home',
      recipientName: 'A B',
      phone: '+91 9876543210',
      line1: '1 Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560025',
    });
    expect(addr.status).toBe(201);

    const checkout = await api()
      .post('/api/v1/users/me/checkout')
      .set(buyerHeaders)
      .set('idempotency-key', `co-${newId()}`)
      .send({ addressId: addr.body.address.id });
    expect(checkout.status).toBe(201);

    const orderNumber = checkout.body.order.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));

    const initiated = await api()
      .post(`/api/v1/users/me/orders/${orderNumber}/payments`)
      .set(buyerHeaders)
      .set('idempotency-key', `pay-${newId()}`)
      .send({ method: options.method });
    expect(initiated.status).toBe(201);

    if (options.method === 'online') {
      const providerRef = initiated.body.handoff.providerRef as string;
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: { id: `pay_CHG${String(seq).padStart(5, '0')}`, order_id: providerRef },
          },
        },
      });
      const hook = await api()
        .post('/api/v1/webhooks/razorpay')
        .set('content-type', 'application/json')
        .set('x-razorpay-signature', sign(body))
        .set('x-razorpay-event-id', `evt_${newId()}`)
        .send(body);
      expect(hook.status).toBe(200);
    }

    /* Delivery is what makes a COD payment refundable, and is harmless for an online one. */
    const created = await api()
      .post(`/api/v1/admin/orders/${orderNumber}/shipments`)
      .set(asStaff())
      .send({ carrier: 'Bluedart', trackingNumber: `BD-${String(seq)}` });
    expect(created.status).toBe(201);
    const shipmentId = created.body.shipment.id as string;

    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/ship`).set(asStaff()).send({}))
        .status,
    ).toBe(200);
    expect(
      (await api().post(`/api/v1/admin/shipments/${shipmentId}/deliver`).set(asStaff()).send({}))
        .status,
    ).toBe(200);

    return { orderNumber, orderId: row!.id, skuCode, grandTotal: row!.grandTotal };
  }

  const refundOrder = (orderNumber: string, amount: string) =>
    api()
      .post(`/api/v1/admin/orders/${orderNumber}/refund`)
      .set(asStaff())
      .set('idempotency-key', `rf-${newId()}`)
      .send({ amount });

  /**
   * A refund sitting in `processing`, which is the only state a webhook may resolve.
   *
   * Reached the honest way — the provider call is dropped on the floor, the adapter reports
   * `unknown`, and the service records "asked, no answer". Nothing writes the row directly.
   */
  async function givenProcessingRefund(amount = '100.0000') {
    const ctx = await givenDeliveredPaidOrder({ method: 'online' });
    refundBehaviour = { kind: 'network' };

    const raised = await refundOrder(ctx.orderNumber, amount);
    expect(raised.status).toBe(201);
    expect(raised.body.refund.status).toBe('processing');

    const row = await refundRow(raised.body.refund.refundNumber as string);
    expect(row.providerRefundId).toBeNull();
    return { ...ctx, refundNumber: raised.body.refund.refundNumber as string, refundRow: row };
  }

  const refundRow = async (refundNumber: string) => {
    const [row] = await db().select().from(refund).where(eq(refund.refundNumber, refundNumber));
    return row!;
  };

  const paymentOf = async (orderId: string) => {
    const [row] = await db().select().from(payment).where(eq(payment.orderId, orderId));
    return row!;
  };

  const refundsOf = async (orderId: string) =>
    db().select().from(refund).where(eq(refund.orderId, orderId));

  /** Build the exact Razorpay refund envelope, with only the fields the adapter reads. */
  function refundEvent(options: {
    event: 'refund.processed' | 'refund.failed' | 'refund.created' | 'refund.speed_changed';
    reference: string | null;
    amountMinor: number;
    refundId?: string;
    notes?: Record<string, unknown> | null;
  }): string {
    const notes =
      options.notes !== undefined
        ? options.notes
        : options.reference === null
          ? {}
          : { refund_id: options.reference };

    return JSON.stringify({
      event: options.event,
      payload: {
        refund: {
          entity: {
            id: options.refundId ?? `rfnd_${newId().slice(0, 12)}`,
            amount: options.amountMinor,
            currency: 'INR',
            status: options.event === 'refund.processed' ? 'processed' : 'failed',
            notes,
          },
        },
      },
    });
  }

  const postWebhook = (body: string, options: { signature?: string; eventId?: string } = {}) =>
    api()
      .post('/api/v1/webhooks/razorpay')
      .set('content-type', 'application/json')
      .set('x-razorpay-signature', options.signature ?? sign(body))
      .set('x-razorpay-event-id', options.eventId ?? `evt_${newId()}`)
      .send(body);

  /* ══ 1. The happy paths ════════════════════════════════════════════════ */

  describe('resolving a processing refund', () => {
    it('moves processing to succeeded on refund.processed', async () => {
      const ctx = await givenProcessingRefund();

      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
          refundId: 'rfnd_resolved_ok',
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'applied', refund: { status: 'succeeded' } });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('succeeded');
      /* The id we never learned from the REST call, learned from the notification instead. */
      expect(after.providerRefundId).toBe('rfnd_resolved_ok');
      expect(after.settledAt).not.toBeNull();
      expect(after.failureCode).toBeNull();
    });

    it('moves processing to failed on refund.failed', async () => {
      const ctx = await givenProcessingRefund();

      const response = await postWebhook(
        refundEvent({
          event: 'refund.failed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'applied', refund: { status: 'failed' } });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('failed');
      expect(after.failureCode).toBe('provider_refund_failed');
      expect(after.settledAt).not.toBeNull();
      /* A failed refund names no provider refund id — it did not happen. */
      expect(after.providerRefundId).toBeNull();
    });

    it('records the resolution against the existing refund audit vocabulary', async () => {
      const ctx = await givenProcessingRefund();

      await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
          refundId: 'rfnd_audited',
        }),
      );

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, ctx.refundRow.id));

      const resolution = entries.find((e) => e.action === 'refund.succeeded');
      expect(resolution).toBeDefined();
      /* The platform applied a fact the provider reported — not a person. */
      expect(resolution!.actorType).toBe('system');
      expect(resolution!.actorUserId).toBeNull();

      const metadata = resolution!.metadata as Record<string, unknown>;
      expect(metadata['providerRefundId']).toBe('rfnd_audited');
      expect(metadata['providerEventId']).toEqual(expect.any(String));
      /* Identifiers only. Never a signature, a header set, or a body. */
      expect(JSON.stringify(metadata)).not.toContain(CREDENTIALS.webhookSecret);
    });
  });

  /* ══ 2. Duplicates and concurrency ═════════════════════════════════════ */

  describe('duplicate and concurrent delivery', () => {
    it('leaves a succeeded refund untouched on redelivery and creates no second attempt', async () => {
      const ctx = await givenProcessingRefund();
      const body = refundEvent({
        event: 'refund.processed',
        reference: ctx.refundRow.id,
        amountMinor: ctx.refundRow.amountMinor,
        refundId: 'rfnd_once',
      });

      const first = await postWebhook(body);
      expect(first.body).toEqual({ status: 'applied', refund: { status: 'succeeded' } });

      const before = await refundRow(ctx.refundNumber);

      /* A genuine redelivery: same body, same signature, a NEW event id, as Razorpay retries. */
      const second = await postWebhook(body);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('succeeded');
      expect(after.settledAt).toEqual(before.settledAt);
      expect(after.updatedAt).toEqual(before.updatedAt);

      /* One refund row for the order, and the provider was asked exactly once. */
      expect(await refundsOf(ctx.orderId)).toHaveLength(1);
    });

    it('resolves once under concurrent delivery of the same event', async () => {
      const ctx = await givenProcessingRefund();
      const body = refundEvent({
        event: 'refund.processed',
        reference: ctx.refundRow.id,
        amountMinor: ctx.refundRow.amountMinor,
        refundId: 'rfnd_concurrent',
      });

      const [a, b] = await Promise.all([postWebhook(body), postWebhook(body)]);

      const outcomes = [a.body.status, b.body.status].sort();
      /* Exactly one applied; the other serialised behind the row lock and saw a terminal row. */
      expect(outcomes).toEqual(['applied', 'ignored']);
      expect([a.status, b.status]).toEqual([200, 200]);

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('succeeded');
      expect(await refundsOf(ctx.orderId)).toHaveLength(1);
    });

    it('does not re-open a failed refund when a late success arrives', async () => {
      const ctx = await givenProcessingRefund();

      await postWebhook(
        refundEvent({
          event: 'refund.failed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );
      expect((await refundRow(ctx.refundNumber)).status).toBe('failed');

      const late = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );
      expect(late.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('failed');
      expect(after.providerRefundId).toBeNull();
    });
  });

  /* ══ 3. What may not move ══════════════════════════════════════════════ */

  describe('refusals', () => {
    it('rejects an invalid signature and leaves the refund processing', async () => {
      const ctx = await givenProcessingRefund();
      const body = refundEvent({
        event: 'refund.processed',
        reference: ctx.refundRow.id,
        amountMinor: ctx.refundRow.amountMinor,
      });

      const response = await postWebhook(body, { signature: 'deadbeef'.repeat(8) });

      expect(response.status).toBe(401);
      expect((await refundRow(ctx.refundNumber)).status).toBe('processing');
    });

    it('rejects a body signed with the wrong secret', async () => {
      const ctx = await givenProcessingRefund();
      const body = refundEvent({
        event: 'refund.processed',
        reference: ctx.refundRow.id,
        amountMinor: ctx.refundRow.amountMinor,
      });
      const forged = createHmac('sha256', 'not-the-webhook-secret')
        .update(Buffer.from(body, 'utf8'))
        .digest('hex');

      expect((await postWebhook(body, { signature: forged })).status).toBe(401);
      expect((await refundRow(ctx.refundNumber)).status).toBe('processing');
    });

    it('acknowledges a reference that names no refund', async () => {
      const response = await postWebhook(
        refundEvent({ event: 'refund.processed', reference: newId(), amountMinor: 1000 }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ignored', reason: 'unknown_reference' });
    });

    it('refuses an amount that does not match the frozen refund', async () => {
      const ctx = await givenProcessingRefund('100.0000');

      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          /* One paisa short of what was actually requested. */
          amountMinor: ctx.refundRow.amountMinor - 1,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ignored', reason: 'amount_mismatch' });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('processing');
      expect(after.settledAt).toBeNull();
    });

    it('refuses an entity carrying no amount at all', async () => {
      const ctx = await givenProcessingRefund();
      const body = JSON.stringify({
        event: 'refund.processed',
        payload: {
          refund: {
            entity: { id: 'rfnd_no_amount', notes: { refund_id: ctx.refundRow.id } },
          },
        },
      });

      expect((await postWebhook(body)).body).toEqual({
        status: 'ignored',
        reason: 'amount_mismatch',
      });
      expect((await refundRow(ctx.refundNumber)).status).toBe('processing');
    });

    it('does not resolve a refund that is still pending', async () => {
      /*
       * A `pending` row: the provider answered, so the claim committed, but the dispatch has
       * not moved it on. Reached by raising a refund whose provider call SUCCEEDS against a
       * COD-style manual row is not possible, so this drives the online path and then rewinds
       * the one column under test — the narrowest possible fixture for a state the API cannot
       * otherwise park a row in.
       */
      const ctx = await givenProcessingRefund();
      await db()
        .update(refund)
        .set({ status: 'pending', settledAt: null })
        .where(eq(refund.id, ctx.refundRow.id));

      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );

      expect(response.body).toEqual({ status: 'ignored', reason: 'illegal_transition' });
      expect((await refundRow(ctx.refundNumber)).status).toBe('pending');
    });

    it('never settles a manual COD refund from a webhook', async () => {
      const ctx = await givenDeliveredPaidOrder({ method: 'cod' });
      const raised = await refundOrder(ctx.orderNumber, '100.0000');
      expect(raised.status).toBe(201);
      expect(raised.body.refund.mode).toBe('manual');
      expect(raised.body.refund.status).toBe('pending');

      const row = await refundRow(raised.body.refund.refundNumber as string);

      /* Park it in `processing` so ONLY the mode guard can be what refuses this. */
      await db().update(refund).set({ status: 'processing' }).where(eq(refund.id, row.id));

      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: row.id,
          amountMinor: row.amountMinor,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ignored', reason: 'unsupported_mode' });

      const after = await refundRow(raised.body.refund.refundNumber as string);
      expect(after.status).toBe('processing');
      expect(after.settledAt).toBeNull();
      /* No gateway was ever asked to refund a COD order. */
      expect(refundCalls.some((c) => c.body.includes(row.id))).toBe(false);
    });

    it('ignores refund events that are not terminal outcomes', async () => {
      const ctx = await givenProcessingRefund();

      for (const event of ['refund.created', 'refund.speed_changed'] as const) {
        const response = await postWebhook(
          refundEvent({
            event,
            reference: ctx.refundRow.id,
            amountMinor: ctx.refundRow.amountMinor,
          }),
        );
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: 'ignored', reason: 'unsupported_event' });
      }

      expect((await refundRow(ctx.refundNumber)).status).toBe('processing');
    });
  });

  /* ══ 4. Correlation, tenancy and the legacy gap ════════════════════════ */

  describe('correlation', () => {
    it('sends our refund id as a note so the notification can name it', async () => {
      const ctx = await givenProcessingRefund();

      const call = refundCalls.find((c) => c.body.includes(ctx.refundRow.id));
      expect(call).toBeDefined();
      expect(JSON.parse(call!.body)).toMatchObject({
        amount: ctx.refundRow.amountMinor,
        notes: { refund_id: ctx.refundRow.id },
      });
    });

    it('leaves a legacy processing refund with no note unresolved', async () => {
      const ctx = await givenProcessingRefund();

      /* Exactly what a refund raised before Increment 60 looks like: no correlating note. */
      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: null,
          amountMinor: ctx.refundRow.amountMinor,
          notes: {},
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ignored', reason: 'unsupported_event' });

      const after = await refundRow(ctx.refundNumber);
      expect(after.status).toBe('processing');
      expect(after.settledAt).toBeNull();
    });

    it('resolves exactly the refund named, and takes its tenant from the stored row', async () => {
      const mine = await givenProcessingRefund();
      const other = await givenProcessingRefund();

      const response = await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: other.refundRow.id,
          amountMinor: other.refundRow.amountMinor,
        }),
      );
      expect(response.body).toEqual({ status: 'applied', refund: { status: 'succeeded' } });

      const resolved = await refundRow(other.refundNumber);
      expect(resolved.status).toBe('succeeded');
      /*
       * The tenant was never in the request — the route is not store-scoped and the body has no
       * store field — so it can only have come off the row itself, unchanged.
       */
      expect(resolved.storeId).toBe(other.refundRow.storeId);
      expect(resolved.storeId).toBe(storeId);

      /* The unnamed refund is untouched: a reference resolves one row and only one. */
      expect((await refundRow(mine.refundNumber)).status).toBe('processing');
    });

    it('cannot be made to resolve anything by rewriting the unsigned event-id header', async () => {
      const ctx = await givenProcessingRefund();
      const body = refundEvent({
        event: 'refund.processed',
        reference: ctx.refundRow.id,
        amountMinor: ctx.refundRow.amountMinor,
        refundId: 'rfnd_header_test',
      });

      const first = await postWebhook(body, { eventId: 'evt_attacker_chosen' });
      expect(first.body).toEqual({ status: 'applied', refund: { status: 'succeeded' } });

      /*
       * Same body, same signature, a DIFFERENT event id — the header is not covered by the
       * HMAC, so an attacker can set it freely. It buys nothing: the state machine, not the
       * header, is what makes a second resolution impossible.
       */
      const replayed = await postWebhook(body, { eventId: 'evt_attacker_chosen_2' });
      expect(replayed.body).toEqual({ status: 'ignored', reason: 'already_terminal' });

      expect(await refundsOf(ctx.orderId)).toHaveLength(1);
    });
  });

  /* ══ 5. What must never change ═════════════════════════════════════════ */

  describe('invariants', () => {
    it('never writes payment.status on any webhook resolution path', async () => {
      const ctx = await givenProcessingRefund();
      const before = await paymentOf(ctx.orderId);
      expect(before.status).toBe('succeeded');

      await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );

      const after = await paymentOf(ctx.orderId);
      expect(after.status).toBe('succeeded');
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.providerTransactionId).toEqual(before.providerTransactionId);
    });

    it('keeps the claimed total within the captured amount after resolution', async () => {
      const ctx = await givenProcessingRefund('100.0000');

      await postWebhook(
        refundEvent({
          event: 'refund.processed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );

      const detail = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/payment`)
        .set(asStaff());
      expect(detail.status).toBe(200);

      const balance = detail.body.payment.refundBalance;
      /* Claimed is now settled, and the remainder is derived from the order's own total. */
      expect(balance.refunded).toBe('100.0000');
      expect(balance.claimed).toBe('100.0000');
      expect(balance.captured).toBe(ctx.grandTotal);
      expect(balance.remaining).toBe((Number.parseFloat(ctx.grandTotal) - 100).toFixed(4));
    });

    it('releases balance when the provider reports a terminal failure', async () => {
      const ctx = await givenProcessingRefund('100.0000');

      await postWebhook(
        refundEvent({
          event: 'refund.failed',
          reference: ctx.refundRow.id,
          amountMinor: ctx.refundRow.amountMinor,
        }),
      );

      const detail = await api()
        .get(`/api/v1/admin/orders/${ctx.orderNumber}/payment`)
        .set(asStaff());

      /* A failed attempt consumes nothing: the money never moved and may be refunded again. */
      expect(detail.body.payment.refundBalance.claimed).toBe('0.0000');
      expect(detail.body.payment.refundBalance.refunded).toBe('0.0000');
      expect(detail.body.payment.refundBalance.remaining).toBe(ctx.grandTotal);
    });
  });
});
