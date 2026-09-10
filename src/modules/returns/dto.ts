import { z } from 'zod';

import { RETURN_REASONS } from './returns.repository.js';

/* ── Shared field shapes ─────────────────────────────────────────────────── */

/**
 * A SKU code, matching the catalogue's own field.
 *
 * Restated rather than imported: `no-cross-module-imports` forbids reaching into catalogue,
 * and a test asserts a code the catalogue accepts is a code a return accepts, so the copy
 * cannot drift silently.
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
 * The return number. `RET-YYYYMMDD-XXXXXX`.
 *
 * Case-SENSITIVE and pattern-checked, exactly as `OrderNumberParamsSchema` is: the number is
 * machine-generated and quoted back verbatim, never typed from memory off a banner. A
 * malformed number is a `400` from Zod rather than a query that can only ever miss.
 */
const returnNumberField = z
  .string()
  .trim()
  .max(64)
  .regex(/^RET-\d{8}-[A-Z2-9]{6}$/, 'must be a return number of the form RET-YYYYMMDD-XXXXXX');

/* ── POST /users/me/orders/{orderNumber}/returns ─────────────────────────── */

/**
 * One line of a return request. **A SKU code and a count, and that is all.**
 *
 * `strictObject`, so note what is therefore unreachable rather than ignored: every monetary
 * field (`unitPrice`, `lineTotal`, `discountAmount`, any tax amount, `refundTotal`), every
 * identifier the server owns (`skuId`, `orderId`, `returnId`, `storeId`, `userId`), and the
 * inspection counts. A client that sends any of them gets a `400` naming the field rather than
 * having it silently dropped — and none of them could have been honoured anyway, because every
 * amount is apportioned from the frozen order line inside the transaction.
 */
export const CreateReturnLineSchema = z.strictObject({
  skuCode: skuCodeField,
  quantity: z
    .int('must be a whole number of units')
    .min(1, 'must be at least 1')
    .max(999, 'must be at most 999'),
});

export type CreateReturnLineRequest = z.infer<typeof CreateReturnLineSchema>;

/**
 * The return request body.
 *
 * `reason` is the CLOSED list the schema defines — free text goes in `customerNote`, which
 * nothing branches on. `deliveredAt`, `status`, `returnNumber` and every amount are absent by
 * construction: the server derives all of them, and `strictObject` makes an attempt to supply
 * one a validation error rather than a silently ignored field.
 */
export const CreateReturnRequestSchema = z.strictObject({
  reason: z.enum(RETURN_REASONS),
  customerNote: z.string().trim().max(500).optional(),
  lines: z
    .array(CreateReturnLineSchema)
    .min(1, 'at least one line is required')
    .max(100, 'at most 100 lines')
    .refine(
      (lines) => new Set(lines.map((l) => l.skuCode)).size === lines.length,
      'each SKU may appear at most once; combine the quantities instead',
    ),
});

export type CreateReturnRequest = z.infer<typeof CreateReturnRequestSchema>;

/* ── Path and query parameters ───────────────────────────────────────────── */

export const ReturnNumberParamsSchema = z.object({ returnNumber: returnNumberField });
export type ReturnNumberParams = z.infer<typeof ReturnNumberParamsSchema>;

export const RETURN_LIST_DEFAULT_LIMIT = 20;
export const RETURN_LIST_MAX_LIMIT = 100;

/**
 * Bounded integer query parameter.
 *
 * A digits-only parse BEFORE coercion, matching the fix recorded for the product list: plain
 * `z.coerce.number()` accepts `''` as `0`, so `?offset=` silently returned the first page.
 * This rejects `''`, `-1`, `2.5`, `1e3` and `0x10` with one rule.
 */
const boundedIntParam = (opts: { min: number; max?: number; default: number }) =>
  z
    .string()
    .regex(/^\d+$/u, 'must be a whole number')
    .transform(Number)
    .refine((n) => n >= opts.min, `must be at least ${String(opts.min)}`)
    .refine(
      (n) => opts.max === undefined || n <= opts.max,
      `must be at most ${String(opts.max ?? 0)}`,
    )
    .optional()
    .transform((n) => n ?? opts.default);

export const ListReturnsQuerySchema = z.strictObject({
  limit: boundedIntParam({
    min: 1,
    max: RETURN_LIST_MAX_LIMIT,
    default: RETURN_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type ListReturnsQuery = z.infer<typeof ListReturnsQuerySchema>;

/* ── Responses ───────────────────────────────────────────────────────────── */

/**
 * One line of a return, as the CUSTOMER sees it.
 *
 * Carries the frozen money so a customer can see exactly what each returned unit credits, and
 * carries `skuCode` rather than `skuId` for the same reason orders publish a number and not an
 * id. **The inspection counts are absent**: `restockQuantity` and `writeOffQuantity` are a
 * warehouse decision about resaleability, not a statement about the customer's refund, and
 * publishing them would invite "why was my item written off" support load over a field that
 * changes nothing they are owed.
 */
export type ReturnLineResponse = {
  skuCode: string;
  quantity: number;
  lineTotal: string;
  discountAmount: string;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  cessAmount: string;
  taxTotal: string;
  refundTotal: string;
};

/**
 * A return, as the CUSTOMER sees it.
 *
 * `staffNote` is deliberately absent — it is the merchant's internal rationale, written for
 * colleagues. So is every internal identifier.
 */
export type ReturnResponse = {
  returnNumber: string;
  orderNumber: string;
  status: string;
  reason: string;
  customerNote: string;
  currency: string;
  refundTaxableValue: string;
  refundTaxTotal: string;
  refundTotal: string;
  requestedAt: string;
  closedAt: string | null;
  lines: ReturnLineResponse[];
};

/** The row fields the mappers need. Structural, so the repository picks the columns. */
export type MappableReturn = {
  readonly returnNumber: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly reason: string;
  readonly customerNote: string;
  readonly currency: string;
  readonly refundTaxableValue: string;
  readonly refundTaxTotal: string;
  readonly refundTotal: string;
  readonly requestedAt: Date;
  readonly closedAt: Date | null;
};

export type MappableReturnLine = {
  readonly skuCode: string;
  readonly quantity: number;
  readonly lineTotal: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly cgstAmount: string;
  readonly sgstAmount: string;
  readonly igstAmount: string;
  readonly cessAmount: string;
  readonly taxTotal: string;
  readonly refundTotal: string;
};

export function toReturnLineResponse(line: MappableReturnLine): ReturnLineResponse {
  return {
    skuCode: line.skuCode,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
    discountAmount: line.discountAmount,
    taxableValue: line.taxableValue,
    cgstAmount: line.cgstAmount,
    sgstAmount: line.sgstAmount,
    igstAmount: line.igstAmount,
    cessAmount: line.cessAmount,
    taxTotal: line.taxTotal,
    refundTotal: line.refundTotal,
  };
}

export function toReturnResponse(view: {
  readonly header: MappableReturn;
  readonly lines: readonly MappableReturnLine[];
}): ReturnResponse {
  return {
    returnNumber: view.header.returnNumber,
    orderNumber: view.header.orderNumber,
    status: view.header.status,
    reason: view.header.reason,
    customerNote: view.header.customerNote,
    currency: view.header.currency,
    refundTaxableValue: view.header.refundTaxableValue,
    refundTaxTotal: view.header.refundTaxTotal,
    refundTotal: view.header.refundTotal,
    requestedAt: view.header.requestedAt.toISOString(),
    closedAt: view.header.closedAt === null ? null : view.header.closedAt.toISOString(),
    lines: view.lines.map(toReturnLineResponse),
  };
}
