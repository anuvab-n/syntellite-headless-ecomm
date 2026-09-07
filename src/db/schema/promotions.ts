import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import {
  codeColumn,
  moneyColumn,
  primaryId,
  rateColumn,
  softDelete,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';
import { cart } from './cart.js';
import { store } from './store.js';

/**
 * Promotions — coupon-code discounts applied to a cart.
 *
 * Two tables, and the split matters: `promotion` is the merchant's CONFIGURATION, and
 * `cart_promotion` is one customer's DECLARATION OF INTENT to use it. Neither stores money.
 *
 * ## What is deliberately absent
 *
 * No usage counters, no redemption table, no per-customer limits. Applying a coupon does not
 * consume it — consumption is an order-time act, and there are no orders. A counter that
 * incremented here would be decremented by nothing when a cart was abandoned, which is worse
 * than not counting.
 *
 * No priority, no combinability matrix, no "best discount" flag. A cart holds at most one
 * promotion, and `cart_promotion`'s primary key is what makes that structural rather than
 * hoped for.
 *
 * No targeting table. These promotions apply to the cart subtotal, not to particular SKUs,
 * products or categories — the last of which does not exist as a table at all.
 *
 * No `sale_price` or `discount_price` column anywhere. A promotion is an adjustment layered
 * over the SKU's current price at read time; the price columns are untouched.
 */

/** The discount shapes this build evaluates. Mirrored by `ck_promotion_discount_type`. */
export const PROMOTION_DISCOUNT_TYPES = ['percentage', 'fixed_amount'] as const;

export type PromotionDiscountType = (typeof PROMOTION_DISCOUNT_TYPES)[number];

/** The largest percentage a promotion may take. 100% is free; more would pay the customer. */
export const MAX_PROMOTION_PERCENT = 100;

export const promotion = pgTable(
  'promotion',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * The coupon code, stored in the form the merchant supplied (trimmed, never re-cased).
     *
     * Matching is case-INSENSITIVE, which is an explicit exception to `codeColumn`'s
     * case-sensitive default: a SKU code is a machine identifier, but a coupon is read off a
     * banner by a person, and refusing `save10` because the poster said `SAVE10` is a support
     * ticket rather than a security boundary. The mechanism is `lower(code)` in the unique
     * index below and in the lookup predicate — in the DATABASE, so a bulk import that forgets
     * to normalise cannot create a second `Save10`.
     */
    code: codeColumn('code').notNull(),

    /** Merchant-facing label. Shown to the customer alongside the code they applied. */
    name: varchar('name', { length: 300 }).notNull(),

    discountType: varchar('discount_type', { length: 20 }).notNull(),

    /**
     * The percentage, when `discount_type = 'percentage'`. NULL otherwise.
     *
     * `rateColumn` — `NUMERIC(9,6)` — is the type `_shared.ts` already designates for "a tax
     * percentage, a discount fraction". Six decimal places is far more than a merchant will
     * type and enough that a third of a percent is exact.
     */
    percentRate: rateColumn('percent_rate'),

    /**
     * The fixed discount, when `discount_type = 'fixed_amount'`. NULL otherwise.
     *
     * `NUMERIC(19,4)`, the same type and scale as every price in the system, so a discount and
     * a subtotal are directly comparable with no conversion.
     */
    amount: moneyColumn('amount'),

    /**
     * The smallest cart subtotal that qualifies. NULL means no minimum.
     *
     * Compared against the subtotal BEFORE any discount — using the discounted total would be
     * circular, since the discount is what is being decided. Equality qualifies.
     */
    minSubtotal: moneyColumn('min_subtotal'),

    /**
     * The live window. Either end may be NULL: no start means already running, no end means
     * running until deactivated.
     *
     * `timestamptz`, so an instant is unambiguous. This build's API takes absolute instants;
     * interpreting a merchant's "ends 30 September" in `store.timezone` is a separate decision
     * and is deliberately not made here.
     */
    startsAt: tsColumn('starts_at'),
    endsAt: tsColumn('ends_at'),

    /**
     * The merchant's on/off switch, independent of the window.
     *
     * Both exist because they answer different questions: `is_active = false` is "stop this
     * now", while the window is "run between these instants". Collapsing them would mean
     * pausing a scheduled sale destroyed its dates.
     */
    isActive: boolean('is_active').notNull().default(true),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * One live coupon per code per store, case-insensitively.
     *
     * Partial on `deleted_at IS NULL` so a retired `DIWALI24` does not block next year's, and
     * `lower(code)` so `SAVE10` and `save10` cannot be two different promotions — which would
     * make the customer-facing lookup ambiguous and force it to pick one arbitrarily.
     *
     * Scoped to the store: a unique index on `code` alone would let one merchant's coupon block
     * another's.
     */
    uniqueIndex('uq_promotion_code_active')
      .on(t.storeId, sql`lower(${t.code})`)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * FK-target index, created BEFORE the composite key in `cart_promotion` that references it.
     *
     * Adds no guarantee of its own — `id` is already the primary key — and exists solely
     * because PostgreSQL requires a unique constraint on exactly the referenced columns.
     */
    uniqueIndex('uq_promotion_id_store').on(t.id, t.storeId),

    /** Admin listing. The only non-constraint index here; no speculative ones. */
    index('ix_promotion_store_active')
      .on(t.storeId, t.isActive)
      .where(sql`${t.deletedAt} IS NULL`),

    check('ck_promotion_discount_type', sql`${t.discountType} in ('percentage', 'fixed_amount')`),

    /**
     * The discriminated union, enforced by the DATABASE.
     *
     * Exactly one of `percent_rate` / `amount` is present, and it is the one the type names. A
     * row carrying both would leave the evaluator choosing, and a row carrying neither would
     * be a coupon that discounts nothing while looking valid. Zod cannot protect a seed script
     * or an operator running SQL; this can.
     */
    check(
      'ck_promotion_shape',
      sql`(
        ${t.discountType} = 'percentage'
          AND ${t.percentRate} IS NOT NULL
          AND ${t.amount} IS NULL
      ) OR (
        ${t.discountType} = 'fixed_amount'
          AND ${t.amount} IS NOT NULL
          AND ${t.percentRate} IS NULL
      )`,
    ),

    /** 0% discounts nothing; over 100% would pay the customer to shop. */
    check(
      'ck_promotion_percent_range',
      sql`${t.percentRate} IS NULL OR (${t.percentRate} > 0 AND ${t.percentRate} <= ${sql.raw(
        String(MAX_PROMOTION_PERCENT),
      )})`,
    ),

    check('ck_promotion_amount_positive', sql`${t.amount} IS NULL OR ${t.amount} > 0`),

    check('ck_promotion_min_subtotal', sql`${t.minSubtotal} IS NULL OR ${t.minSubtotal} >= 0`),

    /**
     * A window that closes before it opens is a promotion that can never apply, and nothing
     * would ever report it — the coupon would simply always 404.
     */
    check(
      'ck_promotion_window',
      sql`${t.startsAt} IS NULL OR ${t.endsAt} IS NULL OR ${t.endsAt} > ${t.startsAt}`,
    ),
  ],
);

/**
 * The promotion a cart currently has applied.
 *
 * A DECLARATION OF INTENT, not a stored discount. There is no amount here: the discount is
 * recomputed on every read from the cart's current subtotal and the promotion's current
 * configuration, exactly as Increment 28 recomputes `lineTotal` from the SKU's current price.
 * Storing the discount would be a price snapshot on a cart, which §41 refused.
 *
 * A consequence worth stating: a row here does NOT mean a discount applies. If the promotion
 * has expired, been deactivated or deleted, or the cart has fallen below the minimum subtotal,
 * the row survives and the discount is simply not applied. That is what lets a customer who
 * removed an item and then put it back get their coupon working again without re-typing it.
 *
 * No `id` column. Its identity IS the cart, the same judgement `stock_item` makes about
 * `sku_id` and `cart_line` about `(cart_id, sku_id)`.
 */
export const cartPromotion = pgTable(
  'cart_promotion',
  {
    cartId: uuid('cart_id').notNull(),
    promotionId: uuid('promotion_id').notNull(),
    storeId: uuid('store_id').notNull(),
    ...timestamps,
  },
  (t) => [
    /**
     * **One promotion per cart, structurally.**
     *
     * This is where "no stacking" lives. Not a service check, not a route guard — a primary
     * key, so a second promotion cannot exist even if written by a seed script. It is also the
     * conflict target for the apply upsert, which is what makes replacement atomic and makes
     * two concurrent applies converge on one row.
     *
     * Relaxing this to `(cart_id, promotion_id)` is the one-line change that would permit
     * stacking, and it would then need every rule this increment deliberately does not have.
     */
    primaryKey({ columns: [t.cartId], name: 'pk_cart_promotion' }),

    /**
     * CASCADE: an applied promotion has no meaning without its cart, and a cart is not an
     * order, so there is no history to preserve. Matches `cart_line`.
     */
    foreignKey({
      columns: [t.cartId, t.storeId],
      foreignColumns: [cart.id, cart.storeId],
      name: 'fk_cart_promotion_cart_store',
    }).onDelete('cascade'),

    /**
     * RESTRICT, and together with the key above this makes cross-store contamination
     * UNREPRESENTABLE: both keys pin the same `store_id` column, so a cart in store A cannot
     * hold a coupon from store B. Naming our store fails the promotion key; naming theirs
     * fails the cart key.
     *
     * Restrict rather than cascade because hard-deleting a promotion out from under a
     * customer's cart is the mistake `cart_line` already refuses for SKUs. Merchants retire a
     * coupon by soft-deleting it, which this key does not obstruct.
     */
    foreignKey({
      columns: [t.promotionId, t.storeId],
      foreignColumns: [promotion.id, promotion.storeId],
      name: 'fk_cart_promotion_promotion_store',
    }).onDelete('restrict'),
  ],
);
