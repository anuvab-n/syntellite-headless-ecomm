import type { Database } from '../../src/db/client.js';
import { sku } from '../../src/db/schema/catalogue.js';
import { newId } from '../../src/shared/id.js';

/**
 * The price `giveSku` uses when a fixture does not name one.
 *
 * Exported so an assertion can reference it instead of repeating the literal — a test that
 * hardcoded '10.0000' would silently stop asserting anything if this default changed.
 */
export const DEFAULT_SKU_PRICE = '10.0000';

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
  return { id: values.id, code: values.code, price: values.price };
}
