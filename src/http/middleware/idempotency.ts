import { createHash } from 'node:crypto';

import type { RequestHandler, Response } from 'express';

import { IdempotencyConflict, IdempotencyKeyReuse, ValidationError } from '../../shared/errors.js';
import type { JsonValue } from '../../shared/events.js';
import type { IdempotencyStore } from '../../shared/idempotency.js';
import type { Logger } from '../../shared/logger.js';
import { requireUser } from './auth.js';
import { requireStore } from './store.js';

/**
 * Idempotency for retryable POSTs.
 *
 * Mount on an endpoint where a client retry must not duplicate work — checkout, refunds,
 * return requests. NOT on endpoints with a natural unique key (one invoice per order), where
 * the constraint already does the job for free.
 *
 *   resolveStore  ->  requireAuth  ->  requireIdempotency  ->  validate  ->  handler
 *
 * **`requireAuth` must come FIRST.** A key is scoped to (store, USER, key, endpoint), and the
 * user comes from the verified access token — so authentication has to have established it
 * before the claim is made. Mounting this ahead of `requireAuth` is a wiring bug that
 * `requireUser` reports as a 500 rather than silently falling back to an unscoped key.
 *
 * That ordering costs one thing, stated plainly: a replay now re-authenticates before it is
 * served, where the original design returned the stored response without touching auth at all.
 * One signature verification per retry is the price of not serving one customer another
 * customer's order.
 *
 * Still before `validate`, so a replay does not re-parse or re-enter the domain.
 *
 * ## The window this leaves, stated plainly
 *
 * The claim happens before the handler and the completion after it, so there is a moment
 * between the business COMMIT and the completion write. If the process dies in that window
 * the key stays `in_progress`: retries get `409` until `expiresAt` passes, and after that a
 * retry would re-execute work that had in fact succeeded.
 *
 * That window is why `IdempotencyStore.complete` uses the ambient executor. A handler with
 * strict requirements — checkout is the intended one — should call `complete()` INSIDE its own
 * transaction, which closes the window entirely; the middleware then finds the key already
 * completed and skips its own write. Until such a handler exists, the middleware's post-hoc
 * completion is the fallback, and the second line of defence is that the operations needing
 * this also have natural keys (one order per cart, one payment per order) that would catch a
 * duplicate anyway.
 */

const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Bounds the stored column (`varchar(255)`) and the hash input. */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 255;

/**
 * How long a key is honoured. 24 hours is long enough to cover any realistic client retry
 * (including a mobile app resumed the next morning) and short enough that the table stays
 * small.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Hash the payload rather than store it.
 *
 * `JSON.stringify` of the parsed body, with object keys sorted, so two requests that differ
 * only in key order are recognised as the same request. Not a general-purpose canonical JSON
 * form — it does not need to be, since both sides of the comparison are produced by this same
 * function on bodies that Express has already parsed.
 */
function hashPayload(body: unknown): string {
  const canonical = JSON.stringify(sortKeys(body));
  return createHash('sha256')
    .update(canonical ?? 'null')
    .digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}

/** `POST /api/v1/checkout` — stable across mounts, so it identifies the operation. */
function endpointOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function requireIdempotency(deps: {
  store: IdempotencyStore;
  logger: Logger;
  ttlMs?: number;
}): RequestHandler {
  const { store, logger } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  return (req, res, next) => {
    void (async () => {
      try {
        const header = req.get(IDEMPOTENCY_HEADER);

        /**
         * REQUIRED, not optional.
         *
         * An endpoint mounted with this middleware is one where a duplicate is harmful, so
         * accepting a keyless request would make the protection opt-in by the very client
         * most likely to get retries wrong. A 400 naming the header is actionable; silently
         * proceeding is not.
         */
        if (header === undefined || header.trim().length === 0) {
          next(
            new ValidationError({
              'header.idempotency-key': ['is required for this endpoint'],
            }),
          );
          return;
        }

        const key = header.trim();
        if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
          next(
            new ValidationError({
              'header.idempotency-key': [
                `must be between ${String(MIN_KEY_LENGTH)} and ${String(MAX_KEY_LENGTH)} characters`,
              ],
            }),
          );
          return;
        }

        const storeId = requireStore(req).id;
        /**
         * From the VERIFIED token. Never a header, never a body field, never a path parameter —
         * a client-supplied identity here would let one customer claim another customer's key
         * space, which is the whole hole this scoping closes.
         */
        const userId = requireUser(req).id;
        const endpoint = endpointOf(req.method, req.baseUrl + req.path);
        const requestHash = hashPayload(req.body);

        const claim = await store.claim({
          storeId,
          userId,
          key,
          endpoint,
          requestHash,
          expiresAt: new Date(Date.now() + ttlMs),
        });

        if (claim.outcome === 'mismatch') {
          logger.warn({ endpoint }, 'idempotency_key_reused_with_different_body');
          next(new IdempotencyKeyReuse());
          return;
        }

        if (claim.outcome === 'in_flight') {
          logger.info({ endpoint }, 'idempotency_request_in_flight');
          next(new IdempotencyConflict());
          return;
        }

        if (claim.outcome === 'replay') {
          /**
           * The stored status AND body. Replaying a 201 as a 200 would tell a client its
           * retry had merely fetched something rather than created it.
           */
          logger.info({ endpoint, status: claim.status }, 'idempotency_response_replayed');
          res.setHeader('Idempotent-Replay', 'true');
          if (claim.body === undefined) {
            // The original had no body (a 204). Reproduce the status alone rather than
            // inventing a payload the first response never sent.
            res.status(claim.status).send();
          } else {
            res.status(claim.status).json(claim.body);
          }
          return;
        }

        captureResponse({ res, store, storeId, userId, key, endpoint, logger });
        next();
      } catch (err) {
        // A store failure must not be reported as a client error. Fail the request loudly:
        // proceeding without a claim would silently drop the guarantee the route asked for.
        next(err);
      }
    })();
  };
}

/**
 * Record the outcome once the response is on its way out.
 *
 * `res.json` is wrapped rather than using the `finish` event, because `finish` gives no
 * access to the body — and the body is the thing a replay has to return. The wrapper fires
 * synchronously with the send, and the store write is deliberately not awaited by it: the
 * response has already left, so making the client wait for bookkeeping would add latency to
 * every successful request for no benefit to that request.
 */
function captureResponse(args: {
  res: Response;
  store: IdempotencyStore;
  storeId: string;
  userId: string;
  key: string;
  endpoint: string;
  logger: Logger;
}): void {
  const { res, store, storeId, userId, key, endpoint, logger } = args;
  const originalJson = res.json.bind(res);
  let recorded = false;

  const record = (status: number, body?: JsonValue): void => {
    if (recorded) return;
    recorded = true;

    /**
     * 2xx completes the key; anything else releases it.
     *
     * A failed request has committed nothing, so the client must be free to retry with the
     * same key. Storing a 500 as the completed answer would make a transient failure
     * permanent for that key — the client would retry correctly and be handed the error
     * forever.
     *
     * 4xx is released too. It is deterministic, so replaying it would be harmless, but
     * releasing keeps the rule to one sentence, and a validation failure is not the
     * operation this key was minted for.
     */
    const succeeded = status >= 200 && status < 300;

    void (
      succeeded
        ? store.complete({
            storeId,
            userId,
            key,
            endpoint,
            status,
            // Spread rather than `body`: `exactOptionalPropertyTypes` distinguishes an absent
            // property from an explicit `undefined`, and here the distinction is real — a
            // bodiless success must record no body at all.
            ...(body === undefined ? {} : { body }),
          })
        : store.release({ storeId, userId, key, endpoint })
    ).catch((err: unknown) => {
      /**
       * Logged, never thrown. The response has already been sent; there is nothing left to
       * fail. A completion that did not land leaves the key `in_progress` until it expires,
       * which the middleware's own doc comment records as the known window.
       */
      logger.error({ err, endpoint, succeeded }, 'idempotency_outcome_not_recorded');
    });
  };

  res.json = (body: unknown) => {
    record(res.statusCode, body as JsonValue);
    return originalJson(body);
  };

  /**
   * A handler that ends without a JSON body — a 204, or an error path that sends nothing —
   * still has to release its claim, or the key is pinned until expiry.
   */
  res.on('finish', () => {
    /**
     * A handler that ended without a JSON body — a 204, or an error path that sent nothing.
     *
     * A bodiless 2xx still COMPLETES: the operation succeeded, so a retry must not re-run it,
     * and a replay reproduces the bare status. Only a non-2xx releases. Recording it as
     * released instead would let a retry execute work that had already happened.
     */
    record(res.statusCode);
  });
}
