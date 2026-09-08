import { describe, expect, it } from 'vitest';

import { SHIPMENT_STATUSES, type ShipmentStatus } from '../fulfilment.repository.js';
import { canTransition, hasLeftFulfilment, isTerminal } from '../shipment.state.js';

/**
 * The shipment transition table, tested as a pure function.
 *
 * No database, no container, no clock — the same shape as `payments.state.test.ts`. The table is
 * the authority on what may follow what, so every legal transition and every illegal one is
 * enumerated rather than sampled: a mutation that widened the table would otherwise survive.
 */
describe('shipment state', () => {
  /** Every ordered pair, so nothing is left unexamined. */
  const allPairs = SHIPMENT_STATUSES.flatMap((from) =>
    SHIPMENT_STATUSES.map((to) => [from, to] as const),
  );

  const LEGAL: readonly (readonly [ShipmentStatus, ShipmentStatus])[] = [
    ['pending', 'shipped'],
    ['shipped', 'delivered'],
  ];

  it('has exactly three states', () => {
    expect([...SHIPMENT_STATUSES]).toEqual(['pending', 'shipped', 'delivered']);
  });

  it('allows pending to shipped', () => {
    expect(canTransition('pending', 'shipped')).toBe(true);
  });

  it('allows shipped to delivered', () => {
    expect(canTransition('shipped', 'delivered')).toBe(true);
  });

  /**
   * The exhaustive half, and the one that matters most.
   *
   * Everything not in `LEGAL` must be refused — including every self-transition, which the
   * `ck_shipment_event_progresses` CHECK also refuses at the database, and every backward move,
   * because undoing a shipment means a return and returns are out of scope.
   */
  it('refuses every other pair, including self-transitions and reversals', () => {
    const illegal = allPairs.filter(
      ([from, to]) => !LEGAL.some(([lf, lt]) => lf === from && lt === to),
    );

    /* 9 pairs total, 2 legal, so 7 must be refused. */
    expect(illegal).toHaveLength(7);
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} -> ${to} must be illegal`).toBe(false);
    }
  });

  it('refuses to skip pending straight to delivered', () => {
    /* Called out separately because it is the mistake a client would actually make. */
    expect(canTransition('pending', 'delivered')).toBe(false);
  });

  it('treats delivered as the only absorbing state', () => {
    expect(isTerminal('delivered')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('shipped')).toBe(false);
  });

  /**
   * The predicate the cancellation guard uses.
   *
   * `pending` deliberately does NOT block cancellation: nothing has moved, so a customer may
   * still cancel an order a staff member has merely started picking.
   */
  describe('hasLeftFulfilment', () => {
    it('is true once goods have gone', () => {
      expect(hasLeftFulfilment('shipped')).toBe(true);
      expect(hasLeftFulfilment('delivered')).toBe(true);
    });

    it('is false while the shipment is only pending', () => {
      expect(hasLeftFulfilment('pending')).toBe(false);
    });
  });
});
