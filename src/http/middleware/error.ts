import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { getRequestId } from '../../shared/context.js';
import { DomainError, ValidationError, type ErrorEnvelope } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';

/**
 * The terminal error middleware. MUST be registered last, after every router.
 *
 * Express identifies error middleware by ARITY — the four-parameter signature is what makes
 * it an error handler. Deleting the unused `_next` silently converts this into an ordinary
 * middleware that is never called for errors, and every failure becomes Express's default
 * HTML 500. That is a genuine and frequently-hit trap, which is why `_next` is named with
 * an underscore rather than removed.
 *
 * One policy decision lives here and nowhere else: what the client is told. Handlers and
 * services throw; this decides the status code, the body, and the log level.
 */

/** Body-parser failures arrive as plain Errors with these properties bolted on. */
type BodyParserError = Error & {
  type?: string;
  status?: number;
  statusCode?: number;
};

function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error)) return false;
  const type = (err as BodyParserError).type;
  return typeof type === 'string' && type.startsWith('entity.');
}

function envelope(
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      requestId,
    },
  };
}

export function errorMiddleware(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = getRequestId() ?? req.requestId ?? 'unknown';

    /**
     * If the response has already started, the status code and headers are gone and a
     * second write corrupts the stream. Hand it to Express, which destroys the socket —
     * ugly, but the only correct move once bytes are on the wire.
     */
    if (res.headersSent) {
      logger.error({ err, path: req.path }, 'error_after_response_started');
      return _next(err);
    }

    /* ── Expected business outcomes ──────────────────────────────────────── */

    if (err instanceof DomainError) {
      // `info`, not `error`. "Out of stock" and "coupon expired" are the system working
      // correctly. Logging them at error level trains everyone to ignore error logs.
      logger.info(
        { code: err.code, statusCode: err.statusCode, path: req.path, method: req.method },
        'domain_error',
      );
      res.status(err.statusCode).json(err.toEnvelope(requestId));
      return;
    }

    /* ── A ZodError that escaped validate() ──────────────────────────────── */

    if (err instanceof ZodError) {
      /**
       * Reaching here means a schema was parsed outside the `validate()` middleware — a
       * service parsing its own input, say. Handled rather than allowed to become a 500,
       * but normalised through ValidationError so the client sees the SAME shape it would
       * have got from the middleware, and Zod's internals still do not escape.
       */
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of err.issues) {
        const key = issue.path.map((s) => String(s)).join('.') || 'root';
        (fieldErrors[key] ??= []).push(issue.message);
      }
      const normalised = new ValidationError(fieldErrors);
      logger.warn({ path: req.path, method: req.method }, 'unhandled_zod_error');
      res.status(normalised.statusCode).json(normalised.toEnvelope(requestId));
      return;
    }

    /* ── Malformed request bodies ────────────────────────────────────────── */

    if (isBodyParserError(err)) {
      const status = err.status ?? err.statusCode ?? 400;

      // Distinct codes, because the client's fix differs: one is "your JSON is broken",
      // the other is "your request is too big". A single generic code makes the caller guess.
      const { code, message } =
        err.type === 'entity.too.large'
          ? { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' }
          : err.type === 'entity.parse.failed'
            ? { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' }
            : { code: 'BAD_REQUEST', message: 'The request could not be processed.' };

      logger.warn({ type: err.type, path: req.path, method: req.method }, 'malformed_request');
      // `err.message` is NOT forwarded: body-parser puts a fragment of the offending body
      // in it, which reflects attacker input straight back into the response.
      res.status(status).json(envelope(code, message, requestId));
      return;
    }

    /* ── Everything else: a bug or an infrastructure failure ─────────────── */

    /**
     * Log EVERYTHING, return NOTHING.
     *
     * A stack trace tells an attacker the framework and file layout; a Postgres error
     * string tells them table and column names; a driver error can carry a connection
     * string. The client gets a code and the request id, which is all it needs to report
     * the problem — and the request id is what turns "it broke" into one log query.
     */
    logger.error(
      {
        err,
        path: req.path,
        method: req.method,
        // Deliberately no body, query, or headers: this is the one code path guaranteed to
        // run with attacker-controlled input, and it must not become an exfiltration route
        // into the log store.
      },
      'unhandled_exception',
    );

    res
      .status(500)
      .json(
        envelope(
          'INTERNAL_ERROR',
          'An unexpected error occurred. Please try again or quote the request id.',
          requestId,
        ),
      );
  };
}
