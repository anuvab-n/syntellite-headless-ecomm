import { and, asc, count, desc, eq, exists, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { product, sku } from '../../db/schema/catalogue.js';
import { appUser } from '../../db/schema/identity.js';
import { order, orderLine } from '../../db/schema/orders.js';
import { returnEvent, returnLine, returnRequest } from '../../db/schema/returns.js';
import { executor } from '../../db/transaction.js';
import { newId } from '../../shared/id.js';
import { exclusiveEndOfMillisecond } from '../../shared/time-bounds.js';

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
  /** The product's current name, joined live so staff see what is on the shelf today. */
  readonly productName: string;
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

/**
 * The customer, as the admin queue and detail show them. Increment 61.
 *
 * Joined rather than carried through a port, for the reason this file already joins `order` and
 * `sku`: `no-cross-module-imports` governs `src/modules/*`, and `db/schema/*` is the shared
 * persistence layer beneath every module. `orders.repository.ts` searches `app_user.email` the
 * same way. A port here would be a second abstraction over a join this file is already allowed
 * to write.
 *
 * Email and name only. No phone, no password material, no verification timestamps — an admin
 * return queue needs to identify a person, not to hold their account.
 */
const RETURN_CUSTOMER_COLUMNS = {
  customerEmail: appUser.email,
  customerFirstName: appUser.firstName,
  customerLastName: appUser.lastName,
} as const;

const RETURN_LINE_COLUMNS = {
  returnId: returnLine.returnId,
  skuId: returnLine.skuId,
  skuCode: sku.code,
  /**
   * The product's CURRENT name, joined live. Increment 61.
   *
   * The one place this module reads a mutable catalogue value, and it is deliberate: staff
   * handling a physical parcel need the name the product has on the shelf today, not the name
   * it had when the order was placed. Nothing financial is read this way — every figure on a
   * return line is the frozen snapshot beside it, and none of them is recomputed from here.
   */
  productName: product.name,
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

/** What the staff queue carries beyond the stored header. Increment 61. */
export type StaffReturnListExtras = {
  readonly orderNumber: string;
  readonly customerEmail: string;
  readonly customerFirstName: string;
  readonly customerLastName: string;
};

/**
 * What the staff DETAIL carries beyond the queue. Increment 61.
 *
 * The address fields are the order's snapshot, not the live address row.
 */
export type StaffReturnDetailExtras = StaffReturnListExtras & {
  readonly shipRecipientName: string;
  readonly shipPhone: string;
  readonly shipLine1: string;
  readonly shipLine2: string;
  readonly shipLandmark: string;
  readonly shipCity: string;
  readonly shipState: string;
  readonly shipPostalCode: string;
  readonly shipCountryCode: string;
};

/** One append-only lifecycle entry, as the admin detail publishes it. Increment 61. */
export type ReturnEventRecord = {
  readonly fromStatus: ReturnStatus | null;
  readonly toStatus: ReturnStatus;
  readonly actorType: string;
  readonly note: string;
  readonly createdAt: Date;
};

/**
 * The staff queue's WHERE clause. Increment 61.
 *
 * Built in one place so the page and its count cannot drift — a total computed from a different
 * predicate than the rows is the failure where an operator pages past the end of a filter.
 *
 * **`store_id` is unconditional and first.** Every other clause narrows within a tenant; none can
 * widen past one, and no caller can omit it because the parameter is required.
 */
function staffReturnFilter(
  db: Database,
  params: {
    storeId: string;
    status?: ReturnStatus;
    q?: string;
    requestedFrom?: Date;
    requestedTo?: Date;
  },
) {
  const clauses = [eq(returnRequest.storeId, params.storeId)];

  if (params.status !== undefined) clauses.push(eq(returnRequest.status, params.status));

  if (params.requestedFrom !== undefined) {
    clauses.push(gte(returnRequest.requestedAt, params.requestedFrom));
  }

  /*
   * INCLUSIVE, expressed as a half-open upper bound. `requested_at` is microsecond-precise in
   * PostgreSQL and millisecond-precise everywhere in this API, so a plain `<=` drops every
   * return whose stored microseconds are non-zero — including the one the operator copied the
   * bound from. `exclusiveEndOfMillisecond` carries the full reasoning; the orders, payments
   * and customer lists use the same helper for the same reason, and this form stays sargable.
   */
  if (params.requestedTo !== undefined) {
    clauses.push(lt(returnRequest.requestedAt, exclusiveEndOfMillisecond(params.requestedTo)));
  }

  /*
   * The operator's search box: case-insensitive SUBSTRING match over the four handles they
   * actually arrive with — the return number, the order number, the customer's email, and a SKU
   * code from the parcel in front of them.
   *
   * `%` and `_` are escaped first. An unescaped `%` turns a typo into a pattern that matches
   * everything, which reads to an operator as "the filter is broken" rather than as a wide match.
   *
   * Deliberately NOT a search over customer names, addresses or notes: a wider search is a wider
   * disclosure, and `orders.repository.ts` draws the line in the same place for the same reason.
   *
   * The SKU arm is an EXISTS rather than a join. A return has many lines, and joining them to
   * filter would emit one row per matching line — duplicating headers in the page and inflating
   * the count. EXISTS answers "does any line match" without changing the row set.
   */
  if (params.q !== undefined && params.q.length > 0) {
    const term = `%${params.q.replace(/([\\%_])/gu, '\\$1')}%`;
    const match = or(
      ilike(returnRequest.returnNumber, term),
      ilike(order.orderNumber, term),
      ilike(appUser.email, term),
      exists(
        executor(db)
          .select({ one: sql`1` })
          .from(returnLine)
          .innerJoin(sku, and(eq(returnLine.skuId, sku.id), eq(returnLine.storeId, sku.storeId)))
          .where(
            and(
              eq(returnLine.returnId, returnRequest.id),
              /* The tenant again, on the correlated side — a subquery is not exempt. */
              eq(returnLine.storeId, returnRequest.storeId),
              ilike(sku.code, term),
            ),
          ),
      ),
    );
    if (match) clauses.push(match);
  }

  return and(...clauses);
}

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

    /**
     * How many units of each SKU the order contained. Increment 61.
     *
     * The denominator of "how much is still returnable", paired with `sumReturnedQuantities`
     * above. Unlocked, because this is a read for a page rather than the basis of a write — the
     * create path still takes the order lock and recomputes, and nothing here is allowed to
     * stand in for that.
     *
     * Reads `order_line` directly, exactly as this file already reads `order`, `sku` and
     * `app_user`: `db/schema` is the shared persistence layer, and `no-cross-module-imports`
     * governs `src/modules/*`.
     */
    async sumOrderedQuantities(params: {
      orderId: string;
      storeId: string;
    }): Promise<Map<string, number>> {
      const rows = await executor(db)
        .select({ skuId: orderLine.skuId, total: sql<string>`sum(${orderLine.quantity})` })
        .from(orderLine)
        .where(and(eq(orderLine.orderId, params.orderId), eq(orderLine.storeId, params.storeId)))
        .groupBy(orderLine.skuId);

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

    /**
     * Record what inspection decided, one SKU at a time. Increment 59.
     *
     * Store-scoped and return-scoped in the predicate, so a line id from another tenant or
     * another return matches nothing rather than being written. The counts are the warehouse's
     * judgement — how many units of this SKU are good to sell, and how many are written off —
     * and `ck_return_line_inspection_quantity` already refuses a pair that exceeds the quantity
     * that came back.
     *
     * Returns the number of rows written so the service can insist it accounted for every line
     * rather than silently inspecting a subset.
     */
    async recordInspection(params: {
      returnId: string;
      storeId: string;
      skuId: string;
      restockQuantity: number;
      writeOffQuantity: number;
    }): Promise<boolean> {
      const rows = await executor(db)
        .update(returnLine)
        .set({
          restockQuantity: params.restockQuantity,
          writeOffQuantity: params.writeOffQuantity,
        })
        .where(
          and(
            eq(returnLine.returnId, params.returnId),
            eq(returnLine.storeId, params.storeId),
            eq(returnLine.skuId, params.skuId),
          ),
        )
        .returning({ skuId: returnLine.skuId });

      return rows.length === 1;
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

    /**
     * One return in this STORE, whoever raised it. Staff read, no lock.
     *
     * Scoped by store and nothing else: staff act for a tenant, not for a customer, so the
     * owner predicate the customer read carries would wrongly hide a colleague’s case.
     * The store predicate is still absolute — staff of one tenant never see another’s.
     */
    /**
     * One return, with everything the admin DETAIL page needs that is not on the header.
     *
     * Separate from `findStoreReturnByNumber` on purpose: that one backs the lifecycle
     * mutations, which run several times per return and must not pay for joins their response
     * does not use. This one runs once, when a human opens a page.
     *
     * The address is the ORDER'S SNAPSHOT — `order.ship_*` — never the live `address` row. The
     * orders schema explains why at length: *"the moment a past invoice reads a live address, a
     * customer fixing a typo rewrites history"*. A parcel is coming back from where it was
     * actually sent, not from wherever that customer lives today.
     */
    async findStoreReturnDetailByNumber(params: {
      returnNumber: string;
      storeId: string;
    }): Promise<(ReturnRecord & StaffReturnDetailExtras) | undefined> {
      const [row] = await executor(db)
        .select({
          ...RETURN_COLUMNS,
          orderNumber: order.orderNumber,
          ...RETURN_CUSTOMER_COLUMNS,
          shipRecipientName: order.shipRecipientName,
          shipPhone: order.shipPhone,
          shipLine1: order.shipLine1,
          shipLine2: order.shipLine2,
          shipLandmark: order.shipLandmark,
          shipCity: order.shipCity,
          shipState: order.shipState,
          shipPostalCode: order.shipPostalCode,
          shipCountryCode: order.shipCountryCode,
        })
        .from(returnRequest)
        .innerJoin(
          order,
          and(eq(returnRequest.orderId, order.id), eq(returnRequest.storeId, order.storeId)),
        )
        .innerJoin(appUser, eq(returnRequest.userId, appUser.id))
        .where(
          and(
            eq(returnRequest.returnNumber, params.returnNumber),
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1);

      /*
       * `toReturn` LAST: it is what narrows `status` from the driver's `string` to
       * `ReturnStatus`, and spreading the raw row after it would put the wide type back.
       */
      return row === undefined ? undefined : { ...row, ...toReturn(row) };
    },

    async findStoreReturnByNumber(params: {
      returnNumber: string;
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
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : { ...toReturn(row), orderNumber: row.orderNumber };
    },

    /**
     * Lock one return by number for a STAFF transition. Store-scoped, no owner predicate.
     *
     * The lock is taken because the decision that follows spans statements — read the status,
     * apply the CAS, append the event, write the audit — and a second staff member must not
     * interleave with any of it.
     *
     * **`FOR NO KEY UPDATE`, not `FOR UPDATE`**, and the difference is load-bearing since
     * Increment 59. Every staff transition updates non-key columns only — `status`,
     * `closed_at`, `staff_note` — so the weaker mode is sufficient for mutual exclusion
     * between staff.
     *
     * `FOR UPDATE` would additionally block `FOR KEY SHARE`, which is the lock PostgreSQL
     * takes on a parent row when a child row referencing it is inserted. Completion inserts a
     * `refund` carrying `fk_refund_return_store` from a SEPARATE connection — separate so the
     * refund survives a completion that then refuses — and under `FOR UPDATE` that insert
     * blocks on this lock while this transaction waits for the refund. That is a genuine
     * deadlock, and it was observed before this was weakened, not reasoned about afterwards.
     */
    async lockStoreReturnByNumber(params: {
      returnNumber: string;
      storeId: string;
    }): Promise<ReturnRecord | undefined> {
      const [row] = await executor(db)
        .select(RETURN_COLUMNS)
        .from(returnRequest)
        .where(
          and(
            eq(returnRequest.returnNumber, params.returnNumber),
            eq(returnRequest.storeId, params.storeId),
          ),
        )
        .limit(1)
        .for('no key update');
      return row === undefined ? undefined : toReturn(row);
    },

    /**
     * The staff work queue: every return in the store, newest first, optionally by status.
     *
     * The page and the total share ONE predicate, so a caller on the last page is never told
     * about rows it cannot reach.
     */
    async listStoreReturns(params: {
      storeId: string;
      status?: ReturnStatus;
      q?: string;
      requestedFrom?: Date;
      requestedTo?: Date;
      limit: number;
      offset: number;
    }): Promise<{ items: (ReturnRecord & StaffReturnListExtras)[]; total: number }> {
      const predicate = staffReturnFilter(db, params);

      /*
       * ONE query for the page, joined — not a per-row lookup. The customer and the order number
       * come back on the same row as the header, and the lines for the whole page are fetched in
       * a single batched call by the service. No N+1 on either axis.
       */
      const rows = await executor(db)
        .select({
          ...RETURN_COLUMNS,
          orderNumber: order.orderNumber,
          ...RETURN_CUSTOMER_COLUMNS,
        })
        .from(returnRequest)
        .innerJoin(
          order,
          and(eq(returnRequest.orderId, order.id), eq(returnRequest.storeId, order.storeId)),
        )
        .innerJoin(appUser, eq(returnRequest.userId, appUser.id))
        .where(predicate)
        .orderBy(desc(returnRequest.requestedAt), desc(returnRequest.returnNumber))
        .limit(params.limit)
        .offset(params.offset);

      /*
       * The count repeats the SAME joins, because the search predicate reaches into `order` and
       * `app_user`. Counting over `return_request` alone would report a total the page could
       * never reach.
       */
      const [counted] = await executor(db)
        .select({ total: sql<string>`count(*)` })
        .from(returnRequest)
        .innerJoin(
          order,
          and(eq(returnRequest.orderId, order.id), eq(returnRequest.storeId, order.storeId)),
        )
        .innerJoin(appUser, eq(returnRequest.userId, appUser.id))
        .where(predicate);

      return {
        items: rows.map((r) => ({
          ...toReturn(r),
          orderNumber: r.orderNumber,
          customerEmail: r.customerEmail,
          customerFirstName: r.customerFirstName,
          customerLastName: r.customerLastName,
        })),
        total: Number(counted?.total ?? 0),
      };
    },

    /**
     * The append-only lifecycle history of one return, oldest first. Increment 61.
     *
     * `return_event` has been written on every transition since Increment 40d and read by
     * nothing until now. This is a READ — there is no second history table, no backfill and no
     * rewrite of what is already recorded.
     *
     * Ordered by `(created_at, id)`. The timestamp alone is not a total order: two transitions
     * inside one transaction share `now()`, and `id` is UUIDv7, so it breaks the tie in the
     * order the rows were actually created. `ix_return_event_return (return_id, created_at)`
     * already serves the leading column.
     */
    async listReturnEvents(params: {
      returnId: string;
      storeId: string;
    }): Promise<ReturnEventRecord[]> {
      const rows = await executor(db)
        .select({
          fromStatus: returnEvent.fromStatus,
          toStatus: returnEvent.toStatus,
          actorType: returnEvent.actorType,
          note: returnEvent.note,
          createdAt: returnEvent.createdAt,
        })
        .from(returnEvent)
        .where(
          and(eq(returnEvent.returnId, params.returnId), eq(returnEvent.storeId, params.storeId)),
        )
        .orderBy(asc(returnEvent.createdAt), asc(returnEvent.id));

      return rows.map((r) => ({
        ...r,
        fromStatus: r.fromStatus as ReturnStatus | null,
        toStatus: r.toStatus as ReturnStatus,
      }));
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
        .innerJoin(product, and(eq(sku.productId, product.id), eq(sku.storeId, product.storeId)))
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
        .innerJoin(product, and(eq(sku.productId, product.id), eq(sku.storeId, product.storeId)))
        .where(
          and(
            inArray(returnLine.returnId, [...params.returnIds]),
            eq(returnLine.storeId, params.storeId),
          ),
        )
        .orderBy(sku.code);
      return rows;
    },

    /**
     * **Return counts by status for the store.** Increment 53. Read-only.
     *
     * One grouped read over this module's own table — no join, so there is nothing that could
     * count another store's rows and no N+1 to avoid. `ix_return_store_status` is
     * `(store_id, status)`, which is exactly this query's shape; measured at 0.7 ms over 10,000
     * returns.
     *
     * Returns only the statuses that occur. Zero-filling against `RETURN_STATUSES` belongs to the
     * service, where the vocabulary lives — a repository that padded its own result would be
     * deciding what the domain's statuses are.
     */
    async countsByStatusForStore(params: {
      storeId: string;
    }): Promise<{ status: string; count: number }[]> {
      return executor(db)
        .select({ status: returnRequest.status, count: count() })
        .from(returnRequest)
        .where(eq(returnRequest.storeId, params.storeId))
        .groupBy(returnRequest.status);
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
