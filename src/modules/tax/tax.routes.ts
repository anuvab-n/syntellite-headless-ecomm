import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore } from '../../http/middleware/store.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import { NotFound } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import {
  CreateTaxClassRequestSchema,
  CreateTaxRateRequestSchema,
  ListTaxClassesQuerySchema,
  PutCustomerTaxIdentityRequestSchema,
  PutSkuTaxRequestSchema,
  PutStoreTaxProfileRequestSchema,
  SkuCodeParamsSchema,
  TaxClassCodeParamsSchema,
  UpdateTaxClassRequestSchema,
  toCustomerTaxIdentityResponse,
  toStoreTaxProfileResponse,
  toTaxClassListResponse,
  toTaxClassResponse,
  toTaxRateResponse,
  type CreateTaxClassRequest,
  type CreateTaxRateRequest,
  type ListTaxClassesQuery,
  type PutCustomerTaxIdentityRequest,
  type PutSkuTaxRequest,
  type PutStoreTaxProfileRequest,
  type SkuCodeParams,
  type TaxClassCodeParams,
  type UpdateTaxClassRequest,
} from './dto.js';
import type { TaxService } from './tax.service.js';

/**
 * The tax module's HTTP surface.
 *
 * **Nine routes, and the split down the middle is the security boundary.** Six are staff-only
 * and configure what customers are charged; three are the customer's own tax identity and
 * reach nothing else.
 *
 * Middleware order is load-bearing and matches promotions and the catalogue exactly:
 *
 *   resolveStore (API router) -> requireAuth -> requireScope('staff') -> validate -> handler
 *
 * `requireAuth` before `requireStaff` because the guard reads `req.user`; `requireStaff` before
 * `validate` so an unprivileged caller cannot use validation messages to probe the shape of an
 * endpoint they may not use.
 *
 * ## What a customer cannot reach through this router
 *
 * A rate, a tax class, a SKU classification, the seller's identity, a supply type, or any
 * computed tax amount. The three customer routes accept exactly two fields between them, both
 * about the caller's own registration, and every write derives `storeId` from the resolved
 * store and `userId` from the verified token.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/` —
 * `dependency-cruiser`'s `no-modules-to-http` carves out `*.routes.ts` for exactly this.
 */
export function createTaxRoutes(deps: {
  tax: TaxService;
  verifyAccessToken: AccessTokenVerifier;
  requireStaff: RequestHandler;
  logger: Logger;
  // Annotated rather than inferred: without it `tsc` cannot name the router type portably
  // under pnpm's nested `node_modules`. Every other routes file does the same.
}): Router {
  const { tax, requireStaff, logger } = deps;

  const router = Router();
  const auth: RequestHandler = requireAuth({ verifyAccessToken: deps.verifyAccessToken, logger });

  /** From the VERIFIED token, never from the request. See the promotions router. */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /* ── Seller tax identity and origin ───────────────────────────────────── */

  /**
   * GET /admin/store/tax-profile
   *
   * 200 with the seller's GST identity and origin address, and a computed `configured` flag.
   *
   * **Staff only, and deliberately not on any public store response.** These are the seller's
   * registration details; they belong on an invoice and in the admin surface, not on a
   * storefront payload that every visitor receives. `modules/stores` still returns its narrow
   * six-field row for request-time resolution, which is what keeps them off that path.
   */
  router.get(
    '/admin/store/tax-profile',
    auth,
    requireStaff,
    asyncHandler(async (req, res) => {
      const row = await tax.getStoreTaxProfile(requireStore(req).id);
      res.status(200).json({ taxProfile: toStoreTaxProfileResponse(row) });
    }),
  );

  /**
   * PUT /admin/store/tax-profile
   *
   * 200 with the stored profile. A full replace — see the DTO for why a PATCH would be worse.
   *
   * **This is the GST switch.** Once a profile is present, every checkout in this store is
   * assessed and a line that cannot resolve a class and a rate is refused. That is a
   * consequential act, which is why it is one explicit request rather than a drift of partial
   * writes, and why it is audited.
   *
   * Failure modes: `400` for a malformed body, an unknown field, a GSTIN or PAN that fails its
   * shape, or a blank required field.
   */
  router.put(
    '/admin/store/tax-profile',
    auth,
    requireStaff,
    validate({ body: PutStoreTaxProfileRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<PutStoreTaxProfileRequest>(req);
      const row = await tax.updateStoreTaxProfile({
        storeId: requireStore(req).id,
        actor: staffActor(req),
        input: {
          legalName: body.legalName,
          gstin: body.gstin,
          pan: body.pan ?? null,
          originLine1: body.originLine1,
          originLine2: body.originLine2 ?? '',
          originCity: body.originCity,
          originState: body.originState,
          originPostalCode: body.originPostalCode,
          originCountryCode: body.originCountryCode,
        },
      });
      res.status(200).json({ taxProfile: toStoreTaxProfileResponse(row) });
    }),
  );

  /* ── Tax classes ──────────────────────────────────────────────────────── */

  /**
   * POST /admin/tax-classes — 201 with the created class.
   *
   * `409` when a class in this store already uses the code, compared case-SENSITIVELY, which
   * matches `uq_tax_class_code` and the `codeColumn` convention.
   */
  router.post(
    '/admin/tax-classes',
    auth,
    requireStaff,
    validate({ body: CreateTaxClassRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<CreateTaxClassRequest>(req);
      /*
       * Spread rather than passed through, because `exactOptionalPropertyTypes` makes
       * `isActive?: boolean` and `isActive: boolean | undefined` different types. Omitting the
       * key when it is absent is what lets the service apply its own default.
       */
      const row = await tax.createTaxClass({
        storeId: requireStore(req).id,
        actor: staffActor(req),
        input: {
          code: body.code,
          name: body.name,
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        },
      });
      res.status(201).json({ taxClass: toTaxClassResponse(row) });
    }),
  );

  /**
   * GET /admin/tax-classes — 200 with a page of this store's classes, ordered by code.
   *
   * Inactive classes are included: a merchant must be able to see the classification they
   * retired, not least because historical orders still name it.
   */
  router.get(
    '/admin/tax-classes',
    auth,
    requireStaff,
    validate({ query: ListTaxClassesQuerySchema }),
    asyncHandler(async (req, res) => {
      const { limit, offset } = validatedQuery<ListTaxClassesQuery>(req);
      const page = await tax.listTaxClasses({ storeId: requireStore(req).id, limit, offset });
      res.status(200).json(toTaxClassListResponse(page));
    }),
  );

  /**
   * PATCH /admin/tax-classes/:code — 200 with the updated class.
   *
   * Name and active state only. The code is immutable; the DTO records why.
   *
   * **Deactivating is not free.** Every SKU pointing at this class becomes unsellable in a
   * store with a GST profile — checkout refuses it with a `422` rather than assessing it at
   * zero. That is the conservative choice and it is deliberate: silently untaxing a line is an
   * accounting error nobody notices until a return is filed.
   */
  router.patch(
    '/admin/tax-classes/:code',
    auth,
    requireStaff,
    validate({ params: TaxClassCodeParamsSchema, body: UpdateTaxClassRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<UpdateTaxClassRequest>(req);
      const row = await tax.updateTaxClass({
        storeId: requireStore(req).id,
        code: validatedParams<TaxClassCodeParams>(req).code,
        actor: staffActor(req),
        input: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
        },
      });
      res.status(200).json({ taxClass: toTaxClassResponse(row) });
    }),
  );

  /* ── Tax rates ────────────────────────────────────────────────────────── */

  /**
   * POST /admin/tax-classes/:code/rates — 201 with the created rate.
   *
   * `409 TAX_RATE_OVERLAP` when the window collides with one already configured, naming the
   * conflicting window in `details`. `404` for an unknown class.
   *
   * There is deliberately no update and no delete. A rate that was in force is what a
   * historical order was assessed under; superseding it with a new dated window is the honest
   * correction, and editing one in place would silently change what a past determination
   * appears to have been based on. Orders snapshot their own rates, so a historical figure is
   * safe either way — but the master data should still tell the truth about what applied when.
   */
  router.post(
    '/admin/tax-classes/:code/rates',
    auth,
    requireStaff,
    validate({ params: TaxClassCodeParamsSchema, body: CreateTaxRateRequestSchema }),
    asyncHandler(async (req, res) => {
      const body = validatedBody<CreateTaxRateRequest>(req);
      const row = await tax.createTaxRate({
        storeId: requireStore(req).id,
        taxClassCode: validatedParams<TaxClassCodeParams>(req).code,
        actor: staffActor(req),
        input: {
          cgstRate: body.cgstRate,
          sgstRate: body.sgstRate,
          igstRate: body.igstRate,
          cessRate: body.cessRate ?? '0',
          effectiveFrom: new Date(body.effectiveFrom),
          effectiveTo:
            body.effectiveTo === undefined || body.effectiveTo === null
              ? null
              : new Date(body.effectiveTo),
        },
      });
      res.status(201).json({ taxRate: toTaxRateResponse(row) });
    }),
  );

  /** GET /admin/tax-classes/:code/rates — 200 with every rate for the class, newest first. */
  router.get(
    '/admin/tax-classes/:code/rates',
    auth,
    requireStaff,
    validate({ params: TaxClassCodeParamsSchema }),
    asyncHandler(async (req, res) => {
      const result = await tax.listTaxRates({
        storeId: requireStore(req).id,
        taxClassCode: validatedParams<TaxClassCodeParams>(req).code,
      });
      res.status(200).json({
        taxClass: toTaxClassResponse(result.taxClass),
        taxRates: result.rates.map(toTaxRateResponse),
      });
    }),
  );

  /* ── SKU classification ───────────────────────────────────────────────── */

  /**
   * PUT /admin/skus/:code/tax — 200 with the SKU's classification.
   *
   * Both fields together, or both null to clear — `ck_sku_tax_classification` restated at the
   * boundary. `404` for an unknown SKU, another store's SKU, a deleted one, or an unknown tax
   * class: all indistinguishable, the §25 rule that ownership belongs in the query.
   *
   * A route of its own rather than fields on `PATCH /admin/skus/:code`, so an existing and
   * well-tested contract did not have to be widened for a different kind of data with a
   * different reviewer.
   */
  router.put(
    '/admin/skus/:code/tax',
    auth,
    requireStaff,
    validate({ params: SkuCodeParamsSchema, body: PutSkuTaxRequestSchema }),
    asyncHandler(async (req, res) => {
      const result = await tax.classifySku({
        storeId: requireStore(req).id,
        skuCode: validatedParams<SkuCodeParams>(req).code,
        actor: staffActor(req),
        input: validatedBody<PutSkuTaxRequest>(req),
      });
      res.status(200).json({ skuTax: result });
    }),
  );

  /* ── Customer tax identity ────────────────────────────────────────────── */

  /**
   * GET /users/me/tax-identity — 200 with the caller's registration, or `404` when they have
   * none.
   *
   * A `404` rather than `200` with a null body: "you have not set one" is the absence of a
   * resource, and every other single-resource read in this codebase answers absence the same
   * way.
   */
  router.get(
    '/users/me/tax-identity',
    auth,
    asyncHandler(async (req, res) => {
      const row = await tax.getCustomerTaxIdentity({
        storeId: requireStore(req).id,
        userId: requireUser(req).id,
      });
      if (row === null) throw new NotFound('tax identity');
      res.status(200).json({ taxIdentity: toCustomerTaxIdentityResponse(row) });
    }),
  );

  /**
   * PUT /users/me/tax-identity — 200 with the stored registration.
   *
   * Create or replace, so the endpoint is naturally idempotent and there is no
   * already-exists conflict for a client to handle.
   *
   * **Supplying one makes the customer's next order B2B** — approved decision 8 — and their
   * GSTIN is then snapshotted onto it. It does NOT retroactively change any order already
   * placed: those carry their own snapshot, which Phase 8 asserts directly.
   */
  router.put(
    '/users/me/tax-identity',
    auth,
    validate({ body: PutCustomerTaxIdentityRequestSchema }),
    asyncHandler(async (req, res) => {
      const row = await tax.putCustomerTaxIdentity({
        storeId: requireStore(req).id,
        userId: requireUser(req).id,
        input: validatedBody<PutCustomerTaxIdentityRequest>(req),
      });
      res.status(200).json({ taxIdentity: toCustomerTaxIdentityResponse(row) });
    }),
  );

  /**
   * DELETE /users/me/tax-identity — 204, or `404` when there was nothing to remove.
   *
   * A hard delete, and correct here: every order that used the GSTIN carries its own copy, so
   * nothing an audit needs is lost. The customer's next order is B2C.
   */
  router.delete(
    '/users/me/tax-identity',
    auth,
    asyncHandler(async (req, res) => {
      const removed = await tax.deleteCustomerTaxIdentity({
        storeId: requireStore(req).id,
        userId: requireUser(req).id,
      });
      if (!removed) throw new NotFound('tax identity');
      res.status(204).send();
    }),
  );

  return router;
}
