import { describe, expect, it } from 'vitest';

import { PAYMENT_STATUSES, type PaymentStatus } from '../../../db/schema/payments.js';
import { canTransition, isTerminal } from '../payments.state.js';

/**
 * The payment state machine.
 *
 * No database, because the machine is a pure function and the approved lifecycle is a business
 * rule rather than a persistence concern. This file IS the executable statement of that rule:
 * if the approved lifecycle changes, this is the test that should fail first.
 *
 * The exhaustive sweep matters more than the individual cases. A hand-written list of forbidden
 * transitions tests only the ones somebody thought of; enumerating all sixteen pairs and
 * asserting the complete allowed set means a transition accidentally opened up — by a typo in
 * the table, or by a later edit — fails here rather than in production.
 */
describe('payment state machine', () => {
  /** The approved lifecycle, restated independently of the implementation. */
  const APPROVED_TRANSITIONS: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
    ['pending', 'succeeded'],
    ['pending', 'failed'],
    ['pending', 'expired'],
  ];

  it('has exactly the four approved states', () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual(['expired', 'failed', 'pending', 'succeeded']);
  });

  it('allows exactly the approved transitions and nothing else', () => {
    const allowed: Array<[PaymentStatus, PaymentStatus]> = [];

    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        if (canTransition(from, to)) allowed.push([from, to]);
      }
    }

    expect(allowed.sort()).toEqual([...APPROVED_TRANSITIONS].sort());
  });

  it('treats pending as the only non-terminal state', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
  });

  /**
   * Spelled out individually as well as swept above.
   *
   * The sweep proves the SET is right; these name the specific regressions the approved scope
   * calls out, so a failure reads as "failed cannot become succeeded" rather than as a diff of
   * two sorted arrays.
   */
  describe('terminal states never regress', () => {
    it('forbids succeeded -> failed', () => {
      expect(canTransition('succeeded', 'failed')).toBe(false);
    });

    it('forbids succeeded -> expired', () => {
      expect(canTransition('succeeded', 'expired')).toBe(false);
    });

    it('forbids failed -> succeeded (no retry in this increment)', () => {
      expect(canTransition('failed', 'succeeded')).toBe(false);
    });

    it('forbids failed -> expired', () => {
      expect(canTransition('failed', 'expired')).toBe(false);
    });

    it('forbids expired -> succeeded', () => {
      expect(canTransition('expired', 'succeeded')).toBe(false);
    });

    it('forbids expired -> failed', () => {
      expect(canTransition('expired', 'failed')).toBe(false);
    });
  });

  /**
   * A transition to the state already held is not a transition.
   *
   * The database says the same thing in `ck_payment_event_progresses`, and both are needed: if
   * this returned true, a redelivered notification could append a history row recording that
   * nothing happened.
   */
  it('never allows a state to transition to itself', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});
