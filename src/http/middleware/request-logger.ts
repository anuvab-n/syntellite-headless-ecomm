import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

import { getRequestId, newRequestId } from '../../shared/context.js';
import type { Logger } from '../../shared/logger.js';

/** The fields this module reads off a request. Everything else is deliberately ignored. */
type LoggedRequest = {
  method?: string | undefined;
  url?: string | undefined;
  remoteAddress?: string | undefined;
};

type LoggedResponse = { statusCode?: number | undefined };

type LoggedError = { type?: string | undefined; message?: string | undefined };

/**
 * Structured request logging.
 *
 * One line per completed request: method, route, status, duration, request id. That line is
 * what answers "was it slow, or did it fail, and for whom" without anybody adding a
 * `console.log`.
 *
 * What is NOT logged, deliberately:
 *
 *  - Request and response BODIES. A checkout body contains an address; a login body
 *    contains a password. There is no allowlist careful enough to be worth the risk, so
 *    bodies are omitted entirely rather than redacted field by field.
 *  - `authorization`, `cookie`, `set-cookie`. A bearer token in a log is a credential in a
 *    log, and log stores are backed up, shipped, and read by more people than a database.
 *
 * The base logger already redacts a list of sensitive keys (see shared/logger.ts); the
 * serialisers here are the primary defence, and that redaction is the backstop.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,

    /**
     * Reuse the id `contextMiddleware` already established, rather than letting pino-http
     * mint its own counter. Two different ids for one request is worse than none.
     *
     * This is why `contextMiddleware` must be registered BEFORE this middleware. The
     * fallback only fires if that ordering is ever broken, and it produces a real id
     * rather than a number so log correlation degrades instead of breaking.
     */
    genReqId: () => getRequestId() ?? newRequestId(),

    /**
     * A 4xx is the client's problem and routine traffic — a validation failure is not an
     * operational event and must not page anyone. A 5xx is ours.
     */
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      // Health probes fire every few seconds forever; at info they drown the log.
      return 'info';
    },

    customSuccessMessage: () => 'request_completed',
    customErrorMessage: () => 'request_failed',

    // `responseTime` is added by pino-http; naming it explicitly keeps the field stable
    // for dashboards even if the library's default changes.
    customAttributeKeys: { responseTime: 'durationMs' },

    /**
     * pino-http types its serializer callbacks as `(value: any) => any`, so the parameters
     * are declared explicitly here. Narrowing them is not cosmetic: it is what lets the
     * type checker confirm we only ever read the four fields we intend to log, rather than
     * spreading an object whose contents we have not inspected into the log store.
     */
    serializers: {
      req: (req: LoggedRequest) => ({
        method: req.method,
        // `req.url` includes the query string, which can carry a token in a badly built
        // client. Path only.
        path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        // Present only when `trust proxy` is set correctly; otherwise it is the LB's IP.
        remoteAddress: req.remoteAddress,
      }),
      res: (res: LoggedResponse) => ({ statusCode: res.statusCode }),
      /**
       * Message and type only. A stack trace belongs in the error middleware's log, once,
       * with full context — not duplicated into every request line.
       */
      err: (err: LoggedError) => ({
        type: err.type,
        message: err.message,
      }),
    },

    /**
     * Health probes and the docs UI are excluded from request logging.
     *
     * A readiness probe every 5 seconds is ~17k lines a day per instance, which costs money
     * in a log store and buries real traffic. Swagger UI is worse per page load — it pulls a
     * dozen static assets, each of which would otherwise be a log line indistinguishable from
     * real traffic.
     *
     * A FAILING probe is still logged, by the readiness handler itself — see `routes/health.ts`.
     */
    autoLogging: {
      ignore: (req) => {
        const path = typeof req.url === 'string' ? req.url.split('?')[0] : '';
        if (path === '/health/live' || path === '/health/ready') return true;
        return path === '/docs.json' || path === '/docs' || (path?.startsWith('/docs/') ?? false);
      },
    },
  }) as RequestHandler;
}
