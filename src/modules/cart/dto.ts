import { z } from 'zod';

import { MAX_CART_LINE_QUANTITY } from './cart.repository.js';
import type { CartView } from './cart.service.js';

/**
 * The cart module's wire contracts.
 *
 * Same two jobs as every other DTO file here, and both are security boundaries: decide exactly
 * what a client may send, and exactly what leaves the system.
 */

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * A merchant SKU code, as the cart route accepts it in the path.
 *
 * The SAME pattern and bounds the catalogue uses, restated rather than imported because
 * `no-cross-module-imports` forbids reaching into `modules/catalogue` for it — the same narrow
 * duplication inventory made of this field and addresses made of `phoneField`. A test asserts a
 * code the catalogue accepts is a code the cart accepts, so the copy cannot drift silently.
 *
 * Trimmed and NOT lowercased, because `sku.code` is case-SENSITIVE.
 */
const skuCodeField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'must start with a letter or digit and contain only letters, digits, dots, underscores, slashes, or hyphens',
  );

/**
 * The path parameter for the item routes.
 *
 * A SKU CODE, not an id: the code is what a merchant prints and a storefront quotes, and
 * exposing an internal id would make it part of the contract. Validating it here means a
 * malformed code is a `400` from Zod rather than reaching a query at all.
 */
export const CartItemParamsSchema = z.object({ skuCode: skuCodeField });

export type CartItemParams = z.infer<typeof CartItemParamsSchema>;

/* ── PUT /users/me/cart/items/:skuCode ───────────────────────────────────── */

/**
 * The quantity to SET for this SKU.
 *
 * `z.int()` rather than `z.number()`, so `1.5` is a `400` rather than being truncated — a cart
 * holds whole units, and silently rounding a customer's intent is worse than refusing it.
 * `z.int()` also rejects a numeric string, `null`, `NaN` and `Infinity`, and its own bounds
 * refuse anything outside the safe-integer range before the `.max()` below is consulted.
 *
 * The minimum is **1**, not 0. A line with no units is a line that should not exist, and
 * `DELETE` expresses that precisely — so `PUT { quantity: 0 }` is a validation error rather than
 * a delete in disguise. Reusing PUT as a conditional delete would make one route mean two
 * things and give it two different success codes.
 *
 * The maximum matches `ck_cart_line_quantity` exactly. Bounding it HERE is what turns an absurd
 * value into a clean `400` naming the field; the CHECK is the backstop for every other writer,
 * and without the Zod bound the same request would surface as a raw SQLSTATE 23514.
 *
 * `strictObject`, so `quantity` is the ONLY accepted key. Note what is therefore unreachable
 * rather than ignored: `userId` and `storeId` (both come from the verified token, so accepting
 * either would be a mass-assignment hole across a tenant boundary), `actorUserId`, `cartId`,
 * `skuId`, `unitPrice`, `lineTotal` and every timestamp. Each produces a `400` naming the field.
 */
export const SetCartItemRequestSchema = z.strictObject({
  quantity: z
    .int('must be a whole number of units')
    .min(1, 'must be at least 1 — use DELETE to remove the line')
    .max(MAX_CART_LINE_QUANTITY, `must be at most ${String(MAX_CART_LINE_QUANTITY)}`),
});

export type SetCartItemRequest = z.infer<typeof SetCartItemRequestSchema>;

/* ── PUT /users/me/cart/promotion ────────────────────────────────────────── */

/**
 * The coupon code to apply.
 *
 * `strictObject`, so `code` is the ONLY accepted key. Note what is therefore unreachable rather
 * than ignored: `userId` and `storeId` (both come from the verified token, so accepting either
 * would be a mass-assignment hole across a tenant boundary), `cartId`, `promotionId`,
 * `actorUserId`, `discountTotal` and every timestamp. Each produces a `400` naming the field.
 *
 * The character set matches the promotions module's own code field — restated because
 * `no-cross-module-imports` forbids importing it — and a test asserts a code a merchant can
 * create is a code a customer can apply, so the copy cannot drift silently.
 *
 * Trimmed and NOT re-cased: matching is case-insensitive in the database, so `save10` reaches
 * `SAVE10` without this schema having to guess which case the merchant chose.
 */
export const ApplyCartPromotionRequestSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
      'must start with a letter or digit and contain only letters, digits, dots, underscores, slashes, or hyphens',
    ),
});

export type ApplyCartPromotionRequest = z.infer<typeof ApplyCartPromotionRequestSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * One line of the cart.
 *
 * An allowlist, built field by field, like every other response in this project. `skuId` and
 * `cartId` never appear: the API identifies a line by its SKU code, and publishing internal ids
 * would make them part of the contract.
 *
 * `unitPrice` and `lineTotal` are decimal STRINGS at the storage scale, never JSON numbers — a
 * double cannot represent `19.99`, which is the whole reason the column is `NUMERIC(19,4)`.
 * Both are computed from the SKU's CURRENT price: a cart is not a quotation.
 */
export type CartItemResponse = {
  skuCode: string;
  skuName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  /**
   * Whether this SKU can still be bought — active, not deleted, under a published product.
   *
   * Derived at read time, never stored. A line whose SKU was deactivated after it was added
   * stays in the cart and comes back `false`, because silently discarding a customer's basket
   * contents when a merchant edits a listing would be worse than telling them.
   */
  isPurchasable: boolean;
};

/**
 * The applied promotion, as a customer sees it.
 *
 * Three fields, and nothing else. No promotion `id` — the API identifies a promotion by its
 * code, and publishing the internal id would make it part of the contract. No `discountType`,
 * `percentRate`, `amount`, `minSubtotal` or window: a customer needs to know which coupon is
 * applied and what it saved them, not how the merchant configured it. `discountTotal` is the
 * same value as the cart's, repeated here so a client rendering a promotion row needs no
 * cross-reference.
 *
 * `null` on the cart when no promotion applies — including when one is associated but has
 * expired or the cart no longer meets its minimum. There is deliberately no permanent
 * `rejectionReason`: a cart that reported one forever would make every client render a stale
 * complaint, and the reason belongs in the response to the apply request that earned it.
 */
export type CartPromotionResponse = {
  code: string;
  name: string;
  discountTotal: string;
};

/**
 * The cart.
 *
 * `userId` and `storeId` never appear: ownership and tenancy are invariants of the query, not
 * fields for a client to inspect. `currency` is the STORE's — neither the cart nor a line has a
 * currency of its own, so a basket cannot mix them.
 *
 * ## `cartTotal` changed meaning in Increment 29
 *
 * It was the pre-discount sum of line totals; it is now the **payable** total, after any
 * promotion. The old value moved to `subtotal`, which is a deliberate, documented evolution
 * rather than a rename: a field called `cartTotal` naming anything other than what the customer
 * pays is the field that gets misused, and `payableTotal` alongside a `cartTotal` that means
 * something else would have preserved the ambiguity forever.
 *
 * The identity `subtotal - discountTotal = cartTotal` holds on every response and is asserted
 * arithmetically by tests, not merely by example.
 */
export type CartResponse = {
  id: string;
  status: string;
  currency: string;
  items: CartItemResponse[];
  /** The number of LINES, not the sum of quantities. */
  itemCount: number;
  /** The sum of the current line totals, BEFORE any discount. */
  subtotal: string;
  /** The promotion discount, or `0.0000` when none applies. */
  discountTotal: string;
  /** `subtotal - discountTotal`. What the customer would pay. */
  cartTotal: string;
  promotion: CartPromotionResponse | null;
  createdAt: string;
  updatedAt: string;
};

export function toCartResponse(view: CartView): CartResponse {
  return {
    id: view.cart.id,
    status: view.cart.status,
    currency: view.currency,
    items: view.items.map((item) => ({
      skuCode: item.skuCode,
      skuName: item.skuName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      isPurchasable: item.isPurchasable,
    })),
    itemCount: view.itemCount,
    subtotal: view.subtotal,
    discountTotal: view.discountTotal,
    cartTotal: view.cartTotal,
    promotion:
      view.promotion === null
        ? null
        : {
            code: view.promotion.code,
            name: view.promotion.name,
            discountTotal: view.promotion.discountTotal,
          },
    createdAt: view.cart.createdAt.toISOString(),
    updatedAt: view.cart.updatedAt.toISOString(),
  };
}
