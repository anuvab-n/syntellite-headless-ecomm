import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { appUser } from './identity.js';
import { order } from './orders.js';
import { payment } from './payments.js';
import { returnRequest } from './returns.js';
import { store } from './store.js';
import {
  codeColumn,
  currencyColumn,
  moneyColumn,
  primaryId,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';

/**
 * Refunds — money going back, as its own aggregate.
 *
 * ## Why a table rather than columns on `payment` or `return_request`
 *
 * `uq_payment_order` makes a payment unique per order, so a refund cannot be modelled as a
 * second payment. And a column on the return would make "how much was requested" and "how much
 * actually moved" the same field — they diverge the instant a provider refund fails, which is
 * exactly the case the column would need to describe. `returns.ts` predicted this table by
 * name; this is it.
 *
 * ## One row per ATTEMPT, never updated destructively
 *
 * A refund row records an attempt and its outcome. A failed attempt is terminal for that row;
 * retrying means a NEW row. That is what keeps the history append-only in substance as well as
 * in policy: "we tried twice and the first failed" is two rows, not one row that forgot.
 *
 * ## The money
 *
 * `amount` is `NUMERIC(19,4)` like every other monetary column, and `amount_minor` is the exact
 * integer handed to the provider — stored for the same reason `payment.amount_minor` is, so a
 * later correction to a table of currency exponents cannot retroactively change what was sent.
 */

/**
 * The refund lifecycle.
 *
 * ```
 *   pending ──▶ processing ──▶ succeeded
 *      │             │
 *      │             └───────▶ failed
 *      ├────────────────────▶ succeeded   (manual: settled offline by staff)
 *      └────────────────────▶ failed      (refused before dispatch)
 * ```
 *
 * `processing` is the state this increment exists to get right. It means **the provider was
 * asked and the answer is not known** — a timeout, an aborted connection, a response that did
 * not parse. It is neither success nor failure, and recording it as either is the specific way
 * this kind of system loses money:
 *
 *  - calling it `failed` invites a retry that double-refunds a refund that actually went
 *    through;
 *  - calling it `succeeded` closes a return against money that may never have moved.
 *
 * So it is its own state, it is NOT terminal, and it consumes refundable balance (see
 * `BALANCE_CONSUMING_REFUND_STATUSES`) until a human or a reconciliation job resolves it.
 */
export const REFUND_STATUSES = ['pending', 'processing', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Every refund starts here. Named so no caller writes the literal. */
export const INITIAL_REFUND_STATUS = 'pending' satisfies RefundStatus;

/** Nothing further happens from here. */
export const TERMINAL_REFUND_STATUSES = ['succeeded', 'failed'] as const;

/**
 * The statuses that consume refundable balance.
 *
 * **`processing` is in this list, and that is the whole point.** An unresolved attempt may
 * already have moved money at the provider. Excluding it would let an operator who sees a
 * timeout raise a second refund for the same amount, and if the first later reconciles as
 * succeeded the store has refunded twice. Reserving the balance makes the over-refund
 * impossible rather than unlikely; the cost is that an unresolved attempt blocks further
 * refunds until it is resolved, which is the correct direction to fail in.
 *
 * `pending` is here too: a row exists for a fraction of a transaction before dispatch, and
 * a concurrent request must see it.
 */
export const BALANCE_CONSUMING_REFUND_STATUSES = ['pending', 'processing', 'succeeded'] as const;

/**
 * How the money goes back.
 *
 * `provider` is a gateway refund against the original charge. `manual` is everything that
 * happens outside this system — the COD case, where cash was collected at the door and goes
 * back by a route the backend has no visibility of.
 *
 * A column rather than inference from `provider IS NULL`, because the two answer different
 * questions and will diverge: a future offline refund of an ONLINE payment (a chargeback
 * settled by bank transfer) is `manual` with a provider present.
 */
export const REFUND_MODES = ['provider', 'manual'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

/** How many characters the random half of a refund number carries. Matches returns and orders. */
export const REFUND_NUMBER_SUFFIX_LENGTH = 6;

/**
 * The alphabet a refund number's suffix is drawn from.
 *
 * `0`, `1`, `I` and `O` are absent, exactly as in the order and return numbers and for the same
 * reason: a refund number is read aloud to a customer chasing their money.
 */
export const REFUND_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const refund = pgTable(
  'refund',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /**
     * The payment this refund reverses. Restricted, never cascaded.
     *
     * The refundable balance is computed against THIS payment's captured amount, so the link is
     * not decoration — it is the denominator of the only invariant that matters here.
     */
    paymentId: uuid('payment_id').notNull(),

    /**
     * The order, denormalised from the payment.
     *
     * Carried rather than joined because "every refund against this order" is a read the admin
     * screens make directly, and `uq_payment_order` guarantees the two can never disagree.
     */
    orderId: uuid('order_id').notNull(),

    /**
     * The return this refund settles, when it came from one.
     *
     * NULL for a refund raised directly against a payment — a goodwill credit, or a correction
     * — which the Payments screen allows and which has no return behind it.
     */
    returnId: uuid('return_id'),

    /**
     * The public identifier. `RFD-YYYYMMDD-XXXXXX`.
     *
     * Same contract as `order_number` and `return_number`: the UUID is never published, so it
     * never becomes part of the API surface and can never be guessed at.
     */
    refundNumber: codeColumn('refund_number', 32).notNull(),

    mode: varchar('mode', { length: 16 }).notNull(),

    /** The gateway, copied from the payment. NULL for a refund of a COD payment. */
    provider: varchar('provider', { length: 32 }),

    /**
     * The provider's own id for the refund — for Razorpay, `rfnd_…`.
     *
     * A fourth identifier, distinct from all three already in play: `payment.provider_ref` is
     * the provider ORDER (`order_…`), `payment.provider_transaction_id` is the provider CHARGE
     * (`pay_…`), and `payment_event.provider_event_id` is a webhook DELIVERY id. This is the
     * refund object. Conflating any two of them is how a refund gets issued against the wrong
     * charge, so each has its own column and its own comment saying which is which.
     *
     * NULL until the provider answers, NULL forever for a manual refund, and NULL for an
     * attempt that ended `failed` or unresolved.
     */
    providerRefundId: varchar('provider_refund_id', { length: 255 }),

    status: varchar('status', { length: 20 }).notNull().default(INITIAL_REFUND_STATUS),

    /** Copied from the payment, so a refund reads correctly if the store's currency changes. */
    currency: currencyColumn().notNull(),

    amount: moneyColumn('amount').notNull(),

    /**
     * The exact integer sent to the provider, in the currency's minor units.
     *
     * Converted once by `money.ts`'s `toMinorUnits` — the system's single rounding boundary —
     * and stored, never recomputed. Zero for a manual refund, which sends nothing anywhere;
     * see `ck_refund_amount_minor`.
     */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),

    /** The provider's failure code, normalised by the adapter. Never a raw provider body. */
    failureCode: varchar('failure_code', { length: 64 }),

    /**
     * The correlation this attempt was dispatched under.
     *
     * Sent to the provider as its idempotency reference and stored so a reconciliation can ask
     * the provider "what happened to this one" without guessing. Not a client-supplied value —
     * HTTP idempotency is the middleware's job and is keyed separately.
     */
    requestKey: varchar('request_key', { length: 255 }),

    /** The staff member who raised it. NOT NULL: a refund is always somebody's decision. */
    initiatedBy: uuid('initiated_by').notNull(),

    /** When the refund reached a terminal status. See `ck_refund_settled_at`. */
    settledAt: tsColumn('settled_at'),

    ...timestamps,
  },
  (t) => [
    /** The public identifier is unique per store, never globally. */
    uniqueIndex('uq_refund_number').on(t.storeId, t.refundNumber),

    /**
     * **At most one live refund per return.**
     *
     * Partial on `status <> 'failed'`, so a failed attempt frees the slot for a retry while a
     * `pending`, `processing` or `succeeded` one holds it. This is what makes a double
     * completion of the same return structurally impossible rather than merely guarded: two
     * concurrent transactions both reaching the insert, one commits and the other violates
     * this index. The application's own CAS on the return status is the first line; this is the
     * line that does not depend on getting the application right.
     */
    uniqueIndex('uq_refund_return_live')
      .on(t.storeId, t.returnId)
      .where(sql`${t.returnId} is not null and ${t.status} <> 'failed'`),

    /**
     * One row per provider refund object.
     *
     * A duplicate would mean the same provider-side refund had been recorded twice, which makes
     * the refunded total wrong in the one direction nobody notices until reconciliation.
     */
    uniqueIndex('uq_refund_provider_refund_id')
      .on(t.storeId, t.provider, t.providerRefundId)
      .where(sql`${t.providerRefundId} is not null`),

    /** The balance query: every refund against one payment. Also the payment-detail read. */
    index('ix_refund_payment').on(t.storeId, t.paymentId),

    /** "Every refund against this order", for the admin order and payment screens. */
    index('ix_refund_order').on(t.storeId, t.orderId, t.createdAt),

    /**
     * Tenancy is the DATABASE's, not a comparison performed afterwards.
     *
     * Every parent FK is composite on `(child_id, store_id)`, so a refund pointing at another
     * tenant's payment, order or return cannot be written at all — the same device
     * `return_line` and `shipment` use.
     */
    foreignKey({
      columns: [t.paymentId, t.storeId],
      foreignColumns: [payment.id, payment.storeId],
      name: 'fk_refund_payment_store',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_refund_order_store',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.returnId, t.storeId],
      foreignColumns: [returnRequest.id, returnRequest.storeId],
      name: 'fk_refund_return_store',
    }).onDelete('restrict'),

    foreignKey({
      columns: [t.initiatedBy, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_refund_initiator_store',
    }).onDelete('restrict'),

    check('ck_refund_status', sql`${t.status} in ('pending', 'processing', 'succeeded', 'failed')`),

    check('ck_refund_mode', sql`${t.mode} in ('provider', 'manual')`),

    /**
     * A refund moves a positive amount, always.
     *
     * A zero-amount refund is a record of nothing, and a negative one is a payment wearing the
     * wrong table. Both are rejected by the service first; this is the guarantee that binds a
     * seed script and an operator running SQL, neither of which passes through Zod.
     */
    check('ck_refund_amount_positive', sql`${t.amount} > 0`),

    /**
     * Minor units are sent only where there is a provider to send them to.
     *
     * A manual refund carries `0` rather than a converted figure, because nothing was handed to
     * anybody and storing a number that looks like it was would be a lie in a column whose
     * entire purpose is to record what was actually sent.
     */
    check(
      'ck_refund_amount_minor',
      sql`(${t.mode} = 'manual' and ${t.amountMinor} = 0) or (${t.mode} = 'provider' and ${t.amountMinor} > 0)`,
    ),

    /** A provider refund id belongs to a provider refund. */
    check(
      'ck_refund_provider_id_requires_provider',
      sql`${t.providerRefundId} is null or (${t.mode} = 'provider' and ${t.provider} is not null)`,
    ),

    /**
     * Settled exactly when terminal.
     *
     * The same both-directions shape as `ck_return_closed_at` and `ck_shipment_shipped_at`: a
     * terminal row with no settling instant and an open row that claims one are equally
     * rejected by one constraint.
     */
    check(
      'ck_refund_settled_at',
      sql`(${t.status} in ('succeeded', 'failed')) = (${t.settledAt} is not null)`,
    ),

    /**
     * A succeeded PROVIDER refund must name the provider object it succeeded as.
     *
     * Without this, an application bug could mark a refund succeeded with no evidence that
     * anything happened at the gateway — precisely the failure mode the `processing` state
     * exists to prevent, so the database enforces it rather than trusting the service.
     * A manual refund is exempt: there is no provider object to name.
     */
    check(
      'ck_refund_succeeded_evidence',
      sql`${t.status} <> 'succeeded' or ${t.mode} = 'manual' or ${t.providerRefundId} is not null`,
    ),
  ],
);
