import type { RequestHandler } from 'express';

import { newRequestId, runWithContext } from '../../shared/context.js';

/**
 * Request ID header.
 *
 * `x-request-id` is the de-facto standard and what most load balancers and proxies already
 * set. Accepting an inbound value means a request can be traced across the whole system —
 * gateway, this API, a worker, a downstream service — under one id.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum accepted length of an inbound request id.
 *
 * The header is attacker-controlled and lands in every log line for the request. Without a
 * cap, a client can write a megabyte into the log pipeline per request, or inject enough
 * padding to push the real fields out of a truncated log viewer.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Conservative character set: an id is echoed in a response header, so anything that could
 * terminate a header or be interpreted downstream is rejected outright rather than escaped.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue !== 'string') return newRequestId();
  const trimmed = headerValue.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REQUEST_ID_LENGTH) return newRequestId();
  // A malformed inbound id is REPLACED, not rejected with a 400: the request itself is
  // fine, and failing it would let a broken proxy take the API down.
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : newRequestId();
}

/**
 * Establishes the ambient request context for the rest of the request.
 *
 * Runs very early — before logging, before body parsing — so that everything downstream,
 * including a JSON parse failure, is attributable to a request id.
 *
 * The context propagates through `await` boundaries via `AsyncLocalStorage`, which is why
 * `next()` is called INSIDE `runWithContext`. Calling it outside would establish a store
 * that ends the moment this function returns, and every log line after the first await
 * would lose its request id — the failure mode being that it appears to work under no
 * load and silently stops correlating under concurrency.
 */
export function contextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);

    req.requestId = requestId;
    // Echoed so a client (or a support engineer reading a screenshot) can quote the id
    // that appears in our logs. Set before `next()` so it survives an early response.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext({ requestId, startedAt: Date.now() }, () => {
      next();
    });
  };
}
