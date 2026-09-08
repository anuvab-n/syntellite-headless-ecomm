/**
 * The fulfilment module's public surface.
 *
 * Everything another module or the composition root may name. The service's PORTS are exported
 * as types so `container.ts` can adapt other modules onto them, and the state predicates are
 * exported because the orders module's cancellation guard reasons about them through a port.
 *
 * Deliberately absent: the repository's table imports, `SHIPMENT_COLUMNS`, and the DTO mappers.
 * Nothing outside this module needs to know how a shipment is stored or serialised.
 */

export {
  createFulfilmentService,
  OrderNotFulfillable,
  ShipmentAlreadyExists,
  ShipmentNotTransitionable,
  type FulfilmentInventory,
  type FulfilmentOrders,
  type FulfilmentPayments,
  type FulfilmentService,
  type FulfillableOrder,
  type ShipmentView,
} from './fulfilment.service.js';

export {
  createFulfilmentRepository,
  FULFILMENT_BLOCKING_STATUSES,
  INITIAL_SHIPMENT_STATUS,
  SHIPMENT_STATUSES,
  type FulfilmentRepository,
  type ShipmentRecord,
  type ShipmentStatus,
} from './fulfilment.repository.js';

export { canTransition, hasLeftFulfilment, isTerminal } from './shipment.state.js';

export { createFulfilmentRoutes } from './fulfilment.routes.js';

export { SHIPMENT_AUDIT, SHIPMENT_RESOURCE } from './fulfilment.events.js';
