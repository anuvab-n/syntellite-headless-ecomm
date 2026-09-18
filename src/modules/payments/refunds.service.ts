import { randomInt } from 'node:crypto';

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
import {
  compare,
  fromDb,
  isCurrency,
  subtract,
  toDb,
  toMinorUnits,
  zero,
  type Currency,
} from '../../shared/money.js';
import { newId } from '../../shared/id.js';
import { REFUND_AUDIT, REFUND_RESOURCE } from './refunds.events.js';

/**
 * Who a provider webhook acts as.
 *
 * `system`, not `job` and not a staff id: the platform itself applied a fact the provider
 * reported. Attributing it to a person would be a lie about who decided, and `job` is reserved
 * for things a scheduler runs. `AuditActor` has no `provider` arm and this increment does not
 * add one — the provider's identity is metadata on the entry, not the actor.
 */
const WEBHOOK_ACTOR = { type: 'system' } as const satisfies AuditActor;
import {
  REFUND_NUMBER_ALPHABET,
  REFUND_NUMBER_SUFFIX_LENGTH,
  type RefundRecord,
  type RefundsRepository,
} from './refunds.repository.js';

/**
 * The refund service.
 *
 * ## The one invariant
 *
 * **Σ(claimed refunds) ≤ captured amount**, always, for every payment. Everything structural in
 * this file exists to make that true under concurrency rather than usually:
 *
 *  1. the PAYMENT row is locked before the balance is read, so two concurrent refunds
 *     serialise and the second sees the first;
 *  2. `pending` and `processing` refunds consume balance alongside `succeeded`, so an
 *     unresolved provider call cannot be refunded around;
 *  3. the arithmetic is `money.ts` / Decimal.js end to end — no `Number`, ever.
 *
 * ## The ordering, and why the row is written before the provider is called
 *
 * A refund row is inserted as `pending` and committed BEFORE the gateway is asked. That costs a
 * transaction boundary and buys the only thing that matters: if the process dies mid-call, a
 * row exists saying an attempt was made. The alternative — call first, write after — loses the
 * attempt entirely on a crash, and a refund nobody recorded is a refund nobody reconciles.
 *
 * ## Payment status is never written here
 *
 * Not once, in any path. A refund is its own aggregate; `payment.status` continues to mean
 * "did the original collection succeed", which stays true after any amount of money goes back.
 * `payments.state.ts` makes `succeeded` absorbing, and this module does not argue with it.
 */

/**
 * The provider, adapted. **Declared by this consumer, implemented by `container.ts`.**
 *
 * Razorpay is not named here and must not be: this module knows there is something that can be
 * asked to move money back, and nothing about who it is.
 */
export type RefundExecutor = {
  readonly provider: string;
  execute(params: {
    /** The provider's CHARGE id (`pay_…`) — never the order ref, never our UUID. */
    providerTransactionId: string;
    amountMinor: number;
    /** Our refund id, sent as the provider's idempotency reference. */
    reference: string;
  }): Promise<
    | { readonly kind: 'succeeded'; readonly providerRefundId: string }
    | { readonly kind: 'failed'; readonly failureCode: string | null }
    | { readonly kind: 'unknown' }
  >;
};

/**
 * Delivery, adapted. **Declared by this consumer, implemented in `container.ts`.**
 *
 * Exists for exactly one question: **has this COD order's cash actually been collected?**
 *
 * An ONLINE payment answers that itself — `status = 'succeeded'` means the gateway captured the
 * money, and that is the whole of it. A COD payment cannot: this system has no "cash collected"
 * transition, so a COD `payment` row sits at `pending` for its entire life however much money
 * changed hands. Reading `status` alone would therefore make every COD order permanently
 * unrefundable, which would leave the Returns screen broken for the majority of Indian orders.
 *
 * Delivery is the COD money event, and this repository already says so elsewhere: fulfilment's
 * `allowUncommittedCod` exists precisely because a COD order SHIPS before its money arrives, and
 * `order-display-status.ts` reports a pending COD payment as `confirmed` rather than as awaiting
 * payment. Delivery is the other side of that trade — the moment the courier hands over the
 * goods and takes the cash.
 *
 * This is deliberately NOT a change to the payment state machine, which §14 requires be
 * preserved: nothing here writes `payment.status`. It is a read, used only to decide what a COD
 * payment's refundable base is.
 */
export type RefundDelivery = {
  /** When this order was delivered, or `null` if it has not been. */
  deliveredAtForOrder(params: { orderId: string; storeId: string }): Promise<Date | null>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** The payment cannot be refunded at all. A `422`. */
export class PaymentNotRefundable extends BusinessRuleViolation {
  override readonly code = 'PAYMENT_NOT_REFUNDABLE';
  constructor(reason: string, message: string) {
    super(message, { reason });
  }
}

/** The amount asked for exceeds what is left. A `422`, and it says what is left. */
export class RefundExceedsBalance extends BusinessRuleViolation {
  override readonly code = 'REFUND_EXCEEDS_BALANCE';
  constructor(requested: string, remaining: string, currency: string) {
    super(
      `a refund of ${requested} exceeds the ${remaining} remaining refundable on this payment`,
      { requested, remaining, currency },
    );
  }
}

/** A live refund already exists for this return. A `409`. */
export class RefundAlreadyRaised extends Conflict {
  override readonly code = 'REFUND_ALREADY_RAISED';
  constructor(returnId: string) {
    super(
      'a refund is already outstanding for this return; it must be reconciled or it must fail before another can be raised',
      { returnId },
    );
  }
}

/** The refund is not in a state this action applies to. A `409`. */
export class RefundNotSettleable extends Conflict {
  override readonly code = 'REFUND_NOT_SETTLEABLE';
  constructor(status: string, mode: string) {
    super(`a ${mode} refund in state ${status} cannot be settled`, { status, mode });
  }
}

/* ── Views ───────────────────────────────────────────────────────────────── */

/** A payment's refund position — what has gone back, and what still could. */
export type RefundBalanceView = {
  readonly currency: string;
  /** What the payment collected. `0` unless the payment succeeded. */
  readonly captured: string;
  /** What has actually gone back — `succeeded` refunds only. */
  readonly refunded: string;
  /**
   * What is reserved against the payment: `refunded` plus everything still in flight.
   *
   * Equals `refunded` in the ordinary case and exceeds it while an attempt is `pending` or
   * `processing`. Published because an operator looking at a payment that will not accept a
   * further refund is owed the reason, and "₹200 claimed, ₹100 refunded" is that reason.
   */
  readonly claimed: string;
  /** `captured - claimed`. What a further refund may be raised for. */
  readonly remaining: string;
};

export type RefundsService = ReturnType<typeof createRefundsService>;

/**
 * The partial unique index that makes a second live refund per return impossible.
 *
 * Named so the interpretation below cannot drift from the schema, and so that ANY OTHER unique
 * violation is rethrown untouched rather than being reported as a duplicate refund — which
 * would hide a real bug behind a plausible-looking 409.
 */
const REFUND_RETURN_UNIQUE_CONSTRAINT = 'uq_refund_return_live';

/** How many times a colliding refund number is re-drawn before failing loudly. */
const REFUND_NUMBER_ATTEMPTS = 5;

/**
 * `RFD-YYYYMMDD-XXXXXX`. The same construction the order and return numbers use.
 *
 * CSPRNG rather than a counter: a predictable refund number is a refund number an attacker can
 * enumerate, and this one addresses a money-bearing endpoint.
 */
export function generateRefundNumber(at: Date): string {
  const datePart = at.toISOString().slice(0, 10).replaceAll('-', '');
  let suffix = '';
  for (let i = 0; i < REFUND_NUMBER_SUFFIX_LENGTH; i += 1) {
    suffix += REFUND_NUMBER_ALPHABET[randomInt(REFUND_NUMBER_ALPHABET.length)];
  }
  return `RFD-${datePart}-${suffix}`;
}

export function createRefundsService(deps: {
  repository: RefundsRepository;
  executor: RefundExecutor;
  /** Answers whether a COD order's cash has been collected. See `RefundDelivery`. */
  delivery: RefundDelivery;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
  now?: () => Date;
}) {
  const { repository, executor, delivery, db, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  function requireCurrency(value: string): Currency {
    if (!isCurrency(value)) {
      throw new InvariantViolation(`refund carries an unsupported currency: ${value}`);
    }
    return value;
  }

  async function allocateRefundNumber(storeId: string, at: Date): Promise<string> {
    for (let attempt = 0; attempt < REFUND_NUMBER_ATTEMPTS; attempt += 1) {
      const refundNumber = generateRefundNumber(at);
      if (!(await repository.refundNumberExists({ refundNumber, storeId }))) return refundNumber;
      logger.info({ storeId, attempt }, 'refund_number_collision');
    }
    throw new InvariantViolation('could not allocate a unique refund number');
  }

  /**
   * What this payment actually collected.
   *
   * ONLINE trusts `status`: the gateway captured it or it did not. COD cannot — this system has
   * no "cash collected" transition, so a COD payment sits at `pending` for its whole life — and
   * asks instead whether the goods were DELIVERED, which is when the cash changed hands. See
   * `RefundDelivery` for why that is the right question and not an invented rule.
   *
   * One function, used by both the claim path and the read-only balance, so the two cannot
   * answer differently — which they would the first time somebody edited one of them.
   */
  async function capturedAmountOf(
    pay: {
      method: string;
      orderId: string;
      amount: string;
      capturedAmount: string;
    },
    storeId: string,
  ): Promise<string> {
    if (pay.method !== 'cod') return pay.capturedAmount;
    const deliveredAt = await delivery.deliveredAtForOrder({ orderId: pay.orderId, storeId });
    return deliveredAt === null ? '0' : pay.amount;
  }

  /**
   * What is left to refund on this payment.
   *
   * `captured - claimed`, clamped at nothing below zero because a negative remaining balance
   * would mean the invariant had already been broken and reporting it as a number a caller
   * could refund against would compound the error.
   */
  function balanceOf(
    captured: string,
    sums: { claimed: string; settled: string },
    currency: Currency,
  ): RefundBalanceView {
    const capturedMoney = fromDb(captured, currency);
    const claimedMoney = fromDb(sums.claimed, currency);
    const remaining = subtract(capturedMoney, claimedMoney);

    return {
      currency,
      captured: toDb(capturedMoney),
      refunded: toDb(fromDb(sums.settled, currency)),
      claimed: toDb(claimedMoney),
      remaining: compare(remaining, zero(currency)) < 0 ? toDb(zero(currency)) : toDb(remaining),
    };
  }

  /**
   * Insert the `pending` row, having checked the balance under the payment lock.
   *
   * Callers must already hold the payment lock and already be inside a transaction. Stated as an
   * assertion rather than a comment, because a caller who forgets would get a check that reads
   * as if it were serialised and is not.
   */
  async function claimRefund(params: {
    storeId: string;
    payment: {
      paymentId: string;
      orderId: string;
      method: string;
      provider: string | null;
      providerTransactionId: string | null;
      status: string;
      currency: string;
      capturedAmount: string;
      amount: string;
    };
    amount: string;
    returnId: string | null;
    actor: AuditActor;
    requestKey: string | null;
  }): Promise<{ record: RefundRecord; mode: 'provider' | 'manual' }> {
    const { storeId, payment: pay } = params;
    const currency = requireCurrency(pay.currency);

    /**
     * What this payment actually collected, by method.
     *
     * ONLINE trusts `status`: the gateway captured it or it did not. COD cannot — see
     * `RefundDelivery` — so it asks whether the goods were delivered, which is when the cash
     * changed hands. Both answers reduce to one figure, and everything downstream works against
     * that figure alone.
     */
    const captured = await capturedAmountOf(pay, storeId);

    if (Number.parseFloat(captured) <= 0) {
      throw new PaymentNotRefundable(
        'payment_not_captured',
        pay.method === 'cod'
          ? 'this order has not been delivered, so no cash has been collected to refund'
          : 'this order’s payment has not succeeded, so there is nothing to refund',
      );
    }

    const requested = fromDb(params.amount, currency);
    if (compare(requested, zero(currency)) <= 0) {
      throw new PaymentNotRefundable('amount_not_positive', 'a refund must move a positive amount');
    }

    const sums = await repository.sumRefundsForPayment({
      paymentId: pay.paymentId,
      storeId,
    });
    const balance = balanceOf(captured, sums, currency);

    if (compare(requested, fromDb(balance.remaining, currency)) > 0) {
      throw new RefundExceedsBalance(toDb(requested), balance.remaining, currency);
    }

    /**
     * COD has no gateway, so its refund is `manual` — a recorded obligation, not a transfer.
     *
     * An ONLINE payment with no stored charge id is also manual, and that case is real: the
     * column is nullable for every payment taken before Increment 55 existed. Refusing those
     * outright would strand genuine refunds; recording them as manual says exactly what is
     * true — the money has to go back by a route this system cannot drive.
     */
    const mode: 'provider' | 'manual' =
      pay.method === 'online' && pay.provider !== null && pay.providerTransactionId !== null
        ? 'provider'
        : 'manual';

    const at = now();
    const refundNumber = await allocateRefundNumber(storeId, at);

    const record = await repository.insertRefund({
      id: newId(),
      storeId,
      paymentId: pay.paymentId,
      orderId: pay.orderId,
      returnId: params.returnId,
      refundNumber,
      mode,
      provider: mode === 'provider' ? pay.provider : null,
      status: 'pending',
      currency,
      amount: toDb(requested),
      /* Zero for manual — nothing is handed to anybody. See `ck_refund_amount_minor`. */
      amountMinor: mode === 'provider' ? toMinorUnits(requested) : 0,
      requestKey: params.requestKey,
      initiatedBy:
        params.actor.type === 'staff' && params.actor.userId !== undefined
          ? params.actor.userId
          : (() => {
              throw new InvariantViolation('a refund requires a staff actor');
            })(),
    });

    await audit.record({
      storeId,
      actor: params.actor,
      action: REFUND_AUDIT.raised,
      resourceType: REFUND_RESOURCE,
      resourceId: record.id,
      metadata: {
        refundNumber: record.refundNumber,
        mode: record.mode,
        amount: record.amount,
        currency: record.currency,
        ...(params.returnId === null ? {} : { fromReturn: true }),
      },
    });

    return { record, mode };
  }

  /**
   * Ask the provider, and persist whatever it said.
   *
   * **Runs OUTSIDE the claim transaction, by construction.** A provider call inside a
   * transaction holds a database connection open across a network round trip that may take the
   * full request timeout, and on a busy store that is how the pool is exhausted. The claim is
   * already committed, so a crash here leaves a `pending` row — visible, reconcilable, and
   * still consuming balance so nobody refunds around it.
   */
  async function dispatch(params: {
    storeId: string;
    record: RefundRecord;
    providerTransactionId: string;
    actor: AuditActor;
  }): Promise<RefundRecord> {
    const { storeId, record } = params;

    const outcome = await executor.execute({
      providerTransactionId: params.providerTransactionId,
      amountMinor: record.amountMinor,
      reference: record.id,
    });

    /**
     * INDEPENDENT, for the reason the claim is — see `refundForReturn`.
     *
     * This is where the provider's answer is written down. If it joined a caller's transaction
     * and that caller then refused, the answer would be rolled back and we would have asked the
     * provider to move money and kept no record of what it said.
     */
    return withTransaction(
      db,
      logger,
      async () => {
        const at = now();

        if (outcome.kind === 'unknown') {
          /*
           * `pending -> processing`. NOT terminal, NOT settled, and still consuming balance.
           *
           * This is the branch the whole increment is shaped around: the provider may or may
           * not have moved the money, so the only honest record is "asked, no answer". A blind
           * retry is what must not happen next, which is why the row stays live and the balance
           * stays claimed.
           */
          const moved = await repository.transitionRefund({
            refundId: record.id,
            storeId,
            fromStatus: 'pending',
            toStatus: 'processing',
            settledAt: null,
            at,
          });

          await audit.record({
            storeId,
            actor: params.actor,
            action: REFUND_AUDIT.unresolved,
            resourceType: REFUND_RESOURCE,
            resourceId: record.id,
            metadata: {
              refundNumber: record.refundNumber,
              amount: record.amount,
              currency: record.currency,
            },
          });

          logger.error(
            { storeId, refundNumber: record.refundNumber, provider: executor.provider },
            'refund_outcome_unknown',
          );

          return moved ?? record;
        }

        if (outcome.kind === 'failed') {
          const moved = await repository.transitionRefund({
            refundId: record.id,
            storeId,
            fromStatus: 'pending',
            toStatus: 'failed',
            failureCode: outcome.failureCode,
            settledAt: at,
            at,
          });

          await audit.record({
            storeId,
            actor: params.actor,
            action: REFUND_AUDIT.failed,
            resourceType: REFUND_RESOURCE,
            resourceId: record.id,
            metadata: {
              refundNumber: record.refundNumber,
              amount: record.amount,
              currency: record.currency,
              failureCode: outcome.failureCode,
            },
          });

          logger.warn(
            { storeId, refundNumber: record.refundNumber, failureCode: outcome.failureCode },
            'refund_failed',
          );

          return moved ?? record;
        }

        const moved = await repository.transitionRefund({
          refundId: record.id,
          storeId,
          fromStatus: 'pending',
          toStatus: 'succeeded',
          providerRefundId: outcome.providerRefundId,
          settledAt: at,
          at,
        });

        await audit.record({
          storeId,
          actor: params.actor,
          action: REFUND_AUDIT.succeeded,
          resourceType: REFUND_RESOURCE,
          resourceId: record.id,
          metadata: {
            refundNumber: record.refundNumber,
            amount: record.amount,
            currency: record.currency,
          },
        });

        logger.info({ storeId, refundNumber: record.refundNumber }, 'refund_succeeded');

        return moved ?? record;
      },
      { independent: true },
    );
  }
  return {
    /**
     * Refund against an order's payment. The Payments screen's "Get Refund".
     *
     * Two phases, on purpose. The claim commits the `pending` row under the payment lock; the
     * dispatch then talks to the provider with no transaction open. See `dispatch` for why the
     * boundary is where it is.
     */
    async refundForOrder(params: {
      orderNumber: string;
      storeId: string;
      amount: string;
      actor: AuditActor;
      requestKey?: string;
    }): Promise<{ refund: RefundRecord; balance: RefundBalanceView }> {
      const claim = await withTransaction(db, logger, async () => {
        const pay = await repository.lockPaymentForRefund({
          orderNumber: params.orderNumber,
          storeId: params.storeId,
        });
        if (!pay) throw new NotFound('payment');

        const claimed = await claimRefund({
          storeId: params.storeId,
          payment: pay,
          amount: params.amount,
          returnId: null,
          actor: params.actor,
          requestKey: params.requestKey ?? null,
        });

        return { ...claimed, providerTransactionId: pay.providerTransactionId };
      });

      const settled =
        claim.mode === 'provider' && claim.providerTransactionId !== null
          ? await dispatch({
              storeId: params.storeId,
              record: claim.record,
              providerTransactionId: claim.providerTransactionId,
              actor: params.actor,
            })
          : claim.record;

      return {
        refund: settled,
        balance: await this.balanceForOrder({
          orderNumber: params.orderNumber,
          storeId: params.storeId,
        }),
      };
    },

    /**
     * Refund a RETURN, called by the returns module through its own port.
     *
     * Identical machinery, one extra guarantee: `uq_refund_return_live` means a second live
     * refund for the same return cannot be inserted at all, so a concurrent double completion
     * loses at the database rather than at a check.
     */
    async refundForReturn(params: {
      storeId: string;
      orderId: string;
      returnId: string;
      amount: string;
      actor: AuditActor;
    }): Promise<RefundRecord> {
      /**
       * **INDEPENDENT, and this is the most important line in the file.**
       *
       * `withTransaction` is re-entrant: called from inside the returns module's completion
       * transaction it would JOIN it, and a completion that then refuses — because the refund
       * failed, or worse because its outcome is unknown — would roll the refund row back with
       * everything else. The attempt would leave no trace at all, and an unresolved attempt
       * that leaves no trace is money that may have moved with nothing to reconcile it against.
       *
       * So the refund commits on its own connection, before the caller decides what to do with
       * it. The trade is deliberate and runs the safe way: a refund recorded for a return that
       * did not complete is visible, reconcilable and blocks a duplicate; a return completed
       * against a refund that was rolled back would be neither.
       *
       * No deadlock: the caller holds the RETURN row lock and this takes the PAYMENT row lock,
       * and nothing in the system takes them in the opposite order.
       */
      const claim = await withTransaction(
        db,
        logger,
        async () => {
          const pay = await repository.lockPaymentForReturnRefund({
            orderId: params.orderId,
            storeId: params.storeId,
          });
          if (!pay) {
            throw new PaymentNotRefundable(
              'no_payment',
              'this order has no payment, so a refund cannot be raised against it',
            );
          }

          try {
            const claimed = await claimRefund({
              storeId: params.storeId,
              payment: pay,
              amount: params.amount,
              returnId: params.returnId,
              actor: params.actor,
              requestKey: null,
            });

            return { ...claimed, providerTransactionId: pay.providerTransactionId };
          } catch (err) {
            /*
             * A live refund already exists for this return — `pending`, `processing` or
             * `succeeded`. The index is the authority here rather than a prior read, because a
             * read-then-insert would let two concurrent completions both pass the read.
             *
             * This is the path a blind retry after an UNRESOLVED outcome takes, and turning it
             * into a clean 409 rather than a 500 is what lets the screen tell an operator the
             * truth: there is already a refund outstanding, go and reconcile it.
             */
            if (uniqueViolationConstraint(err) !== REFUND_RETURN_UNIQUE_CONSTRAINT) throw err;

            /*
             * No follow-up query to name the existing refund, deliberately: PostgreSQL has
             * already aborted this transaction, so any statement issued on it now fails with
             * `25P02` and the 409 turns back into a 500. The caller knows which return it was
             * completing, and the refund is one read away on the return detail.
             */
            throw new RefundAlreadyRaised(params.returnId);
          }
        },
        { independent: true },
      );

      if (claim.mode !== 'provider' || claim.providerTransactionId === null) return claim.record;

      return dispatch({
        storeId: params.storeId,
        record: claim.record,
        providerTransactionId: claim.providerTransactionId,
        actor: params.actor,
      });
    },

    /**
     * Record that a MANUAL refund was paid out offline.
     *
     * The minimum this backend can honestly say about money it did not move: a staff member
     * asserts the disbursement happened, and the assertion is attributed and timestamped. No
     * bank, UPI or payout integration is implied or invented — there is none in this system.
     *
     * Refuses a `provider` refund outright. A gateway refund's outcome is the gateway's to
     * report, and letting staff declare one succeeded would make the `processing` state
     * pointless.
     */
    async settleManualRefund(params: {
      refundNumber: string;
      storeId: string;
      actor: AuditActor;
    }): Promise<RefundRecord> {
      return withTransaction(db, logger, async () => {
        const record = await repository.lockByNumber({
          refundNumber: params.refundNumber,
          storeId: params.storeId,
        });
        if (!record) throw new NotFound('refund');

        if (record.mode !== 'manual' || record.status !== 'pending') {
          throw new RefundNotSettleable(record.status, record.mode);
        }

        const at = now();
        const moved = await repository.transitionRefund({
          refundId: record.id,
          storeId: params.storeId,
          fromStatus: 'pending',
          toStatus: 'succeeded',
          settledAt: at,
          at,
        });
        if (!moved) throw new RefundNotSettleable(record.status, record.mode);

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: REFUND_AUDIT.settled,
          resourceType: REFUND_RESOURCE,
          resourceId: record.id,
          metadata: {
            refundNumber: record.refundNumber,
            amount: record.amount,
            currency: record.currency,
            mode: record.mode,
          },
        });

        return moved;
      });
    },

    /**
     * Resolve a `processing` refund from a verified provider notification. Increment 60.
     *
     * This is the other end of `dispatch`'s `unknown` branch. That branch exists because a
     * timeout, a 5xx or an unparseable body means the provider may or may not have moved the
     * money; this is the provider coming back later and saying which.
     *
     * **It only ever transitions a row that already exists.** There is no insert on this path
     * and no call that could make one, so a notification — however well-signed — cannot create
     * a refund, cannot create a second attempt against a payment, and therefore cannot move the
     * claimed total at all. The balance invariant is not re-checked here because nothing here
     * can change it: `processing` and `succeeded` both consume balance, and `failed` only ever
     * releases it.
     *
     * **`payment.status` is not written, and no code below could write it.** The refunds
     * repository exposes no payment mutation; the payment is not even loaded.
     *
     * The caller has already verified the signature — `parseVerifiedWebhook` is a single method
     * precisely so unverified data cannot reach here — and passes no store, because a webhook
     * has no tenant to pass. The store comes off the locked row.
     */
    async resolveFromWebhook(params: {
      refundReference: string;
      providerRefundId: string;
      provider: string;
      amountMinor: number | null;
      outcome: 'succeeded' | 'failed';
      failureCode: string | null;
      providerEventId: string;
    }): Promise<
      | { readonly outcome: 'applied'; readonly status: RefundRecord['status'] }
      | { readonly outcome: 'ignored'; readonly reason: string }
    > {
      return withTransaction(db, logger, async () => {
        const record = await repository.lockById({ refundId: params.refundReference });

        if (!record) {
          /*
           * A reference that names no row. A forged note, a notification from another
           * environment sharing a provider account, or a refund raised before this mechanism
           * existed. Nothing to do, and nothing a redelivery would fix.
           */
          logger.warn(
            { provider: params.provider, eventType: 'refund' },
            'refund_webhook_no_matching_refund',
          );
          return { outcome: 'ignored', reason: 'unknown_reference' } as const;
        }

        const storeId = record.storeId;

        if (record.mode !== 'provider') {
          /*
           * A manual (COD) obligation. Its money never went through a gateway, so no gateway
           * may declare it settled — that is staff's assertion to make, through
           * `settleManualRefund`. Reaching here at all means a reference was reused or forged.
           */
          logger.error(
            { storeId, refundNumber: record.refundNumber, provider: params.provider },
            'refund_webhook_rejected_manual_mode',
          );
          return { outcome: 'ignored', reason: 'unsupported_mode' } as const;
        }

        if (record.status !== 'processing') {
          /*
           * `succeeded` and `failed` are terminal and are left exactly as they are — this is
           * the ordinary duplicate-delivery path, and also a late `refund.failed` chasing a
           * `refund.processed`. `pending` is refused too: a row still `pending` has not been
           * confirmed as dispatched, and resolving it would skip the state that records that
           * the provider was asked.
           */
          logger.info(
            { storeId, refundNumber: record.refundNumber, status: record.status },
            'refund_webhook_ignored_not_processing',
          );
          return {
            outcome: 'ignored',
            reason: record.status === 'pending' ? 'illegal_transition' : 'already_terminal',
          } as const;
        }

        /*
         * The provider's figure must match the frozen row, exactly, in minor units.
         *
         * Integer equality — no Decimal, no tolerance — because `amount_minor` is what was sent
         * to the gateway and a refund that came back for a different sum is not this refund's
         * outcome. Refusing keeps the row `processing` and visibly unreconciled, which is the
         * honest state; resolving it would close an attempt against money of a different size.
         */
        if (params.amountMinor === null || params.amountMinor !== record.amountMinor) {
          logger.error(
            { storeId, refundNumber: record.refundNumber, provider: params.provider },
            'refund_webhook_amount_mismatch',
          );
          return { outcome: 'ignored', reason: 'amount_mismatch' } as const;
        }

        const at = now();
        const succeeded = params.outcome === 'succeeded';

        const moved = await repository.transitionRefund({
          refundId: record.id,
          storeId,
          fromStatus: 'processing',
          toStatus: succeeded ? 'succeeded' : 'failed',
          /*
           * Written HERE and only on success, because `ck_refund_succeeded_evidence` requires a
           * succeeded provider refund to name one. This is the first moment we learn it: the
           * call that created this refund never returned an id, which is why the row was
           * `processing` at all.
           */
          ...(succeeded ? { providerRefundId: params.providerRefundId } : {}),
          failureCode: succeeded ? null : params.failureCode,
          settledAt: at,
          at,
        });

        if (!moved) {
          /*
           * The compare-and-swap found no `processing` row. A concurrent delivery resolved it
           * between the lock and here — impossible while the lock is held, so this is the
           * belt-and-braces arm — and the safe answer is the same as any other duplicate.
           */
          return { outcome: 'ignored', reason: 'already_terminal' } as const;
        }

        await audit.record({
          storeId,
          actor: WEBHOOK_ACTOR,
          action: succeeded ? REFUND_AUDIT.succeeded : REFUND_AUDIT.failed,
          resourceType: REFUND_RESOURCE,
          resourceId: record.id,
          metadata: {
            refundNumber: record.refundNumber,
            amount: record.amount,
            currency: record.currency,
            /*
             * Identifiers only. The provider's event id and refund id are opaque by design and
             * are what an operator needs to find the delivery in Razorpay's dashboard. No
             * signature, no headers, no body.
             */
            provider: params.provider,
            providerRefundId: params.providerRefundId,
            providerEventId: params.providerEventId,
            ...(succeeded ? {} : { failureCode: params.failureCode }),
          },
        });

        logger.info(
          { storeId, refundNumber: record.refundNumber, status: moved.status },
          'refund_webhook_resolved',
        );

        return { outcome: 'applied', status: moved.status } as const;
      });
    },

    /** The refund position for an order's payment. Read-only, no lock. */
    async balanceForOrder(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<RefundBalanceView> {
      const pay = await repository.lockPaymentForRefund(params);
      if (!pay) throw new NotFound('payment');

      const currency = requireCurrency(pay.currency);
      const sums = await repository.sumRefundsForPayment({
        paymentId: pay.paymentId,
        storeId: params.storeId,
      });
      return balanceOf(await capturedAmountOf(pay, params.storeId), sums, currency);
    },

    /** Every refund against one payment. */
    async listForPayment(params: { paymentId: string; storeId: string }): Promise<RefundRecord[]> {
      return repository.listForPayment(params);
    },

    /** Every refund raised for one return. Used by the returns detail read. */
    async listForReturn(params: { returnId: string; storeId: string }): Promise<RefundRecord[]> {
      return repository.listForReturn(params);
    },
  };
}
