import type { Logger } from '../../shared/logger.js';

/**
 * The payment expiry sweeper. Increment 36.
 *
 * Finds online payments whose window has passed and expires them, releasing the inventory each
 * was holding. One function, no state, no schedule of its own — the scheduler owns cadence and
 * leadership, and this owns what one pass does.
 *
 * ## Why a sweeper and not a timer per payment
 *
 * A `setTimeout` per payment dies with the process, cannot survive a deploy, and multiplies by
 * every instance. A swept column survives restarts, is inspectable in SQL, and needs no memory
 * proportional to open payments.
 *
 * ## Why it does not hold one transaction over the batch
 *
 * Each candidate takes an `order` and a `payment` row lock, and holding a batch's worth across
 * one transaction would contend with live checkouts for as long as the pass ran — and one
 * poisoned row would roll back every expiry beside it. So the candidate read is OUTSIDE any
 * transaction and each candidate gets its own, which is also what lets a single failure be
 * logged and stepped over.
 *
 * That means the candidate list is a HINT, not a decision: a payment can terminalise between
 * the read and the lock. `expirePayment` re-reads under the lock and answers `ignored` for that
 * case, which is why a lost race is counted rather than logged as a failure.
 *
 * ## Multi-instance safety is not this file's problem
 *
 * The scheduler is leader-elected through Redis and re-checks leadership per task, so exactly
 * one instance sweeps. Even if that guarantee were lost, correctness does not depend on it: the
 * payment row lock serialises two sweepers and the `status = 'pending'` CAS admits one, so a
 * second sweeper produces `ignored` results rather than double-releasing stock.
 */

/** What one pass did. Returned for logging and for tests to assert on. */
export type SweepResult = {
  readonly candidates: number;
  readonly expired: number;
  /** Lost races and already-terminal rows. Expected, not failures. */
  readonly ignored: number;
  /** Threw. Left `pending` and retried next pass. */
  readonly failed: number;
};

/**
 * What the sweeper needs from the payments service. Structurally satisfied by it.
 *
 * Declared here rather than importing `PaymentsService` so this file depends on two operations
 * instead of the whole service surface.
 */
export type ExpirablePayments = {
  listExpiryDue(params: {
    now: Date;
    limit: number;
  }): Promise<{ paymentId: string; storeId: string; orderId: string }[]>;
  expirePayment(params: {
    paymentId: string;
    storeId: string;
    orderId: string;
  }): Promise<{ readonly outcome: 'expired' | 'skipped' | 'ignored' }>;
};

export function createPaymentExpirySweeper(deps: {
  payments: ExpirablePayments;
  /**
   * Candidates claimed per pass, from validated configuration.
   *
   * Bounded because each candidate takes two row locks. A backlog larger than this drains over
   * several passes rather than in one long-running transaction storm.
   */
  batchSize: number;
  logger: Logger;
}) {
  const { payments, batchSize, logger } = deps;

  return {
    /**
     * Run one pass.
     *
     * `now` is a parameter with a default rather than a bare `new Date()` inside, which is the
     * only seam a deterministic test needs: seed a payment with `expires_at` in the past, sweep
     * at a chosen instant, assert. That follows the repository's established pattern of
     * controlling time through data rather than through fake timers — there are none anywhere
     * in this codebase, and this increment does not introduce the first.
     *
     * Never throws. A pass that propagated would kill the scheduler tick that called it, and
     * one bad payment must not stop the sweep — so each failure is logged with its id and the
     * loop continues. **Nothing is swallowed silently**: every failure is logged at `error`
     * with the payment id, and the count comes back in the result.
     */
    async sweep(now: Date = new Date()): Promise<SweepResult> {
      const due = await payments.listExpiryDue({ now, limit: batchSize });

      if (due.length === 0) {
        return { candidates: 0, expired: 0, ignored: 0, failed: 0 };
      }

      let expired = 0;
      let ignored = 0;
      let failed = 0;

      for (const candidate of due) {
        try {
          const result = await payments.expirePayment(candidate);
          if (result.outcome === 'expired') expired += 1;
          else ignored += 1;
        } catch (err) {
          /*
           * One poisoned payment must not end the pass. The transaction inside
           * `expirePayment` has already rolled back, so this payment is still `pending` with
           * its reservation still held, and the next pass will try it again.
           *
           * Logged at `error` with the id, because a payment that fails to expire repeatedly
           * is holding stock and someone needs to be able to find it. An `InvariantViolation`
           * from the reservation release surfaces here, and it means the projection has
           * diverged — worth waking someone for.
           */
          failed += 1;
          logger.error(
            {
              err,
              paymentId: candidate.paymentId,
              orderId: candidate.orderId,
              storeId: candidate.storeId,
            },
            'payment_expiry_failed',
          );
        }
      }

      const result: SweepResult = { candidates: due.length, expired, ignored, failed };

      /*
       * `warn` when anything failed, so a sweep that is silently making no progress is visible
       * without reading every line. A pass that found nothing logs nothing at all — this runs
       * every minute forever, and an idle heartbeat would bury the passes that mattered.
       */
      if (failed > 0) logger.warn(result, 'payment_expiry_sweep_completed_with_failures');
      else logger.info(result, 'payment_expiry_sweep_completed');

      return result;
    },
  };
}

export type PaymentExpirySweeper = ReturnType<typeof createPaymentExpirySweeper>;
