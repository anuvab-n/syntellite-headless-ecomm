import type { JsonValue } from './events.js';

/**
 * HTTP idempotency contracts.
 *
 * Types only — no I/O, no imports from `db/`. Same split as `events.ts` and `audit.ts`.
 *
 * ## What this is for
 *
 * A client that sends `POST /checkout` and never sees the response cannot know whether the
 * order was created. Its only sane move is to retry, and without a key on the server side
 * that retry places a second order and takes a second payment. The key turns "retry" from a
 * gamble into a safe operation: the second request returns the first one's answer.
 *
 * `IdempotencyConflict` (409) and `IdempotencyKeyReuse` (422) have existed in the error
 * taxonomy since Phase 0 with nothing behind them. This is the missing half.
 *
 * ## What this is NOT for
 *
 * Operations with a natural key. One invoice per order, one e-invoice submission per invoice,
 * one redemption per (coupon, order) — those are unique constraints, and a constraint needs
 * no header, no storage, and no expiry policy. Prefer the constraint every time it exists;
 * this machinery is for genuinely repeatable operations, which is a short list.
 */

/** What a claim attempt resolved to. */
export type IdempotencyClaim =
  /** First time seen. The caller owns this key and must complete or release it. */
  | { readonly outcome: 'claimed' }
  /**
   * Same key, same payload, already finished. The stored response is replayed verbatim —
   * including its status code, because a replayed 201 must not become a 200.
   */
  | {
      readonly outcome: 'replay';
      readonly status: number;
      /** Absent when the original response had no body, e.g. a 204. */
      readonly body?: JsonValue;
    }
  /**
   * Same key, same payload, still executing. Distinct from a replay: there is no answer to
   * give yet, and inventing one would be a guess about work still in flight.
   */
  | { readonly outcome: 'in_flight' }
  /**
   * Same key, DIFFERENT payload. A client bug, and the one case that must never be served a
   * replay — returning the first request's answer for a different request is worse than an
   * error, because the client would believe the second one succeeded.
   */
  | { readonly outcome: 'mismatch' };

export type IdempotencyStore = {
  /**
   * Attempt to claim a key. One statement, so two concurrent requests cannot both claim.
   *
   * The claim is its own transaction, NOT the caller's. It must survive whatever happens to
   * the business work: a claim that rolled back with a failed handler would let a retry
   * execute concurrently with the original.
   */
  claim(params: {
    storeId: string;
    /**
     * The AUTHENTICATED user this key belongs to. Part of the key identity, never optional.
     *
     * Without it, two customers in one store sending the same header value to the same endpoint
     * collide — and with identical payloads the second is served the first one's response. On a
     * checkout endpoint that is another customer's order. Never taken from a request body or a
     * client-supplied field; the middleware reads it from the verified access token.
     */
    userId: string;
    key: string;
    endpoint: string;
    /** Hash of the request payload, for the mismatch check. Never the payload itself. */
    requestHash: string;
    expiresAt: Date;
  }): Promise<IdempotencyClaim>;

  /**
   * Record the response and mark the key completed, so a retry replays it.
   *
   * Uses the ambient executor, so a caller inside a transaction joins it — which is how a
   * future checkout service can make completion atomic with the order it created. Called
   * from middleware after the response instead, it is a separate write; see the note in
   * `http/middleware/idempotency.ts` on the window that leaves.
   */
  complete(params: {
    storeId: string;
    userId: string;
    key: string;
    endpoint: string;
    status: number;
    /** Omit for a bodiless success. The status alone is then replayed. */
    body?: JsonValue;
  }): Promise<void>;

  /**
   * Abandon a claim so a retry may execute.
   *
   * For a request that did NOT succeed. Keeping the key would pin a failed attempt in place
   * until it expired, turning a transient 500 into a permanently unusable key — the client
   * would retry correctly and be told "already in flight" forever.
   */
  release(params: {
    storeId: string;
    userId: string;
    key: string;
    endpoint: string;
  }): Promise<void>;

  /** Delete expired rows. Called by the scheduler; returns how many went. */
  purgeExpired(params: { now: Date; limit: number }): Promise<number>;
};
