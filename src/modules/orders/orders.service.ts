import { randomInt } from 'node:crypto';

import type { Database } from '../../db/client.js';
import { withTransaction } from '../../db/transaction.js';
import type { AuditActor, AuditTrail } from '../../shared/audit.js';
import { BusinessRuleViolation, Conflict, NotFound } from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import {
  allocate,
  fromDb,
  isCurrency,
  multiply,
  subtract,
  sum,
  toDb,
  zero,
  type Currency,
} from '../../shared/money.js';
import { ORDER_AUDIT, ORDER_RESOURCE } from './orders.events.js';
import {
  CANCELLABLE_ORDER_STATUSES,
  CANCELLED_ORDER_STATUS,
  type OrderLineRecord,
  type OrderRecord,
  type OrdersRepository,
} from './orders.repository.js';

/**
 * Checkout, and reading the orders it produced.
 *
 * ## What this does NOT do
 *
 * No payment: no gateway call, no authorisation, no capture, no webhook, no COD. No shipping: no
 * rate, no carrier, no shipment, no tracking. No tax: no rate, no HSN/SAC, no CGST/SGST/IGST, no
 * place of supply, no GSTIN. No invoice number. No return or refund. Each belongs to its own
 * increment and each would encode a business rule this one has not been given.
 *
 * **No inventory interaction of any kind.** §39 defers *"reservations and allocation (the
 * increment that will need `FOR UPDATE`, and the one that first writes `reserved`)"*, so placing
 * an order checks no stock, reserves nothing, decrements nothing and writes no ledger row. The
 * consequence is stated rather than hidden: an order can be placed for stock that is not there,
 * and the allocation increment is what will make that impossible.
 *
 * **No promotion redemption.** §42 defers usage recording, and there are no limit columns to
 * enforce. Ordering with a coupon consumes nothing.
 *
 * ## No `EventBus`
 *
 * Not in these dependencies. The handler registry is empty, so nothing consumes `order.placed`,
 * and §39's rule — an event with no consumer is a guess at one — has held for four increments.
 * An order is the most event-worthy thing in this domain, which is exactly why it must not get a
 * speculative one; see `orders.events.ts`.
 */

export type OrdersService = ReturnType<typeof createOrdersService>;

/* ── Ports ───────────────────────────────────────────────────────────────── */

/** One cart line as checkout needs it. Structurally the cart module's `CartCheckoutLine`. */
export type CheckoutCartLine = {
  readonly skuId: string;
  readonly skuCode: string;
  readonly skuName: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly isPurchasable: boolean;
};

/**
 * **The cart, as orders needs it — declared HERE, implemented by the cart module.**
 *
 * `no-cross-module-imports` forbids `modules/orders` from importing `modules/cart` and forbids
 * the reverse just as firmly. So the CONSUMER declares the port and `container.ts` adapts the
 * cart service onto it — the same pattern `http/` uses for `AccessTokenVerifier` and the cart
 * uses for `CartPromotions`. Structurally typed, so neither module names the other.
 *
 * Both operations must be called INSIDE the caller's transaction: `lockCartForCheckout` takes a
 * row lock, and a row lock lives only as long as the transaction that took it. The cart service
 * asserts that itself rather than trusting a caller to remember.
 *
 * The cart deliberately owns everything in here — how the active cart is found, what a line is,
 * and the purchasability predicate — so orders cannot grow a second, drifting copy of any of it.
 */
export type CheckoutCart = {
  lockCartForCheckout(input: { userId: string; storeId: string }): Promise<
    | {
        readonly cart: { readonly id: string };
        readonly lines: readonly CheckoutCartLine[];
        readonly promotionId?: string;
      }
    | undefined
  >;
  markCheckedOut(input: { cartId: string; storeId: string }): Promise<boolean>;
};

/** A promotion priced for one subtotal. Structurally the promotions module's own result. */
export type CheckoutPromotion = {
  readonly promotionId: string;
  readonly code: string;
  readonly name: string;
  readonly discountTotal: string;
};

/**
 * **Promotion pricing, as orders needs it.**
 *
 * One operation: re-price the promotion the cart already has applied. `undefined` means it no
 * longer discounts anything — deactivated, deleted, expired, not yet started, or the subtotal
 * has fallen below its minimum. Checkout then proceeds with no discount rather than failing,
 * because a coupon that lapsed while the customer was choosing an address is not a reason to
 * refuse their order.
 *
 * There is deliberately no way to resolve a code, list promotions, or record a redemption. The
 * only promotion decision orders can make is "what is the applied one worth right now".
 */
export type CheckoutPromotions = {
  evaluateApplied(input: {
    storeId: string;
    promotionId: string;
    subtotal: string;
    storeCurrency: string;
    at: Date;
  }): Promise<CheckoutPromotion | undefined>;
};

/**
 * Completing the idempotency claim, from inside the checkout transaction.
 *
 * §36 prescribes exactly this: *"a handler with strict requirements — checkout — should call
 * `complete()` **inside its own transaction**, which closes the window entirely."* Without it
 * there is a moment between the business commit and the completion write in which a crash
 * leaves the key `in_progress`, and after expiry a retry would place a second order.
 *
 * Declared as a port so the service does not import the HTTP middleware or the store directly.
 */
export type CheckoutIdempotency = {
  complete(input: {
    storeId: string;
    userId: string;
    key: string;
    endpoint: string;
    status: number;
    body?: unknown;
  }): Promise<void>;
};

/**
 * What this module needs to know about an order's payment, and nothing more.
 *
 * Declared HERE because orders is the consumer; the payments module never imports it, and
 * `container.ts` adapts one onto the other. `no-cross-module-imports` is satisfied by
 * construction rather than by an exception.
 *
 * Deliberately a STATUS rather than a payment. Cancellation needs to answer one question — has
 * money moved, or might it be moving — and handing this module a whole payment would let it
 * start reasoning about amounts and providers, which are not its business.
 *
 * `null` means no payment exists. That is a different answer from any status, and the
 * cancellation rule treats it differently, so it must not be collapsed into one.
 */
export type OrderPayments = {
  statusForOrder(params: { orderId: string; storeId: string }): Promise<string | null>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The order cannot be cancelled. A `409`: a conflict with existing state.
 *
 * Carries a machine-readable `reason` in `details` so a client can tell the two cases apart
 * without parsing prose — one is "wait and try again", the other is "contact support".
 */
export class OrderNotCancellable extends Conflict {
  override readonly code = 'ORDER_NOT_CANCELLABLE';
  constructor(reason: string, message: string) {
    super(message, { reason });
  }
}

/** Nothing to order. A `422`: well-formed request, business rules say no. */
export class CheckoutCartEmpty extends BusinessRuleViolation {
  override readonly code = 'CHECKOUT_CART_EMPTY';

  constructor() {
    super('There is nothing in your cart to check out.');
  }
}

/**
 * At least one line can no longer be bought, so the WHOLE checkout is refused.
 *
 * The offending SKU codes are named, deliberately: a customer must be told which item is the
 * problem. Silently dropping the line would sell them less than they asked for, and creating a
 * partial order would be worse — Increment 28 already refused to discard basket contents on a
 * merchant's edit, and this is the same judgement at the moment it matters most.
 *
 * Nothing is written: no order, no line, no cart transition, and the idempotency key is released
 * rather than completed, so the customer can fix their cart and retry with the same key.
 */
export class CheckoutLinesUnavailable extends BusinessRuleViolation {
  override readonly code = 'CHECKOUT_LINES_UNAVAILABLE';

  constructor(skuCodes: readonly string[]) {
    super(
      'Some items in your cart are no longer available. Remove them and try again.',
      // Codes only. A SKU code is the merchant's own public identifier, not customer data.
      { skuCodes: [...skuCodes] },
    );
  }
}

/**
 * The cart was checked out by another request, or there is no active cart to check out.
 *
 * A `409`: the request was valid and lost a race. Raised when the cart-row lock finds no active
 * cart, and again if the status transition matches nothing — the second and third of the three
 * defences behind `uq_order_cart`.
 */
export class CheckoutCartNotAvailable extends Conflict {
  override readonly code = 'CHECKOUT_CART_NOT_AVAILABLE';

  constructor() {
    super('This cart is no longer available for checkout. It may already have been ordered.');
  }
}

/* ── Views ───────────────────────────────────────────────────────────────── */

/** An order and its lines, exactly as they were snapshotted. */
export type OrderView = {
  readonly order: OrderRecord;
  readonly lines: readonly OrderLineRecord[];
};

/**
 * The order number: `ORD-YYYYMMDD-XXXXXX`.
 *
 * The date part is UTC, matching every other instant in this system — a local date would need a
 * timezone decision that §42 explicitly declined to make for promotion windows, and an order
 * number is not the place to introduce one.
 *
 * The suffix is six characters from a 32-symbol alphabet, drawn with `randomInt` (a CSPRNG), so
 * there are ~1.07 billion suffixes per day per store. **Deliberately not a sequence**: a serial
 * in a customer-visible identifier leaks the store's order count, which is the same reason
 * `_shared.ts` chose UUIDv7 over `BIGSERIAL` for primary keys.
 *
 * `I`, `O`, `0` and `1` are excluded so a number read aloud or typed from a printed invoice
 * cannot be transcribed into a different one.
 *
 * Collisions are handled by the caller retrying against `uq_order_number`, not by hoping: at
 * ~1e9 suffixes a same-day collision needs a birthday-paradox coincidence, and the constraint is
 * what makes the outcome correct rather than merely unlikely.
 */
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER_NUMBER_SUFFIX_LENGTH = 6;

export function generateOrderNumber(at: Date): string {
  const datePart = at.toISOString().slice(0, 10).replaceAll('-', '');
  let suffix = '';
  for (let i = 0; i < ORDER_NUMBER_SUFFIX_LENGTH; i += 1) {
    suffix += ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
  }
  return `ORD-${datePart}-${suffix}`;
}

/** How many times a colliding order number is re-drawn before failing loudly. */
const ORDER_NUMBER_ATTEMPTS = 5;

export function createOrdersService(deps: {
  repository: OrdersRepository;
  cart: CheckoutCart;
  promotions: CheckoutPromotions;
  idempotency: CheckoutIdempotency;
  payments: OrderPayments;
  db: Database;
  audit: AuditTrail;
  logger: Logger;
}) {
  const { repository, cart, promotions, idempotency, payments, db, audit, logger } = deps;

  /**
   * A store configured with a currency this build does not know is an OPERATOR error, so it
   * surfaces as a 500 — the same judgement the cart, catalogue and promotions services make.
   */
  function requireCurrency(storeId: string, value: string): Currency {
    if (!isCurrency(value)) {
      throw new Error(`store ${storeId} has an unsupported currency: ${value}`);
    }
    return value;
  }

  return {
    /**
     * **Turn the customer's active cart into an order.**
     *
     * One transaction, and it contains the authoritative operation end to end: the cart lock,
     * every read the order is built from, the snapshot, the money, the cart transition, the
     * order, its lines, its first history row, the audit entry and the idempotency completion.
     * The HTTP response happens after the commit.
     *
     * ## What it prevents, and how
     *
     *  - **Duplicate orders** — three defences: `SELECT … FOR UPDATE` on the cart row serialises
     *    concurrent checkouts; the `status = 'active'` predicate in the transition makes the
     *    loser learn it lost from a row count rather than a constraint; and `uq_order_cart` is
     *    the backstop if both were ever removed. Measured: eight concurrent checkouts produced
     *    one order and seven clean refusals.
     *  - **Partially created orders** — one transaction.
     *  - **A cart checked out with no order, or an order whose cart is still active** — the
     *    transition and the insert commit together.
     *  - **Inconsistent totals** — every figure comes from one transactional read, and the
     *    header discount is the SUM of what was actually allocated rather than an independent
     *    calculation that could disagree with allocation rounding.
     *  - **A mutation rewriting the cart afterwards** — every cart write takes the same row
     *    lock and refuses a `checked_out` cart. Measured: without contending on the row, a
     *    coupon swap mid-checkout left the order priced from the old coupon while the cart named
     *    the new one.
     *
     * ## Client values are not consulted anywhere
     *
     * The request carries `addressId` and nothing else. The cart is found from the verified
     * token, prices are re-read from `sku`, purchasability is re-evaluated, the promotion is
     * re-priced, and every total is computed here. `cart.subtotal`, `cart.discountTotal` and
     * `cart.cartTotal` are advisory display values and are never read by this method.
     */
    async checkout(params: {
      userId: string;
      storeId: string;
      storeCurrency: string;
      addressId: string;
      /** The claim this request already holds, completed inside the transaction below. */
      idempotency: { key: string; endpoint: string };
      actor: AuditActor;
      /** Serialises the created order for the idempotency replay body. */
      renderResponse: (view: OrderView) => unknown;
    }): Promise<OrderView> {
      const currency = requireCurrency(params.storeId, params.storeCurrency);
      const at = new Date();

      return withTransaction(db, logger, async () => {
        /* 1. Lock the cart. Everything below reads a consistent snapshot behind this. */
        const locked = await cart.lockCartForCheckout({
          userId: params.userId,
          storeId: params.storeId,
        });
        if (!locked) {
          logger.info(
            { storeId: params.storeId, userId: params.userId },
            'checkout_rejected_no_active_cart',
          );
          throw new CheckoutCartNotAvailable();
        }

        /* 2–4. The lines, with current prices and purchasability re-evaluated by the cart. */
        if (locked.lines.length === 0) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, cartId: locked.cart.id },
            'checkout_rejected_empty_cart',
          );
          throw new CheckoutCartEmpty();
        }

        /* 5. Any unpurchasable line refuses the WHOLE checkout, naming the codes. */
        const unavailable = locked.lines.filter((line) => !line.isPurchasable);
        if (unavailable.length > 0) {
          logger.info(
            {
              storeId: params.storeId,
              userId: params.userId,
              cartId: locked.cart.id,
              unavailable: unavailable.length,
            },
            'checkout_rejected_unpurchasable_lines',
          );
          throw new CheckoutLinesUnavailable(unavailable.map((line) => line.skuCode));
        }

        /* 6. The address, inside the same transaction so a later edit cannot change it. */
        const owned = await repository.findOwnedAddress({
          addressId: params.addressId,
          userId: params.userId,
          storeId: params.storeId,
        });
        if (!owned) {
          logger.info(
            { storeId: params.storeId, userId: params.userId },
            'checkout_rejected_address_not_found',
          );
          throw new NotFound('address');
        }

        /* 9. Line money, then the subtotal. All of it through `shared/money.ts`. */
        const priced = locked.lines.map((line) => {
          const unit = fromDb(line.unitPrice, currency);
          return {
            line,
            unitPrice: toDb(unit),
            lineTotal: toDb(multiply(unit, line.quantity)),
          };
        });
        const subtotal = toDb(
          sum(
            priced.map((p) => fromDb(p.lineTotal, currency)),
            currency,
          ),
        );

        /* 8 + 10. Re-price the applied promotion. A lapsed one simply does not discount. */
        const promotion =
          locked.promotionId === undefined
            ? undefined
            : await promotions.evaluateApplied({
                storeId: params.storeId,
                promotionId: locked.promotionId,
                subtotal,
                storeCurrency: params.storeCurrency,
                at,
              });

        /**
         * 11–12. Allocate the discount across the lines, then derive the header from the
         * allocation.
         *
         * **The header discount is the SUM OF THE ALLOCATED PARTS**, never an independent
         * calculation. `allocate()` distributes at the currency's minor-unit scale using the
         * largest-remainder method, so its parts can differ from a 4-decimal figure by up to
         * half a paisa — and an invoice whose lines do not foot to its header is exactly what
         * §42 introduced `allocate()` to prevent. Deriving the header from the parts makes the
         * two impossible to disagree.
         *
         * Weighted by `line_total`, so a bigger line absorbs a bigger share.
         */
        const allocated =
          promotion === undefined
            ? priced.map(() => toDb(zero(currency)))
            : allocate(
                fromDb(promotion.discountTotal, currency),
                priced.map((p) => p.lineTotal),
              ).map(toDb);

        const discountTotal = toDb(
          sum(
            allocated.map((a) => fromDb(a, currency)),
            currency,
          ),
        );

        /* 13. The payable goods total, before any future tax. */
        const total = toDb(subtract(fromDb(subtotal, currency), fromDb(discountTotal, currency)));

        /* 14. Transition the cart. Zero rows means another request won the race. */
        const moved = await cart.markCheckedOut({
          cartId: locked.cart.id,
          storeId: params.storeId,
        });
        if (!moved) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, cartId: locked.cart.id },
            'checkout_rejected_cart_transition_lost',
          );
          throw new CheckoutCartNotAvailable();
        }

        /* 15. The order header, retrying only a colliding order number. */
        const orderId = newId();
        const header = await insertWithFreshOrderNumber({
          /**
           * Each attempt runs in a NESTED transaction, which Drizzle implements as a SAVEPOINT.
           *
           * Without one a colliding order number would poison the whole checkout transaction:
           * measured against this PostgreSQL, a caught 23505 with no savepoint leaves every
           * later statement failing with 25P02, while the same sequence inside a savepoint
           * continues normally. So the retry is only safe because the failed attempt can be
           * rolled back to a point the outer transaction still owns.
           */
          attempt: async (orderNumber) =>
            withTransaction(db, logger, async () =>
              repository.insertOrder({
                id: orderId,
                storeId: params.storeId,
                userId: params.userId,
                cartId: locked.cart.id,
                orderNumber,
                status: 'placed',
                currency,
                subtotal,
                discountTotal,
                total,
                promotionId: promotion?.promotionId ?? null,
                promotionCode: promotion?.code ?? null,
                promotionName: promotion?.name ?? null,
                addressId: owned.id,
                shipRecipientName: owned.recipientName,
                shipPhone: owned.phone,
                shipLine1: owned.line1,
                shipLine2: owned.line2,
                shipLandmark: owned.landmark,
                shipCity: owned.city,
                shipState: owned.state,
                shipPostalCode: owned.postalCode,
                shipCountryCode: owned.countryCode,
                placedAt: at,
              }),
            ),
          at,
          logger,
        });

        /* 16. The lines, every display value copied. */
        await repository.insertOrderLines(
          priced.map((p, index) => ({
            orderId,
            skuId: p.line.skuId,
            storeId: params.storeId,
            skuCode: p.line.skuCode,
            skuName: p.line.skuName,
            productName: p.line.productName,
            quantity: p.line.quantity,
            unitPrice: p.unitPrice,
            lineTotal: p.lineTotal,
            discountAmount: allocated[index] ?? toDb(zero(currency)),
          })),
        );

        /* 17. The first history row: created IN this state, so `from_status` is NULL. */
        await repository.insertStatusHistory({
          id: newId(),
          orderId,
          storeId: params.storeId,
          fromStatus: null,
          toStatus: 'placed',
          actorType: params.actor.type,
          actorUserId: 'userId' in params.actor ? params.actor.userId : null,
        });

        const lines = await repository.listOrderLines({
          orderId,
          storeId: params.storeId,
        });
        const view: OrderView = { order: header, lines };

        /**
         * 18. Audit.
         *
         * Identifiers and counts only. **No address values** — §40's rule, because `audit_log`
         * is *"read by more people than the database, and frequently shipped to a log aggregator
         * with different access controls"*. No totals either: they are on the order row, so
         * copying them into the trail adds nothing and widens what leaks if the trail does.
         */
        await audit.record({
          action: ORDER_AUDIT.placed,
          actor: params.actor,
          resourceType: ORDER_RESOURCE,
          resourceId: orderId,
          storeId: params.storeId,
          metadata: {
            orderNumber: header.orderNumber,
            cartId: locked.cart.id,
            lineCount: lines.length,
          },
        });

        /**
         * 19. Complete the idempotency claim INSIDE this transaction — §36's prescription.
         *
         * The claim and the order now commit together, which closes the window in which a crash
         * between them would leave the key `in_progress` and let a post-expiry retry place a
         * second order. The middleware finds the key already completed and skips its own write.
         */
        await idempotency.complete({
          storeId: params.storeId,
          userId: params.userId,
          key: params.idempotency.key,
          endpoint: params.idempotency.endpoint,
          status: 201,
          body: params.renderResponse(view),
        });

        logger.info(
          {
            storeId: params.storeId,
            userId: params.userId,
            orderId,
            orderNumber: header.orderNumber,
            cartId: locked.cart.id,
          },
          'order_placed',
        );

        return view;
      });
    },

    /**
     * Cancel one of this customer's orders.
     *
     * ## The rule, and why it is this rule
     *
     * Refunds are out of scope, so nothing here may create money the system cannot return.
     * That fixes the eligibility test to the payment's state:
     *
     * | Payment state        | Cancel? | Why |
     * | -------------------- | ------- | --- |
     * | none                 | yes     | nobody has been asked for money |
     * | `failed`, `expired`  | yes     | terminal and unpaid; no money moved |
     * | `pending`            | **no**  | an online capture may land at any moment |
     * | `succeeded`          | **no**  | money was taken; releasing it needs a refund |
     *
     * `pending` is the interesting one. It is refused rather than allowed because a pending
     * gateway payment is a race with real money: the customer's browser may be mid-checkout,
     * and a capture arriving a second after we cancelled would leave a cancelled order that
     * had been paid — the exact state the refund exclusion makes unfixable. The customer's
     * route out is to let the payment fail or expire, and then cancel.
     *
     * ## Concurrency
     *
     * The order row is locked FOR UPDATE first, so two concurrent cancellations serialise, and
     * the payment status is read INSIDE that lock — reading it before would let a payment be
     * created between the read and the write. The `status = 'placed'` predicate on the update
     * is the second defence, and it is what makes the loser of a race learn from a row count
     * rather than by overwriting the winner.
     *
     * A payment created concurrently with a cancellation is the mirror hazard, and it is
     * covered on the other side: payment initiation refuses an order whose status is not
     * `placed`, and it reads that status inside its own transaction.
     */
    async cancelOrder(params: {
      userId: string;
      storeId: string;
      orderNumber: string;
      actor: AuditActor;
    }): Promise<OrderView> {
      return withTransaction(db, logger, async () => {
        const header = await repository.lockOwnedOrderByNumber({
          orderNumber: params.orderNumber,
          userId: params.userId,
          storeId: params.storeId,
        });
        if (!header) throw new NotFound('order');

        if (!CANCELLABLE_ORDER_STATUSES.includes(header.status as 'placed')) {
          /*
           * Already cancelled, or in some future status that forbids it. Idempotency is
           * deliberately NOT offered here: a second cancellation is a conflict rather than a
           * no-op, because a client that gets `204` twice cannot tell whether it cancelled
           * something or nothing.
           */
          logger.info(
            { storeId: params.storeId, orderNumber: params.orderNumber, status: header.status },
            'order_cancel_rejected_status',
          );
          throw new OrderNotCancellable(
            'status',
            `An order with status ${header.status} cannot be cancelled.`,
          );
        }

        const paymentStatus = await payments.statusForOrder({
          orderId: header.id,
          storeId: params.storeId,
        });

        if (paymentStatus === 'succeeded') {
          logger.info(
            { storeId: params.storeId, orderNumber: params.orderNumber },
            'order_cancel_rejected_paid',
          );
          throw new OrderNotCancellable(
            'paid',
            'This order has been paid for and cannot be cancelled. Refunds are not supported yet.',
          );
        }

        if (paymentStatus === 'pending') {
          logger.info(
            { storeId: params.storeId, orderNumber: params.orderNumber },
            'order_cancel_rejected_payment_in_progress',
          );
          throw new OrderNotCancellable(
            'payment_in_progress',
            'A payment for this order is still in progress. Cancel once it has failed or expired.',
          );
        }

        const at = new Date();

        const moved = await repository.updateOrderStatus({
          orderId: header.id,
          storeId: params.storeId,
          fromStatus: header.status,
          toStatus: CANCELLED_ORDER_STATUS,
          at,
        });

        if (!moved) {
          /*
           * The row changed under the lock, which in practice means a concurrent cancellation
           * committed first. Throwing rolls this transaction back, so no history row or audit
           * entry records a transition that did not happen.
           */
          logger.info(
            { storeId: params.storeId, orderNumber: params.orderNumber },
            'order_cancel_lost_race',
          );
          throw new OrderNotCancellable('status', 'This order was already cancelled.');
        }

        /** Append-only, exactly as checkout writes the creation row. §3 #8. */
        await repository.insertStatusHistory({
          id: newId(),
          orderId: header.id,
          storeId: params.storeId,
          fromStatus: header.status,
          toStatus: CANCELLED_ORDER_STATUS,
          actorType: params.actor.type,
          actorUserId: 'userId' in params.actor ? params.actor.userId : null,
        });

        await audit.record({
          storeId: params.storeId,
          actor: params.actor,
          action: ORDER_AUDIT.cancelled,
          resourceType: ORDER_RESOURCE,
          resourceId: header.id,
          metadata: {
            orderNumber: header.orderNumber,
            from: header.status,
            to: CANCELLED_ORDER_STATUS,
            /* Recorded so an investigation can see the order was genuinely unpaid. */
            paymentStatus: paymentStatus ?? 'none',
          },
        });

        logger.info(
          {
            storeId: params.storeId,
            userId: params.userId,
            orderId: header.id,
            orderNumber: header.orderNumber,
          },
          'order_cancelled',
        );

        const lines = await repository.listOrderLines({
          orderId: header.id,
          storeId: params.storeId,
        });
        return { order: { ...header, status: CANCELLED_ORDER_STATUS }, lines };
      });
    },

    /** One of this customer's orders, or a `404` that reveals nothing. */
    async getOrder(params: {
      userId: string;
      storeId: string;
      orderNumber: string;
    }): Promise<OrderView> {
      const header = await repository.findOwnedOrderByNumber(params);
      if (!header) throw new NotFound('order');

      const lines = await repository.listOrderLines({
        orderId: header.id,
        storeId: params.storeId,
      });
      return { order: header, lines };
    },

    /** A page of this customer's orders, newest first, with their lines. */
    async listOrders(params: {
      userId: string;
      storeId: string;
      limit: number;
      offset: number;
    }): Promise<{
      items: readonly OrderView[];
      total: number;
      limit: number;
      offset: number;
    }> {
      const page = await repository.listOrdersForUser(params);

      const lines = await repository.listLinesForOrders({
        orderIds: page.items.map((o) => o.id),
        storeId: params.storeId,
      });

      const byOrder = new Map<string, OrderLineRecord[]>();
      for (const line of lines) {
        const bucket = byOrder.get(line.orderId);
        if (bucket) bucket.push(line);
        else byOrder.set(line.orderId, [line]);
      }

      return {
        items: page.items.map((header) => ({
          order: header,
          lines: byOrder.get(header.id) ?? [],
        })),
        total: page.total,
        limit: params.limit,
        offset: params.offset,
      };
    },
  };
}

/**
 * Insert the order, re-drawing the order number if it collides.
 *
 * `uq_order_number` is the guarantee; this loop is what turns an astronomically unlikely
 * collision into a retry rather than a `500`. Bounded at five attempts and then rethrown: at
 * ~1.07 billion suffixes per day per store, five consecutive collisions means a broken CSPRNG
 * far more plausibly than bad luck, and an unbounded loop would spin forever against a generator
 * returning a constant — the same judgement §19 records for refresh-token collisions.
 *
 * Discriminated by CONSTRAINT NAME, so an unrelated unique violation — `uq_order_cart`, which is
 * the concurrent-checkout backstop — is rethrown rather than retried under a different number.
 */
async function insertWithFreshOrderNumber(args: {
  attempt: (orderNumber: string) => Promise<OrderRecord>;
  at: Date;
  logger: Logger;
}): Promise<OrderRecord> {
  let lastError: unknown;

  for (let i = 0; i < ORDER_NUMBER_ATTEMPTS; i += 1) {
    const orderNumber = generateOrderNumber(args.at);
    try {
      return await args.attempt(orderNumber);
    } catch (err) {
      if (uniqueViolationConstraint(err) !== 'uq_order_number') throw err;
      lastError = err;
      args.logger.warn({ attempt: i + 1 }, 'order_number_collision_retrying');
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('could not allocate a unique order number');
}

/**
 * The constraint name of a unique violation, or `undefined`.
 *
 * Walks the `cause` chain because Drizzle wraps the driver error in `DrizzleQueryError`: SQLSTATE
 * and the constraint name live on `cause`, and a top-level-only check is the trap §19 records —
 * it made a pre-check path return the right status while the RACE path returned 500, invisible
 * to every sequential test.
 */
function uniqueViolationConstraint(err: unknown): string | undefined {
  let current: unknown = err;

  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && typeof candidate.constraint === 'string') {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return undefined;
}
