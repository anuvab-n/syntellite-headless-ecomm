import type { RequestHandler } from 'express';

import { NotFound } from '../../shared/errors.js';

/**
 * Catch-all for unmatched routes. Registered after every router, immediately before the
 * terminal error middleware.
 *
 * Without it, Express serves its own HTML 404 — inconsistent for a JSON API, and a small
 * information leak, since the default page advertises the framework.
 *
 * Implemented as `next(error)` rather than by writing a response directly, so the envelope
 * is produced in exactly one place. Two code paths that both render an error envelope will
 * eventually disagree about its shape.
 *
 * The message names the RESOURCE TYPE only — never the path. Echoing an unmatched path
 * reflects attacker-controlled input into the response body, which is a small XSS and
 * log-injection surface for no benefit: the client already knows what it asked for.
 */
export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(new NotFound('endpoint'));
  };
}
