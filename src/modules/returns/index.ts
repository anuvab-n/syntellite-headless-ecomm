/**
 * The returns module's public surface.
 *
 * Everything the composition root needs to build and wire it, and nothing else. Repositories
 * stay unexported except for their factory: a caller that wants a return asks the service.
 */

export {
  apportionReturnLine,
  type ApportionedReturnLine,
  type ApportionInput,
  type FrozenOrderLine,
} from './return-apportionment.js';

export {
  createReturnsService,
  generateReturnNumber,
  OrderNotReturnable,
  ReturnNotTransitionable,
  ReturnQuantityUnavailable,
  RETURN_WINDOW_DAYS,
  type ReturnableOrder,
  type ReturnableOrderLine,
  type ReturnFulfilment,
  type ReturnIdempotency,
  type ReturnOrders,
  type ReturnsService,
  type ReturnView,
} from './returns.service.js';

export {
  createReturnsRepository,
  INITIAL_RETURN_STATUS,
  QUANTITY_CONSUMING_STATUSES,
  RETURN_REASONS,
  RETURN_STATUSES,
  type ReturnLineRecord,
  type ReturnRecord,
  type ReturnReason,
  type ReturnsRepository,
  type ReturnStatus,
} from './returns.repository.js';

export {
  canTransition,
  isCustomerCancellable,
  isTerminal,
  CUSTOMER_CANCELLABLE_STATUSES,
} from './return.state.js';

export { createReturnsRoutes } from './returns.routes.js';

export { RETURN_AUDIT, RETURN_RESOURCE, type ReturnActorType } from './returns.events.js';

export { toReturnResponse, type ReturnResponse } from './dto.js';
