import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

import type { Config } from '../../config.js';

/**
 * API documentation.
 *
 * Lives in `http/routes/` beside `health.ts` rather than in a top-level `src/docs/`, because
 * an OpenAPI document describes the HTTP surface and nothing else — it is an HTTP-layer
 * concern, and putting it here means `app.ts` mounts it the same way it already mounts health
 * instead of learning a new pattern.
 *
 * It imports NO domain module. The spec is a static document, so this file cannot drift into
 * depending on a service; the drift risk is that the document stops describing the routes,
 * which is what `__tests__/docs.integration.test.ts` guards.
 *
 * The spec is hand-written rather than generated from the Zod schemas. Generating it would
 * need a `zod-to-openapi` dependency, and the schemas carry deliberate subtleties a generator
 * flattens badly — login's password bounds are not registration's, and `strictObject` means
 * `additionalProperties: false`, which matters to a client and is easy to lose in translation.
 */

/** The error envelope every failure uses. Defined once and referenced by every response. */
const ERROR_ENVELOPE = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: {
          type: 'string',
          description: 'Stable machine-readable code. Switch on this, never on `message`.',
          example: 'INVALID_CREDENTIALS',
        },
        message: { type: 'string', example: 'Email or password is incorrect.' },
        field: {
          type: 'string',
          description: 'Present when the error is attributable to one request field.',
        },
        details: {
          type: 'object',
          additionalProperties: true,
          description: 'Machine-readable context. For validation errors, `details.fields`.',
        },
        requestId: {
          type: 'string',
          description: 'Echoed in the `X-Request-Id` header. Quote this when reporting a fault.',
          example: '2ccb5503-eacc-4f98-b17e-0a0daec1ce71',
        },
      },
    },
  },
} as const;

/**
 * Validation patterns, kept as constants so the documented regex and the prose describing it
 * cannot drift apart within this file.
 *
 * They mirror `slugField` and `priceField` in `modules/catalogue/dto.ts`. Duplicated rather
 * than imported: `no-http-to-modules` forbids this file from reaching into the catalogue, and
 * a published API contract that silently followed an internal refactor would be worse than one
 * that has to be updated deliberately. The docs test asserts the endpoint stays reachable; a
 * pattern drift is caught by the DTO's own tests rejecting what the spec advertises.
 */
const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const PRICE_PATTERN = '^\\d{1,15}(?:\\.\\d{1,4})?$';

/**
 * Pagination bounds, duplicated from `modules/catalogue/dto.ts`.
 *
 * `no-http-to-modules` forbids this file from importing the catalogue, and a published API
 * contract that silently followed an internal refactor would be worse than one that has to be
 * updated deliberately. The drift risk is bounded: the DTO's own tests reject a limit the spec
 * advertises as valid, and vice versa.
 */
/**
 * The refund number's shape, duplicated from `modules/payments/dto.ts` for the reason the
 * pagination limits below are: `no-http-to-modules` forbids the import.
 */
const REFUND_NUMBER_PATTERN = '^RFD-\\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$';

const PRODUCT_LIST_DEFAULT_LIMIT_DOC = 20;
const PRODUCT_LIST_MAX_LIMIT_DOC = 100;

/** Offset pagination metadata. Mirrors `PaginationResponse` in `modules/catalogue/dto.ts`. */
const PAGINATION = {
  type: 'object',
  required: ['limit', 'offset', 'total'],
  properties: {
    limit: { type: 'integer', description: 'The page size actually applied.', example: 20 },
    offset: { type: 'integer', example: 0 },
    total: {
      type: 'integer',
      description:
        'Rows matching the same visibility rules as the page — this store only, excluding deleted products.',
      example: 123,
    },
  },
} as const;

/**
 * The public shape of a SKU. Mirrors `SkuResponse` in `modules/catalogue/dto.ts`.
 *
 * Duplicated from the DTO rather than imported: `no-http-to-modules` forbids this file from
 * reaching into a domain module, for the same reason the patterns above are duplicated — a
 * published contract that silently followed an internal refactor is worse than one that has
 * to be updated deliberately.
 */
const SKU = {
  type: 'object',
  required: [
    'id',
    'productId',
    'code',
    'name',
    'price',
    'isActive',
    'lowStockThreshold',
    'options',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33' },
    productId: { type: 'string', format: 'uuid' },
    code: {
      type: 'string',
      maxLength: 64,
      description:
        "The merchant's own code. Unique per store among non-deleted SKUs, and case-SENSITIVE — unlike a slug, ABC-1 and abc-1 are different codes.",
      example: 'SHIRT-BLUE-M',
    },
    name: {
      type: 'string',
      maxLength: 300,
      description: 'A short display label, e.g. "Medium". Empty when the merchant set none.',
      example: 'Medium',
    },
    price: {
      type: 'string',
      description:
        'Decimal string at the storage scale of 4. Never a JSON number. In the STORE currency reported on the product.',
      example: '1499.0000',
    },
    isActive: {
      type: 'boolean',
      description:
        'Whether this SKU is currently sellable. A product with no active SKU is not publicly visible at all.',
      example: true,
    },
    lowStockThreshold: {
      description: [
        'The reorder point: at or below this, the dashboard reports the SKU as low.',
        '',
        '**`null` means no threshold is configured, which is NOT the same as `0`.** A SKU with no',
        'threshold is never reported as low, however little of it is left — nobody has said what',
        '"low" means for it. `0` is a configured value that says "warn me only when this is gone",',
        'which the `available > 0` half of the low-stock rule then makes unreachable.',
        '',
        'Low stock and out of stock stay distinguishable: `available <= 0` is unsellable and is a',
        'different fact from `available > 0 AND available <= lowStockThreshold`.',
      ].join('\n'),
      oneOf: [{ type: 'integer', minimum: 0, maximum: 1000000 }, { type: 'null' }],
      example: 5,
    },
    options: {
      type: 'array',
      description:
        "The SKU's variant combination — one entry per option, empty for an option-less SKU. Flat pairs rather than nested, because a SKU carries exactly one value per option. The internal option_signature is never exposed.",
      items: { $ref: '#/components/schemas/SkuOption' },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** One (option, value) pair on a SKU. Mirrors `SkuOptionResponse`. */
const SKU_OPTION = {
  type: 'object',
  required: ['optionId', 'optionName', 'optionSortOrder', 'valueId', 'value', 'valueSortOrder'],
  properties: {
    optionId: { type: 'string', format: 'uuid' },
    optionName: { type: 'string', maxLength: 120, example: 'Size' },
    optionSortOrder: { type: 'integer', example: 0 },
    valueId: { type: 'string', format: 'uuid' },
    value: { type: 'string', maxLength: 120, example: 'Medium' },
    valueSortOrder: { type: 'integer', example: 1 },
  },
} as const;

/** One selectable value of an option. Mirrors `OptionValueResponse`. */
const OPTION_VALUE = {
  type: 'object',
  required: ['id', 'value', 'sortOrder', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    value: {
      type: 'string',
      maxLength: 120,
      description:
        'Case is preserved as the merchant typed it. Uniqueness within the option ignores case, enforced by a lower(value) unique index.',
      example: 'Medium',
    },
    sortOrder: {
      type: 'integer',
      description:
        'Display order. S/M/L is not alphabetical, so an explicit order is the only correct one. Ties are broken by id, so the ordering is total.',
      example: 1,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** A product option with its values nested. Mirrors `OptionResponse`. */
const OPTION = {
  type: 'object',
  required: ['id', 'productId', 'name', 'sortOrder', 'values', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    productId: { type: 'string', format: 'uuid' },
    name: {
      type: 'string',
      maxLength: 120,
      description:
        'The option label. Unique per product among non-deleted options, compared CASE-INSENSITIVELY — the opposite of a SKU code, because this is a display label rather than an identifier printed on a packing slip.',
      example: 'Size',
    },
    sortOrder: { type: 'integer', example: 0 },
    values: {
      type: 'array',
      description:
        'The option’s selectable values, nested. Possibly empty: an option with no values yet is a legitimate intermediate state. There is no separate values endpoint.',
      items: { $ref: '#/components/schemas/OptionValue' },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** One SKU's current stock. Mirrors `StockResponse` in `modules/inventory/dto.ts`. */
const STOCK_ITEM = {
  type: 'object',
  required: ['skuId', 'skuCode', 'onHand', 'reserved', 'available', 'createdAt', 'updatedAt'],
  properties: {
    skuId: { type: 'string', format: 'uuid' },
    skuCode: { type: 'string', maxLength: 64, example: 'SHIRT-BLUE-M' },
    onHand: {
      type: 'integer',
      minimum: 0,
      description:
        'Units physically held. A whole number: inventory is counted in units, and fractional quantities are out of scope.',
      example: 42,
    },
    reserved: {
      type: 'integer',
      minimum: 0,
      description:
        'Units promised but not yet shipped. Always 0 in this version — no endpoint writes it, and reservation is a later feature.',
      example: 0,
    },
    available: {
      type: 'integer',
      minimum: 0,
      description:
        'on_hand minus reserved, computed by the database as a generated column. It is the single authoritative definition of availability and cannot be written directly.',
      example: 42,
    },
    createdAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the stock record was initialised — NOT when stock first arrived. Initialisation records that the system has not yet been told this SKU\u2019s stock.',
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** One entry in the append-only stock ledger. Mirrors `StockLedgerResponse`. */
const STOCK_ADJUSTMENT = {
  type: 'object',
  required: [
    'id',
    'skuId',
    'delta',
    'onHandBefore',
    'onHandAfter',
    'reason',
    'note',
    'actorUserId',
    'requestId',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    skuId: { type: 'string', format: 'uuid' },
    delta: {
      type: 'integer',
      description: 'Signed change in units. Never zero.',
      example: -3,
    },
    onHandBefore: { type: 'integer', minimum: 0, example: 45 },
    onHandAfter: {
      type: 'integer',
      minimum: 0,
      description: 'Always equals onHandBefore + delta; the database enforces it.',
      example: 42,
    },
    reason: {
      type: 'string',
      enum: ['manual_increase', 'manual_decrease', 'correction'],
      description:
        'A TECHNICAL vocabulary describing the mechanism of the change. Accounting classifications (damage, theft, write-off, expiry) are deliberately absent: each determines how a loss is posted and taxed, which is an accounting determination.',
      example: 'manual_decrease',
    },
    note: {
      type: 'string',
      maxLength: 500,
      description: 'Free text from the operator. Empty when none was given.',
      example: 'Counted during the Friday stocktake.',
    },
    actorUserId: {
      type: 'string',
      format: 'uuid',
      description:
        'The staff member who made the adjustment, taken from the verified access token. Never accepted from the request.',
    },
    requestId: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      description:
        'Correlates this entry with the request that caused it, and with the matching audit record.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * The public shape of a customer address. Mirrors `AddressResponse` in
 * `modules/addresses/dto.ts`.
 *
 * Note what is NOT here: `userId`, `storeId` and `deletedAt`. Ownership and tenancy are
 * invariants of the query rather than fields a client inspects, and a deleted address is never
 * returned at all.
 */
const ADDRESS = {
  type: 'object',
  required: [
    'id',
    'label',
    'recipientName',
    'phone',
    'line1',
    'line2',
    'landmark',
    'city',
    'state',
    'postalCode',
    'countryCode',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    label: {
      type: 'string',
      maxLength: 60,
      description:
        "The customer's own name for this address. Not unique: two addresses called Home are the customer's business.",
      example: 'Home',
    },
    recipientName: {
      type: 'string',
      maxLength: 300,
      description:
        'Who receives the parcel. ONE field, not a first/last split: the recipient is frequently not the account holder, and Indian names do not divide reliably into two columns.',
      example: 'Ada Lovelace',
    },
    phone: {
      type: 'string',
      maxLength: 20,
      description:
        'The delivery contact — whoever the courier should call, which may not be the account holder. Deliberately unrelated to the account phone.',
      example: '+91 98765 43210',
    },
    line1: { type: 'string', maxLength: 300, example: '221B, Brigade Road' },
    line2: {
      type: 'string',
      maxLength: 300,
      description: 'Empty string when the customer set none, never null.',
      example: 'Shanthala Nagar',
    },
    landmark: {
      type: 'string',
      maxLength: 300,
      description: 'Empty string when none. Ubiquitous in Indian addresses.',
      example: 'Opposite the water tank',
    },
    city: { type: 'string', maxLength: 120, example: 'Bengaluru' },
    state: {
      type: 'string',
      maxLength: 120,
      description:
        'Required and free text. Required because GST place-of-supply will compare it to the seller state; free text because a GST state-code catalogue is not part of this version.',
      example: 'Karnataka',
    },
    postalCode: {
      type: 'string',
      maxLength: 16,
      description:
        'For countryCode IN, exactly six digits not starting with zero. Other countries are bounded but not format-checked.',
      example: '560001',
    },
    countryCode: {
      type: 'string',
      minLength: 2,
      maxLength: 2,
      description:
        'ISO-3166-1 alpha-2, uppercased on the way in. The shape is validated; membership of a country list deliberately is not.',
      example: 'IN',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** One line of an order, exactly as it was snapshotted. Mirrors `OrderItemResponse`. */
const ORDER_LINE = {
  type: 'object',
  required: [
    'skuCode',
    'skuName',
    'productName',
    'quantity',
    'unitPrice',
    'lineTotal',
    'discountAmount',
    'tax',
  ],
  properties: {
    skuCode: {
      type: 'string',
      maxLength: 64,
      description:
        'The SKU code AS IT WAS at checkout. A snapshot: recoding the SKU afterwards does not change it.',
      example: 'SHIRT-BLUE-M',
    },
    skuName: { type: 'string', maxLength: 300, example: 'Medium' },
    productName: {
      type: 'string',
      maxLength: 300,
      description:
        'The product name as it was at checkout. Renaming the product afterwards does not change a past order — that is the whole reason order lines carry copies rather than joins.',
      example: 'Blue Cotton Shirt',
    },
    quantity: { type: 'integer', minimum: 1, maximum: 999, example: 2 },
    unitPrice: {
      type: 'string',
      description:
        "The SKU's price AT CHECKOUT, as a decimal string. Never a JSON number, and never re-read from the live catalogue.",
      example: '1499.0000',
    },
    lineTotal: {
      type: 'string',
      description:
        'unitPrice x quantity — the PRE-discount merchandise value of this line. Never a JSON number.',
      example: '2998.0000',
    },
    discountAmount: {
      type: 'string',
      description:
        "This line's allocated share of the order's cart-level discount, distributed by the largest-remainder method so the parts sum exactly to discountTotal. So a line's net value is (lineTotal - discountAmount) — which IS the taxable value, computed before tax and reported below.",
      example: '299.8000',
    },
    tax: {
      description:
        'The line\u2019s GST breakdown, or null when the order carried no determination. Never a block of zeros standing in for "not assessed".',
      oneOf: [{ $ref: '#/components/schemas/OrderLineTax' }, { type: 'null' }],
    },
  },
} as const;

/** The delivery address as it was at checkout. Mirrors `OrderAddressResponse`. */
const ORDER_ADDRESS = {
  type: 'object',
  required: [
    'recipientName',
    'phone',
    'line1',
    'line2',
    'landmark',
    'city',
    'state',
    'postalCode',
    'countryCode',
  ],
  properties: {
    recipientName: { type: 'string', maxLength: 300, example: 'Ada Lovelace' },
    phone: { type: 'string', maxLength: 20, example: '+91 98765 43210' },
    line1: { type: 'string', maxLength: 300, example: '221B, Brigade Road' },
    line2: { type: 'string', maxLength: 300, example: 'Shanthala Nagar' },
    landmark: { type: 'string', maxLength: 300, example: 'Opposite the water tank' },
    city: { type: 'string', maxLength: 120, example: 'Bengaluru' },
    state: { type: 'string', maxLength: 120, example: 'Karnataka' },
    postalCode: { type: 'string', maxLength: 16, example: '560001' },
    countryCode: { type: 'string', minLength: 2, maxLength: 2, example: 'IN' },
  },
  description:
    "A COPY taken at checkout, not a reference. Editing or deleting the address afterwards leaves this untouched — a customer fixing a typo must not rewrite a past invoice. The address's own label is deliberately not copied: it is a private filing nickname, not part of a delivery record.",
} as const;

/** The promotion that discounted an order. Mirrors `OrderPromotionResponse`. */
const ORDER_PROMOTION = {
  type: 'object',
  required: ['code', 'name'],
  properties: {
    code: { type: 'string', maxLength: 64, example: 'SAVE10' },
    name: { type: 'string', maxLength: 300, example: 'Festive 10% off' },
  },
  description:
    'Snapshotted, so a historical order can still name the offer after the merchant renames or deletes it. Never the promotion id or its terms.',
} as const;

/**
 * A money KPI and the equal-length window before it. Increment 57.
 *
 * Both values are decimal strings at `NUMERIC(19,4)` scale, never JSON numbers: money never
 * becomes binary floating point anywhere in this API.
 */
const DASHBOARD_KPI_MONEY = {
  type: 'object',
  required: ['value', 'currency', 'previous'],
  properties: {
    value: { type: 'string', example: '482300.0000' },
    currency: { type: 'string', example: 'INR' },
    previous: {
      type: 'string',
      example: '410150.0000',
      description:
        'The same figure over the equal-DURATION window immediately before this one, ending one millisecond before `from`. No overlap and no gap.',
    },
  },
} as const;

/** A counted KPI. `previous` is null where no comparison exists. */
const DASHBOARD_KPI_COUNT = {
  type: 'object',
  required: ['value', 'previous'],
  properties: {
    value: { type: 'integer', minimum: 0 },
    previous: {
      description:
        'Null for products and customers, which are cumulative as-of-now facts with no recorded history — there is no product status history and no customer count snapshot, so a previous value could only be invented. Null says "no comparison exists", which a client can render differently from a zero delta.',
      oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
    },
  },
} as const;

/** One point on the sales chart. Every bucket in the window is present, including empty ones. */
const DASHBOARD_SERIES_POINT = {
  type: 'object',
  required: ['bucket', 'revenue', 'orders'],
  properties: {
    bucket: {
      type: 'string',
      format: 'date',
      example: '2026-09-01',
      description:
        'The first local date of the bucket, truncated in the STORE’s timezone — not UTC. Bucketing a month in UTC misfiles every order placed after 18:30 IST on the last day of it.',
    },
    revenue: { type: 'string', example: '0.0000' },
    orders: { type: 'integer', minimum: 0 },
  },
} as const;

/** One row of the top-selling list, by SNAPSHOTTED product identity. */
const DASHBOARD_TOP_PRODUCT = {
  type: 'object',
  required: ['skuCode', 'productName', 'skuName', 'quantitySold', 'revenue'],
  description:
    'Grouped by the product and SKU names SNAPSHOTTED onto the order line at checkout, never by joining today’s catalogue. Renaming a product does not rewrite what it was called when it sold.',
  properties: {
    skuCode: { type: 'string', example: 'PUMP-2HP-BLK' },
    productName: { type: 'string', example: 'Duroflo 2HP Pump' },
    skuName: { type: 'string', example: '2 HP / Black' },
    quantitySold: { type: 'integer', minimum: 0 },
    revenue: {
      type: 'string',
      example: '168000.0000',
      description:
        'The lines’ contribution to the orders’ payable totals: `taxableValue + taxTotal`, where `taxableValue` is already `lineTotal - discountAmount`. Discounts deducted, tax included, cancelled orders excluded.',
    },
  },
} as const;

/** One SKU running low against its own configured reorder point. */
const DASHBOARD_LOW_STOCK = {
  type: 'object',
  required: ['skuCode', 'productName', 'skuName', 'onHand', 'reserved', 'available', 'threshold'],
  description:
    'Still sellable, but at or below its threshold: `available > 0 AND available <= lowStockThreshold`. A SKU with NO threshold configured never appears — "low" is not invented for anybody who has not defined it. Out of stock (`available <= 0`) keeps its own separate meaning and its own tile.',
  properties: {
    skuCode: { type: 'string', example: 'PUMP-1HP-RED' },
    productName: { type: 'string', example: 'Duroflo 1HP Pump' },
    skuName: { type: 'string', example: '1 HP / Red' },
    onHand: { type: 'integer', minimum: 0 },
    reserved: {
      type: 'integer',
      minimum: 0,
      description: 'Units committed to open orders and not yet despatched.',
    },
    available: {
      type: 'integer',
      description: 'PostgreSQL-generated `onHand - reserved`. Never computed by the application.',
    },
    threshold: { type: 'integer', minimum: 0, example: 10 },
  },
} as const;

/** One payment transition. Mirrors `PaymentEventResponse` in `modules/payments/dto.ts`. */
const PAYMENT_EVENT = {
  type: 'object',
  required: ['fromStatus', 'toStatus', 'eventType', 'occurredAt'],
  properties: {
    fromStatus: {
      type: 'string',
      nullable: true,
      enum: ['pending', 'succeeded', 'failed', 'expired', null],
      description: 'Null on the creation row, which has no prior state.',
    },
    toStatus: {
      type: 'string',
      enum: ['pending', 'succeeded', 'failed', 'expired'],
    },
    eventType: {
      type: 'string',
      maxLength: 128,
      description:
        "What caused the transition, in the provider's vocabulary for a gateway-driven row and ours otherwise. A name only — no notification body is ever persisted or published.",
      example: 'payment.captured',
    },
    occurredAt: { type: 'string', format: 'date-time' },
  },
  description:
    'Append-only. Every transition is a row and no UPDATE rewrites the past, so this is the full, ordered history of the payment.',
} as const;

/** A payment. Mirrors `PaymentResponse` in `modules/payments/dto.ts`. */
const PAYMENT = {
  type: 'object',
  required: [
    'orderNumber',
    'method',
    'provider',
    'status',
    'currency',
    'amount',
    'failureCode',
    'createdAt',
    'updatedAt',
    'history',
  ],
  properties: {
    orderNumber: {
      type: 'string',
      maxLength: 64,
      description: 'The order this payment is for. The internal payment id is never published.',
      example: 'ORD-20260904-7QK4M2',
    },
    method: {
      type: 'string',
      enum: ['online', 'cod'],
      description:
        'How the customer chose to pay. `online` goes through the configured gateway; `cod` is cash on delivery and never reaches one. A BUSINESS method, deliberately not a provider name.',
      example: 'online',
    },
    provider: {
      type: 'string',
      nullable: true,
      description:
        'Which gateway handled it, or null for COD. A separate axis from `method` so that "how did the customer pay" and "which gateway processed it" stay distinct questions.',
      example: 'razorpay',
    },
    status: {
      type: 'string',
      enum: ['pending', 'succeeded', 'failed', 'expired'],
      description:
        '**Payment state is not order state.** `order.status` stays `placed` regardless of what happens here — the two lifecycles are deliberately separate. `pending` is the only non-terminal state; the other three are terminal and, in this version, absorbing: there is no retry, so nothing leaves them. `expired` is part of the approved lifecycle but nothing in this version writes it, because no expiry window has been set.',
      example: 'pending',
    },
    currency: {
      type: 'string',
      minLength: 3,
      maxLength: 3,
      description: 'Copied from the order. A payment is never in a currency the order was not.',
      example: 'INR',
    },
    amount: {
      type: 'string',
      description:
        '**Exactly `order.total`, copied at initiation. The client cannot supply or influence it** — a request carrying an amount is rejected as an unknown field. Never a JSON number.',
      example: '2698.2000',
    },
    failureCode: {
      type: 'string',
      nullable: true,
      maxLength: 64,
      description:
        "A normalised DOMAIN code, present only on a failed payment. Never the gateway's own error string: that vocabulary is the provider's, changes outside our release cycle, and is not something a client should branch on.",
      example: 'declined',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    history: { type: 'array', items: PAYMENT_EVENT },
  },
  description:
    'One payment per order, enforced by a unique constraint. No card, UPI, bank or token field exists anywhere in this object or in the table behind it — instrument data never reaches this system.',
} as const;

/** The provider handoff. Mirrors `PaymentHandoffResponse` in `modules/payments/dto.ts`. */
const PAYMENT_HANDOFF = {
  type: 'object',
  required: ['provider', 'providerRef', 'publicKey'],
  properties: {
    provider: { type: 'string', example: 'razorpay' },
    providerRef: {
      type: 'string',
      maxLength: 255,
      description:
        "The gateway's own identifier for this payment, which its client-side checkout needs. Opaque to this API.",
      example: 'order_MgkA9Nn1BqLmXy',
    },
    publicKey: {
      type: 'string',
      nullable: true,
      description:
        "The gateway's PUBLISHABLE key, designed to be sent to a browser. The secret it pairs with never leaves the server, and no field here could carry one.",
    },
  },
  description:
    'Present only on the 201 that created an `online` payment. Absent for COD, which has nothing to hand off.',
} as const;

/**
 * One line's GST breakdown, exactly as it was snapshotted at checkout.
 *
 * Mirrors `OrderItemTaxResponse`. Every figure is a decimal STRING and none of it is
 * recomputed on read — a rate change, a reclassification or a renamed tax class cannot alter
 * any value here.
 */
const ORDER_LINE_TAX = {
  type: 'object',
  required: [
    'taxableValue',
    'hsnCode',
    'taxClassCode',
    'taxClassName',
    'cgstRate',
    'cgstAmount',
    'sgstRate',
    'sgstAmount',
    'igstRate',
    'igstAmount',
    'cessRate',
    'cessAmount',
    'taxTotal',
  ],
  properties: {
    taxableValue: {
      type: 'string',
      description:
        'lineTotal minus discountAmount — the value the rates below were applied to. The discount is allocated BEFORE tax, so this needs no re-allocation and cannot disagree with the header. Never a JSON number.',
      example: '2698.2000',
    },
    hsnCode: {
      type: 'string',
      maxLength: 16,
      description:
        'The HSN or SAC code AS IT WAS at checkout. A snapshot: reclassifying the SKU afterwards does not change it.',
      example: '6205',
    },
    taxClassCode: {
      type: 'string',
      maxLength: 64,
      description: 'The tax class code at checkout. Text, not a reference — see hsnCode.',
      example: 'GST-STD',
    },
    taxClassName: { type: 'string', maxLength: 300, example: 'Standard rate' },
    cgstRate: {
      type: 'string',
      description:
        'The CGST percentage applied, as a decimal string. Zero for an inter-state supply, where IGST applies instead — a line never carries both.',
      example: '9.000000',
    },
    cgstAmount: { type: 'string', description: 'Never a JSON number.', example: '242.84' },
    sgstRate: { type: 'string', example: '9.000000' },
    sgstAmount: { type: 'string', example: '242.84' },
    igstRate: {
      type: 'string',
      description: 'The IGST percentage. Zero for an intra-state supply.',
      example: '0.000000',
    },
    igstAmount: { type: 'string', example: '0.00' },
    cessRate: {
      type: 'string',
      description: 'Cess, where the class attracts one. Accompanies either supply type.',
      example: '0.000000',
    },
    cessAmount: { type: 'string', example: '0.00' },
    taxTotal: {
      type: 'string',
      description:
        'The sum of the four amounts above, exactly — enforced in the database, so a stored total can never disagree with its own components.',
      example: '485.68',
    },
  },
} as const;

/**
 * The order-level GST determination. Mirrors `OrderTaxResponse`.
 *
 * Deliberately narrow: what was charged and where the supply was made. The seller's origin
 * ADDRESS is snapshotted on the order but is not published — a customer needs the supply's
 * place, not the merchant's premises.
 */
const ORDER_TAX = {
  type: 'object',
  required: [
    'supplyType',
    'placeOfSupply',
    'sellerGstin',
    'sellerLegalName',
    'customerTaxCategory',
    'customerGstin',
    'taxedAt',
  ],
  properties: {
    supplyType: {
      type: 'string',
      enum: ['intra_state', 'inter_state'],
      description:
        'intra_state carries CGST + SGST; inter_state carries IGST. Decided by comparing the seller origin state with the place of supply. There is deliberately no export, sez or exempt value — each is a statutory classification with its own determination rules, and a value nothing can produce looks supported to every reader.',
      example: 'intra_state',
    },
    placeOfSupply: {
      type: 'string',
      maxLength: 120,
      description:
        'The state where the supply was made, normalised (trimmed, whitespace collapsed, lower-cased) — stored exactly as it was compared, so a determination can be explained after the fact. Based on the delivery destination for the ordinary domestic goods flow.',
      example: 'karnataka',
    },
    sellerGstin: {
      type: 'string',
      maxLength: 15,
      description:
        "The STORE's GSTIN at the moment of supply — the store is the seller of record, not the platform. A snapshot: the merchant re-registering does not restate a past order.",
      example: '29ABCDE1234F1Z5',
    },
    sellerLegalName: { type: 'string', maxLength: 300, example: 'Example Retail Private Limited' },
    customerTaxCategory: {
      type: 'string',
      enum: ['b2b', 'b2c'],
      description:
        'b2b when a valid customer GSTIN was supplied for the transaction, b2c otherwise. No third value: no unregistered, government or composition category is inferred.',
      example: 'b2c',
    },
    customerGstin: {
      description:
        "The customer's GSTIN as it was at checkout, or null for b2c. Editing or removing the registration afterwards does not change a past order.",
      oneOf: [{ type: 'string', maxLength: 15 }, { type: 'null' }],
    },
    taxedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'The authoritative tax instant: the moment the determination was made and the instant the effective-dated rate was selected against. For COD this is checkout, and does NOT wait for a payment that by design never succeeds.',
    },
  },
} as const;

/** A tax class. Mirrors `TaxClassResponse`. No id: a class is addressed by code. */
const TAX_CLASS = {
  type: 'object',
  required: ['code', 'name', 'isActive', 'createdAt', 'updatedAt'],
  properties: {
    code: {
      type: 'string',
      maxLength: 64,
      description:
        "The merchant's own classification code, case-SENSITIVE. Immutable after creation: every order line that used the class carries it as a snapshot, so renaming would leave historical invoices naming a code the admin surface no longer has.",
      example: 'GST-STD',
    },
    name: { type: 'string', maxLength: 300, example: 'Standard rate' },
    isActive: {
      type: 'boolean',
      description:
        'Whether new checkouts may resolve this class. Deactivating does not touch a historical order, but it makes every SKU pointing here UNSELLABLE in a store with a GST profile — checkout refuses the line rather than assessing it at zero.',
      example: true,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** One effective-dated rate set. Mirrors `TaxRateResponse`. */
const TAX_RATE = {
  type: 'object',
  required: [
    'cgstRate',
    'sgstRate',
    'igstRate',
    'cessRate',
    'effectiveFrom',
    'effectiveTo',
    'createdAt',
  ],
  properties: {
    cgstRate: {
      type: 'string',
      description: 'A percentage, as a decimal string.',
      example: '9.000000',
    },
    sgstRate: { type: 'string', example: '9.000000' },
    igstRate: { type: 'string', example: '18.000000' },
    cessRate: { type: 'string', example: '0.000000' },
    effectiveFrom: {
      type: 'string',
      format: 'date-time',
      description: 'Inclusive. Compared against the order\u2019s tax instant, never against now().',
    },
    effectiveTo: {
      description:
        'EXCLUSIVE, or null for open-ended. Half-open, so a rate ending at midnight does not also apply at midnight. At most one open-ended window may exist per class.',
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * The seller's GST identity and origin address. Mirrors `StoreTaxProfileResponse`.
 *
 * **Staff only.** These are the seller's registration details; they appear on no public store
 * payload.
 */
const STORE_TAX_PROFILE = {
  type: 'object',
  required: ['configured', 'legalName', 'gstin', 'pan', 'origin'],
  properties: {
    configured: {
      type: 'boolean',
      description:
        '**Whether this store charges GST.** Computed, not stored. True once the profile is filled in — and once it is true, every checkout is assessed and a line that cannot resolve an active tax class and a rate in force is refused with 422 rather than silently untaxed.',
      example: true,
    },
    legalName: { oneOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] },
    gstin: { oneOf: [{ type: 'string', maxLength: 15 }, { type: 'null' }] },
    pan: {
      description:
        'Optional even when the rest of the profile is configured: a GSTIN already embeds the PAN.',
      oneOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }],
    },
    origin: {
      type: 'object',
      description:
        'The GST origin / dispatch address. ONE per store; multi-warehouse origin is deferred. Every field is null together with the identity above, or every field is present — half a profile is unrepresentable.',
      required: ['line1', 'line2', 'city', 'state', 'postalCode', 'countryCode'],
      properties: {
        line1: { oneOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] },
        line2: { type: 'string', maxLength: 300, description: 'Empty string when absent.' },
        city: { oneOf: [{ type: 'string', maxLength: 120 }, { type: 'null' }] },
        state: {
          description:
            'The SELLER half of the CGST/SGST-versus-IGST comparison. Free text: a GST state-code catalogue is statutory master data this build does not invent.',
          oneOf: [{ type: 'string', maxLength: 120 }, { type: 'null' }],
        },
        postalCode: { oneOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }] },
        countryCode: { oneOf: [{ type: 'string', minLength: 2, maxLength: 2 }, { type: 'null' }] },
      },
    },
  },
} as const;

/** A customer's own GST registration. Mirrors `CustomerTaxIdentityResponse`. */
const CUSTOMER_TAX_IDENTITY = {
  type: 'object',
  required: ['gstin', 'legalName', 'updatedAt'],
  properties: {
    gstin: { type: 'string', maxLength: 15, example: '29ABCDE1234F1Z5' },
    legalName: {
      type: 'string',
      maxLength: 300,
      description:
        'The registered legal name the GSTIN belongs to. A business, not the account holder — snapshotting the wrong one onto an invoice is the kind of error nobody notices until an audit.',
      example: 'Buyer Enterprises LLP',
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** A SKU's tax classification. Mirrors `SkuTaxResponse`. */
const SKU_TAX = {
  type: 'object',
  required: ['skuCode', 'taxClassCode', 'hsnCode'],
  properties: {
    skuCode: { type: 'string', maxLength: 64, example: 'SHIRT-BLUE-M' },
    taxClassCode: { oneOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
    hsnCode: { oneOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }] },
  },
} as const;

/** An order. Mirrors `OrderResponse` in `modules/orders/dto.ts`. */
const ORDER = {
  type: 'object',
  required: [
    'orderNumber',
    'status',
    'currency',
    'subtotal',
    'discountTotal',
    'total',
    'taxTotal',
    'grandTotal',
    'tax',
    'placedAt',
    'promotion',
    'shippingAddress',
    'items',
  ],
  properties: {
    orderNumber: {
      type: 'string',
      maxLength: 64,
      description:
        'ORD-YYYYMMDD-XXXXXX, generated server-side and unique per store. This is how an order is addressed everywhere in the API — the internal id is never published. Case-sensitive, and never regenerated. The suffix comes from a CSPRNG rather than a sequence, so it leaks no order count, and it omits I, O, 0 and 1 so a number read off a printed invoice cannot be mistyped into a different one.',
      example: 'ORD-20260904-7QK4M2',
    },
    status: {
      type: 'string',
      enum: ['placed', 'cancelled'],
      description:
        '`placed` on creation, and `cancelled` when the customer withdraws an order nobody has been charged for. **Not a payment state** — the order stays `placed` whether or not it has been paid for, and whether money moved is answered only by the payment. `cancelled` is terminal: there is no un-cancel, because reinstating an order cannot re-check the stock, prices and promotion it was built from. Fulfilment and returns each bring their own states, written by the increment that can actually cause them.',
      example: 'placed',
    },
    currency: {
      type: 'string',
      minLength: 3,
      maxLength: 3,
      description:
        "The order's currency, copied from the store at checkout so a store that later changes currency does not restate historical totals.",
      example: 'INR',
    },
    subtotal: {
      type: 'string',
      description: 'The sum of every lineTotal — PRE-discount merchandise. Never a JSON number.',
      example: '2998.0000',
    },
    discountTotal: {
      type: 'string',
      description:
        'The sum of every line\u2019s discountAmount, exactly. Derived FROM the allocation rather than computed alongside it, so an order\u2019s lines can never fail to foot to its header.',
      example: '299.8000',
    },
    total: {
      type: 'string',
      description:
        '**subtotal minus discountTotal: the GOODS total, before tax.** This meaning is fixed and Increment 38 did not change it — GST was added as taxTotal and grandTotal ALONGSIDE. **This is no longer the amount charged**; grandTotal is. Never a JSON number.',
      example: '2698.2000',
    },
    taxTotal: {
      type: 'string',
      description:
        'The sum of every line taxTotal. **0.0000 both when tax was assessed at nil and when it was never assessed at all** — the tax object below is what distinguishes the two. Never a JSON number.',
      example: '485.68',
    },
    grandTotal: {
      type: 'string',
      description:
        '**total + taxTotal: THE PAYABLE AMOUNT, and what a payment charges.** Equal to total for an order carrying no tax determination, which is why the change is invisible to orders placed before GST existed. Enforced as an identity in the database. Never a JSON number.',
      example: '3183.88',
    },
    tax: {
      description:
        '**The GST determination, or null when this order was never assessed** — placed before GST existed, or in a store with no tax profile configured. Null is NOT the same as a determination that produced zero: one says "not assessed", the other says "assessed at nil", and they stay distinguishable for ever.',
      oneOf: [{ $ref: '#/components/schemas/OrderTax' }, { type: 'null' }],
    },
    placedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the order was placed — a business fact, not row bookkeeping. The tax rate in force and the invoice date will both be functions of it.',
    },
    promotion: {
      description:
        'The promotion that discounted this order, or null. Null also when a coupon was applied to the cart but had lapsed by checkout: the order is still placed, without the discount.',
      oneOf: [{ $ref: '#/components/schemas/OrderPromotion' }, { type: 'null' }],
    },
    shippingAddress: { $ref: '#/components/schemas/OrderAddress' },
    items: { type: 'array', items: { $ref: '#/components/schemas/OrderLine' } },
  },
} as const;

/**
 * The composed order status the admin dashboard shows. §49 in `docs/DECISIONS.md`.
 *
 * Derived on read from `order.status`, the payment state and the shipment state. Stored nowhere,
 * and absent from every customer-facing response.
 */
const ORDER_DISPLAY_STATUS = {
  type: 'string',
  enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'failed'],
  description:
    'Composed on read from the three lifecycles, first match wins: `cancelled` when the order ' +
    'is cancelled; else `delivered`/`shipped`/`processing` from the shipment; else `failed` for ' +
    'a failed or expired payment, `confirmed` for a succeeded one or a pending COD one, and ' +
    '`pending` otherwise. **`ready_to_ship` and `returned` are NOT produced** — the first needs ' +
    'an AWB this version has no column for, the second needs a return lifecycle whose routes do ' +
    'not exist yet. Neither is emitted as an empty bucket, because a status that never appears ' +
    'is indistinguishable from a broken one.',
} as const;

/**
 * One row of the staff payment list. Mirrors `AdminPaymentResponse` in `modules/payments/dto.ts`.
 *
 * The omissions are the contract. `providerRef` — the Razorpay handle — is absent because it is
 * a capability to act on the provider side, and it goes to the paying customer for the checkout
 * handoff and to nobody else. `amountMinor` is absent because money leaves this system as a
 * decimal string and publishing both invites a client to pick one. Internal ids are absent
 * because a payment is addressed here by its order number.
 */
const ADMIN_PAYMENT = {
  type: 'object',
  required: [
    'orderNumber',
    'status',
    'method',
    'provider',
    'amount',
    'currency',
    'failureCode',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    orderNumber: { type: 'string', example: 'ORD-20260904-7QK4M2' },
    status: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'expired'] },
    method: { type: 'string', enum: ['online', 'cod'] },
    provider: {
      description:
        'The gateway that handled it, or null for `cod` — `ck_payment_provider_matches_method` guarantees the pairing.',
      oneOf: [{ type: 'string', enum: ['razorpay'] }, { type: 'null' }],
    },
    amount: {
      type: 'string',
      description: 'A decimal string, always exactly the order’s payable total.',
      example: '2268.0000',
    },
    currency: { type: 'string', example: 'INR' },
    failureCode: {
      description:
        'Set only on a failed payment; `ck_payment_failure_code` makes any other combination unrepresentable.',
      oneOf: [{ type: 'string' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'The last transition’s instant — when the payment succeeded, failed or expired.',
    },
  },
} as const;

/**
 * One row of the staff customer list. Mirrors `AdminCustomerResponse` in `modules/identity/dto.ts`.
 *
 * `passwordHash`, `isStaff` and `isSuperuser` are absent from the SQL projection, from the record
 * type, and from the response mapper — three deliberate edits would be needed to publish one.
 * Password-reset tokens and refresh sessions live in other tables this query never touches.
 */
const ADMIN_CUSTOMER = {
  type: 'object',
  required: [
    'id',
    'email',
    'phone',
    'firstName',
    'lastName',
    'isActive',
    'createdAt',
    'updatedAt',
    'orderCount',
    'totalSpent',
    'lastOrderAt',
  ],
  properties: {
    id: {
      type: 'string',
      format: 'uuid',
      description:
        'The one internal identifier published here: unlike an order, a customer has no business-facing number to be addressed by.',
    },
    email: { type: 'string', format: 'email' },
    phone: {
      description:
        'The mobile number. Null whenever the account was created without one — `phone` has never been required at registration, so this is a permanent shape rather than missing data.',
      oneOf: [{ type: 'string', maxLength: 20 }, { type: 'null' }],
    },
    firstName: { type: 'string', description: 'Empty string when never supplied, never null.' },
    lastName: { type: 'string', description: 'Empty string when never supplied, never null.' },
    isActive: {
      type: 'boolean',
      description:
        'False once an account is deactivated. Scopes and liveness are read from the database on every request, so a deactivated account’s existing tokens fail on their next call.',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    orderCount: {
      type: 'integer',
      minimum: 0,
      description: [
        'Orders this customer placed that were **not cancelled**.',
        '',
        '`0` both for a customer who has never ordered and for one whose every order was',
        'cancelled — neither is a sale, so neither is counted.',
      ].join('\n'),
    },
    totalSpent: {
      type: 'string',
      example: '24680.0000',
      description: [
        '**The sum of `grandTotal` over this customer’s non-cancelled orders.** A decimal string',
        'at `NUMERIC(19,4)` scale, never a number — money never becomes binary floating point in',
        'this API. `"0.0000"` when there is nothing to total.',
        '',
        'The definition, stated precisely because the phrase is ambiguous:',
        '',
        '| Included | Excluded |',
        '| --- | --- |',
        '| GST — `grandTotal` is tax-inclusive | cancelled orders |',
        '| cash-on-delivery orders | returns and refunds |',
        '| orders whose online payment later failed | |',
        '',
        'It is **billed value, not cash received.** A cash-on-delivery payment never reaches',
        '`succeeded` in this system, so a definition based on captured money would report zero',
        'for every COD sale; this one does not have that defect, and pays for it by counting an',
        'order whose online payment failed.',
        '',
        'Returns are **not** deducted. There is no refund execution here, so no money has ever',
        'moved back, and subtracting a requested refund would report a reversal that never',
        'happened.',
      ].join('\n'),
    },
    lastOrderAt: {
      description:
        'When this customer last placed a non-cancelled order, or null if they never have. A cancelled order never sets it.',
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

/**
 * The Customers screen's tabs. Increment 56.
 *
 * Tenant- and liveness-scoped and NOTHING else — not the list's filters, and not the search
 * term. A tab count that moved as you typed could not tell you how many rows switching to that
 * tab would show, which is the only question a tab count answers.
 */
const ADMIN_CUSTOMER_COUNTS = {
  type: 'object',
  required: ['total', 'active', 'inactive'],
  description:
    'Counts for the whole store, independent of every filter on this request — so `counts.total` and `pagination.total` differ whenever a filter is applied, and that is correct: one counts the store, the other counts the query. Soft-deleted accounts are excluded from both. `active + inactive === total` always, and both keys are present at zero.',
  properties: {
    total: { type: 'integer', minimum: 0 },
    active: { type: 'integer', minimum: 0 },
    inactive: { type: 'integer', minimum: 0 },
  },
} as const;

/** The customer on an admin order row. An allowlist — never a credential or a privilege flag. */
const ADMIN_ORDER_CUSTOMER = {
  type: 'object',
  description:
    'Who placed the order. Four fields, chosen deliberately: `passwordHash`, `isStaff` and ' +
    '`isSuperuser` are never selected from the database, never carried on the record type, and ' +
    'never mapped onto a response.',
  required: ['id', 'email', 'firstName', 'lastName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
  },
} as const;

/** The payment state on an admin order. A status and a method — never an amount or a provider. */
const ADMIN_ORDER_PAYMENT = {
  type: 'object',
  required: ['status', 'method'],
  properties: {
    status: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'expired'] },
    method: { type: 'string', enum: ['online', 'cod'] },
  },
} as const;

/** The shipment state on an admin order. */
const ADMIN_ORDER_SHIPMENT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
  },
} as const;

/**
 * One row of the admin order list. Mirrors `AdminOrderSummaryResponse` in `modules/orders/dto.ts`.
 *
 * Deliberately NOT the full `Order`: a list row carries no items and no delivery address, so a
 * page of a hundred orders does not ship a hundred addresses to render a table that shows none
 * of them. The detail endpoint carries both.
 */
const ADMIN_ORDER_SUMMARY = {
  type: 'object',
  required: [
    'orderNumber',
    'displayStatus',
    'status',
    'currency',
    'total',
    'taxTotal',
    'grandTotal',
    'placedAt',
    'customer',
    'payment',
    'shipment',
  ],
  properties: {
    orderNumber: { type: 'string', example: 'ORD-20260904-7QK4M2' },
    displayStatus: ORDER_DISPLAY_STATUS,
    status: {
      type: 'string',
      enum: ['placed', 'cancelled'],
      description:
        'The underlying `order.status`, unchanged. The order lifecycle has exactly these two ' +
        'values; payment and fulfilment live in their own tables. See `displayStatus` for the ' +
        'composed view, and §43 for why the three are not merged.',
    },
    currency: { type: 'string', example: 'INR' },
    total: { type: 'string', description: 'The goods total, after the merchandise discount.' },
    taxTotal: { type: 'string' },
    grandTotal: { type: 'string', description: 'total + taxTotal — the payable amount.' },
    placedAt: { type: 'string', format: 'date-time' },
    customer: { $ref: '#/components/schemas/AdminOrderCustomer' },
    payment: {
      description: 'The payment state, or null when the order has no payment row at all.',
      oneOf: [{ $ref: '#/components/schemas/AdminOrderPayment' }, { type: 'null' }],
    },
    shipment: {
      description: 'The shipment state, or null when no shipment has been created.',
      oneOf: [{ $ref: '#/components/schemas/AdminOrderShipment' }, { type: 'null' }],
    },
  },
} as const;

/**
 * The admin order detail: the customer's own `Order` document, plus the four operator fields.
 *
 * Composed with `allOf` rather than restated, mirroring how `AdminOrderDetailResponse` spreads
 * `toOrderResponse` — so the money, the tax snapshot, the promotion and the line items cannot
 * drift between the customer and admin audiences.
 */
const ADMIN_ORDER_DETAIL = {
  allOf: [
    { $ref: '#/components/schemas/Order' },
    {
      type: 'object',
      required: ['displayStatus', 'customer', 'payment', 'shipment'],
      properties: {
        displayStatus: ORDER_DISPLAY_STATUS,
        customer: { $ref: '#/components/schemas/AdminOrderCustomer' },
        payment: {
          oneOf: [{ $ref: '#/components/schemas/AdminOrderPayment' }, { type: 'null' }],
        },
        shipment: {
          oneOf: [{ $ref: '#/components/schemas/AdminOrderShipment' }, { type: 'null' }],
        },
      },
    },
  ],
} as const;

/** One line of the cart. Mirrors `CartItemResponse` in `modules/cart/dto.ts`. */
const CART_ITEM = {
  type: 'object',
  required: ['skuCode', 'skuName', 'quantity', 'unitPrice', 'lineTotal', 'isPurchasable'],
  properties: {
    skuCode: {
      type: 'string',
      maxLength: 64,
      description:
        'The merchant SKU code. The cart identifies a line by this, never by an internal id.',
      example: 'SHIRT-BLUE-M',
    },
    skuName: { type: 'string', maxLength: 300, example: 'Medium' },
    quantity: { type: 'integer', minimum: 1, maximum: 999, example: 2 },
    unitPrice: {
      type: 'string',
      description:
        "The SKU's CURRENT price as a decimal string at the storage scale. Never a JSON number. Not a snapshot: a cart is not a quotation, so a merchant's price change appears on the next read.",
      example: '1499.0000',
    },
    lineTotal: {
      type: 'string',
      description:
        'unitPrice x quantity, computed with exact decimal arithmetic. Never a JSON number.',
      example: '2998.0000',
    },
    isPurchasable: {
      type: 'boolean',
      description:
        'Whether this SKU can still be bought — active, not deleted, under a published product. Derived at read time and never stored. A line whose SKU was deactivated after it was added STAYS in the cart and comes back false, rather than being silently discarded.',
      example: true,
    },
  },
} as const;

/** The cart. Mirrors `CartResponse`. */
const CART = {
  type: 'object',
  required: [
    'id',
    'status',
    'currency',
    'items',
    'itemCount',
    'subtotal',
    'discountTotal',
    'cartTotal',
    'promotion',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['active', 'checked_out'],
      description:
        'A cart is persistent and never deleted. Only the active cart is returned by GET; a checked-out cart is history and does not block a new one.',
      example: 'active',
    },
    currency: {
      type: 'string',
      minLength: 3,
      maxLength: 3,
      description:
        "The STORE's currency. Neither the cart nor a line carries one, so a basket cannot mix currencies.",
      example: 'INR',
    },
    items: { type: 'array', items: { $ref: '#/components/schemas/CartItem' } },
    itemCount: {
      type: 'integer',
      description:
        'The number of LINES, not the sum of quantities. Both readings are plausible, so this one is stated: it answers "how many distinct things are in the basket".',
      example: 2,
    },
    subtotal: {
      type: 'string',
      description:
        'The exact decimal sum of every lineTotal, BEFORE any promotion discount, including lines that are no longer purchasable. Never a JSON number. This is what cartTotal contained before promotions existed.',
      example: '2998.3000',
    },
    discountTotal: {
      type: 'string',
      description:
        'The applied promotion discount, or 0.0000 when none applies. Computed once against the subtotal, never per line, so it does not depend on how the basket is split into lines. Never negative and never more than the subtotal. Never a JSON number.',
      example: '299.8300',
    },
    cartTotal: {
      type: 'string',
      description:
        'subtotal minus discountTotal: the payable total. **This field changed meaning:** before promotions existed it was the pre-discount sum, which is now reported as subtotal. A field named cartTotal that did not mean what the customer pays is the field that gets misused, so the name moved to the payable value rather than a second payableTotal being added beside it. The identity subtotal - discountTotal = cartTotal holds on every response.',
      example: '2698.4700',
    },
    promotion: {
      description:
        'The applied promotion, or null. Null also when a promotion IS associated but no longer discounts anything — it expired, was deactivated or deleted, or the cart fell below its minimum subtotal. There is deliberately no permanent rejection reason: a cart reporting one forever would make every client render a stale complaint.',
      oneOf: [{ $ref: '#/components/schemas/CartPromotion' }, { type: 'null' }],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** The applied promotion as a customer sees it. Mirrors `CartPromotionResponse`. */
const CART_PROMOTION = {
  type: 'object',
  required: ['code', 'name', 'discountTotal'],
  properties: {
    code: {
      type: 'string',
      maxLength: 64,
      description:
        'The coupon code, in the case the merchant configured it. Matching is case-insensitive, so a customer who typed save10 sees SAVE10 here.',
      example: 'SAVE10',
    },
    name: { type: 'string', maxLength: 300, example: 'Festive 10% off' },
    discountTotal: {
      type: 'string',
      description:
        "The same value as the cart's discountTotal, repeated so a client rendering a promotion row needs no cross-reference.",
      example: '299.8300',
    },
  },
} as const;

/** A promotion as STAFF see it. Mirrors `PromotionResponse` in `modules/promotions/dto.ts`. */
const PROMOTION = {
  type: 'object',
  required: [
    'id',
    'code',
    'name',
    'discountType',
    'percentRate',
    'amount',
    'minSubtotal',
    'startsAt',
    'endsAt',
    'isActive',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: {
      type: 'string',
      maxLength: 64,
      description:
        'Stored in the case the merchant supplied, trimmed. Unique per store among non-deleted promotions, compared case-insensitively — SAVE10 and save10 cannot be two live coupons.',
      example: 'SAVE10',
    },
    name: { type: 'string', maxLength: 300, example: 'Festive 10% off' },
    discountType: { type: 'string', enum: ['percentage', 'fixed_amount'], example: 'percentage' },
    percentRate: {
      description:
        'The percentage, as a decimal string with up to 6 decimal places. Present only when discountType is percentage; null otherwise. Greater than 0 and at most 100 — a database CHECK guarantees the pair, so a promotion can never carry both a rate and an amount.',
      oneOf: [{ type: 'string' }, { type: 'null' }],
      example: '10.000000',
    },
    amount: {
      description:
        'The fixed discount, as a decimal string at the storage scale. Present only when discountType is fixed_amount; null otherwise. Greater than 0. Capped at the cart subtotal when applied, so it can never make a total negative.',
      oneOf: [{ type: 'string' }, { type: 'null' }],
      example: '250.0000',
    },
    minSubtotal: {
      description:
        'The smallest qualifying cart subtotal, or null for no minimum. Compared against the subtotal BEFORE any discount, because using the discounted total would be circular. Equality qualifies.',
      oneOf: [{ type: 'string' }, { type: 'null' }],
      example: '1000.0000',
    },
    startsAt: {
      description:
        'When the promotion begins, or null for "already running". An absolute instant; there is no local-date interpretation.',
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    endsAt: {
      description:
        'When the promotion stops, EXCLUSIVE, or null for "until deactivated". A promotion ending at midnight does not apply at midnight.',
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    isActive: {
      type: 'boolean',
      description:
        'The merchant\u2019s on/off switch, independent of the window. Both exist because pausing a scheduled sale must not destroy its dates.',
      example: true,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** The public shape of a product. Mirrors `ProductResponse` in `modules/catalogue/dto.ts`. */
/**
 * The image formats a storefront can render, and the largest object this API will sign for.
 *
 * Duplicated from `modules/catalogue/dto.ts` for the same reason as the pagination limits
 * above: `no-http-to-modules` forbids the import, and a published contract that silently
 * followed an internal change would be worse than one updated deliberately.
 */
const MEDIA_CONTENT_TYPES_DOC = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;

const MEDIA_MAX_BYTES_DOC = 10 * 1024 * 1024;

/**
 * The list screen's tab badges. Mirrors `ProductCountsResponse` in `modules/catalogue/dto.ts`.
 *
 * Store-wide, not query-wide: these say how many rows switching to a tab would show, so they
 * are unaffected by `q`, `status`, `limit` and `offset`. `counts.total` and
 * `pagination.total` therefore differ whenever a filter is applied, and that is correct —
 * one counts the store, the other counts the query. `draft + active + archived === total`.
 */
/**
 * One refund. Mirrors `RefundResponse` in `modules/payments/dto.ts`.
 *
 * Addressed by its public NUMBER; the row's UUID is published nowhere, exactly as with orders
 * and returns. `providerRefundId` IS published — a merchant reconciling against the gateway
 * dashboard needs it, and it is an opaque identifier the provider displays there itself.
 */
const REFUND = {
  type: 'object',
  required: [
    'refundNumber',
    'status',
    'mode',
    'amount',
    'currency',
    'provider',
    'providerRefundId',
    'failureCode',
    'createdAt',
    'settledAt',
  ],
  properties: {
    refundNumber: { type: 'string', example: 'RFD-20260917-K7M2QP' },
    status: {
      type: 'string',
      enum: ['pending', 'processing', 'succeeded', 'failed'],
      description:
        '`processing` means the provider was ASKED and the answer is not known — a timeout, an aborted connection or a 5xx. It is neither success nor failure, it still consumes refundable balance, and it must be reconciled rather than retried.',
      example: 'succeeded',
    },
    mode: {
      type: 'string',
      enum: ['provider', 'manual'],
      description:
        '`provider` is a gateway refund against the original charge. `manual` is a recorded obligation settled outside this system — the COD case, and an online payment whose charge id was never captured.',
      example: 'provider',
    },
    amount: { type: 'string', example: '1499.0000' },
    currency: { type: 'string', example: 'INR' },
    provider: { type: 'string', nullable: true, example: 'razorpay' },
    providerRefundId: {
      type: 'string',
      nullable: true,
      description:
        'The provider’s id for the REFUND object (`rfnd_…`). Distinct from the provider order (`order_…`), the provider charge (`pay_…`) and the webhook delivery id. Null for a manual refund and until the provider answers.',
      example: 'rfnd_QX1a2b3c4d5e6f',
    },
    failureCode: { type: 'string', nullable: true, example: 'http_400' },
    createdAt: { type: 'string', format: 'date-time' },
    settledAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'Set exactly when the refund reaches `succeeded` or `failed`.',
    },
  },
} as const;

/**
 * A payment's refund position. Mirrors `RefundBalanceResponse`.
 *
 * `refunded` and `claimed` are DIFFERENT figures and both are published. They are equal in the
 * ordinary case and differ exactly while an attempt is `pending` or `processing` — the window
 * in which reporting either one as the other would be a lie, and the reason a payment can
 * refuse a further refund while showing nothing refunded.
 */
const REFUND_BALANCE = {
  type: 'object',
  required: ['currency', 'captured', 'refunded', 'claimed', 'remaining'],
  properties: {
    currency: { type: 'string', example: 'INR' },
    captured: {
      type: 'string',
      description:
        'What the payment collected. `0` unless it succeeded — or, for COD, unless the order was delivered, which is when the cash changes hands.',
      example: '1499.0000',
    },
    refunded: { type: 'string', description: 'Succeeded refunds only.', example: '100.0000' },
    claimed: {
      type: 'string',
      description:
        'Succeeded refunds PLUS everything still in flight. What blocks a further refund.',
      example: '100.0000',
    },
    remaining: {
      type: 'string',
      description: '`captured - claimed`. What a further refund may be raised for.',
      example: '1399.0000',
    },
  },
} as const;

const PRODUCT_COUNTS = {
  type: 'object',
  required: ['total', 'draft', 'active', 'archived'],
  description:
    'Products per lifecycle status across the whole store, soft-deleted rows excluded. Every status is present even at zero, so a tab never disappears when it empties.',
  properties: {
    total: { type: 'integer', minimum: 0, example: 42 },
    draft: { type: 'integer', minimum: 0, example: 7 },
    active: { type: 'integer', minimum: 0, example: 31 },
    archived: { type: 'integer', minimum: 0, example: 4 },
  },
} as const;

/**
 * One product image. Mirrors `MediaResponse` in `modules/catalogue/dto.ts`.
 *
 * The BYTES are not here and never travel through this API — the row is a pointer into object
 * storage plus the metadata needed to render it. `url` is composed from `storageKey` and the
 * configured delivery base, and is `null` when this deployment has none, so a client can tell
 * "no image" apart from "no CDN configured".
 */
const PRODUCT_MEDIA = {
  type: 'object',
  required: [
    'id',
    'url',
    'storageKey',
    'contentType',
    'altText',
    'skuCode',
    'width',
    'height',
    'byteSize',
    'position',
    'isPrimary',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33' },
    url: {
      type: 'string',
      nullable: true,
      description:
        'Delivery URL, composed from the storage key. `null` when no delivery base is configured — the image is registered, but this deployment cannot address it.',
      example: 'https://cdn.example.com/stores/s1/products/p1/front.webp',
    },
    storageKey: {
      type: 'string',
      description:
        'The object key in the bucket. Returned so a client can correlate an upload target with the row it became.',
      example: 'stores/s1/products/p1/front.webp',
    },
    contentType: { type: 'string', enum: MEDIA_CONTENT_TYPES_DOC, example: 'image/webp' },
    altText: {
      type: 'string',
      description: 'Accessibility text. An empty string when unset, never null.',
      example: 'Blue cotton shirt, front view',
    },
    skuCode: {
      type: 'string',
      nullable: true,
      description:
        'The variant this image is of. `null` means the product generally. A CODE rather than an id, like every other product route.',
      example: 'SHIRT-BLUE-M',
    },
    width: { type: 'integer', nullable: true, example: 1200 },
    height: { type: 'integer', nullable: true, example: 1600 },
    byteSize: { type: 'integer', nullable: true, example: 184320 },
    position: {
      type: 'integer',
      minimum: 0,
      description: 'Gallery order, ascending. Ties break by creation time, so the order is stable.',
      example: 0,
    },
    isPrimary: {
      type: 'boolean',
      description:
        'The image that represents the product. At most one per product, enforced by a partial unique index rather than by application code.',
      example: true,
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** Where to PUT an object's bytes. Mirrors `MediaUploadTargetResponse`. */
const MEDIA_UPLOAD_TARGET = {
  type: 'object',
  required: ['uploadUrl', 'storageKey', 'expiresAt', 'requiredHeaders'],
  properties: {
    uploadUrl: {
      type: 'string',
      description:
        'Pre-signed URL. `PUT` the bytes here directly; they never pass through this API.',
      example: 'https://bucket.s3.amazonaws.com/stores/s1/...?X-Amz-Signature=...',
    },
    storageKey: {
      type: 'string',
      description:
        'The key to send back to `POST /admin/products/{slug}/media` once the PUT succeeds.',
      example: 'stores/s1/products/p1/01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33.webp',
    },
    expiresAt: { type: 'string', format: 'date-time' },
    requiredHeaders: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Headers the PUT must carry verbatim, or storage rejects it.',
      example: { 'Content-Type': 'image/webp' },
    },
  },
} as const;

const PRODUCT = {
  type: 'object',
  required: [
    'id',
    'slug',
    'name',
    'description',
    'status',
    'skus',
    'currency',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33' },
    slug: { type: 'string', example: 'blue-cotton-shirt' },
    name: { type: 'string', example: 'Blue Cotton Shirt' },
    description: { type: 'string', example: 'A comfortable everyday shirt.' },
    status: { type: 'string', enum: ['draft', 'active', 'archived'], example: 'draft' },
    skus: {
      type: 'array',
      items: { $ref: '#/components/schemas/Sku' },
      description:
        'The product SELLABLE units. Replaces the former product-level price: a product is not sellable and has no price of its own. Public reads show only ACTIVE SKUs and never an empty array, because a product with no sellable SKU is not publicly visible. Admin reads show inactive SKUs too, so an empty array is possible there.',
    },
    currency: {
      type: 'string',
      description:
        "The STORE's currency. Neither products nor SKUs carry a currency of their own, so a cart cannot mix them.",
      example: 'INR',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** The public shape of a user. Mirrors `UserResponse` in `modules/identity/dto.ts`. */
const USER = {
  type: 'object',
  required: [
    'id',
    'email',
    'firstName',
    'lastName',
    'phone',
    'emailVerified',
    'acceptsMarketing',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid', example: '01a04285-73cb-7456-9ea4-71f38798d4dc' },
    email: { type: 'string', format: 'email', example: 'buyer@example.com' },
    firstName: { type: 'string', example: 'Ada' },
    lastName: { type: 'string', example: 'Lovelace' },
    phone: { type: 'string', nullable: true, example: null },
    emailVerified: { type: 'boolean', example: false },
    acceptsMarketing: { type: 'boolean', example: false },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

/** A response that carries only the error envelope. */
function errorResponse(description: string, code: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        example: {
          error: {
            code,
            message: 'See the error catalog.',
            requestId: '2ccb5503-eacc-4f98-b17e-0a0daec1ce71',
          },
        },
      },
    },
  };
}

/**
 * Responses every endpoint under `/api/v1` can return.
 *
 * `503` is the one people forget: `resolveStore` runs before every API route, so an unseeded
 * or deactivated store fails the request before it reaches a handler. Documenting it stops an
 * integrator from treating it as a transient network fault.
 */
const COMMON_ERRORS = {
  '400': errorResponse(
    'Validation failed. `details.fields` maps each rejected field to its messages. Unknown fields are rejected, not ignored.',
    'VALIDATION_ERROR',
  ),
  '503': errorResponse(
    'The store could not be resolved — the deployment has not been seeded, or the store is deactivated. An operational fault, not a client error.',
    'DEPENDENCY_UNAVAILABLE',
  ),
  '500': errorResponse(
    'An unexpected error. Quote `requestId` when reporting it.',
    'INTERNAL_ERROR',
  ),
} as const;

/** The `{slug}` path parameter, shared by every product endpoint that takes one. */
/**
 * The media routes address an image by id.
 *
 * An image has no merchant-facing code the way a SKU does, so its UUID is the only key.
 */
const MEDIA_ID_PARAMETER = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The image id, as returned when it was registered.',
  schema: { type: 'string', format: 'uuid' },
  example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33',
} as const;

const PRODUCT_SLUG_PARAMETER = {
  name: 'slug',
  in: 'path',
  required: true,
  description: 'The product URL segment. Trimmed and lowercased before lookup.',
  schema: { type: 'string', maxLength: 255, pattern: SLUG_PATTERN },
  example: 'blue-cotton-shirt',
} as const;

/**
 * The flat option routes address a resource by id.
 *
 * An option has no merchant-facing code the way a SKU does, so its UUID is the only key. A
 * malformed id is a 400 from validation rather than a PostgreSQL invalid-input-syntax error.
 */
const OPTION_ID_PARAMETER = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'The option or option-value id.',
  schema: { type: 'string', format: 'uuid' },
  example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33',
} as const;

/** The flat SKU routes address a SKU by merchant code; it is unique per store. */
const SKU_CODE_PARAMETER = {
  name: 'code',
  in: 'path',
  required: true,
  description: 'The merchant SKU code. Case-sensitive; trimmed before lookup.',
  schema: { type: 'string', maxLength: 64 },
  example: 'SHIRT-BLUE-M',
} as const;

/** A lifecycle action's success response. The same product shape every other endpoint returns. */
const PRODUCT_LIFECYCLE_RESPONSE = (description: string) =>
  ({
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['product'],
          properties: { product: { $ref: '#/components/schemas/Product' } },
        },
      },
    },
  }) as const;

/** Failures common to both lifecycle actions. */
const PRODUCT_LIFECYCLE_ERRORS = {
  '401': errorResponse(
    'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
    'AUTHENTICATION_REQUIRED',
  ),
  '403': errorResponse(
    'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
    'PERMISSION_DENIED',
  ),
  '404': errorResponse(
    'No such product in this store. Returned identically whether the slug has never existed, the product belongs to another store, or it has been deleted.',
    'NOT_FOUND',
  ),
  '409': errorResponse(
    'The product exists but is not in a status this action can act on — for example publishing one that is already active. `details.from` and `details.to` name the current and requested statuses.',
    'INVALID_STATE_TRANSITION',
  ),
} as const;

/**
 * A shipment as STAFF see it: the customer fields plus the `id` needed to act on it.
 *
 * Shared because six operations return the same shape, and a copy per operation is six places
 * for the response to drift from what the mapper actually produces.
 */
const STAFF_SHIPMENT = {
  type: 'object',
  required: [
    'id',
    'status',
    'carrier',
    'trackingNumber',
    'trackingUrl',
    'shippedAt',
    'deliveredAt',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
    carrier: { type: 'string', nullable: true, maxLength: 120 },
    trackingNumber: { type: 'string', nullable: true, maxLength: 120 },
    trackingUrl: { type: 'string', nullable: true, maxLength: 500 },
    shippedAt: { type: 'string', format: 'date-time', nullable: true },
    deliveredAt: { type: 'string', format: 'date-time', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;
export function buildOpenApiSpec(config: Config): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'E-commerce Backend API',
      version: '1.0.0',
      description: [
        'Headless Commerce REST API.',
        '',
        '**Store Scoping**: All API endpoints are store-scoped.',
        '**Authentication**: Bearer Token (JWT). Staff endpoints require admin authorization.',
        '**Error Handling**: Standardized JSON error response format.',
      ].join('\n'),
    },
    servers: [
      {
        // Built from config rather than hard-coded, so "Try it out" targets the port this
        // process is actually listening on.
        url: '/',
        description: `${config.environment} (this process)`,
      },
    ],
    tags: [
      {
        name: 'Authentication',
        description: 'User registration, login, token management, and auth sessions.',
      },
      {
        name: 'Dashboard',
        description: 'Admin analytics, sales overview, and store operational metrics.',
      },
      { name: 'Users', description: 'Customer profiles and admin customer management.' },
      {
        name: 'Orders',
        description: 'Order placement, customer order history, and admin order management.',
      },
      {
        name: 'Payments',
        description: 'Payment processing, payment status tracking, and admin refunds.',
      },
      {
        name: 'Webhooks',
        description: 'Payment provider webhook callbacks and signature verification.',
      },
      { name: 'Promotions', description: 'Coupon codes and promotional discount management.' },
      {
        name: 'Cart',
        description: 'Shopping cart operations, line item updates, and applied discounts.',
      },
      { name: 'Addresses', description: 'Customer shipping and billing address book management.' },
      {
        name: 'Catalogue',
        description: 'Product catalog, categories, and SKU variant management.',
      },
      {
        name: 'Inventory',
        description: 'Stock tracking, ledger adjustments, and low-stock alerts.',
      },
      { name: 'Tax', description: 'GST configuration and tax identification management.' },
      { name: 'Health', description: 'System liveness and readiness probe checks.' },
    ],
    components: {
      responses: {
        StaffShipment: {
          description: 'The shipment, as staff see it.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['shipment'],
                properties: { shipment: STAFF_SHIPMENT },
              },
            },
          },
        },
      },
      schemas: {
        ReturnLine: {
          type: 'object',
          description:
            'One returned SKU, with the money apportioned from the FROZEN order line. Nothing ' +
            'here is recalculated from the current price, tax configuration or promotion. The ' +
            'inspection counts are deliberately absent: whether a unit was resold or written ' +
            'off is a warehouse decision and changes nothing the customer is owed.',
          required: [
            'skuCode',
            'quantity',
            'lineTotal',
            'discountAmount',
            'taxableValue',
            'cgstAmount',
            'sgstAmount',
            'igstAmount',
            'cessAmount',
            'taxTotal',
            'refundTotal',
          ],
          properties: {
            skuCode: { type: 'string', example: 'AURORA-TEE-S' },
            quantity: { type: 'integer', minimum: 1, example: 2 },
            lineTotal: { type: 'string', description: 'Gross for the returned units.' },
            discountAmount: { type: 'string', description: 'Their share of the promotion.' },
            taxableValue: { type: 'string', description: 'lineTotal minus discountAmount.' },
            cgstAmount: { type: 'string' },
            sgstAmount: { type: 'string' },
            igstAmount: { type: 'string' },
            cessAmount: { type: 'string' },
            taxTotal: { type: 'string', description: 'CGST + SGST + IGST + CESS.' },
            refundTotal: { type: 'string', description: 'taxableValue + taxTotal.' },
          },
        },
        StaffReturn: {
          allOf: [
            { $ref: '#/components/schemas/Return' },
            {
              type: 'object',
              description:
                'The staff view: everything the customer sees, plus the internal fields. ' +
                'staffNote is the merchant’s rationale, written for colleagues — publishing ' +
                'it would turn every refusal into an argument. The per-line inspection counts ' +
                'are a warehouse decision and change nothing the customer is owed.',
              required: ['staffNote'],
              properties: {
                staffNote: { type: 'string', maxLength: 500 },
                lines: {
                  type: 'array',
                  items: {
                    allOf: [
                      { $ref: '#/components/schemas/ReturnLine' },
                      {
                        type: 'object',
                        required: ['restockQuantity', 'writeOffQuantity'],
                        properties: {
                          restockQuantity: { type: 'integer', minimum: 0 },
                          writeOffQuantity: { type: 'integer', minimum: 0 },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        AdminSession: {
          type: 'object',
          description:
            'One refresh session. Carries NO token material: `token_hash` is never selected ' +
            'by the query behind this shape, so it cannot be published even by accident. ' +
            '`userId` is absent because the caller named the customer in the path.',
          required: [
            'id',
            'familyId',
            'active',
            'expiresAt',
            'consumedAt',
            'revokedAt',
            'revokedReason',
            'userAgent',
            'ipAddress',
            'createdAt',
            'updatedAt',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            familyId: {
              type: 'string',
              format: 'uuid',
              description:
                'The rotation chain this session belongs to. Revoking cuts the whole family.',
            },
            active: {
              type: 'boolean',
              description: 'Derived: not revoked, and not yet expired.',
            },
            expiresAt: { type: 'string', format: 'date-time' },
            consumedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'When this row was rotated away. Null while it is the live link.',
            },
            revokedAt: { type: 'string', format: 'date-time', nullable: true },
            revokedReason: {
              type: 'string',
              nullable: true,
              example: 'staff_revoked',
              description:
                'Distinct values per cause — `logout`, `password_change`, `password_reset`, `staff_revoked` — so an investigation can tell them apart.',
            },
            userAgent: { type: 'string', nullable: true, maxLength: 512 },
            ipAddress: { type: 'string', nullable: true, maxLength: 45 },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        OrderTimelineEntry: {
          type: 'object',
          description:
            'One entry of an order’s append-only status history. The actor’s user id is ' +
            'deliberately absent — see GET /admin/audit-logs for attribution to a person.',
          required: ['fromStatus', 'toStatus', 'actorType', 'note', 'at'],
          properties: {
            fromStatus: {
              type: 'string',
              nullable: true,
              enum: ['placed', 'cancelled', null],
              description: 'Null on the entry that created the order.',
            },
            toStatus: { type: 'string', enum: ['placed', 'cancelled'] },
            actorType: { type: 'string', enum: ['customer', 'staff', 'system', 'job'] },
            note: { type: 'string', nullable: true, maxLength: 500 },
            at: { type: 'string', format: 'date-time' },
          },
        },
        AuditLogEntry: {
          type: 'object',
          description:
            'One audit entry. `metadata` is deliberately not published: each module writes ' +
            'its own per-action context, and exposing the union of all of it through one ' +
            'endpoint would make every future audit call a disclosure decision on this route.',
          required: ['action', 'actorType', 'actorUserId', 'resourceType', 'resourceId', 'at'],
          properties: {
            action: { type: 'string', example: 'order.cancelled' },
            actorType: { type: 'string', enum: ['staff', 'customer', 'system', 'job'] },
            actorUserId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              description:
                'Published HERE, unlike on the order and return timelines: this endpoint is the accountability surface, reached deliberately.',
            },
            resourceType: { type: 'string', nullable: true, example: 'order' },
            resourceId: { type: 'string', nullable: true },
            at: { type: 'string', format: 'date-time' },
          },
        },
        BusinessProfile: {
          type: 'object',
          description:
            'The store’s presentational identity. The GST identity — legalName, gstin, pan ' +
            'and the origin address — belongs to /admin/store/tax-profile and is not here.',
          required: ['slug', 'name', 'domain', 'currency', 'defaultLocale', 'timezone', 'isActive'],
          properties: {
            slug: { type: 'string', description: 'Read-only: how the store is resolved.' },
            name: { type: 'string', maxLength: 200 },
            domain: { type: 'string', nullable: true, maxLength: 255 },
            currency: {
              type: 'string',
              description: 'Read-only: it denominates money already written.',
            },
            defaultLocale: { type: 'string', example: 'en-IN' },
            timezone: { type: 'string', example: 'Asia/Kolkata' },
            isActive: { type: 'boolean' },
          },
        },
        ReturnCustomer: {
          type: 'object',
          description:
            'The customer who raised the return. Email and name only, and no identifier: no ' +
            'internal UUID appears in any response in this API.',
          required: ['email', 'firstName', 'lastName'],
          properties: {
            email: { type: 'string', format: 'email' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
          },
        },
        ReturnAddress: {
          type: 'object',
          description:
            'The address the parcel is coming back from — the ORDER’S SNAPSHOT, never the ' +
            'live address row. A customer fixing a typo today must not rewrite where a past ' +
            'parcel was actually sent.',
          required: [
            'recipientName',
            'phone',
            'line1',
            'line2',
            'landmark',
            'city',
            'state',
            'postalCode',
            'countryCode',
          ],
          properties: {
            recipientName: { type: 'string' },
            phone: { type: 'string' },
            line1: { type: 'string' },
            line2: { type: 'string' },
            landmark: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            countryCode: { type: 'string', minLength: 2, maxLength: 2 },
          },
        },
        ReturnEvent: {
          type: 'object',
          description:
            'One entry of the append-only return lifecycle history. Rows are never rewritten ' +
            'and never deleted. `actorType` says what KIND of actor made the transition; the ' +
            'actor’s user id is deliberately absent — attribution to a person is an audit-log ' +
            'question, not something to publish on a read many staff can see.',
          required: ['fromStatus', 'toStatus', 'actorType', 'note', 'at'],
          properties: {
            fromStatus: {
              type: 'string',
              nullable: true,
              description: 'Null on the entry that created the return.',
            },
            toStatus: { type: 'string' },
            actorType: { type: 'string', enum: ['customer', 'staff', 'system', 'job'] },
            note: { type: 'string', maxLength: 500 },
            at: { type: 'string', format: 'date-time' },
          },
        },
        StaffReturnListItem: {
          allOf: [
            { $ref: '#/components/schemas/StaffReturn' },
            {
              type: 'object',
              description: 'A queue row: the staff return plus who raised it.',
              required: ['customer'],
              properties: { customer: { $ref: '#/components/schemas/ReturnCustomer' } },
            },
          ],
        },
        StaffReturnDetail: {
          allOf: [
            { $ref: '#/components/schemas/StaffReturn' },
            {
              type: 'object',
              description:
                'Everything the admin detail page shows. The refunds are the attempts raised ' +
                'for this return by the refunds aggregate; the timeline is the append-only ' +
                'lifecycle history.',
              required: [
                'customer',
                'shippingAddress',
                'deliveredAt',
                'timeline',
                'refunds',
                'lines',
              ],
              properties: {
                customer: { $ref: '#/components/schemas/ReturnCustomer' },
                shippingAddress: { $ref: '#/components/schemas/ReturnAddress' },
                deliveredAt: {
                  type: 'string',
                  format: 'date-time',
                  description:
                    'When the order was delivered — the instant the return window was measured from.',
                },
                timeline: {
                  type: 'array',
                  description: 'Oldest first, totally ordered by (createdAt, id).',
                  items: { $ref: '#/components/schemas/ReturnEvent' },
                },
                refunds: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Refund' },
                },
                lines: {
                  type: 'array',
                  items: {
                    allOf: [
                      { $ref: '#/components/schemas/ReturnLine' },
                      {
                        type: 'object',
                        required: [
                          'restockQuantity',
                          'writeOffQuantity',
                          'productName',
                          'remainingReturnable',
                        ],
                        properties: {
                          restockQuantity: { type: 'integer', minimum: 0 },
                          writeOffQuantity: { type: 'integer', minimum: 0 },
                          productName: {
                            type: 'string',
                            description:
                              'The product’s CURRENT name, read live — staff handling a parcel need the name on the shelf today. Every monetary field beside it remains the frozen snapshot.',
                          },
                          remainingReturnable: {
                            type: 'integer',
                            minimum: 0,
                            description:
                              'How many units of this SKU on the order are still returnable, after every quantity-consuming return against it. A read: the create path recomputes this under the order lock before writing.',
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
        Return: {
          type: 'object',
          description:
            'A return request. staffNote and every internal identifier are absent — the ' +
            'note is the merchant’s internal rationale, written for colleagues.',
          required: [
            'returnNumber',
            'orderNumber',
            'status',
            'reason',
            'customerNote',
            'currency',
            'refundTaxableValue',
            'refundTaxTotal',
            'refundTotal',
            'requestedAt',
            'closedAt',
            'lines',
          ],
          properties: {
            returnNumber: { type: 'string', example: 'RET-20260910-K3M7QP' },
            orderNumber: { type: 'string', example: 'ORD-20260901-A2B4C6' },
            status: {
              type: 'string',
              enum: [
                'requested',
                'approved',
                'received',
                'inspected',
                'completed',
                'rejected',
                'cancelled',
              ],
            },
            reason: {
              type: 'string',
              enum: [
                'damaged_in_transit',
                'defective',
                'wrong_item_received',
                'not_as_described',
                'no_longer_needed',
              ],
            },
            customerNote: { type: 'string', maxLength: 500 },
            currency: { type: 'string', example: 'INR' },
            refundTaxableValue: { type: 'string' },
            refundTaxTotal: { type: 'string' },
            refundTotal: { type: 'string' },
            requestedAt: { type: 'string', format: 'date-time' },
            closedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Set exactly when the return reaches a terminal state.',
            },
            lines: { type: 'array', items: { $ref: '#/components/schemas/ReturnLine' } },
          },
        },

        ErrorEnvelope: ERROR_ENVELOPE,
        User: USER,
        Address: ADDRESS,
        Cart: CART,
        CartItem: CART_ITEM,
        CartPromotion: CART_PROMOTION,
        Promotion: PROMOTION,
        Order: ORDER,
        OrderLine: ORDER_LINE,
        OrderAddress: ORDER_ADDRESS,
        OrderPromotion: ORDER_PROMOTION,
        DashboardKpiMoney: DASHBOARD_KPI_MONEY,
        DashboardKpiCount: DASHBOARD_KPI_COUNT,
        DashboardSeriesPoint: DASHBOARD_SERIES_POINT,
        DashboardTopProduct: DASHBOARD_TOP_PRODUCT,
        DashboardLowStock: DASHBOARD_LOW_STOCK,
        AdminPayment: ADMIN_PAYMENT,
        AdminPaymentDetail: {
          allOf: [
            { $ref: '#/components/schemas/AdminPayment' },
            {
              type: 'object',
              required: ['providerRef', 'providerTransactionId', 'refunds', 'refundBalance'],
              properties: {
                providerRef: {
                  description: [
                    'The provider’s **order** handle — Razorpay’s `order_…`, created at initiation,',
                    'before anybody paid. Null for `cod`.',
                  ].join(' '),
                  oneOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }],
                },
                providerTransactionId: {
                  description: [
                    'The provider’s **charge** id — Razorpay’s `pay_…`. This is the “Transaction ID”',
                    'a merchant looks up in the gateway’s dashboard, and it is a different entity',
                    'from `providerRef` above.',
                    '',
                    'Null in four ordinary cases, all of them permanent for the row concerned: a',
                    '`cod` payment (no gateway), a payment still `pending` (no charge yet), a',
                    'failure the provider reported without one, and any payment taken before this',
                    'field existed — those charges are real and their ids were never captured, so',
                    'nothing could be backfilled that would not be invented.',
                  ].join('\n'),
                  oneOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }],
                },
                refunds: {
                  type: 'array',
                  description:
                    'Every refund raised against this payment, newest first — including failed and unresolved attempts, because an operator chasing money needs to see the ones that did not work.',
                  items: { $ref: '#/components/schemas/Refund' },
                },
                refundBalance: { $ref: '#/components/schemas/RefundBalance' },
              },
            },
          ],
        },
        AdminCustomer: ADMIN_CUSTOMER,
        AdminCustomerCounts: ADMIN_CUSTOMER_COUNTS,
        AdminOrderCustomer: ADMIN_ORDER_CUSTOMER,
        AdminOrderPayment: ADMIN_ORDER_PAYMENT,
        AdminOrderShipment: ADMIN_ORDER_SHIPMENT,
        AdminOrderSummary: ADMIN_ORDER_SUMMARY,
        AdminOrderDetail: ADMIN_ORDER_DETAIL,
        Payment: PAYMENT,
        PaymentEvent: PAYMENT_EVENT,
        PaymentHandoff: PAYMENT_HANDOFF,
        Product: PRODUCT,
        Refund: REFUND,
        RefundBalance: REFUND_BALANCE,
        ProductCounts: PRODUCT_COUNTS,
        ProductMedia: PRODUCT_MEDIA,
        MediaUploadTarget: MEDIA_UPLOAD_TARGET,
        Sku: SKU,
        SkuOption: SKU_OPTION,
        Option: OPTION,
        OptionValue: OPTION_VALUE,
        StaffShipment: STAFF_SHIPMENT,
        AdminShipment: {
          allOf: [
            { $ref: '#/components/schemas/StaffShipment' },
            {
              type: 'object',
              required: ['orderNumber'],
              properties: {
                orderNumber: {
                  type: 'string',
                  description:
                    'How staff address the order everywhere else. A shipment list that could only name internal ids would be unusable.',
                  example: 'ORD-20260904-7QK4M2',
                },
              },
            },
          ],
        },
        ShipmentEvent: {
          type: 'object',
          description:
            'One transition. `actorType` rather than an actor id: the timeline says a STAFF member acted, without naming a colleague on a screen that exists to explain a parcel.',
          required: ['fromStatus', 'toStatus', 'actorType', 'note', 'occurredAt'],
          properties: {
            fromStatus: {
              description: 'Null for the creation row, which has no previous state.',
              oneOf: [
                { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
                { type: 'null' },
              ],
            },
            toStatus: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
            actorType: { type: 'string', example: 'staff' },
            note: {
              description: 'Free text a staff member typed at the transition. Staff-only.',
              oneOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }],
            },
            occurredAt: { type: 'string', format: 'date-time' },
          },
        },
        AdminShipmentDetail: {
          allOf: [
            { $ref: '#/components/schemas/AdminShipment' },
            {
              type: 'object',
              required: ['history'],
              properties: {
                history: {
                  type: 'array',
                  description: 'Every transition this shipment has made, OLDEST first.',
                  items: { $ref: '#/components/schemas/ShipmentEvent' },
                },
              },
            },
          ],
        },
        StaffShipmentList: {
          type: 'object',
          required: ['shipments'],
          properties: {
            shipments: { type: 'array', maxItems: 1, items: STAFF_SHIPMENT },
          },
        },
        StockItem: STOCK_ITEM,
        StockAdjustment: STOCK_ADJUSTMENT,
        OrderTax: ORDER_TAX,
        OrderLineTax: ORDER_LINE_TAX,
        TaxClass: TAX_CLASS,
        TaxRate: TAX_RATE,
        StoreTaxProfile: STORE_TAX_PROFILE,
        CustomerTaxIdentity: CUSTOMER_TAX_IDENTITY,
        SkuTax: SKU_TAX,
        Pagination: PAGINATION,
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: [
            'RS256 access token from `POST /api/v1/auth/login`, sent as',
            '`Authorization: Bearer <accessToken>`.',
            '',
            'Required by `POST /api/v1/auth/logout` and `GET /api/v1/users/me`. Verification pins',
            'RS256 and checks issuer, audience, expiry, and that the token store matches the store',
            'the request resolved to.',
          ].join(' '),
        },
      },
    },
    paths: {
      '/api/v1/auth/register': {
        post: {
          tags: ['Authentication'],
          summary: 'Register a customer',
          description: [
            'Creates a customer in the resolved store and returns the user. **No tokens are',
            'issued** — registering and signing in are separate operations; call `/auth/login`',
            'afterwards.',
            '',
            'Email is trimmed and lowercased before storage, and is unique per store',
            '(case-insensitively). `isStaff` and `isSuperuser` cannot be set here: they are not',
            'accepted fields, and a request containing one is rejected with `400`.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  // Only these two. `firstName`/`lastName`/`phone` are genuinely optional in
                  // the Zod schema and default to empty/null.
                  required: ['email', 'password'],
                  additionalProperties: false,
                  properties: {
                    email: {
                      type: 'string',
                      format: 'email',
                      maxLength: 320,
                      description: 'Trimmed and lowercased before validation and storage.',
                      example: 'buyer@example.com',
                    },
                    password: {
                      type: 'string',
                      minLength: 10,
                      maxLength: 128,
                      description:
                        'Length only — no composition rules (NIST SP 800-63B). Not trimmed: whitespace is a legitimate password character.',
                      example: 'a-sufficiently-long-password',
                    },
                    firstName: { type: 'string', maxLength: 150, example: 'Ada' },
                    lastName: { type: 'string', maxLength: 150, example: 'Lovelace' },
                    phone: { type: 'string', maxLength: 20, example: '+91 98765 43210' },
                    acceptsMarketing: {
                      type: 'boolean',
                      default: false,
                      description: 'Explicit opt-in. Consent is never assumed.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Customer created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user'],
                    properties: { user: { $ref: '#/components/schemas/User' } },
                  },
                },
              },
            },
            '409': errorResponse(
              'An account with this email — or phone — already exists in this store. The message is deliberately generic and does not echo the address.',
              'EMAIL_ALREADY_REGISTERED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/auth/login': {
        post: {
          tags: ['Authentication'],
          summary: 'Log in',
          description: [
            'Verifies credentials, creates a refresh session, and returns an access token plus an',
            'opaque refresh token.',
            '',
            '**All credential failures return an identical `401`** — unknown email, wrong',
            'password, deactivated account, and erased account are indistinguishable by design.',
            'Do not try to infer account state from this endpoint.',
            '',
            'The refresh token is returned **once** and is not recoverable. Store it as a secret;',
            'only its SHA-256 hash is persisted server-side.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  additionalProperties: false,
                  properties: {
                    email: {
                      type: 'string',
                      format: 'email',
                      maxLength: 320,
                      description: 'Trimmed and lowercased, matching registration.',
                      example: 'buyer@example.com',
                    },
                    password: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 1024,
                      description:
                        "Registration's 10-character minimum is NOT applied here — that would reject users whose password predates a policy change, and would reveal that short passwords cannot exist.",
                      example: 'a-sufficiently-long-password',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Authenticated. A refresh session was created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user', 'accessToken', 'tokenType', 'expiresIn', 'refreshToken'],
                    properties: {
                      user: { $ref: '#/components/schemas/User' },
                      accessToken: {
                        type: 'string',
                        description:
                          'RS256 JWT. Claims: `sub`, `storeId`, `isStaff`, `isSuperuser`, `sid`, plus `iss`/`aud`/`exp`/`iat`/`jti`.',
                      },
                      tokenType: { type: 'string', enum: ['Bearer'], example: 'Bearer' },
                      expiresIn: {
                        type: 'integer',
                        description:
                          'Seconds until the ACCESS token expires (RFC 6749 §5.1). The refresh token lives longer; its lifetime is not advertised.',
                        example: 900,
                      },
                      refreshToken: {
                        type: 'string',
                        description:
                          '43-character base64url opaque token, 256 bits of entropy. Returned once.',
                        example: 'WcuzAss736XgOoj_L97tdFfXCeW5mdSgGK5rmthM0NQ',
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'Invalid credentials. Identical for an unknown email, a wrong password, a deactivated account, and an erased account.',
              'INVALID_CREDENTIALS',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/auth/forgot-password': {
        post: {
          tags: ['Authentication'],
          summary: 'Begin a password reset',
          description: [
            'Email a single-use reset link to the address given, if it belongs to an account.',
            '',
            '### The response never varies',
            '',
            '**Always `204`.** An unknown address, a deactivated account and a real one are',
            'indistinguishable, because any difference here would be an account-existence oracle —',
            'anyone could test an address list against this endpoint and learn who shops here. The',
            'response says nothing about whether a mail was queued.',
            '',
            '### The link',
            '',
            'Valid for **one hour** and usable **once**. Requesting again invalidates the previous',
            'link, so only the newest mail works — without that, every request would leave another',
            'live token in another inbox.',
            '',
            'Where the link points is a deployment setting. There is deliberately no `redirectUrl`',
            'field: a client-supplied URL carrying a live reset token would be an open redirect',
            'straight into a phishing flow.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email', maxLength: 320 },
                  },
                },
                example: { email: 'buyer@example.com' },
              },
            },
          },
          responses: {
            '204': {
              description:
                'Received. Whether an account exists, and whether a mail was sent, is deliberately not disclosed.',
            },
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/auth/reset-password': {
        post: {
          tags: ['Authentication'],
          summary: 'Complete a password reset',
          description: [
            'Set a new password using the token from the reset email.',
            '',
            '**Every existing session is revoked.** A reset is the recovery path for an account',
            'whose owner may have lost control of it, so leaving a refresh session alive would',
            'defeat the point of resetting. The customer signs in again afterwards — no tokens are',
            'issued here.',
            '',
            '### One error for every failure',
            '',
            'Unknown, malformed, expired, already used, minted for another store, or belonging to',
            'an account since deactivated all answer `400 INVALID_RESET_TOKEN` with the same',
            'message. Distinguishing them would tell somebody with access to an old inbox which',
            'stale link is worth racing.',
            '',
            'A rejected `newPassword` does NOT spend the token, so a customer who trips the',
            'password policy can simply try again with the same link.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['token', 'newPassword'],
                  properties: {
                    token: {
                      type: 'string',
                      maxLength: 512,
                      description:
                        'From the emailed link. Opaque — its format is not part of this contract.',
                    },
                    newPassword: {
                      type: 'string',
                      minLength: 10,
                      maxLength: 128,
                      description: 'The same policy registration and change-password apply.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '204': { description: 'The password was changed and every session revoked.' },
            '409': errorResponse(
              'The password was changed by another request while this one was in flight. Retrying is the right response.',
              'CONFLICT',
            ),
            ...COMMON_ERRORS,
            /*
             * After the spread. `COMMON_ERRORS` documents the 400 as a validation failure, which
             * is only half of it here: an unusable token is also a 400, and that is the case a
             * client actually has to handle. Overriding rather than duplicating — a duplicate key
             * is a `tsc` error, which is how this was caught.
             */
            '400': errorResponse(
              'Either the token is unusable (INVALID_RESET_TOKEN — unknown, malformed, expired, already used, or minted for another store) or the new password fails the policy (VALIDATION_ERROR).',
              'INVALID_RESET_TOKEN',
            ),
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}/invoice': {
        get: {
          tags: ['Orders'],
          summary: 'Invoice for an order',
          security: [{ bearerAuth: [] }],
          description: [
            'The invoice for one of the customer’s own orders, as a self-contained HTML document',
            'issued by **Syntellite Innovation**.',
            '',
            '### `text/html`, not JSON',
            '',
            'The only non-JSON response in this API. It is a document meant to be read and',
            'printed: opening it in a browser and printing to PDF is the intended flow, and the',
            'page carries `@media print` rules for that. There is no external stylesheet, script,',
            'font or remote image, so it renders identically offline. The company logo is an',
            'embedded `data:` PNG for that reason — the response’s own CSP allows `img-src data:`',
            'and nothing else, so a linked logo would be blocked and would rot the day the path',
            'changed.',
            '',
            'A server-generated PDF would need a rendering dependency — `pdfkit`, or headless',
            'Chromium — which is a decision worth taking on its own terms rather than as a side',
            'effect of this endpoint.',
            '',
            '### The banner tells you what the document is',
            '',
            '| Order / payment state | Banner |',
            '| --- | --- |',
            '| no payment started | `Proforma` — payment is due |',
            '| payment `pending`, method `cod` | `Cash on delivery` |',
            '| payment `pending`, method `online` | `Payment pending` |',
            '| payment `failed` or `expired` | `Payment failed` |',
            '| payment `succeeded` | `Paid` |',
            '| order `cancelled` | `Cancelled` — overrides the payment state |',
            '',
            'An invoice for an unpaid order is a proforma, and it says so. A cancelled order never',
            'reads as payable.',
            '',
            '### It is NOT a GST tax invoice',
            '',
            'Stated on the document itself. There is no tax module in this version: no tax is',
            'calculated or charged, and no GSTIN, HSN/SAC code or place of supply is recorded',
            'anywhere to put on it. The figures shown are the goods total only — the same',
            '`subtotal`, `discountTotal` and `total` the order carries.',
            '',
            'The document also has **no invoice number of its own**. A tax-compliant series is',
            'sequential, gapless and scoped to a financial year; choosing that scheme has legal',
            'consequences and has not been decided. The order number is the document reference.',
            '',
            '### Caching and headers',
            '',
            'Sent with `Cache-Control: private, no-store`, because the document contains a',
            'delivery address. It also sets its own restrictive `Content-Security-Policy` —',
            "`default-src 'none'` with inline styles only — since the API disables CSP globally",
            'on the basis that it serves no HTML.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The invoice document.',
              content: {
                'text/html': {
                  schema: {
                    type: 'string',
                    description: 'A complete HTML document, beginning `<!doctype html>`.',
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '404': errorResponse(
              'No such order. An unknown number, another customer’s order and another store’s order are deliberately indistinguishable. Errors are returned as the standard JSON envelope, not as a document.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/orders/{orderNumber}/invoice': {
        get: {
          tags: ['Orders'],
          summary: 'Invoice for any order (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The same invoice document as the customer route, for **any order in the store**.',
            'Requires the `staff` scope.',
            '',
            'Issued so that re-sending a customer their invoice is a supported operation. The',
            'alternatives it replaces were asking the customer to fetch it themselves, or signing',
            'in as them — and an audited staff route is a better security posture than',
            'impersonation.',
            '',
            '### What is relaxed, and what is not',
            '',
            '| Scoping | Customer route | This route |',
            '| --- | --- | --- |',
            '| Tenant (`store_id`) | enforced | **enforced** |',
            '| Ownership (`user_id`) | enforced | **not enforced** |',
            '',
            'Staff of one store still cannot read another store’s orders. Only ownership *within*',
            'the store is dropped, which is what makes this an admin route.',
            '',
            '### There is no staff order list',
            '',
            'This endpoint needs an order number, so it serves an agent who already has one from',
            'the customer. `GET /admin/orders` does not exist: a browsable order surface needs its',
            'own decisions about filtering, pagination and how much of another customer’s address',
            'staff may see, and those should not be settled as a side effect of an invoice.',
            '',
            'Response headers, banner logic and the “not a GST tax invoice” caveat are identical',
            'to the customer route — the two share one renderer and one response helper, so they',
            'cannot drift.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The invoice document.',
              content: {
                'text/html': {
                  schema: {
                    type: 'string',
                    description: 'A complete HTML document, beginning `<!doctype html>`.',
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Derived from the database on every request, so a demotion takes effect immediately. A customer receives this even for their own order — the customer route is the one they should use.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such order in this store. An unknown number and another store’s order are deliberately indistinguishable. Another customer’s order in the same store is NOT a 404 here — that is the point of the route.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/store/tax-profile': {
        get: {
          tags: ['Tax'],
          summary: 'Read the seller GST profile',
          security: [{ bearerAuth: [] }],
          description: [
            'The store\u2019s own GST identity and origin address, plus a computed `configured` flag.',
            '',
            '**Staff only, and deliberately absent from every public store payload.** These are the',
            'seller\u2019s registration details: they belong on an invoice and in the admin surface, not',
            'on a response every visitor receives.',
            '',
            '`configured` is the single most consequential field in this module — see the PUT.',
          ].join(' '),
          responses: {
            '200': {
              description: 'The profile. Every field is null when GST has not been configured.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxProfile'],
                    properties: { taxProfile: { $ref: '#/components/schemas/StoreTaxProfile' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
        put: {
          tags: ['Tax'],
          summary: 'Configure the seller GST profile',
          security: [{ bearerAuth: [] }],
          description: [
            '**This is the GST switch.** Once a profile exists, every checkout in this store is',
            'assessed, and a line whose SKU cannot resolve an active tax class and a rate in force',
            'is refused with `422 TAX_NOT_DETERMINABLE` rather than silently untaxed. A store with',
            'no profile assesses nothing and its orders carry no tax determination at all.',
            '',
            '**A full replace, not a patch.** Identity and origin are all-or-nothing in the',
            'database, so a partial write could fail a constraint the caller could not have',
            'predicted from the field they touched. Sending the whole object makes the outcome',
            'obvious from the request, and makes "configure GST" one auditable act.',
            '',
            '`gstin` and `pan` are validated for SHAPE only — no checksum. Implementing the check',
            'digit would be engineering inventing a validation rule, and a wrong implementation',
            'rejects a legitimate registration.',
            '',
            '`originState` is the seller half of the CGST/SGST-versus-IGST comparison. It is free',
            'text and is compared against the delivery state after normalising case and',
            'whitespace; a GST state-code catalogue is statutory master data this build does not',
            'invent, so two different SPELLINGS of one state will compare unequal.',
          ].join(' '),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'legalName',
                    'gstin',
                    'originLine1',
                    'originCity',
                    'originState',
                    'originPostalCode',
                    'originCountryCode',
                  ],
                  properties: {
                    legalName: { type: 'string', minLength: 1, maxLength: 300 },
                    gstin: {
                      type: 'string',
                      minLength: 15,
                      maxLength: 15,
                      description: 'Upper-cased before validation.',
                      example: '29ABCDE1234F1Z5',
                    },
                    pan: {
                      description: 'Optional: a GSTIN already embeds the PAN.',
                      oneOf: [{ type: 'string', minLength: 10, maxLength: 10 }, { type: 'null' }],
                    },
                    originLine1: { type: 'string', minLength: 1, maxLength: 300 },
                    originLine2: { type: 'string', maxLength: 300 },
                    originCity: { type: 'string', minLength: 1, maxLength: 120 },
                    originState: { type: 'string', minLength: 1, maxLength: 120 },
                    originPostalCode: { type: 'string', minLength: 1, maxLength: 16 },
                    originCountryCode: { type: 'string', minLength: 2, maxLength: 2 },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The stored profile.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxProfile'],
                    properties: { taxProfile: { $ref: '#/components/schemas/StoreTaxProfile' } },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/tax-classes': {
        post: {
          tags: ['Tax'],
          summary: 'Create a tax class',
          security: [{ bearerAuth: [] }],
          description: [
            'A classification a SKU points at and rates hang off. It holds NO percentage:',
            'rates are effective-dated and a class is not, so putting one here would mean losing',
            'the old value on every change and with it the ability to reprice a historical order.',
            '',
            'The `code` is immutable after creation, because every order line that uses the class',
            'snapshots it.',
          ].join(' '),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['code', 'name'],
                  properties: {
                    code: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description:
                        'Case-SENSITIVE. Letters, digits, dots, underscores, slashes and hyphens; no whitespace, so it survives a URL path unencoded.',
                      example: 'GST-STD',
                    },
                    name: { type: 'string', minLength: 1, maxLength: 300 },
                    isActive: { type: 'boolean', description: 'Defaults to true.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The created class.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxClass'],
                    properties: { taxClass: { $ref: '#/components/schemas/TaxClass' } },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '409': errorResponse(
              'A tax class in this store already uses this code, compared case-sensitively.',
              'TAX_CLASS_ALREADY_EXISTS',
            ),
            ...COMMON_ERRORS,
          },
        },
        get: {
          tags: ['Tax'],
          summary: 'List tax classes',
          security: [{ bearerAuth: [] }],
          description:
            'A page of this store\u2019s tax classes, ordered by code. Inactive classes are included: a merchant must be able to see the classification they retired, not least because historical orders still name it.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of classes.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxClasses', 'pagination'],
                    properties: {
                      taxClasses: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/TaxClass' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/tax-classes/{code}': {
        patch: {
          tags: ['Tax'],
          summary: 'Rename or deactivate a tax class',
          security: [{ bearerAuth: [] }],
          description: [
            'Name and active state only. **The code cannot be changed** — historical order lines',
            'carry it as a snapshot, so renaming would leave past invoices naming a code the admin',
            'surface no longer has.',
            '',
            '**Deactivating is not free.** Every SKU pointing at this class becomes unsellable in a',
            'store with a GST profile: checkout refuses the line with 422 rather than assessing it',
            'at zero. That is deliberate — silently untaxing a line is an accounting error nobody',
            'notices until a return is filed.',
          ].join(' '),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 64 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  description: 'At least one field must be supplied.',
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 300 },
                    isActive: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated class.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxClass'],
                    properties: { taxClass: { $ref: '#/components/schemas/TaxClass' } },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such tax class in this store. An unknown code and another store\u2019s class are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/tax-classes/{code}/rates': {
        post: {
          tags: ['Tax'],
          summary: 'Add an effective-dated rate',
          security: [{ bearerAuth: [] }],
          description: [
            '**Rates are configuration, never code.** There is no default, no seed and no constant',
            'anywhere in this system naming a GST percentage; a class has no rate until one is',
            'configured here, and a checkout that cannot find one is refused.',
            '',
            'The window is half-open: `effectiveFrom` is inclusive, `effectiveTo` is exclusive, and',
            'null means open-ended. Overlapping windows for one class are refused — the class row',
            'is locked before the check, so two staff configuring rates at once serialise rather',
            'than both writing.',
            '',
            '**No relationship between the four components is validated.** The conventional',
            'arrangement is that IGST equals CGST plus SGST; asserting it would make this API the',
            'authority on a rule the finance function owns.',
            '',
            'There is deliberately **no update and no delete**. A rate that was in force is what a',
            'historical order was assessed under; superseding it with a new dated window is the',
            'honest correction.',
          ].join(' '),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 64 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['cgstRate', 'sgstRate', 'igstRate', 'effectiveFrom'],
                  properties: {
                    cgstRate: {
                      type: 'string',
                      description:
                        'A percentage as a decimal STRING, at most 6 decimal places, 0 to 100. Zero is accepted: a zero-rate class records that a determination was made at nil.',
                      example: '9',
                    },
                    sgstRate: { type: 'string', example: '9' },
                    igstRate: { type: 'string', example: '18' },
                    cessRate: { type: 'string', description: 'Defaults to 0.', example: '0' },
                    effectiveFrom: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        'Required, with no default: defaulting it to "now" would make the most consequential field on the row an accident of when the request arrived.',
                    },
                    effectiveTo: {
                      description: 'Exclusive, or null / absent for open-ended.',
                      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The created rate.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxRate'],
                    properties: { taxRate: { $ref: '#/components/schemas/TaxRate' } },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such tax class in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'The window overlaps a rate already configured for this class. The conflicting window is named in details.',
              'TAX_RATE_OVERLAP',
            ),
            ...COMMON_ERRORS,
          },
        },
        get: {
          tags: ['Tax'],
          summary: 'List a class rates',
          security: [{ bearerAuth: [] }],
          description:
            'Every rate configured for the class, newest window first. Superseded windows are included — they are what historical orders were assessed under.',
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 64 },
            },
          ],
          responses: {
            '200': {
              description: 'The class and its rates.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxClass', 'taxRates'],
                    properties: {
                      taxClass: { $ref: '#/components/schemas/TaxClass' },
                      taxRates: { type: 'array', items: { $ref: '#/components/schemas/TaxRate' } },
                    },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such tax class in this store.', 'NOT_FOUND'),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/skus/{code}/tax': {
        put: {
          tags: ['Tax'],
          summary: 'Classify a SKU',
          security: [{ bearerAuth: [] }],
          description: [
            '**The SKU is the tax-classification unit**, and two SKUs of one product may carry',
            'different HSN codes and different classes. There is deliberately no product-level',
            'fallback: a SKU inheriting a classification that may be wrong for it is under- or',
            'over-charged tax on every sale.',
            '',
            'Both fields move together, or both are null to clear — a class with no HSN cannot',
            'produce a compliant invoice line, and an HSN with no class has no rate to apply.',
            '',
            '**An unclassified SKU is not untaxed.** In a store with a GST profile, checkout refuses',
            'it with `422 TAX_NOT_DETERMINABLE`.',
            '',
            'A route of its own rather than fields on the SKU PATCH: classification is tax master',
            'data with a different authority and a different reviewer from a SKU name and price.',
          ].join(' '),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 64 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['taxClassCode', 'hsnCode'],
                  properties: {
                    taxClassCode: {
                      oneOf: [{ type: 'string', minLength: 1, maxLength: 64 }, { type: 'null' }],
                    },
                    hsnCode: {
                      description:
                        'Two to eight digits. Deliberately not a fixed digit count: the number required depends on a turnover threshold this build does not invent. There is no catalogue check, because there is no catalogue.',
                      oneOf: [{ type: 'string', minLength: 2, maxLength: 8 }, { type: 'null' }],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The SKU classification.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['skuTax'],
                    properties: { skuTax: { $ref: '#/components/schemas/SkuTax' } },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such SKU in this store, a deleted SKU, or an unknown tax class. All indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/users/me/tax-identity': {
        get: {
          tags: ['Tax'],
          summary: 'Read your GST registration',
          security: [{ bearerAuth: [] }],
          description:
            'The caller\u2019s own GST registration. A 404 when they have not set one: "you have not set one" is the absence of a resource, and every other single-resource read in this API answers absence the same way.',
          responses: {
            '200': {
              description: 'The registration.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxIdentity'],
                    properties: {
                      taxIdentity: { $ref: '#/components/schemas/CustomerTaxIdentity' },
                    },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '404': errorResponse('The caller has no GST registration on file.', 'NOT_FOUND'),
            ...COMMON_ERRORS,
          },
        },
        put: {
          tags: ['Tax'],
          summary: 'Set your GST registration',
          security: [{ bearerAuth: [] }],
          description: [
            'Create or replace, so the endpoint is idempotent and there is no already-exists',
            'conflict to handle.',
            '',
            '**Supplying one makes your next order B2B**, and the GSTIN is snapshotted onto it. It',
            'does NOT retroactively change an order already placed: those carry their own snapshot.',
            '',
            'Two fields, and that is the whole of it. No place of business, no verification state,',
            'no second registration — each would be a feature with no consumer.',
            '',
            'The GSTIN is validated for SHAPE only; there is no checksum and no registry lookup.',
          ].join(' '),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['gstin', 'legalName'],
                  properties: {
                    gstin: {
                      type: 'string',
                      minLength: 15,
                      maxLength: 15,
                      description: 'Upper-cased before validation.',
                      example: '29ABCDE1234F1Z5',
                    },
                    legalName: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      description:
                        'The registered legal name the GSTIN belongs to — a business, not the account holder.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The stored registration.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['taxIdentity'],
                    properties: {
                      taxIdentity: { $ref: '#/components/schemas/CustomerTaxIdentity' },
                    },
                  },
                },
              },
            },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            ...COMMON_ERRORS,
          },
        },
        delete: {
          tags: ['Tax'],
          summary: 'Remove your GST registration',
          security: [{ bearerAuth: [] }],
          description:
            'A hard delete, and correct: every order that used the GSTIN carries its own copy, so nothing an audit needs is lost. Your next order is B2C.',
          responses: {
            '204': { description: 'Removed.' },
            '401': errorResponse('Not authenticated.', 'AUTHENTICATION_REQUIRED'),
            '404': errorResponse('There was no registration to remove.', 'NOT_FOUND'),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/users/me/orders/{orderNumber}/shipments': {
        get: {
          tags: ['Fulfilment'],
          summary: 'Track a shipment',
          security: [{ bearerAuth: [] }],
          description: [
            'Where the customer’s parcel is. An **empty array** is a normal answer — the order',
            'exists and has not shipped yet — and it is a different answer from `404`, which',
            'means the order is unknown, another customer’s, or another store’s.',
            '',
            'At most one shipment per order, so the array holds zero or one entry. Split',
            'deliveries are not supported; see the staff create endpoint.',
            '',
            '### What is deliberately not here',
            '',
            'No shipment id, no order id, no internal note and nothing about inventory. A customer',
            'gets exactly the facts needed to find their parcel: the state, who is carrying it,',
            'the consignment number, and the two timestamps.',
            '',
            '`carrier` and `trackingNumber` are **nullable**, and often null: a shipment is raised',
            'when picking starts and the courier is frequently chosen later.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The order’s shipments. Empty until it ships.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['shipments'],
                    properties: {
                      shipments: {
                        type: 'array',
                        maxItems: 1,
                        items: {
                          type: 'object',
                          required: [
                            'status',
                            'carrier',
                            'trackingNumber',
                            'trackingUrl',
                            'shippedAt',
                            'deliveredAt',
                          ],
                          properties: {
                            status: {
                              type: 'string',
                              enum: ['pending', 'shipped', 'delivered'],
                              description:
                                '`pending` — raised, not yet despatched. `shipped` — goods have left. `delivered` — arrival recorded.',
                            },
                            carrier: { type: 'string', nullable: true, maxLength: 120 },
                            trackingNumber: { type: 'string', nullable: true, maxLength: 120 },
                            trackingUrl: {
                              type: 'string',
                              nullable: true,
                              maxLength: 500,
                              description: 'Always `http` or `https`; other schemes are refused.',
                            },
                            shippedAt: { type: 'string', format: 'date-time', nullable: true },
                            deliveredAt: { type: 'string', format: 'date-time', nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '404': errorResponse(
              'No such order. An unknown number, another customer’s order and another store’s order are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/fulfilment': {
        get: {
          tags: ['Fulfilment'],
          summary: 'Orders awaiting fulfilment (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The work queue: orders in this store that still need shipping, oldest first.',
            '',
            '**This is not an admin order list.** The predicate is exactly "work to do" — the',
            'order is not cancelled, and it has either no shipment or one still `pending`. There',
            'is no customer search, no status filter, no date range and no free text, and an',
            'unknown query parameter is a `400` rather than being ignored. Widening it would make',
            'this the general-purpose admin order surface this API deliberately does not have.',
            '',
            '### Keyset pagination, not offset',
            '',
            'A queue is worked from the front while rows leave it, so `OFFSET` would skip orders',
            'as earlier ones are shipped — in a fulfilment queue that means an order nobody ever',
            'sees. Pass the `nextCursor` from the previous page; `null` means the last page. The',
            'cursor is opaque and its format may change.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 200 },
              description: 'The `nextCursor` from a previous page. Opaque.',
            },
          ],
          responses: {
            '200': {
              description: 'A page of orders needing fulfilment.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['orders', 'nextCursor'],
                    properties: {
                      orders: {
                        type: 'array',
                        items: {
                          type: 'object',
                          required: [
                            'orderNumber',
                            'placedAt',
                            'recipientName',
                            'city',
                            'postalCode',
                            'shipmentStatus',
                          ],
                          properties: {
                            orderNumber: { type: 'string' },
                            placedAt: { type: 'string', format: 'date-time' },
                            recipientName: { type: 'string' },
                            city: { type: 'string' },
                            postalCode: { type: 'string' },
                            shipmentStatus: {
                              type: 'string',
                              nullable: true,
                              enum: ['pending'],
                              description: '`null` when no shipment has been raised yet.',
                            },
                          },
                        },
                      },
                      nextCursor: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid or expired.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/shipments': {
        get: {
          tags: ['Fulfilment'],
          summary: 'List the store’s shipments (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of **every shipment in the store**, newest first. Requires the `staff` scope.',
            '',
            'The read this module never had. `PATCH /admin/shipments/{id}` and both transition',
            'routes have always addressed a shipment by id, so staff could change a shipment they',
            'had no way to look at — and the only listing was `GET /admin/orders/fulfilment`,',
            'which is a worklist of orders AWAITING shipment and therefore excludes every',
            'shipment that already exists.',
            '',
            '### Filters are exact, not searches',
            '',
            '`status` must be one of the real vocabulary. `orderNumber` must match the generated',
            'shape; because `uq_shipment_order` allows one shipment per order it selects at most',
            'one row, and an unknown number is an **empty page, not a `404`** — it is a filter,',
            'not a lookup.',
            '',
            '**No date filters.** None was asked for, and adding one would pull in the',
            'millisecond-versus-microsecond bound question the order and payment lists answer.',
            '',
            'Ordered by `createdAt` descending, then `id` descending — a total order, so `offset`',
            'paging cannot skip or repeat rows when two shipments share an instant.',
            '',
            'Store-scoped from the verified staff token. There is no `storeId` parameter, and the',
            'query object is strict, so supplying one is a `400`.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
            },
            {
              name: 'orderNumber',
              in: 'query',
              required: false,
              description:
                'An EXACT order number, not a search. An unknown number is an empty page, not a 404.',
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          responses: {
            '200': {
              description: 'A page of the store’s shipments, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['shipments', 'pagination'],
                    properties: {
                      shipments: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminShipment' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}/shipments': {
        post: {
          tags: ['Fulfilment'],
          summary: 'Raise a shipment (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates the order’s shipment in `pending`. **It does not despatch it** — `/ship`',
            'does, and it is a separate call because moving stock is irreversible and should not',
            'be a side effect of a request whose body is tracking metadata.',
            '',
            '### One shipment per order',
            '',
            'Enforced by a unique constraint, which is also the duplicate-click guard: two staff',
            'pressing Create produce one shipment and one `409`. That is why this endpoint takes',
            '**no `Idempotency-Key`** — a constraint does the work a header would only approximate.',
            '',
            'Partial fulfilment is not supported: one shipment covers the whole order.',
            '',
            '### The payment prerequisite',
            '',
            '| Payment | May raise a shipment |',
            '| --- | --- |',
            '| online, `succeeded` | yes |',
            '| online, `pending` / `failed` / `expired` | no — `422` |',
            '| **cash on delivery, `pending`** | **yes** |',
            '| none | no — `422` |',
            '',
            'The COD row is an approved business rule: a COD payment never reaches a terminal',
            'state, so requiring `succeeded` would make COD unsellable. **It does not mean the',
            'payment is settled** — nothing about the payment changes, and the money has not',
            'arrived.',
            '',
            '### Server-controlled fields',
            '',
            '`status`, `shippedAt` and `deliveredAt` are not accepted, and neither is any',
            'identifier: the order comes from the path and the store from the token. The body is',
            'a strict object, so each is a `400` naming the field rather than being ignored.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    carrier: { type: 'string', minLength: 1, maxLength: 120 },
                    trackingNumber: { type: 'string', minLength: 1, maxLength: 120 },
                    trackingUrl: {
                      type: 'string',
                      format: 'uri',
                      maxLength: 500,
                      description:
                        'Must be `http` or `https`. Other schemes are refused — this value is rendered as a link.',
                    },
                  },
                },
                examples: {
                  courierKnown: {
                    summary: 'Courier already chosen',
                    value: { carrier: 'Bluedart', trackingNumber: 'BD123456789' },
                  },
                  courierUnknown: { summary: 'Picking has started', value: {} },
                },
              },
            },
          },
          responses: {
            '201': { $ref: '#/components/responses/StaffShipment' },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such order in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'The order already has a shipment (SHIPMENT_ALREADY_EXISTS), or this tracking number is already recorded for this carrier.',
              'SHIPMENT_ALREADY_EXISTS',
            ),
            '422': errorResponse(
              'The order cannot be fulfilled. `details.reason` is `order_cancelled`, `payment_not_succeeded`, `no_payment` or `cod_not_pending`.',
              'ORDER_NOT_FULFILLABLE',
            ),
            ...COMMON_ERRORS,
          },
        },
        get: {
          tags: ['Fulfilment'],
          summary: 'One order’s shipments (staff)',
          security: [{ bearerAuth: [] }],
          description:
            'The staff view of an order’s shipments — the customer fields plus the shipment `id` needed to act on it, and `createdAt`.',
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          responses: {
            '200': {
              description: 'The order’s shipments.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/StaffShipmentList' } },
              },
            },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such order in this store.', 'NOT_FOUND'),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/shipments/{id}/ship': {
        post: {
          tags: ['Fulfilment'],
          summary: 'Despatch a shipment (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            '**The goods leave, and the stock moves.** This is the only operation in the API that',
            'decreases physical inventory.',
            '',
            'In one transaction: the order’s complete reservation becomes `fulfilled`,',
            '`stock_item.on_hand` and `reserved` each fall by the shipped quantity — so',
            '`available` is UNCHANGED, because the units stopped being sellable when they were',
            'reserved — and one inventory-ledger row is written per SKU with reason `shipment`.',
            'If any part of that fails, the whole thing rolls back and the shipment stays',
            '`pending`: **a shipment is never `shipped` with the stock movement incomplete.**',
            '',
            'An action endpoint rather than `PATCH {status}`, so an illegal transition is',
            'unrepresentable rather than merely rejected.',
            '',
            'Idempotent by construction: a row lock plus a compare-and-swap mean a second call is',
            'a `409` with no second stock movement, no second ledger row and no re-stamped',
            'timestamp. No `Idempotency-Key` is needed or accepted.',
            '',
            'The payment prerequisite is the same table as the create endpoint, including the',
            'approved unpaid-COD path.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    note: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 500,
                      description:
                        'Internal remark, recorded on the transition. Never shown to the customer.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { $ref: '#/components/responses/StaffShipment' },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such shipment in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'The shipment cannot make this transition — it has already shipped. `details.from` and `details.to` name the attempted move. Also returned when the order holds no reservation to fulfil, or it was already released or fulfilled.',
              'SHIPMENT_NOT_TRANSITIONABLE',
            ),
            '422': errorResponse(
              'The order cannot be fulfilled. `details.reason` explains which prerequisite failed.',
              'ORDER_NOT_FULFILLABLE',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/shipments/{id}/deliver': {
        post: {
          tags: ['Fulfilment'],
          summary: 'Record delivery (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Records that the parcel arrived. **No stock moves** — the units left the building at',
            '`/ship`, and inventory has nothing further to say about them.',
            '',
            'Only a `shipped` shipment can be delivered; `pending` is a `409`. A second call is',
            'also a `409`, and **`deliveredAt` is never overwritten**.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    note: { type: 'string', minLength: 1, maxLength: 500 },
                  },
                },
              },
            },
          },
          responses: {
            '200': { $ref: '#/components/responses/StaffShipment' },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such shipment in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'The shipment is not `shipped`, or it is already `delivered`.',
              'SHIPMENT_NOT_TRANSITIONABLE',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/shipments/{id}': {
        get: {
          tags: ['Fulfilment'],
          summary: 'Read one shipment with its history (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'One shipment and every transition it has made. Requires the `staff` scope.',
            '',
            'The same fields as a list row, plus `history` — the transitions in order, oldest',
            'first, each with the note a staff member typed at the time. The history is here and',
            'not on the list because a page of 100 shipments would otherwise carry every',
            'transition any of them ever made to render a table that shows none of them.',
            '',
            'The creation row has `fromStatus: null`; a shipment is created IN `pending` rather',
            'than transitioning into it.',
            '',
            'Store-scoped from the verified staff token. An unknown id and a shipment belonging',
            'to ANOTHER store are both `404` and deliberately indistinguishable — the query',
            'returns nothing for either, so the endpoint cannot confirm that a shipment exists',
            'elsewhere.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description:
                'A UUID by shape only. Existence and tenancy are decided by the query, so a malformed id is a 400 and every other miss is a 404.',
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The shipment and its transition history.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['shipment'],
                    properties: {
                      shipment: { $ref: '#/components/schemas/AdminShipmentDetail' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such shipment in this store. An unknown id and another store’s shipment are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
        patch: {
          tags: ['Fulfilment'],
          summary: 'Correct tracking details (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Fixes the carrier, consignment number or tracking link. **It cannot change state** —',
            'there is no `status` field in the schema, which is why the transitions are separate',
            'action endpoints.',
            '',
            'Three-way semantics: omit a field to leave it alone, send `null` to clear it, send a',
            'value to set it. At least one field is required — a PATCH that changes nothing is a',
            '`400`.',
            '',
            'Permitted in any state, `delivered` included: a wrong tracking number stays wrong and',
            'the customer is still looking at it. Audited, because the field is customer-visible.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  minProperties: 1,
                  properties: {
                    carrier: { type: 'string', nullable: true, minLength: 1, maxLength: 120 },
                    trackingNumber: {
                      type: 'string',
                      nullable: true,
                      minLength: 1,
                      maxLength: 120,
                    },
                    trackingUrl: {
                      type: 'string',
                      format: 'uri',
                      nullable: true,
                      maxLength: 500,
                      description: 'Must be `http` or `https`.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { $ref: '#/components/responses/StaffShipment' },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse(
              'The caller does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse('No such shipment in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'This tracking number is already recorded for this carrier in this store.',
              'CONFLICT',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}/cancel': {
        post: {
          tags: ['Orders'],
          summary: 'Cancel an order',
          security: [{ bearerAuth: [] }],
          description: [
            'Withdraw an order nobody has been charged for. **No request body** — the order comes',
            'from the path, the customer from the token, and the only decision is one the server',
            'makes about eligibility.',
            '',
            '### When it is allowed',
            '',
            '| Payment state | Cancel? |',
            '| ------------- | ------- |',
            '| none | yes |',
            '| `failed`, `expired` | yes |',
            '| `pending` | **no** — a capture may still land |',
            '| `succeeded` | **no** — refunds are not supported |',
            '',
            'Refunds do not exist in this version, so nothing here may create money the system',
            'cannot return. `pending` is refused for the subtler version of the same reason: an',
            'online capture can arrive at any moment, and cancelling would race it. The customer',
            'waits for the payment to fail or expire, then cancels.',
            '',
            '`details.reason` distinguishes the cases — `status`, `payment_in_progress`, `paid` —',
            'so a client can tell "wait and retry" from "contact support" without parsing prose.',
            '',
            '### Terminal, and not idempotent',
            '',
            'A cancelled order cannot be un-cancelled, and it cannot then be paid for. A second',
            'cancellation answers `409` rather than replaying `200`: a client told "cancelled"',
            'twice cannot tell whether it cancelled something or nothing.',
            '',
            'No `Idempotency-Key` is required or accepted — the status predicate on the update is',
            'a natural guard, so a duplicate request cannot cancel twice.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The cancelled order. Only `status` differs from before the call.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['order'],
                    properties: { order: { $ref: '#/components/schemas/Order' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '404': errorResponse(
              'No such order. An unknown number, another customer’s order and another store’s order are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'The order cannot be cancelled. `details.reason` is `status` (already cancelled), `payment_in_progress` (a payment is pending), or `paid` (money was taken and refunds are not supported).',
              'ORDER_NOT_CANCELLABLE',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}/payment': {
        get: {
          tags: ['Payments'],
          summary: 'Read an order’s payment (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The order’s payment, with the provider’s identifiers. Requires the `staff` scope.',
            '',
            'The list above pages and filters; this answers “show me THIS order’s payment”, and it',
            'is where the provider’s charge id is published.',
            '',
            '### Why the order number addresses it',
            '',
            'The payment’s own id is published nowhere in this API — the staff list omits it',
            'because a payment is addressed by the order it pays for — so a `/admin/payments/{id}`',
            'route would be unreachable by any client that had not first been handed an id no',
            'endpoint returns. `uq_payment_order` makes one order exactly one payment, so the order',
            'number is an exact address rather than a filter.',
            '',
            '### Three fields the list row does not carry',
            '',
            '| Field | What it is |',
            '| --- | --- |',
            '| `provider` | Which gateway handled it. Null for `cod`. |',
            '| `providerRef` | The provider’s **order** — Razorpay `order_…`, written by us at initiation, before anybody paid. |',
            '| `providerTransactionId` | The provider’s **charge** — Razorpay `pay_…`, the “Transaction ID” its dashboard shows. |',
            '',
            'Those last two are routinely confused and are different entities. Neither is a',
            'credential: acting on the provider requires the API secret, which never leaves the',
            'server. A third identifier, the webhook **delivery** id, is deduplication material and',
            'is not published here or anywhere else.',
            '',
            '### Still absent',
            '',
            '`amountMinor`, the internal payment id, `userId`, `orderId`, `storeId`, and the',
            'transition timeline — the last is a separate surface that this route does not open.',
            '',
            '### Tenancy',
            '',
            'Store-scoped from the verified staff token. An unknown order, another store’s order,',
            'and an order with no payment are all `404` and indistinguishable.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The order’s payment.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['payment'],
                    properties: {
                      payment: { $ref: '#/components/schemas/AdminPaymentDetail' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Scopes are read from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such order in this store, or the order has no payment. The two are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/payments': {
        get: {
          tags: ['Payments'],
          summary: 'List the store’s payments (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of **every payment in the store**, whosever it is. Requires the `staff` scope.',
            '',
            'The module’s first staff route, and it is a **read**. The two questions the payments',
            'module previously recorded as undecided now have answers: a support agent may see',
            'every payment in their OWN store and none from another, and a provider reference is',
            'NOT among the fields.',
            '',
            '### What is deliberately absent',
            '',
            '| Field | Why |',
            '| --- | --- |',
            '| `providerRef` | The gateway handle — a capability to act provider-side. It goes to the paying customer for the checkout handoff and nobody else. |',
            '| `amountMinor` | The integer mirror kept for the provider call. Money leaves this system as a decimal string; publishing both invites a client to pick one. |',
            '| internal ids | A payment is addressed here by its order number. |',
            '',
            'The provider’s identifiers live on the DETAIL route, `GET',
            '/api/v1/admin/orders/{orderNumber}/payment` — one payment read deliberately, rather',
            'than a page of handles. There is still **no refund, no reconciliation and no staff',
            'mutation of any kind**. Staff may see that a payment exists and what state it reached.',
            '',
            '### Tenancy',
            '',
            'Store-scoped from the verified staff token. There is no `storeId` parameter, and the',
            'query object is strict, so supplying one is a `400` rather than something ignored.',
            '',
            'Ordered by `createdAt` descending, then `id` descending. The tiebreaker matters:',
            '`createdAt` alone is not a total order, and a non-total order makes `offset` paging',
            'silently skip and repeat rows between pages.',
            '',
            '**Both date bounds are inclusive, at millisecond granularity.** A bound NAMES A',
            'MILLISECOND — that is the finest instant this API can express, because a query',
            'parameter becomes a JavaScript `Date` and `createdAt` is published with three',
            'fractional digits — and an inclusive bound includes the whole of the millisecond',
            'named. So a row stored at `10:00:00.123456Z`, published as `10:00:00.123Z`, is',
            'returned by `createdTo=2026-09-15T10:00:00.123Z`: **a row’s own timestamp always',
            'round-trips as a bound.** `…122Z` excludes it and `…124Z` as a lower bound excludes',
            'it, so no adjacent millisecond is swept in.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'expired'] },
            },
            {
              name: 'method',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['online', 'cod'] },
            },
            {
              name: 'provider',
              in: 'query',
              required: false,
              description: 'Matches no `cod` payment — those have a null provider by construction.',
              schema: { type: 'string', enum: ['razorpay'] },
            },
            {
              name: 'orderNumber',
              in: 'query',
              required: false,
              description:
                'An EXACT order number, not a search. `uq_payment_order` means this narrows to at most one payment. An unknown number is an empty page, not a `404` — it is a filter, not a lookup.',
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
            },
            {
              name: 'transactionId',
              in: 'query',
              required: false,
              description: [
                'An EXACT provider **charge** id — Razorpay’s `pay_…`, the id its dashboard shows',
                'against a payment. `uq_payment_provider_txn` makes this at most one row per store.',
                '',
                'Not `providerRef`, which is the provider **order** (`order_…`) created before',
                'anybody paid, and not the webhook delivery id. Matches no `cod` payment and no',
                'payment that has not been charged — both have none.',
                '',
                'Validated as a charset and a length, not as a `pay_` prefix: the value belongs to',
                'the provider, and pinning its shape would turn the provider changing its own',
                'identifiers into a `400` on a lookup that would otherwise have worked.',
              ].join('\n'),
              schema: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z0-9_-]+$' },
              example: 'pay_MgkB2Xq7RtLmNp',
            },
            {
              name: 'createdFrom',
              in: 'query',
              required: false,
              description:
                'INCLUSIVE lower bound on `createdAt`. A full ISO-8601 instant WITH an offset — the client owns the timezone, deliberately: a bare date would force the server to pick one, and every choice is wrong for somebody.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-01T00:00:00+05:30',
            },
            {
              name: 'createdTo',
              in: 'query',
              required: false,
              description: 'INCLUSIVE upper bound on `createdAt`. Same format as `createdFrom`.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-30T23:59:59+05:30',
            },
          ],
          responses: {
            '200': {
              description: 'A page of the store’s payments, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['payments', 'pagination'],
                    properties: {
                      payments: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminPayment' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Scopes are read from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/dashboard': {
        get: {
          tags: ['Dashboard'],
          summary: 'The admin overview screen (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Every figure the dashboard renders, in one read. Requires the `staff` scope.',
            '',
            'One endpoint rather than seven, because it is one screen and the widgets share a date',
            'range that would otherwise have to be re-derived — and re-agreed — by each of them.',
            'Internally it is composition only: each figure is computed by the module that owns the',
            'rows, and nothing here reads a table it does not own.',
            '',
            '### What the date range governs',
            '',
            '| Affected by `from`/`to` | Always as-of-now |',
            '| --- | --- |',
            '| `kpis.revenue` | `kpis.products` |',
            '| `kpis.orders` | `kpis.customers` |',
            '| `salesSeries` | `orderStatusCounts` |',
            '| `topProducts` | `lowStock`, `recentOrders` |',
            '',
            'The right-hand column is deliberate. A customer total silently narrowed to the selected',
            'month would be read as a lifetime figure, and a low-stock alert scoped to last quarter',
            'would describe stock nobody holds any more.',
            '',
            '### Revenue is BILLED value, not cash received',
            '',
            'Revenue is `SUM(order.grandTotal)` over NON-CANCELLED orders placed inside the window.',
            '',
            '| Included | Excluded |',
            '| --- | --- |',
            '| GST — `grandTotal` is tax-inclusive | cancelled orders |',
            '| cash-on-delivery orders | returns and refunds |',
            '| orders whose online payment later failed | |',
            '',
            'A cash-on-delivery payment never reaches `succeeded` in this system, so a definition',
            'based on captured money would report zero for every COD sale. This one does not have',
            'that defect, and pays for it by counting an order whose online payment failed. Returns',
            'are not deducted because no refund has ever been executed here — subtracting a',
            'requested refund would report a reversal that never happened.',
            '',
            'It is the SAME definition `totalSpent` uses on the customer surface, so the two screens',
            'cannot disagree about what a sale was worth.',
            '',
            '### Dates, and the previous period',
            '',
            'Both bounds are INCLUSIVE at millisecond granularity, the convention every admin list',
            'here follows: the upper bound names a millisecond and includes the whole of it, so an',
            'order’s own published `placedAt` always round-trips as a bound even though PostgreSQL',
            'stores microseconds underneath.',
            '',
            'The previous period is the equal-DURATION window immediately before this one, ending',
            'one millisecond before `from`. No overlap, no gap. Equal duration rather than equal',
            'calendar shape, so a 28-day February is never compared against a 31-day January and the',
            'difference called growth.',
            '',
            'Omitted, the window is the last twelve calendar months through now — the chart is',
            'monthly, and a 30-day default would render one or two bars.',
            '',
            '### Buckets',
            '',
            'Truncated in the STORE’s configured timezone, not UTC. Every bucket the window spans is',
            'present, zero-filled where there were no orders — a month with no sales is a fact, and',
            'omitting it would draw a line straight from March to May.',
            '',
            '### Tenancy',
            '',
            'Store-scoped from the verified staff token. There is no `storeId` parameter, and the',
            'query object is strict, so supplying one is a `400`.',
            '',
            'No internal identifiers appear anywhere in the response: SKUs are addressed by their',
            'merchant code and orders by their order number.',
          ].join('\n'),
          parameters: [
            {
              name: 'from',
              in: 'query',
              required: false,
              description:
                'INCLUSIVE lower bound on `placedAt`. A full ISO-8601 instant WITH an offset — the client owns the timezone, deliberately: a bare date would force the server to pick one, and every choice is wrong for somebody. Defaults to twelve calendar months before `to`.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-01-01T00:00:00+05:30',
            },
            {
              name: 'to',
              in: 'query',
              required: false,
              description:
                'INCLUSIVE upper bound on `placedAt`. Same format as `from`. Defaults to now.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-12-31T23:59:59+05:30',
            },
            {
              name: 'interval',
              in: 'query',
              required: false,
              description: 'Calendar bucket for `salesSeries`, truncated in the store’s timezone.',
              schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'month' },
            },
            {
              name: 'topProductsLimit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
            },
            {
              name: 'lowStockLimit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
            },
            {
              name: 'recentOrdersLimit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
            },
          ],
          responses: {
            '200': {
              description: 'Every dashboard figure.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: [
                      'range',
                      'kpis',
                      'salesSeries',
                      'orderStatusCounts',
                      'topProducts',
                      'lowStock',
                      'recentOrders',
                    ],
                    properties: {
                      range: {
                        type: 'object',
                        required: [
                          'from',
                          'to',
                          'previousFrom',
                          'previousTo',
                          'timezone',
                          'interval',
                        ],
                        description:
                          'The window actually used, echoed back so a client never has to re-derive it — including the defaults it did not supply.',
                        properties: {
                          from: { type: 'string', format: 'date-time' },
                          to: { type: 'string', format: 'date-time' },
                          previousFrom: { type: 'string', format: 'date-time' },
                          previousTo: { type: 'string', format: 'date-time' },
                          timezone: { type: 'string', example: 'Asia/Kolkata' },
                          interval: { type: 'string', enum: ['day', 'week', 'month'] },
                        },
                      },
                      kpis: {
                        type: 'object',
                        required: ['revenue', 'orders', 'products', 'customers'],
                        properties: {
                          revenue: { $ref: '#/components/schemas/DashboardKpiMoney' },
                          orders: { $ref: '#/components/schemas/DashboardKpiCount' },
                          products: {
                            allOf: [{ $ref: '#/components/schemas/DashboardKpiCount' }],
                            description:
                              'Products this store can currently sell: `status = active` and not soft-deleted. Draft and archived products are excluded, so the tile agrees with what a shopper can actually buy.',
                          },
                          customers: {
                            allOf: [{ $ref: '#/components/schemas/DashboardKpiCount' }],
                            description:
                              'Live customer accounts in this store. Soft-deleted accounts are excluded, matching every other customer read.',
                          },
                        },
                      },
                      salesSeries: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DashboardSeriesPoint' },
                      },
                      orderStatusCounts: {
                        type: 'object',
                        description:
                          'Orders by composed display status. Reuses the SAME derivation the admin order list filters by, so a tile and the page it links to can never disagree. All seven keys are always present, including at zero.',
                        required: [
                          'pending',
                          'confirmed',
                          'processing',
                          'shipped',
                          'delivered',
                          'cancelled',
                          'failed',
                        ],
                        additionalProperties: { type: 'integer', minimum: 0 },
                        properties: {
                          pending: { type: 'integer', minimum: 0 },
                          confirmed: { type: 'integer', minimum: 0 },
                          processing: { type: 'integer', minimum: 0 },
                          shipped: { type: 'integer', minimum: 0 },
                          delivered: { type: 'integer', minimum: 0 },
                          cancelled: { type: 'integer', minimum: 0 },
                          failed: { type: 'integer', minimum: 0 },
                        },
                      },
                      topProducts: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DashboardTopProduct' },
                      },
                      lowStock: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DashboardLowStock' },
                      },
                      recentOrders: {
                        type: 'array',
                        description:
                          'The newest orders in the store, newest first. The SAME row shape `GET /admin/orders` publishes, through the same mapper — not a second definition of an order summary.',
                        items: { $ref: '#/components/schemas/AdminOrderSummary' },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Scopes are read from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/customers': {
        get: {
          tags: ['Users'],
          summary: 'List the store’s customers (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of **every account in the store**. Requires the `staff` scope.',
            '',
            'The identity module’s first staff route, and its first read that returns many',
            'subjects — every other authenticated endpoint there is about the caller’s own',
            'account. `/users/me` stays self-scoped for everyone including staff, so this is a',
            'separate surface rather than a relaxation of that one.',
            '',
            '### What is deliberately absent',
            '',
            '`passwordHash`, `isStaff` and `isSuperuser` are absent from the SQL projection, from',
            'the record type, and from the response mapper — three deliberate edits would be',
            'needed to publish one. Password-reset tokens and refresh sessions live in other',
            'tables this query never touches.',
            '',
            'There is also **no activation, deactivation or deletion**. Staff may see who exists,',
            'whether the account is live, and what it has ordered.',
            '',
            '### Order aggregates',
            '',
            'Each row carries `orderCount`, `totalSpent` and `lastOrderAt`, all three counting',
            'only NON-CANCELLED orders. They are fetched in ONE additional statement for the whole',
            'page, never one per row.',
            '',
            '### What is included, and what is filtered',
            '',
            'Soft-deleted accounts are excluded — an erased customer is invisible to staff for the',
            'same reason they are invisible to authentication. Staff accounts are NOT excluded:',
            'they are rows in the same table, and hiding them would make the list disagree with',
            'the database for no stated reason.',
            '',
            '### Tenancy',
            '',
            'Store-scoped from the verified staff token. There is no `storeId` parameter, and the',
            'query object is strict, so supplying one is a `400`.',
            '',
            'Ordered by `createdAt` descending, then `id` descending — a total order, so `offset`',
            'paging cannot skip or repeat rows.',
            '',
            '**Both date bounds are inclusive, at millisecond granularity**, exactly as',
            '`GET /admin/payments` documents: a bound names a millisecond and includes the whole',
            'of it, so an account’s own published `createdAt` always round-trips as a bound even',
            'though PostgreSQL stores microseconds underneath.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'isActive',
              in: 'query',
              required: false,
              description:
                'Exactly `true` or `false`. Parsed from those two strings rather than coerced — a boolean coercion treats every non-empty string as true, so `?isActive=false` would have filtered to ACTIVE accounts with no error to notice.',
              schema: { type: 'string', enum: ['true', 'false'] },
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              description: [
                'The operator’s search box. One term, matched case-insensitively as a SUBSTRING',
                'across `email`, `firstName`, `lastName` and `phone`.',
                '',
                'Wider than `GET /admin/orders?q=`, which searches an order number or an email.',
                'That one narrows a list an operator is already looking at; this is the customer',
                'directory, whose purpose is finding a person from a partial name or number.',
                '',
                'The phone arm compares DIGITS only, so `98765`, `+91 98765` and `+919876543210`',
                'all find the same customer. The other three arms take the term verbatim, and `%`',
                'and `_` are escaped — a typed `%` matches a literal percent sign, not everything.',
                '',
                'Combines with every other filter rather than replacing them.',
              ].join('\n'),
              schema: { type: 'string', minLength: 1, maxLength: 320 },
              example: 'meera',
            },
            {
              name: 'createdFrom',
              in: 'query',
              required: false,
              description:
                'INCLUSIVE lower bound on `createdAt`. A full ISO-8601 instant WITH an offset; the client owns the timezone.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-01T00:00:00+05:30',
            },
            {
              name: 'createdTo',
              in: 'query',
              required: false,
              description: 'INCLUSIVE upper bound on `createdAt`. Same format as `createdFrom`.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-30T23:59:59+05:30',
            },
          ],
          responses: {
            '200': {
              description: 'A page of the store’s customers, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['customers', 'counts', 'pagination'],
                    properties: {
                      counts: { $ref: '#/components/schemas/AdminCustomerCounts' },
                      customers: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminCustomer' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. A customer receives this even when asking about themselves — `GET /users/me` is the route they should use.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/summary': {
        get: {
          tags: ['Orders'],
          summary: 'Operational order counts (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Three tallies for the whole store. Requires the `staff` scope.',
            '',
            '**Queue depths, not a report.** No money, no period, no filters — the question is',
            '"what needs attention now". Keeping money out also keeps this endpoint clear of the',
            'one thing the system has no answer for: whether an unpaid or cancelled order should',
            'contribute to a total.',
            '',
            '`byDisplayStatus` uses the SAME composed expression `GET /admin/orders` filters by',
            '(§49), so a tile and the list it links to can never offer different statuses.',
            '`byPaymentStatus` and `byShipmentStatus` are the raw underlying statuses; an order',
            'with no payment or no shipment is counted in neither of those two.',
            '',
            '**Every status appears, including at zero**, so the response shape is fixed and a',
            'client never has to tell "absent" from "none".',
            '',
            'Store-scoped from the verified staff token. There is no query object at all.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'Operational counts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['orders'],
                    properties: {
                      orders: {
                        type: 'object',
                        required: ['byDisplayStatus', 'byPaymentStatus', 'byShipmentStatus'],
                        properties: {
                          byDisplayStatus: {
                            type: 'object',
                            additionalProperties: { type: 'integer', minimum: 0 },
                            description:
                              'One key per §49 display status. `ready_to_ship` and `returned` are not derivable and never appear.',
                          },
                          byPaymentStatus: {
                            type: 'object',
                            additionalProperties: { type: 'integer', minimum: 0 },
                          },
                          byShipmentStatus: {
                            type: 'object',
                            additionalProperties: { type: 'integer', minimum: 0 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/returns/summary': {
        get: {
          tags: ['Returns'],
          summary: 'Operational return counts (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Return counts by status for the whole store. Requires the `staff` scope.',
            '',
            'Queue depth, not a report: no money, no period, no filters. Every status in the',
            'return vocabulary appears, including the ones at zero, so the shape does not change',
            'with the data.',
            '',
            'Store-scoped from the verified staff token; no query object.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'Return counts by status.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['returns'],
                    properties: {
                      returns: {
                        type: 'object',
                        required: ['byStatus'],
                        properties: {
                          byStatus: {
                            type: 'object',
                            additionalProperties: { type: 'integer', minimum: 0 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/inventory/summary': {
        get: {
          tags: ['Inventory'],
          summary: 'Operational inventory counts (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'How many live SKUs have nothing sellable left. Requires the `staff` scope.',
            '',
            '"Out of stock" means `available <= 0`, where `available` is the stored',
            '`on_hand - reserved`. A SKU whose entire holding is reserved therefore counts: the',
            'next customer cannot buy it, which is the fact an operator acts on.',
            '',
            'Uses the same visibility rule as `GET /admin/inventory`, so this number and that',
            'list agree on which SKUs exist — soft-deleted SKUs are excluded from both.',
            '',
            '**There is no low-stock figure and cannot be one in this version.** `stock_item` has',
            'no reorder threshold, so "low" has no definition here; supplying one from a dashboard',
            'would be a business rule arriving by the back door.',
            '',
            'Store-scoped from the verified staff token; no query object.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'Inventory counts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['inventory'],
                    properties: {
                      inventory: {
                        type: 'object',
                        required: ['outOfStockSkus'],
                        properties: {
                          outOfStockSkus: { type: 'integer', minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/customers/{customerId}': {
        get: {
          tags: ['Users'],
          summary: 'Read one customer (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'One customer in the store. Requires the `staff` scope.',
            '',
            'Publishes the SAME seven fields as `GET /admin/customers`, through the same mapper,',
            'so the list and the detail cannot drift into describing a customer differently.',
            '',
            '`passwordHash`, `isStaff` and `isSuperuser` are absent from the SQL projection, the',
            'record type and the response mapper alike. Password-reset tokens and refresh sessions',
            'live in other tables this query never touches.',
            '',
            '### Deliberately absent',
            '',
            'No order history here — that is `GET /admin/customers/{customerId}/orders`. No',
            'activity totals, no activation or deactivation, no editing. This is a read.',
            '',
            '### Tenancy and not-found',
            '',
            'Store-scoped from the verified staff token; `customerId` names which customer, never',
            'which store. An unknown id, a customer belonging to ANOTHER store, and a soft-deleted',
            'customer are all `404` and deliberately indistinguishable — the query returns nothing',
            'for each, so the endpoint cannot confirm that an account exists elsewhere.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              description:
                'A UUID by shape only. Existence, tenancy and liveness are decided by the query, so a malformed id is a 400 and every other miss is a 404.',
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'The customer.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['customer'],
                    properties: { customer: { $ref: '#/components/schemas/AdminCustomer' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Scopes are read from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such customer in this store. An unknown id, another store’s customer and a soft-deleted customer are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/customers/{customerId}/activation': {
        post: {
          tags: ['Users'],
          summary: 'Activate or deactivate a customer (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Enables or disables one customer account. Requires the `staff` scope.',
            '',
            'A deactivated customer cannot sign in. Login already refuses an inactive account —',
            'and refuses it AFTER verifying the password, so the endpoint cannot be used as an',
            'account-state oracle — this route only flips the flag that check reads.',
            '',
            '### Not a privilege operation',
            '',
            '`isStaff` and `isSuperuser` cannot be reached from the body: the schema is strict,',
            'so naming either is a `400`, and the repository method behind this route selects',
            'neither column and can write neither.',
            '',
            '### A redundant change is a conflict, not a no-op',
            '',
            'Deactivating an already deactivated account answers `409`. The update carries a',
            'compare-and-swap on the current value, so no audit entry is written for a decision',
            'nobody made — a trail of repeated clicks is a trail that cannot be read.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['isActive'],
                  additionalProperties: false,
                  properties: { isActive: { type: 'boolean' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The customer, in its new state.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['customer'],
                    properties: { customer: { $ref: '#/components/schemas/AdminCustomer' } },
                  },
                },
              },
            },
            '400': errorResponse(
              'A malformed UUID, a missing `isActive`, or an unknown field — including `isStaff` and `isSuperuser`.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse(
              'Unknown, another store’s, or soft-deleted — all indistinguishable.',
              'NOT_FOUND',
            ),
            '409': errorResponse('The account is already in the requested state.', 'CONFLICT'),
          },
        },
      },

      '/api/v1/admin/audit-logs': {
        get: {
          tags: ['Audit'],
          summary: 'The store audit trail (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of the store’s audit log, newest first. Requires the `staff` scope.',
            '',
            '`audit_log` has been append-only since the platform’s first increment and stays',
            'that way: this is a READ, and there is no endpoint anywhere that updates or',
            'deletes an entry.',
            '',
            '### Tenancy, and why the predicate is an equality',
            '',
            '`store_id` is nullable on this table — platform-level entries carry none — so the',
            'filter is a plain equality rather than an `OR IS NULL`. A NULL store satisfies no',
            'equality, which is exactly the intent: a tenant’s staff must not see the',
            'platform’s trail.',
            '',
            '### `metadata` is not published',
            '',
            'Each module writes its own per-action context, reviewed at its own call site.',
            'Publishing the union of all of them through one endpoint would make every future',
            '`audit.record` call a disclosure decision on this route. What is published is who',
            'did what, to which resource, and when.',
            '',
            'Ordered `createdAt DESC, id DESC`. The timestamp alone is not a total order — one',
            'transaction writes several entries at one instant — and the id is UUIDv7, so it',
            'orders within the tie by creation.',
          ].join('\n'),
          parameters: [
            {
              name: 'action',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 128 },
              description:
                'Exact match, e.g. `order.cancelled`. Not a substring: `payment` must not quietly match every payment action a future module adds.',
            },
            {
              name: 'actorType',
              in: 'query',
              required: false,
              schema: { type: 'string', enum: ['staff', 'customer', 'system', 'job'] },
            },
            {
              name: 'actorUserId',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'resourceType',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 64 },
              description: 'Exact match, e.g. `app_user`, `order`, `refund`.',
            },
            {
              name: 'resourceId',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 64 },
            },
            {
              name: 'from',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description: 'Inclusive lower bound. ISO-8601 with an offset.',
            },
            {
              name: 'to',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description:
                'Inclusive upper bound, admitting the whole millisecond named — the project-wide convention, because `created_at` is microsecond-precise in storage and millisecond-precise here.',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of audit entries.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['auditLogs', 'pagination'],
                    properties: {
                      auditLogs: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AuditLogEntry' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '400': errorResponse(
              'An unknown query parameter, a malformed instant or UUID, or an out-of-range limit.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
          },
        },
      },

      '/api/v1/admin/business-profile': {
        get: {
          tags: ['Settings'],
          summary: 'The store business profile (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The store’s presentational identity: name, custom domain, locale and timezone.',
            'Requires the `staff` scope.',
            '',
            '**The GST identity is not here.** `legalName`, `gstin`, `pan` and the origin',
            'address belong to `GET`/`PUT /admin/store/tax-profile`, which validates a GSTIN',
            'against its checksum and a state against the place-of-supply rules. Two endpoints',
            'writing those columns with different validation is how one of them becomes the',
            'weak one.',
            '',
            '`slug` and `currency` are published but not editable: the slug is how a store is',
            'resolved on every request, and the currency denominates money already written to',
            'every order, payment, refund and invoice. Changing either is a migration.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'The business profile.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['businessProfile'],
                    properties: {
                      businessProfile: { $ref: '#/components/schemas/BusinessProfile' },
                    },
                  },
                },
              },
            },
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
          },
        },
        patch: {
          tags: ['Settings'],
          summary: 'Edit the store business profile (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Edits the store’s presentational identity. Requires the `staff` scope.',
            '',
            'A PATCH: an absent key is left alone rather than nulled, so a client changing the',
            'timezone cannot blank the store name by omitting it. An empty body is a no-op that',
            'reads the profile back.',
            '',
            '`domain` is nullable — clearing a custom domain is a real operation, distinct from',
            'omitting it. `timezone` is checked against the runtime’s own IANA database rather',
            'than a regex, so a value this accepts is one the invoice renderer can format',
            'against.',
            '',
            'Audited inside the write’s transaction, recording only the fields that changed.',
            'Naming `gstin`, `legalName`, `pan`, `slug` or `currency` is a `400`.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 200 },
                    domain: {
                      type: 'string',
                      nullable: true,
                      maxLength: 255,
                      description: 'A bare hostname, without a scheme or path. Null clears it.',
                    },
                    defaultLocale: {
                      type: 'string',
                      example: 'en-IN',
                      description: 'A BCP-47 language tag.',
                    },
                    timezone: {
                      type: 'string',
                      example: 'Asia/Kolkata',
                      description: 'An IANA timezone name.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated business profile.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['businessProfile'],
                    properties: {
                      businessProfile: { $ref: '#/components/schemas/BusinessProfile' },
                    },
                  },
                },
              },
            },
            '400': errorResponse(
              'An unknown field — including `gstin`, `legalName`, `pan`, `slug` and `currency` — an invalid timezone, locale or hostname.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
          },
        },
      },

      '/api/v1/admin/customers/{customerId}/addresses': {
        get: {
          tags: ['Addresses'],
          summary: "One customer's addresses (staff)",
          security: [{ bearerAuth: [] }],
          description: [
            "A customer's live address book. Requires the `staff` scope.",
            '',
            'Unpaged, matching the customer-facing equivalent: an address book is bounded by',
            'what one person maintains. Soft-deleted addresses are excluded and cannot be asked',
            'for. Ordered by label, then id — stable across reads, with UUIDv7 ordering equal',
            'labels by creation.',
            '',
            '### An unknown customer is `200` with an empty list, not `404`',
            '',
            'This endpoint answers "what addresses may I see for this id". A `404` would make it',
            'an oracle telling an operator which customer ids exist in OTHER stores. Existence is',
            'established by `GET /admin/customers/{customerId}`, which does answer `404`.',
            '',
            'The tenant comes from the verified staff token; `customerId` names which customer,',
            'never which store.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: "The customer's live addresses. Empty if they have none.",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['addresses'],
                    properties: {
                      addresses: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Address' },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse('A malformed customer id.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
          },
        },
      },

      '/api/v1/admin/customers/{customerId}/sessions': {
        get: {
          tags: ['Users'],
          summary: "One customer's sessions (staff)",
          security: [{ bearerAuth: [] }],
          description: [
            "A page of a customer's refresh sessions, newest first. Requires the `staff` scope.",
            '',
            '### No token material, by construction',
            '',
            'The repository projection behind this endpoint does not select `token_hash`, so no',
            'credential material is ever in scope for a response to publish — it is not redacted',
            'downstream, it is never loaded.',
            '',
            '`active` is derived: not revoked, and not yet expired. `isCurrent` is deliberately',
            'absent — answering it would require comparing against a refresh token, and the',
            'caller is a staff member looking at somebody else’s account.',
            '',
            'An unknown or foreign `customerId` is `404`, so an operator can tell a mistyped id',
            'from a customer who has never signed in.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of sessions.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sessions', 'pagination'],
                    properties: {
                      sessions: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminSession' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '400': errorResponse('A malformed id or an out-of-range limit.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse(
              'Unknown, another store’s, or soft-deleted customer.',
              'NOT_FOUND',
            ),
          },
        },
      },

      '/api/v1/admin/customers/{customerId}/sessions/{sessionId}': {
        delete: {
          tags: ['Users'],
          summary: "Revoke one of a customer's sessions (staff)",
          security: [{ bearerAuth: [] }],
          description: [
            'Revokes a session, cutting the customer off from it. Requires the `staff` scope.',
            '',
            '### It revokes the FAMILY, not one row',
            '',
            'A refresh token rotates on every use, so one sign-in is a chain of rows sharing a',
            '`family_id`. Revoking only the named row would leave its successor live and the',
            'session still usable — the opposite of what an operator means by "revoke".',
            '',
            '`204` with no body. `404` for an unknown session, another customer’s, another',
            'tenant’s, and one already revoked — all four indistinguishable, because',
            'distinguishing them would make this an oracle for which session ids exist.',
            '',
            'Audited as `customer.session_revoked` with the session id and the number of rows',
            'cut. Never any token material.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'sessionId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '204': { description: 'Revoked.' },
            '400': errorResponse('A malformed id.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse(
              'Unknown customer, or no live session with that id for them.',
              'NOT_FOUND',
            ),
          },
        },
      },

      '/api/v1/admin/customers/{customerId}/orders': {
        get: {
          tags: ['Orders'],
          summary: 'List one customer’s orders (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of one customer’s order history, newest first. Requires the `staff` scope.',
            '',
            'This is `GET /admin/orders` with one more predicate — the same statement, the same',
            'ordering and the same `AdminOrderSummary` rows — so a customer’s history cannot drift',
            'from the store-wide list. `pagination.total` is therefore that customer’s order count.',
            '',
            '### Paging only',
            '',
            'No status, date or search filters. Those belong to `GET /admin/orders`; offering half',
            'of them here would invite a client to discover which half. The query object is strict,',
            'so sending one is a `400` naming it.',
            '',
            'Ordered by `placedAt` descending, then `orderNumber` descending — a total order, so',
            '`offset` paging cannot skip or repeat rows when two orders share an instant.',
            '',
            '### Not found versus empty',
            '',
            'A customer who exists and has never ordered is `200` with an empty `orders` array and',
            '`total: 0`. A customer who is unknown, belongs to another store, or has been',
            'soft-deleted is `404` — an empty page is a fact about somebody’s history and must not',
            'be the answer for somebody who is not there.',
          ].join('\n'),
          parameters: [
            {
              name: 'customerId',
              in: 'path',
              required: true,
              description: 'A UUID by shape only. Same 400/404 rules as the customer detail route.',
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of that customer’s orders, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['orders', 'pagination'],
                    properties: {
                      orders: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminOrderSummary' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such customer in this store — unknown, another store’s, or soft-deleted. Distinct from a customer who exists with no orders, which is a 200 with an empty page.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/payments': {
        get: {
          tags: ['Payments'],
          summary: 'List the customer’s payments',
          security: [{ bearerAuth: [] }],
          description: [
            'This customer’s own payments, newest first. Each row carries the `orderNumber` it',
            'belongs to, so a client can drill into one without a second lookup.',
            '',
            '`history` is empty on a list row — a page of payments each carrying its full',
            'transition timeline would be a response whose size grows with activity. Read the',
            'single payment when the timeline is wanted.',
            '',
            'Scoped to the authenticated customer in the query itself, so a page can only ever',
            'contain rows they own.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of payments.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['payments', 'pagination'],
                    properties: {
                      payments: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Payment' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/auth/refresh': {
        post: {
          tags: ['Authentication'],
          summary: 'Rotate a refresh token',
          description: [
            'Exchanges a refresh token for a **new** access token and a **new** refresh token.',
            '',
            '**The presented token is consumed.** After a successful call it is permanently unusable —',
            'store the returned `refreshToken` and discard the old one. Replaying a consumed token is',
            'treated as evidence that it leaked: the entire token family descended from the original',
            'sign-in is revoked immediately, so every other refresh token the client holds stops working',
            'too and the user must sign in again.',
            '',
            'Concurrency: if two requests present the same token simultaneously, exactly one succeeds.',
            'The other is indistinguishable from a replay and therefore revokes the family — so a client',
            'must serialise its own refreshes rather than firing one per in-flight request.',
            '',
            'The refresh token goes in the JSON body, not a cookie or an `Authorization` header. The',
            'access token is not required and is ignored if sent: an expired access token is the normal',
            'reason to be calling this.',
            '',
            'The session lifetime does **not** slide. A rotated token inherits its parent expiry, so a',
            'family dies a fixed interval after the sign-in that created it however often it is rotated.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refreshToken'],
                  additionalProperties: false,
                  properties: {
                    refreshToken: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 512,
                      description:
                        'The opaque refresh token from a previous login or refresh. Length is not validated against the generated format, so a malformed token returns 401 rather than 400 — the API does not confirm which guesses had the right shape.',
                      example: 'WcuzAss736XgOoj_L97tdFfXCeW5mdSgGK5rmthM0NQ',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'Rotated. The old refresh token is now dead and the returned one replaces it.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user', 'accessToken', 'tokenType', 'expiresIn', 'refreshToken'],
                    properties: {
                      user: { $ref: '#/components/schemas/User' },
                      accessToken: {
                        type: 'string',
                        description:
                          'RS256 JWT, with a fresh `sid` for the replacement session. Authorization claims are re-read from the account on every refresh, so a demoted user loses them here.',
                      },
                      tokenType: { type: 'string', enum: ['Bearer'], example: 'Bearer' },
                      expiresIn: {
                        type: 'integer',
                        description:
                          'Seconds until the ACCESS token expires. The refresh token lives longer; its lifetime is not advertised.',
                        example: 900,
                      },
                      refreshToken: {
                        type: 'string',
                        description:
                          'The replacement token. Returned once and never recoverable — persist it before discarding the old one.',
                        example: 'kQ8vN2wXyZ4aB6cD8eF0gH2iJ4kL6mN8oP0qR2sT4uV',
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'The refresh token is invalid. Identical for a fabricated token, an expired one, one already consumed by a previous rotation, one revoked by logout, one revoked because a sibling was replayed, and one belonging to a deactivated account. The response never reveals which — including whether the token ever existed.',
              'INVALID_REFRESH_TOKEN',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/auth/logout': {
        post: {
          tags: ['Authentication'],
          summary: 'Log out of the current session',
          // The only operation with a security requirement. Declared per-operation rather than
          // globally, because every other endpoint here is deliberately public.
          security: [{ bearerAuth: [] }],
          description: [
            'Revokes the refresh-token **family** behind the access token used to make this call.',
            '',
            '**No request body.** The session is identified by the `sid` claim inside the verified',
            'access token, so a caller can only ever log out the session they are actually holding.',
            'A session id, family id, or refresh token in the body would let any authenticated caller',
            'revoke other users sessions, so none is accepted.',
            '',
            '**Scope.** Other independent sign-ins are unaffected. Logging out on a phone leaves a',
            'laptop session working. There is no "sign out everywhere" behaviour here.',
            '',
            '**The access token is NOT invalidated.** Access tokens are stateless and signed; this',
            'endpoint cannot recall one that has already been issued, so the presented access token',
            'keeps working until it expires (15 minutes by default). What stops immediately is the',
            'ability to obtain a NEW one — every refresh token in the family is revoked, so',
            '`POST /api/v1/auth/refresh` returns 401 from this moment. Clients should discard both',
            'tokens locally rather than relying on the server to reject the access token.',
            '',
            '**Idempotent.** Calling it again with the same token returns 204 again. The response is',
            'identical whether sessions were revoked or none were, so it cannot be used to probe',
            'whether a family is still live.',
          ].join('\n'),
          responses: {
            '204': {
              description:
                'Logged out. No body. Returned whether or not the family was already revoked.',
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, or issued for a different store. `AUTHENTICATION_REQUIRED` when the `Authorization` header is missing or malformed; `INVALID_ACCESS_TOKEN` when a token was present but did not verify.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me': {
        get: {
          tags: ['Users'],
          summary: 'Get the authenticated user',
          security: [{ bearerAuth: [] }],
          description: [
            'Returns the current public profile of the user identified by the access token.',
            '',
            '**No parameters.** `me` is not a placeholder for an id — the user comes entirely from the',
            'token `sub` claim. There is no path, query, or body parameter for selecting a user, so',
            'this endpoint cannot be used to read anyone else or to enumerate accounts.',
            '',
            '**Read from the database, not from the token.** The token proves who you are; the',
            'response reflects what you currently are. A profile change made after the token was',
            'issued appears here immediately, rather than after the token expires.',
            '',
            '**A valid token is not a valid account.** If the record has been deactivated or deleted,',
            'this returns 401 even though the token itself still verifies — stale claims are never',
            'returned as if the account were fine.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'The authenticated user current public profile.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user'],
                    properties: { user: { $ref: '#/components/schemas/User' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, or issued for a different store, or the account has been deactivated or deleted. `AUTHENTICATION_REQUIRED` when the header is missing or malformed and when the account is no longer usable; `INVALID_ACCESS_TOKEN` when a token was present but did not verify. The response does not distinguish a deactivated account from a deleted one.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        patch: {
          tags: ['Users'],
          summary: 'Update the authenticated user',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates the profile of the user identified by the access token.',
            '',
            '**Self-only.** `me` is not a placeholder for an id — the user comes entirely from the',
            'token `sub` claim. There is no path, query, or body parameter for selecting a user, so',
            'this endpoint cannot modify anyone else.',
            '',
            '**No scope required.** This is a user editing themselves, not staff editing a customer.',
            '',
            'Exactly three fields are writable: `firstName`, `lastName`, and `acceptsMarketing`.',
            'Every other column is rejected with a `400` naming the field rather than being',
            'silently ignored — including `email`, `phone`, `isStaff`, `isSuperuser`, `storeId`,',
            '`passwordHash`, `isActive`, `id`, and the verification timestamps. Changing an email',
            'or a phone number is a separate verification flow, not a profile field.',
            '',
            'A **partial** update: fields you omit keep their current values. At least one of the',
            'three must be supplied — an empty body is a `400` rather than a no-op that reports',
            'success. An empty string clears a name; `null` is not accepted.',
            '',
            'Use `POST /api/v1/users/me/password` to change a password. It is deliberately not a',
            'field here.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  minProperties: 1,
                  properties: {
                    firstName: {
                      type: 'string',
                      maxLength: 150,
                      description: 'Trimmed. An empty string clears it.',
                      example: 'Ada',
                    },
                    lastName: {
                      type: 'string',
                      maxLength: 150,
                      description: 'Trimmed. An empty string clears it.',
                      example: 'Lovelace',
                    },
                    acceptsMarketing: {
                      type: 'boolean',
                      description: 'Marketing consent. Explicit in both directions.',
                      example: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated public profile.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user'],
                    properties: { user: { $ref: '#/components/schemas/User' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, or issued for a different store, or the account has been deactivated or deleted. The profile is left unchanged in every case.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/password': {
        post: {
          tags: ['Users'],
          summary: 'Change the authenticated user password',
          security: [{ bearerAuth: [] }],
          description: [
            'Changes the password of the user identified by the access token, and **revokes every',
            'refresh session that user holds**.',
            '',
            '**Self-only.** The user comes entirely from the token `sub` claim. There is no',
            'parameter naming an account, so this endpoint cannot be aimed at anyone else.',
            '',
            '**The current password must be supplied and must be correct.** This is what stops a',
            'stolen access token from becoming a permanent account takeover. An incorrect current',
            'password is a `401` and changes nothing — neither the password nor any session.',
            '',
            '**All sessions are revoked, on every device.** Not just the caller’s. The reason to',
            'change a password is that the old one may be known to someone else, so every session',
            'established under it is treated as suspect. This differs deliberately from',
            '`POST /api/v1/auth/logout`, which revokes only the calling device’s family.',
            '',
            'Consequently **the caller must sign in again**: their own refresh token is revoked too,',
            'and no new tokens are issued here. Outstanding **access** tokens are stateless and',
            'remain valid until they expire (at most 15 minutes); this endpoint ends refresh',
            'capability immediately and cannot retract an already-issued access token.',
            '',
            'The password change and the revocation are **atomic** — there is no state in which the',
            'password changed but sessions stayed live.',
            '',
            'The two password fields validate differently, on purpose. `newPassword` is held to the',
            'registration policy because it is a password being chosen. `currentPassword` is not:',
            'applying the policy to an existing credential would lock out anyone whose password',
            'predates a policy change, and a minimum length would reveal that shorter passwords',
            'cannot exist.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['currentPassword', 'newPassword'],
                  additionalProperties: false,
                  properties: {
                    currentPassword: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 1024,
                      description:
                        'The password in use now. Bounded only to protect the hashing addon; deliberately not held to the registration policy. Not trimmed.',
                      example: 'the-current-password',
                    },
                    newPassword: {
                      type: 'string',
                      minLength: 10,
                      maxLength: 128,
                      description:
                        'Length only — no composition rules (NIST SP 800-63B), identical to the registration policy. Not trimmed: whitespace is a legitimate password character.',
                      example: 'a-sufficiently-long-new-password',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '204': {
              description:
                'Password changed and every refresh session revoked. No body — deliberately not the number of sessions revoked, which would disclose session state.',
            },
            '401': errorResponse(
              'Either authentication failed (no token, or a token that is invalid, expired, or issued for another store, or an account that has been deactivated or deleted) or `currentPassword` was incorrect. `INVALID_CREDENTIALS` for a wrong current password. Nothing is changed and no session is revoked.',
              'INVALID_CREDENTIALS',
            ),
            '409': errorResponse(
              'The password was changed by another request between verification and the write. Nothing was changed; retry.',
              'CONFLICT',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/promotions': {
        post: {
          tags: ['Promotions'],
          summary: 'Create a promotion',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates a coupon-code discount. **Staff only.**',
            '',
            'A promotion is either a `percentage` or a `fixed_amount`, never both, and the',
            'database enforces that pair rather than trusting this schema: a seed script or an',
            'operator running SQL bypasses validation entirely.',
            '',
            '`storeId` comes from the resolved store and the audit actor from the verified',
            'token; neither is a field a client can send.',
            '',
            'This is one of the three audited promotion operations. A customer applying or',
            'removing a coupon is NOT audited — it is neither privileged nor security-relevant,',
            'and an entry per apply would bury the entries that matter.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'name', 'discountType'],
                  additionalProperties: false,
                  properties: {
                    code: {
                      type: 'string',
                      maxLength: 64,
                      description:
                        'Stored as supplied, trimmed, never re-cased. Must be unique per store among non-deleted promotions, compared case-insensitively.',
                      example: 'SAVE10',
                    },
                    name: { type: 'string', maxLength: 300, example: 'Festive 10% off' },
                    discountType: {
                      type: 'string',
                      enum: ['percentage', 'fixed_amount'],
                      description:
                        'Selects which value field applies. Exactly one of percentRate / amount must be supplied, and it must be the one this names — enforced by a database CHECK as well as by this schema.',
                    },
                    percentRate: {
                      type: 'string',
                      description:
                        'Required when discountType is percentage, forbidden otherwise. A decimal STRING with up to 6 decimal places, greater than 0 and at most 100. Not a JSON number: a double cannot hold 33.333333 exactly, and the error would compound into the discount.',
                      example: '10.000000',
                    },
                    amount: {
                      type: 'string',
                      description:
                        'Required when discountType is fixed_amount, forbidden otherwise. A decimal STRING at the storage scale, greater than 0. Capped at the cart subtotal when applied.',
                      example: '250.0000',
                    },
                    minSubtotal: {
                      type: 'string',
                      description:
                        'Optional. The smallest qualifying cart subtotal, compared BEFORE any discount. Equality qualifies. Omit for no minimum.',
                      example: '1000.0000',
                    },
                    startsAt: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        'Optional. An ABSOLUTE instant, with a Z or an offset. A bare local date is rejected — accepting one would mean silently choosing a timezone.',
                    },
                    endsAt: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        'Optional, and EXCLUSIVE. Must be after startsAt when both are given.',
                    },
                    isActive: {
                      type: 'boolean',
                      description: 'Optional, defaults to true.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The created promotion.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['promotion'],
                    properties: { promotion: { $ref: '#/components/schemas/Promotion' } },
                  },
                },
              },
            },
            '409': errorResponse(
              'A non-deleted promotion in this store already uses this code, compared case-insensitively.',
              'PROMOTION_CODE_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but is not staff. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        get: {
          tags: ['Promotions'],
          summary: 'List promotions',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of this store\u2019s promotions, ordered by code. **Staff only.**',
            '',
            'Includes INACTIVE and out-of-window promotions: a merchant must be able to see the',
            'coupon they scheduled for next month and the one they paused. Soft-deleted rows are',
            'excluded — there is no restore, so a deleted promotion is not something this surface',
            'can act on.',
            '',
            'The page and the total share one predicate, so a caller on the last page is never',
            'told the total counted rows it cannot see.',
            '',
            '### There is no `usedCount`',
            '',
            'The Figma list shows a "Used" column and this API does not publish one, because',
            'nothing counts redemptions: there is no redemption table, and a promotion carries no',
            'usage counter. A number derived from anything currently stored would be a guess',
            'presented as a figure a merchant makes decisions with, so none is published.',
            'Recorded as a remaining structural gap rather than fabricated.',
          ].join('\n'),
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description:
                'Case-insensitive substring over the promotion code and name. `%` and `_` are literal characters, not wildcards.',
              schema: { type: 'string', minLength: 1, maxLength: 300 },
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              description: [
                'Lifecycle state, DERIVED from `isActive`, `startsAt` and `endsAt` — there is no',
                'status column, and adding one would be a second source of truth the customer',
                'facing usability rule could contradict.',
                '',
                '- `disabled` — switched off, whatever the dates say. It outranks the window.',
                '- `scheduled` — enabled, and `startsAt` is in the future.',
                '- `expired` — enabled, and `endsAt` is in the past.',
                '- `active` — enabled, started (or unbounded), not yet ended (or unbounded).',
                '',
                'The four are mutually exclusive and cover every row, so tab counts sum to the',
                'unfiltered total.',
              ].join('\n'),
              schema: { type: 'string', enum: ['active', 'scheduled', 'expired', 'disabled'] },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of promotions.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['promotions', 'pagination'],
                    properties: {
                      promotions: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Promotion' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but is not staff. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/promotions/{code}': {
        get: {
          tags: ['Promotions'],
          summary: 'Read one promotion',
          security: [{ bearerAuth: [] }],
          description: [
            '**Staff only.** An unknown code, another store\u2019s promotion and a deleted one all',
            'produce the same `404` — ownership belongs in the query, not in a comparison',
            'performed afterwards.',
          ].join('\n'),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              description:
                'The coupon code. Matched case-insensitively, so /admin/promotions/save10 reaches SAVE10.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SAVE10',
            },
          ],
          responses: {
            '200': {
              description: 'The promotion.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['promotion'],
                    properties: { promotion: { $ref: '#/components/schemas/Promotion' } },
                  },
                },
              },
            },
            '404': errorResponse('No such promotion in this store.', 'NOT_FOUND'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but is not staff. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        patch: {
          tags: ['Promotions'],
          summary: 'Update a promotion',
          security: [{ bearerAuth: [] }],
          description: [
            '**Staff only.** Partial: an absent field is left alone, and `null` on',
            '`minSubtotal`, `startsAt` or `endsAt` CLEARS it. Those are genuinely',
            'different intentions and a PATCH must be able to express both.',
            '',
            '`discountType` may change; the two value columns are then rewritten as a pair, so',
            'the row moves from one valid shape to another in a single statement rather than',
            'passing through a state the CHECK constraint would refuse.',
            '',
            'The code may change. Nothing references a promotion by code except this path —',
            '`cart_promotion` holds the id — so a customer\u2019s applied coupon survives a',
            'rename, and there is no historical record to invalidate because redemption does not',
            'exist yet.',
            '',
            'Not settable at all: `id`, `storeId`, `createdAt`, `updatedAt`,',
            '`deletedAt` and the audit actor. Each is a `400` naming the field.',
          ].join('\n'),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              description:
                'The coupon code. Matched case-insensitively, so /admin/promotions/save10 reaches SAVE10.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SAVE10',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: {
                    code: {
                      type: 'string',
                      maxLength: 64,
                      description:
                        'Stored as supplied, trimmed, never re-cased. Must be unique per store among non-deleted promotions, compared case-insensitively.',
                      example: 'SAVE10',
                    },
                    name: { type: 'string', maxLength: 300, example: 'Festive 10% off' },
                    discountType: {
                      type: 'string',
                      enum: ['percentage', 'fixed_amount'],
                      description:
                        'Selects which value field applies. Exactly one of percentRate / amount must be supplied, and it must be the one this names — enforced by a database CHECK as well as by this schema.',
                    },
                    percentRate: {
                      type: 'string',
                      description:
                        'Required when discountType is percentage, forbidden otherwise. A decimal STRING with up to 6 decimal places, greater than 0 and at most 100. Not a JSON number: a double cannot hold 33.333333 exactly, and the error would compound into the discount.',
                      example: '10.000000',
                    },
                    amount: {
                      type: 'string',
                      description:
                        'Required when discountType is fixed_amount, forbidden otherwise. A decimal STRING at the storage scale, greater than 0. Capped at the cart subtotal when applied.',
                      example: '250.0000',
                    },
                    minSubtotal: {
                      type: 'string',
                      description:
                        'Optional. The smallest qualifying cart subtotal, compared BEFORE any discount. Equality qualifies. Omit for no minimum.',
                      example: '1000.0000',
                    },
                    startsAt: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        'Optional. An ABSOLUTE instant, with a Z or an offset. A bare local date is rejected — accepting one would mean silently choosing a timezone.',
                    },
                    endsAt: {
                      type: 'string',
                      format: 'date-time',
                      description:
                        'Optional, and EXCLUSIVE. Must be after startsAt when both are given.',
                    },
                    isActive: {
                      type: 'boolean',
                      description: 'Optional, defaults to true.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated promotion.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['promotion'],
                    properties: { promotion: { $ref: '#/components/schemas/Promotion' } },
                  },
                },
              },
            },
            '404': errorResponse('No such promotion in this store.', 'NOT_FOUND'),
            '409': errorResponse(
              'Another non-deleted promotion in this store already uses the requested code.',
              'PROMOTION_CODE_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but is not staff. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Promotions'],
          summary: 'Delete a promotion',
          security: [{ bearerAuth: [] }],
          description: [
            '**Staff only. Soft delete, and there is no restore** — reviving a coupon a merchant',
            'retired is a new promotion, and an undelete endpoint would need its own uniqueness',
            'story once the code had been reused.',
            '',
            'The row survives, which is what keeps the cart\u2019s foreign key satisfiable: a',
            'customer holding the coupon keeps their cart, and the coupon simply stops',
            'discounting on their next read. The code is freed for reuse immediately, because the',
            'uniqueness index excludes deleted rows.',
            '',
            'A repeated delete is a `404`.',
          ].join('\n'),
          parameters: [
            {
              name: 'code',
              in: 'path',
              required: true,
              description:
                'The coupon code. Matched case-insensitively, so /admin/promotions/save10 reaches SAVE10.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SAVE10',
            },
          ],
          responses: {
            '204': { description: 'The promotion was soft-deleted.' },
            '404': errorResponse('No such promotion in this store.', 'NOT_FOUND'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but is not staff. Derived from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/cart': {
        get: {
          tags: ['Cart'],
          summary: "Read the customer's cart",
          security: [{ bearerAuth: [] }],
          description: [
            "The authenticated customer's active cart, **creating an empty one if they have none**.",
            '',
            'Requires only a valid access token — no staff scope. A `404` for "you have no cart',
            'yet" would push cart creation into the client for no benefit, so this route is the only',
            'way a cart comes into existence: there is no explicit create endpoint.',
            '',
            'Two simultaneous first requests converge on ONE cart. A `checked_out` cart is never',
            'returned — the customer gets a fresh active one — which is what lets a cart survive',
            'checkout without blocking the next order.',
            '',
            '### Prices are current, not snapshotted',
            '',
            '`unitPrice` is whatever the SKU costs **now**. A cart is not a quotation, so a',
            "merchant's price change shows up on the customer's next read and needs no",
            'reconciliation. Order lines are where a price is snapshotted, and that belongs to a',
            'later version.',
            '',
            '### Lines that can no longer be bought are KEPT',
            '',
            'If a SKU is deactivated or deleted, or its product unpublished, the line stays in the',
            'cart with `isPurchasable: false`. Silently discarding a customer\u2019s basket',
            'contents because a merchant edited a listing would be worse than telling them. Such a',
            'line still contributes to `cartTotal`; deciding what to do about it is the',
            "client's call, and checkout's later.",
            '',
            'UNPAGED: a cart is bounded by what one person puts in it. A request body on this route',
            'is ignored entirely and cannot influence whose cart is returned.',
          ].join('\n'),
          responses: {
            '200': {
              description: 'The active cart, possibly empty.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['cart'],
                    properties: { cart: { $ref: '#/components/schemas/Cart' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Cart'],
          summary: 'Empty the cart',
          security: [{ bearerAuth: [] }],
          description: [
            'Removes every line and **keeps the cart**.',
            '',
            'A cart is a container, so emptying it does not change its identity: a client holding',
            'the cart id still holds a valid cart, and the next `GET` returns the same one rather',
            'than minting a new id for no observable reason.',
            '',
            'Idempotent — clearing an already-empty cart is still a `204`.',
          ].join('\n'),
          responses: {
            '204': { description: 'Every line removed; the cart remains.' },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/cart/items/{skuCode}': {
        put: {
          tags: ['Cart'],
          summary: "Set a SKU's quantity in the cart",
          security: [{ bearerAuth: [] }],
          description: [
            'Sets how many of this SKU the cart holds, creating the line if absent.',
            '',
            '### SET, not add',
            '',
            'The body says what the quantity should **be**, not how much to add. Repeating the',
            'identical request therefore leaves the quantity unchanged, which makes a client retry',
            'safe with no `Idempotency-Key` required. An increment endpoint would double on',
            'retry — which is measurably what happens — and that is why this is a `PUT` and why',
            'there is no `POST` or `PATCH` item route.',
            '',
            'Correctness does not depend on the HTTP method alone: the line is written by a single',
            'atomic upsert keyed on the cart-and-SKU primary key, so two simultaneous writes',
            'converge on one row (last writer wins) and can never produce two lines for one SKU.',
            '',
            '`quantity: 0` is a `400`, not a delete — `DELETE` says that precisely, and one',
            'route meaning two things would need two success codes.',
            '',
            'Returns the FULL cart, so a client never has to re-read to learn the new total.',
            '',
            '### What cannot be sent',
            '',
            '`quantity` is the only accepted key. There is no `userId`, `storeId`,',
            '`actorUserId`, `cartId`, `skuId` or price field, and an unknown key is a `400`',
            'naming it. Ownership and tenancy come from the verified access token, so there is no',
            "path by which a client can write into another customer's cart or across a tenant",
            'boundary.',
            '',
            '### Stock is NOT consulted',
            '',
            'Availability is not checked and nothing is reserved. Without reservations a check would',
            'be stale the instant it returned, so a cart may hold more than is in stock; the',
            'authoritative stock gate is order allocation, in a later version.',
          ].join('\n'),
          parameters: [
            {
              name: 'skuCode',
              in: 'path',
              required: true,
              description: 'The merchant SKU code. Case-sensitive; trimmed before lookup.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SHIRT-BLUE-M',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['quantity'],
                  additionalProperties: false,
                  properties: {
                    quantity: {
                      type: 'integer',
                      minimum: 1,
                      maximum: 999,
                      description:
                        'Whole units. The minimum is 1 because a line with no units should not exist; use DELETE. The maximum is operational hygiene, not a merchandising rule, and keeps a mistyped paste far from integer overflow.',
                      example: 2,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The cart, including the line just set.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['cart'],
                    properties: { cart: { $ref: '#/components/schemas/Cart' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such purchasable SKU in this store — unknown, deleted, inactive, or its product is deleted or unpublished. All indistinguishable, so the response reveals nothing about another merchant\u2019s catalogue.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Cart'],
          summary: 'Remove a SKU from the cart',
          security: [{ bearerAuth: [] }],
          description: [
            'Removes one line.',
            '',
            'Deliberately does **not** require the SKU to be purchasable: a customer must be able to',
            'remove a line whose SKU was deactivated after they added it, and filtering here would',
            'leave them holding something they can neither buy nor delete.',
            '',
            'A line that is not in the cart is a `404` — a `GET` would not show it, so a',
            '`204` here would contradict the very next request.',
            '',
            'A request body on this route is ignored entirely.',
          ].join('\n'),
          parameters: [
            {
              name: 'skuCode',
              in: 'path',
              required: true,
              description: 'The merchant SKU code. Case-sensitive; trimmed before lookup.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SHIRT-BLUE-M',
            },
          ],
          responses: {
            '204': { description: 'The line was removed.' },
            '404': errorResponse(
              'No such line in this cart, or no such SKU in this store.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/cart/promotion': {
        put: {
          tags: ['Cart'],
          summary: 'Apply a coupon code to the cart',
          security: [{ bearerAuth: [] }],
          description: [
            'Applies a coupon to the customer\u2019s active cart and returns the whole cart,',
            'discount included.',
            '',
            '### Replaces, never stacks',
            '',
            '**A cart holds at most ONE promotion.** Applying a second code replaces the first in',
            'one request — requiring a `DELETE` first would be a rule the customer never agreed',
            'to, and would leave their cart briefly with no promotion at all. Exactly one survives',
            'because `cart_promotion` is keyed on the cart, so simultaneous applies converge on',
            'one row rather than racing into a duplicate.',
            '',
            'There is no priority, no best-discount selection and no combinability: stacking is',
            'absent by decision, not by omission.',
            '',
            '### Nothing is consumed',
            '',
            'Applying a coupon does **not** redeem it. There are no usage limits, no per-customer',
            'limits and no redemption records in this version, so an abandoned cart cannot burn a',
            'coupon. Checkout will revalidate and recompute from scratch.',
            '',
            '### The discount is recomputed on every read',
            '',
            'Only the ASSOCIATION is stored — never the discount. So a coupon that expires while a',
            'basket sits untouched simply stops applying; one that stops applying because an item',
            'was removed starts applying again when the item comes back; and a price change moves',
            'the discount with it. The same no-snapshot judgement the cart already makes about',
            'prices.',
            '',
            '### What cannot be sent',
            '',
            '`code` is the only accepted key. There is no `userId`, `storeId`,',
            '`cartId`, `promotionId`, `actorUserId` or discount field, and an unknown',
            'key is a `400` naming it. Ownership and tenancy come from the verified access',
            'token.',
            '',
            'Naturally retry-safe, so no `Idempotency-Key` is required or accepted.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code'],
                  additionalProperties: false,
                  properties: {
                    code: {
                      type: 'string',
                      maxLength: 64,
                      description:
                        'The coupon code. Trimmed, and matched case-insensitively, so save10 finds SAVE10.',
                      example: 'SAVE10',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The cart, with the promotion applied.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['cart'],
                    properties: { cart: { $ref: '#/components/schemas/Cart' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No usable promotion with that code in this store. Unknown, deactivated, deleted, expired and not-yet-started are ALL reported this way — indistinguishable on purpose, so this endpoint cannot be used to discover which coupons exist.',
              'NOT_FOUND',
            ),
            '422': {
              description:
                'The cart is empty (PROMOTION_REQUIRES_ITEMS), or its subtotal is below the promotion\u2019s minimum (PROMOTION_MINIMUM_SUBTOTAL, whose details name the threshold). The minimum is the one apply failure distinguished from a 404: the customer has already proved they know the code, and telling them what to spend is the entire point of a minimum.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorEnvelope' },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Cart'],
          summary: 'Remove the applied coupon',
          security: [{ bearerAuth: [] }],
          description: [
            'Removes the ASSOCIATION, never the promotion itself — a customer discarding a coupon',
            'must not affect the merchant\u2019s configuration or any other customer\u2019s cart.',
            '',
            'A cart with no promotion applied is a `404`: a `GET` would show',
            '`promotion: null`, so a `204` here would contradict the very next request. It',
            'succeeds even when the applied promotion has expired, which is precisely when a',
            'customer wants to clear it.',
            '',
            'A request body on this route is ignored entirely.',
          ].join('\n'),
          responses: {
            '204': { description: 'The promotion was removed from the cart.' },
            '404': errorResponse('This cart has no promotion applied.', 'NOT_FOUND'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/returns': {
        get: {
          tags: ['Returns'],
          summary: 'The store return queue (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Every return in the staff member’s own store, newest first, optionally filtered',
            'by status.',
            '',
            'Store-scoped and **not** owner-scoped: staff act for a tenant, so a colleague’s',
            'case is theirs to see. The store comes from the verified token, so one tenant’s',
            'staff can never reach another’s returns.',
            '',
            'The response carries `staffNote`, the per-line inspection counts and the',
            '`customer` who raised it, none of which appears on the customer-facing endpoints.',
            '',
            'Ordered `requestedAt DESC, returnNumber DESC`. The second key makes the order',
            'total rather than merely usually-stable: `returnNumber` is unique per store, so two',
            'returns raised in the same instant still page deterministically.',
          ].join('\n'),
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: [
                  'requested',
                  'approved',
                  'received',
                  'inspected',
                  'completed',
                  'rejected',
                  'cancelled',
                ],
              },
              description: 'Narrow the queue to one state.',
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string', minLength: 1, maxLength: 320 },
              description: [
                'Case-insensitive **substring** search over four fields: the return number, the',
                'order number, the customer’s email, and any SKU code on the return’s lines.',
                '',
                '`%` and `_` are treated as literal characters, not wildcards. Deliberately not a',
                'search over names, addresses or notes — a wider search is a wider disclosure.',
              ].join('\n'),
            },
            {
              name: 'requestedFrom',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only returns requested at or after this instant. ISO-8601 **with an offset**; a bare `YYYY-MM-DD` is rejected rather than widened into a timezone the server picked.',
            },
            {
              name: 'requestedTo',
              in: 'query',
              required: false,
              schema: { type: 'string', format: 'date-time' },
              description:
                'Only returns requested at or before this instant, **inclusive of the whole millisecond named**. `requested_at` is microsecond-precise in storage and millisecond-precise in this API, so the bound admits every microsecond inside the millisecond given — including the return a client copied the value from.',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of returns.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['returns', 'total', 'limit', 'offset'],
                    properties: {
                      returns: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/StaffReturnListItem' },
                      },
                      total: { type: 'integer' },
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': errorResponse(
              'An unknown query parameter, an invalid status, a malformed instant, an over-long search term, or an out-of-range limit or offset.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}': {
        get: {
          tags: ['Returns'],
          summary: 'Read one return (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'One return in the staff member’s own store.',
            '',
            'Another tenant’s return is a `404` — the same answer an unknown number gets, so',
            'the response cannot be used to probe other stores.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          responses: {
            '200': {
              description: 'The return, with staff-only fields.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/StaffReturnDetail' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed return number.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}/approve': {
        post: {
          tags: ['Returns'],
          summary: 'Approve a requested return (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Agrees to a return exactly as the customer raised it.',
            '',
            '**Only `requested` → `approved`.** Every other state is a `409` naming both ends',
            'of the refused move: an already-approved, received, inspected, completed, rejected',
            'or cancelled return cannot be approved.',
            '',
            '### Approval cannot edit the return',
            '',
            'The body is an optional `staffNote` and nothing else. A client cannot send a',
            'status, a quantity, a refund amount, an approval timestamp, a store or a user —',
            'each is a `400` naming the field. The frozen refund snapshot taken when the return',
            'was created is left exactly as it was.',
            '',
            '### No Idempotency-Key',
            '',
            'The status predicate on the update IS the idempotency: a second approval matches no',
            'row and answers `409`. That is the honest result — a client receiving `200` twice',
            'could not tell whether it approved something or nothing.',
            '',
            'Concurrent approve and reject attempts resolve to exactly one transition, one',
            'history row and one audit record.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { staffNote: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The approved return.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/StaffReturn' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed number or an unknown field.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not in a state that can be approved.',
              'RETURN_NOT_TRANSITIONABLE',
            ),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}/reject': {
        post: {
          tags: ['Returns'],
          summary: 'Reject a return (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Refuses a return. **No refund is made and nothing is restocked.**',
            '',
            '`requested` → `rejected` today. `received` → `rejected` becomes reachable once',
            'Increment 40e adds receipt and inspection.',
            '',
            'A rejected return **releases its quantity** back to the returnable pool: nothing',
            'came back and no money moved, so the customer may raise another return for the',
            'same units.',
            '',
            'The body is an optional `staffNote`, which is internal and never shown to the',
            'customer.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { staffNote: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The rejected return.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/StaffReturn' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed number or an unknown field.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not in a state that can be rejected.',
              'RETURN_NOT_TRANSITIONABLE',
            ),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}/receive': {
        post: {
          tags: ['Returns'],
          summary: 'Record that returned goods arrived (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The parcel is at the warehouse. **Only `approved` → `received`.**',
            '',
            'Nothing about money or stock happens here. The units are physically present but',
            'not yet judged, and restocking unexamined goods would put them back on sale before',
            'anyone had looked at them. That judgement is `POST .../inspect`.',
            '',
            'The received instant is the `return_event` row this writes, not a new column: the',
            'event log is already the append-only record of when each transition happened, and a',
            'second timestamp on the header would be the same fact stored twice and free to',
            'disagree.',
            '',
            '### No Idempotency-Key',
            '',
            'The status predicate on the update IS the idempotency, exactly as for approve and',
            'reject: a second receipt matches no row and answers `409`.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { staffNote: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The received return.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/StaffReturn' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed number or an unknown field.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not `approved`, so it cannot be received.',
              'RETURN_NOT_TRANSITIONABLE',
            ),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}/inspect': {
        post: {
          tags: ['Returns'],
          summary: 'Record the inspection result (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Decides, per line, how many returned units are good to sell and how many are',
            'written off. **Only `received` → `inspected`.**',
            '',
            '### The counts do not change what the customer is owed',
            '',
            'A smashed jar is still a jar they sent back. The frozen refund snapshot taken when',
            'the return was created is never touched here. What these counts decide is how many',
            'units go back into sellable stock when the return is completed.',
            '',
            'Counts rather than a verdict, because a single line legitimately splits — three',
            'jars returned, one smashed. A label would force staff to either lie about the good',
            'two or raise a second return for the broken one.',
            '',
            '### Every line, exactly once, fully accounted for',
            '',
            'Each line of the return must appear, no line may appear twice, and each line’s',
            '`restockQuantity + writeOffQuantity` must equal the quantity that came back. A',
            'partial inspection is a `422` rather than a defaulted zero, because completion',
            'would otherwise restock a number nobody decided.',
            '',
            '### There is no rejection from here',
            '',
            '`received` → `rejected` is the refusal edge, taken INSTEAD of this one. Reaching',
            '`inspected` already means the return was accepted, which is what makes',
            '`inspected` → `completed` unconditional.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['lines'],
                  additionalProperties: false,
                  properties: {
                    lines: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 100,
                      items: {
                        type: 'object',
                        required: ['skuCode', 'restockQuantity', 'writeOffQuantity'],
                        additionalProperties: false,
                        properties: {
                          skuCode: { type: 'string', maxLength: 64, example: 'SHIRT-BLUE-M' },
                          restockQuantity: {
                            type: 'integer',
                            minimum: 0,
                            maximum: 999,
                            example: 2,
                          },
                          writeOffQuantity: {
                            type: 'integer',
                            minimum: 0,
                            maximum: 999,
                            example: 1,
                          },
                        },
                      },
                    },
                    staffNote: { type: 'string', maxLength: 500 },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The inspected return, with the counts on each line.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/StaffReturn' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed number or an unknown field.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not `received`, so it cannot be inspected.',
              'RETURN_NOT_TRANSITIONABLE',
            ),
            '422': errorResponse(
              'The counts do not account for what came back, a line is missing or named twice, or a SKU is not on this return. `details` names the offending line.',
              'RETURN_INSPECTION_INCOMPLETE',
            ),
          },
        },
      },

      '/api/v1/admin/returns/{returnNumber}/complete': {
        post: {
          tags: ['Returns'],
          summary: 'Complete a return: refund and restock (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            '**This is not "set status = completed".** It is where money and stock actually',
            'move. **Only `inspected` → `completed`.**',
            '',
            '### The ordering, and why it is this way round',
            '',
            '1. raise a refund for the FROZEN `refundTotal` — never a figure recomputed from',
            '   today’s catalogue, so a price change after the sale cannot alter what is owed;',
            '2. **stop unless it succeeded**;',
            '3. restock the good-to-sell units decided at inspection;',
            '4. close the return.',
            '',
            'All in one transaction. Refund before restock deliberately: if the refund fails we',
            'have moved nothing, whereas a restock that failed after a successful refund would',
            'have given money back for goods the system still believes are with the customer.',
            'The cheaper failure goes first.',
            '',
            '### A refund that did not succeed leaves the return open',
            '',
            'A **failed** refund is a `422` and the return stays `inspected`, ready to be',
            'completed again once the cause is fixed.',
            '',
            'An **unresolved** refund is also a `422`, and `details.refundStatus` says',
            '`processing`. That one must be reconciled against the provider and must **not** be',
            'retried — the money may already have moved. A second attempt is refused with',
            '`409 REFUND_ALREADY_RAISED`, because a partial unique index holds the return’s',
            'refund slot until the outstanding attempt succeeds or fails.',
            '',
            '### COD completes with a pending manual refund',
            '',
            'There is no gateway to confirm and the disbursement happens by a route this backend',
            'has no visibility of, so blocking on it would mean a COD return could never close.',
            'The refund row records the obligation, and staff settle it with',
            '`POST /api/v1/admin/refunds/{refundNumber}/settle` once the money is handed back.',
            '',
            '### Restock happens exactly once',
            '',
            'The `inspected` → `completed` compare-and-swap is the guarantee: a second',
            'completion matches no row, throws, and rolls back its own stock movement.',
            'Reservations are untouched — a returned unit was shipped, so its reservation was',
            'settled at fulfilment.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { staffNote: { type: 'string', maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The completed return, with the refunds raised for it.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return', 'refunds'],
                    properties: {
                      return: { $ref: '#/components/schemas/StaffReturn' },
                      refunds: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Refund' },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse('A malformed number or an unknown field.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not `inspected`, or a refund is already outstanding for it.',
              'REFUND_ALREADY_RAISED',
            ),
            '422': errorResponse(
              'The refund did not succeed. `details.refundStatus` is `failed` (retryable) or `processing` (reconcile, do NOT retry). Also returned when the refund would exceed the payment’s remaining refundable balance.',
              'RETURN_REFUND_NOT_SETTLED',
            ),
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}/returns': {
        post: {
          tags: ['Returns'],
          summary: 'Request a return for a delivered order',
          security: [{ bearerAuth: [] }],
          description: [
            'Raises a return for some or all of a delivered order’s units.',
            '',
            '### Everything monetary is server-derived',
            '',
            'The body is a reason, an optional note, and `{ skuCode, quantity }` lines. Every',
            'amount is apportioned INSIDE the transaction from the FROZEN `order_line`',
            'snapshot — never from the current SKU price, the current tax configuration or the',
            'current promotion. A client cannot supply a price, a tax amount, a discount, a',
            'refund total, a status, a delivery timestamp, a store id or a user id: each is a',
            '`400` naming the field.',
            '',
            '### Eligibility',
            '',
            'The order must belong to the caller, must not be cancelled, must have a DELIVERED',
            'shipment, and the delivery must be within the 7-day return window. The delivery',
            'instant comes from `shipment.delivered_at` and nowhere else.',
            '',
            '### Quantity',
            '',
            'Partial lines and partial quantities are both allowed, and a line may be returned',
            'across several requests. The cumulative quantity across all non-rejected returns',
            'can never exceed what was ordered: the order row is locked for the duration, so',
            'two concurrent requests for the last unit produce one `201` and one `422`.',
            '',
            '### `Idempotency-Key` is REQUIRED',
            '',
            'A retry that never saw the response would otherwise consume a second slice of the',
            'returnable quantity for goods sent back once. Same key and same body replays the',
            'original `201` verbatim; same key with a different body is a `422`.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              description: 'The order being returned against.',
            },
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 255 },
              description: 'Required. Scoped to the authenticated user, store and endpoint.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['reason', 'lines'],
                  properties: {
                    reason: {
                      type: 'string',
                      enum: [
                        'damaged_in_transit',
                        'defective',
                        'wrong_item_received',
                        'not_as_described',
                        'no_longer_needed',
                      ],
                      description: 'A closed list. Free text belongs in customerNote.',
                    },
                    customerNote: { type: 'string', maxLength: 500 },
                    lines: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 100,
                      description: 'Each SKU may appear at most once; combine the quantities.',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['skuCode', 'quantity'],
                        properties: {
                          skuCode: { type: 'string', maxLength: 64 },
                          quantity: { type: 'integer', minimum: 1, maximum: 999 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The created return, with its frozen line amounts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/Return' } },
                  },
                },
              },
            },
            '400': errorResponse(
              'Validation failed, or the Idempotency-Key header is missing.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '404': errorResponse(
              'The order is unknown, another customer’s, or another store’s.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'The same Idempotency-Key is still in flight.',
              'IDEMPOTENCY_CONFLICT',
            ),
            '422': errorResponse(
              'Not returnable (cancelled, undelivered, window closed, unknown SKU), the quantity is unavailable, or the key was reused with a different body.',
              'ORDER_NOT_RETURNABLE',
            ),
          },
        },
      },

      '/api/v1/users/me/returns': {
        get: {
          tags: ['Returns'],
          summary: 'List my returns',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of the caller’s returns, newest first, each with its lines.',
            '',
            'The page and the total share one predicate, so a caller on the last page is never',
            'told about rows it cannot reach. An over-limit page is a `400` rather than being',
            'silently clamped.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of returns.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['returns', 'total', 'limit', 'offset'],
                    properties: {
                      returns: { type: 'array', items: { $ref: '#/components/schemas/Return' } },
                      total: { type: 'integer' },
                      limit: { type: 'integer' },
                      offset: { type: 'integer' },
                    },
                  },
                },
              },
            },
            '400': errorResponse('An out-of-range limit or offset.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
          },
        },
      },

      '/api/v1/users/me/returns/{returnNumber}': {
        get: {
          tags: ['Returns'],
          summary: 'Read one of my returns',
          security: [{ bearerAuth: [] }],
          description: [
            'One return the caller owns.',
            '',
            'Another customer’s return is a `404`, the same answer a number that does not exist',
            'gets, so the response cannot be used to discover which numbers are real.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
              description: 'The return number, exactly as it was issued.',
            },
          ],
          responses: {
            '200': {
              description: 'The return.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/Return' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed return number.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '404': errorResponse('Unknown, or another customer’s or store’s.', 'NOT_FOUND'),
          },
        },
      },

      '/api/v1/users/me/returns/{returnNumber}/cancel': {
        post: {
          tags: ['Returns'],
          summary: 'Cancel one of my returns',
          security: [{ bearerAuth: [] }],
          description: [
            'Withdraws a return the merchant has approved but not yet received.',
            '',
            '**Only from `approved`.** Once the goods are in the merchant’s hands the decision',
            'is theirs, not the customer’s, so any other state is a `409`.',
            '',
            'Deliberately NOT idempotent: a second cancellation is a `409` rather than a repeat',
            '`200`, because a client that gets the same answer twice cannot tell whether it',
            'cancelled something or nothing. Order cancellation made the same choice.',
          ].join('\n'),
          parameters: [
            {
              name: 'returnNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^RET-\\d{8}-[A-Z2-9]{6}$' },
              description: 'The return number, exactly as it was issued.',
            },
          ],
          responses: {
            '200': {
              description: 'The cancelled return.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['return'],
                    properties: { return: { $ref: '#/components/schemas/Return' } },
                  },
                },
              },
            },
            '400': errorResponse('A malformed return number.', 'VALIDATION_ERROR'),
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '404': errorResponse('Unknown, or another customer’s or store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The return is not in a state a customer may cancel from.',
              'RETURN_NOT_TRANSITIONABLE',
            ),
          },
        },
      },

      '/api/v1/users/me/checkout': {
        post: {
          tags: ['Orders'],
          summary: 'Place an order from the cart',
          security: [{ bearerAuth: [] }],
          description: [
            'Turns the customer\u2019s active cart into an order. **The entire request body is',
            '`{ addressId }`.**',
            '',
            '### Everything is server-authoritative',
            '',
            'The cart is found from the verified token. Prices are re-read from the catalogue',
            'INSIDE the transaction, purchasability is re-evaluated, the applied promotion is',
            're-priced, and every total is computed from that one read. The cart\u2019s own',
            '`subtotal`, `discountTotal` and `cartTotal` are display values and are',
            'never consulted. A client cannot supply a price, a total, a discount, a quantity, a',
            'cart id or a promotion \u2014 every one of those is a `400` naming the field.',
            '',
            '### `Idempotency-Key` is REQUIRED',
            '',
            'A client that never sees the response cannot know whether the order was placed, so',
            'its only sane move is to retry \u2014 and without a key that retry places a second',
            'order and eventually takes a second payment. A retry with the same key and the same',
            'body replays the original `201` verbatim, with `Idempotent-Replay: true`.',
            '',
            'The key is scoped to the authenticated USER as well as the store and the endpoint,',
            'so two customers who happen to choose the same key value never collide.',
            '',
            '### One order per cart',
            '',
            'The cart row is locked for the duration, the transition to `checked_out` carries',
            'its own status predicate, and a unique constraint on the cart is the backstop. Eight',
            'simultaneous checkouts of one cart produce one order and seven clean `409`s.',
            '',
            'Afterwards the cart is `checked_out` and **immutable** \u2014 it is the record the',
            'order was made from \u2014 and the next `GET /users/me/cart` returns a new empty',
            'active cart.',
            '',
            '### Immutable snapshots',
            '',
            'Every product name, SKU code, SKU name, unit price and address field is COPIED onto',
            'the order. Renaming the product, repricing or deleting the SKU, or editing or',
            'deleting the address afterwards changes nothing about a past order.',
            '',
            '### What checkout does NOT do',
            '',
            '**Stock IS reserved**, in the same transaction that creates the order: the SKU\u2019s',
            '`reserved` count rises and its `available` falls, so two customers cannot buy the',
            'same last unit. If any line cannot be held, the WHOLE checkout is refused with a',
            '`409` naming the codes \u2014 there is no partial order and no partial reservation.',
            '',
            'What is still untouched is `on_hand` and the inventory ledger. A reservation changes',
            'what is SELLABLE, not what is physically present, so nothing here decrements stock',
            'or writes a ledger row \u2014 the increment that ships goods does both together.',
            '',
            '**Checkout itself takes no payment**: it neither charges nor',
            'contacts a gateway, and the order is `placed` whether or not it is ever paid for.',
            'Paying is a separate, explicit step — see `POST',
            '/users/me/orders/{orderNumber}/payments` — and it never changes `order.status`.',
            'No shipping is arranged and no rate is quoted. No tax is calculated. No invoice is',
            'generated. No promotion redemption is recorded, so ordering with a coupon consumes',
            'nothing.',
          ].join('\n'),
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description:
                'A client-generated key, 8 to 255 characters, unique per checkout attempt. A UUID is the obvious choice. Retrying with the same key and body replays the original response instead of placing a second order.',
              schema: { type: 'string', minLength: 8, maxLength: 255 },
              example: '7f3c9d2a-1b64-4a51-9c0e-2d8f4b6a1e77',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['addressId'],
                  additionalProperties: false,
                  properties: {
                    addressId: {
                      type: 'string',
                      format: 'uuid',
                      description:
                        "One of the customer's own addresses. Required, and there is no default: default addresses do not exist in this version. An unknown id, another customer's, another store's and a soft-deleted one are all one indistinguishable 404.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The order that was placed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['order'],
                    properties: { order: { $ref: '#/components/schemas/Order' } },
                  },
                },
              },
            },
            '404': errorResponse(
              "No such address for this customer in this store \u2014 unknown, someone else's, another store's, or soft-deleted. All indistinguishable, so the response reveals nothing about another customer's address book.",
              'NOT_FOUND',
            ),
            '409': {
              description:
                'One of three conflicts with existing state. INSUFFICIENT_STOCK \u2014 a line could not be reserved, with details.skuCodes naming which; the whole order is refused and nothing is held. CHECKOUT_CART_NOT_AVAILABLE \u2014 there is no active cart, or a concurrent checkout already took it. IDEMPOTENCY_CONFLICT \u2014 a request with this Idempotency-Key is still in flight. All three are safe to retry, though INSUFFICIENT_STOCK will keep failing until the stock exists.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
              },
            },
            '422': {
              description:
                'The cart is empty (CHECKOUT_CART_EMPTY); or one or more lines can no longer be bought (CHECKOUT_LINES_UNAVAILABLE, whose details name the offending skuCodes \u2014 the WHOLE checkout is refused rather than silently dropping items or creating a partial order); or this key was already used with a different body (IDEMPOTENCY_KEY_REUSE).',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders': {
        get: {
          tags: ['Orders'],
          summary: 'List the store’s orders (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'A page of **every order in the store**, whosever it is. Requires the `staff` scope.',
            '',
            'The browsable operator surface that `GET /admin/orders/{orderNumber}/invoice`',
            'deliberately declined to invent as a side effect of an invoice request. Its three',
            'open questions are answered here on their own terms:',
            '',
            '| Question | Answer |',
            '| --- | --- |',
            '| Filtering | `displayStatus`, `paymentStatus`, `shipmentStatus`, a placed-at range, and `q` |',
            '| Pagination | the usual `limit`/`offset`; page and total share one predicate |',
            '| How much of another customer staff may see | an id, an email and a name — **no address** |',
            '',
            '### `displayStatus`, and why it is derived',
            '',
            'The order lifecycle has two states, `placed` and `cancelled`. Payment lives in the',
            'payment table and fulfilment in the shipment table, and §43 records why folding them',
            'together is the shortcut that makes all three impossible to model properly later.',
            '',
            'So the dashboard’s single status is **composed on read** from all three and stored',
            'nowhere — see the `displayStatus` schema for the precedence table, and §49 in',
            '`docs/DECISIONS.md` for the full argument. Filtering by it happens in the database,',
            'before the page is cut, so a filtered page is a full page and the total agrees with',
            'it.',
            '',
            '**Two statuses in the dashboard design are not produced**: `ready_to_ship` needs an',
            'AWB column that does not exist, and `returned` needs a return to reach `completed`,',
            'which no route currently permits.',
            '',
            '### Tenancy',
            '',
            'Store-scoped from the verified staff token. There is no `storeId` parameter, so there',
            'is nothing a client could widen. Ownership within the store is what is relaxed, and',
            'that is the entire meaning of “admin” here.',
            '',
            'Ordered by `placedAt` descending, then `orderNumber` descending, so the ordering is',
            'total and a page boundary is stable when two orders share an instant.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'displayStatus',
              in: 'query',
              required: false,
              description: 'The dashboard tab. Applied in the database, not after paging.',
              schema: ORDER_DISPLAY_STATUS,
            },
            {
              name: 'paymentStatus',
              in: 'query',
              required: false,
              description:
                'The raw payment status. Orders with no payment row match no value here — use ' +
                '`displayStatus=pending` for those.',
              schema: { type: 'string', enum: ['pending', 'succeeded', 'failed', 'expired'] },
            },
            {
              name: 'shipmentStatus',
              in: 'query',
              required: false,
              description: 'The raw shipment status. Orders with no shipment match no value here.',
              schema: { type: 'string', enum: ['pending', 'shipped', 'delivered'] },
            },
            {
              name: 'placedFrom',
              in: 'query',
              required: false,
              description:
                'Inclusive lower bound on `placedAt`. A full ISO-8601 instant WITH an offset — ' +
                'the client owns the timezone, deliberately: a bare date would force the server ' +
                'to pick one, and every choice is wrong for somebody.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-01T00:00:00+05:30',
            },
            {
              name: 'placedTo',
              in: 'query',
              required: false,
              description:
                'Inclusive upper bound on `placedAt`, at millisecond granularity. Same format as ' +
                '`placedFrom`. A bound NAMES A MILLISECOND — the finest instant this API can ' +
                'express — and includes the whole of it, so an order stored at ' +
                '`14:20:00.123456Z` and published as `14:20:00.123Z` is returned by ' +
                '`placedTo=…123Z`: an order’s own timestamp always round-trips as a bound. ' +
                'The following millisecond is not swept in.',
              schema: { type: 'string', format: 'date-time' },
              example: '2026-09-30T23:59:59+05:30',
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              description:
                'Case-insensitive substring of the **order number or the customer’s email**. ' +
                'Deliberately not a search across names or addresses — a wider search is a wider ' +
                'disclosure, and these two are what an operator already has from the customer. ' +
                '`%` and `_` are escaped, so a typo cannot become a match-everything scan.',
              schema: { type: 'string', minLength: 1, maxLength: 320 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of the store’s orders, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['orders', 'pagination'],
                    properties: {
                      orders: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/AdminOrderSummary' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope. Scopes are read from the database on every request, so a demotion takes effect immediately.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}': {
        get: {
          tags: ['Orders'],
          summary: 'Read any order in the store (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The same order document the customer sees, for **any order in the store**, plus the',
            'four things an operator needs and a customer does not: the composed `displayStatus`,',
            'who placed it, where its payment stands and where its shipment stands.',
            '',
            'Requires the `staff` scope. Store-scoped and not owner-scoped — another customer’s',
            'order in the same store is NOT a `404` here, which is the point of the route.',
            '',
            'The order body is composed from the customer response rather than restated, so the',
            'money, the tax snapshot, the promotion and the line items cannot drift between the',
            'two audiences.',
            '',
            '### A malformed order number is a `404`, not a `400`',
            '',
            'Unusually for this API, and deliberately. This path is one segment under',
            '`/admin/orders/`, and it shares that shape with `GET /admin/orders/fulfilment`, which',
            'already exists. A path segment that is not shaped like an order number is therefore',
            'declined by this route and left to the rest of the application, so the fulfilment',
            'queue keeps working — measured, not assumed.',
            '',
            'The side effect is a better answer anyway: a `400` that distinguished “wrong shape”',
            'from “no such order” would tell an unauthorized prober which path shapes are real.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The order, with its customer and its lifecycle states.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['order'],
                    properties: {
                      order: { $ref: '#/components/schemas/AdminOrderDetail' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'The caller is authenticated but does not hold the `staff` scope.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such order in this store. An unknown number, another store’s order, and a malformed order number are all deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}/timeline': {
        get: {
          tags: ['Orders'],
          summary: 'The order status timeline (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The order’s append-only status history, oldest first. Requires the `staff` scope.',
            '',
            'A READ over `order_status_history`, which checkout and cancellation have written',
            'since the order module’s first increment and nothing has read until now. There is',
            'no second history table and nothing here can write.',
            '',
            '`actorType` says what KIND of actor caused each transition. The actor’s user id is',
            'deliberately absent: naming the colleague is an `audit_log` question, answered at',
            '`GET /admin/audit-logs` where the access controls for it already live.',
            '',
            'Ordered `(createdAt, id)` — the timestamp alone is not a total order, and the id is',
            'UUIDv7.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64 },
            },
          ],
          responses: {
            '200': {
              description: 'The transition history.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['timeline'],
                    properties: {
                      timeline: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/OrderTimelineEntry' },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s — indistinguishable.', 'NOT_FOUND'),
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}/cancel': {
        post: {
          tags: ['Orders'],
          summary: 'Cancel an order (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Cancels an order on the store’s behalf. Requires the `staff` scope.',
            '',
            '### The same rules as a customer cancellation',
            '',
            'This calls the SAME service method `POST /users/me/orders/{orderNumber}/cancel`',
            'does, without an owner predicate — staff act for the tenant rather than for a',
            'person. Every guard is shared rather than reimplemented:',
            '',
            '- a SHIPPED order is refused, checked under the order lock this transaction already',
            '  holds, so a shipment cannot slip in between the read and the write;',
            '- a PAID order is refused — reversing money is the refund aggregate’s job, not a',
            '  side effect of cancelling;',
            '- a payment still IN PROGRESS is refused;',
            '- the status move is a compare-and-swap, so two concurrent cancellations resolve to',
            '  exactly one;',
            '- held stock is released only AFTER that swap proves this request is the one that',
            '  cancelled.',
            '',
            '**`payment.status` is never written here.** A cancellation that would have needed a',
            'refund is refused by the paid guard, so there is nothing for this path to reverse.',
            '',
            'No `Idempotency-Key`, matching the customer route: a second cancellation is a `409`',
            'rather than a no-op, because a client that receives success twice cannot tell',
            'whether it cancelled something or nothing.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64 },
            },
          ],
          responses: {
            '200': {
              description: 'The cancelled order, in the admin projection.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['order'],
                    properties: { order: { $ref: '#/components/schemas/AdminOrderDetail' } },
                  },
                },
              },
            },
            '401': errorResponse('No or invalid access token.', 'UNAUTHORIZED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s — indistinguishable.', 'NOT_FOUND'),
            '409': errorResponse(
              'The order cannot be cancelled: it was already cancelled, has shipped, has been paid for, or has a payment in progress. `details.reason` distinguishes them.',
              'ORDER_NOT_CANCELLABLE',
            ),
          },
        },
      },

      '/api/v1/users/me/orders': {
        get: {
          tags: ['Orders'],
          summary: "List the customer's orders",
          security: [{ bearerAuth: [] }],
          description: [
            'The authenticated customer\u2019s own orders, **newest first**, each with its lines.',
            '',
            'Paginated with the project\u2019s usual `limit`/`offset` contract. An',
            'over-limit page is a `400` rather than being silently clamped: a clamped page',
            'tells a client its size was honoured when it was not, and a client paging on',
            '`offset += limit` would then skip orders.',
            '',
            'The page and the total share one predicate, so a caller on the last page is never',
            'told the total counted rows it cannot see.',
            '',
            'The staff equivalent is `GET /admin/orders`, which is store-scoped rather than',
            'owner-scoped and carries a composed `displayStatus`. This route is unchanged by it —',
            'no customer response gained a field.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
          ],
          responses: {
            '200': {
              description: 'A page of orders, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['orders', 'pagination'],
                    properties: {
                      orders: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}': {
        get: {
          tags: ['Orders'],
          summary: 'Read one order',
          security: [{ bearerAuth: [] }],
          description: [
            'One of the customer\u2019s own orders, addressed by its NUMBER \u2014 the internal id is',
            'never published, so it never becomes part of the contract.',
            '',
            'An unknown number, another customer\u2019s order and another store\u2019s order all',
            'produce the same `404`. A `403` for "someone else\u2019s" would confirm the',
            'order exists, which is exactly the leak one answer closes.',
            '',
            'Every value returned is a snapshot taken at checkout, so this response is stable',
            'for the life of the order.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              description:
                'ORD-YYYYMMDD-XXXXXX. Case-sensitive; a malformed number is a 400 rather than a query that could only miss.',
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The order.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['order'],
                    properties: { order: { $ref: '#/components/schemas/Order' } },
                  },
                },
              },
            },
            '404': errorResponse(
              "No such order for this customer in this store. Indistinguishable from another customer's order by design.",
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}/payments': {
        post: {
          tags: ['Payments'],
          summary: 'Initiate payment for an order',
          security: [{ bearerAuth: [] }],
          description: [
            'Create the payment for one of the customer’s own orders. **One payment per',
            'order**, enforced by a unique constraint — a second attempt is a `409`.',
            '',
            '### The whole request body is `{ method }`',
            '',
            '**The amount is server-authoritative and the client cannot influence it.** It is',
            'copied from the persisted `order.total`, which the database already constrains to',
            '`subtotal - discountTotal`. The schema is strict, so a body carrying `amount`,',
            '`total`, `currency`, `orderId`, `userId`, `storeId` or `status` is a `400` rather',
            'than being silently ignored. The currency comes from the order for the same reason.',
            '',
            '### `Idempotency-Key` is REQUIRED',
            '',
            'A client that never sees the response cannot know whether a payment was created.',
            'Without a key its only sane move is to retry, and for `online` that retry would',
            'create a second gateway-side order. Retrying with the same key and the same body',
            'replays the original response verbatim, including its status.',
            '',
            '### `online` versus `cod`',
            '',
            '`online` creates an object with the configured gateway and returns a `handoff` the',
            'client needs to complete the charge. The payment stays `pending` until a verified',
            'provider notification moves it — this endpoint never reports a completed charge.',
            '',
            '`cod` records the customer’s choice of cash on delivery. It contacts no gateway,',
            'has no provider and no `handoff`, and stays `pending`: nothing in this version can',
            'observe cash changing hands, because delivery does not exist yet.',
            '',
            '### What this does NOT do',
            '',
            '**It does not change `order.status`.** Payment and order are separate lifecycles,',
            'and the order stays `placed`. It records no refund, takes no retry, reserves no',
            'stock, calculates no tax and generates no invoice.',
          ].join('\n'),
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description:
                'A client-generated key, 8 to 255 characters, unique per initiation attempt. A UUID is the obvious choice. Retrying with the same key and body replays the original response instead of creating a second payment.',
              schema: { type: 'string', minLength: 8, maxLength: 255 },
              example: '7f3c9d2a-1b64-4a51-9c0e-2d8f4b6a1e77',
            },
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['method'],
                  properties: {
                    method: {
                      type: 'string',
                      enum: ['online', 'cod'],
                      description:
                        'Required, not defaulted: defaulting the most consequential field in the request would make a client’s omission silently pick a payment method for them.',
                      example: 'online',
                    },
                  },
                },
                example: { method: 'online' },
              },
            },
          },
          responses: {
            '201': {
              description:
                'The payment was created. `handoff` is present for `online` and absent for `cod`.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['payment'],
                    properties: {
                      payment: { $ref: '#/components/schemas/Payment' },
                      handoff: { $ref: '#/components/schemas/PaymentHandoff' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '404': errorResponse(
              'No such order. An unknown number, another customer’s order and another store’s order are deliberately indistinguishable.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'Either the order already has a payment (PAYMENT_ALREADY_EXISTS — including when a concurrent initiation won the race), or a request with this Idempotency-Key is still in flight (IDEMPOTENCY_CONFLICT).',
              'PAYMENT_ALREADY_EXISTS',
            ),
            '422': errorResponse(
              'Either the order cannot be paid for (ORDER_NOT_PAYABLE — its status does not permit it, or its total is zero), or this Idempotency-Key was already used with a different body (IDEMPOTENCY_KEY_REUSE).',
              'ORDER_NOT_PAYABLE',
            ),
            ...COMMON_ERRORS,
            /*
             * After the spread, deliberately. `COMMON_ERRORS` documents the 503 as a store that
             * could not be resolved; on this endpoint it much more often means the gateway, and
             * the narrower description is the useful one. Overriding rather than duplicating —
             * a duplicate key here is a `tsc` error, which is how this was caught.
             */
            '503': errorResponse(
              'An `online` payment was requested but the store has no usable gateway configuration, or the gateway could not be reached. COD is unaffected, because it never contacts one.',
              'DEPENDENCY_UNAVAILABLE',
            ),
          },
        },
      },

      '/api/v1/users/me/orders/{orderNumber}/payment': {
        get: {
          tags: ['Payments'],
          summary: 'Read the payment for an order',
          security: [{ bearerAuth: [] }],
          description: [
            'The payment for one of the customer’s own orders, with its full append-only',
            'transition history.',
            '',
            'Singular `payment` here against plural `payments` for the initiation, and that is',
            'deliberate: one payment per order is the model, so a customer reads *the* payment',
            'while the write creates *a* payment.',
            '',
            'An unknown order number, another customer’s order, another store’s order and an',
            'order with no payment yet all produce the same `404`.',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
              example: 'ORD-20260904-7QK4M2',
            },
          ],
          responses: {
            '200': {
              description: 'The payment and its history.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['payment'],
                    properties: { payment: { $ref: '#/components/schemas/Payment' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '404': errorResponse(
              'No such order, or the order has no payment. Deliberately indistinguishable from another customer’s order.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/webhooks/razorpay': {
        post: {
          tags: ['Webhooks'],
          summary: 'Razorpay payment notification',
          description: [
            '**Called by Razorpay, not by an API client.** Documented so the contract is',
            'reviewable, and because an operator debugging a delivery needs to know what each',
            'status code means.',
            '',
            '### Authentication is the signature, not a token',
            '',
            'A gateway holds no access token. The request is authenticated by an HMAC-SHA256',
            'signature over the **exact raw request bytes**, which is why this endpoint is',
            'mounted with a raw body parser ahead of JSON parsing: re-serialising parsed JSON',
            'produces different bytes and the signature would never match. Nothing in the body',
            'is trusted until the signature verifies.',
            '',
            '### The store is never taken from the request',
            '',
            'This endpoint is not store-scoped. The tenant is resolved from the payment that the',
            'verified provider reference names — a reference this system itself created and',
            'persisted against a store. A body claiming a store is ignored; no field here is',
            'read for tenancy.',
            '',
            '### Duplicates are a successful no-op',
            '',
            'Redelivery is ordinary with at-least-once delivery. The provider event id is unique',
            'in the database, so a second delivery cannot append a second history row, and the',
            'state machine independently refuses to move a payment that has already finished —',
            'so a `payment.failed` arriving after `payment.captured` cannot corrupt anything.',
            '',
            '### Why so many outcomes are `200`',
            '',
            'A `5xx` tells a gateway to retry. Answering that to a permanent condition — a',
            'duplicate, an event this version has no rule for, an unrecognised reference, an',
            'event conflicting with a terminal state — would turn one stray notification into',
            'an indefinite retry loop that no future delivery can resolve.',
            '',
            '### Refund resolution',
            '',
            '`refund.processed` and `refund.failed` resolve a refund that was left `processing`',
            'because the provider never answered the original refund call. `refund.created` and',
            '`refund.speed_changed` are not outcomes and are acknowledged without change.',
            '',
            'The refund is located by `payload.refund.entity.notes.refund_id` — an identifier',
            'this system generated and sent when raising the refund. Nothing else is used to',
            'match: no charge id, no amount heuristic. A refund raised before this mechanism',
            'existed carries no such note and stays manually resolvable.',
            '',
            'Only a `processing`, provider-mode refund whose amount matches the stored figure',
            'exactly may move. A manual (COD) obligation is never settled by a gateway, a',
            'terminal refund is never re-opened, and a refund row is never created here — this',
            'path only transitions a row that already exists, so a notification cannot change',
            'the refundable balance. **`payment.status` is not written on this path**: a refund',
            'is its own aggregate, and whether the original collection succeeded stays true',
            'however much money later goes back.',
          ].join('\n'),
          requestBody: {
            required: true,
            description:
              'Razorpay’s event envelope, delivered as raw bytes. Only `event`, `payload.payment.entity.order_id` and — for refund events — `payload.refund.entity.{id, amount, notes.refund_id}` are read; everything else is ignored, and no part of the body is persisted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['event'],
                  properties: {
                    event: {
                      type: 'string',
                      description:
                        'Acted on for `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`. Every other event — `refund.created`, `refund.speed_changed`, settlements, disputes, subscriptions — is out of scope for this version and acknowledged without change.',
                      example: 'payment.captured',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'Received. `applied` means a payment or a refund transitioned; `ignored` means it was deliberately not acted on, and `reason` says why (duplicate_event, unsupported_event, unknown_reference, already_terminal, illegal_transition, ambiguous_reference, unsupported_mode, amount_mismatch). A payment transition reports under `payment` and a refund transition under `refund` — never both, and never one in the other’s field.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['status'],
                    properties: {
                      status: { type: 'string', enum: ['applied', 'ignored'] },
                      reason: { type: 'string', example: 'duplicate_event' },
                      payment: {
                        type: 'object',
                        properties: {
                          status: {
                            type: 'string',
                            enum: ['pending', 'succeeded', 'failed', 'expired'],
                          },
                        },
                      },
                      refund: {
                        type: 'object',
                        properties: {
                          status: {
                            type: 'string',
                            enum: ['pending', 'processing', 'succeeded', 'failed'],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse(
              'The body is not a well-formed provider notification, or a payment event carried no order reference to match against.',
              'VALIDATION_ERROR',
            ),
            '401': errorResponse(
              'The signature is missing or does not verify. The response says nothing about which part was wrong, so a probe cannot learn whether the secret, the algorithm or the encoding was the problem.',
              'AUTHENTICATION_REQUIRED',
            ),
          },
        },
      },

      '/api/v1/users/me/addresses': {
        post: {
          tags: ['Addresses'],
          summary: 'Add an address',
          security: [{ bearerAuth: [] }],
          description: [
            "Creates an address in the authenticated customer's own address book.",
            '',
            'Requires only a valid access token \u2014 **no staff scope**. This is a customer acting',
            'on their own data, exactly like `PATCH /users/me`.',
            '',
            '### What the body cannot contain',
            '',
            'There is no `userId`, `storeId`, `actorUserId`, `id`, `deletedAt` or timestamp',
            'field, and an unknown key is a `400` naming it rather than being silently dropped.',
            'Ownership and tenancy come from the verified access token; the audit actor comes from',
            'the same place. There is no path by which a client can write into another',
            "customer's address book or across a tenant boundary.",
            '',
            '### Normalization',
            '',
            'Surrounding whitespace is trimmed and `countryCode` is uppercased. **Nothing else.**',
            'No case folding, no abbreviation rewriting, no PIN reformatting, no geocoding and no',
            'deliverability check \u2014 a validation layer that cannot express a customer\u2019s own',
            'address is worse than one that stores something unusual. Unicode is preserved, so',
            'Devanagari, Tamil and the `#` `/` `,` characters common in Indian addresses all pass',
            'through unchanged.',
            '',
            '### Addresses are mutable, orders are not',
            '',
            'This is an address BOOK: the customer edits these rows freely. A future order will',
            'snapshot the values it shipped to, so editing a typo can never rewrite a past invoice.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'label',
                    'recipientName',
                    'phone',
                    'line1',
                    'city',
                    'state',
                    'postalCode',
                  ],
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 60, example: 'Home' },
                    recipientName: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      example: 'Ada Lovelace',
                    },
                    phone: {
                      type: 'string',
                      minLength: 5,
                      maxLength: 20,
                      description:
                        'Kept permissive on purpose: real customer phone formats vary more than any regex worth writing. Digits, spaces, brackets, hyphens and a leading plus.',
                      example: '+91 98765 43210',
                    },
                    line1: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      example: '221B, Brigade Road',
                    },
                    line2: {
                      type: 'string',
                      maxLength: 300,
                      description:
                        'Optional. Absent becomes an empty string; an empty string clears it.',
                      example: 'Shanthala Nagar',
                    },
                    landmark: {
                      type: 'string',
                      maxLength: 300,
                      description: 'Optional. Absent becomes an empty string.',
                      example: 'Opposite the water tank',
                    },
                    city: { type: 'string', minLength: 1, maxLength: 120, example: 'Bengaluru' },
                    state: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description: 'Required. Free text — no state-code catalogue.',
                      example: 'Karnataka',
                    },
                    postalCode: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 16,
                      description:
                        'For IN, exactly six digits not starting with zero. Other countries: non-empty, bounded, no format guess.',
                      example: '560001',
                    },
                    countryCode: {
                      type: 'string',
                      minLength: 2,
                      maxLength: 2,
                      description: 'Optional; defaults to IN. Lowercase input is uppercased.',
                      example: 'IN',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Address created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['address'],
                    properties: { address: { $ref: '#/components/schemas/Address' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        get: {
          tags: ['Addresses'],
          summary: "List the customer's addresses",
          security: [{ bearerAuth: [] }],
          description: [
            'Every live address belonging to the authenticated customer, ordered by label.',
            '',
            'UNPAGED, deliberately: an address book is bounded by what one person can maintain.',
            'Soft-deleted addresses are excluded and there is no parameter that asks for them.',
            '',
            'Scoped by the user AND the store from the verified token. A request body on this route',
            'is ignored entirely \u2014 it cannot influence which addresses are returned.',
          ].join('\n'),
          responses: {
            '200': {
              description: "The customer's addresses, possibly empty.",
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['addresses'],
                    properties: {
                      addresses: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Address' },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/users/me/addresses/{id}': {
        get: {
          tags: ['Addresses'],
          summary: 'Read one address',
          security: [{ bearerAuth: [] }],
          description: [
            'One address from the authenticated customer\u2019s own book.',
            '',
            'An unknown id, **another customer\u2019s** address, another store\u2019s address and a',
            'soft-deleted one all return the same `404`. A `403` for "someone else\u2019s" would',
            'confirm that the id exists, which is exactly the leak one answer closes.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The address id. A malformed id is a 400 from validation, never a 500.',
              schema: { type: 'string', format: 'uuid' },
              example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33',
            },
          ],
          responses: {
            '200': {
              description: 'The address.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['address'],
                    properties: { address: { $ref: '#/components/schemas/Address' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such address in this customer\u2019s book, or it has been deleted.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        patch: {
          tags: ['Addresses'],
          summary: 'Update an address',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates one or more fields of the customer\u2019s own address.',
            '',
            'Every field is optional but **at least one is required**: an empty body would bump',
            '`updatedAt`, answer `200`, and leave a caller believing something changed.',
            '',
            'The same fields are unreachable as on create \u2014 `userId`, `storeId`, `actorUserId`,',
            '`id`, `deletedAt` and the timestamps \u2014 and an unknown key is a `400`.',
            '',
            'Sending `line2` or `landmark` as an empty string CLEARS it. `null` is not accepted:',
            'the columns are not-null with an empty-string default, and admitting both spellings of',
            '"nothing" would make every consumer handle two.',
            '',
            'Note: the Indian PIN rule is checked when `countryCode` and `postalCode` arrive',
            'together. Changing one and then the other in separate requests is not cross-validated',
            'against the stored row.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The address id. A malformed id is a 400 from validation, never a 500.',
              schema: { type: 'string', format: 'uuid' },
              example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 60, example: 'Home' },
                    recipientName: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      example: 'Ada Lovelace',
                    },
                    phone: {
                      type: 'string',
                      minLength: 5,
                      maxLength: 20,
                      description:
                        'Kept permissive on purpose: real customer phone formats vary more than any regex worth writing. Digits, spaces, brackets, hyphens and a leading plus.',
                      example: '+91 98765 43210',
                    },
                    line1: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      example: '221B, Brigade Road',
                    },
                    line2: {
                      type: 'string',
                      maxLength: 300,
                      description:
                        'Optional. Absent becomes an empty string; an empty string clears it.',
                      example: 'Shanthala Nagar',
                    },
                    landmark: {
                      type: 'string',
                      maxLength: 300,
                      description: 'Optional. Absent becomes an empty string.',
                      example: 'Opposite the water tank',
                    },
                    city: { type: 'string', minLength: 1, maxLength: 120, example: 'Bengaluru' },
                    state: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description: 'Required. Free text — no state-code catalogue.',
                      example: 'Karnataka',
                    },
                    postalCode: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 16,
                      description:
                        'For IN, exactly six digits not starting with zero. Other countries: non-empty, bounded, no format guess.',
                      example: '560001',
                    },
                    countryCode: {
                      type: 'string',
                      minLength: 2,
                      maxLength: 2,
                      description: 'Optional; defaults to IN. Lowercase input is uppercased.',
                      example: 'IN',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Address updated.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['address'],
                    properties: { address: { $ref: '#/components/schemas/Address' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such address in this customer\u2019s book, or it has been deleted.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Addresses'],
          summary: 'Remove an address',
          security: [{ bearerAuth: [] }],
          description: [
            'Removes the address from the customer\u2019s book.',
            '',
            '**Soft delete.** The row survives: an address is personal data inside the erasure',
            'story, and erasure in this system anonymises rather than deletes because tax law',
            'requires invoice retention. The address disappears from every read path immediately.',
            '',
            'A second delete is a `404` \u2014 a `GET` on a deleted address answers 404, so a',
            '`DELETE` answering 204 would contradict the very next request about the same id.',
            '',
            'There is **no restore endpoint**. A request body on this route is ignored entirely and',
            'cannot influence which address is removed.',
          ].join('\n'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              description: 'The address id. A malformed id is a 400 from validation, never a 500.',
              schema: { type: 'string', format: 'uuid' },
              example: '01a04310-0f2c-7b31-8c4d-9e2a5f7b1c33',
            },
          ],
          responses: {
            '204': { description: 'Address removed.' },
            '404': errorResponse(
              'No such address in this customer\u2019s book, or it has already been deleted.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products': {
        get: {
          tags: ['Catalogue'],
          summary: 'List products as staff',
          security: [{ bearerAuth: [] }],
          description: [
            'Lists products in the store this request resolves to, in **any** lifecycle status —',
            '`draft`, `active`, and `archived`. **Requires the `staff` scope.**',
            '',
            'Ordered **newest first**, by creation time with the id as a tie-breaker, so the order',
            'is deterministic: a product cannot appear on two pages or be skipped between them.',
            '',
            'Offset pagination. `total` counts rows matching the same visibility rules as the',
            'page, so it never includes another store or a deleted product.',
            '',
            'Unknown query parameters are rejected rather than ignored — `?limitt=50` is a `400`,',
            'not a silently defaulted page.',
            '',
            '`q` matches the product **name or slug**, case-insensitively, anywhere in the value.',
            '`%` and `_` are matched literally rather than as wildcards, so a merchant searching',
            'for `50%` finds that product rather than everything.',
            '',
            '`counts` reports how many products sit in each lifecycle status — the tab badges.',
            'It answers for the **whole store**, so it is unchanged by `limit`, `offset`, `q` and',
            '`status`: a count that moved when you filtered could not tell you what the other tab',
            'holds. Every status is present, zero-filled, so a tab does not vanish when it empties.',
          ].join('\n'),
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size. Values above the maximum are rejected, not clamped.',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: PRODUCT_LIST_MAX_LIMIT_DOC,
                default: PRODUCT_LIST_DEFAULT_LIMIT_DOC,
              },
              example: 20,
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              description: 'Rows to skip. Combine with `total` to page through the catalogue.',
              schema: { type: 'integer', minimum: 0, default: 0 },
              example: 0,
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              description:
                'Case-insensitive substring of the product name or slug. Trimmed; a whitespace-only value is a 400 rather than an unfiltered page.',
              schema: { type: 'string', minLength: 1, maxLength: 100 },
              example: 'shirt',
            },
            {
              name: 'status',
              in: 'query',
              required: false,
              description:
                'Narrows the page to one lifecycle status. Does not affect `counts`. An unrecognised value is a 400, not an empty page.',
              schema: { type: 'string', enum: ['draft', 'active', 'archived'] },
              example: 'active',
            },
            {
              name: 'stockState',
              in: 'query',
              required: false,
              description: [
                "Narrows the page by aggregate stock across the product's live SKUs.",
                '',
                '`out_of_stock` means NO live SKU has stock — a product with one sold-out variant',
                'and one in stock is `in_stock`, and a product with no SKUs at all is',
                '`out_of_stock`. `in_stock` and `low_stock` deliberately OVERLAP: a low SKU is',
                'still sellable.',
                '',
                '`low_stock` uses the SKU’s configured reorder point. A SKU with no configured',
                'threshold is never low — the merchant has not said what low means for it.',
                '',
                'Does not affect `counts`, which remain store-wide.',
              ].join('\n'),
              schema: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
            },
          ],
          responses: {
            '200': {
              description: 'A page of products, newest first, with the store-wide tab counts.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['products', 'pagination', 'counts'],
                    properties: {
                      products: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Product' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                      counts: { $ref: '#/components/schemas/ProductCounts' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
        post: {
          tags: ['Catalogue'],
          summary: 'Create a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates a product in the store this request resolved to. **Requires the `staff` scope.**',
            '',
            '**Store scoping is implicit.** There is no `storeId` field, and sending one is a 400',
            'rather than being ignored — the store comes from request resolution alone, so a caller',
            'cannot create a product in a store other than their own.',
            '',
            '**Creating does not publish.** `status` defaults to `draft`, so a product is not visible',
            'to customers until it is explicitly made `active`. Pass `status` to override.',
            '',
            '**Price is a string, not a number.** JSON numbers are IEEE-754 doubles, so 19.99 has',
            'already lost precision by the time it is parsed. Send it quoted. At most 4 decimal',
            'places. The currency is the store’s, is returned for reference, and is not accepted',
            'as input.',
            '',
            'Slugs are unique per store. Two different stores may both use `blue-shirt`.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['slug', 'name'],
                  additionalProperties: false,
                  properties: {
                    slug: {
                      type: 'string',
                      maxLength: 255,
                      pattern: SLUG_PATTERN,
                      description:
                        'URL segment. Trimmed and lowercased before validation. No leading, trailing, or doubled hyphens.',
                      example: 'blue-cotton-shirt',
                    },
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 300,
                      example: 'Blue Cotton Shirt',
                    },
                    description: {
                      type: 'string',
                      maxLength: 10000,
                      example: 'A comfortable everyday shirt.',
                    },
                    status: {
                      type: 'string',
                      enum: ['draft', 'active', 'archived'],
                      default: 'draft',
                      description:
                        'Omit to create a draft. Only `active` products will be publicly visible.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Product created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['product'],
                    properties: { product: { $ref: '#/components/schemas/Product' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes. Scopes are read from the database on every scoped request, so a revoked privilege takes effect immediately rather than when the token expires.',
              'PERMISSION_DENIED',
            ),
            '409': errorResponse(
              'A product with this slug already exists in this store. Slugs are unique per store, not globally.',
              'PRODUCT_SLUG_TAKEN',
            ),
            ...COMMON_ERRORS,
          },
        },
      },
      '/api/v1/admin/products/{slug}/skus': {
        post: {
          tags: ['Catalogue'],
          summary: 'Create a SKU under a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates a **SKU** — the sellable unit — under the product named by `slug`.',
            '**Requires the `staff` scope.**',
            '',
            'A product is a merchandising container: it has a name, a description and a URL, but',
            'no price and nothing to buy. A SKU is what carries the price, and what inventory,',
            'cart lines and order lines will reference.',
            '',
            'The parent product is addressed by `slug` **in the path**, resolved inside the',
            'authenticated store. There is no `storeId` or `productId` body field, so a SKU cannot',
            'be attached to another merchant’s product; the store recorded on the SKU is taken',
            'from the product row itself.',
            '',
            'An unknown slug, another store’s product, and a **deleted** product all return the',
            'same `404` — a distinct "deleted" would reveal which slugs had once existed.',
            '',
            '`code` is the merchant’s own identifier. It is unique per store among non-deleted',
            'SKUs and **case-sensitive**: unlike a slug, `ABC-1` and `abc-1` are different codes.',
            'Deleting a SKU frees its code for reuse.',
            '',
            '**`code` is optional.** Omit it and the server generates one from the product slug —',
            '`BLUE-SHIRT-K7M2QP`. The suffix is drawn with a CSPRNG from an alphabet that excludes',
            '`I`, `O`, `0` and `1`, so a code read off a shelf label cannot be mistyped into a',
            'different SKU. A generated collision is redrawn against the unique constraint rather',
            'than checked beforehand, so two concurrent creates cannot both pass a check and then',
            'race; a **supplied** code that collides is still a `409`, because quietly storing',
            'something other than what the merchant sent would be worse than refusing.',
            '',
            'Unknown body fields are rejected rather than ignored, including `storeId`,',
            '`productId`, `id`, and any tax field — tax classification is a later increment.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['price'],
                  additionalProperties: false,
                  properties: {
                    code: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description:
                        'The merchant SKU code. Case-sensitive, unique per store among non-deleted SKUs. Letters, digits, dots, underscores, slashes and hyphens; must start with a letter or digit. **Omit it to have one generated from the product slug.**',
                      example: 'SHIRT-BLUE-M',
                    },
                    price: {
                      type: 'string',
                      pattern: PRICE_PATTERN,
                      description:
                        'Decimal amount as a string, in the store currency. At most 4 decimal places, non-negative. Never a JSON number — a double cannot represent 19.99 exactly.',
                      example: '1499.00',
                    },
                    name: {
                      type: 'string',
                      maxLength: 300,
                      description: 'Optional display label. Absent becomes an empty string.',
                      example: 'Medium',
                    },
                    isActive: {
                      type: 'boolean',
                      default: true,
                      description:
                        'Whether the SKU is sellable. Defaults to true — the product’s own status already governs whether customers see it, so a second activation step would serve no purpose.',
                    },
                    lowStockThreshold: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 1000000,
                      description:
                        'Optional reorder point. **Absent stores `null` — no threshold — never `0`.** A SKU with no threshold is never reported as low; `0` is a configured value meaning "warn me only when this is gone". Use `PATCH /admin/skus/{code}` with an explicit `null` to clear one later.',
                      example: 5,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'SKU created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sku'],
                    properties: { sku: { $ref: '#/components/schemas/Sku' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such product in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'A live SKU already uses the code you supplied in this store. The code is not echoed back. A GENERATED code never produces this — a collision is redrawn.',
              'SKU_CODE_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        get: {
          tags: ['Catalogue'],
          summary: 'List a product’s SKUs',
          security: [{ bearerAuth: [] }],
          description: [
            'Every live SKU of the product — **active and inactive alike**, because a merchant',
            'manages both. **Requires the `staff` scope.**',
            '',
            'The public product read shows only ACTIVE SKUs; this is the merchant’s full view.',
            'Deleted SKUs are excluded from both.',
            '',
            '**Unpaginated**, deliberately. The number of SKUs under one product is bounded by the',
            'variant grid a merchant can plausibly maintain, so paging a single product’s variants',
            'would make the view harder to use for no benefit. Products themselves are unbounded',
            'and therefore paged.',
            '',
            'Ordered by `code`, so the list is stable across requests rather than reflecting',
            'insertion order.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': {
              description: 'The product’s SKUs, ordered by code.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['skus'],
                    properties: {
                      skus: { type: 'array', items: { $ref: '#/components/schemas/Sku' } },
                    },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such product in this store, or it has been deleted. Deliberately not an empty list: an empty array and a mistyped slug mean different things to a merchant.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/skus/{code}': {
        patch: {
          tags: ['Catalogue'],
          summary: 'Update a SKU',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates a SKU’s `name`, `price`, `isActive`, or `lowStockThreshold`. **Requires the `staff` scope.**',
            '',
            'Addressed by `code` alone rather than nested under its product: the code is unique',
            'per store, so the product adds nothing to the lookup. The lookup is always',
            '`(store, code)`, so another merchant’s identically-coded SKU is invisible.',
            '',
            '**`isActive` is an ordinary field here**, unlike a product’s `status`. Both of its',
            'transitions are always legal, so there is no state machine to enforce and no illegal',
            'transition to reject — which is precisely why product status is an explicit action',
            'instead. Deactivating a product’s last active SKU removes the product from the',
            'storefront; it stays visible to staff.',
            '',
            '`code` is **not** editable. It is the merchant’s identifier for the thing, carried on',
            'purchase orders and packing slips, so renaming it in place would silently repoint',
            'whatever already references it. A rename is a delete plus a create.',
            '',
            'At least one property is required — an empty body would bump `updatedAt`, return 200,',
            'and leave a caller believing something changed. Unknown fields are rejected,',
            'including `storeId`, `productId`, `id`, timestamps, and any tax field.',
          ].join('\n'),
          parameters: [SKU_CODE_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  description: 'At least one property. Unknown properties are rejected.',
                  properties: {
                    name: { type: 'string', maxLength: 300, example: 'Large' },
                    price: {
                      type: 'string',
                      pattern: PRICE_PATTERN,
                      description:
                        'Decimal string in the store currency, at most 4 decimal places, non-negative. Never a JSON number. The response reports the PERSISTED value, so 19.9 comes back as 19.9000.',
                      example: '1599.00',
                    },
                    isActive: {
                      type: 'boolean',
                      description: 'Whether the SKU is sellable. Both directions are legal.',
                    },
                    lowStockThreshold: {
                      description:
                        'The reorder point. **Nullable here, unlike on creation:** omitting the key leaves the configured threshold alone, while an explicit `null` clears it back to no-threshold. Without the null arm a threshold could be set but never removed.',
                      oneOf: [{ type: 'integer', minimum: 0, maximum: 1000000 }, { type: 'null' }],
                      example: 5,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated SKU, as persisted.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sku'],
                    properties: { sku: { $ref: '#/components/schemas/Sku' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such SKU in this store. An unknown code, another store’s SKU, and a deleted one are indistinguishable.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Catalogue'],
          summary: 'Delete a SKU',
          security: [{ bearerAuth: [] }],
          description: [
            '`204 No Content`. **Requires the `staff` scope.**',
            '',
            'The SKU is **soft** deleted: the row survives because order lines will reference',
            'SKUs, and a hard delete would either break that history or force a cascade that',
            'rewrites it.',
            '',
            'Deleting **frees the merchant code for reuse** — the unique index excludes deleted',
            'rows, so a merchant who deletes a mistake can recreate it under the same code.',
            '',
            'Deleting an already-deleted SKU is a `404`, not a second `204`: a `PATCH` on a',
            'deleted SKU answers 404, so a `DELETE` answering 204 would contradict the very next',
            'request about the same code.',
            '',
            'Deleting a **product** soft-deletes all of its SKUs in the same transaction, so no',
            'SKU is ever left looking sellable under a deleted product.',
          ].join('\n'),
          parameters: [SKU_CODE_PARAMETER],
          responses: {
            '204': { description: 'SKU deleted. No body.' },
            '404': errorResponse(
              'No such SKU in this store, or it was already deleted.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}/options': {
        post: {
          tags: ['Catalogue'],
          summary: 'Create a variant option on a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates a **variant option** — "Size", "Colour" — on the product named by `slug`.',
            '**Requires the `staff` scope.**',
            '',
            'An option belongs to ONE product. Two products that both offer "Size" own two',
            'independent options, which is what lets one sell S/M/L and another 39/40/41 without',
            'either constraining the other. Option names may therefore repeat across products.',
            '',
            'The name is unique per product among non-deleted options and compared',
            '**case-insensitively** — a `lower(name)` unique index in the database, not',
            'application lowercasing, so a bulk import cannot create what the API rejects. This',
            'is the deliberate OPPOSITE of a SKU code: an option name is a display label, while a',
            'SKU code is an identifier printed on purchase orders where case may be meaningful.',
            '',
            'A product may hold at most **10** options — an operational hygiene limit, not a',
            'merchandising rule. It keeps a SKU option signature well inside the size a unique',
            'index can arbitrate. Exceeding it is a `400`.',
            '',
            'There is no `storeId` or `productId` body field: parentage comes from the resolved',
            'product row, so an option cannot be created on another merchant’s product.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  additionalProperties: false,
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description:
                        'The label, as the merchant types it. Capitalisation is preserved; uniqueness ignores case.',
                      example: 'Size',
                    },
                    sortOrder: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 100000,
                      description:
                        'Display order. Absent becomes 0. Ties are broken by id, so the order is always total.',
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Option created. `values` is empty until values are added.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['option'],
                    properties: { option: { $ref: '#/components/schemas/Option' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such product in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'This product already has an option with this name, compared case-insensitively.',
              'OPTION_NAME_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        get: {
          tags: ['Catalogue'],
          summary: 'List a product’s options and values',
          security: [{ bearerAuth: [] }],
          description: [
            'The product’s live options, each with its selectable **values nested**.',
            '**Requires the `staff` scope.**',
            '',
            'There is deliberately no separate values endpoint: one shape means one parser, and a',
            'second endpoint returning the same rows would be a second place for their order to',
            'be decided.',
            '',
            'UNPAGINATED, like the SKU list and for the same reason — a variant grid is bounded by',
            'what a merchant can maintain, and the caps make that bound explicit.',
            '',
            'Deleted options and deleted values are excluded. An unknown slug is a `404` rather',
            'than an empty list: those mean different things to a merchant.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': {
              description: 'The product’s options, possibly empty.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['options'],
                    properties: {
                      options: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Option' },
                      },
                    },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such product in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/options/{id}': {
        patch: {
          tags: ['Catalogue'],
          summary: 'Rename or reorder an option',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates an option’s `name` or `sortOrder`. **Requires the `staff` scope.**',
            '',
            'At least one field must be supplied: an empty body would bump `updatedAt`, return',
            '`200`, and leave a caller believing something changed.',
            '',
            'FLAT rather than nested under the product — the id is already unique, so the product',
            'adds nothing to the lookup, and requiring it would admit a mismatched slug/id pair.',
            'The id is a UUID because an option has no merchant-facing code; a malformed one is a',
            '`400` from validation, never a database error.',
            '',
            '`productId` is NOT editable. Moving an option between products would orphan every',
            'SKU combination referring to it, and the composite foreign keys would reject the',
            'result anyway.',
          ].join('\n'),
          parameters: [OPTION_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description:
                        'The label, as the merchant types it. Capitalisation is preserved; uniqueness ignores case.',
                      example: 'Size',
                    },
                    sortOrder: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 100000,
                      description:
                        'Display order. Absent becomes 0. Ties are broken by id, so the order is always total.',
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Option updated.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['option'],
                    properties: { option: { $ref: '#/components/schemas/Option' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such option in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'This product already has an option with this name, compared case-insensitively.',
              'OPTION_NAME_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Catalogue'],
          summary: 'Retire an option',
          security: [{ bearerAuth: [] }],
          description: [
            'Soft-deletes the option **and its values**, in one transaction.',
            '**Requires the `staff` scope.**',
            '',
            'REFUSED with `409` while any **live** SKU still uses one of its values, and',
            '`details.skuCodes` names them. The merchant decides what happens to those SKUs, and',
            'cannot decide without knowing which they are.',
            '',
            'That refusal is the lifecycle decision, not a limitation: retiring a value a live SKU',
            'references would leave that SKU’s stored combination pointing at a retired row — the',
            'public response would show a PARTIAL combination, indistinguishable from a genuinely',
            'smaller one, and re-creating the value would mint a new id so the "same" combination',
            'would no longer collide with itself.',
            '',
            'A SKU that is already deleted never blocks anything, which is what makes retiring an',
            'option possible once its variants are gone. `sku_option_value` rows are retained as',
            'history and every id in them still resolves, because the deletion is SOFT.',
            '',
            'Deleting frees the option name for reuse. A second delete is a `404`.',
          ].join('\n'),
          parameters: [OPTION_ID_PARAMETER],
          responses: {
            '204': { description: 'Option and its values retired.' },
            '404': errorResponse(
              'No such option in this store, or it has already been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'Live SKUs still use this option. `details.skuCodes` names them.',
              'OPTION_IN_USE',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/options/{id}/values': {
        post: {
          tags: ['Catalogue'],
          summary: 'Add a value to an option',
          security: [{ bearerAuth: [] }],
          description: [
            'Creates a selectable **value** — "Small", "Red" — on the option.',
            '**Requires the `staff` scope.**',
            '',
            'Unique within the option among non-deleted values, compared case-insensitively by a',
            '`lower(value)` unique index. Different options and different products may reuse the',
            'same value freely.',
            '',
            'An option may hold at most **100** values — operational hygiene, as with the option',
            'cap. Exceeding it is a `400`.',
            '',
            'The value’s product is copied from the OPTION row rather than accepted from the',
            'request, which is what makes the option/product agreement unfalsifiable rather than',
            'merely enforced.',
          ].join('\n'),
          parameters: [OPTION_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['value'],
                  additionalProperties: false,
                  properties: {
                    value: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description:
                        'The label, as the merchant types it. Capitalisation is preserved; uniqueness ignores case.',
                      example: 'Medium',
                    },
                    sortOrder: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 100000,
                      description:
                        'Display order. Absent becomes 0. Ties are broken by id, so the order is always total.',
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Value created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { $ref: '#/components/schemas/OptionValue' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such option in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'This option already has a value with this name, compared case-insensitively.',
              'OPTION_VALUE_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/option-values/{id}': {
        patch: {
          tags: ['Catalogue'],
          summary: 'Rename or reorder an option value',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates a value’s `value` or `sortOrder`. **Requires the `staff` scope.**',
            '',
            'Renaming does **not** change any SKU’s combination. A SKU’s stored signature is built',
            'from value IDs precisely so that fixing a typo cannot silently redefine which variant',
            'a SKU represents, nor make two SKUs collide.',
            '',
            '`optionId` is not editable: moving a value between options would change what every',
            'SKU using it means, and could violate one-value-per-option for rows already committed.',
          ].join('\n'),
          parameters: [OPTION_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  properties: {
                    value: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 120,
                      description:
                        'The label, as the merchant types it. Capitalisation is preserved; uniqueness ignores case.',
                      example: 'Medium',
                    },
                    sortOrder: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 100000,
                      description:
                        'Display order. Absent becomes 0. Ties are broken by id, so the order is always total.',
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Value updated.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['value'],
                    properties: { value: { $ref: '#/components/schemas/OptionValue' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No such option value in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'This option already has a value with this name, compared case-insensitively.',
              'OPTION_VALUE_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Catalogue'],
          summary: 'Retire an option value',
          security: [{ bearerAuth: [] }],
          description: [
            'Soft-deletes one value. **Requires the `staff` scope.**',
            '',
            'REFUSED with `409` while any **live** SKU uses it, and `details.skuCodes` names',
            'them — the same rule, and the same reasoning, as retiring a whole option.',
            '',
            'Deleting frees the value name for reuse within its option.',
          ].join('\n'),
          parameters: [OPTION_ID_PARAMETER],
          responses: {
            '204': { description: 'Value retired.' },
            '404': errorResponse(
              'No such option value in this store, or it has already been deleted.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'Live SKUs still use this value. `details.skuCodes` names them.',
              'OPTION_IN_USE',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/skus/{code}/options': {
        put: {
          tags: ['Catalogue'],
          summary: 'Replace a SKU’s option combination',
          security: [{ bearerAuth: [] }],
          description: [
            'Sets the SKU’s complete variant combination. **Requires the `staff` scope.**',
            '',
            'REPLACEMENT, and the method says so. This is a separate route from',
            '`PATCH /admin/skus/{code}` — that endpoint writes `name`, `price` and `isActive`,',
            'and rejects anything else — because a scalar edit and a set replacement have',
            'different semantics and different failure modes.',
            '',
            '`optionValueIds: []` removes every option from the SKU. The field is REQUIRED even',
            'so: clearing a combination is a deliberate act and must be stated, not achieved by',
            'omitting a field. Option-LESS SKUs are fully legal and any number of them may coexist',
            'under one product.',
            '',
            'At most **10** values, and duplicate ids in the array are rejected rather than',
            'de-duplicated — a caller sending the same value twice is confused about something.',
            '',
            '### What is rejected, and how',
            '',
            'An id that is not a **selectable value of this SKU’s own product** is a `400`:',
            'unknown, another product’s, another store’s, deleted, or belonging to a deleted',
            'option — all indistinguishable on purpose, because confirming that an id exists',
            'elsewhere would leak across a tenant boundary.',
            '',
            'Two values of the SAME option is a `409`: the request is well-formed and every id is',
            'valid; what conflicts is the combination they describe.',
            '',
            'A combination another **live** SKU of this product already has is a `409`',
            '`SKU_COMBINATION_TAKEN`, decided by a unique index rather than by the check in front',
            'of it. Two concurrent identical combinations therefore resolve to exactly one success',
            'and one `409`, and the loser leaves no partial rows behind — the relationship rows',
            'and the SKU’s stored signature are written in a single transaction.',
            '',
            'Order does not matter: Red+Small and Small+Red are the same combination and collide.',
            'A soft-deleted SKU releases its combination, so a retired variant can be re-created.',
          ].join('\n'),
          parameters: [SKU_CODE_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['optionValueIds'],
                  additionalProperties: false,
                  properties: {
                    optionValueIds: {
                      type: 'array',
                      maxItems: 10,
                      uniqueItems: true,
                      description:
                        'The complete set of option value ids for this SKU. At most one value per option. An empty array removes every option.',
                      items: { type: 'string', format: 'uuid' },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'Combination replaced. Returns the full SKU, so the caller sees what was stored.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['sku'],
                    properties: { sku: { $ref: '#/components/schemas/Sku' } },
                  },
                },
              },
            },
            '404': errorResponse('No such SKU in this store, or it has been deleted.', 'NOT_FOUND'),
            '409': errorResponse(
              'Two values of one option (`SKU_OPTION_CONFLICT`), or another live SKU of this product already has this exact combination (`SKU_COMBINATION_TAKEN`).',
              'SKU_COMBINATION_TAKEN',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/inventory': {
        get: {
          tags: ['Inventory'],
          summary: 'List stock for the store',
          security: [{ bearerAuth: [] }],
          description: [
            'Current stock for every live SKU in the authenticated store, paged.',
            '**Requires the `staff` scope.**',
            '',
            'Inventory belongs to the **SKU**, not the product: the SKU is the sellable unit, so it',
            'is the thing that can be in stock. A product with three variants has three stock rows.',
            '',
            'Deleted SKUs are excluded. **Inactive SKUs are included** — deactivation means "not',
            'sellable", not "not stocked", and a merchant managing stock needs to see everything',
            'they hold. That is also why an inactive SKU can still be adjusted.',
            '',
            'There is no `storeId` parameter: the store comes from request resolution, and an',
            'unknown query parameter is a `400` rather than being silently ignored and returning',
            'a default page.',
            '',
            '`total` counts rows under the identical visibility rules as the page.',
          ].join('\n'),
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description:
                'Case-insensitive substring over the SKU code and the SKU name — the two things on a shelf label. `%` and `_` are literal characters, not wildcards. The product name is deliberately not searched: this list is keyed by SKU, and matching a product would return every variant for a term on none of them.',
              schema: { type: 'string', minLength: 1, maxLength: 200 },
            },
            {
              name: 'stockState',
              in: 'query',
              required: false,
              description: [
                'Narrows the page by stock state, using this module’s own definitions so the',
                'list cannot disagree with the summary counts beside it:',
                '',
                '- `out_of_stock` — `available <= 0`',
                '- `low_stock` — still sellable and at or below the SKU’s CONFIGURED reorder',
                '  point. A SKU with no configured threshold is never low.',
                '- `in_stock` — `available > 0`, which deliberately includes low SKUs.',
                '',
                '`available` is a generated column (`on_hand - reserved`); nothing is recomputed.',
              ].join('\n'),
              schema: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size. Values above the maximum are rejected, not clamped.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
              example: 20,
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              description: 'Rows to skip. Combine with `total` to page through.',
              schema: { type: 'integer', minimum: 0, default: 0 },
              example: 0,
            },
          ],
          responses: {
            '200': {
              description: 'A page of stock records.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['inventory', 'pagination'],
                    properties: {
                      inventory: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/StockItem' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/inventory/adjustments': {
        post: {
          tags: ['Inventory'],
          summary: 'Adjust a SKU\u2019s stock',
          security: [{ bearerAuth: [] }],
          description: [
            'Applies a signed **delta** to one SKU\u2019s stock and appends an entry to the',
            'append-only ledger. **Requires the `staff` scope.**',
            '',
            '### A delta, never a target',
            '',
            'The body carries how much to ADD or REMOVE, not what the new total should be. A target',
            'quantity would either require the client to read the current figure first \u2014',
            'recreating a lost-update race one layer up \u2014 or silently discard a concurrent',
            'adjustment. A merchant who has physically counted 40 units wants a recount, which is a',
            'different operation.',
            '',
            '### Concurrency',
            '',
            'The change is applied by a single atomic SQL statement whose own predicate enforces the',
            'store scope, the SKU\u2019s existence, that the SKU is not deleted, and that the result',
            'stays non-negative. Two concurrent adjustments therefore both take effect and the total',
            'is exactly correct; two concurrent decrements that together exceed stock resolve to one',
            'success and one `409`. Nothing is read, calculated, and written back.',
            '',
            '### What is rejected',
            '',
            'A **fractional** delta is a `400`: inventory is counted in whole units and',
            'rounding a merchant\u2019s figure silently would be worse than refusing it. A **zero**',
            'delta is a `400` too \u2014 it would write a ledger entry asserting that nothing',
            'happened.',
            '',
            'The store and the actor are **never** accepted from the body. The store comes from',
            'request resolution and the actor from the verified access token, so the ledger and the',
            'audit trail cannot be given a false author. Any unknown field is a `400` naming it.',
            '',
            'An unknown SKU, another store\u2019s SKU, and a **deleted** SKU all return the same',
            '`404` \u2014 a distinct answer would reveal which codes exist elsewhere.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['skuCode', 'delta', 'reason'],
                  additionalProperties: false,
                  properties: {
                    skuCode: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description:
                        'The merchant SKU code. Case-sensitive, resolved inside the authenticated store.',
                      example: 'SHIRT-BLUE-M',
                    },
                    delta: {
                      type: 'integer',
                      minimum: -1000000,
                      maximum: 1000000,
                      description:
                        'Signed whole number of units, never zero. The bound is operational hygiene: it keeps a mistyped paste away from integer overflow.',
                      example: -3,
                    },
                    reason: {
                      type: 'string',
                      enum: ['manual_increase', 'manual_decrease', 'correction'],
                      description:
                        'Required. An adjustment with no stated reason is an entry an auditor cannot interpret, and defaulting one would put a guess in the permanent record.',
                      example: 'manual_decrease',
                    },
                    note: {
                      type: 'string',
                      maxLength: 500,
                      description: 'Optional free text. Absent becomes an empty string.',
                      example: 'Counted during the Friday stocktake.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description:
                'Adjustment applied. Returns the resulting stock AND the ledger entry, so a caller never has to re-read to learn the outcome.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['inventory', 'adjustment'],
                    properties: {
                      inventory: { $ref: '#/components/schemas/StockItem' },
                      adjustment: { $ref: '#/components/schemas/StockAdjustment' },
                    },
                  },
                },
              },
            },
            '404': errorResponse('No such SKU in this store, or it has been deleted.', 'NOT_FOUND'),
            '409': errorResponse(
              'The adjustment would leave less stock than is available. `details.available` reports what there was.',
              'INSUFFICIENT_STOCK',
            ),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/inventory/{skuCode}/history': {
        get: {
          tags: ['Inventory'],
          summary: 'Read a SKU\u2019s stock ledger',
          security: [{ bearerAuth: [] }],
          description: [
            'Every stock movement for one SKU, newest first, paged.',
            '**Requires the `staff` scope.**',
            '',
            'The ledger is the **source of truth** for stock; the figure returned by the list',
            'endpoint is a projection of it, and the two are written in one transaction.',
            '',
            '**Append-only.** There is no endpoint that edits or deletes an entry, and the table has',
            'no columns with which to do either \u2014 so history cannot be rewritten. Each row',
            'records who changed the stock, by how much, from what to what, why, and when.',
            '',
            'History survives the SKU: soft-deleting a SKU or its product leaves every entry intact.',
            'Reading it still requires the SKU to be live, so an unknown, another store\u2019s, or a',
            'deleted SKU is a `404` rather than an empty page.',
          ].join('\n'),
          parameters: [
            {
              name: 'skuCode',
              in: 'path',
              required: true,
              description: 'The merchant SKU code. Case-sensitive; trimmed before lookup.',
              schema: { type: 'string', maxLength: 64 },
              example: 'SHIRT-BLUE-M',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size. Values above the maximum are rejected, not clamped.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
              example: 20,
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              description: 'Rows to skip. Combine with `total` to page through.',
              schema: { type: 'integer', minimum: 0, default: 0 },
              example: 0,
            },
          ],
          responses: {
            '200': {
              description: 'A page of ledger entries, possibly empty for a SKU never adjusted.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['history', 'pagination'],
                    properties: {
                      history: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/StockAdjustment' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            '404': errorResponse('No such SKU in this store, or it has been deleted.', 'NOT_FOUND'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/products': {
        get: {
          tags: ['Catalogue'],
          summary: 'List published products',
          description: [
            'Lists the published products of the store this request resolves to.',
            '',
            '**Public.** No authentication — a storefront and a search-engine crawler must both be',
            'able to browse the catalogue, and everything returned is what the merchant published.',
            '',
            'Only `active` products appear. Drafts, archived products, and deleted ones are absent',
            'from both the page and the `total`, so a client can page to the end without',
            'discovering rows it can never see.',
            '',
            'Ordered **newest first**, by creation time with the id as a tie-breaker, so the order',
            'is deterministic across pages.',
            '',
            'Pass `q` to search product **names**, and `price_min` / `price_max` to filter by',
            'price. They compose: `?q=shirt&price_min=1000&price_max=2000` means published',
            'shirts priced between 1000 and 2000 inclusive.',
            '',
            'The `total` reflects every filter applied, so paging through filtered results',
            'behaves exactly as paging through the full catalogue. Filtering happens before',
            '`limit` and `offset`.',
            '',
            'No filter widens visibility. Drafts, archived products, deleted products, and other',
            'stores’ products remain invisible whatever combination is supplied.',
            '',
            'Same pagination contract as the admin list. Unknown query parameters are rejected',
            'rather than ignored, and there is deliberately no sorting control yet — the order is',
            'always newest first.',
          ].join('\n'),
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description: [
                'Case-insensitive **substring** search against the product name.',
                '',
                'Searches the name only — not the description, slug, or status. Trimmed before use;',
                'an empty or whitespace-only value is a `400`, as is anything over 100 characters.',
                '',
                '`%`, `_`, and `` are treated as literal characters, so searching for `50%` finds a',
                'product named "50% Cotton" rather than matching everything.',
                '',
                'Searching never widens visibility: unpublished, deleted, and other stores’',
                'products stay invisible.',
              ].join('\n'),
              schema: { type: 'string', minLength: 1, maxLength: 100 },
              example: 'shirt',
            },
            {
              name: 'price_min',
              in: 'query',
              required: false,
              description: [
                '**Inclusive** lower price bound: a product priced exactly `price_min` is',
                'returned.',
                '',
                'A **decimal string**, not a JSON number — the same form the create and update',
                'bodies use, and for the same reason: a JSON number is a double, so `19.99`',
                'is already imprecise before the server sees it.',
                '',
                'Non-negative, at most 15 integer digits and at most 4 decimal places. Extra',
                'precision is a `400` rather than being rounded away. Trailing zeroes do not',
                'matter — `10` and `10.0000` select identically. `0` is a valid bound.',
                '',
                'Optional and independent: supply either bound alone for an open-ended range.',
                '`price_min` equal to `price_max` is valid and selects that exact price.',
                '',
                '`price_min` greater than `price_max` is a **`400`**, not an empty result — an',
                'empty page would suggest the filter was honoured and simply matched nothing,',
                'when the request cannot be satisfied at all.',
                '',
                'Prices are in the resolved store’s currency, reported on every product. There',
                'is no conversion and no cross-currency comparison.',
                '',
                'Filtering stays public and never widens visibility: unpublished, deleted, and',
                'other stores’ products stay invisible. The `total` reflects the filter.',
              ].join('\n'),
              schema: { type: 'string', pattern: PRICE_PATTERN },
              example: '1000.00',
            },
            {
              name: 'price_max',
              in: 'query',
              required: false,
              description: [
                '**Inclusive** upper price bound: a product priced exactly `price_max` is',
                'returned.',
                '',
                'Same rules as `price_min` — a non-negative decimal string of at most 4 decimal',
                'places, optional and independent, rejected rather than rounded when it carries',
                'more precision than the stored scale.',
                '',
                'Composes with `q` and `price_min`, and never widens visibility.',
              ].join('\n'),
              schema: { type: 'string', pattern: PRICE_PATTERN },
              example: '2000.00',
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size. Values above the maximum are rejected, not clamped.',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: PRODUCT_LIST_MAX_LIMIT_DOC,
                default: PRODUCT_LIST_DEFAULT_LIMIT_DOC,
              },
              example: 20,
            },
            {
              name: 'offset',
              in: 'query',
              required: false,
              description: 'Rows to skip. Combine with `total` to page through the catalogue.',
              schema: { type: 'integer', minimum: 0, default: 0 },
              example: 0,
            },
          ],
          responses: {
            '200': {
              description: 'A page of published products, newest first.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['products', 'pagination'],
                    properties: {
                      products: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Product' },
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' },
                    },
                  },
                },
              },
            },
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/products/{slug}': {
        get: {
          tags: ['Catalogue'],
          summary: 'Get a published product',
          description: [
            'Returns a published product from the store this request resolves to.',
            '',
            '**Public.** No authentication. A storefront and a search-engine crawler must both be',
            'able to read the catalogue, and everything returned here is what the merchant chose to',
            'publish.',
            '',
            '**Store-scoped.** The same slug may identify a different product, or nothing at all,',
            'depending on which store the request resolves to. There is no parameter for selecting',
            'a store.',
            '',
            'Only products the merchant has published are returned. Anything else — an unknown',
            'slug, or a product that is not published — is a `404` with an identical body, so this',
            'endpoint cannot be used to discover which slugs exist.',
          ].join('\n'),
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              description:
                'The product URL segment. Trimmed and lowercased before lookup, so a slug differing only in case resolves to the same product.',
              schema: { type: 'string', maxLength: 255, pattern: SLUG_PATTERN },
              example: 'blue-cotton-shirt',
            },
          ],
          responses: {
            '200': {
              description: 'The published product.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['product'],
                    properties: { product: { $ref: '#/components/schemas/Product' } },
                  },
                },
              },
            },
            '404': errorResponse(
              'No published product with this slug exists in this store. Returned identically whether the slug has never existed or the product is simply not published — the response deliberately does not distinguish the two.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}': {
        delete: {
          tags: ['Catalogue'],
          summary: 'Delete a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Deletes a product. **Requires the `staff` scope.**',
            '',
            '**Soft delete.** The record is retained — order history and invoices reference products,',
            'and removing the row would either break those or rewrite history. What changes is',
            'visibility: the product immediately stops appearing in the admin list, the admin read,',
            'the public read, and the lifecycle actions. To a client it is simply gone.',
            '',
            'The slug becomes available again. Slug uniqueness applies only to products that are not',
            'deleted, so a new product may reuse the slug afterwards.',
            '',
            'No request body. Deleting an already-deleted product returns `404`, consistent with',
            'every other endpoint treating a deleted product as nonexistent — this operation is not',
            'idempotent, deliberately.',
            '',
            'There is no undelete. Restoring a deleted product is not supported.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '204': { description: 'Deleted. No body.' },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store. Returned identically whether the slug has never existed, the product belongs to another store, or it has already been deleted.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
        patch: {
          tags: ['Catalogue'],
          summary: 'Update product data',
          security: [{ bearerAuth: [] }],
          description: [
            'Updates a product `name`, `description`, and/or `price`. **Requires the `staff` scope.**',
            '',
            'Send only the fields you are changing — an omitted field is left untouched. At least',
            'one must be present: an empty body is a `400`, not a no-op that bumps the timestamp.',
            '',
            '**Not editable here**, and rejected with a `400` rather than ignored:',
            '`slug`, `status`, `storeId`, `currency`, `id`, `createdAt`, `updatedAt`, `deletedAt`.',
            '',
            '`status` moves only through the explicit `publish` and `archive` actions, which enforce',
            'which transitions are legal. A product keeps its lifecycle status across an edit —',
            'editing a published product does not unpublish it.',
            '',
            '`slug` is the product identity and its public URL; renaming is a redirect concern, not',
            'a field update, and is not supported yet.',
            '',
            'The response is the **persisted** product, so a normalised price comes back in its',
            'stored form: sending `"19.9"` returns `"19.9000"`.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  description: 'At least one property. Unknown properties are rejected.',
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 300, example: 'Blue Shirt' },
                    description: {
                      type: 'string',
                      maxLength: 10000,
                      description: 'An empty string clears the description. `null` is rejected.',
                      example: 'Updated copy.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': PRODUCT_LIFECYCLE_RESPONSE('The updated product, as persisted.'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store. Returned identically whether the slug has never existed, the product belongs to another store, or it has been deleted.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
        get: {
          tags: ['Catalogue'],
          summary: 'Get a product as staff',
          security: [{ bearerAuth: [] }],
          description: [
            'Returns a product in **any** lifecycle status — `draft`, `active`, or `archived`.',
            '**Requires the `staff` scope.**',
            '',
            'The staff counterpart to `GET /api/v1/products/{slug}`, which returns published',
            'products only. Same slug, same store, same response shape; the difference is that a',
            'merchant may see their own unpublished work.',
            '',
            'Scoped to the store the request resolves to. A product in another store, a deleted',
            'product, and a slug that never existed all return the same `404`.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': PRODUCT_LIFECYCLE_RESPONSE('The product, whatever its lifecycle status.'),
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store. Returned identically whether the slug has never existed, the product belongs to another store, or it has been deleted.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}/publish': {
        post: {
          tags: ['Catalogue'],
          summary: 'Publish a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Makes a product publicly readable. **Requires the `staff` scope.**',
            '',
            'Allowed from `draft` and from `archived` — archiving is reversible, so a product',
            'withdrawn by mistake can be restored. Publishing an already-published product is a',
            '`409`, not a silent success.',
            '',
            'No request body. The action is the verb, so there is no status field to get wrong and',
            'no way to express an unpublish.',
            '',
            'On success the product becomes available at `GET /api/v1/products/{slug}`.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': PRODUCT_LIFECYCLE_RESPONSE('The product is now `active`.'),
            ...PRODUCT_LIFECYCLE_ERRORS,
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}/archive': {
        post: {
          tags: ['Catalogue'],
          summary: 'Archive a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Withdraws a product from the storefront. **Requires the `staff` scope.**',
            '',
            'Allowed from `active` only. Archiving an already-archived product is a `409`. A draft',
            'cannot be archived — it is already invisible to customers, so there is nothing to',
            'withdraw.',
            '',
            'Reversible: `POST /api/v1/admin/products/{slug}/publish` restores it.',
            '',
            'No request body. On success the product stops being available at',
            '`GET /api/v1/products/{slug}`, which returns its usual `404`.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': PRODUCT_LIFECYCLE_RESPONSE('The product is now `archived`.'),
            ...PRODUCT_LIFECYCLE_ERRORS,
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/bulk': {
        post: {
          tags: ['Catalogue'],
          summary: 'Apply a lifecycle action to many products',
          security: [{ bearerAuth: [] }],
          description: [
            'Publishes, archives or deletes several products in one request. **Requires the',
            '`staff` scope.**',
            '',
            '**All or nothing.** The whole batch commits in one transaction, and there is no',
            'partial-success shape: an unknown slug is a `404` and an illegal transition a `409`,',
            'in both cases with **nothing applied**. An operator who selected twelve products and',
            'got a 200 knows all twelve moved; a partial result would leave them reconciling by',
            'hand, which is exactly what the bulk action exists to avoid.',
            '',
            'The failures name the offending slugs in `details`, so the screen can highlight them',
            'rather than making the operator find them.',
            '',
            'The actions are exactly the three the single-product routes expose, enforced by the',
            'same transition table. A bulk action able to do something no individual action can',
            'would be a second, less-guarded lifecycle.',
            '',
            'Duplicate slugs are collapsed rather than rejected — a slug named twice is one',
            'product. `affected` therefore counts DISTINCT products, and `slugs` is sorted, so',
            'two identical requests produce identical responses.',
            '',
            '`delete` is the same soft delete as `DELETE /api/v1/admin/products/{slug}`: the row',
            'is retained so historical orders still resolve, and the slug is freed for reuse.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['action', 'slugs'],
                  additionalProperties: false,
                  properties: {
                    action: {
                      type: 'string',
                      enum: ['publish', 'archive', 'delete'],
                      description:
                        'The lifecycle verb to apply to every named product. An unrecognised value is a 400.',
                      example: 'publish',
                    },
                    slugs: {
                      type: 'array',
                      minItems: 1,
                      maxItems: PRODUCT_LIST_MAX_LIMIT_DOC,
                      items: { type: 'string', maxLength: 255, pattern: SLUG_PATTERN },
                      description:
                        'The products to act on. Non-empty — an empty selection is a client bug, not a no-op worth a 200. Bounded, because the whole batch commits in one transaction.',
                      example: ['blue-cotton-shirt', 'red-wool-scarf'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Every named product moved.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['action', 'affected', 'slugs'],
                    properties: {
                      action: { type: 'string', enum: ['publish', 'archive', 'delete'] },
                      affected: {
                        type: 'integer',
                        minimum: 1,
                        description:
                          'DISTINCT products changed, after duplicate slugs are collapsed.',
                        example: 2,
                      },
                      slugs: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'The products changed, sorted.',
                        example: ['blue-cotton-shirt', 'red-wool-scarf'],
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'At least one slug does not name a live product in this store. `details.slugs` lists every one that did not resolve, and NOTHING was applied.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'At least one product cannot make this transition from its current status. `details.slugs` lists every offender, and NOTHING was applied.',
              'PRODUCT_STATUS_CONFLICT',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}/media': {
        post: {
          tags: ['Catalogue'],
          summary: 'Register an uploaded image against a product',
          security: [{ bearerAuth: [] }],
          description: [
            'Records an image that is **already in object storage**. **Requires the `staff`',
            'scope.**',
            '',
            '**No binary ever travels through this API.** The bytes go straight from the browser',
            'to storage; this call stores the key and the metadata needed to render the image.',
            'Ask `POST /api/v1/admin/products/{slug}/media/upload-target` where to send them.',
            '',
            'The first image registered against a product becomes its primary automatically —',
            'a product with images and no primary would have nothing to show on the list screen.',
            'Later images append to the end of the gallery rather than jumping to the front.',
            '',
            '`skuCode` attaches the image to one variant. A code belonging to a DIFFERENT product',
            'is a `404`, indistinguishable from one that does not exist: it is not this product’s',
            'variant whatever else is true of it.',
            '',
            '`width` and `height` are a pair — both or neither. Half a measurement cannot lay',
            'anything out and is worse than none, because it looks usable.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['storageKey', 'contentType'],
                  additionalProperties: false,
                  properties: {
                    storageKey: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 512,
                      description:
                        'The object key the bytes were uploaded under. Must start with a letter or digit and contain only letters, digits, dots, underscores, slashes and hyphens; a parent-directory segment is rejected.',
                      example: 'stores/s1/products/p1/front.webp',
                    },
                    contentType: {
                      type: 'string',
                      enum: MEDIA_CONTENT_TYPES_DOC,
                      description:
                        'A closed list rather than any `image/*`: an SVG is a script container and a TIFF will not display, so accepting either would let a merchant upload an image that silently never appears.',
                      example: 'image/webp',
                    },
                    skuCode: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description: 'The variant this image is of. Omit for the product generally.',
                      example: 'SHIRT-BLUE-M',
                    },
                    altText: { type: 'string', maxLength: 300, example: 'Blue shirt, front view' },
                    width: { type: 'integer', minimum: 1, maximum: 20000, example: 1200 },
                    height: { type: 'integer', minimum: 1, maximum: 20000, example: 1600 },
                    byteSize: {
                      type: 'integer',
                      minimum: 1,
                      maximum: MEDIA_MAX_BYTES_DOC,
                      example: 184320,
                    },
                    position: {
                      type: 'integer',
                      minimum: 0,
                      maximum: 1000,
                      description: 'Omit to append to the end of the gallery.',
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The image is registered.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['media'],
                    properties: { media: { $ref: '#/components/schemas/ProductMedia' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store, it has been deleted, or `skuCode` does not name one of ITS variants.',
              'NOT_FOUND',
            ),
            '409': errorResponse(
              'This storage key is already registered in this store. Registering it twice would give one object two rows that could then disagree.',
              'MEDIA_ALREADY_REGISTERED',
            ),
            ...COMMON_ERRORS,
          },
        },

        get: {
          tags: ['Catalogue'],
          summary: 'List a product’s images',
          security: [{ bearerAuth: [] }],
          description: [
            'The product’s gallery, in the merchant’s order. **Requires the `staff` scope.**',
            '',
            '**Unpaginated**, deliberately: a gallery is a handful of images, bounded by what a',
            'merchant will upload for one listing. Paginating it would add a contract for no',
            'benefit and make the ordering harder to reason about.',
            '',
            'Ordered by `position` ascending, then by creation time, so the order is stable',
            'across requests rather than reflecting insertion order alone.',
            '',
            'An empty array is a product with no images; an unknown product is a `404`. Those are',
            'different facts and are reported differently.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          responses: {
            '200': {
              description: 'The gallery, in merchant order.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['media'],
                    properties: {
                      media: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ProductMedia' },
                      },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/products/{slug}/media/upload-target': {
        post: {
          tags: ['Catalogue'],
          summary: 'Ask where to upload an image',
          security: [{ bearerAuth: [] }],
          description: [
            'Returns a pre-signed target to `PUT` the bytes to. **Requires the `staff` scope.**',
            '',
            'This is how a multi-megabyte image reaches storage without passing through this API,',
            'and why nothing here accepts a file upload. Once the `PUT` succeeds, send the',
            'returned `storageKey` to `POST /api/v1/admin/products/{slug}/media`.',
            '',
            '**A `503` here is the honest answer, not an outage.** This deployment has no object',
            'storage configured, so nothing can sign a `PUT`. Everything around the upload —',
            'registration, the gallery, ordering, the primary flag, deletion — works regardless;',
            'only this one call needs external S3-compatible credentials.',
          ].join('\n'),
          parameters: [PRODUCT_SLUG_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['contentType', 'byteSize'],
                  additionalProperties: false,
                  properties: {
                    contentType: {
                      type: 'string',
                      enum: MEDIA_CONTENT_TYPES_DOC,
                      example: 'image/webp',
                    },
                    byteSize: {
                      type: 'integer',
                      minimum: 1,
                      maximum: MEDIA_MAX_BYTES_DOC,
                      description:
                        'Declared up front so an oversized object is refused before it is uploaded rather than after.',
                      example: 184320,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Where to PUT the bytes.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['upload'],
                    properties: {
                      upload: { $ref: '#/components/schemas/MediaUploadTarget' },
                    },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such product in this store, or it has been deleted.',
              'NOT_FOUND',
            ),
            /*
             * Spread FIRST here, uniquely: this route overrides the shared 503. The common one
             * describes an unresolvable store, which is also reachable here; this one names the
             * far likelier cause on this particular route, so the more specific text wins.
             */
            ...COMMON_ERRORS,
            '503': errorResponse(
              'Either this deployment has no object storage configured, so no upload can be signed — every other media route still works — or the store could not be resolved. An operational fault, not a client error.',
              'DEPENDENCY_UNAVAILABLE',
            ),
          },
        },
      },

      '/api/v1/admin/media/{id}': {
        patch: {
          tags: ['Catalogue'],
          summary: 'Edit an image’s alt text, position or primary flag',
          security: [{ bearerAuth: [] }],
          description: [
            'Edits the three things about an image a merchant changes. **Requires the `staff`',
            'scope.**',
            '',
            'Addressed by media id rather than nested under the product, matching',
            '`PATCH /api/v1/admin/options/{id}`: the id identifies the row within a store, and',
            'requiring the product too would let a caller pass a mismatched pair whose behaviour',
            'would then need defining.',
            '',
            'Promoting a primary demotes the previous one **in the same transaction**, so the',
            'product is never left with two primaries or with none.',
            '',
            '`storageKey`, `productId` and `skuCode` are absent and therefore unreachable rather',
            'than ignored: repointing an image at a different object or a different product is a',
            'delete plus a create, not an edit, and allowing it here would let one row’s history',
            'describe two different images.',
            '',
            'An empty body is a `400`, not a 200 — it would bump `updatedAt` and leave a caller',
            'believing something changed.',
          ].join('\n'),
          parameters: [MEDIA_ID_PARAMETER],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  minProperties: 1,
                  additionalProperties: false,
                  description: 'Every field optional, but at least one required.',
                  properties: {
                    altText: { type: 'string', maxLength: 300, example: 'Blue shirt, back view' },
                    position: { type: 'integer', minimum: 0, maximum: 1000, example: 2 },
                    isPrimary: {
                      type: 'boolean',
                      description:
                        'Setting this true demotes whichever image was primary. Setting it false leaves the product with NO primary rather than promoting a successor — which image represents a product is a merchandising decision.',
                      example: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'The updated image.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['media'],
                    properties: { media: { $ref: '#/components/schemas/ProductMedia' } },
                  },
                },
              },
            },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such image, it has been deleted, or it belongs to another store. All three are indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },

        delete: {
          tags: ['Catalogue'],
          summary: 'Remove an image',
          security: [{ bearerAuth: [] }],
          description: [
            'Removes an image from the product. **Requires the `staff` scope.**',
            '',
            'Soft-deleted, so the row survives as a record that the storage object should be',
            'reclaimed — a hard delete would lose the only pointer to an object still costing',
            'money in the bucket. The storage key is freed for re-registration.',
            '',
            'Removing the primary leaves the product with **no** primary rather than promoting a',
            'successor, for the reason given under `PATCH`.',
            '',
            'A repeated delete is a `404` rather than a silent success that the next read would',
            'contradict.',
          ].join('\n'),
          parameters: [MEDIA_ID_PARAMETER],
          responses: {
            '204': { description: 'The image is removed. No body.' },
            '401': errorResponse(
              'No access token was supplied, or the token is invalid, expired, issued for a different store, or the account has been deactivated or deleted.',
              'AUTHENTICATION_REQUIRED',
            ),
            '403': errorResponse(
              'Authenticated, but the account does not hold the `staff` scope. `details.missing` names the required scopes.',
              'PERMISSION_DENIED',
            ),
            '404': errorResponse(
              'No such image, it has already been deleted, or it belongs to another store. All three are indistinguishable.',
              'NOT_FOUND',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/orders/{orderNumber}/refund': {
        post: {
          tags: ['Payments'],
          summary: 'Refund an order’s payment (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'Moves money back against the payment behind the named order.',
            '',
            '### Not a generic "refund any payment" endpoint',
            '',
            'The refund is bound to the payment behind THIS order — `uq_payment_order` makes the',
            'two equivalent — its amount is checked against that payment’s remaining refundable',
            'balance under a row lock, and the currency is copied from the payment rather than',
            'accepted from the caller. A refund that could name its own currency would be a',
            'refund that could claim ₹100 against a $100 charge.',
            '',
            'Addressed by order number because that is the identifier staff already have in front',
            'of them, and because the payment’s internal UUID is published nowhere in this API.',
            '',
            '### Partial refunds, and the cumulative cap',
            '',
            'Send less than the remaining balance. There is no `partial` flag, because the',
            'amount already says everything a flag would. **Σ(claimed refunds) can never exceed',
            'the captured amount**, and an attempt still in flight holds its share of the balance',
            'so nobody refunds around an unresolved provider call.',
            '',
            '`refundBalance.claimed` and `refundBalance.refunded` differ exactly in that window.',
            '',
            '### Provider outcomes',
            '',
            'A **4xx** from the gateway is evidence of refusal, so the refund is `failed` and its',
            'amount is released for a retry. A **5xx**, a timeout or an unparseable response is',
            'not evidence of anything: the refund is `processing`, it keeps consuming balance,',
            'and it must be reconciled rather than retried.',
            '',
            '### COD and uncaptured charges are manual',
            '',
            'A COD payment, or an online one whose provider charge id was never captured, yields',
            'a `manual` refund: a recorded obligation, settled offline and marked with',
            '`POST /api/v1/admin/refunds/{refundNumber}/settle`. No gateway is called and none is',
            'faked. A COD payment is refundable only once the order has been DELIVERED, which is',
            'when the cash actually changed hands.',
            '',
            '### Idempotency-Key is required',
            '',
            'A client that never sees the response cannot know whether money moved, and its only',
            'sane move is to retry — which without a key would refund twice.',
            '',
            '**The payment’s own status is never changed.** A refund is its own aggregate;',
            '`payment.status` continues to mean "did the original collection succeed".',
          ].join('\n'),
          parameters: [
            {
              name: 'orderNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: '^ORD-\\d{8}-[A-Z2-9]{6}$' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount'],
                  additionalProperties: false,
                  properties: {
                    amount: {
                      type: 'string',
                      pattern: PRICE_PATTERN,
                      description:
                        'Decimal amount as a string, in the payment’s currency. At most 4 decimal places. Never a JSON number — a double cannot represent 19.99 exactly, and this is the last place to accept that.',
                      example: '499.0000',
                    },
                    reason: { type: 'string', maxLength: 500, example: 'Damaged on arrival' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'The refund attempt and the payment’s new refund position.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['refund', 'refundBalance'],
                    properties: {
                      refund: { $ref: '#/components/schemas/Refund' },
                      refundBalance: { $ref: '#/components/schemas/RefundBalance' },
                    },
                  },
                },
              },
            },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('No such order in this store, or it has no payment.', 'NOT_FOUND'),
            '422': errorResponse(
              'The payment never succeeded, the amount is not positive, or it exceeds the remaining refundable balance — `details.remaining` says what is left.',
              'REFUND_EXCEEDS_BALANCE',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/api/v1/admin/refunds/{refundNumber}/settle': {
        post: {
          tags: ['Payments'],
          summary: 'Record that a manual refund was paid out (staff)',
          security: [{ bearerAuth: [] }],
          description: [
            'The minimum this backend can honestly say about money it did not move: a named',
            'staff member asserts the offline disbursement happened, and the assertion is',
            'attributed and timestamped.',
            '',
            '**No bank, UPI or payout integration is implied — there is none in this system.**',
            'This records a fact about the world; it does not transfer anything.',
            '',
            'A `provider` refund is a `409`. Its outcome is the gateway’s to report, and letting',
            'staff declare one succeeded would make the `processing` state — the entire point of',
            'the three-way provider outcome — pointless.',
          ].join('\n'),
          parameters: [
            {
              name: 'refundNumber',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 64, pattern: REFUND_NUMBER_PATTERN },
              example: 'RFD-20260917-K7M2QP',
            },
          ],
          responses: {
            '200': {
              description: 'The settled refund.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['refund'],
                    properties: { refund: { $ref: '#/components/schemas/Refund' } },
                  },
                },
              },
            },
            '401': errorResponse('No or invalid access token.', 'AUTHENTICATION_REQUIRED'),
            '403': errorResponse('The caller is not staff.', 'PERMISSION_DENIED'),
            '404': errorResponse('Unknown, or another store’s.', 'NOT_FOUND'),
            '409': errorResponse(
              'The refund is a provider refund, or it is not `pending`.',
              'REFUND_NOT_SETTLEABLE',
            ),
            ...COMMON_ERRORS,
          },
        },
      },

      '/health/live': {
        get: {
          tags: ['Health'],
          summary: 'Liveness probe',
          description:
            'Touches no dependency. A failure here means the process is wedged and should be restarted — it never reflects database or Redis state.',
          responses: {
            '200': {
              description: 'The process is serving.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', example: 'ok' } },
                  },
                },
              },
            },
          },
        },
      },

      '/health/ready': {
        get: {
          tags: ['Health'],
          summary: 'Readiness probe',
          description:
            'Checks required dependencies. A failure means remove this instance from the load balancer — not restart it.',
          responses: {
            '200': {
              description: 'Every required dependency is reachable.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok'] },
                      checks: {
                        type: 'object',
                        additionalProperties: { type: 'string', enum: ['ok', 'degraded'] },
                        example: { postgres: 'ok' },
                      },
                    },
                  },
                },
              },
            },
            '503': {
              description: 'A required dependency is unavailable.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['unavailable'] },
                      checks: { type: 'object', additionalProperties: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * Serve Swagger UI at `/docs` and the raw document at `/docs.json`.
 *
 * `/docs.json` matters more than the UI: it is what a client generator, a contract test, or
 * Postman consumes. The UI is for humans.
 */
export function createDocsRouter(deps: { config: Config }): Router {
  const router = Router();
  const spec = buildOpenApiSpec(deps.config);

  // Served before the UI so a generator never has to scrape HTML.
  router.get('/docs.json', (_req, res) => {
    res.json(spec);
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      // Alphabetical rather than declaration order, so the list stays stable as paths are
      // added and a reader can find an endpoint without scanning.
      swaggerOptions: { docExpansion: 'list', operationsSorter: 'alpha', tagsSorter: 'alpha' },
      customSiteTitle: 'E-commerce Backend API',
    }),
  );

  return router;
}
