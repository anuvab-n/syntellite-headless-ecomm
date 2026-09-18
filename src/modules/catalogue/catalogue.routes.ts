import { Router, type Request, type RequestHandler } from 'express';

import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth, requireUser, type AccessTokenVerifier } from '../../http/middleware/auth.js';
import { requireStore, type RequestStore } from '../../http/middleware/store.js';
import { validate, validatedBody, validatedParams, validatedQuery } from '../../http/validate.js';
import type { AuditActor } from '../../shared/audit.js';
import type { Logger } from '../../shared/logger.js';
import type {
  MediaRecord,
  ProductRecord,
  SkuOptionRecord,
  SkuRecord,
} from './catalogue.repository.js';
import type { CatalogueService } from './catalogue.service.js';
import {
  CreateMediaRequestSchema,
  CreateOptionRequestSchema,
  CreateOptionValueRequestSchema,
  BulkProductActionRequestSchema,
  CreateProductRequestSchema,
  CreateSkuRequestSchema,
  CreateUploadTargetRequestSchema,
  MediaIdParamsSchema,
  AdminListProductsQuerySchema,
  OptionIdParamsSchema,
  ProductSlugParamsSchema,
  PublicListProductsQuerySchema,
  ReplaceSkuOptionsRequestSchema,
  SkuCodeParamsSchema,
  UpdateMediaRequestSchema,
  UpdateOptionRequestSchema,
  UpdateOptionValueRequestSchema,
  UpdateProductRequestSchema,
  UpdateSkuRequestSchema,
  groupOptionsBySku,
  groupSkusByProduct,
  groupValuesByOption,
  toMediaResponse,
  toOptionResponse,
  toOptionValueResponse,
  toProductListResponse,
  toProductResponse,
  toSkuResponse,
  type CreateMediaRequest,
  type CreateOptionRequest,
  type CreateOptionValueRequest,
  type BulkProductActionRequest,
  type CreateProductRequest,
  type CreateSkuRequest,
  type CreateUploadTargetRequest,
  type MediaIdParams,
  type AdminListProductsQuery,
  type OptionIdParams,
  type ProductListResponse,
  type ProductResponse,
  type ProductSlugParams,
  type PublicListProductsQuery,
  type ReplaceSkuOptionsRequest,
  type SkuCodeParams,
  type UpdateMediaRequest,
  type UpdateOptionRequest,
  type UpdateOptionValueRequest,
  type UpdateProductRequest,
  type UpdateSkuRequest,
} from './dto.js';

/**
 * The catalogue module's HTTP surface.
 *
 * Mounted by the composition root under the API router at `/api/v1`, so `POST /admin/products`
 * here is reachable as `POST /api/v1/admin/products`.
 *
 * `/admin/*` is a deliberate prefix rather than a flat namespace. `app_user.isStaff` is
 * documented in the schema as granting "access to the admin API surface at all", so that
 * surface needs to be identifiable — a reviewer should be able to tell from a path whether a
 * route is meant to be reachable by a customer.
 *
 * This file is an HTTP ADAPTER and is the only file in the module permitted to import `http/`
 * — `dependency-cruiser`'s `no-modules-to-http` rule carves out `*.routes.ts` precisely for
 * this. Everything it needs from other modules arrives as a port or a pre-built handler from
 * the composition root, because `no-cross-module-imports` forbids reaching into `identity` for
 * a token service.
 */

export function createCatalogueRoutes(deps: {
  catalogue: CatalogueService;
  /**
   * The identity module's verifier, adapted to the HTTP port by the composition root.
   *
   * A capability, not a service. The catalogue cannot import `TokenService` — that would be a
   * cross-module dependency — and it has no business knowing which module mints tokens.
   */
  verifyAccessToken: AccessTokenVerifier;
  /**
   * The staff guard, pre-built against the authorization loader.
   *
   * Passed in rather than constructed here because the loader reads the user table, which
   * belongs to identity. The composition root owns that wiring; this file only declares which
   * privilege the route requires.
   */
  requireStaff: RequestHandler;
  logger: Logger;
}): Router {
  const { catalogue, requireStaff, logger } = deps;
  const router = Router();

  const auth = requireAuth({ verifyAccessToken: deps.verifyAccessToken, logger });

  /**
   * The staff member performing an admin action, for the audit trail.
   *
   * From the VERIFIED access token via `requireUser`, never from the request. An actor a
   * client could supply is an audit trail a client could forge, which is worse than no trail
   * because it is trusted. Every route using this sits behind `auth` and `requireStaff`, so
   * `requireUser` cannot throw here — it would be a wiring bug, not a client error.
   */
  const staffActor = (req: Request): AuditActor => ({
    type: 'staff',
    userId: requireUser(req).id,
  });

  /**
   * One product plus its SKUs.
   *
   * Goes through the same batch loader a list uses, with a single id, so there is one code
   * path for loading SKUs rather than two that could disagree about `activeOnly`.
   *
   * `activeOnly` is the difference between the two audiences and the reason it is an explicit
   * argument at every call site rather than a default: a storefront must never see an inactive
   * SKU, and a merchant must always see one. A default would decide that silently for whichever
   * caller forgot.
   */
  async function productPayload(
    store: RequestStore,
    product: ProductRecord,
    activeOnly: boolean,
  ): Promise<ProductResponse> {
    const skus = await catalogue.getSkusForProducts({
      storeId: store.id,
      productIds: [product.id],
      activeOnly,
    });

    return toProductResponse(product, store.currency, skus, await skuOptions(store, skus));
  }

  /**
   * One SKU plus its combination.
   *
   * Goes through the same batch loader, with a single id, so there is one code path for loading
   * combinations rather than two that could disagree — the same reasoning `productPayload`
   * applies to SKUs.
   */
  async function skuPayload(store: RequestStore, record: SkuRecord) {
    const optionsBySku = await skuOptions(store, [record]);
    return toSkuResponse(record, optionsBySku.get(record.id));
  }

  /**
   * Combination rows for a set of SKUs, keyed by SKU id — ONE query for all of them.
   *
   * Extracted so the detail read and the list read cannot diverge, and so the N+1 is closed in
   * exactly one place. A 20-product page can carry 100 SKUs; loading each SKU's options
   * separately would be 100 round trips that pass every test and only surface under load.
   *
   * Returns an empty map for an empty SKU list without querying — the repository guards that
   * too, but not issuing the call at all keeps a product with no visible SKUs at two queries.
   */
  async function skuOptions(
    store: RequestStore,
    skus: readonly { id: string }[],
  ): Promise<Map<string, SkuOptionRecord[]>> {
    if (skus.length === 0) return new Map();

    const rows = await catalogue.getOptionsForSkus({
      storeId: store.id,
      skuIds: skus.map((record) => record.id),
    });

    return groupOptionsBySku(rows);
  }

  /**
   * A page of products plus their SKUs, in ONE extra query.
   *
   * The whole page's product ids go into a single `inArray`, so a 20-item page costs two
   * queries rather than twenty-one. A per-product load inside the mapper would be an N+1 that
   * passes every test and only shows up under load.
   */
  async function productListPayload(
    store: RequestStore,
    page: { items: readonly ProductRecord[]; total: number; limit: number; offset: number },
    activeOnly: boolean,
  ): Promise<ProductListResponse> {
    const skus = await catalogue.getSkusForProducts({
      storeId: store.id,
      productIds: page.items.map((item) => item.id),
      activeOnly,
    });

    return toProductListResponse(
      page,
      store.currency,
      groupSkusByProduct(skus),
      await skuOptions(store, skus),
    );
  }

  /**
   * POST /admin/products
   *
   * 201 with the created product. The first production consumer of `requireScope`.
   *
   * Middleware order is load-bearing:
   *
   *   resolveStore (API router)  ->  requireAuth  ->  requireScope('staff')  ->  validate  ->  handler
   *
   *  - `requireAuth` before `requireScope`, because the guard reads `req.user` to know whose
   *    privileges to look up. Mounting them the other way round is a 500, not a 403.
   *  - `requireScope` before `validate`, so an unprivileged caller cannot use validation error
   *    messages to probe the shape of an admin endpoint they may not use. The authorization
   *    read is one indexed query; running it first costs nothing worth saving.
   *
   * Not rate limited, consistent with the other authenticated routes: the limiters guard
   * unauthenticated endpoints that run Argon2. This one needs both a valid signed token and a
   * staff privilege to reach at all.
   */
  router.post(
    '/admin/products',
    auth,
    requireStaff,
    validate({ body: CreateProductRequestSchema }),
    asyncHandler(async (req, res) => {
      // Throws an InvariantViolation (500) if mounted without `resolveStore` — a wiring bug,
      // which must not be reported as a client error.
      const store = requireStore(req);

      const product = await catalogue.createProduct({
        /**
         * From the RESOLVED store, never from the request.
         *
         * The DTO has no `storeId` field, so a client that sends one is rejected by strict
         * validation before reaching this line. Both defences matter: the schema makes the
         * field unreachable, and this makes the source unambiguous to a reader.
         */
        storeId: store.id,
        // Attributed to the token holder, for the audit entry the service writes.
        actor: staffActor(req),
        input: validatedBody<CreateProductRequest>(req),
      });

      /**
       * `toProductResponse` is an allowlist, so `storeId` and `deletedAt` cannot reach a
       * response even though the row carries them.
       *
       * Wrapped in `{ product }`, matching the `{ user }` envelope registration established.
       */
      res.status(201).json({ product: await productPayload(store, product, false) });
    }),
  );

  /**
   * POST /admin/products/bulk
   *
   * 200 with what moved. The list screen's select-all, in one request. Increment 58.
   *
   * ### Why one endpoint with an `action` rather than three
   *
   * The selection is the payload and the action is a property of the request, which is exactly
   * what a body is for. Three endpoints would triple the surface to guard and to document while
   * sharing every line of their validation, their tenancy and their transaction.
   *
   * It does NOT widen the lifecycle: `publish`, `archive` and `delete` are the same three the
   * single-product routes expose, enforced by the same transition table. There is no bulk action
   * that can do something an individual action cannot.
   *
   * ### All or nothing
   *
   * An unknown slug, another store's slug, a soft-deleted one, or a product that cannot make the
   * requested transition refuses the ENTIRE batch — `404` naming the missing slugs, or `409`
   * naming the ones in the wrong status. Nothing is applied. A partial success would leave an
   * operator guessing which half of their selection moved.
   *
   * ### Route shape
   *
   * `/admin/products/bulk` is two segments and `POST /admin/products` is two segments with no
   * trailing parameter, so Express cannot confuse them; there is no `POST /admin/products/:slug`
   * for it to shadow either. The lifecycle actions live one segment deeper.
   *
   * Failure modes: `400` for an unknown field, an empty or oversized selection, a malformed slug
   * or an action outside the three; `401` unauthenticated; `403` without the `staff` scope;
   * `404` for slugs this store does not have; `409` for an illegal transition.
   */
  router.post(
    '/admin/products/bulk',
    auth,
    requireStaff,
    validate({ body: BulkProductActionRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      const body = validatedBody<BulkProductActionRequest>(req);

      const result = await catalogue.bulkProductAction({
        storeId: store.id,
        slugs: body.slugs,
        action: body.action,
        actor: staffActor(req),
      });

      res.status(200).json(result);
    }),
  );

  /**
   * GET /products
   *
   * 200 with a page of this store's PUBLISHED products, newest first.
   *
   * PUBLIC, like `GET /products/:slug` and for the same reason: a storefront and a crawler must
   * both be able to browse a catalogue, and neither can hold a token. Everything returned is
   * what the merchant chose to publish.
   *
   *   resolveStore (API router)  ->  validate(query)  ->  handler
   *
   * Registered BEFORE `/products/:slug` for readability only — Express cannot confuse them,
   * since `/products` has no second segment to bind.
   *
   * Reuses the admin list's query schema and response mapper unchanged. One pagination contract
   * for the whole API (§28) means a client learns `limit`/`offset`/`total` once; a separate
   * public shape would be a second contract to document and keep in step.
   */
  router.get(
    '/products',
    /**
     * The PUBLIC schema — the admin list keeps the narrower one and still rejects `q`,
     * `price_min`, and `price_max`.
     *
     * It also enforces `price_min <= price_max`, so a reversed range is a 400 here and the
     * handler below never sees an impossible request.
     */
    validate({ query: PublicListProductsQuerySchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      const query = validatedQuery<PublicListProductsQuery>(req);
      const { limit, offset, q } = query;

      const page = await catalogue.getPublicProducts({
        storeId: store.id,
        limit,
        offset,
        /**
         * Spread rather than `search: q`. `exactOptionalPropertyTypes` is on, so passing an
         * explicit `undefined` to an optional property is a type error — and the distinction is
         * real here: "no filter" must leave the query untouched, not add an empty predicate.
         *
         * The same applies to both price bounds: absent means the predicate is not built at
         * all, which is what keeps the no-filter request byte-for-byte what it was.
         */
        ...(q === undefined ? {} : { search: q }),
        ...(query.price_min === undefined ? {} : { priceMin: query.price_min }),
        ...(query.price_max === undefined ? {} : { priceMax: query.price_max }),
      });

      res.status(200).json(await productListPayload(store, page, true));
    }),
  );

  /**
   * GET /products/:slug
   *
   * 200 with a publicly visible product, 404 for anything else.
   *
   * PUBLIC. No `requireAuth`, no `requireScope`, and that is the correct contract rather than
   * an omission: a storefront catalogue must be readable by an anonymous visitor and by a
   * search-engine crawler, neither of which can hold a token. Requiring one would not add
   * security — the data returned is exactly what the merchant chose to publish — it would only
   * make the catalogue unreachable.
   *
   *   resolveStore (API router)  ->  validate(params)  ->  handler
   *
   * `resolveStore` still runs, mounted on the API router by the composition root. It is what
   * makes this endpoint multi-tenant: the same slug resolves to a different product, or to
   * nothing at all, depending on which store the request resolved to.
   *
   * Not rate limited, consistent with the rest of the API: the limiters guard unauthenticated
   * endpoints that run Argon2. This is one indexed read.
   */
  router.get(
    '/products/:slug',
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const product = await catalogue.getPublicProduct({
        // From the RESOLVED store. There is no request-controlled way to read another
        // store's catalogue, because the store is never taken from the path or the query.
        storeId: store.id,
        // Reads `req.validated.params`, never `req.params`: the raw value has not been
        // normalised, and the two are kept apart precisely so that is visible.
        slug: validatedParams<ProductSlugParams>(req).slug,
      });

      res.status(200).json({ product: await productPayload(store, product, true) });
    }),
  );

  /**
   * Lifecycle actions.
   *
   * Explicit verbs rather than `PATCH .../status`, because the project has no `PATCH` or `PUT`
   * anywhere and expresses every state change as a POST action — `/auth/logout`, `/auth/refresh`.
   * It is also the smaller surface: no request body at all, and no way to express an unpublish,
   * since there is no endpoint for it. See `docs/DECISIONS.md` §26.
   *
   * Both share the create route's authorization boundary:
   *
   *   resolveStore -> requireAuth -> requireScope('staff') -> validate(params) -> handler
   */
  const lifecycle = (
    action: 'publish' | 'archive',
    apply: (params: { storeId: string; slug: string; actor: AuditActor }) => Promise<ProductRecord>,
  ): void => {
    router.post(
      `/admin/products/:slug/${action}`,
      auth,
      requireStaff,
      validate({ params: ProductSlugParamsSchema }),
      asyncHandler(async (req, res) => {
        const store = requireStore(req);

        const product = await apply({
          storeId: store.id,
          slug: validatedParams<ProductSlugParams>(req).slug,
          actor: staffActor(req),
        });

        res.status(200).json({ product: await productPayload(store, product, false) });
      }),
    );
  };

  /** `draft` or `archived` becomes `active`, making the product publicly readable. */
  lifecycle('publish', (params) => catalogue.publishProduct(params));

  /** `active` becomes `archived`, removing it from the storefront. */
  lifecycle('archive', (params) => catalogue.archiveProduct(params));

  /**
   * GET /admin/products/:slug
   *
   * 200 with a product in ANY lifecycle status — draft, active, or archived.
   *
   * The staff counterpart to the public read. Same slug, same store, same response shape; the
   * only difference is that a merchant may see their own unpublished work. Same authorization
   * boundary as every other admin product route.
   */
  router.get(
    '/admin/products/:slug',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const product = await catalogue.getProductForStaff({
        storeId: store.id,
        slug: validatedParams<ProductSlugParams>(req).slug,
      });

      res.status(200).json({ product: await productPayload(store, product, false) });
    }),
  );

  /**
   * GET /admin/products
   *
   * 200 with a page of this store's products in any lifecycle status, newest first.
   *
   * Registered BEFORE `/admin/products/:slug` is irrelevant here — the paths differ in depth,
   * so Express cannot confuse them — but the query schema is strict, so `?limitt=50` is a 400
   * rather than a silently-defaulted page.
   */
  router.get(
    '/admin/products',
    auth,
    requireStaff,
    validate({ query: AdminListProductsQuerySchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);
      const query = validatedQuery<AdminListProductsQuery>(req);

      const page = await catalogue.getProductsForStaff({
        storeId: store.id,
        limit: query.limit,
        offset: query.offset,
        filters: {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.stockState === undefined ? {} : { stockState: query.stockState }),
        },
      });

      res.status(200).json({
        ...(await productListPayload(store, page, false)),
        counts: page.counts,
      });
    }),
  );

  /**
   * PATCH /admin/products/:slug
   *
   * 200 with the persisted product. Edits `name`, `description`, and `price` only.
   *
   * The project's FIRST `PATCH`, and that is a deliberate departure rather than a reversal of
   * §26. That decision rejected `PATCH .../status` for the LIFECYCLE, because a state machine
   * expressed as a settable field cannot enforce which transitions are legal. This is ordinary
   * partial data editing, where PATCH is exactly the right verb: the fields are independent, any
   * subset may be sent, and there is no transition to guard. Lifecycle stays on its explicit
   * `publish` / `archive` actions, and `status` is not settable here at all.
   */
  router.patch(
    '/admin/products/:slug',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema, body: UpdateProductRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const product = await catalogue.updateProduct({
        storeId: store.id,
        slug: validatedParams<ProductSlugParams>(req).slug,
        actor: staffActor(req),
        input: validatedBody<UpdateProductRequest>(req),
      });

      res.status(200).json({ product: await productPayload(store, product, false) });
    }),
  );

  /**
   * DELETE /admin/products/:slug
   *
   * 204 No Content. The product is SOFT deleted — the row survives for order history and
   * invoices, and simply stops matching every catalogue query.
   *
   * No request body, and none is read: the slug identifies the product and there is nothing
   * else to decide. 204 rather than the product, matching logout — the only other endpoint in
   * the project with nothing useful to return. Returning a "product" that is invisible to every
   * other endpoint a moment later would be a strange thing to hand back.
   *
   * Deleting an already-deleted product is a 404, consistent with how every other catalogue
   * endpoint treats a deleted product.
   */
  router.delete(
    '/admin/products/:slug',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      await catalogue.deleteProduct({
        storeId: store.id,
        slug: validatedParams<ProductSlugParams>(req).slug,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  /**
   * POST /admin/products/:slug/skus
   *
   * 201 with the created SKU.
   *
   *   resolveStore  ->  requireAuth  ->  requireScope('staff')  ->  validate  ->  handler
   *
   * The parent product is addressed by SLUG in the path and resolved inside the authenticated
   * store. Neither `storeId` nor `productId` is a body field, so a caller cannot attach a SKU
   * to another merchant's product — and the service takes the store id from the product ROW
   * rather than from its own argument, so the two cannot disagree.
   *
   * NESTED under the product because this is the one SKU operation that needs a parent. The
   * item operations below are flat, because the partial unique index makes `code` identify a
   * SKU within a store on its own.
   */
  router.post(
    '/admin/products/:slug/skus',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema, body: CreateSkuRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const created = await catalogue.createSku({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
        // The store owns currency; neither the product nor the SKU table has such a column.
        currency: store.currency,
        actor: staffActor(req),
        input: validatedBody<CreateSkuRequest>(req),
      });

      res.status(201).json({ sku: await skuPayload(store, created) });
    }),
  );

  /**
   * GET /admin/products/:slug/skus
   *
   * 200 with every live SKU of the product — active AND inactive, because a merchant manages
   * both. The public product read shows only the active ones.
   *
   * UNPAGINATED, deliberately. The number of SKUs under one product is bounded by the variant
   * grid a merchant can plausibly maintain, and paginating a single product's variants would
   * make the admin view harder to use for no benefit. That is the same judgement §28 applied
   * to a bounded collection, and the opposite of the one it applied to products — which are
   * unbounded and therefore paged.
   */
  router.get(
    '/admin/products/:slug/skus',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const skus = await catalogue.getSkusForStaff({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
      });

      const optionsBySku = await skuOptions(store, skus);
      res
        .status(200)
        .json({ skus: skus.map((record) => toSkuResponse(record, optionsBySku.get(record.id))) });
    }),
  );

  /**
   * PATCH /admin/skus/:code
   *
   * 200 with the updated SKU. Editable: `name`, `price`, `isActive`.
   *
   * FLAT rather than nested under the product. `code` is unique per store, so the product adds
   * nothing to the lookup — and requiring it would let a caller pass a mismatched slug/code
   * pair whose behaviour would then have to be defined and tested for no gain.
   *
   * `isActive` is an ordinary field here, unlike `product.status`. Both of its transitions are
   * always legal, so there is no state machine to enforce and no illegal transition to reject;
   * that is exactly the reasoning §26 used to make product status an explicit action instead.
   */
  router.patch(
    '/admin/skus/:code',
    auth,
    requireStaff,
    validate({ params: SkuCodeParamsSchema, body: UpdateSkuRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const updated = await catalogue.updateSku({
        storeId: store.id,
        code: validatedParams<SkuCodeParams>(req).code,
        currency: store.currency,
        actor: staffActor(req),
        input: validatedBody<UpdateSkuRequest>(req),
      });

      res.status(200).json({ sku: await skuPayload(store, updated) });
    }),
  );

  /**
   * DELETE /admin/skus/:code
   *
   * 204 No Content. The SKU is SOFT deleted — order lines will reference SKUs, and the row has
   * to survive for that history.
   *
   * Deleting frees the merchant code for reuse through the partial unique index. Deleting an
   * already-deleted SKU is a 404, matching `DELETE /admin/products/:slug`: a `PATCH` on a
   * deleted SKU answers 404, so a `DELETE` answering 204 would contradict the very next
   * request about the same code.
   */
  router.delete(
    '/admin/skus/:code',
    auth,
    requireStaff,
    validate({ params: SkuCodeParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      await catalogue.deleteSku({
        storeId: store.id,
        code: validatedParams<SkuCodeParams>(req).code,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  /* ── Variant options ───────────────────────────────────────────────────── */

  /**
   * POST /admin/products/:slug/options
   *
   * 201 with the created option and its (empty) value list.
   *
   * Nested under the product because an option BELONGS to one product and cannot be created
   * without it — the same shape as SKU creation. The later per-option routes are flat, for the
   * reason given on `PATCH /admin/options/:id`.
   *
   * `409 OPTION_NAME_TAKEN` if the product already has this name, compared case-insensitively
   * by the `lower(name)` unique index. `400` if the product is already at the option cap.
   */
  router.post(
    '/admin/products/:slug/options',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema, body: CreateOptionRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const created = await catalogue.createOption({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
        actor: staffActor(req),
        input: validatedBody<CreateOptionRequest>(req),
      });

      // A new option has no values yet, so the nested array is empty rather than absent.
      res.status(201).json({ option: toOptionResponse(created) });
    }),
  );

  /**
   * GET /admin/products/:slug/options
   *
   * 200 with the product's options, each carrying its values NESTED.
   *
   * There is deliberately no separate `GET /admin/options/:id/values`: one shape means one
   * parser, and a second endpoint returning the same rows would be a second place for their
   * order to be decided. Values arrive from one batched query for every option on the product.
   *
   * UNPAGINATED, for the same reason the SKU list is: a variant grid is bounded by what a
   * merchant can plausibly maintain, and the caps make that explicit.
   */
  router.get(
    '/admin/products/:slug/options',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const { options, values } = await catalogue.getOptionsForStaff({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
      });

      const byOption = groupValuesByOption(values);

      res.status(200).json({
        options: options.map((option) => toOptionResponse(option, byOption.get(option.id) ?? [])),
      });
    }),
  );

  /**
   * PATCH /admin/options/:id
   *
   * 200 with the updated option. Editable: `name`, `sortOrder`.
   *
   * FLAT rather than nested under the product, matching `PATCH /admin/skus/:code`: the id is
   * already globally unique, so the product adds nothing to the lookup, and requiring it would
   * admit a mismatched slug/id pair whose behaviour would then need defining and testing for
   * no gain.
   *
   * The id is a UUID rather than a merchant-facing code, because an option has no such code —
   * so this is the first UUID path parameter in the project, and a malformed one is a `400`
   * from `OptionIdParamsSchema` rather than a PostgreSQL syntax error surfacing as a 500.
   *
   * `productId` is NOT editable: moving an option between products would orphan every SKU
   * combination referring to it, and the composite foreign keys would reject the result anyway.
   */
  router.patch(
    '/admin/options/:id',
    auth,
    requireStaff,
    validate({ params: OptionIdParamsSchema, body: UpdateOptionRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const updated = await catalogue.updateOption({
        storeId: store.id,
        id: validatedParams<OptionIdParams>(req).id,
        actor: staffActor(req),
        input: validatedBody<UpdateOptionRequest>(req),
      });

      res.status(200).json({ option: toOptionResponse(updated) });
    }),
  );

  /**
   * DELETE /admin/options/:id
   *
   * 204, and the option's values are soft-deleted with it in the same transaction.
   *
   * `409 OPTION_IN_USE` — naming the blocking SKU codes — while any LIVE SKU still uses one of
   * its values. That refusal is the whole of the approved lifecycle decision: soft-deleting a
   * value a live SKU references would leave that SKU's signature pointing at a retired row, so
   * the public response would show a partial combination and re-creating the value would mint
   * a new id that `uq_sku_combination` could no longer collide.
   *
   * A SKU that is itself already deleted never blocks anything, which is what makes retiring
   * an option possible at all once its variants are gone.
   */
  router.delete(
    '/admin/options/:id',
    auth,
    requireStaff,
    validate({ params: OptionIdParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      await catalogue.deleteOption({
        storeId: store.id,
        id: validatedParams<OptionIdParams>(req).id,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  /**
   * POST /admin/options/:id/values
   *
   * 201 with the created value. `409 OPTION_VALUE_TAKEN` on a case-insensitive duplicate
   * within the option; `400` at the per-option cap.
   *
   * The value's `product_id` is copied from the OPTION row, never from the request — which is
   * what makes `fk_pov_option_product` unfalsifiable rather than merely enforced.
   */
  router.post(
    '/admin/options/:id/values',
    auth,
    requireStaff,
    validate({ params: OptionIdParamsSchema, body: CreateOptionValueRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const created = await catalogue.createOptionValue({
        storeId: store.id,
        optionId: validatedParams<OptionIdParams>(req).id,
        actor: staffActor(req),
        input: validatedBody<CreateOptionValueRequest>(req),
      });

      res.status(201).json({ value: toOptionValueResponse(created) });
    }),
  );

  /**
   * PATCH /admin/option-values/:id
   *
   * 200 with the updated value. Editable: `value`, `sortOrder`.
   *
   * Renaming does NOT change any SKU's signature — the signature is built from ids precisely
   * so that fixing a typo cannot silently redefine which variant a SKU represents.
   *
   * `optionId` is not editable: moving a value between options would change what every SKU
   * using it means, and `uq_sov_sku_option` could then be violated by rows already committed.
   */
  router.patch(
    '/admin/option-values/:id',
    auth,
    requireStaff,
    validate({ params: OptionIdParamsSchema, body: UpdateOptionValueRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const updated = await catalogue.updateOptionValue({
        storeId: store.id,
        id: validatedParams<OptionIdParams>(req).id,
        actor: staffActor(req),
        input: validatedBody<UpdateOptionValueRequest>(req),
      });

      res.status(200).json({ value: toOptionValueResponse(updated) });
    }),
  );

  /** DELETE /admin/option-values/:id — 204, or 409 while a live SKU uses it. */
  router.delete(
    '/admin/option-values/:id',
    auth,
    requireStaff,
    validate({ params: OptionIdParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      await catalogue.deleteOptionValue({
        storeId: store.id,
        id: validatedParams<OptionIdParams>(req).id,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  /**
   * PUT /admin/skus/:code/options
   *
   * 200 with the full updated SKU, so the caller sees the combination the server stored rather
   * than the one it sent.
   *
   * `PUT`, and a separate route from `PATCH /admin/skus/:code`, for three reasons:
   *
   *  - the semantics are REPLACEMENT, and the method says so;
   *  - that PATCH is documented as writing `name`, `price` and `isActive`, and its
   *    `strictObject` makes anything else a 400 — folding options in would change a published
   *    contract;
   *  - the two have different failure modes. A scalar edit cannot produce a duplicate-
   *    combination conflict, and one endpoint carrying both concurrency stories would be
   *    harder to document and to test than two that each carry one.
   *
   * `optionValueIds: []` removes every option. The field is REQUIRED even so: clearing a
   * combination is a deliberate act and must be stated, not achieved by omitting a field.
   *
   * Failure modes: `400` for an id that is not a selectable value of this SKU's product —
   * unknown, another product's, another store's, deleted, or belonging to a deleted option, all
   * indistinguishable on purpose; `409 SKU_OPTION_CONFLICT` for two values of one option;
   * `409 SKU_COMBINATION_TAKEN` when another live SKU of the product already has this exact
   * combination, decided by `uq_sku_combination` rather than by the pre-check in front of it.
   */
  router.put(
    '/admin/skus/:code/options',
    auth,
    requireStaff,
    validate({ params: SkuCodeParamsSchema, body: ReplaceSkuOptionsRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const updated = await catalogue.replaceSkuOptions({
        storeId: store.id,
        code: validatedParams<SkuCodeParams>(req).code,
        actor: staffActor(req),
        input: validatedBody<ReplaceSkuOptionsRequest>(req),
      });

      res.status(200).json({ sku: await skuPayload(store, updated) });
    }),
  );

  /* ── Product media. Increment 58. ──────────────────────────────────────── */

  /**
   * One image on the wire, with its variant's CODE rather than its id.
   *
   * Goes through the same batch resolver a gallery uses, with a single record, so there is one
   * code path for turning SKU ids into codes rather than two that could disagree.
   */
  async function mediaPayload(store: RequestStore, records: readonly MediaRecord[]) {
    const skuIds = records.map((record) => record.skuId).filter((id): id is string => id !== null);

    const codes = await catalogue.getSkuCodesByIds({ storeId: store.id, skuIds });

    return records.map((record) =>
      toMediaResponse(
        record,
        (key) => catalogue.mediaPublicUrl(key),
        record.skuId === null ? null : (codes.get(record.skuId) ?? null),
      ),
    );
  }

  /**
   * POST /admin/products/:slug/media
   *
   * 201 with the registered image.
   *
   * **The bytes are already in the bucket.** This records the pointer and the metadata needed to
   * render the image; the upload itself goes straight from the browser to storage, so a
   * multi-megabyte binary never travels through this API. `POST .../media/upload-target` below
   * is how a client learns where to send it.
   *
   * Failure modes: `400` for an unknown field, a malformed storage key, a content type outside
   * the renderable set, or half a dimension pair; `401` unauthenticated; `403` without the
   * `staff` scope; `404` for an unknown product and for a `skuCode` that is not one of ITS
   * variants — indistinguishable, because a code belonging to another product is not this
   * product's variant whatever else is true of it; `409` when the object is already registered.
   */
  router.post(
    '/admin/products/:slug/media',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema, body: CreateMediaRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const record = await catalogue.addProductMedia({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
        actor: staffActor(req),
        input: validatedBody<CreateMediaRequest>(req),
      });

      const [payload] = await mediaPayload(store, [record]);
      res.status(201).json({ media: payload });
    }),
  );

  /**
   * GET /admin/products/:slug/media
   *
   * 200 with the product's gallery, in the merchant's order.
   *
   * Unpaginated, deliberately: a product's gallery is a handful of images, bounded by what a
   * merchant will upload for one listing. Paginating it would add a contract for no benefit and
   * make the ordering harder to reason about. `404` for an unknown product — an empty array
   * means a product with no images, which is a different fact.
   */
  router.get(
    '/admin/products/:slug/media',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const records = await catalogue.getProductMedia({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
      });

      res.status(200).json({ media: await mediaPayload(store, records) });
    }),
  );

  /**
   * POST /admin/products/:slug/media/upload-target
   *
   * 200 with a pre-signed target, or `503` when this deployment has no object storage.
   *
   * Registered AFTER `POST /admin/products/:slug/media` for readability only — the paths differ
   * in depth, so Express cannot confuse them.
   *
   * **`503` is the honest answer, not a bug.** This project has no S3 SDK, so nothing can sign a
   * `PUT`; the composition root wires an adapter that refuses rather than one that invents a URL.
   * Everything around the upload — registration, the gallery, ordering, the primary flag,
   * deletion — works without it, and swapping in a real adapter touches no domain module.
   */
  router.post(
    '/admin/products/:slug/media/upload-target',
    auth,
    requireStaff,
    validate({ params: ProductSlugParamsSchema, body: CreateUploadTargetRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const target = await catalogue.createMediaUploadTarget({
        storeId: store.id,
        productSlug: validatedParams<ProductSlugParams>(req).slug,
        input: validatedBody<CreateUploadTargetRequest>(req),
      });

      res.status(200).json({
        upload: {
          uploadUrl: target.uploadUrl,
          storageKey: target.storageKey,
          expiresAt: target.expiresAt.toISOString(),
          requiredHeaders: target.requiredHeaders,
        },
      });
    }),
  );

  /**
   * PATCH /admin/media/:id
   *
   * 200 with the updated image. Edits alt text, gallery position, and the primary flag.
   *
   * Addressed by media id rather than nested under the product, matching `PATCH /admin/skus/:code`
   * and `PATCH /admin/options/:id`: the id identifies the row within a store, and requiring the
   * product too would let a caller pass a mismatched pair whose behaviour would then need
   * defining.
   *
   * Promoting a primary demotes the previous one in the same transaction, so the product is never
   * left with two or with none. `storageKey`, `productId` and `skuCode` are not editable —
   * repointing an image is a delete plus a create, not an edit.
   *
   * Failure modes: `400` for a malformed id, an unknown field, or an empty body; `401`; `403`;
   * `404` for an unknown, deleted, or another store's image — all indistinguishable.
   */
  router.patch(
    '/admin/media/:id',
    auth,
    requireStaff,
    validate({ params: MediaIdParamsSchema, body: UpdateMediaRequestSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      const record = await catalogue.updateProductMedia({
        storeId: store.id,
        mediaId: validatedParams<MediaIdParams>(req).id,
        actor: staffActor(req),
        input: validatedBody<UpdateMediaRequest>(req),
      });

      const [payload] = await mediaPayload(store, [record]);
      res.status(200).json({ media: payload });
    }),
  );

  /**
   * DELETE /admin/media/:id
   *
   * 204. Soft-deleted, so the storage object keeps a row saying it should be reclaimed.
   *
   * Removing a primary leaves the product with no primary rather than promoting a successor:
   * which image represents a product is a merchandising decision, and choosing one for the
   * merchant would be inventing a rule the screen does not express.
   *
   * `404` for an unknown, already-deleted, or another store's image — so a repeated delete is a
   * `404` rather than a silent success that contradicts the next read.
   */
  router.delete(
    '/admin/media/:id',
    auth,
    requireStaff,
    validate({ params: MediaIdParamsSchema }),
    asyncHandler(async (req, res) => {
      const store = requireStore(req);

      await catalogue.deleteProductMedia({
        storeId: store.id,
        mediaId: validatedParams<MediaIdParams>(req).id,
        actor: staffActor(req),
      });

      res.status(204).send();
    }),
  );

  return router;
}
