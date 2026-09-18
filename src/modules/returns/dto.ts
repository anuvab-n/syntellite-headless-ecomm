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

/* ── Staff ───────────────────────────────────────────────────────────────── */

/**
 * The staff decision body. An optional note, and that is all.
 *
 * `strictObject`, so note what a client therefore CANNOT send: a status, a refund amount, a
 * quantity, an approval timestamp, a store or a user. Approval agrees to a return exactly as
 * the customer raised it — it never edits one. Each of those is a `400` naming the field.
 */
export const StaffReturnDecisionSchema = z.strictObject({
  staffNote: z.string().trim().max(500).optional(),
});

export type StaffReturnDecisionRequest = z.infer<typeof StaffReturnDecisionSchema>;

/** The staff work-queue filter. One optional status, plus the shared paging contract. */
/**
 * An ISO-8601 instant with an offset, matching the orders, payments and customer lists.
 *
 * **The client owns the timezone.** A bare `YYYY-MM-DD` was rejected there for a reason that
 * holds here too: the server would have to pick a timezone to widen it into, every choice is
 * wrong somewhere, and none of them is visible in the request.
 */
const instantField = z.iso.datetime({ offset: true });

export const StaffListReturnsQuerySchema = z.strictObject({
  status: z
    .enum(['requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled'])
    .optional(),

  /**
   * The return window's lower and upper bounds, on `requestedAt`. Increment 61.
   *
   * **Both inclusive**, and the upper one names a MILLISECOND — every microsecond inside the
   * millisecond named is included. The repository expresses that as a half-open `<` against
   * `exclusiveEndOfMillisecond`, because `requested_at` is microsecond-precise in PostgreSQL
   * and millisecond-precise in this API; a plain `<=` would drop the very return an operator
   * copied the bound from.
   */
  requestedFrom: instantField.optional(),
  requestedTo: instantField.optional(),

  /**
   * The operator's search box. Increment 61.
   *
   * Case-insensitive **substring** over four handles: return number, order number, customer
   * email, and SKU code. Bounded at 320 — the length of the longest of them, an email address.
   *
   * Deliberately NOT names, addresses or notes: a wider search is a wider disclosure, and the
   * orders list draws the line in the same place. Wildcards are escaped in the repository, so a
   * typed `%` means a percent sign rather than "match everything".
   */
  q: z.string().trim().min(1).max(320).optional(),

  limit: boundedIntParam({
    min: 1,
    max: RETURN_LIST_MAX_LIMIT,
    default: RETURN_LIST_DEFAULT_LIMIT,
  }),
  offset: boundedIntParam({ min: 0, default: 0 }),
});

export type StaffListReturnsQuery = z.infer<typeof StaffListReturnsQuerySchema>;

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

/**
 * A return as STAFF see it: everything the customer sees, plus the internal fields.
 *
 * Two additions, and both are staff-only for a reason.
 *
 * `staffNote` is the merchant’s rationale, written for colleagues — publishing it would
 * turn every refusal into an argument with the customer.
 *
 * The per-line inspection counts say how many units were judged resellable versus written
 * off. That is a warehouse decision and changes nothing about what the customer is owed, so
 * it stays out of the customer response and belongs in the one staff use.
 */
export type StaffReturnLineResponse = ReturnLineResponse & {
  restockQuantity: number;
  writeOffQuantity: number;
};

export type StaffReturnResponse = Omit<ReturnResponse, 'lines'> & {
  staffNote: string;
  lines: StaffReturnLineResponse[];
};

export function toStaffReturnResponse(view: {
  readonly header: MappableReturn & { readonly staffNote: string };
  readonly lines: readonly (MappableReturnLine & {
    readonly restockQuantity: number;
    readonly writeOffQuantity: number;
  })[];
}): StaffReturnResponse {
  return {
    ...toReturnResponse(view),
    staffNote: view.header.staffNote,
    lines: view.lines.map((line) => ({
      ...toReturnLineResponse(line),
      restockQuantity: line.restockQuantity,
      writeOffQuantity: line.writeOffQuantity,
    })),
  };
}

/* ── Admin queue and detail. Increment 61. ───────────────────────────────── */

/**
 * The customer, as an admin surface names them.
 *
 * Email and the two name parts, and nothing else. **No `id`** — no internal UUID reaches any
 * response in this API, and an admin looking a customer up has their email.
 */
export type ReturnCustomerResponse = {
  email: string;
  firstName: string;
  lastName: string;
};

const toReturnCustomerResponse = (header: {
  readonly customerEmail: string;
  readonly customerFirstName: string;
  readonly customerLastName: string;
}): ReturnCustomerResponse => ({
  email: header.customerEmail,
  firstName: header.customerFirstName,
  lastName: header.customerLastName,
});

/** One row of the admin queue: enough to triage without opening the detail page. */
export type StaffReturnListItemResponse = StaffReturnResponse & {
  customer: ReturnCustomerResponse;
};

export function toStaffReturnListItemResponse(view: {
  readonly header: MappableReturn & {
    readonly staffNote: string;
    readonly customerEmail: string;
    readonly customerFirstName: string;
    readonly customerLastName: string;
  };
  readonly lines: readonly (MappableReturnLine & {
    readonly restockQuantity: number;
    readonly writeOffQuantity: number;
  })[];
}): StaffReturnListItemResponse {
  return { ...toStaffReturnResponse(view), customer: toReturnCustomerResponse(view.header) };
}

/**
 * The address the parcel is coming back from.
 *
 * The ORDER'S SNAPSHOT, never the live address row — the orders schema states the rule: *"the
 * moment a past invoice reads a live address, a customer fixing a typo rewrites history"*. A
 * return is about a parcel that was sent somewhere specific.
 */
export type ReturnAddressResponse = {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
};

/**
 * One entry of the append-only lifecycle history.
 *
 * `actorType` only — never the actor's user id. Who a staff decision belongs to is an audit
 * question answered in `audit_log`, and publishing internal user ids on a read that a wide set
 * of staff can see is a disclosure with no operational benefit.
 */
export type ReturnEventResponse = {
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  note: string;
  at: string;
};

/** A refund raised for this return, as the detail shows it. Shape mirrors the payments DTO. */
export type ReturnRefundResponseItem = {
  refundNumber: string;
  status: string;
  mode: string;
  amount: string;
  currency: string;
  failureCode: string | null;
  createdAt: string;
  settledAt: string | null;
};

export type StaffReturnDetailResponse = StaffReturnResponse & {
  customer: ReturnCustomerResponse;
  shippingAddress: ReturnAddressResponse;
  deliveredAt: string;
  timeline: ReturnEventResponse[];
  refunds: ReturnRefundResponseItem[];
  lines: (StaffReturnLineResponse & { productName: string; remainingReturnable: number })[];
};

export function toStaffReturnDetailResponse(view: {
  readonly header: MappableReturn & {
    readonly staffNote: string;
    readonly deliveredAt: Date;
    readonly customerEmail: string;
    readonly customerFirstName: string;
    readonly customerLastName: string;
    readonly shipRecipientName: string;
    readonly shipPhone: string;
    readonly shipLine1: string;
    readonly shipLine2: string;
    readonly shipLandmark: string;
    readonly shipCity: string;
    readonly shipState: string;
    readonly shipPostalCode: string;
    readonly shipCountryCode: string;
  };
  readonly lines: readonly (MappableReturnLine & {
    readonly skuId: string;
    readonly productName: string;
    readonly restockQuantity: number;
    readonly writeOffQuantity: number;
  })[];
  readonly events: readonly {
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly actorType: string;
    readonly note: string;
    readonly createdAt: Date;
  }[];
  readonly refunds: readonly {
    readonly refundNumber: string;
    readonly status: string;
    readonly mode: string;
    readonly amount: string;
    readonly currency: string;
    readonly failureCode: string | null;
    readonly createdAt: Date;
    readonly settledAt: Date | null;
  }[];
  readonly remainingBySkuId: ReadonlyMap<string, number>;
}): StaffReturnDetailResponse {
  const base = toStaffReturnResponse(view);

  return {
    ...base,
    customer: toReturnCustomerResponse(view.header),
    shippingAddress: {
      recipientName: view.header.shipRecipientName,
      phone: view.header.shipPhone,
      line1: view.header.shipLine1,
      line2: view.header.shipLine2,
      landmark: view.header.shipLandmark,
      city: view.header.shipCity,
      state: view.header.shipState,
      postalCode: view.header.shipPostalCode,
      countryCode: view.header.shipCountryCode,
    },
    /* The delivery fact the return window was measured from. Already on the header. */
    deliveredAt: view.header.deliveredAt.toISOString(),
    timeline: view.events.map((e) => ({
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorType: e.actorType,
      note: e.note,
      at: e.createdAt.toISOString(),
    })),
    refunds: view.refunds.map((r) => ({
      refundNumber: r.refundNumber,
      status: r.status,
      mode: r.mode,
      amount: r.amount,
      currency: r.currency,
      failureCode: r.failureCode,
      createdAt: r.createdAt.toISOString(),
      settledAt: r.settledAt === null ? null : r.settledAt.toISOString(),
    })),
    /*
     * `remainingBySkuId` is keyed by SKU id INTERNALLY and projected here by position, so the
     * id never reaches the response — the line already publishes `skuCode`, which is what a
     * client addresses a SKU by everywhere else in this API.
     */
    lines: view.lines.map((line, index) => ({
      ...base.lines[index]!,
      productName: line.productName,
      remainingReturnable: view.remainingBySkuId.get(line.skuId) ?? 0,
    })),
  };
}

/* ── Inspection. Increment 59. ───────────────────────────────────────────── */

/**
 * The inspection result for ONE returned line.
 *
 * Counts rather than a verdict, because a single line legitimately splits: three jars came
 * back, one smashed. A label would force staff to either lie about the good two or raise a
 * second return for the broken one.
 *
 * The SKU **code**, never an id — every other return field a client sees is addressed the same
 * way, and internal ids are published nowhere in this API.
 *
 * Both counts are required rather than defaulted. A default of zero would let a client submit
 * `{ skuCode }` and have the service silently write off nothing and restock nothing, which is a
 * decision nobody made; the service then refuses the line because the two do not sum to what
 * came back, but the 400 that names the missing field is a better answer than a 422 about
 * arithmetic.
 */
const InspectionLineSchema = z.strictObject({
  skuCode: skuCodeField,
  restockQuantity: z.int().min(0).max(999),
  writeOffQuantity: z.int().min(0).max(999),
});

/**
 * The inspection body. Every line of the return, exactly once.
 *
 * Non-empty because a return always has at least one line, so an empty array is a client bug
 * rather than "inspect nothing". The completeness rule — every line present, each one's counts
 * summing to the quantity that came back — is the service's, because only it can see what the
 * return actually contains; Zod enforces the shape, the service enforces the arithmetic.
 */
export const InspectReturnRequestSchema = z.strictObject({
  lines: z.array(InspectionLineSchema).min(1).max(100),
  staffNote: z.string().trim().max(500).optional(),
});

export type InspectReturnRequest = z.infer<typeof InspectReturnRequestSchema>;

/**
 * A refund as the returns screens show it.
 *
 * The public **number**, never the refund's UUID, matching how every other aggregate in this
 * API is addressed. `providerRefundId` is included because a merchant reconciling against the
 * gateway dashboard needs it and it is not a secret — it is an opaque identifier the provider
 * itself displays. The payment id, the order id and the internal refund id are all absent.
 */
export type ReturnRefundResponse = {
  refundNumber: string;
  status: string;
  mode: string;
  amount: string;
  currency: string;
  providerRefundId: string | null;
  failureCode: string | null;
  createdAt: string;
  settledAt: string | null;
};

export function toReturnRefundResponse(record: {
  readonly refundNumber: string;
  readonly status: string;
  readonly mode: string;
  readonly amount: string;
  readonly currency: string;
  readonly providerRefundId: string | null;
  readonly failureCode: string | null;
  readonly createdAt: Date;
  readonly settledAt: Date | null;
}): ReturnRefundResponse {
  return {
    refundNumber: record.refundNumber,
    status: record.status,
    mode: record.mode,
    amount: record.amount,
    currency: record.currency,
    providerRefundId: record.providerRefundId,
    failureCode: record.failureCode,
    createdAt: record.createdAt.toISOString(),
    settledAt: record.settledAt === null ? null : record.settledAt.toISOString(),
  };
}
