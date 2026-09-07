import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedBody, validatedParams } from '../../http/validate.js';
import type { Logger } from '../../shared/logger.js';
import type { CartService } from './cart.service.js';
import {
  ApplyCartPromotionRequestSchema,
  CartItemParamsSchema,
  SetCartItemRequestSchema,
  toCartResponse,
  type ApplyCartPromotionRequest,
  type CartItemParams,
  type SetCartItemRequest,
} from './dto.js';

/**
 * The cart module's HTTP surface.
 *
 * Mounted by the composition root under the API router at `/api/v1`, so `GET /users/me/cart`
 * here is reachable as `GET /api/v1/users/me/cart`.
 *
 * `/users/me/*` matches the existing convention exactly — identity owns `GET /users/me` and
 * `POST /users/me/password`, addresses owns `/users/me/addresses`. A third module now serves
 * that prefix, which is the deliberate cost of keeping each customer-owned aggregate its own
 * module rather than growing one of them.
 *
 * **No staff scope and no admin routes.** A cart is the customer's own basket; there is nothing
 * for an operator to do with it in this increment, and exposing one would be a privacy cost with
 * no purchaser. Promotion CONFIGURATION is a staff surface and lives in `modules/promotions`;
 * what belongs here is only what a customer does to their own cart.
 *
 * **Six routes.** Four for the basket, two for the applied coupon.
 *
 * **No `Idempotency-Key` middleware.** That infrastructure is reserved for checkout by its own
 * documentation, and its header is REQUIRED when mounted — so mounting it here would 400 every
 * client that omits a key. It is unnecessary anyway: both `PUT`s SET rather than add, so a retry
 * of the identical request is a no-op, and correctness comes from the `(cart_id, sku_id)` and
 * `(cart_id)` primary keys rather than from a key in a header.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createCartRoutes(deps: {
  cart: CartService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { cart, verifyAccessToken, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({ verifyAccessToken, logger });

  /**
   * The owner, the tenant, and the currency — none of them from the request body.
   *
   * `AuthenticatedUser` carries `id` and `storeId` from the verified token, so no schema in this
   * module has a field for either. That matters most on the three routes with no body schema
   * (`GET` and the two `DELETE`s): an unexpected JSON body reaches `req.body` unvalidated there,
   * which is the escalation Increments 24, 26 and 27 each probed. Reading scope from the token
   * closes it by construction.
   *
   * `currency` comes from the resolved STORE, which is the currency aggregate (§6). The cart
   * has no currency column, so there is nothing that could disagree with it.
   */
  const scope = (req: Request): { userId: string; storeId: string; storeCurrency: string } => {
    const user = requireUser(req);
    return {
      userId: user.id,
      storeId: user.storeId,
      storeCurrency: requireStore(req).currency,
    };
  };

  /**
   * GET /users/me/cart
   *
   * 200 with the customer's active cart, **creating an empty one if they have none**. A 404 for
   * "you have no cart yet" would push cart creation into the client for no benefit, and every
   * client's first action would be to handle it.
   *
   * Two simultaneous first requests converge on ONE cart: `uq_cart_active` admits a single row
   * and the loser re-reads the winner's. Verified against PostgreSQL with two and eight
   * concurrent callers.
   *
   * A `checked_out` cart is not returned — the customer gets a fresh active one — so this route
   * is also what makes the lifecycle work without a checkout endpoint existing yet.
   *
   * UNPAGED: a cart is bounded by what one person puts in it.
   */
  router.get(
    '/users/me/cart',
    auth,
    asyncHandler(async (req, res) => {
      const view = await cart.getCart(scope(req));

      res.status(200).json({ cart: toCartResponse(view) });
    }),
  );

  /**
   * PUT /users/me/cart/items/:skuCode
   *
   * 200 with the whole cart. **SET, not add**: the body says what the quantity should BE, so
   * repeating the identical request leaves it unchanged and a client retry is safe with no
   * idempotency infrastructure. An increment endpoint would double on retry, which is measurably
   * what happens and why this is a `PUT`.
   *
   * `PUT` rather than `POST` + `PATCH`: those would be two ways to write one line, with two
   * concurrency stories and two sets of failure modes. One idempotent upsert is smaller and
   * safer.
   *
   * `quantity: 0` is a `400`, not a delete — `DELETE` says that precisely, and one route meaning
   * two things would need two success codes.
   *
   * Returns the FULL cart rather than the single line, so a client never has to re-read to learn
   * the new total.
   *
   * Failure modes: `400` for a missing, fractional, zero, negative, over-999 or non-numeric
   * quantity and for any unknown field; `404` for a SKU that is unknown, another store's,
   * deleted, inactive, or whose product is deleted or unpublished — all indistinguishable on
   * purpose. **No stock check**: availability is not consulted and `reserved` is untouched.
   */
  router.put(
    '/users/me/cart/items/:skuCode',
    auth,
    validate({ params: CartItemParamsSchema, body: SetCartItemRequestSchema }),
    asyncHandler(async (req, res) => {
      const view = await cart.setItemQuantity({
        ...scope(req),
        skuCode: validatedParams<CartItemParams>(req).skuCode,
        quantity: validatedBody<SetCartItemRequest>(req).quantity,
      });

      res.status(200).json({ cart: toCartResponse(view) });
    }),
  );

  /**
   * DELETE /users/me/cart/items/:skuCode
   *
   * 204. Removes one line.
   *
   * Deliberately does NOT require the SKU to be purchasable: a customer must be able to remove a
   * line whose SKU was deactivated after they added it, and filtering here would leave them
   * holding something they can neither buy nor delete.
   *
   * A line that is not in the cart is a `404`, matching every other delete in this codebase —
   * a `GET` of a cart without that line shows nothing, so a `DELETE` answering 204 would
   * contradict the very next request.
   */
  router.delete(
    '/users/me/cart/items/:skuCode',
    auth,
    validate({ params: CartItemParamsSchema }),
    asyncHandler(async (req, res) => {
      await cart.removeItem({
        ...scope(req),
        skuCode: validatedParams<CartItemParams>(req).skuCode,
      });

      res.status(204).send();
    }),
  );

  /**
   * DELETE /users/me/cart
   *
   * 204. Clears every line **and the applied promotion**, and **keeps the cart row**.
   *
   * The promotion goes too: a discount on an empty cart is meaningless, and leaving the
   * association would mean the next item added silently revived a coupon the customer had
   * already cleared away. Both deletes share one transaction.
   *
   * A cart is a container, so emptying it does not churn its identity: a client holding the cart
   * id still holds a valid cart, and the customer's `uq_cart_active` slot is unchanged. Deleting
   * the row would also mean the next `GET` minted a new id for no reason a client could observe.
   *
   * Idempotent: clearing an already-empty cart is a 204.
   */
  router.delete(
    '/users/me/cart',
    auth,
    asyncHandler(async (req, res) => {
      await cart.clearCart(scope(req));

      res.status(204).send();
    }),
  );

  /**
   * PUT /users/me/cart/promotion
   *
   * 200 with the whole cart, discount included. Body is exactly `{ code }`.
   *
   * `PUT` rather than `POST` for the same reason the item route is: the request states what the
   * cart's promotion should BE, so repeating it is a no-op and a client retry after a timeout
   * cannot apply anything twice. That is why **no `Idempotency-Key` middleware is mounted** —
   * and mounting it would 400 every client that omitted the header, which it requires.
   *
   * **Applying a second code REPLACES the first**, in one request. Requiring a `DELETE` first
   * would be a rule the customer never agreed to, and it would leave their cart briefly with no
   * promotion at all. Exactly one survives because `pk_cart_promotion` is on `cart_id`, so
   * concurrent applies converge on one row rather than racing into a duplicate.
   *
   * Returns the FULL cart, so a client never has to re-read to learn the new total.
   *
   * Failure modes: `400` for a malformed code or any unknown field; `422` for an empty cart and
   * for a subtotal below the promotion's minimum, the latter naming the threshold; `404` for a
   * code that is unknown, another store's, deactivated, deleted, expired or not yet started —
   * all indistinguishable, so this endpoint cannot be used to discover which coupons exist.
   *
   * **Nothing is consumed.** Applying a coupon does not redeem it: there are no usage limits and
   * no redemption records in this build, and checkout will revalidate and recompute from scratch.
   */
  router.put(
    '/users/me/cart/promotion',
    auth,
    validate({ body: ApplyCartPromotionRequestSchema }),
    asyncHandler(async (req, res) => {
      const view = await cart.applyPromotion({
        ...scope(req),
        code: validatedBody<ApplyCartPromotionRequest>(req).code,
      });

      res.status(200).json({ cart: toCartResponse(view) });
    }),
  );

  /**
   * DELETE /users/me/cart/promotion
   *
   * 204. Removes the ASSOCIATION, never the promotion — a customer discarding a coupon must not
   * affect the merchant's configuration or any other customer's cart.
   *
   * A cart with no promotion applied is a `404`: a `GET` would show `promotion: null`, so a
   * `204` here would contradict the very next request. It succeeds even when the applied
   * promotion has expired, which is precisely when a customer wants to clear it.
   *
   * A request body on this route is ignored entirely.
   */
  router.delete(
    '/users/me/cart/promotion',
    auth,
    asyncHandler(async (req, res) => {
      await cart.removePromotion(scope(req));

      res.status(204).send();
    }),
  );

  return router;
}
