import type { Request, RequestHandler } from 'express';

import {
  hashRateLimitSubject,
  type RateLimiter,
  type RateLimitPolicy,
  type RateLimitVerdict,
} from '../../redis/rate-limiter.js';
import { RateLimited } from '../../shared/errors.js';
import type { Logger } from '../../shared/logger.js';
import { asyncHandler } from '../async-handler.js';
import { requireStore } from './store.js';

/**
 * Rate limiting middleware.
 *
 * Mounted PER ROUTE, not globally on the API router. The budgets are endpoint-specific —
 * login and register want different allowances, and a catalogue browse in Phase 2 must not
 * be throttled by an auth-shaped policy. A global limiter would either be too tight for
 * browsing or too loose to protect Argon2.
 *
 * Two limiters, protecting two different things:
 *
 *  - **Per IP** caps CPU. Every Argon2 verification costs ~50 ms of a worker, so a few
 *    hundred concurrent attempts is a denial of service against the whole API, not just
 *    against one account. This counts EVERY attempt, because a successful login costs the
 *    same CPU as a failed one.
 *  - **Per email + store** caps guesses against one account, which is what stops credential
 *    stuffing from a botnet where each IP sends only one or two requests and never trips the
 *    per-IP limit.
 *
 * The per-email limiter here only CHECKS. Spending the budget is the service's job, because
 * only the service knows whether the credentials were valid — see the note on
 * `rateLimitByEmail` below.
 */

/** Bucket names. Constants, so the middleware and the service cannot disagree on a key. */
export const RATE_LIMIT_BUCKETS = {
  loginIp: 'login:ip',
  loginEmail: 'login:email',
  registerIp: 'register:ip',
  refreshIp: 'refresh:ip',
} as const;

/**
 * Apply the verdict: advertise the budget on every response, reject when it is spent.
 *
 * The `X-RateLimit-*` headers are set on ALLOWED requests too. A client that can see it has
 * two attempts left can back off before being blocked, which is the difference between a
 * well-behaved integration and one that hammers until it gets a 429.
 *
 * TWO limiters run on login, and both want to describe "the" budget in one pair of headers.
 * Whichever writes last would otherwise win by accident — so the TIGHTEST budget is reported
 * instead, because that is the one the client will actually hit first. Advertising the roomy
 * per-IP allowance while the per-email budget is one attempt from exhaustion would tell a
 * well-behaved client it had headroom it does not have.
 */
function enforce(req: Request, verdict: RateLimitVerdict, policy: RateLimitPolicy): void {
  const response = req.res;

  if (response) {
    const advertised = response.getHeader('X-RateLimit-Remaining');
    const isTighter = advertised === undefined || verdict.remaining < Number(advertised);

    if (isTighter) {
      response.setHeader('X-RateLimit-Limit', String(policy.max));
      response.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
    }
  }

  if (verdict.allowed) return;

  /**
   * `Retry-After` AND `details.retryAfterSeconds`.
   *
   * The header is the HTTP-standard signal that proxies, SDKs and browsers already honour
   * without any client code; the body field is what a UI can render as "try again in 42
   * seconds". Sending only the body means well-behaved clients retry immediately anyway.
   */
  response?.setHeader('Retry-After', String(verdict.retryAfterSeconds));
  throw new RateLimited(verdict.retryAfterSeconds);
}

/**
 * Limit by client IP, counting every attempt.
 *
 * `req.ip`, never a hand-parsed `X-Forwarded-For`. `app.ts` sets `trust proxy: 1`, which is
 * the application's declared trust boundary — Express derives `req.ip` from exactly one
 * forwarded hop. Parsing the header here would trust hops the rest of the app deliberately
 * does not, and a client could then forge a fresh identity per request and bypass this
 * entirely.
 */
export function rateLimitByIp(deps: {
  limiter: RateLimiter;
  policy: RateLimitPolicy;
  bucket: string;
  logger: Logger;
}): RequestHandler {
  const { limiter, policy, bucket, logger } = deps;

  return asyncHandler(async (req, _res, next) => {
    /**
     * A missing `req.ip` must not become a free pass. Express only leaves it undefined when
     * there is no socket, which in practice means a synthetic request — so all such requests
     * share one bucket rather than each getting an unlimited one.
     */
    const subject = hashRateLimitSubject(req.ip ?? 'unknown');
    const verdict = await limiter.consume(bucket, subject, policy);

    if (!verdict.allowed) {
      // The IP is NOT logged: it is a hashed subject in Redis by design, and an attacker
      // cycling addresses would otherwise get to write unbounded content into our logs.
      logger.warn({ bucket, count: verdict.count, limit: policy.max }, 'rate_limit_exceeded_ip');
    }

    enforce(req, verdict, policy);
    next();
  });
}

/**
 * Limit by email + store, CHECKING ONLY.
 *
 * This middleware never increments. That is the whole point:
 *
 *  - It runs BEFORE authentication, so it cannot know whether the credentials are valid.
 *  - If it counted here, a legitimate user who mistypes one character and then logs in
 *    correctly would have spent budget on the successful attempt. A handful of careless
 *    typos across a day would lock out a paying customer.
 *
 * So the budget is spent by `identity.login` after a rejection and cleared after a success,
 * and this middleware only refuses to let a request through once the budget is already gone.
 * The counter is therefore a FAILURE counter, not a request counter.
 *
 * The email is read from the RAW body, before validation has run — see the guard below.
 */
export function rateLimitByEmail(deps: {
  limiter: RateLimiter;
  policy: RateLimitPolicy;
  bucket: string;
  logger: Logger;
}): RequestHandler {
  const { limiter, policy, bucket, logger } = deps;

  return asyncHandler(async (req, _res, next) => {
    const email = readEmailFromRawBody(req);

    /**
     * No usable email means no email budget to check, so this limiter abstains and lets
     * `validate` reject the body with a 400. Inventing a bucket for absent emails would put
     * every malformed request in the world into one counter, and the first attacker to send
     * garbage would lock out every genuine malformed request behind the same key.
     *
     * The per-IP limiter has already counted this attempt, so a flood of bodyless requests
     * is still capped.
     */
    if (email === null) {
      next();
      return;
    }

    const store = requireStore(req);

    /**
     * The store is part of the subject. Two tenants can legitimately have a customer with
     * the same address, and letting one tenant's failed logins consume the other's budget
     * would be both a cross-tenant leak and a trivial way to lock out a competitor's users.
     */
    const subject = hashRateLimitSubject(store.id, email);
    const verdict = await limiter.peek(bucket, subject, policy);

    if (!verdict.allowed) {
      /**
       * No email in the log line, and no distinction anywhere in the RESPONSE between
       * "this address exists and is being attacked" and "this address has never existed".
       *
       * That matters: the counter keys on whatever the client sent, existing or not, so the
       * 429 arrives after the same number of failures either way. If the limiter only
       * tracked real accounts, a 429 would confirm the address exists — turning brute-force
       * protection into exactly the enumeration oracle that `InvalidCredentials` exists to
       * prevent.
       */
      logger.warn({ bucket, count: verdict.count, limit: policy.max }, 'rate_limit_exceeded_email');
    }

    enforce(req, verdict, policy);
    next();
  });
}

/** Longest address `emailField` accepts. Anything longer cannot be a real account. */
const MAX_EMAIL_LENGTH = 320;

/**
 * Pull an email out of an unvalidated request body.
 *
 * This runs before `validate`, so the body is whatever the client sent: it may be absent, a
 * string, an array, or an object with `email` set to a number. Every non-string shape
 * returns null rather than being coerced — `String(someObject)` would happily produce a
 * bucket key from `[object Object]`.
 *
 * Normalisation must MATCH `emailField` in the DTO (trim, lowercase), or the middleware and
 * the service would key on different subjects for the same address and the budget would
 * silently never be enforced. Length is capped because the key derives from
 * attacker-controlled input.
 */
function readEmailFromRawBody(req: Request): string | null {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const raw = (body as { email?: unknown }).email;
  if (typeof raw !== 'string') return null;

  const normalised = raw.trim().toLowerCase();
  if (normalised.length === 0 || normalised.length > MAX_EMAIL_LENGTH) return null;

  return normalised;
}
