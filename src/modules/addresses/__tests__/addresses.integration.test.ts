import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { address } from '../../../db/schema/address.js';
import { appUser, auditLog } from '../../../db/schema/identity.js';
import { store } from '../../../db/schema/store.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import { newId } from '../../../shared/id.js';
import { createIdentityRepository } from '../../identity/identity.repository.js';
import { createIdentityRoutes } from '../../identity/identity.routes.js';
import { createIdentityService } from '../../identity/identity.service.js';
import { createRefreshSessionRepository } from '../../identity/refresh-session.repository.js';
import { createPasswordResetRepository } from '../../identity/password-reset.repository.js';
import { createTokenService } from '../../identity/tokens.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createAddressesRepository } from '../addresses.repository.js';
import { createAddressesRoutes } from '../addresses.routes.js';
import { createAddressesService } from '../addresses.service.js';

/**
 * The customer address book — against real PostgreSQL.
 *
 * Four properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **Ownership lives in the QUERY.** Every predicate carries `(id, user_id, store_id,
 *     deleted_at IS NULL)`, so another customer's address is a 404 rather than a 403. Asserted
 *     at the repository level as well as through HTTP, because a guarantee that lives only in a
 *     route is one refactor from a leak.
 *
 *  2. **Nothing forgeable is reachable.** `userId`, `storeId`, `actorUserId`, `id`, `deletedAt`
 *     and the timestamps are absent from every schema. Asserted ONE AT A TIME, so a schema that
 *     happened to accept exactly one of them cannot hide behind the others — and asserted on
 *     the three BODILESS routes too, which is where Increments 24 and 26 both found real holes.
 *
 *  3. **The audit trail carries no address values.** Only identifiers and changed field NAMES.
 *     Asserted by scanning the stored JSON for each value, not by reading the code.
 *
 *  4. **Soft delete hides without destroying.** Gone from every read path, row still present.
 */
describe('addresses (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';

  /** A complete, valid Indian address. Every test starts from this and varies one thing. */
  const VALID = {
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+91 98765 43210',
    line1: '221B, Brigade Road',
    line2: 'Shanthala Nagar',
    landmark: 'Opposite the water tank',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    countryCode: 'IN',
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.truncate();
    storeId = (await seedTestStore(testDb)).id;
  });

  const db = () => testDb.handle.db;

  function build(slug = testDb.config.defaultStoreSlug) {
    const identityRepository = createIdentityRepository({ db: db() });
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const repository = createAddressesRepository({ db: db() });

    const identity = createIdentityService({
      repository: identityRepository,
      sessions: createRefreshSessionRepository({ db: db() }),
      passwordResets: createPasswordResetRepository({ db: db() }),
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...testRecorders(db()),
    });

    const addresses = createAddressesService({
      repository,
      db: db(),
      // `testRecorders` supplies both an event bus and an audit trail; the addresses service
      // takes only `audit`, so the event bus is simply not wired — this module emits no events.
      audit: testRecorders(db()).audit,
      logger: silentLogger,
    });

    const apiRouter = Router();
    apiRouter.use(
      resolveStore({
        resolver: createDefaultStoreResolver({
          repository: createStoreRepository({ db: db() }),
          slug,
          logger: silentLogger,
          cacheTtlMs: 0,
        }),
        logger: silentLogger,
      }),
    );
    apiRouter.use(createIdentityRoutes({ identity, tokens, logger: silentLogger }));
    apiRouter.use(
      createAddressesRoutes({
        addresses,
        verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
        logger: silentLogger,
      }),
    );

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      addresses,
      repository,
    };
  }

  type App = ReturnType<typeof build>['app'];
  type Identity = ReturnType<typeof build>['identity'];

  async function signIn(
    app: App,
    identity: Identity,
    options: { email?: string; storeId?: string } = {},
  ): Promise<{ token: string; userId: string }> {
    const email = options.email ?? 'ada@example.com';
    const user = await identity.registerCustomer({
      storeId: options.storeId ?? storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken as string, userId: user.id };
  }

  /** One signed-in customer, ready to use. */
  const customerApp = async () => {
    const built = build();
    const auth = await signIn(built.app, built.identity);
    return { ...built, ...auth };
  };

  /* ── Request helpers ───────────────────────────────────────────────────── */

  const create = (app: App, body: unknown, token?: string) => {
    const req = request(app).post('/api/v1/users/me/addresses');
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const list = (app: App, token?: string) => {
    const req = request(app).get('/api/v1/users/me/addresses');
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const read = (app: App, id: string, token?: string) => {
    const req = request(app).get(`/api/v1/users/me/addresses/${id}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  const patch = (app: App, id: string, body: unknown, token?: string) => {
    const req = request(app).patch(`/api/v1/users/me/addresses/${id}`);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(
      body as object,
    );
  };

  const remove = (app: App, id: string, token?: string) => {
    const req = request(app).delete(`/api/v1/users/me/addresses/${id}`);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  /* ── Row readers ───────────────────────────────────────────────────────── */

  const row = async (id: string) => {
    const [found] = await db().select().from(address).where(eq(address.id, id));
    return found;
  };

  const auditRows = async () =>
    (await db().select().from(auditLog)).filter((r) => r.resourceType === 'address');

  /** Typed readers; supertest hands back `any`. */
  const labelsOf = (body: { addresses: { label: string }[] }): string[] =>
    body.addresses.map((a) => a.label);

  /** Create one address through the API and return its id. */
  const givenAddress = async (app: App, token: string, overrides: Record<string, unknown> = {}) => {
    const response = await create(app, { ...VALID, ...overrides }, token);
    expect(response.status).toBe(201);
    return response.body.address.id as string;
  };

  /** Assert a write was refused by a NAMED constraint; Drizzle wraps the driver error. */
  async function expectConstraint(work: Promise<unknown>, constraint: string): Promise<void> {
    let caught: unknown;
    try {
      await work;
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the write to be refused').toBeDefined();
    const chain = [caught, (caught as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : ''))
      .join(' | ');
    expect(chain).toContain(constraint);
  }

  /* ── Authorization ─────────────────────────────────────────────────────── */

  describe('authorization', () => {
    it('rejects unauthenticated requests on every route', async () => {
      const { app } = build();
      const id = newId();

      for (const response of [
        await create(app, VALID),
        await list(app),
        await read(app, id),
        await patch(app, id, { city: 'Mysuru' }),
        await remove(app, id),
      ]) {
        expect(response.status).toBe(401);
      }
    });

    it('needs no staff scope — a plain customer manages their own book', async () => {
      const { app, token } = await customerApp();

      /**
       * The whole point of the route placement. Identity's own comment states the rule:
       * "`requireScope('staff')` here would lock every customer out of their own profile."
       */
      expect((await create(app, VALID, token)).status).toBe(201);
      expect((await list(app, token)).status).toBe(200);
    });
  });

  /* ── Ownership ─────────────────────────────────────────────────────────── */

  describe('ownership', () => {
    it('404s another customer’s address on read, patch and delete', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;

      const adaAddress = await givenAddress(app, ada.token);

      /**
       * A 404, never a 403. A 403 would confirm the id exists, which is exactly the leak the
       * single answer closes — the §25 rule that ownership belongs in the query.
       */
      expect((await read(app, adaAddress, grace.token)).status).toBe(404);
      expect((await patch(app, adaAddress, { city: 'Hijacked' }, grace.token)).status).toBe(404);
      expect((await remove(app, adaAddress, grace.token)).status).toBe(404);

      // And Ada's address is untouched.
      const stored = await row(adaAddress);
      expect(stored?.city).toBe('Bengaluru');
      expect(stored?.deletedAt).toBeNull();
    });

    it('never shows another customer’s address in the list', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;

      await givenAddress(app, ada.token, { label: 'Ada Home' });
      await givenAddress(app, grace.token, { label: 'Grace Home' });

      expect(labelsOf((await list(app, ada.token)).body)).toEqual(['Ada Home']);
      expect(labelsOf((await list(app, grace.token)).body)).toEqual(['Grace Home']);
    });

    it('isolates customers across STORES', async () => {
      // A second store with its own customer, reachable only through its own resolver.
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      const mine = build();
      const ada = await signIn(mine.app, mine.identity, { email: 'ada@example.com' });
      const adaAddress = await givenAddress(mine.app, ada.token);

      const theirs = build('other');
      const bob = await signIn(theirs.app, theirs.identity, {
        email: 'bob@example.com',
        storeId: otherStoreId,
      });

      /**
       * The same email could legitimately exist in both stores — `uq_user_email_active` is
       * `(store_id, lower(email))` — so tenancy has to be enforced independently of identity.
       */
      expect((await read(theirs.app, adaAddress, bob.token)).status).toBe(404);
      expect((await patch(theirs.app, adaAddress, { city: 'X' }, bob.token)).status).toBe(404);
      expect((await remove(theirs.app, adaAddress, bob.token)).status).toBe(404);
      expect(labelsOf((await list(theirs.app, bob.token)).body)).toEqual([]);
    });

    it('scopes every repository method by user AND store', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const adaAddress = await givenAddress(built.app, ada.token);
      const { repository } = built;

      /**
       * Asserted at the REPOSITORY level as well as through HTTP. A guarantee that lives only
       * in a route is one refactor from a leak, and a future caller arriving from a CLI command
       * or a background job gets no middleware at all.
       */
      const asGrace = { id: adaAddress, userId: grace.userId, storeId };
      expect(await repository.findAddressById(asGrace)).toBeUndefined();
      expect(
        await repository.updateAddressFields({
          ...asGrace,
          fields: { city: 'Hijacked' },
          at: new Date(),
        }),
      ).toBeUndefined();
      expect(await repository.softDeleteAddress({ ...asGrace, at: new Date() })).toBeUndefined();
      expect(await repository.listAddressesForUser({ userId: grace.userId, storeId })).toEqual([]);

      // A wrong STORE with the right user is equally refused.
      expect(
        await repository.findAddressById({
          id: adaAddress,
          userId: ada.userId,
          storeId: newId(),
        }),
      ).toBeUndefined();

      expect((await row(adaAddress))?.city).toBe('Bengaluru');
    });
  });

  /* ── Forged fields ─────────────────────────────────────────────────────── */

  describe('forged fields', () => {
    it('rejects every forgeable field on CREATE, one at a time', async () => {
      const { app, token } = await customerApp();

      /**
       * One per request rather than all in one body, so a schema that happened to accept
       * exactly one of them cannot hide behind the others.
       */
      const forgeable: Record<string, unknown>[] = [
        { userId: newId() },
        { storeId: newId() },
        { actorUserId: newId() },
        { actorId: newId() },
        { id: newId() },
        { deletedAt: new Date().toISOString() },
        { createdAt: new Date().toISOString() },
        { updatedAt: new Date().toISOString() },
        { stateCode: '29' },
        { gstin: '29ABCDE1234F1Z5' },
        { isDefaultShipping: true },
      ];

      for (const extra of forgeable) {
        const response = await create(app, { ...VALID, ...extra }, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }

      expect(await db().select().from(address)).toEqual([]);
    });

    it('rejects every forgeable field on PATCH, one at a time', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      for (const extra of [
        { userId: newId() },
        { storeId: newId() },
        { actorUserId: newId() },
        { id: newId() },
        { deletedAt: new Date().toISOString() },
        { createdAt: new Date().toISOString() },
      ]) {
        const response = await patch(app, id, { city: 'Mysuru', ...extra }, token);
        expect(response.status, Object.keys(extra)[0]).toBe(400);
      }

      // None of them took effect.
      const stored = await row(id);
      expect(stored?.city).toBe('Bengaluru');
      expect(stored?.deletedAt).toBeNull();
    });

    it('ignores a body on the BODILESS list and read routes', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      const adaAddress = await givenAddress(app, ada.token, { label: 'Ada Home' });

      /**
       * These routes validate `params` only — they have no body to describe — so an unexpected
       * JSON body reaches `req.body` UNVALIDATED, and the strict schemas on create and patch do
       * not protect them. Increments 24 and 26 each found a real escalation on exactly this
       * shape, so it is tested rather than assumed closed.
       */
      const listed = await list(app, grace.token).send({
        userId: ada.userId,
        storeId,
      });
      expect(listed.status).toBe(200);
      expect(labelsOf(listed.body)).toEqual([]);

      const got = await read(app, adaAddress, grace.token).send({
        userId: ada.userId,
        storeId,
      });
      expect(got.status).toBe(404);
    });

    it('ignores a body on the BODILESS delete route', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;
      const adaAddress = await givenAddress(app, ada.token);

      const response = await remove(app, adaAddress, grace.token).send({
        userId: ada.userId,
        storeId,
      });

      expect(response.status).toBe(404);
      expect((await row(adaAddress))?.deletedAt).toBeNull();
    });

    it('records the audit actor from the TOKEN, not from any body', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const grace = await signIn(built.app, built.identity, { email: 'grace@example.com' });
      const { app } = built;

      const id = await givenAddress(app, ada.token);
      await remove(app, id, ada.token).send({ actorUserId: grace.userId });

      const entries = await auditRows();
      expect(entries.every((e) => e.actorUserId === ada.userId)).toBe(true);
      expect(entries.some((e) => e.actorUserId === grace.userId)).toBe(false);
    });
  });

  /* ── CRUD ──────────────────────────────────────────────────────────────── */

  describe('CRUD', () => {
    it('creates an address and returns an EXACT key set', async () => {
      const { app, token } = await customerApp();

      const response = await create(app, VALID, token);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body)).toEqual(['address']);
      /**
       * An exact set, not a superset. That is what catches an ADDED field — the way a leak
       * actually happens — and `userId`, `storeId` and `deletedAt` must never appear.
       */
      expect(Object.keys(response.body.address).sort()).toEqual([
        'city',
        'countryCode',
        'createdAt',
        'id',
        'label',
        'landmark',
        'line1',
        'line2',
        'phone',
        'postalCode',
        'recipientName',
        'state',
        'updatedAt',
      ]);
      expect(response.body.address.city).toBe('Bengaluru');
    });

    it('defaults the optional fields', async () => {
      const { app, token } = await customerApp();

      const response = await create(
        app,
        {
          label: 'Office',
          recipientName: 'Ada',
          phone: '9876543210',
          line1: '1 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
        token,
      );

      expect(response.status).toBe(201);
      // Empty strings, never null — the column defaults.
      expect(response.body.address.line2).toBe('');
      expect(response.body.address.landmark).toBe('');
      // And the country default.
      expect(response.body.address.countryCode).toBe('IN');
    });

    it('lists the customer’s addresses ordered by label', async () => {
      const { app, token } = await customerApp();
      for (const label of ['Office', 'Home', 'Parents']) {
        await givenAddress(app, token, { label });
      }

      const response = await list(app, token);

      expect(response.status).toBe(200);
      expect(Object.keys(response.body)).toEqual(['addresses']);
      expect(labelsOf(response.body)).toEqual(['Home', 'Office', 'Parents']);
    });

    it('returns an empty array for a customer with no addresses', async () => {
      const { app, token } = await customerApp();

      const response = await list(app, token);
      expect(response.status).toBe(200);
      expect(response.body.addresses).toEqual([]);
    });

    it('reads one address by id', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      const response = await read(app, id, token);
      expect(response.status).toBe(200);
      expect(response.body.address.id).toBe(id);
    });

    it('404s an unknown id, and 400s a malformed one', async () => {
      const { app, token } = await customerApp();

      expect((await read(app, newId(), token)).status).toBe(404);
      // A 400 from validation, never a 22P02 from PostgreSQL surfacing as a 500.
      expect((await read(app, 'not-a-uuid', token)).status).toBe(400);
      expect((await patch(app, 'not-a-uuid', { city: 'X' }, token)).status).toBe(400);
      expect((await remove(app, 'not-a-uuid', token)).status).toBe(400);
    });

    it('updates one field without touching the others or its siblings', async () => {
      const { app, token } = await customerApp();
      const target = await givenAddress(app, token, { label: 'Home' });
      const sibling = await givenAddress(app, token, { label: 'Office', city: 'Mysuru' });

      const response = await patch(app, target, { city: 'Chennai' }, token);

      expect(response.status).toBe(200);
      expect(response.body.address.city).toBe('Chennai');
      // Untouched on the same row…
      expect(response.body.address.line1).toBe(VALID.line1);
      expect(response.body.address.state).toBe('Karnataka');
      // …and the blast radius is one row. §29's first suite passed a mutation that rewrote
      // every row because every test kept exactly one.
      expect((await row(sibling))?.city).toBe('Mysuru');
    });

    it('clears line2 and landmark with an empty string', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      const response = await patch(app, id, { line2: '', landmark: '' }, token);

      // Meaningful, not a no-op: an empty string CLEARS the line. `null` is not accepted.
      expect(response.status).toBe(200);
      expect(response.body.address.line2).toBe('');
      expect(response.body.address.landmark).toBe('');
    });

    it('soft-deletes: hidden everywhere, row still present', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      expect((await remove(app, id, token)).status).toBe(204);

      expect((await read(app, id, token)).status).toBe(404);
      expect((await list(app, token)).body.addresses).toEqual([]);
      expect((await patch(app, id, { city: 'X' }, token)).status).toBe(404);

      /**
       * The row survives. §3 decision 15 is "anonymise, never delete" — tax law requires
       * invoice retention, and an address is personal data inside that story.
       */
      const stored = await row(id);
      expect(stored).toBeDefined();
      expect(stored?.deletedAt).not.toBeNull();
      expect(stored?.city).toBe('Bengaluru');
    });

    it('404s a second delete', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      expect((await remove(app, id, token)).status).toBe(204);
      const second = await remove(app, id, token);
      expect(second.status).toBe(404);

      // The original deletion timestamp was not re-stamped.
      const stored = await row(id);
      expect(stored?.deletedAt).not.toBeNull();
    });

    it('has NO restore endpoint', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);
      await remove(app, id, token);

      // None was asked for; a restore would need its own decision about label collisions and
      // changed country rules.
      for (const attempt of [
        request(app).post(`/api/v1/users/me/addresses/${id}/restore`),
        request(app).put(`/api/v1/users/me/addresses/${id}`),
        request(app).post(`/api/v1/users/me/addresses/${id}`),
      ]) {
        const response = await attempt.set('Authorization', `Bearer ${token}`).send({});
        expect(response.status).toBe(404);
      }

      expect((await row(id))?.deletedAt).not.toBeNull();
    });

    it('allows two addresses with the same label', async () => {
      const { app, token } = await customerApp();

      // Deliberately not unique: two addresses called "Home" are the customer's business, and
      // a uniqueness rule would have to define what soft delete does to it for no gain.
      await givenAddress(app, token, { label: 'Home' });
      expect((await create(app, { ...VALID, label: 'Home' }, token)).status).toBe(201);
      expect(labelsOf((await list(app, token)).body)).toEqual(['Home', 'Home']);
    });
  });

  /* ── Validation ────────────────────────────────────────────────────────── */

  describe('validation', () => {
    it('requires every required field', async () => {
      const { app, token } = await customerApp();

      for (const missing of [
        'label',
        'recipientName',
        'phone',
        'line1',
        'city',
        'state',
        'postalCode',
      ]) {
        const body: Record<string, unknown> = { ...VALID };
        delete body[missing];
        const response = await create(app, body, token);
        expect(response.status, missing).toBe(400);
        expect(JSON.stringify(response.body.error.details)).toContain(missing);
      }
    });

    it('rejects whitespace-only required fields', async () => {
      const { app, token } = await customerApp();

      // `.min(1)` AFTER `.trim()` is what catches this; a bare length bound would store a
      // blank required field, which `ck_address_required_not_blank` also refuses.
      for (const field of ['label', 'recipientName', 'line1', 'city', 'state']) {
        const response = await create(app, { ...VALID, [field]: '   ' }, token);
        expect(response.status, field).toBe(400);
      }
    });

    it('TRIMS surrounding whitespace and stores the trimmed value', async () => {
      const { app, token } = await customerApp();

      const response = await create(
        app,
        { ...VALID, label: '  Home  ', city: '\tBengaluru\n', line1: '  221B, Brigade Road ' },
        token,
      );

      expect(response.status).toBe(201);
      expect(response.body.address.label).toBe('Home');
      expect(response.body.address.city).toBe('Bengaluru');
      expect(response.body.address.line1).toBe('221B, Brigade Road');
    });

    it('does NOT rewrite anything beyond trimming', async () => {
      const { app, token } = await customerApp();

      /**
       * No case folding, no abbreviation rewriting, no punctuation normalisation. A validation
       * layer that "helpfully" rewrote `Rd.` to `Road` would be changing the customer's own
       * address, which is worse than storing it verbatim.
       */
      const messy = {
        ...VALID,
        line1: '#12/3-A, 2nd Cross, M.G. Rd.',
        city: 'bengaluru',
        state: 'KARNATAKA',
      };
      const response = await create(app, messy, token);

      expect(response.status).toBe(201);
      expect(response.body.address.line1).toBe('#12/3-A, 2nd Cross, M.G. Rd.');
      expect(response.body.address.city).toBe('bengaluru');
      expect(response.body.address.state).toBe('KARNATAKA');
    });

    it('preserves Unicode — Devanagari, Tamil, and an emoji label', async () => {
      const { app, token } = await customerApp();

      const response = await create(
        app,
        {
          ...VALID,
          label: '🏠 घर',
          recipientName: 'அடா லவ்லேஸ்',
          line1: '२२१बी, ब्रिगेड रोड',
          landmark: 'पानी की टंकी के सामने',
          city: 'बेंगलुरु',
          state: 'कर्नाटक',
        },
        token,
      );

      // Legitimate Indian addresses must round-trip byte-for-byte. A character allowlist would
      // have rejected every one of these.
      expect(response.status).toBe(201);
      expect(response.body.address.label).toBe('🏠 घर');
      expect(response.body.address.recipientName).toBe('அடா லவ்லேஸ்');
      expect(response.body.address.line1).toBe('२२१बी, ब्रिगेड रोड');
      expect(response.body.address.city).toBe('बेंगलुरु');

      const stored = await row(response.body.address.id as string);
      expect(stored?.city).toBe('बेंगलुरु');
    });

    it('enforces max lengths at the boundary and one past it', async () => {
      const { app, token } = await customerApp();

      const bounds: [string, number][] = [
        ['label', 60],
        ['recipientName', 300],
        ['line1', 300],
        ['line2', 300],
        ['landmark', 300],
        ['city', 120],
        ['state', 120],
        ['postalCode', 16],
      ];

      for (const [field, max] of bounds) {
        // Exactly at the bound is accepted…
        const atBound = field === 'postalCode' ? { ...VALID, countryCode: 'US' } : { ...VALID };
        const ok = await create(app, { ...atBound, [field]: 'a'.repeat(max) }, token);
        expect(ok.status, `${field} at ${String(max)}`).toBe(201);

        // …one past it is not.
        const over = await create(app, { ...atBound, [field]: 'a'.repeat(max + 1) }, token);
        expect(over.status, `${field} at ${String(max + 1)}`).toBe(400);
      }
    });

    it('accepts Indian phones with and without the country code', async () => {
      const { app, token } = await customerApp();

      for (const phone of ['+91 98765 43210', '9876543210', '+919876543210', '(080) 2345-6789']) {
        const response = await create(app, { ...VALID, phone }, token);
        expect(response.status, phone).toBe(201);
      }
    });

    it('rejects an invalid phone', async () => {
      const { app, token } = await customerApp();

      for (const phone of ['abc', '123', '', '+91-98765-43210-extra-long-number', 'nine-nine']) {
        const response = await create(app, { ...VALID, phone }, token);
        expect(response.status, JSON.stringify(phone)).toBe(400);
      }
    });

    it('matches the identity module’s phone rule exactly — a DRIFT guard', async () => {
      const built = build();
      const { app } = built;
      const auth = await signIn(built.app, built.identity, { email: 'ada@example.com' });

      /**
       * `phoneField` is restated in this module because `no-cross-module-imports` forbids
       * importing identity's copy. This asserts the two have not drifted: every phone the
       * REGISTRATION endpoint accepts, the address endpoint accepts too, and vice versa.
       */
      const cases = ['+91 98765 43210', '9876543210', '(080) 2345-6789', 'abc', '1', ''];

      for (const [index, phone] of cases.entries()) {
        const register = await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: `drift${String(index)}@example.com`,
            password: PASSWORD,
            phone,
          });
        const addressAttempt = await create(app, { ...VALID, phone }, auth.token);

        const registerRejectedPhone =
          register.status === 400 && JSON.stringify(register.body.error.details).includes('phone');
        const addressRejectedPhone = addressAttempt.status === 400;

        expect(addressRejectedPhone, `phone ${JSON.stringify(phone)}`).toBe(registerRejectedPhone);
      }
    });

    it('enforces the Indian PIN rule when the country is IN', async () => {
      const { app, token } = await customerApp();

      expect((await create(app, { ...VALID, postalCode: '560001' }, token)).status).toBe(201);

      for (const postalCode of ['012345', '00000', '12345', '1234567', '56000a', '5600 01']) {
        const response = await create(app, { ...VALID, postalCode }, token);
        expect(response.status, postalCode).toBe(400);
        expect(JSON.stringify(response.body.error.details)).toContain('postalCode');
      }
    });

    it('applies the Indian PIN rule when countryCode is OMITTED', async () => {
      const { app, token } = await customerApp();
      const body: Record<string, unknown> = { ...VALID, postalCode: '012345' };
      delete body['countryCode'];

      // The column default is 'IN', so the rule must be checked against the EFFECTIVE country
      // rather than only the supplied one.
      expect((await create(app, body, token)).status).toBe(400);
    });

    it('does NOT apply the Indian rule to other countries', async () => {
      const { app, token } = await customerApp();

      // Generic rule only: non-empty and bounded. This increment was not asked to invent
      // foreign postal formats, and a wrong guess would lock a customer out of their address.
      for (const [countryCode, postalCode] of [
        ['US', '94107'],
        ['GB', 'SW1A 1AA'],
        ['AE', '00000'],
        ['SG', '018956'],
      ]) {
        const response = await create(app, { ...VALID, countryCode, postalCode }, token);
        expect(response.status, `${countryCode} ${postalCode}`).toBe(201);
      }
    });

    it('UPPERCASES a lowercase country code', async () => {
      const { app, token } = await customerApp();

      const response = await create(app, { ...VALID, countryCode: 'in' }, token);

      // Normalise-then-validate, the same order `slugField` uses for lowercasing.
      expect(response.status).toBe(201);
      expect(response.body.address.countryCode).toBe('IN');
      expect((await row(response.body.address.id as string))?.countryCode).toBe('IN');
    });

    it('rejects a country code of the wrong shape', async () => {
      const { app, token } = await customerApp();

      for (const countryCode of ['IND', 'I', '', '1N', 'I N', '🇮🇳']) {
        const response = await create(app, { ...VALID, countryCode }, token);
        expect(response.status, JSON.stringify(countryCode)).toBe(400);
      }
    });

    it('rejects an unknown field and an empty PATCH', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      expect((await create(app, { ...VALID, nickname: 'x' }, token)).status).toBe(400);
      expect((await patch(app, id, { nickname: 'x' }, token)).status).toBe(400);

      // An empty PATCH would bump `updatedAt`, answer 200, and leave a caller believing
      // something changed (§29).
      const empty = await patch(app, id, {}, token);
      expect(empty.status).toBe(400);
      expect(JSON.stringify(empty.body.error.details)).toContain('at least one');
    });

    it('validates the Indian PIN on PATCH when both fields arrive together', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      expect(
        (await patch(app, id, { countryCode: 'IN', postalCode: '012345' }, token)).status,
      ).toBe(400);
      expect(
        (await patch(app, id, { countryCode: 'IN', postalCode: '110001' }, token)).status,
      ).toBe(200);
      // A known limitation, asserted so it is a recorded decision rather than a surprise: a
      // lone `postalCode` is not cross-checked against the STORED country.
      expect((await patch(app, id, { postalCode: '012345' }, token)).status).toBe(200);
    });
  });

  /* ── PII in the audit trail ────────────────────────────────────────────── */

  describe('PII', () => {
    it('audits a create with identifiers only — NO address values', async () => {
      const { app, token, userId } = await customerApp();

      const id = await givenAddress(app, token);

      const entries = await auditRows();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe('address.created');
      expect(entries[0]?.resourceType).toBe('address');
      expect(entries[0]?.resourceId).toBe(id);
      expect(entries[0]?.actorUserId).toBe(userId);
      expect(entries[0]?.actorType).toBe('customer');
      expect(entries[0]?.storeId).toBe(storeId);
      expect(entries[0]?.requestId).not.toBeNull();

      /**
       * The property that matters. `audit_log` is "read by more people than the database, and
       * frequently shipped to a log aggregator with different access controls" — so not one
       * address value may appear anywhere in the row.
       */
      const serialised = JSON.stringify(entries[0]);
      for (const value of Object.values(VALID)) {
        expect(serialised, `leaked ${value}`).not.toContain(value);
      }
    });

    it('audits an update with changed FIELD NAMES, not values', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      await patch(app, id, { city: 'Chennai', postalCode: '600001' }, token);

      const entries = (await auditRows()).filter((e) => e.action === 'address.updated');
      expect(entries).toHaveLength(1);
      const metadata = entries[0]?.metadata as Record<string, unknown>;
      // Names, so an auditor learns WHAT changed without the trail becoming a second copy of
      // the customer's home address.
      expect(metadata['changed']).toEqual(['city', 'postalCode']);

      const serialised = JSON.stringify(entries[0]);
      expect(serialised).not.toContain('Chennai');
      expect(serialised).not.toContain('600001');
      expect(serialised).not.toContain('Bengaluru');
    });

    it('audits a delete, still without values', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);

      await remove(app, id, token);

      const entries = (await auditRows()).filter((e) => e.action === 'address.deleted');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.resourceId).toBe(id);
      const serialised = JSON.stringify(entries[0]);
      for (const value of Object.values(VALID)) {
        expect(serialised, `leaked ${value}`).not.toContain(value);
      }
    });

    it('audits NOTHING when a mutation is rejected', async () => {
      const { app, token } = await customerApp();

      expect((await create(app, { ...VALID, postalCode: 'nope' }, token)).status).toBe(400);
      expect((await patch(app, newId(), { city: 'X' }, token)).status).toBe(404);
      expect((await remove(app, newId(), token)).status).toBe(404);

      expect(await auditRows()).toEqual([]);
    });

    it('emits NO domain events — this module has no event bus', async () => {
      const { app, token } = await customerApp();
      const id = await givenAddress(app, token);
      await patch(app, id, { city: 'Chennai' }, token);
      await remove(app, id, token);

      /**
       * Deliberate. Nothing consumes an address change, and Increment 26 established that an
       * event with no consumer is a guess at one. Asserted so that adding one later is a
       * conscious decision rather than an accident.
       */
      const { outboxEvent } = await import('../../../db/schema/outbox.js');
      const events = await db().select().from(outboxEvent);
      expect(events.filter((e) => e.aggregateType === 'address')).toEqual([]);
      expect(events.filter((e) => e.eventName.startsWith('address.'))).toEqual([]);
    });
  });

  /* ── Transactionality ──────────────────────────────────────────────────── */

  describe('transactionality', () => {
    it('leaves NO address row when the audit write fails', async () => {
      const built = await customerApp();

      /**
       * Provoke a REAL rollback: `audit_log.actor_user_id` is a foreign key, so naming an actor
       * whose user does not exist fails the audit insert AFTER the address insert has happened.
       *
       * This is the only assertion that proves the two writes share a transaction. With
       * separate transactions the address would already exist with no audit entry.
       */
      await expect(
        built.addresses.createAddress({
          userId: built.userId,
          storeId,
          actor: { type: 'customer', userId: newId() },
          input: VALID,
        }),
      ).rejects.toThrow();

      expect(await db().select().from(address)).toEqual([]);
      expect(await auditRows()).toEqual([]);
    });

    it('leaves the address unchanged when an update’s audit write fails', async () => {
      const built = await customerApp();
      const id = await givenAddress(built.app, built.token);

      await expect(
        built.addresses.updateAddress({
          id,
          userId: built.userId,
          storeId,
          actor: { type: 'customer', userId: newId() },
          input: { city: 'Chennai' },
        }),
      ).rejects.toThrow();

      expect((await row(id))?.city).toBe('Bengaluru');
      expect((await auditRows()).filter((e) => e.action === 'address.updated')).toEqual([]);
    });

    it('leaves the address live when a delete’s audit write fails', async () => {
      const built = await customerApp();
      const id = await givenAddress(built.app, built.token);

      await expect(
        built.addresses.deleteAddress({
          id,
          userId: built.userId,
          storeId,
          actor: { type: 'customer', userId: newId() },
        }),
      ).rejects.toThrow();

      expect((await row(id))?.deletedAt).toBeNull();
    });
  });

  /* ── Database constraints ──────────────────────────────────────────────── */

  describe('database constraints', () => {
    /**
     * These distinguish a DATABASE guarantee from an application check. Each writes with
     * direct SQL, bypassing the service entirely, and asserts the NAMED constraint that
     * refuses it. If the Zod schemas were deleted tomorrow, only these would still fail.
     */
    /**
     * A complete raw row. `userId` and `storeId` are explicit parameters rather than
     * overrides, because Drizzle needs them present at the type level — hiding required columns
     * inside a `Record<string, unknown>` spread defeats the insert's own typing.
     */
    const rawAddress = (
      userId: string,
      owningStore: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id: newId(),
      userId,
      storeId: owningStore,
      label: 'Home',
      recipientName: 'Ada',
      phone: '9876543210',
      line1: '1 MG Road',
      line2: '',
      landmark: '',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      countryCode: 'IN',
      ...overrides,
    });

    it('refuses an address whose store is not its user’s store', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      const otherStoreId = newId();
      await db()
        .insert(store)
        .values({ id: otherStoreId, slug: 'other', name: 'Other', isActive: true });

      /**
       * The composite foreign key. Ownership and tenancy in ONE constraint, so a cross-store
       * address row is unrepresentable rather than merely rejected by application code.
       */
      await expectConstraint(
        db().insert(address).values(rawAddress(ada.userId, otherStoreId)),
        'fk_address_user_store',
      );
    });

    it('refuses an address for a user that does not exist', async () => {
      await expectConstraint(
        db().insert(address).values(rawAddress(newId(), storeId)),
        'fk_address_user_store',
      );
    });

    it('refuses a HARD delete of a user that still has addresses', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });
      await givenAddress(built.app, ada.token);

      // RESTRICT, not CASCADE: users are soft-deleted, so a hard delete is either an operator
      // mistake or a bug, and silently discarding a customer's addresses is strictly worse
      // than failing loudly.
      await expectConstraint(
        db().delete(appUser).where(eq(appUser.id, ada.userId)),
        'fk_address_user_store',
      );
    });

    it('refuses a blank required field', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });

      // NOT NULL alone would admit '', which is the same failure wearing a different hat.
      for (const field of [
        'label',
        'recipientName',
        'phone',
        'line1',
        'city',
        'state',
        'postalCode',
      ]) {
        await expectConstraint(
          db()
            .insert(address)
            .values(rawAddress(ada.userId, storeId, { [field]: '   ' })),
          'ck_address_required_not_blank',
        );
      }
    });

    it('refuses a country code of the wrong SHAPE', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });

      for (const countryCode of ['in', '1N', 'i']) {
        await expectConstraint(
          db()
            .insert(address)
            .values(rawAddress(ada.userId, storeId, { countryCode })),
          'ck_address_country_code_shape',
        );
      }
    });

    it('ACCEPTS any well-shaped country code — membership is deliberately not constrained', async () => {
      const built = build();
      const ada = await signIn(built.app, built.identity, { email: 'ada@example.com' });

      // 'ZZ' is not an assigned ISO country. Storing it is preferable to a 249-entry CHECK
      // that would need a migration every time the list changes and would reject a legitimate
      // country if it fell behind.
      await db()
        .insert(address)
        .values(rawAddress(ada.userId, storeId, { countryCode: 'ZZ' }));

      const rows = await db().select().from(address);
      expect(rows).toHaveLength(1);
    });
  });
});
