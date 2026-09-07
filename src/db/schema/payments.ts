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

import {
  currencyColumn,
  moneyColumn,
  primaryId,
  storeIdColumn,
  timestamps,
  tsColumn,
} from './_shared.js';
import { appUser } from './identity.js';
import { order } from './orders.js';
import { store } from './store.js';

/**
 * Payments — what was charged for an order, and every transition it went through.
 *
 * Two tables, and the split mirrors `order` / `order_status_history` exactly: `payment` is the
 * current state, `payment_event` is the append-only history. §3 #8 — _"every transition is a
 * row. No `UPDATE` rewrites the past."_
 *
 * ## Payment state is NOT order state
 *
 * §43 fixed that _"the four state spaces stay separate — `cart.status`, `order.status`, a future
 * payment table, a future shipment table. Folding payment or fulfilment into this column is the
 * shortcut that makes both impossible to model properly later."_ So `order` gains no column
 * here, and the relationship points this way: payment references order, never the reverse.
 *
 * The FK target is `uq_order_id_store`, the composite unique that `order_line` and
 * `order_status_history` already use — tenancy travels with the reference rather than being
 * re-checked in application code.
 *
 * ## Nothing here is ever deleted
 *
 * No `deleted_at` on either table. A payment is a financial record, and §3 #15 —
 * _"anonymise, never delete. Tax law requires invoice retention"_ — governs it for the same
 * reason it governs orders. `softDelete` is deliberately not imported.
 *
 * ## No payment-instrument data, ever
 *
 * There is no column for a card number, a CVV, an expiry, a UPI handle, a bank account or a
 * token standing for any of them, and no column that could carry one as free text. That is not
 * an omission to be filled in later: storing instrument data changes the PCI scope of this
 * system, and the approved scope forbids it outright. What the provider charged is identified
 * by `provider_ref` — an opaque id belonging to the provider — and nothing else about the
 * instrument is persisted.
 *
 * ## What is deliberately absent
 *
 * No refund, settlement, dispute, payout, subscription or reconciliation table, and no
 * authorisation/capture pair: the approved lifecycle is single-step, so a captured-amount
 * column would encode a rule this increment was not given. No `expires_at`, because no expiry
 * window was approved — see `PAYMENT_STATUSES` on why `expired` exists as a state regardless.
 */

/**
 * The payment lifecycle. The approved set, exactly.
 *
 * `pending` is the only non-terminal state; the other three are terminal and, per the approved
 * scope, absorbing — there is no retry in this increment, so nothing leaves them. The
 * transition table itself lives in the payments module, not here: a CHECK can constrain which
 * values a column holds but not which pairs are legal, and splitting that rule across two
 * places would let them disagree.
 *
 * `expired` is in the set and in the transition table because the approved lifecycle names it.
 * **Nothing in this increment writes it.** No expiry window was approved, and the approved
 * scope says to implement only the window the manager set rather than invent a timeout — so
 * there is no sweeper and no `expires_at`. The state and the `pending -> expired` transition
 * are here and tested so that the increment which is given a window adds a caller, not a
 * migration and a new state space.
 */
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Every payment starts here. */
export const INITIAL_PAYMENT_STATUS: PaymentStatus = 'pending';

/**
 * How the customer pays. A BUSINESS method, deliberately not a provider name.
 *
 * `online` means "through whichever gateway this store is configured with" — the column stays
 * correct if a second provider is ever approved, and `provider` below records which one
 * actually handled it. `cod` is cash on delivery: approved, and inside the payment domain
 * rather than pretending to be a gateway payment.
 */
export const PAYMENT_METHODS = ['online', 'cod'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Providers this build can name. One entry, and it is not the same axis as `PAYMENT_METHODS`.
 *
 * A COD payment has no provider, which is why the column is nullable and why the two are not
 * folded into one enum: `('razorpay' | 'cod')` would make "which gateway handled this" and
 * "how did the customer choose to pay" the same question, and they stop being the same the
 * first time a second gateway is added.
 */
export const PAYMENT_PROVIDERS = ['razorpay'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const payment = pgTable(
  'payment',
  {
    id: primaryId(),
    storeId: storeIdColumn(() => store.id),

    /** The order being paid for. Unique — see `uq_payment_order`. */
    orderId: uuid('order_id').notNull(),

    /**
     * The payer.
     *
     * Denormalised from `order.user_id` on purpose: every customer-facing read of a payment is
     * scoped by the authenticated user, and carrying the owner here means that scoping is one
     * predicate on this table rather than a join a caller could forget. The composite FK below
     * is what keeps it honest.
     */
    userId: uuid('user_id').notNull(),

    method: varchar('method', { length: 20 }).notNull(),

    /** NULL for COD. Never NULL for `online`; see `ck_payment_provider_matches_method`. */
    provider: varchar('provider', { length: 32 }),

    /**
     * The provider's own identifier for this payment — for Razorpay, the order id it returns.
     *
     * Opaque to the domain, and the only thing linking our row to the provider's. It is what an
     * inbound event is matched against, which is why it is unique per provider per store: two
     * payments claiming one provider object would make an event ambiguous, and resolving that
     * ambiguity by guessing is how the wrong order gets marked paid.
     */
    providerRef: varchar('provider_ref', { length: 255 }),

    status: varchar('status', { length: 20 }).notNull().default(INITIAL_PAYMENT_STATUS),

    /**
     * The currency, copied from the order.
     *
     * Copied rather than joined for the same reason `order.currency` is copied from the store:
     * a historical record must not restate itself because a parent row changed.
     */
    currency: currencyColumn().notNull(),

    /**
     * The authoritative amount, `NUMERIC(19,4)`, copied from `order.total`.
     *
     * The client never supplies it. `ck_order_total_identity` already makes `order.total` the
     * one defensible figure (`subtotal - discount_total`), so payment copies it rather than
     * recomputing anything.
     */
    amount: moneyColumn('amount').notNull(),

    /**
     * The exact integer handed to the provider, in the currency's minor units.
     *
     * Derivable from `amount` and `currency` — and stored anyway, because it is the number the
     * provider was actually given. Recomputing it later depends on `minorUnitExponent`, and a
     * historical record that changes when a table of exponents is corrected is not a record.
     * `bigint` in `number` mode: `money.ts` caps amounts well inside `Number.MAX_SAFE_INTEGER`
     * even after scaling, and `toMinorUnits` asserts exactly that.
     */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),

    /**
     * Why a payment failed, normalised by the provider adapter.
     *
     * A DOMAIN code, never the provider's raw string: a customer-visible surface must not echo
     * a gateway's vocabulary, and an operator reading these needs a closed set. No free-text
     * counterpart — a provider's description is the most likely place for an unreviewed detail
     * about the instrument to arrive, and nothing needs it to resolve a failure.
     */
    failureCode: varchar('failure_code', { length: 64 }),

    ...timestamps,
  },
  (t) => [
    /**
     * **One payment per order**, the approved model, stated as a constraint.
     *
     * This is the last line of defence behind the existence check in the service and the
     * idempotency key on the endpoint: two concurrent initiations cannot both produce a payment
     * even if both other defences were removed. That ordering is §3's — the constraint is what
     * makes the outcome correct rather than merely unlikely — and it is what the concurrency
     * test proves by removing the other two.
     *
     * Scoped to `order_id` alone rather than `(store_id, order_id)`: an order id is a UUIDv7
     * primary key, globally unique already, and the composite FK below means a payment cannot
     * name an order from another tenant in the first place.
     */
    uniqueIndex('uq_payment_order').on(t.orderId),

    /**
     * FK-target index for `payment_event`.
     *
     * Adds no guarantee of its own — `id` is the primary key — and exists solely because
     * PostgreSQL requires a unique constraint on exactly the referenced columns.
     */
    uniqueIndex('uq_payment_id_store').on(t.id, t.storeId),

    /**
     * The webhook's lookup key, and a uniqueness guarantee.
     *
     * Partial, because `provider_ref` is NULL for every COD payment and those must not collide
     * with each other. Leads with `store_id` because it is the tenant: without it one
     * merchant's provider object could shadow another's.
     */
    uniqueIndex('uq_payment_provider_ref')
      .on(t.storeId, t.provider, t.providerRef)
      .where(sql`${t.providerRef} is not null`),

    /**
     * Ownership AND tenancy in one constraint, matching `fk_order_user_store`: the payer must
     * exist, and their store must be the payment's store. A cross-store payment is
     * unrepresentable rather than merely refused by application code.
     */
    foreignKey({
      columns: [t.userId, t.storeId],
      foreignColumns: [appUser.id, appUser.storeId],
      name: 'fk_payment_user_store',
    }).onDelete('restrict'),

    /**
     * RESTRICT, matching every other order-adjacent FK. Deleting an order must never take its
     * payment with it — that is the same retention rule that keeps the order itself.
     */
    foreignKey({
      columns: [t.orderId, t.storeId],
      foreignColumns: [order.id, order.storeId],
      name: 'fk_payment_order_store',
    }).onDelete('restrict'),

    /** The operator question "what is still pending?", scoped to the tenant. */
    index('ix_payment_store_status').on(t.storeId, t.status),

    check('ck_payment_status', sql`${t.status} in ('pending', 'succeeded', 'failed', 'expired')`),
    check('ck_payment_method', sql`${t.method} in ('online', 'cod')`),
    check('ck_payment_provider', sql`${t.provider} is null or ${t.provider} in ('razorpay')`),

    /**
     * The method and provider columns must agree.
     *
     * An `online` payment with no provider could never be matched to an inbound event, and a
     * `cod` payment carrying a gateway reference would claim a charge that was never made.
     * Stated as an equivalence so both directions are enforced.
     */
    check(
      'ck_payment_provider_matches_method',
      sql`(${t.method} = 'online' AND ${t.provider} IS NOT NULL)
          OR (${t.method} = 'cod' AND ${t.provider} IS NULL AND ${t.providerRef} IS NULL)`,
    ),

    /**
     * Money invariants, in the database because the API is not the only writer.
     *
     * Strictly positive, not merely non-negative: a zero-total order has nothing to pay and the
     * service rejects it before it gets here. A zero-amount payment row would be a charge that
     * cannot be reconciled against anything.
     */
    check('ck_payment_amount_positive', sql`${t.amount} > 0 AND ${t.amountMinor} > 0`),

    /** A failure code on a payment that did not fail has no meaning. */
    check(
      'ck_payment_failure_code_only_when_failed',
      sql`${t.failureCode} IS NULL OR ${t.status} = 'failed'`,
    ),
  ],
);

/**
 * One transition of one payment. **Append-only, and never rewritten.**
 *
 * Two jobs, and they are the same row on purpose:
 *
 *  1. The history. `from_status -> to_status` with an actor, exactly as `order_status_history`
 *     records an order's transitions.
 *  2. **The webhook dedupe ledger.** `provider_event_id` carries the provider's own id for the
 *     notification that caused the transition, and `uq_payment_event_provider` makes a second
 *     delivery of it a unique violation rather than a second transition.
 *
 * Job 2 is why this is not simply an audit row. `idempotency_key` cannot serve a webhook — its
 * `user_id` is `NOT NULL` and a provider carries no authenticated user, which its own comment
 * states while naming the alternative: _"a webhook … has a natural key"_, and _"a constraint
 * needs no header, no storage, and no expiry policy"_. This is that constraint.
 *
 * No `updated_at`, no `deleted_at`: a transition that could be edited is not a history.
 */
export const paymentEvent = pgTable(
  'payment_event',
  {
    id: primaryId(),
    paymentId: uuid('payment_id').notNull(),
    storeId: uuid('store_id').notNull(),

    /** NULL only for the creation row. */
    fromStatus: varchar('from_status', { length: 20 }),
    toStatus: varchar('to_status', { length: 20 }).notNull(),

    /**
     * Who caused the transition. Mirrors `audit_log`'s actor split and
     * `order_status_history`'s columns rather than inventing a third vocabulary — a transition
     * caused by a provider notification must be distinguishable from one a customer caused.
     */
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorUserId: uuid('actor_user_id'),

    /**
     * The provider's identifier for the notification behind this row. NULL for a transition
     * this system caused itself, which is why `uq_payment_event_provider` is partial.
     */
    providerEventId: varchar('provider_event_id', { length: 255 }),

    /**
     * What happened, in the provider's vocabulary for a webhook-driven row and ours otherwise.
     *
     * Kept for traceability: when an operator asks why a payment failed, the provider's event
     * name is the first thing that makes the answer checkable against the provider's dashboard.
     * A name, never a payload — the body itself is not persisted anywhere.
     */
    eventType: varchar('event_type', { length: 128 }).notNull(),

    createdAt: tsColumn('created_at').notNull().defaultNow(),
  },
  (t) => [
    /**
     * CASCADE, matching `fk_order_status_history_order_store`. History belongs to its aggregate
     * and has no meaning without it — and since nothing deletes a payment, this is a definition
     * of ownership rather than a delete path anybody takes.
     */
    foreignKey({
      columns: [t.paymentId, t.storeId],
      foreignColumns: [payment.id, payment.storeId],
      name: 'fk_payment_event_payment_store',
    }).onDelete('cascade'),

    foreignKey({
      columns: [t.actorUserId],
      foreignColumns: [appUser.id],
      name: 'fk_payment_event_actor',
    }).onDelete('set null'),

    /**
     * **The duplicate-webhook guarantee.**
     *
     * Partial, so the NULLs on internally-caused rows do not collide. Leads with `store_id`
     * because it is the tenant. Claiming is an INSERT — the same idiom as
     * `idempotency_key.claim()` and `processed_event` — so a unique violation is what makes a
     * redelivery a no-op, rather than a read-then-write that both deliveries could pass.
     */
    uniqueIndex('uq_payment_event_provider')
      .on(t.storeId, t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),

    /** The transition timeline for one payment, in order. */
    index('ix_payment_event_payment').on(t.paymentId, t.createdAt),

    check(
      'ck_payment_event_to_status',
      sql`${t.toStatus} in ('pending', 'succeeded', 'failed', 'expired')`,
    ),
    check(
      'ck_payment_event_from_status',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} in ('pending', 'succeeded', 'failed', 'expired')`,
    ),
    /** A transition to the state it came from is not a transition. */
    check(
      'ck_payment_event_progresses',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} <> ${t.toStatus}`,
    ),
  ],
);
