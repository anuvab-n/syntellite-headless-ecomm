/**
 * The addresses module's public surface.
 *
 * The composition root uses these; nothing else should. In particular the repository's table
 * import and the DTO internals are NOT exported — a caller that wants an address asks the
 * service, and nothing outside this module names the `address` table.
 *
 * Deliberately small. This increment creates, lists, reads, updates and soft-deletes a
 * customer's own addresses. Default shipping/billing addresses, order snapshotting, customer
 * tax identity, staff access and address verification are all later increments, and exporting
 * a surface ahead of them would be guessing at their shape.
 */

export { createAddressesService, type AddressesService } from './addresses.service.js';
export {
  createAddressesRepository,
  type AddressesRepository,
  type AddressRecord,
} from './addresses.repository.js';
export { createAddressesRoutes } from './addresses.routes.js';
export { ADDRESS_AUDIT, ADDRESS_RESOURCE } from './addresses.events.js';
