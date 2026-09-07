import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { getRequestId } from '../../shared/context.js';
import { Conflict, NotFound } from '../../shared/errors.js';
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
import type {
  InventoryRepository,
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
  };
}
