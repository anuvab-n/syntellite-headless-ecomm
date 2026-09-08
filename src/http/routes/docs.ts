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
        "This line's allocated share of the order's cart-level discount, distributed by the largest-remainder method so the parts sum exactly to discountTotal. So a line's net value is (lineTotal - discountAmount), which is the figure a future tax calculation needs and can derive without re-allocating anything.",
      example: '299.8000',
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
        '**subtotal minus discountTotal: the payable GOODS total, before any tax.** This meaning is fixed. When GST arrives it will add taxTotal and grandTotal alongside; it must NOT redefine total. Never a JSON number.',
      example: '2698.2000',
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

/**
 * The 429, documented for the rate-limited auth endpoints only.
 *
 * NOT in `COMMON_ERRORS`, because limits are applied per route. Only the endpoints that run
 * Argon2 carry one today, and promising a 429 on a future catalogue endpoint that has no
 * limiter would be a spec that lies in the other direction.
 *
 * Both signals are documented because both are sent: the header is what an SDK or proxy
 * honours without any client code, the body field is what a UI renders.
 */
const RATE_LIMIT_ERROR = {
  '429': {
    ...errorResponse(
      [
        'Too many attempts. Two independent limits apply: one per client IP counting **every** attempt,',
        'and — on login — one per email address counting **failed** attempts only, which resets on a',
        'successful sign-in. Retry after the interval in `Retry-After` or `details.retryAfterSeconds`.',
        'A 429 does not indicate whether the account exists.',
      ].join(' '),
      'RATE_LIMITED',
    ),
    headers: {
      'Retry-After': {
        description: 'Seconds to wait before retrying (RFC 9110 §10.2.3).',
        schema: { type: 'integer', example: 42 },
      },
      'X-RateLimit-Limit': {
        description: 'Attempts permitted per window for the limit that was hit.',
        schema: { type: 'integer', example: 10 },
      },
      'X-RateLimit-Remaining': {
        description: 'Attempts left in the current window. Sent on successful responses too.',
        schema: { type: 'integer', example: 0 },
      },
    },
  },
} as const;

/** The `{slug}` path parameter, shared by every product endpoint that takes one. */
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

export function buildOpenApiSpec(config: Config): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'E-commerce Backend API',
      version: '1.0.0',
      description: [
        'Headless commerce API.',
        '',
        '**Store scoping.** Every `/api/v1` route resolves a store before the handler runs. The',
        'platform is single-store for now (`DEFAULT_STORE_SLUG`), so no header or parameter is',
        'required — but a user, an email address, and a session all belong to exactly one store.',
        '',
        '**Errors.** Every failure returns the same envelope. Switch on `error.code`, never on',
        '`error.message`, which is prose and may be reworded.',
        '',
        '**Unknown fields are rejected.** Request bodies are strict: sending a field that is not',
        'documented returns `400`, it is not silently ignored.',
      ].join('\n'),
    },
    servers: [
      {
        // Built from config rather than hard-coded, so "Try it out" targets the port this
        // process is actually listening on.
        url: `http://localhost:${String(config.port)}`,
        description: `${config.environment} (this process)`,
      },
    ],
    tags: [
      { name: 'Authentication', description: 'Registration and session establishment.' },
      { name: 'Users', description: 'The authenticated user own account.' },
      {
        name: 'Orders',
        description:
          "Checkout, and the customer's own order history. Orders are immutable records: every product, price and address value is copied at checkout, so later catalogue or address edits never change a past order. There is no staff or admin order surface in this version.",
      },
      {
        name: 'Payments',
        description:
          'Paying for an order. One payment per order, and **payment state is a separate lifecycle from order state** — `order.status` stays `placed` whatever happens to the payment. Two methods: `online` through the configured gateway, and `cod` (cash on delivery), which never touches one. The amount is always exactly `order.total`; a client cannot supply it. There is no staff or admin payment surface in this version, and no refund, retry, reconciliation or settlement surface. Instrument data — card, UPI, bank, token — never reaches this system.',
      },
      {
        name: 'Webhooks',
        description:
          'Provider callbacks. **Not store-scoped and not token-authenticated**: a gateway holds no access token, so authentication is a signature over the exact raw request bytes, and the tenant is derived from the payment the verified provider reference names — never from anything in the request. Endpoints are provider-specific by path, because each provider brings its own signature scheme and event vocabulary.',
      },
      {
        name: 'Promotions',
        description:
          'Coupon-code discounts. Staff configure them under /admin/promotions; a customer applies one to their own cart. There is no customer-facing way to list or discover promotions.',
      },
      {
        name: 'Cart',
        description:
          "The authenticated customer's own shopping cart. No staff or admin surface, and no guest carts.",
      },
      {
        name: 'Addresses',
        description:
          "The authenticated customer's own address book. No staff or admin surface: addresses are personal data and nothing needs them yet.",
      },
      { name: 'Catalogue', description: 'Products. Admin writes require the staff scope.' },
      {
        name: 'Inventory',
        description:
          'Stock levels and the append-only ledger of every change. Staff only; there is no public inventory surface.',
      },
      { name: 'Health', description: 'Liveness and readiness probes. Not store-scoped.' },
    ],
    components: {
      schemas: {
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
        Payment: PAYMENT,
        PaymentEvent: PAYMENT_EVENT,
        PaymentHandoff: PAYMENT_HANDOFF,
        Product: PRODUCT,
        Sku: SKU,
        SkuOption: SKU_OPTION,
        Option: OPTION,
        OptionValue: OPTION_VALUE,
        StockItem: STOCK_ITEM,
        StockAdjustment: STOCK_ADJUSTMENT,
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
            ...RATE_LIMIT_ERROR,
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
            ...RATE_LIMIT_ERROR,
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
            'That makes rate limiting the actual defence, and it is applied on two dimensions: per',
            'IP so the endpoint cannot be swept, and per email so one customer cannot be flooded',
            'with reset mail by somebody who knows their address.',
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
            '429': errorResponse(
              'Too many attempts from this IP, or too many for this address. Retry-After says when to try again.',
              'RATE_LIMITED',
            ),
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
            '429': errorResponse(
              'Too many attempts from this IP. Retry-After says when to try again.',
              'RATE_LIMITED',
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
            ...RATE_LIMIT_ERROR,
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
            '**No stock is read, reserved or decremented**, and no inventory ledger row is',
            'written \u2014 so an order may be placed for stock that is not there until stock',
            'allocation ships. **Checkout itself takes no payment**: it neither charges nor',
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
                'Either the cart is no longer available for checkout (CHECKOUT_CART_NOT_AVAILABLE \u2014 there is no active cart, or a concurrent checkout already took it), or a request with this Idempotency-Key is still in flight (IDEMPOTENCY_CONFLICT). Both are safe to retry.',
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
            'There is no staff or admin equivalent in this version.',
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
          ].join('\n'),
          requestBody: {
            required: true,
            description:
              'Razorpay’s event envelope, delivered as raw bytes. Only `event` and `payload.payment.entity.order_id` are read; everything else is ignored, and no part of the body is persisted.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['event'],
                  properties: {
                    event: {
                      type: 'string',
                      description:
                        'Acted on for `payment.captured` and `payment.failed`. Every other event — refunds, settlements, disputes, subscriptions — is out of scope for this version and acknowledged without change.',
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
                'Received. `applied` means the payment transitioned; `ignored` means it was deliberately not acted on, and `reason` says why (duplicate_event, unsupported_event, unknown_reference, already_terminal, illegal_transition, ambiguous_reference).',
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
            'not a silently defaulted page. There is deliberately no search, filter, sort, or',
            'status parameter yet.',
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
          ],
          responses: {
            '200': {
              description: 'A page of products, newest first.',
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
                  required: ['code', 'price'],
                  additionalProperties: false,
                  properties: {
                    code: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 64,
                      description:
                        'The merchant SKU code. Case-sensitive, unique per store among non-deleted SKUs. Letters, digits, dots, underscores, slashes and hyphens; must start with a letter or digit.',
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
              'A live SKU already uses this code in this store. The code is not echoed back.',
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
            'Updates a SKU’s `name`, `price`, or `isActive`. **Requires the `staff` scope.**',
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
            'There is no `storeId` parameter and no filter: the store comes from request',
            'resolution, and an unknown query parameter is a `400` rather than being silently',
            'ignored and returning a default page.',
            '',
            '`total` counts rows under the identical visibility rules as the page.',
          ].join('\n'),
          parameters: [
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
                        example: { postgres: 'ok', redis: 'ok' },
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
