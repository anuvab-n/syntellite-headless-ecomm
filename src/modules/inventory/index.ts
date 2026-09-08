/**
 * The inventory module's public surface.
 *
 * The composition root uses these; nothing else should. In particular the repository's table
 * imports and the DTO internals are NOT exported — a caller that wants stock asks the service,
 * and nothing outside this module names `stock_item` or `stock_ledger`.
 *
 * Deliberately small. This increment reads stock, adjusts it, and reads its history.
 * Reservations, allocation, multi-location inventory and stock-based public availability are
 * all later increments, and exporting a surface ahead of them would be guessing at their shape.
 */

export {
  createInventoryService,
  InsufficientStock,
  NothingToFulfil,
  AlreadyFulfilled,
  type InventoryService,
} from './inventory.service.js';
export {
  createInventoryRepository,
  STOCK_REASONS,
  type InventoryRepository,
  type StockLedgerRecord,
  type StockRecord,
  type StockReason,
} from './inventory.repository.js';
export { createInventoryRoutes } from './inventory.routes.js';
export { STOCK_EVENTS, STOCK_AGGREGATE } from './inventory.events.js';
