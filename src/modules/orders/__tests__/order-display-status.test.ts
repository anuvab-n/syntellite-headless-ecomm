import { describe, expect, it } from 'vitest';

import {
  ORDER_DISPLAY_STATUSES,
  deriveOrderDisplayStatus,
  type OrderDisplayStatus,
} from '../order-display-status.js';

/**
 * §49's mapping table, as a test.
 *
 * The function is pure and its input space is finite, so this suite ENUMERATES it rather than
 * sampling it: every order status x every payment state x every shipment state, 40 combinations,
 * each with an expected answer written out by hand. A table-driven test that generated its own
 * expectations from the same precedence rules would pass for a function that had the rules
 * wrong — it would be the implementation, asserted against itself.
 *
 * The combinations that the rest of the system currently makes unreachable are included on
 * purpose. `requirePaymentPrerequisite` means a shipped order with a failed payment should not
 * arise today; the mapping still has to answer, and this is where that answer is pinned so a
 * change elsewhere cannot quietly redefine it.
 */

/** Every payment state, including the two absences. `null` is "no payment row at all". */
const PAYMENTS = [
  { label: 'no payment', value: null },
  { label: 'online pending', value: { status: 'pending', method: 'online' } },
  { label: 'cod pending', value: { status: 'pending', method: 'cod' } },
  { label: 'succeeded', value: { status: 'succeeded', method: 'online' } },
  { label: 'failed', value: { status: 'failed', method: 'online' } },
  { label: 'expired', value: { status: 'expired', method: 'online' } },
] as const;

const SHIPMENTS = [
  { label: 'no shipment', value: null },
  { label: 'pending', value: 'pending' },
  { label: 'shipped', value: 'shipped' },
  { label: 'delivered', value: 'delivered' },
] as const;

/**
 * The expected answer for every `placed` combination, written out rather than computed.
 *
 * Read down a column to see fulfilment overriding payment; read across a row to see the payment
 * rules that apply only when no shipment exists.
 */
const PLACED_EXPECTATIONS: Record<string, Record<string, OrderDisplayStatus>> = {
  'no payment': {
    'no shipment': 'pending',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
  'online pending': {
    'no shipment': 'pending',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
  'cod pending': {
    'no shipment': 'confirmed',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
  succeeded: {
    'no shipment': 'confirmed',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
  failed: {
    'no shipment': 'failed',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
  expired: {
    'no shipment': 'failed',
    pending: 'processing',
    shipped: 'shipped',
    delivered: 'delivered',
  },
};

describe('deriveOrderDisplayStatus', () => {
  describe('a placed order — all 24 combinations', () => {
    for (const payment of PAYMENTS) {
      for (const shipment of SHIPMENTS) {
        const expected = PLACED_EXPECTATIONS[payment.label]?.[shipment.label];

        it(`${payment.label} + ${shipment.label} -> ${expected}`, () => {
          expect(
            deriveOrderDisplayStatus({
              orderStatus: 'placed',
              payment: payment.value,
              shipmentStatus: shipment.value,
            }),
          ).toBe(expected);
        });
      }
    }
  });

  /**
   * Row 1 of the table, and the reason it is row 1: cancellation is a fact about the ORDER, so it
   * must win over every payment and shipment state — including the ones the rest of the system
   * currently prevents from coexisting with it.
   */
  describe('a cancelled order — all 24 combinations answer `cancelled`', () => {
    for (const payment of PAYMENTS) {
      for (const shipment of SHIPMENTS) {
        it(`${payment.label} + ${shipment.label}`, () => {
          expect(
            deriveOrderDisplayStatus({
              orderStatus: 'cancelled',
              payment: payment.value,
              shipmentStatus: shipment.value,
            }),
          ).toBe('cancelled');
        });
      }
    }
  });

  describe('precedence, stated as its own assertions', () => {
    it('fulfilment outranks payment: a delivered order with a failed payment is `delivered`', () => {
      expect(
        deriveOrderDisplayStatus({
          orderStatus: 'placed',
          payment: { status: 'failed', method: 'online' },
          shipmentStatus: 'delivered',
        }),
      ).toBe('delivered');
    });

    it('a pending shipment is `processing`, not `ready_to_ship` — no AWB exists to justify it', () => {
      expect(
        deriveOrderDisplayStatus({
          orderStatus: 'placed',
          payment: { status: 'succeeded', method: 'online' },
          shipmentStatus: 'pending',
        }),
      ).toBe('processing');
    });

    it('COD pending is `confirmed` but online pending is `pending` — the one business rule', () => {
      const cod = deriveOrderDisplayStatus({
        orderStatus: 'placed',
        payment: { status: 'pending', method: 'cod' },
        shipmentStatus: null,
      });
      const online = deriveOrderDisplayStatus({
        orderStatus: 'placed',
        payment: { status: 'pending', method: 'online' },
        shipmentStatus: null,
      });

      expect(cod).toBe('confirmed');
      expect(online).toBe('pending');
      expect(cod).not.toBe(online);
    });

    it('no payment row is `pending`, the same answer as an unpaid online payment', () => {
      expect(
        deriveOrderDisplayStatus({
          orderStatus: 'placed',
          payment: null,
          shipmentStatus: null,
        }),
      ).toBe('pending');
    });
  });

  describe('totality — an unrecognised input never throws and never leaves the enum', () => {
    /*
     * An admin list must not 500 because one row carries a status some later increment added. The
     * function is total by construction; these assert it rather than trusting the `else`.
     */
    it('an unknown payment status falls back to `pending`', () => {
      expect(
        deriveOrderDisplayStatus({
          orderStatus: 'placed',
          payment: { status: 'refunded', method: 'online' },
          shipmentStatus: null,
        }),
      ).toBe('pending');
    });

    it('an unknown shipment status is ignored rather than passed through', () => {
      const result = deriveOrderDisplayStatus({
        orderStatus: 'placed',
        payment: { status: 'succeeded', method: 'online' },
        shipmentStatus: 'out_for_delivery',
      });

      expect(result).toBe('confirmed');
      expect(ORDER_DISPLAY_STATUSES).toContain(result);
    });

    it('an unknown order status is treated as live rather than as cancelled', () => {
      expect(
        deriveOrderDisplayStatus({
          orderStatus: 'refunded',
          payment: { status: 'succeeded', method: 'online' },
          shipmentStatus: null,
        }),
      ).toBe('confirmed');
    });
  });

  describe('the published vocabulary', () => {
    it('does not offer `ready_to_ship` or `returned` — neither is derivable yet', () => {
      expect(ORDER_DISPLAY_STATUSES).not.toContain('ready_to_ship');
      expect(ORDER_DISPLAY_STATUSES).not.toContain('returned');
    });

    it('every enumerated combination produces a value inside the published enum', () => {
      for (const orderStatus of ['placed', 'cancelled']) {
        for (const payment of PAYMENTS) {
          for (const shipment of SHIPMENTS) {
            expect(ORDER_DISPLAY_STATUSES).toContain(
              deriveOrderDisplayStatus({
                orderStatus,
                payment: payment.value,
                shipmentStatus: shipment.value,
              }),
            );
          }
        }
      }
    });
  });
});
