import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';

import type { Config } from '../config.js';
import type { Logger } from '../shared/logger.js';
import { contextMiddleware } from './middleware/context.js';
import { errorMiddleware } from './middleware/error.js';
import { notFoundHandler } from './middleware/not-found.js';
import { requestLogger } from './middleware/request-logger.js';
import { createDocsRouter } from './routes/docs.js';
import { createHealthRouter, type HealthCheck } from './routes/health.js';

/**
 * The Express application.
 *
 * Contains NO business logic and touches no database. It wires middleware in a specific
 * order and mounts routers it is handed. Everything domain-specific arrives as a `Router`
 * from the composition root (Step 6).
 */

export type CreateAppOptions = {
  config: Config;
  logger: Logger;
  /** Dependency probes for `/health/ready`. Supplied by the composition root. */
  healthChecks: readonly HealthCheck[];
  /** Mounted under `/api/v1`. Absent until modules exist. */
  apiRouter?: Router;
  /**
   * Mounted under `/api/v1/webhooks` with a RAW body parser, before `express.json()`.
   *
   * Separate from `apiRouter` for one reason: signature verification needs the exact bytes
   * the provider signed. See the ordering note below — this is not a stylistic split.
   */
  webhookRouter?: Router;
};

/** Body size ceiling. A commerce API has no legitimate multi-megabyte JSON request. */
const JSON_BODY_LIMIT = '1mb';

/**
 * MIDDLEWARE ORDER IS LOAD-BEARING.
 *
 * Every entry below is here because putting it elsewhere breaks something, usually
 * silently and usually only in production. Read this before reordering anything.
 *
 *  1. `trust proxy` — must be set before ANY rate limiting or IP logging. Behind a load
 *     balancer, every request appears to come from the LB's IP; a rate limiter then sees one
 *     client making all the traffic and throttles every customer at once because one was
 *     abusive.
 *
 *  2. `helmet` — security headers on every response, including error responses. After the
 *     error middleware it would miss exactly the responses an attacker is provoking.
 *
 *  3. `cors` — before routes, or the preflight OPTIONS request 404s and the browser reports
 *     an opaque CORS failure with no useful detail.
 *
 *  4. `contextMiddleware` — before anything that logs, so every line including a JSON parse
 *     failure carries a request id. It must also precede `requestLogger`, which reuses the
 *     id this establishes rather than minting a second one.
 *
 *  5. `requestLogger` — after context, before routes.
 *
 *  6. health routes — BEFORE the body parsers. A probe carries no body, and keeping it ahead
 *     of parsing means readiness stays answerable even if a parser is misbehaving.
 *
 *  7. **webhook raw body — BEFORE `express.json()`.** THE critical one. `express.json()`
 *     consumes the request stream and leaves only a parsed object; the original bytes are
 *     gone. HMAC signatures are computed over those exact bytes, so if JSON parsing runs
 *     first, EVERY webhook signature check fails — and it fails at integration time against
 *     a live payment provider, not in a unit test.
 *
 *  8. `express.json()` — for everything else.
 *
 *  9. `apiRouter` — the application.
 *
 * 10. API DOCS — after the routes it documents, before the 404. Mounting it earlier would
 *     let a `/docs`-prefixed path shadow a real route; mounting it later would make the 404
 *     handler swallow it.
 *
 * 11. `notFoundHandler` — after all routers, so it only sees genuinely unmatched paths.
 *
 * 12. `errorMiddleware` — LAST, always. Express only routes errors to middleware registered
 *     after the thing that threw.
 */
export function createApp(opts: CreateAppOptions): Express {
  const { config, logger, healthChecks } = opts;
  const app = express();

  /* ── 1. Proxy and fingerprinting ─────────────────────────────────────── */

  /**
   * `1` = trust exactly one proxy hop. NOT `true`: trusting every hop lets a client forge
   * `X-Forwarded-For` and appear to come from any address it likes, defeating both rate
   * limiting and IP-based audit logging. Raise this only to match the real number of
   * proxies in front of the app.
   */
  app.set('trust proxy', 1);

  // Removes `X-Powered-By: Express`. Free, and stops advertising the stack.
  app.disable('x-powered-by');

  // Rejects `?a[b]=c` style nesting. Deep object query strings are an old DoS vector and
  // this API has no use for them.
  app.set('query parser', 'simple');

  /* ── 2. Security headers ─────────────────────────────────────────────── */

  app.use(
    helmet({
      // This is a JSON API with no HTML responses, so a CSP has nothing to protect and
      // its default `form-action`/`frame-ancestors` directives only confuse debugging.
      contentSecurityPolicy: false,
      // Payment gateways redirect back to the storefront; a strict referrer policy here
      // would strip the referrer a gateway sometimes needs.
      referrerPolicy: { policy: 'no-referrer-when-downgrade' },
    }),
  );

  /* ── 3. CORS ─────────────────────────────────────────────────────────── */

  app.use(
    cors({
      // Explicit allowlist from config, which refuses to boot with `*` in production.
      origin: config.corsAllowedOrigins,
      credentials: true,
      // Echoed so a browser will actually send them on a cross-origin request.
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  /* ── 4/5. Context, then logging ──────────────────────────────────────── */

  app.use(contextMiddleware());
  app.use(requestLogger(logger));

  /* ── 6. Health — before body parsing ─────────────────────────────────── */

  app.use('/health', createHealthRouter({ checks: healthChecks, logger }));

  /* ── 7. Webhooks — RAW body, BEFORE express.json() ───────────────────── */

  if (opts.webhookRouter) {
    app.use(
      '/api/v1/webhooks',
      // `express.raw` leaves a Buffer on `req.body`, preserving the exact signed bytes.
      express.raw({ type: 'application/json', limit: JSON_BODY_LIMIT }),
      opts.webhookRouter,
    );
  }

  /* ── 8. JSON parsing ─────────────────────────────────────────────────── */

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  /* ── 9. Application routes ───────────────────────────────────────────── */

  if (opts.apiRouter) {
    app.use('/api/v1', opts.apiRouter);
  }

  /* ── 10. API documentation ───────────────────────────────────────────── */

  /**
   * Swagger UI at `/docs`, the raw document at `/docs.json`.
   *
   * NOT mounted in production, deliberately. An OpenAPI document is a complete map of the
   * attack surface — every path, every field, every constraint — and publishing it to
   * anonymous callers is a gift to anyone probing the API. Staging and local get it; if
   * production ever needs it, it should sit behind the admin auth that does not exist yet
   * rather than be exposed by default.
   *
   * The spec object itself is always built (it is cheap and static), so `buildOpenApiSpec`
   * stays testable in every environment.
   */
  if (config.environment !== 'production') {
    app.use(createDocsRouter({ config }));
  }

  /* ── 11/12. Not found, then the terminal error handler ───────────────── */

  app.use(notFoundHandler());
  app.use(errorMiddleware(logger));

  return app;
}
