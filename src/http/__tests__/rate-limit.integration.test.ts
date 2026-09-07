import { Router } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../../../tests/helpers/redis.ts';
import { store } from '../../db/schema/store.js';
import { createIdentityRepository } from '../../modules/identity/identity.repository.js';
import { createIdentityRoutes } from '../../modules/identity/identity.routes.js';
import { createIdentityService } from '../../modules/identity/identity.service.js';
import { createRefreshSessionRepository } from '../../modules/identity/refresh-session.repository.js';
import { createTokenService } from '../../modules/identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../modules/stores/index.js';
import {
  createRateLimiter,
  hashRateLimitSubject,
  type RateLimitPolicy,
} from '../../redis/rate-limiter.js';
import { newId } from '../../shared/id.js';
import { createApp } from '../app.js';
import { RATE_LIMIT_BUCKETS } from '../middleware/rate-limit.js';
import { resolveStore } from '../middleware/store.js';
import { testRecorders } from '../../../tests/helpers/recording.ts';

/**
 * Authentication rate limiting, end to end.
 *
 * Real PostgreSQL, real Redis, real Argon2, and the same assembly the composition root uses —
 * because the thing most likely to be wrong is not the limiter (its own suite covers that) but
 * the WIRING: whether the middleware and the service agree on a key, whether the limiter runs
 * before the password check, whether the store reaches the subject. None of that is observable
 * from a unit test of either piece alone.
 */
describe('auth rate limiting (integration)', () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let redis: Redis;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const EMAIL = 'buyer@example.com';

  /** Deliberately tiny, so a test spends 3 attempts rather than 10. */
  const IP_POLICY: RateLimitPolicy = { max: 4, windowSeconds: 60 };
  const EMAIL_POLICY: RateLimitPolicy = { max: 2, windowSeconds: 60 };

  /**
   * A budget large enough never to be the limit under test.
   *
   * Every request in this suite arrives from 127.0.0.1 and, on login, carries one address —
   * so both limiters are always live and the tighter one decides. Each test therefore relaxes
   * the limiter it is NOT examining, otherwise a per-IP assertion would silently be measuring
   * the per-email limit and would keep passing if the per-IP limiter were deleted.
   */
  const ROOMY: RateLimitPolicy = { max: 100, windowSeconds: 60 };

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([startTestDatabase(), startTestRedis()]);
    redis = new Redis(testRedis.url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  }, 240_000);

  afterAll(async () => {
    await redis?.quit();
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  beforeEach(async () => {
    await testDb.truncate();
    await testRedis.flush();
    storeId = (await seedTestStore(testDb)).id;
  });

  const db = () => testDb.handle.db;

  /**
   * The production assembly, with the limiter policies injected.
   *
   * `redisOverride` lets one test point the limiter at a dead server to prove the fail-closed
   * path, without disturbing the shared client every other test uses.
   */
  function build(
    options: {
      redisOverride?: Redis;
      /** Relax the limiter a test is not examining. */
      ip?: RateLimitPolicy;
      email?: RateLimitPolicy;
    } = {},
  ) {
    const limiter = createRateLimiter({
      redis: options.redisOverride ?? redis,
      logger: silentLogger,
    });

    const ipPolicy = options.ip ?? IP_POLICY;
    const emailPolicy = options.email ?? EMAIL_POLICY;

    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const identity = createIdentityService({
      repository: createIdentityRepository({ db: db() }),
      sessions: createRefreshSessionRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
      /**
       * The same adapter the composition root builds, hashing with the same helper and the
       * same argument order. If this drifted from `container.ts`, these tests would pass
       * while production silently never enforced the email limit.
       */
      loginAttempts: {
        async recordFailure({ storeId: sid, email }) {
          await limiter.record(
            RATE_LIMIT_BUCKETS.loginEmail,
            hashRateLimitSubject(sid, email),
            emailPolicy,
          );
        },
        async clear({ storeId: sid, email }) {
          await limiter.reset(RATE_LIMIT_BUCKETS.loginEmail, hashRateLimitSubject(sid, email));
        },
      },
    });

    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: createStoreRepository({ db: db() }),
          slug: testDb.config.defaultStoreSlug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );
    apiRouter.use(
      createIdentityRoutes({
        identity,
        tokens,
        logger: silentLogger,
        rateLimit: { limiter, ipPolicy, emailPolicy, logger: silentLogger },
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
    };
  }

  /** Register a user through the service, bypassing the HTTP limiters. */
  async function seedUser(email = EMAIL): Promise<void> {
    const { identity } = build();
    await identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
  }

  describe('per-IP limit on login', () => {
    it('blocks once the budget is spent, counting every attempt', async () => {
      await seedUser();
      const { app } = build({ email: ROOMY });

      const statuses: number[] = [];
      for (let i = 0; i < IP_POLICY.max + 1; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
        statuses.push(response.status);
      }

      // Four 401s, then the fifth request never reaches Argon2.
      expect(statuses).toEqual([401, 401, 401, 401, 429]);
    });

    it('counts SUCCESSFUL logins too', async () => {
      await seedUser();
      // Successes never touch the email budget, but relax it anyway so this test can only
      // ever be measuring the per-IP limiter.
      const { app } = build({ email: ROOMY });

      const statuses: number[] = [];
      for (let i = 0; i < IP_POLICY.max + 1; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: PASSWORD });
        statuses.push(response.status);
      }

      /**
       * The per-IP limiter exists to cap CPU, and a successful Argon2 verification costs
       * exactly as much as a failed one. Exempting successes would leave the whole API
       * stallable by one client looping over valid credentials.
       */
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
    });

    it('counts malformed bodies, which never reach validation', async () => {
      const { app } = build();

      const statuses: number[] = [];
      for (let i = 0; i < IP_POLICY.max + 1; i += 1) {
        const response = await request(app).post('/api/v1/auth/login').send({ nonsense: true });
        statuses.push(response.status);
      }

      /**
       * The limiter is mounted BEFORE `validate` on purpose. A flood of garbage is still a
       * flood, and if validation ran first an attacker could burn CPU on Zod parsing forever
       * without ever touching their budget.
       */
      expect(statuses).toEqual([400, 400, 400, 400, 429]);
    });
  });

  describe('per-IP limit on register', () => {
    it('blocks once the budget is spent', async () => {
      const { app } = build();

      const statuses: number[] = [];
      for (let i = 0; i < IP_POLICY.max + 1; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/register')
          .send({ email: `signup-${String(i)}@example.com`, password: PASSWORD });
        statuses.push(response.status);
      }

      /**
       * Registration runs Argon2 at the HASHING cost, which is higher than verification.
       * Leaving it unlimited would mean the cheapest way to stall the API was the endpoint
       * that does not even need a password to be correct.
       */
      expect(statuses).toEqual([201, 201, 201, 201, 429]);
    });

    it('has a budget separate from login', async () => {
      await seedUser();
      const { app } = build();

      for (let i = 0; i < IP_POLICY.max + 1; i += 1) {
        await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: `other-${String(i)}@example.com`,
            password: PASSWORD,
          });
      }

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });

      // Separate buckets. Being throttled on signup must not lock existing customers out.
      expect(login.status).toBe(200);
    });
  });

  describe('per-email failure limit', () => {
    it('blocks after `max` failures, before the password is checked', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      const statuses: number[] = [];
      for (let i = 0; i < EMAIL_POLICY.max + 1; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
        statuses.push(response.status);
      }

      expect(statuses).toEqual([401, 401, 429]);
    });

    it('rejects the CORRECT password once the budget is spent', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      for (let i = 0; i < EMAIL_POLICY.max; i += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
      }

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });

      /**
       * The proof that the limiter SHORT-CIRCUITS authentication rather than merely reporting
       * on it. A valid password now gets a 429, which means no Argon2 ran — which is the
       * entire point of putting the check ahead of the handler. If this returned 200 the
       * limiter would be decorative under exactly the load it exists to survive.
       */
      expect(response.status).toBe(429);
    });

    it('does NOT count successful logins', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      // Five successes against a budget of two. A request counter would have blocked at three.
      for (let i = 0; i < 5; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: PASSWORD });
        expect(response.status).toBe(200);
      }
    });

    it('resets the counter on a successful login', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      // One short of the limit.
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: 'the-wrong-password' });

      await request(app).post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });

      /**
       * The forgiveness rule. Without it, a user who mistypes their password on Monday and
       * again on Tuesday carries those failures for the whole window and is locked out by a
       * third typo weeks of successful sign-ins later.
       */
      const key = `rl:${RATE_LIMIT_BUCKETS.loginEmail}:${hashRateLimitSubject(storeId, EMAIL)}`;
      expect(await redis.exists(key)).toBe(0);

      // And the budget is genuinely usable again.
      const statuses: number[] = [];
      for (let i = 0; i < EMAIL_POLICY.max; i += 1) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
        statuses.push(response.status);
      }
      expect(statuses).toEqual([401, 401]);
    });

    it('keeps one address from exhausting another address budget', async () => {
      await seedUser();
      await seedUser('other@example.com');
      const { app } = build({ ip: ROOMY });

      for (let i = 0; i < EMAIL_POLICY.max + 1; i += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
      }

      const other = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'other@example.com', password: PASSWORD });

      // Otherwise attacking one account would lock out every other customer behind it.
      expect(other.status).toBe(200);
    });

    it('normalises the address, so casing cannot multiply the budget', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: 'the-wrong-password' });
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: '  BUYER@Example.COM  ', password: 'the-wrong-password' });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'Buyer@Example.com', password: 'the-wrong-password' });

      /**
       * The middleware normalises the RAW body the same way `emailField` does. If it did not,
       * `BUYER@…` and `buyer@…` would be separate buckets and an attacker would get a fresh
       * budget per capitalisation — 2^n free budgets for an n-character address.
       */
      expect(response.status).toBe(429);
    });

    it('keeps the budget separate per store', async () => {
      await seedUser();

      // A second tenant with a customer at the same address — legitimate, and the reason the
      // store id is part of the subject.
      const secondStoreId = newId();
      await db()
        .insert(store)
        .values({ id: secondStoreId, slug: 'second', name: 'Second', isActive: true });

      const { app, identity } = build({ ip: ROOMY });
      await identity.registerCustomer({
        storeId: secondStoreId,
        input: { email: EMAIL, password: PASSWORD, firstName: '', lastName: '' },
      });

      for (let i = 0; i < EMAIL_POLICY.max + 1; i += 1) {
        await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'the-wrong-password' });
      }

      /**
       * The default resolver pins requests to store one, so the second store's counter is
       * asserted directly. What matters is that the two subjects differ — otherwise one
       * tenant's failed logins would lock out another tenant's customers, which is both a
       * cross-tenant leak and a trivial way to attack a competitor.
       */
      const first = hashRateLimitSubject(storeId, EMAIL);
      const second = hashRateLimitSubject(secondStoreId, EMAIL);
      expect(second).not.toBe(first);

      expect(await redis.exists(`rl:${RATE_LIMIT_BUCKETS.loginEmail}:${first}`)).toBe(1);
      expect(await redis.exists(`rl:${RATE_LIMIT_BUCKETS.loginEmail}:${second}`)).toBe(0);
    });
  });

  describe('the 429 response', () => {
    it('carries Retry-After and details.retryAfterSeconds', async () => {
      const { app } = build({ email: ROOMY });

      let blocked = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });
      for (let i = 0; i < IP_POLICY.max; i += 1) {
        blocked = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: PASSWORD });
      }

      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');

      /**
       * BOTH signals, and both matter. The header is what an SDK, a proxy, or a browser
       * honours with no client code at all; the body field is what a UI renders as "try again
       * in 42 seconds". Sending only the body means well-behaved clients retry immediately.
       */
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(Number(blocked.headers['retry-after'])).toBe(
        blocked.body.error.details.retryAfterSeconds,
      );
    });

    it('advertises the budget on ALLOWED responses too', async () => {
      await seedUser();
      // Roomy email budget, so the tightest-wins header logic reports the per-IP limit and
      // this test pins a known number rather than whichever limiter happened to be smaller.
      const { app } = build({ email: ROOMY });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });

      // A client that can see it has one attempt left can back off before being blocked.
      expect(response.status).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe(String(IP_POLICY.max));
      expect(response.headers['x-ratelimit-remaining']).toBe(String(IP_POLICY.max - 1));
    });

    it('reveals nothing about whether the account exists', async () => {
      await seedUser();
      const { app } = build({ ip: ROOMY });

      const exhaust = async (email: string): Promise<request.Response> => {
        let last = await request(app).post('/api/v1/auth/login').send({ email, password: 'nope' });
        for (let i = 0; i < EMAIL_POLICY.max; i += 1) {
          last = await request(app).post('/api/v1/auth/login').send({ email, password: 'nope' });
        }
        return last;
      };

      const real = await exhaust(EMAIL);
      const fake = await exhaust('does-not-exist@example.com');

      /**
       * The enumeration guard, and the reason the service counts failures for unknown
       * addresses too. If only real accounts had counters, a 429 would confirm the address
       * exists while a nonexistent one kept answering 401 — rebuilding, inside the
       * brute-force defence, exactly the oracle `InvalidCredentials` exists to close.
       */
      expect(real.status).toBe(429);
      expect(fake.status).toBe(429);
      expect(fake.body.error.code).toBe(real.body.error.code);
      expect(fake.body.error.message).toBe(real.body.error.message);
    });

    it('does not echo the email anywhere in the response', async () => {
      const { app } = build({ email: ROOMY });

      let blocked = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: 'x' });
      for (let i = 0; i < IP_POLICY.max; i += 1) {
        blocked = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: EMAIL, password: 'x' });
      }

      // A 429 that quotes the address back is a reflection surface and a log-injection vector.
      expect(blocked.status).toBe(429);
      expect(JSON.stringify(blocked.body)).not.toContain(EMAIL);
    });
  });

  describe('failing closed', () => {
    it('returns 503 rather than allowing the request when Redis is down', async () => {
      await seedUser();

      const dead = new Redis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      dead.on('error', () => {});

      const { app } = build({ redisOverride: dead });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: EMAIL, password: PASSWORD });

      /**
       * THE security property of this increment. A limiter that allows the request when its
       * backend is unavailable is a limiter an attacker removes by attacking Redis — turning
       * an availability problem into unlimited brute force.
       *
       * 503 and not 200, even though these are valid credentials. The readiness probe already
       * treats Redis as required, so an instance in this state is being pulled from the load
       * balancer anyway; refusing the request is consistent with that, not an extra outage.
       */
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');

      dead.disconnect();
    }, 30_000);
  });

  describe('the email limiter abstains when there is no email', () => {
    it('lets validation reject a body with no email', async () => {
      const { app } = build();

      const response = await request(app).post('/api/v1/auth/login').send({ password: PASSWORD });

      /**
       * A 400 from `validate`, not a 429 and not a crash. Inventing a bucket for absent
       * emails would put every malformed request in the world into one counter, so the first
       * attacker to send garbage would lock out everyone else's typos behind the same key.
       * The per-IP limiter still counted this attempt, so the flood is capped regardless.
       */
      expect(response.status).toBe(400);
    });

    it('lets validation reject a non-string email', async () => {
      const { app } = build();

      // `String({})` would key a bucket on `[object Object]`; a number would key on its digits.
      for (const email of [42, null, { nested: true }, ['a@b.co']]) {
        const response = await request(app)
          .post('/api/v1/auth/login')
          .send({ email, password: PASSWORD });
        expect(response.status).toBe(400);
      }
    });
  });
});
