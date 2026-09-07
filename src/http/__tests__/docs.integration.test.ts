import { Router, type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { parseConfig, type Config } from '../../config.js';
import { silentLogger } from '../../../tests/helpers/postgres.ts';
import { createApp } from '../app.js';
import { buildOpenApiSpec } from '../routes/docs.js';

/**
 * API documentation.
 *
 * No database: the spec is a static document and the routes it describes are asserted by
 * their own suites. What is tested here is that the document stays HONEST — a spec that
 * describes a path which does not exist, or omits one that does, is worse than no spec,
 * because a client codes against it.
 */
describe('API documentation', () => {
  function config(overrides: Record<string, string> = {}): Config {
    const result = parseConfig({
      NODE_ENV: 'test',
      ENVIRONMENT: 'test',
      PORT: '8000',
      DATABASE_URL: 'postgres://a:b@localhost:5432/c',
      REDIS_CACHE_URL: 'redis://localhost:6379/0',
      REDIS_LOCK_URL: 'redis://localhost:6379/1',
      REDIS_QUEUE_URL: 'redis://localhost:6379/2',
      JWT_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(128)}\n-----END PRIVATE KEY-----`,
      JWT_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----\n${'B'.repeat(128)}\n-----END PUBLIC KEY-----`,
      JWT_ISSUER: 'ecom-test',
      JWT_AUDIENCE: 'ecom-test',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      PAYMENT_SANDBOX_MODE: 'true',
      S3_BUCKET: 'test',
      S3_REGION: 'us-east-1',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      LOG_LEVEL: 'error',
      LOG_FORMAT: 'json',
      ...overrides,
    });
    if (!result.success) {
      throw new Error(`test config failed to parse: ${JSON.stringify(result.error.issues)}`);
    }
    return result.data;
  }

  /** An app with a router that answers every documented `/api/v1` path. */
  function buildApp(cfg: Config = config()) {
    const apiRouter = Router();
    apiRouter.post('/auth/register', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.post('/auth/login', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/auth/refresh', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/auth/logout', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.get('/users/me', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/users/me', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/users/me/password', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.get('/users/me/cart', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/users/me/cart', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.put('/users/me/cart/items/:skuCode', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/users/me/checkout', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/users/me/orders', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.get('/users/me/orders/:orderNumber', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.put('/users/me/cart/promotion', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/users/me/cart/promotion', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.post('/admin/promotions', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/admin/promotions', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.get('/admin/promotions/:code', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/admin/promotions/:code', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/admin/promotions/:code', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.delete('/users/me/cart/items/:skuCode', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.post('/users/me/addresses', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/users/me/addresses', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.get('/users/me/addresses/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/users/me/addresses/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/users/me/addresses/:id', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.post('/admin/products/:slug/skus', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/admin/products/:slug/skus', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/admin/skus/:code', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/admin/skus/:code', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.put('/admin/skus/:code/options', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/admin/products/:slug/options', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/admin/products/:slug/options', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/admin/options/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/admin/options/:id', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.post('/admin/options/:id/values', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.patch('/admin/option-values/:id', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/admin/option-values/:id', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.get('/admin/inventory', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/admin/inventory/adjustments', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/admin/inventory/:skuCode/history', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/admin/products', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/admin/products', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    /**
     * Registered with the EXPRESS parameter syntax while the spec documents the OpenAPI form.
     *
     * The drift guard requests the literal documented path, so `{slug}` simply binds as the
     * parameter value. That is what makes the guard meaningful for a parameterised route: it
     * proves one is actually mounted, rather than merely written down in the document.
     */
    apiRouter.get('/products', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.get('/products/:slug', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.get('/admin/products/:slug', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.patch('/admin/products/:slug', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.delete('/admin/products/:slug', (_req, res) => {
      res.status(204).send();
    });
    apiRouter.post('/admin/products/:slug/publish', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/admin/products/:slug/archive', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    apiRouter.post('/users/me/orders/:orderNumber/payments', (_req, res) => {
      res.status(201).json({ ok: true });
    });
    apiRouter.get('/users/me/orders/:orderNumber/payment', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    /**
     * The webhook router, mounted the way `container.ts` mounts it.
     *
     * Separate from `apiRouter` on purpose — that is the whole point of the mount, and a stub
     * hung off `apiRouter` would let the drift guard pass while the real endpoint sat behind
     * `express.json()`, which is exactly the misconfiguration that breaks signature
     * verification.
     */
    const webhookRouter = Router();
    webhookRouter.post('/razorpay', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    return createApp({
      config: cfg,
      logger: silentLogger,
      healthChecks: [],
      apiRouter,
      webhookRouter,
    });
  }

  describe('serving', () => {
    it('serves Swagger UI at /docs', async () => {
      const response = await request(buildApp()).get('/docs/').redirects(1);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('swagger-ui');
    });

    it('serves the raw document at /docs.json', async () => {
      const response = await request(buildApp()).get('/docs.json');

      // The endpoint that matters most: a client generator or contract test consumes this,
      // and should never have to scrape HTML for it.
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body.openapi).toBe('3.0.3');
    });

    it('builds the server URL from configuration', async () => {
      const response = await request(buildApp(config({ PORT: '9123' }))).get('/docs.json');

      // Hard-coding localhost:8000 would make "Try it out" fire at the wrong port whenever
      // PORT differs, which is exactly when somebody is debugging.
      expect(response.body.servers[0].url).toBe('http://localhost:9123');
    });
  });

  describe('production exposure', () => {
    it('is NOT mounted in production', async () => {
      const app = buildApp(
        config({
          ENVIRONMENT: 'production',
          // Production config refuses to boot without these — see config.ts superRefine.
          DATABASE_REPLICA_URL: 'postgres://a:b@replica:5432/c',
          REDIS_CACHE_URL: 'redis://cache:6379/0',
          REDIS_LOCK_URL: 'redis://lock:6379/0',
          REDIS_QUEUE_URL: 'redis://queue:6379/0',
          PAYMENT_SANDBOX_MODE: 'false',
          SENTRY_DSN: 'https://key@sentry.example/1',
        }),
      );

      /**
       * An OpenAPI document is a complete map of the attack surface — every path, every
       * field, every constraint. Publishing it to anonymous callers in production is a gift
       * to anyone probing the API, so both routes fall through to the 404 handler.
       */
      await expect(request(app).get('/docs.json')).resolves.toMatchObject({ status: 404 });
      await expect(request(app).get('/docs/')).resolves.toMatchObject({ status: 404 });
    });

    it('is mounted in staging', async () => {
      const app = buildApp(config({ ENVIRONMENT: 'staging' }));
      await expect(request(app).get('/docs.json')).resolves.toMatchObject({ status: 200 });
    });
  });

  describe('honesty', () => {
    it('documents only paths that actually exist', async () => {
      const spec = buildOpenApiSpec(config());
      const app = buildApp();
      const paths = Object.keys(spec['paths'] as Record<string, unknown>);

      expect(paths.length).toBeGreaterThan(0);

      for (const path of paths) {
        const methods = Object.keys(
          (spec['paths'] as Record<string, Record<string, unknown>>)[path] ?? {},
        );

        for (const method of methods) {
          const response = await sendByMethod(app, method, path).send({});

          /**
           * The drift guard. A hand-written spec rots when a route is renamed, and the failure
           * is silent — a client codes against a path that 404s. Asserting "not 404" catches a
           * documented path that no longer exists, without pinning status codes the route
           * suites already own.
           */
          expect(
            response.status,
            `${method.toUpperCase()} ${path} is documented but 404s`,
          ).not.toBe(404);
        }
      }
    });

    it('documents the auth endpoints and the health probes', () => {
      const spec = buildOpenApiSpec(config());
      const paths = Object.keys(spec['paths'] as Record<string, unknown>);

      // Explicit, so removing an endpoint from the spec without removing the route is caught
      // — the inverse drift of the test above.
      expect(paths.sort()).toEqual([
        '/api/v1/admin/inventory',
        '/api/v1/admin/inventory/adjustments',
        '/api/v1/admin/inventory/{skuCode}/history',
        '/api/v1/admin/option-values/{id}',
        '/api/v1/admin/options/{id}',
        '/api/v1/admin/options/{id}/values',
        '/api/v1/admin/products',
        '/api/v1/admin/products/{slug}',
        '/api/v1/admin/products/{slug}/archive',
        '/api/v1/admin/products/{slug}/options',
        '/api/v1/admin/products/{slug}/publish',
        '/api/v1/admin/products/{slug}/skus',
        '/api/v1/admin/promotions',
        '/api/v1/admin/promotions/{code}',
        '/api/v1/admin/skus/{code}',
        '/api/v1/admin/skus/{code}/options',
        '/api/v1/auth/login',
        '/api/v1/auth/logout',
        '/api/v1/auth/refresh',
        '/api/v1/auth/register',
        '/api/v1/products',
        '/api/v1/products/{slug}',
        '/api/v1/users/me',
        '/api/v1/users/me/addresses',
        '/api/v1/users/me/addresses/{id}',
        '/api/v1/users/me/cart',
        '/api/v1/users/me/cart/items/{skuCode}',
        '/api/v1/users/me/cart/promotion',
        '/api/v1/users/me/checkout',
        '/api/v1/users/me/orders',
        '/api/v1/users/me/orders/{orderNumber}',
        '/api/v1/users/me/orders/{orderNumber}/payment',
        '/api/v1/users/me/orders/{orderNumber}/payments',
        '/api/v1/users/me/password',
        '/api/v1/webhooks/razorpay',
        '/health/live',
        '/health/ready',
      ]);
    });

    it('marks only genuinely required registration fields as required', () => {
      const spec = buildOpenApiSpec(config());
      const body = postOperation(spec, '/api/v1/auth/register').requestBody.content[
        'application/json'
      ].schema;

      /**
       * `firstName` and `lastName` are OPTIONAL in `RegisterRequestSchema` — they default to
       * empty strings. Documenting them as required would make every generated client demand
       * a value the API does not need, and a reviewer would have no way to know the spec was
       * wrong without reading the Zod schema.
       */
      expect(body.required.sort()).toEqual(['email', 'password']);
      expect(body.additionalProperties).toBe(false);
    });

    it('documents that unknown fields are rejected', () => {
      const spec = buildOpenApiSpec(config());

      // Both bodies use `z.strictObject`, so an undocumented field is a 400 rather than being
      // silently dropped. A client author needs to know that.
      for (const path of [
        '/api/v1/auth/register',
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
      ] as const) {
        expect(
          postOperation(spec, path).requestBody.content['application/json'].schema
            .additionalProperties,
        ).toBe(false);
      }
    });

    it('documents the error envelope and the 503 store failure', () => {
      const spec = buildOpenApiSpec(config());
      const components = spec['components'] as Record<string, Record<string, unknown>>;

      expect(components['schemas']?.['ErrorEnvelope']).toBeDefined();
      // `resolveStore` runs before every API route, so an unseeded store fails the request
      // before a handler sees it. Undocumented, an integrator reads it as a network blip.
      expect(postOperation(spec, '/api/v1/auth/register').responses['503']).toBeDefined();
      expect(postOperation(spec, '/api/v1/auth/login').responses['401']).toBeDefined();
      expect(postOperation(spec, '/api/v1/auth/register').responses['409']).toBeDefined();
    });
  });
});

/**
 * Look up a documented POST operation, failing loudly if the path is absent.
 *
 * `noUncheckedIndexedAccess` is enabled, so an index lookup is `T | undefined`. A `!` would
 * silence that and turn a missing path into a confusing TypeError three lines later; this
 * names the problem instead.
 */
function postOperation(spec: Record<string, unknown>, path: string): SpecOperation {
  const paths = spec['paths'] as Record<string, { post?: SpecOperation }> | undefined;
  const operation = paths?.[path]?.post;
  if (!operation) throw new Error(`spec has no POST ${path}`);
  return operation;
}

/** Minimal structural view of one operation, so assertions read without casts. */
type SpecOperation = {
  requestBody: {
    content: {
      'application/json': {
        schema: { required: string[]; additionalProperties: boolean };
      };
    };
  };
  responses: Record<string, unknown>;
};

/**
 * Issue a request using the HTTP method the spec documents.
 *
 * An explicit switch rather than `request(app)[method]`. Indexing detaches the method, which
 * carries no `this`-safety guarantee and is what the `unbound-method` rule objects to — and the
 * `default` branch means a verb this helper does not know fails loudly instead of silently
 * skipping a documented operation.
 *
 * The previous form sent a POST for anything that was not a GET, so documenting a `PATCH`
 * produced a POST to a path that has none — a 404 reported as spec drift when the route was
 * mounted correctly. It would equally have passed a documented PATCH whose route was never
 * mounted, as long as a POST existed at the same path. Both directions are now impossible.
 */
function sendByMethod(app: Express, method: string, path: string): request.Test {
  const agent = request(app);

  switch (method) {
    case 'get':
      return agent.get(path);
    case 'post':
      return agent.post(path);
    case 'patch':
      return agent.patch(path);
    case 'put':
      return agent.put(path);
    case 'delete':
      return agent.delete(path);
    default:
      throw new Error(`the drift guard cannot issue a "${method}" request`);
  }
}
