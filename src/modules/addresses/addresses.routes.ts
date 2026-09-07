import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { validate, validatedBody, validatedParams } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import type { AddressesService } from './addresses.service.js';
import {
  AddressIdParamsSchema,
  CreateAddressRequestSchema,
  UpdateAddressRequestSchema,
  toAddressResponse,
  type AddressIdParams,
  type CreateAddressRequest,
  type UpdateAddressRequest,
} from './dto.js';

/**
 * The addresses module's HTTP surface.
 *
 * Mounted by the composition root under the API router at `/api/v1`, so
 * `GET /users/me/addresses` here is reachable as `GET /api/v1/users/me/addresses`.
 *
 * `/users/me/*` matches the existing identity convention exactly — `GET /users/me`,
 * `PATCH /users/me`, `POST /users/me/password` — so a client learns one shape for "things about
 * the signed-in customer". Two modules therefore serve that prefix; that is the deliberate cost
 * of keeping the address book its own aggregate rather than growing `identity.service.ts`
 * further.
 *
 * **No staff scope anywhere in this file, and no admin routes.** Identity's own comment states
 * the reason for its equivalents: *"`requireScope('staff')` here would lock every customer out
 * of their own profile."* Customer addresses are PII and no admin need exists yet — nothing
 * fulfils orders — so exposing them to staff would be a privacy cost with no purchaser.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */

export function createAddressesRoutes(deps: {
  addresses: AddressesService;
  /** The identity module's verifier, adapted to the HTTP port by the composition root. */
  verifyAccessToken: AccessTokenVerifier;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { addresses, verifyAccessToken, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({ verifyAccessToken, logger });

  /**
   * The owner and the tenant, both from the VERIFIED access token.
   *
   * `AuthenticatedUser` carries `id` and `storeId`, so neither ever needs to come from a
   * request body — and no schema in this module has a field for either. That matters most on
   * the three routes with no body schema (`GET`, `GET /:id`, `DELETE`): an unexpected JSON body
   * reaches `req.body` unvalidated there, which is the escalation Increments 24 and 26 both
   * found on bodiless routes. Reading scope from the token rather than the request closes it by
   * construction.
   *
   * `requireStore(req)` is deliberately NOT used: identity's own `/users/me` routes take the
   * store from the token, and the token is already verified against the resolved store by
   * `requireAuth`. Using the token keeps the owner and the tenant from two different sources.
   */
  const owner = (req: Request): { userId: string; storeId: string } => {
    const user = requireUser(req);
    return { userId: user.id, storeId: user.storeId };
  };

  /** The audit actor, from the same verified token. Never from the body. */
  const customerActor = (req: Request): AuditActor => ({
    type: 'customer',
    userId: requireUser(req).id,
  });

  /**
   * POST /users/me/addresses
   *
   * 201 with the created address.
   *
   * Middleware order is load-bearing and matches every other authenticated route:
   *
   *   resolveStore (API router)  ->  requireAuth  ->  validate(body)  ->  handler
   *
   * No scope guard: this is a customer acting on their own data. Not rate limited, consistent
   * with the other authenticated routes — reaching it requires a valid signed access token.
   */
  router.post(
    '/users/me/addresses',
    auth,
    validate({ body: CreateAddressRequestSchema }),
    asyncHandler(async (req, res) => {
      const created = await addresses.createAddress({
        ...owner(req),
        actor: customerActor(req),
        input: validatedBody<CreateAddressRequest>(req),
      });

      res.status(201).json({ address: toAddressResponse(created) });
    }),
  );

  /**
   * GET /users/me/addresses
   *
   * 200 with this customer's live addresses.
   *
   * UNPAGED, deliberately: an address book is bounded by what one person can maintain, which is
   * the judgement §28 applied to a single product's SKUs and the opposite of the one it applied
   * to a store's products. Deleted addresses are excluded and there is no way to ask for them.
   */
  router.get(
    '/users/me/addresses',
    auth,
    asyncHandler(async (req, res) => {
      const rows = await addresses.getAddressesForUser(owner(req));

      res.status(200).json({ addresses: rows.map(toAddressResponse) });
    }),
  );

  /**
   * GET /users/me/addresses/:id
   *
   * 200, or `404` for an unknown id, another customer's address, another store's, or a deleted
   * one — all indistinguishable on purpose. A `403` for "someone else's" would confirm the id
   * exists, which is precisely the leak one answer closes.
   *
   * A malformed id is a `400` from `AddressIdParamsSchema`, never a PostgreSQL
   * invalid-input-syntax error surfacing as a 500.
   */
  router.get(
    '/users/me/addresses/:id',
    auth,
    validate({ params: AddressIdParamsSchema }),
    asyncHandler(async (req, res) => {
      const row = await addresses.getAddressById({
        ...owner(req),
        id: validatedParams<AddressIdParams>(req).id,
      });

      res.status(200).json({ address: toAddressResponse(row) });
    }),
  );

  /**
   * PATCH /users/me/addresses/:id
   *
   * 200 with the updated address. Every field optional, at least one required — an empty PATCH
   * would bump `updated_at`, answer 200, and leave a caller believing something changed (§29).
   *
   * `userId`, `storeId`, `id`, `deletedAt` and the timestamps are absent from the schema and
   * therefore unreachable rather than ignored; each is a `400` naming the field.
   */
  router.patch(
    '/users/me/addresses/:id',
    auth,
    validate({ params: AddressIdParamsSchema, body: UpdateAddressRequestSchema }),
    asyncHandler(async (req, res) => {
      const updated = await addresses.updateAddress({
        ...owner(req),
        id: validatedParams<AddressIdParams>(req).id,
        actor: customerActor(req),
        input: validatedBody<UpdateAddressRequest>(req),
      });

      res.status(200).json({ address: toAddressResponse(updated) });
    }),
  );

  /**
   * DELETE /users/me/addresses/:id
   *
   * 204. **Soft** delete: the row survives, per docs/DECISIONS.md §3 decision 15 ("anonymise,
   * never delete"), because an address is personal data inside the erasure story and tax law
   * requires invoice retention.
   *
   * A second delete is a `404`, matching `DELETE /admin/products/:slug` and
   * `DELETE /admin/skus/:code`: a `GET` on a deleted address answers 404, so a `DELETE`
   * answering 204 would contradict the very next request about the same id.
   *
   * There is no restore endpoint — none was asked for.
   */
  router.delete(
    '/users/me/addresses/:id',
    auth,
    validate({ params: AddressIdParamsSchema }),
    asyncHandler(async (req, res) => {
      await addresses.deleteAddress({
        ...owner(req),
        id: validatedParams<AddressIdParams>(req).id,
        actor: customerActor(req),
      });

      res.status(204).send();
    }),
  );

  return router;
}
