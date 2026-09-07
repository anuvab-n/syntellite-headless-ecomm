import { createHmac, timingSafeEqual } from 'node:crypto';

import { DependencyUnavailable } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

/**
 * The Razorpay adapter.
 *
 * **The only file in `src/` that knows Razorpay exists.** Everything provider-specific lives
 * here: the REST endpoint, the auth scheme, the JSON shapes, the event names, the signature
 * algorithm and the mapping from Razorpay's vocabulary to the domain's. The payments module
 * declares a port (`PaymentGateway`) and never names this file; `container.ts` adapts one onto
 * the other. Swapping providers is a new file in a sibling directory and one line in the
 * composition root.
 *
 * Parallel to `redis/rate-limiter.ts`: an adapter for an external system, at the top level
 * rather than inside a domain module, because a domain module that imported a gateway SDK could
 * no longer be tested without one.
 *
 * ## No SDK dependency, deliberately
 *
 * The approved integration needs exactly two provider operations, and both are one function
 * call against Node's standard library:
 *
 *  - **Create an order** — a single authenticated `POST /v1/orders`. `fetch` is global in
 *    Node 22 (the engine this project pins), so there is nothing to install.
 *  - **Verify a webhook** — `HMAC-SHA256(rawBody, webhookSecret)` compared in constant time,
 *    which is `node:crypto`.
 *
 * The official SDK would add a dependency tree to wrap two calls, and its order-creation helper
 * is a thin wrapper over the same POST. `not-to-dev-dep` and the project's rule on dependencies
 * both point the same way: the minimum required dependency here is none.
 *
 * ## What this file must never do
 *
 * It never logs the key secret, the webhook secret, a signature, or a request or response body.
 * A gateway response can carry instrument details (`method`, `card`, `vpa`, `bank`), and the
 * moment one of those reaches a log line it is in a store read by more people than the
 * database. What is logged is the operation, the outcome, and — on a webhook — the provider
 * event id, which is an opaque identifier by design.
 */

/** Razorpay's API host. Test and live mode are selected by the key pair, not by the URL. */
const API_BASE = 'https://api.razorpay.com/v1';

/** The header Razorpay signs the body with. */
const SIGNATURE_HEADER = 'x-razorpay-signature';

/** The header carrying Razorpay's own id for the notification. */
const EVENT_ID_HEADER = 'x-razorpay-event-id';

/** How long to wait on the provider before giving up. A checkout must not hang on a gateway. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Razorpay event names this integration acts on.
 *
 * `payment.captured` is success and `payment.failed` is failure, for the approved single-step
 * lifecycle: there is no separate authorisation, so `payment.authorized` is not acted on. Every
 * other event — refunds, settlements, disputes, subscriptions — is out of the approved scope
 * and is answered as `unsupported` rather than guessed at.
 */
const EVENT_CAPTURED = 'payment.captured';
const EVENT_FAILED = 'payment.failed';

/**
 * The domain-facing failure code for a declined payment.
 *
 * One value, on purpose. Razorpay's `error_code` vocabulary is the provider's, it changes
 * without our release cycle, and echoing it would put a gateway's strings into a column the
 * domain has to reason about. An operator who needs the provider's own reason has the event id
 * and the provider's dashboard; what the domain needs to know is that the charge did not
 * succeed.
 */
const FAILURE_CODE_DECLINED = 'declined';

/* ── The port this adapter satisfies ─────────────────────────────────────── */

/**
 * What the payments module asked for. Declared there, restated here as a structural type so
 * this file imports nothing from a domain module — `no-cross-module-imports` is satisfied by
 * construction, and the compiler still checks the two agree where `container.ts` joins them.
 */
export type RazorpayGateway = {
  readonly provider: 'razorpay';
  createOrder(params: {
    amountMinor: number;
    currency: string;
    reference: string;
  }): Promise<{ providerRef: string; publicKey: string | null }>;
  parseVerifiedWebhook(params: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | undefined>>;
  }):
    | { readonly kind: 'invalid_signature' }
    | { readonly kind: 'malformed' }
    | { readonly kind: 'unsupported'; readonly providerEventId: string; readonly eventType: string }
    | {
        readonly kind: 'event';
        readonly providerEventId: string;
        readonly eventType: string;
        readonly providerRef: string;
        readonly outcome: 'succeeded' | 'failed';
        readonly failureCode: string | null;
      };
};

export type RazorpayCredentials = {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
};

/* ── Signature verification ──────────────────────────────────────────────── */

/**
 * Verify Razorpay's signature over the EXACT bytes it signed.
 *
 * The `Buffer` matters. `app.ts` mounts the webhook router with `express.raw` **before**
 * `express.json()` for this one reason: re-serialising parsed JSON produces different bytes —
 * key order, whitespace, unicode escapes — and the HMAC would not match. Anything that touches
 * the body before this function runs breaks verification in a way that looks like a provider
 * fault.
 *
 * `timingSafeEqual` rather than `===`, and length-checked first because it throws on a length
 * mismatch. A string comparison here leaks, byte by byte, how much of a forged signature was
 * right.
 */
function verifySignature(params: {
  rawBody: Buffer;
  signature: string;
  webhookSecret: string;
}): boolean {
  const expected = createHmac('sha256', params.webhookSecret).update(params.rawBody).digest();

  let received: Buffer;
  try {
    received = Buffer.from(params.signature, 'hex');
  } catch {
    return false;
  }

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/* ── Event parsing ───────────────────────────────────────────────────────── */

/**
 * Razorpay's webhook envelope, narrowed to the fields this integration reads.
 *
 * Hand-written rather than trusted: the body is attacker-reachable until the signature has been
 * checked, and even afterwards a provider is free to add fields. Reading exactly what is needed
 * means an unexpected shape becomes `malformed` instead of a runtime crash inside a handler.
 */
function readEnvelope(raw: Buffer): { event: string; orderId: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== 'string' || event.length === 0) return null;

  /*
   * The order id lives at `payload.payment.entity.order_id`. Absent on events that are not
   * about a payment, which is fine — those resolve to `unsupported` and never need it.
   */
  const entity = (parsed as { payload?: { payment?: { entity?: unknown } } }).payload?.payment
    ?.entity;
  const orderId =
    typeof entity === 'object' && entity !== null
      ? (entity as { order_id?: unknown }).order_id
      : undefined;

  return { event, orderId: typeof orderId === 'string' && orderId.length > 0 ? orderId : null };
}

/* ── The adapter ─────────────────────────────────────────────────────────── */

export function createRazorpayGateway(deps: {
  credentials: RazorpayCredentials;
  logger: Logger;
  /** Injected so tests can drive the adapter without a network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}): RazorpayGateway {
  const { credentials, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  /** `Basic base64(key_id:key_secret)`. Built per call so the secret is never a module global. */
  const authHeader = (): string =>
    `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString('base64')}`;

  return {
    provider: 'razorpay',

    /**
     * Create the Razorpay order the client-side checkout needs.
     *
     * `amountMinor` arrives already converted by `money.ts`'s `toMinorUnits` — the one rounding
     * boundary in the system. **This file does not multiply by 100.** A hard-coded factor here
     * would be wrong for a zero-decimal currency and would put a second, unreviewed rounding
     * rule next to the one `money.ts` documents.
     *
     * Returns the publishable `key_id` alongside the order id because the browser checkout
     * needs both. That key is designed to be public; the secret never leaves this closure.
     */
    async createOrder(params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetchImpl(`${API_BASE}/orders`, {
          method: 'POST',
          headers: {
            authorization: authHeader(),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            amount: params.amountMinor,
            currency: params.currency,
            receipt: params.reference,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          /*
           * Status only. A Razorpay error body echoes the request, and the request is about
           * money; there is no version of logging it that is safe by default.
           */
          logger.error(
            { provider: 'razorpay', operation: 'create_order', status: response.status },
            'payment_provider_request_failed',
          );
          throw new DependencyUnavailable('payment provider');
        }

        const body: unknown = await response.json();
        const id =
          typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;

        if (typeof id !== 'string' || id.length === 0) {
          logger.error(
            { provider: 'razorpay', operation: 'create_order' },
            'payment_provider_response_unusable',
          );
          throw new DependencyUnavailable('payment provider');
        }

        return { providerRef: id, publicKey: credentials.keyId };
      } catch (err) {
        if (err instanceof DependencyUnavailable) throw err;
        /* Network failure, timeout, abort. The error itself is safe — it carries no body. */
        logger.error(
          { err, provider: 'razorpay', operation: 'create_order' },
          'payment_provider_unreachable',
        );
        throw new DependencyUnavailable('payment provider');
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Verify, then parse. **One method, so parsed data cannot be obtained without verifying.**
     *
     * Splitting this into `verify()` and `parse()` would make the insecure order expressible,
     * and a future edit that called only the second would compile. Returning a discriminated
     * union instead means the caller has to handle `invalid_signature` to get anything at all.
     *
     * The event id comes from the `x-razorpay-event-id` header — the provider's own identifier
     * for the notification, which is what the approved scope names as the dedupe key. That
     * header is not itself covered by the signature, so it is not trusted to be *unique* on its
     * own: the state machine and the row lock are what make a second transition impossible, and
     * `uq_payment_event_provider` is what makes a second history row impossible. Neither
     * defence relies on the header being honest.
     */
    parseVerifiedWebhook(params) {
      const signature = params.headers[SIGNATURE_HEADER];
      if (typeof signature !== 'string' || signature.length === 0) {
        return { kind: 'invalid_signature' };
      }

      if (
        !verifySignature({
          rawBody: params.rawBody,
          signature,
          webhookSecret: credentials.webhookSecret,
        })
      ) {
        return { kind: 'invalid_signature' };
      }

      const eventId = params.headers[EVENT_ID_HEADER];
      if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 255) {
        return { kind: 'malformed' };
      }

      const envelope = readEnvelope(params.rawBody);
      if (envelope === null) return { kind: 'malformed' };

      if (envelope.event !== EVENT_CAPTURED && envelope.event !== EVENT_FAILED) {
        return { kind: 'unsupported', providerEventId: eventId, eventType: envelope.event };
      }

      /* A payment event with no order id cannot be matched to a payment row. */
      if (envelope.orderId === null) return { kind: 'malformed' };

      const succeeded = envelope.event === EVENT_CAPTURED;
      return {
        kind: 'event',
        providerEventId: eventId,
        eventType: envelope.event,
        providerRef: envelope.orderId,
        outcome: succeeded ? 'succeeded' : 'failed',
        failureCode: succeeded ? null : FAILURE_CODE_DECLINED,
      };
    },
  };
}

/**
 * The gateway used when Razorpay is not configured.
 *
 * Online payment then answers `503 DEPENDENCY_UNAVAILABLE` and every webhook is rejected,
 * which is the honest outcome: the credentials are `.optional()` in `config.ts`, so a
 * deployment without them is a supported state, and a store in that state genuinely cannot take
 * an online payment. **COD is unaffected** — it never reaches a gateway — so an unconfigured
 * deployment still has a working payment method rather than none.
 *
 * Deliberately not a fake that fabricates order ids: a stub that returned a plausible reference
 * would let a misconfigured production deployment report success for a charge nobody made.
 */
export function createUnconfiguredGateway(deps: { logger: Logger }): RazorpayGateway {
  const { logger } = deps;
  return {
    provider: 'razorpay',
    createOrder() {
      logger.error({ provider: 'razorpay' }, 'payment_provider_not_configured');
      return Promise.reject(new DependencyUnavailable('payment provider'));
    },
    parseVerifiedWebhook() {
      logger.warn({ provider: 'razorpay' }, 'payment_webhook_rejected_provider_not_configured');
      return { kind: 'invalid_signature' };
    },
  };
}
