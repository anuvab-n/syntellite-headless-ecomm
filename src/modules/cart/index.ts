/**
 * The cart module's public surface.
 *
 * The composition root uses these; nothing else should. In particular the repository's table
 * imports and the DTO internals are NOT exported — a caller that wants a cart asks the service,
 * and nothing outside this module names `cart` or `cart_line`.
 *
 * Increment 30 added the CHECKOUT boundary — `lockCartForCheckout` and `markCheckedOut` — which
 * the orders module consumes through a port it declares itself. Those two are the only way a
 * cart becomes an order, and they exist here because the cart owns what a cart line is, how the
 * active cart is found, the row lock that serialises it, and the purchasability predicate.
 *
 * Still deliberately small. Stock reservation, guest carts, abandoned-cart expiry and
 * saved-for-later remain later increments — or nothing at all — and exporting a surface ahead of
 * them would be guessing at their shape.
 */

export {
  createCartService,
  CartAlreadyCheckedOut,
  PromotionMinimumSubtotal,
  PromotionRequiresItems,
  type CartService,
  type CartView,
  type CartPromotions,
  type AppliedPromotion,
  type CartPromotionRejection,
} from './cart.service.js';
export {
  createCartRepository,
  ACTIVE_CART_STATUS,
  CART_STATUSES,
  CHECKED_OUT_CART_STATUS,
  MAX_CART_LINE_QUANTITY,
  type CartRepository,
  type CartRecord,
  type CartCheckoutLine,
  type CartStatus,
} from './cart.repository.js';
export { createCartRoutes } from './cart.routes.js';
