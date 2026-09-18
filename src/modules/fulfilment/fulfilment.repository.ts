import { and, asc, count, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { order } from '../../db/schema/orders.js';
import { shipment, shipmentEvent } from '../../db/schema/shipments.js';
import { executor } from '../../db/transaction.js';
import { newId } from '../../shared/id.js';

/**
 * Shipment persistence.
 *
 * The only file in this module permitted to import a table — `schema-only-in-repositories`.
 * Every method takes `storeId` and puts it in the predicate; the customer-facing read takes
 * `userId` too. Ownership and tenancy are enforced HERE rather than trusted from a caller.
 *
 * `executor(db)` throughout, so a method called inside `withTransaction` joins the ambient
 * transaction — which every write path here depends on: a shipment transition, its event row,
 * the stock movement and the audit entry must commit together or not at all.
 *
 * ## Why this file may name the `order` table
 *
 * `no-cross-module-imports` forbids importing anything under `modules/orders`, but
 * `schema-only-in-repositories` explicitly permits any `*.repository.ts` to import any table.
 * The fulfilment queue joins `order` because "which orders need shipping?" is a question about
 * both tables at once, and answering it through a port would mean fetching every candidate order
 * into JavaScript and filtering there. Nothing here WRITES `order` — the queue reads it, and the
 * order lock is taken through a port so the locking discipline stays visible at the call site.
 */

export {
  SHIPMENT_STATUSES,
  INITIAL_SHIPMENT_STATUS,
  FULFILMENT_BLOCKING_STATUSES,
  type ShipmentStatus,
} from '../../db/schema/shipments.js';

import type { ShipmentStatus } from '../../db/schema/shipments.js';

export type FulfilmentRepository = ReturnType<typeof createFulfilmentRepository>;

/**
 * A shipment as the rest of the system sees it.
 *
 * `storeId` is present because the service needs it to scope subsequent writes from the LOCKED
 * row rather than from caller input — the same reason `PaymentRecord` carries it.
 */
export type ShipmentRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly status: ShipmentStatus;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly trackingUrl: string | null;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * Selected explicitly rather than with `select()`.
 *
 * A bare select would silently start returning any column a later increment adds, which is how
 * an internal field reaches a response body nobody meant to widen.
 */
const SHIPMENT_COLUMNS = {
  id: shipment.id,
  storeId: shipment.storeId,
  orderId: shipment.orderId,
  status: shipment.status,
  carrier: shipment.carrier,
  trackingNumber: shipment.trackingNumber,
  trackingUrl: shipment.trackingUrl,
  shippedAt: shipment.shippedAt,
  deliveredAt: shipment.deliveredAt,
  createdAt: shipment.createdAt,
  updatedAt: shipment.updatedAt,
} as const;

/**
 * The narrowing cast at the repository boundary.
 *
 * `status` is `varchar` + CHECK rather than a PostgreSQL enum, so Drizzle types it as `string`.
 * The CHECK is what makes the cast sound; doing it once here means the service and the DTOs work
 * in the domain vocabulary rather than re-asserting it.
 */
function toShipmentRecord(row: {
  id: string;
  storeId: string;
  orderId: string;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ShipmentRecord {
  return { ...row, status: row.status as ShipmentStatus };
}

export function createFulfilmentRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Create the shipment. `pending`, with whatever tracking is known.
     *
     * A `uq_shipment_order` violation surfaces as the driver's unique-violation error and the
     * service turns it into a domain conflict — the constraint is the arbiter, not a preceding
     * read. That is what makes two concurrent creations produce one shipment, and it is why
     * creation needs no `Idempotency-Key`.
     */
    async createShipment(params: {
      storeId: string;
      orderId: string;
      carrier: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
    }): Promise<ShipmentRecord> {
      const [row] = await executor(db)
        .insert(shipment)
        .values({
          /* Application-generated UUIDv7, so the service has the id before the INSERT. */
          id: newId(),
          storeId: params.storeId,
          orderId: params.orderId,
          carrier: params.carrier,
          trackingNumber: params.trackingNumber,
          trackingUrl: params.trackingUrl,
        })
        .returning(SHIPMENT_COLUMNS);

      /* istanbul ignore next -- INSERT ... RETURNING either returns a row or throws. */
      if (!row) throw new Error('shipment insert returned no row');
      return toShipmentRecord(row);
    },

    /**
     * Lock one shipment by id, store-scoped. The second lock in the fulfilment lock order.
     *
     * `FOR UPDATE` because the decision that follows spans statements — read the status, move
     * inventory, apply the transition, write the event — and a second staff member must not
     * interleave with any of it.
     */
    async lockById(params: {
      shipmentId: string;
      storeId: string;
    }): Promise<ShipmentRecord | undefined> {
      const [row] = await executor(db)
        .select(SHIPMENT_COLUMNS)
        .from(shipment)
        .where(and(eq(shipment.id, params.shipmentId), eq(shipment.storeId, params.storeId)))
        .limit(1)
        .for('update');
      return row === undefined ? undefined : toShipmentRecord(row);
    },

    /**
     * Which order a shipment belongs to. **No lock.**
     *
     * The ship and deliver routes address a shipment, but the lock order requires the ORDER
     * first — so something has to be read before any lock is taken. This is safe to read
     * unlocked because `shipment.order_id` is IMMUTABLE: no statement anywhere updates it, and
     * a shipment cannot move between orders. Nothing is decided from it; the caller locks the
     * order, then re-reads the shipment locked, and decides from that.
     */
    async findOrderIdForShipment(params: {
      shipmentId: string;
      storeId: string;
    }): Promise<{ orderId: string } | undefined> {
      const [row] = await executor(db)
        .select({ orderId: shipment.orderId })
        .from(shipment)
        .where(and(eq(shipment.id, params.shipmentId), eq(shipment.storeId, params.storeId)))
        .limit(1);
      return row;
    },
    /**
     * Lock one order's shipment, if it has one. Store-scoped, by ORDER id.
     *
     * Used by the ship path, which addresses an order rather than a shipment, and by the
     * cancellation guard — which needs the shipment's state under the order lock it already
     * holds.
     */
    async lockByOrderId(params: {
      orderId: string;
      storeId: string;
    }): Promise<ShipmentRecord | undefined> {
      const [row] = await executor(db)
        .select(SHIPMENT_COLUMNS)
        .from(shipment)
        .where(and(eq(shipment.orderId, params.orderId), eq(shipment.storeId, params.storeId)))
        .limit(1)
        .for('update');
      return row === undefined ? undefined : toShipmentRecord(row);
    },

    /**
     * One order's shipment state, WITHOUT a lock. For the cancellation guard's read.
     *
     * Deliberately lock-free: cancellation already holds the ORDER lock, and every path that
     * changes a shipment takes that same order lock first — so a shipment cannot change state
     * while cancellation holds it. Taking a second lock here would add contention for no
     * additional guarantee.
     */
    async findStatusByOrderId(params: {
      orderId: string;
      storeId: string;
    }): Promise<ShipmentStatus | undefined> {
      const [row] = await executor(db)
        .select({ status: shipment.status })
        .from(shipment)
        .where(and(eq(shipment.orderId, params.orderId), eq(shipment.storeId, params.storeId)))
        .limit(1);
      return row === undefined ? undefined : (row.status as ShipmentStatus);
    },

    /**
     * **Apply a transition. The compare-and-swap.**
     *
     * `WHERE status = :fromStatus` is what makes a duplicate action a no-op: a second attempt
     * matches nothing, returns `false`, and the service answers `409` — no second event row, no
     * second stock movement, and no re-stamped timestamp.
     *
     * The timestamps are set by the SAME statement that moves the status, so a `shipped` row can
     * never exist without `shipped_at` — which `ck_shipment_shipped_at` also enforces. They are
     * passed rather than defaulted so the caller's single `at` is used throughout one
     * transaction.
     */
    /**
     * When this order was delivered, or `null`.
     *
     * No lock: the returns module reads this to decide eligibility and already holds the
     * ORDER lock — the head of the global lock order. Taking a shipment lock here would add
     * a second lock in the wrong order and invite a deadlock against the ship and deliver
     * paths. A delivery instant is immutable once set, so there is nothing to race with.
     *
     * Whole-order shipments remain the v1 model, so at most one row can match.
     */
    async findDeliveredAtByOrderId(params: {
      orderId: string;
      storeId: string;
    }): Promise<Date | null> {
      const [row] = await executor(db)
        .select({ deliveredAt: shipment.deliveredAt })
        .from(shipment)
        .where(and(eq(shipment.orderId, params.orderId), eq(shipment.storeId, params.storeId)))
        .limit(1);
      return row?.deliveredAt ?? null;
    },

    async applyTransition(params: {
      shipmentId: string;
      storeId: string;
      fromStatus: ShipmentStatus;
      toStatus: ShipmentStatus;
      at: Date;
    }): Promise<boolean> {
      const updated = await executor(db)
        .update(shipment)
        .set({
          status: params.toStatus,
          ...(params.toStatus === 'shipped' ? { shippedAt: params.at } : {}),
          ...(params.toStatus === 'delivered' ? { deliveredAt: params.at } : {}),
          updatedAt: params.at,
        })
        .where(
          and(
            eq(shipment.id, params.shipmentId),
            eq(shipment.storeId, params.storeId),
            eq(shipment.status, params.fromStatus),
          ),
        )
        .returning({ id: shipment.id });

      return updated.length === 1;
    },

    /**
     * Correct the tracking facts. Never the status.
     *
     * Only the three fields a courier can change its mind about. `status`, both timestamps and
     * every identifier are absent by construction, so a tracking correction cannot become a
     * state change — the reason this is a distinct method rather than a general update.
     */
    async updateTracking(params: {
      shipmentId: string;
      storeId: string;
      carrier: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
      at: Date;
    }): Promise<ShipmentRecord | undefined> {
      const [row] = await executor(db)
        .update(shipment)
        .set({
          carrier: params.carrier,
          trackingNumber: params.trackingNumber,
          trackingUrl: params.trackingUrl,
          updatedAt: params.at,
        })
        .where(and(eq(shipment.id, params.shipmentId), eq(shipment.storeId, params.storeId)))
        .returning(SHIPMENT_COLUMNS);

      return row === undefined ? undefined : toShipmentRecord(row);
    },

    /** Append one transition row. There is no update and no delete — the table is append-only. */
    async insertEvent(values: {
      shipmentId: string;
      storeId: string;
      fromStatus: ShipmentStatus | null;
      toStatus: ShipmentStatus;
      actorType: string;
      actorUserId: string | null;
      note: string | null;
    }): Promise<void> {
      await executor(db)
        .insert(shipmentEvent)
        .values({ id: newId(), ...values });
    },

    /**
     * One order's shipment, for a customer read. **User-scoped through the order.**
     *
     * The join to `order` carrying `user_id` is what enforces ownership: another customer's
     * order, another store's order and an unknown order number are all `undefined`, so the
     * service answers one `404` and reveals nothing — the §25 rule that ownership belongs in
     * the query rather than in a comparison performed afterwards.
     */
    async findForCustomer(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
    }): Promise<{ orderExists: boolean; shipments: ShipmentRecord[] }> {
      /*
       * The order is resolved FIRST, scoped by user and store, so "not yours" and "no
       * shipment yet" are different answers. Collapsing them would make an order with no
       * shipment look like someone else's order, and an empty list is a legitimate reply for
       * an order that has not shipped.
       */
      const [found] = await executor(db)
        .select({ id: order.id })
        .from(order)
        .where(
          and(
            eq(order.orderNumber, params.orderNumber),
            eq(order.userId, params.userId),
            eq(order.storeId, params.storeId),
          ),
        )
        .limit(1);
      if (!found) return { orderExists: false, shipments: [] };

      const rows = await executor(db)
        .select(SHIPMENT_COLUMNS)
        .from(shipment)
        .where(and(eq(shipment.orderId, found.id), eq(shipment.storeId, params.storeId)))
        .orderBy(shipment.createdAt);

      return { orderExists: true, shipments: rows.map(toShipmentRecord) };
    },
    /** One order's shipment for STAFF — store-scoped, not user-scoped. */
    async findForStore(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<{ orderId: string; shipments: ShipmentRecord[] } | undefined> {
      const [found] = await executor(db)
        .select({ id: order.id })
        .from(order)
        .where(and(eq(order.orderNumber, params.orderNumber), eq(order.storeId, params.storeId)))
        .limit(1);
      if (!found) return undefined;

      const rows = await executor(db)
        .select(SHIPMENT_COLUMNS)
        .from(shipment)
        .where(and(eq(shipment.orderId, found.id), eq(shipment.storeId, params.storeId)))
        .orderBy(shipment.createdAt);

      return { orderId: found.id, shipments: rows.map(toShipmentRecord) };
    },

    /**
     * **A page of the STORE's shipments, newest first.** Increment 54.
     *
     * The store-wide counterpart of `findForStore`, which answers "this ORDER's shipments". A
     * separate method rather than an optional `orderNumber`, for the reason the repositories in
     * this project keep saying: a caller that forgot the narrowing argument would silently get
     * store-wide reach, and an optional security parameter is how that happens.
     *
     * The join to `order` carries the order number, which is how staff address an order
     * everywhere else — a shipment list that could only name internal ids would be unusable. It
     * cannot multiply rows: `uq_shipment_order` makes the relationship one-to-one, and the join
     * is pinned on `store_id` on both sides so a shipment can only ever meet its own tenant's
     * order.
     *
     * Page and count share ONE predicate, so a caller on the last page is never told the total
     * counted rows it cannot see. Ordered by `created_at DESC, id DESC`: `created_at` alone is
     * not a total order, and a non-total order makes `offset` paging skip and repeat rows.
     * `ix_shipment_store_created` serves it — measured at 0.122 ms against 11.0 ms without.
     */
    async listForStorePaged(params: {
      storeId: string;
      filters: AdminShipmentFilters;
      limit: number;
      offset: number;
    }): Promise<{ items: (ShipmentRecord & { orderNumber: string })[]; total: number }> {
      const where = adminShipmentPredicate(params.storeId, params.filters);

      /*
       * The join is repeated on the count rather than factored away: the `orderNumber` filter is
       * expressed over the joined table, so a count over `shipment` alone would silently ignore
       * it and report a total for a different query than the page.
       */
      const [rows, [counted]] = await Promise.all([
        executor(db)
          .select({ ...SHIPMENT_COLUMNS, orderNumber: order.orderNumber })
          .from(shipment)
          .innerJoin(
            order,
            and(eq(order.id, shipment.orderId), eq(order.storeId, shipment.storeId)),
          )
          .where(where)
          .orderBy(desc(shipment.createdAt), desc(shipment.id))
          .limit(params.limit)
          .offset(params.offset),
        executor(db)
          .select({ total: count() })
          .from(shipment)
          .innerJoin(
            order,
            and(eq(order.id, shipment.orderId), eq(order.storeId, shipment.storeId)),
          )
          .where(where),
      ]);

      return {
        items: rows.map((row) => ({ ...toShipmentRecord(row), orderNumber: row.orderNumber })),
        total: counted?.total ?? 0,
      };
    },

    /**
     * One shipment in this store, by id. Increment 54.
     *
     * The read that the admin surface was missing: `PATCH /admin/shipments/{id}` and both
     * transition routes have always addressed a shipment by id, so staff could change one they
     * had no way to look at.
     *
     * Store-scoped and served by `uq_shipment_id_store`, which already exists as an FK target —
     * measured at 0.022 ms. An unknown id and another store's shipment are both `undefined`, so
     * the caller answers one `404` and reveals nothing.
     */
    async findByIdForStore(params: {
      shipmentId: string;
      storeId: string;
    }): Promise<(ShipmentRecord & { orderNumber: string }) | undefined> {
      const [row] = await executor(db)
        .select({ ...SHIPMENT_COLUMNS, orderNumber: order.orderNumber })
        .from(shipment)
        .innerJoin(order, and(eq(order.id, shipment.orderId), eq(order.storeId, shipment.storeId)))
        .where(and(eq(shipment.id, params.shipmentId), eq(shipment.storeId, params.storeId)))
        .limit(1);

      return row === undefined
        ? undefined
        : { ...toShipmentRecord(row), orderNumber: row.orderNumber };
    },

    /**
     * One shipment's transition history, oldest first. Increment 54.
     *
     * Store-scoped in its OWN right, not merely via the shipment the caller already fetched.
     * `shipment_event.store_id` is a real column with its own predicate here, so this method is
     * safe to call with any id — it cannot return another tenant's history even if a caller
     * passed an id it had no business holding.
     *
     * Oldest first, matching `payments.listEvents`: a history is read forwards.
     * `ix_shipment_event_shipment_time` serves it.
     */
    async listEventsForShipment(params: {
      shipmentId: string;
      storeId: string;
    }): Promise<ShipmentEventRecord[]> {
      return executor(db)
        .select({
          fromStatus: shipmentEvent.fromStatus,
          toStatus: shipmentEvent.toStatus,
          actorType: shipmentEvent.actorType,
          note: shipmentEvent.note,
          createdAt: shipmentEvent.createdAt,
        })
        .from(shipmentEvent)
        .where(
          and(
            eq(shipmentEvent.shipmentId, params.shipmentId),
            eq(shipmentEvent.storeId, params.storeId),
          ),
        )
        .orderBy(asc(shipmentEvent.createdAt), asc(shipmentEvent.id));
    },

    /**
     * **The fulfilment queue: orders that still need shipping.**
     *
     * Narrow by design, and it is not an admin order list. The predicate is exactly "work to
     * do": the order is not cancelled, and it has either no shipment or one still `pending`.
     * There is no customer search, no status filter, no date range and no free text — adding
     * any of those would make this the general-purpose admin order surface this project has
     * repeatedly declined.
     *
     * Keyset pagination on `(placed_at, order_number)` rather than OFFSET, because a queue is
     * worked from the front while rows leave it: OFFSET would skip orders as earlier ones are
     * shipped. `placed_at` ascending, so the oldest order is fulfilled first, and `order_number`
     * breaks ties to make the order total and the page boundary stable.
     */
    async listAwaitingFulfilment(params: {
      storeId: string;
      limit: number;
      cursor?: { placedAt: Date; orderNumber: string };
    }): Promise<
      {
        orderNumber: string;
        placedAt: Date;
        shipRecipientName: string;
        shipCity: string;
        shipPostalCode: string;
        shipmentStatus: ShipmentStatus | null;
      }[]
    > {
      const eligible = and(
        eq(order.storeId, params.storeId),
        sql`${order.status} = 'placed'`,
        or(isNull(shipment.id), eq(shipment.status, 'pending')),
      );

      const afterCursor =
        params.cursor === undefined
          ? undefined
          : or(
              lt(order.placedAt, params.cursor.placedAt),
              and(
                eq(order.placedAt, params.cursor.placedAt),
                sql`${order.orderNumber} > ${params.cursor.orderNumber}`,
              ),
            );

      const rows = await executor(db)
        .select({
          orderNumber: order.orderNumber,
          placedAt: order.placedAt,
          shipRecipientName: order.shipRecipientName,
          shipCity: order.shipCity,
          shipPostalCode: order.shipPostalCode,
          shipmentStatus: shipment.status,
        })
        .from(order)
        .leftJoin(
          shipment,
          and(eq(shipment.orderId, order.id), eq(shipment.storeId, params.storeId)),
        )
        .where(afterCursor === undefined ? eligible : and(eligible, afterCursor))
        .orderBy(desc(order.placedAt), order.orderNumber)
        .limit(params.limit);

      return rows.map((row) => ({
        ...row,
        shipmentStatus: row.shipmentStatus === null ? null : (row.shipmentStatus as ShipmentStatus),
      }));
    },
  };
}

/**
 * One transition in a shipment's history, as the staff detail reads it. Increment 54.
 *
 * Deliberately NOT the whole `shipment_event` row. `id`, `shipmentId` and `storeId` are internal
 * keys the caller already holds or has no business with, and `actorUserId` is a person — the
 * event says a STAFF member acted, which is what an operator reading a timeline needs, without
 * naming a colleague on a screen that exists to explain a parcel.
 */
export type ShipmentEventRecord = {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly note: string | null;
  readonly createdAt: Date;
};

/** The filters the staff shipment list accepts. Both optional. */
export type AdminShipmentFilters = {
  readonly status?: string;
  readonly orderNumber?: string;
};

/**
 * The staff list's WHERE clause: tenancy, then whichever filters were supplied.
 *
 * A free function rather than a closure inside the factory because it takes everything it needs
 * and captures nothing — which is what makes it readable as the one place tenancy is applied.
 * `storeId` is the first conjunct and is not optional; both filters below can only narrow, so no
 * combination of query parameters widens the result past one tenant.
 *
 * **No date bounds.** The endpoint accepts none, so the millisecond-versus-microsecond question
 * the order and payment lists answer does not arise here. If a date filter is ever added it must
 * reuse `exclusiveEndOfMillisecond` rather than introduce a second reading of "inclusive".
 */
function adminShipmentPredicate(storeId: string, filters: AdminShipmentFilters): SQL | undefined {
  const clauses: SQL[] = [eq(shipment.storeId, storeId)];

  if (filters.status !== undefined) clauses.push(eq(shipment.status, filters.status));

  /*
   * An exact match on the JOINED order, not a search. `uq_shipment_order` means this narrows to
   * at most one shipment, and an unknown number is an empty page rather than a `404` — it is a
   * filter, not a lookup.
   */
  if (filters.orderNumber !== undefined) {
    clauses.push(eq(order.orderNumber, filters.orderNumber));
  }

  return and(...clauses);
}
