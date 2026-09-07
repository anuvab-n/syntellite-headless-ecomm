import { and, asc, count, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { promotion } from '../../db/schema/promotions.js';
import { executor } from '../../db/transaction.js';

/**
 * Promotion persistence.
 *
 * The only file in this module permitted to import a table — `dependency-cruiser`'s
 * `schema-only-in-repositories` rule. Every method takes `storeId` and puts it in the
 * predicate, so tenancy is enforced here rather than trusted from the caller.
 *
 * `executor(db)` rather than `db` throughout, so a method called inside `withTransaction`
 * joins the ambient transaction and one called outside runs on the pool.
 */

/**
 * Re-exported so the DTO can name them without importing a table.
 *
 * The values live in the schema because `ck_promotion_discount_type` and
 * `ck_promotion_percent_range` are their real enforcement points, and
 * `schema-only-in-repositories` means this file is the only one in the module permitted to see
 * them. Re-exporting keeps one source of truth rather than a second copy in the DTO that could
 * silently drift from the constraint — the same discipline cart applies to
 * `MAX_CART_LINE_QUANTITY` and the catalogue to `PRODUCT_STATUSES`.
 */
export {
  MAX_PROMOTION_PERCENT,
  PROMOTION_DISCOUNT_TYPES,
  type PromotionDiscountType,
} from '../../db/schema/promotions.js';

export type PromotionsRepository = ReturnType<typeof createPromotionsRepository>;

/**
 * A promotion as this module hands it out.
 *
 * The money and rate columns are `NUMERIC`, which Drizzle returns as STRINGS — convert with
 * `fromDb()`, never `Number()`. `deleted_at` is deliberately absent: every read filters it, so
 * a caller never has to decide what a deleted promotion means.
 */
export type PromotionRecord = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly discountType: string;
  readonly percentRate: string | null;
  readonly amount: string | null;
  readonly minSubtotal: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The fields a merchant may change after creation. Everything else is derived or immutable. */
export type EditablePromotionFields = {
  code?: string;
  name?: string;
  discountType?: string;
  percentRate?: string | null;
  amount?: string | null;
  minSubtotal?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  isActive?: boolean;
};

const PROMOTION_COLUMNS = {
  id: promotion.id,
  code: promotion.code,
  name: promotion.name,
  discountType: promotion.discountType,
  percentRate: promotion.percentRate,
  amount: promotion.amount,
  minSubtotal: promotion.minSubtotal,
  startsAt: promotion.startsAt,
  endsAt: promotion.endsAt,
  isActive: promotion.isActive,
  createdAt: promotion.createdAt,
  updatedAt: promotion.updatedAt,
} as const;

export function createPromotionsRepository(deps: { db: Database }) {
  const { db } = deps;

  /** Live-in-this-store, for the ADMIN surface: not deleted. Inactive rows are still visible. */
  const adminScope = (storeId: string) =>
    and(eq(promotion.storeId, storeId), isNull(promotion.deletedAt));

  /**
   * **The authoritative "can a customer use this right now" predicate.**
   *
   * Defined ONCE and used by every customer-facing path — the code lookup on apply and the
   * re-evaluation on every cart read. Two copies is how "you cannot apply this coupon" and
   * "your coupon is still discounting your cart" end up disagreeing, which is a customer
   * seeing a discount they will not get at checkout.
   *
   * `startsAt <= at` with a NULL meaning "already running"; `at < endsAt` with a NULL meaning
   * "no end". The end is EXCLUSIVE, so a promotion ending at midnight does not apply at
   * midnight — a window is half-open, the same convention as every range in the system.
   */
  const liveScope = (storeId: string, at: Date) =>
    and(
      eq(promotion.storeId, storeId),
      isNull(promotion.deletedAt),
      eq(promotion.isActive, true),
      or(isNull(promotion.startsAt), lte(promotion.startsAt, at)),
      or(isNull(promotion.endsAt), sql`${at} < ${promotion.endsAt}`),
    );

  /**
   * Case-insensitive code match.
   *
   * `lower()` on both sides, matching `uq_promotion_code_active`. Doing it in SQL rather than
   * lowercasing the parameter in JavaScript is what lets the expression index serve the lookup
   * and keeps the stored code in whatever case the merchant chose.
   */
  const codeMatches = (code: string) => sql`lower(${promotion.code}) = lower(${code})`;

  return {
    /**
     * One live promotion by code, for a customer.
     *
     * Returns nothing for unknown, another store's, deleted, deactivated, not-yet-started and
     * expired codes alike — the caller turns all six into one indistinguishable `404`, so the
     * response never reveals that a competitor's coupon exists.
     */
    async findLiveByCode(params: {
      storeId: string;
      code: string;
      at: Date;
    }): Promise<PromotionRecord | undefined> {
      const [row] = await executor(db)
        .select(PROMOTION_COLUMNS)
        .from(promotion)
        .where(and(codeMatches(params.code), liveScope(params.storeId, params.at)))
        .limit(1);
      return row;
    },

    /**
     * One live promotion by id, for re-evaluating what a cart already has applied.
     *
     * By id rather than code because the cart stores the id: a merchant who edits a coupon's
     * code has not given the customer a different coupon.
     */
    async findLiveById(params: {
      storeId: string;
      id: string;
      at: Date;
    }): Promise<PromotionRecord | undefined> {
      const [row] = await executor(db)
        .select(PROMOTION_COLUMNS)
        .from(promotion)
        .where(and(eq(promotion.id, params.id), liveScope(params.storeId, params.at)))
        .limit(1);
      return row;
    },

    /** One promotion by code for STAFF. Inactive and out-of-window rows are included. */
    async findByCodeForAdmin(params: {
      storeId: string;
      code: string;
    }): Promise<PromotionRecord | undefined> {
      const [row] = await executor(db)
        .select(PROMOTION_COLUMNS)
        .from(promotion)
        .where(and(codeMatches(params.code), adminScope(params.storeId)))
        .limit(1);
      return row;
    },

    async insertPromotion(values: {
      id: string;
      storeId: string;
      code: string;
      name: string;
      discountType: string;
      percentRate: string | null;
      amount: string | null;
      minSubtotal: string | null;
      startsAt: Date | null;
      endsAt: Date | null;
      isActive: boolean;
    }): Promise<PromotionRecord> {
      const [row] = await executor(db)
        .insert(promotion)
        .values(values)
        .returning(PROMOTION_COLUMNS);
      if (!row) {
        // Unreachable: an INSERT ... RETURNING either returns its row or throws.
        throw new Error('promotion insert returned no row');
      }
      return row;
    },

    /**
     * Apply a partial change, scoped to the store and to live rows.
     *
     * Returns `undefined` when nothing matched, which the caller turns into the same `404` a
     * read would give. One predicate serves read, update and delete, so a promotion can never
     * be readable but not editable because two predicates drifted.
     */
    async updatePromotion(params: {
      storeId: string;
      code: string;
      changes: EditablePromotionFields;
      at: Date;
    }): Promise<PromotionRecord | undefined> {
      const [row] = await executor(db)
        .update(promotion)
        .set({ ...params.changes, updatedAt: params.at })
        .where(and(codeMatches(params.code), adminScope(params.storeId)))
        .returning(PROMOTION_COLUMNS);
      return row;
    },

    /**
     * Soft delete. Returns false when nothing matched, so a repeated delete is a `404` rather
     * than a silent success that contradicts the next read.
     *
     * The row survives, which is what keeps `cart_promotion`'s RESTRICT key satisfiable: a
     * customer holding a retired coupon keeps their cart, and the coupon simply stops applying.
     */
    async softDeletePromotion(params: {
      storeId: string;
      code: string;
      at: Date;
    }): Promise<boolean> {
      const rows = await executor(db)
        .update(promotion)
        .set({ deletedAt: params.at, updatedAt: params.at })
        .where(and(codeMatches(params.code), adminScope(params.storeId)))
        .returning({ id: promotion.id });
      return rows.length > 0;
    },

    /**
     * A page of this store's live promotions, plus the total.
     *
     * Both halves use the SAME predicate, so the page and the count cannot disagree — the §28
     * rule that a caller on the last page must not be told the total counted rows it can never
     * see. Ordered by code so the ordering is total and a page boundary is stable.
     */
    async listPromotions(params: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ items: PromotionRecord[]; total: number }> {
      const scope = adminScope(params.storeId);

      const [items, [totals]] = await Promise.all([
        executor(db)
          .select(PROMOTION_COLUMNS)
          .from(promotion)
          .where(scope)
          .orderBy(asc(promotion.code))
          .limit(params.limit)
          .offset(params.offset),
        executor(db).select({ total: count() }).from(promotion).where(scope),
      ]);

      return { items, total: totals?.total ?? 0 };
    },
  };
}
