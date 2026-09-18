/**
 * The payments module's public surface.
 *
 * The composition root uses these; nothing else should. The repository's table imports and the
 * DTO internals are NOT exported — a caller that wants a payment asks the service, and nothing
 * outside this module names `payment` or `payment_event`.
 *
 * The four PORT types are exported because the composition root adapts the orders service, the
 * provider gateway and the idempotency store onto them. Those never import from here: payments
 * declares the shapes it needs and structural typing does the rest, so no module names another
 * and `no-cross-module-imports` is satisfied by construction rather than by an exception.
 *
 * Deliberately small. This increment creates a payment for an order, reads it back, and applies
 * a verified provider notification to it. Refunds, retries, reconciliation, settlements,
 * disputes and admin payment management are all out of the approved scope, and exporting a
 * surface ahead of them would be guessing at their shape.
 */

export {
  createPaymentsService,
  OrderNotPayable,
  PaymentAlreadyExists,
  type PaymentsService,
  type PaymentView,
  type PaymentHandoff,
  type PayableOrder,
  type PaymentOrders,
  type PaymentGateway,
  type PaymentIdempotency,
} from './payments.service.js';
export {
  createPaymentsRepository,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type PaymentsRepository,
  type PaymentRecord,
  type PaymentEventRecord,
  type PaymentMethod,
  type PaymentStatus,
} from './payments.repository.js';
export { createPaymentsRoutes } from './payments.routes.js';
export { createPaymentsWebhookRoutes } from './payments.webhook.routes.js';
export { canTransition, isTerminal } from './payments.state.js';
export { PAYMENT_AUDIT, PAYMENT_RESOURCE } from './payments.events.js';
export {
  createPaymentExpirySweeper,
  type PaymentExpirySweeper,
  type SweepResult,
} from './payments.sweeper.js';

/* ── Refunds. Increment 59. ────────────────────────────────────────────── */

export {
  createRefundsRepository,
  REFUND_MODES,
  REFUND_STATUSES,
  BALANCE_CONSUMING_REFUND_STATUSES,
  type RefundMode,
  type RefundRecord,
  type RefundsRepository,
  type RefundStatus,
} from './refunds.repository.js';

export {
  createRefundsService,
  generateRefundNumber,
  PaymentNotRefundable,
  RefundAlreadyRaised,
  RefundExceedsBalance,
  RefundNotSettleable,
  type RefundBalanceView,
  type RefundExecutor,
  type RefundsService,
} from './refunds.service.js';

export { REFUND_AUDIT, REFUND_RESOURCE, type RefundAuditAction } from './refunds.events.js';
