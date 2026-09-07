import { and, asc, count, desc, eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { order } from '../../db/schema/orders.js';
import { payment, paymentEvent } from '../../db/schema/payments.js';
import { executor } from '../../db/transaction.js';
import { newId } from '../../shared/id.js';

/**
 * Payment persistence.
 *
 * The only file in this module permitted to import a table — `schema-only-in-repositories`.
 * Every method takes `storeId` and puts it in the predicate; every customer-facing read takes
 * `userId` too. Ownership and tenancy are enforced HERE rather than trusted from a caller, so a
 * future CLI command or sweeper inherits the same isolation without re-deriving it.
 *
 * `executor(db)` throughout, so a method called inside `withTransaction` joins the ambient
 * transaction. Both write paths depend on that: a payment, its history row, its audit entry and
 * the idempotency completion must commit together or not at all.
 *
 * ## Why `insertEvent` is the concurrency primitive
 *
 * `recordTransition` inserts the history row BEFORE updating the payment, and the insert carries
 * `provider_event_id`. That ordering is the point: `uq_payment_event_provider` turns a
 * redelivered webhook into a unique violation before any state has changed. Claiming by INSERT
 * is the same idiom `idempotency_key.claim()` and `processed_event` use, and for the same
 * reason — a read-then-write would let two concurrent deliveries both pass the read.
 */

/** The lifecycle vocabulary, re-exported so nothing outside this module names the table. */
export {
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_PROVIDERS,
  INITIAL_PAYMENT_STATUS,
  type PaymentStatus,
  type PaymentMethod,
  type PaymentProvider,
} from '../../db/schema/payments.js';

import type { PaymentMethod, PaymentProvider, PaymentStatus } from '../../db/schema/payments.js';

export type PaymentsRepository = ReturnType<typeof createPaymentsRepository>;

/**
 * A payment, exactly as stored.
 *
 * `amount` is the canonical `NUMERIC(19,4)` string — never parsed into a `number`, per
 * `money.ts`. `amountMinor` is a `number` because the column is `bigint` in `number` mode and
 * `toMinorUnits` has already asserted it is a safe integer.
 */
export type PaymentRecord = {
  readonly id: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly method: PaymentMethod;
  readonly provider: PaymentProvider | null;
  readonly providerRef: string | null;
  readonly status: PaymentStatus;
  readonly currency: string;
  readonly amount: string;
  readonly amountMinor: number;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** One transition, exactly as stored. */
export type PaymentEventRecord = {
  readonly id: string;
  readonly paymentId: string;
  readonly fromStatus: PaymentStatus | null;
  readonly toStatus: PaymentStatus;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly providerEventId: string | null;
  readonly eventType: string;
  readonly createdAt: Date;
};

/**
 * Selected explicitly rather than with `select()`.
 *
 * A bare select would silently start returning any column a later increment adds, which is how
 * an internal field reaches a response body nobody meant to widen.
 */
const PAYMENT_COLUMNS = {
  id: payment.id,
  storeId: payment.storeId,
  orderId: payment.orderId,
  userId: payment.userId,
  method: payment.method,
  provider: payment.provider,
  providerRef: payment.providerRef,
  status: payment.status,
  currency: payment.currency,
  amount: payment.amount,
  amountMinor: payment.amountMinor,
  failureCode: payment.failureCode,
  createdAt: payment.createdAt,
  updatedAt: payment.updatedAt,
} as const;

const EVENT_COLUMNS = {
  id: paymentEvent.id,
  paymentId: paymentEvent.paymentId,
  fromStatus: paymentEvent.fromStatus,
  toStatus: paymentEvent.toStatus,
  actorType: paymentEvent.actorType,
  actorUserId: paymentEvent.actorUserId,
  providerEventId: paymentEvent.providerEventId,
  eventType: paymentEvent.eventType,
  createdAt: paymentEvent.createdAt,
} as const;

/**
 * The narrowing cast at the repository boundary.
 *
 * The columns are `varchar` with a `CHECK`, not a PostgreSQL enum, so Drizzle types them as
 * `string`. The CHECK constraints are what make the cast sound; doing it once here means the
 * service and the DTOs work in the domain vocabulary rather than re-asserting it.
 */
function toPaymentRecord(row: {
  id: string;
  storeId: string;
  orderId: string;
  userId: string;
  method: string;
  provider: string | null;
  providerRef: string | null;
  status: string;
  currency: string;
  amount: string;
  amountMinor: number;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PaymentRecord {
  return {
    ...row,
    method: row.method as PaymentMethod,
    provider: row.provider as PaymentProvider | null,
    status: row.status as PaymentStatus,
  };
}

function toEventRecord(row: {
  id: string;
  paymentId: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorUserId: string | null;
  providerEventId: string | null;
  eventType: string;
  createdAt: Date;
}): PaymentEventRecord {
  return {
    ...row,
    fromStatus: row.fromStatus as PaymentStatus | null,
    toStatus: row.toStatus as PaymentStatus,
  };
}

export function createPaymentsRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Create a payment and its first history row.
     *
     * One statement each, inside the caller's transaction. A `uq_payment_order` violation
     * surfaces as the driver's unique-violation error and the service turns it into a domain
     * conflict — the constraint is the arbiter, not a preceding read.
     */
    async createPayment(params: {
      storeId: string;
      orderId: string;
      userId: string;
      method: PaymentMethod;
      provider: PaymentProvider | null;
      providerRef: string | null;
      currency: string;
      amount: string;
      amountMinor: number;
      actorUserId: string;
      eventType: string;
    }): Promise<PaymentRecord> {
      const [row] = await executor(db)
        .insert(payment)
        .values({
          /*
           * Generated here, not by a database default. `shared/id.ts` requires it: UUIDv7 comes
           * from the application so a service has the id before the INSERT and can build child
           * rows inside one transaction — which is exactly what the history row below needs.
           */
          id: newId(),
          storeId: params.storeId,
          orderId: params.orderId,
          userId: params.userId,
          method: params.method,
          provider: params.provider,
          providerRef: params.providerRef,
          currency: params.currency,
          amount: params.amount,
          amountMinor: params.amountMinor,
        })
        .returning(PAYMENT_COLUMNS);

      /* istanbul ignore next -- INSERT ... RETURNING either returns a row or throws. */
      if (!row) throw new Error('payment insert returned no row');

      await executor(db).insert(paymentEvent).values({
        id: newId(),
        paymentId: row.id,
        storeId: row.storeId,
        fromStatus: null,
        toStatus: row.status,
        actorType: 'customer',
        actorUserId: params.actorUserId,
        providerEventId: null,
        eventType: params.eventType,
      });

      return toPaymentRecord(row);
    },

    /**
     * This customer's payment for this order, or `undefined`.
     *
     * Scoped by store AND user. A payment belonging to another customer or another tenant is
     * indistinguishable from one that does not exist, which is what lets the route answer `404`
     * without disclosing that the row is somebody else's.
     */
    async findByOrderId(params: {
      orderId: string;
      storeId: string;
      userId: string;
    }): Promise<PaymentRecord | undefined> {
      const [row] = await executor(db)
        .select(PAYMENT_COLUMNS)
        .from(payment)
        .where(
          and(
            eq(payment.orderId, params.orderId),
            eq(payment.storeId, params.storeId),
            eq(payment.userId, params.userId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toPaymentRecord(row);
    },

    /**
     * Does this order already have a payment? Store-scoped, deliberately NOT user-scoped.
     *
     * The service asks this before spending a provider call, and it must see a payment
     * regardless of who owns it: `uq_payment_order` is global to the order, so a user-scoped
     * check would report "none" and then hit a constraint violation. The read is an
     * optimisation; the constraint is the guarantee.
     */
    async existsForOrder(params: { orderId: string; storeId: string }): Promise<boolean> {
      const [row] = await executor(db)
        .select({ id: payment.id })
        .from(payment)
        .where(and(eq(payment.orderId, params.orderId), eq(payment.storeId, params.storeId)))
        .limit(1);
      return row !== undefined;
    },

    /**
     * Lock the payment a provider notification refers to.
     *
     * ## Where the store comes from
     *
     * **From the row, never from the notification.** The lookup key is
     * `(provider, provider_ref)`, and `provider_ref` is a value THIS system received from the
     * provider when it created the provider-side object and then persisted against a specific
     * store. So the tenant is established by our own prior write, reached through a reference
     * whose authenticity the signature check has already proven. Nothing the body claims about
     * a store is read — this method has no parameter that could carry one.
     *
     * That is why `store_id` is not a predicate here even though `uq_payment_provider_ref`
     * leads with it: at webhook time the store is the ANSWER, not the question. Deriving it
     * from the row also keeps the design correct if per-store provider credentials are ever
     * added, where the configured account alone would no longer identify a tenant.
     *
     * ## Why two rows are fetched
     *
     * `uq_payment_provider_ref` is scoped per store, so it cannot by itself rule out two stores
     * holding the same reference — which is conceivable while a single provider account is
     * shared. A second row means the tenant is genuinely ambiguous, and the caller refuses
     * rather than picking one; guessing would be how a notification marks the wrong store's
     * order paid. In practice a provider order id is unique per account and this returns one row.
     *
     * `FOR UPDATE` serialises concurrent deliveries for one payment, so the state machine sees a
     * stable `status` rather than one two workers read simultaneously. It is only expressible on
     * the query builder, never on `db.query.*` — §6's trap.
     */
    async lockByProviderRef(params: {
      provider: PaymentProvider;
      providerRef: string;
    }): Promise<readonly PaymentRecord[]> {
      const rows = await executor(db)
        .select(PAYMENT_COLUMNS)
        .from(payment)
        .where(
          and(eq(payment.provider, params.provider), eq(payment.providerRef, params.providerRef)),
        )
        .limit(2)
        .for('update');
      return rows.map(toPaymentRecord);
    },

    /**
     * Append the history row for a transition.
     *
     * **Called before the status update, on purpose.** `uq_payment_event_provider` rejects a
     * redelivered `provider_event_id` here, so a duplicate never reaches the `UPDATE` at all.
     * The unique violation propagates to the service, which recognises it and answers the
     * provider with a success.
     */
    async insertEvent(params: {
      paymentId: string;
      storeId: string;
      fromStatus: PaymentStatus | null;
      toStatus: PaymentStatus;
      actorType: string;
      actorUserId: string | null;
      providerEventId: string | null;
      eventType: string;
    }): Promise<void> {
      await executor(db)
        .insert(paymentEvent)
        .values({ id: newId(), ...params });
    },

    /**
     * Move the payment to its new state.
     *
     * The `status = fromStatus` predicate is in the statement, so two writers that somehow both
     * got past the lock still resolve to one winner — and the loser learns it lost from a row
     * count rather than from corrupted state. Returns false when the row had already moved.
     */
    async applyTransition(params: {
      paymentId: string;
      storeId: string;
      fromStatus: PaymentStatus;
      toStatus: PaymentStatus;
      failureCode: string | null;
      at: Date;
    }): Promise<boolean> {
      const updated = await executor(db)
        .update(payment)
        .set({
          status: params.toStatus,
          failureCode: params.failureCode,
          updatedAt: params.at,
        })
        .where(
          and(
            eq(payment.id, params.paymentId),
            eq(payment.storeId, params.storeId),
            eq(payment.status, params.fromStatus),
          ),
        )
        .returning({ id: payment.id });
      return updated.length === 1;
    },

    /**
     * This customer's payments, newest first, with the order number each belongs to.
     *
     * ## Why this method may name `order`
     *
     * The customer surface addresses a payment by its ORDER NUMBER — the payment's own id is
     * never published — so a list has to carry it. The alternative, a port into the orders
     * module to translate ids in a second round trip, would move the store predicate out of
     * this query and make an N+1 out of a page of rows. `orders.repository.ts` takes the same
     * narrow licence for `address` and documents it the same way: a repository may name another
     * table when the only thing it decides is a value this query already needs.
     *
     * Nothing here writes `order`, and the join is INNER because `fk_payment_order_store`
     * guarantees the row exists.
     */
    async listForUser(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: readonly (PaymentRecord & { orderNumber: string })[]; total: number }> {
      const where = and(eq(payment.userId, params.userId), eq(payment.storeId, params.storeId));

      const rows = await executor(db)
        .select({ ...PAYMENT_COLUMNS, orderNumber: order.orderNumber })
        .from(payment)
        .innerJoin(order, and(eq(order.id, payment.orderId), eq(order.storeId, payment.storeId)))
        .where(where)
        .orderBy(desc(payment.createdAt))
        .limit(params.limit)
        .offset(params.offset);

      const [counted] = await executor(db).select({ total: count() }).from(payment).where(where);

      return {
        items: rows.map((row) => ({ ...toPaymentRecord(row), orderNumber: row.orderNumber })),
        total: counted?.total ?? 0,
      };
    },

    /**
     * The status of an order's payment, or `undefined` when it has none.
     *
     * Store-scoped and deliberately NOT user-scoped: `uq_payment_order` is global to the order,
     * so a user-scoped read could report "none" for a payment that exists. The caller is
     * deciding whether the order may be cancelled, and a payment it cannot see is exactly the
     * one that must block it.
     */
    async findStatusByOrderId(params: {
      orderId: string;
      storeId: string;
    }): Promise<PaymentStatus | undefined> {
      const [row] = await executor(db)
        .select({ status: payment.status })
        .from(payment)
        .where(and(eq(payment.orderId, params.orderId), eq(payment.storeId, params.storeId)))
        .limit(1);
      return row === undefined ? undefined : (row.status as PaymentStatus);
    },

    /** The transition timeline for one payment, oldest first. Store-scoped. */
    async listEvents(params: {
      paymentId: string;
      storeId: string;
    }): Promise<readonly PaymentEventRecord[]> {
      const rows = await executor(db)
        .select(EVENT_COLUMNS)
        .from(paymentEvent)
        .where(
          and(
            eq(paymentEvent.paymentId, params.paymentId),
            eq(paymentEvent.storeId, params.storeId),
          ),
        )
        .orderBy(asc(paymentEvent.createdAt));
      return rows.map(toEventRecord);
    },
  };
}
