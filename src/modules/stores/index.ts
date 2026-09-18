/**
 * The stores module's public surface.
 *
 * Minimal on purpose: Phase 1 needs exactly enough to resolve the one configured store.
 * Store CRUD, settings, and feature flags belong to Phase 2.
 */

export {
  createStoreRepository,
  type ResolvedStore,
  type StoreRepository,
} from './stores.repository.js';
export { createDefaultStoreResolver } from './stores.resolver.js';
export { createStoresService, type StoresService } from './stores.service.js';
export { createStoresRoutes } from './stores.routes.js';
export { STORE_AUDIT, STORE_RESOURCE } from './stores.events.js';
export type { StoreBusinessProfile } from './stores.repository.js';
