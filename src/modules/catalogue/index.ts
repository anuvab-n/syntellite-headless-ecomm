/**
 * The catalogue module's public surface.
 *
 * The composition root uses these; nothing else should. In particular the repository's table
 * import and the DTO internals are NOT exported — a caller that wants a product asks the
 * service, and nothing outside this module names the `product` table.
 *
 * Deliberately small. This increment creates products and does nothing else: reads, updates,
 * variants, inventory, categories, and media are all later increments, and exporting a surface
 * ahead of them would be guessing at their shape.
 */

export {
  createCatalogueService,
  PRODUCT_TRANSITIONS,
  ProductSlugTaken,
  type CatalogueService,
} from './catalogue.service.js';
export {
  createCatalogueRepository,
  escapeLikePattern,
  PRODUCT_SLUG_UNIQUE_CONSTRAINT,
  PUBLIC_PRODUCT_STATUS,
  PRODUCT_STATUSES,
  type CatalogueRepository,
  type EditableProductFields,
  type ProductRecord,
  type ProductStatus,
} from './catalogue.repository.js';
export { createCatalogueRoutes } from './catalogue.routes.js';
export {
  CreateProductRequestSchema,
  ListProductsQuerySchema,
  PRODUCT_LIST_DEFAULT_LIMIT,
  PRODUCT_LIST_MAX_LIMIT,
  ProductSlugParamsSchema,
  PublicListProductsQuerySchema,
  UpdateProductRequestSchema,
  toProductListResponse,
  toProductResponse,
  type CreateProductRequest,
  type ListProductsQuery,
  type PaginationResponse,
  type ProductListResponse,
  type ProductResponse,
  type ProductSlugParams,
  type PublicListProductsQuery,
  type UpdateProductRequest,
} from './dto.js';
