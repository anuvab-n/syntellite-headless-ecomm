import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { sku } from '../../db/schema/catalogue.js';
import { order } from '../../db/schema/orders.js';
import { returnEvent, returnLine, returnRequest } from '../../db/schema/returns.js';
import { executor } from '../../db/transaction.js';
import { newId } from '../../shared/id.js';

export {
  INITIAL_RETURN_STATUS,
  RETURN_NUMBER_ALPHABET,
  RETURN_NUMBER_SUFFIX_LENGTH,
  RETURN_REASONS,
  RETURN_STATUSES,
  TERMINAL_RETURN_STATUSES,
  type ReturnReason,
  type ReturnStatus,
} from '../../db/schema/returns.js';

import type { ReturnStatus } from '../../db/schema/returns.js';

/**
 * Statuses whose returned units still count against the ordered quantity.
 *
 * **Two statuses RELEASE their units back to the returnable pool: `rejected` and
 * `cancelled`.** Everything else holds them.
 *
 * The reasoning is the same for both, and it is about what physically happened rather than
 * about who ended the return. A `rejected` return was refused: no refund, no restock. A
 * `cancelled` return was withdrawn by the customer before the goods were ever received: again
 * no physical return, again no refund. Neither consumed anything, so neither may permanently
 * reduce what the customer is still entitled to send back.
 *
 * The cap exists to stop a line refunding more than it was worth. A return that refunds
 * nothing cannot threaten that, so counting it would only punish a customer for changing
 * their mind.
 *
 * Here rather than in `return.state.ts` because it is a WHERE-clause predicate: the
 * `schema-only-in-repositories` rule keeps persistence knowledge in the data layer.
 */
export const QUANTITY_CONSUMING_STATUSES = [
  'requested',
  'approved',
  'received',
  'inspected',
  'completed',
] as const;

export type ReturnsRepository = ReturnType<typeof createReturnsRepository>;

export type ReturnRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly returnNumber: string;
  readonly status: ReturnStatus;
  readonly reason: string;
  readonly customerNote: string;
  readonly staffNote: string;
  readonly currency: string;
  readonly refundTaxableValue: string;
  readonly refundTaxTotal: string;
  readonly refundTotal: string;
  readonly deliveredAt: Date;
  readonly requestedAt: Date;
  readonly closedAt: Date | null;
};

export type ReturnLineRecord = {
  readonly returnId: string;
  readonly skuId: string;
  /** Joined from the catalogue so a response can name the SKU the customer knows. */
  readonly skuCode: string;
  readonly quantity: number;
  readonly lineTotal: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly cgstAmount: string;
  readonly sgstAmount: string;
  readonly igstAmount: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
  readonly refundTotal: string;
  readonly restockQuantity: number;
  readonly writeOffQuantity: number;
};

const RETURN_COLUMNS = {
  id: returnRequest.id,
  storeId: returnRequest.storeId,
  orderId: returnRequest.orderId,
  userId: returnRequest.userId,
  returnNumber: returnRequest.returnNumber,
  status: returnRequest.status,
  reason: returnRequest.reason,
  customerNote: returnRequest.customerNote,
  staffNote: returnRequest.staffNote,
  currency: returnRequest.currency,
  refundTaxableValue: returnRequest.refundTaxableValue,
  refundTaxTotal: returnRequest.refundTaxTotal,
  refundTotal: returnRequest.refundTotal,
  deliveredAt: returnRequest.deliveredAt,
  requestedAt: returnRequest.requestedAt,
  closedAt: returnRequest.closedAt,
} as const;

const RETURN_LINE_COLUMNS = {
  returnId: returnLine.returnId,
  skuId: returnLine.skuId,
  skuCode: sku.code,
  quantity: returnLine.quantity,
  lineTotal: returnLine.lineTotal,
  discountAmount: returnLine.discountAmount,
  taxableValue: returnLine.taxableValue,
  cgstAmount: returnLine.cgstAmount,
  sgstAmount: returnLine.sgstAmount,
  igstAmount: returnLine.igstAmount,
  cessAmount: returnLine.cessAmount,
  taxTotal: returnLine.taxTotal,
  refundTotal: returnLine.refundTotal,
  restockQuantity: returnLine.restockQuantity,
  writeOffQuantity: returnLine.writeOffQuantity,
} as const;

const toReturn = (row: Record<string, unknown>): ReturnRecord =>
  ({ ...row, status: row['status'] as ReturnStatus }) as ReturnRecord;

/**
 * Persistence for returns.
 *
 * Every read that a decision depends on takes a lock, and every state change is a CAS —
 * `UPDATE ... WHERE status = <expected> RETURNING` — so a second concurrent actor changes
 * nothing rather than overwriting the first. The pattern is the one `fulfilment.repository`
 * and `payments.repository` already use.
 */
export function createReturnsRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * How many units of each SKU are already spoken for by earlier returns on this order.
     *
     * **Reads only the statuses that consume quantity** — a `rejected` or `cancelled` return
     * releases its units, because neither returned goods nor refunded money. Keyed by SKU id
     * so the caller can look up per line.
     *
     * Must run inside the caller's transaction, AFTER the order lock: the value it returns is
     * the basis of the remaining-quantity decision, and an unlocked read would let two
     * concurrent requests both see zero.
     */
    async sumReturnedQuantities(params: {
      orderId: string;
      storeId: string;
    }): Promise<Map<string, number>> {
      const rows = await executor(db)
        .select({
          skuId: returnLine.skuId,
          total: sql<string>`sum(${returnLine.quantity})`,
        })
        .from(returnLine)
        .innerJoin(
          returnRequest,
          and(
            eq(returnLine.returnId, returnRequest.id),
            eq(returnLine.storeId, returnRequest.storeId),
          ),
        )
        .where(
          and(
            eq(returnRequest.orderId, params.orderId),
            eq(returnRequest.storeId, params.storeId),
            inArray(returnRequest.status, [...QUANTITY_CONSUMING_STATUSES]),
          ),
        )
        .groupBy(returnLine.skuId);

      return new Map(rows.map((r) => [r.skuId, Number(r.total)]));
    },

    /** Insert the header. The caller supplies every derived value. */
    async insertReturn(values: {
      id: string;
      storeId: string;
      orderId: string;
      userId: string;
      returnNumber: string;
      reason: string;
      customerNote: string;
      currency: string;
      refundTaxableValue: string;
      refundTaxTotal: string;
      refundTotal: string;
      deliveredAt: Date;
    }): Promise<ReturnRecord> {
      const [row] = await executor(db)
        .insert(returnRequest)
        .values(values)
        .returning(RETURN_COLUMNS);
      /* istanbul ignore next -- INSERT ... RETURNING either returns a row or throws. */
      if (!row) throw new Error('return insert returned no row');
      return toReturn(row);
    },

    async insertReturnLines(
      lines: readonly {
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
      }[],
    ): Promise<void> {
      if (lines.length === 0) return;
      await executor(db)
        .insert(returnLine)
        .values([...lines]);
    },

    /**
     * Append one transition to the history. Never updated, never deleted.
     *
     * `fromStatus` is `null` only for the row that records creation.
     */
    async insertEvent(values: {
      returnId: string;
      storeId: string;
      fromStatus: ReturnStatus | null;
      toStatus: ReturnStatus;
      actorType: string;
      actorUserId: string | null;
      note?: string;
    }): Promise<void> {
      await executor(db)
        .insert(returnEvent)
        .values({ id: newId(), ...values, note: values.note ?? '' });
    },

    /**
     * Lock one return by number, scoped to the store AND the owning customer.
     *
     * The user predicate is in the WHERE clause rather than checked afterwards: another
     * customer's return must be indistinguishable from a missing one, and a query that finds
     * the row and then compares owner has already leaked that it exists via timing.
     */
    async lockOwnedReturnByNumber(params: {
      returnNumber: string;
      userId: string;
      storeId: string;
    }): Promise<ReturnRecord | undefined> {
      const [row] = await executor(db)
        .select(RETURN_COLUMNS)
        .from(returnRequest)
        .where(
          and(
            eq(returnRequest.returnNumber, params.returnNumber),
            eq(returnRequest.userId, params.userId),
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1)
        .for('update');
      return row === undefined ? undefined : toReturn(row);
    },

    /**
     * Move a return from one status to another, and stamp `closed_at` when it lands on a
     * terminal state.
     *
     * A compare-and-set: the `status = from` predicate is what makes the transition safe under
     * concurrency. It returns `undefined` when the row had already moved, which the caller
     * turns into a conflict rather than silently succeeding.
     */
    async transitionStatus(params: {
      returnId: string;
      storeId: string;
      fromStatus: ReturnStatus;
      toStatus: ReturnStatus;
      closedAt: Date | null;
      staffNote?: string;
    }): Promise<ReturnRecord | undefined> {
      const [row] = await executor(db)
        .update(returnRequest)
        .set({
          status: params.toStatus,
          closedAt: params.closedAt,
          updatedAt: new Date(),
          ...(params.staffNote === undefined ? {} : { staffNote: params.staffNote }),
        })
        .where(
          and(
            eq(returnRequest.id, params.returnId),
            eq(returnRequest.storeId, params.storeId),
            eq(returnRequest.status, params.fromStatus),
          ),
        )
        .returning(RETURN_COLUMNS);
      return row === undefined ? undefined : toReturn(row);
    },

    /** One return the customer owns, with the order number it belongs to. No lock. */
    async findOwnedReturnByNumber(params: {
      returnNumber: string;
      userId: string;
      storeId: string;
    }): Promise<(ReturnRecord & { orderNumber: string }) | undefined> {
      const [row] = await executor(db)
        .select({ ...RETURN_COLUMNS, orderNumber: order.orderNumber })
        .from(returnRequest)
        .innerJoin(
          order,
          and(eq(returnRequest.orderId, order.id), eq(returnRequest.storeId, order.storeId)),
        )
        .where(
          and(
            eq(returnRequest.returnNumber, params.returnNumber),
            eq(returnRequest.userId, params.userId),
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : { ...toReturn(row), orderNumber: row.orderNumber };
    },

    /** A page of the customer's returns, newest first, with the order number for each. */
    async listOwnedReturns(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: (ReturnRecord & { orderNumber: string })[]; total: number }> {
      const predicate = and(
        eq(returnRequest.userId, params.userId),
        eq(returnRequest.storeId, params.storeId),
      );

      const rows = await executor(db)
        .select({ ...RETURN_COLUMNS, orderNumber: order.orderNumber })
        .from(returnRequest)
        .innerJoin(
          order,
          and(eq(returnRequest.orderId, order.id), eq(returnRequest.storeId, order.storeId)),
        )
        .where(predicate)
        .orderBy(desc(returnRequest.requestedAt), desc(returnRequest.returnNumber))
        .limit(params.limit)
        .offset(params.offset);

      /*
       * The page and the total share ONE predicate, so a caller on the last page is never told
       * about rows it cannot reach.
       */
      const [counted] = await executor(db)
        .select({ total: sql<string>`count(*)` })
        .from(returnRequest)
        .where(predicate);

      return {
        items: rows.map((r) => ({ ...toReturn(r), orderNumber: r.orderNumber })),
        total: Number(counted?.total ?? 0),
      };
    },

    /** Every line of one return, ordered so a response is stable across reads. */
    async listReturnLines(params: {
      returnId: string;
      storeId: string;
    }): Promise<ReturnLineRecord[]> {
      const rows = await executor(db)
        .select(RETURN_LINE_COLUMNS)
        .from(returnLine)
        .innerJoin(sku, and(eq(returnLine.skuId, sku.id), eq(returnLine.storeId, sku.storeId)))
        .where(
          and(eq(returnLine.returnId, params.returnId), eq(returnLine.storeId, params.storeId)),
        )
        .orderBy(sku.code);
      return rows;
    },

    /** Lines for several returns at once, so a list page costs one query rather than N. */
    async listLinesForReturns(params: {
      returnIds: readonly string[];
      storeId: string;
    }): Promise<ReturnLineRecord[]> {
      if (params.returnIds.length === 0) return [];
      const rows = await executor(db)
        .select(RETURN_LINE_COLUMNS)
        .from(returnLine)
        .innerJoin(sku, and(eq(returnLine.skuId, sku.id), eq(returnLine.storeId, sku.storeId)))
        .where(
          and(
            inArray(returnLine.returnId, [...params.returnIds]),
            eq(returnLine.storeId, params.storeId),
          ),
        )
        .orderBy(sku.code);
      return rows;
    },

    /** Does this exact return number already exist in the store? Used for collision redraw. */
    async returnNumberExists(params: { returnNumber: string; storeId: string }): Promise<boolean> {
      const [row] = await executor(db)
        .select({ one: sql<number>`1` })
        .from(returnRequest)
        .where(
          and(
            eq(returnRequest.returnNumber, params.returnNumber),
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
