import { randomInt } from 'node:crypto';

import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import {
  BusinessRuleViolation,
  Conflict,
  InvariantViolation,
  NotFound,
} from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import { isCurrency, type Currency } from '../../shared/money.js';
import type { Logger } from '../../shared/logger.js';

import { apportionReturnLine, type FrozenOrderLine } from './return-apportionment.js';
import { RETURN_AUDIT, RETURN_RESOURCE } from './returns.events.js';
import {
  RETURN_NUMBER_ALPHABET,
  RETURN_NUMBER_SUFFIX_LENGTH,
  RETURN_STATUSES,
  type ReturnEventRecord,
  type ReturnLineRecord,
  type ReturnRecord,
  type ReturnsRepository,
  type ReturnStatus,
  type StaffReturnDetailExtras,
  type StaffReturnListExtras,
} from './returns.repository.js';
import { canTransition, isCustomerCancellable, isTerminal } from './return.state.js';

/* ── Ports ───────────────────────────────────────────────────────────────── */

/**
 * The order line this module needs, in its own spelling.
 *
 * `skuId` is here and `skuCode` is too: the first is what `return_line` references, the second
 * is what the customer names in the request. Every monetary field is the FROZEN snapshot.
 */
export type ReturnableOrderLine = FrozenOrderLine & {
  readonly skuId: string;
  readonly skuCode: string;
};

export type ReturnableOrder = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly currency: string;
};

/**
 * The orders module, adapted to what returns needs.
 *
 * Declared here and satisfied by the composition root, because `no-cross-module-imports`
 * forbids importing `modules/orders`. Exactly the device `FulfilmentOrders` uses.
 */
export type ReturnOrders = {
  /**
   * Find and LOCK one order the customer owns, with its frozen lines.
   *
   * The lock is the head of this module's lock order and must be taken inside the caller's
   * transaction: every quantity decision below is read-then-write, and without it two
   * concurrent returns both read the same remaining quantity.
   */
  lockOwnedOrderForReturn(params: {
    orderNumber: string;
    userId: string;
    storeId: string;
  }): Promise<{ order: ReturnableOrder; lines: readonly ReturnableOrderLine[] } | null>;
};

/** The fulfilment module, adapted. Delivery is the eligibility fact returns turns on. */
export type ReturnFulfilment = {
  /**
   * When this order was delivered, or `null` if it has not been.
   *
   * The instant comes from `shipment.delivered_at` and nowhere else — never from the request,
   * which is why no DTO accepts it.
   */
  deliveredAtForOrder(params: { orderId: string; storeId: string }): Promise<Date | null>;
};

/**
 * Refunds, adapted. **Declared here, implemented in `container.ts`.**
 *
 * This module knows a refund can be raised and what came back. It does not know there is a
 * payments module, a gateway, or a provider called Razorpay, and it must not: a returns service
 * that imported a gateway could not be tested without one, and the no-cross-module-imports rule
 * says so structurally.
 *
 * The three outcomes are the port's whole point. `unresolved` is not an error — it is a fact
 * about the provider that the caller must be able to act on differently from a failure, because
 * a failure may be retried and an unresolved attempt must not be.
 */
export type ReturnRefunds = {
  refundForReturn(params: {
    storeId: string;
    orderId: string;
    returnId: string;
    amount: string;
    actor: AuditActor;
  }): Promise<{
    readonly refundNumber: string;
    readonly status: 'pending' | 'processing' | 'succeeded' | 'failed';
    readonly mode: 'provider' | 'manual';
    readonly amount: string;
    readonly currency: string;
    readonly failureCode: string | null;
  }>;
  /** Every refund raised for one return, for the staff detail read. */
  listForReturn(params: { returnId: string; storeId: string }): Promise<
    readonly {
      readonly refundNumber: string;
      readonly status: string;
      readonly mode: string;
      readonly amount: string;
      readonly currency: string;
      readonly providerRefundId: string | null;
      readonly failureCode: string | null;
      readonly createdAt: Date;
      readonly settledAt: Date | null;
    }[]
  >;
};

/**
 * Inventory, adapted. **Declared here, implemented in `container.ts`.**
 *
 * One call: put the good-to-sell units back. Returns does not touch `stock_item` or
 * `stock_ledger` — it cannot, since `schema-only-in-repositories` puts those tables behind the
 * inventory module's own repository, and going around that would put the ledger arithmetic in
 * two places.
 */
export type ReturnInventory = {
  restockForReturn(params: {
    storeId: string;
    lines: readonly { skuId: string; quantity: number }[];
    actorUserId: string;
    note?: string;
  }): Promise<{ skuCount: number; totalUnits: number }>;
};

/** The idempotency store, narrowed to the one call this module makes. */
export type ReturnIdempotency = {
  complete(params: {
    storeId: string;
    userId: string;
    key: string;
    endpoint: string;
    status: number;
    body?: unknown;
  }): Promise<void>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** The order cannot be returned at all. A `422`: well-formed request, business rules say no. */
export class OrderNotReturnable extends BusinessRuleViolation {
  override readonly code = 'ORDER_NOT_RETURNABLE';
  constructor(reason: string, message: string) {
    super(message, { reason });
  }
}

/** The requested quantity is not available to return. A `422`. */
export class ReturnQuantityUnavailable extends BusinessRuleViolation {
  override readonly code = 'RETURN_QUANTITY_UNAVAILABLE';
  constructor(skuCode: string, requested: number, remaining: number) {
    super(
      `Only ${String(remaining)} unit(s) of ${skuCode} remain returnable; ${String(requested)} were requested.`,
      { skuCode, requested, remaining },
    );
  }
}

/**
 * Inspection did not account for the goods. A `422`.
 *
 * Every line that came back must be inspected, and each one's good-plus-written-off must equal
 * the quantity returned. Anything else is a half-finished inspection, and completing on top of
 * one would restock a number nobody decided.
 */
export class ReturnInspectionIncomplete extends BusinessRuleViolation {
  override readonly code = 'RETURN_INSPECTION_INCOMPLETE';
  constructor(detail: string, context: Record<string, unknown>) {
    super(detail, context);
  }
}

/**
 * The refund did not succeed, so the return stays open. A `422`.
 *
 * Separate from `ReturnNotTransitionable` because nothing is wrong with the return's state —
 * the money is the problem, and the operator's next action is different for each of the two
 * outcomes this covers:
 *
 *  - `failed` — the provider refused. Fix the cause and complete again; a new attempt is safe.
 *  - `processing` — the provider never answered. **Do not retry.** The refund may already have
 *    gone through, so it must be reconciled against the provider before anything else happens.
 *
 * The distinction is carried in `details.refundStatus` so the screen can say which.
 */
export class ReturnRefundNotSettled extends BusinessRuleViolation {
  override readonly code = 'RETURN_REFUND_NOT_SETTLED';
  constructor(refundNumber: string, refundStatus: string, failureCode: string | null) {
    super(
      refundStatus === 'processing'
        ? `refund ${refundNumber} has no confirmed outcome from the provider; it must be reconciled before this return can be completed, and it must NOT be retried`
        : `refund ${refundNumber} did not succeed, so this return cannot be completed`,
      { refundNumber, refundStatus, failureCode },
    );
  }
}

/** The return cannot move to the requested state. A `409`: a conflict with existing state. */
export class ReturnNotTransitionable extends Conflict {
  override readonly code = 'RETURN_NOT_TRANSITIONABLE';
  constructor(from: string, to: string) {
    super(`a return in state ${from} cannot become ${to}`, { from, to });
  }
}

/* ── Views ───────────────────────────────────────────────────────────────── */

export type ReturnView = {
  readonly header: ReturnRecord & { readonly orderNumber: string };
  readonly lines: readonly ReturnLineRecord[];
};

/**
 * What STAFF see. The customer view plus the fields written for colleagues.
 *
 * `staffNote` is here and absent from the customer response deliberately: it is the
 * merchant’s internal rationale for approving or refusing, written to be read by other
 * staff, and publishing it would turn every refusal into an argument.
 */
export type StaffReturnView = ReturnView;

/** One row of the staff queue: the header, its lines, and who it belongs to. Increment 61. */
export type StaffReturnListView = {
  readonly header: ReturnRecord & StaffReturnListExtras;
  readonly lines: readonly ReturnLineRecord[];
};

/**
 * Everything the admin DETAIL page shows. Increment 61.
 *
 * `remainingBySkuId` is keyed by SKU id internally and projected onto lines by SKU code at the
 * DTO boundary — no internal id reaches a response.
 */
export type StaffReturnDetailView = {
  readonly header: ReturnRecord & StaffReturnDetailExtras;
  readonly lines: readonly ReturnLineRecord[];
  readonly events: readonly ReturnEventRecord[];
  readonly refunds: Awaited<ReturnType<ReturnRefunds['listForReturn']>>;
  readonly remainingBySkuId: ReadonlyMap<string, number>;
};

export type ReturnsService = ReturnType<typeof createReturnsService>;

/** The approved window, in whole days from delivery. */
export const RETURN_WINDOW_DAYS = 7;

/** How many times a colliding return number is re-drawn before failing loudly. */
const RETURN_NUMBER_ATTEMPTS = 5;

export function generateReturnNumber(at: Date): string {
  const datePart = at.toISOString().slice(0, 10).replaceAll('-', '');
  let suffix = '';
  for (let i = 0; i < RETURN_NUMBER_SUFFIX_LENGTH; i += 1) {
    suffix += RETURN_NUMBER_ALPHABET[randomInt(RETURN_NUMBER_ALPHABET.length)];
  }
  return `RET-${datePart}-${suffix}`;
}

export function createReturnsService(deps: {
  repository: ReturnsRepository;
  orders: ReturnOrders;
  fulfilment: ReturnFulfilment;
  idempotency: ReturnIdempotency;
  /** Increment 59. Raises the money side of a completion. */
  refunds: ReturnRefunds;
  /** Increment 59. Puts the good-to-sell units back. */
  inventory: ReturnInventory;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
  /** Injected so a test can freeze the return window without waiting seven days. */
  now?: () => Date;
}) {
  const { repository, orders, fulfilment, idempotency, refunds, inventory, db, audit, logger } =
    deps;
  const now = deps.now ?? (() => new Date());

  /**
   * Is this delivery still inside the return window?
   *
   * Seven CALENDAR days from `deliveredAt`, compared as instants. Not "seven business days"
   * and not a timezone-local midnight boundary — neither was approved, and inventing either
   * would change who is eligible.
   */
  function withinWindow(deliveredAt: Date, at: Date): boolean {
    const deadline = deliveredAt.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return at.getTime() <= deadline;
  }

  /** Draw a return number that is free in this store, or fail loudly. */
  async function allocateReturnNumber(storeId: string, at: Date): Promise<string> {
    for (let attempt = 0; attempt < RETURN_NUMBER_ATTEMPTS; attempt += 1) {
      const candidate = generateReturnNumber(at);
      if (!(await repository.returnNumberExists({ returnNumber: candidate, storeId }))) {
        return candidate;
      }
    }
    /*
     * Five collisions on a 32^6 alphabet means something is wrong with the entropy source, not
     * that we were unlucky. Failing is correct; looping forever is not.
     */
    throw new InvariantViolation('could not allocate a unique return number in five attempts');
  }

  return {
    /**
     * Create a return for units of a delivered order.
     *
     * The whole thing is ONE transaction, and the order lock is taken before any quantity is
     * read. That ordering is what makes the cumulative cap hold under concurrency: two
     * requests for the last unit serialise on the order row, so the second sees the first's
     * line and is refused.
     *
     * Nothing monetary comes from the caller. Every amount is apportioned by
     * {@link apportionReturnLine} from the frozen `order_line`, using the quantity earlier
     * non-rejected returns already claimed — which is what stops a sequence of partial
     * returns from refunding more than the line was worth.
     */
    async createReturn(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
      reason: string;
      customerNote: string;
      lines: readonly { skuCode: string; quantity: number }[];
      actor: AuditActor;
      idempotency: { key: string; endpoint: string };
      renderResponse: (view: ReturnView) => unknown;
    }): Promise<ReturnView> {
      return withTransaction(db, logger, async () => {
        const at = now();

        /* 1. The order, locked, with its frozen lines. Head of the lock order. */
        const owned = await orders.lockOwnedOrderForReturn({
          orderNumber: params.orderNumber,
          userId: params.userId,
          storeId: params.storeId,
        });
        /*
         * 404, not 403: another customer's order and a nonexistent one must be
         * indistinguishable, or the response confirms which order numbers exist.
         */
        if (!owned) throw new NotFound('order');

        /* 2. Eligibility. */
        if (owned.order.status === 'cancelled') {
          throw new OrderNotReturnable(
            'cancelled',
            'This order was cancelled and cannot be returned.',
          );
        }

        const deliveredAt = await fulfilment.deliveredAtForOrder({
          orderId: owned.order.id,
          storeId: params.storeId,
        });
        if (deliveredAt === null) {
          throw new OrderNotReturnable(
            'not_delivered',
            'This order has not been delivered yet, so it cannot be returned.',
          );
        }
        if (!withinWindow(deliveredAt, at)) {
          throw new OrderNotReturnable(
            'window_closed',
            `The ${String(RETURN_WINDOW_DAYS)}-day return window for this order has closed.`,
          );
        }

        if (!isCurrency(owned.order.currency)) {
          throw new InvariantViolation(
            `order ${owned.order.orderNumber} carries an unsupported currency`,
          );
        }
        const currency: Currency = owned.order.currency;

        /* 3. Everything already claimed by earlier non-rejected returns, read under the lock. */
        const alreadyBySkuId = await repository.sumReturnedQuantities({
          orderId: owned.order.id,
          storeId: params.storeId,
        });

        const lineBySkuCode = new Map(owned.lines.map((l) => [l.skuCode, l]));

        /* 4. Validate and apportion, line by line. */
        const returnId = newId();
        const persistedLines: {
          returnId: string;
          skuId: string;
          storeId: string;
          quantity: number;
          lineTotal: string;
          discountAmount: string;
          taxableValue: string;
          cgstAmount: string;
          sgstAmount: string;
          igstAmount: string;
          cessAmount: string;
          taxTotal: string;
          refundTotal: string;
        }[] = [];

        for (const requested of params.lines) {
          const orderLine = lineBySkuCode.get(requested.skuCode);
          if (!orderLine) {
            throw new OrderNotReturnable(
              'unknown_sku',
              `${requested.skuCode} is not part of this order.`,
            );
          }

          const already = alreadyBySkuId.get(orderLine.skuId) ?? 0;
          const remaining = orderLine.quantity - already;
          if (requested.quantity > remaining) {
            throw new ReturnQuantityUnavailable(
              requested.skuCode,
              requested.quantity,
              Math.max(remaining, 0),
            );
          }

          /*
           * The money. Apportioned from the frozen line and NOTHING else — no current price,
           * no current rate, no current promotion. `alreadyReturnedQuantity` is what makes a
           * sequence of partial returns sum to exactly the line rather than over-refunding.
           */
          const apportioned = apportionReturnLine({
            line: orderLine,
            returnedQuantity: requested.quantity,
            alreadyReturnedQuantity: already,
            currency,
          });

          persistedLines.push({
            returnId,
            skuId: orderLine.skuId,
            storeId: params.storeId,
            quantity: requested.quantity,
            ...apportioned,
          });
        }

        /* 5. The header totals are the sum of the lines, never an independent calculation. */
        const totals = persistedLines.reduce(
          (acc, line) => ({
            taxable: acc.taxable + BigInt(line.taxableValue.replace('.', '')),
            tax: acc.tax + BigInt(line.taxTotal.replace('.', '')),
          }),
          { taxable: 0n, tax: 0n },
        );
        const asDecimal = (minor: bigint): string => {
          const s = minor.toString().padStart(5, '0');
          return `${s.slice(0, -4)}.${s.slice(-4)}`;
        };

        const returnNumber = await allocateReturnNumber(params.storeId, at);

        const header = await repository.insertReturn({
          id: returnId,
          storeId: params.storeId,
          orderId: owned.order.id,
          userId: params.userId,
          returnNumber,
          reason: params.reason,
          customerNote: params.customerNote,
          currency,
          refundTaxableValue: asDecimal(totals.taxable),
          refundTaxTotal: asDecimal(totals.tax),
          refundTotal: asDecimal(totals.taxable + totals.tax),
          deliveredAt,
        });

        await repository.insertReturnLines(persistedLines);

        await repository.insertEvent({
          returnId,
          storeId: params.storeId,
          fromStatus: null,
          toStatus: 'requested',
          actorType: 'customer',
          actorUserId: params.userId,
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: RETURN_AUDIT.requested,
          resourceType: RETURN_RESOURCE,
          resourceId: header.id,
          metadata: {
            returnNumber: header.returnNumber,
            orderNumber: owned.order.orderNumber,
            reason: header.reason,
            refundTotal: header.refundTotal,
            lines: persistedLines.length,
          },
        });

        const stored = await repository.listReturnLines({
          returnId,
          storeId: params.storeId,
        });
        const view: ReturnView = {
          header: { ...header, orderNumber: owned.order.orderNumber },
          lines: stored,
        };

        /*
         * The claim completes INSIDE the transaction, so a replay cannot reproduce a response
         * for a return that rolled back.
         */
        await idempotency.complete({
          storeId: params.storeId,
          userId: params.userId,
          key: params.idempotency.key,
          endpoint: params.idempotency.endpoint,
          status: 201,
          body: params.renderResponse(view),
        });

        logger.info(
          {
            storeId: params.storeId,
            returnNumber: header.returnNumber,
            orderNumber: owned.order.orderNumber,
          },
          'return_requested',
        );

        return view;
      });
    },

    /**
     * Cancel a return the customer raised.
     *
     * Only from `approved`, the one cancellable state the approved rules name. A second
     * cancellation is a `409` rather than a silent success: a client that receives the same
     * answer twice cannot tell whether it cancelled something or nothing.
     */
    async cancelReturn(params: {
      returnNumber: string;
      userId: string;
      storeId: string;
      actor: AuditActor;
    }): Promise<ReturnView> {
      return withTransaction(db, logger, async () => {
        const locked = await repository.lockOwnedReturnByNumber({
          returnNumber: params.returnNumber,
          userId: params.userId,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('return');

        if (!isCustomerCancellable(locked.status) || !canTransition(locked.status, 'cancelled')) {
          throw new ReturnNotTransitionable(locked.status, 'cancelled');
        }

        const moved = await repository.transitionStatus({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'cancelled',
          closedAt: now(),
        });
        /*
         * The CAS matched nothing, which under the row lock means a concurrent transition
         * committed first. Throwing rolls this back, so no event or audit records a change
         * that did not happen.
         */
        if (!moved) throw new ReturnNotTransitionable(locked.status, 'cancelled');

        await repository.insertEvent({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'cancelled',
          actorType: 'customer',
          actorUserId: params.userId,
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: RETURN_AUDIT.cancelled,
          resourceType: RETURN_RESOURCE,
          resourceId: locked.id,
          metadata: { returnNumber: locked.returnNumber, fromStatus: locked.status },
        });

        return this.getReturn({
          returnNumber: params.returnNumber,
          userId: params.userId,
          storeId: params.storeId,
        });
      });
    },

    /** One return the customer owns. `404` for anyone else's, or a number that does not exist. */
    async getReturn(params: {
      returnNumber: string;
      userId: string;
      storeId: string;
    }): Promise<ReturnView> {
      const header = await repository.findOwnedReturnByNumber(params);
      if (!header) throw new NotFound('return');

      const lines = await repository.listReturnLines({
        returnId: header.id,
        storeId: params.storeId,
      });
      return { header, lines };
    },

    /** A page of the customer's returns, newest first. */
    async listReturns(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{
      items: readonly ReturnView[];
      total: number;
      limit: number;
      offset: number;
    }> {
      const page = await repository.listOwnedReturns(params);
      const lines = await repository.listLinesForReturns({
        returnIds: page.items.map((r) => r.id),
        storeId: params.storeId,
      });

      const byReturn = new Map<string, ReturnLineRecord[]>();
      for (const line of lines) {
        const bucket = byReturn.get(line.returnId) ?? [];
        bucket.push(line);
        byReturn.set(line.returnId, bucket);
      }

      return {
        items: page.items.map((header) => ({
          header,
          lines: byReturn.get(header.id) ?? [],
        })),
        total: page.total,
        limit: params.limit,
        offset: params.offset,
      };
    },

    /**
     * Move a return to a new status on a STAFF decision. The one place 40d transitions.
     *
     * Shared by approve and reject because the two differ only in the target status and the
     * audit action — everything that makes the transition safe is identical, and two copies
     * would be two places for the lock, the CAS or the history write to drift.
     *
     * The sequence is fixed:
     *
     *  1. Lock the return row, store-scoped. Staff act for a tenant, so there is no owner
     *     predicate — but the store predicate is absolute.
     *  2. Check the transition table. An illegal move is a `409`, never a silent no-op.
     *  3. CAS on the status. If it matches nothing, a concurrent actor won the race and this
     *     request throws rather than recording a transition that did not happen.
     *  4. Append the event, write the audit — both inside the same transaction, so a
     *     rollback leaves neither.
     *
     * **The frozen refund snapshot is never touched.** Approval does not recompute, reprice
     * or re-apportion anything: the amounts were fixed when the return was raised and staff
     * agreeing to it cannot change what the customer is owed.
     */
    async transitionByStaff(params: {
      returnNumber: string;
      storeId: string;
      toStatus: ReturnStatus;
      actor: AuditActor;
      auditAction: string;
      staffNote?: string;
    }): Promise<ReturnView> {
      return withTransaction(db, logger, async () => {
        const locked = await repository.lockStoreReturnByNumber({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('return');

        if (!canTransition(locked.status, params.toStatus)) {
          throw new ReturnNotTransitionable(locked.status, params.toStatus);
        }

        const closedAt = isTerminal(params.toStatus) ? now() : null;

        const moved = await repository.transitionStatus({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: params.toStatus,
          closedAt,
          ...(params.staffNote === undefined ? {} : { staffNote: params.staffNote }),
        });
        /*
         * The CAS matched nothing, which under the row lock means a concurrent transition
         * committed first. Throwing rolls this back, so no event or audit records a change
         * that did not happen.
         */
        if (!moved) throw new ReturnNotTransitionable(locked.status, params.toStatus);

        await repository.insertEvent({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: params.toStatus,
          actorType: 'staff',
          actorUserId: params.actor.type === 'staff' ? (params.actor.userId ?? null) : null,
          ...(params.staffNote === undefined ? {} : { note: params.staffNote }),
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: params.auditAction,
          resourceType: RETURN_RESOURCE,
          resourceId: locked.id,
          metadata: {
            returnNumber: locked.returnNumber,
            fromStatus: locked.status,
            toStatus: params.toStatus,
          },
        });

        logger.info(
          {
            storeId: params.storeId,
            returnNumber: locked.returnNumber,
            fromStatus: locked.status,
            toStatus: params.toStatus,
          },
          'return_transitioned_by_staff',
        );

        return this.getStoreReturn({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
      });
    },

    /** Approve a requested return. Only `requested -> approved`. */
    async approveReturn(params: {
      returnNumber: string;
      storeId: string;
      actor: AuditActor;
      staffNote?: string;
    }): Promise<ReturnView> {
      return this.transitionByStaff({
        ...params,
        toStatus: 'approved',
        auditAction: RETURN_AUDIT.approved,
      });
    },

    /**
     * Refuse a return. `requested -> rejected`, and later `received -> rejected`.
     *
     * A rejected return refunds nothing and restocks nothing, and it RELEASES its quantity
     * back to the returnable pool — the customer may raise another for the same units.
     */
    async rejectReturn(params: {
      returnNumber: string;
      storeId: string;
      actor: AuditActor;
      staffNote?: string;
    }): Promise<ReturnView> {
      return this.transitionByStaff({
        ...params,
        toStatus: 'rejected',
        auditAction: RETURN_AUDIT.rejected,
      });
    },

    /**
     * Receive the goods. `approved -> received`. Increment 59.
     *
     * The warehouse has the parcel. Nothing about money or stock happens here — the units are
     * physically present but not yet judged, so restocking them would put unexamined goods on
     * sale. That judgement is `inspectReturn`.
     *
     * The received instant is the `return_event` row this writes, not a new column: the event
     * log is already the append-only record of when each transition happened, and a second
     * timestamp on the header would be the same fact stored twice and free to disagree.
     */
    async receiveReturn(params: {
      returnNumber: string;
      storeId: string;
      actor: AuditActor;
      staffNote?: string;
    }): Promise<ReturnView> {
      return this.transitionByStaff({
        ...params,
        toStatus: 'received',
        auditAction: RETURN_AUDIT.received,
      });
    },

    /**
     * Inspect the goods and record the split. `received -> inspected`. Increment 59.
     *
     * **The counts are the output of this step and the input to completion.** For every line
     * that came back, staff say how many units are good to sell and how many are written off.
     * Neither number decides whether the customer is refunded — a smashed jar is still a jar
     * they sent back, and the frozen refund snapshot taken at creation is never touched here.
     *
     * Every line must be accounted for, and each line's two counts must sum EXACTLY to the
     * quantity returned. A partial inspection would leave completion restocking a number nobody
     * decided, so it is refused rather than defaulted. `ck_return_line_inspection_quantity`
     * catches the over-count; this catches the under-count, which a CHECK cannot see because it
     * cannot know the status.
     *
     * Rejection after inspection is deliberately impossible — `received -> rejected` is the
     * refusal edge, taken INSTEAD of this one. Reaching `inspected` already means accepted,
     * which is what makes `inspected -> completed` unconditional.
     */
    async inspectReturn(params: {
      returnNumber: string;
      storeId: string;
      actor: AuditActor;
      lines: readonly { skuCode: string; restockQuantity: number; writeOffQuantity: number }[];
      staffNote?: string;
    }): Promise<ReturnView> {
      return withTransaction(db, logger, async () => {
        const locked = await repository.lockStoreReturnByNumber({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('return');

        if (!canTransition(locked.status, 'inspected')) {
          throw new ReturnNotTransitionable(locked.status, 'inspected');
        }

        const existing = await repository.listReturnLines({
          returnId: locked.id,
          storeId: params.storeId,
        });

        const byCode = new Map(existing.map((line) => [line.skuCode, line]));

        /* Every submitted code must name a line of THIS return. */
        for (const submitted of params.lines) {
          if (!byCode.has(submitted.skuCode)) {
            throw new ReturnInspectionIncomplete(
              `${submitted.skuCode} is not a line of this return`,
              { skuCode: submitted.skuCode },
            );
          }
        }

        const submittedCodes = new Set(params.lines.map((line) => line.skuCode));
        const missing = existing
          .filter((line) => !submittedCodes.has(line.skuCode))
          .map((line) => line.skuCode);

        if (missing.length > 0) {
          throw new ReturnInspectionIncomplete(
            'every returned line must be inspected before the return can move on',
            { missing },
          );
        }

        if (submittedCodes.size !== params.lines.length) {
          throw new ReturnInspectionIncomplete('a line was inspected more than once', {});
        }

        for (const submitted of params.lines) {
          /* Present: checked above. */
          const line = byCode.get(submitted.skuCode) as (typeof existing)[number];
          const accounted = submitted.restockQuantity + submitted.writeOffQuantity;

          if (accounted !== line.quantity) {
            throw new ReturnInspectionIncomplete(
              `inspection of ${submitted.skuCode} accounts for ${String(accounted)} unit(s) but ${String(line.quantity)} came back`,
              {
                skuCode: submitted.skuCode,
                accounted,
                returned: line.quantity,
              },
            );
          }

          const written = await repository.recordInspection({
            returnId: locked.id,
            storeId: params.storeId,
            skuId: line.skuId,
            restockQuantity: submitted.restockQuantity,
            writeOffQuantity: submitted.writeOffQuantity,
          });

          /* istanbul ignore next -- the line was read under this transaction's lock. */
          if (!written) {
            throw new InvariantViolation(
              `inspection of ${submitted.skuCode} matched no line under the return lock`,
            );
          }
        }

        const moved = await repository.transitionStatus({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'inspected',
          closedAt: null,
          ...(params.staffNote === undefined ? {} : { staffNote: params.staffNote }),
        });
        if (!moved) throw new ReturnNotTransitionable(locked.status, 'inspected');

        await repository.insertEvent({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'inspected',
          actorType: 'staff',
          actorUserId: params.actor.type === 'staff' ? (params.actor.userId ?? null) : null,
          ...(params.staffNote === undefined ? {} : { note: params.staffNote }),
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: RETURN_AUDIT.inspected,
          resourceType: RETURN_RESOURCE,
          resourceId: locked.id,
          metadata: {
            returnNumber: locked.returnNumber,
            fromStatus: locked.status,
            toStatus: 'inspected',
            restockUnits: params.lines.reduce((total, line) => total + line.restockQuantity, 0),
            writeOffUnits: params.lines.reduce((total, line) => total + line.writeOffQuantity, 0),
          },
        });

        return this.getStoreReturn({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
      });
    },

    /**
     * Complete the return. `inspected -> completed`. Increment 59.
     *
     * **Not "set status = completed".** Completion is the point at which the money and the
     * stock actually move, and the ordering between them is the whole safety property:
     *
     *   1. lock the return and check the transition;
     *   2. raise the refund for the FROZEN `refundTotal` — never a figure recomputed from
     *      today's catalogue;
     *   3. **stop unless the refund succeeded.** A `failed` refund leaves the return in
     *      `inspected`, ready to try again. A `processing` one leaves it there too, and the
     *      error says explicitly that it must be reconciled rather than retried;
     *   4. restock the good-to-sell units;
     *   5. move the status, write the event and the audit row.
     *
     * Refund before restock, deliberately. If the refund fails we have moved nothing; if the
     * restock failed after a successful refund we would have given money back for goods the
     * system says are still with the customer — recoverable, but only by hand. The cheaper
     * failure goes first.
     *
     * **Restock happens exactly once**, and the guarantee is the `inspected -> completed` CAS
     * inside this transaction, not a flag: a second completion matches no row, throws, and rolls
     * back its own stock movement. `uq_refund_return_live` is the second line — a concurrent
     * pair cannot both insert a live refund for one return.
     *
     * A refund of nothing is not raised at all. A return whose frozen `refundTotal` is zero is
     * possible (a fully discounted line), and asking a gateway to move zero rupees would be a
     * request the provider rejects and an operator has to explain.
     */
    async completeReturn(params: {
      returnNumber: string;
      storeId: string;
      actor: AuditActor;
      staffNote?: string;
    }): Promise<ReturnView> {
      return withTransaction(db, logger, async () => {
        const locked = await repository.lockStoreReturnByNumber({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('return');

        if (!canTransition(locked.status, 'completed')) {
          throw new ReturnNotTransitionable(locked.status, 'completed');
        }

        const lines = await repository.listReturnLines({
          returnId: locked.id,
          storeId: params.storeId,
        });

        /*
         * The FROZEN figure, from the header written at creation. Never recomputed, and never
         * summed from the current catalogue — that is the rule the whole returns increment is
         * built on and completion is where it would be easiest to break.
         */
        const refundAmount = locked.refundTotal;
        const refundable = Number.parseFloat(refundAmount) > 0;

        let raised: Awaited<ReturnType<ReturnRefunds['refundForReturn']>> | null = null;

        if (refundable) {
          raised = await refunds.refundForReturn({
            storeId: params.storeId,
            orderId: locked.orderId,
            returnId: locked.id,
            amount: refundAmount,
            actor: params.actor,
          });

          /*
           * A manual refund is an OBLIGATION, not a transfer, and it is `pending` by design —
           * COD money goes back by a route this backend has no visibility of. Blocking
           * completion on it would mean a COD return could never close. A provider refund is
           * different: the gateway is authoritative and its answer is available now.
           */
          if (raised.mode === 'provider' && raised.status !== 'succeeded') {
            throw new ReturnRefundNotSettled(
              raised.refundNumber,
              raised.status,
              raised.failureCode,
            );
          }
        }

        const restockLines = lines
          .filter((line) => line.restockQuantity > 0)
          .map((line) => ({ skuId: line.skuId, quantity: line.restockQuantity }));

        if (restockLines.length > 0) {
          const actorUserId = params.actor.type === 'staff' ? params.actor.userId : undefined;
          /* istanbul ignore next -- `requireStaff` runs before this route's handler. */
          if (actorUserId === undefined) {
            throw new InvariantViolation('completing a return requires a staff actor');
          }

          await inventory.restockForReturn({
            storeId: params.storeId,
            lines: restockLines,
            actorUserId,
            note: `return ${locked.returnNumber}`,
          });
        }

        const closedAt = now();

        const moved = await repository.transitionStatus({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'completed',
          closedAt,
          ...(params.staffNote === undefined ? {} : { staffNote: params.staffNote }),
        });
        /*
         * The CAS matched nothing under the row lock, so a concurrent completion committed
         * first. Throwing rolls THIS transaction back — including its restock — so the units
         * are put back exactly once however many staff click at once.
         */
        if (!moved) throw new ReturnNotTransitionable(locked.status, 'completed');

        await repository.insertEvent({
          returnId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'completed',
          actorType: 'staff',
          actorUserId: params.actor.type === 'staff' ? (params.actor.userId ?? null) : null,
          ...(params.staffNote === undefined ? {} : { note: params.staffNote }),
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: RETURN_AUDIT.completed,
          resourceType: RETURN_RESOURCE,
          resourceId: locked.id,
          metadata: {
            returnNumber: locked.returnNumber,
            fromStatus: locked.status,
            toStatus: 'completed',
            refundTotal: refundAmount,
            currency: locked.currency,
            restockedUnits: restockLines.reduce((total, line) => total + line.quantity, 0),
            ...(raised === null
              ? { refunded: false }
              : { refunded: true, refundNumber: raised.refundNumber, refundMode: raised.mode }),
          },
        });

        logger.info(
          {
            storeId: params.storeId,
            returnNumber: locked.returnNumber,
            refundTotal: refundAmount,
            ...(raised === null ? {} : { refundNumber: raised.refundNumber }),
          },
          'return_completed',
        );

        return this.getStoreReturn({
          returnNumber: params.returnNumber,
          storeId: params.storeId,
        });
      });
    },

    /**
     * **Return counts by status for the store.** Increment 53. Read-only.
     *
     * Every status in `RETURN_STATUSES` appears, including the ones at zero. Zero-filling happens
     * here rather than in the repository because the vocabulary is domain knowledge — and it is
     * the contract: a client rendering queue tiles must not have to tell "absent" from "none".
     *
     * A status present in the data but missing from the constant is still reported. That would
     * mean a migration had introduced a state the code does not know about, and a dashboard is
     * precisely where you would want to see it rather than have it silently dropped.
     *
     * No transaction, no audit row, no event.
     */
    async summaryForStore(params: { storeId: string }): Promise<Record<string, number>> {
      const rows = await repository.countsByStatusForStore(params);

      const totals: Record<string, number> = {};
      for (const status of RETURN_STATUSES) totals[status] = 0;
      for (const row of rows) totals[row.status] = (totals[row.status] ?? 0) + row.count;
      return totals;
    },

    /**
     * The refunds raised for one return. Increment 59.
     *
     * Goes out through the same port a completion uses, so there is one definition of what a
     * refund looks like from this module's side rather than two that could disagree. Resolves
     * the return by number first, so a number from another store answers `404` rather than an
     * empty list — an empty list would say "this return has no refunds", which is a different
     * and wrong fact.
     */
    async refundsForReturn(params: { returnNumber: string; storeId: string }) {
      const header = await repository.findStoreReturnByNumber(params);
      if (!header) throw new NotFound('return');

      return refunds.listForReturn({ returnId: header.id, storeId: params.storeId });
    },

    /** One return in the store, whoever raised it. Staff read. */
    async getStoreReturn(params: { returnNumber: string; storeId: string }): Promise<ReturnView> {
      const header = await repository.findStoreReturnByNumber(params);
      if (!header) throw new NotFound('return');

      const lines = await repository.listReturnLines({
        returnId: header.id,
        storeId: params.storeId,
      });
      return { header, lines };
    },

    /**
     * One return, with everything an admin detail page shows. Increment 61.
     *
     * Four reads, fixed — header, lines, lifecycle history, refunds — and not one of them is
     * per-row. The refunds come through the existing `ReturnRefunds` port, which Increment 59
     * built and documented as being *"for the staff detail read"*; until now it was wired only
     * into the completion response.
     */
    async getStoreReturnDetail(params: {
      returnNumber: string;
      storeId: string;
    }): Promise<StaffReturnDetailView> {
      const header = await repository.findStoreReturnDetailByNumber(params);
      if (!header) throw new NotFound('return');

      const [lines, events, refundRows] = await Promise.all([
        repository.listReturnLines({ returnId: header.id, storeId: params.storeId }),
        repository.listReturnEvents({ returnId: header.id, storeId: params.storeId }),
        refunds.listForReturn({ returnId: header.id, storeId: params.storeId }),
      ]);

      /*
       * How much of each ordered line is still returnable, computed from the SAME source the
       * create path caps against — every quantity-consuming return on the order, not just this
       * one. Published so staff can see "1 of 3 still returnable" without opening every other
       * return on the order and adding up.
       *
       * A read. It re-uses the existing cap query and changes no decision; the create path
       * still recomputes it under the order lock, because only a locked read is safe to write
       * against.
       */
      const [consumed, ordered] = await Promise.all([
        repository.sumReturnedQuantities({ orderId: header.orderId, storeId: params.storeId }),
        repository.sumOrderedQuantities({ orderId: header.orderId, storeId: params.storeId }),
      ]);

      return {
        header,
        lines,
        events,
        refunds: refundRows,
        remainingBySkuId: new Map(
          [...ordered].map(([skuId, qty]) => [
            skuId,
            Math.max(qty - (consumed.get(skuId) ?? 0), 0),
          ]),
        ),
      };
    },

    /** The staff work queue: every return in the store, newest first, optionally by status. */
    async listStoreReturns(params: {
      storeId: string;
      status?: ReturnStatus;
      q?: string;
      requestedFrom?: Date;
      requestedTo?: Date;
      limit: number;
      offset: number;
    }): Promise<{
      items: readonly StaffReturnListView[];
      total: number;
      limit: number;
      offset: number;
    }> {
      const page = await repository.listStoreReturns(params);
      const lines = await repository.listLinesForReturns({
        returnIds: page.items.map((r) => r.id),
        storeId: params.storeId,
      });

      const byReturn = new Map<string, ReturnLineRecord[]>();
      for (const line of lines) {
        const bucket = byReturn.get(line.returnId) ?? [];
        bucket.push(line);
        byReturn.set(line.returnId, bucket);
      }

      return {
        items: page.items.map((header) => ({
          header,
          lines: byReturn.get(header.id) ?? [],
        })),
        total: page.total,
        limit: params.limit,
        offset: params.offset,
      };
    },

    /** Exposed so a test can assert the transition table through the service surface. */
    canTransition(from: ReturnStatus, to: ReturnStatus): boolean {
      return canTransition(from, to);
    },
  };
}
