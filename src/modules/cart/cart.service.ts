import type { Database } from '../../db/client.js';
import { isInTransaction, withTransaction } from '../../db/transaction.js';
import {
  BusinessRuleViolation,
  Conflict,
  InvariantViolation,
  NotFound,
} from '../../shared/errors.js';
import { newId } from '../../shared/id.js';
import type { Logger } from '../../shared/logger.js';
import {
  fromDb,
  isCurrency,
  multiply,
  subtract,
  sum,
  toDb,
  zero,
  type Currency,
} from '../../shared/money.js';
import type {
  CartCheckoutLine,
  CartLineRecord,
  CartRecord,
  CartRepository,
} from './cart.repository.js';

/**
 * The cart module's write API.
 *
 * A factory taking explicit dependencies, matching every other service in the project. No HTTP
 * types cross this boundary — it takes validated data, an owner and a store, and raises
 * `DomainError` subclasses the terminal middleware maps.
 *
 * ## No `EventBus`, no `AuditTrail`
 *
 * Neither is in these dependencies, deliberately. Nothing consumes a cart change, and Increment
 * 26 established that an event with no consumer is a guess at one. Audit in this codebase
 * records privileged or security-relevant acts — a staff member moving stock, a password change
 * — and a customer adjusting their own basket is neither, while being high-frequency enough
 * that an entry per tweak would bury the entries that matter. **Applying a coupon is a customer
 * act on their own basket and is therefore NOT audited**, while a staff member creating that
 * coupon is — the promotions module writes that entry.
 *
 * ## Transactions
 *
 * Almost every mutation here is a single statement against a single row. `withTransaction` is
 * used in this codebase "only where there is a real consistency boundary" (§21), and there is
 * exactly one: clearing a cart deletes lines AND the applied promotion, and a cart left with a
 * discount and no items is a state no reader should ever see.
 *
 * The composite create-if-absent-then-read is deliberately NOT a transaction, for the reason
 * given in `getOrCreateActiveCart`.
 */

export type CartService = ReturnType<typeof createCartService>;

/* ── The promotions port ─────────────────────────────────────────────────── */

/**
 * A promotion priced against one cart subtotal at one instant.
 *
 * `promotionId` is carried so the cart can store the association; it never reaches a response.
 */
export type AppliedPromotion = {
  readonly promotionId: string;
  readonly code: string;
  readonly name: string;
  /** A `NUMERIC(19,4)` decimal string. Never negative, never more than the subtotal. */
  readonly discountTotal: string;
};

/** Why a code cannot be applied. Mapped to a status code by this service, not by the provider. */
export type CartPromotionRejection =
  | { readonly reason: 'not_found' }
  | { readonly reason: 'minimum_subtotal'; readonly minSubtotal: string };

/**
 * **The cart's view of promotions — declared here, implemented elsewhere.**
 *
 * `dependency-cruiser`'s `no-cross-module-imports` forbids `modules/cart` from importing
 * anything under `modules/promotions`, and forbids the reverse just as firmly. So the CONSUMER
 * declares the port and the composition root adapts the provider onto it, exactly as `http/`
 * declares `AccessTokenVerifier` and identity supplies a compatible function. TypeScript's
 * structural typing means neither module names the other, and the boundary is satisfied by
 * construction rather than by an exception in the rules file.
 *
 * Note what is NOT in this port: no way to list promotions, create one, or ask whether a code
 * exists. The cart can price the coupon a customer typed and re-price the one they already
 * applied. Nothing more, so no promotion rule can leak into this module.
 */
export type CartPromotions = {
  /** Resolve a customer-supplied code and price it, or say why not. */
  findApplicable(input: {
    storeId: string;
    code: string;
    subtotal: string;
    storeCurrency: string;
    at: Date;
  }): Promise<AppliedPromotion | CartPromotionRejection>;

  /**
   * Re-price a promotion the cart already has applied. `undefined` means it no longer
   * discounts anything — deactivated, deleted, expired, not yet started, or the cart has
   * fallen below its minimum.
   */
  evaluateApplied(input: {
    storeId: string;
    promotionId: string;
    subtotal: string;
    storeCurrency: string;
    at: Date;
  }): Promise<AppliedPromotion | undefined>;
};

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The cart is below the promotion's minimum subtotal.
 *
 * A `422`, and the ONE apply failure distinguished from `404`. It leaks nothing worth having:
 * the customer has already proved they know the code, and "spend ₹500 to use this" is the
 * entire point of a minimum. Every other failure — unknown, inactive, deleted, expired, not yet
 * started — is one indistinguishable `404`, so the endpoint cannot be used to discover that a
 * competitor's coupon exists.
 *
 * A subclass rather than `new BusinessRuleViolation(msg, { code })`: `code` is a class property,
 * so passing it in `details` does not set the wire code. That was a real bug found in Increment
 * 25 and it is the reason every distinct code in this codebase has its own class.
 */
export class PromotionMinimumSubtotal extends BusinessRuleViolation {
  override readonly code = 'PROMOTION_MINIMUM_SUBTOTAL';

  constructor(args: { minSubtotal: string; subtotal: string }) {
    super(`This promotion requires a cart subtotal of at least ${args.minSubtotal}.`, args);
  }
}

/**
 * A promotion cannot be applied to an empty cart.
 *
 * A `422`. Refused rather than accepted-and-worth-nothing, because a coupon that "applied" to
 * an empty cart would report a zero discount and a customer would reasonably read that as the
 * coupon being invalid. Nothing is written, so there is no meaningless association row against
 * a zero-subtotal cart to clean up later.
 */
export class PromotionRequiresItems extends BusinessRuleViolation {
  override readonly code = 'PROMOTION_REQUIRES_ITEMS';

  constructor() {
    super('A promotion cannot be applied to an empty cart.');
  }
}

/**
 * The cart has already been checked out, so it can no longer be changed.
 *
 * A `409`: the request was well-formed and would have been valid a moment earlier, which is
 * exactly what Conflict means. Raised instead of letting a write silently land on a
 * `checked_out` cart — that cart is now the historical record behind an order, and rewriting it
 * would rewrite what the customer ordered from.
 *
 * A clean domain error rather than a database error, because a customer whose second tab still
 * shows the old cart deserves a sentence they can act on, not a constraint name.
 */
export class CartAlreadyCheckedOut extends Conflict {
  override readonly code = 'CART_ALREADY_CHECKED_OUT';

  constructor() {
    super('This cart has already been checked out and can no longer be modified.');
  }
}

/* ── The view ────────────────────────────────────────────────────────────── */

/** A cart plus everything a response needs, with the money already computed exactly. */
export type CartView = {
  readonly cart: CartRecord;
  readonly currency: string;
  readonly items: readonly {
    readonly skuCode: string;
    readonly skuName: string;
    readonly quantity: number;
    readonly unitPrice: string;
    readonly lineTotal: string;
    readonly isPurchasable: boolean;
  }[];
  /** The number of LINES, not the sum of quantities. */
  readonly itemCount: number;
  /** The sum of the current line totals, BEFORE any discount. */
  readonly subtotal: string;
  /** The promotion discount, or `0.0000` when none applies. Never exceeds `subtotal`. */
  readonly discountTotal: string;
  /** `subtotal - discountTotal`. The payable total. */
  readonly cartTotal: string;
  /** The applied promotion, or `null`. Absent when it exists but no longer discounts anything. */
  readonly promotion: {
    readonly code: string;
    readonly name: string;
    readonly discountTotal: string;
  } | null;
};

export function createCartService(deps: {
  repository: CartRepository;
  /**
   * Promotion pricing, adapted onto {@link CartPromotions} by the composition root.
   *
   * Injected rather than imported: see the port's own comment. It is also what keeps this
   * module testable without a promotions database — though the integration suite uses the real
   * implementation, because a stub would let a broken port pass.
   */
  promotions: CartPromotions;
  db: Database;
  logger: Logger;
}) {
  const { repository, promotions, db, logger } = deps;

  /**
   * The store's currency, or a loud failure.
   *
   * A store configured with a currency this build does not know is an OPERATOR error, not a
   * client one, so it surfaces as a 500 rather than a 400 — the same judgement
   * `requireCurrency` makes in the catalogue service.
   */
  function requireCurrency(storeId: string, value: string): Currency {
    if (!isCurrency(value)) {
      throw new Error(`store ${storeId} has an unsupported currency: ${value}`);
    }
    return value;
  }

  /**
   * The line items and the subtotal.
   *
   * **All arithmetic goes through `shared/money.ts`.** `unitPrice` is a `NUMERIC(19,4)` decimal
   * STRING, and `local/no-money-arithmetic` forbids touching it with `+` or `*` — for good
   * reason: `'10.0000' * 3` is not multiplication, and `Number('10.0000')` reintroduces the
   * float error the column type exists to avoid. `multiply` and `sum` are exact.
   *
   * There is no stored price anywhere in this: the prices are whatever the SKUs cost right now,
   * so a merchant's price change is visible on the customer's next read and needs no
   * reconciliation. A promotion is layered over those current prices, never baked into them.
   */
  function priceLines(lines: readonly CartLineRecord[], currency: Currency) {
    const items = lines.map((line) => {
      const unit = fromDb(line.unitPrice, currency);

      return {
        skuCode: line.skuCode,
        skuName: line.skuName,
        quantity: line.quantity,
        unitPrice: toDb(unit),
        lineTotal: toDb(multiply(unit, line.quantity)),
        isPurchasable: line.isPurchasable,
      };
    });

    /**
     * Computed from the source values rather than by re-summing `items[].lineTotal`, so the
     * subtotal never depends on a string round-trip.
     *
     * Lines flagged `isPurchasable: false` ARE included. Excluding them would make the total
     * change when a merchant edits a listing, with no action by the customer — and Increment 28
     * already decided such a line stays in the basket and is flagged rather than dropped.
     */
    const subtotal = toDb(
      sum(
        lines.map((line) => multiply(fromDb(line.unitPrice, currency), line.quantity)),
        currency,
      ),
    );

    return { items, subtotal };
  }

  /**
   * Build the whole view: lines, subtotal, promotion, discount, payable total.
   *
   * **The single place cart money is composed.** Every operation in this service returns
   * through here, so there is exactly one subtotal formula and one `cartTotal` formula in the
   * module. A second one anywhere would eventually disagree with this one.
   *
   * The promotion is re-priced on EVERY read, from the association row plus the promotion's
   * current configuration. The row is a declaration of intent, not a stored discount:
   *
   *  - a coupon that expires while a basket sits untouched simply stops applying;
   *  - one that stops applying because an item was removed starts applying again when the item
   *    comes back;
   *  - a merchant's price change moves the discount with it.
   *
   * None of that needs a write, a sweeper, or a second source of truth. It is the same
   * no-snapshot judgement §41 made for prices, applied to the discount computed from them.
   *
   * A read never mutates: an invalid or ineligible promotion leaves its row alone and simply
   * reports `promotion: null` with a zero discount. Deleting it here would make `GET` a write,
   * race concurrent reads of the same cart, and destroy the intent a customer would want back
   * the moment their cart qualifies again.
   */
  async function buildView(args: {
    cart: CartRecord;
    storeId: string;
    storeCurrency: string;
    at: Date;
  }): Promise<CartView> {
    const currency = requireCurrency(args.storeId, args.storeCurrency);

    const lines = await repository.listLines({
      cartId: args.cart.id,
      storeId: args.storeId,
    });
    const { items, subtotal } = priceLines(lines, currency);

    const applied = await repository.findAppliedPromotionId({
      cartId: args.cart.id,
      storeId: args.storeId,
    });

    const priced =
      applied === undefined
        ? undefined
        : await promotions.evaluateApplied({
            storeId: args.storeId,
            promotionId: applied.promotionId,
            subtotal,
            storeCurrency: args.storeCurrency,
            at: args.at,
          });

    const discountTotal = priced?.discountTotal ?? toDb(zero(currency));

    return {
      cart: args.cart,
      currency,
      items,
      /**
       * The number of LINES, not the sum of quantities.
       *
       * Stated explicitly because both readings are plausible and a client will depend on one:
       * this is "how many distinct things are in the basket", which is what a cart badge shows.
       */
      itemCount: items.length,
      subtotal,
      discountTotal,
      /**
       * `subtotal - discountTotal`, and this is where Increment 28's `cartTotal` changed
       * meaning: it was the pre-discount sum and is now the payable total. The rename would
       * have been kinder to existing clients, but `cartTotal` naming anything other than what
       * the customer pays is the field that gets misused.
       *
       * Cannot go negative: a percentage is capped at 100 by `ck_promotion_percent_range` and a
       * fixed amount is capped at the subtotal by the promotions service.
       */
      cartTotal: toDb(subtract(fromDb(subtotal, currency), fromDb(discountTotal, currency))),
      promotion:
        priced === undefined
          ? null
          : { code: priced.code, name: priced.name, discountTotal: priced.discountTotal },
    };
  }

  /**
   * The customer's active cart, created if they have none.
   *
   * ## Why this is two statements and not one
   *
   * The obvious single-statement form — an `INSERT … ON CONFLICT DO NOTHING` with a `UNION ALL
   * SELECT` in one CTE — is WRONG under concurrency, and that was measured rather than
   * reasoned: the losing request's read runs in the snapshot taken at statement start, which is
   * before the winner committed, so it sees no row and returns **nothing at all**.
   *
   * Insert-then-read as separate statements gives the loser a fresh snapshot, and both callers
   * get the winner's cart. Verified with two and with eight concurrent callers: one cart row,
   * and every caller received the same id.
   *
   * It is deliberately NOT wrapped in a transaction. A REPEATABLE READ or serialised
   * transaction would reintroduce the stale-snapshot problem; under autocommit each statement
   * sees the latest committed state, which is exactly what this needs.
   */
  async function getOrCreateActiveCart(params: {
    userId: string;
    storeId: string;
  }): Promise<CartRecord> {
    const existing = await repository.findActiveCart(params);
    if (existing) return existing;

    await repository.insertActiveCartIfAbsent({
      id: newId(),
      userId: params.userId,
      storeId: params.storeId,
    });

    // A second read, in a new snapshot: it finds either our own insert or the winner's.
    const created = await repository.findActiveCart(params);
    if (!created) {
      // Unreachable: the insert either succeeded or conflicted with a row that therefore
      // exists. Stated so a future change to the conflict target fails loudly rather than
      // returning a cart that is not there.
      throw new Error(`active cart for user ${params.userId} vanished during creation`);
    }

    logger.info(
      { storeId: params.storeId, userId: params.userId, cartId: created.id },
      'cart_created',
    );
    return created;
  }

  /** Every operation ends the same way, so no caller can compose totals differently. */
  async function viewOf(params: {
    cart: CartRecord;
    storeId: string;
    storeCurrency: string;
  }): Promise<CartView> {
    return buildView({ ...params, at: new Date() });
  }

  /**
   * Run a MUTATION against the customer's active cart, holding the cart-row lock.
   *
   * Every write path goes through this, and that is the whole Increment 30 concurrency
   * invariant: **the cart row is the serialisation point.** Checkout takes the same lock, so a
   * mutation arriving mid-checkout blocks until the checkout commits and then finds the cart
   * `checked_out` and is refused — rather than writing into a cart that has already become an
   * order.
   *
   * A status predicate alone is NOT enough, and that was measured rather than assumed: with the
   * guard but no lock, a coupon swap that arrived while the cart was still legitimately active
   * passed the guard, and the order was priced from the pre-swap promotion while the cart ended
   * up naming the post-swap one. Contending on the row fixed it, three runs out of three.
   *
   * The lock is taken inside a transaction because a row lock lives only as long as its
   * transaction. It is the ONE row locked — no SKU, promotion, address or stock row — so there
   * is no lock ordering and therefore no deadlock to reason about.
   *
   * `CartAlreadyCheckedOut` rather than a raw database error, because "your cart has already
   * been ordered" is a business outcome a client can act on.
   */
  async function withLockedActiveCart<T>(
    params: { userId: string; storeId: string },
    fn: (activeCart: CartRecord) => Promise<T>,
  ): Promise<T> {
    // Created outside the lock, for the same reason it always was: implicit creation must not
    // hold a lock, and a cart that does not exist yet cannot be locked.
    await getOrCreateActiveCart(params);

    return withTransaction(db, logger, async () => {
      const locked = await repository.lockActiveCart(params);
      if (!locked) {
        logger.info(
          { storeId: params.storeId, userId: params.userId },
          'cart_mutation_rejected_not_active',
        );
        throw new CartAlreadyCheckedOut();
      }
      return fn(locked);
    });
  }

  return {
    /** The customer's cart, creating an empty one if needed. */
    async getCart(params: {
      userId: string;
      storeId: string;
      storeCurrency: string;
    }): Promise<CartView> {
      const active = await getOrCreateActiveCart(params);

      return viewOf({
        cart: active,
        storeId: params.storeId,
        storeCurrency: params.storeCurrency,
      });
    },

    /**
     * Set the quantity of one SKU in the customer's cart.
     *
     * SET, never increment. Repeating the identical request leaves the quantity unchanged, which
     * is what makes a client retry safe without any idempotency infrastructure.
     *
     * A SKU that is unknown, another store's, deleted, inactive, or whose product is deleted or
     * unpublished is one `404` — indistinguishable on purpose, so the response reveals nothing
     * about another merchant's catalogue.
     *
     * **No stock check.** Availability is not consulted and `reserved` is not touched: without
     * reservations a check would be stale the instant it returned, and §39 records that
     * authoritative allocation belongs to the order increment.
     *
     * The applied promotion is untouched, and re-priced against the new subtotal on the way
     * out — so adding an item can bring a cart over a coupon's minimum and the discount appears
     * in the very same response.
     */
    async setItemQuantity(params: {
      userId: string;
      storeId: string;
      storeCurrency: string;
      skuCode: string;
      quantity: number;
    }): Promise<CartView> {
      return withLockedActiveCart(params, async (active) => {
        const purchasable = await repository.findPurchasableSkuByCode({
          storeId: params.storeId,
          code: params.skuCode,
        });
        if (!purchasable) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, skuCode: params.skuCode },
            'cart_item_sku_not_purchasable',
          );
          throw new NotFound('sku');
        }

        await repository.setLineQuantity({
          cartId: active.id,
          skuId: purchasable.id,
          // From the CART row, not from a request. With the two composite foreign keys, this is
          // what makes a cross-store line unrepresentable.
          storeId: params.storeId,
          quantity: params.quantity,
          at: new Date(),
        });

        return buildView({
          cart: active,
          storeId: params.storeId,
          storeCurrency: params.storeCurrency,
          at: new Date(),
        });
      });
    },

    /**
     * Remove one line.
     *
     * Resolves the SKU WITHOUT the purchasability filter, deliberately: a customer must be able
     * to remove a line whose SKU has since been deactivated, and filtering here would leave them
     * holding something they can neither buy nor delete.
     *
     * A line that was never in the cart is a `404`, decided by the delete's own predicate rather
     * than by a lookup beforehand.
     */
    async removeItem(params: { userId: string; storeId: string; skuCode: string }): Promise<void> {
      await withLockedActiveCart(params, async (active) => {
        const existing = await repository.findAnySkuIdByCode({
          storeId: params.storeId,
          code: params.skuCode,
        });
        if (!existing) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, skuCode: params.skuCode },
            'cart_item_not_found',
          );
          throw new NotFound('cart item');
        }

        const removed = await repository.deleteLine({
          cartId: active.id,
          storeId: params.storeId,
          skuId: existing.id,
        });

        if (!removed) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, skuCode: params.skuCode },
            'cart_item_not_found',
          );
          throw new NotFound('cart item');
        }

        logger.info(
          { storeId: params.storeId, userId: params.userId, cartId: active.id },
          'cart_item_removed',
        );
      });
    },

    /**
     * Empty the cart, keeping the cart row.
     *
     * Removes the lines **and the applied promotion**. A discount on an empty cart is
     * meaningless, and leaving the association would mean the next added item silently revived a
     * coupon the customer had already cleared away.
     *
     * The two deletes share ONE transaction — the only real consistency boundary in this
     * module. A cart with a promotion and no items, or items and a promotion the customer
     * thought they had cleared, is a state no reader should ever observe.
     *
     * A cart is a container, so clearing it does not churn its identity: a client holding the
     * cart id still holds a valid cart. Idempotent — clearing an empty cart succeeds.
     */
    async clearCart(params: { userId: string; storeId: string }): Promise<void> {
      await withLockedActiveCart(params, async (active) => {
        await repository.clearLines({ cartId: active.id, storeId: params.storeId });
        await repository.deleteAppliedPromotion({
          cartId: active.id,
          storeId: params.storeId,
        });

        logger.info(
          { storeId: params.storeId, userId: params.userId, cartId: active.id },
          'cart_cleared',
        );
      });
    },

    /**
     * **The checkout boundary: take the cart lock and hand back everything an order needs.**
     *
     * Called by the orders module through a port it declares, so neither module imports the
     * other. The cart owns three things no other module may re-derive:
     *
     *  1. how the customer's ACTIVE cart is found, and the lock that serialises it;
     *  2. what a cart line is, including `sku_id` and the values an order line must snapshot;
     *  3. the purchasability predicate — one expression, shared with `listLines`, so "you may
     *     buy this" cannot mean one thing in the cart and another at checkout.
     *
     * MUST be called inside the caller's transaction: a row lock lives only as long as the
     * transaction that took it, so acquiring it here and returning would release it immediately.
     * `executor(db)` in the repository joins the ambient transaction, which is what makes that
     * work; `isInTransaction()` is asserted so a caller who forgets fails loudly rather than
     * silently losing the lock.
     *
     * Returns `undefined` when there is no active cart to check out — either the customer has
     * none, or a concurrent checkout already took it.
     */
    async lockCartForCheckout(params: {
      userId: string;
      storeId: string;
    }): Promise<{ cart: CartRecord; lines: CartCheckoutLine[]; promotionId?: string } | undefined> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'lockCartForCheckout must be called inside a transaction; a row lock does not outlive one',
        );
      }

      const locked = await repository.lockActiveCart(params);
      if (!locked) return undefined;

      const lines = await repository.listLinesForCheckout({
        cartId: locked.id,
        storeId: params.storeId,
      });
      const applied = await repository.findAppliedPromotionId({
        cartId: locked.id,
        storeId: params.storeId,
      });

      return {
        cart: locked,
        lines,
        ...(applied === undefined ? {} : { promotionId: applied.promotionId }),
      };
    },

    /**
     * Move the locked cart to `checked_out`. Returns false if it was not active any more.
     *
     * The caller must already hold the lock from `lockCartForCheckout`, and must be in the same
     * transaction — the transition and the order have to commit together, or a cart could be
     * checked out with no order behind it.
     *
     * The `status = 'active'` predicate is in the UPDATE, so this is the second of three
     * defences against a double checkout: the lock, this predicate, and `uq_order_cart`.
     */
    async markCheckedOut(params: { cartId: string; storeId: string }): Promise<boolean> {
      if (!isInTransaction()) {
        throw new InvariantViolation(
          'markCheckedOut must be called inside the checkout transaction',
        );
      }
      return repository.markCartCheckedOut({
        cartId: params.cartId,
        storeId: params.storeId,
        at: new Date(),
      });
    },

    /**
     * Apply a coupon code to the customer's cart, replacing any promotion already applied.
     *
     * **Replace rather than refuse.** A customer holding a better coupon should not have to
     * perform two requests, and "remove the other one first" is a rule they did not agree to.
     * Exactly one promotion survives, guaranteed by `pk_cart_promotion` rather than by a check
     * here — so two simultaneous applies converge on one row instead of racing into a duplicate.
     *
     * Naturally retry-safe: the write is an upsert keyed on the cart, so repeating the identical
     * request leaves the same row. That is why no `Idempotency-Key` middleware is mounted.
     *
     * Failure modes: `422` for an empty cart and for a subtotal below the promotion's minimum;
     * one indistinguishable `404` for unknown, inactive, deleted, expired and not-yet-started
     * codes, so the endpoint cannot be used to discover which coupons exist.
     */
    async applyPromotion(params: {
      userId: string;
      storeId: string;
      storeCurrency: string;
      code: string;
    }): Promise<CartView> {
      const at = new Date();
      const currency = requireCurrency(params.storeId, params.storeCurrency);

      return withLockedActiveCart(params, async (active) => {
        const lines = await repository.listLines({
          cartId: active.id,
          storeId: params.storeId,
        });
        const { subtotal } = priceLines(lines, currency);

        if (lines.length === 0) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, cartId: active.id },
            'cart_promotion_rejected_empty_cart',
          );
          throw new PromotionRequiresItems();
        }

        const outcome = await promotions.findApplicable({
          storeId: params.storeId,
          code: params.code,
          subtotal,
          storeCurrency: params.storeCurrency,
          at,
        });

        if ('reason' in outcome) {
          logger.info(
            {
              storeId: params.storeId,
              userId: params.userId,
              cartId: active.id,
              reason: outcome.reason,
            },
            'cart_promotion_rejected',
          );

          if (outcome.reason === 'minimum_subtotal') {
            throw new PromotionMinimumSubtotal({ minSubtotal: outcome.minSubtotal, subtotal });
          }
          // Everything else is one answer. The code is deliberately not echoed.
          throw new NotFound('promotion');
        }

        const written = await repository.setAppliedPromotion({
          cartId: active.id,
          promotionId: outcome.promotionId,
          // From the CART row, not from a request. With the two composite foreign keys, this is
          // what makes a cross-store applied promotion unrepresentable.
          storeId: params.storeId,
          at,
        });

        /**
         * The cart was emptied while this request was in flight.
         *
         * The check above is advisory: it reads the lines, then prices the coupon, and a `DELETE
         * /cart` committing in between would leave a coupon attached to an empty cart — measured
         * three times out of three before the guard moved into the statement. The write carries
         * the real guard, so this branch is how a lost race is reported, and it gives the same
         * answer the sequential path does.
         */
        if (!written) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, cartId: active.id },
            'cart_promotion_rejected_empty_cart_race',
          );
          throw new PromotionRequiresItems();
        }

        logger.info(
          { storeId: params.storeId, userId: params.userId, cartId: active.id },
          'cart_promotion_applied',
        );

        return buildView({
          cart: active,
          storeId: params.storeId,
          storeCurrency: params.storeCurrency,
          at,
        });
      });
    },

    /**
     * Remove the applied promotion.
     *
     * Removes the ASSOCIATION, never the promotion — a customer discarding a coupon must not be
     * able to affect a merchant's configuration or any other customer's cart.
     *
     * A cart with no promotion applied is a `404`, matching every other delete in this codebase:
     * a `GET` would show `promotion: null`, so a `204` here would contradict the very next
     * request. Note this fires even when a promotion IS associated but no longer discounts
     * anything — the row is what is being removed, and removing it is exactly what a customer
     * whose coupon has expired would want to do.
     */
    async removePromotion(params: { userId: string; storeId: string }): Promise<void> {
      await withLockedActiveCart(params, async (active) => {
        const removed = await repository.deleteAppliedPromotion({
          cartId: active.id,
          storeId: params.storeId,
        });
        if (!removed) {
          logger.info(
            { storeId: params.storeId, userId: params.userId, cartId: active.id },
            'cart_promotion_not_found',
          );
          throw new NotFound('cart promotion');
        }

        logger.info(
          { storeId: params.storeId, userId: params.userId, cartId: active.id },
          'cart_promotion_removed',
        );
      });
    },
  };
}
