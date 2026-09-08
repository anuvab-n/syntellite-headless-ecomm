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
  /**
   * **What to charge: the order's `grand_total`, tax included.**
   *
   * Increment 38 repointed this from `order.total`. The names differ deliberately —
   * `order.total` still means the GOODS total and must never be charged once GST applies,
   * while this field means "the payable amount" and is the only thing this module should ever
   * know about an order's money. For an order with no tax determination the two are equal, by
   * `ck_order_grand_total_identity`, which is why the change is invisible to every order
   * placed before that increment.
   */
  readonly payableTotal: string;
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

  /**
   * Take the ORDER's row lock, by id, for expiry. **The first lock in the expiry lock order.**
   *
   * Not a customer operation and deliberately not user-scoped: the sweeper acts as the system
   * on an order it found through a payment row, so there is no authenticated user to scope by.
   * Store scoping is still mandatory and the implementation carries it.
   *
   * `order → payment` is the global lock order this increment establishes, and taking the order
   * lock first is the ENTIRE reason expiry serialises with cancellation: cancellation already
   * locks the order first and reads payment status without a lock, so without this an expiring
   * payment and a cancelling customer would not serialise at all. The webhook takes only the
   * payment lock and never the order, so no cycle is possible.
   *
   * `false` means the order vanished between the candidate read and the lock — impossible
   * today, since orders are never deleted, but the sweeper treats it as "skip" rather than
   * asserting, because a sweeper that crashes on surprising data stops sweeping.
   */
  lockForExpiry(params: { orderId: string; storeId: string }): Promise<boolean>;
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

/**
 * **Inventory settlement, as payments needs it — declared HERE, implemented by inventory.**
 *
 * Two operations, and deliberately nothing else. This module cannot reserve, cannot read a
 * stock level, and cannot name a SKU: it only reports that an order's payment reached a
 * terminal state, and inventory decides what that means for the units.
 *
 * **The reservation belongs to the ORDER, not to the payment.** It is created at checkout,
 * before any payment row exists, and an order with no payment still holds stock. So both
 * operations are keyed by `orderId`, and payment state changes are TRIGGERS rather than owners.
 * That is why nothing here takes a payment id.
 *
 * Both must be called inside this service's transaction, so the settlement commits with the
 * payment transition that caused it. Inventory asserts that itself.
 *
 * `reason` excludes `order_cancelled`: this module never cancels an order. `payment_expired` is
 * now reachable — Increment 36 gave it a caller in `expirePayment` — so both members of the
 * union are live.
 */
export type PaymentReservations = {
  commitForOrder(input: { orderId: string; storeId: string }): Promise<void>;
  releaseForOrder(input: {
    orderId: string;
    storeId: string;
    reason: 'payment_failed' | 'payment_expired';
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
  reservations: PaymentReservations;
  /**
   * How long an online payment stays payable, from validated configuration.
   *
   * Passed in rather than read from `Config` here, so the service depends on the VALUE and not
   * on the shape of the config object — the same reason the mailer receives `resetUrlBase`
   * rather than the whole config. Zod has already proven it a positive integer.
   */
  expiryMinutes: number;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const {
    repository,
    orders,
    gateway,
    idempotency,
    reservations,
    expiryMinutes,
    db,
    audit,
    logger,
  } = deps;

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
      /*
       * `payableTotal` is the order's `grand_total`. Read through `fromDb` and carried as a
       * `Money`, so the comparison below and the minor-unit conversion are both exact — there
       * is no `Number()` anywhere on this path.
       */
      const amount = fromDb(order.payableTotal, currency);
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

      /**
       * **The expiry window, stamped once, from configuration.**
       *
       * `initiatedAt` is captured ONCE here and used for nothing else, so the window is exactly
       * `expiryMinutes` from a single instant rather than from whenever a later line happened to
       * call `new Date()`. That also makes it the one seam a test needs.
       *
       * `null` for COD, unconditionally — decision C put COD out of expiry's scope, and
       * `ck_payment_expires_at_only_online` refuses the row if this ever disagrees.
       *
       * **The client cannot influence this.** `InitiatePaymentRequestSchema` is a
       * `strictObject` whose only field is `method`, so an `expiresAt` in the body is a 400
       * naming the field, and nothing on this path reads one.
       */
      const initiatedAt = new Date();
      const expiresAt =
        params.method === 'online'
          ? new Date(initiatedAt.getTime() + expiryMinutes * 60_000)
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
            expiresAt,
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
     * **Expire one abandoned online payment, and give its stock back. Increment 36.**
     *
     * ONE transaction, and the lock order is the whole design:
     *
     *     order -> payment -> stock_reservation -> stock_item
     *
     * The order lock comes FIRST, and that is not defensive habit. Cancellation already locks
     * the order and then reads payment status WITHOUT a lock, so if expiry took only the
     * payment lock the two would not serialise at all: a customer could be refused a
     * cancellation on a `pending` read while this transaction was turning that same payment
     * `expired`. Taking the order lock first makes them queue. The webhook takes only the
     * payment lock and never the order, so no wait cycle can form and no deadlock is possible.
     *
     * ## Atomicity is the point
     *
     * The transition, the history row, the reservation release and the audit entry commit
     * together or not at all. If the release throws — `InvariantViolation` when the projection
     * has diverged from `stock_reservation` — the whole transaction rolls back: the payment
     * stays `pending`, no `payment_event` survives, no audit entry survives, the reservation
     * stays `held`, and the next sweep tries again. **A failed release can never leave a
     * payment marked expired.** That is why the release is inside this transaction and why
     * nothing here catches and continues.
     *
     * ## What cannot happen
     *
     * A terminal payment is never expired: the status is re-read under the lock, `isTerminal`
     * returns early, `canTransition` is consulted, and `applyTransition` is a CAS on
     * `from_status` — four independent refusals. Two concurrent sweepers cannot both release:
     * the row lock serialises them and the CAS admits one. And a webhook cannot resurrect an
     * expired payment, because `expired` has no outgoing transitions.
     *
     * ## Local expiry is authoritative, and that has a price
     *
     * Nothing is read back from the provider. A payment expired here can still be captured at
     * Razorpay, in which case the late webhook is ignored as already-terminal and the money is
     * taken with no local record of success. That exposure is ACCEPTED by decision, not solved
     * — there is deliberately no reconciliation, no read-back and no reversal in this
     * increment. See docs/DECISIONS.md.
     *
     * Returns an outcome rather than throwing on the uninteresting cases, so the sweeper can
     * count what happened without treating a lost race as a failure.
     */
    async expirePayment(params: {
      paymentId: string;
      storeId: string;
      orderId: string;
    }): Promise<
      | { readonly outcome: 'expired' }
      | { readonly outcome: 'skipped'; readonly reason: 'order_gone' | 'not_found' }
      | { readonly outcome: 'ignored'; readonly reason: 'already_terminal' | 'illegal_transition' }
    > {
      return withTransaction(db, logger, async () => {
        /* 1. The ORDER lock, first. See the lock-order note above. */
        const orderLocked = await orders.lockForExpiry({
          orderId: params.orderId,
          storeId: params.storeId,
        });
        if (!orderLocked) {
          logger.warn(
            { paymentId: params.paymentId, orderId: params.orderId },
            'payment_expiry_skipped_order_missing',
          );
          return { outcome: 'skipped', reason: 'order_gone' } as const;
        }

        /* 2 + 3. The payment lock, then its state re-read from the locked row. */
        const locked = await repository.lockById({
          paymentId: params.paymentId,
          storeId: params.storeId,
        });
        if (!locked) {
          return { outcome: 'skipped', reason: 'not_found' } as const;
        }

        /*
         * 4. Already terminal — a webhook or another sweeper won the race between the candidate
         * read and this lock. No writes at all, and not an error: this is the expected outcome
         * of a race, and the sweeper counts it rather than logging it as a failure.
         */
        if (isTerminal(locked.status)) {
          logger.info(
            { paymentId: locked.id, status: locked.status },
            'payment_expiry_ignored_terminal_state',
          );
          return { outcome: 'ignored', reason: 'already_terminal' } as const;
        }

        /* 5. The transition table is the authority on what may follow `pending`. */
        if (!canTransition(locked.status, 'expired')) {
          logger.warn(
            { paymentId: locked.id, from: locked.status },
            'payment_expiry_transition_rejected',
          );
          return { outcome: 'ignored', reason: 'illegal_transition' } as const;
        }

        const at = new Date();

        /*
         * 6. The history row first, exactly as the webhook path does. `provider_event_id` is
         * NULL because no provider event caused this — expiry is a local decision, and a
         * fabricated id would pollute the uniqueness guard that makes redelivery safe.
         */
        await repository.insertEvent({
          paymentId: locked.id,
          storeId: locked.storeId,
          fromStatus: locked.status,
          toStatus: 'expired',
          actorType: 'system',
          actorUserId: null,
          providerEventId: null,
          eventType: PAYMENT_AUDIT.expired,
        });

        /* 7. The same CAS the webhook uses. Zero rows means someone else moved it first. */
        const applied = await repository.applyTransition({
          paymentId: locked.id,
          storeId: locked.storeId,
          fromStatus: locked.status,
          toStatus: 'expired',
          /* `ck_payment_failure_code_only_when_failed` — an expiry is not a failure. */
          failureCode: null,
          at,
        });
        if (!applied) throw new Conflict('payment changed while being expired');

        /*
         * 8. Give the stock back. Inside the transaction, after the CAS, and deliberately not
         * wrapped in a try: if this throws, everything above it rolls back with it.
         */
        await reservations.releaseForOrder({
          orderId: locked.orderId,
          storeId: locked.storeId,
          reason: 'payment_expired',
        });

        /* 9. The audit action already existed, unused, since the payment increment. */
        await audit.record({
          storeId: locked.storeId,
          actor: { type: 'system' },
          action: PAYMENT_AUDIT.expired,
          resourceType: PAYMENT_RESOURCE,
          resourceId: locked.id,
          metadata: {
            from: locked.status,
            to: 'expired',
            orderId: locked.orderId,
            method: locked.method,
          },
        });

        logger.info(
          { paymentId: locked.id, orderId: locked.orderId, storeId: locked.storeId },
          'payment_expired',
        );

        return { outcome: 'expired' } as const;
      });
    },

    /**
     * Due online payments, as ids. Read OUTSIDE any transaction by the sweeper.
     *
     * Deliberately a hint and not a decision: each candidate is re-read under a lock before
     * anything is written, so a payment that terminalised in between is simply ignored.
     */
    async listExpiryDue(params: { now: Date; limit: number }) {
      return repository.listExpiryDue(params);
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

          /**
           * **Settle the order's reservation, driven by the transition that just committed.**
           *
           * After `applyTransition`, never before: that CAS on `from_status` is what proves
           * THIS delivery performed the transition. A duplicate webhook never reaches here —
           * `isTerminal` returns early, `uq_payment_event_provider` rejects a repeated
           * `provider_event_id`, and the CAS would fail — and even if one did, the settlement
           * is itself a CAS on `status = 'held'`, so it would move no counter.
           *
           * `succeeded` commits: the units are sold, and deliberately stay counted in
           * `reserved` because they are still physically present. No counter moves and no
           * `stock_ledger` row is written, because `on_hand` did not change.
           *
           * `failed` releases: the units go back to `available` and the order becomes payable
           * and cancellable again.
           *
           * `expired` is not handled here because nothing produces it — there is no expiry
           * window and no sweeper. When one is approved it will transition a payment the same
           * way and reach this same branch with `payment_expired`.
           *
           * Keyed by `locked.orderId`, from the payment row the provider reference resolved to
           * — never from the webhook payload, which is exactly how the store is resolved too.
           */
          if (target === 'succeeded') {
            await reservations.commitForOrder({
              orderId: locked.orderId,
              storeId: locked.storeId,
            });
          } else {
            await reservations.releaseForOrder({
              orderId: locked.orderId,
              storeId: locked.storeId,
              reason: 'payment_failed',
            });
          }

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
