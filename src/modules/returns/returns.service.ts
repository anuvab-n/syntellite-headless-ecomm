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
  type ReturnLineRecord,
  type ReturnRecord,
  type ReturnsRepository,
  type ReturnStatus,
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
  db: Database;
  audit: AuditTrail;
  logger: Logger;
  /** Injected so a test can freeze the return window without waiting seven days. */
  now?: () => Date;
}) {
  const { repository, orders, fulfilment, idempotency, db, audit, logger } = deps;
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

    /** The staff work queue: every return in the store, newest first, optionally by status. */
    async listStoreReturns(params: {
      storeId: string;
      status?: ReturnStatus;
      limit: number;
      offset: number;
    }): Promise<{
      items: readonly ReturnView[];
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
