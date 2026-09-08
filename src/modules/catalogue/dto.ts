import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import { STORAGE_SCALE } from '../../shared/money.js';
import {
  PRODUCT_STATUSES,
  type OptionRecord,
  type OptionValueRecord,
  type ProductRecord,
  type SkuOptionRecord,
  type SkuRecord,
} from './catalogue.repository.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

/**
 * The catalogue module's wire contracts.
 *
 * Same two jobs as the identity DTOs, and both are security boundaries: decide exactly what
 * a client may send, and exactly what leaves the system.
 */

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * A URL slug.
 *
 * Lowercased and trimmed BEFORE the pattern check, so `" Blue-Shirt "` becomes `blue-shirt`
 * rather than being rejected for a capital letter the caller plainly did not mean as a
 * distinct product. The stored value then matches the unique index exactly.
 *
 * The pattern forbids leading, trailing, and doubled hyphens. Those produce URLs that look
 * broken and, worse, let two visually indistinguishable slugs coexist.
 */
const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(255)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be lowercase letters, digits, and single hyphens between them',
  );

/**
 * A decimal price, as a STRING.
 *
 * Not `z.number()`, and this is the same reason `money()` refuses a number: JSON numbers are
 * IEEE-754 doubles, so `19.99` is already `19.989999...` by the time Zod sees it, and the
 * error compounds through every later sum. A string survives the wire intact.
 *
 * At most 4 decimal places, matching `NUMERIC(19,4)`. Rejecting extra precision is better
 * than silently rounding it away — a merchant who typed one digit too many should be told,
 * not quietly overruled.
 */
const priceField = z
  .string()
  .trim()
  .regex(/^\d{1,15}(?:\.\d{1,4})?$/, 'must be a decimal amount with at most 4 decimal places');

/**
 * Product name and description.
 *
 * Named primitives rather than inline schemas, so create and update cannot drift apart. A
 * PATCH that accepted a 400-character name the create endpoint rejects would let a product
 * reach a state it could never have been created in.
 */
const nameField = z.string().trim().min(1).max(300);
const descriptionField = z.string().trim().max(10_000);

/* ── POST /admin/products ────────────────────────────────────────────────── */

/**
 * `strictObject`, so an unknown field is a 400 rather than being silently dropped.
 *
 * Note what is absent and therefore unreachable: `storeId`, `id`, `deletedAt`, and every
 * timestamp. The store comes from `resolveStore`, the id from `newId()`. A client sending
 * `storeId` gets a validation error naming the field — which is the correct response to what
 * is either a probe for a tenancy hole or a badly confused integration, and is strictly
 * better than accepting and ignoring it.
 */
export const CreateProductRequestSchema = z.strictObject({
  slug: slugField,
  name: nameField,
  /** Optional. Absent becomes the column default of an empty string, never NULL. */
  description: descriptionField.optional(),
  /**
   * Optional, and it defaults to `draft` rather than `active`.
   *
   * A create that publishes by default is how half-finished listings reach customers. A
   * merchant who genuinely wants to publish immediately can say so; the safe outcome is the
   * one you get by not thinking about it.
   */
  status: z.enum(PRODUCT_STATUSES).optional(),
});

export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

/* ── PATCH /admin/products/:slug ─────────────────────────────────────────── */

/**
 * The editable product fields.
 *
 * Every field optional, but **at least one required**. A PATCH with an empty body is a request
 * that asks for nothing: it would bump `updated_at`, return 200, and leave a caller believing
 * something changed. Rejecting it costs a client nothing and removes a silent no-op.
 *
 * `strictObject`, so everything absent from this list is **unreachable rather than ignored**:
 *
 *  - `storeId` — comes from request resolution; accepting one would be a tenancy hole.
 *  - `slug` — the product's identity and its URL. Changing it breaks every existing link and
 *    every stored reference, and it collides with the per-store unique index. A rename is a
 *    redirect problem, not a field update, and belongs in its own increment.
 *  - `status` — lifecycle moves through explicit `publish` / `archive` actions (§26), which
 *    enforce which transitions are legal. Allowing it here would be a second, unguarded path
 *    into the state machine that could set any status from any other.
 *  - `currency` — owned by the store; the product table has no such column.
 *  - `id`, `createdAt`, `updatedAt`, `deletedAt` — server-owned. `updatedAt` is set by the
 *    update itself, and a client-supplied one would make the audit trail a client's opinion.
 *
 * Each of those produces a 400 naming the field, which is the right answer to what is either a
 * probe or a badly confused integration.
 */
export const UpdateProductRequestSchema = z
  .strictObject({
    name: nameField.optional(),
    /** An empty string is valid and CLEARS the description; `null` is not. */
    description: descriptionField.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of name or description must be provided',
  });

export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

/* ── GET /products/:slug ─────────────────────────────────────────────────── */

/**
 * The public read path parameter.
 *
 * Reuses `slugField`, so a URL is normalised exactly as the create endpoint normalised the
 * value it stored. If these diverged, a product created as `blue-shirt` could be unreachable at
 * the URL a merchant was shown.
 *
 * A malformed slug is therefore a 400, not a 404 — the established convention for a request
 * that cannot be interpreted. That is not a visibility leak: the slug format is published in
 * the OpenAPI document, so a caller learns nothing from it that the spec does not already
 * state. What must never differ is the answer for a well-formed slug, whatever the reason.
 */
export const ProductSlugParamsSchema = z.object({ slug: slugField });

export type ProductSlugParams = z.infer<typeof ProductSlugParamsSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The public shape of a product.
 *
 * An allowlist, built field by field — the same discipline as `UserResponse`. Spreading the
 * row and deleting the private fields inverts the safety: every column added in a later
 * increment would be published by default, and the one that eventually leaks is the column
 * nobody thought about.
 */
export type ProductResponse = {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  /**
   * The product's sellable units.
   *
   * Replaces the former product-level `price`: a product is not sellable and has no price of
   * its own. An empty array is a legitimate state — a product whose SKUs have all been
   * deactivated or deleted — and on the PUBLIC read it cannot occur, because a product with
   * no sellable SKU is not publicly visible at all.
   *
   * Present on the LIST as well as the detail response. One shape for both (§25) means a
   * client learns the product contract once; the list batch-loads SKUs for the whole page in
   * a single query rather than one per product.
   */
  skus: SkuResponse[];
  /** Resolved from the store, which owns currency. Neither table has such a column. */
  currency: string;
  createdAt: string;
  /**
   * Last modification. Useful to a storefront for cache validation and to a client deciding
   * whether its copy is stale.
   *
   * ONE response shape is shared by the admin create and the public read. A second,
   * near-identical product shape is how a client ends up with two parsers that disagree —
   * and how a field added for an admin response silently reaches the public one. Everything
   * here is safe for an anonymous caller to see, which is the property that makes sharing it
   * correct rather than merely convenient.
   */
  updatedAt: string;
};

export function toProductResponse(
  product: ProductRecord,
  currency: string,
  skus: readonly SkuRecord[] = [],
  /**
   * Combination rows for these SKUs, keyed by SKU id — from the SAME batched query the SKUs
   * came from. Defaulted to empty so every existing call site stays correct: a SKU with no
   * options is a legitimate state, not a missing load.
   */
  optionsBySku: Map<string, SkuOptionRecord[]> = new Map(),
): ProductResponse {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    status: product.status,
    skus: skus.map((record) => toSkuResponse(record, optionsBySku.get(record.id) ?? [])),
    currency,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

/* ── GET /admin/products ─────────────────────────────────────────────────── */

/**
 * Offset pagination bounds.
 *
 * The project had no pagination convention before this endpoint — the only `limit`/`offset` in
 * the codebase were internal outbox batch sizes, not an HTTP contract — so this establishes
 * one. Offset over cursor because it is the smaller thing that works: an admin catalogue is
 * browsed by page number, and cursor pagination buys stability under concurrent inserts that
 * nothing has asked for. See `docs/DECISIONS.md` §28.
 */
export const PRODUCT_LIST_DEFAULT_LIMIT = 20;
export const PRODUCT_LIST_MAX_LIMIT = 100;

/**
 * The list query.
 *
 * `strictObject`, so `?limitt=50` is a 400 rather than being silently ignored and returning a
 * default page. That matches the request-body convention and is worth more on a query string,
 * where a typo produces plausible-looking output instead of an obvious failure. It also means
 * `storeId`, `status`, `search`, and `sort` are not merely unhandled but unreachable — the
 * store comes from resolution, and the rest are later increments.
 *
 * The ceiling is enforced by validation rather than by clamping. Silently returning 100 rows
 * for `?limit=5000` would tell a caller their page size was honoured when it was not, and a
 * client paging on `offset += limit` would then skip records.
 *
 * Parsing is handled by `boundedIntParam` below, which explains why coercion is not used.
 */
export const ListProductsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: PRODUCT_LIST_MAX_LIMIT,
    default: PRODUCT_LIST_DEFAULT_LIMIT,
  }),
  /**
   * No ceiling, deliberately. A pathological `?offset=99999999999` is a performance concern
   * rather than a correctness one, and the fix is keyset pagination — deferred — not an
   * arbitrary cap. A value large enough to matter fails `.int()` anyway once `Number` yields
   * `Infinity`.
   */
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;
/**
 * A storefront search term.
 *
 * Trimmed BEFORE the length checks, so `?q=%20%20` is an empty search and a 400 rather than a
 * query for two spaces. The 100-character ceiling is not a UX judgement — it bounds the pattern
 * handed to a scan that cannot use an index.
 */
const searchTermField = z.string().trim().min(1, 'must not be empty').max(100);

/**
 * Compare two price strings that have ALREADY passed `priceField`.
 *
 * Not `Number(a) <= Number(b)`, for the same reason `priceField` is not `z.number()`. The
 * pattern admits 15 integer digits and 4 decimals — 19 significant digits, past what an
 * IEEE-754 double can distinguish — so `999999999999999.9999` and `999999999999999.9998`
 * compare EQUAL as doubles, and a reversed range at that magnitude would slip through the
 * check below. Reachable through the public API, so not a theoretical concern.
 *
 * Not `money()` either: that needs a `Currency`, which would mean threading the store's
 * currency into query validation, and it raises an `InvariantViolation` — a 500 — for a
 * currency this build does not know. A filter must not be able to fail that way.
 *
 * Instead, zero-pad both sides to a fixed 15.4 layout. The inputs are non-negative and
 * bounded by the regex, so the padded forms are equal-length digit strings and lexicographic
 * order IS numeric order. Exact, and no dependency.
 */
function comparePriceStrings(a: string, b: string): -1 | 0 | 1 {
  const pad = (value: string): string => {
    const [whole = '', fraction = ''] = value.split('.');
    return whole.padStart(15, '0') + fraction.padEnd(STORAGE_SCALE, '0');
  };

  const left = pad(a);
  const right = pad(b);

  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * The PUBLIC list query: everything the admin list accepts, plus `q` and the price bounds.
 *
 * Deliberately a separate schema rather than adding these to the shared one. The admin list
 * uses `ListProductsQuerySchema` too, and widening it would give that endpoint parameters it
 * silently ignores — the exact "looks like it worked" failure §28 rejected clamping to avoid.
 * Admin filtering, if it is ever wanted, is its own increment with its own visibility rules.
 *
 * `.extend()` preserves `strictObject`, so unknown parameters remain a 400 here — asserted by
 * test rather than assumed, since that is a property of Zod rather than of this code.
 *
 * Both bounds reuse `priceField`, the same primitive the create and update bodies use. A second
 * price pattern here would be free to drift from the column, and the endpoint that disagreed
 * would be the one filtering rather than the one writing. Reuse also settles three rules at
 * once: no negatives (the pattern starts `\d`), at most 4 decimals, and rejection rather than
 * silent rounding.
 *
 * `snake_case` because these are query parameters, matching `price_min` / `price_max` on the
 * wire exactly. `strictObject` means the name is the contract — a camelCase alias would be a
 * 400, so there is nothing to reconcile.
 */
export const PublicListProductsQuerySchema = ListProductsQuerySchema.extend({
  q: searchTermField.optional(),
  /** Inclusive lower bound: `price >= price_min`. */
  price_min: priceField.optional(),
  /** Inclusive upper bound: `price <= price_max`. */
  price_max: priceField.optional(),
}).refine(
  (query) =>
    query.price_min === undefined ||
    query.price_max === undefined ||
    comparePriceStrings(query.price_min, query.price_max) <= 0,
  {
    /**
     * A reversed range is a 400, not an empty 200.
     *
     * Same judgement as §28's "over the maximum is rejected, not clamped": an empty page would
     * tell a caller their filter was honoured and simply matched nothing, when in fact the
     * request was impossible to satisfy. A transposed `price_min=2000&price_max=1000` is a bug
     * in the caller, and the useful answer says so rather than looking like an empty shelf.
     *
     * `.refine()` on the whole object, following `UpdateProductRequestSchema` — the existing
     * cross-field mechanism, rather than a second one.
     */
    message: 'price_min must not be greater than price_max',
    path: ['price_min'],
  },
);

export type PublicListProductsQuery = z.infer<typeof PublicListProductsQuerySchema>;

export type ProductListResponse = {
  products: ProductResponse[];
  pagination: PaginationResponse;
};

export function toProductListResponse(
  page: { items: readonly ProductRecord[]; total: number; limit: number; offset: number },
  currency: string,
  /**
   * SKUs for this page's products, keyed by product id — from ONE batched query.
   *
   * Passed in rather than fetched here because a mapper must not do I/O; the route loads them
   * for the whole page in a single `inArray` and hands the grouping over. A per-product fetch
   * inside this loop would be an N+1 that only shows up under load.
   */
  skusByProduct: Map<string, SkuRecord[]> = new Map(),
  /** Combination rows for every SKU on the page, from one further batched query. */
  optionsBySku: Map<string, SkuOptionRecord[]> = new Map(),
): ProductListResponse {
  return {
    // The SAME mapper every other product endpoint uses. A list-specific shape would be a
    // second contract for clients to parse, and a place for an internal field to reach one
    // response but not the other.
    products: page.items.map((item) =>
      toProductResponse(item, currency, skusByProduct.get(item.id) ?? [], optionsBySku),
    ),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

/* ── SKUs ────────────────────────────────────────────────────────────────── */

/**
 * A merchant SKU code.
 *
 * Trimmed but NOT lowercased, which is the deliberate difference from `slugField`. A slug is a
 * URL segment, where case is noise; a merchant code is an identifier that already exists on
 * their purchase orders and packing slips, where `ABC-1` and `abc-1` may well be two different
 * things. Normalising case would silently merge them.
 *
 * The pattern is permissive on purpose — real merchant numbering uses dots, slashes and
 * underscores — but excludes whitespace and control characters, which would make a code
 * impossible to type back reliably or to put in a URL path.
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

/** A short display label. Empty is valid and means the column default. */
const skuNameField = z.string().trim().max(300);

/* ── POST /admin/products/:slug/skus ─────────────────────────────────────── */

/**
 * `strictObject`, so an unknown field is a 400 rather than being silently dropped.
 *
 * Note what is absent and therefore UNREACHABLE, not merely ignored: `storeId` and `productId`
 * come from the resolved store and the product slug in the path; `id` from `newId()`;
 * `actorUserId` from the verified access token; and every timestamp is server-owned. A client
 * sending any of them gets a validation error naming the field — the right answer to what is
 * either a probe for a tenancy hole or a badly confused integration.
 */
export const CreateSkuRequestSchema = z.strictObject({
  code: skuCodeField,
  /** Optional. Absent becomes the column default of an empty string, never NULL. */
  name: skuNameField.optional(),
  price: priceField,
  /**
   * Optional, defaulting to sellable.
   *
   * The opposite default from `product.status`, and deliberately so: a product defaults to
   * `draft` because publishing a half-finished listing is the harm to avoid, whereas a SKU is
   * created underneath a product whose own status already governs whether customers see it.
   * A SKU that had to be activated separately would be a second publish step for no gain.
   */
  isActive: z.boolean().optional(),
});

export type CreateSkuRequest = z.infer<typeof CreateSkuRequestSchema>;

/* ── PATCH /admin/skus/:code ─────────────────────────────────────────────── */

/**
 * The editable SKU fields.
 *
 * Every field optional, but **at least one required** — an empty PATCH would bump
 * `updated_at`, return 200, and leave a caller believing something changed (§29).
 *
 * `strictObject`, so everything absent from this list is unreachable rather than ignored:
 *
 *  - `code` — the merchant's identifier for the thing, carried on documents that already
 *    exist. Renaming it in place would silently repoint whatever references it; a rename is a
 *    delete plus a create, which the partial unique index already allows.
 *  - `storeId`, `productId` — tenancy and parentage. Accepting either would let a caller move
 *    a SKU between stores or products, which is not an edit but a different operation nobody
 *    has asked for.
 *  - `id`, `createdAt`, `updatedAt`, `deletedAt` — server-owned. `updatedAt` is set by the
 *    update itself, and a client-supplied one would make the audit trail a client's opinion.
 *  - tax fields — not in this increment at all, and when they arrive they are accounting's
 *    decision, not a field a merchant PATCHes casually.
 *
 * `isActive` IS here, unlike `product.status`. Both of its transitions are always legal, so
 * there is no state machine to skip and no illegal transition to reject — which is precisely
 * the reasoning §26 used to make product status an explicit ACTION instead.
 */
export const UpdateSkuRequestSchema = z
  .strictObject({
    name: skuNameField.optional(),
    price: priceField.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of name, price, or isActive must be provided',
  });

export type UpdateSkuRequest = z.infer<typeof UpdateSkuRequestSchema>;

/**
 * The path parameter for the flat SKU routes.
 *
 * Reuses `skuCodeField`, so a URL normalises exactly as the create endpoint normalised the
 * value it stored. If these diverged, a SKU created as `ABC-1` could be unreachable at its
 * own URL.
 */
export const SkuCodeParamsSchema = z.object({ code: skuCodeField });

export type SkuCodeParams = z.infer<typeof SkuCodeParamsSchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The public shape of a SKU.
 *
 * An allowlist, built field by field, like every other response in this project. `storeId` and
 * `deletedAt` never appear: tenancy is an invariant of the query rather than a field for a
 * client to inspect, and a deleted SKU is not returned at all.
 *
 * ONE shape for the public read and the admin views. `isActive` is safe for an anonymous
 * caller — a storefront legitimately needs to know which variants it may offer — and sharing
 * the shape is what stops a field added for an admin view silently reaching the public one.
 */
export type SkuResponse = {
  id: string;
  productId: string;
  code: string;
  name: string;
  /** Decimal string at the storage scale. Never a JSON number — see `priceField`. */
  price: string;
  isActive: boolean;
  /**
   * The SKU's variant combination — one entry per option, empty for an option-less SKU.
   *
   * FLAT pairs rather than a nested option-with-one-value object, because on a SKU each option
   * has exactly one value: `uq_sov_sku_option` forbids more. Nesting would model a cardinality
   * the database rules out and would make every consumer unwrap a one-element array.
   *
   * Never the raw `option_signature`. That is storage — an internal, order-sensitive string of
   * ids — and publishing it would turn a private encoding into a contract that could not then
   * be changed.
   */
  options: SkuOptionResponse[];
  createdAt: string;
  updatedAt: string;
};

/** One (option, value) pair on a SKU. Sort orders are carried so a client can render the grid. */
export type SkuOptionResponse = {
  optionId: string;
  optionName: string;
  optionSortOrder: number;
  valueId: string;
  value: string;
  valueSortOrder: number;
};

export function toSkuOptionResponse(record: SkuOptionRecord): SkuOptionResponse {
  return {
    optionId: record.optionId,
    optionName: record.optionName,
    optionSortOrder: record.optionSortOrder,
    valueId: record.valueId,
    value: record.value,
    valueSortOrder: record.valueSortOrder,
  };
}

export function toSkuResponse(
  record: SkuRecord,
  options: readonly SkuOptionRecord[] = [],
): SkuResponse {
  return {
    id: record.id,
    productId: record.productId,
    code: record.code,
    name: record.name,
    price: record.price,
    isActive: record.isActive,
    options: options.map(toSkuOptionResponse),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Group combination rows by SKU id.
 *
 * The batch loader returns a flat list across many SKUs; this is what keeps a product list at a
 * fixed number of queries instead of one per SKU. A 20-product page can carry 100 SKUs, so the
 * N+1 this avoids is real rather than theoretical.
 */
export function groupOptionsBySku(
  records: readonly SkuOptionRecord[],
): Map<string, SkuOptionRecord[]> {
  const bySku = new Map<string, SkuOptionRecord[]>();

  for (const record of records) {
    const existing = bySku.get(record.skuId);
    if (existing) {
      existing.push(record);
    } else {
      bySku.set(record.skuId, [record]);
    }
  }

  return bySku;
}

/**
 * Group SKUs by product id, for the list responses.
 *
 * The batch loader returns a flat list; this turns it into the lookup `toProductListResponse`
 * needs. Grouping here rather than in SQL keeps the query a single `inArray` — a join would
 * duplicate products, which is the whole reason the visibility predicate uses `EXISTS`.
 */
export function groupSkusByProduct(skus: readonly SkuRecord[]): Map<string, SkuRecord[]> {
  const byProduct = new Map<string, SkuRecord[]>();

  for (const record of skus) {
    const existing = byProduct.get(record.productId);
    if (existing) {
      existing.push(record);
    } else {
      byProduct.set(record.productId, [record]);
    }
  }

  return byProduct;
}

/* ── Options: grid-size caps ─────────────────────────────────────────────── */

/**
 * Operational hygiene limits, NOT merchandising rules.
 *
 * They exist so an absurd request fails as a clean `400` naming the limit, rather than as a
 * database error or a signature long enough to threaten PostgreSQL's ~2704-byte B-tree entry
 * cap. A real variant grid is far below all three; nothing about a legitimate catalogue is
 * being constrained here, which is why they are stated as constants with this comment rather
 * than modelled as configurable policy.
 */
export const MAX_OPTIONS_PER_PRODUCT = 10;
export const MAX_VALUES_PER_OPTION = 100;
export const MAX_OPTION_VALUES_PER_SKU = 10;

/* ── Options: field primitives ───────────────────────────────────────────── */

/**
 * An option or value label.
 *
 * Trimmed but NOT lowercased. The merchant's own capitalisation is what gets stored and
 * displayed; case-insensitivity is enforced by the `lower()` expression unique indexes in the
 * migration, so the database rejects "size" beside "Size" no matter which writer produced it.
 * Lowercasing here instead would make the API the only enforcement point and would silently
 * mangle a label a merchant deliberately capitalised.
 */
const optionLabelField = z.string().trim().min(1).max(120);

/**
 * Display order.
 *
 * A plain non-negative integer, and duplicates are allowed: ordering ties are broken by `id`
 * at every read site, so a merchant who leaves everything at 0 still gets a stable, total
 * order rather than an arbitrary one.
 */
const sortOrderField = z.int().min(0).max(100_000);

/**
 * A UUID path parameter — the FIRST in this codebase.
 *
 * Options and values have no merchant-facing code the way a SKU does, so their id is the only
 * key. Validating it here means a malformed id is a `400` from the validation layer rather
 * than a `22P02` invalid-input-syntax error surfacing from PostgreSQL as a 500.
 */
export const OptionIdParamsSchema = z.object({ id: z.uuid() });

export type OptionIdParams = z.infer<typeof OptionIdParamsSchema>;

/* ── POST/PATCH /admin/.../options and option-values ─────────────────────── */

/**
 * `strictObject` throughout, so an unknown field is a `400` rather than being silently dropped.
 *
 * Note what is absent and therefore UNREACHABLE rather than ignored: `storeId`, `productId`
 * and `optionId` are never accepted from a body. Parentage comes from the resolved path — the
 * product row for an option, the option row for a value — so a caller cannot move an option to
 * another product or reach across a tenant boundary by naming one.
 */
export const CreateOptionRequestSchema = z.strictObject({
  name: optionLabelField,
  sortOrder: sortOrderField.optional(),
});

export type CreateOptionRequest = z.infer<typeof CreateOptionRequestSchema>;

/** Every field optional, at least one required — the established PATCH rule (§29). */
export const UpdateOptionRequestSchema = z
  .strictObject({
    name: optionLabelField.optional(),
    sortOrder: sortOrderField.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of name or sortOrder must be provided',
  });

export type UpdateOptionRequest = z.infer<typeof UpdateOptionRequestSchema>;

export const CreateOptionValueRequestSchema = z.strictObject({
  value: optionLabelField,
  sortOrder: sortOrderField.optional(),
});

export type CreateOptionValueRequest = z.infer<typeof CreateOptionValueRequestSchema>;

export const UpdateOptionValueRequestSchema = z
  .strictObject({
    value: optionLabelField.optional(),
    sortOrder: sortOrderField.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one of value or sortOrder must be provided',
  });

export type UpdateOptionValueRequest = z.infer<typeof UpdateOptionValueRequestSchema>;

/* ── PUT /admin/skus/:code/options ───────────────────────────────────────── */

/**
 * Replace a SKU's whole combination.
 *
 * REPLACEMENT, not a patch, and the method says so. The field is REQUIRED even though `[]` is
 * legal: "remove every option from this SKU" is a deliberate act and must be stated, not
 * achieved by forgetting a field. An optional array would make a typo in the field name — which
 * `strictObject` would otherwise catch as a 400 — indistinguishable from an intentional clear.
 *
 * Duplicate ids are rejected rather than de-duplicated. A caller sending the same value twice
 * is confused about something, and silently accepting it would hide the confusion; the same
 * judgement §28 applied to rejecting an over-limit page rather than clamping it.
 *
 * `MAX_OPTION_VALUES_PER_SKU` is enforced here rather than in the service because it is a
 * property of the REQUEST — the array's length — so the request never reaches a transaction.
 */
export const ReplaceSkuOptionsRequestSchema = z.strictObject({
  optionValueIds: z
    .array(z.uuid())
    .max(
      MAX_OPTION_VALUES_PER_SKU,
      `a SKU may carry at most ${String(MAX_OPTION_VALUES_PER_SKU)} option values`,
    )
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'optionValueIds must not contain duplicates',
    }),
});

export type ReplaceSkuOptionsRequest = z.infer<typeof ReplaceSkuOptionsRequestSchema>;

/* ── Option responses ────────────────────────────────────────────────────── */

/**
 * The public shape of an option value.
 *
 * An allowlist, like every other response here. `storeId`, `productId` and `deletedAt` never
 * appear: tenancy and parentage are invariants of the query rather than fields for a client to
 * inspect, and a deleted value is not returned at all.
 */
export type OptionValueResponse = {
  id: string;
  value: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export function toOptionValueResponse(record: OptionValueRecord): OptionValueResponse {
  return {
    id: record.id,
    value: record.value,
    sortOrder: record.sortOrder,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * An option, with its values NESTED.
 *
 * One shape, so there is no second endpoint listing values and no second parser that could
 * disagree with this one about their order. `values` is present and possibly empty — an option
 * with no values yet is a legitimate intermediate state, exactly as a product with no SKUs is.
 */
export type OptionResponse = {
  id: string;
  productId: string;
  name: string;
  sortOrder: number;
  values: OptionValueResponse[];
  createdAt: string;
  updatedAt: string;
};

export function toOptionResponse(
  record: OptionRecord,
  values: readonly OptionValueRecord[] = [],
): OptionResponse {
  return {
    id: record.id,
    productId: record.productId,
    name: record.name,
    sortOrder: record.sortOrder,
    values: values.map(toOptionValueResponse),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Group values by option id, so the option list stays one batched query. */
export function groupValuesByOption(
  values: readonly OptionValueRecord[],
): Map<string, OptionValueRecord[]> {
  const byOption = new Map<string, OptionValueRecord[]>();

  for (const record of values) {
    const existing = byOption.get(record.optionId);
    if (existing) {
      existing.push(record);
    } else {
      byOption.set(record.optionId, [record]);
    }
  }

  return byOption;
}
