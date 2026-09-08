import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';
import {
  GSTIN_LENGTH,
  GSTIN_PATTERN,
  MAX_TAX_RATE_PERCENT,
  PAN_LENGTH,
  PAN_PATTERN,
  type CustomerTaxIdentityRecord,
  type StoreTaxProfileRecord,
  type TaxClassRecord,
  type TaxRateRecord,
} from './tax.repository.js';

export type { PaginationResponse };

/**
 * The tax module's wire contracts.
 *
 * Two jobs, both security boundaries: decide exactly what a client may send, and exactly what
 * leaves the system.
 *
 * ## What is UNREACHABLE, not merely unused
 *
 * Every schema is a `strictObject`, so an unknown key is a `400` naming it rather than being
 * silently dropped. That is what makes each of the following impossible to supply:
 *
 * `storeId`, `userId` — from the resolved store and the verified token. Accepting either would
 * be a mass-assignment hole across a tenant boundary, which is §24's rule and the one this
 * module could do the most damage with: a client-supplied `storeId` on a rate write would let
 * one merchant set another's GST.
 *
 * `id`, `taxClassId`, `skuId` — internal identifiers. Everything is addressed by CODE, so no
 * database id appears in a URL or a body.
 *
 * `cgstAmount`, `sgstAmount`, `igstAmount`, `cessAmount`, `taxTotal`, `taxableValue`,
 * `grandTotal`, `supplyType`, `placeOfSupply`, `sellerGstin` — every one of these is COMPUTED
 * or RESOLVED server-side during checkout. There is no request schema anywhere in this module
 * or in orders that accepts one.
 *
 * A customer's schemas reach only their own GSTIN and legal name; nothing a customer can send
 * touches a rate, a class, a classification or the seller's identity.
 */

export const TAX_CLASS_LIST_DEFAULT_LIMIT = 20;
export const TAX_CLASS_LIST_MAX_LIMIT = 100;

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * Compare two non-negative decimal strings that have already passed a regex.
 *
 * The same helper `promotions/dto.ts` carries, restated rather than imported because
 * `no-cross-module-imports` forbids reaching into another module for it — and the reasoning is
 * identical: `Number(a) - Number(b)` is wrong at 19 significant digits, and `money()` needs a
 * `Currency` that request validation must not have to thread through.
 */
function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const pad = (value: string): string => {
    const [whole = '', fraction = ''] = value.split('.');
    return whole.padStart(15, '0') + fraction.padEnd(6, '0');
  };
  const left = pad(a);
  const right = pad(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * A classification code — a tax class code, matching `sku.code`'s accepted character set.
 *
 * Excludes whitespace and `%`, so a code always survives a URL path unencoded, which matters
 * because the admin routes address a class by its code. Trimmed and **not re-cased**: the
 * column is case-sensitive by the `codeColumn` convention, so normalising here would silently
 * merge two classifications a merchant deliberately distinguished.
 */
const codeField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    'must start with a letter or digit and contain only letters, digits, dots, underscores, slashes, or hyphens',
  );

const nameField = z.string().trim().min(1).max(300);

/**
 * A GSTIN.
 *
 * Uppercased before the pattern is applied, the same normalise-at-the-edge-and-enforce-in-the-
 * database pattern `lower(email)` and `countryCode` use — a merchant typing lower case has
 * made a formatting slip, not an error. `ck_store_gstin` and
 * `ck_customer_tax_identity_gstin` apply the identical regex in the database, because the API
 * is not the only writer.
 *
 * **Shape only. No checksum** — see `_shared.ts` for why implementing one would be engineering
 * inventing a validation rule.
 */
const gstinField = z
  .string()
  .trim()
  .toUpperCase()
  .length(GSTIN_LENGTH)
  .regex(new RegExp(GSTIN_PATTERN, 'u'), 'must be a valid GSTIN');

const panField = z
  .string()
  .trim()
  .toUpperCase()
  .length(PAN_LENGTH)
  .regex(new RegExp(PAN_PATTERN, 'u'), 'must be a valid PAN');

/**
 * A tax rate percentage.
 *
 * Zero is ACCEPTED here, unlike `promotions`' `percentField` which requires a positive value.
 * That difference is deliberate: a zero-rate class is a real configuration — it records that a
 * determination was made at nil, which an unassessed order does not — whereas a zero-percent
 * coupon discounts nothing while looking valid.
 *
 * Six decimal places, matching `NUMERIC(9,6)`. Bounds are a decimal comparison, never
 * `Number()`, and the ceiling matches `ck_tax_rate_range` so a typo is a clean `400` naming
 * the field instead of a raw SQLSTATE 23514.
 */
const rateField = z
  .string()
  .trim()
  .regex(/^\d{1,3}(?:\.\d{1,6})?$/, 'must be a percentage with at most 6 decimal places')
  .refine(
    (v) => compareDecimalStrings(v, String(MAX_TAX_RATE_PERCENT)) <= 0,
    `must be at most ${String(MAX_TAX_RATE_PERCENT)}`,
  );

/**
 * An HSN or SAC code.
 *
 * Digits only, 2 to 8 of them — the shape of the code, and deliberately NOT a specific digit
 * count: the number required depends on a turnover threshold this project was told not to
 * invent, and pinning one here would reject a legitimate code from a merchant on the other
 * side of it. There is no catalogue check, because there is no catalogue.
 */
const hsnField = z
  .string()
  .trim()
  .regex(/^\d{2,8}$/, 'must be an HSN or SAC code of 2 to 8 digits');

/**
 * An absolute instant, ISO-8601, matching `promotions`' `instantField` exactly.
 *
 * A bare local date is rejected. An effective date interpreted in `store.timezone` would mean
 * silently choosing a timezone for a value with tax consequences, which is the one place that
 * is least acceptable.
 */
const instantField = z.iso.datetime({ offset: true });

/* ── Seller tax profile ──────────────────────────────────────────────────── */

/**
 * The seller's GST identity and origin address.
 *
 * **A full replace, and every field is required together.** `ck_store_tax_profile` is
 * all-or-nothing in the database, so a PATCH that cleared one field would fail a constraint
 * the caller could not have predicted from the field they touched. Requiring the whole object
 * makes the outcome obvious from the request — and makes "configure GST" a single, auditable
 * act rather than a sequence of partial writes with an undefined state in between.
 *
 * `pan` is optional because a GSTIN already embeds the PAN; requiring it separately would
 * refuse a complete profile over a value the seller has already supplied inside another field.
 *
 * `originLine2` defaults to `''` rather than being nullable, matching `address.line2`: there is
 * no useful difference between "no second line" and "an empty second line".
 */
export const PutStoreTaxProfileRequestSchema = z.strictObject({
  legalName: nameField,
  gstin: gstinField,
  pan: panField.nullable().optional(),
  originLine1: z.string().trim().min(1).max(300),
  originLine2: z.string().trim().max(300).optional(),
  originCity: z.string().trim().min(1).max(120),
  /** The seller half of the CGST/SGST-versus-IGST comparison. Free text; see the calculator. */
  originState: z.string().trim().min(1).max(120),
  originPostalCode: z.string().trim().min(1).max(16),
  originCountryCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(2)
    .regex(/^[A-Z]{2}$/u, 'must be an ISO-3166-1 alpha-2 country code'),
});

export type PutStoreTaxProfileRequest = z.infer<typeof PutStoreTaxProfileRequestSchema>;

export type StoreTaxProfileResponse = {
  readonly configured: boolean;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly pan: string | null;
  readonly origin: {
    readonly line1: string | null;
    readonly line2: string;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly countryCode: string | null;
  };
};

/**
 * `configured` is computed rather than left for the client to infer from seven null checks.
 *
 * It is also THE predicate that decides whether checkout assesses tax, so a staff member must
 * be able to read it directly — inferring it wrongly from a partially-rendered form is exactly
 * how a merchant ends up believing GST is on when it is not.
 */
export function toStoreTaxProfileResponse(row: StoreTaxProfileRecord): StoreTaxProfileResponse {
  return {
    configured: row.gstin !== null,
    legalName: row.legalName,
    gstin: row.gstin,
    pan: row.pan,
    origin: {
      line1: row.originLine1,
      line2: row.originLine2,
      city: row.originCity,
      state: row.originState,
      postalCode: row.originPostalCode,
      countryCode: row.originCountryCode,
    },
  };
}

/* ── Tax classes ─────────────────────────────────────────────────────────── */

export const TaxClassCodeParamsSchema = z.object({ code: codeField });
export type TaxClassCodeParams = z.infer<typeof TaxClassCodeParamsSchema>;

export const CreateTaxClassRequestSchema = z.strictObject({
  code: codeField,
  name: nameField,
  isActive: z.boolean().optional(),
});
export type CreateTaxClassRequest = z.infer<typeof CreateTaxClassRequestSchema>;

/**
 * Rename or deactivate. **The code is deliberately absent.**
 *
 * Every order line that used this class carries the code as a snapshot, so renaming it would
 * leave historical invoices naming a code the admin surface no longer has. A merchant who
 * needs a different code creates a different class.
 */
export const UpdateTaxClassRequestSchema = z
  .strictObject({
    name: nameField.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of name or isActive must be supplied',
  });
export type UpdateTaxClassRequest = z.infer<typeof UpdateTaxClassRequestSchema>;

export const ListTaxClassesQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: TAX_CLASS_LIST_MAX_LIMIT,
    default: TAX_CLASS_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});
export type ListTaxClassesQuery = z.infer<typeof ListTaxClassesQuerySchema>;

export type TaxClassResponse = {
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** No `id`: the class is addressed by code everywhere, so its id is not part of the contract. */
export function toTaxClassResponse(row: TaxClassRecord): TaxClassResponse {
  return {
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTaxClassListResponse(page: {
  rows: readonly TaxClassRecord[];
  total: number;
  limit: number;
  offset: number;
}): { taxClasses: TaxClassResponse[]; pagination: PaginationResponse } {
  return {
    taxClasses: page.rows.map(toTaxClassResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

/* ── Tax rates ───────────────────────────────────────────────────────────── */

/**
 * A new effective-dated rate.
 *
 * `effectiveFrom` is REQUIRED and has no default. Defaulting it to "now" would make the most
 * consequential field on the row an accident of when the request happened to arrive, and a
 * merchant scheduling a rate change for the start of a quarter must be able to say so.
 *
 * `effectiveTo` is optional and nullable: absent or null both mean open-ended, and
 * `uq_tax_rate_class_open` guarantees at most one such window per class.
 *
 * **No relationship between the four components is validated.** The conventional arrangement
 * is that IGST equals CGST plus SGST; asserting it here would make this schema the authority
 * on a rule the finance function owns, which decision 20 forbids.
 */
export const CreateTaxRateRequestSchema = z
  .strictObject({
    cgstRate: rateField,
    sgstRate: rateField,
    igstRate: rateField,
    cessRate: rateField.optional(),
    effectiveFrom: instantField,
    effectiveTo: instantField.nullable().optional(),
  })
  .refine(
    (v) =>
      v.effectiveTo === undefined ||
      v.effectiveTo === null ||
      /*
       * Compared as instants, not as strings: both pass `z.iso.datetime({ offset: true })`,
       * but `2026-10-01T00:00:00+05:30` does not sort lexicographically against a `Z` value.
       * The same trap `promotions` documents on its own window check.
       */
      new Date(v.effectiveTo).getTime() > new Date(v.effectiveFrom).getTime(),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  );
export type CreateTaxRateRequest = z.infer<typeof CreateTaxRateRequestSchema>;

export type TaxRateResponse = {
  readonly cgstRate: string;
  readonly sgstRate: string;
  readonly igstRate: string;
  readonly cessRate: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly createdAt: string;
};

export function toTaxRateResponse(row: TaxRateRecord): TaxRateResponse {
  return {
    cgstRate: row.cgstRate,
    sgstRate: row.sgstRate,
    igstRate: row.igstRate,
    cessRate: row.cessRate,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── SKU classification ──────────────────────────────────────────────────── */

export const SkuCodeParamsSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'must be a SKU code'),
});
export type SkuCodeParams = z.infer<typeof SkuCodeParamsSchema>;

/**
 * Classify a SKU, or clear it.
 *
 * Both fields nullable together, and `.refine` requires them to agree — which is
 * `ck_sku_tax_classification` restated at the boundary so a half-classification is a clean
 * `400` naming the problem rather than a raw constraint violation.
 *
 * A separate route rather than fields on the SKU PATCH, deliberately: classification is tax
 * master data with different authority and a different reviewer from a SKU's name and price,
 * and folding it in would have widened an existing, well-tested contract for no gain.
 */
export const PutSkuTaxRequestSchema = z
  .strictObject({
    taxClassCode: codeField.nullable(),
    hsnCode: hsnField.nullable(),
  })
  .refine((v) => (v.taxClassCode === null) === (v.hsnCode === null), {
    message: 'taxClassCode and hsnCode must be supplied together, or both null to clear',
    path: ['hsnCode'],
  });
export type PutSkuTaxRequest = z.infer<typeof PutSkuTaxRequestSchema>;

export type SkuTaxResponse = {
  readonly skuCode: string;
  readonly taxClassCode: string | null;
  readonly hsnCode: string | null;
};

/* ── Customer tax identity ───────────────────────────────────────────────── */

/**
 * The customer's own GST registration.
 *
 * Two fields, and that is the whole of it — approved Phase 1B: *"Do not build a broad
 * customer-profile redesign."* No place of business, no verification state, no second
 * registration.
 *
 * A PUT rather than a POST/PATCH pair: there is at most one per customer, so replace is the
 * only meaningful write and the endpoint is naturally idempotent.
 */
export const PutCustomerTaxIdentityRequestSchema = z.strictObject({
  gstin: gstinField,
  legalName: nameField,
});
export type PutCustomerTaxIdentityRequest = z.infer<typeof PutCustomerTaxIdentityRequestSchema>;

export type CustomerTaxIdentityResponse = {
  readonly gstin: string;
  readonly legalName: string;
  readonly updatedAt: string;
};

export function toCustomerTaxIdentityResponse(
  row: CustomerTaxIdentityRecord,
): CustomerTaxIdentityResponse {
  return {
    gstin: row.gstin,
    legalName: row.legalName,
    updatedAt: row.updatedAt.toISOString(),
  };
}
