import { z } from 'zod';

import { boundedIntParam, type PaginationResponse } from '../../shared/pagination.js';

import { STOCK_REASONS } from './inventory.repository.js';
import type { StockLedgerRecord, StockRecord } from './inventory.repository.js';

/**
 * Re-exported, so a caller of this module needs one import rather than two.
 *
 * The shape lives in `shared/pagination.ts` — one definition for every list endpoint.
 */
export type { PaginationResponse };

/**
 * The inventory module's wire contracts.
 *
 * Same two jobs as every other DTO file here, and both are security boundaries: decide exactly
 * what a client may send, and exactly what leaves the system.
 */

/* ── Field primitives ────────────────────────────────────────────────────── */

/**
 * A merchant SKU code, as the inventory endpoints accept it.
 *
 * The SAME pattern and bounds the catalogue uses, restated rather than imported because
 * `no-cross-module-imports` forbids reaching into `modules/catalogue` for it. That duplication
 * is deliberate and narrow: a divergence would mean a SKU created as `ABC-1` was unreachable
 * from inventory, so a test asserts a code the catalogue accepts is a code this accepts.
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
 * The largest adjustment a single request may make.
 *
 * Operational hygiene, not a merchandising rule. It keeps a fat-fingered paste a long way from
 * `integer` overflow, which would otherwise surface as SQLSTATE 22003 from PostgreSQL rather
 * than as a clean 400 naming the field.
 */
export const MAX_ADJUSTMENT_DELTA = 1_000_000;

/**
 * The stock delta.
 *
 * `z.int()`, so a fractional quantity is a 400 rather than being truncated. Inventory is
 * counted in whole units — the approved decision — and silently rounding 1.5 to 1 would be a
 * merchant's stock figure quietly changed by a validation layer.
 *
 * `.refine` for non-zero rather than a min/max pair, because the legal set is two ranges with
 * a hole in the middle. A zero adjustment is refused for the same reason an empty PATCH is:
 * it would write a ledger row asserting that nothing happened, which is audit-trail noise —
 * and `ck_stock_ledger_delta_non_zero` refuses it in the database too.
 */
const deltaField = z
  .int('must be a whole number of units')
  .min(-MAX_ADJUSTMENT_DELTA)
  .max(MAX_ADJUSTMENT_DELTA)
  .refine((value) => value !== 0, { message: 'must not be zero' });

export const INVENTORY_LIST_DEFAULT_LIMIT = 20;
export const INVENTORY_LIST_MAX_LIMIT = 100;

/* ── GET /admin/inventory ────────────────────────────────────────────────── */

/**
 * `strictObject`, so `?limitt=50` is a 400 rather than silently returning a default page.
 *
 * `storeId` is absent and therefore UNREACHABLE rather than ignored: the store comes from
 * request resolution. So are `skuCode` and any filter — filtering inventory is a later
 * increment, and an unhandled parameter that looks like it worked is the failure this rejects.
 */
export const ListInventoryQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: INVENTORY_LIST_MAX_LIMIT,
    default: INVENTORY_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type ListInventoryQuery = z.infer<typeof ListInventoryQuerySchema>;

/* ── POST /admin/inventory/adjustments ───────────────────────────────────── */

/**
 * One stock adjustment.
 *
 * `strictObject`. Note what is absent and therefore unreachable, not merely ignored:
 *
 *  - `storeId` — comes from request resolution. Accepting one would be a tenancy hole.
 *  - `actorUserId` / `actorId` — comes from the verified access token. Accepting one would let
 *    a caller forge the audit trail's attribution.
 *  - `productId`, `skuId` — the SKU is selected by its merchant CODE, which is what appears on
 *    a merchant's paperwork. Accepting an internal id as an alternative selector would be a
 *    second lookup path with its own store-scoping to get wrong.
 *  - `onHand`, `available`, `reserved` — the API accepts a DELTA, never a target. A target
 *    would either require the client to read-then-write (recreating the lost-update bug one
 *    layer up) or silently discard a concurrent adjustment.
 *
 * Each of those produces a 400 naming the field.
 */
export const CreateAdjustmentRequestSchema = z.strictObject({
  skuCode: skuCodeField,
  delta: deltaField,
  /**
   * Required, not optional. An adjustment with no stated reason is an entry an auditor cannot
   * interpret, and defaulting one would put a guess in the permanent record.
   */
  reason: z.enum(STOCK_REASONS),
  /** Optional free text. Absent becomes the column default of an empty string, never NULL. */
  note: z.string().trim().max(500).optional(),
});

export type CreateAdjustmentRequest = z.infer<typeof CreateAdjustmentRequestSchema>;

/* ── GET /admin/inventory/:skuCode/history ───────────────────────────────── */

/**
 * The history path parameter.
 *
 * Reuses `skuCodeField`, so a URL is validated exactly as the adjustment body is. A malformed
 * code is therefore a 400 from validation and never reaches PostgreSQL — which matters here
 * because an unvalidated code would otherwise be interpolated into a query.
 */
export const SkuCodeParamsSchema = z.object({ skuCode: skuCodeField });

export type SkuCodeParams = z.infer<typeof SkuCodeParamsSchema>;

export const ListHistoryQuerySchema = ListInventoryQuerySchema;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * The shape of one SKU's stock.
 *
 * An allowlist, built field by field, like every other response in this project. `storeId`
 * never appears: tenancy is an invariant of the query rather than a field for a client to
 * inspect.
 *
 * `available` is echoed as the database generated it. It is NOT recomputed here — that would
 * be a second definition of availability, and the whole point of the generated column is that
 * there is exactly one.
 *
 * There is no public counterpart to this shape. No stock figure appears on any public product
 * or SKU response in this increment: without reservations there is nothing to hold a displayed
 * availability with, so publishing one would ship the storefront a promise the backend cannot
 * keep.
 */
export type StockResponse = {
  skuId: string;
  skuCode: string;
  onHand: number;
  reserved: number;
  available: number;
  createdAt: string;
  updatedAt: string;
};

export function toStockResponse(record: StockRecord): StockResponse {
  return {
    skuId: record.skuId,
    skuCode: record.skuCode,
    onHand: record.onHand,
    reserved: record.reserved,
    available: record.available,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * One ledger entry.
 *
 * `actorUserId` IS exposed: the caller is authenticated staff of the store that owns the row,
 * and "who moved this stock" is the question a history endpoint exists to answer. `requestId`
 * is exposed so an operator can line an entry up against the request that caused it — it is
 * already in `audit_log` beside it.
 */
export type StockLedgerResponse = {
  id: string;
  skuId: string;
  delta: number;
  onHandBefore: number;
  onHandAfter: number;
  reason: string;
  note: string;
  actorUserId: string;
  requestId: string | null;
  createdAt: string;
};

export function toStockLedgerResponse(record: StockLedgerRecord): StockLedgerResponse {
  return {
    id: record.id,
    skuId: record.skuId,
    delta: record.delta,
    onHandBefore: record.onHandBefore,
    onHandAfter: record.onHandAfter,
    reason: record.reason,
    note: record.note,
    actorUserId: record.actorUserId,
    requestId: record.requestId,
    createdAt: record.createdAt.toISOString(),
  };
}

export type StockListResponse = {
  inventory: StockResponse[];
  pagination: PaginationResponse;
};

export function toStockListResponse(page: {
  items: readonly StockRecord[];
  total: number;
  limit: number;
  offset: number;
}): StockListResponse {
  return {
    inventory: page.items.map(toStockResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}

export type StockHistoryResponse = {
  history: StockLedgerResponse[];
  pagination: PaginationResponse;
};

export function toStockHistoryResponse(page: {
  items: readonly StockLedgerRecord[];
  total: number;
  limit: number;
  offset: number;
}): StockHistoryResponse {
  return {
    history: page.items.map(toStockLedgerResponse),
    pagination: { limit: page.limit, offset: page.offset, total: page.total },
  };
}
