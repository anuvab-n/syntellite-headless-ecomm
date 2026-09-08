import type { ShipmentStatus } from './fulfilment.repository.js';

/**
 * The shipment lifecycle, as a pure transition table.
 *
 * No I/O, no database, no clock — so it is unit-testable without a container, exactly like
 * `payments.state.ts`, which this mirrors deliberately. The table IS the rule; nothing else in
 * the module decides what may follow what.
 *
 *     pending -> shipped -> delivered
 *
 * `pending` is the only state with more than zero successors, and the chain is linear: there is
 * no branch, no undo and no way back. A shipment that should not have existed is corrected by
 * cancelling the order before it ships, not by a reverse transition — returns are out of scope,
 * and a `returned` state with nothing able to produce it would look supported to every reader of
 * the enum.
 *
 * `delivered` is absorbing. `shipped` has exactly one successor, which makes it terminal in the
 * sense that matters here: nothing moves backward, and no second stock movement can be provoked
 * from it.
 */
const TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  pending: ['shipped'],
  shipped: ['delivered'],
  delivered: [],
};

/** Whether `from -> to` is legal. The only place that question is answered. */
export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Whether nothing can follow this state.
 *
 * Only `delivered`. Note this is NOT the same question as "has fulfilment finished" — a
 * `shipped` shipment has finished moving stock but can still be delivered — so callers that
 * care about the stock movement ask about `shipped` explicitly rather than using this.
 */
export function isTerminal(status: ShipmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Whether the goods have physically left, and therefore whether the order's stock has moved.
 *
 * The predicate the cancellation guard needs: `shipped` and `delivered` both mean stock left
 * the building and cancelling would require a return. `pending` does not — nothing has moved,
 * so a customer may still cancel, and the pending shipment is left behind as an operational
 * fact that can never ship because the ship path refuses a cancelled order.
 */
export function hasLeftFulfilment(status: ShipmentStatus): boolean {
  return status === 'shipped' || status === 'delivered';
}
