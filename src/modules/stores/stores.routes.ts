import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';

import {
  UpdateBusinessProfileRequestSchema,
  toBusinessProfileResponse,
  type UpdateBusinessProfileRequest,
} from './dto.js';
import type { StoresService } from './stores.service.js';

/**
 * The store's own admin surface: the business profile.
 *
 * Two routes, both staff-only and both scoped to the caller's OWN store. There is no store
 * parameter on either path and no `storeId` field in either schema — the tenant comes from the
 * verified token, so a staff member cannot address another merchant's settings at all.
 *
 * The GST identity is deliberately absent. `GET`/`PUT /admin/store/tax-profile` in the tax
 * module owns `legal_name`, `gstin`, `pan` and the origin address; this router must never write
 * them, and the DTO rejects each by name rather than ignoring it.
 */
export function createStoresRoutes(deps: {
  stores: StoresService;
  verifyAccessToken: AccessTokenVerifier;
  /** The `staff` scope guard, pre-built by the composition root, as every other router takes it. */
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred, matching every other routes file.
}): Router {
  const { stores, requireStaff, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({
    verifyAccessToken: deps.verifyAccessToken,
    logger,
  });

  const staffStore = (req: Request): string => requireUser(req).storeId;
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * `GET /admin/business-profile` — the store's business identity. Increment 62.
   *
   * `401` unauthenticated, `403` without the `staff` scope. There is no `404`: the store was
   * already resolved in order to authenticate the request.
   */
  router.get(
    '/admin/business-profile',
    auth,
    requireStaff,
    asyncHandler(async (req, res) => {
      const profile = await stores.getBusinessProfile({ storeId: staffStore(req) });
      res.status(200).json({ businessProfile: toBusinessProfileResponse(profile) });
    }),
  );

  /**
   * `PATCH /admin/business-profile` — edit the business identity. Increment 62.
   *
   * A PATCH rather than a PUT: absent keys are left alone, so a client editing one field cannot
   * blank the others by omission. An empty body is a no-op that reads the profile back.
   *
   * Audited inside the write's transaction, recording only the fields that actually changed.
   * No `Idempotency-Key`: this is a last-write-wins settings edit with no side effect a replay
   * could duplicate — unlike a refund or a shipment, re-applying the same values twice leaves
   * the same state.
   *
   * `400` for an unknown field — including `gstin`, `legalName`, `pan`, `slug` and `currency`,
   * each of which is rejected by name rather than ignored.
   */
  router.patch(
    '/admin/business-profile',
    auth,
    requireStaff,
    validate({ body: UpdateBusinessProfileRequestSchema }),
    asyncHandler(async (req, res) => {
      const profile = await stores.updateBusinessProfile({
        storeId: staffStore(req),
        values: validatedBody<UpdateBusinessProfileRequest>(req),
        actor: staffActor(req),
      });

      res.status(200).json({ businessProfile: toBusinessProfileResponse(profile) });
    }),
  );

  return router;
}
