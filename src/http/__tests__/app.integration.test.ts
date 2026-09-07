import { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { checkDatabase } from '../../db/client.js';
import { BusinessRuleViolation, NotFound } from '../../shared/errors.js';
import { getRequestId } from '../../shared/context.js';
import {
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';
import { createApp } from '../app.js';
import { asyncHandler } from '../async-handler.js';
import { postgresCheck, redisCheck, type HealthCheck } from '../routes/health.js';
import { validate, validatedBody, validatedQuery } from '../validate.js';

/**
 * HTTP scaffolding, against a real PostgreSQL.
 *
 * Supertest binds an ephemeral port per request, so no fixed port is occupied and these run
 * alongside a live dev server. The readiness checks use the REAL database probe — a mocked
 * probe would assert that our own function was called, which is not the property under test.
 */
describe('http scaffolding (integration)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  /** Tracks whether readiness actually touched the database, for the liveness test. */
  let postgresProbeCalls = 0;

  function realPostgresCheck(): HealthCheck {
    return postgresCheck(async () => {
      postgresProbeCalls += 1;
      await checkDatabase(testDb.handle);
    });
  }

  /**
   * Routes that exist only to exercise the middleware. Passed in as an `apiRouter`, which
   * is the same seam the composition root will use — not a test-only backdoor in
   * production code.
   */
  function testRouter(): Router {
    const router = Router();

    router.get('/ok', (_req, res) => {
      res.json({ ok: true });
    });

    router.post(
      '/validated',
      validate({
        body: z.object({
          email: z.string().email(),
          quantity: z.number().int().positive(),
        }),
      }),
      (req, res) => {
        res.json({ received: validatedBody(req) });
      },
    );

    router.get(
      '/validated-query',
      validate({ query: z.object({ page: z.coerce.number().int().min(1) }) }),
      (req, res) => {
        res.json({ query: validatedQuery(req) });
      },
    );

    // A DomainError thrown synchronously.
    router.get('/domain-error', () => {
      throw new BusinessRuleViolation('Minimum order value not met.', { minimum: '500.0000' });
    });

    router.get('/not-found-error', () => {
      throw new NotFound('order');
    });

    // An async rejection — the case that hangs forever without error forwarding.
    router.get(
      '/async-domain-error',
      asyncHandler(async () => {
        await Promise.resolve();
        throw new NotFound('product');
      }),
    );

    // An unexpected error carrying text that must NOT reach the client.
    router.get(
      '/unexpected',
      asyncHandler(async () => {
        await Promise.resolve();
        throw new Error('relation "secret_table" does not exist at 10.0.0.5:5432');
      }),
    );

    // Proves the ALS context survives an await inside a handler.
    router.get(
      '/context',
      asyncHandler(async (_req, res) => {
        const before = getRequestId();
        await new Promise((resolve) => setTimeout(resolve, 10));
        res.json({ before, after: getRequestId() });
      }),
    );

    return router;
  }

  function buildApp(checks: readonly HealthCheck[] = [realPostgresCheck()]) {
    return createApp({
      config: testDb.config,
      logger: silentLogger,
      healthChecks: checks,
      apiRouter: testRouter(),
    });
  }

  /* ── Health ────────────────────────────────────────────────────────────── */

  describe('GET /health/live', () => {
    it('returns 200 without touching any dependency', async () => {
      const before = postgresProbeCalls;
      const app = buildApp();

      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
      // THE point of liveness: a database blip must not restart the fleet.
      expect(postgresProbeCalls).toBe(before);
    });

    it('stays alive even when every dependency is failing', async () => {
      const app = createApp({
        config: testDb.config,
        logger: silentLogger,
        healthChecks: [
          postgresCheck(() => Promise.reject(new Error('db is down'))),
          redisCheck(() => Promise.reject(new Error('redis is down'))),
        ],
        apiRouter: testRouter(),
      });

      // Liveness 200 while readiness 503 is the correct pair: keep the process, stop the
      // traffic. A liveness failure here would restart a process that is working fine.
      await expect(request(app).get('/health/live')).resolves.toMatchObject({ status: 200 });
      await expect(request(app).get('/health/ready')).resolves.toMatchObject({ status: 503 });
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 and per-dependency status when dependencies are available', async () => {
      const app = buildApp([realPostgresCheck(), redisCheck(() => Promise.resolve())]);

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        checks: { postgres: 'ok', redis: 'ok' },
      });
    });

    it('actually verifies PostgreSQL connectivity', async () => {
      const before = postgresProbeCalls;
      const app = buildApp();

      await request(app).get('/health/ready');

      expect(postgresProbeCalls).toBe(before + 1);
    });

    it('returns 503 when a required dependency is unavailable', async () => {
      const app = buildApp([
        postgresCheck(() => Promise.reject(new Error('connection refused'))),
        redisCheck(() => Promise.resolve()),
      ]);

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'unavailable', redis: 'ok' },
      });
    });

    it('reports a non-required dependency as degraded but stays 200', async () => {
      // Per the degradation policy: losing the cache means slower browsing, and evicting
      // the instance from the load balancer would turn that into an outage.
      const app = buildApp([
        realPostgresCheck(),
        redisCheck(() => Promise.reject(new Error('cache down')), false),
      ]);

      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        checks: { postgres: 'ok', redis: 'degraded' },
      });
    });

    it('leaks no error detail from a failing dependency', async () => {
      const app = buildApp([
        postgresCheck(() =>
          Promise.reject(new Error('password authentication failed for user "ecom" at 10.0.0.5')),
        ),
      ]);

      const response = await request(app).get('/health/ready');
      const serialised = JSON.stringify(response.body);

      // This endpoint is often reachable from further away than the rest of the API.
      expect(serialised).not.toContain('password');
      expect(serialised).not.toContain('10.0.0.5');
      expect(serialised).not.toContain('ecom');
    });
  });

  /* ── Request id and context ────────────────────────────────────────────── */

  describe('request id', () => {
    it('generates one when the client sends none, and echoes it', async () => {
      const response = await request(buildApp()).get('/api/v1/ok');

      expect(response.status).toBe(200);
      const header = response.headers['x-request-id'];
      expect(header).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('propagates an inbound request id', async () => {
      const inbound = 'trace-abc-123';
      const response = await request(buildApp()).get('/api/v1/ok').set('x-request-id', inbound);

      // One id across gateway, API, and worker is what makes a distributed trace readable.
      expect(response.headers['x-request-id']).toBe(inbound);
    });

    it('replaces a malformed inbound id rather than failing the request', async () => {
      const response = await request(buildApp())
        .get('/api/v1/ok')
        .set('x-request-id', 'bad id with spaces and <script>');

      // A broken proxy must not be able to take the API down, and the header is echoed —
      // so anything that could be interpreted downstream is replaced, not escaped.
      expect(response.status).toBe(200);
      expect(response.headers['x-request-id']).not.toContain('script');
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an over-long inbound id', async () => {
      const response = await request(buildApp())
        .get('/api/v1/ok')
        .set('x-request-id', 'a'.repeat(500));

      // Otherwise a client writes 500 bytes into every log line for the request.
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('preserves the context across an await inside a handler', async () => {
      const response = await request(buildApp())
        .get('/api/v1/context')
        .set('x-request-id', 'ctx-survives');

      // AsyncLocalStorage propagating through await is the whole reason logs correlate.
      expect(response.body).toEqual({ before: 'ctx-survives', after: 'ctx-survives' });
    });

    it('includes the request id in an error envelope', async () => {
      const response = await request(buildApp())
        .get('/api/v1/not-found-error')
        .set('x-request-id', 'err-trace-1');

      expect(response.body.error.requestId).toBe('err-trace-1');
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('passes a valid body through to the handler', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .send({ email: 'buyer@example.com', quantity: 2 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: { email: 'buyer@example.com', quantity: 2 } });
    });

    it('returns the standard envelope with per-field messages on failure', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .send({ email: 'not-an-email', quantity: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.requestId).toBeTypeOf('string');

      // Both failures reported at once, so the client does not fix one and retry to find
      // the next.
      const fields = response.body.error.details.fields;
      expect(Object.keys(fields).sort()).toEqual(['body.email', 'body.quantity']);
      expect(fields['body.email'][0]).toBeTypeOf('string');
    });

    it('reports a missing required field', async () => {
      const response = await request(buildApp()).post('/api/v1/validated').send({});

      expect(response.status).toBe(400);
      expect(Object.keys(response.body.error.details.fields).sort()).toEqual([
        'body.email',
        'body.quantity',
      ]);
    });

    it('never exposes Zod internals', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .send({ email: 123, quantity: 'many' });

      const serialised = JSON.stringify(response.body);
      // A ZodError describes our schema — union branches, discriminators, internal names.
      expect(serialised).not.toContain('ZodError');
      expect(serialised).not.toContain('invalid_type');
      expect(serialised).not.toContain('zod');
    });

    it('validates and coerces query parameters', async () => {
      const ok = await request(buildApp()).get('/api/v1/validated-query?page=3');
      expect(ok.status).toBe(200);
      // Coerced from the string a query string always is.
      expect(ok.body).toEqual({ query: { page: 3 } });

      const bad = await request(buildApp()).get('/api/v1/validated-query?page=0');
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.fields['query.page']).toBeDefined();
    });
  });

  /* ── Error mapping ─────────────────────────────────────────────────────── */

  describe('error mapping', () => {
    it('maps a DomainError to its status code and envelope', async () => {
      const response = await request(buildApp()).get('/api/v1/domain-error');

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        error: {
          code: 'BUSINESS_RULE_VIOLATION',
          message: 'Minimum order value not met.',
          details: { minimum: '500.0000' },
        },
      });
    });

    it('maps NotFound to 404', async () => {
      const response = await request(buildApp()).get('/api/v1/not-found-error');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('forwards an async rejection to the terminal middleware', async () => {
      // Without error forwarding this request never completes — it hangs until the socket
      // times out, which is the worst possible failure mode.
      const response = await request(buildApp()).get('/api/v1/async-domain-error');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('returns a safe 500 for an unexpected error', async () => {
      const response = await request(buildApp()).get('/api/v1/unexpected');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred. Please try again or quote the request id.',
          requestId: expect.any(String),
        },
      });
    });

    it('leaks no internals in a 500', async () => {
      const response = await request(buildApp()).get('/api/v1/unexpected');
      const serialised = JSON.stringify(response.body);

      // The thrown message contained a table name and a host:port. A stack trace would
      // hand over the file layout; a Postgres error hands over the schema.
      expect(serialised).not.toContain('secret_table');
      expect(serialised).not.toContain('10.0.0.5');
      expect(serialised).not.toContain('at ');
      expect(response.body.error.stack).toBeUndefined();
    });

    it('returns the standard envelope for malformed JSON', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .set('content-type', 'application/json')
        .send('{"email": "a@b.c", quantity');

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MALFORMED_JSON');
      expect(response.body.error.requestId).toBeTypeOf('string');
    });

    it('does not reflect the malformed body back to the client', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .set('content-type', 'application/json')
        .send('{"x": "<script>alert(1)</script>" ');

      // body-parser puts a fragment of the offending body in `err.message`; forwarding it
      // would reflect attacker input straight into the response.
      expect(JSON.stringify(response.body)).not.toContain('script');
    });

    it('returns 413 with a distinct code for an oversized body', async () => {
      const response = await request(buildApp())
        .post('/api/v1/validated')
        .set('content-type', 'application/json')
        .send(JSON.stringify({ email: 'a@b.c', blob: 'x'.repeat(2 * 1024 * 1024) }));

      expect(response.status).toBe(413);
      // Distinct from MALFORMED_JSON, because the client's fix is different.
      expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  /* ── 404 ───────────────────────────────────────────────────────────────── */

  describe('unknown routes', () => {
    it('returns the standard JSON envelope, not Express HTML', async () => {
      const response = await request(buildApp()).get('/api/v1/does-not-exist');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toMatchObject({
        error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist.' },
      });
      // Express's default page is HTML and advertises the framework.
      expect(response.text).not.toContain('<html');
      expect(response.text).not.toContain('Cannot GET');
    });

    it('does not echo the unmatched path', async () => {
      const response = await request(buildApp()).get('/api/v1/%3Cscript%3Ealert(1)');

      // Reflecting the path is a small XSS and log-injection surface for no benefit.
      expect(JSON.stringify(response.body)).not.toContain('script');
    });

    it('returns JSON 404 for an unknown method on a known path', async () => {
      const response = await request(buildApp()).delete('/api/v1/ok');

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  /* ── Hardening ─────────────────────────────────────────────────────────── */

  describe('hardening', () => {
    it('does not advertise Express', async () => {
      const response = await request(buildApp()).get('/api/v1/ok');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('sets security headers, including on error responses', async () => {
      const response = await request(buildApp()).get('/api/v1/unexpected');

      // helmet before the routes means the responses an attacker provokes are covered too.
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.status).toBe(500);
    });
  });
});
