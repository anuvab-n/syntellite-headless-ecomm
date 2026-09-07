import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../../config.js';
import { createLogger } from '../logger.js';

/**
 * Log redaction.
 *
 * Redaction is a security control, and an untested one is a control nobody knows is still
 * working — a reordered path or a pino upgrade could silently disable it. These tests capture
 * real log output and assert on the bytes.
 *
 * The specific case that motivated the SQL paths: Drizzle does not throw the driver's error,
 * it wraps it in a `DrizzleQueryError` whose own enumerable properties are `query`, `params`,
 * and `cause`. Pino's error serialiser includes own properties, so an unhandled database error
 * reaching the terminal middleware logged the statement with every bound value.
 */
describe('logger redaction', () => {
  /** Captures everything the logger writes, so assertions run against real output. */
  function capture(): { logger: ReturnType<typeof createLogger>; lines: () => string } {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      },
    });

    return {
      logger: createLogger(testConfig(), sink),
      lines: () => chunks.join(''),
    };
  }

  function testConfig(): Config {
    const result = parseConfig({
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
      DATABASE_URL: 'postgres://a:b@localhost:5432/c',
      REDIS_CACHE_URL: 'redis://localhost:6379/0',
      REDIS_LOCK_URL: 'redis://localhost:6379/1',
      REDIS_QUEUE_URL: 'redis://localhost:6379/2',
      // Shape-valid placeholders: nothing here signs a token, and config now validates the
      // PEM envelope rather than accepting any non-empty string.
      JWT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(128)}\n-----END PRIVATE KEY-----`,
      JWT_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----\n${'B'.repeat(128)}\n-----END PUBLIC KEY-----`,
      JWT_ISSUER: 'test',
      JWT_AUDIENCE: 'test',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      PAYMENT_SANDBOX_MODE: 'true',
      S3_BUCKET: 'test',
      S3_REGION: 'us-east-1',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      // `debug` so nothing under test is filtered out by level.
      LOG_LEVEL: 'debug',
      // `json`, not `pretty`: the pretty transport owns its own stream and would bypass the
      // capture sink entirely.
      LOG_FORMAT: 'json',
    });

    if (!result.success) {
      throw new Error(`test config failed to parse: ${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  describe('SQL and bound parameters', () => {
    /** The shape Drizzle actually throws — verified against a real unique violation. */
    function drizzleLikeError(): Error {
      const driverError = Object.assign(
        new Error('duplicate key value violates unique constraint'),
        {
          code: '23505',
          constraint: 'uq_user_email_active',
          query: 'insert into "app_user" ("email", "password_hash") values ($1, $2)',
          params: ['victim@example.com', '$argon2id$v=19$m=19456,p=1,t=2$SALT$DIGEST'],
        },
      );

      return Object.assign(new Error('Failed query'), {
        query: 'insert into "app_user" ("email", "password_hash") values ($1, $2)',
        params: ['victim@example.com', '$argon2id$v=19$m=19456,p=1,t=2$SALT$DIGEST'],
        cause: driverError,
      });
    }

    it('redacts the SQL statement and its parameters', () => {
      const { logger, lines } = capture();

      // Exactly what the terminal error middleware does for an unhandled exception.
      logger.error(
        { err: drizzleLikeError(), path: '/api/v1/auth/register' },
        'unhandled_exception',
      );
      const output = lines();

      // The Argon2 hash and the email were both bound parameters.
      expect(output).not.toContain('argon2id');
      expect(output).not.toContain('victim@example.com');
      expect(output).not.toContain('insert into');
      expect(output).toContain('[redacted]');
    });

    it('leaks no bound parameter anywhere in the output, including via the cause', () => {
      const { logger, lines } = capture();

      logger.error({ err: drizzleLikeError() }, 'unhandled_exception');
      const output = lines();

      /**
       * Asserted against the WHOLE output rather than a `"cause"` section, because pino
       * flattens a `cause` into the `stack` string ("caused by: …") instead of emitting it as
       * a nested object. An earlier version of this test sliced from `indexOf('"cause"')`,
       * which is -1 when there is no such field — so it compared the last character of the
       * line and passed vacuously.
       *
       * Searching the entire line is the property that actually matters and cannot pass by
       * accident: the parameters must not appear, by any mechanism.
       */
      expect(output).not.toContain('argon2id');
      expect(output).not.toContain('victim@example.com');
      expect(output).not.toContain('insert into');
    });

    it('keeps the diagnostic information that is not secret', () => {
      const { logger, lines } = capture();

      logger.error(
        { err: drizzleLikeError(), path: '/api/v1/auth/register' },
        'unhandled_exception',
      );
      const output = lines();

      /**
       * Redaction must not blind the log. What survives is the event name, the error type and
       * message, the stack, the flattened cause message, and the request path — enough to
       * diagnose a failure, none of it secret.
       *
       * Note what is NOT here: pino's error serialiser does not emit the driver error's
       * `code` (SQLSTATE) or `constraint`, because they live on the `cause` and the cause is
       * rendered into the stack string rather than as fields. Diagnosing a constraint
       * violation therefore relies on the message. That is a real limitation, and the reason
       * `identity.repository.ts` translates constraint names into typed errors at the source
       * rather than expecting a log reader to recover them.
       */
      expect(output).toContain('unhandled_exception');
      expect(output).toContain('/api/v1/auth/register');
      expect(output).toContain('duplicate key value violates unique constraint');
      expect(output).toContain('"type":"Error"');
    });

    it('does not redact an unrelated params field', () => {
      const { logger, lines } = capture();

      // The paths are deliberately `err.params` / `err.cause.params` rather than a bare
      // `*.params`: a top-level wildcard would blind ordinary diagnostics like route params.
      logger.info({ job: { params: { attempt: 3 } } }, 'job_started');

      expect(lines()).toContain('"attempt":3');
    });
  });

  describe('credentials', () => {
    it('redacts passwords, tokens, and secrets at the top level and one level deep', () => {
      const { logger, lines } = capture();

      logger.info(
        {
          password: 'plaintext-password',
          accessToken: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
          refreshToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          user: { passwordHash: '$argon2id$v=19$SALT$DIGEST' },
          req: { headers: { authorization: 'Bearer eyJhbGciOi' } },
        },
        'sensitive',
      );
      const output = lines();

      expect(output).not.toContain('plaintext-password');
      expect(output).not.toContain('eyJhbGciOiJSUzI1NiJ9');
      expect(output).not.toContain('AAAAAAAAAAAAAAAAAAAA');
      expect(output).not.toContain('$argon2id');
      expect(output).not.toContain('Bearer');
      expect(output).toContain('[redacted]');
    });
  });
});
