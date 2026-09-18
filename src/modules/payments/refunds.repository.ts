import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { order } from '../../db/schema/orders.js';
import { payment } from '../../db/schema/payments.js';
import { refund } from '../../db/schema/refunds.js';
import { executor } from '../../db/transaction.js';

/**
 * Refund persistence.
 *
 * Lives in the payments module because a refund is computed against a payment's captured
 * amount, and `schema-only-in-repositories` means whoever reads `payment` owns the query. A
 * separate `refunds` module would have to import this module's tables to answer "how much is
 * left", which is exactly the cross-module import the architecture forbids.
 *
 * Every method takes `storeId` and puts it in the predicate. Tenancy is enforced here, not
 * trusted from a caller.
 *
 * ## The one query that matters
 *
 * `lockPaymentForRefund` takes a row lock on the PAYMENT, not on the refunds. That is
 * deliberate and it is what makes the refundable-balance check correct under concurrency: two
 * concurrent refunds against one payment serialise on that row, so the second reads the first's
 * committed refund and sees the reduced balance. Locking the existing refunds instead would
 * lock nothing at all when there are none — which is precisely the first-double-refund case.
 */

export {
  REFUND_STATUSES,
  REFUND_MODES,
  INITIAL_REFUND_STATUS,
  BALANCE_CONSUMING_REFUND_STATUSES,
  TERMINAL_REFUND_STATUSES,
  REFUND_NUMBER_ALPHABET,
  REFUND_NUMBER_SUFFIX_LENGTH,
  type RefundStatus,
  type RefundMode,
} from '../../db/schema/refunds.js';

import { type RefundMode, type RefundStatus } from '../../db/schema/refunds.js';

export type RefundsRepository = ReturnType<typeof createRefundsRepository>;

/** A refund, exactly as stored. `amount` stays the canonical `NUMERIC(19,4)` string. */
export type RefundRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly returnId: string | null;
  readonly refundNumber: string;
  readonly mode: RefundMode;
  readonly provider: string | null;
  readonly providerRefundId: string | null;
  readonly status: RefundStatus;
  readonly currency: string;
  readonly amount: string;
  readonly amountMinor: number;
  readonly failureCode: string | null;
  readonly requestKey: string | null;
  readonly initiatedBy: string;
  readonly settledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const REFUND_COLUMNS = {
  id: refund.id,
  storeId: refund.storeId,
  paymentId: refund.paymentId,
  orderId: refund.orderId,
  returnId: refund.returnId,
  refundNumber: refund.refundNumber,
  mode: refund.mode,
  provider: refund.provider,
  providerRefundId: refund.providerRefundId,
  status: refund.status,
  currency: refund.currency,
  amount: refund.amount,
  amountMinor: refund.amountMinor,
  failureCode: refund.failureCode,
  requestKey: refund.requestKey,
  initiatedBy: refund.initiatedBy,
  settledAt: refund.settledAt,
  createdAt: refund.createdAt,
  updatedAt: refund.updatedAt,
} as const;

/**
 * The payment a refund is being raised against, with the order number a caller addresses it by.
 *
 * `capturedAmount` is `payment.amount` when the payment SUCCEEDED and `'0'` otherwise — the
 * projection is done in SQL rather than left to the caller so that "what is refundable" has one
 * definition, in the layer that can see the status column.
 */
export type RefundablePayment = {
  readonly paymentId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly userId: string;
  readonly method: string;
  readonly provider: string | null;
  readonly providerTransactionId: string | null;
  readonly status: string;
  readonly currency: string;
  readonly capturedAmount: string;
  /** The payment's full amount, regardless of status. The COD capture rule needs it. */
  readonly amount: string;
};

export type InsertRefundValues = {
  readonly id: string;
  readonly storeId: string;
  readonly paymentId: string;
  readonly orderId: string;
  readonly returnId: string | null;
  readonly refundNumber: string;
  readonly mode: RefundMode;
  readonly provider: string | null;
  readonly status: RefundStatus;
  readonly currency: string;
  readonly amount: string;
  readonly amountMinor: number;
  readonly requestKey: string | null;
  readonly initiatedBy: string;
};

/**
 * The narrowing cast at the repository boundary.
 *
 * `mode` and `status` are `varchar` with a `CHECK`, not PostgreSQL enums, so Drizzle types
 * them as `string`. The CHECK constraints are what make the cast sound; doing it once here
 * means the service and the DTOs work in the domain vocabulary rather than re-asserting it.
 * The same device `toPaymentRecord` uses in this module's other repository.
 */
function toRefundRecord(row: {
  id: string;
  storeId: string;
  paymentId: string;
  orderId: string;
  returnId: string | null;
  refundNumber: string;
  mode: string;
  provider: string | null;
  providerRefundId: string | null;
  status: string;
  currency: string;
  amount: string;
  amountMinor: number;
  failureCode: string | null;
  requestKey: string | null;
  initiatedBy: string;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): RefundRecord {
  return {
    ...row,
    mode: row.mode as RefundMode,
    status: row.status as RefundStatus,
  };
}

export function createRefundsRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Lock the order's payment and return what a refund decision needs.
     *
     * `FOR UPDATE` on `payment` — see the header. The lock must be taken inside the caller's
     * transaction; a caller outside one would take it and release it immediately, which is
     * worse than not taking it because the code would read as if it were safe.
     *
     * Joined to `order` for the order number rather than requiring the caller to resolve it
     * separately: the caller already has the number, and a second lookup is a second chance to
     * resolve it in the wrong store.
     */
    async lockPaymentForRefund(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<RefundablePayment | undefined> {
      const [row] = await executor(db)
        .select({
          paymentId: payment.id,
          orderId: payment.orderId,
          orderNumber: order.orderNumber,
          userId: payment.userId,
          method: payment.method,
          provider: payment.provider,
          providerTransactionId: payment.providerTransactionId,
          status: payment.status,
          currency: payment.currency,
          /*
           * A payment that never succeeded has nothing to give back. Expressed here rather than
           * in the service so the rule cannot be restated differently by a second caller.
           */
          capturedAmount: sql<string>`case when ${payment.status} = 'succeeded' then ${payment.amount} else '0' end`,
          amount: payment.amount,
        })
        .from(payment)
        .innerJoin(order, and(eq(order.id, payment.orderId), eq(order.storeId, payment.storeId)))
        .where(and(eq(payment.storeId, params.storeId), eq(order.orderNumber, params.orderNumber)))
        .limit(1)
        .for('update', { of: payment });

      return row;
    },

    /**
     * Lock the payment behind a RETURN, by return id.
     *
     * The return path reaches the payment through the order rather than through the return
     * number, because `uq_payment_order` makes the order the only link there is. Same lock, same
     * reason.
     */
    async lockPaymentForReturnRefund(params: {
      orderId: string;
      storeId: string;
    }): Promise<RefundablePayment | undefined> {
      const [row] = await executor(db)
        .select({
          paymentId: payment.id,
          orderId: payment.orderId,
          orderNumber: order.orderNumber,
          userId: payment.userId,
          method: payment.method,
          provider: payment.provider,
          providerTransactionId: payment.providerTransactionId,
          status: payment.status,
          currency: payment.currency,
          capturedAmount: sql<string>`case when ${payment.status} = 'succeeded' then ${payment.amount} else '0' end`,
          amount: payment.amount,
        })
        .from(payment)
        .innerJoin(order, and(eq(order.id, payment.orderId), eq(order.storeId, payment.storeId)))
        .where(and(eq(payment.storeId, params.storeId), eq(payment.orderId, params.orderId)))
        .limit(1)
        .for('update', { of: payment });

      return row;
    },

    /**
     * What previous refunds have already claimed against this payment.
     *
     * TWO figures from ONE scan, because they answer different questions and must not be
     * confused. `claimed` sums `pending`, `processing` AND `succeeded` — see
     * `BALANCE_CONSUMING_REFUND_STATUSES` for why an unresolved attempt reserves its amount —
     * and is what the remaining balance is computed against. `settled` sums only `succeeded`
     * and is what actually went back to the customer.
     *
     * They differ exactly while an attempt is in flight, which is the window in which reporting
     * either one as the other would be a lie. `coalesce` because `SUM` over no rows is NULL,
     * and a NULL here would silently become "nothing is claimed".
     *
     * Returns a string: the sum is `NUMERIC(19,4)` and parsing it into a `number` to add it up
     * would be exactly the floating-point arithmetic `money.ts` exists to prevent.
     */
    async sumRefundsForPayment(params: {
      paymentId: string;
      storeId: string;
    }): Promise<{ claimed: string; settled: string }> {
      const [row] = await executor(db)
        .select({
          /* What blocks a further refund: succeeded PLUS everything still in flight. */
          claimed: sql<string>`coalesce(sum(${refund.amount}) filter (
            where ${refund.status} in ('pending', 'processing', 'succeeded')
          ), 0)::text`,
          /* What has actually gone back. The figure a customer would recognise. */
          settled: sql<string>`coalesce(sum(${refund.amount}) filter (
            where ${refund.status} = 'succeeded'
          ), 0)::text`,
        })
        .from(refund)
        .where(and(eq(refund.storeId, params.storeId), eq(refund.paymentId, params.paymentId)));

      return { claimed: row?.claimed ?? '0', settled: row?.settled ?? '0' };
    },

    async insertRefund(values: InsertRefundValues): Promise<RefundRecord> {
      const [row] = await executor(db).insert(refund).values(values).returning(REFUND_COLUMNS);
      /* istanbul ignore next -- INSERT ... RETURNING either returns a row or throws. */
      if (!row) throw new Error('insert refund returned no row');
      return toRefundRecord(row);
    },

    /**
     * Move a refund to a new status. Compare-and-swap on the CURRENT status.
     *
     * `WHERE status = :fromStatus` is what makes a duplicate settlement a no-op rather than a
     * second write: the second attempt matches nothing and returns `undefined`, so the caller
     * can tell "I moved it" from "somebody else already did" without a second read.
     */
    async transitionRefund(params: {
      refundId: string;
      storeId: string;
      fromStatus: RefundStatus;
      toStatus: RefundStatus;
      providerRefundId?: string | null;
      failureCode?: string | null;
      settledAt: Date | null;
      at: Date;
    }): Promise<RefundRecord | undefined> {
      const [row] = await executor(db)
        .update(refund)
        .set({
          status: params.toStatus,
          settledAt: params.settledAt,
          updatedAt: params.at,
          ...(params.providerRefundId === undefined
            ? {}
            : { providerRefundId: params.providerRefundId }),
          ...(params.failureCode === undefined ? {} : { failureCode: params.failureCode }),
        })
        .where(
          and(
            eq(refund.storeId, params.storeId),
            eq(refund.id, params.refundId),
            eq(refund.status, params.fromStatus),
          ),
        )
        .returning(REFUND_COLUMNS);

      return row === undefined ? undefined : toRefundRecord(row);
    },

    /** Every refund against one payment, newest first. The payment-detail read. */
    async listForPayment(params: { paymentId: string; storeId: string }): Promise<RefundRecord[]> {
      return executor(db)
        .select(REFUND_COLUMNS)
        .from(refund)
        .where(and(eq(refund.storeId, params.storeId), eq(refund.paymentId, params.paymentId)))
        .orderBy(desc(refund.createdAt), desc(refund.id))
        .then((rows) => rows.map(toRefundRecord));
    },

    /** Every refund raised for one return. The return-detail read. */
    async listForReturn(params: { returnId: string; storeId: string }): Promise<RefundRecord[]> {
      return executor(db)
        .select(REFUND_COLUMNS)
        .from(refund)
        .where(and(eq(refund.storeId, params.storeId), eq(refund.returnId, params.returnId)))
        .orderBy(desc(refund.createdAt), desc(refund.id))
        .then((rows) => rows.map(toRefundRecord));
    },

    async findByNumber(params: {
      refundNumber: string;
      storeId: string;
    }): Promise<RefundRecord | undefined> {
      const [row] = await executor(db)
        .select(REFUND_COLUMNS)
        .from(refund)
        .where(
          and(eq(refund.storeId, params.storeId), eq(refund.refundNumber, params.refundNumber)),
        )
        .limit(1);
      return row === undefined ? undefined : toRefundRecord(row);
    },

    /** Lock one refund by its public number, for a settlement decision. */
    async lockByNumber(params: {
      refundNumber: string;
      storeId: string;
    }): Promise<RefundRecord | undefined> {
      const [row] = await executor(db)
        .select(REFUND_COLUMNS)
        .from(refund)
        .where(
          and(eq(refund.storeId, params.storeId), eq(refund.refundNumber, params.refundNumber)),
        )
        .limit(1)
        .for('update');
      return row === undefined ? undefined : toRefundRecord(row);
    },

    /**
     * Lock one refund by its PRIMARY KEY, for a provider webhook. Increment 60.
     *
     * **The only lookup in this file with no `storeId` predicate, and the only one that may
     * have none.** A webhook has no tenant: it arrives unauthenticated on a route where
     * `resolveStore` deliberately does not run, so a store could only come from the request
     * body — which is precisely what must never be trusted. The id supplied here is a UUIDv7
     * this system generated and sent to the provider, so it is globally unique on its own; the
     * store is then READ OFF the row that comes back and used for every subsequent write.
     *
     * That inversion is what keeps tenancy honest: nothing the provider says selects a tenant,
     * it only names a row whose tenant we already recorded. A forged id names no row.
     *
     * `for('update')` because the caller compare-and-swaps the status immediately after, and
     * two concurrent deliveries of the same event must serialise rather than race.
     */
    async lockById(params: { refundId: string }): Promise<RefundRecord | undefined> {
      const [row] = await executor(db)
        .select(REFUND_COLUMNS)
        .from(refund)
        .where(eq(refund.id, params.refundId))
        .limit(1)
        .for('update');
      return row === undefined ? undefined : toRefundRecord(row);
    },

    async refundNumberExists(params: { refundNumber: string; storeId: string }): Promise<boolean> {
      const [row] = await executor(db)
        .select({ one: sql<number>`1` })
        .from(refund)
        .where(
          and(eq(refund.storeId, params.storeId), eq(refund.refundNumber, params.refundNumber)),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
