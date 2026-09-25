import { createHmac } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildContainer, type AppContainer } from '../../src/container.js';
import { appUser } from '../../src/db/schema/identity.js';
import { invoice } from '../../src/db/schema/invoicing.js';
import { stockItem } from '../../src/db/schema/inventory.js';
import { order } from '../../src/db/schema/orders.js';
import { outboxEvent } from '../../src/db/schema/outbox.js';
import { returnEvent, returnRequest } from '../../src/db/schema/returns.js';
import { newId } from '../../src/shared/id.js';
import {
  buildTestConfig,
  seedTestStore,
  startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.ts';
import { startTestRedis, type TestRedis } from '../helpers/redis.ts';

/**
 * A DEEP AUDIT of the whole system, driven by two brand-new actors.
 *
 * A sibling of `full-flow-walkthrough.e2e.test.ts`, deliberately not a replacement. The
 * walkthrough narrates the happy path; this file walks the same ground and then pushes on
 * every edge it passes — validation floors and ceilings, state machines re-entered from the
 * wrong state, one customer reaching for another's rows, token rotation and reuse, oversell
 * under concurrency, secret leakage in response bodies, and the platform hygiene (headers,
 * 404 shape, malformed JSON) that no single module owns.
 *
 * Two kinds of check live here, and the distinction is the whole point:
 *
 *  - `expect(...)` guards an invariant the build MUST hold. A failure is a bug; the suite
 *    goes red.
 *  - `probe(...)` records an OBSERVATION. It never throws; it appends to a ledger printed as
 *    `FINDINGS` at the end, graded HIGH / MEDIUM / LOW / INFO. That is the "print the lows"
 *    half: the run finishes green and *then* tells you every soft spot it walked past, so a
 *    passing suite is never mistaken for a system without weaknesses.
 *
 * Everything is real: the real composition root, real PostgreSQL, real Redis, real Argon2,
 * real HMAC. The single substitution is `globalThis.fetch`, so the Razorpay adapter talks to
 * a stub rather than the internet — its signature verification, persistence and webhook
 * de-duplication are the production code paths.
 */
describe('deep audit (new customer + new admin, full flow, graded findings)', () => {
  let testDb: TestDatabase;
  let redis: TestRedis;
  let container: AppContainer;

  const realFetch = globalThis.fetch;
  const providerRefs: string[] = [];

  const RAZORPAY = {
    keyId: 'rzp_test_audit',
    keySecret: 'audit-api-secret-value',
    webhookSecret: 'audit-webhook-secret-value',
  };

  const PASSWORD = 'a-sufficiently-long-password';
  const NEW_PASSWORD = 'an-even-longer-replacement-password';
  const RESET_PASSWORD = 'a-third-password-set-by-reset';
  const SELLER_STATE = 'Karnataka';
  const SELLER_GSTIN = '29AABCE1234F1Z5';
  const BUYER_GSTIN = '29AABCB2345G1Z7';
  const HSN = '61091000';

  let storeId = '';
  let adminToken = '';
  let customerToken = '';
  let customerRefresh = '';
  let customerEmail = '';
  let customerId = '';
  let skuCode = '';
  let couponCode = '';
  let addressId = '';
  let orderNumber = '';
  let orderId = '';
  let shipmentId = '';
  let returnNumber = '';
  let productSlug = '';
  /** Read off the login response, so the logout finding can quantify its own exposure window. */
  let accessTtlSeconds = 0;

  const api = () => request(container.app);
  const db = () => container.db.db;
  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });
  const asCustomer = () => ({ Authorization: `Bearer ${customerToken}` });

  /* ── Narration ─────────────────────────────────────────────────────────── */

  let step = 0;
  /**
   * Straight to stdout, NOT `console.log`.
   *
   * Vitest intercepts console output and re-emits it grouped per test, which collapses to
   * nothing once output is redirected to a file. `process.stdout.write` survives `> log.txt`
   * and CI capture alike, and a transcript that never reaches the terminal makes this file
   * worthless.
   */
  const line = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const section = (title: string): void => {
    line('');
    line(`══════ ${title} ══════`);
  };
  const log = (method: string, path: string, status: number, text: string): void => {
    step += 1;
    line(
      `${String(step).padStart(3, '0')}. ${method.padEnd(6)} ${path.padEnd(54)} → ${String(status).padEnd(3)}  ${text}`,
    );
  };
  const fact = (text: string): void => line(`     · ${text}`);

  /* ── The findings ledger ───────────────────────────────────────────────── */

  type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

  type Finding = {
    severity: Severity;
    area: string;
    /** What a careful reader would expect to be true. */
    expected: string;
    /** What the running system actually did. Never a guess — always an observed value. */
    observed: string;
  };

  const findings: Finding[] = [];

  const record = (severity: Severity, area: string, expected: string, observed: string): void => {
    findings.push({ severity, area, expected, observed });
    line(`     ⚑ ${severity.padEnd(6)} [${area}] ${expected} — observed: ${observed}`);
  };

  /**
   * A soft assertion.
   *
   * Records a finding when `ok` is false, and returns the verdict so a caller can branch.
   * NEVER throws: the value of this file is the ledger it prints at the end, and a probe that
   * aborted the run would take the ledger with it.
   */
  /**
   * How many probes ran, and how many held.
   *
   * Printed with the ledger, because "3 LOW findings" is only meaningful next to a
   * denominator — without it, a ledger that is short because the system is sound reads
   * identically to one that is short because barely anything was checked.
   */
  const probes = { run: 0, held: 0 };

  const probe = (
    severity: Severity,
    area: string,
    ok: boolean,
    expected: string,
    observed: string,
  ): boolean => {
    probes.run += 1;
    if (ok) {
      probes.held += 1;
      return true;
    }
    record(severity, area, expected, observed);
    return false;
  };

  /** An unconditional note — something true and worth stating, not a defect. */
  const note = (area: string, text: string): void => {
    record('INFO', area, text, 'confirmed by this run');
  };

  /* ── One place every request goes through ──────────────────────────────── */

  /**
   * Strings that must NEVER appear in a response body, scanned on EVERY call.
   *
   * A leak is not found by inspecting the endpoint you suspect; it is found by checking every
   * response you already made. Centralising the scan means a future serialiser change that
   * starts echoing a hash is caught by whichever test happens to touch it.
   */
  const forbidden = (): { label: string; value: string }[] => [
    { label: 'an argon2 hash', value: '$argon2' },
    { label: 'a passwordHash field', value: 'passwordHash' },
    { label: 'the password_hash column', value: 'password_hash' },
    { label: 'a tokenHash field', value: 'tokenHash' },
    { label: 'a live password', value: PASSWORD },
    { label: 'the Razorpay API secret', value: RAZORPAY.keySecret },
    { label: 'the Razorpay webhook secret', value: RAZORPAY.webhookSecret },
    { label: 'a PEM private key', value: '-----BEGIN' },
  ];

  /** Every call, so the summary can name the real cost centres rather than guess at them. */
  const timings: { path: string; ms: number; status: number }[] = [];

  type HitOptions = {
    headers?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
    /** Sent as `idempotency-key`. */
    idem?: string;
    /** A RAW body string, bypassing supertest's JSON serialisation — for malformed input. */
    raw?: string;
    contentType?: string;
  };

  const hit = async (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    options: HitOptions = {},
  ): Promise<request.Response> => {
    let req = api()[method](path);
    if (options.headers) req = req.set(options.headers);
    if (options.idem !== undefined) req = req.set('idempotency-key', options.idem);
    if (options.query) req = req.query(options.query);
    if (options.contentType) req = req.set('content-type', options.contentType);

    const started = Date.now();
    const response =
      options.raw === undefined
        ? await (options.body === undefined ? req : req.send(options.body as object))
        : await req.send(options.raw);
    const elapsed = Date.now() - started;

    timings.push({ path: `${method.toUpperCase()} ${path}`, ms: elapsed, status: response.status });

    /*
     * `response.text`, not `response.body`: the scan must cover the rendered invoice HTML and
     * any error page as well as parsed JSON.
     */
    const text = response.text ?? '';
    if (text.length > 0) {
      for (const { label, value } of forbidden()) {
        if (text.includes(value)) {
          record(
            'HIGH',
            'secret leakage',
            `no response may carry ${label}`,
            `${method.toUpperCase()} ${path} (${String(response.status)}) carries it`,
          );
        }
      }
    }

    return response;
  };

  const sign = (body: string): string =>
    createHmac('sha256', RAZORPAY.webhookSecret).update(Buffer.from(body, 'utf8')).digest('hex');

  /** Money in MINOR units. Never a float — see the `no-money-arithmetic` lint rule. */
  const minor = (value: string): bigint => BigInt(value.replace('.', ''));

  /** The error code an envelope carries, or a description of why there wasn't one. */
  const codeOf = (response: request.Response): string => {
    const body = response.body as { error?: { code?: unknown } } | undefined;
    const code = body?.error?.code;
    return typeof code === 'string' ? code : `<no error.code; body=${JSON.stringify(body)}>`;
  };

  beforeAll(async () => {
    [testDb, redis] = await Promise.all([startTestDatabase(), startTestRedis()]);

    // Stubbed BEFORE the container: the gateway captures `fetch` at construction.
    globalThis.fetch = async (input: unknown) => {
      const url = String(input);
      if (!url.includes('api.razorpay.com')) {
        throw new Error(`unexpected outbound request: ${url}`);
      }
      const ref = `order_AUDIT_${String(providerRefs.length + 1)}`;
      providerRefs.push(ref);
      return new Response(JSON.stringify({ id: ref }), { status: 200 });
    };

    container = buildContainer({
      role: 'api',
      config: buildTestConfig({
        databaseUrl: testDb.connectionUri,
        redisUrl: redis.url,
        extraEnv: {
          RAZORPAY_KEY_ID: RAZORPAY.keyId,
          RAZORPAY_KEY_SECRET: RAZORPAY.keySecret,
          RAZORPAY_WEBHOOK_SECRET: RAZORPAY.webhookSecret,
          /*
           * A sequential audit makes hundreds of authenticated calls from one IP. The
           * production default of 10/min would reject the audit itself as an attack, so the
           * limits are raised here — and probed separately below, so raising them does not
           * mean the audit stops looking at them.
           */
          AUTH_RATE_LIMIT_IP_MAX: '5000',
          AUTH_RATE_LIMIT_EMAIL_MAX: '5000',
        },
      }),
      drainer: { pollIntervalMs: 50 },
    });

    storeId = (await seedTestStore({ ...testDb, config: container.config })).id;

    line('');
    line('╔════════════════════════════════════════════════════════════════════════════╗');
    line('║  DEEP AUDIT — real container, real Postgres, real Redis, real Argon2       ║');
    line('║  expect() = must hold.   probe() = observation, printed under FINDINGS.    ║');
    line('╚════════════════════════════════════════════════════════════════════════════╝');
    line(`store seeded: ${storeId}`);
  }, 300_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await container?.shutdown();
    await Promise.allSettled([testDb?.stop(), redis?.stop()]);
  });

  /* ══ 1. Two brand-new actors ═══════════════════════════════════════════ */

  it('creates a brand-new ADMIN and a brand-new CUSTOMER from nothing', async () => {
    section('1. ACTORS — created from scratch');

    /* ---- the admin ---- */

    const adminEmail = `audit.admin.${newId()}@example.com`;
    const admin = await container.identity.registerCustomer({
      storeId,
      input: { email: adminEmail, password: PASSWORD, firstName: 'Ops', lastName: 'Admin' },
    });
    log('POST', '/auth/register (admin, via service)', 201, adminEmail);

    /*
     * Promoted by UPDATE, deliberately. No endpoint grants staff — that would be a
     * privilege-escalation route on a public API. This audit confirms the absence below.
     */
    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, admin.id));
    fact('promoted with app_user.is_staff = true (no HTTP route grants this)');

    const adminLogin = await hit('post', '/api/v1/auth/login', {
      body: { email: adminEmail, password: PASSWORD },
    });
    log('POST', '/api/v1/auth/login', adminLogin.status, 'admin signed in (SHARED login route)');
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.accessToken as string;
    expect(adminToken.length).toBeGreaterThan(0);

    /*
     * A JWT is three dot-separated segments. Asserted because a token that is not one is not
     * a token, and every authorization check below would be meaningless.
     */
    expect(adminToken.split('.')).toHaveLength(3);
    accessTtlSeconds = adminLogin.body.expiresIn as number;
    fact(`tokenType=${adminLogin.body.tokenType as string} expiresIn=${String(accessTtlSeconds)}s`);

    /*
     * What the token actually carries.
     *
     * A privilege claim in a token is the classic stale-authorization bug — but only if
     * anything TRUSTS it. This build carries `isStaff`/`isSuperuser` in the payload and
     * deliberately drops them at the authentication boundary, reading privileges fresh from
     * the database on every scoped request. Section 3 demotes this very admin and reuses this
     * very token to prove that, so the finding below is graded on what it really is: a claim
     * nobody reads, which invites a future reader to start reading it.
     */
    const claims = JSON.parse(
      Buffer.from(adminToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    fact(`token claims: ${Object.keys(claims).sort().join(', ')}`);
    probe(
      'LOW',
      'tokens',
      !('isStaff' in claims) && !('isSuperuser' in claims),
      'privilege claims in a token are dead weight when authorization reads the database anyway — they cost nothing today and are a stale-privilege bug the first time someone trusts them',
      `the payload carries ${['isStaff', 'isSuperuser']
        .filter((key) => key in claims)
        .join(' and ')} (proven unused by the live-demotion check in section 3)`,
    );
    probe(
      'LOW',
      'tokens',
      !('email' in claims),
      'the access token should not carry the email address (a decoded token is a PII disclosure)',
      `claim keys: ${Object.keys(claims).sort().join(', ')}`,
    );

    /* ---- the customer ---- */

    customerEmail = `audit.shopper.${newId()}@example.com`;
    const registered = await hit('post', '/api/v1/auth/register', {
      body: {
        email: customerEmail,
        password: PASSWORD,
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+91 9876543210',
      },
    });
    log('POST', '/api/v1/auth/register', registered.status, customerEmail);
    expect(registered.status).toBe(201);
    customerId = registered.body.user.id as string;

    // Registration issues no session. Signing up and signing in are separate operations.
    probe(
      'INFO',
      'identity',
      !('accessToken' in (registered.body as object)),
      'registration issues no session — signing up and signing in stay separate',
      `response keys: ${Object.keys(registered.body as object).join(', ')}`,
    );

    const customerLogin = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail, password: PASSWORD },
    });
    log('POST', '/api/v1/auth/login', customerLogin.status, 'customer signed in');
    expect(customerLogin.status).toBe(200);
    customerToken = customerLogin.body.accessToken as string;
    customerRefresh = customerLogin.body.refreshToken as string;
    expect(customerRefresh.length).toBeGreaterThan(0);

    /* ---- the account-existence oracle ---- */

    const wrongPassword = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail, password: 'definitely-not-the-password' },
    });
    const unknownEmail = await hit('post', '/api/v1/auth/login', {
      body: { email: `ghost.${newId()}@example.com`, password: PASSWORD },
    });
    log('POST', '/api/v1/auth/login', wrongPassword.status, 'known email, wrong password');
    log('POST', '/api/v1/auth/login', unknownEmail.status, 'unknown email entirely');
    expect(wrongPassword.status).toBe(401);
    probe(
      'MEDIUM',
      'identity',
      wrongPassword.status === unknownEmail.status &&
        codeOf(wrongPassword) === codeOf(unknownEmail),
      'a wrong password and an unknown address must be indistinguishable, or login is an account-existence oracle',
      `wrong-password=${String(wrongPassword.status)}/${codeOf(wrongPassword)} unknown-email=${String(unknownEmail.status)}/${codeOf(unknownEmail)}`,
    );

    const duplicate = await hit('post', '/api/v1/auth/register', {
      body: { email: customerEmail, password: PASSWORD, firstName: 'Ada', lastName: 'Twin' },
    });
    log('POST', '/api/v1/auth/register', duplicate.status, 'the SAME email a second time');
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    probe(
      'LOW',
      'identity',
      duplicate.status === 201 || duplicate.status === 204,
      'registration discloses whether an address already has an account — anyone can test an address list against it',
      `status=${String(duplicate.status)} code=${codeOf(duplicate)} (rate limiting is the only mitigation; this is the standard trade-off, recorded rather than argued)`,
    );

    /* ---- email casing ---- */

    const upperCased = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail.toUpperCase(), password: PASSWORD },
    });
    log('POST', '/api/v1/auth/login', upperCased.status, 'the same address in UPPER CASE');
    probe(
      'MEDIUM',
      'identity',
      upperCased.status === 200,
      'email matching must be case-insensitive, or a customer who capitalises their address is locked out',
      `status=${String(upperCased.status)} code=${codeOf(upperCased)}`,
    );
  });

  /* ══ 2. The identity lifecycle, end to end ═════════════════════════════ */

  it('drives the whole identity lifecycle: profile, password, rotation, reuse, logout, reset', async () => {
    section('2. IDENTITY LIFECYCLE');

    /* ---- profile ---- */

    const me = await hit('get', '/api/v1/users/me', { headers: asCustomer() });
    log('GET', '/api/v1/users/me', me.status, `id=${me.body.user.id as string}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(customerId);

    const patched = await hit('patch', '/api/v1/users/me', {
      headers: asCustomer(),
      body: { firstName: 'Augusta', acceptsMarketing: true },
    });
    log('PATCH', '/api/v1/users/me', patched.status, 'firstName + acceptsMarketing updated');
    expect(patched.status).toBe(200);
    expect(patched.body.user.firstName).toBe('Augusta');

    const emptyPatch = await hit('patch', '/api/v1/users/me', { headers: asCustomer(), body: {} });
    log(
      'PATCH',
      '/api/v1/users/me',
      emptyPatch.status,
      'an EMPTY patch is refused, not a no-op 200',
    );
    expect(emptyPatch.status).toBe(400);

    const massAssign = await hit('patch', '/api/v1/users/me', {
      headers: asCustomer(),
      body: { firstName: 'Ada', isStaff: true },
    });
    log('PATCH', '/api/v1/users/me', massAssign.status, 'self-promotion to staff attempted');
    expect(massAssign.status).toBe(400);
    fact(`refused by strictObject: code=${codeOf(massAssign)}`);

    const [afterAttempt] = await db().select().from(appUser).where(eq(appUser.id, customerId));
    expect(afterAttempt!.isStaff).toBe(false);
    fact('app_user.is_staff still false — no HTTP path grants privilege');

    /* ---- refresh rotation, and reuse of a spent token ---- */

    const rotated = await hit('post', '/api/v1/auth/refresh', {
      body: { refreshToken: customerRefresh },
    });
    log('POST', '/api/v1/auth/refresh', rotated.status, 'refresh token exchanged');
    expect(rotated.status).toBe(200);
    const secondRefresh = rotated.body.refreshToken as string;
    expect(secondRefresh).not.toBe(customerRefresh);
    fact('the replacement refresh token differs from the presented one (rotation, not reuse)');

    const replayed = await hit('post', '/api/v1/auth/refresh', {
      body: { refreshToken: customerRefresh },
    });
    log('POST', '/api/v1/auth/refresh', replayed.status, 'the SPENT token presented again');
    expect(replayed.status).toBe(401);

    /*
     * Replay of a spent token is the signature of a stolen token, so the whole family should
     * die — not just the replayed link. Checked by trying the token that replaced it.
     */
    const familyCheck = await hit('post', '/api/v1/auth/refresh', {
      body: { refreshToken: secondRefresh },
    });
    log(
      'POST',
      '/api/v1/auth/refresh',
      familyCheck.status,
      'the LIVE token, after a replay was detected',
    );
    if (
      probe(
        'HIGH',
        'session security',
        familyCheck.status === 401,
        'detecting a replayed refresh token should revoke the whole family — a thief and the victim both hold one, and only revocation evicts the thief',
        `the live sibling still refreshed: status=${String(familyCheck.status)}`,
      )
    ) {
      note('session security', 'a replay detection revoked the entire token family');
      // The family is dead; sign in again to carry on.
      const again = await hit('post', '/api/v1/auth/login', {
        body: { email: customerEmail, password: PASSWORD },
      });
      customerToken = again.body.accessToken as string;
      customerRefresh = again.body.refreshToken as string;
      log('POST', '/api/v1/auth/login', again.status, 'signed in again after family revocation');
    } else {
      customerToken = familyCheck.body.accessToken as string;
      customerRefresh = familyCheck.body.refreshToken as string;
    }

    /* ---- password change ---- */

    const wrongCurrent = await hit('post', '/api/v1/users/me/password', {
      headers: asCustomer(),
      body: { currentPassword: 'not-the-current-password', newPassword: NEW_PASSWORD },
    });
    log('POST', '/api/v1/users/me/password', wrongCurrent.status, 'wrong current password refused');
    expect(wrongCurrent.status).toBeGreaterThanOrEqual(400);

    const shortPassword = await hit('post', '/api/v1/users/me/password', {
      headers: asCustomer(),
      body: { currentPassword: PASSWORD, newPassword: 'short' },
    });
    log(
      'POST',
      '/api/v1/users/me/password',
      shortPassword.status,
      'a 5-character password refused',
    );
    expect(shortPassword.status).toBe(400);

    const changed = await hit('post', '/api/v1/users/me/password', {
      headers: asCustomer(),
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    log('POST', '/api/v1/users/me/password', changed.status, 'password changed');
    expect(changed.status).toBeLessThan(300);

    const oldPasswordLogin = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail, password: PASSWORD },
    });
    log('POST', '/api/v1/auth/login', oldPasswordLogin.status, 'the OLD password no longer works');
    expect(oldPasswordLogin.status).toBe(401);

    /*
     * A password change is a "someone may have my account" action, so the OTHER sessions it
     * left behind matter. Checked with the refresh token minted before the change.
     */
    const staleAfterChange = await hit('post', '/api/v1/auth/refresh', {
      body: { refreshToken: customerRefresh },
    });
    log(
      'POST',
      '/api/v1/auth/refresh',
      staleAfterChange.status,
      'a refresh token minted BEFORE the password change',
    );
    probe(
      'MEDIUM',
      'session security',
      staleAfterChange.status === 401,
      'changing a password should revoke every existing session, or an attacker who already stole one keeps it',
      `the pre-change refresh token still worked: status=${String(staleAfterChange.status)}`,
    );

    const relogin = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail, password: NEW_PASSWORD },
    });
    log('POST', '/api/v1/auth/login', relogin.status, 'signed in with the NEW password');
    expect(relogin.status).toBe(200);
    customerToken = relogin.body.accessToken as string;
    customerRefresh = relogin.body.refreshToken as string;

    /* ---- logout, and what an access token does afterwards ---- */

    const loggedOut = await hit('post', '/api/v1/auth/logout', { headers: asCustomer() });
    log('POST', '/api/v1/auth/logout', loggedOut.status, 'session revoked');
    expect(loggedOut.status).toBe(204);

    const refreshAfterLogout = await hit('post', '/api/v1/auth/refresh', {
      body: { refreshToken: customerRefresh },
    });
    log('POST', '/api/v1/auth/refresh', refreshAfterLogout.status, 'refresh after logout refused');
    expect(refreshAfterLogout.status).toBe(401);

    const accessAfterLogout = await hit('get', '/api/v1/users/me', { headers: asCustomer() });
    log('GET', '/api/v1/users/me', accessAfterLogout.status, 'the ACCESS token, used after logout');
    probe(
      'LOW',
      'session security',
      accessAfterLogout.status === 401,
      'an access token should stop working the moment its session is revoked',
      `it still authenticated: status=${String(accessAfterLogout.status)} — a stateless JWT carries no revocation check, so logout ends the refresh chain only; a stolen access token stays usable for up to ${String(accessTtlSeconds)}s (${String(Math.round(accessTtlSeconds / 60))} min) after the customer logs out`,
    );

    /* ---- forgot / reset, with the token taken from the outbox ---- */

    const forgot = await hit('post', '/api/v1/auth/forgot-password', {
      body: { email: customerEmail },
    });
    log('POST', '/api/v1/auth/forgot-password', forgot.status, 'a real address');
    expect(forgot.status).toBe(204);

    const forgotUnknown = await hit('post', '/api/v1/auth/forgot-password', {
      body: { email: `nobody.${newId()}@example.com` },
    });
    log('POST', '/api/v1/auth/forgot-password', forgotUnknown.status, 'an address with no account');
    expect(forgotUnknown.status).toBe(204);
    probe(
      'INFO',
      'identity',
      forgot.status === forgotUnknown.status,
      'forgot-password answers 204 for every address, so it cannot be swept for account existence',
      `known=${String(forgot.status)} unknown=${String(forgotUnknown.status)}`,
    );

    /*
     * The reset token is a bearer credential and is deliberately NOT stored in plaintext —
     * `password_reset_token` holds only a hash. The plaintext exists in exactly one place, the
     * outbox event the mailer consumes, which is where a test must read it from.
     */
    const events = await db()
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.storeId, storeId),
          eq(outboxEvent.eventName, 'user.password_reset_requested'),
        ),
      );
    const payload = events.at(-1)?.payload as { token?: string; email?: string } | undefined;
    const resetToken = payload?.token ?? '';
    fact(`reset token recovered from the outbox event (length ${String(resetToken.length)})`);
    expect(resetToken.length).toBeGreaterThan(20);

    const badToken = await hit('post', '/api/v1/auth/reset-password', {
      body: { token: `${resetToken}tampered`, newPassword: RESET_PASSWORD },
    });
    log('POST', '/api/v1/auth/reset-password', badToken.status, 'a tampered token refused');
    expect(badToken.status).toBe(400);

    const reset = await hit('post', '/api/v1/auth/reset-password', {
      body: { token: resetToken, newPassword: RESET_PASSWORD },
    });
    log('POST', '/api/v1/auth/reset-password', reset.status, 'password reset');
    expect(reset.status).toBe(204);

    const reused = await hit('post', '/api/v1/auth/reset-password', {
      body: { token: resetToken, newPassword: RESET_PASSWORD },
    });
    log('POST', '/api/v1/auth/reset-password', reused.status, 'the SAME token, a second time');
    expect(reused.status).toBe(400);
    fact('a reset token is single-use');

    const finalLogin = await hit('post', '/api/v1/auth/login', {
      body: { email: customerEmail, password: RESET_PASSWORD },
    });
    log('POST', '/api/v1/auth/login', finalLogin.status, 'signed in with the reset password');
    expect(finalLogin.status).toBe(200);
    customerToken = finalLogin.body.accessToken as string;
    customerRefresh = finalLogin.body.refreshToken as string;
  });

  /* ══ 3. The authorization boundary, swept ══════════════════════════════ */

  it('sweeps EVERY admin endpoint with no token, a customer token, and a bad token', async () => {
    section('3. AUTHORIZATION — swept, not sampled');

    /*
     * The whole admin surface, not a sample. A boundary that holds on the endpoint someone
     * remembered to test and leaks on the one they forgot is not a boundary.
     */
    const adminSurface: ['get' | 'post' | 'put' | 'patch' | 'delete', string][] = [
      ['get', '/api/v1/admin/products'],
      ['post', '/api/v1/admin/products'],
      ['get', '/api/v1/admin/inventory'],
      ['post', '/api/v1/admin/inventory/adjustments'],
      ['get', '/api/v1/admin/promotions'],
      ['post', '/api/v1/admin/promotions'],
      ['get', '/api/v1/admin/returns'],
      ['get', '/api/v1/admin/orders/fulfilment'],
      ['get', '/api/v1/admin/tax-classes'],
      ['post', '/api/v1/admin/tax-classes'],
      ['get', '/api/v1/admin/store/tax-profile'],
      ['put', '/api/v1/admin/store/tax-profile'],
    ];

    let anonymousLeaks = 0;
    let customerLeaks = 0;

    for (const [method, path] of adminSurface) {
      const anonymous = await hit(method, path);
      const asShopper = await hit(method, path, { headers: asCustomer() });

      const anonymousOk = anonymous.status === 401;
      const shopperOk = asShopper.status === 403;
      if (!anonymousOk) anonymousLeaks += 1;
      if (!shopperOk) customerLeaks += 1;

      log(
        method.toUpperCase(),
        path,
        anonymous.status,
        `anon=${String(anonymous.status)} customer=${String(asShopper.status)} ${anonymousOk && shopperOk ? '✓' : '✗'}`,
      );
    }

    expect(anonymousLeaks).toBe(0);
    expect(customerLeaks).toBe(0);
    fact(
      `${String(adminSurface.length)} admin endpoints: 401 anonymous, 403 as a customer, all of them`,
    );

    const allowed = await hit('get', '/api/v1/admin/products', { headers: asAdmin() });
    log('GET', '/api/v1/admin/products', allowed.status, 'the admin token is allowed');
    expect(allowed.status).toBe(200);

    /* ---- what a rejection says ---- */

    const forbidden403 = await hit('get', '/api/v1/admin/products', { headers: asCustomer() });
    const details = forbidden403.body.error?.details as { missing?: unknown } | undefined;
    fact(`403 envelope: code=${codeOf(forbidden403)} missing=${JSON.stringify(details?.missing)}`);

    /* ---- a demotion, with the SAME token ---- */

    /*
     * The token minted in section 1 carries `isStaff: true`. If authorization read that claim,
     * a demoted administrator would keep their access until the token expired — which is the
     * whole reason the middleware drops the claim and pays for an indexed read instead. The
     * only honest way to check that is to demote the row and reuse the unchanged token.
     */
    const [adminRow] = await db().select().from(appUser).where(eq(appUser.isStaff, true));

    await db().update(appUser).set({ isStaff: false }).where(eq(appUser.id, adminRow!.id));
    const afterDemotion = await hit('get', '/api/v1/admin/products', { headers: asAdmin() });
    log(
      'GET',
      '/api/v1/admin/products',
      afterDemotion.status,
      'the SAME admin token, after is_staff was set to false',
    );
    if (
      probe(
        'HIGH',
        'authorization',
        afterDemotion.status === 403,
        'revoking staff must take effect on the next request — a token that keeps its privileges until expiry cannot be de-authorised',
        `the demoted admin still had access: status=${String(afterDemotion.status)}`,
      )
    ) {
      note(
        'authorization',
        'a demotion took effect on the very next request, with an unchanged token carrying isStaff: true — privileges are read live, never from the claim',
      );
    }

    await db().update(appUser).set({ isStaff: true }).where(eq(appUser.id, adminRow!.id));
    const afterRestore = await hit('get', '/api/v1/admin/products', { headers: asAdmin() });
    log('GET', '/api/v1/admin/products', afterRestore.status, 'restored, same token again');
    expect(afterRestore.status).toBe(200);
    fact('and the promotion is equally immediate — no re-login needed in either direction');

    /* ---- malformed and forged credentials ---- */

    const shapes: [string, string, number][] = [
      ['a token that is not a JWT', 'Bearer not-a-token', 401],
      ['the scheme with no token', 'Bearer', 401],
      ['the wrong scheme', `Basic ${Buffer.from('a:b').toString('base64')}`, 401],
      ['no scheme at all', customerToken, 401],
      ['a tampered signature', `Bearer ${customerToken.slice(0, -6)}AAAAAA`, 401],
      [
        'an alg=none forgery',
        `Bearer ${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: customerId, storeId, isStaff: true })).toString('base64url')}.`,
        401,
      ],
    ];

    for (const [label, header, expected] of shapes) {
      const response = await hit('get', '/api/v1/users/me', {
        headers: { Authorization: header },
      });
      log('GET', '/api/v1/users/me', response.status, label);
      expect(response.status).toBe(expected);
    }
    fact(
      'a forged alg=none token is rejected — the verifier pins RS256 rather than trusting the header',
    );
  });

  /* ══ 4. The admin builds the catalogue ════════════════════════════════ */

  it('lets the ADMIN build a catalogue with options, SKUs, stock, a promotion and GST', async () => {
    section('4. ADMIN — CATALOGUE, OPTIONS, STOCK, PROMOTION, GST');

    const suffix = String(Date.now()).slice(-6);
    productSlug = `audit-tee-${suffix}`;
    skuCode = `AUDIT-TEE-${suffix}`;

    const product = await hit('post', '/api/v1/admin/products', {
      headers: asAdmin(),
      body: {
        slug: productSlug,
        name: 'Audit Tee',
        description: 'Soft cotton, deeply inspected',
        status: 'active',
      },
    });
    log('POST', '/api/v1/admin/products', product.status, productSlug);
    expect(product.status).toBe(201);

    const duplicateSlug = await hit('post', '/api/v1/admin/products', {
      headers: asAdmin(),
      body: { slug: productSlug, name: 'Audit Tee (again)', status: 'active' },
    });
    log('POST', '/api/v1/admin/products', duplicateSlug.status, 'the SAME slug refused');
    expect(duplicateSlug.status).toBe(409);

    const unknownField = await hit('post', '/api/v1/admin/products', {
      headers: asAdmin(),
      body: { slug: `x-${suffix}`, name: 'X', status: 'active', storeId: newId() },
    });
    log('POST', '/api/v1/admin/products', unknownField.status, 'a storeId in the body refused');
    expect(unknownField.status).toBe(400);
    fact('tenancy cannot be named in a body — strictObject makes it a 400, not a silent drop');

    /* ---- options and values ---- */

    const option = await hit('post', `/api/v1/admin/products/${productSlug}/options`, {
      headers: asAdmin(),
      body: { name: 'Size', sortOrder: 1 },
    });
    log('POST', '/api/v1/admin/products/:slug/options', option.status, 'option "Size"');
    expect(option.status).toBe(201);
    const optionId = option.body.option.id as string;

    const value = await hit('post', `/api/v1/admin/options/${optionId}/values`, {
      headers: asAdmin(),
      body: { value: 'Medium', sortOrder: 1 },
    });
    log('POST', '/api/v1/admin/options/:id/values', value.status, 'value "Medium"');
    expect(value.status).toBe(201);
    const valueId = value.body.value.id as string;

    const badOptionId = await hit('post', '/api/v1/admin/options/not-a-uuid/values', {
      headers: asAdmin(),
      body: { value: 'Large' },
    });
    log('POST', '/api/v1/admin/options/:id/values', badOptionId.status, 'a non-UUID id');
    probe(
      'MEDIUM',
      'validation',
      badOptionId.status === 400,
      'a malformed UUID must be a 400 from validation, never a 500 surfacing PostgreSQL 22P02',
      `status=${String(badOptionId.status)} code=${codeOf(badOptionId)}`,
    );

    /* ---- the SKU ---- */

    const sku = await hit('post', `/api/v1/admin/products/${productSlug}/skus`, {
      headers: asAdmin(),
      body: { code: skuCode, price: '500.0000' },
    });
    log('POST', '/api/v1/admin/products/:slug/skus', sku.status, `${skuCode} @ 500.0000`);
    expect(sku.status).toBe(201);

    const negativePrice = await hit('post', `/api/v1/admin/products/${productSlug}/skus`, {
      headers: asAdmin(),
      body: { code: `NEG-${suffix}`, price: '-1.0000' },
    });
    log('POST', '/api/v1/admin/products/:slug/skus', negativePrice.status, 'a NEGATIVE price');
    expect(negativePrice.status).toBe(400);

    const floatPrice = await hit('post', `/api/v1/admin/products/${productSlug}/skus`, {
      headers: asAdmin(),
      body: { code: `FLT-${suffix}`, price: 500.5 },
    });
    log('POST', '/api/v1/admin/products/:slug/skus', floatPrice.status, 'price as a JSON NUMBER');
    probe(
      'MEDIUM',
      'money',
      floatPrice.status === 400,
      'money must be rejected as a JSON number — accepting a float invites IEEE-754 error into a ledger',
      `status=${String(floatPrice.status)} code=${codeOf(floatPrice)}`,
    );

    const combination = await hit('put', `/api/v1/admin/skus/${skuCode}/options`, {
      headers: asAdmin(),
      body: { optionValueIds: [valueId] },
    });
    log('PUT', '/api/v1/admin/skus/:code/options', combination.status, 'SKU bound to Size=Medium');
    expect(combination.status).toBeLessThan(300);

    const duplicateValues = await hit('put', `/api/v1/admin/skus/${skuCode}/options`, {
      headers: asAdmin(),
      body: { optionValueIds: [valueId, valueId] },
    });
    log('PUT', '/api/v1/admin/skus/:code/options', duplicateValues.status, 'the same value twice');
    expect(duplicateValues.status).toBe(400);

    /* ---- stock ---- */

    const stocked = await hit('post', '/api/v1/admin/inventory/adjustments', {
      headers: asAdmin(),
      body: { skuCode, delta: 25, reason: 'manual_increase', note: 'audit' },
    });
    log('POST', '/api/v1/admin/inventory/adjustments', stocked.status, '+25 on hand');
    expect(stocked.status).toBe(201);

    const overDraw = await hit('post', '/api/v1/admin/inventory/adjustments', {
      headers: asAdmin(),
      body: { skuCode, delta: -9999, reason: 'manual_decrease' },
    });
    log('POST', '/api/v1/admin/inventory/adjustments', overDraw.status, '-9999 refused');
    probe(
      'HIGH',
      'inventory',
      overDraw.status >= 400,
      'an adjustment must not be able to drive on-hand negative',
      `status=${String(overDraw.status)}`,
    );

    const zeroDelta = await hit('post', '/api/v1/admin/inventory/adjustments', {
      headers: asAdmin(),
      body: { skuCode, delta: 0, reason: 'manual_increase' },
    });
    log('POST', '/api/v1/admin/inventory/adjustments', zeroDelta.status, 'a delta of ZERO');
    probe(
      'LOW',
      'inventory',
      zeroDelta.status === 400,
      'a zero-delta adjustment should be refused — it writes a ledger row that records nothing',
      `status=${String(zeroDelta.status)}`,
    );

    const history = await hit('get', `/api/v1/admin/inventory/${skuCode}/history`, {
      headers: asAdmin(),
    });
    log(
      'GET',
      '/api/v1/admin/inventory/:sku/history',
      history.status,
      'the adjustment ledger is readable',
    );
    expect(history.status).toBe(200);

    /* ---- the promotion ---- */

    couponCode = `AUDIT10-${String(Date.now()).slice(-5)}`;
    const promo = await hit('post', '/api/v1/admin/promotions', {
      headers: asAdmin(),
      body: {
        code: couponCode,
        name: '10% off',
        discountType: 'percentage',
        percentRate: '10',
        isActive: true,
      },
    });
    log('POST', '/api/v1/admin/promotions', promo.status, `${couponCode} — 10% off`);
    expect(promo.status).toBe(201);

    const over100 = await hit('post', '/api/v1/admin/promotions', {
      headers: asAdmin(),
      body: {
        code: `BAD-${suffix}`,
        name: 'free money',
        discountType: 'percentage',
        percentRate: '150',
        isActive: true,
      },
    });
    log('POST', '/api/v1/admin/promotions', over100.status, 'a 150% discount refused');
    probe(
      'HIGH',
      'promotions',
      over100.status === 400,
      'a percentage discount above 100 must be refused, or an order can total below zero',
      `status=${String(over100.status)}`,
    );

    /* ---- GST ---- */

    const profile = await hit('put', '/api/v1/admin/store/tax-profile', {
      headers: asAdmin(),
      body: {
        legalName: 'Audit Retail Private Limited',
        gstin: SELLER_GSTIN,
        originLine1: '4th Floor, MG Road',
        originCity: 'Bengaluru',
        originState: SELLER_STATE,
        originPostalCode: '560001',
        originCountryCode: 'IN',
      },
    });
    log('PUT', '/api/v1/admin/store/tax-profile', profile.status, `seller GSTIN ${SELLER_GSTIN}`);
    expect(profile.status).toBe(200);

    const badGstin = await hit('put', '/api/v1/admin/store/tax-profile', {
      headers: asAdmin(),
      body: {
        legalName: 'Audit Retail Private Limited',
        gstin: '29AABCE1234F1Z',
        originLine1: '4th Floor, MG Road',
        originCity: 'Bengaluru',
        originState: SELLER_STATE,
        originPostalCode: '560001',
        originCountryCode: 'IN',
      },
    });
    log('PUT', '/api/v1/admin/store/tax-profile', badGstin.status, 'a 14-character GSTIN refused');
    expect(badGstin.status).toBe(400);

    const taxClass = await hit('post', '/api/v1/admin/tax-classes', {
      headers: asAdmin(),
      body: { code: 'GST5', name: 'GST 5%', isActive: true },
    });
    log('POST', '/api/v1/admin/tax-classes', taxClass.status, 'GST5');
    expect(taxClass.status).toBe(201);

    const rate = await hit('post', '/api/v1/admin/tax-classes/GST5/rates', {
      headers: asAdmin(),
      body: {
        cgstRate: '2.5',
        sgstRate: '2.5',
        igstRate: '5',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
      },
    });
    log('POST', '/api/v1/admin/tax-classes/:code/rates', rate.status, 'CGST 2.5 + SGST 2.5');
    expect(rate.status).toBe(201);

    const assigned = await hit(`put`, `/api/v1/admin/skus/${skuCode}/tax`, {
      headers: asAdmin(),
      body: { taxClassCode: 'GST5', hsnCode: HSN },
    });
    log('PUT', '/api/v1/admin/skus/:code/tax', assigned.status, `HSN ${HSN}`);
    expect(assigned.status).toBe(200);
  });

  /* ══ 5. The customer shops ════════════════════════════════════════════ */

  it('lets the CUSTOMER browse and probes every list and cart edge', async () => {
    section('5. CUSTOMER — BROWSE, FILTER, CART');

    const list = await hit('get', '/api/v1/products');
    log(
      'GET',
      '/api/v1/products',
      list.status,
      `${String(list.body.products.length)} product(s), no auth`,
    );
    expect(list.status).toBe(200);
    fact(
      `pagination: limit=${String(list.body.pagination.limit)} offset=${String(list.body.pagination.offset)} total=${String(list.body.pagination.total)}`,
    );

    const detail = await hit('get', `/api/v1/products/${productSlug}`);
    log('GET', '/api/v1/products/:slug', detail.status, 'the product detail, with its SKUs');
    expect(detail.status).toBe(200);

    const missing = await hit('get', `/api/v1/products/no-such-product-${newId()}`);
    log('GET', '/api/v1/products/:slug', missing.status, 'an unknown slug');
    expect(missing.status).toBe(404);

    /* ---- list-parameter edges ---- */

    const listEdges: [string, Record<string, string>, number][] = [
      ['limit=0 (below the floor)', { limit: '0' }, 400],
      ['limit=5000 (above the ceiling)', { limit: '5000' }, 400],
      ['limit=abc', { limit: 'abc' }, 400],
      ['limit=1.5', { limit: '1.5' }, 400],
      ['offset=-1', { offset: '-1' }, 400],
      ['limitt=10 (a typo)', { limitt: '10' }, 400],
      ['q= (empty search)', { q: '' }, 400],
      ['a reversed price range', { price_min: '900.0000', price_max: '100.0000' }, 400],
    ];

    for (const [label, query, expected] of listEdges) {
      const response = await hit('get', '/api/v1/products', { query });
      log('GET', '/api/v1/products', response.status, label);
      probe(
        'LOW',
        'validation',
        response.status === expected,
        `${label} should be a ${String(expected)}`,
        `status=${String(response.status)} code=${codeOf(response)}`,
      );
    }
    fact('an unknown query parameter is a 400 — a typo cannot silently return an unfiltered page');

    const search = await hit('get', '/api/v1/products', { query: { q: 'Audit' } });
    log(
      'GET',
      '/api/v1/products?q=Audit',
      search.status,
      `${String(search.body.products.length)} match(es)`,
    );
    expect(search.status).toBe(200);

    const injection = await hit('get', '/api/v1/products', {
      query: { q: "%' OR 1=1 --" },
    });
    log('GET', '/api/v1/products?q=<injection>', injection.status, 'a SQL-shaped search term');
    expect(injection.status).toBe(200);
    expect(injection.body.products.length).toBe(0);
    fact('the term is a parameter, not SQL: zero matches rather than the whole table');

    /* ---- the cart ---- */

    const cartEdges: [string, unknown, number][] = [
      ['quantity 0 (use DELETE instead)', { quantity: 0 }, 400],
      ['quantity -3', { quantity: -3 }, 400],
      ['quantity 1000 (over the line cap)', { quantity: 1000 }, 400],
      ['quantity 2.5', { quantity: 2.5 }, 400],
      ['quantity as a string', { quantity: '3' }, 400],
      ['an empty body', {}, 400],
      ['an extra field', { quantity: 1, unitPrice: '0.0001' }, 400],
    ];

    for (const [label, body, expected] of cartEdges) {
      const response = await hit('put', `/api/v1/users/me/cart/items/${skuCode}`, {
        headers: asCustomer(),
        body,
      });
      log('PUT', '/api/v1/users/me/cart/items/:sku', response.status, label);
      probe(
        'MEDIUM',
        'cart validation',
        response.status === expected,
        `${label} should be a ${String(expected)}`,
        `status=${String(response.status)} code=${codeOf(response)}`,
      );
    }
    fact('unitPrice is unreachable from a body — the price comes from the SKU, never the client');

    const unknownSku = await hit('put', `/api/v1/users/me/cart/items/NO-SUCH-SKU-${newId()}`, {
      headers: asCustomer(),
      body: { quantity: 1 },
    });
    log('PUT', '/api/v1/users/me/cart/items/:sku', unknownSku.status, 'an unknown SKU');
    expect(unknownSku.status).toBe(404);

    const added = await hit('put', `/api/v1/users/me/cart/items/${skuCode}`, {
      headers: asCustomer(),
      body: { quantity: 3 },
    });
    log('PUT', '/api/v1/users/me/cart/items/:sku', added.status, '3 units');
    expect(added.status).toBe(200);
    fact(`subtotal=${added.body.cart.subtotal as string}`);
    expect(minor(added.body.cart.subtotal as string)).toBe(minor('500.0000') * 3n);

    const idempotentPut = await hit('put', `/api/v1/users/me/cart/items/${skuCode}`, {
      headers: asCustomer(),
      body: { quantity: 3 },
    });
    expect(minor(idempotentPut.body.cart.subtotal as string)).toBe(minor('500.0000') * 3n);
    log(
      'PUT',
      '/api/v1/users/me/cart/items/:sku',
      idempotentPut.status,
      'PUT is a SET, not an add',
    );
    fact('the same PUT twice leaves 3 units, not 6 — the verb means what it says');

    /* ---- the promotion ---- */

    const unknownCoupon = await hit('put', '/api/v1/users/me/cart/promotion', {
      headers: asCustomer(),
      body: { code: `NOPE${String(Date.now()).slice(-5)}` },
    });
    log('PUT', '/api/v1/users/me/cart/promotion', unknownCoupon.status, 'an unknown coupon');
    expect(unknownCoupon.status).toBeGreaterThanOrEqual(400);

    const lowerCased = await hit('put', '/api/v1/users/me/cart/promotion', {
      headers: asCustomer(),
      body: { code: couponCode.toLowerCase() },
    });
    log('PUT', '/api/v1/users/me/cart/promotion', lowerCased.status, 'the coupon in lower case');
    probe(
      'LOW',
      'promotions',
      lowerCased.status === 200,
      'coupon matching should be case-insensitive — a customer retyping a code from a poster will not match its case',
      `status=${String(lowerCased.status)} code=${codeOf(lowerCased)}`,
    );

    const applied = await hit('put', '/api/v1/users/me/cart/promotion', {
      headers: asCustomer(),
      body: { code: couponCode },
    });
    log('PUT', '/api/v1/users/me/cart/promotion', applied.status, `${couponCode} applied`);
    expect(applied.status).toBe(200);
    fact(`discountTotal=${applied.body.cart.discountTotal as string}`);
    // 10% of 1500.0000 is exactly 150.0000. Compared in minor units, never as floats.
    expect(minor(applied.body.cart.discountTotal as string)).toBe(minor('150.0000'));

    /* ---- addresses and the buyer's GSTIN ---- */

    const address = await hit('post', '/api/v1/users/me/addresses', {
      headers: asCustomer(),
      body: {
        label: 'Home',
        recipientName: 'Ada Lovelace',
        phone: '+91 9876543210',
        line1: '12 Residency Road',
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: '560025',
      },
    });
    log('POST', '/api/v1/users/me/addresses', address.status, 'shipping address created');
    expect(address.status).toBe(201);
    addressId = address.body.address.id as string;

    const badPostal = await hit('post', '/api/v1/users/me/addresses', {
      headers: asCustomer(),
      body: {
        label: 'Bad',
        recipientName: 'Ada Lovelace',
        phone: '+91 9876543210',
        line1: '12 Residency Road',
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: 'ABC',
      },
    });
    log('POST', '/api/v1/users/me/addresses', badPostal.status, 'a non-numeric PIN code');
    probe(
      'LOW',
      'validation',
      badPostal.status === 400,
      'an Indian PIN code should be validated as six digits',
      `status=${String(badPostal.status)} code=${codeOf(badPostal)}`,
    );

    const taxIdentity = await hit('put', '/api/v1/users/me/tax-identity', {
      headers: asCustomer(),
      body: { gstin: BUYER_GSTIN, legalName: 'Analytical Engines LLP' },
    });
    log('PUT', '/api/v1/users/me/tax-identity', taxIdentity.status, `buyer GSTIN ${BUYER_GSTIN}`);
    expect(taxIdentity.status).toBeLessThan(300);

    const readIdentity = await hit('get', '/api/v1/users/me/tax-identity', {
      headers: asCustomer(),
    });
    log('GET', '/api/v1/users/me/tax-identity', readIdentity.status, 'read back');
    expect(readIdentity.status).toBe(200);
  });

  /* ══ 6. Checkout ══════════════════════════════════════════════════════ */

  it('checks out, freezes the money, and holds the idempotency contract', async () => {
    section('6. CHECKOUT — money, reservation, idempotency');

    const noKey = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      body: { addressId },
    });
    log('POST', '/api/v1/users/me/checkout', noKey.status, 'NO idempotency-key');
    probe(
      'HIGH',
      'idempotency',
      noKey.status === 400,
      'a money-moving POST must require an idempotency key — without one a retried request charges twice',
      `status=${String(noKey.status)} code=${codeOf(noKey)}`,
    );

    const foreignAddress = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: `audit-foreign-${newId()}`,
      body: { addressId: newId() },
    });
    log(
      'POST',
      '/api/v1/users/me/checkout',
      foreignAddress.status,
      'an addressId that is not mine',
    );
    expect(foreignAddress.status).toBeGreaterThanOrEqual(400);
    expect(foreignAddress.status).toBeLessThan(500);

    const key = `audit-checkout-${newId()}`;
    const checkout = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: key,
      body: { addressId },
    });
    log('POST', '/api/v1/users/me/checkout', checkout.status, 'order placed');
    expect(checkout.status).toBe(201);

    const placed = checkout.body.order;
    orderNumber = placed.orderNumber as string;
    const [row] = await db().select().from(order).where(eq(order.orderNumber, orderNumber));
    orderId = row!.id;

    fact(`orderNumber   = ${orderNumber}`);
    fact(`subtotal      = ${placed.subtotal as string}`);
    fact(`discountTotal = ${placed.discountTotal as string}`);
    fact(`total (goods) = ${placed.total as string}`);
    fact(`taxTotal      = ${placed.taxTotal as string}`);
    fact(`grandTotal    = ${placed.grandTotal as string}   <- payable`);
    fact(
      `supplyType    = ${placed.tax.supplyType as string} (seller and buyer both in ${SELLER_STATE})`,
    );

    /* The money must FOOT, in minor units. */
    expect(minor(placed.total as string)).toBe(
      minor(placed.subtotal as string) - minor(placed.discountTotal as string),
    );
    expect(minor(placed.grandTotal as string)).toBe(
      minor(placed.total as string) + minor(placed.taxTotal as string),
    );
    fact('subtotal − discount = total, and total + tax = grandTotal, exactly');

    /* GST at 5% of 1350.0000 is 67.5000, split 33.7500 CGST + 33.7500 SGST. */
    expect(minor(placed.taxTotal as string)).toBe(minor('67.5000'));
    const itemTax = placed.items[0].tax as {
      cgstAmount: string;
      sgstAmount: string;
      igstAmount: string;
    };
    expect(minor(itemTax.cgstAmount)).toBe(minor(itemTax.sgstAmount));
    expect(minor(itemTax.igstAmount)).toBe(0n);
    fact(`intrastate: CGST ${itemTax.cgstAmount} + SGST ${itemTax.sgstAmount}, IGST nil`);

    /* ---- the idempotency replay ---- */

    const replay = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: key,
      body: { addressId },
    });
    log('POST', '/api/v1/users/me/checkout', replay.status, 'the SAME key replayed');
    expect(replay.body.order.orderNumber).toBe(orderNumber);
    fact('the replay returned the SAME order — not a second one');

    const orders = await db().select().from(order).where(eq(order.storeId, storeId));
    expect(orders.length).toBe(1);

    const conflicting = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: key,
      body: { addressId, note: 'different body' },
    });
    log('POST', '/api/v1/users/me/checkout', conflicting.status, 'the same key, a DIFFERENT body');
    probe(
      'MEDIUM',
      'idempotency',
      conflicting.status === 409 || conflicting.status === 422 || conflicting.status === 400,
      'reusing an idempotency key with a different body must be refused, or a retry silently returns the wrong result',
      `status=${String(conflicting.status)} code=${codeOf(conflicting)}`,
    );

    /* ---- the reservation ---- */

    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    fact(
      `inventory     = onHand ${String(stock[0]?.onHand)} / reserved ${String(stock[0]?.reserved)}`,
    );
    expect(stock[0]?.reserved).toBe(3);
    expect(stock[0]?.onHand).toBe(25);
    fact('checkout RESERVES; it does not deduct. Deduction happens at fulfilment.');

    /* ---- the cart after checkout ---- */

    const cart = await hit('get', '/api/v1/users/me/cart', { headers: asCustomer() });
    log(
      'GET',
      '/api/v1/users/me/cart',
      cart.status,
      `${String((cart.body.cart.items as unknown[]).length)} item(s) left`,
    );
    expect((cart.body.cart.items as unknown[]).length).toBe(0);

    const emptyCheckout = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: `audit-empty-${newId()}`,
      body: { addressId },
    });
    log('POST', '/api/v1/users/me/checkout', emptyCheckout.status, 'checking out an EMPTY cart');
    expect(emptyCheckout.status).toBeGreaterThanOrEqual(400);
    expect(emptyCheckout.status).toBeLessThan(500);
  });

  /* ══ 7. The invoice ═══════════════════════════════════════════════════ */

  it('issued a statutory invoice, and renders it without an injection hole', async () => {
    section('7. INVOICE');

    const [issued] = await db().select().from(invoice).where(eq(invoice.orderId, orderId));
    fact(`invoiceNumber = ${issued!.invoiceNumber}`);
    expect(issued!.invoiceNumber).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/u);
    fact('the number is gapless and per financial year — INV/YYYY-YY/NNNNNN');

    const document = await hit('get', `/api/v1/users/me/orders/${orderNumber}/invoice`, {
      headers: asCustomer(),
    });
    log('GET', '/api/v1/users/me/orders/:n/invoice', document.status, 'HTML rendered');
    expect(document.status).toBe(200);
    expect(document.text).toContain(issued!.invoiceNumber);
    expect(document.text).toContain(SELLER_GSTIN);
    expect(document.text).toContain(HSN);
    fact('the document carries the invoice number, the seller GSTIN and the HSN summary');

    /*
     * The invoice interpolates customer-controlled strings (a recipient name) into HTML. If it
     * does so unescaped, every invoice is a stored-XSS delivery vehicle — and invoices are the
     * documents most likely to be opened in a browser or forwarded by mail.
     */
    const payload = '<script>alert(1)</script>';
    const hostile = await hit('post', '/api/v1/users/me/addresses', {
      headers: asCustomer(),
      body: {
        label: 'XSS',
        recipientName: `Ada ${payload}`,
        phone: '+91 9876543210',
        line1: `12 ${payload} Road`,
        city: 'Bengaluru',
        state: SELLER_STATE,
        postalCode: '560025',
      },
    });
    log('POST', '/api/v1/users/me/addresses', hostile.status, 'an address carrying <script>');

    if (hostile.status === 201) {
      await hit('put', `/api/v1/users/me/cart/items/${skuCode}`, {
        headers: asCustomer(),
        body: { quantity: 1 },
      });
      const hostileOrder = await hit('post', '/api/v1/users/me/checkout', {
        headers: asCustomer(),
        idem: `audit-xss-${newId()}`,
        body: { addressId: hostile.body.address.id as string },
      });
      if (hostileOrder.status === 201) {
        const hostileNumber = hostileOrder.body.order.orderNumber as string;
        const rendered = await hit('get', `/api/v1/users/me/orders/${hostileNumber}/invoice`, {
          headers: asCustomer(),
        });
        log(
          'GET',
          '/api/v1/users/me/orders/:n/invoice',
          rendered.status,
          'the invoice for the hostile address',
        );
        probe(
          'HIGH',
          'xss',
          !rendered.text.includes('<script>'),
          'customer-supplied text must be HTML-escaped in a rendered invoice, or every invoice is a stored-XSS vector',
          `the raw <script> tag ${rendered.text.includes('<script>') ? 'REACHED' : 'did not reach'} the document`,
        );
        if (!rendered.text.includes('<script>')) {
          note('xss', 'the invoice renderer escapes customer-supplied text');
        }
        // Cancel it so the ledger below counts only the orders the audit means to leave.
        await hit('post', `/api/v1/users/me/orders/${hostileNumber}/cancel`, {
          headers: asCustomer(),
        });
      }
    } else {
      probe(
        'INFO',
        'xss',
        true,
        'an address containing markup is refused at validation, so the invoice renderer never sees it',
        `status=${String(hostile.status)} code=${codeOf(hostile)}`,
      );
      await hit('delete', `/api/v1/users/me/cart`, { headers: asCustomer() });
    }

    const adminCopy = await hit('get', `/api/v1/admin/orders/${orderNumber}/invoice`, {
      headers: asAdmin(),
    });
    log('GET', '/api/v1/admin/orders/:n/invoice', adminCopy.status, 'staff read the same invoice');
    expect(adminCopy.status).toBe(200);
  });

  /* ══ 8. Payment ═══════════════════════════════════════════════════════ */

  it('takes an online payment and settles it through a signed webhook', async () => {
    section('8. PAYMENT — Razorpay, real HMAC');

    const initiated = await hit('post', `/api/v1/users/me/orders/${orderNumber}/payments`, {
      headers: asCustomer(),
      idem: `audit-pay-${newId()}`,
      body: { method: 'online' },
    });
    log('POST', '/api/v1/users/me/orders/:n/payments', initiated.status, 'payment initiated');
    expect(initiated.status).toBe(201);
    fact(
      `status=${initiated.body.payment.status as string} provider=${initiated.body.handoff.provider as string} publicKey=${initiated.body.handoff.publicKey as string}`,
    );
    fact(
      'the handoff carries the PUBLIC key id only — the API secret is scanned for on every call',
    );

    const badMethod = await hit('post', `/api/v1/users/me/orders/${orderNumber}/payments`, {
      headers: asCustomer(),
      idem: `audit-badmethod-${newId()}`,
      body: { method: 'bitcoin' },
    });
    log('POST', '/api/v1/users/me/orders/:n/payments', badMethod.status, 'an unknown method');
    expect(badMethod.status).toBe(400);

    const second = await hit('post', `/api/v1/users/me/orders/${orderNumber}/payments`, {
      headers: asCustomer(),
      idem: `audit-pay2-${newId()}`,
      body: { method: 'online' },
    });
    log('POST', '/api/v1/users/me/orders/:n/payments', second.status, 'a SECOND payment attempt');
    probe(
      'HIGH',
      'payments',
      second.status >= 400,
      'a second live payment on one order must be refused, or the customer can be charged twice',
      `status=${String(second.status)} code=${codeOf(second)}`,
    );

    /* ---- the webhook ---- */

    const providerRef = providerRefs[providerRefs.length - 1]!;
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_AUDIT', order_id: providerRef } } },
    });
    const eventId = `evt_audit_${newId()}`;

    const unsigned = await hit('post', '/api/v1/webhooks/razorpay', {
      contentType: 'application/json',
      headers: { 'x-razorpay-event-id': `evt_unsigned_${newId()}` },
      raw: body,
    });
    log('POST', '/api/v1/webhooks/razorpay', unsigned.status, 'NO signature');
    expect(unsigned.status).toBe(401);

    const forged = await hit('post', '/api/v1/webhooks/razorpay', {
      contentType: 'application/json',
      headers: {
        'x-razorpay-signature': 'deadbeef'.repeat(8),
        'x-razorpay-event-id': `evt_forged_${newId()}`,
      },
      raw: body,
    });
    log('POST', '/api/v1/webhooks/razorpay', forged.status, 'a FORGED signature');
    expect(forged.status).toBe(401);

    const tamperedBody = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_TAMPER', order_id: providerRef } } },
    });
    const mismatched = await hit('post', '/api/v1/webhooks/razorpay', {
      contentType: 'application/json',
      headers: {
        // A signature over the ORIGINAL body, presented with a modified one.
        'x-razorpay-signature': sign(body),
        'x-razorpay-event-id': `evt_tamper_${newId()}`,
      },
      raw: tamperedBody,
    });
    log(
      'POST',
      '/api/v1/webhooks/razorpay',
      mismatched.status,
      'a valid signature over ANOTHER body',
    );
    expect(mismatched.status).toBe(401);
    fact('the HMAC covers the RAW bytes — a re-serialised or edited body no longer verifies');

    const accepted = await hit('post', '/api/v1/webhooks/razorpay', {
      contentType: 'application/json',
      headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': eventId },
      raw: body,
    });
    log('POST', '/api/v1/webhooks/razorpay', accepted.status, 'correctly signed — accepted');
    expect(accepted.status).toBe(200);

    const settled = await hit('get', `/api/v1/users/me/orders/${orderNumber}/payment`, {
      headers: asCustomer(),
    });
    log(
      'GET',
      '/api/v1/users/me/orders/:n/payment',
      settled.status,
      `status=${settled.body.payment.status as string}`,
    );
    expect(settled.body.payment.status).toBe('succeeded');

    const redelivered = await hit('post', '/api/v1/webhooks/razorpay', {
      contentType: 'application/json',
      headers: { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': eventId },
      raw: body,
    });
    log('POST', '/api/v1/webhooks/razorpay', redelivered.status, 'the SAME event id redelivered');
    expect(redelivered.status).toBe(200);
    fact(
      'a redelivery is a 200 and a no-op — providers retry, and a 4xx would make them retry harder',
    );

    const [orderRow] = await db().select().from(order).where(eq(order.id, orderId));
    fact(`order status  = ${orderRow!.status}`);

    const cancelPaid = await hit('post', `/api/v1/users/me/orders/${orderNumber}/cancel`, {
      headers: asCustomer(),
    });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/cancel',
      cancelPaid.status,
      'cancelling a PAID order refused',
    );
    probe(
      'HIGH',
      'orders',
      cancelPaid.status >= 400,
      'a paid order must not be cancellable through the customer route — that would release stock while holding money',
      `status=${String(cancelPaid.status)} code=${codeOf(cancelPaid)}`,
    );
  });

  /* ══ 9. Fulfilment ════════════════════════════════════════════════════ */

  it('ships and delivers, and refuses every illegal transition', async () => {
    section('9. FULFILMENT — the state machine, pushed');

    const queue = await hit('get', '/api/v1/admin/orders/fulfilment', { headers: asAdmin() });
    log('GET', '/api/v1/admin/orders/fulfilment', queue.status, 'the fulfilment queue');
    expect(queue.status).toBe(200);

    const created = await hit('post', `/api/v1/admin/orders/${orderNumber}/shipments`, {
      headers: asAdmin(),
      body: { carrier: 'Bluedart', trackingNumber: `BD-${String(Date.now()).slice(-8)}` },
    });
    log('POST', '/api/v1/admin/orders/:n/shipments', created.status, 'shipment created (pending)');
    expect(created.status).toBe(201);
    shipmentId = created.body.shipment.id as string;

    const deliverFirst = await hit('post', `/api/v1/admin/shipments/${shipmentId}/deliver`, {
      headers: asAdmin(),
      body: {},
    });
    log(
      'POST',
      '/api/v1/admin/shipments/:id/deliver',
      deliverFirst.status,
      'delivering a PENDING shipment',
    );
    probe(
      'MEDIUM',
      'fulfilment',
      deliverFirst.status === 409,
      'pending → delivered must be refused; a parcel cannot arrive before it leaves',
      `status=${String(deliverFirst.status)} code=${codeOf(deliverFirst)}`,
    );

    const shipped = await hit('post', `/api/v1/admin/shipments/${shipmentId}/ship`, {
      headers: asAdmin(),
      body: {},
    });
    log('POST', '/api/v1/admin/shipments/:id/ship', shipped.status, 'pending → shipped');
    expect(shipped.status).toBe(200);

    const shippedTwice = await hit('post', `/api/v1/admin/shipments/${shipmentId}/ship`, {
      headers: asAdmin(),
      body: {},
    });
    log('POST', '/api/v1/admin/shipments/:id/ship', shippedTwice.status, 'shipping twice');
    expect(shippedTwice.status).toBe(409);

    const delivered = await hit('post', `/api/v1/admin/shipments/${shipmentId}/deliver`, {
      headers: asAdmin(),
      body: {},
    });
    log('POST', '/api/v1/admin/shipments/:id/deliver', delivered.status, 'shipped → delivered');
    expect(delivered.status).toBe(200);

    const reShip = await hit('post', `/api/v1/admin/shipments/${shipmentId}/ship`, {
      headers: asAdmin(),
      body: {},
    });
    log('POST', '/api/v1/admin/shipments/:id/ship', reShip.status, 'shipping a DELIVERED shipment');
    expect(reShip.status).toBe(409);
    fact('the transitions are a real state machine, not a status column anyone can set');

    const tracked = await hit('get', `/api/v1/users/me/orders/${orderNumber}/shipments`, {
      headers: asCustomer(),
    });
    log(
      'GET',
      '/api/v1/users/me/orders/:n/shipments',
      tracked.status,
      `the customer sees status=${tracked.body.shipments[0].status as string}`,
    );
    expect(tracked.body.shipments[0].status).toBe('delivered');

    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    fact(
      `inventory = onHand ${String(stock[0]?.onHand)} / reserved ${String(stock[0]?.reserved)} (deducted at fulfilment)`,
    );
    expect(stock[0]?.reserved).toBe(0);
    expect(stock[0]?.onHand).toBe(22);
    fact('25 on hand, 3 shipped, 22 left — the reservation became a deduction exactly once');
  });

  /* ══ 10. Returns ══════════════════════════════════════════════════════ */

  it('runs the return lifecycle and refuses to over-return', async () => {
    section('10. RETURNS — customer raises, staff decides');

    const tooMany = await hit('post', `/api/v1/users/me/orders/${orderNumber}/returns`, {
      headers: asCustomer(),
      idem: `audit-ret-many-${newId()}`,
      body: { reason: 'defective', lines: [{ skuCode, quantity: 4 }] },
    });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/returns',
      tooMany.status,
      'returning 4 of 3 units purchased',
    );
    probe(
      'HIGH',
      'returns',
      tooMany.status >= 400,
      'a return must not exceed the quantity ordered, or a refund exceeds the payment',
      `status=${String(tooMany.status)} code=${codeOf(tooMany)}`,
    );

    const created = await hit('post', `/api/v1/users/me/orders/${orderNumber}/returns`, {
      headers: asCustomer(),
      idem: `audit-ret-${newId()}`,
      body: {
        reason: 'defective',
        customerNote: 'the seam split',
        lines: [{ skuCode, quantity: 1 }],
      },
    });
    log('POST', '/api/v1/users/me/orders/:n/returns', created.status, 'a return raised');
    expect(created.status).toBe(201);

    const raised = created.body.return;
    returnNumber = raised.returnNumber as string;
    fact(`returnNumber  = ${returnNumber}  status=${raised.status as string}`);
    fact(`refund goods  = ${raised.refundTaxableValue as string}`);
    fact(`refund tax    = ${raised.refundTaxTotal as string}`);
    fact(
      `refund total  = ${raised.refundTotal as string}  (1 of 3, apportioned from the FROZEN line)`,
    );

    /* One unit of three must refund at most a third of what was paid. */
    const [orderRow] = await db().select().from(order).where(eq(order.id, orderId));
    expect(minor(raised.refundTotal as string) * 3n).toBeLessThanOrEqual(
      minor(orderRow!.grandTotal) + 3n,
    );
    fact('the refund is apportioned from the frozen order line, so it cannot exceed what was paid');

    const staffNoteFromCustomer = raised as { staffNote?: unknown };
    probe(
      'INFO',
      'returns',
      !('staffNote' in staffNoteFromCustomer),
      'the customer projection omits staffNote — internal notes are not customer-visible',
      `keys: ${Object.keys(raised as object).join(', ')}`,
    );

    const queue = await hit('get', '/api/v1/admin/returns', {
      headers: asAdmin(),
      query: { status: 'requested' },
    });
    log(
      'GET',
      '/api/v1/admin/returns?status=requested',
      queue.status,
      `${String(queue.body.total)} awaiting a decision`,
    );
    expect(queue.status).toBe(200);

    const selfApprove = await hit('post', `/api/v1/admin/returns/${returnNumber}/approve`, {
      headers: asCustomer(),
      body: {},
    });
    log(
      'POST',
      '/api/v1/admin/returns/:n/approve',
      selfApprove.status,
      'the CUSTOMER approving their own return',
    );
    expect(selfApprove.status).toBe(403);

    const cancelTooEarly = await hit('post', `/api/v1/users/me/returns/${returnNumber}/cancel`, {
      headers: asCustomer(),
      body: {},
    });
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      cancelTooEarly.status,
      'cancelling before approval refused',
    );
    expect(cancelTooEarly.status).toBe(409);

    const approved = await hit('post', `/api/v1/admin/returns/${returnNumber}/approve`, {
      headers: asAdmin(),
      body: { staffNote: 'the photographs check out' },
    });
    log('POST', '/api/v1/admin/returns/:n/approve', approved.status, 'requested → approved');
    expect(approved.status).toBe(200);
    expect(approved.body.return.status).toBe('approved');

    /* Approval AGREES to a return; it never edits one. */
    expect(approved.body.return.refundTotal).toBe(raised.refundTotal);
    fact('the refund total is unchanged by approval — the frozen snapshot is not recomputed');

    const approvedTwice = await hit('post', `/api/v1/admin/returns/${returnNumber}/approve`, {
      headers: asAdmin(),
      body: {},
    });
    log('POST', '/api/v1/admin/returns/:n/approve', approvedTwice.status, 'approving twice');
    expect(approvedTwice.status).toBe(409);

    const rejectApproved = await hit('post', `/api/v1/admin/returns/${returnNumber}/reject`, {
      headers: asAdmin(),
      body: { staffNote: 'changed my mind' },
    });
    log(
      'POST',
      '/api/v1/admin/returns/:n/reject',
      rejectApproved.status,
      'rejecting an APPROVED return',
    );
    probe(
      'MEDIUM',
      'returns',
      rejectApproved.status === 409,
      'an approved return should not be rejectable — the decision is made and the customer has been told',
      `status=${String(rejectApproved.status)} code=${codeOf(rejectApproved)}`,
    );

    const cancelled = await hit('post', `/api/v1/users/me/returns/${returnNumber}/cancel`, {
      headers: asCustomer(),
      body: {},
    });
    log(
      'POST',
      '/api/v1/users/me/returns/:n/cancel',
      cancelled.status,
      'the customer withdraws it',
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.return.status).toBe('cancelled');

    const reRaised = await hit('post', `/api/v1/users/me/orders/${orderNumber}/returns`, {
      headers: asCustomer(),
      idem: `audit-ret2-${newId()}`,
      body: { reason: 'not_as_described', lines: [{ skuCode, quantity: 3 }] },
    });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/returns',
      reRaised.status,
      'all 3 units returnable again after the cancel',
    );
    expect(reRaised.status).toBe(201);
    const secondNumber = reRaised.body.return.returnNumber as string;

    const rejected = await hit('post', `/api/v1/admin/returns/${secondNumber}/reject`, {
      headers: asAdmin(),
      body: { staffNote: 'outside the policy window' },
    });
    log('POST', '/api/v1/admin/returns/:n/reject', rejected.status, 'no refund, no restock');
    expect(rejected.status).toBe(200);
    expect(rejected.body.return.closedAt).not.toBeNull();

    const [header] = await db()
      .select()
      .from(returnRequest)
      .where(eq(returnRequest.returnNumber, secondNumber));
    const events = await db()
      .select()
      .from(returnEvent)
      .where(eq(returnEvent.returnId, header!.id));
    fact(`history       = ${events.map((event) => event.toStatus).join(' → ')} (append-only)`);
    expect(events.map((event) => event.toStatus)).toEqual(['requested', 'rejected']);

    returnNumber = secondNumber;
  });

  /* ══ 11. Cancellation, and the reservation coming back ════════════════ */

  it('releases the reservation when an unpaid order is cancelled', async () => {
    section('11. CANCELLATION — the reservation must come back');

    const before = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    const onHandBefore = before[0]?.onHand ?? 0;

    await hit('put', `/api/v1/users/me/cart/items/${skuCode}`, {
      headers: asCustomer(),
      body: { quantity: 2 },
    });
    const placed = await hit('post', '/api/v1/users/me/checkout', {
      headers: asCustomer(),
      idem: `audit-cancel-${newId()}`,
      body: { addressId },
    });
    log('POST', '/api/v1/users/me/checkout', placed.status, 'a second order, 2 units, unpaid');
    expect(placed.status).toBe(201);
    const cancelNumber = placed.body.order.orderNumber as string;

    const reserved = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    expect(reserved[0]?.reserved).toBe(2);
    fact(`reserved = ${String(reserved[0]?.reserved)} while the order is open`);

    const cancelled = await hit('post', `/api/v1/users/me/orders/${cancelNumber}/cancel`, {
      headers: asCustomer(),
    });
    log('POST', '/api/v1/users/me/orders/:n/cancel', cancelled.status, 'the customer cancels');
    expect(cancelled.status).toBeLessThan(300);

    const released = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    expect(released[0]?.reserved).toBe(0);
    expect(released[0]?.onHand).toBe(onHandBefore);
    fact(`reserved back to 0, onHand still ${String(onHandBefore)} — nothing was lost or leaked`);

    const twice = await hit('post', `/api/v1/users/me/orders/${cancelNumber}/cancel`, {
      headers: asCustomer(),
    });
    log('POST', '/api/v1/users/me/orders/:n/cancel', twice.status, 'cancelling twice');
    expect(twice.status).toBe(409);
    fact(
      'a second cancellation is a conflict, not a silent no-op — a client can tell what happened',
    );

    const payCancelled = await hit('post', `/api/v1/users/me/orders/${cancelNumber}/payments`, {
      headers: asCustomer(),
      idem: `audit-paycancel-${newId()}`,
      body: { method: 'online' },
    });
    log(
      'POST',
      '/api/v1/users/me/orders/:n/payments',
      payCancelled.status,
      'paying a CANCELLED order',
    );
    probe(
      'HIGH',
      'payments',
      payCancelled.status >= 400,
      'a cancelled order must not accept a payment, or money arrives against stock that was released',
      `status=${String(payCancelled.status)} code=${codeOf(payCancelled)}`,
    );
  });

  /* ══ 12. Oversell under concurrency ═══════════════════════════════════ */

  it('cannot be made to oversell by two customers checking out at once', async () => {
    section('12. CONCURRENCY — the oversell test');

    const suffix = String(Date.now()).slice(-6);
    const scarceSlug = `audit-scarce-${suffix}`;
    const scarceSku = `AUDIT-SCARCE-${suffix}`;

    await hit('post', '/api/v1/admin/products', {
      headers: asAdmin(),
      body: { slug: scarceSlug, name: 'Last One', status: 'active' },
    });
    await hit('post', `/api/v1/admin/products/${scarceSlug}/skus`, {
      headers: asAdmin(),
      body: { code: scarceSku, price: '100.0000' },
    });
    await hit('post', '/api/v1/admin/inventory/adjustments', {
      headers: asAdmin(),
      body: { skuCode: scarceSku, delta: 1, reason: 'manual_increase' },
    });
    await hit('put', `/api/v1/admin/skus/${scarceSku}/tax`, {
      headers: asAdmin(),
      body: { taxClassCode: 'GST5', hsnCode: HSN },
    });
    log(
      'POST',
      '/api/v1/admin/inventory/adjustments',
      201,
      `${scarceSku}: exactly ONE unit in stock`,
    );

    /* Two brand-new rivals, so neither is the customer whose state the rest of the audit uses. */
    const rivals = await Promise.all(
      [1, 2].map(async (index) => {
        const email = `audit.rival${String(index)}.${newId()}@example.com`;
        await hit('post', '/api/v1/auth/register', {
          body: { email, password: PASSWORD, firstName: 'Rival', lastName: String(index) },
        });
        const login = await hit('post', '/api/v1/auth/login', {
          body: { email, password: PASSWORD },
        });
        const headers = { Authorization: `Bearer ${login.body.accessToken as string}` };
        const address = await hit('post', '/api/v1/users/me/addresses', {
          headers,
          body: {
            label: 'Home',
            recipientName: `Rival ${String(index)}`,
            phone: '+91 9876543210',
            line1: '1 Race Course Road',
            city: 'Bengaluru',
            state: SELLER_STATE,
            postalCode: '560001',
          },
        });
        await hit('put', `/api/v1/users/me/cart/items/${scarceSku}`, {
          headers,
          body: { quantity: 1 },
        });
        return { headers, addressId: address.body.address.id as string };
      }),
    );
    log(
      'POST',
      '/api/v1/auth/register',
      201,
      'two rival customers, each with the last unit in cart',
    );

    /* Both at once, on purpose. This is the race the FOR UPDATE lock exists for. */
    const results = await Promise.all(
      rivals.map(async (rival) =>
        hit('post', '/api/v1/users/me/checkout', {
          headers: rival.headers,
          idem: `audit-race-${newId()}`,
          body: { addressId: rival.addressId },
        }),
      ),
    );

    const statuses = results.map((response) => response.status);
    const winners = statuses.filter((status) => status === 201).length;
    log(
      'POST',
      '/api/v1/users/me/checkout ×2 (parallel)',
      statuses[0]!,
      `statuses=${statuses.join(', ')}`,
    );

    expect(winners).toBe(1);
    fact('exactly ONE of the two parallel checkouts won the last unit');

    const rows = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    const scarceRow = rows.find((row) => row.onHand === 1 && row.reserved === 1);
    probe(
      'HIGH',
      'inventory',
      scarceRow !== undefined,
      'the scarce SKU must end at onHand 1 / reserved 1 — reserved may never exceed on hand',
      `rows: ${rows.map((row) => `${String(row.onHand)}/${String(row.reserved)}`).join(' ')}`,
    );
    for (const row of rows) {
      expect(row.reserved).toBeLessThanOrEqual(row.onHand);
    }
    fact('reserved ≤ onHand holds for every stock row after the race');
  });

  /* ══ 13. Tenant and owner isolation ═══════════════════════════════════ */

  it('keeps one customer entirely out of another customer data', async () => {
    section('13. ISOLATION — 404, not 403');

    const email = `audit.intruder.${newId()}@example.com`;
    await hit('post', '/api/v1/auth/register', {
      body: { email, password: PASSWORD, firstName: 'Mallory', lastName: 'X' },
    });
    const login = await hit('post', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    const headers = { Authorization: `Bearer ${login.body.accessToken as string}` };
    log('POST', '/api/v1/auth/login', login.status, 'a second, unrelated customer');

    const reachable: [string, string][] = [
      [`/api/v1/users/me/orders/${orderNumber}`, 'the order'],
      [`/api/v1/users/me/orders/${orderNumber}/invoice`, 'the invoice'],
      [`/api/v1/users/me/orders/${orderNumber}/payment`, 'the payment'],
      [`/api/v1/users/me/orders/${orderNumber}/shipments`, 'the shipments'],
      [`/api/v1/users/me/returns/${returnNumber}`, 'the return'],
      [`/api/v1/users/me/addresses/${addressId}`, 'the address'],
    ];

    for (const [path, label] of reachable) {
      const response = await hit('get', path, { headers });
      log(
        'GET',
        path
          .replace(orderNumber, ':order')
          .replace(returnNumber, ':return')
          .replace(addressId, ':id'),
        response.status,
        `${label} — hidden`,
      );
      probe(
        'HIGH',
        'isolation',
        response.status === 404,
        `${label} of another customer must answer 404 (a 403 would confirm the row exists)`,
        `status=${String(response.status)}`,
      );
    }

    const write = await hit('post', `/api/v1/users/me/orders/${orderNumber}/cancel`, { headers });
    log('POST', '/api/v1/users/me/orders/:order/cancel', write.status, 'cancelling ANOTHER order');
    expect(write.status).toBe(404);

    const foreignReturn = await hit('post', `/api/v1/users/me/returns/${returnNumber}/cancel`, {
      headers,
      body: {},
    });
    log(
      'POST',
      '/api/v1/users/me/returns/:return/cancel',
      foreignReturn.status,
      'cancelling ANOTHER return',
    );
    expect(foreignReturn.status).toBe(404);

    const ownCart = await hit('get', '/api/v1/users/me/cart', { headers });
    log(
      'GET',
      '/api/v1/users/me/cart',
      ownCart.status,
      'the intruder sees only their OWN empty cart',
    );
    expect((ownCart.body.cart.items as unknown[]).length).toBe(0);

    const ownAddresses = await hit('get', '/api/v1/users/me/addresses', { headers });
    expect((ownAddresses.body.addresses as unknown[]).length).toBe(0);
    log(
      'GET',
      '/api/v1/users/me/addresses',
      ownAddresses.status,
      'and none of the other customer addresses',
    );
  });

  /* ══ 14. Platform hygiene ═════════════════════════════════════════════ */

  it('checks the platform surface no module owns: headers, 404s, bad bodies, health', async () => {
    section('14. PLATFORM HYGIENE');

    const live = await hit('get', '/health/live');
    log('GET', '/health/live', live.status, 'liveness');
    expect(live.status).toBe(200);

    const ready = await hit('get', '/health/ready');
    log('GET', '/health/ready', ready.status, 'readiness (Postgres + Redis)');
    expect(ready.status).toBe(200);

    probe(
      'LOW',
      'observability',
      !JSON.stringify(ready.body).includes(testDb.connectionUri),
      'a health payload must not echo a connection string — it carries credentials',
      `body=${JSON.stringify(ready.body).slice(0, 200)}`,
    );

    /* ---- headers ---- */

    const headed = await hit('get', '/api/v1/products');
    const headers = headed.headers as Record<string, string | undefined>;
    fact(
      `security headers: ${Object.keys(headers)
        .filter((key) => key.startsWith('x-') || key.includes('security') || key.includes('policy'))
        .join(', ')}`,
    );

    probe(
      'MEDIUM',
      'headers',
      headers['x-powered-by'] === undefined,
      'x-powered-by must be off — it advertises the stack for free',
      `x-powered-by=${String(headers['x-powered-by'])}`,
    );
    probe(
      'LOW',
      'headers',
      headers['x-content-type-options'] === 'nosniff',
      'X-Content-Type-Options: nosniff should be set',
      `value=${String(headers['x-content-type-options'])}`,
    );
    probe(
      'LOW',
      'headers',
      headers['strict-transport-security'] !== undefined,
      'Strict-Transport-Security should be set',
      `value=${String(headers['strict-transport-security'])}`,
    );
    probe(
      'LOW',
      'headers',
      headers['x-request-id'] !== undefined || headers['request-id'] !== undefined,
      'a correlation id should be returned, so a customer report can be traced to a log line',
      `x-request-id=${String(headers['x-request-id'])} request-id=${String(headers['request-id'])}`,
    );

    /* ---- CORS ---- */

    const hostileOrigin = await hit('get', '/api/v1/products', {
      headers: { Origin: 'https://evil.example.com' },
    });
    const allowOrigin = (hostileOrigin.headers as Record<string, string | undefined>)[
      'access-control-allow-origin'
    ];
    log('GET', '/api/v1/products', hostileOrigin.status, 'from a DISALLOWED Origin');
    probe(
      'MEDIUM',
      'cors',
      allowOrigin === undefined || allowOrigin === 'http://localhost:3000',
      'an unlisted origin must not be reflected in Access-Control-Allow-Origin',
      `access-control-allow-origin=${String(allowOrigin)}`,
    );

    /* ---- unknown routes and bad bodies ---- */

    const unknown = await hit('get', `/api/v1/no-such-endpoint-${newId()}`);
    log('GET', '/api/v1/no-such-endpoint', unknown.status, 'an unknown path');
    expect(unknown.status).toBe(404);
    probe(
      'LOW',
      'errors',
      typeof (unknown.body as { error?: unknown }).error === 'object',
      'a 404 should use the same error envelope as every other failure, not an HTML page',
      `content-type=${String((unknown.headers as Record<string, string | undefined>)['content-type'])}`,
    );

    const badMethod = await hit('delete', '/api/v1/products');
    log('DELETE', '/api/v1/products', badMethod.status, 'a method the route does not have');
    expect(badMethod.status).toBeGreaterThanOrEqual(400);
    expect(badMethod.status).toBeLessThan(500);

    const malformed = await hit('post', '/api/v1/auth/login', {
      contentType: 'application/json',
      raw: '{"email": "a@b.c", "password": ',
    });
    log('POST', '/api/v1/auth/login', malformed.status, 'a TRUNCATED JSON body');
    probe(
      'MEDIUM',
      'errors',
      malformed.status === 400,
      'malformed JSON must be a 400, never a 500 — a parse failure is the client’s fault',
      `status=${String(malformed.status)} code=${codeOf(malformed)}`,
    );

    const wrongContentType = await hit('post', '/api/v1/auth/login', {
      contentType: 'text/plain',
      raw: 'email=a@b.c',
    });
    log('POST', '/api/v1/auth/login', wrongContentType.status, 'a text/plain body');
    expect(wrongContentType.status).toBeGreaterThanOrEqual(400);
    expect(wrongContentType.status).toBeLessThan(500);

    const oversized = await hit('post', '/api/v1/auth/register', {
      body: {
        email: `big.${newId()}@example.com`,
        password: PASSWORD,
        firstName: 'A'.repeat(50_000),
        lastName: 'B',
      },
    });
    log('POST', '/api/v1/auth/register', oversized.status, 'a 50 KB first name');
    probe(
      'LOW',
      'validation',
      oversized.status === 400 || oversized.status === 413,
      'an absurdly long field should be refused at validation rather than reaching the database',
      `status=${String(oversized.status)} code=${codeOf(oversized)}`,
    );

    /* ---- an error body must not carry a stack trace ---- */

    const errorBody = JSON.stringify(malformed.body);
    probe(
      'HIGH',
      'errors',
      !errorBody.includes('    at ') && !errorBody.toLowerCase().includes('node_modules'),
      'an error response must not carry a stack trace or an internal path',
      `body=${errorBody.slice(0, 200)}`,
    );

    /* ---- the documented surface ---- */

    const docs = await hit('get', '/api/v1/docs.json');
    log('GET', '/api/v1/docs.json', docs.status, 'the OpenAPI document');
    if (docs.status === 200) {
      const paths = Object.keys((docs.body as { paths?: object }).paths ?? {});
      fact(`${String(paths.length)} documented paths`);
    }
  });

  /* ══ 15. The ledger ═══════════════════════════════════════════════════ */

  it('prints the final state and the FINDINGS ledger', async () => {
    section('FINAL STATE');

    const orders = await db().select().from(order).where(eq(order.storeId, storeId));
    const invoices = await db().select().from(invoice).where(eq(invoice.storeId, storeId));
    const returns = await db()
      .select()
      .from(returnRequest)
      .where(eq(returnRequest.storeId, storeId));
    const stock = await db().select().from(stockItem).where(eq(stockItem.storeId, storeId));
    const users = await db().select().from(appUser);

    line(
      `  users       : ${String(users.length)}  (${String(users.filter((user) => user.isStaff).length)} staff)`,
    );
    line(
      `  orders      : ${String(orders.length)}  (${orders.map((row) => row.status).join(', ')})`,
    );
    line(
      `  invoices    : ${String(invoices.length)}  (${invoices.map((row) => row.invoiceNumber).join(', ')})`,
    );
    line(
      `  returns     : ${String(returns.length)}  (${returns.map((row) => row.status).join(', ')})`,
    );
    line(
      `  stock rows  : ${stock.map((row) => `${String(row.onHand)} on hand / ${String(row.reserved)} reserved`).join(' | ')}`,
    );
    line(`  HTTP calls  : ${String(timings.length)}`);

    /* Every stock row, one last time. This is the invariant that matters most. */
    for (const row of stock) {
      expect(row.reserved).toBeLessThanOrEqual(row.onHand);
      expect(row.onHand).toBeGreaterThanOrEqual(0);
      expect(row.reserved).toBeGreaterThanOrEqual(0);
    }
    line('  invariant   : reserved ≤ onHand, both non-negative, on every row ✓');

    /* ---- the slowest calls ---- */

    section('SLOWEST CALLS');
    const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 8);
    for (const entry of slowest) {
      line(`  ${String(entry.ms).padStart(5)}ms  ${String(entry.status)}  ${entry.path}`);
    }
    /*
     * Argon2 dominates, by design — it is a deliberately expensive hash. Anything else near
     * the top is worth a look, so the threshold is recorded rather than asserted.
     */
    const slowNonAuth = slowest.filter(
      (entry) =>
        entry.ms > 1_500 && !entry.path.includes('/auth/') && !entry.path.includes('password'),
    );
    probe(
      'LOW',
      'performance',
      slowNonAuth.length === 0,
      'no non-authentication call should take over 1.5s against a local database',
      slowNonAuth.map((entry) => `${entry.path} ${String(entry.ms)}ms`).join('; '),
    );

    /* ---- the ledger ---- */

    section('FINDINGS');

    const order_: Severity[] = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];
    const counts = order_.map((severity) => ({
      severity,
      items: findings.filter((finding) => finding.severity === severity),
    }));

    line('');
    line(
      `  ${counts.map(({ severity, items }) => `${severity} ${String(items.length)}`).join('   ·   ')}`,
    );
    line(
      `  from ${String(probes.run)} soft probes (${String(probes.held)} held) and ${String(timings.length)} HTTP calls, over and above the hard expect() assertions`,
    );

    for (const { severity, items } of counts) {
      if (items.length === 0) continue;
      line('');
      line(
        `  ── ${severity} (${String(items.length)}) ${'─'.repeat(Math.max(0, 56 - severity.length))}`,
      );
      items.forEach((finding, index) => {
        line(`  ${String(index + 1).padStart(2)}. [${finding.area}]`);
        line(`      expected : ${finding.expected}`);
        line(`      observed : ${finding.observed}`);
      });
    }

    line('');
    line('  NOTES ON READING THIS LEDGER');
    line(
      '    · HIGH   — a real defect, or an invariant that only held by luck. Fix before release.',
    );
    line('    · MEDIUM — a weakness with a plausible exploit or a bad failure mode.');
    line('    · LOW    — a rough edge: an accepted trade-off, a missing hardening, a papercut.');
    line('    · INFO   — a property this run CONFIRMED. Not a defect; evidence.');
    line('');
    line('  NOT IMPLEMENTED IN THIS BUILD (so not graded above):');
    line('    · return receipt, inspection and restock   — Increment 40e');
    line('    · refund execution (COD + Razorpay)        — Increment 40f');
    line('    · credit notes for returned GST            — not approved');
    line('');

    /*
     * The gate. A HIGH finding is a defect the audit found under its own steam, and this file
     * is worth nothing if it discovers one and still reports success. LOW and MEDIUM are
     * printed, counted and deliberately NOT fatal — they are the backlog, not the build.
     */
    const high = findings.filter((finding) => finding.severity === 'HIGH');
    expect(
      high.map((finding) => `${finding.area}: ${finding.expected} (observed ${finding.observed})`),
    ).toEqual([]);
  });
});
