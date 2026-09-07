import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { Conflict, NotFound } from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import {
  compare,
  fromDb,
  isCurrency,
  min,
  percentOf,
  toDb,
  type Currency,
} from '../../shared/money.js';
import { PROMOTION_AUDIT, PROMOTION_RESOURCE } from './promotions.events.js';
import type {
  EditablePromotionFields,
  PromotionRecord,
  PromotionsRepository,
} from './promotions.repository.js';
import type { CreatePromotionRequest, UpdatePromotionRequest } from './dto.js';

/**
 * The promotions module's API: staff configuration, plus discount evaluation for a cart.
 *
 * ## No `EventBus`
 *
 * There is no event bus in these dependencies. Nothing consumes a promotion change — the
 * handler registry is empty and no checkout exists — and Increment 26 established that an
 * event with no consumer is a guess at one. Audit is the whole obligation.
 *
 * ## Evaluation is advisory
 *
 * `evaluateForCart` answers "what would this promotion take off a cart with this subtotal,
 * right now". It stores nothing, consumes nothing, and reserves nothing. Applying a coupon
 * does not redeem it: redemption is an order-time act and there are no orders. Checkout will
 * re-read prices, revalidate the promotion and recompute the discount from scratch.
 */

/** A merchant tried to reuse a live coupon code. */
export class PromotionCodeTaken extends Conflict {
  override readonly code = 'PROMOTION_CODE_TAKEN';

  constructor(promotionCode: string) {
    super(`A promotion with code "${promotionCode}" already exists in this store.`, {
      promotionCode,
    });
  }
}

/** Why a promotion cannot be applied. Deliberately a small, closed vocabulary. */
export type PromotionRejection =
  /**
   * No usable promotion. Unknown code, another store's, deactivated, soft-deleted,
   * not-yet-started and expired all collapse to this — the caller answers `404` for every one,
   * so the response never reveals that a coupon exists but is unavailable.
   */
  | { readonly reason: 'not_found' }
  /**
   * The promotion exists and is live, but the cart is below its minimum.
   *
   * Distinguished on purpose, and it is the one distinction that leaks nothing worth having:
   * the customer has already proved they know the code, and telling them "spend ₹500 to use
   * this" is the entire point of a minimum.
   */
  | { readonly reason: 'minimum_subtotal'; readonly minSubtotal: string };

/** What a promotion takes off a cart, computed for one subtotal at one instant. */
export type PromotionDiscount = {
  readonly promotionId: string;
  readonly code: string;
  readonly name: string;
  /** A `NUMERIC(19,4)` decimal string. Never negative, never more than the subtotal. */
  readonly discountTotal: string;
};

export type PromotionsService = ReturnType<typeof createPromotionsService>;

export function createPromotionsService(deps: {
  repository: PromotionsRepository;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, audit, logger } = deps;

  /**
   * A store configured with a currency this build does not know is an OPERATOR error, not a
   * client one, so it surfaces as a 500 — the same judgement the catalogue and cart services
   * make.
   */
  function requireCurrency(storeId: string, value: string): Currency {
    if (!isCurrency(value)) {
      throw new Error(`store ${storeId} has an unsupported currency: ${value}`);
    }
    return value;
  }

  /**
   * The discount this promotion takes off `subtotal`.
   *
   * **All arithmetic through `shared/money.ts`.** `local/no-money-arithmetic` forbids touching
   * these values with `+` or `*`, for good reason: `'1499.0000' * 0.1` is not multiplication
   * and `Number('1499.0000')` reintroduces the float error `NUMERIC(19,4)` exists to avoid.
   *
   * Computed ONCE against the whole subtotal, never per line and summed. That is not a
   * micro-optimisation: measured against this build's money module, `percentOf(price, r)`
   * multiplied by quantity and `percentOf(price × quantity, r)` differ in the fourth decimal,
   * because every operation rounds to the storage scale. One subtotal-level call is the
   * shortest possible chain and makes the answer independent of how the cart is split into
   * lines.
   *
   * No `allocate()` here. Splitting a cart discount across lines is a minor-unit rounding
   * boundary, and it belongs at the order/tax boundary where a per-line taxable value is
   * actually needed — not in a cart that reports four decimals.
   */
  function discountFor(args: {
    promotion: PromotionRecord;
    subtotal: string;
    currency: Currency;
  }): string {
    const subtotal = fromDb(args.subtotal, args.currency);

    if (args.promotion.discountType === 'percentage') {
      if (args.promotion.percentRate === null) {
        // Unreachable: `ck_promotion_shape` guarantees a percentage promotion has a rate.
        throw new Error(`promotion ${args.promotion.id} is a percentage with no rate`);
      }
      /**
       * `ck_promotion_percent_range` bounds the rate at 100, so this can equal the subtotal but
       * never exceed it. The cap is the DATABASE's job, not a second guard here that no test
       * could reach.
       */
      return toDb(percentOf(subtotal, args.promotion.percentRate));
    }

    if (args.promotion.amount === null) {
      // Unreachable: `ck_promotion_shape` guarantees a fixed promotion has an amount.
      throw new Error(`promotion ${args.promotion.id} is a fixed amount with none set`);
    }

    /**
     * Capped at the subtotal. A ₹500 coupon on a ₹200 cart takes ₹200, not ₹500 — the
     * alternative is a negative total, which is the system paying the customer to shop.
     */
    return toDb(min(fromDb(args.promotion.amount, args.currency), subtotal));
  }

  /**
   * The unmet threshold, or `undefined` when the cart qualifies.
   *
   * Returns the threshold rather than a boolean so the caller cannot reach for
   * `promo.minSubtotal` and have to re-establish that it is non-null. Inclusive: a cart exactly
   * at the threshold qualifies, which is the reading a merchant writing "on orders above ₹500"
   * expects and the only one that has no dead value just below the line.
   *
   * Compared against the subtotal BEFORE any discount. Using the discounted total would be
   * circular — the discount is what is being decided.
   */
  function unmetMinimum(
    promo: PromotionRecord,
    subtotal: string,
    currency: Currency,
  ): string | undefined {
    if (promo.minSubtotal === null) return undefined;
    const threshold = fromDb(promo.minSubtotal, currency);
    return compare(fromDb(subtotal, currency), threshold) >= 0 ? undefined : toDb(threshold);
  }

  function toDiscount(
    promo: PromotionRecord,
    subtotal: string,
    currency: Currency,
  ): PromotionDiscount {
    return {
      promotionId: promo.id,
      code: promo.code,
      name: promo.name,
      discountTotal: discountFor({ promotion: promo, subtotal, currency }),
    };
  }

  /**
   * Reject a create or update whose code collides with a live promotion.
   *
   * `uq_promotion_code_active` is the real guarantee — this read makes the failure a clean
   * `409` naming the code instead of a raw SQLSTATE 23505, and it is deliberately NOT the
   * defence. Under concurrency the index wins and the loser sees the constraint; that is why
   * the caller maps a unique violation too.
   */
  async function assertCodeFree(args: {
    storeId: string;
    code: string;
    exceptId?: string;
  }): Promise<void> {
    const existing = await repository.findByCodeForAdmin({
      storeId: args.storeId,
      code: args.code,
    });
    if (existing && existing.id !== args.exceptId) {
      throw new PromotionCodeTaken(args.code);
    }
  }

  async function recordChange(args: {
    storeId: string;
    actor: AuditActor;
    promotionId: string;
    action: string;
    /**
     * Field NAMES, not values. A coupon's terms are commercially sensitive, and `audit_log`'s
     * own doc comment notes it is *"read by more people than the database, and frequently
     * shipped to a log aggregator with different access controls"* — the same judgement §40
     * made for addresses. Absent for create and delete, where the action says it all.
     */
    changed?: readonly string[];
  }): Promise<void> {
    await audit.record({
      action: args.action,
      actor: args.actor,
      resourceType: PROMOTION_RESOURCE,
      resourceId: args.promotionId,
      storeId: args.storeId,
      ...(args.changed === undefined ? {} : { metadata: { changed: [...args.changed] } }),
    });
  }

  return {
    /* ── Staff configuration ─────────────────────────────────────────────── */

    /**
     * Create a promotion.
     *
     * The insert and the audit entry share one transaction, so a rollback discards both: a
     * trail recording a creation that did not happen is worse than no entry at all.
     */
    async createPromotion(params: {
      storeId: string;
      actor: AuditActor;
      input: CreatePromotionRequest;
    }): Promise<PromotionRecord> {
      const { storeId, actor, input } = params;

      return withTransaction(db, logger, async () => {
        await assertCodeFree({ storeId, code: input.code });

        const row = await repository.insertPromotion({
          id: newId(),
          // From the resolved store, never from the request body.
          storeId,
          code: input.code,
          name: input.name,
          discountType: input.discountType,
          /**
           * Exactly one of these is present, decided by `discountType`. Stated explicitly
           * rather than spread from the input so the null is deliberate.
           *
           * The `?? null` is unreachable — the request schema refuses a percentage with no rate
           * — and it is written that way rather than asserted so that if it ever WERE reachable,
           * `ck_promotion_shape` refuses the row instead of a non-null assertion quietly
           * writing whatever it found.
           */
          percentRate: input.discountType === 'percentage' ? (input.percentRate ?? null) : null,
          amount: input.discountType === 'fixed_amount' ? (input.amount ?? null) : null,
          minSubtotal: input.minSubtotal ?? null,
          startsAt: input.startsAt === undefined ? null : new Date(input.startsAt),
          endsAt: input.endsAt === undefined ? null : new Date(input.endsAt),
          isActive: input.isActive ?? true,
        });

        await recordChange({
          storeId,
          actor,
          promotionId: row.id,
          action: PROMOTION_AUDIT.created,
        });

        logger.info({ storeId, promotionId: row.id }, 'promotion_created');
        return row;
      });
    },

    async getPromotion(params: { storeId: string; code: string }): Promise<PromotionRecord> {
      const row = await repository.findByCodeForAdmin(params);
      if (!row) throw new NotFound('promotion');
      return row;
    },

    async listPromotions(params: { storeId: string; limit: number; offset: number }): Promise<{
      items: readonly PromotionRecord[];
      total: number;
      limit: number;
      offset: number;
    }> {
      const page = await repository.listPromotions(params);
      return { ...page, limit: params.limit, offset: params.offset };
    },

    /**
     * Apply a partial change.
     *
     * `discountType` may change, and when it does the value columns must be rewritten together
     * — a promotion switching from percentage to fixed with its old rate still set would fail
     * `ck_promotion_shape`, which is the constraint doing its job but a `500` for the merchant.
     * So the two columns are always written as a pair, derived from the resulting type.
     */
    async updatePromotion(params: {
      storeId: string;
      code: string;
      actor: AuditActor;
      input: UpdatePromotionRequest;
    }): Promise<PromotionRecord> {
      const { storeId, code, actor, input } = params;

      return withTransaction(db, logger, async () => {
        const existing = await repository.findByCodeForAdmin({ storeId, code });
        if (!existing) throw new NotFound('promotion');

        if (input.code !== undefined) {
          await assertCodeFree({ storeId, code: input.code, exceptId: existing.id });
        }

        const changes: EditablePromotionFields = {};
        if (input.code !== undefined) changes.code = input.code;
        if (input.name !== undefined) changes.name = input.name;
        if (input.minSubtotal !== undefined) changes.minSubtotal = input.minSubtotal;
        if (input.startsAt !== undefined) {
          changes.startsAt = input.startsAt === null ? null : new Date(input.startsAt);
        }
        if (input.endsAt !== undefined) {
          changes.endsAt = input.endsAt === null ? null : new Date(input.endsAt);
        }
        if (input.isActive !== undefined) changes.isActive = input.isActive;

        /**
         * The discount shape, always written as a pair.
         *
         * `percentRate` and `amount` are never set independently of the type that selects
         * them, so the row moves from one valid shape to another in a single statement.
         */
        const nextType = input.discountType ?? existing.discountType;
        const touchesShape =
          input.discountType !== undefined ||
          input.percentRate !== undefined ||
          input.amount !== undefined;

        if (touchesShape) {
          changes.discountType = nextType;
          if (nextType === 'percentage') {
            changes.percentRate = input.percentRate ?? existing.percentRate;
            changes.amount = null;
          } else {
            changes.amount = input.amount ?? existing.amount;
            changes.percentRate = null;
          }
        }

        const row = await repository.updatePromotion({
          storeId,
          code,
          changes,
          at: new Date(),
        });
        if (!row) throw new NotFound('promotion');

        await recordChange({
          storeId,
          actor,
          promotionId: row.id,
          action: PROMOTION_AUDIT.updated,
          changed: Object.keys(changes).filter((k) => k !== 'updatedAt'),
        });

        logger.info({ storeId, promotionId: row.id }, 'promotion_updated');
        return row;
      });
    },

    /**
     * Soft delete. No restore: reviving a coupon a merchant retired is a new promotion, and an
     * undelete endpoint would need its own uniqueness story when the code has since been reused.
     */
    async deletePromotion(params: {
      storeId: string;
      code: string;
      actor: AuditActor;
    }): Promise<void> {
      const { storeId, code, actor } = params;

      await withTransaction(db, logger, async () => {
        const existing = await repository.findByCodeForAdmin({ storeId, code });
        if (!existing) throw new NotFound('promotion');

        const deleted = await repository.softDeletePromotion({ storeId, code, at: new Date() });
        if (!deleted) throw new NotFound('promotion');

        await recordChange({
          storeId,
          actor,
          promotionId: existing.id,
          action: PROMOTION_AUDIT.deleted,
        });

        logger.info({ storeId, promotionId: existing.id }, 'promotion_deleted');
      });
    },

    /* ── The cart-facing port ────────────────────────────────────────────── */

    /**
     * Resolve a customer-supplied code and price it against a subtotal.
     *
     * Used when a customer APPLIES a coupon. Returns the discount, or a rejection the caller
     * maps to a status code.
     */
    async findApplicable(params: {
      storeId: string;
      code: string;
      subtotal: string;
      storeCurrency: string;
      at: Date;
    }): Promise<PromotionDiscount | PromotionRejection> {
      const currency = requireCurrency(params.storeId, params.storeCurrency);

      const promo = await repository.findLiveByCode({
        storeId: params.storeId,
        code: params.code,
        at: params.at,
      });
      if (!promo) return { reason: 'not_found' };

      const unmet = unmetMinimum(promo, params.subtotal, currency);
      if (unmet !== undefined) {
        return { reason: 'minimum_subtotal', minSubtotal: unmet };
      }

      return toDiscount(promo, params.subtotal, currency);
    },

    /**
     * Re-price a promotion a cart already has applied.
     *
     * Returns `undefined` when the promotion should no longer discount anything — it has been
     * deactivated, deleted, has expired, has not started, or the cart has fallen below its
     * minimum. The association row is NOT the authority; this call is, on every single read.
     *
     * That is what makes a stale cart honest: a coupon that expires while a basket sits
     * untouched simply stops applying, and one that stops applying because an item was removed
     * starts applying again when the item comes back — with no write, no sweeper and no second
     * source of truth.
     */
    async evaluateApplied(params: {
      storeId: string;
      promotionId: string;
      subtotal: string;
      storeCurrency: string;
      at: Date;
    }): Promise<PromotionDiscount | undefined> {
      const currency = requireCurrency(params.storeId, params.storeCurrency);

      const promo = await repository.findLiveById({
        storeId: params.storeId,
        id: params.promotionId,
        at: params.at,
      });
      if (!promo) return undefined;
      if (unmetMinimum(promo, params.subtotal, currency) !== undefined) return undefined;

      return toDiscount(promo, params.subtotal, currency);
    },
  };
}
