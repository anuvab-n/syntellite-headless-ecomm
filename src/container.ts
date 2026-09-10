import { Router, type Express } from 'express';
import { Redis } from 'ioredis';

import { loadConfig, type Config } from './config.js';
import { createAuditRepository, createAuditTrail } from './db/audit/index.js';
import { createIdempotencyStore } from './db/idempotency/idempotency.repository.js';
import { checkDatabase, createDatabase, type DatabaseHandle } from './db/client.js';
import {
  createOutboxSubsystem,
  type DrainerOptions,
  type OutboxSubsystem,
  type OutboxTransport,
  type QueueRoutes,
} from './db/outbox/index.js';
import { createApp } from './http/app.js';
import { createPasswordResetMailHandler } from './mail/password-reset.handler.js';
import { createSmtpMailer } from './mail/mailer.js';
import { RATE_LIMIT_BUCKETS } from './http/middleware/rate-limit.js';
import { requireIdempotency } from './http/middleware/idempotency.js';
import { createScopeGuards } from './http/middleware/scope.js';
import { resolveStore } from './http/middleware/store.js';
import { postgresCheck, redisCheck, type HealthCheck } from './http/routes/health.js';
import { waitForRedisReady } from './redis/ready.js';
import {
  createRateLimiter,
  hashRateLimitSubject,
  type RateLimitPolicy,
} from './redis/rate-limiter.js';
import {
  createIdentityRepository,
  createIdentityRoutes,
  createIdentityService,
  createPasswordResetRepository,
  createRefreshSessionRepository,
  createTokenService,
  USER_EVENTS,
  type IdentityService,
} from './modules/identity/index.js';
import {
  createCatalogueRepository,
  createCatalogueRoutes,
  createCatalogueService,
  type CatalogueService,
} from './modules/catalogue/index.js';
import {
  createCartRepository,
  createCartRoutes,
  createCartService,
  type CartService,
} from './modules/cart/index.js';
import {
  createPromotionsRepository,
  createPromotionsRoutes,
  createPromotionsService,
  type PromotionsService,
} from './modules/promotions/index.js';
import {
  createOrdersRepository,
  createOrdersRoutes,
  createOrdersService,
  type OrdersService,
} from './modules/orders/index.js';
import {
  createAddressesRepository,
  createAddressesRoutes,
  createAddressesService,
  type AddressesService,
} from './modules/addresses/index.js';
import {
  createInventoryRepository,
  createInventoryRoutes,
  createInventoryService,
  type InventoryService,
} from './modules/inventory/index.js';
import {
  createFulfilmentRepository,
  createFulfilmentRoutes,
  createFulfilmentService,
  type FulfilmentService,
} from './modules/fulfilment/index.js';
import {
  createReturnsRepository,
  createReturnsRoutes,
  createReturnsService,
  type ReturnsService,
} from './modules/returns/index.js';
import {
  createPaymentsRepository,
  createPaymentsRoutes,
  createPaymentsService,
  createPaymentsWebhookRoutes,
  createPaymentExpirySweeper,
  type PaymentExpirySweeper,
  type PaymentsService,
} from './modules/payments/index.js';
import {
  createTaxRepository,
  createTaxRoutes,
  createTaxService,
  type TaxService,
} from './modules/tax/index.js';
import {
  createInvoicingRepository,
  createInvoicingService,
  type InvoicingService,
} from './modules/invoicing/index.js';
import { createDefaultStoreResolver, createStoreRepository } from './modules/stores/index.js';
import { createRazorpayGateway, createUnconfiguredGateway } from './razorpay/gateway.js';
import type { HandlerRegistry } from './db/outbox/publisher.js';
import { NotFound } from './shared/errors.js';
import type { IdempotencyStore } from './shared/idempotency.js';
import { createLogger, type Logger } from './shared/logger.js';

/**
 * The composition root.
 *
 * This is the ONLY file that knows how the system fits together. Every other module
 * declares what it needs as a function argument and is handed it; nothing reaches out for a
 * dependency. That has three consequences worth stating plainly:
 *
 *  1. **Cycles are compile errors.** The construction order below IS the dependency graph.
 *     `outbox` cannot depend on `app` because `app` is built afterwards and TypeScript will
 *     say so. A runtime DI container would discover that at startup, or hide it behind a
 *     `forwardRef()` and leave the design problem in place.
 *
 *  2. **It is not a service locator.** The container is constructed once and passed to
 *     process entry points. Nothing calls `container.get('thing')` at runtime, and nothing
 *     imports this module to find a dependency — a module that did would be coupled to
 *     every implementation choice made here.
 *
 *  3. **There is no global singleton.** `buildContainer()` returns a value. Tests build
 *     their own against throwaway containers, which is only possible because there is no
 *     module-level instance to collide with.
 *
 * The cost is that adding a dependency means editing this file. That friction is deliberate:
 * it makes the dependency graph a thing people notice changing, and it shows up in the PR
 * diff rather than in a decorator nobody reads.
 *
 * Process signal handling is NOT here. `shutdown()` is a plain method; deciding when to call
 * it, and in what order relative to draining HTTP traffic, is Step 7's job.
 */

/**
 * Which process this container is for.
 *
 * `scheduler` behaves like `api` as far as construction goes — it runs no BullMQ workers —
 * but it is named rather than folded into `api` so logs and future wiring say what the
 * process actually is. Only `worker` consumes jobs.
 */
export type ContainerRole = 'api' | 'worker' | 'scheduler';

export type BuildContainerOptions = {
  /**
   * What this process is for.
   *
   * `api` serves HTTP and drains the outbox but does NOT run job handlers. `worker` runs
   * them. The split matters because Node is single-threaded: a CPU-bound handler running
   * inside the API process stalls every concurrent request, and that failure presents to
   * users as "the site is down" rather than as a slow job.
   */
  role: ContainerRole;
  /**
   * Pre-parsed configuration. Tests pass a `Config` built against throwaway containers;
   * production omits it and `loadConfig()` reads the environment.
   */
  config?: Config;
  /**
   * Event handlers, keyed by event type.
   *
   * Empty at Phase 0 — deliberately. There are no business modules yet, so there is nothing
   * to subscribe. An empty registry is the truthful state; inventing a placeholder handler
   * to make the container look populated would be a lie the next reader has to unpick.
   */
  handlers?: HandlerRegistry;
  /** Overridden by tests that need a fast poll or an in-process transport. */
  transport?: OutboxTransport;
  drainer?: DrainerOptions;
  queueRoutes?: QueueRoutes;
};

/**
 * What process entry points get.
 *
 * Deliberately narrow. Every field here is something an entry point in Step 7 genuinely
 * needs — the HTTP app to serve, the outbox to drain, `shutdown` to close. Internals that
 * only exist to build those (the health check array, the repository) are not re-exported
 * just because they happen to exist.
 */
export type AppContainer = {
  config: Config;
  logger: Logger;
  /** Primary. Every write, and every read inside a transaction. */
  db: DatabaseHandle;
  /**
   * Replica-safe reads. Points at the SAME handle as `db` when no replica is configured,
   * rather than opening a second pool to the same server — which would double the
   * connection count for no benefit. Selectors will use this from Phase 1.
   */
  replica: DatabaseHandle;
  /**
   * The lock/coordination Redis: idempotency keys, rate-limit counters, distributed locks.
   *
   * Must run `noeviction` in production. Losing a key here is not a cache miss — it is a
   * duplicate charge, which is why the readiness probe treats it as required and the
   * degradation policy fails closed on it.
   */
  locks: Redis;
  outbox: OutboxSubsystem;
  /**
   * The idempotency key store.
   *
   * Exposed so the route that eventually needs it can be handed the middleware from here,
   * and so integration tests can assert on claims without reaching into db/.
   */
  idempotency: IdempotencyStore;
  /**
   * The identity module's write API.
   *
   * Exposed because a CLI command (creating the first admin) and integration tests both
   * need to register a user without going through HTTP. Repositories stay unexported — a
   * caller that wants a user asks the service.
   */
  identity: IdentityService;
  /**
   * The catalogue module write API.
   *
   * Exposed for the same reason as `identity`: a seed script or an integration test needs to
   * create a product without going through HTTP.
   */
  catalogue: CatalogueService;
  /**
   * The inventory module write API.
   *
   * Exposed for the same reason as `catalogue`: an integration test or a future operator
   * script needs to adjust stock without going through HTTP — and doing so still goes through
   * the atomic statement and the same transaction, because those live in the service.
   */
  inventory: InventoryService;
  /**
   * The addresses module write API.
   *
   * Exposed for the same reason as `catalogue`: an integration test or a future operator
   * script needs to manage an address without going through HTTP.
   */
  addresses: AddressesService;
  /**
   * The cart module write API.
   *
   * Exposed for the same reason as `addresses`: an integration test or a future operator script
   * needs to inspect or adjust a cart without going through HTTP.
   */
  cart: CartService;
  /**
   * The promotions module API.
   *
   * Exposed for the same reason as the others: a future CLI or job may need to configure or
   * price a promotion without going through HTTP.
   */
  promotions: PromotionsService;
  /**
   * The orders module API.
   *
   * Exposed for the same reason as the others: an integration test or a future operator tool
   * needs to place or read an order without going through HTTP.
   */
  orders: OrdersService;
  /**
   * The payments module API.
   *
   * Exposed for the same reason as the others: an integration test drives initiation and
   * webhook processing directly, and a future operator tool may need to read a payment without
   * going through HTTP.
   */
  payments: PaymentsService;
  /**
   * The payment expiry sweeper. One pass per call; the scheduler owns cadence and leadership.
   *
   * Exposed on the container because the SCHEDULER entry point needs it, and only that. It is
   * safe to build in every role — constructing it starts nothing.
   */
  paymentExpirySweeper: PaymentExpirySweeper;
  /**
   * The returns module.
   *
   * Exposed for the same reason as the others: an integration test drives a return without
   * going through HTTP, and a future operator tool will need it.
   */
  returns: ReturnsService;
  /**
   * Manual fulfilment: raising a shipment, shipping it, recording delivery.
   *
   * The fourth state space. It never writes `order.status` and never writes a payment row.
   */
  fulfilment: FulfilmentService;
  /**
   * GST: tax classes, effective-dated rates, seller and customer tax identity, and the
   * checkout determination.
   *
   * The one place a tax figure is computed. Every other module receives one already resolved.
   */
  tax: TaxService;
  /**
   * Statutory invoice issuance: the FY-scoped numbering series and the issued invoice.
   *
   * Exposed for completeness and for operator reconciliation. It mounts NO routes of its own —
   * the invoice document is served by the two existing orders routes, and issuance happens
   * inside checkout.
   */
  invoicing: InvoicingService;
  /**
   * Authorization guards for privileged routes.
   *
   * Exposed so a Phase 2 admin router can be handed them without rebuilding the loader, and
   * so exactly one place decides where authorization state is read from.
   */
  scopeGuards: ReturnType<typeof createScopeGuards>;
  app: Express;
  /**
   * Prove lazily-initialised dependencies actually work, before serving traffic.
   *
   * Today that means importing the JWT keypair: config validates PEM *shape* synchronously,
   * but only an import proves the key material is usable. Without this a deployment with a
   * well-formed-but-broken key starts cleanly and fails at the first customer login.
   *
   * A container METHOD rather than an exposed token service: entry points need the
   * capability, not the dependency. Later increments can warm a cache or a gateway client
   * here without changing a single call site.
   */
  warmUp: () => Promise<void>;
  /** Idempotent. Closes everything this container owns, in reverse dependency order. */
  shutdown: () => Promise<void>;
};

/**
 * Ceiling on how long a readiness probe waits for the lock client to connect. Comfortably
 * under the health route's own 2s per-check timeout, so this produces a definite answer
 * rather than letting the route time out with no reason recorded.
 */
const READINESS_WAIT_MS = 1_500;

/**
 * The lock client's connection options.
 *
 * `enableOfflineQueue: false` is the load-bearing one. By default ioredis QUEUES commands
 * while disconnected and replays them on reconnect — so an idempotency-key write issued
 * during a Redis outage appears to succeed and silently lands seconds later, after the
 * decision that depended on it was already made. With the queue disabled the command fails
 * immediately, which is what "fail closed on anything touching money" requires.
 */
const LOCK_CLIENT_OPTIONS = {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
  enableReadyCheck: true,
  connectTimeout: 5_000,
} as const;

export function buildContainer(opts: BuildContainerOptions): AppContainer {
  /* ── 1. Configuration ────────────────────────────────────────────────── */

  // Parsed first and exactly once. It validates itself and exits the process on a bad
  // value, so nothing below has to defend against a missing variable.
  const config = opts.config ?? loadConfig();

  /* ── 2. Logging ──────────────────────────────────────────────────────── */

  // Before any resource, so a connection failure is logged rather than thrown into a void.
  const logger = createLogger(config);

  /* ── 3. Database ─────────────────────────────────────────────────────── */

  const db = createDatabase(config.databaseUrl, config, logger, 'primary');

  /**
   * A distinct replica URL, or undefined when reads should go to the primary.
   *
   * The equality check matters: `.env.example` sets the replica to the same URL locally, and
   * building a second pool to the same server would double the connection count while
   * proving nothing.
   */
  const replicaUrl =
    config.databaseReplicaUrl !== undefined && config.databaseReplicaUrl !== config.databaseUrl
      ? config.databaseReplicaUrl
      : undefined;

  const replica =
    replicaUrl !== undefined ? createDatabase(replicaUrl, config, logger, 'replica') : db;

  /* ── 4. Redis ────────────────────────────────────────────────────────── */

  /**
   * Only the LOCK client is created here.
   *
   * The queue client is not: `createOutboxSubsystem` builds and owns its own BullMQ
   * connections, and it closes them in its `shutdown()`. Creating a second one here would
   * mean two owners for one resource and an ambiguous shutdown order.
   *
   * The CACHE client is not created either, because nothing consumes it yet. An idle
   * connection that exists only to make the container look complete is a placeholder, and
   * it would also make the readiness probe report on a dependency no code path uses.
   * Phase 1 adds it alongside the first selector that caches.
   */
  const locks = new Redis(config.redisLockUrl, LOCK_CLIENT_OPTIONS);

  /**
   * Required: an unhandled 'error' event on an ioredis client is an unhandled exception and
   * takes the process down. A Redis outage must degrade readiness, not kill the API.
   */
  locks.on('error', (err) => {
    logger.error({ err, client: 'locks' }, 'redis_client_error');
  });

  /* ── 5/6. Outbox and queue infrastructure ────────────────────────────── */

  /**
   * Reuses the Step 4 subsystem verbatim. There is exactly one event system in this
   * codebase; a second would mean two answers to "did this event get delivered".
   *
   * `runWorkers` is keyed off the role, which is the single decision that separates an API
   * container from a worker container.
   */
  /**
   * The mailer, and the handler registry it populates.
   *
   * **This is where the "no consumers" era ends.** Every increment up to now passed `{}`, on the
   * rule that an event with no consumer is a guess at one. `user.password_reset_requested` is
   * the first event whose consumer is not optional: a reset token nobody mails leaves a
   * customer locked out, so the producer and the consumer ship together.
   *
   * Built here rather than required from an entry point, so `main.ts` and the workers do not
   * each have to remember to wire it. A caller may still override `handlers` — the integration
   * tests do, to assert on delivery without SMTP.
   */
  const mailer = createSmtpMailer({
    config: {
      host: config.smtpHost,
      port: config.smtpPort,
      from: config.mailFrom,
      user: config.smtpUser,
      password: config.smtpPassword,
      secure: config.smtpSecure,
    },
    logger,
  });

  const builtInHandlers: HandlerRegistry = {
    [USER_EVENTS.passwordResetRequested]: [
      createPasswordResetMailHandler({
        mailer,
        config: {
          resetUrlBase: config.passwordResetUrlBase,
          storeName: config.defaultStoreSlug,
        },
        logger,
      }),
    ],
  };

  const outbox = createOutboxSubsystem({
    db: db.db,
    logger,
    handlers: opts.handlers ?? builtInHandlers,
    /**
     * 'in-process' by default — no BullMQ, no queue Redis database.
     *
     * The worker process still polls `outbox_event` and runs handlers itself (see
     * `workers/default.ts`, which calls `outbox.drainer.start()`); it simply does not hand
     * the job to a second Redis-backed queue to do it. Redis stays in the picture only for
     * what nothing else can do without it — locks (`redisLockUrl`) and, through the same
     * client, auth rate limiting.
     *
     * A deployment that later needs handlers to scale independently of the drain loop can
     * still opt back in explicitly with `buildContainer({ transport: 'queue' })`; nothing
     * about the 'queue' path (`queues.ts`, `workers/default.ts`'s BullMQ branch) was removed,
     * only its default.
     */
    transport: opts.transport ?? 'in-process',
    redisUrl: config.redisQueueUrl,
    runWorkers: opts.role === 'worker',
    ...(opts.drainer ? { drainer: opts.drainer } : {}),
    ...(opts.queueRoutes ? { queueRoutes: opts.queueRoutes } : {}),
  });

  /**
   * The audit trail.
   *
   * Built here beside the outbox because it is the same kind of thing: cross-cutting,
   * append-only infrastructure that every domain module writes through. Both are handed to
   * services as ports, so a service can be constructed in a test with a recording double and
   * no database at all.
   */
  const audit = createAuditTrail({
    repository: createAuditRepository({ db: db.db }),
    logger,
  });

  /**
   * The idempotency key store.
   *
   * Built here beside the outbox and the audit trail, for the same reason: cross-cutting
   * infrastructure that any endpoint may use, owned by no domain module.
   *
   * Mounted on `POST /users/me/checkout` by Increment 30 — the endpoint it was built for, and
   * still the only one. A duplicate checkout is the failure it exists to prevent.
   *
   * The key identity now includes the authenticated USER, which is why the middleware is mounted
   * after `requireAuth` rather than before it: with the scope at (store, key, endpoint) alone,
   * two customers using the same header value collided, and identical payloads served the second
   * one the first one's order.
   */
  const idempotency = createIdempotencyStore({ db: db.db, logger });

  /* ── 7. Health probes ────────────────────────────────────────────────── */

  /**
   * Probes are passed as closures, which is why `http/routes/health.ts` has no import from
   * `db/` or `ioredis`. The HTTP layer knows it has "a thing that resolves or rejects"; the
   * wiring lives here, in the one file whose job is wiring.
   *
   * The probe hits the PRIMARY. A replica-only check would report ready while writes are
   * failing, which is the wrong way round: reads degrade gracefully, writes do not.
   */
  /**
   * Waits for the lock client to be connected, then pings it.
   *
   * The wait is necessary, not defensive. `enableOfflineQueue: false` makes a command throw
   * IMMEDIATELY when the socket is not writeable — which is the correct behaviour for an
   * idempotency write, and the wrong behaviour for a probe fired microseconds after the
   * process started and before the TCP handshake finished. Pinging directly makes a
   * perfectly healthy instance report 503 at boot, intermittently, depending on how fast
   * Redis answered.
   *
   * There is no timeout here on purpose: the health route already bounds every check at 2s.
   * Adding a second timeout would mean two numbers to keep consistent. If the client is in
   * a terminal state ('end') or genuinely cannot connect, 'ready' never fires and the route's
   * timeout produces the 503 — which is the right answer either way.
   */
  async function pingLocks(): Promise<void> {
    /**
     * Bounded wait, not `events.once(locks, 'ready')`.
     *
     * `once()` never settles against a CLOSED client — neither 'ready' nor 'error' is ever
     * emitted from that state — so it leaked one listener per probe, measurably growing
     * 1 → 2 → 3, while the route's timeout silently absorbed each failure. It self-cleans
     * against a merely-unreachable client (ioredis emits 'error' per reconnect, which
     * rejects it), which is what kept the leak hidden in the common case.
     */
    await waitForRedisReady(locks, READINESS_WAIT_MS);
    // Annotated as `string`, not inferred: ioredis types `ping()` as returning the literal
    // 'PONG', so the comparison below narrows the value to `never` and the template
    // literal becomes untypeable. Widening keeps the guard meaningful at runtime, which is
    // where an unexpected reply would actually show up.
    const reply: string = await locks.ping();
    if (reply !== 'PONG') throw new Error(`unexpected PING reply: ${reply}`);
  }

  const healthChecks: readonly HealthCheck[] = [
    postgresCheck(() => checkDatabase(db)),
    redisCheck(pingLocks),
  ];

  /* ── 8. Domain modules ───────────────────────────────────────────────── */

  /**
   * Constructed in dependency order, and that order IS the graph: `stores` before the
   * resolver that reads it, `identity` before the router that calls it. A cycle would be a
   * compile error rather than something discovered at boot.
   *
   * Repositories take `db` (the primary) rather than `replica`, because both modules here
   * are on write paths. Read-heavy selectors move to `replica` when Phase 2 adds them.
   */
  const stores = createStoreRepository({ db: db.db });
  const identityRepository = createIdentityRepository({ db: db.db });
  const refreshSessions = createRefreshSessionRepository({ db: db.db });

  /**
   * The access-token service.
   *
   * Constructed here for the first time — increment 2 built it and deliberately left it
   * unwired rather than injecting a dependency nothing used. Login is its first consumer.
   *
   * Key IMPORT is lazy inside the service, so this stays synchronous and `buildContainer()`
   * does not become async. `warmUp()` below is what proves the keys usable, and the API
   * entry point awaits it before binding a port.
   */
  const tokens = createTokenService({ config, logger });

  /**
   * Scope guards, bound to a loader that reads authorization state from the PRIMARY database.
   *
   * Not the replica, deliberately. A demotion must take effect on the very next scoped
   * request, and replica lag would leave a revoked administrator privileged for however long
   * replication happens to be behind — exactly the staleness this design exists to eliminate.
   *
   * Reuses `findSubjectById`, so no new query and no new repository method. The narrow port
   * means the HTTP layer never learns which module owns users.
   *
   * No route consumes these yet: the authenticated endpoints today are logout and `/users/me`,
   * and neither gates on a privilege. Phase 2 catalogue writes are the first real consumer.
   */
  const scopeGuards = createScopeGuards({
    loadSubject: async ({ storeId, userId }) =>
      identityRepository.findSubjectById({ storeId, userId }),
    logger,
  });

  /**
   * Rate limiting, on the LOCK Redis client.
   *
   * Not the cache client, and the distinction matters. The cache database is the one that
   * would be configured with an eviction policy, and an evicted rate-limit counter is a reset
   * budget — an attacker could fill the cache with junk to flush their own block. The lock
   * database holds correctness-critical keys that must expire only on their own TTL.
   *
   * It also already has the right client options for this job: `enableOfflineQueue: false`, so
   * a command issued while disconnected throws immediately instead of queueing up requests
   * behind a dead socket, which is what makes failing closed fast rather than slow.
   */
  const rateLimiter = createRateLimiter({ redis: locks, logger });

  const ipPolicy: RateLimitPolicy = {
    max: config.authRateLimitIpMax,
    windowSeconds: config.authRateLimitWindowSeconds,
  };
  const emailPolicy: RateLimitPolicy = {
    max: config.authRateLimitEmailMax,
    windowSeconds: config.authRateLimitWindowSeconds,
  };
  const refreshPolicy: RateLimitPolicy = {
    max: config.authRateLimitRefreshIpMax,
    windowSeconds: config.authRateLimitWindowSeconds,
  };

  const identity = createIdentityService({
    repository: identityRepository,
    sessions: refreshSessions,
    passwordResets: createPasswordResetRepository({ db: db.db }),
    tokens,
    // The service opens its own transaction for the login writes, so it needs the primary
    // handle rather than a repository-scoped executor.
    db: db.db,
    config,
    logger,
    /**
     * The adapter between the domain port and the Redis limiter.
     *
     * Hashing happens HERE rather than in the service, and it uses the same
     * `hashRateLimitSubject(storeId, email)` shape as the middleware. That is not incidental:
     * if these two disagreed by so much as an argument order, the middleware would check a key
     * the service never increments and the limit would silently never fire — a security
     * control that looks wired and does nothing. The shared helper is the only reason they
     * cannot drift.
     */
    events: outbox.events,
    audit,
    loginAttempts: {
      async recordFailure({ storeId, email }) {
        await rateLimiter.record(
          RATE_LIMIT_BUCKETS.loginEmail,
          hashRateLimitSubject(storeId, email),
          emailPolicy,
        );
      },
      async clear({ storeId, email }) {
        await rateLimiter.reset(
          RATE_LIMIT_BUCKETS.loginEmail,
          hashRateLimitSubject(storeId, email),
        );
      },
    },
  });

  /**
   * The catalogue module.
   *
   * Constructed after identity because its router needs the token verifier and the staff
   * guard, both of which are built above. That ordering IS the dependency graph — a cycle
   * would be a compile error here rather than a surprise at boot.
   */
  const catalogue = createCatalogueService({
    repository: createCatalogueRepository({ db: db.db }),
    // Every mutation now wraps its write, its event, and its audit entry in one transaction,
    // so the service needs the primary handle.
    db: db.db,
    events: outbox.events,
    audit,
    logger,
  });

  /**
   * The inventory module.
   *
   * Constructed after the catalogue only for readability — it has no dependency on it. The two
   * communicate through nothing at all: inventory reaches SKU rows through its own repository
   * (legal under `schema-only-in-repositories`, which permits any repository to name any
   * table), and `no-cross-module-imports` forbids either from importing the other.
   *
   * Takes the primary handle for the same reason the catalogue does: every adjustment wraps its
   * atomic stock update, its ledger entry, its event and its audit record in one transaction.
   */
  const inventory = createInventoryService({
    repository: createInventoryRepository({ db: db.db }),
    db: db.db,
    events: outbox.events,
    audit,
    logger,
  });

  /**
   * The addresses module.
   *
   * No `events` dependency, deliberately: nothing consumes an address change, and Increment 26
   * established that an event with no consumer is a guess at one. It takes `audit` and the
   * primary handle, because every mutation wraps its write and its audit entry in one
   * transaction.
   *
   * No dependency on identity either. Ownership arrives from the verified token at the route,
   * and the composite foreign key `(user_id, store_id) -> app_user(id, store_id)` enforces it
   * in the database — so `no-cross-module-imports` costs nothing here.
   */
  const addresses = createAddressesService({
    repository: createAddressesRepository({ db: db.db }),
    db: db.db,
    audit,
    logger,
  });

  /**
   * The promotions module.
   *
   * Takes `audit` because STAFF configuration changes are privileged: a coupon changes what
   * every customer pays, so who created or edited one is worth recording. It takes no `events`
   * — nothing consumes a promotion change, the handler registry is empty, and §39 established
   * that an event with no consumer is a guess at one.
   *
   * Constructed BEFORE the cart, because the cart depends on it. That ordering is the whole
   * benefit of a manual composition root: the dependency is a value, so a cycle would be a
   * compile error here rather than a runtime `forwardRef()` workaround (§3 #12).
   */
  const promotions = createPromotionsService({
    repository: createPromotionsRepository({ db: db.db }),
    db: db.db,
    audit,
    logger,
  });

  /**
   * The tax module.
   *
   * Takes `audit` for the same reason promotions does, only more so: a rate change alters what
   * every customer of the store pays, and the seller tax profile is the switch that decides
   * whether GST is charged at all. It takes no `events` — nothing consumes a tax change, the
   * handler registry is still empty, and §39's rule holds.
   *
   * Constructed BEFORE orders, because orders depends on it through the `CheckoutTax` port it
   * declares. A direct reference rather than a late binding: tax depends on nothing here, so
   * there is no cycle to defer.
   *
   * It takes the primary handle because `determineForCheckout` runs inside the checkout
   * transaction and must see that transaction's snapshot.
   */
  const tax = createTaxService({
    repository: createTaxRepository({ db: db.db }),
    db: db.db,
    audit,
    logger,
  });

  /**
   * The cart module.
   *
   * No `events` and no `audit`, deliberately: nothing consumes a cart change, and a customer
   * adjusting their own basket is neither privileged nor security-relevant — an audit row per
   * quantity tweak would bury the entries that matter. Applying a coupon is exactly such an
   * act; the staff member who CREATED that coupon is audited by the promotions module instead.
   *
   * It takes the primary handle because every mutation writes. Exactly one needs a transaction
   * — clearing a cart removes the lines and the applied promotion together — and the composite
   * create-if-absent-then-read is deliberately NOT transactional; see the service.
   *
   * No dependency on catalogue or inventory. The cart's own repository reads `sku` and
   * `product` directly, which `schema-only-in-repositories` permits, and the composite foreign
   * keys enforce tenancy in the database.
   *
   * ## The promotions port, adapted here
   *
   * `no-cross-module-imports` forbids `modules/cart` from importing `modules/promotions`, and
   * forbids the reverse just as firmly. So the CART declares `CartPromotions` and this object
   * adapts the promotions service onto it — the same pattern `verifyAccessToken` uses for
   * identity. TypeScript's structural typing means neither module names the other, and
   * `depcruise` sees only two edges, both from the composition root.
   *
   * The adapter is deliberately thin: it forwards, and it narrows the promotions surface to the
   * two operations a cart legitimately needs. No promotion configuration rule, and no way to
   * enumerate coupons, can reach the cart through it.
   */
  const cart = createCartService({
    repository: createCartRepository({ db: db.db }),
    promotions: {
      findApplicable: (input) => promotions.findApplicable(input),
      evaluateApplied: (input) => promotions.evaluateApplied(input),
    },
    db: db.db,
    logger,
  });

  /**
   * The orders module.
   *
   * Constructed after cart and promotions, because it depends on both — through ports IT
   * declares, adapted here. That ordering is the benefit of a manual composition root: the
   * dependency is a value, so a cycle would be a compile error in this file rather than a
   * runtime `forwardRef()` workaround (§3 #12).
   *
   * Takes `audit` because placing an order is the most consequential act a customer performs
   * and is money-bearing. It takes NO `events`: nothing consumes `order.placed`, the handler
   * registry is empty, and §39's rule — an event with no consumer is a guess at one — applies
   * most strongly to the event that looks most obviously worth having.
   *
   * ## Three ports, three adapters
   *
   * Each is thin on purpose: it forwards, and it narrows the provider's surface to exactly what
   * checkout may do. Orders cannot resolve a coupon code, list promotions, mutate a cart line,
   * or claim an idempotency key — none of those reach it through these objects.
   */
  /**
   * The invoicing module.
   *
   * Takes `audit` because allocating a statutory number is a recordable act — "which order took
   * number 000042, and when" must be answerable without reading the invoice table. It takes no
   * `events`: nothing consumes `invoice.issued`, the handler registry is still empty, and
   * §39's rule holds for the eleventh increment.
   *
   * Constructed BEFORE orders, because orders depends on it through the `OrderInvoicing` port it
   * declares. A direct reference rather than a late binding: invoicing depends on nothing here.
   *
   * It takes the primary handle because `issueForOrder` runs inside the checkout transaction —
   * and it is the rollback of that transaction that keeps the series gapless.
   */
  const invoicing = createInvoicingService({
    repository: createInvoicingRepository({ db: db.db }),
    db: db.db,
    audit,
    logger,
  });

  const orders = createOrdersService({
    repository: createOrdersRepository({ db: db.db }),
    cart: {
      lockCartForCheckout: (input) => cart.lockCartForCheckout(input),
      markCheckedOut: (input) => cart.markCheckedOut(input),
    },
    promotions: {
      evaluateApplied: (input) => promotions.evaluateApplied(input),
    },
    /**
     * Completion only. Orders cannot claim or release a key — the middleware owns those, and
     * handing the service a claim capability would let it invent its own key space.
     */
    idempotency: {
      complete: (input) =>
        idempotency.complete({
          storeId: input.storeId,
          userId: input.userId,
          key: input.key,
          endpoint: input.endpoint,
          status: input.status,
          ...(input.body === undefined ? {} : { body: input.body as never }),
        }),
    },
    /**
     * The payment state of an order, for the cancellation rule.
     *
     * A LATE binding, and it has to be: `payments` is constructed below and needs `orders`
     * through its own port, so the two services are mutually dependent. The arrow defers the
     * lookup to call time, which is the only shape that lets both stay ignorant of each other —
     * an eager reference here would be a `TypeError` at construction and a cycle
     * `dependency-cruiser` would rightly reject.
     *
     * Orders asks for a status and a method; payments answers with both. Neither names the
     * other.
     */
    payments: {
      stateForOrder: (input) => payments.stateForOrder(input),
    },
    /**
     * Inventory, adapted to the reservation port orders declared.
     *
     * Not a late binding: `inventory` is constructed above and depends on nothing here, so
     * these can be direct references. Only two operations are handed over — checkout holds
     * stock and cancellation gives it back. Orders cannot read a stock level, cannot adjust
     * one, and cannot commit a reservation: committing is caused by a payment succeeding, and
     * that capability belongs to the payments wiring below.
     */
    reservations: {
      reserve: (input) => inventory.reserveForOrder(input),
      releaseForOrder: (input) => inventory.releaseForOrder(input),
    },
    /**
     * Tax, adapted to the port orders declared.
     *
     * Not a late binding: `tax` is constructed above and depends on nothing here.
     *
     * **One operation, and it is the narrowest port in this file.** Orders cannot read a rate,
     * list tax classes, classify a SKU, reach the seller's profile, or set a supply type — none
     * of those exist on this object. It hands over line money it computed and a destination
     * state it snapshotted, and receives a determination it writes verbatim. That asymmetry is
     * the point: the only module that can produce a tax figure is the one that owns the rules.
     */
    tax: {
      determineForCheckout: (input) => tax.determineForCheckout(input),
    },
    /**
     * Invoicing, adapted to the port orders declared.
     *
     * Not a late binding: `invoicing` is constructed above and depends on nothing here.
     *
     * Two operations, and the asymmetry is deliberate. `issueForOrder` allocates a number and is
     * reachable only from inside the checkout transaction; `findForOrder` is a read for the
     * document routes. Orders cannot renumber, cannot delete an invoice, and cannot read the
     * series counter through this object — the numbering scheme stays the property of one module.
     */
    invoicing: {
      issueForOrder: (input) => invoicing.issueForOrder(input),
      findForOrder: (input) => invoicing.findForOrder(input),
    },
    /**
     * Whether a shipment blocks cancellation.
     *
     * A LATE binding, and it has to be: `fulfilment` is constructed below and needs `orders`
     * through its own port, so the two are mutually dependent. The arrow defers the lookup to
     * call time, which is the only shape that lets both stay ignorant of each other — the same
     * pattern the `payments` binding above uses, and for the same reason.
     *
     * Orders asks one question and fulfilment answers it. Neither names the other.
     */
    fulfilment: {
      hasBlockingShipment: (input) => fulfilment.hasBlockingShipment(input),
    },
    db: db.db,
    audit,
    logger,
  });

  /**
   * The payment gateway.
   *
   * Razorpay when all three credentials are present, and an adapter that refuses otherwise.
   * They are `.optional()` in `config.ts`, so a deployment without them is a supported state —
   * and one that genuinely cannot take an online payment. **COD is unaffected**, because it
   * never reaches a gateway, so such a deployment still has a working payment method.
   *
   * Deliberately not a fake that fabricates references: a stub returning a plausible order id
   * would let a misconfigured production deployment report success for a charge nobody made.
   *
   * This is the only place in the system that names Razorpay outside `src/razorpay/`. The
   * payments module declares a `PaymentGateway` port and never learns which provider satisfies
   * it.
   */
  const paymentGateway =
    config.razorpayKeyId !== undefined &&
    config.razorpayKeySecret !== undefined &&
    config.razorpayWebhookSecret !== undefined
      ? createRazorpayGateway({
          credentials: {
            keyId: config.razorpayKeyId,
            keySecret: config.razorpayKeySecret,
            webhookSecret: config.razorpayWebhookSecret,
          },
          logger,
        })
      : createUnconfiguredGateway({ logger });

  const payments = createPaymentsService({
    repository: createPaymentsRepository({ db: db.db }),
    /**
     * The orders module, adapted to the port payments declared.
     *
     * Payments cannot import `OrdersService` — `no-cross-module-imports` forbids it — so it
     * asks for a narrow `findPayable` and the composition root supplies one. **The adapter is
     * where ownership and tenancy are enforced**: `getOrder` is already scoped by user and
     * store and answers `NotFound` for anything else, and that is translated to `null` here so
     * the port keeps its "absent or not yours are the same thing" contract.
     *
     * Only the five fields the port asks for are passed on. Handing over the whole `OrderView`
     * would couple payments to the shape of another module's read model, and would put an
     * order's delivery address inside the payment domain for no reason.
     */
    orders: {
      findPayable: async (input) => {
        try {
          const view = await orders.getOrder({
            userId: input.userId,
            storeId: input.storeId,
            orderNumber: input.orderNumber,
          });
          return {
            id: view.order.id,
            orderNumber: view.order.orderNumber,
            status: view.order.status,
            currency: view.order.currency,
            /*
             * **`grandTotal`, not `total` — Increment 38.** The goods total is not what a
             * customer pays once GST applies. The port names the field `payableTotal` so the
             * two cannot be confused at either end, and `ck_order_grand_total_identity`
             * guarantees they are equal for an order that carried no determination.
             */
            payableTotal: view.order.grandTotal,
          };
        } catch (err) {
          if (err instanceof NotFound) return null;
          throw err;
        }
      },
      /**
       * The ORDER row lock, for the expiry sweeper only.
       *
       * Store-scoped and not user-scoped, because the sweeper is the system acting on an order
       * it reached through a payment row — and the store comes from that row, never from input.
       * This is what lets payments take the order lock BEFORE the payment lock, which is the
       * whole reason expiry serialises with cancellation.
       */
      lockForExpiry: (input) => orders.lockOrderForExpiry(input),
    },
    gateway: paymentGateway,
    /**
     * Completion only, exactly as orders receives it. Payments cannot claim or release a key —
     * the middleware owns those, and handing the service a claim capability would let it invent
     * its own key space, which the approved scope forbids.
     */
    idempotency: {
      complete: (input) =>
        idempotency.complete({
          storeId: input.storeId,
          userId: input.userId,
          key: input.key,
          endpoint: input.endpoint,
          status: input.status,
          ...(input.body === undefined ? {} : { body: input.body as never }),
        }),
    },
    /**
     * Inventory, adapted to the settlement port payments declared.
     *
     * Payments gets exactly two verbs and no reserve capability: it can report that an order's
     * payment reached a terminal state, and inventory decides what that means for the units.
     * Both are keyed by order id, because a reservation is owned by the ORDER — it exists
     * before any payment row does.
     *
     * There is deliberately no COD wiring anywhere. A COD payment is created `pending` and no
     * code path in this codebase transitions it, so there is no terminal event to settle
     * against and inventing one would be inventing COD semantics. See `payments.events.ts` and
     * the reservation limitation recorded in `docs/DECISIONS.md`.
     */
    reservations: {
      commitForOrder: (input) => inventory.commitForOrder(input),
      releaseForOrder: (input) => inventory.releaseForOrder(input),
    },
    /**
     * The online expiry window, from validated configuration.
     *
     * The VALUE, not the config object: the service should not know the shape of `Config`, the
     * same reason the mailer receives `resetUrlBase` alone. Zod has already proven it a
     * positive integer, so the service does no validation of its own.
     */
    expiryMinutes: config.paymentExpiryMinutes,
    db: db.db,
    audit,
    logger,
  });

  /**
   * The fulfilment module.
   *
   * Constructed after orders, payments and inventory because it needs all three through
   * ports. There is deliberately no provider adapter and no provider port: fulfilment is
   * manual, so `carrier` and `tracking_number` are text a staff member types. When a carrier
   * integration is chosen it arrives as a port plus an adapter beside `razorpay/`, which is
   * why nothing here is shaped to accommodate one in advance.
   */
  const fulfilment = createFulfilmentService({
    repository: createFulfilmentRepository({ db: db.db }),
    /**
     * The ORDER lock, at the head of the global lock order.
     *
     * Store-scoped and NOT user-scoped: staff act on any order in their store, and there is
     * no customer in the request to scope by. The store comes from the staff token.
     */
    orders: {
      lockByNumber: (input) => orders.lockForFulfilmentByNumber(input),
      lockById: (input) => orders.lockForFulfilmentById(input),
    },
    /**
     * Payment state, for the fulfilment prerequisite. READ ONLY — the port has no write.
     *
     * This is what lets a COD order ship with its payment still `pending` without any
     * payment write happening: fulfilment learns the method and the status, and decides.
     */
    payments: {
      stateForOrder: (input) => payments.stateForOrder(input),
    },
    /**
     * The physical inventory movement. One operation, and it is the irreversible one.
     */
    inventory: {
      fulfilForOrder: (input) => inventory.fulfilForOrder(input),
    },
    db: db.db,
    audit,
    logger,
  });

  /**
   * The payment expiry sweeper.
   *
   * Built in every role because construction is inert — it opens nothing, schedules nothing and
   * starts no timer. Only the scheduler entry point calls `sweep()`, and only while it holds
   * leadership.
   */
  const paymentExpirySweeper = createPaymentExpirySweeper({
    payments,
    batchSize: config.paymentExpirySweepBatchSize,
    logger,
  });

  /**
   * The store resolution strategy.
   *
   * Single-store by configuration for Phase 1. Replacing this with domain matching later
   * means constructing a different resolver HERE — the middleware, the routes, and the
   * identity service are all written against the resolved store and never learn how it was
   * found.
   */
  const storeResolver = createDefaultStoreResolver({
    repository: stores,
    slug: config.defaultStoreSlug,
    logger,
  });

  /* ── 9. HTTP application ─────────────────────────────────────────────── */

  /**
   * The API router, assembled here rather than in `app.ts`.
   *
   * Two things fall out of composing it at this level:
   *
   *  1. `app.ts` never imports a domain module. It receives a `Router` and mounts it, so the
   *     HTTP layer stays free of business dependencies.
   *  2. `resolveStore` applies to the API surface ONLY. Mounting it globally would make
   *     `/health/ready` require a seeded store, and a fresh deployment could then never
   *     report ready long enough to be seeded — a genuine deadlock.
   */
  /**
   * Returns.
   *
   * Built after `orders` and `fulfilment` because it consumes both — and consumes them as
   * PORTS, because `no-cross-module-imports` forbids the module reaching for either. The two
   * adapters below are the whole coupling.
   *
   * The lock order is stated once, here: **the order row first, then the return row.**
   * Creation takes the order lock and touches no existing return; every state change takes
   * the return lock alone. Nothing takes them in the opposite order, so the two paths cannot
   * deadlock against each other.
   */
  const returns = createReturnsService({
    repository: createReturnsRepository({ db: db.db }),
    /**
     * The ORDER lock plus the frozen lines, adapted from the orders module.
     *
     * The lock is what makes the cumulative return-quantity cap hold: two concurrent returns
     * for the last unit serialise on the order row, so the second reads the first's line.
     */
    orders: {
      lockOwnedOrderForReturn: (input) => orders.lockOwnedOrderForReturn(input),
    },
    /**
     * The delivery instant, adapted from fulfilment.
     *
     * The ONLY source of it. No request body carries a delivery timestamp, which is what
     * stops a customer reopening a closed window by claiming an earlier delivery.
     */
    fulfilment: {
      deliveredAtForOrder: (input) => fulfilment.deliveredAtForOrder(input),
    },
    /* The same store every other module completes its claim against. */
    idempotency: {
      complete: (input) =>
        idempotency.complete({
          storeId: input.storeId,
          userId: input.userId,
          key: input.key,
          endpoint: input.endpoint,
          status: input.status,
          ...(input.body === undefined ? {} : { body: input.body as never }),
        }),
    },
    db: db.db,
    audit,
    logger,
  });

  const apiRouter = Router();
  apiRouter.use(resolveStore({ resolver: storeResolver, logger }));
  apiRouter.use(
    createIdentityRoutes({
      identity,
      // Needed by requireAuth() on the logout route, the first authenticated endpoint.
      tokens,
      logger,
      rateLimit: { limiter: rateLimiter, ipPolicy, emailPolicy, refreshPolicy, logger },
    }),
  );
  apiRouter.use(
    createCartRoutes({
      cart,
      // The same capability every other domain router receives, adapted here for the same
      // reason: the cart must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      logger,
    }),
  );
  apiRouter.use(
    createOrdersRoutes({
      orders,
      // The same capability every other domain router receives, adapted here for the same
      // reason: orders must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      /**
       * The idempotency guard, built here because the store is cross-cutting infrastructure the
       * module must not reach for. Mounted by the ROUTE after `requireAuth`, which is what lets
       * it read the authenticated user for the key scope.
       */
      requireIdempotency: requireIdempotency({ store: idempotency, logger }),
      // For the ONE staff route in this module: the invoice for any order in the store. The
      // guard is built against identity's authorization loader, which orders must not import,
      // so it arrives pre-built exactly as the catalogue's and promotions' do.
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );
  apiRouter.use(
    createReturnsRoutes({
      returns,
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // The staff guard, built against identity's authorization loader.
      requireStaff: scopeGuards.requireScope('staff'),
      /**
       * The idempotency guard, built here because the store is cross-cutting infrastructure
       * the module must not reach for. Mounted by the ROUTE after `requireAuth`, which is
       * what lets it read the authenticated user for the key scope.
       */
      requireIdempotency: requireIdempotency({ store: idempotency, logger }),
      logger,
    }),
  );

  apiRouter.use(
    createFulfilmentRoutes({
      fulfilment,
      // The same capability every other domain router receives, adapted here for the same
      // reason: fulfilment must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // Five of its six routes are staff-only; the customer read uses `auth` alone.
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );
  apiRouter.use(
    createTaxRoutes({
      tax,
      // The same capability every other domain router receives, adapted here for the same
      // reason: tax must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // Six of its nine routes are staff-only; the three customer routes use `auth` alone.
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );
  apiRouter.use(
    createPromotionsRoutes({
      promotions,
      // The same capability every other domain router receives, adapted here for the same
      // reason: promotions must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // Staff-only, every route. The guard is built against identity's authorization loader,
      // which promotions must not import — so it arrives pre-built, like the catalogue's.
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );
  apiRouter.use(
    createAddressesRoutes({
      addresses,
      // The same capability the catalogue and inventory routers receive, adapted here for the
      // same reason: addresses must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // No `requireStaff`: these are customer-owned resources and there is no admin surface.
      logger,
    }),
  );
  apiRouter.use(
    createCatalogueRoutes({
      catalogue,
      /**
       * The identity module's verifier, adapted to the HTTP port here.
       *
       * The catalogue cannot import `TokenService` — `no-cross-module-imports` forbids it, and
       * rightly: a catalogue that knows which module mints tokens is coupled to identity's
       * lifecycle. The composition root is the one place allowed to know both.
       *
       * An arrow rather than the bare method, because `verifyAccessToken` is declared with
       * method shorthand and carries no `this`-safety guarantee when detached.
       */
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      /**
       * The first production consumer of `requireScope`. Built here because the authorization
       * loader reads `app_user`, which belongs to identity — the catalogue only declares that
       * the route needs `staff`.
       */
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );

  apiRouter.use(
    createInventoryRoutes({
      inventory,
      // The same two capabilities the catalogue router receives, adapted here for the same
      // reason: inventory must not know which module mints tokens or reads privileges.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      requireStaff: scopeGuards.requireScope('staff'),
      logger,
    }),
  );

  apiRouter.use(
    createPaymentsRoutes({
      payments,
      // The same capability every other domain router receives, adapted here for the same
      // reason: payments must not know which module mints tokens.
      verifyAccessToken: async (token) => tokens.verifyAccessToken(token),
      // No `requireStaff`: initiation is authenticated-customer only and there is no admin
      // surface in the approved scope.
      requireIdempotency: requireIdempotency({ store: idempotency, logger }),
      logger,
    }),
  );

  /**
   * The webhook router, mounted by `app.ts` at `/api/v1/webhooks` with a RAW body parser.
   *
   * **Not on `apiRouter`**, and that is the point. `resolveStore` lives on the API router, and a
   * provider notification has no client to resolve a store for — the tenant is derived by the
   * service from the payment row the verified provider reference names. Putting this on
   * `apiRouter` would also put it behind `express.json()`, which destroys the exact bytes the
   * signature covers.
   *
   * The slot has existed in `app.ts` since Phase 0 with nothing to fill it. This is the first
   * and only filler.
   */
  const webhookRouter = createPaymentsWebhookRoutes({ payments, logger });

  const app = createApp({ config, logger, healthChecks, apiRouter, webhookRouter });

  /* ── 9. Shutdown ─────────────────────────────────────────────────────── */

  let shuttingDown: Promise<void> | undefined;

  /**
   * Reverse dependency order, and each step is `allSettled`-style tolerant: one resource
   * failing to close must not abandon the rest, or a stuck Redis socket keeps the process
   * alive after the database has already gone.
   *
   * The HTTP server is NOT closed here — this container owns the app, not the listener.
   * Step 7 stops accepting connections first, then calls this.
   */
  async function shutdown(): Promise<void> {
    // Memoised rather than guarded by a boolean: two concurrent callers (a SIGTERM and a
    // SIGINT arriving together) must both wait for one shutdown, not race two.
    shuttingDown ??= (async () => {
      logger.info('container_shutdown_started');

      // Outbox first: it stops the drain loop and closes workers and queue connections.
      // Doing this after the database would let an in-flight handler query a closed pool.
      await outbox.shutdown().catch((err: unknown) => {
        logger.error({ err }, 'outbox_shutdown_failed');
      });

      await locks.quit().catch((err: unknown) => {
        // `quit()` rejects if the connection is already gone, which is not a failure worth
        // reporting loudly during shutdown.
        logger.debug({ err }, 'locks_quit_failed');
      });

      await db.close().catch((err: unknown) => {
        logger.error({ err }, 'database_close_failed');
      });

      // Only when it is a genuinely separate pool. Closing the same handle twice would
      // reject, and closing `db` twice is what happens if this guard is dropped.
      if (replicaUrl !== undefined) {
        await replica.close().catch((err: unknown) => {
          logger.error({ err }, 'replica_close_failed');
        });
      }

      logger.info('container_shutdown_complete');
    })();

    return shuttingDown;
  }

  async function warmUp(): Promise<void> {
    await tokens.warmUp();
    logger.info({ kid: await tokens.keyId() }, 'jwt_keys_verified');
  }

  return {
    config,
    logger,
    db,
    replica,
    locks,
    outbox,
    idempotency,
    identity,
    catalogue,
    inventory,
    addresses,
    cart,
    promotions,
    orders,
    payments,
    paymentExpirySweeper,
    fulfilment,
    returns,
    tax,
    invoicing,
    scopeGuards,
    app,
    warmUp,
    shutdown,
  };
}
