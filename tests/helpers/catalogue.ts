import type { Database } from '../../src/db/client.js';
import { sku } from '../../src/db/schema/catalogue.js';
import { stockItem } from '../../src/db/schema/inventory.js';
import { newId } from '../../src/shared/id.js';

/**
 * The price `giveSku` uses when a fixture does not name one.
 *
 * Exported so an assertion can reference it instead of repeating the literal — a test that
 * hardcoded '10.0000' would silently stop asserting anything if this default changed.
 */
export const DEFAULT_SKU_PRICE = '10.0000';

/**
 * Units `giveSku` stocks when a fixture does not name a quantity.
 *
 * Above `MAX_ORDER_LINE_QUANTITY` (999) on purpose, so no suite can accidentally exhaust it and
 * every stock-dependent assertion in a stock-agnostic test is trivially satisfied.
 */
export const DEFAULT_SKU_ON_HAND = 1_000;

/**
 * Give a product one SKU, mirroring the Increment 24 backfill.
 *
 * Shared across the catalogue suites because the SKU is now what makes a product SELLABLE:
 * price moved off `product`, and public visibility requires at least one active SKU. Every
 * `givenProduct` fixture therefore needs one, and eleven local copies of the same three lines
 * would be eleven places for the default price or the active flag to drift.
 *
 * The `code` defaults to the product slug — the same derivation the migration used, so a
 * fixture and a backfilled row look alike and a test written against one holds for the other.
 *
 * `deletedAt` is copied from the product by default, because that is the invariant the
 * deletion cascade maintains: a deleted product must not leave a SKU that still looks
 * sellable. A test that wants the broken state deliberately can pass `deletedAt: null`.
 */
export async function giveSku(
  db: Database,
  product: { id: string; storeId: string; slug: string; deletedAt?: Date | null },
  overrides: {
    code?: string;
    name?: string;
    price?: string;
    isActive?: boolean;
    deletedAt?: Date | null;
    /**
     * Units on hand. **Opt-in**: omit it and NO `stock_item` row is created, which is the state
     * of a SKU that has never been adjusted.
     *
     * Opt-in rather than defaulted, because the inventory suite owns the projection's lifecycle
     * and inserts its own rows — a default here collided with `stock_item_pkey` and broke 64 of
     * its tests. Suites that CHECK OUT pass a quantity, because checkout now reserves; every
     * other suite is unaffected, exactly as before.
     */
    onHand?: number;
  } = {},
): Promise<{ id: string; code: string; price: string }> {
  const values = {
    id: newId(),
    storeId: product.storeId,
    productId: product.id,
    code: overrides.code ?? product.slug,
    name: overrides.name ?? '',
    price: overrides.price ?? DEFAULT_SKU_PRICE,
    isActive: overrides.isActive ?? true,
    deletedAt:
      overrides.deletedAt === null ? null : (overrides.deletedAt ?? product.deletedAt ?? null),
  };

  await db.insert(sku).values(values);

  /**
   * Stock, only when asked for, because checkout now RESERVES it.
   *
   * Before reservations a SKU needed no `stock_item` row to be bought. Now an unstocked SKU
   * cannot be checked out at all, so the suites that place orders name a quantity here — and
   * the ones that do not (catalogue, cart, inventory) keep their previous fixture exactly,
   * which matters because the inventory suite is ABOUT this row's lifecycle and creates its own.
   *
   * `onConflictDoNothing` so a fixture that stocks a SKU the inventory service later
   * initialises is still idempotent.
   */
  if (overrides.onHand !== undefined) {
    await db
      .insert(stockItem)
      .values({
        skuId: values.id,
        storeId: product.storeId,
        onHand: overrides.onHand,
        reserved: 0,
      })
      .onConflictDoNothing({ target: stockItem.skuId });
  }

  return { id: values.id, code: values.code, price: values.price };
}
