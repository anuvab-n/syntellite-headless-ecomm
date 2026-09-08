import { z } from 'zod';

/**
 * Configuration.
 *
 * Three rules:
 *
 *  1. Twelve-factor. Everything comes from the environment. There is no
 *     `if (env === 'production')` anywhere else in the codebase — differences between
 *     environments are values, not branches.
 *  2. Fail fast. A missing or malformed variable crashes the process at startup with
 *     every problem listed at once. It does not fail at 3 a.m. on first use.
 *  3. `process.env` is read ONCE, here, and mapped explicitly. Never spread it into the
 *     schema: a blind spread means a typo'd variable name silently becomes `undefined`
 *     and a renamed one silently keeps working from a stale value.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean),
);

/**
 * PEM key material.
 *
 * Two stages, in this order:
 *
 *  1. Unescape. Keys arrive from `.env` with literal `\n` sequences, because dotenv does not
 *     interpret escapes inside quoted values. Restore the real newlines or every JWT
 *     operation fails with an opaque ASN.1 error.
 *  2. Validate the SHAPE. Previously this was `.min(1)`, which accepted any non-empty
 *     string — `'not-a-key'` and `' '` both passed. That deferred the failure to the first
 *     token ever signed, which in a fresh deployment means the first customer login rather
 *     than boot. It contradicted this file's own rule 2 ("fail fast"), so it is fixed here.
 *
 * Shape only, deliberately. Proving a key is cryptographically *usable* means importing it,
 * which is async, and `loadConfig()` is synchronous by design — making it async would ripple
 * into `buildContainer()` and three process entry points. The regex catches every realistic
 * failure (empty, whitespace, wrong file pasted, PKCS#1 instead of PKCS#8, truncated body);
 * the token service catches the exotic remainder on first use.
 */
const pemKey = (label: string, header: string): z.ZodType<string> =>
  z
    .string()
    .transform((s) => s.replace(/\\n/g, '\n').trim())
    .refine((s) => s.length > 0, { message: `${label} must not be empty` })
    .refine((s) => s.startsWith(`-----BEGIN ${header}-----`), {
      // Names the fix rather than just the fault: the most common cause is the wrong half of
      // the pair, or a PKCS#1 key from `openssl genrsa` without `-outform`.
      message: `${label} must be a PEM block beginning with "-----BEGIN ${header}-----" (generate one with: pnpm keys:generate)`,
    })
    .refine((s) => s.trimEnd().endsWith(`-----END ${header}-----`), {
      message: `${label} must end with "-----END ${header}-----" — it looks truncated`,
    })
    .refine(
      (s) => {
        // Base64 body between the delimiters. Catches a key whose newlines were mangled into
        // spaces, which produces a valid-looking block that no parser accepts.
        const body = s
          .replace(`-----BEGIN ${header}-----`, '')
          .replace(`-----END ${header}-----`, '')
          .replace(/\s+/g, '');
        return body.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
      },
      { message: `${label} does not contain a valid base64 key body` },
    );

/** PKCS#8, which is what `pnpm keys:generate` emits and what `jose` imports. */
const privateKeyPem = pemKey('JWT_PRIVATE_KEY', 'PRIVATE KEY');
/** SPKI, the matching public encoding. */
const publicKeyPem = pemKey('JWT_PUBLIC_KEY', 'PUBLIC KEY');

const ConfigSchema = z
  .object({
    /* ── Core ──────────────────────────────────────────────────────────── */
    nodeEnv: z.enum(['development', 'test', 'production']),
    /**
     * Deliberately separate from `nodeEnv`. Staging runs with NODE_ENV=production (so
     * dependencies behave identically to production) but must never charge a real card,
     * so the production guards below key off `environment`, not `nodeEnv`.
     */
    environment: z.enum(['local', 'test', 'staging', 'production']),
    port: z.coerce.number().int().positive().max(65535).default(8000),

    /* ── Database ──────────────────────────────────────────────────────── */
    databaseUrl: z.string().url(),
    databaseReplicaUrl: z.string().url().optional(),
    databasePoolMax: z.coerce.number().int().positive().default(10),
    /**
     * A query that has run for 30s in a web request is never going to succeed usefully;
     * it is holding a connection and, if it took a lock, blocking checkouts.
     */
    databaseStatementTimeoutMs: z.coerce.number().int().positive().default(30_000),

    /* ── Redis ─────────────────────────────────────────────────────────── */
    redisCacheUrl: z.string().url(),
    redisLockUrl: z.string().url(),
    redisQueueUrl: z.string().url(),

    /* ── Auth ──────────────────────────────────────────────────────────── */
    jwtPrivateKey: privateKeyPem,
    jwtPublicKey: publicKeyPem,
    jwtIssuer: z.string().min(1),
    jwtAudience: z.string().min(1),
    jwtAccessTtlMinutes: z.coerce.number().int().positive().default(15),
    jwtRefreshTtlDays: z.coerce.number().int().positive().default(30),

    /* ── CORS ──────────────────────────────────────────────────────────── */
    corsAllowedOrigins: csv,

    /* ── Payments ──────────────────────────────────────────────────────── */
    paymentSandboxMode: booleanish,
    razorpayKeyId: z.string().optional(),
    razorpayKeySecret: z.string().optional(),
    /** Distinct from the API secret. Reusing one for the other is a real, common bug. */
    razorpayWebhookSecret: z.string().optional(),

    /* ── Storage ───────────────────────────────────────────────────────── */
    s3Bucket: z.string().min(1),
    s3Region: z.string().min(1),
    /** Set for MinIO locally; unset in production so the AWS default endpoint is used. */
    s3EndpointUrl: z.string().url().optional(),
    s3AccessKeyId: z.string().optional(),
    s3SecretAccessKey: z.string().optional(),

    /* ── Email ─────────────────────────────────────────────────────────── */
    smtpHost: z.string().min(1),
    smtpPort: z.coerce.number().int().positive().default(1025),
    /** The `From` header on every message. */
    mailFrom: z.string().min(1).default('no-reply@localhost'),
    /**
     * Where a password-reset link points.
     *
     * Configuration, never a request field: a client-supplied URL carrying a live reset token
     * would be an open redirect straight into a phishing flow.
     */
    passwordResetUrlBase: z.string().url().default('http://localhost:3000/reset-password'),

    /* ── Behaviour ─────────────────────────────────────────────────────── */
    /**
     * Deployment-wide default only. The per-store currency lives in `store.currency`;
     * anything a merchant would change belongs in `store_setting`, not here.
     */
    defaultCurrency: z.enum(['INR', 'USD', 'EUR', 'GBP', 'AED', 'JPY']).default('INR'),
    /**
     * Slug of the store every request resolves to while the platform is single-store.
     *
     * A slug rather than a UUID on purpose: it is stable across environments, so the same
     * value works in local dev, CI, and staging without per-environment id juggling, and
     * `store.slug` already carries a unique index. Phase 2 replaces this resolver with
     * domain matching; nothing outside the resolver reads this value.
     */
    defaultStoreSlug: z.string().trim().min(1).max(255).default('default'),

    /* ── Authentication rate limits ────────────────────────────────────── */

    /**
     * Configurable rather than hard-coded, because the right numbers are not knowable from
     * a desk. Phase 8 load testing calibrates them against real traffic shape — a mobile
     * client that retries on a flaky connection, or an office behind one NAT gateway, both
     * change what "abusive" means — and that recalibration must not require a code change.
     *
     * The defaults are deliberately generous enough for a human and far too tight for a
     * script: a person mistyping a password four times is normal, four hundred attempts is
     * not.
     */
    authRateLimitWindowSeconds: z.coerce.number().int().positive().max(3_600).default(60),
    /** Every login/register attempt from one address. Caps Argon2 CPU. */
    authRateLimitIpMax: z.coerce.number().int().positive().default(10),
    /** FAILED authentications per address per store. Caps guesses at one account. */
    authRateLimitEmailMax: z.coerce.number().int().positive().default(5),

    /**
     * Refresh attempts per IP per window. Deliberately MUCH higher than the login limit.
     *
     * Refresh is a scheduled background call, not a human action: every active client wakes up
     * every ~15 minutes to rotate, so an office or a mobile carrier behind one NAT address
     * legitimately produces far more refreshes than logins. Setting this to the login limit
     * would break the largest customers first and present as a random logout.
     */
    authRateLimitRefreshIpMax: z.coerce.number().int().positive().default(60),

    reservationTtlMinutes: z.coerce.number().int().positive().default(15),
    outboxPollIntervalMs: z.coerce.number().int().positive().default(1_000),
    outboxBatchSize: z.coerce.number().int().positive().max(1_000).default(100),

    /* ── Payment expiry (Increment 36) ─────────────────────────────────── */

    /**
     * How long an ONLINE payment stays payable, in minutes. Approved at 30.
     *
     * Stamped onto `payment.expires_at` at initiation and never recomputed, so changing this
     * affects only payments started afterwards — a payment in flight keeps the window the
     * customer was given. Positive integer only: a zero or negative window would expire a
     * payment the instant it was created.
     *
     * COD is out of scope by decision — `expires_at` stays NULL there.
     */
    paymentExpiryMinutes: z.coerce.number().int().positive().default(30),

    /**
     * How often the leader-elected sweeper looks for due payments. Approved at 60_000 ms.
     *
     * This bounds how long stock stays held past its window: worst case is the window plus one
     * cadence. It is not the window itself, and making it shorter does not expire anything
     * sooner than `expires_at` allows.
     */
    paymentExpirySweepIntervalMs: z.coerce.number().int().positive().default(60_000),

    /**
     * How many due payments one sweep pass may claim.
     *
     * Bounded because each candidate takes an `order` and a `payment` row lock, and an
     * unbounded batch on a backlog would contend with live checkouts for as long as it ran.
     * A backlog larger than this is simply drained over several passes.
     */
    paymentExpirySweepBatchSize: z.coerce.number().int().positive().max(1_000).default(100),

    /* ── Observability ─────────────────────────────────────────────────── */
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    logFormat: z.enum(['json', 'pretty']).default('json'),
    sentryDsn: z.string().url().optional(),
  })
  .superRefine((cfg, ctx) => {
    const issue = (message: string, path: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [path] });
    };

    // Guards that only apply where real money and real customers are involved.
    if (cfg.environment !== 'production') return;

    if (cfg.paymentSandboxMode) {
      issue('must be false in production', 'PAYMENT_SANDBOX_MODE');
    }
    if (cfg.corsAllowedOrigins.includes('*')) {
      issue('must not include "*" in production', 'CORS_ALLOWED_ORIGINS');
    }
    if (cfg.corsAllowedOrigins.length === 0) {
      issue('must list at least one origin in production', 'CORS_ALLOWED_ORIGINS');
    }
    if (!cfg.databaseReplicaUrl) {
      issue('a read replica is required in production', 'DATABASE_REPLICA_URL');
    }
    if (cfg.logFormat !== 'json') {
      issue('must be "json" in production so logs are parseable', 'LOG_FORMAT');
    }
    if (!cfg.sentryDsn) {
      issue('error reporting is required in production', 'SENTRY_DSN');
    }
    // Three separate Redis endpoints, because the lock DB must run `noeviction`.
    // Sharing one means an eviction storm can drop idempotency keys or queued jobs.
    const redis = new Set([cfg.redisCacheUrl, cfg.redisLockUrl, cfg.redisQueueUrl]);
    if (redis.size !== 3) {
      issue(
        'cache, lock, and queue Redis endpoints must be distinct in production',
        'REDIS_LOCK_URL',
      );
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

/** Explicit mapping. See rule 3 above — do not replace this with a spread. */
function readEnvironment(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    nodeEnv: env['NODE_ENV'],
    environment: env['ENVIRONMENT'],
    port: env['PORT'],

    databaseUrl: env['DATABASE_URL'],
    databaseReplicaUrl: env['DATABASE_REPLICA_URL'],
    databasePoolMax: env['DATABASE_POOL_MAX'],
    databaseStatementTimeoutMs: env['DATABASE_STATEMENT_TIMEOUT_MS'],

    redisCacheUrl: env['REDIS_CACHE_URL'],
    redisLockUrl: env['REDIS_LOCK_URL'],
    redisQueueUrl: env['REDIS_QUEUE_URL'],

    jwtPrivateKey: env['JWT_PRIVATE_KEY'],
    jwtPublicKey: env['JWT_PUBLIC_KEY'],
    jwtIssuer: env['JWT_ISSUER'],
    jwtAudience: env['JWT_AUDIENCE'],
    jwtAccessTtlMinutes: env['JWT_ACCESS_TTL_MINUTES'],
    jwtRefreshTtlDays: env['JWT_REFRESH_TTL_DAYS'],

    corsAllowedOrigins: env['CORS_ALLOWED_ORIGINS'],

    paymentSandboxMode: env['PAYMENT_SANDBOX_MODE'],
    razorpayKeyId: env['RAZORPAY_KEY_ID'],
    razorpayKeySecret: env['RAZORPAY_KEY_SECRET'],
    razorpayWebhookSecret: env['RAZORPAY_WEBHOOK_SECRET'],

    s3Bucket: env['S3_BUCKET'],
    s3Region: env['S3_REGION'],
    s3EndpointUrl: env['S3_ENDPOINT_URL'],
    s3AccessKeyId: env['S3_ACCESS_KEY_ID'],
    s3SecretAccessKey: env['S3_SECRET_ACCESS_KEY'],

    smtpHost: env['SMTP_HOST'],
    smtpPort: env['SMTP_PORT'],
    mailFrom: env['MAIL_FROM'],
    passwordResetUrlBase: env['PASSWORD_RESET_URL_BASE'],

    defaultCurrency: env['DEFAULT_CURRENCY'],
    defaultStoreSlug: env['DEFAULT_STORE_SLUG'],
    authRateLimitWindowSeconds: env['AUTH_RATE_LIMIT_WINDOW_SECONDS'],
    authRateLimitIpMax: env['AUTH_RATE_LIMIT_IP_MAX'],
    authRateLimitEmailMax: env['AUTH_RATE_LIMIT_EMAIL_MAX'],
    authRateLimitRefreshIpMax: env['AUTH_RATE_LIMIT_REFRESH_IP_MAX'],
    reservationTtlMinutes: env['RESERVATION_TTL_MINUTES'],
    outboxPollIntervalMs: env['OUTBOX_POLL_INTERVAL_MS'],
    outboxBatchSize: env['OUTBOX_BATCH_SIZE'],
    paymentExpiryMinutes: env['PAYMENT_EXPIRY_MINUTES'],
    paymentExpirySweepIntervalMs: env['PAYMENT_EXPIRY_SWEEP_INTERVAL_MS'],
    paymentExpirySweepBatchSize: env['PAYMENT_EXPIRY_SWEEP_BATCH_SIZE'],

    logLevel: env['LOG_LEVEL'],
    logFormat: env['LOG_FORMAT'],
    sentryDsn: env['SENTRY_DSN'],
  };
}

let cached: Config | undefined;

/**
 * Parse and validate configuration. Memoised — the container calls this once at process
 * start, and tests call it repeatedly with `reset` to build fixtures.
 *
 * Crashes the process on failure. That is the intended behaviour: a misconfigured
 * deployment must not start and serve traffic in an unknown state.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const result = ConfigSchema.safeParse(readEnvironment(env));

  if (!result.success) {
    // Report EVERY problem at once. Fixing one variable per restart, five restarts deep,
    // is a genuinely miserable way to spend a deploy window.
    const lines = result.error.issues.map((i) => {
      const key = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `  • ${key}: ${i.message}`;
    });
    // eslint-disable-next-line no-console -- the logger needs config; it does not exist yet.
    console.error(`\nInvalid configuration:\n${lines.join('\n')}\n`);
    process.exit(1);
  }

  cached = result.data;
  return cached;
}

/** Tests only — clears the memo so a fresh environment can be parsed. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** Parse without exiting. Used by config tests to assert the guards actually fire. */
export function parseConfig(env: NodeJS.ProcessEnv): z.ZodSafeParseResult<Config> {
  return ConfigSchema.safeParse(readEnvironment(env));
}
