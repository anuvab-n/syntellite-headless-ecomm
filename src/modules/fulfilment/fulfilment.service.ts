import type { Database } from '../../db/client.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { BusinessRuleViolation, Conflict, NotFound, ValidationError } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { SHIPMENT_AUDIT, SHIPMENT_RESOURCE } from './fulfilment.events.js';
import type {
  FulfilmentRepository,
  ShipmentRecord,
  ShipmentStatus,
} from './fulfilment.repository.js';
import { canTransition, hasLeftFulfilment } from './shipment.state.js';

/**
 * Fulfilment: creating a shipment, shipping it, and recording delivery.
 *
 * Manual fulfilment. There is no carrier API, no provider adapter, no provider port and no
 * webhook — `carrier` and `tracking_number` are text a staff member types. The seam for a future
 * provider is deliberately not built; `PaymentGateway` shows what it will look like when one is
 * chosen, and building it now would be an abstraction with one caller and no second case.
 *
 * ## What this service does NOT do
 *
 * It never writes `order.status` — §43 fixed that the four state spaces stay separate, and this
 * is the fourth. It never writes a payment row: a COD order ships with its payment still
 * `pending`, and that is an approved business rule, not a settlement. It never emits a domain
 * event, because no consumer exists — see `fulfilment.events.ts`. It moves stock only through
 * the inventory port, and only inside its own transaction.
 *
 * ## The lock order, which is the whole concurrency design
 *
 *     order -> payment -> shipment -> stock_reservation -> stock_item
 *
 * The ORDER lock always comes first. Cancellation already locks the order first and reads
 * shipment state without a lock, so taking it here is what makes cancellation and fulfilment
 * serialise. Payment state is read after it. Nothing here ever takes a payment lock before an
 * order lock, so no wait cycle with the payment webhook or the expiry sweeper is possible.
 */

/* ── Ports ───────────────────────────────────────────────────────────────── */

/**
 * The order being fulfilled, as this module needs it.
 *
 * Four fields. Fulfilment needs to know the order exists in this store, whether the customer has
 * withdrawn it, and enough to lock it — nothing else. Asking for an `OrderView` would couple
 * this module to another module's read model, and would drag a delivery address and a money
 * breakdown into a decision that turns on neither.
 */
export type FulfillableOrder = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
};

/**
 * **The order, as fulfilment needs it — declared HERE, implemented by orders.**
 *
 * `no-cross-module-imports` forbids importing `modules/orders`, so the consumer declares the
 * port and `container.ts` adapts the orders service onto it.
 *
 * `lockByNumber` both FINDS and LOCKS, in one operation, because separating them would invite a
 * caller to read first and lock later — which is the read-then-decide shape this codebase
 * refuses. It is store-scoped and deliberately NOT user-scoped: staff act on any order in their
 * store, and there is no customer in the request to scope by.
 */
export type FulfilmentOrders = {
  lockByNumber(params: { orderNumber: string; storeId: string }): Promise<FulfillableOrder | null>;
  /**
   * The same lock, addressed by id.
   *
   * The ship and deliver routes address a SHIPMENT, so they learn the order id from an unlocked
   * read of the immutable `shipment.order_id` and then lock by it. Two methods rather than one
   * optional argument, so neither call site can accidentally lock nothing.
   */
  lockById(params: { orderId: string; storeId: string }): Promise<FulfillableOrder | null>;
};

/**
 * What this module needs to know about an order's payment, and nothing more.
 *
 * A status and a method — the same two fields cancellation and the invoice ask for, and for a
 * related reason: the fulfilment prerequisite is a function of both. `null` means no payment
 * exists at all, which is a distinct answer from any status and must not be collapsed into one:
 * an order with no payment is refused, where a COD order with a `pending` one is allowed.
 *
 * This module never writes a payment. Nothing in the port permits it.
 */
export type FulfilmentPayments = {
  stateForOrder(params: {
    orderId: string;
    storeId: string;
  }): Promise<{ status: string; method: string } | null>;
};

/**
 * **Inventory fulfilment, as this module needs it — declared HERE, implemented by inventory.**
 *
 * One operation, and it is the irreversible one: it decrements `on_hand` and `reserved` together
 * and writes the ledger. Must be called inside this service's transaction, so the stock movement
 * and the shipment transition commit together or not at all. Inventory asserts that itself.
 *
 * `allowUncommittedCod` is the explicit mechanism the approved COD rule requires. A COD
 * reservation is `held`, `held -> fulfilled` is illegal, and inventing a payment transition is
 * forbidden — so inventory commits it with reason `cod_fulfilment` first when this is set. The
 * flag is named for what it PERMITS rather than for the caller, so it cannot be passed casually:
 * it means "this order may ship without its money having arrived".
 */
export type FulfilmentInventory = {
  fulfilForOrder(params: {
    orderId: string;
    storeId: string;
    actorUserId: string;
    allowUncommittedCod: boolean;
  }): Promise<{ skuCount: number; totalUnits: number }>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The order already has a shipment. A `409`.
 *
 * One shipment per order is the approved model, enforced by `uq_shipment_order`, so a second
 * creation is a conflict with existing state rather than a malformed request. This is also the
 * duplicate-request answer: two staff clicking Create produce one shipment and one of these,
 * which is why creation carries no `Idempotency-Key`.
 */
export class ShipmentAlreadyExists extends Conflict {
  override readonly code = 'SHIPMENT_ALREADY_EXISTS';
  constructor() {
    super('this order already has a shipment');
  }
}

/**
 * The shipment cannot make this transition. A `409`.
 *
 * Carries a machine-readable `from`/`to` in `details` so a client can tell "already shipped"
 * from "not shipped yet" without parsing prose.
 */
export class ShipmentNotTransitionable extends Conflict {
  override readonly code = 'SHIPMENT_NOT_TRANSITIONABLE';
  constructor(from: ShipmentStatus, to: ShipmentStatus) {
    super(`a shipment in state ${from} cannot become ${to}`, { from, to });
  }
}

/**
 * The order cannot be fulfilled. A `422`: well-formed, but the business rules say no.
 *
 * `reason` is machine-readable because the operational fix differs per case — a cancelled order
 * is finished, an unpaid online order needs the customer to pay, and a missing payment needs one
 * initiated.
 */
export class OrderNotFulfillable extends BusinessRuleViolation {
  override readonly code = 'ORDER_NOT_FULFILLABLE';
  constructor(reason: string, message: string) {
    super(message, { reason });
  }
}

/* ── Views ───────────────────────────────────────────────────────────────── */

export type ShipmentView = { readonly shipment: ShipmentRecord };

export type FulfilmentService = ReturnType<typeof createFulfilmentService>;

export function createFulfilmentService(deps: {
  repository: FulfilmentRepository;
  orders: FulfilmentOrders;
  payments: FulfilmentPayments;
  inventory: FulfilmentInventory;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, orders, payments, inventory, db, audit, logger } = deps;

  /**
   * **The payment prerequisite. The approved rule, in one place.**
   *
   * | Method   | Payment status | May fulfil |
   * | -------- | -------------- | ---------- |
   * | `online` | `succeeded`    | yes        |
   * | `online` | `pending`      | no         |
   * | `online` | `failed`       | no         |
   * | `online` | `expired`      | no         |
   * | `cod`    | `pending`      | **yes**    |
   * | *(none)* | —              | no         |
   *
   * The COD row is the approved unpaid-fulfilment path: a COD payment never terminalises, so
   * requiring `succeeded` would make COD unsellable. **It does not mean the payment is settled**
   * — nothing here transitions it, and the reservation records `cod_fulfilment` rather than
   * `payment_succeeded` precisely so an unpaid sale is not misreported as a paid one.
   *
   * Returns whether inventory may commit a still-held reservation, which is true only on that
   * COD path.
   */
  async function requirePaymentPrerequisite(params: {
    orderId: string;
    storeId: string;
  }): Promise<{ allowUncommittedCod: boolean }> {
    const state = await payments.stateForOrder(params);

    if (state === null) {
      throw new OrderNotFulfillable(
        'no_payment',
        'This order has no payment. It cannot be fulfilled until one is initiated.',
      );
    }

    if (state.method === 'cod') {
      /*
       * COD stays `pending` for the life of the order, so `pending` is the only status this can
       * be — but the check is written positively rather than assuming it, so a future COD
       * settlement increment fails loudly here instead of silently taking the unpaid path.
       */
      if (state.status !== 'pending') {
        throw new OrderNotFulfillable(
          'cod_not_pending',
          `A cash-on-delivery payment in state ${state.status} is not the approved fulfilment path.`,
        );
      }
      return { allowUncommittedCod: true };
    }

    if (state.status !== 'succeeded') {
      throw new OrderNotFulfillable(
        'payment_not_succeeded',
        `This order's payment is ${state.status}. An online order must be paid before it ships.`,
      );
    }

    return { allowUncommittedCod: false };
  }

  /** The order must exist, and the customer must not have withdrawn it. */
  function requireNotCancelled(order: FulfillableOrder): void {
    if (order.status !== 'placed') {
      throw new OrderNotFulfillable(
        'order_cancelled',
        `An order with status ${order.status} cannot be fulfilled.`,
      );
    }
  }

  /** The staff member performing the action, from the VERIFIED token. */
  function staffUserId(actor: AuditActor): string {
    if (!('userId' in actor)) {
      /*
       * Unreachable through HTTP: every route here sits behind `requireStaff`. Stated so a
       * future CLI caller fails loudly rather than writing an unattributable ledger entry —
       * `stock_ledger.actor_user_id` is NOT NULL by decision 19.
       */
      throw new Error('fulfilment requires an actor with a user id');
    }
    return actor.userId;
  }

  return {
    /**
     * **Create the shipment.** `pending`, with whatever tracking is known.
     *
     * Creation deliberately does NOT ship. `pending` earns its place: it is the state in which a
     * tracking number can be attached, and it separates recording the intent to ship from the
     * irreversible act of moving stock. Folding them together would make a POST that accepts
     * tracking metadata also decrement inventory, which is a lot of consequence for one call and
     * impossible to undo.
     *
     * The payment prerequisite is checked HERE as well as at ship time. Not required by the
     * rule, but it stops staff building a queue of shipments that can never ship, and it
     * surfaces an unpaid order at the moment someone tries to act on it rather than later.
     *
     * A `uq_shipment_order` violation becomes `ShipmentAlreadyExists`, discriminated by
     * CONSTRAINT NAME so an unrelated unique violation is rethrown rather than mislabelled.
     */
    async createShipment(params: {
      orderNumber: string;
      storeId: string;
      actor: AuditActor;
      carrier: string | null;
      trackingNumber: string | null;
      trackingUrl: string | null;
    }): Promise<ShipmentView> {
      const actorUserId = staffUserId(params.actor);

      return withTransaction(db, logger, async () => {
        /* 1. The ORDER lock, first. Always. */
        const order = await orders.lockByNumber({
          orderNumber: params.orderNumber,
          storeId: params.storeId,
        });
        if (order === null) throw new NotFound('order');

        requireNotCancelled(order);
        await requirePaymentPrerequisite({ orderId: order.id, storeId: params.storeId });

        let created: ShipmentRecord;
        try {
          created = await repository.createShipment({
            storeId: params.storeId,
            orderId: order.id,
            carrier: params.carrier,
            trackingNumber: params.trackingNumber,
            trackingUrl: params.trackingUrl,
          });
        } catch (err) {
          const constraint = uniqueViolationConstraint(err);
          if (constraint === 'uq_shipment_order') throw new ShipmentAlreadyExists();
          if (constraint === 'uq_shipment_tracking') {
            throw new Conflict('this tracking number is already recorded for this carrier');
          }
          throw err;
        }

        /* The creation row: created IN this state, so `from_status` is NULL. */
        await repository.insertEvent({
          shipmentId: created.id,
          storeId: params.storeId,
          fromStatus: null,
          toStatus: created.status,
          actorType: params.actor.type,
          actorUserId,
          note: null,
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: SHIPMENT_AUDIT.created,
          resourceType: SHIPMENT_RESOURCE,
          resourceId: created.id,
          metadata: {
            orderNumber: order.orderNumber,
            carrier: created.carrier,
            trackingNumber: created.trackingNumber,
          },
        });

        logger.info(
          { storeId: params.storeId, orderId: order.id, shipmentId: created.id },
          'shipment_created',
        );

        return { shipment: created };
      });
    },

    /**
     * **Ship it. The transaction that moves stock.**
     *
     * The order of operations is the design, and each step is load-bearing:
     *
     *  1. lock the ORDER — serialises with cancellation and with expiry
     *  2. refuse a cancelled order
     *  3. read the payment prerequisite (never a payment lock before the order lock)
     *  4. lock the SHIPMENT — serialises two staff members
     *  5. check the transition table
     *  6. **move the inventory** — the irreversible step
     *  7. CAS `pending -> shipped`
     *  8. append the event
     *  9. audit
     *
     * Inventory moves BEFORE the CAS deliberately. If the movement throws — a divergent
     * projection, a released reservation — the transaction rolls back and the shipment is still
     * `pending`, so it can be retried once the cause is fixed. Doing the CAS first would leave a
     * `shipped` shipment whose stock had not moved if the rollback were ever partial, and
     * **a shipment must never be `shipped` while the stock movement is incomplete.**
     *
     * The CAS after it is what makes a duplicate click safe: the second attempt finds `shipped`,
     * matches nothing, and answers `409` — with no second inventory movement, because the
     * transition check above it already refused.
     */
    async shipShipment(params: {
      shipmentId: string;
      storeId: string;
      actor: AuditActor;
      note: string | null;
    }): Promise<ShipmentView> {
      const actorUserId = staffUserId(params.actor);

      return withTransaction(db, logger, async () => {
        /**
         * An UNLOCKED read, and only to learn which order this shipment belongs to.
         *
         * The route addresses a shipment, but the lock order requires the ORDER first — so
         * something has to be read before any lock is taken. `shipment.order_id` is safe to
         * read unlocked because it is IMMUTABLE: no code path updates it, and there is no
         * statement anywhere that could move a shipment between orders. Nothing is decided from
         * this read; the shipment is re-read under both locks below and every decision is made
         * from that copy.
         */
        const unlocked = await repository.findOrderIdForShipment({
          shipmentId: params.shipmentId,
          storeId: params.storeId,
        });
        if (!unlocked) throw new NotFound('shipment');

        /* 1. The ORDER lock. First, always — this is what serialises with cancellation. */
        const order = await orders.lockById({
          orderId: unlocked.orderId,
          storeId: params.storeId,
        });
        if (order === null) throw new NotFound('shipment');

        /* 2. The order must not have been withdrawn. */
        requireNotCancelled(order);

        /* 3. The payment prerequisite, read after the order lock — never before it. */
        const { allowUncommittedCod } = await requirePaymentPrerequisite({
          orderId: order.id,
          storeId: params.storeId,
        });

        /* 4. The SHIPMENT lock. Serialises two staff members on the same shipment. */
        const locked = await repository.lockById({
          shipmentId: params.shipmentId,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('shipment');

        /* 5. The transition table is the authority. A second click lands here. */
        if (!canTransition(locked.status, 'shipped')) {
          logger.info(
            { shipmentId: locked.id, from: locked.status },
            'shipment_ship_rejected_transition',
          );
          throw new ShipmentNotTransitionable(locked.status, 'shipped');
        }

        /**
         * 6. **Move the stock. The irreversible step, and deliberately before the CAS.**
         *
         * If this throws — a divergent projection, a released reservation, an order that holds
         * no reservation — the whole transaction rolls back and the shipment is still `pending`,
         * so it can be retried once the cause is fixed. Nothing catches and continues here: a
         * catch is how a `shipped` shipment with unmoved stock gets committed.
         */
        const moved = await inventory.fulfilForOrder({
          orderId: order.id,
          storeId: params.storeId,
          actorUserId,
          allowUncommittedCod,
        });

        const at = new Date();

        /* 7. The CAS. Zero rows means another transaction moved it first. */
        const applied = await repository.applyTransition({
          shipmentId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'shipped',
          at,
        });
        if (!applied) throw new Conflict('shipment changed while being shipped');

        /* 8. The append-only transition row. */
        await repository.insertEvent({
          shipmentId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'shipped',
          actorType: params.actor.type,
          actorUserId,
          note: params.note,
        });

        /* 9. Audit. */
        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: SHIPMENT_AUDIT.shipped,
          resourceType: SHIPMENT_RESOURCE,
          resourceId: locked.id,
          metadata: {
            orderNumber: order.orderNumber,
            skuCount: moved.skuCount,
            totalUnits: moved.totalUnits,
            /* Recorded because it means the goods left before the money arrived. */
            unpaidCodFulfilment: allowUncommittedCod,
          },
        });

        const shipped = await repository.lockById({
          shipmentId: locked.id,
          storeId: params.storeId,
        });
        if (!shipped) throw new Conflict('shipment vanished while being shipped');

        logger.info(
          {
            storeId: params.storeId,
            orderId: order.id,
            shipmentId: locked.id,
            skuCount: moved.skuCount,
            totalUnits: moved.totalUnits,
            unpaidCodFulfilment: allowUncommittedCod,
          },
          'shipment_shipped',
        );

        return { shipment: shipped };
      });
    },

    /**
     * **Record delivery.** No stock moves.
     *
     * The units left the building at `shipped`; delivery is the arrival, and inventory has
     * nothing left to say about them. So this is the one transition with no inventory step —
     * which is also why it cannot fail halfway.
     *
     * Order-locked first anyway, for one reason: consistency of the lock order. A path that
     * took only the shipment lock would be the exception someone later copies.
     *
     * `delivered_at` is set by the same CAS that moves the status, so a second delivery finds
     * `delivered`, matches nothing, and answers `409` — **the original timestamp is never
     * overwritten**, which a test asserts.
     */
    async deliverShipment(params: {
      shipmentId: string;
      storeId: string;
      actor: AuditActor;
      note: string | null;
    }): Promise<ShipmentView> {
      const actorUserId = staffUserId(params.actor);

      return withTransaction(db, logger, async () => {
        const unlocked = await repository.findOrderIdForShipment({
          shipmentId: params.shipmentId,
          storeId: params.storeId,
        });
        if (!unlocked) throw new NotFound('shipment');

        const order = await orders.lockById({
          orderId: unlocked.orderId,
          storeId: params.storeId,
        });
        if (order === null) throw new NotFound('shipment');

        const locked = await repository.lockById({
          shipmentId: params.shipmentId,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('shipment');

        if (!canTransition(locked.status, 'delivered')) {
          logger.info(
            { shipmentId: locked.id, from: locked.status },
            'shipment_deliver_rejected_transition',
          );
          throw new ShipmentNotTransitionable(locked.status, 'delivered');
        }

        const at = new Date();

        const applied = await repository.applyTransition({
          shipmentId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'delivered',
          at,
        });
        if (!applied) throw new Conflict('shipment changed while being delivered');

        await repository.insertEvent({
          shipmentId: locked.id,
          storeId: params.storeId,
          fromStatus: locked.status,
          toStatus: 'delivered',
          actorType: params.actor.type,
          actorUserId,
          note: params.note,
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: SHIPMENT_AUDIT.delivered,
          resourceType: SHIPMENT_RESOURCE,
          resourceId: locked.id,
          metadata: { orderNumber: order.orderNumber },
        });

        const delivered = await repository.lockById({
          shipmentId: locked.id,
          storeId: params.storeId,
        });
        if (!delivered) throw new Conflict('shipment vanished while being delivered');

        logger.info(
          { storeId: params.storeId, orderId: order.id, shipmentId: locked.id },
          'shipment_delivered',
        );

        return { shipment: delivered };
      });
    },

    /**
     * Correct the tracking facts. **Never the state.**
     *
     * A courier changes its mind, or a number is mistyped. Permitted in any state, including
     * `delivered`, because a wrong tracking number stays wrong and the customer is still looking
     * at it — refusing corrections after delivery would leave a visible error uncorrectable.
     *
     * No inventory, no transition, no event row: nothing about fulfilment STATE changed, and
     * writing a `shipment_event` for it would put a non-transition into an append-only history
     * of transitions. The audit log is where this belongs, and it is audited precisely because
     * the field is customer-visible.
     */
    async updateTracking(params: {
      shipmentId: string;
      storeId: string;
      actor: AuditActor;
      /**
       * Three-way, and the distinction is the contract: `undefined` leaves the field alone,
       * `null` clears it, a string sets it. The DTO produces exactly that from
       * `.nullable().optional()`, and the merge happens here against the LOCKED row so a
       * concurrent correction cannot be silently overwritten with a stale value.
       */
      carrier: string | null | undefined;
      trackingNumber: string | null | undefined;
      trackingUrl: string | null | undefined;
    }): Promise<ShipmentView> {
      staffUserId(params.actor);

      return withTransaction(db, logger, async () => {
        const locked = await repository.lockById({
          shipmentId: params.shipmentId,
          storeId: params.storeId,
        });
        if (!locked) throw new NotFound('shipment');

        let updated: ShipmentRecord | undefined;
        try {
          updated = await repository.updateTracking({
            shipmentId: locked.id,
            storeId: params.storeId,
            /* Absent means unchanged, so fall back to what the locked row already holds. */
            carrier: params.carrier === undefined ? locked.carrier : params.carrier,
            trackingNumber:
              params.trackingNumber === undefined ? locked.trackingNumber : params.trackingNumber,
            trackingUrl: params.trackingUrl === undefined ? locked.trackingUrl : params.trackingUrl,
            at: new Date(),
          });
        } catch (err) {
          if (uniqueViolationConstraint(err) === 'uq_shipment_tracking') {
            throw new Conflict('this tracking number is already recorded for this carrier');
          }
          throw err;
        }
        if (!updated) throw new NotFound('shipment');

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: SHIPMENT_AUDIT.trackingUpdated,
          resourceType: SHIPMENT_RESOURCE,
          resourceId: locked.id,
          metadata: {
            /* Both sides, so the trail says what it was as well as what it became. */
            fromCarrier: locked.carrier,
            toCarrier: updated.carrier,
            fromTrackingNumber: locked.trackingNumber,
            toTrackingNumber: updated.trackingNumber,
          },
        });

        return { shipment: updated };
      });
    },

    /* ── Reads ──────────────────────────────────────────────────────────────── */

    /**
     * One order's shipments, for the CUSTOMER who owns it.
     *
     * An empty array is a legitimate answer for an order that has not shipped — distinct from
     * a `404`, which means the order is unknown, another customer's, or another store's. The
     * repository enforces that distinction in its predicate rather than here.
     */
    async listForCustomer(params: {
      orderNumber: string;
      userId: string;
      storeId: string;
    }): Promise<ShipmentRecord[]> {
      const found = await repository.findForCustomer(params);
      if (found.orderExists === false) throw new NotFound('order');
      return found.shipments;
    },

    /** One order's shipments, for STAFF. Store-scoped, not user-scoped. */
    async listForStore(params: {
      orderNumber: string;
      storeId: string;
    }): Promise<ShipmentRecord[]> {
      const found = await repository.findForStore(params);
      if (!found) throw new NotFound('order');
      return found.shipments;
    },

    /**
     * The fulfilment queue: orders still needing shipment, oldest first.
     *
     * Narrow by design. Not an admin order list, not searchable, and not filterable — the
     * predicate is exactly "work to do", and widening it is how this becomes the general admin
     * order surface the project has repeatedly declined.
     */
    async listAwaitingFulfilment(params: { storeId: string; limit: number; cursor?: string }) {
      /*
       * A malformed cursor is a 400 naming the field, not a silent first page: a client that
       * sent a broken cursor is paging through a list it thinks it is halfway down, and quietly
       * restarting would make it re-process work.
       */
      let decoded: { placedAt: Date; orderNumber: string } | undefined;
      if (params.cursor !== undefined) {
        try {
          const raw: unknown = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
          const parsed = raw as { p?: unknown; o?: unknown };
          if (typeof parsed.p !== 'string' || typeof parsed.o !== 'string') {
            throw new Error('shape');
          }
          const placedAt = new Date(parsed.p);
          if (Number.isNaN(placedAt.getTime())) throw new Error('date');
          decoded = { placedAt, orderNumber: parsed.o };
        } catch {
          throw new ValidationError({ cursor: ['must be a cursor from a previous page'] });
        }
      }

      return repository.listAwaitingFulfilment({
        storeId: params.storeId,
        limit: params.limit,
        ...(decoded === undefined ? {} : { cursor: decoded }),
      });
    },

    /**
     * Encode a queue cursor. **Opaque to the client, by intent.**
     *
     * base64url of the two ordering columns. Opaque so the keyset can change — a different
     * tiebreaker, an added column — without a client that reverse-engineered the format
     * breaking. It carries no secret and needs no signature: forging one only asks for a
     * different page of the same store-scoped query, which the predicate already bounds.
     */
    encodeQueueCursor(position: { placedAt: Date; orderNumber: string }): string {
      return Buffer.from(
        JSON.stringify({ p: position.placedAt.toISOString(), o: position.orderNumber }),
        'utf8',
      ).toString('base64url');
    },

    /**
     * Whether an order's shipment blocks cancellation. **For the orders module's guard.**
     *
     * `true` once goods have left — `shipped` or `delivered` — because undoing that means a
     * return, which is out of scope. A `pending` shipment does NOT block: nothing has moved, so
     * the customer may still cancel, and the pending shipment is left behind as an operational
     * fact that can never ship, since the ship path refuses a cancelled order.
     *
     * Read WITHOUT a lock, deliberately: cancellation already holds the ORDER lock, and every
     * path that changes a shipment takes that same order lock first — so a shipment cannot
     * change state while cancellation holds it. A second lock would add contention for no
     * additional guarantee.
     */
    /**
     * When this order was delivered, or `null` if it has not been.
     *
     * Exposed so the returns module can decide eligibility without importing this one — it
     * declares `ReturnFulfilment.deliveredAtForOrder` and the composition root adapts this
     * onto it. **This is the only source of the delivery instant**: no request body carries
     * one, which is what stops a customer from claiming an earlier delivery to reopen a
     * closed return window.
     *
     * Whole-order shipments remain the v1 model, so at most one shipment can be delivered.
     */
    async deliveredAtForOrder(params: { orderId: string; storeId: string }): Promise<Date | null> {
      return repository.findDeliveredAtByOrderId(params);
    },

    async hasBlockingShipment(params: { orderId: string; storeId: string }): Promise<boolean> {
      const status = await repository.findStatusByOrderId(params);
      return status === undefined ? false : hasLeftFulfilment(status);
    },
  };
}
