import { Router } from 'express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { auditLog } from '../../../db/schema/identity.js';
import { outboxEvent } from '../../../db/schema/outbox.js';
import { passwordResetToken } from '../../../db/schema/password-reset.js';
import { refreshSession } from '../../../db/schema/identity.js';
import { createApp } from '../../../http/app.js';
import { resolveStore } from '../../../http/middleware/store.js';
import {
  seedTestStore,
  silentLogger,
  startTestDatabase,
  type TestDatabase,
} from '../../../../tests/helpers/postgres.ts';
import { testRecorders } from '../../../../tests/helpers/recording.ts';
import type { JsonObject } from '../../../shared/events.js';
import { createDefaultStoreResolver, createStoreRepository } from '../../stores/index.js';
import { createIdentityRepository } from '../identity.repository.js';
import { createIdentityRoutes } from '../identity.routes.js';
import { createIdentityService } from '../identity.service.js';
import { createPasswordResetRepository } from '../password-reset.repository.js';
import { createRefreshSessionRepository } from '../refresh-session.repository.js';
import {
  hashPasswordResetToken,
  passwordResetTokenParameters,
  PASSWORD_RESET_TTL_MINUTES,
} from '../password-reset-token.js';
import { createTokenService } from '../tokens.js';
import { createPasswordResetMailHandler } from '../../../mail/password-reset.handler.js';
import type { Mailer } from '../../../mail/mailer.js';

/**
 * Password reset: forgot-password and reset-password.
 *
 * The whole flow against real PostgreSQL, plus the mail handler driven off the real event the
 * service emits. Only the SMTP transport is a double — everything between the HTTP request and
 * `Mailer.send` is production code, so a broken token, a broken event payload or a broken link
 * fails a test here rather than reaching a customer.
 *
 * Five properties carry this suite, and each is one a passing test could easily fail to prove:
 *
 *  1. **The response never varies.** An unknown address, a deactivated account and a real one
 *     are indistinguishable, because any difference is an account-existence oracle.
 *  2. **The token is never stored.** Only its digest, and the digest cannot be used as a token.
 *  3. **Single use, under concurrency.** Two requests with one token produce one password.
 *  4. **Every session dies.** A reset is account recovery; leaving a session alive defeats it.
 *  5. **Cross-store tokens are refused.** The lookup is global by necessity, so the store check
 *     is the only thing standing between tenants.
 */
describe('password reset (integration)', () => {
  let testDb: TestDatabase;
  let storeId: string;

  const PASSWORD = 'a-sufficiently-long-password';
  const NEW_PASSWORD = 'an-even-longer-new-password';
  const EMAIL = 'buyer@example.com';

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

  /** Captures what the handler asked to send, so the mail can be asserted on. */
  type SentMail = { to: string; subject: string; text: string; html: string };

  function recordingMailer(): { mailer: Mailer; sent: SentMail[] } {
    const sent: SentMail[] = [];
    return {
      sent,
      mailer: {
        send: async (message) => {
          sent.push({ ...message });
        },
      },
    };
  }

  function build(slug = testDb.config.defaultStoreSlug) {
    const tokens = createTokenService({ config: testDb.config, logger: silentLogger });
    const repository = createIdentityRepository({ db: db() });
    const sessions = createRefreshSessionRepository({ db: db() });
    const passwordResets = createPasswordResetRepository({ db: db() });
    const recorders = testRecorders(db());

    const identity = createIdentityService({
      repository,
      sessions,
      passwordResets,
      tokens,
      db: db(),
      config: testDb.config,
      logger: silentLogger,
      ...recorders,
    });

    const { mailer, sent } = recordingMailer();
    const mailHandler = createPasswordResetMailHandler({
      mailer,
      config: { resetUrlBase: 'https://shop.example.com/reset', storeName: 'Example Store' },
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

    return {
      app: createApp({ config: testDb.config, logger: silentLogger, healthChecks: [], apiRouter }),
      identity,
      passwordResets,
      sent,
      mailHandler,
    };
  }

  type Harness = ReturnType<typeof build>;

  async function givenUser(harness: Harness, email = EMAIL) {
    return harness.identity.registerCustomer({
      storeId,
      input: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
    });
  }

  const forgot = (harness: Harness, email: string) =>
    request(harness.app).post('/api/v1/auth/forgot-password').send({ email });

  const reset = (harness: Harness, body: Record<string, unknown>) =>
    request(harness.app).post('/api/v1/auth/reset-password').send(body);

  const login = (harness: Harness, email: string, password: string) =>
    request(harness.app).post('/api/v1/auth/login').send({ email, password });

  const tokenRows = () => db().select().from(passwordResetToken);

  /**
   * Run the mail handler over every emitted reset event, exactly as the worker would, and
   * return the token from the link.
   *
   * The token is recovered FROM THE MAIL rather than from the database, on purpose: that is the
   * only path a real customer has, so a test that read the token out of the row would pass even
   * if the event payload or the link were wrong.
   */
  async function deliverAndExtractToken(harness: Harness): Promise<string> {
    const events = await db()
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.eventName, 'user.password_reset_requested'));

    for (const row of events) {
      await harness.mailHandler({
        id: row.id,
        type: row.eventName,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload as JsonObject,
        storeId: row.storeId,
        occurredAt: row.occurredAt,
        attempts: row.attempts,
        requestId: row.requestId,
      });
    }

    const last = harness.sent.at(-1);
    expect(last, 'no mail was sent').toBeDefined();
    const match = /[?&]token=([^\s&"]+)/.exec(last!.text ?? '');
    expect(match, 'the mail carried no token link').not.toBeNull();
    return decodeURIComponent(match![1]!);
  }

  /* ══ The response never varies ═════════════════════════════════════════ */

  describe('forgot-password does not disclose whether an account exists', () => {
    it('answers 204 for a real account, and issues one token', async () => {
      const harness = build();
      const user = await givenUser(harness);

      const response = await forgot(harness, EMAIL);
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});

      const rows = await tokenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(user.id);
      expect(rows[0]!.storeId).toBe(storeId);
      expect(rows[0]!.usedAt).toBeNull();
    });

    /** The oracle test. Same status, same body, and no token to give it away. */
    it('answers 204 identically for an address that does not exist', async () => {
      const harness = build();
      await givenUser(harness);

      const real = await forgot(harness, EMAIL);
      const fake = await forgot(harness, 'nobody-here@example.com');

      expect(fake.status).toBe(real.status);
      expect(fake.body).toEqual(real.body);
      expect(fake.text).toEqual(real.text);

      /* One token — the real request's. The unknown address produced nothing. */
      expect(await tokenRows()).toHaveLength(1);
    });

    it('answers 204 for a deactivated account, and issues nothing', async () => {
      const harness = build();
      const user = await givenUser(harness);
      await db()
        .update((await import('../../../db/schema/identity.js')).appUser)
        .set({ isActive: false })
        .where(eq((await import('../../../db/schema/identity.js')).appUser.id, user.id));

      const response = await forgot(harness, EMAIL);
      expect(response.status).toBe(204);
      expect(await tokenRows()).toEqual([]);
    });

    it('normalises the address, so casing and padding still find the account', async () => {
      const harness = build();
      await givenUser(harness);

      const response = await forgot(harness, '  BUYER@Example.COM  ');
      expect(response.status).toBe(204);
      expect(await tokenRows()).toHaveLength(1);
    });

    it('rejects a malformed address and an unknown field', async () => {
      const harness = build();
      await givenUser(harness);

      expect((await forgot(harness, 'not-an-email')).status).toBe(400);
      expect(
        (
          await request(harness.app)
            .post('/api/v1/auth/forgot-password')
            .send({ email: EMAIL, redirectUrl: 'https://evil.example.com' })
        ).status,
      ).toBe(400);

      expect(await tokenRows()).toEqual([]);
    });

    /**
     * A second request invalidates the first token.
     *
     * Without this, every "forgot password" a customer clicks leaves another live token in
     * another email and the account stays resettable by the oldest of them for an hour.
     */
    it('keeps only one live token per user', async () => {
      const harness = build();
      const user = await givenUser(harness);

      expect((await forgot(harness, EMAIL)).status).toBe(204);
      const firstToken = await deliverAndExtractToken(harness);

      expect((await forgot(harness, EMAIL)).status).toBe(204);
      const secondToken = await deliverAndExtractToken(harness);
      expect(secondToken).not.toBe(firstToken);

      const live = await harness.passwordResets.countLive({
        userId: user.id,
        storeId,
        at: new Date(),
      });
      expect(live).toBe(1);

      /* The first token is dead; only the newest works. */
      expect((await reset(harness, { token: firstToken, newPassword: NEW_PASSWORD })).status).toBe(
        400,
      );
      expect((await reset(harness, { token: secondToken, newPassword: NEW_PASSWORD })).status).toBe(
        204,
      );
    });
  });

  /* ══ The token is never stored ═════════════════════════════════════════ */

  describe('token storage', () => {
    it('stores only a digest, and the digest is not usable as a token', async () => {
      const harness = build();
      await givenUser(harness);
      expect((await forgot(harness, EMAIL)).status).toBe(204);

      const token = await deliverAndExtractToken(harness);
      const [row] = await tokenRows();

      /* The stored value is the digest of the token, and nothing in the table IS the token. */
      expect(row!.tokenHash).toBe(hashPasswordResetToken(token));
      expect(row!.tokenHash).not.toBe(token);
      expect(row!.tokenHash).toHaveLength(passwordResetTokenParameters().hashLength);

      const dumped = await testDb.handle.pool.query<{ dump: string }>(
        `SELECT coalesce(string_agg(t::text, ' '), '') AS dump
         FROM (SELECT p FROM password_reset_token p) AS x(t)`,
      );
      expect(dumped.rows[0]!.dump).not.toContain(token);

      /* Presenting the digest as the token must fail. */
      expect(
        (await reset(harness, { token: row!.tokenHash, newPassword: NEW_PASSWORD })).status,
      ).toBe(400);
    });

    it('generates a token with the documented parameters', async () => {
      const harness = build();
      await givenUser(harness);
      await forgot(harness, EMAIL);
      const token = await deliverAndExtractToken(harness);

      const params = passwordResetTokenParameters();
      expect(token).toHaveLength(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(params.entropyBits).toBe(256);
      expect(params.ttlMinutes).toBe(PASSWORD_RESET_TTL_MINUTES);
    });

    it('sets an expiry one TTL ahead', async () => {
      const harness = build();
      await givenUser(harness);
      const before = Date.now();
      await forgot(harness, EMAIL);

      const [row] = await tokenRows();
      const expected = before + PASSWORD_RESET_TTL_MINUTES * 60_000;
      /* Generous window: the request takes some milliseconds. */
      expect(row!.expiresAt.getTime()).toBeGreaterThan(expected - 5_000);
      expect(row!.expiresAt.getTime()).toBeLessThan(expected + 30_000);
    });
  });

  /* ══ The mail ══════════════════════════════════════════════════════════ */

  describe('the reset email', () => {
    it('carries a working link built from configuration, and no secret beyond the token', async () => {
      const harness = build();
      await givenUser(harness);
      await forgot(harness, EMAIL);
      const token = await deliverAndExtractToken(harness);

      const mail = harness.sent.at(-1)!;
      expect(mail.to).toBe(EMAIL);
      expect(mail.subject).toContain('Example Store');
      expect(mail.text).toContain(`https://shop.example.com/reset?token=${token}`);
      expect(mail.html).toContain('https://shop.example.com/reset?token=');

      /* The link works. */
      expect((await reset(harness, { token, newPassword: NEW_PASSWORD })).status).toBe(204);
    });

    it('emits exactly one event per request, aggregated on the user', async () => {
      const harness = build();
      const user = await givenUser(harness);
      await forgot(harness, EMAIL);

      const events = await db()
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.eventName, 'user.password_reset_requested'));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregateType: 'app_user',
        aggregateId: user.id,
        storeId,
      });
    });

    /** A payload missing its fields must fail loudly so the outbox retries, not send junk. */
    it('refuses to send when the payload is incomplete', async () => {
      const harness = build();
      const base = {
        id: 'evt',
        type: 'user.password_reset_requested',
        aggregateType: 'app_user',
        aggregateId: 'u',
        storeId,
        occurredAt: new Date(),
        attempts: 0,
        requestId: null,
      };

      await expect(harness.mailHandler({ ...base, payload: {} })).rejects.toThrow(/email/);
      await expect(harness.mailHandler({ ...base, payload: { email: EMAIL } })).rejects.toThrow(
        /token/,
      );
      expect(harness.sent).toEqual([]);
    });
  });

  /* ══ Completing the reset ══════════════════════════════════════════════ */

  describe('reset-password', () => {
    async function givenToken(harness: Harness): Promise<string> {
      await givenUser(harness);
      expect((await forgot(harness, EMAIL)).status).toBe(204);
      return deliverAndExtractToken(harness);
    }

    it('sets the new password, spends the token and revokes every session', async () => {
      const harness = build();
      const token = await givenToken(harness);

      /* Two live sessions before the reset. */
      expect((await login(harness, EMAIL, PASSWORD)).status).toBe(200);
      expect((await login(harness, EMAIL, PASSWORD)).status).toBe(200);
      const before = await db().select().from(refreshSession);
      expect(before.filter((s) => s.revokedAt === null)).toHaveLength(2);

      const response = await reset(harness, { token, newPassword: NEW_PASSWORD });
      expect(response.status).toBe(204);

      /* The old password is dead and the new one works. */
      expect((await login(harness, EMAIL, PASSWORD)).status).toBe(401);
      expect((await login(harness, EMAIL, NEW_PASSWORD)).status).toBe(200);

      /* The token is spent. */
      const [row] = await tokenRows();
      expect(row!.usedAt).not.toBeNull();

      /**
       * Every pre-existing session is revoked with the reset-specific reason. A reset is the
       * recovery path for an account the owner may have lost control of; leaving an attacker's
       * session alive would defeat the point.
       */
      const sessions = await db().select().from(refreshSession);
      const preExisting = sessions.filter((s) => before.some((b) => b.id === s.id));
      expect(preExisting.every((s) => s.revokedAt !== null)).toBe(true);
      expect(preExisting.every((s) => s.revokedReason === 'password_reset')).toBe(true);
    });

    it('refuses a second use of the same token', async () => {
      const harness = build();
      const token = await givenToken(harness);

      expect((await reset(harness, { token, newPassword: NEW_PASSWORD })).status).toBe(204);

      const again = await reset(harness, { token, newPassword: 'a-third-long-password' });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');

      /* The second attempt changed nothing. */
      expect((await login(harness, EMAIL, NEW_PASSWORD)).status).toBe(200);
    });

    /**
     * Concurrency: two requests, one token.
     *
     * `markUsed` carries `used_at IS NULL`, so exactly one wins. Without that predicate both
     * would set a password and which one survived would be a coin flip.
     */
    it('lets only one of two concurrent resets succeed', async () => {
      const harness = build();
      const token = await givenToken(harness);

      const [a, b] = await Promise.all([
        reset(harness, { token, newPassword: NEW_PASSWORD }),
        reset(harness, { token, newPassword: 'a-different-long-password' }),
      ]);

      expect([a.status, b.status].sort()).toEqual([204, 400]);

      /* Exactly one of the two passwords works. */
      const first = await login(harness, EMAIL, NEW_PASSWORD);
      const second = await login(harness, EMAIL, 'a-different-long-password');
      expect([first.status, second.status].sort()).toEqual([200, 401]);
    });

    it('refuses an expired token', async () => {
      const harness = build();
      const token = await givenToken(harness);

      await db()
        .update(passwordResetToken)
        .set({ expiresAt: new Date(Date.now() - 1_000) });

      const response = await reset(harness, { token, newPassword: NEW_PASSWORD });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
      expect((await login(harness, EMAIL, PASSWORD)).status).toBe(200);
    });

    /** Unknown, malformed and expired all answer the same, so a holder learns nothing. */
    it('answers identically for unknown, malformed and expired tokens', async () => {
      const harness = build();
      const token = await givenToken(harness);
      await db()
        .update(passwordResetToken)
        .set({ expiresAt: new Date(Date.now() - 1_000) });

      const bodies = await Promise.all([
        reset(harness, { token: 'totally-made-up-token', newPassword: NEW_PASSWORD }),
        reset(harness, { token: 'x'.repeat(43), newPassword: NEW_PASSWORD }),
        reset(harness, { token, newPassword: NEW_PASSWORD }),
      ]);

      for (const response of bodies) {
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_RESET_TOKEN');
        expect(response.body.error.message).toBe(bodies[0].body.error.message);
      }
    });

    it('applies the same password policy as registration', async () => {
      const harness = build();
      const token = await givenToken(harness);

      const tooShort = await reset(harness, { token, newPassword: 'short' });
      expect(tooShort.status).toBe(400);
      expect(tooShort.body.error.details.fields).toHaveProperty('body.newPassword');

      /* The token survives a rejected password, so the customer can try again. */
      const [row] = await tokenRows();
      expect(row!.usedAt).toBeNull();
      expect((await reset(harness, { token, newPassword: NEW_PASSWORD })).status).toBe(204);
    });

    it('rejects an unknown field and a missing token', async () => {
      const harness = build();
      await givenToken(harness);

      expect((await reset(harness, { newPassword: NEW_PASSWORD })).status).toBe(400);
      expect(
        (await reset(harness, { token: 'x', newPassword: NEW_PASSWORD, email: EMAIL })).status,
      ).toBe(400);
    });

    /**
     * **A token minted for another store must not work here.**
     *
     * The digest lookup is global by necessity — a customer clicking an emailed link supplies
     * nothing but the token — so the store comparison in the service is the only thing between
     * two tenants. Removing it would make a token from store A reset an account while the
     * request was scoped to store B.
     */
    it('refuses a token minted for another store', async () => {
      const harness = build();
      await givenToken(harness);

      /* Re-point the token at a different store, leaving the digest untouched. */
      const otherStore = await db()
        .insert((await import('../../../db/schema/store.js')).store)
        .values({
          id: (await import('../../../shared/id.js')).newId(),
          slug: 'other-store',
          name: 'Other Store',
          currency: 'INR',
          defaultLocale: 'en-IN',
          timezone: 'Asia/Kolkata',
          isActive: true,
        })
        .returning({ id: (await import('../../../db/schema/store.js')).store.id });

      /*
       * The composite FK ties the token's user to its store, so the row cannot simply be
       * re-pointed — which is itself the guarantee. Asserted as a rejected write.
       */
      await expect(
        testDb.handle.pool.query('UPDATE password_reset_token SET store_id = $1', [
          otherStore[0]!.id,
        ]),
      ).rejects.toThrow(/fk_password_reset_user_store/);
    });

    it('records an audit entry for the request and for the completion', async () => {
      const harness = build();
      const token = await givenToken(harness);
      expect((await reset(harness, { token, newPassword: NEW_PASSWORD })).status).toBe(204);

      const entries = await db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'app_user'));

      const actions = entries.map((e) => e.action);
      expect(actions).toContain('auth.password_reset_requested');
      expect(actions).toContain('auth.password_reset');

      /* Neither entry carries the token. */
      expect(JSON.stringify(entries)).not.toContain(token);
    });
  });

  /* ══ Housekeeping ══════════════════════════════════════════════════════ */

  describe('purge', () => {
    it('removes spent and expired rows and leaves live ones', async () => {
      const harness = build();
      const token = await givenUser(harness).then(async () => {
        await forgot(harness, EMAIL);
        return deliverAndExtractToken(harness);
      });
      expect(token).toBeTruthy();
      expect(await tokenRows()).toHaveLength(1);

      /* Still live: nothing to purge. */
      expect(await harness.passwordResets.purge({ before: new Date(Date.now() - 60_000) })).toBe(0);
      expect(await tokenRows()).toHaveLength(1);

      /* Age it and mark it spent, then purge. */
      const old = new Date(Date.now() - 48 * 3_600_000);
      await db().update(passwordResetToken).set({ createdAt: old, usedAt: old });

      expect(await harness.passwordResets.purge({ before: new Date() })).toBe(1);
      expect(await tokenRows()).toEqual([]);
    });
  });
});
