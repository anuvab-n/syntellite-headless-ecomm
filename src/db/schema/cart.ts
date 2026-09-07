import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { primaryId, storeIdColumn, timestamps } from './_shared.js';
import { sku } from './catalogue.js';
import { appUser } from './identity.js';
import { store } from './store.js';

/**
 * The shopping cart.
 *
 * ## Persistent, not soft-deleted
 *
 * A cart has a STATUS rather than a `deleted_at`, and the row survives checkout. That is not a
 * stylistic choice: docs/DECISIONS.md §36 records that the operations needing idempotency
 * "also have natural keys (**one order per cart**, one payment per order)", and a cart that
 * vanished after checkout could not serve as that key. So the row stays, its status changes,
 * and the partial unique index below frees the customer to start a new one.
 *
 * ## What is deliberately absent
 *
 * **No price column and no totals.** A SKU owns its price (§24), and §3 decision 9 puts
 * snapshotting on ORDER lines — so a cart snapshot would be a second, competing snapshot with
 * no defined precedence at checkout. Unit price, line totals and the cart total are all derived
 * at read time from the current SKU, using `shared/money.ts`.
 *
 * **No currency**: `store.currency` is the currency aggregate (§6), and a per-cart copy could
 * disagree with it.
 *
 * **No `address_id`**: a cart is a basket, not a delivery instruction. Checkout will consume an
 * address and snapshot it.
 *
 * **No `expires_at`, no reservation, no `deleted_at`, no `product_id` on lines.** Abandoned-cart
 * sweeping, stock reservation and product denormalisation each belong to a later increment or to
 * nothing at all.
 */
export const CART_STATUSES = ['active', 'checked_out'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

/** The maximum units of one SKU a single cart line may hold. */
export const MAX_CART_LINE_QUANTITY = 999;

export const cart = pgTable(
  'cart',
  {
    id: primaryId(),

    /**
     * No single-column FK to `app_user`. The composite key below covers this reference AND the
     * store agreement in one constraint; a second, weaker FK to the same parent would be
     * redundant and would imply the composite one was optional.
     */
    userId: uuid('user_id').notNull(),

    /**
     * Denormalised, matching `sku`, `stock_item` and `address`: every repository predicate in
     * this codebase carries `store_id` in its own `WHERE`, and it is half of two composite
     * foreign keys.
     */
    storeId: storeIdColumn(() => store.id),

    /**
     * `active` or `checked_out`, and nothing else.
     *
     * A `varchar` with a CHECK rather than a PostgreSQL `enum`, matching `product.status`:
     * adding a value to a PG enum is a migration that cannot run inside a transaction on older
     * servers and cannot be reversed, whereas widening a CHECK is an ordinary `ALTER`.
     *
     * Checkout does NOT exist yet. The second value is here because the lifecycle it belongs to
     * is what makes "one active cart per customer" expressible at all — without it, a
     * checked-out cart would block the customer's next one forever.
     */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    ...timestamps,
  },
  (t) => [
    /**
     * Ownership AND tenancy in one constraint: the cart's user must exist, and its store must be
     * that user's store. A cross-store cart is unrepresentable rather than merely rejected by
     * application code.
     *
     * The target index `uq_app_user_id_store` already exists — Increment 27 created it for
     * `address` — so this needs no new index on `app_user`.
     *
     * `RESTRICT`, matching every other reference to `app_user`: users are soft-deleted, so a
     * hard delete that still has carts attached is a bug and must fail loudly.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_cart_user_store',
    }).onDelete('restrict'),

    /**
     * **Exactly one ACTIVE cart per customer per store.**
     *
     * Partial on `status = 'active'`, which is what makes the lifecycle work: a `checked_out`
     * cart is outside the index, so it neither blocks a new cart nor has to be deleted to get
     * out of the way. A plain unique index on `(user_id, store_id)` would allow a customer
     * exactly one cart for all time.
     *
     * This is also the concurrency arbiter for implicit creation: two simultaneous `GET`s both
     * attempt an insert and the index admits one. Verified against PostgreSQL — with the
     * insert-then-read split into two statements, two and eight concurrent callers all received
     * the same single cart id.
     */
    uniqueIndex('uq_cart_active')
      .on(t.userId, t.storeId)
      .where(sql`${t.status} = 'active'`),

    /** FK TARGET ONLY — `cart_line` references `(cart_id, store_id)`. */
    uniqueIndex('uq_cart_id_store').on(t.id, t.storeId),

    /**
     * Enforced in the database, not only in Zod.
     *
     * The API is not the only writer — a seed script or an operator running SQL during an
     * incident bypasses application validation entirely, and a status the code cannot interpret
     * is worse than a rejected write.
     */
    check('ck_cart_status', sql`${t.status} in ('active', 'checked_out')`),
  ],
);

/**
 * One SKU in one cart.
 *
 * The line references the **SKU**, never the product: the SKU is the sellable unit (§24), and a
 * product is not something a customer can buy. `product_id` is deliberately absent — it is
 * reachable through the SKU, and a redundant copy would be a second thing to keep in step with
 * no query needing it.
 */
export const cartLine = pgTable(
  'cart_line',
  {
    cartId: uuid('cart_id').notNull(),
    skuId: uuid('sku_id').notNull(),

    /** Denormalised to close both composite foreign keys below. Never written from a request. */
    storeId: uuid('store_id').notNull(),

    /**
     * Units of this SKU. `integer`, whole units only, bounded 1..999 by the CHECK below.
     *
     * The minimum is 1 rather than 0 because a line with no units is a line that should not
     * exist, and `DELETE` already expresses that precisely. A `PUT` of `0` is a validation
     * error, not a disguised delete.
     */
    quantity: integer('quantity').notNull(),

    ...timestamps,
  },
  (t) => [
    /**
     * **The pair IS the identity, and that is what makes a repeat add safe.**
     *
     * One line per SKU per cart, structurally — not a separate unique index somebody could
     * drop. It is also the entire concurrency mechanism for `PUT`: an upsert keyed on this
     * primary key means two simultaneous writes to the same SKU converge on one row rather than
     * producing two lines. Verified against PostgreSQL: eight concurrent writes left one line,
     * and a repeated identical request left the quantity unchanged.
     *
     * There is no surrogate `id`, because nothing needs to address a line by an identity of its
     * own — it is always reached by cart and SKU.
     */
    primaryKey({ columns: [t.cartId, t.skuId], name: 'pk_cart_line' }),

    /**
     * The line's cart exists, and the line's store is that cart's store.
     *
     * `ON DELETE CASCADE` is the one cascade in this schema, and it is right here: a line has no
     * meaning without its cart, there is no history to preserve (a cart is not an order), and
     * the application never hard-deletes a cart anyway — so the cascade only fires for an
     * operator or a future purge, where taking the lines along is exactly what is wanted.
     */
    foreignKey({
      columns: [t.cartId, t.storeId],
      foreignColumns: [cart.id, cart.storeId],
      name: 'fk_cart_line_cart_store',
    }).onDelete('cascade'),

    /**
     * The line's SKU exists, and the line's store is that SKU's store.
     *
     * Together with the key above, this makes **cross-store contamination unrepresentable**: a
     * cart in store A cannot hold a SKU from store B, because both keys pin the same
     * `store_id` column. Verified against PostgreSQL — a line naming a foreign store is refused
     * by the constraint, not by application code.
     *
     * `RESTRICT`, matching every other reference to `sku`. SKUs are soft-deleted, so a hard
     * delete with cart lines attached is a bug; and a customer's basket is not something to
     * discard silently on a merchant's mistake.
     *
     * The target index `uq_sku_id_store` already exists — Increment 25 created it.
     */
    foreignKey({
      columns: [t.skuId, t.storeId],
      foreignColumns: [sku.id, sku.storeId],
      name: 'fk_cart_line_sku_store',
    }).onDelete('restrict'),

    /**
     * 1..999, in the database as well as in Zod.
     *
     * The upper bound is operational hygiene rather than a merchandising rule: it keeps a
     * mistyped paste far from `integer` overflow, which would otherwise surface as SQLSTATE
     * 22003 instead of a clean 400. Zod's `.max()` is what produces the clean error; this CHECK
     * is the backstop for every other writer.
     */
    check(
      'ck_cart_line_quantity',
      sql`${t.quantity} >= 1 AND ${t.quantity} <= ${sql.raw(String(MAX_CART_LINE_QUANTITY))}`,
    ),
  ],
);
