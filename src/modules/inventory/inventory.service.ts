import type { Database } from '../../db/client.js';
import { isInTransaction, withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { getRequestId } from '../../shared/context.js';
import { Conflict, InvariantViolation, NotFound } from '../../shared/errors.js';
import type { EventBus } from '../../shared/events.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import {
  STOCK_AGGREGATE,
  STOCK_AUDIT,
  STOCK_EVENTS,
  STOCK_RESOURCE,
  stockEventPayload,
} from './inventory.events.js';
import { RESERVATION_HELD } from './inventory.repository.js';
import type {
  InventoryRepository,
  ReservationSettledReason,
  StockLedgerRecord,
  StockRecord,
} from './inventory.repository.js';
import type { CreateAdjustmentRequest } from './dto.js';

/**
 * The inventory module's write API.
 *
 * A factory taking explicit dependencies, matching every other service in the project. No HTTP
 * types cross this boundary — it takes validated data, a store id, and an actor, and raises
 * `DomainError` subclasses the terminal middleware maps.
 */

export type InventoryService = ReturnType<typeof createInventoryService>;

/**
 * The adjustment would leave less stock than exists — or than is already reserved.
 *
 * `details.available` is included so an operator can see what they actually had rather than
 * having to make a second request to find out. It is safe: the caller is authenticated staff
 * of the store that owns the SKU, and they just asked about this exact SKU.
 */
export class InsufficientStock extends Conflict {
  override readonly code = 'INSUFFICIENT_STOCK';

  constructor(args: { available: number; requested: number }) {
    super('The adjustment would leave less stock than is available.', {
      available: args.available,
      requested: args.requested,
    });
  }
}

/**
 * Checkout could not hold the stock it needed.
 *
 * A separate class from `InsufficientStock` rather than a reshaping of it, because the two are
 * different failures with different audiences. That one answers a staff adjustment about ONE
 * SKU and reports `available`/`requested`, which is safe to disclose to the operator who owns
 * the SKU. This one answers a CUSTOMER checkout across SEVERAL lines, and reports only the SKU
 * codes — never the quantities on hand, which are a merchant's commercial information and none
 * of a shopper's business.
 *
 * `409`, inherited from `Conflict`: the request was valid and would succeed later, which is
 * exactly what a shopper needs to be told. The shape matches `CheckoutLinesUnavailable`, so a
 * client handles "cannot buy these lines right now" one way regardless of the reason.
 */
export class ReservationInsufficientStock extends Conflict {
  override readonly code = 'INSUFFICIENT_STOCK';

  constructor(skuCodes: readonly string[]) {
    super('Some items in your cart are no longer available in the quantity requested.', {
      skuCodes: [...skuCodes],
    });
  }
}

/**
 * This order cannot be fulfilled. A `409`: a conflict with existing state.
 *
 * Covers three distinct situations, and the message says which: the order holds no reservation
 * at all, its reservation was already released (cancelled, or the payment failed or expired), or
 * it is not committed and the caller is not on the approved COD path.
 */
export class NothingToFulfil extends Conflict {
  override readonly code = 'NOTHING_TO_FULFIL';
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * The order's inventory has already shipped. A `409`.
 *
 * Separate from `NothingToFulfil` because the operational answer differs: this is not "fix the
 * payment and retry", it is "this already happened". Reached only if a shipment CAS let a second
 * fulfilment through, so it is a loud refusal — a second stock movement cannot be undone without
 * a correcting ledger entry.
 */
export class AlreadyFulfilled extends Conflict {
  override readonly code = 'ALREADY_FULFILLED';
  constructor() {
    super('this order has already been fulfilled');
  }
}

export function createInventoryService(deps: {
  repository: InventoryRepository;
  db: Database;
  events: EventBus;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, events, audit, logger } = deps;

  return {
    /**
     * One SKU's stock, or 404.
     *
     * An unknown code, another store's SKU, and a soft-deleted SKU all return the same
     * `NotFound` — the §25 rule that ownership belongs in the query rather than in a
     * comparison afterwards, so confirming a code exists elsewhere cannot leak across a tenant
     * boundary. An INACTIVE SKU is returned normally: deactivation means "not sellable", not
     * "not stocked".
     */
    async getStockByCode(params: { storeId: string; code: string }): Promise<StockRecord> {
      const row = await repository.findStockByCode(params);
      if (!row) {
        logger.info({ storeId: params.storeId, code: params.code }, 'stock_not_found');
        throw new NotFound('inventory');
      }
      return row;
    },

    /** A page of this store's stock. Visibility belongs to the repository query. */
    async getStockForStore(params: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: StockRecord[]; total: number }> {
      return repository.listStockForStore(params);
    },

    /**
     * **Adjust one SKU's stock. The heart of the increment.**
     *
     * Everything happens in ONE transaction: the atomic stock update, the ledger entry, the
     * event, and the audit record. A rollback discards all four, so the state the design
     * forbids — a ledger entry with no projection change, or an audit trail recording an
     * adjustment that did not happen — is not reachable through a crash, a concurrent write, or
     * a rejected statement.
     *
     * ## Why there is no read before the write
     *
     * The atomic `UPDATE` in the repository is the only thing that reads `on_hand`, and it
     * returns the resulting value. Nothing here reads stock, computes a new figure, and writes
     * it back: that shape loses updates under concurrency, which was measured against this
     * PostgreSQL — two concurrent `+5` from 10 produced 15, and two concurrent `-4` from 5 both
     * reported success while four units vanished with no CHECK constraint violated.
     *
     * So `onHandBefore` is derived from the statement's own result rather than from a separate
     * read. That is what guarantees the ledger's before/after pair describes the same moment
     * the update happened.
     */
    async adjustStock(params: {
      storeId: string;
      actor: AuditActor;
      input: CreateAdjustmentRequest;
    }): Promise<{ stock: StockRecord; entry: StockLedgerRecord }> {
      const { storeId, actor, input } = params;

      /**
       * Correlation from the AMBIENT request context, not from a parameter and never from the
       * body — the same source `audit.record` falls back to, so a ledger entry and its audit
       * row always carry the identical `request_id`. `undefined` outside an HTTP request (a
       * future CLI adjustment) becomes NULL, which the column allows.
       */
      const requestId = getRequestId() ?? null;

      /**
       * The actor's user id, from the verified token — never from the request body, which has
       * no field for it. `ck` on the ledger's FK to `app_user` means a forged or absent id
       * fails the insert rather than writing an unattributable row.
       */
      const actorUserId = actor.type === 'staff' ? actor.userId : undefined;
      if (actorUserId === undefined) {
        // Unreachable through HTTP: the route's `requireStaff` guard runs first. Stated so a
        // future CLI caller fails loudly rather than writing an unattributed ledger entry.
        throw new Error('inventory adjustment requires a staff actor');
      }

      const result = await withTransaction(db, logger, async () => {
        const at = new Date();

        let outcome = await repository.adjustStock({
          storeId,
          code: input.skuCode,
          delta: input.delta,
          at,
        });

        /**
         * A live SKU with no projection row yet — initialise it and adjust once more.
         *
         * The migration created a row for every SKU that existed when inventory shipped, but a
         * SKU created AFTERWARDS has none, and adjusting it would otherwise be a confusing 404
         * for a SKU the merchant can plainly see in the catalogue.
         *
         * Both statements are still atomic and still inside this transaction: the insert is
         * `ON CONFLICT DO NOTHING`, so a concurrent initialisation is harmless, and the retry
         * re-applies the SAME predicate, so the store scope, the liveness check and the
         * non-negative rule are enforced exactly as on the first attempt. Nothing is read into
         * JavaScript and adjusted there at any point.
         *
         * Runs at most once, and only when the SKU resolves as live — so a genuinely unknown
         * or deleted SKU still falls through to the 404 below rather than having a row created
         * for it.
         */
        if (!outcome) {
          const ref = await repository.findLiveSkuRefByCode({ storeId, code: input.skuCode });
          if (ref) {
            await repository.initialiseStock({ skuId: ref.id, storeId });
            outcome = await repository.adjustStock({
              storeId,
              code: input.skuCode,
              delta: input.delta,
              at,
            });
          }
        }

        /**
         * Still nothing. That means one of two things — no such live SKU in this store, or the
         * delta cannot be absorbed — and the atomic predicate cannot tell them apart. A second
         * STORE-SCOPED read does, after the rollback, exactly as `transitionStatus` does in the
         * catalogue: the boundary stays in the query, so there is no second place for the store
         * scope to be got wrong.
         */
        if (!outcome) return undefined;

        const entry = await repository.insertLedgerEntry({
          id: newId(),
          storeId,
          skuId: outcome.skuId,
          delta: input.delta,
          onHandBefore: outcome.onHandBefore,
          onHandAfter: outcome.onHandAfter,
          reason: input.reason,
          note: input.note ?? '',
          actorUserId,
          requestId,
        });

        /**
         * Re-read the projection so the response carries exactly what is stored, including the
         * generated `available` and the SKU code. One indexed read inside the same
         * transaction, rather than assembling a response from values the service happens to
         * hold — which is how a response and a database end up disagreeing.
         */
        const stock = await repository.findStockByCode({ storeId, code: input.skuCode });
        if (!stock) {
          // Unreachable: the update above matched this exact row inside this transaction.
          throw new Error(`stock row for ${input.skuCode} vanished during adjustment`);
        }

        await events.emit({
          type: STOCK_EVENTS.adjusted,
          aggregateType: STOCK_AGGREGATE,
          aggregateId: outcome.skuId,
          storeId,
          payload: stockEventPayload({
            skuId: outcome.skuId,
            skuCode: stock.skuCode,
            delta: input.delta,
            onHandBefore: outcome.onHandBefore,
            onHandAfter: outcome.onHandAfter,
            available: stock.available,
            reason: input.reason,
          }),
        });

        await audit.record({
          action: STOCK_AUDIT.adjusted,
          actor,
          resourceType: STOCK_RESOURCE,
          resourceId: outcome.skuId,
          storeId,
          /**
           * The arithmetic and the WHY. `skuCode` is recorded because a code is freed for reuse
           * when a SKU is deleted, so after a later SKU claims it the resource id alone no
           * longer tells an auditor which SKU this entry meant — the same reasoning the
           * catalogue applies to a deleted product's slug.
           *
           * `store_id`, `actor_user_id`, `request_id` and the timestamp are written by the
           * audit infrastructure itself and are not repeated here.
           */
          metadata: {
            skuCode: stock.skuCode,
            delta: input.delta,
            onHandBefore: outcome.onHandBefore,
            onHandAfter: outcome.onHandAfter,
            available: stock.available,
            reason: input.reason,
            note: input.note ?? '',
          },
        });

        return { stock, entry };
      });

      if (result) {
        logger.info(
          {
            storeId,
            skuId: result.entry.skuId,
            delta: input.delta,
            onHandAfter: result.entry.onHandAfter,
          },
          'stock_adjusted',
        );
        return result;
      }

      /**
       * The update matched nothing. Distinguish the two causes with one store-scoped read,
       * OUTSIDE the transaction that has already rolled back.
       *
       * A SKU that does not exist, belongs to another store, or is deleted → 404. One that
       * exists but cannot absorb the delta → 409 with what was actually available.
       */
      const existing = await repository.findStockByCode({ storeId, code: input.skuCode });
      if (!existing) {
        logger.info({ storeId, code: input.skuCode }, 'stock_adjust_sku_not_found');
        throw new NotFound('inventory');
      }

      logger.info(
        { storeId, code: input.skuCode, available: existing.available, delta: input.delta },
        'stock_adjust_rejected_insufficient',
      );
      throw new InsufficientStock({ available: existing.available, requested: input.delta });
    },

    /**
     * One SKU's movement history.
     *
     * The SKU is resolved first, so an unknown or deleted code is a 404 rather than an empty
     * page: those mean different things to a merchant, and an empty array for a mistyped code
     * is the answer that sends someone looking for data that was never there.
     *
     * The history query itself does NOT filter on SKU liveness. Resolving here is what enforces
     * the boundary; the ledger is history and must stay readable in full once you are allowed
     * to see it at all.
     */
    async getHistoryForSku(params: {
      storeId: string;
      code: string;
      limit: number;
      offset: number;
    }): Promise<{ items: StockLedgerRecord[]; total: number }> {
      const ref = await repository.findLiveSkuRefByCode({
        storeId: params.storeId,
        code: params.code,
      });
      if (!ref) {
        logger.info({ storeId: params.storeId, code: params.code }, 'stock_history_not_found');
        throw new NotFound('inventory');
      }

      return repository.listLedgerForSku({
        storeId: params.storeId,
        skuId: ref.id,
        limit: params.limit,
        offset: params.offset,
      });
    },

    /**
     * Initialise the projection row for a newly created SKU.
     *
     * Wired by the composition root to SKU creation, so the catalogue module does not import
     * inventory and inventory does not import the catalogue. Idempotent, so a retry is safe.
     *
     * Zero is an INITIALISATION value, exactly as in the migration: it records that the system
     * has not been told this SKU's stock, not that the shelf is empty.
     */
    async initialiseStockForSku(params: { skuId: string; storeId: string }): Promise<void> {
      await repository.initialiseStock(params);
    },

    /* ── Reservation ──────────────────────────────────────────────────────── */

    /**
     * **Hold stock for a placed order. Called from inside the checkout transaction.**
     *
     * ## Deterministic lock ordering is load-bearing, not an optimisation
     *
     * The lines are sorted by `skuId` ascending and reserved **sequentially**. Both parts
     * matter, and dropping either reintroduces deadlocks:
     *
     *  - **Sorted**, because two carts holding the same two SKUs in opposite order would
     *    otherwise have each transaction take one row lock and wait for the other's — a wait
     *    cycle PostgreSQL breaks by killing one with SQLSTATE 40P01. With one global order,
     *    no cycle can form: the later transaction simply blocks, then re-evaluates.
     *  - **By `skuId`, not `skuCode`**, because `skuId` is the row being locked. Sorting by
     *    code is a plausible-looking bug that only shows up when two SKUs' code order and id
     *    order disagree — which is why a test uses exactly that fixture.
     *  - **Sequentially**, because the guarantee is about the order statements are ISSUED in.
     *    `Promise.all` would abandon it while looking like a harmless speedup.
     *
     * No quantity aggregation is needed: `pk_cart_line` is `(cart_id, sku_id)`, so a cart
     * cannot hold two lines for one SKU, and therefore neither can an order.
     *
     * ## All or nothing
     *
     * The first line that cannot be reserved aborts the whole thing by throwing, which rolls
     * back the enclosing checkout transaction — the counter increments already made, the
     * order, and its lines. There is deliberately no partial reservation and no partial order:
     * it matches the existing rule that one unpurchasable line refuses the entire checkout.
     *
     * Reservation rows are inserted only after EVERY counter increment has succeeded, so a
     * failed checkout never leaves a `held` row behind even momentarily.
     */
    async reserveForOrder(params: {
      orderId: string;
      storeId: string;
      lines: readonly { skuId: string; skuCode: string; quantity: number }[];
    }): Promise<void> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'reserveForOrder must be called inside the caller transaction; a reservation that ' +
            'outlived a rolled-back checkout would hold stock for an order that does not exist',
        );
      }
      if (params.lines.length === 0) return;

      const at = new Date();

      /*
       * A copy, sorted by the LOCK TARGET. Canonical lowercase UUIDs, so a plain string
       * comparison is a total order — the only property required, since every transaction
       * applies the same one.
       */
      const ordered = [...params.lines].sort((a, b) => (a.skuId < b.skuId ? -1 : 1));

      for (const line of ordered) {
        const outcome = await repository.reserveForSku({
          skuId: line.skuId,
          storeId: params.storeId,
          quantity: line.quantity,
          at,
        });

        if (!outcome) {
          /*
           * Zero rows is insufficient stock, a missing projection row, or a SKU outside this
           * store — indistinguishable by design. Checkout has already proven the SKU is live
           * and in-store, and a missing row means zero available, so all three are reported as
           * insufficient, naming the code the customer would recognise.
           */
          logger.info(
            {
              storeId: params.storeId,
              orderId: params.orderId,
              skuCode: line.skuCode,
              requested: line.quantity,
            },
            'reservation_rejected_insufficient_stock',
          );
          throw new ReservationInsufficientStock([line.skuCode]);
        }
      }

      await repository.insertReservations(
        ordered.map((line) => ({
          orderId: params.orderId,
          skuId: line.skuId,
          storeId: params.storeId,
          quantity: line.quantity,
        })),
      );

      logger.info(
        { storeId: params.storeId, orderId: params.orderId, lines: ordered.length },
        'reservation_held',
      );
    },

    /**
     * **Give an order's held stock back. Exactly once, whatever the caller does.**
     *
     * The `status = 'held'` CAS inside `settleReservationsForOrder` is the guarantee: a second
     * call returns no rows and performs no decrement. A `committed` reservation is never
     * matched, so paid stock cannot be released by a cancellation that races in.
     *
     * The decrements are issued in `skuId` order for the same deadlock reason as reserving —
     * two cancellations of DIFFERENT orders that share SKUs would otherwise be able to form a
     * wait cycle.
     */
    async releaseForOrder(params: {
      orderId: string;
      storeId: string;
      reason: ReservationSettledReason;
    }): Promise<void> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'releaseForOrder must be called inside the caller transaction; the settlement and ' +
            'the counter decrements must commit together or not at all',
        );
      }

      const at = new Date();
      const settled = await repository.settleReservationsForOrder({
        orderId: params.orderId,
        storeId: params.storeId,
        toStatus: 'released',
        reason: params.reason,
        at,
      });

      if (settled.length === 0) return;

      for (const row of [...settled].sort((a, b) => (a.skuId < b.skuId ? -1 : 1))) {
        const outcome = await repository.releaseForSku({
          skuId: row.skuId,
          storeId: params.storeId,
          quantity: row.quantity,
          at,
        });

        if (!outcome) {
          /*
           * Unreachable unless the projection has diverged from the reservation rows: this row
           * was `held` a statement ago, and a held reservation is by construction counted in
           * `reserved`. Failing loudly is right — silently under-releasing would leave stock
           * permanently unsellable with nothing recording why.
           */
          throw new InvariantViolation(
            `stock_item.reserved is lower than a held reservation for sku ${row.skuId}; ` +
              'the projection has diverged from stock_reservation',
          );
        }
      }

      logger.info(
        {
          storeId: params.storeId,
          orderId: params.orderId,
          reason: params.reason,
          lines: settled.length,
        },
        'reservation_released',
      );
    },

    /**
     * **Turn an order's held stock into a sale. Exactly once.**
     *
     * Deliberately moves NO counter. A committed reservation is a sale awaiting fulfilment:
     * the units are still physically present, so `on_hand` keeps counting them, and they are
     * no longer sellable, so `reserved` keeps counting them too. `available` therefore stays
     * correct with no change to its formula, and `stock_ledger` — which exists to justify
     * `on_hand` — needs no entry, because `on_hand` did not move.
     *
     * The decrement of both, and the ledger row for it, belong to the fulfilment increment
     * that ships the goods. Until then nothing in this codebase ever reduces `on_hand` for a
     * sale, which is why `available` trends toward zero while `on_hand` stays flat.
     */
    async commitForOrder(params: { orderId: string; storeId: string }): Promise<void> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'commitForOrder must be called inside the caller transaction; the commit must ' +
            'commit with the payment transition that caused it',
        );
      }

      const settled = await repository.settleReservationsForOrder({
        orderId: params.orderId,
        storeId: params.storeId,
        toStatus: 'committed',
        reason: 'payment_succeeded',
        at: new Date(),
      });

      if (settled.length === 0) return;

      logger.info(
        { storeId: params.storeId, orderId: params.orderId, lines: settled.length },
        'reservation_committed',
      );
    },

    /**
     * **Fulfil an order's entire reservation. The physical movement, and the only one.**
     *
     * Called from inside the shipping transaction, after the order lock. This is where stock
     * actually leaves the building: `on_hand` falls, `reserved` falls by the same amount,
     * `available` is unchanged, and one `stock_ledger` row is written per SKU with reason
     * `shipment`.
     *
     * ## All or nothing, because there is no partial fulfilment
     *
     * One shipment per order and no `shipment_item`, so this fulfils the COMPLETE reservation
     * or throws. Any failure — a divergent projection, a reservation in the wrong state, a
     * missing stock row — propagates and rolls the caller's transaction back, taking the
     * shipment transition with it. **A shipment can never be `shipped` while the stock movement
     * is partial.**
     *
     * ## The COD path, stated explicitly
     *
     * A COD order's reservation is `held`, because a COD payment never terminalises and nothing
     * commits it. `held -> fulfilled` is deliberately illegal, and inventing a payment
     * transition is forbidden — so when `allowUncommittedCod` is set, this performs
     * `held -> committed` with reason `cod_fulfilment` first, then fulfils normally. Two
     * transitions, one transaction, no payment write.
     *
     * That flag is the ONLY way a held reservation reaches `fulfilled`, and the caller sets it
     * only for a COD order whose payment is `pending` — the approved unpaid-fulfilment path.
     *
     * ## Deterministic ordering
     *
     * SKUs are processed in ascending `sku_id` order, sequentially, for the reason Increment 35
     * established: each takes a `stock_item` row lock, and two fulfilments of different orders
     * sharing SKUs would otherwise deadlock. `Promise.all` would abandon the guarantee while
     * looking like a speedup.
     */
    async fulfilForOrder(params: {
      orderId: string;
      storeId: string;
      /** The staff member shipping it. `stock_ledger.actor_user_id` is NOT NULL by decision. */
      actorUserId: string;
      /**
       * Permit a `held` reservation to be committed here first. **COD only.**
       *
       * Named for what it permits rather than for the method, so a future caller cannot set it
       * casually: it means "this order may ship without its money having arrived".
       */
      allowUncommittedCod: boolean;
    }): Promise<{ skuCount: number; totalUnits: number }> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'fulfilForOrder must be called inside the caller transaction; the stock movement and ' +
            'the shipment transition must commit together or not at all',
        );
      }

      const at = new Date();
      const requestId = getRequestId() ?? null;

      const existing = await repository.listFulfillableReservations({
        orderId: params.orderId,
        storeId: params.storeId,
      });

      if (existing.length === 0) {
        throw new NothingToFulfil('this order holds no inventory reservation');
      }

      if (existing.some((row) => row.status === 'fulfilled')) {
        /*
         * Already shipped. Reached only if the shipment CAS above somehow let a second
         * fulfilment through, so it is a loud refusal rather than a silent no-op — a second
         * stock movement is unrecoverable without a correcting ledger entry.
         */
        throw new AlreadyFulfilled();
      }

      if (existing.some((row) => row.status === 'released')) {
        /*
         * The order was cancelled, or its payment failed or expired. The units went back to
         * the sellable pool and shipping them would oversell.
         */
        throw new NothingToFulfil('this order’s inventory reservation was already released');
      }

      /* Every remaining row is `held` or `committed`. */
      const held = existing.filter((row) => row.status === RESERVATION_HELD);

      if (held.length > 0) {
        if (!params.allowUncommittedCod) {
          throw new NothingToFulfil(
            'this order’s inventory reservation has not been committed by a successful payment',
          );
        }

        /*
         * The COD step. `held -> committed` with `cod_fulfilment`, so the row records that the
         * sale was recognised at shipment and NOT that money arrived. No counter moves — commit
         * never moves one — so the reconciliation invariant holds across this statement.
         */
        const committed = await repository.commitReservationsForCodFulfilment({
          orderId: params.orderId,
          storeId: params.storeId,
          at,
        });

        if (committed.length !== held.length) {
          throw new InvariantViolation(
            `expected to commit ${String(held.length)} held reservations for COD fulfilment but ` +
              `committed ${String(committed.length)}; another transaction changed them`,
          );
        }

        logger.info(
          { storeId: params.storeId, orderId: params.orderId, lines: committed.length },
          'reservation_committed_for_cod_fulfilment',
        );
      }

      /*
       * `committed -> fulfilled`, CAS-protected. Zero rows would mean another transaction moved
       * them between the read above and here, which the order lock should make impossible —
       * hence a loud failure rather than a quiet return.
       */
      const fulfilled = await repository.fulfilReservationsForOrder({
        orderId: params.orderId,
        storeId: params.storeId,
        fromStatus: 'committed',
        at,
      });

      if (fulfilled.length !== existing.length) {
        throw new InvariantViolation(
          `expected to fulfil ${String(existing.length)} reservations for order ` +
            `${params.orderId} but fulfilled ${String(fulfilled.length)}`,
        );
      }

      let totalUnits = 0;

      /* Sorted by the LOCK TARGET, sequentially. See the header. */
      for (const row of [...fulfilled].sort((a, b) => (a.skuId < b.skuId ? -1 : 1))) {
        const outcome = await repository.fulfilStockForSku({
          skuId: row.skuId,
          storeId: params.storeId,
          quantity: row.quantity,
          at,
        });

        if (!outcome) {
          /*
           * Unreachable unless the projection has diverged: this SKU had a committed
           * reservation a statement ago, so both `on_hand` and `reserved` must have covered it.
           * Failing loudly rolls the whole shipment back, which is the only safe answer —
           * shipping stock the system cannot account for is worse than refusing to ship.
           */
          throw new InvariantViolation(
            `stock_item for sku ${row.skuId} cannot cover a committed reservation of ` +
              `${String(row.quantity)}; the projection has diverged from stock_reservation`,
          );
        }

        /*
         * One ledger row per SKU, negative delta, both sides of the arithmetic from the SAME
         * statement that moved the counter. `SUM(delta) = on_hand` therefore still holds — the
         * invariant a test asserts — and this is the first entry in the ledger's history that
         * a customer's order caused.
         */
        await repository.insertLedgerEntry({
          id: newId(),
          storeId: params.storeId,
          skuId: row.skuId,
          delta: -row.quantity,
          onHandBefore: outcome.onHandBefore,
          onHandAfter: outcome.onHandAfter,
          reason: 'shipment',
          note: '',
          /* NOT NULL by decision 19: manual fulfilment always has a real staff actor. */
          actorUserId: params.actorUserId,
          requestId,
        });

        totalUnits += row.quantity;
      }

      logger.info(
        {
          storeId: params.storeId,
          orderId: params.orderId,
          skuCount: fulfilled.length,
          totalUnits,
        },
        'inventory_fulfilled',
      );

      return { skuCount: fulfilled.length, totalUnits };
    },

    /** One order's reservations. Read-only, for tests and support. */
    async listReservationsForOrder(params: { orderId: string; storeId: string }) {
      return repository.listReservationsForOrder(params);
    },
  };
}
