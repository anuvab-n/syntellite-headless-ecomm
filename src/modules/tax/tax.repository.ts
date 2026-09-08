import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { sku } from '../../db/schema/catalogue.js';
import { store } from '../../db/schema/store.js';
import { customerTaxIdentity, taxClass, taxRate } from '../../db/schema/tax.js';
import { executor } from '../../db/transaction.js';

/**
 * Tax persistence: classes, effective-dated rates, seller profile, customer tax identity.
 *
 * The only file in this module permitted to import a table — `dependency-cruiser`'s
 * `schema-only-in-repositories` rule. Every method takes `storeId` and puts it in the
 * predicate, so tenancy is enforced here rather than trusted from the caller.
 *
 * `executor(db)` rather than `db` throughout, so a method called inside `withTransaction`
 * joins the ambient transaction and one called outside runs on the pool. That matters more
 * here than usual: rate resolution runs INSIDE the checkout transaction, and a read on the
 * pool would see a different snapshot from the order being written.
 *
 * ## Why this repository touches `store` and `sku`
 *
 * `store` because the seller's tax profile lives there — Increment 38 was told to make the
 * existing dead `legal_name` / `gstin` / `pan` columns usable rather than to duplicate them
 * elsewhere. `modules/stores` owns store RESOLUTION and deliberately returns a narrow row that
 * excludes exactly these columns, on the stated grounds that they *"belong to invoicing"*.
 * This is invoicing. Reading them here keeps that narrowness intact rather than widening the
 * resolver every request pays for.
 *
 * `sku` because a SKU's tax classification is tax master data on a catalogue row. The
 * alternative — a port back into the catalogue module — would put the classification write
 * path in a module that has no other reason to know what a tax class is.
 */

/**
 * Re-exported so the DTO, the calculator and the service can name them without importing a
 * table. The values live in the schema because the CHECK constraints are their real
 * enforcement point, and re-exporting keeps one source of truth rather than a second copy that
 * could silently drift — the discipline promotions applies to `PROMOTION_DISCOUNT_TYPES`.
 */
export {
  CUSTOMER_TAX_CATEGORIES,
  MAX_TAX_RATE_PERCENT,
  PLACE_OF_SUPPLY_BASES,
  SUPPLY_TYPES,
  type CustomerTaxCategory,
  type PlaceOfSupplyBasis,
  type SupplyType,
} from '../../db/schema/tax.js';
export { GSTIN_LENGTH, GSTIN_PATTERN, PAN_LENGTH, PAN_PATTERN } from '../../db/schema/_shared.js';

export type TaxRepository = ReturnType<typeof createTaxRepository>;

/* ── Records ─────────────────────────────────────────────────────────────── */

/** A tax class as this module hands it out. */
export type TaxClassRecord = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * One effective-dated rate set. Rates are `NUMERIC(9,6)`, which Drizzle returns as STRINGS —
 * convert with `fromDb()` or hand straight to `percentOf()`, never `Number()`.
 */
export type TaxRateRecord = {
  readonly id: string;
  readonly taxClassId: string;
  readonly cgstRate: string;
  readonly sgstRate: string;
  readonly igstRate: string;
  readonly cessRate: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The seller's tax profile.
 *
 * Every field nullable together, because `ck_store_tax_profile` makes them all-or-nothing —
 * a half-configured profile is unrepresentable, so a caller never has to decide what to do
 * with one. `pan` is outside that group and independently optional.
 */
export type StoreTaxProfileRecord = {
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly originLine1: string | null;
  readonly originLine2: string;
  readonly originCity: string | null;
  readonly originState: string | null;
  readonly originPostalCode: string | null;
  readonly originCountryCode: string | null;
};

/** A customer's GST registration. */
export type CustomerTaxIdentityRecord = {
  readonly gstin: string;
  readonly legalName: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** A SKU's classification, resolved for checkout. */
export type SkuTaxClassificationRecord = {
  readonly skuId: string;
  readonly skuCode: string;
  readonly hsnCode: string | null;
  readonly taxClassId: string | null;
  readonly taxClassCode: string | null;
  readonly taxClassName: string | null;
  readonly taxClassIsActive: boolean | null;
};

const TAX_CLASS_COLUMNS = {
  id: taxClass.id,
  code: taxClass.code,
  name: taxClass.name,
  isActive: taxClass.isActive,
  createdAt: taxClass.createdAt,
  updatedAt: taxClass.updatedAt,
} as const;

const TAX_RATE_COLUMNS = {
  id: taxRate.id,
  taxClassId: taxRate.taxClassId,
  cgstRate: taxRate.cgstRate,
  sgstRate: taxRate.sgstRate,
  igstRate: taxRate.igstRate,
  cessRate: taxRate.cessRate,
  effectiveFrom: taxRate.effectiveFrom,
  effectiveTo: taxRate.effectiveTo,
  createdAt: taxRate.createdAt,
  updatedAt: taxRate.updatedAt,
} as const;

const STORE_TAX_PROFILE_COLUMNS = {
  legalName: store.legalName,
  gstin: store.gstin,
  pan: store.pan,
  originLine1: store.originLine1,
  originLine2: store.originLine2,
  originCity: store.originCity,
  originState: store.originState,
  originPostalCode: store.originPostalCode,
  originCountryCode: store.originCountryCode,
} as const;

export function createTaxRepository(deps: { db: Database }) {
  const { db } = deps;

  return {
    /* ── Seller tax profile ────────────────────────────────────────────── */

    /**
     * The store's own GST identity and origin address.
     *
     * `undefined` only when the store row itself is missing, which cannot happen behind
     * `resolveStore`. A CONFIGURED-but-empty profile comes back with nulls, and the service
     * decides what that means — this layer does not interpret.
     */
    async findStoreTaxProfile(storeId: string): Promise<StoreTaxProfileRecord | undefined> {
      const [row] = await executor(db)
        .select(STORE_TAX_PROFILE_COLUMNS)
        .from(store)
        .where(eq(store.id, storeId))
        .limit(1);
      return row;
    },

    /**
     * Write the whole profile at once.
     *
     * A full replace rather than a partial merge, deliberately: `ck_store_tax_profile` is
     * all-or-nothing, so a PATCH that cleared one field would fail the constraint in a way no
     * caller could predict from the field they touched. Setting every column together makes
     * the outcome obvious from the request.
     */
    async updateStoreTaxProfile(input: {
      storeId: string;
      legalName: string | null;
      gstin: string | null;
      pan: string | null;
      originLine1: string | null;
      originLine2: string;
      originCity: string | null;
      originState: string | null;
      originPostalCode: string | null;
      originCountryCode: string | null;
    }): Promise<StoreTaxProfileRecord | undefined> {
      const [row] = await executor(db)
        .update(store)
        .set({
          legalName: input.legalName,
          gstin: input.gstin,
          pan: input.pan,
          originLine1: input.originLine1,
          originLine2: input.originLine2,
          originCity: input.originCity,
          originState: input.originState,
          originPostalCode: input.originPostalCode,
          originCountryCode: input.originCountryCode,
          updatedAt: new Date(),
        })
        .where(eq(store.id, input.storeId))
        .returning(STORE_TAX_PROFILE_COLUMNS);
      return row;
    },

    /* ── Tax classes ───────────────────────────────────────────────────── */

    async insertTaxClass(input: {
      id: string;
      storeId: string;
      code: string;
      name: string;
      isActive: boolean;
    }): Promise<TaxClassRecord> {
      const [row] = await executor(db).insert(taxClass).values(input).returning(TAX_CLASS_COLUMNS);
      if (!row) throw new Error('tax class insert returned no row');
      return row;
    },

    async findTaxClassByCode(input: {
      storeId: string;
      code: string;
    }): Promise<TaxClassRecord | undefined> {
      const [row] = await executor(db)
        .select(TAX_CLASS_COLUMNS)
        .from(taxClass)
        .where(and(eq(taxClass.storeId, input.storeId), eq(taxClass.code, input.code)))
        .limit(1);
      return row;
    },

    /**
     * The class row, LOCKED.
     *
     * **The serialisation point for rate configuration.** Two staff adding overlapping rates
     * to one class at the same time would each pass an unlocked overlap check and both write;
     * taking this lock first makes the second wait and then see the first's row. It is the
     * same shape as the cart-row lock at checkout, and for the same reason — the check must be
     * a decision, not a guess.
     *
     * Must be called inside a transaction; a row lock lives only as long as the transaction
     * that took it. The service asserts that rather than trusting a caller to remember.
     */
    async lockTaxClassByCode(input: {
      storeId: string;
      code: string;
    }): Promise<TaxClassRecord | undefined> {
      const [row] = await executor(db)
        .select(TAX_CLASS_COLUMNS)
        .from(taxClass)
        .where(and(eq(taxClass.storeId, input.storeId), eq(taxClass.code, input.code)))
        .limit(1)
        .for('update');
      return row;
    },

    async listTaxClasses(input: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ rows: TaxClassRecord[]; total: number }> {
      const scope = eq(taxClass.storeId, input.storeId);
      const rows = await executor(db)
        .select(TAX_CLASS_COLUMNS)
        .from(taxClass)
        .where(scope)
        .orderBy(asc(taxClass.code))
        .limit(input.limit)
        .offset(input.offset);
      const [counted] = await executor(db)
        .select({ total: sql<number>`count(*)::int` })
        .from(taxClass)
        .where(scope);
      return { rows, total: counted?.total ?? 0 };
    },

    async updateTaxClass(input: {
      storeId: string;
      code: string;
      values: { name?: string; isActive?: boolean };
    }): Promise<TaxClassRecord | undefined> {
      const [row] = await executor(db)
        .update(taxClass)
        .set({ ...input.values, updatedAt: new Date() })
        .where(and(eq(taxClass.storeId, input.storeId), eq(taxClass.code, input.code)))
        .returning(TAX_CLASS_COLUMNS);
      return row;
    },

    /* ── Tax rates ─────────────────────────────────────────────────────── */

    async insertTaxRate(input: {
      id: string;
      storeId: string;
      taxClassId: string;
      cgstRate: string;
      sgstRate: string;
      igstRate: string;
      cessRate: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
    }): Promise<TaxRateRecord> {
      const [row] = await executor(db).insert(taxRate).values(input).returning(TAX_RATE_COLUMNS);
      if (!row) throw new Error('tax rate insert returned no row');
      return row;
    },

    /** Every rate for one class, newest window first. The admin read and the overlap check. */
    async listRatesForClass(input: {
      storeId: string;
      taxClassId: string;
    }): Promise<TaxRateRecord[]> {
      return executor(db)
        .select(TAX_RATE_COLUMNS)
        .from(taxRate)
        .where(and(eq(taxRate.storeId, input.storeId), eq(taxRate.taxClassId, input.taxClassId)))
        .orderBy(desc(taxRate.effectiveFrom));
    },

    /**
     * **The resolution query: the rate in force for this class at this instant.**
     *
     * `effective_from <= at AND (effective_to IS NULL OR at < effective_to)` — half-open,
     * matching `promotion`'s live window and every other range in this system. A rate ending
     * at midnight does not apply at midnight.
     *
     * `at` is the ORDER's authoritative tax instant, never `now()`. That is the entire reason
     * re-reading a historical order cannot pick up a rate introduced afterwards.
     *
     * Ordered by `effective_from` descending and limited to one purely as a belt-and-braces
     * measure: `uq_tax_rate_class_from` and `uq_tax_rate_class_open` plus the service's
     * locked overlap check should make at most one row match, and if a second ever did, the
     * most recently effective one is the defensible answer rather than an arbitrary one.
     */
    async findEffectiveRate(input: {
      storeId: string;
      taxClassId: string;
      at: Date;
    }): Promise<TaxRateRecord | undefined> {
      const [row] = await executor(db)
        .select(TAX_RATE_COLUMNS)
        .from(taxRate)
        .where(
          and(
            eq(taxRate.storeId, input.storeId),
            eq(taxRate.taxClassId, input.taxClassId),
            lte(taxRate.effectiveFrom, input.at),
            or(isNull(taxRate.effectiveTo), gt(taxRate.effectiveTo, input.at)),
          ),
        )
        .orderBy(desc(taxRate.effectiveFrom))
        .limit(1);
      return row;
    },

    /* ── SKU classification ────────────────────────────────────────────── */

    /**
     * Attach (or clear) a SKU's classification.
     *
     * Both fields move together because `ck_sku_tax_classification` is all-or-nothing. The
     * predicate carries `store_id` and `deleted_at IS NULL`, so another tenant's SKU and a
     * deleted one are both simply not found — §25's rule that ownership belongs in the query
     * rather than in a comparison performed afterwards.
     */
    async setSkuClassification(input: {
      storeId: string;
      skuCode: string;
      taxClassId: string | null;
      hsnCode: string | null;
    }): Promise<{ skuCode: string } | undefined> {
      const [row] = await executor(db)
        .update(sku)
        .set({ taxClassId: input.taxClassId, hsnCode: input.hsnCode, updatedAt: new Date() })
        .where(
          and(eq(sku.storeId, input.storeId), eq(sku.code, input.skuCode), isNull(sku.deletedAt)),
        )
        .returning({ skuCode: sku.code });
      return row;
    },

    /**
     * The classifications for a set of SKUs, for checkout.
     *
     * One statement for the whole basket rather than one per line — a five-line cart would
     * otherwise be five round trips inside the checkout transaction, holding the cart lock
     * that much longer.
     *
     * Left-joined to `tax_class`, so an unclassified SKU comes back with nulls rather than
     * vanishing. Checkout must be able to tell "this SKU has no classification" apart from
     * "this SKU does not exist", and a plain join would collapse the two.
     */
    async listClassificationsForSkus(input: {
      storeId: string;
      skuIds: readonly string[];
    }): Promise<SkuTaxClassificationRecord[]> {
      if (input.skuIds.length === 0) return [];
      return executor(db)
        .select({
          skuId: sku.id,
          skuCode: sku.code,
          hsnCode: sku.hsnCode,
          taxClassId: sku.taxClassId,
          taxClassCode: taxClass.code,
          taxClassName: taxClass.name,
          taxClassIsActive: taxClass.isActive,
        })
        .from(sku)
        .leftJoin(taxClass, and(eq(taxClass.id, sku.taxClassId), eq(taxClass.storeId, sku.storeId)))
        .where(
          and(
            eq(sku.storeId, input.storeId),
            sql`${sku.id} = any(${sql.param(input.skuIds)}::uuid[])`,
          ),
        );
    },

    /* ── Customer tax identity ─────────────────────────────────────────── */

    async findCustomerTaxIdentity(input: {
      storeId: string;
      userId: string;
    }): Promise<CustomerTaxIdentityRecord | undefined> {
      const [row] = await executor(db)
        .select({
          gstin: customerTaxIdentity.gstin,
          legalName: customerTaxIdentity.legalName,
          createdAt: customerTaxIdentity.createdAt,
          updatedAt: customerTaxIdentity.updatedAt,
        })
        .from(customerTaxIdentity)
        .where(
          and(
            eq(customerTaxIdentity.storeId, input.storeId),
            eq(customerTaxIdentity.userId, input.userId),
          ),
        )
        .limit(1);
      return row;
    },

    /**
     * Create or replace the customer's registration, in one statement.
     *
     * `ON CONFLICT ... DO UPDATE` on `uq_customer_tax_identity_user` rather than a
     * read-then-write: two concurrent PUTs would both pass a pre-check and one would fail on
     * the unique index. This is idempotent by construction instead of by timing — the same
     * reasoning `stores.createIfAbsent` records.
     */
    async upsertCustomerTaxIdentity(input: {
      id: string;
      storeId: string;
      userId: string;
      gstin: string;
      legalName: string;
    }): Promise<CustomerTaxIdentityRecord> {
      const [row] = await executor(db)
        .insert(customerTaxIdentity)
        .values(input)
        .onConflictDoUpdate({
          target: customerTaxIdentity.userId,
          set: {
            gstin: input.gstin,
            legalName: input.legalName,
            updatedAt: new Date(),
          },
        })
        .returning({
          gstin: customerTaxIdentity.gstin,
          legalName: customerTaxIdentity.legalName,
          createdAt: customerTaxIdentity.createdAt,
          updatedAt: customerTaxIdentity.updatedAt,
        });
      if (!row) throw new Error('customer tax identity upsert returned no row');
      return row;
    },

    /**
     * Remove it. **A hard delete, and that is correct here.**
     *
     * There is no history to preserve: every order that used a GSTIN carries its own snapshot,
     * so deleting the live row destroys nothing an audit needs. Soft-deleting instead would
     * mean carrying a `deleted_at` on a table whose only query is "this user's row", for no
     * consumer — which is the field-with-no-reader §24 warns about.
     */
    async deleteCustomerTaxIdentity(input: { storeId: string; userId: string }): Promise<boolean> {
      const rows = await executor(db)
        .delete(customerTaxIdentity)
        .where(
          and(
            eq(customerTaxIdentity.storeId, input.storeId),
            eq(customerTaxIdentity.userId, input.userId),
          ),
        )
        .returning({ id: customerTaxIdentity.id });
      return rows.length > 0;
    },
  };
}
