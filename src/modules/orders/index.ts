/**
 * The orders module's public surface.
 *
 * The composition root uses these; nothing else should. The repository's table imports and the
 * DTO internals are NOT exported — a caller that wants an order asks the service, and nothing
 * outside this module names `order`, `order_line` or `order_status_history`.
 *
 * The three PORT types are exported because the composition root adapts the cart, the promotions
 * service and the idempotency store onto them. Those modules never import them: orders declares
 * the shapes it needs and structural typing does the rest, so no module names another and
 * `no-cross-module-imports` is satisfied by construction rather than by an exception.
 *
 * Deliberately small. This increment turns a cart into an order and reads the result back.
 * Payment, shipping, tax, invoicing, cancellation, returns and refunds are all later increments,
 * and exporting a surface ahead of them would be guessing at their shape.
 */

export {
  createOrdersService,
  generateOrderNumber,
  CheckoutCartEmpty,
  CheckoutCartNotAvailable,
  CheckoutLinesUnavailable,
  type OrdersService,
  type OrderView,
  type CheckoutCart,
  type CheckoutCartLine,
  type CheckoutPromotion,
  type CheckoutPromotions,
  type CheckoutIdempotency,
} from './orders.service.js';
export {
  createOrdersRepository,
  type OrdersRepository,
  type OrderRecord,
  type OrderLineRecord,
} from './orders.repository.js';
export { createOrdersRoutes } from './orders.routes.js';
export { ORDER_AUDIT, ORDER_RESOURCE } from './orders.events.js';
