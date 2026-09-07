import { createHmac } from 'node:crypto';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { DependencyUnavailable } from '../../shared/errors.js';
import { money, toMinorUnits } from '../../shared/money.js';
import { createRazorpayGateway, createUnconfiguredGateway } from '../gateway.js';

/**
 * The Razorpay adapter.
 *
 * No database and no network: `fetchImpl` is injected. What is tested is the part that would be
 * a security bug if it were wrong — signature verification over exact bytes — and the part that
 * would be a money bug: the minor-unit conversion never happening here.
 *
 * The signature tests use the REAL HMAC implementation rather than a stubbed verifier. A fake
 * that returned `true` would let every one of them pass while the production path accepted
 * anything, which is the failure mode this file exists to rule out.
 */
describe('razorpay gateway', () => {
  const CREDENTIALS = {
    keyId: 'rzp_test_publishable',
    keySecret: 'the-api-secret-never-logged',
    webhookSecret: 'the-webhook-secret-never-logged',
  };

  /** Captures every log line so the secret-hygiene assertions can read them. */
  function recordingLogger(): { logger: pino.Logger; lines: string[] } {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (line: string) => void lines.push(line) });
    return { logger, lines };
  }

  function sign(body: string, secret = CREDENTIALS.webhookSecret): string {
    return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
  }

  function capturedBody(orderId = 'order_ABC123'): string {
    return JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_XYZ', order_id: orderId } } },
    });
  }

  function gateway(fetchImpl?: typeof fetch) {
    const { logger, lines } = recordingLogger();
    return {
      lines,
      gw: createRazorpayGateway({
        credentials: CREDENTIALS,
        logger,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      }),
    };
  }

  /* ── Order creation ────────────────────────────────────────────────────── */

  describe('createOrder', () => {
    it('sends the amount it is given, and never multiplies by 100 itself', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ id: 'order_CREATED' }), { status: 200 }),
      ) as unknown as typeof fetch;

      const { gw } = gateway(fetchImpl);

      /*
       * 2698.20 INR is 269820 paise. The conversion happens in `money.ts` — the one rounding
       * boundary in the system — and the adapter must pass that integer through untouched. If
       * this file multiplied by 100 the request would carry 26982000.
       */
      const amountMinor = toMinorUnits(money('2698.2000', 'INR'));
      expect(amountMinor).toBe(269820);

      const result = await gw.createOrder({
        amountMinor,
        currency: 'INR',
        reference: 'ORD-20260904-7QK4M2',
      });

      expect(result).toEqual({ providerRef: 'order_CREATED', publicKey: CREDENTIALS.keyId });

      const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(String((call?.[1] as { body: string }).body)) as {
        amount: number;
        currency: string;
        receipt: string;
      };
      expect(sent.amount).toBe(269820);
      expect(sent.currency).toBe('INR');
      expect(sent.receipt).toBe('ORD-20260904-7QK4M2');
    });

    /**
     * A zero-decimal currency, which is the case a hard-coded x100 gets wrong.
     *
     * 5000 JPY is 5000 minor units, not 500000. `money.ts` knows that because
     * `CURRENCY_MINOR_UNITS` records the exponent; a factor written into the adapter could not.
     */
    it('is correct for a zero-decimal currency', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ id: 'order_JPY' }), { status: 200 }),
      ) as unknown as typeof fetch;
      const { gw } = gateway(fetchImpl);

      await gw.createOrder({
        amountMinor: toMinorUnits(money('5000.0000', 'JPY')),
        currency: 'JPY',
        reference: 'ORD-20260904-AAAAAA',
      });

      const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const sent = JSON.parse(String((call?.[1] as { body: string }).body)) as { amount: number };
      expect(sent.amount).toBe(5000);
    });

    it('authenticates with the key pair and never logs either secret', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ id: 'order_X' }), { status: 200 }),
      ) as unknown as typeof fetch;
      const { gw, lines } = gateway(fetchImpl);

      await gw.createOrder({ amountMinor: 100, currency: 'INR', reference: 'r' });

      const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = (call?.[1] as { headers: Record<string, string> }).headers;
      const expected = `Basic ${Buffer.from(
        `${CREDENTIALS.keyId}:${CREDENTIALS.keySecret}`,
      ).toString('base64')}`;
      expect(headers['authorization']).toBe(expected);

      const logged = lines.join('\n');
      expect(logged).not.toContain(CREDENTIALS.keySecret);
      expect(logged).not.toContain(CREDENTIALS.webhookSecret);
      expect(logged).not.toContain(expected);
    });

    it('turns a provider error into DependencyUnavailable without logging the body', async () => {
      const secretish = 'card_number_4111111111111111';
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { description: secretish } }), { status: 400 }),
      ) as unknown as typeof fetch;
      const { gw, lines } = gateway(fetchImpl);

      await expect(
        gw.createOrder({ amountMinor: 100, currency: 'INR', reference: 'r' }),
      ).rejects.toBeInstanceOf(DependencyUnavailable);

      expect(lines.join('\n')).not.toContain(secretish);
    });

    it('turns an unusable response into DependencyUnavailable', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ notAnId: true }), { status: 200 }),
      ) as unknown as typeof fetch;
      const { gw } = gateway(fetchImpl);

      await expect(
        gw.createOrder({ amountMinor: 100, currency: 'INR', reference: 'r' }),
      ).rejects.toBeInstanceOf(DependencyUnavailable);
    });

    it('turns a network failure into DependencyUnavailable', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      const { gw } = gateway(fetchImpl);

      await expect(
        gw.createOrder({ amountMinor: 100, currency: 'INR', reference: 'r' }),
      ).rejects.toBeInstanceOf(DependencyUnavailable);
    });
  });

  /* ── Webhook verification ──────────────────────────────────────────────── */

  describe('parseVerifiedWebhook', () => {
    it('accepts a correctly signed captured event', () => {
      const { gw } = gateway();
      const body = capturedBody();

      const result = gw.parseVerifiedWebhook({
        rawBody: Buffer.from(body, 'utf8'),
        headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_1' },
      });

      expect(result).toEqual({
        kind: 'event',
        providerEventId: 'evt_1',
        eventType: 'payment.captured',
        providerRef: 'order_ABC123',
        outcome: 'succeeded',
        failureCode: null,
      });
    });

    it('maps a failed event to the domain failure code, not the provider string', () => {
      const { gw } = gateway();
      const body = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              order_id: 'order_F',
              error_code: 'BAD_REQUEST_ERROR',
              error_description: 'Your card was declined by the issuing bank',
            },
          },
        },
      });

      const result = gw.parseVerifiedWebhook({
        rawBody: Buffer.from(body, 'utf8'),
        headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_2' },
      });

      expect(result).toMatchObject({ kind: 'event', outcome: 'failed', failureCode: 'declined' });
      /* The provider's own vocabulary must not escape the adapter. */
      expect(JSON.stringify(result)).not.toContain('BAD_REQUEST_ERROR');
      expect(JSON.stringify(result)).not.toContain('issuing bank');
    });

    it('rejects a signature computed with the wrong secret', () => {
      const { gw } = gateway();
      const body = capturedBody();

      const result = gw.parseVerifiedWebhook({
        rawBody: Buffer.from(body, 'utf8'),
        headers: {
          'x-razorpay-signature': sign(body, 'not-the-webhook-secret'),
          'x-razorpay-event-id': 'evt_1',
        },
      });

      expect(result).toEqual({ kind: 'invalid_signature' });
    });

    it('rejects a missing signature', () => {
      const { gw } = gateway();
      const body = capturedBody();

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(body, 'utf8'),
          headers: { 'x-razorpay-event-id': 'evt_1' },
        }),
      ).toEqual({ kind: 'invalid_signature' });
    });

    it('rejects a signature that is not hex, and one of the wrong length', () => {
      const { gw } = gateway();
      const body = capturedBody();

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(body, 'utf8'),
          headers: { 'x-razorpay-signature': 'zzzz', 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'invalid_signature' });

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(body, 'utf8'),
          headers: { 'x-razorpay-signature': 'ab', 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'invalid_signature' });
    });

    /**
     * **The exact-bytes property, stated as a test.**
     *
     * The signature is computed over the original body, then the body is re-serialised through
     * `JSON.parse`/`JSON.stringify` — semantically identical, different bytes. This is precisely
     * what `express.json()` would do if the webhook were mounted behind it, and verification
     * must fail. If this test passes while the raw-body mount is removed, the mount was doing
     * nothing.
     */
    it('fails when the body is re-serialised rather than passed through verbatim', () => {
      const { gw } = gateway();

      /*
       * Pretty-printed, which is what makes the point: this is semantically identical to the
       * compact form but a different sequence of bytes. A provider is free to send whitespace,
       * and whatever it sends is what it signed.
       */
      const original = JSON.stringify(
        {
          event: 'payment.captured',
          payload: { payment: { entity: { order_id: 'order_ABC123' } } },
        },
        null,
        2,
      );
      const signature = sign(original);

      /* What `express.json()` followed by a re-stringify would produce: same JSON, fewer bytes. */
      const reserialised = JSON.stringify(JSON.parse(original));
      expect(reserialised).not.toBe(original);

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(reserialised, 'utf8'),
          headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' },
        }),
      ).toEqual({ kind: 'invalid_signature' });

      /* The verbatim bytes verify, proving the signature itself was correct. */
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(original, 'utf8'),
          headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' },
        }),
      ).toMatchObject({ kind: 'event' });
    });

    it('fails when a single byte of the body is altered', () => {
      const { gw } = gateway();
      const body = capturedBody();
      const signature = sign(body);
      const tampered = body.replace('order_ABC123', 'order_ABC124');

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(tampered, 'utf8'),
          headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' },
        }),
      ).toEqual({ kind: 'invalid_signature' });
    });

    it('reports an unsupported event without acting on it', () => {
      const { gw } = gateway();
      const body = JSON.stringify({ event: 'refund.created', payload: {} });

      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(body, 'utf8'),
          headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_r' },
        }),
      ).toEqual({ kind: 'unsupported', providerEventId: 'evt_r', eventType: 'refund.created' });
    });

    it('reports malformed input rather than throwing', () => {
      const { gw } = gateway();

      /* Not JSON at all. */
      const notJson = 'not json';
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(notJson, 'utf8'),
          headers: { 'x-razorpay-signature': sign(notJson), 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'malformed' });

      /* JSON, but no event name. */
      const noEvent = JSON.stringify({ payload: {} });
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(noEvent, 'utf8'),
          headers: { 'x-razorpay-signature': sign(noEvent), 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'malformed' });

      /* A payment event with no order to match against. */
      const noOrder = JSON.stringify({ event: 'payment.captured', payload: {} });
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(noOrder, 'utf8'),
          headers: { 'x-razorpay-signature': sign(noOrder), 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'malformed' });

      /* Signed, but no event id to deduplicate on. */
      const body = capturedBody();
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from(body, 'utf8'),
          headers: { 'x-razorpay-signature': sign(body) },
        }),
      ).toEqual({ kind: 'malformed' });
    });

    it('checks the signature BEFORE the body is parsed at all', () => {
      const { gw } = gateway();

      /*
       * Unsigned garbage. If parsing came first this would be `malformed`, which would mean the
       * adapter had inspected an unauthenticated body before deciding anything about it.
       */
      expect(
        gw.parseVerifiedWebhook({
          rawBody: Buffer.from('not json', 'utf8'),
          headers: { 'x-razorpay-signature': 'deadbeef', 'x-razorpay-event-id': 'e' },
        }),
      ).toEqual({ kind: 'invalid_signature' });
    });
  });

  /* ── The unconfigured gateway ──────────────────────────────────────────── */

  describe('unconfigured gateway', () => {
    it('refuses to create an order rather than fabricating a reference', async () => {
      const { logger } = recordingLogger();
      const gw = createUnconfiguredGateway({ logger });

      await expect(
        gw.createOrder({ amountMinor: 100, currency: 'INR', reference: 'r' }),
      ).rejects.toBeInstanceOf(DependencyUnavailable);
    });

    it('rejects every webhook', () => {
      const { logger } = recordingLogger();
      const gw = createUnconfiguredGateway({ logger });

      expect(gw.parseVerifiedWebhook({ rawBody: Buffer.from('{}'), headers: {} })).toEqual({
        kind: 'invalid_signature',
      });
    });
  });
});
