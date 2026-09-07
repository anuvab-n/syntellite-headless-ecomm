import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import type { PromotionsService } from './promotions.service.js';
import {
  CreatePromotionRequestSchema,
  ListPromotionsQuerySchema,
  PromotionCodeParamsSchema,
  UpdatePromotionRequestSchema,
  toPromotionListResponse,
  toPromotionResponse,
  type CreatePromotionRequest,
  type ListPromotionsQuery,
  type PromotionCodeParams,
  type UpdatePromotionRequest,
} from './dto.js';

/**
 * The promotions module's HTTP surface: **staff only**.
 *
 * All five routes live under `/admin/`, matching the project's convention that an admin surface
 * must be identifiable from its path. There is deliberately **no customer-facing route here** —
 * no "list available coupons", which would hand every visitor a catalogue of discounts to try,
 * and no apply/remove, which operate on a cart and therefore belong to the cart module.
 *
 * Middleware order is load-bearing and matches the catalogue exactly:
 *
 *   resolveStore (API router) -> requireAuth -> requireScope('staff') -> validate -> handler
 *
 * `requireAuth` before `requireStaff` because the guard reads `req.user`; `requireStaff` before
 * `validate` so an unprivileged caller cannot use validation messages to probe the shape of an
 * endpoint they may not use.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createPromotionsRoutes(deps: {
  promotions: PromotionsService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  /** The staff guard, pre-built against the authorization loader by the composition root. */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { promotions, requireStaff, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({ verifyAccessToken: deps.verifyAccessToken, logger });

  /**
   * The staff member performing the action, for the audit trail.
   *
   * From the VERIFIED access token, never from the request. An actor a client could supply is
   * an audit trail a client could forge, which is worse than no trail because it is trusted.
   */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * POST /admin/promotions
   *
   * 201 with the created promotion.
   *
   * `storeId` comes from the RESOLVED store and the actor from the token; the request schema
   * has no field for either, so a client that sends one is rejected before this line. Both
   * defences matter — the schema makes the field unreachable, this makes the source
   * unambiguous.
   *
   * Failure modes: `400` for a malformed body, an unknown field, a discount whose shape does
   * not match its type, a percentage outside 0–100, a non-positive amount, or a window that
   * closes before it opens; `409` when a live promotion in this store already uses the code,
   * compared case-insensitively.
   */
  router.post(
    '/admin/promotions',
    auth,
    requireStaff,
    validate({ body: CreatePromotionRequestSchema }),
    asyncHandler(async (req, res) => {
      const row = await promotions.createPromotion({
        storeId: requireStore(req).id,
        actor: staffActor(req),
        input: validatedBody<CreatePromotionRequest>(req),
      });

      res.status(201).json({ promotion: toPromotionResponse(row) });
    }),
  );

  /**
   * GET /admin/promotions
   *
   * 200 with a page of this store's promotions, ordered by code.
   *
   * Includes inactive and out-of-window promotions: a merchant must be able to see the coupon
   * they scheduled for next month and the one they paused. Soft-deleted rows are excluded —
   * there is no restore, so a deleted promotion is not something the admin surface can act on.
   *
   * The page and the total share one predicate, so a caller on the last page is never told the
   * total counted rows it cannot see.
   */
  router.get(
    '/admin/promotions',
    auth,
    requireStaff,
    validate({ query: ListPromotionsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = validatedQuery<ListPromotionsQuery>(req);

      const page = await promotions.listPromotions({
        storeId: requireStore(req).id,
        limit,
        offset,
      });

      res.status(200).json(toPromotionListResponse(page));
    }),
  );

  /**
   * GET /admin/promotions/:code
   *
   * 200, or `404` for an unknown code, another store's promotion, or a deleted one — all
   * indistinguishable, the §25 rule that ownership belongs in the query rather than in a
   * comparison performed afterwards.
   *
   * The code is matched case-insensitively, so `/admin/promotions/save10` reaches `SAVE10`.
   */
  router.get(
    '/admin/promotions/:code',
    auth,
    requireStaff,
    validate({ params: PromotionCodeParamsSchema }),
    asyncHandler(async (req, res) => {
      const row = await promotions.getPromotion({
        storeId: requireStore(req).id,
        code: validatedParams<PromotionCodeParams>(req).code,
      });

      res.status(200).json({ promotion: toPromotionResponse(row) });
    }),
  );

  /**
   * PATCH /admin/promotions/:code
   *
   * 200 with the updated promotion. Partial: absent means "leave it alone", and `null` on a
   * nullable field means "clear it" — two genuinely different intentions.
   *
   * A promotion's code may be changed, and the new code is checked for a case-insensitive
   * collision with any other live promotion in the store. Nothing references a promotion by
   * code except the admin path itself: `cart_promotion` holds the id, so a customer's applied
   * coupon survives a rename, and no historical record exists to be invalidated because
   * redemption does not exist yet.
   *
   * Failure modes: `400` as for create, plus an empty body; `404` as for read; `409` for a
   * code collision.
   */
  router.patch(
    '/admin/promotions/:code',
    auth,
    requireStaff,
    validate({ params: PromotionCodeParamsSchema, body: UpdatePromotionRequestSchema }),
    asyncHandler(async (req, res) => {
      const row = await promotions.updatePromotion({
        storeId: requireStore(req).id,
        code: validatedParams<PromotionCodeParams>(req).code,
        actor: staffActor(req),
        input: validatedBody<UpdatePromotionRequest>(req),
      });

      res.status(200).json({ promotion: toPromotionResponse(row) });
    }),
  );

  /**
   * DELETE /admin/promotions/:code
   *
   * 204. **Soft delete, and there is no restore** — reviving a coupon a merchant retired is a
   * new promotion, and an undelete endpoint would need its own uniqueness story once the code
   * has been reused.
   *
   * The row survives, which is what keeps `fk_cart_promotion_promotion_store`'s RESTRICT
   * satisfiable: a customer holding the coupon keeps their cart, and the coupon simply stops
   * discounting. A repeated delete is a `404`, matching every other delete in this codebase.
   */
  router.delete(
    '/admin/promotions/:code',
    auth,
    requireStaff,
    validate({ params: PromotionCodeParamsSchema }),
    asyncHandler(async (req, res) => {
      await promotions.deletePromotion({
        storeId: requireStore(req).id,
        code: validatedParams<PromotionCodeParams>(req).code,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  return router;
}
