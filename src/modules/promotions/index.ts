/**
 * The promotions module's public surface.
 *
 * The composition root uses these; nothing else should. The repository's table imports and the
 * DTO internals are NOT exported — a caller that wants a promotion asks the service, and
 * nothing outside this module names `promotion` or `cart_promotion`.
 *
 * `PromotionDiscount` and `PromotionRejection` are exported because the composition root
 * adapts this service onto the port the cart module declares. The cart never imports them: it
 * declares its own structurally compatible port, so neither module depends on the other and
 * `no-cross-module-imports` is satisfied by construction rather than by an exception.
 *
 * Deliberately small. This increment configures coupon-code discounts and prices one against a
 * cart subtotal. Redemption, usage limits, per-customer limits, automatic promotions, targeting
 * and stacking are all absent — several by explicit decision, and exporting a surface ahead of
 * them would be guessing at their shape.
 */

export {
  createPromotionsService,
  PromotionCodeTaken,
  type PromotionsService,
  type PromotionDiscount,
  type PromotionRejection,
} from './promotions.service.js';
export {
  createPromotionsRepository,
  PROMOTION_DISCOUNT_TYPES,
  type PromotionsRepository,
  type PromotionRecord,
  type PromotionDiscountType,
} from './promotions.repository.js';
export { createPromotionsRoutes } from './promotions.routes.js';
export { PROMOTION_AUDIT, PROMOTION_RESOURCE } from './promotions.events.js';
