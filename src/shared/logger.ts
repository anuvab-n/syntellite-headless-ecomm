import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { Config } from '../config.js';
import { getContext } from './context.js';

export type { Logger };

/**
 * Structured logging.
 *
 * The important property: every line carries the `requestId` without any call site
 * passing one. `AsyncLocalStorage` supplies it via a pino mixin, so a log statement deep
 * inside a service is correlatable with the HTTP request or background job that caused
 * it — including across `await` boundaries and into BullMQ workers.
 *
 * Log an OBJECT then a message: `logger.info({ orderId }, 'order_placed')`. Interpolated
 * strings ("order abc123 placed") cannot be aggregated, filtered, or alerted on.
 * Event names are snake_case and stable — dashboards and alerts key off them.
 */

/**
 * Keys whose values must never reach a log sink, at any nesting depth.
 *
 * This is a backstop, not a licence: do not log an object you have not looked at. Card
 * data in particular must never be in a position to be redacted, because under SAQ-A it
 * should never have entered the process.
 */
const REDACTED_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'cookie',
  '*.cookie',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
  'signature',
  '*.signature',
  /**
   * SQL and its bound parameters.
   *
   * Drizzle does not throw the driver's error — it wraps it in a `DrizzleQueryError` whose
   * OWN enumerable properties are `query`, `params`, and `cause`. Pino's error serialiser
   * includes own properties, so an unhandled database error reaching the terminal middleware
   * would log the statement together with every bound value. For a registration insert that
   * is the Argon2 hash; for a future table it could be an address or a card reference.
   *
   * Explicit paths rather than a bare `*.params`: a top-level wildcard would also capture
   * unrelated fields (`req.params`, a job's `params`) and quietly hide diagnostics that are
   * not secret.
   *
   * The `err.cause.*` pair is a FORWARD GUARD, not currently load-bearing: pino flattens a
   * `cause` into the `stack` string rather than emitting it as a nested object, so those
   * fields are not serialised today. They cost nothing and cover the case where a future pino
   * serialises causes structurally. Verified in shared/__tests__/logger.test.ts.
   */
  'err.query',
  'err.params',
  'err.cause.query',
  'err.cause.params',
];

/**
 * @param destination Optional sink, used by the redaction test to capture output.
 *
 * Production always omits it and pino writes to stdout. It exists because redaction is a
 * security control, and a security control nobody can assert on is a security control nobody
 * knows is still working. Ignored for the `pretty` transport, which owns its own stream.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    // `level: 'info'` rather than `level: 30` — humans and log platforms both read it.
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Runs on every log call: injects the ambient request context.
    mixin: () => {
      const ctx = getContext();
      if (!ctx) return {};
      return {
        requestId: ctx.requestId,
        ...(ctx.storeId !== undefined ? { storeId: ctx.storeId } : {}),
        ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
        ...(ctx.jobName !== undefined ? { jobName: ctx.jobName } : {}),
      };
    },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    base: {
      service: 'ecommerce-backend',
      environment: config.environment,
    },
    // ISO timestamps: marginally more expensive than epoch millis, and worth it every
    // single time someone reads a log during an incident.
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.logFormat === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    });
  }

  return destination ? pino(options, destination) : pino(options);
}

/**
 * A logger for code that runs before configuration is parsed (config failure itself,
 * and the very earliest startup path). Deliberately minimal.
 */
export const bootstrapLogger: Logger = pino({
  level: 'info',
  formatters: { level: (label) => ({ level: label }) },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: 'ecommerce-backend', phase: 'bootstrap' },
});
