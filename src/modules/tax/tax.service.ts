import type { Database } from '../../db/client.js';
import { uniqueViolationConstraint } from '../../db/errors.js';
import { isInTransaction, withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import {
  BusinessRuleViolation,
  Conflict,
  InvariantViolation,
  NotFound,
} from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import { isCurrency, type Currency } from '../../shared/money.js';
import {
  calculateLineTax,
  grandTotalOf,
  resolveCustomerTaxCategory,
  resolvePlaceOfSupply,
  resolveSupplyType,
  sumLineTax,
  untaxedLine,
  type CustomerTaxCategory,
  type LineTax,
  type PlaceOfSupplyBasis,
  type SupplyType,
} from './tax.calculator.js';
import {
  SKU_TAX_RESOURCE,
  TAX_AUDIT,
  TAX_CLASS_RESOURCE,
  TAX_IDENTITY_RESOURCE,
  TAX_PROFILE_RESOURCE,
  TAX_RATE_RESOURCE,
} from './tax.events.js';
import type {
  CustomerTaxIdentityRecord,
  StoreTaxProfileRecord,
  TaxClassRecord,
  TaxRateRecord,
  TaxRepository,
} from './tax.repository.js';

/**
 * The tax module.
 *
 * Two responsibilities, deliberately in one module because they are one subject: configuring
 * GST master data, and applying it to a checkout.
 *
 * ## The one rule this increment had to settle, and how
 *
 * Approved decisions 1–20 fix what tax IS. They do not say what happens to a store that has
 * not configured any of it — and every existing order, test and fixture in this repository was
 * created by exactly such a store. Refusing every checkout until a merchant configures GST
 * would be a business rule invented here; charging zero on an unclassified SKU would be
 * asserting an exemption accounting has not granted. Both are worse than the alternative.
 *
 * **So configuration IS the switch, and it is all-or-nothing:**
 *
 *  - **No seller tax profile** (`ck_store_tax_profile`'s null branch): no determination is
 *    made. `tax_total` is zero, `grand_total` equals `total`, and the order's tax snapshot is
 *    NULL — which records *"not assessed"*, not *"assessed at nil"*. Behaviour is exactly what
 *    it was before this increment.
 *  - **Seller tax profile present:** every line MUST resolve an active tax class and a rate in
 *    force at the tax instant. A line that cannot is a `422` naming the SKU codes — never a
 *    silent zero. A store that has told the system it charges GST does not get to under-charge
 *    it by omission.
 *
 * No new flag, no new column, no `store_setting` key: the profile a merchant must fill in
 * anyway is the switch. This is the one operational rule not handed down in the approval, it
 * is recorded in DECISIONS §47, and it is flagged for accounting ratification.
 */

export type TaxService = ReturnType<typeof createTaxService>;

/* ── Errors ──────────────────────────────────────────────────────────────── */

/** The class code is already taken in this store. A `409`. */
export class TaxClassAlreadyExists extends Conflict {
  override readonly code = 'TAX_CLASS_ALREADY_EXISTS';
  constructor(taxClassCode: string) {
    super('A tax class with this code already exists.', { taxClassCode });
  }
}

/**
 * The proposed rate window overlaps one already configured for this class. A `409`.
 *
 * Names the conflicting window so a merchant can see WHAT they collided with — a bare "that
 * overlaps" leaves them guessing which of several rates is in the way.
 */
export class TaxRateOverlap extends Conflict {
  override readonly code = 'TAX_RATE_OVERLAP';
  constructor(existing: { effectiveFrom: Date; effectiveTo: Date | null }) {
    super('This rate period overlaps an existing rate for the same tax class.', {
      existingEffectiveFrom: existing.effectiveFrom.toISOString(),
      existingEffectiveTo: existing.effectiveTo?.toISOString() ?? null,
    });
  }
}

/**
 * At least one line cannot be taxed, so the WHOLE checkout is refused. A `422`.
 *
 * The SKU codes are named, matching `CheckoutLinesUnavailable` exactly: a customer must be
 * told which item is the problem, and a SKU code is the merchant's own public identifier
 * rather than customer data. `reason` distinguishes the three causes so staff can act without
 * parsing prose.
 *
 * **Nothing is written.** This throws inside the checkout transaction, which rolls back
 * entirely — no order, no lines, no cart transition, no reservation.
 */
export class TaxNotDeterminable extends BusinessRuleViolation {
  override readonly code = 'TAX_NOT_DETERMINABLE';
  constructor(
    reason: 'unclassified' | 'inactive_class' | 'no_effective_rate',
    skuCodes: readonly string[],
  ) {
    super('Some items in your cart cannot be taxed yet. Please contact support.', {
      reason,
      skuCodes: [...skuCodes],
    });
  }
}

/* ── The checkout determination, as orders will consume it ───────────────── */

/** One line, as the determination needs it. Structurally what checkout already has. */
export type TaxableLine = {
  readonly skuId: string;
  readonly skuCode: string;
  readonly lineTotal: string;
  readonly discountAmount: string;
};

/** One line's resolved classification and computed tax. */
export type TaxedLine = LineTax & {
  readonly skuId: string;
  readonly hsnCode: string | null;
  readonly taxClassCode: string | null;
  readonly taxClassName: string | null;
};

/**
 * The whole determination for one order.
 *
 * `assessed: false` carries no snapshot at all — that is the unconfigured-store case, and the
 * shape makes it impossible to write half a determination onto an order by accident.
 */
export type TaxDetermination =
  | {
      readonly assessed: false;
      readonly lines: readonly TaxedLine[];
      readonly taxTotal: string;
      readonly grandTotal: string;
    }
  | {
      readonly assessed: true;
      readonly lines: readonly TaxedLine[];
      readonly taxTotal: string;
      readonly grandTotal: string;
      readonly taxAt: Date;
      readonly supplyType: SupplyType;
      readonly placeOfSupplyState: string;
      readonly placeOfSupplyBasis: PlaceOfSupplyBasis;
      readonly sellerGstin: string;
      readonly sellerLegalName: string;
      readonly originLine1: string;
      readonly originLine2: string;
      readonly originCity: string;
      readonly originState: string;
      readonly originPostalCode: string;
      readonly originCountryCode: string;
      readonly customerTaxCategory: CustomerTaxCategory;
      readonly customerGstin: string | null;
      readonly customerLegalName: string | null;
    };

/** A configured profile: every nullable field proved present, so callers stop null-checking. */
type ConfiguredProfile = {
  readonly legalName: string;
  readonly gstin: string;
  readonly originLine1: string;
  readonly originLine2: string;
  readonly originCity: string;
  readonly originState: string;
  readonly originPostalCode: string;
  readonly originCountryCode: string;
};

/**
 * Narrow a profile to its configured form, or `null`.
 *
 * `ck_store_tax_profile` already guarantees all-or-nothing in the database, so in practice one
 * test would do. Every field is checked anyway, because this function is what convinces
 * TypeScript the snapshot below cannot contain a null — asserting the constraint instead would
 * trade a compile-time guarantee for a runtime one.
 */
function asConfigured(profile: StoreTaxProfileRecord | undefined): ConfiguredProfile | null {
  if (profile === undefined) return null;
  const { legalName, gstin, originLine1, originCity, originState, originPostalCode } = profile;
  const country = profile.originCountryCode;
  if (
    legalName === null ||
    gstin === null ||
    originLine1 === null ||
    originCity === null ||
    originState === null ||
    originPostalCode === null ||
    country === null
  ) {
    return null;
  }
  return {
    legalName,
    gstin,
    originLine1,
    originLine2: profile.originLine2,
    originCity,
    originState,
    originPostalCode,
    originCountryCode: country,
  };
}

export function createTaxService(deps: {
  repository: TaxRepository;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, db, audit, logger } = deps;

  /**
   * A store configured with a currency this build does not know is an OPERATOR error, so it
   * surfaces as a 500 — the same judgement payments, orders, cart and promotions all make. It
   * is emphatically not a client's fault, and a 400 would send the customer looking for a
   * mistake they did not make.
   */
  const requireCurrency = (storeId: string, code: string): Currency => {
    if (!isCurrency(code)) {
      throw new InvariantViolation(`store ${storeId} has an unsupported currency: ${code}`);
    }
    return code;
  };

  return {
    /* ── Seller tax profile ────────────────────────────────────────────── */

    async getStoreTaxProfile(storeId: string): Promise<StoreTaxProfileRecord> {
      const row = await repository.findStoreTaxProfile(storeId);
      if (row === undefined) throw new NotFound('store');
      return row;
    },

    /**
     * Replace the store's tax profile.
     *
     * Audited, because it changes what every customer of this store is charged — the same
     * reason promotions audits staff configuration changes. The GSTIN and legal name are
     * recorded in the trail: they are the seller's own PUBLIC registration details, printed on
     * every invoice, not customer data, so §40's no-PII rule does not reach them. The origin
     * address is NOT recorded, because the trail is *"frequently shipped to a log aggregator
     * with different access controls"* and a full premises address adds nothing to the entry.
     */
    async updateStoreTaxProfile(params: {
      storeId: string;
      actor: AuditActor;
      input: {
        legalName: string | null;
        gstin: string | null;
        pan: string | null;
        originLine1: string | null;
        originLine2: string;
        originCity: string | null;
        originState: string | null;
        originPostalCode: string | null;
        originCountryCode: string | null;
      };
    }): Promise<StoreTaxProfileRecord> {
      /*
       * The write and its audit row commit TOGETHER.
       *
       * `audit.record` refuses to write outside a transaction by default, and that default is
       * the point: a profile change that switched GST on with no trail of who did it is
       * exactly the entry an auditor comes looking for. Same shape as every promotions write.
       */
      return withTransaction(db, logger, async () => {
        const row = await repository.updateStoreTaxProfile({
          storeId: params.storeId,
          ...params.input,
        });
        if (row === undefined) throw new NotFound('store');

        await audit.record({
          action: TAX_AUDIT.profileUpdated,
          actor: params.actor,
          resourceType: TAX_PROFILE_RESOURCE,
          resourceId: params.storeId,
          storeId: params.storeId,
          metadata: { gstin: row.gstin, legalName: row.legalName, configured: row.gstin !== null },
        });

        return row;
      });
    },

    /* ── Tax classes ───────────────────────────────────────────────────── */

    async createTaxClass(params: {
      storeId: string;
      actor: AuditActor;
      input: { code: string; name: string; isActive?: boolean };
    }): Promise<TaxClassRecord> {
      try {
        return await withTransaction(db, logger, async () => {
          const row = await repository.insertTaxClass({
            id: newId(),
            storeId: params.storeId,
            code: params.input.code,
            name: params.input.name,
            isActive: params.input.isActive ?? true,
          });

          await audit.record({
            action: TAX_AUDIT.classCreated,
            actor: params.actor,
            resourceType: TAX_CLASS_RESOURCE,
            resourceId: row.id,
            storeId: params.storeId,
            metadata: { code: row.code, name: row.name, isActive: row.isActive },
          });

          return row;
        });
      } catch (err) {
        if (uniqueViolationConstraint(err) === 'uq_tax_class_code') {
          throw new TaxClassAlreadyExists(params.input.code);
        }
        throw err;
      }
    },

    async getTaxClass(params: { storeId: string; code: string }): Promise<TaxClassRecord> {
      const row = await repository.findTaxClassByCode(params);
      if (row === undefined) throw new NotFound('tax class');
      return row;
    },

    async listTaxClasses(params: {
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{ rows: TaxClassRecord[]; total: number; limit: number; offset: number }> {
      const page = await repository.listTaxClasses(params);
      return { ...page, limit: params.limit, offset: params.offset };
    },

    /**
     * Rename or deactivate a class.
     *
     * The CODE is deliberately not editable. Every order line that ever used this class carries
     * the code as a snapshot, so renaming it would leave historical invoices naming a code the
     * admin surface no longer has — which is worse than the small inconvenience of creating a
     * replacement class. Promotions permits a code change for the opposite reason: nothing
     * historical records a promotion code except the order, which snapshots it too, but a
     * promotion is not an accounting classification.
     */
    async updateTaxClass(params: {
      storeId: string;
      code: string;
      actor: AuditActor;
      input: { name?: string; isActive?: boolean };
    }): Promise<TaxClassRecord> {
      return withTransaction(db, logger, async () => {
        const row = await repository.updateTaxClass({
          storeId: params.storeId,
          code: params.code,
          values: params.input,
        });
        if (row === undefined) throw new NotFound('tax class');

        await audit.record({
          action: TAX_AUDIT.classUpdated,
          actor: params.actor,
          resourceType: TAX_CLASS_RESOURCE,
          resourceId: row.id,
          storeId: params.storeId,
          metadata: { code: row.code, name: row.name, isActive: row.isActive },
        });

        return row;
      });
    },

    /* ── Tax rates ─────────────────────────────────────────────────────── */

    /**
     * Add an effective-dated rate to a class.
     *
     * ## The overlap check, and why it is safe
     *
     * The class row is LOCKED first, and the existing rates are read under that lock. Two staff
     * configuring rates for one class therefore serialise: the second sees the first's row and
     * is refused, rather than both passing an unlocked check and both writing.
     *
     * Two unique indexes back it up — `uq_tax_rate_class_from` (no two windows starting
     * together) and `uq_tax_rate_class_open` (at most one open-ended window). The lock closes
     * the remaining case, two overlapping CLOSED windows, which no index can express without
     * the `btree_gist` extension; `tax.ts` records why that was not taken.
     */
    async createTaxRate(params: {
      storeId: string;
      taxClassCode: string;
      actor: AuditActor;
      input: {
        cgstRate: string;
        sgstRate: string;
        igstRate: string;
        cessRate: string;
        effectiveFrom: Date;
        effectiveTo: Date | null;
      };
    }): Promise<TaxRateRecord> {
      return withTransaction(db, logger, async () => {
        const cls = await repository.lockTaxClassByCode({
          storeId: params.storeId,
          code: params.taxClassCode,
        });
        if (cls === undefined) throw new NotFound('tax class');

        const existing = await repository.listRatesForClass({
          storeId: params.storeId,
          taxClassId: cls.id,
        });

        const clash = existing.find((rate) => overlaps(rate, params.input));
        if (clash !== undefined) throw new TaxRateOverlap(clash);

        const row = await repository.insertTaxRate({
          id: newId(),
          storeId: params.storeId,
          taxClassId: cls.id,
          ...params.input,
        });

        await audit.record({
          action: TAX_AUDIT.rateCreated,
          actor: params.actor,
          resourceType: TAX_RATE_RESOURCE,
          resourceId: row.id,
          storeId: params.storeId,
          metadata: {
            taxClassCode: cls.code,
            cgstRate: row.cgstRate,
            sgstRate: row.sgstRate,
            igstRate: row.igstRate,
            cessRate: row.cessRate,
            effectiveFrom: row.effectiveFrom.toISOString(),
            effectiveTo: row.effectiveTo?.toISOString() ?? null,
          },
        });

        return row;
      });
    },

    async listTaxRates(params: {
      storeId: string;
      taxClassCode: string;
    }): Promise<{ taxClass: TaxClassRecord; rates: TaxRateRecord[] }> {
      const cls = await repository.findTaxClassByCode({
        storeId: params.storeId,
        code: params.taxClassCode,
      });
      if (cls === undefined) throw new NotFound('tax class');
      const rates = await repository.listRatesForClass({
        storeId: params.storeId,
        taxClassId: cls.id,
      });
      return { taxClass: cls, rates };
    },

    /* ── SKU classification ────────────────────────────────────────────── */

    /**
     * Classify a SKU, or clear its classification.
     *
     * `taxClassCode: null` clears both fields together, which is what
     * `ck_sku_tax_classification` requires — and what a merchant means when they say a SKU is
     * no longer classified. An unclassified SKU cannot be sold once the store has a GST
     * profile, so this is an operationally significant act and is audited.
     */
    async classifySku(params: {
      storeId: string;
      skuCode: string;
      actor: AuditActor;
      input: { taxClassCode: string | null; hsnCode: string | null };
    }): Promise<{ skuCode: string; taxClassCode: string | null; hsnCode: string | null }> {
      return withTransaction(db, logger, async () => {
        let taxClassId: string | null = null;
        if (params.input.taxClassCode !== null) {
          const cls = await repository.findTaxClassByCode({
            storeId: params.storeId,
            code: params.input.taxClassCode,
          });
          if (cls === undefined) throw new NotFound('tax class');
          taxClassId = cls.id;
        }

        const row = await repository.setSkuClassification({
          storeId: params.storeId,
          skuCode: params.skuCode,
          taxClassId,
          hsnCode: params.input.hsnCode,
        });
        if (row === undefined) throw new NotFound('sku');

        await audit.record({
          action: TAX_AUDIT.skuClassified,
          actor: params.actor,
          resourceType: SKU_TAX_RESOURCE,
          resourceId: row.skuCode,
          storeId: params.storeId,
          metadata: {
            skuCode: params.skuCode,
            taxClassCode: params.input.taxClassCode,
            hsnCode: params.input.hsnCode,
          },
        });

        return {
          skuCode: row.skuCode,
          taxClassCode: params.input.taxClassCode,
          hsnCode: params.input.hsnCode,
        };
      });
    },

    /* ── Customer tax identity ─────────────────────────────────────────── */

    async getCustomerTaxIdentity(params: {
      storeId: string;
      userId: string;
    }): Promise<CustomerTaxIdentityRecord | null> {
      return (await repository.findCustomerTaxIdentity(params)) ?? null;
    },

    /**
     * Set or replace the customer's own GST registration.
     *
     * NOT audited. A customer maintaining their own tax identity is neither privileged nor
     * security-relevant, and §42's reasoning for the cart applies exactly: an audit row per
     * self-service edit buries the entries that matter. The value that matters for an audit is
     * the one SNAPSHOTTED onto an order, and that is on the order row.
     */
    async putCustomerTaxIdentity(params: {
      storeId: string;
      userId: string;
      input: { gstin: string; legalName: string };
    }): Promise<CustomerTaxIdentityRecord> {
      return repository.upsertCustomerTaxIdentity({
        id: newId(),
        storeId: params.storeId,
        userId: params.userId,
        gstin: params.input.gstin,
        legalName: params.input.legalName,
      });
    },

    /** `false` when there was nothing to remove, which the route turns into a `404`. */
    async deleteCustomerTaxIdentity(params: { storeId: string; userId: string }): Promise<boolean> {
      return repository.deleteCustomerTaxIdentity(params);
    },

    /* ── The checkout determination ────────────────────────────────────── */

    /**
     * **Determine the tax for one checkout. Called from inside the checkout transaction.**
     *
     * Asserts it is in a transaction rather than trusting the caller, exactly as
     * `lockCartForCheckout` and `reserveForOrder` do: reading the seller profile, the customer
     * identity and the classifications outside the order's transaction would let any of them
     * change between the determination and the order it is written onto.
     *
     * Every input is SERVER-RESOLVED. The caller supplies an order's own already-computed line
     * money and its destination state; nothing a client sent reaches this method, and there is
     * no parameter through which a rate, an amount, a class or a supply type could be
     * supplied.
     *
     * The tax instant is the caller's `at` — the same instant the order is stamped `placed_at`
     * with — so the rate selected is the one in force when the order was placed, and no later
     * read can select a different one.
     */
    async determineForCheckout(params: {
      storeId: string;
      userId: string;
      storeCurrency: string;
      /** The order's `total`: `subtotal - discount_total`, already computed by checkout. */
      total: string;
      destinationState: string;
      lines: readonly TaxableLine[];
      at: Date;
    }): Promise<TaxDetermination> {
      if (!isInTransaction()) {
        throw new Error('determineForCheckout must be called inside a transaction');
      }
      const currency = requireCurrency(params.storeId, params.storeCurrency);

      const profile = asConfigured(await repository.findStoreTaxProfile(params.storeId));

      /* The unconfigured store: no determination, and nothing pretends otherwise. */
      if (profile === null) {
        const lines = params.lines.map((line) => ({
          ...untaxedLine({ ...line, currency }),
          skuId: line.skuId,
          hsnCode: null,
          taxClassCode: null,
          taxClassName: null,
        }));
        const taxTotal = sumLineTax(lines, currency);
        return {
          assessed: false,
          lines,
          taxTotal,
          grandTotal: grandTotalOf({ total: params.total, taxTotal, currency }),
        };
      }

      const placeOfSupply = resolvePlaceOfSupply({ destinationState: params.destinationState });
      const supplyType = resolveSupplyType({
        originState: profile.originState,
        placeOfSupply,
      });

      const identity = await repository.findCustomerTaxIdentity({
        storeId: params.storeId,
        userId: params.userId,
      });
      const customerGstin = identity?.gstin ?? null;
      const customerTaxCategory = resolveCustomerTaxCategory({ customerGstin });

      /* One statement for the whole basket; see the repository for why. */
      const classifications = await repository.listClassificationsForSkus({
        storeId: params.storeId,
        skuIds: params.lines.map((line) => line.skuId),
      });
      const byskuId = new Map(classifications.map((row) => [row.skuId, row]));

      /**
       * Refuse the WHOLE checkout on any undeterminable line, and name them all.
       *
       * Collected rather than thrown on the first, matching `CheckoutLinesUnavailable`: a
       * customer fixing one item at a time because the server only ever names one is a
       * needlessly bad experience, and staff diagnosing a mis-configured catalogue need the
       * full list.
       */
      const unclassified: string[] = [];
      const inactive: string[] = [];
      const unrated: string[] = [];
      const taxed: TaxedLine[] = [];

      for (const line of params.lines) {
        const classification = byskuId.get(line.skuId);
        if (
          classification === undefined ||
          classification.taxClassId === null ||
          classification.hsnCode === null ||
          classification.taxClassCode === null ||
          classification.taxClassName === null
        ) {
          unclassified.push(line.skuCode);
          continue;
        }
        if (classification.taxClassIsActive !== true) {
          inactive.push(line.skuCode);
          continue;
        }

        const rate = await repository.findEffectiveRate({
          storeId: params.storeId,
          taxClassId: classification.taxClassId,
          at: params.at,
        });
        if (rate === undefined) {
          unrated.push(line.skuCode);
          continue;
        }

        taxed.push({
          ...calculateLineTax({
            lineTotal: line.lineTotal,
            discountAmount: line.discountAmount,
            currency,
            supplyType,
            rates: rate,
          }),
          skuId: line.skuId,
          hsnCode: classification.hsnCode,
          taxClassCode: classification.taxClassCode,
          taxClassName: classification.taxClassName,
        });
      }

      if (unclassified.length > 0) throw new TaxNotDeterminable('unclassified', unclassified);
      if (inactive.length > 0) throw new TaxNotDeterminable('inactive_class', inactive);
      if (unrated.length > 0) throw new TaxNotDeterminable('no_effective_rate', unrated);

      const taxTotal = sumLineTax(taxed, currency);

      return {
        assessed: true,
        lines: taxed,
        taxTotal,
        grandTotal: grandTotalOf({ total: params.total, taxTotal, currency }),
        taxAt: params.at,
        supplyType,
        placeOfSupplyState: placeOfSupply.state,
        placeOfSupplyBasis: placeOfSupply.basis,
        sellerGstin: profile.gstin,
        sellerLegalName: profile.legalName,
        originLine1: profile.originLine1,
        originLine2: profile.originLine2,
        originCity: profile.originCity,
        originState: profile.originState,
        originPostalCode: profile.originPostalCode,
        originCountryCode: profile.originCountryCode,
        customerTaxCategory,
        customerGstin,
        customerLegalName: identity?.legalName ?? null,
      };
    },
  };
}

/**
 * Do two half-open windows overlap?
 *
 * `[a.from, a.to)` and `[b.from, b.to)` overlap iff `a.from < b.to AND b.from < a.to`, with a
 * NULL `to` read as "no end". Written out rather than reached for a library: the half-open
 * convention is the same one `promotion`'s live window uses, and getting the boundary wrong in
 * either direction produces either a rejected legitimate rate or two rates in force at once.
 */
function overlaps(
  a: { effectiveFrom: Date; effectiveTo: Date | null },
  b: { effectiveFrom: Date; effectiveTo: Date | null },
): boolean {
  const aEndsAfter = a.effectiveTo === null || a.effectiveTo > b.effectiveFrom;
  const bEndsAfter = b.effectiveTo === null || b.effectiveTo > a.effectiveFrom;
  return aEndsAfter && bEndsAfter;
}

export {
  SKU_TAX_RESOURCE,
  TAX_AUDIT,
  TAX_CLASS_RESOURCE,
  TAX_IDENTITY_RESOURCE,
  TAX_PROFILE_RESOURCE,
  TAX_RATE_RESOURCE,
};
