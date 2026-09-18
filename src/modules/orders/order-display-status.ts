/**
 * **D1 — the admin dashboard's order status, derived and never stored.**
 *
 * The admin UI shows one status per order. This backend has three lifecycles instead, and §43
 * records why they stay apart: `order.status` is `placed | cancelled`, money lives in `payment`,
 * and goods live in `shipment`. Folding any of them into the others is the shortcut that makes
 * all three impossible to model later.
 *
 * So the composition happens HERE, on read, in a pure function — see §49 for the full argument
 * and for the two UI statuses this deliberately cannot produce.
 *
 * ## Why this file is pure
 *
 * No database, no clock, no money. It takes three already-read facts and returns a string. That
 * buys two things worth having:
 *
 *  - **Exhaustive tests.** The input space is finite — 2 order statuses x 5 payment states x 4
 *    shipment states — so the mapping is verified by enumerating all 40 combinations rather than
 *    by sampling the ones someone thought of.
 *  - **One place to change.** When the carrier increment adds `ready_to_ship`, it adds a branch
 *    here and touches nothing else. A stored status would need a backfill and a migration.
 *
 * Nothing in this file reads a request, so it cannot be influenced by one.
 */

/**
 * The statuses this function can actually produce.
 *
 * **`ready_to_ship` and `returned` are absent on purpose.** Both are in the Figma; neither is
 * derivable today — the first needs an AWB column that does not exist, the second needs a return
 * to reach `completed`, which no route currently permits. §49 has the reasoning. They are listed
 * nowhere in this module rather than being emitted as a bucket that can never fill, because a
 * status that never appears is indistinguishable from a broken one.
 */
export const ORDER_DISPLAY_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'failed',
] as const;

export type OrderDisplayStatus = (typeof ORDER_DISPLAY_STATUSES)[number];

/**
 * The payment facts the mapping consults: a status and, for one row, a method.
 *
 * Structurally typed and deliberately narrow — the same shape the `OrderPayments` port already
 * hands back. The amount is not here because row 7 is the only rule that looks past `status`,
 * and it looks at `method`. A function that could see an amount is a function that could start
 * deciding things about money.
 */
export type DisplayPaymentState = {
  readonly status: string;
  readonly method: string;
};

/**
 * Compose the display status. **First match wins — the order of these branches IS the spec.**
 *
 * The table lives in `docs/DECISIONS.md` §49; this is the same table as code, in the same order,
 * and the numbered comments are the row numbers so the two can be diffed by eye.
 *
 * @param input.orderStatus   `order.status` — `placed` or `cancelled`.
 * @param input.payment       The order's payment state, or `null` when no payment row exists.
 * @param input.shipmentStatus The order's shipment status, or `null` when no shipment exists.
 */
export function deriveOrderDisplayStatus(input: {
  orderStatus: string;
  payment: DisplayPaymentState | null;
  shipmentStatus: string | null;
}): OrderDisplayStatus {
  const { orderStatus, payment, shipmentStatus } = input;

  // 1. Cancellation is a fact about the ORDER, not about money or goods, so it outranks both.
  if (orderStatus === 'cancelled') return 'cancelled';

  /*
   * 2-4. Fulfilment outranks payment: if goods have moved, that is the more advanced fact, and
   * reporting `failed` for a delivered parcel would be wrong in the direction that matters.
   * `requirePaymentPrerequisite` makes the awkward combinations near-unreachable today — but a
   * rule that leans on another module continuing to guard something breaks silently, so the
   * precedence is stated here rather than assumed.
   */
  if (shipmentStatus === 'delivered') return 'delivered';
  if (shipmentStatus === 'shipped') return 'shipped';
  if (shipmentStatus === 'pending') return 'processing';

  // 9. No payment at all. A distinct fact from any payment status, and it means "not started".
  if (payment === null) return 'pending';

  // 5. `expired` joins `failed`: both mean this attempt will never complete.
  if (payment.status === 'failed' || payment.status === 'expired') return 'failed';

  // 6. Money has moved.
  if (payment.status === 'succeeded') return 'confirmed';

  /*
   * 7. The one row that asserts a business meaning rather than restating a state. A COD order is
   * agreed when it is placed — there is nothing to wait for and the money arrives at the door —
   * so bucketing it with unpaid online orders would put "needs chasing" and "needs packing" in
   * one queue. §49 flags this as the row to revisit first if the dashboard reads wrong.
   */
  if (payment.status === 'pending' && payment.method === 'cod') return 'confirmed';

  /*
   * 8, and the fallback. A `pending` online payment is the archetype, and anything this function
   * does not recognise lands here too: an unknown payment status means no money has been
   * confirmed, and `pending` is the honest answer to that. Returning a value keeps the function
   * total — an admin list must not 500 because one row carries a status added elsewhere.
   */
  return 'pending';
}
