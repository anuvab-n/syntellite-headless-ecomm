import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import {
  MAX_PROMOTION_PERCENT,
  PROMOTION_DISCOUNT_TYPES,
  type PromotionRecord,
} from './promotions.repository.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

/**
 * The promotions module's wire contracts.
 *
 * Two jobs, both security boundaries: decide exactly what a client may send, and exactly what
 * leaves the system.
 *
 * Every schema is a `strictObject`, so an unknown key is a `400` naming it rather than being
 * silently ignored. That is what makes `id`, `storeId`, `createdAt`, `updatedAt`, `deletedAt`
 * and any audit actor field unreachable rather than merely unused.
 */

/** Page size for the admin listing. Operational hygiene, not a merchandising rule. */
export const PROMOTION_LIST_DEFAULT_LIMIT = 20;
export const PROMOTION_LIST_MAX_LIMIT = 100;

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * A coupon code.
 *
 * Trimmed, and **not re-cased**: the merchant's chosen presentation is stored verbatim, while
 * matching is case-insensitive in the database via `lower(code)`. Uppercasing here would take
 * that choice away for no gain, and lowercasing would make every coupon in the admin list look
 * wrong.
 *
 * The character set is the same one `sku.code` accepts, restated rather than imported because
 * `no-cross-module-imports` forbids reaching into `modules/catalogue` for it. It excludes
 * whitespace and `%`, so a code always survives a URL path unencoded — which matters because
 * the admin routes address a promotion by its code.
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
 * Compare two non-negative decimal strings that have already passed a regex.
 *
 * Not `Number(a) - Number(b)`, the same judgement §33 records for `comparePriceStrings`: the
 * amount pattern admits 15 integer digits and 4 decimals — 19 significant digits, past what an
 * IEEE-754 double can distinguish — so `999999999999999.9999` and `999999999999999.9998` would
 * compare equal and a bound check at that magnitude would silently pass.
 *
 * Not `money()` either: that needs a `Currency`, which would mean threading the store's
 * currency into request validation, and it raises an `InvariantViolation` — a 500 — for a
 * currency this build does not know. Validation must not be able to fail that way.
 *
 * Zero-padding both sides to a fixed layout makes them equal-length digit strings, and
 * lexicographic order is then numeric order. Exact, and no dependency.
 */
function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const pad = (value: string): string => {
    const [whole = '', fraction = ''] = value.split('.');
    return whole.padStart(15, '0') + fraction.padEnd(6, '0');
  };

  const left = pad(a);
  const right = pad(b);

  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * A percentage, as a decimal STRING.
 *
 * Not `z.number()`, for the reason `priceField` is not either: a JSON number is an IEEE-754
 * double, so `12.5` survives but `33.333333` does not, and the error would compound into the
 * discount. At most 6 decimal places, matching `NUMERIC(9,6)`.
 *
 * Bounds are checked as a decimal comparison, never by `Number()`. The upper bound matches
 * `ck_promotion_percent_range`: stating it here is what turns 150% into a clean `400` naming
 * the field instead of a raw SQLSTATE 23514.
 */
const percentField = z
  .string()
  .trim()
  .regex(/^\d{1,3}(?:\.\d{1,6})?$/, 'must be a percentage with at most 6 decimal places')
  .refine((v) => compareDecimalStrings(v, '0') > 0, 'must be greater than 0')
  .refine(
    (v) => compareDecimalStrings(v, String(MAX_PROMOTION_PERCENT)) <= 0,
    `must be at most ${String(MAX_PROMOTION_PERCENT)}`,
  );

/**
 * A monetary amount, as a decimal STRING at most 4 decimal places — the same primitive shape
 * `priceField` uses in the catalogue, and for the same reason.
 */
const amountField = z
  .string()
  .trim()
  .regex(/^\d{1,15}(?:\.\d{1,4})?$/, 'must be a decimal amount with at most 4 decimal places');

/** A positive amount: a zero discount discounts nothing while looking valid. */
const positiveAmountField = amountField.refine(
  (v) => compareDecimalStrings(v, '0') > 0,
  'must be greater than 0',
);

/**
 * An absolute instant, ISO-8601.
 *
 * `z.iso.datetime({ offset: true })` so `2026-10-01T00:00:00+05:30` is accepted as well as a
 * `Z` timestamp. A bare local date (`2026-10-01`) is rejected: this build takes instants, and
 * interpreting a date in `store.timezone` is a decision deliberately not made here — accepting
 * one would mean silently choosing a timezone.
 */
const instantField = z.iso.datetime({ offset: true });

const discountTypeField = z.enum(PROMOTION_DISCOUNT_TYPES);

/* ── Path and query ──────────────────────────────────────────────────────── */

/**
 * The admin path parameter: a promotion's CODE, not its id.
 *
 * The code is what a merchant knows and prints; exposing an internal id would make it part of
 * the contract. Matching is case-insensitive, so `/admin/promotions/save10` reaches `SAVE10`.
 */
export const PromotionCodeParamsSchema = z.object({ code: codeField });

export type PromotionCodeParams = z.infer<typeof PromotionCodeParamsSchema>;

export const ListPromotionsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: PROMOTION_LIST_MAX_LIMIT,
    default: PROMOTION_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type ListPromotionsQuery = z.infer<typeof ListPromotionsQuerySchema>;

/* ── POST /admin/promotions ──────────────────────────────────────────────── */

/**
 * The shape rule, restated in Zod so a merchant gets a `400` naming the field rather than the
 * `500` a raw `ck_promotion_shape` violation would produce.
 *
 * The CHECK constraint remains the guarantee — it binds a seed script and an operator running
 * SQL, neither of which passes through Zod. This is the same division of labour as the cart's
 * quantity bounds: the schema is for the message, the constraint is for the truth.
 */
const requireMatchingShape = <
  T extends {
    discountType: 'percentage' | 'fixed_amount';
    percentRate?: string | undefined;
    amount?: string | undefined;
  },
>(
  schema: z.ZodType<T>,
) =>
  schema
    .refine((v) => v.discountType !== 'percentage' || v.percentRate !== undefined, {
      message: 'percentRate is required when discountType is "percentage"',
      path: ['percentRate'],
    })
    .refine((v) => v.discountType !== 'percentage' || v.amount === undefined, {
      message: 'amount must be absent when discountType is "percentage"',
      path: ['amount'],
    })
    .refine((v) => v.discountType !== 'fixed_amount' || v.amount !== undefined, {
      message: 'amount is required when discountType is "fixed_amount"',
      path: ['amount'],
    })
    .refine((v) => v.discountType !== 'fixed_amount' || v.percentRate === undefined, {
      message: 'percentRate must be absent when discountType is "fixed_amount"',
      path: ['percentRate'],
    });

const CreatePromotionBase = z.strictObject({
  code: codeField,
  name: nameField,
  discountType: discountTypeField,
  percentRate: percentField.optional(),
  amount: positiveAmountField.optional(),
  /** Absent means no minimum. `0` is accepted and means the same thing, explicitly. */
  minSubtotal: amountField.optional(),
  startsAt: instantField.optional(),
  endsAt: instantField.optional(),
  isActive: z.boolean().optional(),
});

export const CreatePromotionRequestSchema = requireMatchingShape(CreatePromotionBase).refine(
  (v) =>
    v.startsAt === undefined ||
    v.endsAt === undefined ||
    /**
     * Compared as INSTANTS, not as strings. Both have passed
     * `z.iso.datetime({ offset: true })`, but `2026-10-01T00:00:00+05:30` does not sort
     * lexically against `2026-09-30T20:00:00Z` even though it is the later moment — a string
     * comparison would reject a perfectly ordered window written in two notations.
     */
    new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(),
  { message: 'endsAt must be after startsAt', path: ['endsAt'] },
);

export type CreatePromotionRequest = z.infer<typeof CreatePromotionRequestSchema>;

/* ── PATCH /admin/promotions/:code ───────────────────────────────────────── */

/**
 * A partial update.
 *
 * `null` is accepted for the three nullable fields and means "clear it" — `minSubtotal: null`
 * removes the minimum, `endsAt: null` makes the promotion open-ended. Absent means "leave it
 * alone". Those are genuinely different intentions and a PATCH must be able to express both,
 * which is why they are not merged into `.optional()`.
 *
 * `discountType` may change. When it does the service rewrites both value columns as a pair,
 * so the row moves from one valid shape to another in a single statement.
 */
const UpdatePromotionBase = z.strictObject({
  code: codeField.optional(),
  name: nameField.optional(),
  discountType: discountTypeField.optional(),
  percentRate: percentField.optional(),
  amount: positiveAmountField.optional(),
  minSubtotal: amountField.nullable().optional(),
  startsAt: instantField.nullable().optional(),
  endsAt: instantField.nullable().optional(),
  isActive: z.boolean().optional(),
});

export const UpdatePromotionRequestSchema = UpdatePromotionBase.refine(
  (v) => Object.keys(v).length > 0,
  'at least one field must be supplied',
)
  .refine((v) => v.discountType !== 'percentage' || v.amount === undefined, {
    message: 'amount must be absent when discountType is "percentage"',
    path: ['amount'],
  })
  .refine((v) => v.discountType !== 'fixed_amount' || v.percentRate === undefined, {
    message: 'percentRate must be absent when discountType is "fixed_amount"',
    path: ['percentRate'],
  })
  /**
   * A rate or an amount on its own is only meaningful if it matches the promotion's CURRENT
   * type, which this schema cannot see. Sending one without a `discountType` is therefore
   * allowed here and validated by the service against the stored row — the alternative would
   * be forcing every price edit to restate the type.
   */
  .refine(
    (v) =>
      v.startsAt === undefined ||
      v.endsAt === undefined ||
      v.startsAt === null ||
      v.endsAt === null ||
      new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  );

export type UpdatePromotionRequest = z.infer<typeof UpdatePromotionRequestSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The staff-facing shape of a promotion.
 *
 * An allowlist, built field by field. `storeId` and `deletedAt` never appear: tenancy is an
 * invariant of the query rather than a field to inspect, and every promotion in a response is
 * live by construction. `id` DOES appear here — a staff member is entitled to the identifier of
 * a row they administer — and never on the customer surface.
 *
 * `percentRate` and `amount` are decimal STRINGS, never JSON numbers, for the same reason
 * prices are.
 */
export type PromotionResponse = {
  id: string;
  code: string;
  name: string;
  discountType: string;
  percentRate: string | null;
  amount: string | null;
  minSubtotal: string | null;
  startsAt: string | null;
  endsAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toPromotionResponse(row: PromotionRecord): PromotionResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    discountType: row.discountType,
    percentRate: row.percentRate,
    amount: row.amount,
    minSubtotal: row.minSubtotal,
    startsAt: row.startsAt === null ? null : row.startsAt.toISOString(),
    endsAt: row.endsAt === null ? null : row.endsAt.toISOString(),
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPromotionListResponse(page: {
  items: readonly PromotionRecord[];
  total: number;
  limit: number;
  offset: number;
}): { promotions: PromotionResponse[]; pagination: PaginationResponse } {
  return {
    promotions: page.items.map(toPromotionResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}
