import type { Database } from '../../db/client.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import {
  BusinessRuleViolation,
  Conflict,
  InvariantViolation,
  NotFound,
} from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { fromDb, isCurrency, toMinorUnits, type Currency } from '../../shared/money.js';
import { PAYMENT_AUDIT, PAYMENT_RESOURCE } from './payments.events.js';
import type {
  PaymentEventRecord,
  PaymentMethod,
  PaymentRecord,
  PaymentsRepository,
  PaymentStatus,
} from './payments.repository.js';
import { canTransition, isTerminal } from './payments.state.js';

/**
 * The payments service.
 *
 * Two operations a customer can cause — initiate and read — and one a provider can: process a
 * verified notification. Everything else about a payment is history, and history is written by
 * the repository as a side effect of a transition.
 *
 * ## The ports
 *
 * Three, all declared here because this is the consumer. None of them names another module, so
 * `no-cross-module-imports` holds by construction and `container.ts` is the only file that
 * knows what satisfies them.
 *
 * ## What this service does NOT do
 *
 * It never writes `order.status`. §43 fixed that the state spaces stay separate, and the
 * approved scope says it again. It never emits a domain event — the handler registry is empty,
 * and `payments.events.ts` states why. It never sees a card, a UPI handle or a bank detail:
 * those do not reach this process at all, because the customer hands them to the provider.
 */

/* ── Ports ───────────────────────────────────────────────────────────────── */

/**
 * The order being paid for, as this module needs it.
 *
 * Deliberately five fields. A payment needs to know the order exists, that this customer in
 * this store owns it, whether it is payable, and what to charge — and nothing else. Asking for
 * an `OrderView` would couple this module to the shape of another module's read model.
 */
export type PayableOrder = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
  readonly total: string;
};

/**
 * How this module finds an order.
 *
 * **Ownership and tenancy are the port's job, not this service's.** The implementation is
 * expected to answer `null` for an order belonging to another customer or another store, which
 * is why both are parameters and neither is optional. This service never re-derives ownership
 * from anything the client sent.
 */
export type PaymentOrders = {
  findPayable(params: {
    orderNumber: string;
    userId: string;
    storeId: string;
  }): Promise<PayableOrder | null>;
};

/**
 * The payment provider, as a business capability.
 *
 * No Razorpay in the name, in a type, or in a field. `provider` is a string this service
 * records rather than branches on, and `parseVerifiedWebhook` returns a domain outcome rather
 * than a provider event. The adapter in `razorpay/gateway.ts` satisfies this structurally.
 */
export type PaymentGateway = {
  readonly provider: string;
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

/**
 * The idempotency claim this request already holds, completed inside our transaction.
 *
 * Same port shape as `CheckoutIdempotency`, and same reason: completing inside the transaction
 * closes the window §36 describes, where a process death between COMMIT and the completion
 * write leaves a key `in_progress` and a later retry re-executes work that had succeeded.
 */
export type PaymentIdempotency = {
  complete(input: {
    storeId: string;
    userId: string;
    key: string;
    endpoint: string;
    status: number;
    body?: unknown;
  }): Promise<void>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The order already has a payment. A `409`: one payment per order is the approved model, and a
 * second attempt is a conflict with existing state rather than a malformed request.
 */
export class PaymentAlreadyExists extends Conflict {
  override readonly code = 'PAYMENT_ALREADY_EXISTS';
  constructor() {
    super('this order already has a payment');
  }
}

/**
 * The order cannot be paid for. A `422`: well-formed, but the business rules say no.
 *
 * Reached when the order is not in a payable state, or when its total is zero — there is
 * nothing to charge, and `ck_payment_amount_positive` would refuse the row anyway.
 */
export class OrderNotPayable extends BusinessRuleViolation {
  override readonly code = 'ORDER_NOT_PAYABLE';
  constructor(reason: string) {
    super(`this order cannot be paid for: ${reason}`);
  }
}

/* ── Views ───────────────────────────────────────────────────────────────── */

/** A payment and, for the customer-facing read, its transition history. */
export type PaymentView = {
  readonly payment: PaymentRecord;
  readonly events: readonly PaymentEventRecord[];
};

/**
 * What a client needs to hand off to the provider's checkout.
 *
 * Returned only on the initiation that created an `online` payment, and only ever composed of
 * values designed to be public: the provider's name, the provider's reference, and the
 * publishable key. Absent for COD, which has no handoff.
 */
export type PaymentHandoff = {
  readonly provider: string;
  readonly providerRef: string;
  readonly publicKey: string | null;
};

export type PaymentsService = ReturnType<typeof createPaymentsService>;

/**
 * Order statuses a payment may be created against.
 *
 * `placed` only. `cancelled` is deliberately absent — that is what stops a customer cancelling
 * an order and then paying for it, which would leave a cancelled order that had been charged.
 * The status is read inside this service's own transaction, so the check cannot be raced by a
 * cancellation committing between the read and the insert.
 *
 * Named rather than inlined so the exclusion reads as a rule, and so the increment that adds a
 * fulfilment status has an obvious place to decide about it.
 */
const PAYABLE_ORDER_STATUSES: readonly string[] = ['placed'];

export function createPaymentsService(deps: {
  repository: PaymentsRepository;
  orders: PaymentOrders;
  gateway: PaymentGateway;
  idempotency: PaymentIdempotency;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, orders, gateway, idempotency, db, audit, logger } = deps;

  /**
   * The currency, as `money.ts` understands it.
   *
   * A stored currency that is not in `CURRENCY_MINOR_UNITS` is a bug, not a business outcome —
   * `store.supported_currencies` governs what a store may transact in — so it is an
   * `InvariantViolation` rather than a 4xx. Without this the minor-unit conversion would have
   * no exponent to use and would silently pick a default.
   */
  function requireCurrency(value: string): Currency {
    if (!isCurrency(value)) {
      throw new InvariantViolation(`order currency ${value} is not a supported currency`);
    }
    return value;
  }

  return {
    /**
     * Create the payment for an order.
     *
     * Ordered so that the expensive, irreversible step happens last-but-one and the atomic step
     * happens last:
     *
     *  1. Find the order through the port. Ownership and tenancy are enforced there; a miss is
     *     a `404` that reveals nothing about whose order it was.
     *  2. Check it is payable, and that the amount is worth charging.
     *  3. Check no payment exists yet — an optimisation, so a doomed request does not create a
     *     provider-side object. `uq_payment_order` is the actual guarantee.
     *  4. Convert to minor units **once**, through `money.ts`.
     *  5. For `online`, call the provider. **Outside the transaction**: an external HTTP call
     *     holding a row lock is an availability risk, and a gateway that is slow would hold one
     *     for as long as it liked.
     *  6. In ONE transaction: insert the payment, its first history row, the audit entry, and
     *     the idempotency completion.
     *
     * The window between 5 and 6 is real and bounded: a crash there leaves an unpaid provider
     * order with no row in our database. That is harmless — nobody was charged, and the
     * customer's retry is refused by the idempotency key until it expires, after which a fresh
     * attempt creates a fresh provider order. Reconciliation of such orphans is explicitly
     * deferred by the approved scope, and this is the shape that makes the deferral safe: every
     * outcome is "no charge", never "charged but unrecorded".
     */
    async initiate(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
      method: PaymentMethod;
      actor: AuditActor;
      idempotency: { key: string; endpoint: string };
      renderResponse: (view: PaymentView, handoff: PaymentHandoff | null) => unknown;
    }): Promise<{ view: PaymentView; handoff: PaymentHandoff | null }> {
      const order = await orders.findPayable({
        orderNumber: params.orderNumber,
        userId: params.userId,
        storeId: params.storeId,
      });
      if (order === null) throw new NotFound('order');

      if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
        throw new OrderNotPayable(`its status is ${order.status}`);
      }

      const currency = requireCurrency(order.currency);
      const amount = fromDb(order.total, currency);
      const amountMinor = toMinorUnits(amount);
      if (amountMinor <= 0) throw new OrderNotPayable('its total is zero');

      if (await repository.existsForOrder({ orderId: order.id, storeId: params.storeId })) {
        throw new PaymentAlreadyExists();
      }

      /*
       * COD never reaches the gateway. That is the whole of the approved COD behaviour: a
       * payment record, in the payment domain, with no provider and no provider reference. It
       * stays `pending` because nothing in this increment can observe cash changing hands —
       * delivery does not exist yet — and inventing a transition for it would be inventing a
       * workflow the scope forbids.
       */
      const gatewayOrder =
        params.method === 'online'
          ? await gateway.createOrder({
              amountMinor,
              currency,
              reference: order.orderNumber,
            })
          : null;

      try {
        return await withTransaction(db, logger, async () => {
          const created = await repository.createPayment({
            storeId: params.storeId,
            orderId: order.id,
            userId: params.userId,
            method: params.method,
            provider: params.method === 'online' ? 'razorpay' : null,
            providerRef: gatewayOrder?.providerRef ?? null,
            currency,
            amount: amount.amount,
            amountMinor,
            actorUserId: params.userId,
            eventType: PAYMENT_AUDIT.initiated,
          });

          await audit.record({
            storeId: params.storeId,
            actor: params.actor,
            action: PAYMENT_AUDIT.initiated,
            resourceType: PAYMENT_RESOURCE,
            resourceId: created.id,
            metadata: {
              orderNumber: order.orderNumber,
              method: created.method,
              amount: created.amount,
              currency: created.currency,
            },
          });

          /*
           * The history is read back rather than left empty.
           *
           * `createPayment` writes the creation row, so an empty `events` here would make the
           * 201 and a subsequent GET disagree about the same payment — the read would show one
           * transition and the create none. `history` is a required field in the contract, and
           * a required field that is momentarily wrong is worse than one that costs a query.
           * Inside the transaction, so it sees exactly what was just written.
           */
          const events = await repository.listEvents({
            paymentId: created.id,
            storeId: params.storeId,
          });
          const view: PaymentView = { payment: created, events };
          const handoff: PaymentHandoff | null =
            gatewayOrder === null
              ? null
              : {
                  provider: gateway.provider,
                  providerRef: gatewayOrder.providerRef,
                  publicKey: gatewayOrder.publicKey,
                };

          await idempotency.complete({
            storeId: params.storeId,
            userId: params.userId,
            key: params.idempotency.key,
            endpoint: params.idempotency.endpoint,
            status: 201,
            body: params.renderResponse(view, handoff),
          });

          logger.info(
            {
              storeId: params.storeId,
              userId: params.userId,
              paymentId: created.id,
              orderNumber: order.orderNumber,
              method: created.method,
            },
            'payment_initiated',
          );

          return { view, handoff };
        });
      } catch (err) {
        /*
         * `uq_payment_order`. Two concurrent initiations both passed the existence read; this
         * one lost. A conflict, not a fault — and the customer's correct next move is to read
         * the payment that does exist.
         *
         * Matched on the CONSTRAINT, not merely on the SQLSTATE. The other unique index on this
         * table, `uq_payment_provider_ref`, would mean a provider had handed us a reference it
         * had already used — an anomaly nobody should see reported as "you already have a
         * payment". That case falls through and surfaces as a fault, which is what it is.
         */
        if (uniqueViolationConstraint(err) === 'uq_payment_order') {
          logger.info(
            { storeId: params.storeId, orderNumber: params.orderNumber },
            'payment_initiation_lost_race',
          );
          throw new PaymentAlreadyExists();
        }
        throw err;
      }
    },

    /**
     * This customer's payment for this order.
     *
     * Two lookups, both scoped. The order is resolved through the port so that an order
     * belonging to somebody else is a `404` before a payment is ever looked for, and the
     * payment read is scoped by user as well — either predicate alone would be enough, and
     * having both means neither is load-bearing on its own.
     */
    async getForOrder(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
    }): Promise<PaymentView> {
      const order = await orders.findPayable({
        orderNumber: params.orderNumber,
        userId: params.userId,
        storeId: params.storeId,
      });
      if (order === null) throw new NotFound('order');

      const found = await repository.findByOrderId({
        orderId: order.id,
        storeId: params.storeId,
        userId: params.userId,
      });
      if (found === undefined) throw new NotFound('payment');

      const events = await repository.listEvents({
        paymentId: found.id,
        storeId: params.storeId,
      });
      return { payment: found, events };
    },

    /**
     * This customer's own payments, newest first.
     *
     * Store- and user-scoped in the query, so the page can only ever contain rows this customer
     * owns. No history on a list row: a page of payments each carrying its full transition
     * timeline would be a response whose size grows with activity, and a client that wants the
     * timeline reads the one payment.
     */
    async listForUser(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{
      items: readonly (PaymentRecord & { orderNumber: string })[];
      total: number;
      limit: number;
      offset: number;
    }> {
      const page = await repository.listForUser(params);
      return { ...page, limit: params.limit, offset: params.offset };
    },

    /**
     * The status and method of an order's payment, for a caller deciding what to say or do
     * about that order.
     *
     * Exported on the service because the ORDERS module needs it twice — to answer "may this be
     * cancelled?" and to word an invoice correctly — and it must not reach for the payment table
     * itself. The composition root adapts this onto the port orders declares.
     *
     * Status and method together in one call, because both callers want both and a second round
     * trip for a single column would be waste. Nothing else about the payment crosses: not the
     * amount, not the provider, not the provider reference.
     */
    async stateForOrder(params: {
      orderId: string;
      storeId: string;
    }): Promise<{ status: PaymentStatus; method: PaymentMethod } | null> {
      const state = await repository.findStateByOrderId(params);
      return state ?? null;
    },

    /**
     * Process a provider notification.
     *
     * The signature is verified by the adapter before this method sees a single parsed field —
     * `parseVerifiedWebhook` is one call precisely so that ordering cannot be got wrong here.
     *
     * **The store is never taken from the body.** It comes from the payment row that
     * `provider_ref` resolves to, and that reference was written by us when we created the
     * provider-side object. A body claiming a `store_id` is ignored: nothing in this method
     * reads one.
     *
     * Returns what the provider should be told, and the provider is told `200` for every
     * outcome that retrying cannot fix — a duplicate, an unsupported event, an unknown
     * reference, or an event that conflicts with a terminal state. A `5xx` to a gateway means
     * "try again", and answering that to a permanent condition turns one stray event into an
     * indefinite retry loop.
     */
    async handleProviderWebhook(params: {
      rawBody: Buffer;
      headers: Readonly<Record<string, string | undefined>>;
    }): Promise<
      | { readonly outcome: 'invalid_signature' }
      | { readonly outcome: 'malformed' }
      | { readonly outcome: 'ignored'; readonly reason: string }
      | { readonly outcome: 'applied'; readonly status: PaymentStatus }
    > {
      const parsed = gateway.parseVerifiedWebhook({
        rawBody: params.rawBody,
        headers: params.headers,
      });

      if (parsed.kind === 'invalid_signature') {
        /*
         * Recorded outside a transaction, which `AuditOptions` permits for exactly this case:
         * a rejected action has no successful write to join, and a forged webhook is the kind
         * of security event that must leave a trace even though nothing else happened.
         *
         * No signature, no body, no headers in the log. What is useful is that it happened.
         */
        logger.warn({ provider: gateway.provider }, 'payment_webhook_signature_invalid');
        return { outcome: 'invalid_signature' };
      }

      if (parsed.kind === 'malformed') {
        logger.warn({ provider: gateway.provider }, 'payment_webhook_malformed');
        return { outcome: 'malformed' };
      }

      if (parsed.kind === 'unsupported') {
        /*
         * A real Razorpay event this increment has no rule for — a refund, a settlement, a
         * dispute. Acknowledged and dropped. Guessing at a transition for it is precisely what
         * the approved scope forbids, and answering an error would make the provider retry
         * something no future delivery can change.
         */
        logger.info(
          { provider: gateway.provider, eventType: parsed.eventType },
          'payment_webhook_event_unsupported',
        );
        return { outcome: 'ignored', reason: 'unsupported_event' };
      }

      const target: PaymentStatus = parsed.outcome === 'succeeded' ? 'succeeded' : 'failed';

      try {
        return await withTransaction(db, logger, async () => {
          /*
           * The store is resolved HERE, and it comes from our own row — see the repository
           * method's comment. The notification body is never consulted for tenancy.
           */
          const matches = await repository.lockByProviderRef({
            provider: 'razorpay',
            providerRef: parsed.providerRef,
          });

          if (matches.length === 0) {
            logger.warn(
              { provider: gateway.provider, eventType: parsed.eventType },
              'payment_webhook_no_matching_payment',
            );
            return { outcome: 'ignored', reason: 'unknown_reference' } as const;
          }

          if (matches.length > 1) {
            /*
             * Two tenants hold the same provider reference. Refusing is the only safe move:
             * applying the event to either one would be a coin flip about whose order gets
             * marked paid. Logged at `error` because it means a provider account is shared in a
             * way the data model did not anticipate, and an operator has to resolve it.
             */
            logger.error(
              { provider: gateway.provider, eventType: parsed.eventType },
              'payment_webhook_reference_ambiguous_across_stores',
            );
            return { outcome: 'ignored', reason: 'ambiguous_reference' } as const;
          }

          const locked = matches[0];
          /* istanbul ignore next -- length checked immediately above. */
          if (locked === undefined) throw new InvariantViolation('payment lock returned no row');

          if (isTerminal(locked.status)) {
            /*
             * The payment has already finished. A redelivery of the event that finished it, or
             * a conflicting one (`payment.failed` arriving after `payment.captured` — ordinary
             * with at-least-once delivery). Either way the state machine says no, and the row
             * is left exactly as it is.
             */
            logger.info(
              {
                provider: gateway.provider,
                paymentId: locked.id,
                status: locked.status,
                eventType: parsed.eventType,
              },
              'payment_webhook_ignored_terminal_state',
            );
            return { outcome: 'ignored', reason: 'already_terminal' } as const;
          }

          if (!canTransition(locked.status, target)) {
            logger.warn(
              {
                provider: gateway.provider,
                paymentId: locked.id,
                from: locked.status,
                to: target,
              },
              'payment_webhook_transition_rejected',
            );
            return { outcome: 'ignored', reason: 'illegal_transition' } as const;
          }

          /*
           * History first. `uq_payment_event_provider` rejects a redelivered event id HERE,
           * before any state changes — so a duplicate cannot reach the UPDATE below even if it
           * arrived while the first delivery was still in flight.
           */
          await repository.insertEvent({
            paymentId: locked.id,
            storeId: locked.storeId,
            fromStatus: locked.status,
            toStatus: target,
            actorType: 'system',
            actorUserId: null,
            providerEventId: parsed.providerEventId,
            eventType: parsed.eventType,
          });

          const applied = await repository.applyTransition({
            paymentId: locked.id,
            storeId: locked.storeId,
            fromStatus: locked.status,
            toStatus: target,
            failureCode: parsed.failureCode,
            at: new Date(),
          });

          /* istanbul ignore next -- unreachable behind FOR UPDATE; the guard is the point. */
          if (!applied) throw new Conflict('payment changed while being updated');

          await audit.record({
            storeId: locked.storeId,
            actor: { type: 'system' },
            action: target === 'succeeded' ? PAYMENT_AUDIT.succeeded : PAYMENT_AUDIT.failed,
            resourceType: PAYMENT_RESOURCE,
            resourceId: locked.id,
            metadata: {
              from: locked.status,
              to: target,
              provider: gateway.provider,
              providerEventId: parsed.providerEventId,
              eventType: parsed.eventType,
            },
          });

          logger.info(
            {
              provider: gateway.provider,
              paymentId: locked.id,
              from: locked.status,
              to: target,
            },
            'payment_transitioned',
          );

          return { outcome: 'applied', status: target } as const;
        });
      } catch (err) {
        /*
         * `uq_payment_event_provider`. This exact provider event has already been recorded, so
         * the transition it describes has already happened. A successful no-op is the correct
         * answer: the provider needs to stop redelivering, and nothing is left to do.
         */
        if (uniqueViolationConstraint(err) === 'uq_payment_event_provider') {
          logger.info(
            { provider: gateway.provider, eventType: parsed.eventType },
            'payment_webhook_duplicate_ignored',
          );
          return { outcome: 'ignored', reason: 'duplicate_event' };
        }
        throw err;
      }
    },
  };
}
