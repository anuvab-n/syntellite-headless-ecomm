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
 * Parallel to `mail/mailer.ts`: an adapter for an external system, at the top level
 * rather than inside a domain module, because a domain module that imported a gateway SDK could
 * no longer be tested without one.
 *
 * ## No SDK dependency, deliberately
 *
 * The approved integration needs three provider operations, and each is one function call
 * against Node's standard library:
 *
 *  - **Create an order** — a single authenticated `POST /v1/orders`. `fetch` is global in
 *    Node 22 (the engine this project pins), so there is nothing to install.
 *  - **Refund a charge** — a single authenticated `POST /v1/payments/{id}/refund`.
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
 * lifecycle: there is no separate authorisation, so `payment.authorized` is not acted on.
 *
 * `refund.processed` and `refund.failed` are the refund lifecycle's two TERMINAL events, added
 * by Increment 60 to resolve attempts left `processing` by an unanswered provider call.
 * Razorpay also emits `refund.created` and `refund.speed_changed`; neither is an outcome —
 * `created` merely acknowledges the request we already recorded, and `speed_changed` is a
 * delivery-time detail — so both stay `unsupported` rather than being read as confirmation.
 *
 * Every other event — settlements, disputes, subscriptions — is out of the approved scope and
 * is answered as `unsupported` rather than guessed at.
 */
const EVENT_CAPTURED = 'payment.captured';
const EVENT_FAILED = 'payment.failed';
const EVENT_REFUND_PROCESSED = 'refund.processed';
const EVENT_REFUND_FAILED = 'refund.failed';

/**
 * The key our own refund id travels under, inside the refund entity's `notes`.
 *
 * `notes` is a provider-persisted key/value map that Razorpay echoes back on every refund
 * entity, including the one inside a webhook payload. It is the ONLY field in that entity we
 * control, which is what makes it the correlation mechanism: the `x-razorpay-idempotency`
 * header we also send is never echoed, and the refund id Razorpay assigns is unknown to us
 * precisely in the `processing` case this exists to resolve.
 */
const REFUND_NOTE_KEY = 'refund_id';

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

/**
 * The domain-facing failure code for a refund Razorpay reports as terminally failed.
 *
 * Distinct from `declined`, which is about a charge, and from the `http_4xx` codes the refund
 * REST call produces: those say our REQUEST was refused, this says an accepted refund did not
 * complete at the bank. An operator reading the column needs to tell those apart.
 */
const FAILURE_CODE_REFUND_FAILED = 'provider_refund_failed';

/* ── The port this adapter satisfies ─────────────────────────────────────── */

/**
 * What the payments module asked for. Declared there, restated here as a structural type so
 * this file imports nothing from a domain module — `no-cross-module-imports` is satisfied by
 * construction, and the compiler still checks the two agree where `container.ts` joins them.
 */
/**
 * What asking the provider to refund a charge told us.
 *
 * **Three outcomes, not two.** `unknown` is the one this type exists for: a timeout, an
 * aborted connection, a 5xx, or a body that did not parse all mean the request may or may not
 * have moved money. Collapsing that into `failed` would invite a retry that refunds twice, and
 * collapsing it into `succeeded` would close a return against money that never moved. The
 * caller persists it as its own state and resolves it out of band.
 *
 * A 4xx from the provider IS evidence of failure — the request was understood and refused — so
 * that maps to `failed` with the provider's normalised code. A 5xx is not evidence of
 * anything, and maps to `unknown`.
 */
export type RazorpayRefundResult =
  | { readonly kind: 'succeeded'; readonly providerRefundId: string }
  | { readonly kind: 'failed'; readonly failureCode: string | null }
  | { readonly kind: 'unknown' };

export type RazorpayGateway = {
  readonly provider: 'razorpay';
  /**
   * Refund a CHARGE, addressed by the provider's payment id (`pay_…`).
   *
   * Not `providerRef` — that is the Razorpay ORDER (`order_…`), which cannot be refunded and
   * would be rejected by the API. The distinction is the reason `payment.provider_transaction_id`
   * exists as a separate column, and getting it wrong here would be a refund issued against the
   * wrong object.
   *
   * `reference` is sent as Razorpay's `Idempotency-Key` header, so a retry of a request whose
   * answer was lost returns the ORIGINAL refund rather than creating a second one. That is what
   * makes a `processing` row recoverable instead of merely recorded.
   */
  refund(params: {
    providerTransactionId: string;
    amountMinor: number;
    reference: string;
  }): Promise<RazorpayRefundResult>;
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
        /**
         * Razorpay's id for the CHARGE (`pay_…`), from `payload.payment.entity.id`.
         *
         * Distinct from `providerRef`, which is the ORDER (`order_…`) this event is matched
         * against, and from `providerEventId`, which is the delivery header. Nullable because a
         * notification is free to omit it and a missing charge id must not cost us the
         * transition the event describes.
         */
        readonly providerTransactionId: string | null;
        readonly outcome: 'succeeded' | 'failed';
        readonly failureCode: string | null;
      }
    /**
     * A terminal REFUND notification. Increment 60.
     *
     * Deliberately a distinct variant rather than a flag on `event`: a refund event resolves a
     * different aggregate, against a different state machine, and merging the two would let a
     * future edit apply a refund outcome to a payment row. The discriminant makes that
     * unexpressible.
     */
    | {
        readonly kind: 'refund_event';
        readonly providerEventId: string;
        readonly eventType: string;
        /** Razorpay's id for the refund (`rfnd_…`), from `payload.refund.entity.id`. */
        readonly providerRefundId: string;
        /**
         * OUR refund id, read back out of `payload.refund.entity.notes.refund_id`.
         *
         * The lookup key, and the only one. It is a value this system generated and sent; a
         * notification that does not carry one names no attempt we can safely resolve.
         */
        readonly refundReference: string;
        /** The provider's figure, in minor units, checked against the frozen row by the caller. */
        readonly amountMinor: number | null;
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
type RefundEntity = {
  readonly refundId: string | null;
  readonly reference: string | null;
  readonly amountMinor: number | null;
};

/**
 * `payload.refund.entity`, narrowed to the three fields Increment 60 reads.
 *
 * Returned as `null` for every event that is not about a refund, which is the ordinary case:
 * a `payment.captured` body has no `payload.refund` at all.
 */
function readRefundEntity(parsed: unknown): RefundEntity | null {
  const entity = (parsed as { payload?: { refund?: { entity?: unknown } } }).payload?.refund
    ?.entity;
  if (typeof entity !== 'object' || entity === null) return null;

  const fields = entity as { id?: unknown; amount?: unknown; notes?: unknown };

  /*
   * `notes` is a free-form map. Ours is the one key we put there; anything else the merchant or
   * a future increment adds is ignored rather than merged, and a `notes` that is absent, not an
   * object, or carries a non-string value yields `null` — which the caller turns into
   * "unmatchable", never into a guess.
   */
  const notes = fields.notes;
  const reference =
    typeof notes === 'object' && notes !== null
      ? readBoundedString((notes as Record<string, unknown>)[REFUND_NOTE_KEY])
      : null;

  /*
   * Minor units, as an integer. Anything else — a float, a string, a negative, a value beyond
   * safe-integer range — becomes `null`, and the caller refuses to resolve rather than
   * comparing a number it cannot trust against money.
   */
  const rawAmount = fields.amount;
  const amountMinor =
    typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) && rawAmount > 0
      ? rawAmount
      : null;

  return { refundId: readBoundedString(fields.id), reference, amountMinor };
}

function readEnvelope(raw: Buffer): {
  event: string;
  orderId: string | null;
  paymentId: string | null;
  refund: RefundEntity | null;
} | null {
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
  const fields =
    typeof entity === 'object' && entity !== null
      ? (entity as { order_id?: unknown; id?: unknown })
      : {};

  /*
   * `entity.id` is Razorpay's id for the CHARGE — `pay_…`, the one its dashboard shows. Read
   * beside `order_id` rather than in a second pass, so the two can never be taken from
   * different entities.
   *
   * Bounded at the column's width HERE, at the adapter boundary, rather than trusted to be
   * short: the body is the provider's, `provider_transaction_id` is `varchar(255)`, and a
   * longer value must become "no charge id" rather than an insert that fails inside a webhook
   * transaction and asks the provider to retry something that can never succeed.
   */
  const paymentId = fields.id;

  return {
    event,
    orderId: readBoundedString(fields.order_id),
    paymentId: readBoundedString(paymentId),
    refund: readRefundEntity(parsed),
  };
}

/** A non-empty string no wider than the columns these values land in, or `null`. */
function readBoundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : null;
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
     * Refund a charge.
     *
     * `POST /v1/payments/{pay_id}/refund` with `{ amount }` in minor units — which arrives
     * already converted by `money.ts`. **This file does not multiply by 100**, for the same
     * reason `createOrder` does not: a hard-coded factor here would be wrong for a zero-decimal
     * currency and would put a second, unreviewed rounding rule beside the documented one.
     *
     * The three-way return is the contract. Note which branch each failure takes:
     *
     *  - **4xx** — the provider understood and refused. That is evidence, so `failed`.
     *  - **5xx** — the provider broke. That is not evidence of anything, so `unknown`.
     *  - **timeout / abort / network** — the request may have been received and processed.
     *    `unknown`.
     *  - **200 with an unusable body** — something happened and we cannot say what. `unknown`,
     *    not `failed`: a refund id we failed to parse is still a refund that may exist.
     */
    async refund(params) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetchImpl(
          `${API_BASE}/payments/${encodeURIComponent(params.providerTransactionId)}/refund`,
          {
            method: 'POST',
            headers: {
              authorization: authHeader(),
              'content-type': 'application/json',
              /* The provider's own idempotency, so a lost answer does not become a second refund. */
              'x-razorpay-idempotency': params.reference,
            },
            /*
             * `notes` carries OUR refund id into the provider's copy of the refund, and
             * Razorpay echoes it on every later refund entity — including the one inside a
             * `refund.processed` / `refund.failed` webhook. That is what lets Increment 60
             * resolve an attempt whose `provider_refund_id` we never learned, which is exactly
             * the `processing` rows this whole mechanism exists for.
             *
             * The idempotency header above cannot serve: Razorpay does not echo headers.
             */
            body: JSON.stringify({
              amount: params.amountMinor,
              notes: { [REFUND_NOTE_KEY]: params.reference },
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          /*
           * Status only, never the body. A Razorpay error body echoes the request, and the
           * request is about money; there is no version of logging it that is safe by default.
           */
          logger.error(
            { provider: 'razorpay', operation: 'refund', status: response.status },
            'payment_provider_request_failed',
          );

          /*
           * The one place in this file where the status CLASS changes the domain answer. A
           * refusal is a fact; a server fault is an absence of one.
           */
          if (response.status >= 400 && response.status < 500) {
            return { kind: 'failed', failureCode: `http_${String(response.status)}` };
          }
          return { kind: 'unknown' };
        }

        const body: unknown = await response.json();
        const id =
          typeof body === 'object' && body !== null ? (body as { id?: unknown }).id : undefined;

        if (typeof id !== 'string' || id.length === 0) {
          logger.error(
            { provider: 'razorpay', operation: 'refund' },
            'payment_provider_response_unusable',
          );
          return { kind: 'unknown' };
        }

        return { kind: 'succeeded', providerRefundId: id };
      } catch (err) {
        /* Network failure, timeout, abort. The error itself is safe — it carries no body. */
        logger.error(
          { err, provider: 'razorpay', operation: 'refund' },
          'payment_provider_unreachable',
        );
        return { kind: 'unknown' };
      } finally {
        clearTimeout(timer);
      }
    },

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

      /*
       * Refunds first, and they return before the payment branch can see them. Increment 60.
       *
       * A refund notification that cannot be correlated — no `notes.refund_id`, no `rfnd_` id —
       * is `unsupported`, NOT `malformed`: the body is perfectly well-formed, it simply names
       * no attempt of ours. `malformed` would be a `400`, and a `400` asks Razorpay to retry
       * something no redelivery can fix. This is the case a refund raised before Increment 60
       * lands in, and it is answered as an acknowledged no-op by design.
       */
      if (envelope.event === EVENT_REFUND_PROCESSED || envelope.event === EVENT_REFUND_FAILED) {
        const entity = envelope.refund;
        if (entity === null || entity.reference === null || entity.refundId === null) {
          return { kind: 'unsupported', providerEventId: eventId, eventType: envelope.event };
        }

        const refundSucceeded = envelope.event === EVENT_REFUND_PROCESSED;
        return {
          kind: 'refund_event',
          providerEventId: eventId,
          eventType: envelope.event,
          providerRefundId: entity.refundId,
          refundReference: entity.reference,
          amountMinor: entity.amountMinor,
          outcome: refundSucceeded ? 'succeeded' : 'failed',
          failureCode: refundSucceeded ? null : FAILURE_CODE_REFUND_FAILED,
        };
      }

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
        providerTransactionId: envelope.paymentId,
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
    /**
     * Rejects rather than answering `failed`.
     *
     * `failed` would be a claim about what the provider decided, and there is no provider. The
     * caller turns this into a `503` and writes no refund row, which leaves the return exactly
     * where it was — recoverable once credentials are configured. Answering `unknown` would be
     * worse still: it would strand the refund in a reconciliation state against a gateway that
     * was never contacted.
     */
    refund() {
      logger.error({ provider: 'razorpay' }, 'payment_provider_not_configured');
      return Promise.reject(new DependencyUnavailable('payment provider'));
    },
    parseVerifiedWebhook() {
      logger.warn({ provider: 'razorpay' }, 'payment_webhook_rejected_provider_not_configured');
      return { kind: 'invalid_signature' };
    },
  };
}
