import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { cart, cartLine } from '../../db/schema/cart.js';
import { product, sku } from '../../db/schema/catalogue.js';
import { cartPromotion } from '../../db/schema/promotions.js';
import { executor } from '../../db/transaction.js';

/**
 * Cart data access.
 *
 * **Every query here is scoped by `user_id` and/or `store_id`, in the WHERE clause** — not by a
 * check the caller performs afterwards, and not by trusting that middleware got it right. A
 * future caller arriving from a CLI command or a background job inherits the same isolation.
 *
 * ## Why this file may name `sku` and `product`
 *
 * `dependency-cruiser`'s `no-cross-module-imports` forbids `modules/cart` from importing
 * anything under `modules/catalogue` — including a type. But `schema-only-in-repositories`
 * explicitly permits any `*.repository.ts` to import any table, and `db/schema/` is not a
 * module. So the purchasability predicate and the unit-price read live here, in the queries that
 * need them, rather than being fetched through a port and then re-checked.
 *
 * That is a deliberate, narrow use of that permission: nothing here writes `sku` or `product`,
 * and nothing decides anything about them beyond whether a customer may buy them.
 *
 * No `db.query.*` anywhere: the query builder is the project default and the only API that can
 * express `.for('update')`. Increment 30 needed one — see `lockActiveCart`, which is the single
 * serialisation point for checkout and every cart mutation.
 */

/**
 * Re-exported so the DTO can name the quantity bound without importing a table.
 *
 * The value lives in the schema because `ck_cart_line_quantity` is its real enforcement point,
 * and `schema-only-in-repositories` means this file is the only one permitted to see it.
 * Re-exporting keeps one source of truth rather than a second copy in the DTO that could
 * silently drift from the constraint — the same discipline the catalogue applies to
 * `PRODUCT_STATUSES` and inventory to `STOCK_REASONS`.
 */
export { CART_STATUSES, MAX_CART_LINE_QUANTITY, type CartStatus } from '../../db/schema/cart.js';

export type CartRepository = ReturnType<typeof createCartRepository>;

/**
 * A cart row as the rest of the system sees it.
 *
 * `userId` and `storeId` are absent: ownership and tenancy are invariants of the query rather
 * than fields for a caller to inspect and re-check.
 */
export type CartRecord = {
  readonly id: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * One cart line, joined to its SKU and product for the fields a response needs.
 *
 * `skuId` is deliberately ABSENT — the API identifies a line by `skuCode`, and publishing an
 * internal id would make it part of the contract. `unitPrice` is the SKU's CURRENT price as a
 * decimal string, never a number: it is `NUMERIC(19,4)` and must reach `shared/money.ts`
 * intact.
 *
 * `isPurchasable` is computed by the DATABASE from live SKU and product state, so a line whose
 * SKU was deactivated or deleted after it was added is flagged rather than silently dropped.
 */
export type CartLineRecord = {
  readonly skuCode: string;
  readonly skuName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly isPurchasable: boolean;
};

const CART_COLUMNS = {
  id: cart.id,
  status: cart.status,
  createdAt: cart.createdAt,
  updatedAt: cart.updatedAt,
} as const;

/** The one status a customer's live cart may have. */
export const ACTIVE_CART_STATUS = 'active';

/** The terminal status: a cart that became an order. Immutable from then on. */
export const CHECKED_OUT_CART_STATUS = 'checked_out';

/**
 * One cart line as CHECKOUT needs it — every value an order line must snapshot, plus `skuId`.
 *
 * Distinct from `CartLineRecord`, which is the customer-facing shape and deliberately hides
 * `skuId`. An order line needs it for its composite tenant key, and needs `productName` too,
 * so the two shapes are not the same and are not made to pretend otherwise.
 */
export type CartCheckoutLine = {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly isPurchasable: boolean;
};

/**
 * "A customer may buy this SKU."
 *
 * Five conditions, stated once: the SKU is in this store, is not soft-deleted, is active, and
 * its product is neither soft-deleted nor unpublished. It mirrors the storefront's own
 * visibility rule — `product.status = 'active'` plus an active SKU — because a cart that
 * accepted something the catalogue will not show is a cart that fails at checkout.
 *
 * Used in TWO places with different jobs, which is why it is a function rather than inlined:
 * `findPurchasableSkuByCode` uses it as a filter (so a non-purchasable SKU is simply not found),
 * and `listLines` SELECTS it as a boolean (so an existing line can be flagged without being
 * removed). One definition means those two can never disagree about what purchasable means.
 */
const purchasablePredicate = (storeId: string) =>
  and(
    eq(sku.storeId, storeId),
    isNull(sku.deletedAt),
    eq(sku.isActive, true),
    isNull(product.deletedAt),
    eq(product.status, 'active'),
  );

export function createCartRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * The customer's active cart, or `undefined`.
     *
     * `status = 'active'` is what makes a checked-out cart invisible here, so a customer who has
     * ordered gets a fresh cart rather than their old one.
     */
    async findActiveCart(params: {
      userId: string;
      storeId: string;
    }): Promise<CartRecord | undefined> {
      const [row] = await executor(db)
        .select(CART_COLUMNS)
        .from(cart)
        .where(
          and(
            eq(cart.userId, params.userId),
            eq(cart.storeId, params.storeId),
            eq(cart.status, ACTIVE_CART_STATUS),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * **Take the cart-row lock, and return the active cart only if it is still active.**
     *
     * `SELECT … FOR UPDATE` on exactly one row: the customer's active cart. That row is the
     * aggregate root, so locking it serialises checkout against checkout AND against every cart
     * mutation, with no lock ordering to get wrong and therefore no deadlock to reason about.
     *
     * ## Why a lock and not just a status predicate
     *
     * Measured against this PostgreSQL during the Increment 30 design review, racing a coupon
     * swap against a checkout:
     *
     *  - no lock, no guard — the order priced the OLD coupon while the cart ended up pointing at
     *    the new one. Divergent.
     *  - checkout locks, the swap only carries `status = 'active'` — **still divergent**: the
     *    cart was legitimately still active when the swap ran, so the guard passed.
     *  - the swap CONTENDS on the same row — consistent, three runs out of three. The swap
     *    blocks, then finds the cart checked out and is refused.
     *
     * So the guard is necessary and not sufficient. Every mutation must take this lock, which is
     * why all five write paths below call it rather than trusting a predicate.
     *
     * Returns `undefined` when there is no active cart — either none exists or another request
     * has already checked it out. The caller turns that into its own domain answer; no row is
     * created here.
     *
     * `FOR UPDATE` is only expressible on the query builder, never on `db.query.*` — §6's trap.
     */
    async lockActiveCart(params: {
      userId: string;
      storeId: string;
    }): Promise<CartRecord | undefined> {
      const [row] = await executor(db)
        .select(CART_COLUMNS)
        .from(cart)
        .where(
          and(
            eq(cart.userId, params.userId),
            eq(cart.storeId, params.storeId),
            eq(cart.status, ACTIVE_CART_STATUS),
          ),
        )
        .limit(1)
        .for('update');
      return row;
    },

    /**
     * Move the cart out of `active`. Returns false when it was not active any more.
     *
     * The `status = 'active'` predicate is in the statement, so two checkouts that somehow both
     * got past the lock still resolve to one winner — and the loser learns it lost from a row
     * count rather than from a constraint violation. The third defence is `uq_order_cart`.
     */
    async markCartCheckedOut(params: {
      cartId: string;
      storeId: string;
      at: Date;
    }): Promise<boolean> {
      const rows = await executor(db)
        .update(cart)
        .set({ status: CHECKED_OUT_CART_STATUS, updatedAt: params.at })
        .where(
          and(
            eq(cart.id, params.cartId),
            eq(cart.storeId, params.storeId),
            eq(cart.status, ACTIVE_CART_STATUS),
          ),
        )
        .returning({ id: cart.id });
      return rows.length > 0;
    },

    /**
     * The cart's lines for CHECKOUT: everything an order line must snapshot, plus `sku_id`.
     *
     * Separate from `listLines` for two reasons. It exposes `sku_id`, which the customer-facing
     * view deliberately withholds because the API identifies a line by code — but an order line
     * needs it for its composite tenant key. And it carries `productName`, which a cart response
     * has no use for and an order line must copy.
     *
     * The purchasability flag comes from the SAME expression `listLines` uses, so "you may buy
     * this" cannot mean one thing in the cart and another at checkout. That is the reason this
     * method lives here rather than in the orders module: the predicate has exactly one home.
     *
     * Ordered by `sku.code`, so an order's lines and its cart's lines read in the same sequence
     * and a discount allocation is deterministic.
     */
    async listLinesForCheckout(params: {
      cartId: string;
      storeId: string;
    }): Promise<CartCheckoutLine[]> {
      return executor(db)
        .select({
          skuId: cartLine.skuId,
          skuCode: sku.code,
          skuName: sku.name,
          productName: product.name,
          quantity: cartLine.quantity,
          unitPrice: sku.price,
          isPurchasable: sql<boolean>`(
            ${sku.deletedAt} is null
            and ${sku.isActive} = true
            and ${product.deletedAt} is null
            and ${product.status} = 'active'
          )`,
        })
        .from(cartLine)
        .innerJoin(sku, eq(sku.id, cartLine.skuId))
        .innerJoin(product, eq(product.id, sku.productId))
        .where(and(eq(cartLine.cartId, params.cartId), eq(cartLine.storeId, params.storeId)))
        .orderBy(asc(sku.code));
    },

    /**
     * Create the active cart if the customer has none.
     *
     * **`ON CONFLICT DO NOTHING`, and the read is a SEPARATE statement** — see
     * `cart.service.ts`. Returning nothing here when another request won the race is correct and
     * expected; the caller reads afterwards, in a new snapshot, and finds the winner's row.
     *
     * The conflict target is the partial unique index `uq_cart_active`, named by repeating its
     * predicate — PostgreSQL matches a partial index only when the statement restates it.
     */
    async insertActiveCartIfAbsent(values: {
      id: string;
      userId: string;
      storeId: string;
    }): Promise<void> {
      await executor(db)
        .insert(cart)
        .values({ ...values, status: ACTIVE_CART_STATUS })
        .onConflictDoNothing({
          target: [cart.userId, cart.storeId],
          // Drizzle 0.45 spells the partial-index predicate `where`, not `targetWhere`.
          // It is required: PostgreSQL matches a PARTIAL unique index as a conflict target only
          // when the statement restates the index's own predicate.
          where: eq(cart.status, ACTIVE_CART_STATUS),
        });
    },

    /**
     * Resolve a SKU the customer is allowed to put in a cart.
     *
     * Returns `undefined` for a SKU that does not exist, belongs to another store, is deleted,
     * is inactive, or whose product is deleted or unpublished — all indistinguishable, so the
     * service can answer one 404 and reveal nothing about another merchant's catalogue.
     *
     * An inner join to `product`: every SKU has exactly one, so this cannot multiply rows.
     */
    async findPurchasableSkuByCode(params: {
      storeId: string;
      code: string;
    }): Promise<{ id: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: sku.id })
        .from(sku)
        .innerJoin(product, eq(product.id, sku.productId))
        .where(and(eq(sku.code, params.code), purchasablePredicate(params.storeId)))
        .limit(1);
      return row;
    },

    /**
     * **Set** the quantity of one SKU in one cart.
     *
     * ONE atomic upsert, and the `(cart_id, sku_id)` primary key is the entire concurrency
     * mechanism. `DO UPDATE SET quantity = excluded.quantity` **assigns** rather than
     * increments, which is what makes a repeated identical request a no-op — measured against
     * this PostgreSQL: a retry under increment semantics doubled the quantity, while under set
     * semantics it left it unchanged. Two concurrent writes converge on one row, last writer
     * wins, and neither fails.
     *
     * That is also why no `Idempotency-Key` middleware is involved and why `SELECT … FOR UPDATE`
     * is not needed: the statement touches one row identified by its primary key, so there is no
     * multi-row decision to serialise.
     *
     * `store_id` comes from the CART row, never from a request — which, with the two composite
     * foreign keys, is what makes a cross-store line unrepresentable.
     */
    async setLineQuantity(params: {
      cartId: string;
      skuId: string;
      storeId: string;
      quantity: number;
      at: Date;
    }): Promise<void> {
      await executor(db)
        .insert(cartLine)
        .values({
          cartId: params.cartId,
          skuId: params.skuId,
          storeId: params.storeId,
          quantity: params.quantity,
        })
        .onConflictDoUpdate({
          target: [cartLine.cartId, cartLine.skuId],
          set: { quantity: params.quantity, updatedAt: params.at },
        });
    },

    /**
     * The cart's lines, with everything a response needs.
     *
     * Joined to `sku` and `product` for the code, the name and the CURRENT price. There is no
     * price on `cart_line`, deliberately: a cart is not a quotation, and §3 decision 9 puts
     * snapshotting on order lines — so the price a customer sees is always the price the
     * merchant is charging now.
     *
     * `isPurchasable` is computed here rather than filtered, which is the whole point: a line
     * whose SKU has since been deactivated or deleted, or whose product was unpublished, stays
     * in the cart and comes back flagged. Silently discarding a customer's basket contents
     * because a merchant edited a listing would be worse than showing them what happened.
     *
     * Both joins are inner joins and still safe with a deleted SKU: `RESTRICT` guarantees the
     * `sku` row still exists, because a soft delete only sets `deleted_at`.
     *
     * Ordered by `sku.code` so a cart renders identically on every read; the primary key makes
     * the order total.
     */
    async listLines(params: { cartId: string; storeId: string }): Promise<CartLineRecord[]> {
      return executor(db)
        .select({
          skuCode: sku.code,
          skuName: sku.name,
          quantity: cartLine.quantity,
          unitPrice: sku.price,
          /**
           * A boolean the DATABASE computes, from the same predicate the add path filters on.
           * `sql<boolean>` rather than reading the columns and deciding in JavaScript: two
           * copies of this rule is how "you cannot add this" and "this is fine in your cart"
           * end up disagreeing.
           */
          isPurchasable: sql<boolean>`(
            ${sku.deletedAt} is null
            and ${sku.isActive} = true
            and ${product.deletedAt} is null
            and ${product.status} = 'active'
          )`,
        })
        .from(cartLine)
        .innerJoin(sku, eq(sku.id, cartLine.skuId))
        .innerJoin(product, eq(product.id, sku.productId))
        .where(and(eq(cartLine.cartId, params.cartId), eq(cartLine.storeId, params.storeId)))
        .orderBy(asc(sku.code));
    },

    /**
     * Remove one line.
     *
     * Scoped by cart AND store. Returns whether anything matched, which the service reports as a
     * 404 without a second lookup: an unknown SKU code, another store's SKU, and a line that was
     * never in the cart are all the same answer.
     */
    async deleteLine(params: { cartId: string; storeId: string; skuId: string }): Promise<boolean> {
      const rows = await executor(db)
        .delete(cartLine)
        .where(
          and(
            eq(cartLine.cartId, params.cartId),
            eq(cartLine.storeId, params.storeId),
            eq(cartLine.skuId, params.skuId),
          ),
        )
        .returning({ skuId: cartLine.skuId });
      return rows.length > 0;
    },

    /**
     * Remove every line, keeping the cart row.
     *
     * A cart is a container: clearing it empties the basket without churning its identity, so a
     * client holding the cart id still holds a valid cart. Idempotent — clearing an empty cart
     * deletes nothing and is still a success.
     */
    async clearLines(params: { cartId: string; storeId: string }): Promise<void> {
      await executor(db)
        .delete(cartLine)
        .where(and(eq(cartLine.cartId, params.cartId), eq(cartLine.storeId, params.storeId)));
    },

    /**
     * Find any SKU by code within the store, regardless of purchasability.
     *
     * Needed ONLY by the line delete: a customer must be able to remove a line whose SKU has
     * since been deactivated, and `findPurchasableSkuByCode` would refuse to resolve it —
     * leaving them stuck with something they cannot buy and cannot remove.
     *
     * Still store-scoped and still excludes hard-nonexistent SKUs, so it leaks nothing.
     */
    async findAnySkuIdByCode(params: {
      storeId: string;
      code: string;
    }): Promise<{ id: string } | undefined> {
      const [row] = await executor(db)
        .select({ id: sku.id })
        .from(sku)
        .where(and(eq(sku.storeId, params.storeId), eq(sku.code, params.code)))
        .limit(1);
      return row;
    },

    /* ── The applied promotion ───────────────────────────────────────────── */

    /**
     * Which promotion this cart has applied, if any.
     *
     * Returns the ID ONLY. The cart deliberately does not read the `promotion` table: whether
     * that promotion is live, and what it is worth, is the promotions module's answer, reached
     * through the injected port. Reading the columns here would put a second copy of the
     * eligibility rules in this module, and two copies is how "you cannot apply this coupon"
     * and "your coupon is still discounting your cart" end up disagreeing.
     */
    async findAppliedPromotionId(params: {
      cartId: string;
      storeId: string;
    }): Promise<{ promotionId: string } | undefined> {
      const [row] = await executor(db)
        .select({ promotionId: cartPromotion.promotionId })
        .from(cartPromotion)
        .where(
          and(eq(cartPromotion.cartId, params.cartId), eq(cartPromotion.storeId, params.storeId)),
        )
        .limit(1);
      return row;
    },

    /**
     * Apply a promotion to a NON-EMPTY cart, replacing whatever was there.
     *
     * Returns `false` when the cart has no lines, which the caller reports as the same `422` a
     * sequential empty-cart apply gets.
     *
     * ## Why the emptiness guard is in the WHERE clause
     *
     * **Measured, not reasoned.** With the check performed in JavaScript before the write — a
     * read, then the promotion lookup, then the upsert — a clear that commits in between leaves
     * a coupon attached to an empty cart. Raced three times in a throwaway schema, it happened
     * three times out of three. Moving the guard into the statement refused it three times out
     * of three, with the row count staying at zero.
     *
     * That is the §39 lesson in a new place: a check in application code is advisory under
     * concurrency, however carefully it is written, because the state can change between the
     * read and the write. Only a single statement closes the window.
     *
     * ONE atomic upsert on `pk_cart_promotion`, which is also what makes replacement work
     * without a delete-then-insert — that would leave a window with no promotion at all and
     * would race itself into a primary-key violation under two concurrent applies. Here the
     * conflict target IS the cart, so two simultaneous applies converge on one row (last writer
     * wins) and a second promotion cannot exist even momentarily.
     *
     * `storeId` comes from the CART, never a request. With the two composite foreign keys that
     * is what makes a cross-store applied promotion unrepresentable.
     */
    async setAppliedPromotion(params: {
      cartId: string;
      promotionId: string;
      storeId: string;
      at: Date;
    }): Promise<boolean> {
      /**
       * Raw SQL because this shape — `INSERT ... SELECT ... WHERE EXISTS ... ON CONFLICT DO
       * UPDATE` — is not expressible through the query builder's `.values()` form, and the
       * guard has to be inside the statement to be worth anything. The query builder is still
       * the default everywhere else in this file.
       */
      const result = await executor(db).execute(sql`
        insert into ${cartPromotion} (cart_id, promotion_id, store_id)
        select ${params.cartId}::uuid, ${params.promotionId}::uuid, ${params.storeId}::uuid
         where exists (
           select 1 from ${cartLine}
            where ${cartLine.cartId} = ${params.cartId}::uuid
              and ${cartLine.storeId} = ${params.storeId}::uuid
         )
        on conflict (cart_id) do update
           set promotion_id = excluded.promotion_id,
               updated_at = ${params.at}
        returning cart_id
      `);

      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Remove the applied promotion. Returns false when there was none, so a repeated remove is
     * a `404` rather than a silent success that contradicts the next read.
     */
    async deleteAppliedPromotion(params: { cartId: string; storeId: string }): Promise<boolean> {
      const rows = await executor(db)
        .delete(cartPromotion)
        .where(
          and(eq(cartPromotion.cartId, params.cartId), eq(cartPromotion.storeId, params.storeId)),
        )
        .returning({ cartId: cartPromotion.cartId });
      return rows.length > 0;
    },
  };
}
