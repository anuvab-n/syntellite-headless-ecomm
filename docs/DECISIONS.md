# Locked Baseline & Document Precedence

**Status:** locked, 2026-08-24 · **Applies from:** Phase 0

This file is the tiebreaker. It exists because this project has two source documents that
describe the same system at different altitudes, and without a written precedence rule they
will drift apart and both become untrustworthy.

## 1. Source documents and precedence

| Rank | Document                                                              | Role                                                                     |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | **This file**                                                         | The reconciled decisions. Wins over both documents wherever it speaks.   |
| 2    | `Generic_Ecommerce_Backend_Technical_Design_Implementation_Plan.docx` | **The contract.** What we agreed to build, and the approval-level scope. |
| 3    | `ecommerce-backend-nodejs-express-specification.md`                   | **The implementation manual.** How to build it, in detail.               |

Reading order for a new engineer: this file, then the `.docx` (30 minutes), then the `.md`
section relevant to the phase they are working on.

**When the `.docx` and the `.md` conflict on a detail, the `.md` wins** — it is the one
written at implementation altitude, with exit criteria and failure modes. When either
conflicts with a decision recorded below, this file wins.

**A fourth document exists and is NOT in scope:** `ecommerce-backend-full-specification.md`
is the Django/Python variant of the same system. It is a useful cross-reference for
domain logic (roughly 85% of it is stack-agnostic) and must never be treated as
authoritative for this codebase. Do not copy its code examples.

## 2. Stack

| Layer                 | Choice                                                            |
| --------------------- | ----------------------------------------------------------------- |
| Runtime               | Node.js 22                                                        |
| Language              | TypeScript, `strict` plus the extra flags in `tsconfig.base.json` |
| HTTP                  | Express 5                                                         |
| Database              | PostgreSQL 16                                                     |
| DB access             | Drizzle ORM (`node-postgres` driver)                              |
| Cache / locks / queue | Redis, **three separate logical databases**                       |
| Jobs                  | BullMQ                                                            |
| Validation            | Zod                                                               |
| Logging               | Pino                                                              |
| Testing               | Vitest + Testcontainers                                           |
| Packaging             | pnpm workspace, Docker                                            |

## 3. Reconciled decisions

Each of these resolves a genuine conflict or ambiguity between the two documents.

| #   | Area              | Decision                                                                                                          | Why                                                                                                                                                                                                                                           |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Roadmap           | **9 phases (0–8) from the `.md`**                                                                                 | It is the version with per-phase exit criteria and stated risks. The `.docx` 10-phase list folds in as a scope summary; its "Phase 2 Identity" is absorbed into Phase 0.                                                                      |
| 2   | Auth              | RS256 access tokens (15 min) **+** opaque rotating refresh sessions in PostgreSQL **+** Argon2id password hashing | The `.docx` and `.md` describe the same design at different altitudes, not two designs. Stateless access tokens are fast to verify; stateful refresh is what makes logout and breach response work.                                           |
| 3   | DB location       | `src/db/`                                                                                                         | One `tsconfig` root. The `.docx` put `db/` beside `src/`.                                                                                                                                                                                     |
| 4   | Identifiers       | **UUIDv7, single primary key column**                                                                             | Deviates from the `.md` reference SQL, which uses `BIGSERIAL` + a UUID surrogate. That duality exists to keep indexes narrow while not leaking row counts; UUIDv7 achieves both properties in one column, so the second is redundant. See §4. |
| 5   | Tenancy           | `store_id` on every tenant-owned table, from the first migration                                                  | Retrofitting tenancy rewrites every query, index, and unique constraint.                                                                                                                                                                      |
| 6   | Money             | `NUMERIC(19,4)` + a currency code on the aggregate, branded `Money` type, decimal.js, `ROUND_HALF_UP`             | JavaScript has no exact decimal. `src/shared/money.ts` is the only place permitted to do monetary arithmetic.                                                                                                                                 |
| 7   | Stock history     | Append-only ledger                                                                                                | The ledger is the source of truth; the projection is derived and reconcilable against it.                                                                                                                                                     |
| 8   | Order history     | Append-only status history                                                                                        | Every transition is a row. No `UPDATE` rewrites the past.                                                                                                                                                                                     |
| 9   | Historical orders | Snapshot product and address data onto order lines                                                                | Renaming a product must not alter a past invoice.                                                                                                                                                                                             |
| 10  | Events            | Transactional outbox, built in Phase 0 before the first event exists                                              | Node has no `transaction.on_commit()`. See §5.                                                                                                                                                                                                |
| 11  | Enforcement       | `dependency-cruiser` + 5 custom ESLint rules, as **failing** CI checks                                            | In Express, CI is the only enforcement of module boundaries.                                                                                                                                                                                  |
| 12  | DI                | Manual composition root (`src/container.ts`), no DI framework                                                     | Cycles become compile errors instead of runtime `forwardRef()` workarounds.                                                                                                                                                                   |
| 13  | Processes         | `api` + `worker` + `scheduler`                                                                                    | The scheduler runs as **exactly one** instance, ever. Two will double-release reservations.                                                                                                                                                   |
| 14  | Email uniqueness  | Unique index on `(store_id, lower(email))`, partial on `deleted_at IS NULL`                                       | The `.md` uses the `citext` extension. An expression index needs no extension and is enforced by the database regardless of whether application code remembers to lowercase.                                                                  |
| 15  | Erasure           | Anonymise, never delete                                                                                           | Tax law requires invoice retention. This must be stated in the privacy policy.                                                                                                                                                                |

## 4. Deviations from the `.md` reference schema — stated openly

The reference SQL in the `.md` is authoritative for **shape and constraints**, not for
column types. Where we differ:

| Reference SQL                               | This codebase                                | Reason                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `BIGSERIAL id` + `UUID uuid` on every table | one `UUID` (v7) primary key                  | UUIDv7 is time-ordered, so it indexes like a sequence and leaks no row count. The two-column pattern solves a problem v7 does not have. |
| `CITEXT` email                              | `VARCHAR(320)` + `lower(email)` unique index | Avoids an extension; enforced identically.                                                                                              |
| `gen_random_uuid()` default                 | generated by the application (`newId()`)     | Services need the id before the `INSERT` to build child rows and emit an event in one transaction.                                      |

Anything marked **CRITICAL** in the reference SQL is reproduced exactly. Those are
correctness guarantees, not style.

## 5. The two things that must never be deferred

Recorded here because both are invisible when working and catastrophic when absent, and
both will be proposed for deferral at some point.

### The transactional outbox

Enqueueing a job inside a transaction lets a worker read uncommitted data. Enqueueing
after the commit loses the job if the process dies in between. The outbox removes both:
the event row commits atomically with the business state, and a drainer publishes it with
at-least-once delivery.

Consequence: **every handler must be idempotent.** Delivery is at-least-once, not
exactly-once.

### The CI enforcement rules

`dependency-cruiser` plus five custom ESLint rules:

1. Bare `async` route handlers (an unhandled rejection, not a 500)
2. `queue.add` outside the event bus (bypasses the outbox)
3. Bare `fetch` outside `integrations/` (no timeout, no retry, no circuit breaker)
4. `db.query.*` in the inventory module (**cannot express `FOR UPDATE`** — see §6)
5. Arithmetic operators applied to a `Money` value

**Removing or downgrading any of these to a warning requires two approvals and an ADR.**
Without them the module boundaries in this codebase are aspirational.

## 6. The single most dangerous trap in this stack

Drizzle exposes two query APIs. `.for('update')` — the row lock that prevents overselling —
exists on the query builder and **not** on the relational API:

```ts
// CORRECT — takes the lock
await tx.select().from(stockItem).where(eq(stockItem.id, id)).for('update');

// WRONG — compiles, runs, returns the right row, takes NO LOCK
await tx.query.stockItem.findFirst({ where: eq(stockItem.id, id) });
```

The wrong version passes every single-threaded test. It fails only under concurrent load,
in production, as overselling.

Three independent defences, all mandatory:

1. The `dependency-cruiser` rule banning the relational API inside `inventory`
2. A database `CHECK` constraint that makes negative available stock impossible
3. A concurrency test that **must fail when `.for('update')` is removed** — a test that
   still passes without the lock is testing nothing

## 7. Deliberately still open

These do not block Phase 0. They must be answered before the phase named.

| Decision                                               | Blocks  | Default if unanswered                    |
| ------------------------------------------------------ | ------- | ---------------------------------------- |
| Razorpay vs Stripe first                               | Phase 3 | Razorpay (primary market is India)       |
| India / INR / GST + COD confirmation                   | Phase 3 | Assumed yes; the tax module is pluggable |
| Multi-store enabled in v1, or store-ready single store | Phase 1 | Store-ready single store                 |
| Guest checkout allowed                                 | Phase 3 | Allowed, as a store setting              |
| Cloud platform and object storage                      | Phase 8 | S3-compatible; MinIO locally             |
| RPO / RTO targets                                      | Phase 8 | — must be a business decision            |

## 8. Definition of done

From the `.docx`, unchanged. A change is done when:

- [ ] Code reviewed
- [ ] Typecheck, lint, and `dependency-cruiser` pass
- [ ] Relevant tests pass — including a concurrency test if it touches stock or money
- [ ] API documentation updated
- [ ] Migration tested from a clean database, and the generated SQL was read
- [ ] Authorization verified
- [ ] Failure and retry behaviour handled
- [ ] Logs and errors are meaningful
- [ ] No secrets or debug code committed
- [ ] Operational documentation updated

## 9. Amending this file

A decision here changes only by editing this file in the same pull request as the code
that depends on the change, with the reason recorded in the table. Do not resolve a
conflict in a code comment or a commit message — the next person will not find it.

## 10. Phase 0 implementation notes

Decisions taken while implementing Phase 0 that were not in either source document.

| Area                                  | Decision                                                          | Why                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container images                      | Debian-based `postgres:16`, **never** `-alpine`                   | Alpine/musl images fail to exec on some Docker Desktop + WSL2 kernels — `docker run alpine:3 echo ok` reproduces it with "accessing a corrupted shared library". Applies to `docker-compose.yml` and the Testcontainers image alike. |
| Local host ports                      | Postgres `55432`, Redis `56379`                                   | The defaults are routinely held by a native Postgres install or another project's Redis, and the resulting "port is already allocated" is a confusing first-run failure. Container-internal ports are unchanged.                     |
| Outbox failure states                 | Added `outbox_event.dead_lettered_at`                             | Retrying-and-pending and permanently-dead need different alerts and different human responses. The row is kept, with its error and attempt count, so a dead letter can be investigated and replayed by hand.                         |
| Outbox attempt counting               | `attempts` increments on CLAIM, not on failure                    | A worker that crashes mid-publish still burns an attempt, so an event whose payload kills the process dead-letters instead of crash-looping every worker forever.                                                                    |
| `EventBus.emit` outside a transaction | Throws by default; `{ allowOutsideTransaction: true }` to opt out | An emit with no ambient transaction is usually a caller who believes it is atomic with a write that actually committed separately — the exact bug the outbox exists to prevent, in disguise.                                         |
| Batch ordering                        | Claimed rows are re-sorted in the application                     | `UPDATE ... WHERE id IN (SELECT ... ORDER BY ...) RETURNING *` gives **no** ordering guarantee on `RETURNING`; PostgreSQL returns heap order. Ordering holds within a batch only — across concurrent drainers it cannot, by design.  |
| TypeScript version                    | Pinned to `~5.9`                                                  | `typescript-eslint` does not support TypeScript 7 (peer `<6.1.0`), and the lint rules are the architecture enforcement. Revisit when typescript-eslint ships TS7 support.                                                            |
| `testcontainers` version              | Pinned to `^11`                                                   | v12 requires Node ≥ 22.22; the local runtime is 22.20. Unpin after upgrading Node.                                                                                                                                                   |

## 11. Step 4 — outbox decisions

| Area                        | Decision                                                                           | Why                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event identity              | `type` + `aggregateType` + `aggregateId`                                           | During an incident the question is "everything that happened to THIS order", not "every order.placed". Indexed as `(store_id, aggregate_type, aggregate_id, occurred_at)`.                                                                                                |
| Handler idempotency         | The `processed_event` claim and the handler run in **one transaction**             | Claiming outside it means a failed handler is marked done forever and the work is silently lost. Sharing the transaction makes a rollback release the claim, so the retry genuinely reruns.                                                                               |
| Exactly-once scope          | Real for PostgreSQL-only handlers; best-effort for external effects                | An email already sent cannot be un-sent by a rollback. Handlers with external effects must also be idempotent at the provider; the claim narrows the window, it does not abolish it.                                                                                      |
| `published_at` vs processed | `outbox_event.published_at` means "handed to the transport", not "handled"         | With a queue those are different moments. Handler completion is recorded in `processed_event`, keyed per handler, because one event legitimately fans out to several.                                                                                                     |
| Source of truth             | A BullMQ job carries only an event id; the worker re-reads the row from PostgreSQL | Keeps Redis a work-distribution mechanism. A flushed, restarted, or evicted Redis loses no durable state — proven by a test that flushes it mid-flight.                                                                                                                   |
| Transport                   | `in-process` and `queue`, chosen at composition                                    | In-process needs no Redis and suits local dev and tests. Queue is the production shape: a slow handler must not stall the drain loop.                                                                                                                                     |
| Queue split                 | `default`, `emails`, `heavy`                                                       | Separated by blast radius, not domain. A bulk send must not queue ahead of an order confirmation.                                                                                                                                                                         |
| Batch ordering              | Sorted in the application after claiming                                           | `UPDATE ... RETURNING` has no ordering guarantee. Holds **within** a batch only; across concurrent drainers ordering is impossible by design.                                                                                                                             |
| ESLint scope                | Type-aware baseline now; `stylisticTypeChecked` off                                | The stylistic set demands `interface` over `type` across a codebase that uses `type` deliberately — churn in working files, no defect caught. The five architecture rules and `dependency-cruiser` remain Step 8, and they are the ones that actually enforce boundaries. |

## 12. Step 5 — HTTP scaffolding decisions

| Area                     | Decision                                                                  | Why                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Liveness vs readiness    | `/health/live` touches **nothing**; `/health/ready` checks dependencies   | A liveness probe that queries PostgreSQL fails on every instance during a database blip, so the orchestrator restarts the whole fleet and the restarts stampede the recovering database. Restarting a process cannot fix a database.                |
| Readiness response shape | Its own status document, not the error envelope                           | Probes read the status code, not the body. `{ status, checks: { postgres: 'ok' } }` is what a human wants during an incident; an error envelope is not.                                                                                             |
| Readiness detail         | Only `ok` / `unavailable` / `degraded` per dependency                     | This endpoint is often reachable from further away than the rest of the API, and a driver error can contain a connection string. Detail goes to the log, keyed by request id.                                                                       |
| Redis readiness          | `required: true` by default                                               | Redis holds idempotency keys and rate-limit counters, and the degradation policy fails closed on anything touching money. An instance that cannot reach the lock store must not accept a checkout.                                                  |
| Validated input          | Goes on `req.validated`, never over `req.body`                            | If validated data overwrote the raw input, half the codebase would read `req.body` and be right while the other half read it and be wrong, with nothing at the call site to distinguish them.                                                       |
| Validation errors        | All sources accumulated, then one `ValidationError`                       | Failing on the first means the client fixes one field, retries, and discovers the next — a round trip per mistake.                                                                                                                                  |
| Zod errors               | Never serialised to the client                                            | A `ZodError` describes the schema: union branches, discriminators, internal field names. Only `{ field: [messages] }` crosses the boundary.                                                                                                         |
| Request id               | Accept inbound `x-request-id`, else generate; validated and length-capped | One id across gateway, API, and worker makes a trace readable. The header is attacker-controlled and echoed, so a malformed value is replaced rather than escaped, and capped at 128 chars so a client cannot write a megabyte into every log line. |
| Malformed body           | `MALFORMED_JSON` (400) and `PAYLOAD_TOO_LARGE` (413) as distinct codes    | The client's fix differs. `err.message` is never forwarded — body-parser puts a fragment of the offending body in it, which reflects attacker input into the response.                                                                              |
| Request logging          | No bodies, ever; `authorization`/`cookie` stripped                        | A checkout body holds an address, a login body a password. No allowlist is careful enough to be worth the risk.                                                                                                                                     |
| Health probe logging     | Excluded from request logging; failures still logged                      | A 5-second readiness probe is ~17k lines/day/instance of noise. A _failing_ probe is a real operational event and is logged at warn with the error.                                                                                                 |
| `trust proxy`            | `1`, not `true`                                                           | Trusting every hop lets a client forge `X-Forwarded-For` and appear to come from any address, defeating rate limiting and IP audit logging.                                                                                                         |
| Signal handling          | **Not** in `src/http/server.ts`                                           | Shutdown ordering (HTTP stops accepting before the database pool closes) is a process concern and belongs to Step 7. A module that registers `process.on` as an import side effect is untestable.                                                   |

## 13. Step 6 — composition root decisions

| Area                                 | Decision                                                                 | Why                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape                                | `buildContainer(opts)` returns a value; no module-level instance         | No global singleton means tests build their own container against throwaway containers with nothing to collide over. Not a service locator: nothing calls `container.get(...)`, and no module imports `container.ts`.                  |
| Role                                 | `role: 'api' \| 'worker'` decides `runWorkers`                           | The one decision separating the two process types. Node is single-threaded, so a CPU-bound handler inside the API process stalls every concurrent request and reads to users as "the site is down".                                    |
| Redis ownership                      | Container owns the **lock** client only                                  | The queue connections are created and closed by `createOutboxSubsystem`; creating a second here would mean two owners for one resource and an ambiguous shutdown order.                                                                |
| Cache client                         | **Not created**                                                          | Nothing consumes it yet. An idle connection that exists to make the container look complete is a placeholder, and it would make readiness report on a dependency no code path uses. Phase 1 adds it with the first caching selector.   |
| `enableOfflineQueue: false` on locks | Commands fail immediately when disconnected                              | ioredis otherwise queues and replays them, so an idempotency-key write during an outage appears to succeed and lands seconds later — after the decision that depended on it. Fail closed on money paths.                               |
| Redis readiness probe                | Waits for `'ready'` before pinging                                       | Consequence of the above: a probe fired microseconds after boot hits a socket mid-handshake and a healthy instance reports 503 intermittently. The wait is bounded by the health route's existing 2s timeout rather than a second one. |
| Replica                              | Same handle as primary unless a _different_ URL is configured            | `.env.example` sets the replica to the same URL locally; a second pool to the same server doubles connections and proves nothing. Identity also means shutdown closes it exactly once.                                                 |
| Health probes                        | Passed as closures                                                       | Keeps `http/routes/health.ts` free of imports from `db/` and `ioredis`. The wiring lives in the one file whose job is wiring.                                                                                                          |
| `shutdown()`                         | Memoised promise, reverse dependency order, per-resource error tolerance | Two signals arriving together must await one shutdown, not race two. Outbox closes before the database, or an in-flight handler queries a closed pool. One resource failing must not abandon the rest.                                 |
| Signals                              | Not handled here                                                         | Ordering against HTTP draining is a process concern and belongs to Step 7. A module registering `process.on` as an import side effect is untestable.                                                                                   |
| Routers                              | `apiRouter`/`webhookRouter` omitted                                      | No business modules exist. The app serves health and returns JSON 404 for everything else — the honest Phase 0 state.                                                                                                                  |

## 14. Step 7 — process entry points

| Area                            | Decision                                                                                    | Why                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processes                       | `src/main.ts` (api), `src/workers/default.ts`, `src/workers/scheduler.ts`                   | The paths the existing `dev:*` scripts already referenced.                                                                                                                                                            |
| Signal ownership                | Entry points only; `container.ts` registers nothing                                         | Shutdown _ordering_ is the hard part and only the entry point knows it — the API must drain HTTP before the container closes the pool those requests are using.                                                       |
| Outbox draining                 | Worker only, not the API                                                                    | Node is single-threaded; a CPU-bound handler on the API stalls every concurrent request. Consequence: local dev needs `pnpm dev` **and** `pnpm dev:worker` for a side effect to fire.                                 |
| Worker shutdown order           | Stop drainer → await the loop → close container                                             | `container.shutdown()` closes the queue connections. A drain loop still mid-batch would publish to a closed queue, marking events failed and retrying them for no reason during a routine deploy.                     |
| Happy-path exit                 | No `process.exit()`                                                                         | Letting the event loop drain is the only proof teardown was complete. An explicit exit masks a leaked handle, and the leak then surfaces as data loss during a deploy rather than as a hanging process in dev.        |
| Shutdown watchdog               | 25s, `unref()`-ed, forces exit 1                                                            | Must be under the orchestrator's grace period or it never runs. `unref()` is essential — a referenced timer would itself hold the loop open for 25s, preventing the exit it exists to guarantee.                      |
| Scheduler singleton             | Redis leader lock (`SET NX PX` + Lua compare-and-act), losing instance stays a warm standby | "We deploy one replica" is not enforcement: a rolling deploy runs two, and that window is when a task fires. Standby (rather than exit) avoids a restart loop and gives failover within the TTL.                      |
| Fencing token                   | Random per instance; renew and release are compare-and-act                                  | Without it, an instance whose lock had already expired would `DEL` the _new_ leader's key, and two instances would then both believe they lead.                                                                       |
| Scheduler tasks                 | Registry deliberately **empty**                                                             | No business jobs exist yet. Inventing a sweeper to make the file look busy would be a lie the next reader has to unpick. Phases 2/4/6 add theirs.                                                                     |
| Redis readiness before commands | `waitForReady` bounded at 3s inside the lock                                                | Second instance of the same class of bug as §13: `enableOfflineQueue: false` is right for money paths but makes any command issued during the initial handshake throw. Found by running the scheduler, not by a test. |

## 15. Phase 1 increment 1 — registration

| Area                          | Decision                                                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing              | **Argon2id**, `memoryCost=19456 KiB`, `timeCost=2`, `parallelism=1`, stated explicitly in `password.ts` | OWASP Password Storage (2024) minimum. Parameters are pinned rather than inherited: a dependency bump that changed library defaults would silently weaken every password created afterwards. Memory is the lever that costs an attacker money; raising `timeCost` is weaker per unit of latency. `parallelism=1` because Node is single-threaded and lanes we cannot use add coordination for no security. |
| Cost upgrades                 | `needsRehash()` + re-hash on successful login (login increment)                                         | The PHC string records the parameters each hash was made with, so cost factors can be raised without a mass reset. Passwords strengthen as users return.                                                                                                                                                                                                                                                   |
| `verifyPassword` failure mode | Returns `false` for a wrong password, a malformed hash, and a wrong algorithm alike                     | A caller must not distinguish those by catching different exceptions. A corrupt `password_hash` returning 500 instead of 401 tells an attacker they found an interesting account.                                                                                                                                                                                                                          |
| Password policy               | Length only: 10–128. No composition rules                                                               | NIST SP 800-63B: mandatory character classes drive predictable substitutions (`Password1!`) for little real entropy. The 128 ceiling bounds the buffer handed to the native addon. Passwords are **not** trimmed — whitespace is a legitimate character.                                                                                                                                                   |
| Store resolution              | `DEFAULT_STORE_SLUG` → `StoreResolver` port in `http/middleware/store.ts`, adapter in `modules/stores`  | `http/` must not query tables. The port/adapter split means Phase 2 domain matching is a new resolver only — the middleware, routes, and identity service never learn how resolution happens.                                                                                                                                                                                                              |
| Missing store → **503**       | `DependencyUnavailable`, not `NotFound`                                                                 | The client asked for nothing in particular; an unseeded store is our operational fault. A 404 sends an integrator hunting their own code for our bug, and does not trip 5xx alerting.                                                                                                                                                                                                                      |
| `resolveStore` scope          | API router only, never `/health`                                                                        | Readiness must not require a seeded database, or a fresh deployment can never report ready long enough to be seeded — a genuine deadlock.                                                                                                                                                                                                                                                                  |
| Store id propagation          | `req.store` **and** `extendContext({storeId})`                                                          | `RequestContext.storeId` already existed with two consumers: the Pino mixin and `EventBus.emit`'s fallback. One line makes every log line and outbox event store-attributed with no call site passing an id.                                                                                                                                                                                               |
| Duplicate email → **409**     | `EMAIL_ALREADY_REGISTERED`, generic message, no address echoed                                          | **Accepted trade-off: this is a user-enumeration oracle.** The clean alternative (always 202, disambiguate by email) needs email delivery that does not exist yet. Rate limiting is the mitigation and is the next security increment. The message stays generic so the response confirms rather than reflects.                                                                                            |
| Duplicate enforcement         | Pre-check for a clean error **plus** unique-index translation for the race                              | Two concurrent registrations both pass the pre-check. Only the constraint can arbitrate. Translated by **constraint name**, so a future unique index is not misreported as a duplicate email; anything unrecognised is rethrown as a 500.                                                                                                                                                                  |
| Drizzle error unwrapping      | `uniqueViolationConstraint` walks the `cause` chain                                                     | Drizzle wraps the driver error in `DrizzleQueryError` (own props: `query`, `params`, `cause`); SQLSTATE and constraint name live on `cause`. A top-level check made the pre-check path return 409 while the **race** path returned 500 — invisible to every sequential test.                                                                                                                               |
| Request DTO                   | `z.strictObject`, not a plain object                                                                    | A plain object _strips_ unknown keys, so `isStaff: true` would succeed silently. A client sending it is probing for mass assignment or badly confused; both deserve a 400. `isStaff`/`isSuperuser`/`storeId`/`id`/`passwordHash` are absent from the schema **and** from `InsertUserValues`, so neither the boundary nor the insert can carry them.                                                        |
| Response shape                | Allowlist mapper (`toUserResponse`), never spread-and-delete                                            | Spreading publishes every future column by default, and the one that eventually leaks is the one nobody thought about.                                                                                                                                                                                                                                                                                     |
| Transactions                  | **None** for registration                                                                               | It is a single INSERT. The project convention is `withTransaction` only where there is a real consistency boundary. It arrives with the second write — the `user.registered` outbox event or the `audit_log` row.                                                                                                                                                                                          |
| Email normalisation           | `.trim().toLowerCase()` **before** `.email()`, and again in the service                                 | Validating first would reject `" User@Example.com "` for whitespace the user plainly did not intend. Re-normalising in the service covers non-HTTP callers, so the stored value always matches the `lower(email)` unique index.                                                                                                                                                                            |

## 16. Phase 1 increment 2 — token foundation

| Area                                    | Decision                                                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm                               | **RS256, pinned on both sides.** `algorithms: ['RS256']` on verification                                                   | Pinning the VERIFIER is the part that matters. An unpinned verifier trusts the token's own `alg` header, so an attacker sets `HS256` and signs with the public key — which is public — and the token verifies. `jose` additionally refuses `alg: none`.                                                                                                                                                                                                                                       |
| Access-token claims                     | `iss`, `aud`, `exp`, `iat`, `jti`, `sub`, `storeId`, `isStaff`, `isSuperuser`, `sid`                                       | Asserted exactly by test, so a claim added carelessly fails the build.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| No email or name in the token           | Excluded                                                                                                                   | A JWT is base64, not encryption: anyone holding it reads the payload. Email is PII and mutable — a token minted before an address change carries a stale one for its whole life, and any log that dumped a decoded token would carry PII.                                                                                                                                                                                                                                                     |
| No scopes in the token                  | Derived from `isStaff`/`isSuperuser` at authorization time                                                                 | Baking a scope list into a 15-minute credential means a permission revoked now takes effect in 15 minutes. Deriving per request makes revocation immediate.                                                                                                                                                                                                                                                                                                                                   |
| `sid` present from the first token      | The `refresh_session` row the access token descends from                                                                   | Included now so the format never changes. It is what lets "revoke this session" reach access tokens later via a short-lived denylist; without it the only options are waiting out the TTL or revoking everything.                                                                                                                                                                                                                                                                             |
| `kid`                                   | RFC 7638 JWK thumbprint of the public key                                                                                  | Deterministic and derivable by any verifier holding the public key — no registry, no new environment variable. Rotation later becomes additive: a second key brings its own `kid`, verification selects by it, and the token format is unchanged. Retrofitting would leave every token in flight lacking the header the verifier needs.                                                                                                                                                       |
| `kid` mismatch rejected                 | Even though the signature already validated                                                                                | A mismatch cannot mean forgery (the signature proved the key); it means a token from a previous keypair. Impossible with one key, and exactly the case rotation introduces — so the verifier already distinguishes keys.                                                                                                                                                                                                                                                                      |
| PEM validation                          | **Synchronous shape check in config**; cryptographic import is lazy in the token service                                   | `.min(1)` previously accepted `'not-a-key'` and `' '`, deferring failure to the first signature — in a fresh deployment, the first customer login rather than boot. Proving a key _usable_ requires an async import, and `loadConfig()` is synchronous by design; making it async would ripple into `buildContainer()` and three entry points. The regex catches every realistic failure (empty, whitespace, wrong half of the pair, PKCS#1, truncated body); `warmUp()` catches the residue. |
| `warmUp()` not yet wired                | Exists on the service, unused                                                                                              | Belongs in the API startup sequence alongside login, so a well-formed-but-broken key fails at boot. Wiring it now would mean wiring an otherwise-unused service into the container.                                                                                                                                                                                                                                                                                                           |
| Verification failures                   | **One error, one message, one code** for malformed / expired / wrong key / wrong issuer / wrong audience / wrong algorithm | The differences are what an attacker probes: "expired" confirms the token was once valid; "wrong issuer" confirms the signature checked out. The reason is logged at **debug** — an expired token is normal traffic every client hits once per 15 minutes, and at warn it would be the noisiest line in the system.                                                                                                                                                                           |
| Claim parsing                           | Verified payloads are type-checked before use                                                                              | `jwtVerify` proves signed-and-unexpired; it does not prove our own claims exist. A token from an older service version would otherwise verify and yield `undefined` where a session id was expected.                                                                                                                                                                                                                                                                                          |
| Refresh token entropy                   | 32 bytes (256 bits) from `randomBytes`, base64url → 43 chars                                                               | Beyond brute force, and matches the digest size so neither side is the weak link. base64url needs no escaping in a header, URL, or cookie. **Not a UUID:** v4 carries 122 bits in a recognisable structure and v7 — this project's row id — embeds a timestamp and is partially predictable. Neither is credential material.                                                                                                                                                                  |
| Refresh token storage                   | SHA-256 hex (64 chars), matching `refresh_session.tokenHash` `varchar(64)`                                                 | A dump, replica, or backup then yields no usable sessions. The length coupling is asserted by test, so moving to SHA-512 fails loudly instead of silently truncating every hash to a colliding prefix.                                                                                                                                                                                                                                                                                        |
| SHA-256, not Argon2, for refresh tokens | Deliberately different from `password.ts`                                                                                  | A password is low-entropy and human-chosen, so slowness buys security. A refresh token is 256 random bits — there is nothing to guess, so a slow hash would only add latency to every refresh. Unsalted for the same reason, and because lookup requires determinism.                                                                                                                                                                                                                         |
| Raw/hash type confusion                 | Marker types `RefreshToken` / `RefreshTokenHash`, matching `PasswordHash` style                                            | Passing a raw token where a hash is expected writes the secret to the database in plaintext, and the bug is invisible in review because both are 43–64-character strings.                                                                                                                                                                                                                                                                                                                     |
| SQL redaction                           | `err.query`, `err.params` (plus `err.cause.*` as a forward guard)                                                          | Drizzle wraps the driver error in a `DrizzleQueryError` whose own properties include `query` and `params`; pino serialises those, so an unhandled database error logged the statement with every bound value — for a registration insert, the Argon2 hash. Explicit paths, not `*.params`, so ordinary diagnostics are not blinded.                                                                                                                                                           |

## 17. Phase 1 increment 3 — login

| Area                      | Decision                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timing equalisation       | An unknown email still runs `verifyPassword` against a **dummy Argon2 hash** computed once at service construction                | Registration hashes _after_ its existence check to avoid CPU burn; login must invert that. Returning early on an unknown address answers in ~1ms where a real one takes ~50ms — a timing oracle precise enough to enumerate a customer list. The dummy hash is not a secret: it is stored nowhere and authenticates nothing.            |
| `isActive`                | **Selected, not filtered**, and checked _after_ password verification                                                             | Filtering it would make a disabled account skip Argon2 entirely and answer measurably faster. Fetching it keeps every failure path the same cost.                                                                                                                                                                                       |
| Failure collapse          | Unknown email, wrong password, inactive account, and soft-deleted account all → the same `InvalidCredentials` (401), same message | Asserted by a test that strips `requestId` and requires exactly **one** distinct response body. Soft-deleted users never reach verification: the query excludes them, matching the partial unique index.                                                                                                                                |
| Failure logging           | ONE event (`login_rejected_invalid_credentials`) for unknown-email and wrong-password, carrying no email                          | Splitting into `login_unknown_email` / `login_wrong_password` would rebuild the enumeration oracle inside our own logs, and log access is broader than database access. The inactive case _is_ logged distinctly — reaching it proves the caller already knew the password, so it reveals nothing they did not supply.                  |
| Credential loading        | A separate `findCredentialsByEmail` + `CREDENTIAL_COLUMNS`, never a widened `PUBLIC_COLUMNS`                                      | `passwordHash` is reachable through exactly one method name, greppable in one search. Its return type is distinct from `MappableUser`, so a credential row cannot be passed to `toUserResponse`.                                                                                                                                        |
| Transaction               | Session insert **+** `lastLoginAt` update, atomic                                                                                 | The asymmetry decides it: a committed session with a stale timestamp is harmless, but a stamped timestamp with no session row means returning a refresh token that does not exist — the client believes it holds a 30-day session and its first refresh fails inexplicably.                                                             |
| Token issuance ordering   | **After** commit                                                                                                                  | Minting a credential whose `sid` might roll back is the worse failure. Asserted, not hidden: issuance failing after commit leaves an **orphan session** the client never learns about, which expires on its own while the client retries. `warmUp()` at startup makes the realistic cause (unusable keys) impossible by then.           |
| Raw refresh token         | Hashed in the service; the repository signature accepts only `RefreshTokenHash`                                                   | A raw token and its hash are both opaque strings of similar length, so a mix-up is invisible in review. Making it a type error is the only reliable guard.                                                                                                                                                                              |
| Collision retry           | Retry **once**, then fail loudly                                                                                                  | At 256 bits a collision is ~2⁻¹²⁸, so a violation means a broken CSPRNG far more plausibly than bad luck. An unbounded loop would spin forever against a generator returning a constant — precisely what the violation signals. Discriminated by **constraint name**, so an unrelated unique violation is rethrown rather than retried. |
| `needsRehash` upgrade     | Post-commit, best-effort, using the hash already verified                                                                         | A rehash problem must never turn a valid login into a failed one. The update is conditional on the fetched hash still being current, so a concurrent login or password change cannot be overwritten. Failure logs only `storeId`/`userId` — never the plaintext or either hash.                                                         |
| Client IP                 | `req.ip`                                                                                                                          | `app.ts` already sets `trust proxy: 1`, the application's declared trust boundary. Hand-parsing `X-Forwarded-For` would duplicate that logic or trust hops the rest of the app deliberately does not.                                                                                                                                   |
| User agent                | **Truncated** to 512 (the column width), not rejected                                                                             | A browser with an absurd UA must never be unable to sign in. The value is forensic only and never used for authorization, so losing the tail costs nothing whereas an overflow would fail the transaction.                                                                                                                              |
| Login password validation | `min(1).max(1024)`, **not** the registration `passwordField`                                                                      | The 10–128 bounds are a policy for _choosing_ a password. Applying them at login would reject users whose password predates a policy change, and the floor would leak that short passwords cannot exist.                                                                                                                                |
| Response contract         | `user`, `accessToken`, `tokenType: 'Bearer'`, `expiresIn`, `refreshToken` — asserted as an exact key set                          | No `familyId`, no `sessionId`, no token hash, no session expiry. `expiresIn` follows RFC 6749 §5.1 and describes the **access** token only; the refresh lifetime is not advertised.                                                                                                                                                     |
| `warmUp()` at startup     | `container.warmUp()` awaited inside the existing `startOrCleanUp`, **before** `listen()`                                          | Closes the fail-fast gap from §16: config validates the PEM envelope synchronously, but only an import proves the key usable. Exposed as a container _method_ rather than by publishing the token service — entry points need the capability, not the dependency.                                                                       |

## 18. Phase 1 increment 4 — authentication rate limiting

Protects `POST /auth/login` and `POST /auth/register` from credential stuffing, brute force, and CPU exhaustion via unlimited Argon2 calls.

| Decision                        | Choice                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library                         | **None.** Hand-written Lua on the existing `locks` Redis client                                 | `rate-limiter-flexible` would be a dependency wrapping `INCR` + `PEXPIRE`. The project already hand-writes Lua for the leader lock, for the same reason: check-then-set across two round trips is not atomic, and under exactly the load a limiter exists to handle, two concurrent requests would both read the same count and both be allowed.                                                                                                                                                                           |
| Algorithm                       | **Fixed window**, not sliding                                                                   | One integer per key. A sliding window stores one sorted-set member per attempt, which puts our memory under attacker control — a memory-exhaustion vector opened by the defence against a CPU-exhaustion vector. **Accepted trade-off: a boundary burst of up to 2× the limit** (10 attempts at 0:59 plus 10 at 1:01). Immaterial when the goal is stopping thousands of guesses rather than exactly ten, and still bounded.                                                                                               |
| Redis database                  | The **lock** DB, not the cache DB                                                               | The cache DB is the one that would carry an eviction policy, and an evicted counter is a reset budget — an attacker could flush their own block by filling the cache. The lock client also already has `enableOfflineQueue: false`, which is what makes failing closed fast instead of slow.                                                                                                                                                                                                                               |
| Backend unavailable             | **Fail closed** — `DependencyUnavailable` (503)                                                 | A limiter that allows the request when its backend is down is a limiter an attacker removes by attacking Redis, converting an availability problem into unlimited brute force. Consistent with the existing posture: `redisCheck` is already `required: true`, so an instance in this state is being pulled from the load balancer anyway. 503 rather than 429 because "too many attempts" would be false and un-actionable; 503 is true, retryable, and counts as our fault on a dashboard rather than as attack traffic. |
| Per-IP scope                    | Counts **every** attempt, on login **and** register                                             | The per-IP limiter caps CPU, and a successful Argon2 verification costs the same as a failed one. Registration hashes rather than verifies, so it is the _more_ expensive endpoint — leaving it unlimited would make the cheapest way to stall the API the endpoint that does not need a correct password.                                                                                                                                                                                                                 |
| Per-email scope                 | Counts **failures only**, resets on success. **Login only**                                     | A request counter would spend budget on the successful retry after a typo; a handful of careless typos across a day would lock out a paying customer. No per-email budget on register, because a per-address limit there would let an attacker who guesses an address block its real owner from ever signing up.                                                                                                                                                                                                           |
| Where the increment happens     | In `identity.login`, **after** the credential decision — never in middleware                    | Only the service knows whether the credentials were valid. Middleware checks (`peek`), the service spends (`record`) or forgives (`reset`). Exposed to the domain as a narrow `LoginAttemptTracker` port, so logging in still works from a CLI or a test without Redis.                                                                                                                                                                                                                                                    |
| When success clears the counter | At the moment ownership is proven, **before** session persistence                               | Everything after that point can fail for infrastructure reasons that say nothing about the caller's legitimacy. Clearing at the end of the method would leave a user with four prior typos one failure from lockout because _our_ database blipped.                                                                                                                                                                                                                                                                        |
| Inactive accounts               | **Counted** as failures                                                                         | Reaching that branch proves the password was correct, so exempting it would hand an attacker who already has valid credentials an unlimited-attempt path against a suspended account.                                                                                                                                                                                                                                                                                                                                      |
| Non-enumeration                 | Failures are counted for **unknown addresses too**                                              | If only real accounts had counters, a 429 would confirm an address exists while a nonexistent one kept answering 401 — rebuilding, inside the brute-force defence, exactly the oracle `InvalidCredentials` exists to close. Asserted by test: exhausting a real and a fake address yields byte-identical responses.                                                                                                                                                                                                        |
| Redis key subjects              | `sha256(parts.join(' ')).slice(0, 32)`                                                          | A raw email in a Redis key is PII in a datastore that gets dumped, replicated, and read with `KEYS *` during incidents. Hashing also fixes the key length against attacker-controlled input, and the separator stops `('ab','c')` and `('a','bc')` colliding — which would drop a crafted address into another store's bucket.                                                                                                                                                                                             |
| Store in the subject            | `hashRateLimitSubject(storeId, email)`                                                          | Two tenants can legitimately share a customer address. Without the store id, one tenant's failed logins would consume another's budget — a cross-tenant leak and a trivial way to lock out a competitor's users.                                                                                                                                                                                                                                                                                                           |
| Middleware placement            | Route-level, `resolveStore` → IP → email → `validate` → handler                                 | Per-route because budgets are endpoint-specific; a global limiter would throttle a Phase 2 catalogue browse with an auth-shaped policy. **Before `validate`**, because a flood of malformed bodies is still a flood and validating first would let an attacker burn CPU on Zod parsing without touching their budget. `resolveStore` must precede both, since the email subject needs the store id.                                                                                                                        |
| Missing or non-string email     | The email limiter **abstains**; `validate` returns 400                                          | A bucket for absent emails would put every malformed request in the world into one counter, so the first attacker to send garbage would lock out everyone else's malformed requests. The per-IP limiter has already counted the attempt, so the flood is still capped.                                                                                                                                                                                                                                                     |
| Response signals                | `Retry-After` header **and** `details.retryAfterSeconds`                                        | The header is what proxies, SDKs and browsers honour with no client code; the body field is what a UI renders. Sending only the body means well-behaved clients retry immediately. `X-RateLimit-*` is sent on allowed responses too, so a client can back off before being blocked.                                                                                                                                                                                                                                        |
| Two limiters, one header pair   | The **tightest** budget wins, not the last writer                                               | Advertising the roomy per-IP allowance while the per-email budget is one attempt from exhaustion would tell a well-behaved client it had headroom it does not have.                                                                                                                                                                                                                                                                                                                                                        |
| `peek` vs `consume` counting    | Separate comparisons: `consume` includes the current attempt, `peek` counts only prior ones     | Found by test during this increment. A single shared comparison allowed `max + 1` attempts through the peek path — a free guess on every account.                                                                                                                                                                                                                                                                                                                                                                          |
| Limits                          | `AUTH_RATE_LIMIT_IP_MAX=10`, `AUTH_RATE_LIMIT_EMAIL_MAX=5`, `AUTH_RATE_LIMIT_WINDOW_SECONDS=60` | Config, not constants: the right numbers are not knowable from a desk. A mobile client retrying on a flaky connection and an office behind one NAT gateway both change what "abusive" means, and Phase 8 load-test calibration must not require a code change.                                                                                                                                                                                                                                                             |
| Bookkeeping failures            | `trackAttempt` never throws; logged at `error`                                                  | The enforcement point is the _check_, which fails closed. Once the auth decision is made, letting a Redis blip turn a correct 401 into a 500 — or fail a **successful** login because the counter could not be cleared — would trade a real outage for marginal accounting accuracy.                                                                                                                                                                                                                                       |

## 19. Phase 1 increment 5 — refresh token rotation and reuse detection

Adds `POST /api/v1/auth/refresh`. **No migration was needed** — `refresh_session` already carried `consumedAt`, `revokedAt`, `revokedReason`, `familyId`, and an index on `familyId`, all added in Phase 0 in anticipation of this increment.

| Decision                            | Choice                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport                           | **JSON body** (`{ "refreshToken": "..." }`), not a cookie                                                                     | Not a preference — the existing architecture already settled it. Login returns `refreshToken` in its response body, the project has no cookie dependency and no `res.cookie` call anywhere, and the API is a headless JSON service. Adding a cookie would mean two transports for one credential plus CSRF protection that does not exist; a browser auto-attaching a refresh cookie to a cross-site request is exactly the attack a body-carried token cannot suffer.                                                                                                                                                                        |
| Rotation                            | Every successful refresh consumes the presented token and issues a replacement in the same family                             | A leaked token is then only useful until its owner next refreshes. This is what makes a 30-day credential tolerable at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Reuse detection                     | A row that exists and is **already consumed** means the token was presented twice, so the **entire family** is revoked        | Rotation hands the client a replacement, so a legitimate client has no reason to ever send the old token again. The thief may hold any number of descendants, so revoking only the replayed row would leave them with a live session. The family is the unit of revocation.                                                                                                                                                                                                                                                                                                                                                                   |
| Family revocation blast radius      | Revokes the compromised family only — **not** all of the user's sessions                                                      | A leak on a phone must not sign the user out of their laptop. Over-revoking trains users to expect random logouts, which hides the real incident in the noise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Order independence                  | Whoever presents a token **second** is the replay, whether that is the attacker or the victim                                 | The system cannot tell them apart and does not try. Asserted in both orderings by test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Concurrency**                     | A single `UPDATE ... SET consumed_at = now WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now RETURNING *` | The predicate and the write are one statement, so PostgreSQL takes a row lock and two concurrent transactions serialise on it: the second blocks, re-evaluates the `WHERE` under READ COMMITTED, and updates zero rows. Exactly one caller can ever win. **No application-memory locking**, so this holds across processes and instances.                                                                                                                                                                                                                                                                                                     |
| Concurrency loser                   | Treated as a **replay** — the family is revoked                                                                               | The accepted trade-off, stated plainly: a client that fires two refreshes at once logs itself out. The alternative (a grace window that forgives a recent replay) cannot return the same replacement token because only its hash is stored — so it would have to reject _without_ revoking, which is precisely the hole a thief racing the real user would walk through. Clients must serialise their own refreshes.                                                                                                                                                                                                                          |
| Verified, not assumed               | The read-then-write version of the claim was **actually implemented and tested**                                              | It passed every sequential test and forked the family under `Promise.all`. It also left the "exactly one wins" status assertion passing on three consecutive runs — so that test now asserts the session **row count**, which is the real invariant, rather than a status pair that only sometimes appears.                                                                                                                                                                                                                                                                                                                                   |
| Atomicity of the rotation           | Claim and replacement insert share **one transaction**                                                                        | If the insert failed after the claim committed, the caller would hold a just-consumed token with no replacement ever issued — logged out by an infrastructure blip with no recovery but signing in again. Atomicity means a failure leaves the old token valid and retryable.                                                                                                                                                                                                                                                                                                                                                                 |
| Family revocation vs. rollback      | The service returns a **discriminated union** from the transaction instead of throwing inside it                              | Throwing would roll back — exactly wrong for the reuse path, whose entire purpose is to _commit_ a revocation and then reject. Diagnosis and revocation happen in a separate step that commits before throwing.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Session lifetime                    | The replacement **inherits the parent's `expiresAt`** — the window does not slide                                             | A family dies a fixed interval after the login that created it, however often it is rotated. A sliding expiry would let a stolen token be refreshed indefinitely, so a thief who never misses a rotation window would never be forced out. **Cost: an active user re-authenticates on that schedule.** One line to change if a product decision goes the other way.                                                                                                                                                                                                                                                                           |
| Error surface                       | One `InvalidRefreshToken` (401, `INVALID_REFRESH_TOKEN`) for **every** failure                                                | Unknown, malformed, expired, revoked-by-logout, revoked-by-family-compromise, already-consumed, deactivated user, wrong store — all identical. A distinct `TOKEN_EXPIRED` would confirm to an attacker that a stolen token was _real_; a distinct `TOKEN_REVOKED` would tell them their theft had been detected, which is exactly when you want them to learn nothing and keep replaying into a log you are watching. Mirrors `InvalidCredentials`.                                                                                                                                                                                           |
| Malformed vs. unknown token         | Both **401**, not 400                                                                                                         | Validation bounds length only (`1..512`) and deliberately does **not** pin the 43-character generated format. Pinning it would make a malformed token a 400 while an unknown one is a 401 — telling an attacker which of their guesses had the right shape.                                                                                                                                                                                                                                                                                                                                                                                   |
| Authorization claims                | Re-read from `app_user` on **every** refresh, never carried from the old token                                                | A staff member demoted mid-session loses `isStaff` on their next refresh. This is what makes the 15-minute access token the actual bound on stale privilege.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Deactivated users                   | Cannot refresh                                                                                                                | Suspension must take effect at the refresh boundary, or a 30-day token would make it meaningless for a month. Reported as the same opaque 401.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `passwordHash` on this path         | A third projection, `SUBJECT_COLUMNS`, which omits it                                                                         | Refresh proves possession of a token, not knowledge of a password, so the hash has no reason to be in memory here at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Plaintext tokens                    | **Never stored.** PostgreSQL holds a SHA-256 hex digest only                                                                  | A database dump, replica, or backup then yields no usable sessions. Enforced by the compiler, not by review: every repository signature accepts `RefreshTokenHash`, so passing a raw token is a type error. Asserted directly by a test that queries the table _by the raw token_ and finds nothing.                                                                                                                                                                                                                                                                                                                                          |
| Tokens in logs                      | Neither the raw token **nor its hash** is ever logged                                                                         | The raw token is an obvious credential. The hash is less obvious and just as dangerous: it is a working lookup key for the session table, and log stores are read by more people than the database. Logs carry `storeId`, `userId`, `sessionId`, `familyId`, `revokedCount`.                                                                                                                                                                                                                                                                                                                                                                  |
| Log levels                          | `error` for reuse detection; `info` for unknown, expired, and revoked                                                         | Only reuse is an incident. Random 43-character strings arriving at a public endpoint is background noise, and paging on it would train people to ignore the alert that matters.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Consumed checked **before** revoked | Load-bearing order                                                                                                            | After a family revocation a replayed token is both. Checking `revokedAt` first would classify a genuine replay as routine and skip the security log — so the second and third replays of a stolen token would go unrecorded, which is exactly when someone is watching.                                                                                                                                                                                                                                                                                                                                                                       |
| Expiry is not a theft signal        | An expired, unconsumed token is rejected **without** revoking the family                                                      | Expiry proves nothing about whether a token leaked. Revoking here would log people out for leaving a tab open over a holiday.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Rate limiting                       | **Per-IP only**, own bucket (`refresh:ip`), own policy: `AUTH_RATE_LIMIT_REFRESH_IP_MAX=60`/min                               | No per-email limiter: the request carries no email, so there is nothing to key on — and guessing a 256-bit token is not a threat a counter defends against. What the per-IP limit does defend is write amplification from a client, or an attacker holding one stolen token, spinning rotations as fast as the network allows. Deliberately **6x the login limit**: refresh is a scheduled background call, so one NAT gateway legitimately produces far more refreshes than logins, and reusing login's limit would break the largest customers first and present as a random logout. Reuses `rateLimitByIp` verbatim — no new limiter code. |
| `replacedBySessionId` column        | **Not added**                                                                                                                 | `familyId` already groups the chain, which is all revocation needs. A parent-to-child pointer would only add a forensic convenience, and the instruction was to add columns only if genuinely required.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 20. Phase 1 increment 6 — logout (and the authentication middleware)

Adds `POST /api/v1/auth/logout`. **No migration was needed.** `revoked_at` and `revoked_reason` already existed.

**This increment pulled the authentication middleware forward.** Logout must identify the caller from a verified token, and `requireAuth` did not exist — `src/http/types.ts` had declared `req.user` as "set by the auth middleware in a later step" since Phase 0. The endpoint is impossible without it, so `src/http/middleware/auth.ts` was written here. It consumes the existing `tokens.verifyAccessToken` and invents no transport. Authorization (scope derivation from `isStaff`/`isSuperuser`) remains a later increment.

| Decision                                             | Choice                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access tokens stay valid until `exp`**             | Logout revokes refresh capability **immediately**; the presented access token keeps working for up to its remaining TTL (15 min default)                        | Stated plainly rather than papered over. Access tokens are stateless RS256 — the server holds no record of an issued one, so it cannot recall it. Making logout instantaneous requires a per-request revocation lookup (a `sid` denylist in Redis, which `tokens.ts` already anticipates), and that puts a network dependency in front of _every_ authenticated route. That is a real architectural change, not a detail to smuggle in as a side effect of building logout. **What logout guarantees is that no NEW access token can be obtained.** Clients must discard both tokens locally; the OpenAPI description says so explicitly. |
| Revoke, never delete                                 | Rows are stamped with `revoked_at` and `revoked_reason`                                                                                                         | Two reasons. The row is the audit record — who signed out, when, from which family. And reuse detection depends on it: a _deleted_ row would make a later replay of that token look merely unknown, so a genuinely stolen token could never be flagged. Deletion is the sweeper's job, on expiry, not logout's.                                                                                                                                                                                                                                                                                                                           |
| Family-scoped, not user-scoped                       | Revokes only the family behind the caller's session                                                                                                             | This is what "log out" means to the person pressing the button: a phone signing out must not sign out the laptop. "Sign out everywhere" is a _different feature_, and conflating them makes the destructive option the only option. Asserted by test: two independent sign-ins, logging out one leaves the other refreshing successfully.                                                                                                                                                                                                                                                                                                 |
| Session id from the **verified JWT**, never the body | `sid` claim via `requireUser(req)`                                                                                                                              | The claim is signed, so a caller can only ever log out the session they actually hold. A body-supplied session id, family id, or refresh token would let any authenticated caller revoke other users' sessions by guessing or observing an id — a one-line denial-of-service, which the store predicate alone would _not_ stop because ids are unique within a store.                                                                                                                                                                                                                                                                     |
| No request body at all                               | The endpoint reads nothing from the request                                                                                                                     | Not merely "we ignore it": accepting and ignoring a field invites a client to depend on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Idempotent                                           | Second logout returns 204 again                                                                                                                                 | The `revoked_at IS NULL` predicate means a repeat matches zero rows. A client retrying after a dropped response must not see an error, and the original `revoked_at` timestamp is not overwritten.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Identical response either way                        | 204 whether rows were revoked or none were                                                                                                                      | A count in the body, or a 404 for an already-revoked session, would tell a caller whether their family was still live — making the endpoint a probe for whether a stolen token had been revoked. Nothing about session state is disclosed.                                                                                                                                                                                                                                                                                                                                                                                                |
| Response status                                      | **204 No Content**                                                                                                                                              | The project has no `{ "success": true }` convention to follow, and there is no useful body to return.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Repository shape                                     | One statement: `UPDATE ... WHERE store_id = $1 AND family_id IN (SELECT family_id FROM refresh_session WHERE id = $2 AND store_id = $1) AND revoked_at IS NULL` | Keyed by session id because that is all the token carries; the family is derived server-side. A read-then-write would add a round trip and need the read store-checked separately.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Store isolation                                      | The store predicate appears in **both** the subquery and the outer update                                                                                       | **Verified by mutation, and the result corrected a claim.** Removing _either_ predicate alone leaves the isolation test passing, because each independently blocks the write — so this is genuine defence-in-depth rather than one guard plus dead code. Removing **both** makes the test fail (1 row revoked instead of 0), so the test is not vacuous.                                                                                                                                                                                                                                                                                  |
| Cross-store access tokens                            | `requireAuth` rejects a token whose `storeId` claim differs from the resolved store                                                                             | `storeId` is signed, so a client cannot edit it — but nothing stops them presenting a valid store-A token to store B. Without the check the token authenticates while every downstream query is scoped to the wrong tenant. Reported as `AUTHENTICATION_REQUIRED`, because "valid, just not here" confirms the token is real. Mutation-tested: disabling the check fails the isolation test.                                                                                                                                                                                                                                              |
| Ancestor tokens can still log out                    | A `sid` naming an already-consumed session still resolves its family                                                                                            | A client holding a slightly stale access token must still be able to sign itself out. This is why the repository derives the family rather than requiring the session to be live.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Missing header vs. bad token                         | `AUTHENTICATION_REQUIRED` (no credential) vs. `INVALID_ACCESS_TOKEN` (token present, did not verify)                                                            | A safe and useful distinction: "you sent nothing" tells an attacker nothing they did not already know, and it separates a client that forgot the header from one whose token expired — different bugs to fix. Every failure involving an actual token value stays opaque; the specific reason is logged at debug only.                                                                                                                                                                                                                                                                                                                    |
| `revoked_reason` values stay distinct                | `logout` vs. `rotation_reuse`                                                                                                                                   | A later reuse cannot relabel a deliberate sign-out, because `revokeFamily` only touches rows where `revoked_at IS NULL`. Overwriting would make the audit trail actively misleading — reporting a normal sign-out as a security incident. Asserted both directions by test.                                                                                                                                                                                                                                                                                                                                                               |
| Not marked consumed                                  | Logout sets `revoked_at` only                                                                                                                                   | Consumed means "spent by a rotation"; revoked means "withdrawn". Conflating them would make a logged-out token look _replayed_ and trigger a spurious reuse incident on its next presentation.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| No rate limiting                                     | Deliberately none                                                                                                                                               | Consistent with the existing policy: the limiters guard **unauthenticated** endpoints that run Argon2. Logout needs a valid signed token to reach at all and performs one indexed UPDATE. A caller spamming it is revoking their own already-revoked session — one query, no effect.                                                                                                                                                                                                                                                                                                                                                      |
| No configuration added                               | None required                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Logging                                              | `logout_succeeded` at `info`, with `storeId`, `sessionId`, `revokedCount`                                                                                       | Routine user-initiated event, not a warning. Neither the token nor its **hash** is logged — the hash is a working lookup key for the session table, and log stores are read by more people than the database. Asserted by a test that captures real logger output.                                                                                                                                                                                                                                                                                                                                                                        |
| `AuthenticatedUser.scopes`                           | **Removed**, not populated with `[]`                                                                                                                            | It was a Phase 0 placeholder. Nothing derives scopes yet, and a declared-but-always-empty permission list is worse than an absent one: a handler could plausibly write `if (user.scopes.includes('admin'))` and get a silent, permanent `false`. It returns with the role-authorization increment.                                                                                                                                                                                                                                                                                                                                        |
| `createIdentityRoutes` deps                          | `tokens` and `logger` are **required**, not optional                                                                                                            | An authenticated endpoint that silently mounted without verification would be an open door. Making them required broke five existing test call sites, which were updated — the correct trade.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 21. Phase 1 increment 8 — `GET /api/v1/users/me`

Adds the authenticated user's own profile endpoint. **No migration. No new repository method. No new DTO. No new dependency.**

Increment 5 already left `findSubjectById` in place, and it happened to be exactly right for this: store-scoped in the query itself, `deleted_at IS NULL`, `isActive` selected for the domain check, and a projection that never touches `passwordHash`. Adding a near-duplicate `findPublicUserById` would have been a second name for the same query.

| Decision                                          | Choice                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database, not JWT claims**                      | The response is read from `app_user` on every call                                                                                                  | The token proves WHO the caller is; the database decides WHAT they currently are. Those are different questions. An access token lives 15 minutes, so answering the second from the token means a name change, an email verification, or a marketing opt-out inside that window is silently ignored — and the client has no way to know it is showing stale data. Failure mode is invisible until it matters, which is the worst kind.                                                                                                                                                |
| **User id from the verified `sub` claim**         | No path, query, or body parameter, anywhere                                                                                                         | `me` is not a placeholder for an id. Enumeration is impossible _structurally_ rather than by validation: there is no parameter to validate, so there is no check to get wrong, and no authorization rule to forget when a future endpoint copies this one. Asserted by test — `?userId=`, `?id=`, `?email=`, and a GET body are all inert, and `GET /api/v1/users/{id}` 404s because it does not exist.                                                                                                                                                                               |
| Store id from the resolved store + verified token | `requireAuth` has already confirmed the token's `storeId` claim matches the resolved store, so the two cannot disagree by the time the service runs |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Public projection, not credentials-then-strip** | `SUBJECT_COLUMNS` never selects `passwordHash`                                                                                                      | "Never loaded" is a stronger property than "stripped before sending". A hash in memory can be logged, serialised into an error payload, or picked up by a future field-spreading bug; a hash that was never selected cannot. Asserted at the repository, not just at the response.                                                                                                                                                                                                                                                                                                    |
| Response mapper                                   | `toUserResponse`, the same one register and login use                                                                                               | One shape, one parser. A second slightly-different user response is how a client ends up with two code paths that disagree about whether `emailVerified` is a boolean or a timestamp.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Response envelope                                 | `{ "user": { … } }`, matching the registration response                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Inactive, soft-deleted, hard-deleted, wrong-store | All four → `AUTHENTICATION_REQUIRED` (401), identically                                                                                             | **A cryptographically valid token is not a valid account.** Signature, issuer, audience and expiry can all be fine while the account behind it is suspended or gone. 401 because the credential no longer identifies a usable identity and re-authenticating is the only remedy. Not 403 — that is "you may not", this is "you are not", and authorization is a later increment. Not 404 — a missing _self_ is an authentication problem, and 404 invites a client to treat it as a routing bug. Identical for all four so a caller cannot learn _why_ their account stopped working. |
| Logged-out sessions still return 200              | Deliberately unchanged from §20                                                                                                                     | Access tokens remain valid until `exp`; logout revokes refresh capability, not the outstanding access token. Making this 401 needs a per-request session-revocation lookup, which is a separate architectural change and explicitly out of scope. **The account check is not a session check** — a test asserts the 200 so this is documented behaviour rather than an oversight.                                                                                                                                                                                                     |
| Middleware                                        | `resolveStore` (already on the API router) → `requireAuth` → handler                                                                                | `resolveStore` is not mounted a second time; `requireAuth` depends on it having run in order to compare stores.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| No rate limiting                                  | Consistent with logout and with the existing policy                                                                                                 | The limiters guard unauthenticated endpoints that run Argon2. This needs a valid signed token to reach and does one primary-key read.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Verified by mutation**                          | Two guards, tested independently                                                                                                                    | Removing the store predicate from `findSubjectById` → the repository-level isolation test **fails**. A leaky response mapper alone leaks **nothing**, because the hash is never selected — so widening `SUBJECT_COLUMNS` _and_ leaking in the mapper was needed to make the leakage test fail, which it then does. Both layers are load-bearing, and neither is dead code.                                                                                                                                                                                                            |
| Store scoping tested at the repository            | `findSubjectById` is called directly, bypassing all middleware                                                                                      | If the predicate lived only in `requireAuth`, any future caller reaching the repository another way — a CLI command, an admin endpoint, a job — would leak across tenants. The guarantee has to be in the query, so the test asserts it there.                                                                                                                                                                                                                                                                                                                                        |
| Non-public columns                                | 10 named explicitly in the leakage test                                                                                                             | `passwordHash`, `storeId`, `isActive`, `isStaff`, `isSuperuser`, `phoneVerifiedAt`, `lastLoginAt`, `deletedAt`, `updatedAt`, plus `password_hash`. The public key set is also asserted as an **exact** set, which is what catches an _added_ field — the way a leak actually happens. Note there are no password-reset or verification-secret columns in the schema at all yet; nothing to leak because they do not exist.                                                                                                                                                            |
| Explicitly out of scope                           | No role authorization, scopes, profile editing, password change, account deletion, sign-out-everywhere, access-token denylisting                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 22. Phase 1 increment 9 — scope-based authorization

Adds `requireScope` / `requireAnyScope`. **No migration, no roles table, no new repository method, no new dependency.**

**THE RULE, and everything below follows from it:** authorization decisions use the scopes a guard read from the database. They never use the access token's `isStaff` / `isSuperuser` claims.

| Decision                                 | Choice                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where the read happens**               | In `requireScope`, **lazily** — not in `requireAuth`                                                        | `requireAuth` answers "who are you"; the guards answer "may you". Putting the read in `requireAuth` would charge _every_ authenticated route for a database lookup: `/users/me` would read the same row twice, and logout would gain a read it has no use for. It would also contradict §20, which built the middleware specifically to avoid "a dependency in front of every authenticated route". Only routes that gate on a privilege pay. Pinned by a test that counts loader calls and asserts **zero** on an authenticated-but-unscoped route. |
| **Database, not token**                  | Scopes derive from a fresh row on every scoped request                                                      | A token lives 15 minutes, so trusting its claims would leave a revoked administrator fully privileged for the rest of that window. Reading the row means a demotion takes effect on the caller's very next scoped request — and a promotion likewise, with no re-login. Same principle as `/users/me`: the token proves who the caller is, the database determines what they currently are.                                                                                                                                                          |
| **Token claims removed from `req.user`** | `AuthenticatedUser` no longer carries `isStaff` / `isSuperuser` at all                                      | The stronger form of "don't trust these for authorization". Nothing read them (verified before removing), so the cost was zero and the guarantee is now structural: a stale flag that cannot be _reached_ cannot be trusted by mistake. Same reasoning that removed the placeholder `scopes` in §20. The claims remain in the JWT — `tokens.ts` is unchanged — they are simply not surfaced.                                                                                                                                                         |
| Primary, not replica                     | The container binds the loader to `db`, not `replica`                                                       | Replica lag would leave a revoked administrator privileged for however long replication is behind — exactly the staleness this design eliminates.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **No implied hierarchy**                 | `superuser` does **not** grant `staff`                                                                      | The two columns are separate booleans. Quietly making one imply the other would invent a privilege relationship the domain has never stated — invisible until someone is granted more than an administrator intended. A deployment that wants the hierarchy sets both flags, which says so in the data rather than implicitly in a function.                                                                                                                                                                                                         |
| `scopes` optional on `req.user`          | Present only on routes that ran a guard                                                                     | The rule `req.validated`, `req.store`, and `req.user` all follow. A route that never asked about privileges reports `undefined`, not `[]` — an empty array would imply "checked, holds none", which is a different and false claim.                                                                                                                                                                                                                                                                                                                  |
| Error split                              | 401 for no/invalid token · 401 for inactive or deleted · **403 `PERMISSION_DENIED`** for insufficient scope | A suspended account is an authentication problem — the credential no longer identifies a usable identity — so 403 there would tell a suspended administrator they merely lacked a privilege, which is wrong and a misleading hint. Conversely 401 for a valid active user lacking a privilege would send a perfectly good client off to re-authenticate, which would succeed and change nothing.                                                                                                                                                     |
| 403 body names **required** scopes       | `details.missing`, never the caller's held scopes                                                           | Actionable for a client; enumerating what an account _has_ would leak its privilege shape to anyone who can provoke a 403. `requireAnyScope` reports the whole set, because any one would have sufficed and naming one would misstate the requirement.                                                                                                                                                                                                                                                                                               |
| Empty guard is a boot error              | `requireScope()` throws `InvariantViolation` at construction                                                | A guard with no scopes guards nothing, and is far more likely a spread of an empty array or a forgotten argument than a deliberate "any active user" check. Failing at construction beats silently admitting every caller.                                                                                                                                                                                                                                                                                                                           |
| Missing `requireAuth` → 500              | `requireUser` throws `InvariantViolation`                                                                   | A router mounted without its middleware is our bug. Reporting it as 401/403 would send someone to check permissions while the fault sits in the composition root.                                                                                                                                                                                                                                                                                                                                                                                    |
| Narrow port, not the repository          | `AuthorizationSubjectLoader`, mirroring `StoreResolver`                                                     | The HTTP layer stays ignorant of Drizzle, of `app_user`, and of which module owns users. Also makes the guards testable against a fake with no PostgreSQL.                                                                                                                                                                                                                                                                                                                                                                                           |
| **Verified by mutation**                 | Reintroducing the claims on `req.user` and deriving scopes from them fails **all three** demotion tests     | Both directions: a demoted user kept access (200 where 403 expected) and a promoted user was still denied (403 where 200 expected). The guarantee is tested, not asserted.                                                                                                                                                                                                                                                                                                                                                                           |
| Scope of this increment                  | Two scopes, no permission matrix, no resource-level rules                                                   | **No production route consumes these guards yet.** The authenticated endpoints today are logout and `/users/me`, and neither gates on a privilege — Phase 2 catalogue writes are the first real consumer. The shape is therefore a considered guess, kept deliberately minimal so there is less to unpick when a real admin surface arrives. The test suite mounts its own `/t/...` fixture routes rather than adding a fake admin endpoint to the application.                                                                                      |

## 23. Phase 1 increment 10 — architecture enforcement

Adds `.dependency-cruiser.cjs` and wires `depcruise` into `pnpm verify`. Scoped as Phase 0 Step 8, skipped at the time, and until now the layering of five modules was maintained entirely by hand.

**Rules were written first and the code was made to comply**, not the reverse. Every rule was verified to already hold before being written; the one that did not (`no-http-to-modules`) had its violation fixed rather than the rule weakened.

### The rules

| Rule                                                 | Enforces                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-circular`                                        | No dependency cycles                                                                                                                        |
| `no-http-to-modules`                                 | HTTP is a delivery mechanism; it depends on **ports**, never on a domain module                                                             |
| `no-modules-to-http`                                 | A service must be drivable from a CLI or a worker. Narrow exception for `*.routes.ts` / `*.resolver.ts`, which exist to adapt that boundary |
| `no-cross-module-imports`                            | Modules stay independently testable; they talk through the composition root or the outbox                                                   |
| `shared-is-the-base-layer`                           | `shared/` imports nothing above it                                                                                                          |
| `schema-only-in-repositories`                        | Only `*.repository.ts`, `db/`, and scripts touch `db/schema` — so store-scoping stays in one place                                          |
| `jose-only-in-token-service`                         | Algorithm pinning, key handling, and the claim contract cannot drift                                                                        |
| `argon2-only-in-password-module`                     | One password policy, not a second unreviewed one                                                                                            |
| `container-only-from-entry-points`                   | No service locator                                                                                                                          |
| `no-orphans`, `not-to-dev-dep`, `no-deprecated-core` | Hygiene                                                                                                                                     |

Each carries a prose `comment` naming the violation and the fix, so a failure six months from now reads as `error no-http-to-modules: src/http/middleware/auth.ts → src/modules/identity/tokens.ts` plus an explanation, rather than a rule id.

`depcruise` runs **before** `test` in `verify`: a static layering break should fail in seconds, not after Testcontainers boots.

### What the first run found

| Finding                                                     | Resolution                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `http/middleware/auth.ts` → `modules/identity/tokens.ts`    | Fixed with an `AccessTokenVerifier` port, not by weakening the rule     |
| **A real cycle:** `auth.ts → types.ts → scope.ts → auth.ts` | `Scope` moved into `types.ts`, where the request contract already lives |
| `shared/events.ts` and `http/types.ts` reported as orphans  | Symptom of a config error — see `tsPreCompilationDeps` below            |

### Three things that were nearly wrong, and how they were caught

**1. `tsPreCompilationDeps` — the rules were almost vacuous.** Without it dependency-cruiser analyses imports _after_ TypeScript erases types. The single real violation this increment found was an `import type`, so it left no runtime edge: `no-http-to-modules` would have reported a clean codebase while the dependency sat in the source. The same setting explains the phantom orphans — both files export only types, so post-erasure nothing imports them. Enabling it took the graph from 180 edges to 265.

**2. The `jose` and `argon2` rules matched nothing.** `path: '^jose$'` never fires, because dependency-cruiser matches the **resolved** path — `node_modules/.pnpm/jose@6.2.10/node_modules/jose/dist/types/index.d.ts`. Both rules were repointed at `/node_modules/jose/`. Found by deliberately importing `jose` into middleware and watching the run stay green; every rule was then probed the same way, and each produced its named error.

**3. A pre-existing flaky test, surfaced by this run.** `pnpm verify` failed on a tampered-token assertion in `current-user.integration.test.ts` — **not** a regression from this increment. The test flipped the _last_ base64url character of an RS256 signature. A 256-byte signature is 342 base64url characters and 256 = 85·3 + 1, so the final group encodes one byte across two characters with four bits unused: **15 of 63** alternative final characters decode to an identical signature. Measured over 200 random signatures, the "tampered" token was byte-identical **27%** of the time, and verified correctly. The same mistake existed in `logout.integration.test.ts`. Both now flip the _first_ character of the signature, which carries six significant bits — 0% no-op over the same 200 trials. (A third instance in `refresh-token.test.ts` tampers a hex digest, where every character is four significant bits, and is sound.)

### Supporting changes

- `eslint.config.js`: `.cjs` added to the `disableTypeChecked` override (config files are in no tsconfig) plus a narrow CommonJS globals block, rather than loosening `no-undef` project-wide.
- `AccessTokenVerifier` returns `VerifiedIdentity` — `userId`, `storeId`, `sessionId` only. It deliberately omits `isStaff` / `isSuperuser`, moving §22's guarantee one layer earlier: the privilege claims cannot reach the authentication middleware at all, not merely `req.user`.

## 24. Phase 2 increment 11 — product foundation

Adds the catalogue module and `POST /api/v1/admin/products` — **the first production consumer of `requireScope`**, which until now existed with no caller.

Migration: `20260828093328_oval_eddie_brock.sql`, generated by `pnpm db:generate` and applied without manual correction.

### Entity ownership and shape

| Decision                                       | Choice                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module boundary                                | `src/modules/catalogue/` — repository, service, dto, routes, index                                                                                           | Mirrors `modules/identity`. The `product` table is imported by `catalogue.repository.ts` and nowhere else, enforced by `schema-only-in-repositories`.                                                                                                                                                      |
| One table                                      | `product` only                                                                                                                                               | Variants, inventory, categories, and media all belong to later increments. A row that anticipated them would encode guesses about their shape before anything consumes them.                                                                                                                               |
| `status` default `draft`                       | Creating a product never publishes it                                                                                                                        | A merchant filling in a form over several minutes must not have a half-finished listing visible between saves. The first public read endpoint will filter on `active` rather than trusting every row is fit to show.                                                                                       |
| `status` as `varchar` + CHECK, not a PG `enum` | Adding a value to a PG enum is a migration that cannot run in a transaction on older servers and cannot be reversed; widening a CHECK is an ordinary `ALTER` | The set will grow — `scheduled` is the obvious next one. Enforced in the database because the API is not the only writer: seeds, imports, and operators running SQL all bypass Zod.                                                                                                                        |
| `price` as `NUMERIC(19,4)`                     | Per §6. Accepted over the wire as a **string**                                                                                                               | JSON numbers are IEEE-754 doubles, so `19.99` has already lost precision before Zod sees it, and the error compounds into every later sum. A JSON number is rejected outright rather than coerced.                                                                                                         |
| **No `currency` column**                       | The store is the currency aggregate; `store.currency` already exists                                                                                         | Duplicating it lets a product's currency drift from the store selling it. The response returns the store's currency for reference. Multi-currency pricing is a real feature with its own table, not a column to add speculatively — a test asserts the column's absence so adding one is a deliberate act. |
| Price normalised through `Money`               | `money()` then `toDb()` before insert                                                                                                                        | Zod proves the shape; `Money` proves it is a real decimal and renders it at the column's scale, so `19.9` and `19.9000` cannot become two rows that compare unequal as text.                                                                                                                               |
| `description` defaults to `''`, not NULL       | There is no meaningful difference between "no description" and "an empty one" for a storefront, and nullable would make every consumer handle both.          |

### Store isolation

|                    |                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Unique index       | `(store_id, slug) WHERE deleted_at IS NULL`                                                                 | **Per store, not global.** A global unique index on `slug` would let the first merchant to claim `blue-shirt` block every other merchant on the platform. Partial, so deleting a product frees its slug — matching `uq_user_email_active`. |
| `storeId` source   | `req.store` only                                                                                            | The DTO has no `storeId` field at all, so `strictObject` rejects one with a **400** rather than ignoring it. Two defences: the schema makes it unreachable, the route makes the source unambiguous.                                        |
| Scoping location   | In the repository's `WHERE`, not the service or route                                                       | A future caller arriving from a CLI command or an import job inherits the same isolation. Asserted by calling `findBySlug` directly with all middleware bypassed.                                                                          |
| Cross-store tokens | Rejected by `requireAuth` before authorization or the handler runs, and nothing is written to either store. |

### Authorization

`resolveStore → requireAuth → requireScope('staff') → validate → handler`

- **`staff`, not `superuser`** — the schema documents `isStaff` as granting "access to the admin API surface at all". §22 established no hierarchy, so a superuser is _not_ implicitly staff; picking the wrong scope is a silent, total lockout of the intended audience.
- **`requireAuth` untouched.** The lazy model from §22 stands: the authorization read happens only in the guard, so unscoped routes still cost one query.
- **Authorization runs BEFORE validation.** An unprivileged caller must not be able to enumerate an admin endpoint's fields through validation error messages. The authorization read is one indexed query; ordering it first costs nothing worth saving.
- Cross-module wiring: the catalogue **cannot import identity** (`no-cross-module-imports`), so the composition root hands it an `AccessTokenVerifier` port and a pre-built `requireScope('staff')` handler. The module declares which privilege it needs; the root knows where privileges are read from.

### Verified by mutation

| Mutation                                                         | Result                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Store predicate removed from `findBySlug`                        | **2 tests fail**                                                         |
| `requireScope('staff')` removed from the route                   | **5 tests fail**                                                         |
| `requireAuth` removed from the route                             | **6 tests fail** — the guard errors loudly rather than silently allowing |
| Container wires `requireScope('superuser')` instead of `'staff'` | **1 test fails** — see below                                             |

### Two findings worth recording

**1. A gap the module suite could not see.** Swapping `requireScope('staff')` for `requireScope('superuser')` in the composition root left all 28 catalogue tests passing, because that suite builds its own router wiring. _Which_ scope a production route demands is a property of the container and has to be asserted there — the same class of hole closed for rate limiting in §18. A container test now signs in a **staff** user (deliberately not a superuser) and asserts a 201.

**2. The container suite was independent only by accident.** It has no `beforeEach` truncate, and `seedTestStore` re-seeds by deleting stores. `store` is referenced with `ON DELETE restrict`, so the first test to leave a child row behind breaks every later test's seed with a foreign-key violation. Nothing had written a child row until this increment did. `afterEach` now truncates, which makes the independence real rather than incidental.

### Deferred, deliberately

Variants · inventory · categories · images · search · pagination · pricing rules · multi-currency · **public reads** · update · delete · publish workflow · bulk import.

This increment is write-only: a product can be created and not yet read back through the API. Persistence is verified against the database directly. `GET /api/v1/products/:slug` is the natural next increment and will be the first consumer of `status = 'active'`.

## 25. Phase 2 increment 12 — public product read

Adds `GET /api/v1/products/:slug`. **No migration** — the increment needed no schema change, and inspection confirmed the existing columns and the `ix_product_store_status` index already serve the query.

| Decision                                        | Choice                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visibility enforced in the repository query** | All four predicates — `store_id`, `slug`, `deleted_at IS NULL`, `status = 'active'` — are in the `WHERE` clause | Not a style preference. Fetching a row and then deciding whether to return it means a draft price or an archived name is in application memory, where it can be logged, serialised into an error payload, or returned by a later refactor that forgets the check. **A row the query never selected cannot leak.** It also lets PostgreSQL use `ix_product_store_status` rather than reading a row it will discard. Asserted at the repository, not only through HTTP, because "never selected" is a stronger property than "filtered afterwards" and is only observable there.                                        |
| Separate `findPublicBySlug` from `findBySlug`   | Two methods, not one with a flag                                                                                | They answer different questions. A draft's slug **is** taken for conflict purposes, so the admin create path must see it; a storefront must not. One method with a boolean would put both behaviours one wrong argument apart. A test asserts the admin lookup still finds a draft.                                                                                                                                                                                                                                                                                                                                   |
| `PUBLIC_PRODUCT_STATUS` named once              | A constant, not an inline `'active'`                                                                            | A second literal in a later read method is how two endpoints end up disagreeing about what "published" means.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Everything invisible collapses to one 404**   | Unknown slug, another store's product, draft, archived, and soft-deleted all return an identical body           | A distinct 403 for a draft would confirm the product exists, letting a competitor enumerate an unreleased range before launch by probing candidate slugs. A distinct 410 for an archived one would reveal what a merchant had withdrawn. Neither is information a storefront visitor is entitled to, and hiding it costs nothing. The test compares response **bodies to each other**, not just statuses — a status-only check would pass against an implementation that leaked the difference through the message.                                                                                                   |
| **Intentionally unauthenticated**               | No `requireAuth`, no `requireScope`                                                                             | A storefront and a search-engine crawler must both read the catalogue, and neither can hold a token. Requiring one would add no security — the data returned is exactly what the merchant chose to publish — it would only make the catalogue unreachable. The absence of auth is part of the contract, so the test suite wires the router with a verifier and a guard that **throw if invoked**: an auth guard appearing on this route fails loudly rather than silently changing the contract.                                                                                                                      |
| `resolveStore` still runs                       | Mounted on the API router                                                                                       | It is what makes the endpoint multi-tenant: the same slug resolves to a different product, or to nothing, depending on the store. An unseeded deployment gets **503**, not 404 — an operational fault, not a client error.                                                                                                                                                                                                                                                                                                                                                                                            |
| Malformed slug → **400**, not 404               | The established `validate()` convention                                                                         | Not a visibility leak: the slug pattern is published in the OpenAPI document, so a caller learns nothing the spec does not already state. What must never differ is the answer for a **well-formed** slug, whatever the reason it is invisible.                                                                                                                                                                                                                                                                                                                                                                       |
| Slug normalised in the param schema             | Reuses `slugField`, so trim + lowercase                                                                         | A URL is normalised exactly as the create endpoint normalised the stored value. If these diverged, a product created as `blue-shirt` could be unreachable at the URL the merchant was shown. A slug differing only in case resolves to the same product.                                                                                                                                                                                                                                                                                                                                                              |
| **One shared response shape**                   | `ProductResponse` gained `updatedAt`; both endpoints use the same mapper                                        | The requested response listed `updatedAt` and omitted `currency`, while the existing shape had the reverse. Rather than fork into two near-identical product shapes — which is how a client ends up with two parsers that disagree, and how a field added for an admin response silently reaches the public one — the single shape was **extended**. `currency` was kept: a price string without a currency is ambiguous, and removing it would break the create response for no gain. Everything in the shape is safe for an anonymous caller, which is what makes sharing it correct rather than merely convenient. |
| Slug logged on a 404                            | Unlike an email on the auth paths                                                                               | A slug is public by construction — it appears in URLs, sitemaps, and search results — so recording it discloses nothing while making "which links are broken" answerable. `info`, not `warn`: a storefront 404 is routine, and paging on it would train people to ignore the log.                                                                                                                                                                                                                                                                                                                                     |

### Mutation verification

| Probe                                                | Result            |
| ---------------------------------------------------- | ----------------- |
| A — remove `status = 'active'`                       | **5 tests fail**  |
| B — remove the store predicate                       | **4 tests fail**  |
| C — remove `deleted_at IS NULL`                      | **4 tests fail**  |
| D — add `requireAuth` to the public route            | **14 tests fail** |
| D2 — add `requireScope('staff')` to the public route | **14 tests fail** |

No probe passed unexpectedly, so no coverage gap had to be closed.

### Deferred, deliberately

Product lists · pagination · search · admin reads · draft preview · update · delete · publish endpoint · variants · inventory · categories · images · pricing rules · multi-currency.

A merchant can now create a product and a storefront can read it, but nothing can yet change a product's status through the API — so `active` products must currently be created as such. A publish endpoint is the natural next increment.

## 26. Phase 2 increment 13 — product lifecycle

Adds `POST /api/v1/admin/products/{slug}/publish` and `.../archive`. **No migration** — the existing `status` column and its CHECK constraint already carried every value needed.

### 1. Why explicit actions rather than `PATCH .../status`

Decided by inspection, not preference. Three findings:

- **The project has no `PATCH` or `PUT` route anywhere.** Every mutation is a `POST`, and the two existing state-changing endpoints — `/auth/logout`, `/auth/refresh` — are already action verbs rather than resource updates.
- **`InvalidStateTransition` already existed**, unused in production since Phase 0, with the exact shape `{entity, from, to}`. The error was built for this.
- **Actions are the smaller surface.** No request body at all, so no body schema, no "what if `status` is unknown", and no second place for the transition target to come from.

The deciding argument is what each design makes _impossible_. With `PATCH {status}`, `{"status":"draft"}` is a request the server must accept, validate, and refuse — an unpublish is expressible and merely rejected. With action endpoints there is no route to call, so it is **unrepresentable**. That is the same reasoning that removed `isStaff` from `AuthenticatedUser` (§22) and kept `storeId` out of the create DTO (§24): make the wrong thing unreachable rather than guarded. A test asserts `/unpublish`, `/draft`, and `/status` all 404.

### 2. Allowed transitions

| Action    | From                | To         |
| --------- | ------------------- | ---------- |
| `publish` | `draft`, `archived` | `active`   |
| `archive` | `active`            | `archived` |

Held as data in `PRODUCT_TRANSITIONS`, so the lifecycle is one object to read rather than logic spread across two methods. There is deliberately **no transition back to `draft`**.

### 3. Archived products ARE restorable

`publish` accepts `archived` as a source. Archiving is currently the only way to remove a product from a storefront — there is no delete endpoint — so a terminal `archived` would let one mis-click destroy a listing with no recovery path in the API. Nothing in the domain says archived is final, and supporting restoration costs one extra value in a `from` array.

`draft → archived` is **not** supported: a draft is already invisible to customers, so there is nothing to withdraw.

### 4. Atomic transition, not read-then-write

The precondition is part of the `UPDATE` predicate:

```sql
UPDATE product SET status = $to, updated_at = $now
WHERE store_id = $1 AND slug = $2 AND deleted_at IS NULL AND status IN ($from)
RETURNING ...
```

PostgreSQL takes the row lock, so two concurrent publishes serialise: the second re-evaluates the predicate after the first commits and matches nothing. A read-then-write would let both observe `draft` and both report success — two independent state changes where only one occurred.

**Verified, and the verification corrected a claim.** Replacing the atomic update with a read-then-write left the _HTTP-level_ concurrency test passing — two `Promise.all` requests through supertest do not reliably overlap. Only the **repository-level** test caught it, by receiving two rows instead of one. Both tests are kept, with comments stating plainly which one proves atomicity and which only asserts the contract. This is the second time this pattern has appeared; see §19.

### 5. Store isolation

`store_id` is in the same `UPDATE` predicate — the write cannot touch another tenant's row, enforced by the database rather than by a comparison the service performs afterwards. Asserted by calling the repository directly with a foreign store id and confirming the row is untouched.

### 6. Distinguishing "not found" from "invalid transition"

The update returns nothing for four different reasons. A second, **store-scoped** lookup (`findBySlug`, which already existed for the create path's conflict check) runs only on the failure path and separates them:

| Situation                                             | Response                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| No such slug · another store's product · soft-deleted | **404 `NOT_FOUND`**, identical for all three                             |
| Exists in this store, wrong source status             | **409 `INVALID_STATE_TRANSITION`**, with `details.from` and `details.to` |

Cross-store collapses into 404 deliberately: `NotFound`'s own contract is that ownership belongs in the query, so a 403 would confirm the product exists in another tenant. The extra lookup cannot leak, because it is store-scoped too.

Reporting the current status in the 409 is safe here in a way it would not be on the public read (§25): this endpoint already requires the `staff` scope, and an administrator is entitled to know their own catalogue's state. It costs one indexed read on the failure path only.

An invalid transition is a **409, never a silent 200**. Reporting success for a no-op would tell a caller their request changed something when it did not, and would hide a double-submit rather than surface it.

### 7. Lifecycle drives public visibility

The actions are only meaningful through their effect on `GET /api/v1/products/{slug}`, so that is what the tests assert — publishing makes a 404 become 200, archiving reverses it. Checking the `status` column alone would pass against an implementation that wrote a value the public read does not recognise; mutation F (publish writes `draft`) fails 7 tests for exactly that reason.

### 8. Deferred

Generic product editing · deletion · listing · pagination · search · variants · inventory · categories · images · pricing rules · multi-currency · public drafts · admin product reads · scheduled publishing.

A `scheduled` status is the obvious next lifecycle value, and §24 already chose a `varchar` + CHECK over a PG enum so adding one is an ordinary `ALTER`.

## 27. Phase 2 increment 14 — admin product read

Adds `GET /api/v1/admin/products/{slug}`, returning a product in any lifecycle status. **No migration**, and **no new repository method**.

| Decision                                                  | Choice                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reuse `findBySlug`                                        | No fourth query added                                                     | It already had exactly the required semantics — `store_id` + `slug` + `deleted_at IS NULL`, no status filter — because the create path's conflict check and the lifecycle diagnosis both need it. A new near-identical method would have been a second place for the tenancy predicate to drift. Its docblock now states the any-status property explicitly, since a third caller depends on it. |
| A clearly named **service** method                        | `getProductForStaff`, beside `getPublicProduct`                           | The audience, not the predicate, is what a call site should read. Two named methods mean the visibility rule is chosen by picking a name rather than by remembering to pass a flag — the same reasoning that kept `findBySlug` and `findPublicBySlug` separate in §25.                                                                                                                           |
| Same authorization boundary                               | `resolveStore → requireAuth → requireScope('staff') → validate → handler` | Identical to every other admin product route. No new pattern.                                                                                                                                                                                                                                                                                                                                    |
| Non-staff customer → **403**                              | Deliberately different from the cross-store 404                           | The caller is a legitimate customer of _this_ store; the product is not hidden from them by tenancy, they simply may not use an admin endpoint. Answering 404 would misreport a permission problem as a missing resource.                                                                                                                                                                        |
| Cross-store, deleted, unknown → **404**, identical bodies | Staff privilege is scoped to a store                                      | Confirming a product exists in another tenant's catalogue would leak across the boundary. `NotFound`'s own contract is that ownership belongs in the query rather than a check afterwards. Asserted body-to-body, not just by status.                                                                                                                                                            |
| Soft-deleted stays invisible **even to staff**            | `deleted_at IS NULL` in the query                                         | Deleted means gone. A resurrection path would need to be a deliberate feature, not a side effect of an admin read. Tested with a row that was `active` before deletion, so both predicates must hold.                                                                                                                                                                                            |
| One shared `ProductResponse`                              | Unchanged; no admin-only fields                                           | Five endpoints now return the same nine keys through one mapper. The exact-key-set assertion in this suite is what stops an admin-only field being added on the quiet.                                                                                                                                                                                                                           |

### The property that distinguishes this endpoint

One test asserts both reads in the same case: for the same slug in the same store, a draft is **200 for staff and 404 for the storefront**. A suite copied from the public read would get this backwards, and an implementation that reused `findPublicBySlug` fails it — which mutation C confirmed, taking 9 of 18 tests with it.

### Mutation verification

| Probe                                                 | Tests failed |
| ----------------------------------------------------- | ------------ |
| Remove the store predicate                            | 2            |
| Remove `deleted_at IS NULL`                           | 2            |
| Admin lookup becomes active-only (`findPublicBySlug`) | 9            |
| Remove `requireScope('staff')`                        | 2            |
| Remove `requireAuth`                                  | 18           |

None passed unexpectedly, so no coverage gap needed closing.

### Coverage not duplicated

Repository-level properties were already asserted elsewhere and are not repeated: cross-store scoping of `findBySlug` in `create-product.integration.test.ts`, and its any-status behaviour in `public-product.integration.test.ts`. This suite covers the HTTP surface those two do not.

Each catalogue suite still builds its own router, following the convention the other three established. Extracting a shared harness would touch four files and is a refactor, not part of this increment.

### Deferred

Admin product **listing** · pagination · search · generic editing · deletion · variants · inventory · categories · images · pricing rules · multi-currency.

Listing is the obvious next increment and the first that will need pagination — which is why it was kept out of this one.

## 28. Phase 2 increment 15 — admin product listing with pagination

Adds `GET /api/v1/admin/products`. **No migration, and no index.**

### The pagination contract, and why it is new

Inspection found **no existing pagination convention** — the only `limit`/`offset` in the codebase were internal outbox batch sizes (`listPending`, `reclaimStale`), which are a queue-drain concern rather than an HTTP contract. So this increment establishes one.

```
GET /api/v1/admin/products?limit=20&offset=0
→ { "products": [ …Product ], "pagination": { "limit", "offset", "total" } }
```

| Decision                                | Choice                            | Why                                                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offset, not cursor                      | `limit` + `offset` + `total`      | The smaller thing that works. An admin catalogue is browsed by page number, and cursor pagination buys stability under concurrent inserts that nothing has asked for. Keyset pagination is the answer if a store ever has enough products for a deep offset to hurt. |
| Bounds                                  | default 20, max 100, `offset ≥ 0` |                                                                                                                                                                                                                                                                      |
| Over the maximum → **400, not clamped** | `?limit=101` is rejected          | Silently returning 100 rows would tell a caller their page size was honoured when it was not, and a client paging on `offset += limit` would then skip records with nothing to notice.                                                                               |
| Unknown query parameters → **400**      | `strictObject` on the query       | `?limitt=1` returning a default page of 20 looks like success while ignoring the caller's intent. It also makes `status`, `search`, `sort`, and `storeId` unreachable rather than merely unhandled — each is a later increment or, in `storeId`'s case, never.       |
| Response envelope                       | `{ products, pagination }`        | `pagination` is a nested object rather than four sibling keys, so a future field belongs somewhere obvious.                                                                                                                                                          |

### Ordering

`ORDER BY created_at DESC, id DESC` — newest first, with the id as a tie-breaker so the order is **total**: a row cannot appear on two pages or be skipped between them.

`id DESC` alone would in fact suffice, since UUIDv7 is time-ordered (§4). Naming `created_at` states the intent without requiring the reader to know that, and survives a future change of id scheme.

**No index was added.** Both existing product indexes lead with `store_id` (`uq_product_slug_active`, `ix_product_store_status`), so the filter is served as a prefix; neither provides this sort order, so PostgreSQL sorts the store's rows. That is adequate at the catalogue sizes this endpoint will see, and a dedicated `(store_id, created_at DESC, id DESC)` index is the obvious optimisation **once there is evidence it is needed**. Adding it now would be the speculative index this project has avoided elsewhere.

### The page and the total cannot disagree

The visibility predicate — `store_id = $1 AND deleted_at IS NULL` — is built **once** and shared by the page query and the `COUNT`. The classic paginated-endpoint bug is a total that counts rows the page can never show, and it happens because the two queries are written separately and then drift. Here they cannot drift independently, because there is only one predicate.

Every isolation assertion therefore checks **both**: a soft-deleted or cross-store product must be absent from the page _and_ uncounted in the total. Mutations I and J had to be applied by deliberately re-inlining a divergent predicate into the count — the shared expression makes that drift impossible to introduce by accident, and the tests catch it if someone does it on purpose.

### Status is not filtered

Draft, active, and archived are all returned. `listForStore` is store-scoped and soft-delete-aware but status-agnostic, matching `findBySlug` (§27) rather than `findPublicBySlug`. Mutation C — adding `status = 'active'` — fails 11 of 25 tests.

### Authorization

`resolveStore → requireAuth → requireScope('staff') → validate(query) → handler`, identical to every other admin product route. A **container-level** test asserts the real application route admits a staff user and refuses a plain customer, because the catalogue's own suites build their own router and would all keep passing if the composition root wired `requireScope('superuser')` — the gap first recorded in §24.

### Two findings, both caught by tests rather than by reading

**1. `z.coerce.number()` accepted an empty parameter.** `Number('')` is `0`, so `?offset=` passed validation and returned the first page. `?limit=` happened to fail only because its floor is 1 — the two parameters were consistent by accident. Replaced with a digits-only string parse (`^\d+$`) before coercion, which also rejects `-1`, `2.5`, `1e3`, and `0x10` with one rule.

**2. `.default()` on a `.pipe()` short-circuits.** It returns the raw default _without_ parsing it, so a string default came back as a string and `pagination.offset` was `'0'` instead of `0`. My assumption that the default would flow through the same parse as a real query value was simply wrong, and the exact-metadata assertion caught it. The default is now applied after the pipe via `.optional().transform()`.

### Mutation verification

| Probe                                         | Tests failed |
| --------------------------------------------- | ------------ |
| A — remove `store_id`                         | 2            |
| B — remove `deleted_at IS NULL`               | 1            |
| C — add `status = 'active'`                   | 11           |
| D — ignore `limit`                            | 3            |
| E — ignore `offset`                           | 4            |
| F — replace the ordering with an unstable one | 2            |
| G — remove `requireScope('staff')`            | 2            |
| H — remove `requireAuth`                      | 24           |
| I — remove `store_id` from the COUNT only     | 2            |
| J — remove soft-delete from the COUNT only    | 1            |

None passed unexpectedly.

### Deferred

Public product listing · search · filtering · arbitrary sorting · cursor/keyset pagination · a shared pagination framework · generic editing · deletion · variants · inventory · categories · images · pricing rules · multi-currency · bulk import · scheduled publishing.

The DTO helpers are deliberately local to the catalogue. A reusable pagination module should be extracted when a **second** endpoint needs one, not invented for the first.

## 29. Phase 2 increment 16 — admin product editing

Adds `PATCH /api/v1/admin/products/{slug}`. **No migration, no index.**

### The contract

```
PATCH /api/v1/admin/products/{slug}      staff scope required
{ "name"?: string, "description"?: string, "price"?: string }
→ 200 { "product": { …ProductResponse } }
```

**Editable:** `name`, `description`, `price` — any subset, at least one.
**Rejected with 400, not ignored:** `slug`, `status`, `storeId`, `currency`, `id`, `createdAt`, `updatedAt`, `deletedAt`, and any unknown field.

### The project's first PATCH, and why that is not a reversal of §26

§26 rejected `PATCH .../status` for the **lifecycle** and chose explicit `publish`/`archive` actions, because a state machine expressed as a settable field cannot enforce which transitions are legal. That reasoning is about transitions, not about verbs.

This is ordinary partial data editing: the fields are independent, any subset may be sent, and there is no transition to guard. PATCH is the correct verb for exactly that. Lifecycle stays on its explicit actions, and `status` is not settable here at all — so the two decisions are consistent rather than contradictory.

### Why slug and status are excluded

| Field    | Why not editable                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`   | It is the product's identity and its public URL. Renaming breaks every existing link and stored reference, and collides with the per-store unique index. A rename is a **redirect** problem — old URL, new URL, and what happens to the old one — not a field update. Its own increment. |
| `status` | Lifecycle has guarded transitions (§26). A settable `status` would be a second, unguarded path into the state machine, able to set any status from any other — including reviving an archived product without going through `publish`.                                                   |

**Enforced by the type, not by a check.** `EditableProductFields` names exactly three columns; it is deliberately _not_ `Partial<InsertProductValues>`, which would admit `storeId`, `slug`, and `status`. Passing one is a compile error. Widening that type is the only way to make another column editable, which is the friction that decision deserves.

### Validation semantics

- **Empty body → 400.** A PATCH that asks for nothing would bump `updated_at`, return 200, and leave a caller believing something changed. `.refine(Object.keys(body).length > 0)`.
- **`strictObject`**, so forbidden fields are unreachable rather than silently dropped, and the 400 names the field.
- **`description: ''` clears it; `null` is rejected.** An empty string is a value; `null` is a type error.
- **Price stays a string** and is normalised through `Money` exactly as on create, so `19.9` and `19.9000` cannot become two values that compare unequal as text.
- `name` and `description` were extracted into shared primitives (`nameField`, `descriptionField`) so create and update cannot drift. A PATCH accepting a 400-character name the create endpoint rejects would let a product reach a state it could never have been created in.

### Store isolation and soft delete

One atomic store-scoped `UPDATE` whose predicate is `store_id AND slug AND deleted_at IS NULL`. Cross-store, soft-deleted, and nonexistent all match nothing and produce the same 404 — asserted body-to-body, not merely by status. The boundary is the statement's; nothing is re-checked afterwards, so there is no second place for it to be got wrong.

The response is the **persisted** row from `RETURNING`, not an echo of the request. Those differ whenever a value is normalised, which is the only place the distinction is observable — and the reason the price test matters more than it looks.

### Findings

**1. A mutation survived, and it was the worst one.** Removing `slug` from the UPDATE predicate passed all 37 tests. Without it the statement matches every non-deleted row the store owns, so a PATCH to one product **silently rewrites the entire catalogue**. It was invisible because every test kept exactly one product in the store. Two tests were added — editing one of three products and asserting the siblings are untouched, and a 404 for an unknown slug in a store that _has_ products — and the mutation now fails both. Coverage gap closed before declaring the increment complete, not merely reported.

**2. A vacuous assertion I wrote.** The empty-body test compared the row to itself (`rowOf(id)` on both sides), which is true whatever the endpoint does. Rewritten to capture `updatedAt` before the request and compare after.

**3. The OpenAPI drift guard could not express PATCH.** It dispatched `get` or _else POST_, so a documented PATCH produced a POST to a path with none — a false failure — and would equally have passed a documented PATCH whose route was never mounted, as long as a POST existed there. Now dispatched by method name. Verified by removing the mounted PATCH and confirming the guard fails.

**4. A stale docblock from §28**, still describing `z.coerce.number()` after that approach was replaced. Corrected; reported rather than folded in silently.

### Concurrency

**Not claimed and not tested.** Two concurrent PATCHes to the same product are last-write-wins, and nothing here proves otherwise. That is honest rather than dismissive: field edits are independent and idempotent in a way lifecycle transitions are not (§26), so there is no invariant a race can break — no state machine to skip, no double-spend. Optimistic locking would be the tool if a merchant-facing conflict ever needs surfacing; no version column or ETag was added, because the existing project requires none.

### Deferred

Slug renaming and redirects · deletion · bulk edit · variants · inventory · categories · images · pricing rules · multi-currency · optimistic locking.

## 30. Phase 2 increment 17 — admin product deletion

Adds `DELETE /api/v1/admin/products/{slug}`. **No migration, no index.**

### The contract

```
DELETE /api/v1/admin/products/{slug}     staff scope, no request body
→ 204 No Content
→ 404 unknown slug · another store · already deleted
```

### Soft delete, and why

`deleted_at` already existed on `product` through the shared `softDelete` helper, whose docblock names this exact case: soft delete is _"for rows a merchant can delete but whose history must survive — a product that appears on past invoices."_ Order lines and invoices will reference products; a hard delete would either break those or force a cascade that rewrites history.

**This is the project's first write to a `deleted_at` column.** Eight read predicates already filtered on one — five in the catalogue, three in identity — but nothing had ever set one. Nothing else had to change for a deleted product to vanish: every catalogue query already filters `deleted_at IS NULL`, so the row simply stops matching. That is asserted end to end rather than assumed — the admin list (and its `total`), the admin read, the public read, `PATCH`, `publish`, and `archive` are all checked after a deletion.

### 204, and why not the product

204 No Content, matching logout — the only other endpoint in the project with nothing useful to return. Handing back a "product" that is invisible to every other endpoint a moment later would be a strange thing to return.

### Repeat delete is 404, NOT idempotent

The deliberate departure, and it is a departure from logout rather than from the catalogue.

Every other catalogue endpoint answers **404** for a deleted product. If `DELETE` answered 204 twice, it would contradict the 404 that a `GET` on the same slug gives an instant later. Logout (§20) is idempotent because it must not disclose whether a session was still live; there is no equivalent secret here, since the caller already holds the `staff` scope and can see the whole catalogue.

The `deleted_at IS NULL` predicate is what produces this: a second delete matches nothing. It also **preserves the original deletion timestamp**, which a blind re-stamp would destroy — asserted by a test.

### Store isolation and blast radius

One atomic statement: `UPDATE product SET deleted_at, updated_at WHERE store_id = $1 AND slug = $2 AND deleted_at IS NULL`.

The `slug` predicate is load-bearing in a way Increment 16 proved the hard way — a missing one there survived 37 tests because every test kept a single product, and here it would delete **the entire store's catalogue**. So every destructive case in this suite runs against a store holding several products and compares each survivor **column by column**, before against after, rather than checking only `deletedAt`.

### Lifecycle is untouched

Deletion does not change `status`. Archiving is a different operation with a different meaning — reversible (§26), and visible in the record as a merchant decision rather than a removal. Using `archived` as a stand-in would make the two indistinguishable; mutation G confirmed the tests reject it.

### Slug reuse

`uq_product_slug_active` is partial on `deleted_at IS NULL`, so deleting a product **frees its slug**. A merchant who deletes a mistake can recreate it at the same URL. That is a consequence of the index design rather than an accident, so it has a test.

### No migration or index

`deleted_at` exists. `uq_product_slug_active` is `(store_id, slug) WHERE deleted_at IS NULL` — precisely this statement's predicate, so it is already the ideal index. **No migration/index added.**

### Mutation verification

| Probe                               | Tests failed |
| ----------------------------------- | ------------ |
| A — remove `requireAuth`            | 22           |
| B — remove `requireScope('staff')`  | 2            |
| C — remove the `store_id` predicate | 4            |
| D — remove the `slug` predicate     | 5            |
| E — remove `deleted_at IS NULL`     | 2            |
| F — hard `DELETE` instead of soft   | 5            |
| G — archive as a deletion stand-in  | 11           |

None survived, so no coverage gap needed closing.

### Deferred

Undelete/restore · hard-delete sweeper for genuinely expired rows · cascading deletion of future related records (variants, media) · bulk delete.

There is deliberately **no undelete**. Restoring a product raises questions this increment cannot answer — whether its slug is still free, what happens to a replacement created in the meantime — and inventing an answer now would be a guess.

## 31. Phase 2 increment 18 — public product listing

Adds `GET /api/v1/products`. **No migration, no index, no new contract.**

```
GET /api/v1/products?limit=20&offset=0        public · no auth · store-scoped
→ 200 { products: [ …active only ], pagination: { limit, offset, total } }
```

This increment adds almost nothing new, which is the point. Every piece it needs already existed and was reused unchanged:

| Reused                                                             | From     |
| ------------------------------------------------------------------ | -------- |
| `ListProductsQuerySchema` — bounds, strictness, digit-only parsing | §28      |
| `toProductListResponse` and `ProductResponse`                      | §24, §28 |
| The `{ products, pagination }` envelope                            | §28      |
| `ORDER BY created_at DESC, id DESC`                                | §28      |
| `PUBLIC_PRODUCT_STATUS` — the single definition of "published"     | §25      |
| The shared page/count predicate                                    | §28      |

**One pagination contract for the whole API.** A client learns `limit`/`offset`/`total` once. Forking a public variant would be a second contract to document, version, and keep in step — for no behavioural difference.

### A separate repository method, not a flag

`listPublicForStore` sits beside `listForStore` rather than taking a `publicOnly` boolean, for exactly the reason `findPublicBySlug` is separate from `findBySlug` (§25): a flag puts "shows every draft in the catalogue" and "does not" **one wrong argument apart**, on the query that faces anonymous callers. Mutation D — pointing the public service at `listForStore` — fails 7 tests, and is precisely the mistake a flag would make easy.

### Visibility

`store_id AND deleted_at IS NULL AND status = 'active'`, built once and shared by the page and the `COUNT`. A total that counted drafts would tell a storefront there are 40 products while paging only ever yields 12 — mutation F fails 6 tests.

`LIMIT` applies **after** the predicate, so a page of 2 contains 2 _visible_ products rather than 2 rows some of which are filtered away. Tested with interleaved visible/hidden rows, because getting this wrong yields short pages that look like the end of the catalogue.

### An index note

This predicate — `(store_id, status)` — is exactly `ix_product_store_status`, so unlike the admin list PostgreSQL can satisfy the filter from the index rather than scanning the store's rows. The sort still costs a pass. Still **no dedicated index**, on the §28 reasoning: add one when there is evidence, not in anticipation.

### Public by contract, not by omission

No `requireAuth`, no `requireScope`. The suite wires the router with a verifier and a scope guard that **throw if invoked**, so a guard appearing on this route fails loudly rather than quietly changing the contract — mutation E fails 22 tests.

`resolveStore` still runs, which is what makes the endpoint multi-tenant, and an unseeded deployment gets **503** rather than an empty page.

### Empty is 200, not 404

A store with no published products returns an empty array. An empty catalogue is a valid state, not a missing resource — and a 404 would force every storefront to special-case its own launch day.

### Mutation verification

| Probe                               | Tests failed |
| ----------------------------------- | ------------ |
| A — drop `status = 'active'`        | 7            |
| B — drop the store predicate        | 3            |
| C — drop `deleted_at IS NULL`       | 2            |
| D — service calls the admin list    | 7            |
| E — public list gains an auth guard | 22           |
| F — COUNT diverges from the page    | 6            |

None survived.

### Deferred

Search · category/price/attribute filtering · sorting · cursor pagination · a shared pagination module · variants · inventory · images.

Search and filtering are the obvious next asks for a storefront list, and both deserve their own increment: filtering changes the index story, and search likely needs `tsvector` or an external engine rather than `LIKE`.

## 32. Phase 2 increment 19 — public product search

Adds one optional query parameter to `GET /api/v1/products`. **No migration, no index, no extension, no dependency.**

```
GET /api/v1/products?q=shirt&limit=20&offset=0
```

`q` — optional · trimmed · 1–100 characters · case-insensitive **substring** match on `product.name` only.

### Why substring, and not the alternatives

Inspection first: the project had **no search of any kind** — no `ILIKE`, no `tsvector`, no search dependency. So this establishes the convention rather than following one.

| Option                     | Rejected because                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact                      | Useless for a search box                                                                                                                                                                                                               |
| Prefix `q%`                | Indexable, but "shirt" would not match "Blue Cotton Shirt" — the common case fails                                                                                                                                                     |
| **Substring `%q%`**        | **Chosen.** Matches how people search. Within one store it is a filtered scan over rows already narrowed by `ix_product_store_status`.                                                                                                 |
| Full-text `tsvector`       | Needs a generated column, a GIN index, and a migration — and **cannot do partial words**, so "shir" would not match "shirt". Worse for search-as-you-type, not merely bigger. Adopt when ranking or stemming is an actual requirement. |
| `pg_trgm`, external engine | Available but not installed / not present. No evidence yet justifies either.                                                                                                                                                           |

The upgrade path is API-invisible: `CREATE EXTENSION pg_trgm` plus a GIN index on `lower(name)` is one migration and changes no contract. That is precisely why it can wait.

### Name only — a correctness argument, not a scope one

Description is **not** searched, and that is the better design rather than the smaller one. With no relevance ranking, results are ordered by date — so a product that merely _mentions_ "shirt" in its description would outrank an actual shirt whenever it happened to be newer. Searching descriptions becomes right when ranking exists. Slug and status are likewise excluded: a storefront searches what a customer can read on the page.

### A separate public schema

`q` lives on `PublicListProductsQuerySchema`, an `.extend()` of the shared one — **not** on `ListProductsQuerySchema` itself, which the admin list also uses. Widening the shared schema would have given the admin list a parameter it silently ignores: a request that looks honoured and is not, the same failure mode §28 rejected clamping to avoid. Admin search is its own increment with its own visibility rules. `.extend()` preserves `strictObject`, verified by test rather than assumed.

### LIKE metacharacters — the subtle part

Parameterisation stops SQL injection. It does **not** stop this: `%` and `_` inside a _bound parameter_ are still wildcards, so an unescaped `?q=%` returns the entire catalogue and `?q=%%%%%` is a cheap way to make the scan miserable.

`escapeLikePattern` escapes `\`, `%`, and `_` in **one regex pass**. That is deliberate: a sequence of `.replace()` calls invites an ordering bug where escaping `%` first and `\` second double-escapes the backslashes just inserted, turning `50%` into a search for `50\%`.

The test that proves it is asymmetric on purpose. Three products, exactly one named `50% Cotton Shirt`: escaped, `?q=%` returns **1**; unescaped it returns **3**. An "expect empty" assertion would have distinguished neither — and that is the mistake the first draft of the test actually made, caught when it failed against correct code.

### The search joins the SHARED predicate

`q` is added to the single `visible` expression that the page query and the `COUNT` both use (§28). A search applied to only one of them reports a total for a different result set than the page it accompanies — mutations 7 and 8 fail 10 and 15 tests respectively.

`and()` drops `undefined` operands, so an absent `q` leaves the query byte-for-byte what Increment 18 produced.

### Test design

Every case uses **several** products, and every visibility case pairs a _matching hidden_ product with a _matching visible_ one — so an empty result can never be mistaken for correct exclusion. Exactly one product must come back.

### Mutation verification

| Probe                                  | Tests failed |
| -------------------------------------- | ------------ |
| Remove `status = 'active'`             | 3            |
| Remove `deleted_at IS NULL`            | 2            |
| Remove the `store_id` predicate        | 3            |
| `ILIKE` → case-sensitive `LIKE`        | 17           |
| Remove wildcard escaping               | 4            |
| Search `description` instead of `name` | 21           |
| `q` on the page but not the COUNT      | 10           |
| `q` on the COUNT but not the page      | 15           |
| Add an auth guard to the public route  | 30           |

None survived.

### Deferred

Price filtering (`price_min` / `price_max`) · category and attribute filters · sorting · relevance ranking · full-text or trigram search · admin search · cursor pagination.

Price filtering is the recommended Increment 20 and was deliberately split out: it forces decisions search does not — whether bounds validate as `Money` against the store currency, whether `min > max` is a `400` or an empty result, and whether a range predicate changes the index story.

### Known limitation

Substring search does not scale indefinitely — it cannot use a B-tree, so cost grows with a store's catalogue size. Correct and fast at present scale, with the `pg_trgm` upgrade path above. Worth revisiting when a single store reaches the low thousands of products.

## 33. Phase 2 increment 20 — public product price filtering

`GET /api/v1/products` gains two optional query parameters, `price_min` and `price_max`. No new endpoint, no new response field, no migration.

### The bounds are decimal strings, and they reuse `priceField`

Same primitive the create and update bodies use, for the same reason those are not `z.number()`: a JSON number is an IEEE-754 double, so `19.99` is already imprecise before the server sees it. Reusing the primitive rather than writing a filter-specific pattern settles three rules at once — no negatives (the pattern begins `\d`), at most 4 decimal places, at most 15 integer digits — and guarantees the endpoint that _filters_ on price cannot drift from the ones that _write_ it.

Excess precision is a `400`, never a silent round. `?price_min=10.00001` is a caller who typed one digit too many, and §16's rule applies: tell them, do not overrule them.

`snake_case`, matching the wire exactly. `strictObject` makes the parameter name the contract, so a camelCase alias is a `400` and there is nothing to reconcile.

### The bounds are NOT converted through `Money`

Deliberate, and a departure from the create and update paths, which do call `toDb(money(...))`.

`money()` requires a `Currency`. Using it here would mean threading the resolved store's currency into query validation, and it raises an `InvariantViolation` — a **500** — for a currency this build does not know. A price filter must not be able to fail that way.

Nothing is lost by skipping it. PostgreSQL coerces the text parameter to `numeric` itself: `'10'`, `'10.0'`, and `'10.0000'` all select the same rows, verified against the live database before the code was written and asserted by test afterwards. No cast, no normalisation, no currency needed.

### Comparison of the two bounds is zero-padded, not `Number()`

The cross-field check needs to know whether `price_min <= price_max`. `Number(a) <= Number(b)` is wrong at the edge of what the pattern admits: 15 integer digits plus 4 decimals is 19 significant digits, past what a double can distinguish, so `999999999999999.9999` and `999999999999999.9998` compare **equal** and a reversed range at that magnitude would pass. Reachable through the public API, so not theoretical.

Instead both sides are zero-padded to a fixed 15.4 layout and compared lexicographically. The inputs are non-negative and length-bounded by the regex, so the padded forms are equal-length digit strings and lexicographic order _is_ numeric order. Exact, four lines, no dependency. Plain string comparison without the padding would have been worse still — `'9' > '10'`.

### `price_min > price_max` is a 400, not an empty page

Same judgement as §28's "over the maximum is rejected, not clamped". An empty `200` would tell a caller their filter was honoured and simply matched nothing, when the request cannot be satisfied at all. A transposed `price_min=2000&price_max=1000` is a bug in the caller, and the useful answer says so rather than looking like an empty shelf.

Note the distinction the tests hold: a range that is _satisfiable but matches nothing_ (`3000..4000` over a catalogue topping out at 2500) is a normal `200` with `[]` and `total: 0`. Only the impossible range is an error.

Implemented with `.refine()` on the whole object — the existing cross-field mechanism from `UpdateProductRequestSchema` (§29), not a second one. `.refine()` wraps the strict object without relaxing it, so unknown parameters are still rejected; asserted by test, since that is a property of Zod rather than of this code.

### Both bounds are inclusive

`price >= price_min` and `price <= price_max`. A shopper filtering "up to 2000" means a product priced exactly 2000 is in range; excluding it is the kind of off-by-one that hides a product from the only search that should have found it.

Proved by fixtures priced **exactly on each boundary** rather than by a range that merely contains rows. A `1000..2000` filter over a `500 / 1000 / 1500 / 2000 / 2500` catalogue fails visibly if `>=` becomes `>` or `<=` becomes `<`; a range like `900..2100` would not.

### One shared predicate, as in §28 and §32

The bounds join the same `visible` expression the page and the `COUNT` both use. A filter applied to only one of them reports a total for a different result set than the page it accompanies. `and()` drops `undefined` operands, so a request with neither bound produces byte-for-byte the query it produced before this increment.

The bounds can only **narrow** that expression — store scoping, `deleted_at IS NULL`, and `status = 'active'` are unconditional operands beside them, so no combination of price parameters can widen visibility.

### Public-only, again

`price_min` and `price_max` go on `PublicListProductsQuerySchema`, not the shared `ListProductsQuerySchema`. Widening the shared one would give the admin list parameters it silently ignores — the "looks like it worked" failure §28 rejected clamping to avoid. Admin filtering is its own increment with its own visibility rules.

The test for this had to be built differently from §32's. That suite asserted the admin list rejects `q` by observing a `401` — but a missing token produces a `401` whether or not the schema was widened, so the mutation would have survived. This increment signs in as staff first, making the assertion `400`-versus-`200`, with an unfiltered request as the control.

### No index, no migration

`(store_id, status, price)` was considered and rejected. Two reasons, the second decisive: the `ORDER BY created_at DESC, id DESC` means a sort is required regardless, so the index would not remove it; and the catalogue is currently four rows with no production data. §28 already set the rule — add on evidence, not on speculation.

### Ordering and response unchanged

Still newest first. No price sorting, no filter echo in the response, no new envelope field. Asserted by a test that filters by price and checks the results come back in _creation_ order, not price order.

### Mutation verification

| Probe                                    | Tests failed |
| ---------------------------------------- | ------------ |
| Remove the `price_min` predicate         | 12           |
| Remove the `price_max` predicate         | 13           |
| `>=` becomes `>`                         | 11           |
| `<=` becomes `<`                         | 9            |
| Price on the page but not the COUNT      | 14           |
| Price on the COUNT but not the page      | 15           |
| Remove the `store_id` predicate          | 3            |
| Remove `status = 'active'`               | 3            |
| Remove `deleted_at IS NULL`              | 2            |
| Add an auth guard to the public route    | 33           |
| Allow the price bounds on the admin list | 1            |

None survived.

### Deferred

Price sorting · price facets and histograms · exclusive bounds (`price_lt` / `price_gt`) · category and attribute filtering · currency conversion · sale and discount prices · admin price filtering · cursor pagination.

### Known limitation

With no index on `price`, a bounded query scans the store's visible rows. Correct at present scale; the fix, when evidence justifies it, is a composite index — but as noted above it would narrow the scan without removing the sort, so keyset pagination is the larger win and remains deferred.

Bounds are interpreted in the resolved store's currency, which every product in the response reports. There is no conversion and no cross-currency comparison; a client filtering across stores is comparing different units and must account for that itself.

## 34. Phase 1 increment 21 — password change and profile update

Two endpoints complete the identity module: `POST /api/v1/users/me/password` and `PATCH /api/v1/users/me`. No new table, no new index, no migration.

### Session revocation is an invariant, not a side effect

A password change revokes **every** refresh session the user holds, across all families. This is the only user-wide revocation in the codebase, and the asymmetry with logout is deliberate:

- **Logout** is family-scoped (§20). Signing out of a phone must not sign a user out of their laptop — that is what the word means to the person pressing the button.
- **Password change** is user-wide. The reason to change a password is that the old one may be known to someone else, so every session established under it is suspect. A password change that left a stolen refresh token alive would leave the attacker with a renewable foothold — exactly what the user pressed the button to end.

Conflating the two would make the safe option the only option; here the safe option is the correct one.

The new `revokeAllForUser` writes a distinct `revoked_reason` of `password_change`, so the forensic trail can tell a credential rotation from a sign-out. Its `revoked_at IS NULL` predicate also preserves history: a session already revoked by logout keeps its original reason rather than being re-stamped.

`ix_refresh_session_user` already indexes `user_id`, so no index was added. `store_id` sits in the predicate beside it rather than being trusted from the caller's lookup — ids are unique within a store, and a method that could be aimed at another tenant by one wrong argument is a refactor away from a cross-tenant write.

### Atomicity

Both writes run inside one `withTransaction`, using the existing helper — repositories already call `executor(db)`, so nothing about them changed.

The partial state that must not exist is "password changed, sessions still live": the user believes they have locked an intruder out while the intruder's refresh token still works. One transaction means a revocation failure takes the password change with it, and the user is told the operation failed — recoverable, and honest.

`PATCH /users/me` is wrapped for the same reason. Its `isActive` check has to run on the row the update returned (the predicate already excludes deleted and foreign rows, leaving deactivation as the one case a prior read cannot settle without a second query whose answer could be stale). Checking after the write means the write has already happened, so without the transaction a deactivated user would get a 401 **and** a modified profile.

### Access tokens are not revoked, and that is stated rather than implied

Access tokens are stateless and remain valid until `exp`, at most 15 minutes. These endpoints end refresh capability immediately; they cannot retract an issued access token. §20 already recorded that trade-off and it is unchanged — the OpenAPI description says so explicitly rather than letting a reader assume otherwise.

### The two password fields validate differently

`newPassword` reuses `passwordField`, the registration policy — it is a password being **chosen**, so the 10–128 rule applies exactly as at registration.

`currentPassword` reuses login's permissive `min(1).max(1024)` instead. This follows the reasoning already recorded on `LoginRequestSchema`: applying the policy to an existing credential would reject anyone whose password predates a policy change — locking them out of the very endpoint that would fix it — and the 10-character floor would leak that shorter passwords cannot exist. There is a test that installs a 7-character password through the repository and proves the change still succeeds.

Neither field is trimmed. Whitespace is a legitimate password character, and trimming would silently change a credential a password manager stored.

### `updatePasswordHash` was reused unchanged

It already takes `expectedCurrentHash`, which is exactly the guard this flow needs: a compare-and-set on the hash just verified. If a concurrent login rehashed the row, or another password change landed first, the WHERE matches nothing and the method returns false.

That case is a **409, not a 401**. The credential presented _was_ correct when checked, and telling the user their current password is wrong would be a lie that sends them looking for the wrong problem. Throwing inside the transaction means no session is revoked for a password change that did not happen.

### PATCH strictness is a security boundary

Three fields are writable: `firstName`, `lastName`, `acceptsMarketing`. Everything else is a 400 naming the field, not a silently stripped key. The consequences of the alternatives are concrete: `isStaff` and `isSuperuser` are privilege escalation, `storeId` is a tenancy escape, `passwordHash` is account takeover bypassing the current-password check, and `email` moves the login identifier past its uniqueness index and verification state.

Two independent defences, because the cost of losing one is a customer promoting themselves to staff:

1. `strictObject` rejects the field at the boundary.
2. `EditableUserFields` — a closed allowlist type — means a service that tried to forward one would not compile.

The mutation testing below shows why both are needed: defeating either alone is caught, and it is the **pair** that would be dangerous.

`email` and `phone` are excluded for a second reason beyond privilege: both carry a partial unique index and a verification timestamp, so changing either is a verification flow, not a field assignment.

An empty PATCH body is a 400, following §29 — it would otherwise bump `updated_at`, return 200, and leave the caller believing something changed.

### Password change is a POST sub-resource, not a PATCH field

Changing a password is an **action** with side effects — it verifies a credential and cuts every session — not a field assignment. The project already draws that line for product `publish`/`archive` (§26). Folding it into the profile PATCH would also let one request half-succeed across two very different kinds of change.

### Mutation verification

| Probe                                                   | Result               | Tests failed |
| ------------------------------------------------------- | -------------------- | ------------ |
| Remove the current-password check                       | caught               | 3            |
| Skip the password-hash update                           | caught               | 6            |
| Skip session revocation                                 | caught               | 7            |
| Revoke only one family instead of all                   | caught               | 5            |
| Revoke another user's sessions                          | caught               | 8            |
| Allow an unknown PATCH field (`strictObject` loosened)  | caught               | 7            |
| Mass-assign a privileged field (schema **and** service) | caught               | 7            |
| Forward an omitted PATCH field                          | **survives — no-op** | —            |
| Return credential material from PATCH                   | caught               | 3            |

Eight of nine caught. The ninth is recorded honestly rather than engineered away:

**Forwarding an omitted PATCH field is behaviourally equivalent, not a defect.** Drizzle's `buildUpdateSet` keeps a column only when `set[col] !== undefined` (`pg-core/dialect.cjs`), so a service that spread the parsed body would emit **identical SQL** — there is nothing for a test to observe. Making the probe "fail" would mean asserting on source text rather than behaviour, which is not a test.

The explicit `!== undefined` field-building is kept anyway, and the comments were corrected to say why: the load-bearing reason is that spreading needs an `as` cast to satisfy `EditableUserFields`, and that cast is precisely what would let a widened schema carry `isStaff` through. Relying on the driver's filtering would make this method's safety a property of a dependency.

The revocation probes are the reason every revocation test establishes **three independent login families** and a second user. Against a single-session fixture, "revoke only the current family" is invisible — the same blast-radius blind spot §29 hit when every test kept one product.

### Deferred

Password reset / forgot-password · email verification · phone verification · MFA/TOTP · email change · account deletion and erasure · a session-listing endpoint · a standalone sign-out-everywhere endpoint · admin user management · addresses · a dedicated rate-limit budget for authenticated password changes.

### Known limitation

`POST /users/me/password` is not rate limited, matching the existing policy that the limiters guard **unauthenticated** endpoints. Reaching it requires a valid signed access token. It does run Argon2 twice per call (one verify, one hash), so an authenticated caller can spend server CPU; the per-IP limiter on the API surface still applies. A dedicated budget for authenticated password changes is a rate-limiting decision, not part of this increment.

## 35. Increment 22 — domain events and audit producers

The outbox and `audit_log` were built in Phase 0, fully tested, and wired into the container — and after ten increments neither had a single producer. This increment gives both their first ones. No new table, no new index, no migration.

### Why this came before categories or SKUs

It is the only outstanding item whose cost **rises** with every increment shipped without it. §5 names the transactional outbox one of two things that must never be deferred; leaving it unused was deferring it in practice. Every product mutation written between Increments 11 and 21 is a mutation with no event and no attributed record, and each further increment would have added more surface to retrofit.

### Audit is infrastructure, not a module

`src/db/audit/`, beside `src/db/outbox/`. Not `src/modules/audit/`, because `no-cross-module-imports` forbids one domain module importing another with **no exception for a barrel** — a module-shaped audit trail would be unimportable by the modules that need it. Siting it as infrastructure needed no new dependency-cruiser rule, which is itself evidence the existing boundaries were drawn correctly.

`shared/audit.ts` holds the types and the `AuditTrail` port; `db/audit/` holds the implementation. Same split as `shared/events.ts` versus `db/outbox/`, so domain code declares "record this" without depending on where it lands.

### Events and audit entries answer different questions

They look similar and are deliberately separate:

- An **event** says _something happened_, so other code can react. At-least-once delivery, handled minutes later, consumers are code.
- An **audit entry** says _someone did something_, so a human can later ask who. Never delivered, never retried, consumer is an auditor.

One table serving both would either drop the actor (useless for audit) or carry delivery state (useless for reading). One admin action legitimately produces both — an event so a cache invalidates, an entry so a manager can see who changed the price.

### Both writes are transactional, and both refuse to run otherwise

`AuditTrail.record` asserts an open transaction exactly as `EventBus.emit` already did. The failure it prevents is worse than a missing entry and one-directional in the wrong way: an audit row written in its own transaction **survives a rollback of the action**, so the trail asserts someone did something they did not do. A trail that is wrong is worse than one that is incomplete, because it is trusted.

Consequently every catalogue mutation now opens a `withTransaction`. Previously they were single statements that correctly needed none; a write **plus** an event **plus** an entry is a real consistency boundary. `registerCustomer` gained one too — its own code comment had predicted this exact change and said the transaction would arrive when the second write did.

### `events` and `audit` are required dependencies

Not optional. The `loginAttempts?` precedent exists, but its justification was that absence is still safe — the per-IP limiter still caps CPU. A silently unaudited service is the opposite: it looks wired and records nothing, the "looks like it worked" failure this project keeps rejecting.

The cost was 19 test harnesses. Those were updated to construct the **real** ports against the test database via `tests/helpers/recording.ts`, not no-op doubles. A stub would have let every existing suite keep passing while the services emitted nothing — so the whole catalogue and identity suite now exercises the write+event+audit transaction, and a broken boundary surfaces across the suite rather than only in the new tests.

### The actor comes from the token, and only from the token

`staffActor(req)` reads `requireUser(req).id`. An actor a client could supply is an audit trail a client could forge.

That needed a specific test, because the obvious one is masked. On `POST /admin/products` a body-supplied `actorUserId` is a 400 from `strictObject` before the handler runs — so a route that trusted client input would still pass. But the **lifecycle and delete routes call `validate({ params })` only**: their bodies are entirely unvalidated, which makes those the one place the mutation is genuinely reachable. The tests send `actorUserId` to `/publish` and to `DELETE`, and assert the entry names the token holder.

### `audit_log.actor_user_id` is a foreign key, and it earns its place

It references `app_user.id`, so an entry cannot attribute an action to a user who does not exist. This caught a synthetic actor id in one of this increment's own fixtures — the constraint working exactly as intended. The fixture was corrected to register a real user rather than the constraint being relaxed.

### Payloads carry ids and facts

The rule from `shared/events.ts`, applied. `productEventPayload` is `{ productId, slug, status }` — no serialised entity, because a payload holding one is stale by the time a handler runs. `product.updated` adds `changedFields` so a handler can decide whether it cares; `price` is emitted only there, where the change is the fact worth carrying.

`user.registered` does carry the email, deliberately: a welcome-email handler cannot work without it, and re-reading the row would race a customer who changes their address in the interim. No hash, no phone — an outbox payload is retained far longer than a request log.

### Mutation verification

| Probe                                     | Result | Tests failed |
| ----------------------------------------- | ------ | ------------ |
| Drop the product event                    | caught | 8            |
| Drop the product audit entry              | caught | 8            |
| Allow `emit` outside a transaction        | caught | 17           |
| Allow `record` outside a transaction      | caught | 17           |
| Omit `storeId` from both records          | caught | 1            |
| Trust a body-supplied actor               | caught | 2            |
| Record on a REJECTED lifecycle transition | caught | 1            |
| Drop `user.registered`                    | caught | 1            |

All eight caught — but two only after strengthening, and the reasons are worth recording because both were invisible for the same structural reason.

**Omitting `storeId`** survived initially because the event bus falls back to `context?.storeId`, which `resolveStore` populates. Over HTTP the fallback silently produces the right answer, so the explicit argument looked redundant. It is not: a CLI command, a seed, or a job has no ambient context, and an omitted `storeId` lands as NULL where every per-tenant audit query misses it. Killed by a test that drives the service with no request in flight.

**Trusting a body actor** survived because `strictObject` was doing the defending on the only route the tests exercised. Killed by testing the routes that validate no body at all.

Both are the same lesson as Increment 21's mass-assignment probe: where two layers defend, a mutation to either one alone is invisible, and the test has to target the layer that is actually load-bearing for that route.

### Deferred

Event handlers and subscribers (nothing consumes these events yet — the drainer publishes them and the registry is empty) · audit-log read endpoints · `auth.login_failed` and session-revocation entries · privilege-change entries (nothing can grant staff through the API yet) · `ip_address` on audit entries, which would need the request context to carry it.

### Known limitation

Nothing consumes these events. The drainer will publish them to BullMQ and the handler registry has no entries, so they are recorded and delivered to nowhere. That is the intended end state for this increment — producers first, consumers when a consumer exists — but it means the delivery half of the pipeline remains exercised only by the outbox's own tests, not by a real subscriber.

`audit_log.ip_address` is always NULL. The column exists and `RequestContext` does not carry an IP, so populating it would mean widening the context — out of scope here.

## 36. Increment 23 — idempotency, the Money lint rule, and the leader-lock flake

Three items that look unrelated and share one property: each was cheap now, each grew more expensive later, and none was blocked on a decision. Together they close three of the debts recorded in the architecture review.

### The leader-lock flake was a production bug, not a slow test

The intermittent failure was a symptom. The cause was in `leader-lock.ts`:

```ts
const renewIntervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
```

The 1s floor silently inverts the documented ratio below a 3s TTL. At `ttlMs = 1000` the renewal interval **equals** the TTL, so the first renewal races Redis's expiry and leadership is decided by a coin flip. At `ttlMs = 1500` the ratio is 1.5x, so one late renewal loses the lock. Both were in use in the test file, and the comment on one test claimed "renews every 500ms" — which the floor made 1000ms.

The stated property is that **two consecutive renewals may fail** before leadership lapses. That requires `renewIntervalMs * 3 <= ttlMs`, so that is now an `invariant` at construction. Asserted rather than clamped: a caller asking for a 1s leadership TTL has misunderstood something, and silently substituting a workable value would hide it. Production uses 30s, so it cannot fire there — it fired in the tests, which is how the trap was found.

### One of the flaky tests was worse than flaky — it was vacuous

`does not delete a lock it no longer owns` could never test what it claimed. `release()` returns early when `!leader`, so a stale instance that has already stood down never reaches the Lua compare-and-delete. The test slept past a 1s TTL, which meant:

- renewal fired and was rejected → `a` stood down → the assertion passed **without exercising the fencing token at all**; or
- renewal won the race → `b` could not acquire → the test failed.

There was no interleaving in which it tested the guard. It is now sleep-free: a long TTL keeps the renewal timer from firing, the key is dropped from an independent connection to simulate the lapse, `b` takes over, and `a` — still believing it is leader — is made to run its release against `b`'s key.

Two more latent flakes in the same file were fixed with it. `expires so a crashed leader does not hold the lock forever` left the leader's renewal running and depended on the renewal losing a race; a crash is now simulated by killing the client connection, so waiting past the TTL can only ever be too late, never too early. `stands down when its key is taken` asserted 200ms after a timer interval; it now polls for the property with a deadline, because a sleep sized to a timer measures punctuality under load rather than behaviour.

### `local/no-money-arithmetic` — the first of the five §5 rules

Type-aware, in `eslint-rules/`, registered as a local plugin. It exists because the realistic failure is invisible:

```ts
line.amount + tax.amount; // "10.0000" + "2.5000" === "10.00002.5000"
```

`Money.amount` is a decimal **string**, so this is concatenation. It typechecks perfectly — `string + string` is a `string` — so neither `tsc` nor `recommendedTypeChecked` says a word, and it writes a plausible-looking wrong number into a `NUMERIC` column. The rule also catches `Number()`/`parseFloat()`/`parseInt()` coercion, compound assignment, unary negation, and relational operators (`"9.0000" < "10.0000"` is false — the identical trap the §33 price comparator solved by zero-padding).

It is in `no-restricted-syntax`'s neighbour rather than inside it because a selector cannot distinguish a Money amount from any other string, and that distinction is the whole rule.

**It found one genuine violation on the first run**: `format()` calling `Number(m.amount)`. That one is legitimate — `Intl.NumberFormat` takes a number and there is no exact-decimal formatter in the platform — so it carries an explicit disable with a reason, and now rounds to minor units first so the conversion is provably lossless.

Worth recording: the first fix was to extract `roundToMinorUnits(m).amount` to a local, which silenced the rule _without any disable comment_. That is the rule's real limit — assigning to a `string` local launders the type — and doing it would have been dodging the guard rather than documenting the exception. The call is inlined instead, so the disable is visible and will fail loudly if the rule is ever removed.

The rule has its own test suite (11 cases) run through the **real project config**, not `RuleTester`: a snippet linted under a made-up path is in no TypeScript program, so the rule bails by design and every assertion would report zero messages and pass while proving nothing. One fixture file, one program build, assertions pinned by line — plus a test that the rule is registered at all, because a correct rule nobody wired in looks exactly like a clean codebase.

### `idempotency_key` — the table behind the existing error classes

`IdempotencyConflict` (409) and `IdempotencyKeyReuse` (422) have been in the taxonomy since Phase 0 with nothing behind them. This is the missing half, and it is a prerequisite for checkout rather than a later refinement.

**Claim is an INSERT ... ON CONFLICT DO NOTHING**, not a read-then-insert: two requests arriving together would both see nothing and both proceed. Exactly one INSERT returns a row; the loser reads what is already there. Only the database can arbitrate that, which is why the suite runs against real PostgreSQL.

**Payload is checked before status.** A mismatched body is a client bug whatever the original request is doing, and reporting `in_flight` would invite the client to keep retrying a request that can never be served.

**The request payload is hashed, never stored.** A checkout body carries addresses and a cart; the table's job is short-lived bookkeeping, not becoming a second copy of customer PII. Keys are hashed with SHA-256 and compared after sorting object keys, so two clients whose serialisers differ in key order are not handed spurious 422s.

**Failure releases; success completes.** A failed request committed nothing, so the client must be free to retry with the same key — storing a 500 as the completed answer would make a transient failure permanent for that key. `release` is a DELETE restricted to `in_progress`, so it can never remove a completed row and let a retry re-execute work that already succeeded.

### A design bug the tests found: the bodiless 2xx

The first `CHECK` required a completed row to carry `response_status`, `response_body` **and** `completed_at`. A `204 No Content` could then satisfy none of the available outcomes: it could not complete (the constraint rejected a null body) and must not be released (the operation had succeeded), so the key stayed pinned in `in_progress` until it expired — and a retry after expiry would re-execute it.

The constraint now ties completion to `response_status` and `completed_at` only. A body is stored when there was one; a 204 completes with none and replays as a bare 204. Found by the test asserting the wrong behaviour, which is the useful direction for a test to be wrong in.

### Deferred, deliberately

**No route mounts the middleware.** Checkout is the first endpoint that needs it, and the suite carries its own test-only handlers rather than pretending a consumer exists.

**`purgeExpired` has no caller.** Nothing writes to the table until an endpoint mounts the middleware, so there is nothing to purge, and the scheduler's own registry documents the convention that a recurring task arrives with the phase that needs it. The method is on the contract and covered by tests so the sweeper is a one-line registration when it is due.

### The window this leaves, stated rather than hidden

The claim happens before the handler and the completion after it, so there is a moment between the business COMMIT and the completion write. A process dying in that window leaves the key `in_progress`: retries get 409 until `expiresAt`, and after that a retry would re-execute work that had succeeded.

That is why `complete()` uses the ambient executor. A handler with strict requirements — checkout — should call it **inside its own transaction**, which closes the window entirely; the middleware then finds the key completed and skips its own write. Until such a handler exists, the post-hoc completion is the fallback, and the second defence is that the operations needing this also have natural keys (one order per cart, one payment per order).

### Mutation verification

| Probe                                        | Result                    | Tests failed |
| -------------------------------------------- | ------------------------- | ------------ |
| Claim never conflicts                        | caught                    | 11           |
| Replay loses the stored status               | caught                    | 7            |
| Mismatch checked after status                | caught                    | 1            |
| Release removes completed rows               | caught                    | 1            |
| Complete overwrites the first answer         | caught                    | 1            |
| Key header becomes optional                  | caught                    | 1            |
| Failure completes instead of releasing       | caught                    | 2            |
| Money lint rule disabled                     | caught                    | nonzero exit |
| Renewal-margin invariant removed             | caught                    | 1            |
| Drop the `ON CONFLICT` target                | **survives — equivalent** | —            |
| Drop the store predicate from the claim read | **survives — equivalent** | —            |

Nine caught. The two survivors are **provably behaviourally equivalent**, not uncaught defects, and both are recorded rather than engineered away:

- `.onConflictDoNothing()` without an explicit target still matches the same unique index, because it is the only one on the table. The explicit target is documentation and future-proofing — if a second unique index were added, an untargeted `DO NOTHING` would swallow that conflict too — but today it cannot change behaviour.
- The store predicate on the claim **read** is unreachable-by-construction defence in depth. That read only runs when the INSERT conflicted, which means a row with that exact `(store_id, key, endpoint)` already exists — so the predicate can never alter the outcome.

The cross-tenant test was strengthened anyway, from "store B can claim" to "store B must not be handed store A's completed response, and store A's key survives store B's claim". The weaker form passed even with the response shared, because the claim path returns before reading anything.

### Known limitation

The lint rule is type-based, so assigning a Money amount to a plain `string` local escapes it. Closing that would need dataflow analysis and would produce false positives; the limit is documented in the rule and asserted by its tests.

## 37. Phase 2 increment 24 — SKU / variant foundation

**SKU is the sellable unit.** A product is a merchandising container — name, description, URL, lifecycle — and carries no price. A SKU carries the price, and is what inventory, cart lines, order lines and tax classification will reference in later increments. Nothing buys a product.

One new table, one migration with a backfill, four admin endpoints, and a changed product response.

### `EXISTS`, never a join — the decision the rest of the increment bends around

A product has 0..n SKUs. Joining them into the product query multiplies the product row by the number of matching SKUs, which corrupts three things simultaneously: the page repeats the product, `pagination.total` counts SKUs instead of products, and pagination stops being deterministic because `LIMIT` slices SKU rows.

Measured against real data during the design review, before any code was written: a price band matching two SKUs on each of three products returned **6 rows** through a join and **3** through `EXISTS`.

A `DISTINCT` would paper over the page and not the `COUNT`, and would require a second, divergent predicate — the exact failure §28 built the single shared predicate to prevent. `EXISTS` stays one boolean expression, so the page query and the `COUNT` continue to use the identical `visible` predicate they always have.

The join version **compiles cleanly** and passes typecheck. It is a silently shippable defect, which is why it is the first mutation probe.

### Both price bounds go in ONE subquery

`EXISTS(price >= min) AND EXISTS(price <= max)` is satisfiable by a cheap SKU and a separate expensive one, matching a product that has nothing in the requested band at all. One subquery means one SKU must satisfy both ends — which is what "a product in this price range" means. There is a test for exactly that: a product priced 10 and 9000 must not match `1000..2000`.

### Public visibility requires an active SKU

The shared predicate gained `EXISTS (active, non-deleted SKU)`. A published product with nothing sellable collapses into the same 404 as an unknown slug, a draft, or another store's product — the §25 rule that every public failure is indistinguishable. Without it a storefront could render a product page with no purchasable SKU on it.

**Consequence, recorded rather than discovered later:** deactivating a product's last active SKU removes it from the storefront. `PRODUCT_TRANSITIONS` was deliberately left untouched — `publish` does not check for a sellable SKU — so the guard is a read predicate rather than a new 409, and it needs no row lock. The design review considered the alternative (refuse to deactivate the last SKU) and rejected it: enforcing that invariant needs `SELECT … FOR UPDATE` on the product row, because two concurrent deactivations would each see "there's another active one" and both proceed. Introducing this codebase's first row lock for a merchandising nicety, rather than for money, is the wrong trade. The product stays visible to staff, and republishing is one reactivation away.

### `isActive` is a PATCH field, not a lifecycle action

The opposite of the choice §26 made for `product.status`, and for a stated reason: a product's status has a state machine with illegal transitions to enforce, so it moves through explicit `publish`/`archive` actions. `isActive` has two states and both transitions are always legal — there is no machine to skip and nothing to reject — so an action pair would be ceremony. That also keeps the increment two endpoints smaller.

### The price migration, and why there is no dual-write

Four steps, all in one migration: create `sku`; backfill one SKU per product copying its price, deriving `code` from the slug and carrying `deleted_at` across; then `ALTER product ALTER COLUMN price DROP NOT NULL`.

**`product.price` survives this increment as a migration safety net and is read and written by nothing.** A grep for `product.price` now returns the schema definition and the migrations, and nothing else. It is dropped in Increment 25.

The textbook move here would be a dual-write so a rollback survives. **Deliberately not done**, and the deployment assumption was verified rather than assumed: there is no CI configuration, no deploy manifest, no infrastructure of any kind in the repository — only a local `docker-compose.yml` — and the development database held four products. A dual-written mirror would also have no coherent meaning the moment a product has two SKUs, and a mirror nothing reads is a mirror that drifts.

The backfill constructs **UUIDv7** ids in SQL rather than calling `gen_random_uuid()`. v4 is a locked decision against (§10 bans it in application code with a lint rule), and a backfill quietly seeding v4 rows into a v7 table would defeat that rule from the one direction it cannot see. The expression overlays a 48-bit big-endian unix-ms timestamp onto a random uuid and stamps version 7; the variant bits are already correct because `gen_random_uuid()` sets them to `10xx`. Verified against the live database before use: version nibble `7`, valid variant, and a decoded timestamp matching the clock.

### Product deletion cascades in the product's own transaction

Not a database `ON DELETE CASCADE`: products are soft-deleted, so there is no `DELETE` for the database to cascade from — and the FK is `RESTRICT` precisely so a hard delete cannot silently take sellable rows with it.

It must be the same transaction. A SKU left with `is_active = true` and `deleted_at IS NULL` under a deleted product is a row that looks sellable to every query reaching it by code rather than through its product — including the SKU `PATCH` and `DELETE` endpoints, which look up by code alone.

The atomicity test provokes a real rollback by naming an actor whose user does not exist: `audit_log.actor_user_id` is a foreign key, so the audit insert fails _after_ both the product and the SKU have been updated. That is the only assertion that proves the cascade shares the product's transaction — with two transactions, the product would stay deleted and the SKU would not.

### Store scoping is denormalised onto the SKU

`sku.store_id` is reachable through `product`, so the column is redundant for correctness. It is there because every repository predicate in this codebase carries `store_id` in its own `WHERE`; requiring a join to enforce tenancy would make this the one table where the store boundary lives somewhere else. The `EXISTS` subquery states it too, even though `product_id` implies it, so a reader never has to trace tenancy through a relationship.

### Merchant codes are case-SENSITIVE

`uq_sku_code_active (store_id, code) WHERE deleted_at IS NULL` — per store, freed on delete, mirroring `uq_product_slug_active`. Case is **not** normalised, which is the deliberate difference from a slug or an email: a merchant code already exists on their purchase orders and packing slips, where `ABC-1` and `abc-1` may be two different things, and merging them would be a data-loss bug wearing a convenience disguise.

`code` is not editable. It is the identifier other documents reference, so renaming it in place would silently repoint them; a rename is a delete plus a create, which the partial index already permits.

### The response contract changed

`ProductResponse.price` became `ProductResponse.skus[]`. One shape for the detail read, the create, the update and the LIST (§25) — the list batch-loads SKUs for the whole page in a single `inArray`, not one query per product. Public reads carry active SKUs only and can never be empty, because a product with no sellable SKU is not publicly visible; admin reads carry inactive ones too, so an empty array is possible there.

`price` is now rejected on product create and update with a `400` naming the field. A stale client is told rather than silently ignored, which would leave a merchant believing they had set a price that went nowhere.

### Mutation verification

Fifteen probes, all caught. Five needed a second pass, and three of those found real gaps rather than bad probes.

| Probe                                                 | Result | Killed by                            |
| ----------------------------------------------------- | ------ | ------------------------------------ |
| Page query joins `sku` instead of using `EXISTS`      | caught | duplicate-row and `total` assertions |
| Drop `is_active` from the visibility `EXISTS`         | caught | inactive-SKU 404                     |
| Drop `deleted_at IS NULL` from the `EXISTS`           | caught | deleted-SKU 404                      |
| Price predicate on the page but not the `COUNT`       | caught | `total` vs page length               |
| Drop `store_id` from the `EXISTS`                     | caught | **new** cross-store corrupt-row test |
| Drop `code` from the SKU update predicate             | caught | wrong-SKU-updated assertion          |
| Drop `store_id` from `uq_sku_code_active`             | caught | **new** two-stores-share-a-code test |
| Skip the SKU cascade on product delete                | caught | cascade and atomicity tests          |
| Allow `price` back into the product `PATCH` schema    | caught | strict-body contract test            |
| Response drops SKU prices                             | caught | exact-key-set assertion              |
| Actor read from the request body instead of the token | caught | **new** body-supplied-actor test     |
| SKU event and audit emitted outside the transaction   | caught | rollback leaves no event             |
| Remove SKU events                                     | caught | outbox assertions                    |
| Remove SKU audit entries                              | caught | `audit_log` assertions               |
| Remove the parent-product existence and deleted check | caught | 404 on absent and deleted parents    |

Three of the second-pass fixes are worth recording, because each was a hole in the suite rather than a defect in the probe.

**Dropping `store_id` from the `EXISTS` initially survived, and the reason it survived is the reason the predicate is easy to argue away.** It is redundant _by construction_: the outer query already scopes `product.store_id`, and the subquery matches `sku.product_id = product.id`, so a SKU's store is implied by its product. It can only matter for a row whose `store_id` disagrees with its product's — which the application cannot create, because `createSku` takes the store from the product ROW rather than from its argument. That made it unreachable through the API and therefore invisible to every test that went through the API. The new test inserts such a row with direct SQL and asserts it leaks into neither store's listing. The predicate is now defence against corruption from an import or a future bug, and it is _asserted_ as that rather than assumed.

**Dropping `store_id` from the code uniqueness index also survived — but that probe was VACUOUS, which is a more useful finding than the survival.** It mutated the Drizzle schema, and the test database's schema comes from the migration SQL (`tests/helpers/postgres.ts` calls `runMigrations`). The mutation therefore had no runtime effect at all: nothing was being tested, and reading the survival as "equivalent" would have been wrong twice over. Re-targeted at the migration, it exposed a genuine gap — the suite proved a duplicate code in one store is _rejected_, but never that two stores may _share_ one. A global unique index on `code` alone satisfies the first assertion and fails only the second, so only the new test distinguishes them. **Any probe against a schema constraint must mutate the migration, not the Drizzle table definition.**

**Reading the actor from the request body instead of the verified token survived, and that was a real privilege-escalation hole.** The strict Zod schemas reject unknown keys, so `POST` and `PATCH` were already covered — but `DELETE /admin/skus/:code` validates `params` only, because it has no body to describe. An unexpected JSON body therefore reaches `req.body` unvalidated, and that one route is where a body-supplied actor would actually have worked, forging `audit_log.actor_user_id` to another real user. The new test sends exactly that body and asserts the audit row names the authenticated staff user. Recorded as a general rule: **a route with no body schema is not protected by the other routes' strict schemas**, and any future bodyless route must be audited for the same read.

### Test rewrite cost, measured rather than estimated

The design review predicted ~90 assertions would need rewriting. The real figure was much smaller because `price` was centralised in one `givenProduct` helper per suite: nine suites needed a one-line helper change plus the shared `giveSku` fixture, and the genuine reworks were confined to the exact-key-set assertions (`'price'` → `'skus'`, which sorts to the same position and so stays an exact assertion), the two product-body contract tests, and the price-filter suite's `pricesOf` reader.

Two price tests moved rather than being deleted: "normalises the price to the storage scale" and "returns the PERSISTED price, not the submitted one" now live in the SKU suite, where the price does. Deleting them would have lost the only assertions that distinguish a persisted value from an echoed request.

### Deferred

Variant option grids (`product_option`, `product_option_value`, `sku_option_value`, option signatures, duplicate-combination constraints) → Increment 25. SKUs here are option-less on purpose.

`DROP COLUMN product.price` → Increment 25, once the SKU read path has settled.

Tax classification → the tax increment. The placement decision is recorded (`sku.tax_class_id` nullable, falling back to `product.tax_class_id`), and **no column was added**: a `tax_class_id` needs a `tax_class` table to reference, and that table needs GST rates and HSN/SAC mappings that are accounting determinations. Adding a nullable column with no FK now would be speculation.

Also deferred: product/SKU media and `sku_id` on media · inventory, stock and reservations · `compare_at_price`, weight and dimensions · bulk SKU import · SKU-level search and sorting · keyset pagination.

### Requires manager / accounting decision

- **SKU code generation.** Merchant-supplied is implemented; there is no generation subsystem. Whether the platform should offer one, and in what format, is open (roadmap D3).
- **Case sensitivity of merchant codes.** Implemented as case-sensitive per the `codeColumn` convention. Worth an explicit confirmation, because it is the kind of decision a merchant notices only after creating `abc-1` alongside `ABC-1`.
- **The last-active-SKU behaviour.** Implemented as "the product silently leaves the storefront". The alternative is to refuse the deactivation with a 409; that needs a row lock and is a business call, not an engineering one.
- **Whether two SKUs of one product may attract different GST rates.** Blocks tax classification, not this increment. Slab-based rates would require it; that is accounting's determination.

### Known limitations

`product.price` is still physically present. Nothing reads it, and its values are now a historical record rather than live data — a price edited on a SKU does not update it, and it will be wrong for any product created after this increment (where it is NULL). It exists only so the pre-migration values remain auditable for one increment.

A product may have zero SKUs. That is a legitimate intermediate state — a merchant creates the product, then adds its variants — and the public predicate makes it harmless. It also means the admin response's `skus` array can be empty, which the OpenAPI description states.

## 38. Phase 2 increment 25 — the option grid, and letting PostgreSQL hold the invariants

**A SKU is still the sellable unit.** There is no `variant` entity, because a variant is a _relationship_ — a product plus a choice of option values — not a thing. A table between product and SKU would be a synonym for SKU reached through an extra join.

Three tables, one column, one migration with no backfill, eight admin endpoints.

```
product
 └── product_option          Size, Colour
       └── product_option_value  Small, Red
sku
 └── sku_option_value        junction → product_option_value
```

### Composite foreign keys, so the invariants have no application code

The design brief asked which invariants belong in foreign keys and which in application validation. The answer turned out to be further toward the database than expected, because three denormalised columns buy five constraints that make corruption **unrepresentable** rather than merely rejected.

`product_option_value` carries `product_id`, and `sku_option_value` carries `option_id`, `product_id` and `store_id`. Each is half of a composite key:

| Key                                                  | Makes impossible                                  |
| ---------------------------------------------------- | ------------------------------------------------- |
| `fk_pov_option_product (option_id, product_id)`      | a value whose option belongs to another product   |
| `fk_sov_sku_product (sku_id, product_id)`            | a junction row lying about its SKU's product      |
| `fk_sov_value_product (option_value_id, product_id)` | a SKU carrying **another product's** option value |
| `fk_sov_sku_store (sku_id, store_id)`                | a junction row lying about its tenant             |
| `fk_sov_value_option (option_value_id, option_id)`   | a **falsified `option_id`**                       |

Read together, the SKU's product is pinned by one key and the value's product by another, and both must equal the row's own `product_id`. **"A SKU option value must belong to the same product as the SKU" therefore has no application code at all.**

The last row is the subtle one. `uq_sov_sku_option (sku_id, option_id)` is what forbids a SKU being both Red and Blue — but on its own it is trivially defeated by writing a _false_ `option_id`, at which point the index cheerfully admits the second value. `fk_sov_value_option` is what makes `option_id` honest, and therefore what makes that unique index mean anything. Neither is sufficient alone.

All six attacks were attempted against PostgreSQL 16.15 in a throwaway schema **before any code was written**, and all six were rejected by the database.

**The cost, stated plainly:** five extra unique indexes whose only purpose is to be FK targets, because PostgreSQL requires a unique constraint on exactly the referenced columns — `ERROR: there is no unique constraint matching given keys for referenced table`. Two of them are on the pre-existing `sku` table. They add no guarantee of their own (`id` is already the primary key in every case); they are the price of the five that do.

### The migration's statement order is load-bearing

drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated output fails on the first composite key — the FK-target unique indexes do not exist yet. The generated migration was **hand-reordered** to hoist them, and the file says so at the top, because regenerating it will reintroduce the original order. This was found by running the migration, not by reading it.

### The option signature

PostgreSQL cannot derive a generated column from another table, so the application maintains it. Every part of the format is a decision:

- **Sorted `product_option_value` ids, joined with `,`.** Sorting is the whole point: `Red+Small` and `Small+Red` are the same variant and must collide. Ids rather than names, so renaming a value cannot silently redefine what a SKU is — a merchant fixing a typo in "Rde" must not make two SKUs suddenly identical.
- **Value ids only**, not `(option, value)` pairs. A value belongs to exactly one option, so the value set already determines the option set; carrying both would be a second source of truth.
- **`''` for an option-less SKU**, `NOT NULL`. A nullable column with a plain unique index would also permit many option-less SKUs, since `NULL`s compare distinct — rejected because it gives one fact two spellings, and every future reader would have to know which means "no options".
- **`Array.prototype.sort`, never `localeCompare`**: the latter is locale-sensitive, so the same combination could sort differently on another machine and quietly acquire a second signature.
- Practical ceiling ~70 values per SKU, from PostgreSQL's B-tree entry limit. The caps below keep it far below that.

`buildOptionSignature` is the only place it is computed, and a test pins the exact string for a known pair of ids rather than round-tripping through the builder — because if the ordering or delimiter ever changed, every stored signature would be invalidated with **no error at the moment of the change**.

### The uniqueness index needed a second predicate

The approved direction was `UNIQUE(product_id, option_signature) WHERE option_signature <> ''`. Demonstrated against PostgreSQL during the design review: that reserves a deleted SKU's combination **forever**, so a merchant can never re-create a variant they deleted — a 409 with no way out.

Shipped as `WHERE option_signature <> '' AND deleted_at IS NULL`, which is the identical rule `uq_sku_code_active` already applies to `code`. Both predicates are load-bearing and both have a test: one that many option-less SKUs coexist, one that a combination is reusable after its holder is deleted.

### Option and value deletion is REFUSED while in use

Two designs were weighed. **(A)** refuse while a live SKU references it. **(B)** soft-delete and leave the junction rows.

B is cheaper at the moment of deletion and more expensive everywhere else, permanently. It creates a state in which a SKU's stored combination no longer describes what it is: the public response would show a _partial_ combination — "Red / Small" becoming "Small", indistinguishable from a genuinely Size-only SKU — and, worse, re-creating "Red" mints a **new id**, so the "same" combination gets a different signature and `uq_sku_combination` can no longer see the collision. The requirement that duplicate combinations be _impossible_ could not survive it.

A was chosen, and the insight that makes it cheap is that **soft**-deleting the value is what protects history: the guard asks only about SKUs with `deleted_at IS NULL`, so a value used solely by already-deleted SKUs retires freely, and those historical rows keep pointing at a row that still exists. The 409 names the blocking SKU codes, because the whole point of refusing rather than cascading is that the merchant decides what happens to those SKUs — and cannot decide without knowing which they are.

**No `is_active` on options or values.** `sku.is_active` already controls sellability; an option-level flag would be a second, overlapping way to hide the same thing, with no rule for what a SKU means when its option is deactivated. That is the state machine the brief said not to invent.

### Replacement hard-deletes; deletion never does

`uq_sov_sku_option` rejects the new value of an option while the superseded row is still present, and the junction table deliberately has no `deleted_at` — giving it one would force that index to become partial, and a SKU's _current_ combination would become a query over surviving rows rather than a fact.

So combination replacement hard-deletes the rows it supersedes. That is not in tension with "retain historical relationship rows", which is about deleting a SKU or a product: those delete nothing here. The history of an **edit** lives in the `sku.options_updated` event and its audit metadata, which carry the before and after combinations — which is why that metadata is a requirement rather than a nicety. It is the only surviving record that a SKU was ever Red.

### One transaction, and what proves it

Everything that could leave `sku_option_value` and `sku.option_signature` disagreeing happens inside one transaction: superseded rows removed, new rows inserted, signature recomputed and written, event and audit emitted. A rollback discards all of it.

The test that proves this provokes a **real** rollback by naming an actor whose user does not exist — `audit_log.actor_user_id` is a foreign key, so the audit insert fails _after_ the junction rows and the signature have already been written. With separate transactions the rows and signature would already show the new combination. It is the same technique that proved Increment 24's cascade atomicity, and it is the only assertion that distinguishes the two designs.

Product deletion extends the existing cascade: product → SKUs → options → values, all soft, all in one transaction. **Ordering is load-bearing** — the delete guard is satisfied by construction because the SKUs were soft-deleted two statements earlier, so options before SKUs would refuse the product's own deletion. `sku_option_value` is left entirely alone.

### Concurrency

Two requests building the same combination both validate against a database showing neither taken, so both pre-checks pass and **the unique index decides**. The loser's whole transaction rolls back, leaving no partial junction rows. Asserted under genuine concurrency with `Promise.all`, and the assertion checks all three: exactly one 200 and one 409, exactly one SKU carrying the signature, and exactly one junction row in total.

The pre-check exists only so the ordinary sequential case gets a clean 409 rather than a translated constraint violation — the same division of labour as `ProductSlugTaken` and `SkuCodeTaken`. No advisory locks, and still no row lock anywhere in this codebase.

Only `uq_sku_combination` is translated to `SKU_COMBINATION_TAKEN`. Any other unique violation is rethrown untouched, because telling a client their variant is a duplicate when the real failure was a duplicate option name sends them looking for a clash that does not exist. Probe 15 exists to prove that distinction is tested rather than merely intended.

### Case-insensitive option names, in the database

`uq_product_option_name_active (product_id, lower(name)) WHERE deleted_at IS NULL`, and the same shape one level down for values. A `lower()` **expression index in the migration**, not application lowercasing, so a bulk import or an operator running SQL cannot create the duplicate the API rejects. `citext` was not used: it needs an extension, and an expression index is the smaller thing that works.

This is the deliberate **opposite** of `sku.code`, and the reason is stated rather than assumed: a SKU code is an identifier printed on purchase orders where `ABC-1` and `abc-1` may genuinely differ, whereas "Size" and "size" are one option to every human who reads them, and letting both exist would give the variant grid two identical columns. The column stores the merchant's own capitalisation; only the comparison is folded.

### Grid-size caps are hygiene, not merchandising

10 options per product, 100 values per option, 10 values per SKU — all `400`, all documented. They exist so an absurd request fails cleanly rather than as a database error or a signature approaching the B-tree entry limit that `uq_sku_combination` depends on.

The per-SKU cap is enforced by the Zod array bound, because it is a property of the _request_ and so never reaches a transaction. The other two are service-side counts of **live** rows only: retired options must not permanently consume a merchant's budget. Racing past a cap is harmless by design — it leaves a product one option over a hygiene limit, not in an invalid state — which is why they are 400s rather than 409s.

### API surface: eight endpoints, and three deliberately absent

`POST`/`GET /admin/products/:slug/options`, `PATCH`/`DELETE /admin/options/:id`, `POST /admin/options/:id/values`, `PATCH`/`DELETE /admin/option-values/:id`, and `PUT /admin/skus/:code/options`.

Not built: `GET /admin/options/:id/values` (values are nested in the option list — one shape, one parser), `GET /admin/skus/:code/options` (the combination is on `SkuResponse`, so every existing SKU read already returns it), and incremental single-association endpoints (replacement covers it, and an incremental API would need its own partial-failure story).

`PUT` rather than folding options into the existing `PATCH /admin/skus/:code`: that endpoint is documented as writing `name`, `price` and `isActive` and rejects anything else, so extending it would change a published contract — and it would give one endpoint two unrelated concurrency failure modes.

`optionValueIds` is **required** even though `[]` is legal. Clearing a combination is a deliberate act; if omission meant "clear", a typo in the field name — which `strictObject` otherwise catches as a 400 — would silently wipe the grid.

This increment establishes the **first UUID path parameter** in the project. Options have no merchant-facing code, so the id is the only key, and `OptionIdParamsSchema` makes a malformed one a 400 from validation rather than a `22P02` surfacing as a 500.

### Public response

`SkuResponse.options[]` — flat `(option, value)` pairs, not nested, because `uq_sov_sku_option` means each option has exactly one value on a SKU; nesting would model a cardinality the database forbids. `option_signature` is **never** published: it is an internal, order-sensitive encoding, and exposing it would turn a private format into a contract that could not then be changed.

Options do not participate in visibility. Sellability is a property of the SKU, so the shared `EXISTS` predicate is untouched and a product with no active SKU stays hidden exactly as before.

No product-level "selectable options" block. A storefront can derive the selectable set from the SKUs it was given, which has the advantage of never offering a combination that has no SKU behind it.

### Mutation verification

Fifteen probes, all fifteen caught. Twelve were caught on the first pass; the three survivors are worth recording, because **not one of them was an under-tested invariant** — two were bad probes and the third found a real defect in this increment's own code.

| Probe                                                    | Target        | Result              |
| -------------------------------------------------------- | ------------- | ------------------- |
| Drop `product_id` from the option ownership predicate    | repository    | caught              |
| Drop `store_id` from a child repository predicate        | repository    | caught              |
| Allow a value from another product                       | service       | caught              |
| Remove `UNIQUE(sku_id, option_id)`                       | **migration** | caught              |
| Remove `uq_sku_combination`                              | **migration** | caught              |
| Remove the signature's sort                              | service       | caught              |
| Stop updating `option_signature`                         | service       | caught              |
| Write the signature outside the transaction              | service       | caught _(2nd pass)_ |
| Allow deleted option values to be attached               | repository    | caught              |
| Remove the product-delete cascade for options            | service       | caught              |
| Public mapper exposes deleted values                     | repository    | caught              |
| Public price `EXISTS` → `JOIN`                           | repository    | caught              |
| `COUNT` uses a different SKU predicate                   | repository    | caught              |
| Body-supplied store id overrides the token scope         | routes        | caught _(2nd pass)_ |
| Catch **all** unique violations as combination conflicts | service       | caught _(2nd pass)_ |

**Two probes against database constraints mutate the MIGRATION.** The test database is built by `runMigrations` from the SQL files, so mutating a Drizzle table definition has no runtime effect at all — which is exactly how Increment 24's probe S7 "survived" while testing nothing. Coverage is not claimed from any mutation that leaves the live schema unchanged.

#### The three second-pass probes

**"Signature written outside the transaction" first survived because the probe could not fail.** It wrapped the write in `Promise.resolve().then(...)`, and `AsyncLocalStorage` **propagates across microtasks** — so the write was still inside the ambient transaction and nothing had moved. Rewritten to use `onCommit`, which genuinely defers past `COMMIT` and is a mistake a real developer would plausibly make ("the signature is derived data, write it after we know we committed"). It was then caught — and it exposed a **genuine gap in the tests**: the duplicate-combination test asserted the loser's signature was unchanged but never that the loser had no junction rows. With the write deferred past commit, the junction rows commit first and the unique violation arrives too late to undo them, leaving a SKU carrying a combination its own signature denies. That assertion now exists.

**"Body-supplied store id" first survived because it was mis-targeted.** It mutated `createOption`, whose `strictObject` rejects an unknown `storeId` with a `400` _before the handler runs_ — the mutation was unreachable. Retargeted at `DELETE /admin/options/:id`, which validates `params` only because it has no body to describe, and where an unvalidated body therefore does reach `req.body`. That is the Increment 24 finding — a route with no body schema is not protected by the other routes' strict schemas — re-tested rather than assumed closed, and this increment adds two more such routes.

**"Catch all unique violations" first survived because it is genuinely equivalent at that site.** Only `uq_sku_combination` is reachable inside the replacement's `try`: the two-values-per-option pre-check runs first, and the array-level duplicate check is in Zod. A catch-all there cannot mislabel anything. To make the defect observable the probe was paired with the removal of that pre-check, so `uq_sov_sku_option` reaches the same catch — and that immediately exposed a **real bug in this increment**. The same-option conflict had been raised as `new Conflict(message, { code: 'SKU_OPTION_CONFLICT' })`, but `Conflict.code` is a class property, so `details.code` never became the wire code: clients saw the generic `CONFLICT` and could not distinguish "drop a value" from "choose a different variant". Fixed with a proper `SkuOptionConflict` class, and the test now pins the error **code** rather than only the `409`. A status-only assertion was what let the bug through.

### Deferred

Option types (swatch, dropdown) and per-value metadata such as a hex colour — presentation with no invariant behind it. Automatic SKU-matrix generation from the grid. Incremental association endpoints. Shared option templates across products. Per-SKU option search and faceting.

`DROP COLUMN product.price` is still carried from Increment 24 and still referenced by nothing. Deliberately **not** bundled here: mixing a destructive column drop into the increment that adds three tables and five composite keys would put two unrelated risks in one migration.

### Requires manager / accounting decision

- **Whether two SKUs of one product may attract different GST rates.** Still blocks tax classification, not this increment. The option grid makes the question concrete — a Size option could plausibly cross a slab boundary — but the answer is an accounting determination.
- **Whether the caps are right.** 10/100/10 are engineering hygiene; the numbers were confirmed, but they are the kind of limit a merchant notices only on the day they hit it.

### Known limitations

A product may have options with no values, and SKUs with no options, at the same time. Both are legitimate intermediate states while a merchant builds a grid, and nothing downstream depends on the grid being complete — but it does mean the admin response can show an option no SKU uses, which is not an error.

The delete guard is a read inside the transaction rather than a lock. Two concurrent requests — one retiring a value, one attaching it to a SKU — serialise on the value row's own update, so the outcome is one of the two orderings and never both. There is no row lock, and no test could distinguish this from one, because the composite foreign key would reject the losing insert regardless.

## 39. Phase 2 increment 26 — inventory, and what a CHECK constraint cannot do

Two tables, one column of derived truth, three staff endpoints, and the fourth of the five §5 architecture rules.

```
sku
 ├── stock_item     the PROJECTION — one row per SKU, current state
 └── stock_ledger   the SOURCE OF TRUTH — append-only, one row per movement
```

§3 decision 7 had already settled the shape: _"Stock history: append-only ledger. The ledger is the source of truth; the projection is derived and reconcilable against it."_ This increment implements that decision rather than re-litigating it.

### The measurement that decided the concurrency mechanism

Eight scenarios were run against the real PostgreSQL 16.15 during the design review, with two pooled connections and a deliberate 120 ms stall inside each transaction to widen the race window.

| Strategy                         | two concurrent `+5` from 10 | two concurrent `-4` from 5         |
| -------------------------------- | --------------------------- | ---------------------------------- |
| read → add in JavaScript → write | **15** — an update was lost | **1, and BOTH reported success**   |
| atomic `on_hand = on_hand + δ`   | **20**                      | **1**, one success and one refusal |

Twenty concurrent mixed adjustments converged on the exact arithmetic total with the atomic form.

**The second column is the finding that matters, and it changes how §6 should be read.** Two concurrent read-modify-write decrements each read 5, each computed 1, each wrote 1. Both committed. The final value is a perfectly legal 1, and **four units of stock silently disappeared with no constraint violated** — because every value written was individually valid.

§6 lists a database CHECK constraint as defence 2 of 3 against overselling. That is true for negative stock and **false for lost updates**, which is the more insidious failure precisely because it leaves the database looking consistent. A CHECK constraint prevents negative numbers; it does not prevent arithmetic from being lost.

So the CHECK constraints ship as **backstops** — they catch a bug in the predicate and surface as SQLSTATE 23514 — and the atomic statement is the mechanism.

### One statement, six guarantees

```sql
UPDATE stock_item si
   SET on_hand = si.on_hand + :delta, updated_at = :now
 WHERE si.store_id = :storeId
   AND si.sku_id = (SELECT id FROM sku
                     WHERE id = si.sku_id AND code = :code
                       AND store_id = :storeId AND deleted_at IS NULL)
   AND si.on_hand + :delta >= si.reserved
RETURNING si.on_hand, si.available
```

Store scope, the SKU's existence, the SKU not being deleted, the right SKU, a legal result, and the arithmetic — all in one statement, each verified individually to return **zero rows** when violated. Nothing is ever read into JavaScript, adjusted there, and written back; `on_hand_before` is derived from this statement's own result, so the ledger's before/after pair cannot come from two different reads.

`on_hand + δ >= reserved` is simultaneously the non-negative rule and the reserved floor, because `reserved >= 0` is itself a CHECK. One expression, not two.

Zero rows means either "no such live SKU here" or "insufficient stock". A second **store-scoped** read after the rollback tells them apart — the idiom `transitionStatus` already established, so the boundary stays in the query and there is no second place for the store scope to be got wrong.

### Why not `SELECT … FOR UPDATE`, given §6

The lock is _correct_ — measured at the same final value — and strictly worse here:

- roughly **double the wall clock** (270 ms vs 139 ms), because it is held across application think-time rather than for one statement;
- it puts the arithmetic back in JavaScript, which is the shape the table above shows failing, leaving the lock as the only thing between correct behaviour and silent stock loss — and a lock is removable by a refactor that looks harmless;
- the non-negative rule moves out of the database and into a JavaScript `if`.

**`FOR UPDATE` becomes genuinely necessary the moment a decision spans several rows** — allocating a multi-line order needs a consistent snapshot across every SKU in it and deterministic lock ordering to avoid deadlock. §6's warning is exactly right there. It is not needed to add to or subtract from one row.

### All three §6 defences ship

1. **The ESLint rule landed**, unchanged: `local/no-relational-api-in-inventory` bans `db.query.*` under `src/modules/inventory/`. It guards nothing today — there is no lock to protect — and it ships anyway, because it must be in place _before_ the allocation increment writes the first `.for('update')`, and because `eslint.config.js` committed to these rules landing with their subject. Inventory was the missing subject. Its own tests prove it fires inside the module and stays silent outside; a rule that fired repo-wide would be one nobody could live with, and the first person to hit it would disable rather than narrow it.
2. **The CHECK constraints landed**, demoted to backstops for the reason above.
3. **The concurrency test landed** in the form §6 intends — _"a test that still passes without the lock is testing nothing."_ Here the mechanism is the atomic statement, so the test that must fail without it is the lost-update test, and probe Q1 replaces the statement with read-modify-write to prove it does.

No defence was removed or downgraded, so no ADR was raised.

### `available` is unwritable, not merely consistent

```sql
available integer GENERATED ALWAYS AS (on_hand - reserved) STORED NOT NULL
```

A stored generated column rather than a view, a service helper, or a mapper expression — each of which would be a second place the formula could be written differently, and a stock figure two endpoints disagree about is worse than one that is merely wrong.

PostgreSQL **refuses to write it**: `column "available" can only be updated to DEFAULT`. So the invariant is not asserted, enforced, or tested into existence — it is structurally impossible to violate. It can still be selected, used inside a CHECK, and indexed (verified, including partially).

`NOT NULL` is a second migration rather than an edit to the one that created the table: drizzle-kit keeps a snapshot per migration, and hand-editing an applied migration to say something its snapshot does not would leave the two disagreeing and produce phantom drift on the next `db:generate`.

### `reserved` ships at zero

Nothing writes it in this increment, and it is here so `available` has its final definition and its three CHECK constraints from day one. Unlike Increment 24's `product.price` — a mirror nothing read, which drifts — this is a column a known future increment will write, and its constraints are meaningful immediately. The reservation increment then changes no formula and no constraint anywhere.

### The projection can only be written beside the ledger

Both writes, plus the event and the audit record, share one transaction. A rollback discards all four, proven by provoking a real failure with the `audit_log.actor_user_id` foreign key — the technique that proved Increments 24 and 25 — and by a second test that fails at the _ledger_ insert instead, so the transaction is demonstrably not merely wrapping the audit call.

**The honest limit:** PostgreSQL cannot express "this UPDATE must be accompanied by that INSERT" without a trigger, and a trigger would hide the arithmetic from the code that reasons about it. So the guard is a reconciliation test — `SUM(delta) = on_hand` over a long mixed sequence of sequential adjustments, a concurrent burst, and rejections — plus a probe that removes each write. The residual risk is a future second write path, and that is the thing to watch in review.

### The ledger's order is a display order, not a causal one

Found by a test that assumed otherwise and failed. `created_at` defaults to `now()`, which in PostgreSQL is **transaction start time**, so concurrent transactions share it; and the UUIDv7 `id` encodes when the id was _generated_, not when its update took effect. Walking the rows in `(created_at, id)` order therefore does not reproduce the order the deltas were applied in.

The data was correct; the assumption was wrong. The reconciliation test now asserts what is actually true regardless of order: exactly one entry starts from the initial zero, every entry's own arithmetic adds up, and every intermediate level is both some entry's `after` and some entry's `before` — which cannot balance if a movement were lost or applied twice. Recorded because a later increment reading the ledger as a sequence will need a monotonic column, and that is a real gap rather than an oversight.

### Deletion needs no new code at all

The cheapest property of the increment, and worth stating plainly: inventory reads SKU liveness **through** the SKU rather than mirroring it, so there is nothing to keep in step and the existing deletion transactions are untouched.

- SKU soft-deleted → nothing happens to either table; the adjustment predicate's `deleted_at IS NULL` makes it unadjustable and the reads exclude it.
- Product soft-deleted → cascades to SKUs as before; inventory needs no cascade step.
- Ledger rows are never deleted or edited. There is no `deleted_at` and no `updated_at` on that table, so there is nothing to hide or rewrite an entry _with_, and no route exposes one.
- A hard delete of a SKU is refused by `ON DELETE RESTRICT`.

A `deleted_at` on `stock_item` would have created exactly the divergence Increment 25 had to design around. It was considered and rejected: the SKU's own flag is authoritative.

### An inactive SKU stays adjustable

`is_active = false` means "not sellable", not "not stocked". A merchant deactivates a SKU precisely _because_ they are counting, correcting, or clearing it, and refusing adjustments would make the deactivated state a trap where stock could never be fixed without first making the SKU sellable again.

So the liveness predicate checks `deleted_at IS NULL` and deliberately **not** `is_active` — and probe Q17 inverts it to prove the behaviour is tested rather than incidental. Catalogue sellability is unchanged: an inactive SKU is still invisible to every public path.

### A delta, never a target

The API accepts how much to add or remove, not what the new total should be. A target quantity would either require the client to read the current figure first — recreating the lost-update race one layer up — or silently discard a concurrent adjustment. A merchant who has physically counted 40 units wants a _recount_, which is a different operation with its own reason code.

The response therefore returns the resulting stock **and** the ledger entry, so a caller never has to re-read to learn the outcome, which is also what removes the temptation to read-then-write.

### Integer quantities, as an approved decision

`integer`: ±2.1 billion units, four bytes, exact, and it composes with `+` in SQL without any of the rounding discipline `Money` requires. Fractional quantities — weighed goods, cable by the metre, seat-months — are **out of scope**, and that was a decision rather than a deduction: nothing in the repository establishes whether such SKUs exist, since there is no unit-of-measure column and no product type anywhere.

The escape hatch is a table rewrite under `ACCESS EXCLUSIVE` plus matching changes to every CHECK and to the generated column. Cheap on four rows; a maintenance window on a real catalogue.

Zod uses `z.int()`, so `1.5` is a `400` rather than being truncated — silently rounding a merchant's stock figure would be worse than refusing it.

### Reason codes are technical, and stop where accounting begins

`manual_increase`, `manual_decrease`, `correction`. Three values, constrained by a database CHECK (a `varchar` + CHECK rather than a PG enum, matching `product.status`, because widening a CHECK is an ordinary `ALTER`).

**Deliberately absent:** `damage`, `theft`, `shrinkage`, `write_off`, `expiry`, `return_to_supplier`, `stocktake_variance`. Every one of those determines which ledger a loss is posted to and how it is treated for tax — accounting classifications, not mechanisms. Inventing them here would bury accounting policy in a CHECK constraint where the finance function would later find it and have to live with it. An operator records intent in `note`; widening the vocabulary is a one-line `ALTER` once accounting has ruled.

### No public stock field

Not caution — correctness. Every public stock signal is a promise, and this increment has nothing to keep it with: without reservations, a displayed "in stock" cannot be held for the duration of a checkout that does not exist yet. Publishing availability now would ship the storefront a guarantee the backend cannot honour, and the reservation increment's first job would be to redefine it.

When it is wanted, the ranking is already clear: a boolean `inStock` derived from `available > 0` is the right first step — it answers the buyer's actual question and leaks nothing. **Exact quantities are operational data**: they expose sales velocity to competitors, and "only 2 left" is a merchandising decision with its own increment.

### Indexes: two, and one deliberate omission

- `stock_item_pkey (sku_id)` — free with the table, and the reason one-row-per-SKU is structural rather than a droppable unique index. `sku_id` leads because it is the selective column; `store_id` alone matches the whole tenant.
- `ix_stock_ledger_sku_time (store_id, sku_id, created_at DESC, id DESC)` — the history endpoint's only read pattern, and the table's only index. `created_at DESC` supplies the ordering so the page needs no sort node.

**Not added:** a partial index on the generated `available` column. It works — verified — but no query in this increment filters by availability, because nothing public exposes stock. It belongs to whichever increment first adds an in-stock filter. Also not added: `stock_ledger(actor_user_id)`, because `audit_log` already answers "everything this user did" and is already indexed for it.

Zero new indexes on existing tables: Increment 25's `uq_sku_id_store` is already the composite-FK target both new tables need.

### Zero is an initialisation value, not a claim

The migration creates one `stock_item` per existing SKU at `on_hand = 0`. That asserts **this system has not yet been told what these SKUs' stock is** — not that the shelves are empty. Conflating the two is how a catalogue goes out of stock on the day inventory ships, so the migration says so in a comment rather than leaving it to be inferred.

Rows are created for soft-deleted SKUs too: a projection row for a deleted SKU is harmless (nothing can adjust it), while its absence would make the ledger's reconciliation property conditional on liveness and leave `GET` unable to distinguish "no row" from "zero stock".

**No ledger rows are created.** An initialisation is not a movement — `ck_stock_ledger_delta_non_zero` forbids a zero-delta entry anyway — and attributing one to an invented actor would put fiction in the audit trail. `stock_item.created_at` records when the row was initialised.

A SKU created _after_ the migration has no row, which would otherwise be a confusing 404 for a SKU plainly visible in the catalogue. The adjustment initialises it inside the same transaction and retries once: `ON CONFLICT DO NOTHING` makes a concurrent initialisation harmless, and the retry re-applies the identical predicate, so every guarantee holds on the second attempt exactly as on the first. It runs only when the SKU resolves as live, so an unknown or deleted SKU still falls through to the 404.

**Known limitation:** such a SKU does not appear in `GET /admin/inventory` until its first adjustment. Closing that needs either a catalogue hook or an outbox consumer, both explicitly out of scope here.

### Where inventory lives, and the one boundary it borrows

Its own module, `src/modules/inventory/`, matching the baseline's language ("the inventory module") and the ESLint rule's path scope.

`no-cross-module-imports` is absolute, so inventory cannot import anything from the catalogue — not even a type. But `schema-only-in-repositories` explicitly permits any `*.repository.ts` to import any table, and `db/schema/` is not a module. So `inventory.repository.ts` names the `sku` table directly, which is what makes the single-statement design possible without a port round-trip.

That is a deliberate, narrow use of that permission, confined to one predicate — and it is the increment's main architectural cost, because it puts one copy of the SKU liveness rule outside the catalogue. The alternative, folding inventory into the catalogue module, would contradict the baseline and leave the ESLint rule with no path to scope to. A test asserts a SKU code the catalogue accepts is a code inventory accepts, so the restated `skuCodeField` cannot drift silently either.

### Mutation verification

Twenty-two probes, all twenty-two caught. Seventeen fell on the first pass; the five that did not are the interesting ones, and **none of them was an untested invariant.**

| Probe                                              | Target        | Result              |
| -------------------------------------------------- | ------------- | ------------------- |
| Atomic arithmetic → stale read/write               | repository    | caught (6 tests)    |
| Drop the non-negative / reserved-floor predicate   | repository    | caught (5)          |
| Allow negative `on_hand`                           | **migration** | caught              |
| Allow negative `reserved`                          | **migration** | caught              |
| Allow `reserved > on_hand`                         | **migration** | caught              |
| Drop the one-row-per-SKU primary key               | **migration** | caught _(2nd pass)_ |
| Make `available` an ordinary writable column       | **migration** | caught (6)          |
| Drop the ledger's arithmetic CHECK                 | **migration** | caught              |
| Permit any reason string                           | **migration** | caught              |
| Drop the store scope                               | repository    | caught _(2nd pass)_ |
| Drop the SKU-not-deleted predicate                 | repository    | caught              |
| Skip the ledger insert                             | service       | caught              |
| Skip the event emission                            | service       | caught              |
| Skip the audit record                              | service       | caught              |
| Remove the transaction wrapper                     | service       | caught (28)         |
| Body-supplied `storeId` overrides the token scope  | routes        | caught _(2nd pass)_ |
| Make inactive SKUs unadjustable                    | repository    | caught              |
| Make deleted SKUs adjustable                       | repository    | caught              |
| Permissive reason validation                       | DTO           | caught              |
| Diverge the read predicate from the adjustment's   | repository    | caught _(2nd pass)_ |
| Catch-all masks `NotFound` as `INSUFFICIENT_STOCK` | service       | caught              |
| List `JOIN` duplicates rows                        | repository    | caught _(2nd pass)_ |

**Seven probes target the MIGRATION, not the Drizzle schema.** The test database is built by `runMigrations` from the SQL files, so mutating a table definition has no runtime effect at all — that is how Increment 24's probe S7 "survived" while testing nothing. Coverage is not claimed from any mutation that leaves the live schema unchanged.

#### The five second-pass probes

**Two were genuinely equivalent because a foreign key already guarantees the thing.** Dropping `stock_item.store_id` from the adjustment predicate survived, and correctly: the correlated subquery still scoped `sku.store_id`, and `fk_stock_item_sku_store (sku_id, store_id) → sku(id, store_id)` makes the two **impossible to disagree**. The same applied to the read predicate. This is a better outcome than Increment 24's equivalent survivor, where `store_id` in the visibility `EXISTS` was redundant only _by convention_ and needed a corrupt-row test to become load-bearing — here a constraint enforces it, so the redundancy is provable rather than assumed. Both probes were retargeted to remove the scope from **both** places, and both were then caught.

**One was neutralised by belt-and-braces.** Breaking the list's `JOIN … ON` clause survived because the `visible` predicate re-established the correct join condition in the `WHERE`. Removing the `WHERE` half too duplicates rows, and the page-versus-`total` assertions caught it.

**One was killed too weakly.** Dropping the one-row-per-SKU primary key made the migration _unappliable_ — the backfill's `ON CONFLICT (sku_id)` needs a unique constraint — so the suite failed on a migration error rather than on an assertion. Retargeted to keep the migration valid, and the duplicate-row constraint test then failed properly. A probe that prevents the tests from running has not demonstrated that they would have caught anything.

**One found a real gap.** A body-supplied `storeId` first survived because it was aimed at the `POST`, whose `strictObject` rejects the field with a `400` before the handler runs — the mutation was unreachable. Retargeted at `GET /admin/inventory/{skuCode}/history`, which validates `params` and `query` only because it has no body to describe, it survived again: **no test sent a body on a GET**, so the fallback always won. That is the gap Increment 24 found on a bodiless `DELETE`, now re-tested on the two bodiless routes this increment adds — a test that sends `{ storeId: <other store> }` on both GETs and asserts one merchant still cannot read another's stock movements.

#### The probe the whole increment turns on

Q1 replaces the atomic statement with read-modify-write and is caught by **six** tests, including both concurrency cases. That is §6's third defence in the form it actually applies here: _"a test that still passes without the safety mechanism is testing nothing."_

### Deliberately deferred

**Idempotency on the adjustment endpoint — the most likely immediate follow-up.** The
`Idempotency-Key` middleware from Increment 23 exists and is deliberately NOT applied here. A
retried `POST` after a client timeout will therefore adjust stock twice, which for a delta-based
API means the retry is a second real movement rather than a replay. That is the correct default
for an append-only ledger — nothing is silently overwritten and both entries are visible — but
it is not what a client expects from a retry. Applying the middleware needs its own decision
about what "same request" means for an adjustment, and inventing that here would have expanded
the increment.

Also deferred: reservations and allocation (the increment that will need `FOR UPDATE`, and the
one that first writes `reserved`) · multi-location inventory, whose seam is a `location_id` on
both tables plus a widened `stock_item` primary key · a monotonic ledger sequence, needed by
anything that reads the ledger as an ordered stream rather than a set · reconciliation and
repair tooling, so a projection that ever diverged from the ledger could be rebuilt · public
availability, whose first step is a boolean `inStock` and not a quantity · low-stock thresholds
and their events · cost price, batch, lot, expiry and supplier · bulk stock import.

### What the live smoke test found that 1091 tests did not

`stock_ledger.request_id` was first declared `uuid`. That was wrong, and wrong in a way the
integration suite structurally could not see: `resolveRequestId` **accepts a client-supplied
`X-Request-Id` header** whenever it is short enough and matches the safe pattern, so an id
arriving from an upstream proxy need not be a UUID — and a `uuid` column would have rejected
those inserts, failing an otherwise valid stock adjustment in production only. Every
Testcontainers request generates its own UUID id, so no test could produce the failing input.

The smoke test surfaced it twice over: the column could not be joined to
`audit_log.request_id` without a cast, which is the second symptom of the same mistake. It is
now `varchar(64)`, matching `audit_log` exactly.

Recorded because it is the clearest argument in this increment for running a smoke test against
the real server at all: the defect was not in logic the tests exercise badly, it was in an input
the tests cannot generate.

## 40. Phase 2 increment 27 — the customer address book

One table, five customer-facing routes, no defaults, no events, and audit metadata that
deliberately contains no address.

### The address book is mutable; orders are not

§3 decision 9 was already settled — _"Historical orders snapshot product and address data onto
order lines"_ — so this increment did not have to decide it, only to avoid making it hard.

**Nothing references an address row for historical truth.** There is no `order` table, no FK
pointing at `address` from anywhere, and no column that would make such a reference look
correct. The rule is restated here so the checkout increment inherits it explicitly rather than
rediscovering it: the moment a past invoice reads a live address, a customer fixing a typo
rewrites history.

### Ownership: the user, and the store through the user

`app_user.store_id` is NOT NULL and there is no user/store join table, so a user belongs to
exactly one store and an address is store-scoped automatically. `AuthenticatedUser` carries both
`id` and `storeId` from the verified token, so **neither ever needs to come from a request
body** — and no schema in the module has a field for either.

```sql
FOREIGN KEY (user_id, store_id) REFERENCES app_user(id, store_id) ON DELETE RESTRICT
```

Ownership and tenancy in one constraint, so a cross-store address row is **unrepresentable**
rather than merely rejected by application code. Its target index `uq_app_user_id_store` is the
third of its kind — `uq_sku_id_store` served `sku_option_value` and `stock_item` before it — and
had to be created **before** the key: drizzle-kit emits every `ADD CONSTRAINT` before every
`CREATE INDEX`, so the generated migration failed with _"there is no unique constraint matching
given keys for referenced table app_user"_. Verified by running it, then hand-reordered, exactly
as Increment 25 documented.

`store_id` in the repository predicates is arguably redundant once that key exists: it
guarantees an address's store equals its user's store, so `user_id` alone already pins the
tenant. It is stated anyway, because every predicate in this codebase carries its own scope and
a reader should not have to trace tenancy through a constraint. That redundancy is **reported as
equivalence** in the mutation results rather than engineered away.

### A 404, never a 403

Unknown id, another customer's address, another store's address, and a soft-deleted one all
produce the same `NotFound`. A `403` for "someone else's" would confirm the id exists, which is
exactly the leak one answer closes — §25's rule that ownership belongs in the query rather than
in a comparison performed afterwards.

One predicate serves the read, the update and the delete, so an address can never be readable
but not editable because two predicates drifted.

### The audit trail carries no address

**Identifiers and changed field NAMES only.**

```
action: address.updated   resourceType: address   resourceId: <id>
metadata: { "changed": ["city", "postalCode"] }
```

Not a before/after diff, and this is a deliberate departure from the catalogue's habit of
recording values. `audit_log`'s own doc comment gives the reason: it is _"read by more people
than the database, and frequently shipped to a log aggregator with different access controls."_
§36 already refuses to store address payloads in `idempotency_key` for the same reason, and §10
forbids logging request bodies because _"a checkout body holds an address"_.

So an auditor learns that this actor changed the city and postal code of this address at this
time — which is what an audit trail is for — without the trail becoming a second copy of the
customer's home address. Asserted by a test that scans the stored row's JSON for every address
value, not by reading the code. Log lines carry `addressId`, `userId` and `storeId` and nothing
else.

### No domain events

There is no `EventBus` in this module's dependencies. Nothing consumes an address change: the
handler registry is empty and no checkout exists. Increment 26 established the rule — _an event
with no consumer is a guess at one_ — and a test asserts the outbox stays empty, so adding one
later is a conscious decision rather than an accident. Audit is the whole obligation.

### Defaults are deliberately deferred, with the reason measured

No `is_default_shipping`, no `is_default_billing`, no endpoints, no indexes. Nothing consumes a
default until checkout exists, and the mechanism is more awkward than it looks. Measured against
this PostgreSQL during the design review:

| Attempt                                                  | Result                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Partial unique index, two concurrent "make default"      | one wins, one gets 23505 — correct                                                                         |
| **One-statement swap** `SET is_default = (id = $target)` | **fails, 23505** — even sequentially                                                                       |
| `UNIQUE CONSTRAINT ... WHERE`                            | **syntax error** — unique constraints cannot be partial                                                    |
| Promote the partial index to a deferrable constraint     | **refused**: _"is a partial index … Cannot create a primary key or unique constraint using such an index"_ |
| Clear every default                                      | permitted — so the index enforces **at most** one, never **exactly** one                                   |

The elegant single-statement swap is impossible because a partial unique index is checked
**row-by-row mid-statement**, and deferral is unavailable for partial indexes. The workable form
is unset-then-set in one transaction, where a concurrent burst of eight produced three successes
and five 23505s. All of that complexity for a feature with no consumer, so it waits — and when
it arrives, the pointer-column alternative (`default_shipping_address_id` on `app_user`) needs
its own composite FK, because a plain FK does not stop one user's pointer naming another user's
address. Also verified.

### Validation: bound it, trim it, and otherwise leave it alone

`recipientName` is ONE field, not a first/last split: the recipient is frequently not the
account holder, and Indian names do not divide reliably into two columns.

**No character allowlists** on any address line. Any regex worth writing would reject legitimate
Indian addresses — `#12/3-A, 2nd Cross, M.G. Rd.`, or text in Devanagari or Tamil — and a
validation layer that cannot express a customer's own address is worse than one that stores
something unusual. A test round-trips Devanagari, Tamil and an emoji label byte-for-byte.

**Normalisation is trimming and one uppercase, and nothing else.** No case folding, no
abbreviation rewriting, no punctuation normalisation, no PIN reformatting, no geocoding, no
deliverability check. A test asserts that `bengaluru`, `KARNATAKA` and `M.G. Rd.` are all stored
exactly as sent — rewriting a customer's address "helpfully" is a data-loss bug wearing a
convenience disguise.

`phoneField` is a **verbatim restatement** of identity's, whose comment reads _"Kept permissive
on purpose: real customer phone formats vary more than any regex we would write here."_ Restated
because `no-cross-module-imports` forbids importing it — the same narrow duplication inventory
made of `skuCodeField` — and guarded by a **drift test** that puts the same six phone values
through the registration endpoint and the address endpoint and asserts they agree.

`countryCode` is uppercased then shape-checked, the same normalise-then-validate order
`slugField` uses. The CHECK constrains **shape, not membership**: a 249-entry country list would
be a migration every time the list changes, and rejecting a legitimate country is a worse
failure than storing an implausible one. A test asserts `'ZZ'` is accepted, so the omission is a
recorded decision rather than a gap.

The Indian PIN rule `^[1-9][0-9]{5}$` applies **only when the country is IN**, checked against
the _effective_ country so an omitted `countryCode` still gets it via the `'IN'` default. Other
countries get the generic bound: this increment was not asked to invent foreign postal formats,
and a wrong guess would lock a customer out of their own address.

### Soft delete, and no restore

The row survives — §3 decision 15 is _"anonymise, never delete"_, and an address is personal
data inside that story. Gone from every read path immediately; a second delete is a 404, because
a `GET` on a deleted address answers 404 and a `DELETE` answering 204 would contradict the very
next request about the same id.

**No restore endpoint**, because none was asked for: a restore needs its own decision about what
a restored address means if its label now collides or its country's rules have changed. Erasure
itself is a later concern; this increment only refrains from making it impossible.

Labels are deliberately **not** unique. Two addresses called "Home" are the customer's business,
and a uniqueness rule would have to define what soft delete does to it for no gain.

### GST: one required field, and nothing else

`state` is **required and free text**. Required because `store.registered_address` is documented
as _"Drives the CGST/SGST vs IGST split: same state as the customer means CGST+SGST, different
means IGST"_ — an address with no state cannot support that later. Free text, and no
`state_code`, because a GST state-code catalogue is not this increment's to invent.

**No GSTIN on the address.** Seller GST identity already lives on `store` (`gstin`, `pan`,
`legal_name`), so the architecture had already answered where it belongs. A _customer's_ GSTIN is
customer tax identity — a third thing, alongside address data and order-time tax determination —
and putting tax registration in a delivery address would conflate two of them.

Nothing else GST-related is implemented: no rates, no HSN/SAC, no e-invoicing, no place-of-supply
computation, no GSTIN validation.

### Two indexes, one of them a pure FK target

- `address_pkey (id)` — free with the table.
- `ix_address_user_active (user_id, store_id) WHERE deleted_at IS NULL` — the ONE read pattern.
  `user_id` leads because it is the selective column; `store_id` alone matches the whole tenant.
  Partial because no query ever wants deleted rows: there is no restore endpoint and no history
  read, so indexing them would be dead weight.
- `uq_app_user_id_store (id, store_id)` on `app_user` — **FK target only**, adding no guarantee
  of its own.

Not added: anything on `postal_code`, `city`, `state`, `store_id` alone, or `deleted_at` alone.
Nothing searches addresses, and the partial predicate covers the last.

### Where the module lives

Its own module, `src/modules/addresses/`, rather than inside identity. `/users/me/*` paths are
already identity's, so two modules now serve that prefix — the deliberate cost of keeping a
mutable address book with its own PII rules as its own aggregate instead of growing a 1285-line
`identity.service.ts` further. It needs no port: ownership arrives from the verified token, and
the composite FK enforces it in the database, so `no-cross-module-imports` costs nothing here.

**No new ESLint rule and no new dependency-cruiser contract.** The three outstanding §5 rules are
bare `async` handlers, `queue.add` outside the event bus, and bare `fetch` outside
`integrations/` — none has addresses as its subject, so the "land with its subject" precedent
does not trigger.

### The reference SQL could not be consulted

§4 calls the reference `.md` authoritative for **shape and constraints** and says anything marked
CRITICAL is reproduced exactly. **That document is not in the repository** — `docs/` contains
only this file. The table above is therefore a design proposal that was reviewed and approved,
**not** a reproduction of the reference schema, and it was not inspected. If the reference SQL
specifies an `address` shape, this table should be checked against it.

### Mutation verification

Twenty probes, all twenty caught. Seventeen fell on the first pass; the three survivors were all
**bad probes**, not untested invariants, and each failed in a way the plan had predicted.

| Probe                                                   | Target        | Result              |
| ------------------------------------------------------- | ------------- | ------------------- |
| Drop the ownership predicate (single-address scope)     | repository    | caught (4 tests)    |
| Drop the ownership predicate (list)                     | repository    | caught              |
| Drop the store predicate                                | repository    | caught              |
| Drop the soft-delete predicate                          | repository    | caught              |
| Accept a client-supplied `userId` on create             | dto + routes  | caught _(2nd pass)_ |
| Accept a client-supplied `storeId` on the bodiless list | routes        | caught              |
| Accept a client-supplied actor                          | routes        | caught              |
| Remove required-field validation                        | dto           | caught              |
| Remove the max-length bound                             | dto           | caught              |
| Remove trimming                                         | dto           | caught              |
| Remove country uppercasing                              | dto           | caught              |
| Remove the Indian PIN rule                              | dto           | caught (4)          |
| Composite FK → single-column                            | **migration** | caught              |
| Remove the blank-field CHECK                            | **migration** | caught              |
| Remove the country-shape CHECK                          | **migration** | caught              |
| Remove audit emission                                   | service       | caught              |
| **Leak address values into audit metadata**             | service       | caught _(2nd pass)_ |
| Extra field in the response                             | dto           | caught              |
| Remove the transaction around create                    | service       | caught (37)         |
| Catch-all masks the intended contract                   | service       | caught _(2nd pass)_ |

Three probes target the **migration**, because the test database's schema comes from
`runMigrations` — mutating a Drizzle table definition has no runtime effect and proves nothing,
which is how Increment 24's probe S7 "survived" while testing nothing. No probe was counted that
made the migration syntactically invalid.

#### The three second-pass probes

**A client-supplied `userId` on create first survived because it was mis-targeted.** The route
read `req.body.userId`, but `CreateAddressRequestSchema` is a `strictObject` and rejects the key
with a `400` before the handler runs — the schema _is_ the defence on a route that has one, so
the mutation was unreachable. Increments 25 and 26 each hit this once. Retargeted to widen the
schema **and** trust it, which is the reachable defect, and caught.

**Leaking address values into the audit metadata first survived because the probe was vacuous.**
It added a `leaked` key to the `recordAddressChange` call site, and that function reads only
`action`, `actor`, `addressId`, `storeId` and `changed` — the extra property was never read, so
nothing changed at runtime. Vitest transpiles without typechecking, so an excess property is not
even a compile error. Retargeted to leak inside the function, where the metadata object is
actually built, and caught immediately by the JSON-scanning PII tests.

**The catch-all probe first survived because it was genuinely equivalent, and that is a design
property worth recording.** The mutation fell back to a read when the update matched nothing —
but the read and the update use the **same** `scopeToOne` predicate, so the update matching
nothing means the read matches nothing too, and the fallback could never fire. One predicate
serving both is what makes an address impossible to read-but-not-edit, and it also makes that
class of masking bug unrepresentable. Reported as equivalence rather than engineered around; the
retargeted probe swallows the audit write's failure instead, which masks a rollback and is caught
three times over.

#### Vacuity identified in advance

The index probe from the plan was **not run as a correctness mutation**. Removing
`ix_address_user_active` changes performance, not behaviour, and no test could legitimately
distinguish it — claiming it as a kill would have been dishonest. It is listed here so the
omission is deliberate.

### What the live smoke test taught, and one thing it did not find

**No product defect.** All 85 checks pass, including the composite foreign key refusing a
cross-store row, the two CHECKs refusing a blank field and a lowercase country code, and the
audit trail containing none of the recipient name, street, city, phone or PIN.

Three checks failed at first and the cause was the **harness, not the code**: on Windows the
shell substitutes `?` for characters it cannot represent, so `octet_length(state)` came back as
7 ASCII bytes instead of the 21 that `कर्नाटक` occupies. Re-sent as bytes from a file written by
node — bypassing the shell entirely — the same request stores 21 octets / 7 characters, the
Tamil recipient name 31 octets, the emoji label 11, and `line1` trimmed but otherwise byte-for-
byte. Recorded because "the smoke test says the Unicode is broken" is exactly the kind of
finding that gets believed without being checked; the integration suite, which sends bytes
through supertest with no shell in between, had been asserting the correct behaviour all along.

A fourth check failed for a second harness reason worth naming: the cross-store insert first
used a **nonexistent** store id, so `address_store_id_store_id_fk` fired before the composite
key and the test proved nothing about ownership. It now creates a real second store, which is
what makes `fk_address_user_store` the constraint under test.

## 41. Phase 2 increment 28 — the shopping cart

Two tables, four routes, no price snapshot, no reservation, no events, no audit. The cart is
deliberately the thinnest aggregate in the codebase, and most of what follows is a record of
what it does **not** do and why.

### The cart is persistent, and it is never deleted

`status` is `active | checked_out`, and there is exactly **one active cart per customer per
store**:

```sql
CREATE UNIQUE INDEX uq_cart_active ON cart (user_id, store_id) WHERE status = 'active';
```

The partial predicate is the whole lifecycle. A checked-out cart falls out of the index, so it
neither blocks the customer's next basket nor has to be deleted to get out of the way — which
means checkout, when it arrives, can transition a cart in place instead of copying and dropping
it. §36 already fixed _"one order per cart, one payment per order"_, and this shape is what makes
that reachable.

No `expires_at`, no sweeper, no TTL. An abandoned cart costs two narrow rows, and a customer
returning after three weeks to find their basket intact is the behaviour every storefront the
project is modelled on actually has. Emptiness is expressed by having no lines, not by having no
cart.

`DELETE /users/me/cart` therefore **clears the lines and keeps the row**: a cart is a container,
so emptying it does not churn its identity, and the customer's `uq_cart_active` slot stays
exactly where it was.

### GET creates the cart, and that is the only way one appears

There is no create endpoint. A `404` meaning "you have no cart yet" would push cart creation
into every client's first action for no benefit.

The implementation is **two statements, not one**, and this was measured rather than reasoned.
The obvious single-CTE form — `INSERT … ON CONFLICT DO NOTHING` with a `UNION ALL SELECT` —
is wrong under concurrency: the losing request's read runs in the snapshot taken at statement
start, before the winner committed, so it sees no row and the caller gets **nothing at all**.
Insert-then-read as separate autocommit statements gives the loser a fresh snapshot and both
callers get the winner's cart. Verified with two and with eight concurrent callers: one row,
one id, every time.

It is deliberately **not** wrapped in a transaction. `REPEATABLE READ` would reintroduce the
stale snapshot it is designed to escape — one of the few places in this codebase where adding a
transaction would make a correctness bug, not prevent one.

Two consequences of the conflict target are worth recording, because both are easy to get wrong:

- The `ON CONFLICT` clause must **restate the index predicate** (`where status = 'active'`).
  PostgreSQL matches a partial unique index as an arbiter only when the statement repeats its
  predicate; without it the statement fails outright. Drizzle 0.45 spells that option `where`,
  not `targetWhere`.
- A partial unique index cannot be deferred, and is checked per row mid-statement. There is no
  window in which two active carts exist.

### `PUT` SETS the quantity — it never adds

`PUT /users/me/cart/items/:skuCode` with a body of exactly `{ quantity }`. The body says what
the quantity should **be**.

This is the increment's most consequential API decision, and it is what lets the cart ship with
**no `Idempotency-Key` middleware at all**: repeating the identical request is a no-op, so a
client retrying after a timeout cannot double a line. An increment endpoint would double — that
was measured against PostgreSQL, not assumed. §36's idempotency infrastructure is reserved for
checkout by its own documentation and its header is mandatory when mounted, so mounting it here
would have `400`ed every client that omitted a key, to solve a problem the method already
solves.

Correctness does not rest on the verb, though. The line is written by one atomic upsert keyed on
the primary key:

```sql
PRIMARY KEY (cart_id, sku_id)
```

so two simultaneous writes converge on one row — last writer wins — and two lines for one SKU
are structurally impossible rather than merely unlikely. The concurrency tests assert exactly
that and no more: **one line holding one of the requested quantities, not which one.** Claiming
a stronger guarantee than the database provides would be manufacturing a promise.

`quantity: 0` is a `400`, not a delete. `DELETE` already says that precisely, and one route
meaning two things would need two success codes. Bounds are `1..999`, stated in Zod **and** in
`ck_cart_line_quantity`: the Zod bound is what turns an absurd value into a clean `400` naming
the field, and the CHECK is the backstop for every other writer — without the former the same
request surfaces as a raw SQLSTATE 23514.

### No price on the cart, ever

`cart_line` has no price, no currency and no total. `unitPrice` and `lineTotal` are computed at
read time from the SKU's **current** price, through `shared/money.ts`.

§3 decision 9 already puts snapshotting on **order** lines. A second snapshot on the cart would
be a competing copy with no defined precedence at checkout, and a three-week-old cart would
quote a price the merchant has withdrawn. So a price change is visible on the customer's next
read and needs no reconciliation — a cart is not a quotation.

Currency comes from the resolved **store**, which is the currency aggregate (§6). Neither the
cart nor a line carries one, so a basket cannot mix currencies.

### Stock is not consulted and nothing is reserved

Adding 50 of a SKU with 2 on hand succeeds. `reserved` is untouched and no `stock_ledger` row is
written; the cart does not read inventory at all, so a SKU with no `stock_item` row is still
addable.

Without reservations an availability check would be **stale the instant it returned** — it would
read as a promise while guaranteeing nothing, which is worse than not checking. §39 records that
authoritative allocation belongs to the order increment, and §3 decision 13 (_"two will double-
release reservations"_) is a warning about building that machinery ahead of its consumer.

### A line that can no longer be bought is kept and flagged

Adding a SKU that is unknown, another store's, inactive, deleted, or under an unpublished or
deleted product is one indistinguishable `404`, so the response reveals nothing about another
merchant's catalogue.

An **existing** line whose SKU later becomes unbuyable **stays in the cart** with
`isPurchasable: false`, and still counts toward `cartTotal`. Silently discarding a customer's
basket contents because a merchant edited a listing would be worse than telling them, and what
to do about it is the client's call and checkout's later.

Two asymmetries follow, both deliberate:

- **`DELETE` does not filter on purchasability.** Otherwise a customer would hold something they
  can neither buy nor remove.
- **`PUT` does.** Removing is always allowed; committing to _more_ of something unbuyable is not.

The add filter and the read flag are the **same predicate**, defined once. Two copies is exactly
how "you cannot add this" and "this is fine in your cart" end up disagreeing.

### `itemCount` is the number of LINES

Both readings are plausible and a client will depend on one, so it is stated: `itemCount`
answers _"how many distinct things are in the basket"_, which is what a cart badge shows. Not
the sum of quantities.

### Tenancy lives in the database, in two composite keys

```sql
FOREIGN KEY (user_id, store_id)  REFERENCES app_user (id, store_id) ON DELETE RESTRICT
FOREIGN KEY (cart_id, store_id)  REFERENCES cart     (id, store_id) ON DELETE CASCADE
FOREIGN KEY (sku_id,  store_id)  REFERENCES sku      (id, store_id) ON DELETE RESTRICT
```

The second and third pin the **same** `store_id` column, which makes a cross-store cart line
**unrepresentable**: naming our store fails the SKU key, naming theirs fails the cart key. There
is no third option. `uq_cart_id_store` is the fourth FK-target index of its kind, and the
generated migration failed for the fourth time with _"there is no unique constraint matching
given keys for referenced table cart"_ — drizzle-kit emits every `ADD CONSTRAINT` before every
`CREATE INDEX`. Confirmed by running it, then hand-reordered, with the correction documented in
the migration header.

`ON DELETE CASCADE` on the line-to-cart key is the **only** cascade in this schema, and it is
right for exactly this relationship: a line has no meaning without its cart, and a cart is not
an order, so there is no history to preserve. The SKU key is `RESTRICT` for the opposite reason
— a customer's basket is not something to discard because a merchant mistyped a delete.

`user_id` and `store_id` come from the verified access token and appear in **no** schema in the
module. That matters most on the three routes with no body schema, where an unexpected JSON body
reaches `req.body` unvalidated: Increments 24, 26 and 27 each found a real escalation on that
exact shape, so it is tested here rather than assumed closed.

### No events, no audit

Neither an `EventBus` nor an `AuditTrail` is in the service's dependencies.

Nothing consumes a cart change — the handler registry is empty and no checkout exists — and
Increment 26 settled the rule that _an event with no consumer is a guess at one_. Audit records
privileged or security-relevant acts; a customer adjusting their own basket is neither, while
being frequent enough that an entry per quantity tweak would bury the entries that matter. Both
absences are **asserted** by tests, so adding either later is a conscious decision rather than an
accident.

No transaction, either. Every mutation is one statement against one row, with no second write to
keep atomic with it — §21 confines `withTransaction` to real consistency boundaries.

### Guest carts remain out of scope

§7 still reads _"Guest checkout allowed | Phase 3"_. Every route requires a verified access
token; there is no session-keyed cart, no cart-merge-on-login, and `cart.user_id` is `NOT NULL`,
so a guest cart is not silently half-built. When guest checkout arrives it will need a
deliberate decision about identity, not a nullable column inherited from this increment.

### A property of the path, recorded rather than fixed

`sku.code` permits `/`, but a raw slash in a path is an extra URL **segment**, so `:skuCode`
never matches and Express answers `404` before any handler runs. Percent-encoded (`%2F`) it
decodes to the literal code and works. This is not a cart defect and was not changed:
`PATCH /admin/skus/:code` has had the identical property since Increment 24, and narrowing the
cart's pattern would make it reject codes the catalogue still mints. Asserted by a test so the
behaviour is recorded rather than discovered by a client.

### Mutation results — 34 probes, 34 killed

| Mutation                                           | Target        | Result |
| -------------------------------------------------- | ------------- | ------ |
| `itemCount` counts units instead of lines          | service       | caught |
| Line total ignores the quantity                    | service       | caught |
| Cart total sums unit prices instead of line totals | service       | caught |
| Extra field in the item allowlist                  | dto           | caught |
| **`PUT` increments instead of setting**            | repository    | caught |
| `ON CONFLICT` omits the partial-index predicate    | repository    | caught |
| `DELETE` requires the SKU to still be purchasable  | service       | caught |
| Inactive SKU addable                               | repository    | caught |
| Deleted SKU addable                                | repository    | caught |
| SKU under an unpublished product addable           | repository    | caught |
| SKU under a deleted product addable                | repository    | caught |
| `isPurchasable` flag ignores the SKU active flag   | repository    | caught |
| Purchasability not scoped to the store             | repository    | caught |
| Active-cart lookup not scoped to the user          | repository    | caught |
| Active-cart lookup not scoped to the store         | repository    | caught |
| Active-cart lookup ignores the status              | repository    | caught |
| Line listing not scoped to the store               | repository    | caught |
| Line delete not scoped to the store                | repository    | caught |
| Clear empties the whole store instead of one cart  | repository    | caught |
| Route trusts a client-supplied `userId`            | routes        | caught |
| `strictObject` → `object` on the PUT body          | dto           | caught |
| Quantity minimum 1 → 0                             | dto           | caught |
| Integer check dropped                              | dto           | caught |
| Quantity ceiling removed                           | dto           | caught |
| `uq_cart_active` no longer unique                  | **migration** | caught |
| `uq_cart_active` loses its partial predicate       | **migration** | caught |
| `pk_cart_line` demoted to a plain index            | **migration** | caught |
| `ck_cart_line_quantity` admits 0 and negatives     | **migration** | caught |
| `ck_cart_status` removed                           | **migration** | caught |
| `fk_cart_user_store` → single column               | **migration** | caught |
| `fk_cart_line_cart_store` → single column          | **migration** | caught |
| `fk_cart_line_sku_store` → single column           | **migration** | caught |
| SKU-in-cart `RESTRICT` → `CASCADE`                 | **migration** | caught |
| Cart-line `CASCADE` → `RESTRICT`                   | **migration** | caught |

Ten probes target the **migration**, because the test database's schema comes from
`runMigrations` — mutating a Drizzle table definition has no runtime effect and proves nothing,
which is how Increment 24's probe S7 "survived" while testing nothing.

**No survivors, and no probe was retargeted after the fact** — a first for this project, and it
is worth saying why rather than treating it as luck. Three of the traps that produced survivors
in Increments 25, 26 and 27 were designed out in advance:

- Probes aimed at a route with a `strictObject` body are unreachable, so the mass-assignment
  probe mutates the schema **and** the route's use of it (A20/A21), not the route alone.
- Every constraint probe mutates the migration and asserts the **named** constraint, so
  dropping a column from one composite key is caught by that key rather than accidentally by
  its neighbour. `fk_cart_line_cart_store` → single column is the clearest case: the row is
  still refused, but by the _other_ key, and pinning the name is what distinguishes those.
- Two probes (A17, A18) are killed **only** by the repository-level isolation test, because no
  HTTP request can supply a cart id in another store — the route derives it from the token. That
  test exists precisely so a guarantee living in a route rather than a query cannot pass
  unnoticed, and it is what makes those mutations reachable at all.

The index-only probe was **not run as a correctness mutation**: `uq_cart_id_store` adds no
guarantee of its own, and removing it makes the migration unappliable rather than exposing a
behaviour. It is listed here so the omission is deliberate.

## 42. Phase 2 increment 29 — coupon-code promotions

Two tables, seven routes, no stored discount, no redemption, no stacking, no targeting. The
domain was **undocumented before this increment** — searching all of §1–§41 for _promotion_,
_coupon_, _campaign_ and _offer_ returned one unrelated hit about staff role promotion, plus
_"sale and discount prices"_ in §33's deferred list. Every business rule below was therefore an
explicit decision, not a derivation.

### The infrastructure was built for this, years of increments early

Worth recording because it changed the shape of the work: `src/shared/money.ts` already
contained everything promotions needed, and its own comments say so. Its header speaks of
carrying precision through _"a long promotion chain"_; `percentOf` exists; `clampAtZero` is
documented as _"useful for discounts that must not turn a total negative"_; `allocate` is
introduced as _"the function that makes order-level discounts safe"_. `_shared.ts` designates
`rateColumn` — `NUMERIC(9,6)` — for _"a tax percentage, **a discount fraction**"_, and justifies
the money scale with _"a per-unit price after a 7.5% discount is not expressible in paise"_.

**So this increment added no money code at all.** The one thing it must not do is build a second
arithmetic path, and it did not.

### `promotion` is configuration; `cart_promotion` is intent

Neither stores money.

```sql
CREATE UNIQUE INDEX uq_promotion_code_active
  ON promotion (store_id, lower(code)) WHERE deleted_at IS NULL;

PRIMARY KEY (cart_id)                                            -- cart_promotion
FOREIGN KEY (cart_id, store_id)      REFERENCES cart (id, store_id)      ON DELETE CASCADE
FOREIGN KEY (promotion_id, store_id) REFERENCES promotion (id, store_id) ON DELETE RESTRICT
```

A row in `cart_promotion` does **not** mean a discount applies. The discount is recomputed on
every read from the cart's current subtotal and the promotion's current configuration — the same
no-snapshot judgement §41 made for prices, applied to the number derived from them. That single
decision is what makes all of the following true with no writes, no sweeper and no second source
of truth:

- a coupon that expires while a basket sits untouched simply stops discounting;
- one blocked by a minimum starts discounting again when the customer adds an item back;
- a merchant's price change or rate change moves the discount with it;
- a merchant renaming a coupon's code has not handed the customer a different coupon, because
  the association holds the **id**.

`ON DELETE RESTRICT` on the promotion key is what makes a soft delete safe: the row survives, so
a customer holding a retired coupon keeps their cart and only the discount stops. A hard delete
is refused, asserted by name from direct SQL.

### `cartTotal` changed meaning, deliberately

| Field           | Before               | Now                                                |
| --------------- | -------------------- | -------------------------------------------------- |
| `subtotal`      | —                    | the pre-discount sum of current line totals        |
| `discountTotal` | —                    | the promotion discount, `0.0000` when none applies |
| `cartTotal`     | the pre-discount sum | **`subtotal - discountTotal`** — the payable total |

This is a **breaking change to Increment 28's contract**, taken over the alternative of adding
`payableTotal` beside a `cartTotal` that meant something else. A field named `cartTotal` that
does not name what the customer pays is the field that gets misused, and the ambiguity would
have been permanent. The mitigation is that on a cart with no coupon the two are identical, so
an existing client sees a different number only on a discounted cart.

The identity `subtotal - discountTotal = cartTotal` holds on every response and is asserted
**arithmetically** — with `BigInt` on the returned strings, not with `Number` — on every route
that returns a cart.

`promotion` is `{ code, name, discountTotal }` or `null`. No promotion id, no `discountType`,
`percentRate`, `minSubtotal` or window: a customer needs to know which coupon is applied and
what it saved them, not how the merchant configured it. There is deliberately **no permanent
`rejectionReason`** — a cart reporting one forever would make every client render a stale
complaint; the reason belongs in the response to the apply request that earned it.

### The discount is computed ONCE, on the subtotal

```
percentage    ->  percentOf(subtotal, percent_rate)
fixed_amount  ->  min(amount, subtotal)
cartTotal     ->  subtotal - discount
```

Never per line and summed, and **the first version of that test proved nothing** — 19.99×3 plus
0.0001×7 at a third off happens to give the same answer either way. Measured against this
build's money module, the forms genuinely diverge when lines land on half-paisa boundaries:

```
two lines of 1.0001, 50% off
  once on the subtotal:  50% of 2.0002        -> 1.0001
  summed per line:       50% of 1.0001, twice -> 1.0002
```

Every money operation rounds to the storage scale — which is itself worth recording, because
`money.ts`'s header claims rounding _"happens ONCE, at the boundary"_ while `brand()` in fact
rounds at every construction. The error is a hundredth of a paisa per step and harmless at this
chain length, but it means **operation order is observable**, so the formula is specified rather
than left to the implementer. A second test asserts the discount is identical whether a ₹1000
cart is one line or two of ₹500 — the property a per-line implementation would break.

`allocate()` is **not** called in the cart, and `roundToMinorUnits` is not either. Both are
payment- and tax-boundary operations; using them here would put a minor-unit rounding step
between the cart and checkout.

The fixed-amount cap is `min(amount, subtotal)`, so a ₹500 coupon on a ₹200 cart takes ₹200 and
the total is exactly `0.0000` — never negative. For a percentage no cap is needed or written:
`ck_promotion_percent_range` bounds the rate at 100, so 100% reaches zero and cannot pass it. A
guard no test could reach would have been worse than the constraint.

### No stacking, enforced by a primary key

`PRIMARY KEY (cart_id)` on `cart_promotion`. Not a service check — a primary key, so a second
promotion cannot exist even if written by a seed script. Applying a second code **replaces** the
first in one request: requiring a `DELETE` first would be a rule the customer never agreed to,
and would leave their cart briefly with no promotion at all.

The write is one `INSERT … ON CONFLICT (cart_id) DO UPDATE`, which is also what makes it
retry-safe. Verified with eight concurrent applies of one code (one row) and with different codes
racing (one row, one of the two — **which one is not asserted**, because claiming more than the
database provides would be manufacturing a guarantee).

Relaxing the key to `(cart_id, promotion_id)` is the one-line change that would permit stacking,
and it would then need every rule this increment deliberately does not have: priority,
combinability, best-discount selection.

### The empty-cart guard had to move into the statement

**A concurrency test found a real defect, and it is the most useful thing this increment
produced.**

Applying a coupon reads the cart's lines, prices the promotion, then writes the association. With
the emptiness check in JavaScript, a `DELETE /users/me/cart` committing in between left a coupon
attached to an empty cart. Raced in a throwaway schema it happened **three times out of three**;
moving the guard into the insert's `WHERE EXISTS` refused it three times out of three:

```sql
INSERT INTO cart_promotion (cart_id, promotion_id, store_id)
SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM cart_line WHERE cart_id = $1 AND store_id = $3)
ON CONFLICT (cart_id) DO UPDATE SET promotion_id = excluded.promotion_id, updated_at = $4
RETURNING cart_id
```

Zero rows means the cart was emptied mid-flight, and the caller reports the same `422` the
sequential path gives. This is §39's lesson in a new place: **a check in application code is
advisory under concurrency however carefully it is written**, because the state can change
between the read and the write. Only a single statement closes the window.

The service-level check survives for one reason a mutation probe exposed: it decides _which_
`422` a customer sees when the coupon also has a minimum. "Add something to your basket" is
actionable; "spend at least ₹500" on an empty cart reads as a broken coupon.

Clearing a cart removes the lines **and** the association, in one transaction — the only real
consistency boundary in the cart module. A cart with a discount and no items must not be
observable, and leaving the association would mean the next added item silently revived a coupon
the customer had already cleared away.

### Coupon codes are case-insensitive; SKU codes are not

An explicit exception to `codeColumn`'s stated _"case-sensitive by design"_ default, and the
reason is the audience: a SKU code is a machine identifier, while a coupon is read off a banner
by a person. Refusing `save10` because the poster said `SAVE10` is a support ticket, not a
security boundary.

The mechanism is `lower(code)` in the unique index **and** in the lookup predicate — in the
database, so a bulk import that forgets to normalise cannot create a second `Save10`. The stored
code keeps the merchant's own casing: uppercasing it would take that choice away for no gain.
Partial on `deleted_at IS NULL`, so a retired `DIWALI24` does not block next year's, and a
deleted code is reusable immediately.

### The apply endpoint is not an enumeration oracle

Unknown, another store's, deactivated, soft-deleted, expired and not-yet-started all return one
**indistinguishable `404`** with the same message, and the submitted code is never echoed back.
Asserted by comparing the message of each case against the unknown-code case, not by inspection.

The single exception is `422 PROMOTION_MINIMUM_SUBTOTAL`, which names the threshold. It leaks
nothing worth having: the customer has already proved they know the code, and telling them what
to spend is the entire point of a minimum.

There is no customer-facing route that lists or discovers promotions, and a test asserts three
plausible such paths all `404`.

### Lifecycle: two independent switches, and a half-open window

`is_active` **and** `starts_at`/`ends_at` both exist because they answer different questions —
"stop this now" versus "run between these instants". Collapsing them would mean pausing a
scheduled sale destroyed its dates. There is no stored `expired` status and no scheduler: those
are derivable from `now()`, and a stored one would need a job to keep it true.

The window is **half-open** — `starts_at` inclusive, `ends_at` exclusive — matching every other
range in the system, so two consecutive windows cannot both be live for one instant.

**The API takes absolute instants only.** A bare local date is a `400`. `store.timezone` exists
and is still used by nothing; interpreting "the sale ends 30 September" in it is a real decision
and accepting a date would have made it silently, in whichever direction the implementer
happened to choose.

### Nothing is consumed

No redemption table, no usage counters, no per-customer limits, and applying a coupon does not
touch the `promotion` row at all — asserted by comparing it before and after. An abandoned cart
therefore cannot burn a limited coupon.

That deferral was proved rather than assumed, because it is the design that will need it most.
In a throwaway schema, a cap of 5 against 20 concurrent redemptions:

| Mechanism                          | With the CHECK                                   | Without it      |
| ---------------------------------- | ------------------------------------------------ | --------------- |
| read → check in JavaScript → write | 5 redeemed, but **15 raw constraint violations** | **20 redeemed** |
| single conditional `UPDATE`        | **5 redeemed, 15 cleanly rejected**              | **5 redeemed**  |
| `count(*)` → check → insert        | 5 redeemed, 15 raw violations                    | **20 redeemed** |
| per-customer, 8 concurrent         | 1 redeemed, 7 refused by the unique key          | —               |

The conditional `UPDATE` is the mechanism; the CHECK is the backstop; per-customer limits are a
unique constraint, not a count. Recorded here so the increment that adds redemption inherits it
rather than rediscovering it.

### Checkout inherits an advisory cart

Stated so it is not rediscovered: **cart promotion pricing is advisory, checkout is
authoritative.** It follows unavoidably from §41 — prices are not snapshotted, so a cart total
is already a live quotation and a discount computed from live prices is no different. Checkout
must re-read prices, revalidate the promotion, recompute the discount, and record redemption when
usage limits exist. A cart may display a discount that later expires; that is the honest
consequence of not snapshotting, and the same behaviour a customer already gets when a price
changes.

### The GST hand-off, decided now and implemented nowhere

No tax is implemented. One thing had to be settled so a future calculation is not ambiguous:
**a cart-level discount must be allocated across order lines before tax is computed**, using
`allocate()` at the order/tax boundary. Indian GST is charged on the transaction value — the
discount-adjusted amount — when the discount is recorded on the invoice, which makes the required
input a per-line taxable value. `allocate()` exists for exactly this and its own comment says so.

Nothing in this increment computes, stores, or references a tax rate, HSN/SAC, place of supply,
GSTIN, or an invoice.

### The port, and why `depcruise` had the last word

`no-cross-module-imports` forbids `modules/cart` from importing `modules/promotions` and forbids
the reverse just as firmly. So the **consumer declares the port** — `CartPromotions` lives in
`cart.service.ts` — and `container.ts` adapts the promotions service onto it, exactly as `http/`
declares `AccessTokenVerifier` and identity supplies a compatible function. Structural typing
means neither module names the other, and `depcruise` sees only two edges, both from the
composition root.

The port carries two operations and no more: price a code a customer typed, and re-price the one
they already applied. There is no way to list promotions or ask whether a code exists, so no
promotion rule and no enumeration capability can reach the cart through it.

The rules also caught a genuine boundary violation during implementation:
`schema-only-in-repositories` rejected `promotions/dto.ts` importing the table for its constants.
Fixed the way cart already does it — re-export from the repository — which is the established
pattern rather than a workaround, and keeps one source of truth for a value whose real
enforcement point is a CHECK constraint.

### Mutation results — 46 probes, 46 killed

| Mutation                                              | Target        | Result                            |
| ----------------------------------------------------- | ------------- | --------------------------------- |
| Percentage applied as a raw multiplier (no `/100`)    | service       | caught                            |
| Fixed discount not capped at the subtotal             | service       | caught                            |
| `cartTotal` = subtotal **plus** discount              | service       | caught                            |
| `cartTotal` ignores the discount                      | service       | caught                            |
| **Discount evaluated per line and summed**            | service       | caught _(2nd attempt)_            |
| Discount subtracted before the minimum is checked     | service       | caught                            |
| Minimum becomes exclusive                             | service       | caught                            |
| Minimum not checked on apply                          | service       | caught                            |
| Minimum not re-checked when re-pricing                | service       | caught                            |
| Inactive promotion usable                             | repository    | caught                            |
| Soft-deleted promotion usable                         | repository    | caught                            |
| Not-yet-started promotion usable                      | repository    | caught                            |
| Expired promotion usable                              | repository    | caught                            |
| Window end becomes inclusive                          | repository    | caught                            |
| Live lookup not store-scoped                          | repository    | caught                            |
| Admin lookup not store-scoped                         | repository    | caught                            |
| Code matching becomes case-sensitive                  | repository    | caught                            |
| Applied-promotion lookup not cart-scoped              | repository    | caught                            |
| Promotion removal not cart-scoped                     | repository    | caught                            |
| Clearing leaves the promotion behind                  | service       | caught                            |
| **Empty-cart guard dropped from the write**           | repository    | caught                            |
| Empty-cart check disabled in the service              | service       | caught _(after a test was added)_ |
| Upsert becomes an insert — replacement breaks         | repository    | caught                            |
| Apply body accepts unknown fields                     | dto           | caught                            |
| Create body accepts unknown fields                    | dto           | caught                            |
| Percentage ceiling removed from the schema            | dto           | caught                            |
| Staff guard dropped from the create route             | routes        | caught                            |
| Code collision check dropped                          | service       | caught                            |
| Collision check no longer excludes itself             | service       | caught                            |
| Type switch no longer clears the other column         | service       | caught                            |
| **Audit records changed VALUES, not names**           | service       | caught                            |
| Delete becomes a hard delete                          | repository    | caught                            |
| `pk_cart_promotion` demoted to an index               | **migration** | caught                            |
| `ck_promotion_shape` removed                          | **migration** | caught                            |
| `ck_promotion_percent_range` removed                  | **migration** | caught                            |
| `ck_promotion_amount_positive` removed                | **migration** | caught                            |
| `ck_promotion_window` removed                         | **migration** | caught                            |
| `ck_promotion_min_subtotal` removed                   | **migration** | caught                            |
| `ck_promotion_discount_type` removed                  | **migration** | caught                            |
| Code index loses `lower()`                            | **migration** | caught                            |
| Code index loses its partial predicate                | **migration** | caught                            |
| Code index is not unique                              | **migration** | caught                            |
| Line-to-cart key → single column                      | **migration** | caught                            |
| Cart-to-promotion key → single column                 | **migration** | caught                            |
| Applied promotion hard-deletable (RESTRICT → CASCADE) | **migration** | caught                            |
| Cart delete no longer cascades                        | **migration** | caught                            |

Fourteen probes target the **migration**, because the test database's schema comes from
`runMigrations` — mutating a Drizzle table definition has no runtime effect and proves nothing,
which is how Increment 24's probe S7 "survived" while testing nothing. Every constraint probe
asserts the **named** constraint, so dropping a column from one composite key is caught by that
key rather than accidentally by its neighbour.

#### The two probes that taught something

**The per-line probe failed to be a probe at all on its first attempt**, and the test it was
aimed at was equally weak: the chosen figures gave the same answer under both formulas. The
correct response was to find data that discriminates rather than to accept a green result — the
test now uses two lines that each land on a half-paisa boundary, and a second test asserts the
discount is independent of how the basket is split.

**Disabling the service's empty-cart check SURVIVED**, and correctly so: the database guard on
the write refuses an empty-cart apply anyway and reports the same error, so the mutation was
unreachable behind a stronger invariant. But it was not wholly redundant — that check alone
decides which `422` a customer sees when the coupon also carries a minimum, and nothing tested
it. A case was added; the probe now dies. Classified honestly rather than counted as a kill.

Two probes were designed and **not run**, listed so the omission is deliberate: a `void`
statement added beside the re-evaluation (equivalent by construction — it changes nothing), and
the `ix_promotion_store_active` index removal (performance only, no behaviour to distinguish).

## 43. Phase 3 increment 30 — checkout and orders

Three tables, three routes, one transaction. The first increment that takes a cart and produces
something a customer could be invoiced for — and the first to mount the idempotency machinery
§36 built for exactly this endpoint.

### Authenticated only, and `order.user_id` is NOT NULL

§7 still lists _"guest checkout allowed"_ as open with a default of "allowed, as a store
setting". That default was taken the other way here, deliberately: guest identity needs its own
decision — where a guest's identity lives, how it survives a session, how it merges on
registration — and a nullable owner column would weaken the composite tenancy key everything
else in this schema depends on. Reversing it later is a deliberate migration rather than a
column that silently permits an ownerless order today.

### The order number

`ORD-YYYYMMDD-XXXXXX`, `varchar(64)`, case-sensitive, generated server-side, never regenerated.

The date is UTC — a local date would need the timezone decision §42 explicitly declined to make
for promotion windows, and an order number is not the place to introduce one. The suffix is six
characters from a 32-symbol alphabet drawn with `randomInt`, so ~1.07 billion suffixes per store
per day.

**Deliberately not a sequence.** A serial in a customer-visible identifier leaks the store's
order count, which is the same reason `_shared.ts` chose UUIDv7 over `BIGSERIAL` for primary
keys. `I`, `O`, `0` and `1` are excluded so a number read off a printed invoice cannot be
transcribed into a different one.

Collisions are handled by `uq_order_number` plus a bounded retry — five attempts, then a loud
failure, the same judgement §19 records for refresh-token collisions. **The retry only works
because each attempt runs in a nested transaction**, which Drizzle implements as a `SAVEPOINT`:
measured against this PostgreSQL, a caught 23505 with no savepoint leaves every later statement
in the transaction failing with 25P02, while the same sequence inside a savepoint continues
normally.

### One status, and four state spaces kept apart

`order.status` has exactly one value: `placed`. `cancelled`, `pending_payment`, `paid`,
`payment_failed`, `packed`, `shipped`, `delivered`, `returned` and `refunded` are all absent —
each would be written by an increment that does not exist, and a status value nothing can
produce looks supported to every reader of the enum.

`order_status_history` gets exactly one row, `from_status = NULL` → `to_status = 'placed'`,
because §3 #8 requires _"every transition is a row. No `UPDATE` rewrites the past."_ No
`updated_at` on that table and no `deleted_at` on any of the three: `_shared.ts` names order
status history among the tables _"never deleted at all"_, and §3 #15 ties order retention to tax
law.

The four state spaces stay separate — `cart.status`, `order.status`, a future payment table, a
future shipment table. Folding payment or fulfilment into this column is the shortcut that makes
both impossible to model properly later.

### The cart row is the serialisation point

This is the increment's central concurrency decision, and it was measured rather than reasoned.
Racing a coupon swap against a checkout in a throwaway schema:

| Design                                           | Result                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| no lock, no status guard on the swap             | order priced the OLD coupon, cart named the NEW one — **divergent**                                 |
| checkout locks, swap carries `status = 'active'` | **still divergent** — the cart was legitimately still active when the swap ran, so the guard passed |
| the swap CONTENDS on the same cart row           | **consistent**, three runs out of three                                                             |

So a status predicate is necessary and **not sufficient**. Every cart write —
`setLineQuantity`, `deleteLine`, `clearLines`, `setAppliedPromotion`, `deleteAppliedPromotion` —
now takes `SELECT … FOR UPDATE` on the cart row inside a transaction, exactly as checkout does.
Exactly ONE row is locked; no SKU, promotion, address or stock row is, so there is no lock
ordering and therefore no deadlock to reason about. That is also why §39 could defer the
`FOR UPDATE` discussion to the allocation increment: this one needs no multi-row locking.

A write arriving after the transition finds the cart `checked_out` and is refused with
`CartAlreadyCheckedOut` (409) — a clean domain answer, not a database error. Separately measured:
without the guard, a line added after the transition was written **onto the checked-out cart**,
and a clear **emptied** it — rewriting the record the order was made from.

The checked-out cart keeps its lines and its applied promotion as history. It is never deleted,
and the next `GET /users/me/cart` returns a new empty active cart, which is what §41's partial
`uq_cart_active` index was shaped for.

### Three defences against a double checkout

1. the cart-row lock, which serialises attempts;
2. `status = 'active'` in the transition's `UPDATE`, so the loser learns from a row count rather
   than a constraint violation;
3. `uq_order_cart` — §36's _"one order per cart"_ stated as a constraint.

All three measured independently: any one of them alone yields a single order, but only the lock
refuses the loser **before** it does any pricing work, and only the transition gives it a clean
409 instead of a raw 23505. Eight concurrent checkouts produce one order and seven clean 409s.

### The transaction

One transaction contains the whole authoritative operation: lock the cart · read its lines with
current prices and purchasability · read and validate the address · re-price the promotion ·
compute the money · transition the cart · insert the order, its lines and its first history row ·
write the audit entry · **complete the idempotency claim**. The HTTP response happens after the
commit.

`idempotency.complete()` inside the transaction is §36's own prescription: _"a handler with
strict requirements — checkout — should call `complete()` inside its own transaction, which
closes the window entirely."_ Without it there is a moment between the business commit and the
completion write in which a crash leaves the key `in_progress`, and after expiry a retry places
a second order.

### The idempotency key is now user-scoped — a security fix

`uq_idempotency_key` was `(store_id, key, endpoint)`. **It did not include the user.** Two
customers in one store sending the same `Idempotency-Key` to the same endpoint collided:

- different payloads → the second got a spurious `422`, plus a weak oracle that the key was in
  use;
- **identical payloads → the second was served a replay of the first customer's response.** On
  checkout that is another customer's order number, totals and delivery address.

The identity is now `(store_id, user_id, key, endpoint)`, with `user_id NOT NULL` and a composite
`fk_idempotency_user_store`. `NOT NULL` means the middleware can only guard authenticated
endpoints, which is not a real restriction: `shared/idempotency.ts` already excludes the
unauthenticated candidates, because _"operations with a natural key… are unique constraints"_ and
_"a constraint needs no header, no storage, and no expiry policy"_.

A nullable column with `NULLS NOT DISTINCT` would also have worked — PostgreSQL 16 supports it,
verified — but Drizzle 0.45's `uniqueIndex` builder does not expose the option, and a raw index
would sit outside what `drizzle-kit` can diff.

**The middleware moved after `requireAuth`.** Its own documentation had it before, and the cost
of moving is stated rather than hidden: a replay now re-authenticates before it is served, where
previously it returned the stored response without touching auth. One signature verification per
retry is the price of not serving one customer another customer's order. `requireUser` raises an
`InvariantViolation` if the middleware is ever mounted without auth, so a mis-wired route is a
loud 500 rather than a silent return to an unscoped key.

`ADD COLUMN … NOT NULL` with no default was safe because the table was provably empty — no route
mounted the middleware before this increment and `purgeExpired` had no caller — verified as 0
rows before generating the migration.

### Everything is snapshotted, and nothing is recomputed

§3 #9: _"snapshot product and address data onto order lines"_, because _"renaming a product must
not alter a past invoice."_

Order lines copy `sku_code`, `sku_name`, `product_name`, `quantity` and `unit_price`. The header
copies the promotion's code and name and **nine address fields**. `label` is deliberately not
copied — it is the customer's private filing nickname, not part of a delivery record.

Asserted by mutating every source at once — product renamed, archived and deleted; SKU recoded,
renamed, repriced, deactivated and deleted; address edited and soft-deleted — and re-reading the
order, which comes back byte-identical.

`order.address_id` exists **alongside** the snapshot, with `RESTRICT`. §40 restated the rule
_"so the checkout increment inherits it explicitly"_, and this is what inheriting it looks like:
the reference stops an operator hard-deleting an address a past order names, and the snapshot is
what every historical read actually uses. Measured during the design review — after the address
was soft-deleted mid-checkout the order still read its snapshotted city, while a join to the live
row showed it deleted. The foreign key alone would not have preserved it.

`address.ts`'s header comment previously claimed _"no FK pointing here from anywhere"_. That is
now false, so it was corrected rather than left to mislead.

### The money, and why the header is derived from the allocation

```
unit_price      = the SKU's price at checkout
line_total      = unit_price × quantity          (PRE-discount merchandise)
discount_amount = this line's allocated share of the cart-level discount
subtotal        = Σ line_total
discount_total  = Σ discount_amount
total           = subtotal − discount_total
```

**`total` means the payable GOODS total, before any tax, permanently.** When GST arrives it adds
`tax_total` and `grand_total` alongside; it must not redefine `total`. Increment 29 had to
redefine `cartTotal` once, and doing it twice would be a pattern rather than an accident.

A future per-line tax basis is therefore `line_total − discount_amount`, derivable with no
re-allocation against a cart that no longer exists — which is exactly what §42 required be
possible.

**The header discount is the SUM of the allocated parts, never an independent calculation.**
`allocate()` distributes at the currency's minor-unit scale by the largest-remainder method, so
its parts can differ from a separately-computed 4-decimal figure by up to half a paisa — and an
invoice whose lines do not foot to its header is precisely what §42 introduced `allocate()` to
prevent. Deriving the header from the parts makes the two impossible to disagree, and the tests
assert both identities with `BigInt` on the returned strings rather than with floats.

A lapsed promotion does not fail the checkout. If the coupon is inactive, deleted, expired, not
yet started, or the subtotal no longer meets its minimum, the order is **placed without the
discount** and the promotion snapshot is null. A coupon that lapsed while the customer was
choosing an address is not a reason to refuse their order.

### An unpurchasable line refuses the whole checkout

If any line's SKU is inactive, deleted, or under an unpublished or deleted product, checkout
answers `422 CHECKOUT_LINES_UNAVAILABLE` and **names the offending SKU codes**. Nothing is
written: no order, no partial order, no cart transition, and the idempotency key is released so
the customer can fix their cart and retry with the same key.

Silently dropping the line would sell them less than they asked for; Increment 28 already refused
to discard basket contents when a merchant edited a listing, and this is the same judgement at
the moment it matters most. The purchasability predicate is the cart's own — one expression,
shared with `listLines` — so "you may buy this" cannot mean one thing in the cart and another at
checkout.

### Inventory is untouched, and that has a consequence

No stock is read, reserved or decremented, and no `stock_ledger` row is written. §39 defers
_"reservations and allocation (the increment that will need `FOR UPDATE`, and the one that first
writes `reserved`)"_, and `STOCK_REASONS` contains only three technical values — none of them a
sale — so a ledger row here would need a vocabulary §39 deliberately kept small.

**The consequence, stated rather than discovered: an order can be placed for stock that is not
there.** A test asserts a 50-unit order against 5 on hand succeeds and leaves `on_hand`,
`reserved` and `available` untouched. Making that impossible is the allocation increment's first
job.

Promotion redemption is deferred too, per §42 — ordering with a coupon consumes nothing, and a
test compares the promotion row before and after to prove it.

### Two ports, and the boundary held

`no-cross-module-imports` forbids orders from importing cart or promotions, and forbids the
reverse. So **orders declares the ports** — `CheckoutCart`, `CheckoutPromotions`,
`CheckoutIdempotency` — and `container.ts` adapts the providers onto them, the same pattern
`http/` uses for `AccessTokenVerifier` and the cart uses for `CartPromotions`. Structural typing
means no module names another; `depcruise` reports 133 modules and 535 dependencies with no
violation, and no direct edge between orders and cart or promotions exists.

The cart port is what keeps the purchasability predicate in one place: it hands back
`sku_id`, the values an order line must snapshot, and the cart-owned flag. `listLines` still
withholds `sku_id` from the customer-facing view, so the two shapes are distinct rather than
pretending to be the same.

The promotions port needed **no widening at all** — `evaluateApplied` already returned the
promotion's id, code, name and discount, because Increment 29 had built it that way.

### Audit, and no event

One `order.placed` audit row per checkout: actor `customer`, `resourceType: 'order'`,
`resourceId: order.id`, metadata `{ orderNumber, cartId, lineCount }`. **No address values and no
totals** — §40's rule, because `audit_log` is _"read by more people than the database, and
frequently shipped to a log aggregator with different access controls"_; the totals are on the
order row, so copying them into the trail adds nothing and widens what leaks if the trail does. A
test scans the stored metadata for every address value.

**No event.** The handler registry is empty, so nothing consumes `order.placed`, and §39's rule —
an event with no consumer is a guess at one — applies most strongly to the event that looks most
obviously worth having. §11 already anticipates the first consumer being an order-confirmation
email, and the queue split exists so _"a bulk send must not queue ahead of an order
confirmation"_. The event ships with that consumer. A test asserts the outbox stays empty.

### The migration, and the fault's fifth appearance

drizzle-kit emitted **three** foreign keys before the indexes they target this time —
`fk_order_address_store` needing a new `uq_address_id_store` on the EXISTING `address` table, and
both `order_line` and `order_status_history` needing `uq_order_id_store`. Confirmed by running it
against a fresh database, then hand-reordered with the reason in the file header. Fifth
occurrence, after Increments 25, 27, 28 and 29.

Final state: **24 tables, 14 migrations**, `db:generate` reporting no schema changes.

### Two constraints that cannot be violated in isolation

Worth recording because two tests were wrong before they were right. The order's money checks
overlap by construction:

```
A ck_order_money_non_negative        subtotal, discount, total all >= 0
B ck_order_discount_within_subtotal  discount <= subtotal
C ck_order_total_identity            total = subtotal - discount
D ck_order_discount_needs_promotion  discount = 0 OR a promotion is named
```

With `discount = 0`, any negative subtotal breaks B as well as A. Setting `discount < 0` to
satisfy B then breaks D unless a full promotion snapshot is attached. A and B are therefore
**unreachable alone**, and PostgreSQL does not promise which of several violated checks it
reports. The same entanglement exists on `order_line` between its money bound and its discount
bound.

Both are kept — they state intent directly, and A does not depend on C surviving a future tax
change — but they are verified by existence in `pg_constraint` plus refusal, while C and D are
verified by exact constraint name. Two earlier versions of those tests asserted the wrong name
and passed for the wrong reason.

### Mutation verification

Fifty-eight probes: forty against the source, eighteen against the migration. Fifty-four were
killed on the first pass. Four survived, and the four are the useful part of the exercise.

**Two were equivalences already recorded.** Dropping `store_id` from a predicate that already
carries `user_id` changes nothing observable, because the composite key to `app_user` makes the
user imply the tenant — the same equivalence §40 recorded, appearing here three more times. A
third, `CartAlreadyCheckedOut`, is reachable only under a genuine race: `withLockedActiveCart`
creates a new active cart before it locks, so single-threaded there is nothing checked out to
find.

**Two were real weaknesses, and both were the same shape: a test passing for the wrong reason.**

_The allocation was never actually tested._ Two probes — replacing `allocate()` with an even split,
and computing the header discount independently of the lines — both survived, because every
existing money test used quantities and prices that made an even split and a proportional split
identical. Two focused tests now pin a 3:1 line ratio to `300.0000`/`100.0000` and assert that a
sub-paisa remainder still foots against the stored rows.

_A cross-store test was satisfied by the wrong constraint._ The test named "refuses a cross-store
address" built a row whose USER was also cross-store, so `fk_order_user_store` refused it first
and `fk_order_address_store` never ran — a mutation dropping `store_id` from the address key
passed the suite untouched. The fix is to make every other reference in the row agree with the
foreign store, so only the key under test can refuse the write; there are now two tests, one per
key, each asserting its own constraint name.

**This is the fourth increment in which a constraint test passed because a different constraint
fired.** Increment 27 hit it with a primary key shadowing a foreign key, Increment 29 with a
NOT NULL shadowing a CHECK, and §43's own money constraints are documented above as unverifiable
in isolation for the same reason. The general rule, now stated once: _a test that asserts a
database refusal must assert the constraint NAME, and must isolate the row so that no other
constraint can be the one that refuses._ Asserting only "this write fails" verifies nothing about
which rule is doing the work.

One probe survived for a reason worth keeping: deleting the in-transaction
`idempotency.complete()` call changed nothing observable through HTTP, because the middleware's
own post-hoc completion is a documented fallback and completes the key either way. What §36
actually requires is that the SERVICE close the window, so the test now calls the service
directly — with no middleware in the path, nothing else can complete the key, and its absence is
immediately visible.

### What this increment does NOT do

No payment: no gateway, authorisation, capture, webhook, retry, refund or COD. No shipping: no
rate, carrier, service level, shipment, tracking or fulfilment. No tax: no rate, HSN/SAC,
CGST/SGST/IGST, place of supply, GSTIN or e-invoicing. No invoice number, series, PDF or IRN. No
returns, RMAs, credit notes or restocking. No cancellation. No staff or admin order surface —
that is a reporting concern.

What later increments will need from this one, and therefore what had to be right now: per-line
`unit_price`, `quantity` and **allocated `discount_amount`** for the tax basis · `currency` and
`placed_at` for the rate in force and the invoice date · the address snapshot including `state`
and `postal_code` for place of supply · `order_number` and `placed_at` for invoice identity ·
per-line quantities and money for partial returns · `order_status_history` as the append-only
spine every one of them will add transitions to.

---

## 44. Phase 3 increment 35 — inventory reservation

One new table, no change to any existing one. The increment §39 named when it deferred
_"reservations and allocation (the increment that will need `FOR UPDATE`, and the one that first
writes `reserved`)"_ — and the one that makes §43's recorded consequence, _"an order can be placed
for stock that is not there"_, impossible.

**A numbering note.** This is section 44 for increment 35; increments 31–34 (payment, password
reset, order cancellation, invoicing) shipped without sections here, and their reasoning currently
lives in file headers under `src/`. That gap is recorded rather than closed, and nothing below
renumbers or rewrites what came before it.

### Why `stock_item.reserved` alone was not enough

`reserved` shipped in §39 at zero, with its CHECK constraints already in place, precisely so this
increment would _"change no formula and no constraint anywhere"_. It didn't. But a counter turned
out to be insufficient on its own, and the reason is worth stating because "just increment the
column" is the obvious first design.

A counter cannot answer two questions this feature turns on: **whose units are these**, and **has
this reservation already been settled?** Without an owner row, "release exactly once" is
unenforceable — a second cancellation would decrement the counter again with nothing to refuse
it, and the projection would silently drift below the truth. Four of the approved requirements
(ownership, release-on-cancel, release-on-expiry, no duplicate effect under retry) reduce to that
one missing record.

So the counter stays as the fast projection and each `stock_reservation` row is the record that
justifies part of it — the same relationship `stock_ledger` has to `on_hand`, and reconcilable the
same way:

```
SUM(quantity) WHERE status IN ('held', 'committed')  =  stock_item.reserved
```

Three alternatives were considered and rejected. A bare counter fails the four requirements above.
Rows **deleted** on settlement give exactly-once for free (`DELETE … RETURNING` matches nothing the
second time) but destroy the history, which §3 #15's retention posture forbids. An append-only
reservation **event log** works but needs an aggregate to enforce once-only and turns "is this
still held?" into a fold — a third persistence pattern where the codebase already has projection
plus ledger.

### The table

`stock_reservation`, owned by the inventory module: the schema sits in `db/schema/inventory.ts`,
the statements in `inventory.repository.ts`, the operations in `inventory.service.ts`. That keeps
the counter and the rows that justify it in one module, which is what "do not create a second
inventory model" required.

**Primary key `(order_id, sku_id)`**, no surrogate `id`, following `order_line` and `stock_item`,
which both key on their natural composite. One reservation per order per SKU is therefore
structural rather than a unique index somebody could later drop — and it is a free idempotency
backstop: a code path that somehow reserved twice for one order hits a primary-key violation
rather than double-counting units. `order_id` leads because "settle this order's reservations" is
the only hot read.

**Ownership is the ORDER, not the payment.** A reservation is created at checkout, before any
payment row exists, and an order with no payment still holds stock. Both settlement operations are
keyed by `order_id`, and nothing in the reservation model takes a payment id. Payment state
changes are triggers, not owners — see _Payment interaction_ below.

**Two tenant-scoped composite foreign keys**, both `RESTRICT`:

```
fk_stock_reservation_order_store  (order_id, store_id) -> "order" (id, store_id)
fk_stock_reservation_sku_store    (sku_id,   store_id) -> sku     (id, store_id)
```

A cross-store reservation is unrepresentable rather than merely rejected in application code — the
§3 posture every table here follows. Neither key needed a new index: `uq_order_id_store` already
exists for `order_line` and `uq_sku_id_store` for `stock_item`. `RESTRICT` and not `CASCADE`
because an order is never hard-deleted and a SKU is soft-deleted, so a hard delete with live
reservations is a bug that must fail loudly rather than quietly discard the record of stock that
was taken.

`sku_id` points at the SKU and **not** at `stock_item`, for the reason `stock_ledger` does: an
immutable record must not depend on a mutable projection's lifecycle.

**Rows are retained permanently.** There is no delete path and no `deleted_at`. A settled
reservation is the record that stock was taken and what became of it, which is the historical
auditability the increment was required to preserve. There is also no `updated_at`: the row is
written once and settled at most once, so `settled_at` already answers the only question
`updated_at` would, and a second timestamp would be a second place for the two to disagree.

No `expires_at`, and no `payment_id`. Both would encode rules this increment was not given — the
first an expiry window nobody has approved, the second the wrong ownership.

### The lifecycle

```
                  checkout transaction
                          |
                          v
                      +-------+
                      | held  |   reserved += quantity
                      +---+---+
              +-----------+-----------+
              v                       v
        +----------+            +-----------+
        | released |            | committed |
        +----------+            +-----------+
     reserved -= quantity     reserved UNCHANGED
```

Both settled states are terminal in this increment. `held` is the only non-terminal one, named as
`RESERVATION_HELD` so every compare-and-swap predicate has a single source.

`reserved` rises exactly once, at creation. It falls exactly once, on `held -> released`. **Commit
moves no counter at all**, and that is the load-bearing decision of the increment — see _Inventory
semantics_.

**Settlement is CAS-protected by `status = 'held'`.** Every release and every commit is one
statement:

```sql
UPDATE stock_reservation
   SET status = :toStatus, settled_reason = :reason, settled_at = :at
 WHERE order_id = :orderId AND store_id = :storeId AND status = 'held'
RETURNING sku_id, quantity;
```

A second settlement matches nothing, returns no rows, and therefore drives no counter change. That
property holds **independently of any lock the caller happens to hold**, which is what makes
repeated cancellation and duplicate webhook delivery safe even if a future code path reaches them
by another route. The same predicate is why a `committed` reservation can never be released: it is
not `held`, so no release statement can match it — structural, not conditional.

`RETURNING` is what the caller decrements by, so the settled rows and the counter movements come
from the same statement and cannot disagree.

The `settled_reason` vocabulary is TECHNICAL, in the sense `STOCK_REASONS` established: one value
per code path and nothing with an accounting treatment. `order_cancelled`, `payment_succeeded`,
`payment_failed`, `payment_expired`. Without it, `released` could not distinguish a cancellation
from a payment failure from an expiry — three paths with one outcome.

`payment_expired` is **defined and unreachable**. It exists so the increment given an expiry window
adds a caller rather than a vocabulary, exactly as `expired` already sits unreachable in
`PAYMENT_STATUSES`.

### Inventory semantics, and the one thing that did not change

The definitions, now that something writes `reserved`:

| Quantity    | Meaning                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| `on_hand`   | Units **physically held**. Not a sales figure                                                |
| `reserved`  | Units **not available for sale** — held for an unpaid order, or sold and awaiting fulfilment |
| `available` | `on_hand - reserved`, generated by PostgreSQL. Still the only definition                     |

`available = on_hand - reserved` remains authoritative and untouched: a `STORED GENERATED` column
PostgreSQL refuses to write, so no code path, migration or operator can make it contradict its
inputs.

**Checkout does not decrement `on_hand`, and neither does payment.** A reservation changes what is
SELLABLE, not what is physically present. A committed reservation is a sale awaiting fulfilment:
the units are still in the building, so `on_hand` must keep counting them; they are no longer
sellable, so `reserved` must keep counting them too. That is why commit moves no counter, and it
is what lets `available` stay correct with no change to its formula or its three CHECKs.

The consequence is deliberate and worth stating as plainly as §43 stated the one it replaces: **as
paid orders accumulate, `available` trends to zero while `on_hand` stays flat.** That is not a
leak — it is what "sold but not yet shipped" looks like in a system with no fulfilment. An operator
watching availability fall while on-hand does not move is seeing the design work.

**`stock_ledger` is unchanged, and remains exclusively about `on_hand`.** No new column, no widened
reason vocabulary, no relaxed `actor_user_id`. The reason is not restraint but arithmetic: that
table is defined around `on_hand` (`delta`, `on_hand_before`, `on_hand_after`, `CHECK
(on_hand_before + delta = on_hand_after)`, `CHECK (delta <> 0)`), and `SUM(delta) = on_hand` is an
asserted invariant. A reservation moves `reserved`, so recording one there would require either
lying with `delta = 0` — which the CHECK refuses — or adding `reserved_before`/`reserved_after`
plus a movement-kind discriminator, which changes what the ledger MEANS and breaks the invariant.

Because commit does not move `on_hand`, none of that was needed. `actor_user_id` keeps its `NOT
NULL` too — a sweeper-driven release has no user, which is exactly the widening that column's
comment anticipates and this increment does not require.

**Fulfilment owns the future decrement.** The increment that ships goods reduces `on_hand` and
`reserved` together, writes the `stock_ledger` row for it, and inherits all three deferred
changes: a new technical reason, the `actor_user_id` widening for a system actor, and a
`fulfilled` reservation state. The seam is recorded rather than built.

### Concurrency: one atomic conditional UPDATE

The whole guarantee is one statement per SKU. Nothing reads a stock figure into JavaScript,
decides, and writes it back.

```sql
UPDATE stock_item
   SET reserved = reserved + :quantity, updated_at = :at
 WHERE sku_id = :skuId AND store_id = :storeId
   AND available >= :quantity
RETURNING sku_id, on_hand, reserved, available;
```

`available >= :quantity` rather than a restatement of `on_hand - reserved >= :quantity`, because
`available` is the schema's one authoritative definition and a `STORED` generated column carries a
materialised, PostgreSQL-maintained value on every committed row version. (`adjustStock` restates
the arithmetic as `on_hand + :delta >= reserved`; the reuse here is the preference, not a
correction.)

#### Why it is safe under READ COMMITTED

`on_hand = 1, reserved = 0, available = 1`. Two customers each request 1.

1. **T1** issues the `UPDATE`. It matches, takes a row lock, writes `reserved = 1`, holds the lock
   until commit.
2. **T2** issues the same statement, reaches the same row, finds it locked by an in-progress
   transaction, and **blocks**.
3. **T1 commits.**
4. **T2 unblocks — and does not proceed with the row version it originally read.** Under READ
   COMMITTED, PostgreSQL re-fetches the newly committed version and **re-evaluates the `WHERE`
   clause against it**. This is the **EvalPlanQual** mechanism, and it is the behaviour this design
   relies on. The new version has `available = 0`; `0 >= 1` is false; the row is skipped.
5. T2's `UPDATE` reports **zero rows**, and the service raises `ReservationInsufficientStock`.

Exactly one succeeds. `available >= 0` is then guaranteed twice over: the predicate never commits
an update that would breach it, and `ck_stock_reserved_within_on_hand` is a backstop that turns any
bug in the predicate into SQLSTATE 23514 rather than oversold stock.

The re-evaluation is why read-then-write is not merely slower but **wrong**, and §39 measured it:
two concurrent `-4` from 5 left 1 and reported BOTH successful, with no constraint violated,
because every value written was individually legal. **A CHECK constraint prevents negative numbers;
it does not prevent lost updates.**

#### `SELECT ... FOR UPDATE` is intentionally not used

Not for the single-SKU availability decision. `FOR UPDATE` is what you need when one row's decision
depends on **reading another row** — pin several rows, then decide. That is not this: a cart line's
availability is a function of its own `stock_item` row and nothing else, so every decision is a
single-row decision and the conditional `UPDATE` covers it.

Using it here would actively hurt. It puts the arithmetic back in JavaScript — the shape §39
measured losing updates — and holds locks across application think-time, which §39 measured at
roughly double the wall clock.

### The `FOR UPDATE` divergence, recorded

§39 wrote, when deferring this work, that it would be _"the increment that will need `FOR
UPDATE`"_. **It did not, and this increment deliberately diverges from that expectation.** The
divergence was raised in the design review, argued on the grounds above, and **explicitly
approved** — it is a decision, not an omission, and not an oversight to be tidied up later.

The boundary is precise. `FOR UPDATE` or another multi-row locking strategy becomes **necessary**
the moment a rule spans stock rows:

- **kits and bundles** — reserving A is only legal if B is also available;
- **multi-location allocation** — an all-or-nothing choice across several `stock_item` rows;
- **any rule where one stock row's decision depends on another stock row's state.**

At that point `reserveForSku` is the wrong primitive and the increment introducing such a rule must
revisit it rather than layering onto it. That is written on the method itself as well as here, so
whoever adds the first bundle finds it.

### Deadlock prevention: ascending `sku_id`, sequentially

The real hazard is not the single-row race but a multi-SKU cart. Cart 1 holds [A, B]; cart 2 holds
[B, A]. Unordered, T1 takes A and waits for B while T2 takes B and waits for A; PostgreSQL detects
the cycle and kills one with SQLSTATE 40P01, which surfaces as a 500 rather than a 409.

**All reservation operations acquire `stock_item` row locks in ascending canonical `sku_id`
order.** Every transaction therefore acquires locks in the same total order, no wait cycle can
form, and the later transaction simply blocks and then re-evaluates as above. Three details are
load-bearing:

- **`sku_id`, not `sku_code`.** The id is the row being locked. Sorting by code is a
  plausible-looking bug that only manifests when two SKUs' code order and id order disagree — so a
  test uses exactly that fixture.
- **Sequential, never `Promise.all`.** The guarantee is about the order statements are ISSUED in.
  Concurrent issue abandons it while looking like a harmless speedup, so it is forbidden in the
  reservation loop and the prohibition is written at the loop.
- **Releases sort too.** The settle statement is one multi-row `UPDATE` and rows for different
  orders never contend (the PK leads on `order_id`), but the subsequent counter decrements must be
  ordered as well — two cancellations of different orders sharing SKUs could otherwise deadlock.

**This ordering is a correctness requirement, not an optimisation.** A test runs six rounds of
opposite-order carts concurrently and asserts that no outcome is a 500 — every result must be a 201
or a 409. Without the sort it fails intermittently, which is the point of running it repeatedly.

No quantity aggregation is needed before sorting: `pk_cart_line` is `(cart_id, sku_id)`, so a cart
cannot hold two lines for one SKU and neither can an order.

### The checkout transaction boundary

Reservation happens **inside the same transaction as checkout**, and its position within it is
forced rather than chosen:

| Step | What                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| …    | lock cart, reject empty, reject unpurchasable lines, load address, price, re-price promotion |
| 14   | `markCheckedOut` CAS                                                                         |
| 15   | insert order header (savepoint, order-number retry)                                          |
| 16   | insert order lines                                                                           |
| 16b  | **reserve**                                                                                  |
| 17   | status history                                                                               |
| 18   | audit                                                                                        |
| 19   | `idempotency.complete`                                                                       |

- **After the order header exists**, because `fk_stock_reservation_order_store` references
  `order (id, store_id)`. That is what fixes the position; it was not a preference.
- **Outside the step-15 savepoint**, so an order-number collision retries only the header insert.
  Reserving inside it would re-run on every retry.
- **After the `markCheckedOut` CAS**, so a losing concurrent checkout cannot take stock it is about
  to roll back.
- **Before `idempotency.complete`**, so a completed key always implies a fully reserved order.

**Insufficient stock rolls back the entire checkout transaction** — the counter increments already
made, the order header, its lines, and the cart transition, all together. The accepted cost is that
a refused checkout consumed an order number and wrote rows that were then discarded. That is the
right trade: it is one transaction, and the alternative — an advisory availability check before
step 15 — returns an answer that is stale the instant it arrives, which is the reasoning §39 used
to refuse availability checks in the first place.

**No partial order and no partial reservation.** The first line that cannot be held throws, and
reservation rows are inserted only after every counter increment has succeeded, so a failed
checkout never leaves a `held` row behind even momentarily. This matches the existing rule that one
unpurchasable line refuses the whole checkout.

Both port operations assert `isInTransaction()` and raise `InvariantViolation` otherwise, the same
guard `lockCartForCheckout` uses — a reservation that outlived a rolled-back checkout would hold
stock for an order that does not exist.

### Failure, rollback and idempotency

| Case                                     | Outcome                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Same key, same payload, already complete | Middleware replays the stored 201; **the handler never runs**. Cannot reserve twice       |
| Same key, still in flight                | `409 IDEMPOTENCY_CONFLICT`. Nothing reserved                                              |
| Same key, different payload              | `422 IDEMPOTENCY_KEY_REUSE`. Nothing reserved                                             |
| Concurrent same-key requests             | The unique index lets exactly one claim; the other is in-flight. One reservation          |
| Failure after reserving                  | Whole transaction rolls back: counter increments **and** reservation rows vanish together |

**Retry after a rollback is allowed, through the existing lifecycle unchanged.** The claim is made
on a separate connection (§36), so it survives the rollback, and the middleware releases it after
the response — so a retry proceeds, mints a **new** `order_id`, and reserves afresh. That is
correct: the first attempt's reservation no longer exists. `pk_stock_reservation` does not prevent
this and should not.

`pk_stock_reservation` is the structural backstop for the case idempotency does not cover: a code
path that reserved twice for one order within a single transaction fails loudly instead of silently
double-counting.

**Duplicate or concurrent webhook delivery cannot settle twice.** Four guards, three of them
pre-existing: `isTerminal` returns early, `uq_payment_event_provider` rejects a repeated
`provider_event_id`, `applyTransition` is a CAS on `from_status`, and settlement is itself a CAS on
`status = 'held'`. Settlement runs only after `applyTransition` returns true, so a duplicate
performs **zero** counter changes — asserted by comparing `settled_at` across two deliveries, since
a re-settlement would re-stamp it.

### Payment interaction

No payment semantics changed. No new state, no new transition, no write to `order.status` — §43's
separation of state spaces holds.

| Payment transition     | Reservation         | Counter         |
| ---------------------- | ------------------- | --------------- |
| `pending -> succeeded` | `held -> committed` | unchanged       |
| `pending -> failed`    | `held -> released`  | `reserved -= q` |
| `pending -> expired`   | `held -> released`  | `reserved -= q` |
| order cancelled        | `held -> released`  | `reserved -= q` |

Settlement is invoked after the existing `applyTransition` CAS succeeds — that CAS is what proves
this delivery performed the transition — and is keyed by `locked.order_id`, taken from the payment
row the provider reference resolved to. **Never from the webhook payload**, which is exactly how
the store is resolved too.

**Payment expiry is not implemented.** There is no `expires_at` column and no sweeper, so nothing
writes `payment.status = 'expired'` and the `payment_expired` release path is unreachable. The
expiry window and the sweeper cadence are unapproved business decisions; inventing either was
explicitly out of scope. **Expiry does not work today** — the vocabulary exists so the increment
given a window adds a caller, and §3 #13's warning that _"two schedulers running the reservation
sweeper release stock twice"_ becomes live guidance at that point rather than a forward reference.

> **Superseded by §45 (Increment 36).** Expiry now exists: a 30-minute window on
> `payment.expires_at`, swept every minute by the leader-elected scheduler, releasing held
> reservations with `payment_expired`. The paragraph above is left as written because its
> reasoning is why the vocabulary was ready — the caller was the only missing piece, and §3 #13's
> warning is now live guidance rather than a forward reference. **COD is still excluded**, so the
> COD limitation below stands unchanged.

Two ports carry this across the module boundary, both declared by the consumer and adapted in
`container.ts`, as `OrderPayments` already is: `OrderReservations` (reserve, release) for orders,
`PaymentReservations` (commit, release) for payments. Payments has no reserve capability and cannot
name a SKU; orders has no commit capability, because committing is caused by a payment succeeding.
`no-cross-module-imports` holds by construction — depcruise reports 0 violations across 153
modules.

### COD: a known limitation, not a feature

**Checkout is method-agnostic**, because the payment method is chosen later, at `POST
/users/me/orders/{orderNumber}/payments`. At reservation time there is no such thing as a COD
order. Reservations are therefore created for every order **before** the method is selected.

A COD payment is created `pending`, and **no code path in this codebase transitions it** — there is
no delivery confirmation, and the only writer of `succeeded`/`failed` is the Razorpay webhook,
keyed on a `provider_ref` a COD payment does not have. Two consequences already existed before this
increment: a COD payment stays `pending` indefinitely, and cancellation is therefore refused for
every COD order with `PAYMENT_IN_PROGRESS`.

This increment adds a third: **a COD order's reservation can remain `held` indefinitely**, holding
stock with no release path.

**No COD settlement behaviour was invented.** There is no COD wiring in the container, no
commit-on-initiation, and no delivery endpoint — each would have been inventing COD semantics, which
the approved scope forbade. The three candidate answers (commit at checkout; commit on a future
delivery confirmation; hold until an operator acts) are materially different, and one of them
contradicts the ownership model above.

**This is a known limitation and an open business decision, not a completed COD feature.** A test
asserts the current behaviour and is labelled a tripwire for the decision — it must change when the
decision is made, and it is not an endorsement of the present state.

### Ledger and audit

**No `stock_ledger` change of any kind** — see _Inventory semantics_ for why none was possible or
needed.

Reservation history is the `stock_reservation` lifecycle fields themselves: `held_at`,
`settled_at`, `settled_reason`, and the terminal `status`. Append-only in effect — written once,
settled once, never deleted — which is the same shape `order_status_history` and `payment_event`
have.

**No new audit actions were added.** `order.placed`, `order.cancelled`, `payment.succeeded` and
`payment.failed` already mark every moment a reservation changes state, and they remain the
surrounding business audit trail. Per-SKU audit entries would multiply audit volume by cart size
for no information the reservation rows do not already carry. Nothing was invented here that was
not implemented.

### API boundary

**No new endpoint** — customer or admin. The lifecycle is owned entirely by existing operations:
checkout creates reservations, cancellation releases them, the payment webhook commits or releases
them. The OpenAPI document still describes **61 operations across 43 paths**, unchanged.

One contract change on an existing endpoint, and it is documented: **`POST
/users/me/checkout`'s `409` now includes `INSUFFICIENT_STOCK`**, whose `details.skuCodes` names the
offending lines. The whole checkout fails; there is no partial order. A client that treated `409` as
"unchanged, retry later" needed to know this one keeps failing until stock exists.

**No public availability endpoint was added.** §39 withheld public stock signals because _"without
reservations, a displayed 'in stock' cannot be held for the duration of a checkout that does not
exist yet"_. That objection is now gone, which makes the question newly answerable — but it is a new
public promise with its own caching and staleness semantics and belongs to its own increment.

### A test-fixture finding worth recording

`giveSku` was extended with an **opt-in** `onHand`, not a defaulted one, and the first attempt got
this wrong in a way worth writing down.

Defaulting stock creation in the shared fixture **broke 64 of the inventory suite's 68 tests** with
`stock_item_pkey` violations. That suite is _about_ the projection's lifecycle — it inserts its own
`stock_item` rows and asserts that a SKU starts with none — so a fixture that silently pre-created
them changed the meaning of the suite rather than merely its setup.

The resolution: `giveSku` creates a `stock_item` row **only when a quantity is asked for**.
Checkout-performing suites (orders, cancellation, payments) pass one explicitly; catalogue, cart and
inventory keep their previous fixture exactly.

That leaves a deliberate product behaviour, and it is not an accident of the fixture: **a SKU with
no `stock_item` row is treated as unavailable, not auto-created during checkout.** Zero rows from
the reserve statement means insufficient stock, a missing projection row, or a SKU outside the
store — indistinguishable by design, exactly as in `adjustStock`. Checkout has already proven the
SKU is live and in-store, and a missing row means zero available, so all three answer a clean `409`
naming the code. Creating inventory rows as a side effect of a customer checkout was rejected: the
correct fix for a never-adjusted SKU is to wire `initialiseStockForSku` into SKU creation, where it
already exists unwired, and that is its own decision.

A related finding, and a second confirmation of the fault §43 recorded: **`sku` now has four
referencing keys** — `stock_item`, `cart_line`, `order_line` and `stock_reservation` — and the
hard-delete constraint test silently moved between three of them as it was isolated, passing each
time on a key it was not testing. Two of the new reservation constraint tests did the same: a
non-`held` status with a null `settled_at` trips `ck_stock_reservation_settled_at` before the
status vocabulary is ever checked, and a `settled_at` built in JavaScript is EARLIER than the
column's `now()` default, so `ck_stock_reservation_settled_after_held` fires first.

Every new reference to a table, and every CHECK that pairs two columns, degrades an existing
constraint test unless the row is isolated. §43's rule stands and grew a second confirmation: _a
test asserting a database refusal must assert the constraint NAME, and must isolate the row so
that no other constraint can be the one that refuses._

One case cannot be isolated and is documented instead: a wrong `store_id` violates the order's
composite key and the SKU's at once, because one column feeds both. That test asserts the shared
`fk_stock_reservation_` prefix — enough to prove a composite key refused it rather than the plain
store key or a CHECK, without pinning an order PostgreSQL does not guarantee.

### Verification

Recorded as actually executed, not as intended.

| Check                                | Result                                            |
| ------------------------------------ | ------------------------------------------------- |
| Full test suite                      | **1,703 passed**, 57 files, **exit 0**, 528.92s   |
| `pnpm format:check`                  | exit 0                                            |
| `pnpm lint`                          | exit 0                                            |
| `pnpm typecheck` (3 configs)         | exit 0                                            |
| `pnpm depcruise`                     | exit 0 — **0 violations**, 153 modules / 629 deps |
| `pnpm build`                         | exit 0                                            |
| `pnpm db:generate`                   | exit 0 — "No schema changes, nothing to migrate"  |
| `pnpm exec drizzle-kit check`        | exit 0 — "Everything's fine"                      |
| Migration                            | **18 applied**; Neon reports **28 tables**        |
| `stock_reservation` constraints live | 16                                                |
| OpenAPI                              | 61 operations / 43 paths, unchanged               |

**One honesty note on the suite.** The green run was `vitest run --fileParallelism=false`. Plain
`pnpm test` in parallel mode failed on this machine for environmental reasons — a Docker daemon
outage mid-run (`Could not find a working container runtime strategy` ×28, daemon 500/502/409) and,
on other attempts, `Memory allocation error` and worker-fork crashes across modules unrelated to
this work, with the same files passing in isolation. That is a host-capacity problem, not a code
problem, but the parallel run is not currently reliable here and the sequential figure is the one
that was verified.

The test count rose from 1,668 to 1,703 (+35). The concurrency claim is proven against real
PostgreSQL via Testcontainers, never a mock: stock 1 with two different customers checking out
through `Promise.all` yields exactly `[201, 409]`, one order, one reservation and `available = 0`;
five units against six simultaneous buyers yields exactly five successes.

### What this increment does NOT do

**Deferred, explicitly:**

- **Payment expiry and the sweeper** — no `expires_at`, no scheduled job. Needs the window and the
  cadence approved. `payment_expired` is defined and unreachable. **Delivered by §45.**
- **COD settlement and delivery confirmation** — see _COD_ above. The open decision, not an
  omission to be patched.
- **Fulfilment / shipment** — the decrement of `on_hand`, its `stock_ledger` movement, the new
  technical reason, the `actor_user_id` widening for a system actor, and a `fulfilled` reservation
  state. All five belong together, to that increment.
  _(Delivered in §46, with one revision: `actor_user_id` was NOT widened — manual fulfilment has
  a staff actor, so a system actor stays deferred with the provider.)_
- **Public availability** — no stock figure on any public payload.
- **Reservation admin endpoints** — no per-order reservation view, no manual release override. The
  correct fix for a stuck reservation is to resolve its order or payment; `GET /admin/inventory`
  already reports `reserved` and `available`.
- **Multi-location inventory** — the seam is still §39's: a `location_id` on both inventory tables
  plus a widened `stock_item` primary key, and now a widened `stock_reservation` key as well.
- **Reconciliation and repair tooling** — the invariant is asserted by a test, but nothing can
  rebuild `reserved` from `stock_reservation` if it ever diverged. This increment adds a second
  projection depending on the tooling §39 already deferred.
- **Refunds and returns** — unchanged from §43 and the payment increment.
- **Shipping, GST and tax** — unchanged from §43. No rate, carrier, HSN/SAC, place of supply or
  GSTIN.

**Not deferred but worth naming, because this increment surfaced it without creating it:** a
payment can still succeed against a cancelled order — the webhook does not check order status. The
stock consequence is now visible (the reservation was released, so the commit finds nothing to
commit) but the underlying gap predates this work and fixing it is a payment-semantics change.

---

## 45. Phase 3 increment 36 — payment expiry

The caller §44 said was the only missing piece. `expired` had a state, a CHECK, a transition, an
audit action and a reservation reason; this increment adds a column, an index, one service
method, a sweeper, and one entry in a scheduler task list that had been empty since Phase 0.

Nothing else changed. No new state, no new endpoint, no new dependency, no new scheduler, no
change to the payment API, and no COD behaviour.

### The approved decisions

| #   | Decision                | Value                                                       |
| --- | ----------------------- | ----------------------------------------------------------- |
| A   | Online expiry window    | **30 minutes**                                              |
| B   | Sweeper cadence         | **every 60 seconds**                                        |
| C   | Scope                   | **`method = 'online'` only**                                |
| D   | Late provider success   | **local expiry wins; the webhook is ignored**               |
| E   | Lock order              | **order → payment**, so expiry serialises with cancellation |
| F   | Retry after expiry      | **not included.** `uq_payment_order` stands                 |
| G   | `expires_at` visibility | **not exposed through any API**                             |
| H   | Window anchor           | **exactly 30 minutes after initiation**                     |

Every one of these is a business decision that was approved before implementation, and none was
chosen here.

### `expires_at`, and why it is a column

`timestamptz`, nullable, stamped once at initiation.

Deriving eligibility from `created_at + window` at query time was rejected for three reasons: it
bakes the window into every query that asks; it makes the window unchangeable for payments
already in flight, so a configuration change would silently move deadlines customers had already
been given; and it leaves nothing on the row explaining why something expired. A column answers
all three — a payment keeps the window it was given, and the row says what it was.

**Nullable, and deliberately not `NOT NULL` for online payments.** NULL means "never expires",
which is exactly right for COD and for the one historical online payment that predates the
column. A biconditional (`expires_at IS NOT NULL ⟺ method = 'online'`) would have required
backfilling a window for a row whose window nobody can now reconstruct, and would refuse a
future non-expiring online method. The service guarantees a fresh online payment gets one; the
database guarantees COD never does:

```sql
CHECK (expires_at IS NULL OR method = 'online')   -- ck_payment_expires_at_only_online
```

One direction only, and that direction is the one that matters: it makes an expiring COD payment
**unrepresentable**, not merely unwritten. Without it, a future caller stamping `expires_at` on a
COD payment would have introduced COD settlement by the back door — the single thing this
increment was told not to invent.

### The index, and why it is not store-leading

```sql
CREATE INDEX ix_payment_expiry_due
  ON payment (expires_at)
  WHERE status = 'pending' AND expires_at IS NOT NULL AND method = 'online';
```

`ix_payment_store_status` cannot serve this query and that is the whole reason a new index
exists: it leads with `store_id` and carries no time column, so a cross-tenant sweep would
degrade to a scan plus a filter.

**Not store-leading**, because the sweeper is one leader-elected task serving every store. This
is the only unscoped read in the codebase, and it is safe for a specific reason: it returns
**ids only**, and every subsequent write is scoped by the `store_id` on the row it locked — never
by anything a caller supplied. Tenancy moves from the read to the write rather than being
dropped.

Partial on all three predicates the query carries, so it holds only rows that can ever be due and
shrinks as payments terminalise. A store with a million paid orders contributes nothing to it. A
test asserts the index exists and, with `enable_seqscan = off`, that the candidate query's plan
actually names it — on a table of a few rows a sequential scan is genuinely cheaper, so without
disabling it the plan would say nothing about whether the index is usable.

### The window is stamped once, from configuration

`PAYMENT_EXPIRY_MINUTES=30`, validated by Zod as a positive integer — a zero or negative window
would expire a payment the instant it was created. The service receives the **value**, not the
config object, the same way the mailer receives `resetUrlBase` alone.

`initiate` captures one `initiatedAt` and derives the window from it, rather than calling
`new Date()` wherever a timestamp is needed. That is what makes the window exactly 30 minutes
from a single instant, and it is the one seam a test needs.

**The client cannot influence it.** `InitiatePaymentRequestSchema` is a `strictObject` whose only
field is `method`, so an `expiresAt` in the body is a 400 naming the field — asserted by a test,
rather than assumed from the schema.

**`expires_at` is not in `PAYMENT_COLUMNS`**, and that is how decision G is enforced. Every read
path selects that list explicitly, so the field is not merely omitted from a DTO — no query
returns it, and it cannot reach a response body through a mapper somebody widens later. The
sweeper does not need it either: it selects ids and re-reads status under a lock.

### The expiry transaction, and the lock order

One transaction per payment:

```
1. SELECT … FROM "order"  WHERE id = :orderId  FOR UPDATE
2. SELECT … FROM payment  WHERE id = :paymentId FOR UPDATE
3. re-read status from the locked row
4. isTerminal      -> ignored/already_terminal, no writes
5. canTransition   -> ignored/illegal_transition
6. INSERT payment_event (pending -> expired, actor system, provider_event_id NULL)
7. UPDATE payment … WHERE status = 'pending'        -- the existing CAS
8. reservations.releaseForOrder(reason: payment_expired)
9. audit.record(PAYMENT_AUDIT.expired, actor system)
COMMIT
```

**The order lock comes first, and it is the entire reason expiry serialises with cancellation.**
Cancellation locks the order and then reads payment status **without a lock** —
`findStateByOrderId` is a plain `SELECT`, which the inspection confirmed. So if expiry took only
the payment lock the two would not serialise at all: a customer could be refused a cancellation
on a stale `pending` read while this transaction was turning that same payment `expired`.

The webhook takes only the payment lock and never the order, so no wait cycle can form and no
deadlock is possible. The global order this increment establishes is:

```
order -> payment -> stock_reservation -> stock_item
```

`provider_event_id` is NULL on the expiry event because no provider event caused it. Fabricating
one would pollute `uq_payment_event_provider`, which is what makes webhook redelivery safe.
`failure_code` stays NULL because an expiry is not a failure — `ck_payment_failure_code_only_when_failed`
agrees.

### Atomicity, and why the release is inside the transaction

The transition, the history row, the reservation release and the audit entry commit together or
not at all.

If the release throws — `InvariantViolation`, when `stock_item.reserved` has diverged from
`stock_reservation` — **everything rolls back**: the payment stays `pending`, no `payment_event`
survives, no audit entry survives, the reservation stays `held`, and the payment is still
eligible on the next pass. Nothing catches and continues inside the transaction, because a catch
there is exactly how a partial state gets committed.

That is asserted by provoking a real divergence rather than by mocking one: the reservation row
is left `held` while the projection is zeroed, so `releaseForSku` matches nothing and the
inventory service raises. The test then checks all five properties above, including that the
payment is still returned by the candidate query.

### Concurrency

| Race                           | Resolution                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expiry ∥ webhook success       | Same payment row lock. Whichever terminal transition commits first wins; the loser sees terminal and settles nothing. A test asserts exactly one of the two did the work, and that the reservation settled consistently with whoever won |
| Two concurrent expiry attempts | Row lock serialises them; the `status = 'pending'` CAS admits one. One `expired`, one `ignored`, and `reserved` moves once                                                                                                               |
| Expiry ∥ cancellation          | Serialised by the order lock. Either outcome is legal — cancellation refuses `pending` and permits `expired` — and the reservation is released exactly once either way                                                                   |
| Webhook after expiry           | `isTerminal` returns early. Nothing is committed, resurrected or recommitted                                                                                                                                                             |

**Correctness does not depend on leader election.** The scheduler guarantees one sweeper, but if
that guarantee were lost, a second sweeper would produce `ignored` results rather than
double-releasing stock — the row lock and the CAS are the actual safety, and leadership is an
efficiency.

### The sweeper reuses the scheduler that was already there

One entry in `TASKS`, which had been empty since Phase 0 and whose header already named this job.
No BullMQ, no second scheduler, no new dependency. The existing machinery supplies everything:
leadership re-checked **per task** (it can lapse mid-tick), a `running` set so a slow pass cannot
overlap itself, per-task error isolation, and graceful shutdown.

`TASKS` moved to below the container construction, because a task now needs it. Its previous
position above was only possible while the list was empty.

What the sweeper does per pass: read candidate **ids** outside any transaction, then process each
in its own transaction. Not one transaction for the batch — that would hold a batch's worth of
order and payment locks against live checkouts, and one poisoned row would roll back every expiry
beside it. `PAYMENT_EXPIRY_SWEEP_BATCH_SIZE=100` bounds a pass; a larger backlog drains over
several.

The candidate list is therefore a **hint**, not a decision. A payment can terminalise between the
read and the lock, which is why `expirePayment` re-reads under the lock and why a lost race is
counted as `ignored` rather than logged as a failure.

`sweep(now = new Date())` takes the instant as a parameter. That is the only seam the tests need:
seed `expires_at` in the past, sweep at a chosen `now`, assert. It continues this repository's
practice of controlling time through **data** — there are no fake timers anywhere in it, and this
increment did not introduce the first.

The sweeper never throws. A pass that propagated would kill the scheduler tick that called it, so
each failure is counted and logged at `error` with the payment id — a payment repeatedly failing
to expire is holding stock and someone has to be able to find it. **Nothing is swallowed
silently**, and a pass that found nothing logs nothing at all: this runs every minute forever, and
an idle heartbeat would bury the passes that mattered.

### Late Razorpay success: an accepted financial exposure

**Local expiry is authoritative. Razorpay is never read back.**

The adapter makes exactly one outbound call, `POST /orders`, and keeps only the returned id.
Nothing else about the provider's own lifecycle is fetched or stored, so the system has no
information other than its own window — which is why local expiry must be authoritative rather
than merely convenient.

The consequence, stated plainly because it involves real money: **a payment expired here can
still be captured at Razorpay.** The late webhook is ignored as already-terminal, the stock stays
released, the order stays `placed` — and the customer may have been charged with no local record
of success.

There is deliberately no read-back, no provider-side cancellation, no refund call and no
reconciliation in this increment; each was explicitly out of scope. **This is a known financial
and operational exposure requiring manual reconciliation**, and a test pins the behaviour so it
cannot change silently. The mitigation is operational — a window long enough that a genuine
customer completes inside it — not technical, and closing it properly is a reconciliation
increment.

### COD is untouched, and still limited

Nothing about COD changed. No settlement, no expiry, no delivery confirmation, no transition.

Expiry is online-only by decision C, enforced three ways: the service stamps `null` for COD, the
candidate query filters `method = 'online'`, and `ck_payment_expires_at_only_online` makes the
alternative unrepresentable. Four tests cover it — COD has a NULL window, the sweeper never
selects it even at a far-future instant, the payment stays `pending`, and the reservation stays
`held`.

**§44's COD limitation stands unchanged: a COD order's reservation can remain held indefinitely**,
because a COD payment has no terminal transition and this increment did not give it one. That is
still a known limitation and an open business decision, not something this increment quietly
fixed.

### Retry after expiry is not included

`uq_payment_order` is untouched, so an expired order still cannot be paid again — `POST
…/payments` returns `409 PAYMENT_ALREADY_EXISTS` exactly as before. No `payment_attempt` table,
no relaxed constraint, no change to the initiation contract.

That leaves a real dead end: an order whose payment expired has its stock back but no way to pay.
Fixing it means either one _live_ payment per order or an attempt model, and both change the
payments API — which makes it its own increment rather than a corner of this one.

### No API change, and no event

No new endpoint. No change to the initiation request or response, the payment response, the order
response, or `order.status`. `GET` payment endpoints keep showing whatever `status` holds, which
now includes `expired`; the invoice already rendered that as _Payment failed_.

**No domain event.** `PAYMENT_AUDIT.expired` already existed, unused, and is now written with a
system actor — audit was ready. An event was deliberately not added: the handler registry has
exactly one consumer (`user.password_reset_requested`), and §39's rule that _an event with no
consumer is a guess at one_ has held for six increments. A test asserts the outbox contains no
`payment.*` event after a sweep — scoped to payment events rather than asserting an empty outbox,
because registration publishes `user.registered` and a blanket assertion would have been testing
the fixture.

### The migration

Migration 19, `20260908093306_lying_doctor_faustus.sql`. Additive only: `ADD COLUMN`, `CREATE
INDEX`, `ADD CONSTRAINT`.

Read before applying, as every generated migration in this project is. The FK-before-index fault
has appeared six times; there is no foreign key here and the new index is referenced by nothing,
so nothing needed hoisting — the only ordering that matters is the CHECK following the column it
constrains, which it does.

`ADD COLUMN` with no default and no `NOT NULL` is metadata-only in PostgreSQL: no table rewrite,
no long lock. **`CREATE INDEX`, deliberately not `CONCURRENTLY`** — Drizzle runs migrations inside
a transaction and `CONCURRENTLY` cannot run in one. The table is small so a plain build is
instant; a large table would need the index created outside the migration runner.

**No backfill, and the live data is why.** Every existing row takes NULL, which is correct: the
six COD payments are ineligible by decision and the single online payment is already terminal.
The CHECK validates against all seven rows and passes because all seven are NULL.

Rollback is dropping the constraint, the index, then the column — safe at any time, since nothing
else references any of the three and losing `expires_at` only stops future expiry. Payments
already `expired` stay expired, which is correct: their stock was already released.

### Verification

| Check                         | Result                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payments suite (targeted)     | 108 passed, exit 0                                                                                                                                                     |
| Full suite                    | **1,727 passed**, 57 files, exit 0, 470.40s                                                                                                                            |
| `pnpm format:check`           | exit 0                                                                                                                                                                 |
| `pnpm lint`                   | exit 0                                                                                                                                                                 |
| `pnpm typecheck` (3 configs)  | exit 0                                                                                                                                                                 |
| `pnpm depcruise`              | exit 0 — 0 violations, 154 modules / 631 dependencies                                                                                                                  |
| `pnpm build`                  | exit 0                                                                                                                                                                 |
| `pnpm db:generate`            | exit 0 — "No schema changes, nothing to migrate"                                                                                                                       |
| `pnpm exec drizzle-kit check` | exit 0 — "Everything's fine"                                                                                                                                           |
| Live Neon                     | 19 migrations, `expires_at` nullable, `ix_payment_expiry_due` partial on all three predicates, `ck_payment_expires_at_only_online` present, `ck_payment_status` intact |
| Dependencies                  | unchanged — 17 production, 21 development                                                                                                                              |
| OpenAPI                       | 61 operations / 43 paths, unchanged                                                                                                                                    |

The full suite was run with `vitest run --fileParallelism=false`. Plain `pnpm test` in parallel
mode remains unreliable on this machine for environmental reasons recorded in §44 — Docker daemon
outages and memory pressure, with the same files passing in isolation — and the sequential figure
is the one that was verified.

Test count rose from 1,703 to 1,727 (+24). Concurrency is proven against real PostgreSQL via
Testcontainers, never a mock, and the index claim is proven by `EXPLAIN` rather than asserted.

### What this increment does NOT do

**Deferred, explicitly:**

- **COD settlement, COD expiry, delivery confirmation** — §44's limitation stands.
- **Retry after expiry** — needs either one-live-payment-per-order or an attempt model, and both
  change the payments API.
- **Provider read-back, provider-side cancellation, refunds, reconciliation** — the late-capture
  exposure above is accepted, not solved.
- **Fulfilment / `on_hand` decrement** — unchanged from §44. Expiry moves `reserved`, never
  `on_hand`, and writes no `stock_ledger` row.
- **Public `expires_at`** — decision G. It is not in `PAYMENT_COLUMNS`, so no read path can
  return it.
- **Reservation admin endpoints, multi-location inventory, reconciliation tooling** — unchanged
  from §44.
- **Shipping, GST/tax, statutory invoicing, returns, order-status redesign, new providers** —
  unchanged from §43 and §44.
  _(Shipping delivered in §46 as manual, free fulfilment; GST/tax, statutory invoicing, returns,
  order-status redesign and new providers all remain deferred.)_

**Not deferred but worth naming again:** a payment can still succeed against a _cancelled_ order,
because the webhook does not check order status. This increment neither created nor fixed that;
expiry simply gives it one more shape, since a cancelled order's reservation is already released
when the late capture lands.

---

## 46. Phase 3 increment 37 — shipping and fulfilment foundation

The fourth state space, and the increment that finally decrements `on_hand`. Two new tables, one
new reservation state, one new ledger reason, six routes — and no shipping provider, no shipping
price, and no change to what `order.total` means.

### The approved decisions

| Decision                 | Value                                                                     |
| ------------------------ | ------------------------------------------------------------------------- |
| Provider                 | **Manual fulfilment. No provider, adapter, port, credentials or webhook** |
| Pricing                  | **Free. `shipping_total` is not stored, because it is not charged**       |
| Methods                  | **One implied method.** No table, no selection, no endpoint               |
| Free-shipping promotions | **Not included.** The promotion model is untouched                        |
| Selection timing         | **Not selectable.** Checkout is unchanged                                 |
| Shipments per order      | **Exactly one**, enforced by `uq_shipment_order`                          |
| Partial fulfilment       | **Not supported.** No `shipment_item`, no partial quantities              |
| States                   | `pending -> shipped -> delivered`, separate from `order.status`           |
| Payment prerequisite     | online must be `succeeded`; **COD may be `pending`**                      |
| COD                      | No settlement, no transition, no expiry. Fulfilment may proceed unpaid    |
| Inventory                | `committed -> fulfilled` at shipment: both counters fall, one ledger row  |
| Cancellation             | A `shipped` or `delivered` shipment blocks it                             |
| Customer visibility      | status, carrier, tracking number, URL, two timestamps                     |
| Staff queue              | Narrow, keyset-paged, fulfilment-only                                     |
| Shipping cost            | Zero, and **`order.total` is not redefined**                              |
| GST/tax                  | Out of scope                                                              |
| Staff actor              | `stock_ledger.actor_user_id` stays NOT NULL                               |

None of these was chosen here; all were approved before implementation.

### Why fulfilment state is not `order.status`

The rule already existed, recorded in a migration header:

> _"§43 fixed that `cart.status`, `order.status`, the payment table and a future shipment table
> stay **four separate state spaces**."_

This is that shipment table, and it holds to it. `order.status` still has two values answering
one question — has the customer withdrawn the order — and nothing in this increment writes it.

Expanding it was considered and rejected on four grounds. One column cannot carry a carrier, a
tracking number and two timestamps. It would make the column answer two unrelated questions. It
would require widening `ck_order_status` plus both `order_status_history` CHECKs and
re-examining every reader of `CANCELLABLE_ORDER_STATUSES`. And "is this order fulfilled?" is a
question ABOUT a shipment, answered by joining rather than by mirroring — the same reasoning §39
used for `available` and §44 for `reserved`.

### The two tables

**`shipment`** — the authoritative record that goods left. `id`, `store_id`, `order_id`,
`status`, `carrier`, `tracking_number`, `tracking_url`, `shipped_at`, `delivered_at`, timestamps.
No `deleted_at`: a shipment is historical operational data, and the retention posture that
forbids deleting an order forbids deleting the record that it shipped.

**`shipment_event`** — append-only transitions, the same shape as `payment_event` and
`order_status_history`: no `updated_at`, no `deleted_at`, so there is no column with which to
rewrite the past. It gives `order_status_history.note` — present and unused since §43 — its first
real analogue: "left with neighbour", "second delivery attempt".

`uq_shipment_order` is **not** store-scoped, deliberately. `order_id` is a UUIDv7 primary key,
globally unique on its own, so adding `store_id` would weaken the constraint rather than scope
it: a composite unique would permit two shipments for one order if a caller ever supplied the
wrong store. Tenancy comes from `fk_shipment_order_store` and from every repository predicate.

Tracking uniqueness is `(store_id, carrier, tracking_number) WHERE tracking_number IS NOT NULL`
— the shape of `uq_payment_provider_ref`. Store- and carrier-scoped rather than global, because
two couriers legitimately reuse number formats and two tenants must never collide. A test asserts
both halves: a duplicate under one carrier is refused, and the same number under a different
carrier is accepted.

### `pending` earns its place

Creation does not ship. The two are separate calls because moving stock is irreversible and
should not be a side effect of a request whose body is tracking metadata — and because `pending`
is the state in which a tracking number can be attached, which is the normal case: a shipment is
raised when picking starts and the courier is frequently chosen later.

That is why `carrier` and `tracking_number` are nullable, and why the `PATCH` exists at all.

There is deliberately no `packed` (no operational step acts on it), no `failed` and no `returned`
(returns are out of scope), and no `cancelled` — a shipment that should not have existed is
corrected by cancelling the order before it ships, and a state nothing can produce looks
supported to every reader of the enum.

### The inventory lifecycle, completed

§44 promised that _"the fulfilment increment decrements both together and writes the
`stock_ledger` row for it."_ This is that increment.

| Event                                | `on_hand` | `reserved` | `available`   | ledger              |
| ------------------------------------ | --------- | ---------- | ------------- | ------------------- |
| checkout                             | —         | **+q**     | falls         | —                   |
| payment succeeded                    | —         | —          | —             | —                   |
| payment failed / expired / cancelled | —         | **−q**     | rises         | —                   |
| **shipment**                         | **−q**    | **−q**     | **unchanged** | **one row per SKU** |

`available` is unchanged by shipping, and that is correct rather than surprising: the units
stopped being sellable when they were reserved, not when they left. A test asserts it explicitly,
because it is the property most likely to look like a bug.

The reservation gains one terminal state, `committed -> fulfilled`, with `settled_reason`
`shipment_fulfilled`. `held -> fulfilled` and `released -> fulfilled` are illegal, and `fulfilled`
is absorbing.

**`fulfilled_at` is a new column, not a re-stamp of `settled_at`.** `committed -> fulfilled` is a
second settled-to-settled move, and overwriting would destroy the fact that matters most: when
the sale was committed. An auditor needs both instants — when the units stopped being sellable,
and when they left the building — and one timestamp can hold only one.

The reconciliation invariant is unchanged, which is the point of decrementing `reserved` in the
same statement: `SUM(quantity) WHERE status IN ('held','committed') = stock_item.reserved` still
holds, because `fulfilled` rows drop out of the sum exactly as the counter drops. The partial
index `ix_stock_reservation_sku_outstanding` needed no change for the same reason.

### `stock_ledger` gains exactly one reason

`shipment`. The first non-manual reason, and still a MECHANISM rather than an accounting
treatment — which is why it belongs in a vocabulary that still excludes `damage`, `shrinkage` and
`write_off`.

One row per shipped SKU, negative delta, with `on_hand_before`/`on_hand_after` taken from the
SAME statement that moved the counter, so the pair cannot come from two reads. A test asserts the
row's arithmetic against the column it moved.

**`actor_user_id` stays NOT NULL.** That column's comment anticipated a system actor for order
allocation; manual fulfilment does not need one, because every shipment is despatched by an
authenticated staff member. A provider webhook would be the first system actor and would need its
own decision — deferred with the provider.

### COD: an authorised unpaid fulfilment path

The hardest coupling in the increment, and the one the approved rules had to resolve explicitly.

A COD payment is created `pending` and no code path terminalises it, so its reservation sits
`held` forever. Requiring `committed` would make COD unshippable and therefore unsellable.
`held -> fulfilled` is deliberately illegal. Inventing a payment transition was forbidden.

**The mechanism:** when a COD order ships, fulfilment performs `held -> committed` with
`settled_reason = 'cod_fulfilment'` first, then `committed -> fulfilled`, both inside the shipping
transaction. Two reservation transitions, one transaction, and **no payment write of any kind** —
no status change, no `payment_event`, no audit entry against the payment.

The reason is `cod_fulfilment` and NOT `payment_succeeded`, deliberately: the money has not been
received, and a reason claiming otherwise would misreport an unpaid sale as a paid one. The
capability is carried by a flag named `allowUncommittedCod` — named for what it permits rather
than for its caller, so it cannot be passed casually: it means _this order may ship without its
money having arrived_.

**This is not COD settlement.** A COD payment remains `pending` after delivery, a COD order
remains uncancellable for the reason §44 recorded, and the settlement dependency is still open. A
test asserts the payment is untouched after shipping, and exists to keep that true.

### The payment prerequisite

| Method   | Status                           | May fulfil |
| -------- | -------------------------------- | ---------- |
| `online` | `succeeded`                      | yes        |
| `online` | `pending` / `failed` / `expired` | no — `422` |
| `cod`    | `pending`                        | **yes**    |
| _(none)_ | —                                | no — `422` |

Checked at BOTH creation and shipping. Not required by the rule, but it stops staff building a
queue of shipments that can never ship, and surfaces an unpaid order when someone first tries to
act on it. The COD branch is written positively rather than assuming `pending` is the only
possible COD status, so a future settlement increment fails loudly here instead of silently
taking the unpaid path.

### The lock order, extended

```
order -> payment -> shipment -> stock_reservation -> stock_item
```

The ORDER lock always comes first. Cancellation already locks the order and reads shipment state
without a lock; taking the order lock here is what makes the two serialise.

**The ship and deliver routes address a SHIPMENT, which creates a problem the lock order does not
solve on its own**: something must be read before any lock can be taken. The resolution is a
single unlocked read of `shipment.order_id`, which is safe precisely because that column is
IMMUTABLE — no statement anywhere updates it, and a shipment cannot move between orders. Nothing
is decided from that read; the order is locked, the shipment is re-read locked, and every decision
comes from the locked copy.

The payment webhook and the expiry sweeper never take a shipment lock, and nothing here takes a
payment lock before an order lock, so no wait cycle is possible.

### Atomicity: inventory moves before the CAS

The order is deliberate. Inventory is moved, and only then does the shipment CAS `pending ->
shipped`. If the movement throws — a divergent projection, a released reservation, an order
holding no reservation — the transaction rolls back and the shipment is still `pending`, so it can
be retried once the cause is fixed.

**A shipment is never `shipped` with the stock movement incomplete.** A test provokes a real
divergence — the reservation left `committed` while the projection is zeroed — and asserts all
five properties: the shipment stays `pending` with a null `shipped_at`, only the creation event
row survives, no ledger row survives, no `shipment.shipped` audit entry survives, and the
reservation is still `committed` and therefore retryable.

Because there is one shipment per order and no partial fulfilment, the operation fulfils the
COMPLETE reservation or throws. There is no partial state to represent.

### Concurrency

| Race                                 | Resolution                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Two staff creating a shipment        | `uq_shipment_order`. One `201`, one `409`, one shipment, one event                                                                          |
| Two staff shipping the same shipment | Shipment row lock + CAS on `from_status`. One `200`, one `409`, **one stock movement, one ledger row, one event**                           |
| Two staff delivering                 | Same CAS. `delivered_at` never re-stamped                                                                                                   |
| Cancellation vs shipping             | Both take the ORDER lock first → serialised                                                                                                 |
| Payment expiry vs shipping           | Both take the ORDER lock first → serialised. If expiry wins, the reservation is released and fulfilment finds nothing committed and refuses |
| Staff of another store               | `404`. Every predicate carries `store_id`, from the token                                                                                   |

**No `Idempotency-Key` anywhere in this module.** Creation is guarded by a unique constraint —
a constraint doing the work a header would only approximate — and the transitions by a row lock
plus a CAS. Adding the header would be ceremony on top of guarantees that already hold. The
existing infrastructure is unchanged.

### Cancellation

A `shipped` or `delivered` shipment blocks cancellation, checked under the ORDER lock the
cancellation transaction already holds. It runs BEFORE the payment check, because it is the more
final answer: a shipped order stays shipped, where an unpaid one may become payable, and a
customer whose goods are in transit should be told that rather than told about their payment.

**A `pending` shipment does NOT block.** Nothing has moved, so refusing would trap a customer
whose order a staff member had merely started picking. The pending shipment is then left behind as
an operational fact that can never ship, because the ship path refuses a cancelled order — a
consequence asserted by a test rather than left to be discovered.

Returns and cancellation-after-shipment refunds are not implemented.

### Money, and what `order.total` still means

**`order.total = subtotal - discount_total`, unchanged**, and `ck_order_total_identity` still
enforces it in the database. No `shipping_total`, no `grand_total`, no change to what payments
charge.

Shipping is free in this increment, so there is no shipping amount to store — and a zero-valued
column would be a field with no reader, which is what §24's `product.price` mirror taught. When
shipping is charged, the additive shape is a `shipping_total` plus a `grand_total` with its own
identity CHECK, leaving `ck_order_total_identity` untouched; that was designed during the
inspection and deliberately not built.

No `Number()` arithmetic was introduced. The custom `no-money-arithmetic` ESLint rule makes it
impossible outside `shared/money.ts`, and this module handles no money at all.

### The tax boundary

No GST, no HSN/SAC, no place-of-supply, no rates, no statutory invoice change.

What is preserved for the future tax increment, without implementing any of it: the order's
immutable nine-column address snapshot (untouched), the carrier and tracking as text on the
shipment, and `shipped_at` — the date a rate would be a function of. Those are stored as facts at
the moment they are true, exactly as `order_line` snapshots `sku_name` and `unit_price`.

One gap the inspection surfaced and this increment does not close: **there is no origin address
anywhere in the codebase** — no warehouse, no store address, no `location_id`. Place of supply
needs both endpoints, and the destination is the only one that exists. That is a tax-increment
prerequisite, recorded here rather than guessed at.

### Audit, and no events

Four audit actions: `shipment.created`, `shipment.shipped`, `shipment.delivered`,
`shipment.tracking_updated`. The last one is there because a tracking number is a
CUSTOMER-VISIBLE fact, and a correction to one is precisely what an audit trail exists for.

**No domain event.** The outbox handler registry still has exactly one consumer, and §39's rule
has held for eight increments: an event with no consumer is a guess at one. `shipment.shipped` is
the most obviously event-worthy thing here — "your order has shipped" is the notification every
shop sends, and the mail infrastructure already exists — which is exactly why it must not get a
speculative one: the consumer is one increment away, not zero, and the event should ship WITH it
so its payload is designed against a real reader. A test asserts the outbox holds no `shipment.*`
event.

Tracking corrections write no `shipment_event` row: nothing about fulfilment STATE changed, and
putting a non-transition into an append-only history of transitions would corrupt what that table
means.

### The API

Six new operations, taking the documented surface to **68 operations across 49 paths**.

| Method       | Path                                       | Access   |
| ------------ | ------------------------------------------ | -------- |
| `GET`        | `/users/me/orders/{orderNumber}/shipments` | Customer |
| `GET`        | `/admin/orders/fulfilment`                 | Staff    |
| `POST` `GET` | `/admin/orders/{orderNumber}/shipments`    | Staff    |
| `POST`       | `/admin/shipments/{id}/ship`               | Staff    |
| `POST`       | `/admin/shipments/{id}/deliver`            | Staff    |
| `PATCH`      | `/admin/shipments/{id}`                    | Staff    |

No existing contract changed. Checkout, the payment endpoints, the order responses and
`order.status` are all untouched.

**Action endpoints, not `PATCH {status}`** — the reasoning §26 recorded for product
publish/archive. With a status field, `{"status":"delivered"}` on a pending shipment is a request
the server must accept, validate and refuse; with action routes there is no route to call, so it
is unrepresentable. The `PATCH` that does exist has no `status` field in its schema and cannot
reach the column.

The customer response carries six fields and no shipment id, no order id, no note and nothing
about inventory. It is built by an explicit mapper rather than by spreading the record, so a
column added later cannot reach a customer by default.

The staff queue is narrow by construction: the predicate is exactly "work to do", and there is no
customer search, no status filter, no date range and no free text — each would be a `400` from
the `strictObject` rather than a silently ignored parameter. Keyset-paged on `(placed_at,
order_number)` rather than OFFSET, because a queue is worked from the front while rows leave it
and OFFSET would skip orders as earlier ones ship.

**Existing staff authorization was sufficient.** `requireScope('staff')`, re-derived from the
database on every request. No role table, no fulfilment permission, no role management — that
would have been a different increment.

### Two findings worth recording

**`z.string().url()` accepts `javascript:alert(1)`.** Found by a test that expected a `400` and
got a `201`. `trackingUrl` is rendered as a customer-facing link, so a scheme-less URL validator
is a stored-XSS delivery route — and the invoice's `esc()` does not help, because escaping a
href's text does not neuter its scheme. The field now allow-lists `http` and `https` explicitly,
with `.url()` kept for the clear message on malformed input.

**`String.replace` corrupted `docs.ts`.** The OpenAPI block contained `pattern: '^ORD-…{6}$'`, and
`$'` is a replacement pattern meaning "the portion after the match" — so a single `.replace()`
spliced the file's own tail in four times, taking it from 5,500 lines to 17,689. Repaired by
rebuilding from the known-clean head and tail and concatenating rather than replacing. The lesson
is narrow and worth having: **never pass generated code through `String.replace` as the
replacement argument**; use a function replacement or plain concatenation.

### The migration, and the seventh appearance of a known fault

Migration 20, `20260908101813_flowery_dust.sql`.

**Drizzle emitted `fk_shipment_event_shipment_store` BEFORE `uq_shipment_id_store`, the unique
index it references.** Applied as generated, PostgreSQL refuses it: _there is no unique constraint
matching given keys for referenced table "shipment"_. This is the **seventh** appearance of that
fault — §43 records the fifth, §44 the sixth — and the first time it was predicted in an
inspection before it happened.

Every `CREATE INDEX` was hoisted above every `ADD CONSTRAINT … FOREIGN KEY`; no statement was
added, removed or altered, and the count is unchanged at 21. The correction is documented in the
migration header. The re-added CHECK constraints stay last, because one of them constrains the
`fulfilled_at` column added above it.

Not destructive. The three `DROP CONSTRAINT` statements drop CHECKs immediately re-added as
strict SUPERSETS — `ck_stock_ledger_reason` gains `shipment`, `ck_stock_reservation_status` gains
`fulfilled`, `ck_stock_reservation_reason_values` gains two reasons — so no row that was legal
before is illegal after, and the whole migration is one transaction so no window exists where a
CHECK is missing. `ADD COLUMN fulfilled_at` is nullable with no default: metadata-only, no
rewrite. **No backfill**: every existing reservation is `held`, `released` or `committed`, so
`fulfilled_at` is correctly NULL for all of them.

Rollback is dropping the two tables and `fulfilled_at`, then narrowing the three CHECKs — safe
only while nothing has shipped, because after that narrowing `ck_stock_reservation_status` would
reject existing rows and dropping the tables would discard the record that goods left.

### Verification

| Check                                        | Result                                                        |
| -------------------------------------------- | ------------------------------------------------------------- |
| Fulfilment state (unit)                      | 8 passed                                                      |
| Payments + fulfilment integration            | 158 passed                                                    |
| Orders, payments, inventory suites (7 files) | 452 passed                                                    |
| OpenAPI drift guard                          | 10 passed                                                     |
| Full suite                                   | **1,785 passed**, 58 files, exit 0                            |
| `pnpm format:check`                          | exit 0                                                        |
| `pnpm lint`                                  | exit 0                                                        |
| `pnpm typecheck`                             | exit 0                                                        |
| `pnpm depcruise`                             | exit 0 — **0 violations**, 162 modules                        |
| `pnpm build`                                 | exit 0                                                        |
| `pnpm db:generate`                           | exit 0 — no schema drift                                      |
| `pnpm exec drizzle-kit check`                | exit 0                                                        |
| Live Neon                                    | 30 tables, 20 migrations, all constraints and indexes present |
| Dependencies                                 | unchanged — 17 production, 21 development                     |

The full suite ran with `--fileParallelism=false`, for the environmental reasons §44 and §45
record. Concurrency is proven against real PostgreSQL via Testcontainers, never a mock.

### What this increment does NOT do

**Deferred, explicitly:** shipping provider, carrier API, provider webhooks, provider read-back ·
calculated rates, zones, weight-based pricing, shipping methods · multiple shipments, partial
fulfilment, backorders · GST, tax, HSN/SAC, place of supply, statutory invoice · refunds, returns
· COD settlement and delivery-payment transition · payment retry · reconciliation · reporting
dashboards · general admin order management · storefront, product images, reviews, wishlist ·
role management.
_(GST, HSN/SAC and place of supply delivered in §47; the STATUTORY invoice — numbering series,
HSN-wise summary, IRN/QR — remains deferred to Increment 39. Everything else here still stands.)_

**Still open from earlier increments, and untouched:** a COD payment never terminalises, so a COD
order remains uncancellable and its money is not tracked; a payment can still succeed against a
cancelled order, because the webhook does not check order status; and there is no origin address
for place of supply. _(The origin address was added in §47 as six typed `store.origin_*` columns;
the two payment gaps remain open.)_

**The provider seam is intentionally not built.** `PaymentGateway` shows what it will look like —
a consumer-declared port with no provider name in any type, plus an adapter beside `razorpay/`
that is the only file naming the vendor. Building it now would be an abstraction with one caller
and no second case, and the wrong seam is more expensive than a late one.

---

## 47. Phase 3 increment 38 — GST / tax foundation

The increment that finally charges tax. Three tables, twenty-nine new columns across `order` and
`order_line`, eleven routes — and not one GST rate, HSN code or state code anywhere in the
source. Everything statutory is data a merchant supplies; everything in code is arithmetic.

### The approved decisions

| #   | Decision                             | Value                                                                       |
| --- | ------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Prices                               | **GST-EXCLUSIVE.** `sku.price` is the pre-tax value                         |
| 2   | Seller of record                     | **The STORE**, not the platform                                             |
| 3   | Origin                               | **One GST origin/dispatch address per store.** Multi-warehouse deferred     |
| 4   | Classification unit                  | **The SKU**                                                                 |
| 5   | Within a product                     | Two SKUs MAY differ in HSN/SAC and tax class                                |
| 6   | HSN/SAC                              | **Snapshotted on the order line**                                           |
| 7   | Customer GSTIN                       | Optional, its own concern, **never on the address table**                   |
| 8   | B2B / B2C                            | Valid customer GSTIN supplied ⇒ B2B; otherwise B2C. Nothing else            |
| 9   | Place of supply                      | **Delivery destination**, represented so exceptions can be added explicitly |
| 10  | Split                                | Same state ⇒ CGST+SGST; different ⇒ IGST                                    |
| 11  | Rates                                | **Configurable, effective-dated. NEVER hardcoded**                          |
| 12  | Ordering                             | Discount allocated BEFORE tax; basis is `line_total − discount_amount`      |
| 13  | Arithmetic                           | Existing Decimal.js and ROUND_HALF_UP, at line/component level              |
| 14  | Snapshot                             | Tax facts frozen at the transaction boundary                                |
| 15  | Currency                             | **INR only**                                                                |
| 16  | COD                                  | Tax authoritative WITHOUT payment success. COD state machine untouched      |
| 17  | Invoice numbering                    | FY-scoped series per store — **delivered in §48**                           |
| 18  | E-invoice / e-way bill               | Deferred                                                                    |
| 19  | Returns, refunds, credit/debit notes | Deferred                                                                    |
| 20  | Master data                          | Engineering invents none of it                                              |

None of these was chosen here; all were approved before implementation.

### The one rule that was NOT handed down, and how it was settled

Decisions 1–20 fix what tax IS. They are silent on what happens to a store that has configured
none of it — and every existing order, fixture and test in this repository was created by
exactly such a store.

Two obvious answers were both wrong. Refusing every checkout until a merchant fills in a GST
profile invents a business rule and breaks 1,800 tests. Charging zero on an unclassified SKU
asserts an exemption accounting has not granted, which is the more dangerous of the two because
nobody notices until a return is filed.

**So configuration IS the switch, and it is all-or-nothing:**

| Store state                | Behaviour                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| No seller tax profile      | No determination. `tax_total` 0, `grand_total = total`, snapshot NULL                              |
| Seller tax profile present | Every line MUST resolve an active class and a rate in force, or the checkout is refused with `422` |

No new flag, no new column, no `store_setting` key: the profile a merchant has to fill in anyway
is the switch, and `ck_store_tax_profile` makes "half configured" unrepresentable so the
question has exactly one answer. **This is the one operational rule engineering settled, and it
is flagged for accounting ratification.**

The NULL snapshot is what makes it honest. NULL across the group records _"not assessed"_; a
determination that produced zero arrives as a FULL snapshot with zero rates. Collapsing the two
would make an unassessed order indistinguishable from an exempt one, and `ck_order_tax_snapshot`
keeps them apart for ever.

### `total` was not redefined. It never will be.

§43 pinned it: _"`total` means the payable GOODS total, before any tax, permanently. When GST
arrives it adds `tax_total` and `grand_total` alongside; it must not redefine `total`."_

That is exactly what happened, and both identities now stand side by side in the database:

```
ck_order_total_identity        total       = subtotal - discount_total     (unchanged)
ck_order_grand_total_identity  grand_total = total + tax_total             (new)
```

A row where either disagrees is an order that cannot be invoiced, and it would be found by an
accountant rather than by a test. `tax_total` is the SUM of the line figures, never an
independent calculation — the same rule §43 applied to `discount_total`, for the same reason:
an invoice whose lines do not foot to its header is what `allocate()` exists to prevent.

**`grand_total` is now the payable amount**, and `payment.amount` is copied from it. The port
was renamed `payableTotal` at the same time so the two cannot be confused at either end. For
every order placed before this increment the two are equal by the identity above, which is why
the change is invisible to all of them.

### The three tables

**`tax_class`** — a classification a SKU points at. Holds NO percentage: rates are
effective-dated and a class is not, so a rate here would mean either losing the old value on
every change or versioning the class, which is the same split done worse. No soft delete; a
class is deactivated, and nothing historical depends on it surviving because the order line
carries the code and name as text.

**`tax_rate`** — CGST, SGST, IGST and cess as separate `NUMERIC(9,6)` columns, with a half-open
`[effective_from, effective_to)` window. Components are stored separately because a blended
percentage cannot produce a compliant breakdown later. **No relationship between them is
enforced**: the conventional arrangement is that IGST equals CGST plus SGST, and encoding that
would make this schema the authority on a rule the finance function owns.

**`customer_tax_identity`** — the third thing §43 named and declined to build: _"a customer's
GSTIN is customer tax identity — a third thing, alongside address data and order-time tax
determination."_ One row per user, two fields, and nothing else. Approved decision 7 put it here
rather than on `address`; approved Phase 1B forbade a broader profile redesign.

### Overlap prevention, and the extension that was not added

Two windows for one class must never both be in force. Three mechanisms, in order of strength:

1. `uq_tax_rate_class_from` — no two rates may START at the same instant.
2. `uq_tax_rate_class_open` — at most ONE open-ended window per class. This is the half that
   matters in practice: adding a new rate without closing the old one is the mistake that
   actually happens.
3. The service LOCKS the `tax_class` row before checking, so two staff configuring rates
   serialise rather than both passing an unlocked check.

`EXCLUDE USING gist (store_id WITH =, tax_class_id WITH =, tstzrange(...) WITH &&)` would say all
of it in one line. It needs `btree_gist`, which is not a trusted extension and therefore requires
SUPERUSER in a migration — a privilege this project's migration runner should not need and a
managed provider may withhold. Drizzle also cannot express EXCLUDE, so the constraint would live
only in hand-written SQL and be invisible to `db:generate`. The row lock closes the same gap at
no cost, and a concurrency test proves it: two simultaneous overlapping rates produce one `201`
and one `409`, with exactly one row written.

### SKU classification, and a deliberate departure from §41

§41 recorded the placement this column would take: _"`sku.tax_class_id` nullable, falling back
to `product.tax_class_id`"_. Increment 38 built the column and **dropped the product fallback.**

Approved decision 5 settles the question §41 and §42 each raised once and left open — _"whether
two SKUs of one product may attract different GST rates"_ — and the answer is yes. Once that is
true, a product-level fallback is not a convenience but an ambiguity: a SKU with no class would
silently inherit a classification that may be wrong for it, and a wrong classification is under-
or over-charged tax on every sale. There is exactly one place a SKU's classification comes from.

An unclassified SKU is NOT untaxed. In a store with a GST profile, checkout refuses it with
`422 TAX_NOT_DETERMINABLE` naming the SKU codes — the same shape as `CHECKOUT_LINES_UNAVAILABLE`,
and for the same reason: a customer must be told which item is the problem.

### The determination, and where it happens

```
 9. line money and the subtotal
10. allocate the cart discount across the lines        <- §42, unchanged
11. resolve the seller tax profile                     <- new
12. resolve the customer tax identity                  <- new
13. determine the authoritative tax instant            <- new
14. resolve classification and the effective rate      <- new
15. calculate line taxes, tax_total, grand_total       <- new
16. insert the order and its immutable snapshots
17. transition the cart
18. complete the idempotency claim
```

Steps 11–15 sit AFTER the allocation because approved decision 12 and §42 fix that ordering, and
BEFORE the insert because `ck_order_grand_total_identity` refuses a header whose totals are not
yet known — there is no "insert now, tax later" option. All of it runs inside the existing
checkout transaction, so the profile, the registration and the classifications are read in the
same snapshot as the order they are written onto. `determineForCheckout` asserts it is in a
transaction rather than trusting the caller, exactly as `lockCartForCheckout` and `reserve` do.

**Orders does no tax arithmetic.** It hands over line money it computed and a destination state
it snapshotted, and writes back a determination verbatim. There is no rate, no percentage and no
tax calculation anywhere in `orders.service.ts`; the one place tax is computed is
`tax.calculator.ts`, which is pure and needs no database to test.

### Rounding: once per component

Not per line, and not per invoice.

Per-component is what makes the stored breakdown add up. `ck_order_line_tax_total` requires
`tax_total` to equal the sum of the four stored amounts exactly, so carrying components unrounded
and rounding only the total would produce a row the database refuses. Rounding each and summing
the rounded values makes the identity hold by construction.

ROUND_HALF_UP is inherited from `money.ts`, whose own comment records why — _"it is what Indian
GST rules, invoice expectations, and every merchant's spreadsheet assume"_ — and approved
decision 13 restates it. **No rounding rule is defined in this increment.** There is exactly one
in the codebase, and §42's rule held again: the tax module added no money code, only calls.

### What is snapshotted, and why every single field

Approved decision 14: _"Historical invoices/orders must not re-read mutable tax master data."_
Every source below is mutable, and §40's rule reaches all of them — _"the moment a past invoice
reads a live address, a customer fixing a typo rewrites history."_

**On `order`:** `tax_total`, `grand_total`, `tax_at`, `supply_type`, `place_of_supply_state`,
`place_of_supply_basis`, `seller_gstin`, `seller_legal_name`, the six `origin_*` columns,
`customer_tax_category`, `customer_gstin`, `customer_legal_name`.

**On `order_line`:** `taxable_value`, `hsn_code`, `tax_class_code`, `tax_class_name`, and a
RATE and an AMOUNT for each of CGST, SGST, IGST and cess, plus `tax_total`.

Both the rate and the amount, deliberately: storing only amounts makes a line impossible to
explain, and storing only rates makes it recomputable and therefore vulnerable to a future change
in how rounding works. **There is no foreign key from an order to `tax_class` or `tax_rate`
anywhere** — that is the point.

`tax_at` is its own column rather than a reuse of `placed_at`, for the reason `placed_at` is not
`created_at`: they coincide today because tax is determined at checkout, and an increment that
moves the determination must be able to say so without restating what "placed" means.

**The acceptance test changes all of it.** One test places an order, then closes the rate and
adds a very different one, renames the tax class, reclassifies the SKU under a new HSN, changes
the seller's GSTIN and legal name and moves the premises to another state, and changes the
customer's registration — then asserts every figure and every identity on the persisted row and
through the API is byte-identical. That is Phase 8's mandatory criterion, and it is one test
rather than nine because the failure it guards against is systemic.

### Place of supply, and the limitation this increment does not close

Approved decision 9 asked for two things. The rule — delivery destination for the ordinary
domestic goods flow — and the representation: _"Do not hide statutory exceptions inside a generic
state comparison."_

`place_of_supply_basis` is that representation. One value exists (`delivery_destination`), so
every order records WHICH rule decided it, and a future exception becomes a new value rather than
an invisible change in behaviour that no historical order can be distinguished by.

**The weak link is the comparison itself, and it is named rather than hidden.** §43 declined to
invent a GST state-code catalogue and this increment was told the same, so both sides are free
text: `store.origin_state` and the order's `ship_state`. `normaliseStateName` repairs case,
surrounding whitespace and internal runs — the overwhelmingly common case — and cannot repair two
genuine spellings of one state (`Orissa` / `Odisha`), an abbreviation, or a typo. Those compare
unequal and produce IGST where CGST+SGST was due.

A test asserts the limitation directly, so anybody who later adds a catalogue finds the case
already written down. **Closing it requires a statutory state catalogue, which is accounting
master data, not an engineering choice.** The normalised value is snapshotted onto the order
precisely so a wrong determination can be found and explained afterwards rather than merely
suspected.

### COD, again

Approved decision 16: tax becomes authoritative at CHECKOUT and does not wait for payment.

That is forced rather than chosen. §44 and §45 both record that a COD payment is created
`pending` and no code path terminalises it; §46 added an authorised unpaid fulfilment path on top
of that. If tax waited for payment success, every COD order would be permanently unassessed. So
the determination happens at checkout for both methods, the COD payment row is untouched, and a
test asserts the payment is still `pending` while `tax_at` is set and `tax_total` is charged.

The COD state machine was not modified in any way.

### The seller identity: four dead columns, made live

`store.legal_name`, `gstin`, `pan` and `registered_address` have existed since the first
migration and were read and written by NOTHING — the seed never set them, no route touched them,
and `ResolvedStore` deliberately excluded them on the stated grounds that they _"belong to
invoicing."_ This is invoicing, so three of the four now have a staff-only write path.

**`registered_address` was declined.** An untyped `jsonb` defaulting to `{}` has no shape, no
validator and no NOT NULL on anything inside it, and place of supply is the single most
consequential field on a tax invoice — it does not belong in a blob. Six typed `origin_*` columns
replace it. The blob is kept rather than dropped because dropping a column is destructive and it
may hold operator-entered values; it is documented as superseded and read by nothing.

`ResolvedStore` stays narrow. The tax profile is read by the tax repository, not by the resolver
every request pays for.

### GSTIN validation: shape, and deliberately no checksum

`^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$`, applied in Zod AND as a CHECK, because §24's
rule holds: a bulk import or an operator running SQL during an incident bypasses the validation
boundary.

The check-digit ALGORITHM is a different thing and is not implemented. Approved decision 8 asked
for strict SHAPE validation; implementing a checksum would be engineering inventing a validation
rule, and a wrong implementation rejects a legitimate registration — a worse failure than
accepting a well-shaped invalid one, which the tax authority rejects anyway.

The same judgement governs HSN: two to eight digits, no catalogue, and deliberately no fixed
digit count, because the number required depends on a turnover threshold this project was told
not to invent.

### The invoice: it shows the tax, and it still disclaims

The document now renders per-component CGST/SGST/IGST/cess rows, the HSN against each line, both
parties' GSTIN, the place of supply and the supply type — because withholding figures a customer
has actually been charged would be misleading in the other direction.

**What it does not do is claim compliance.** The disclaimer was REWORDED, not removed:

> _"This document is NOT a statutory GST tax invoice. The tax shown was calculated and charged,
> but the document carries no sequential invoice number, no HSN-wise summary, and no IRN or QR
> code."_

A document that quietly stopped disclaiming the moment it grew a tax row would be the worst
possible outcome of this increment, and a test asserts the wording survives. A second test
asserts an unassessed order renders exactly as it did before, with no GST block at all.

The letterhead is still the hardcoded `COMPANY` constant, and the seller of record is now named
separately from it in the GST block. Reconciling the two — along with the FY-scoped invoice
series, the HSN-wise summary and IRN/QR — is Increment 39.

### Audit, and no events

Five audit actions: `tax.profile_updated`, `tax.class_created`, `tax.class_updated`,
`tax.rate_created`, `tax.sku_classified`. All five change what customers are charged, which is
the bar promotions set for auditing configuration; a rate change moves it for every customer at
once. The seller GSTIN and legal name go into the trail because they are the seller's own PUBLIC
registration details, printed on every invoice; the origin ADDRESS does not, because §40's rule
about log aggregators applies and it adds nothing.

The customer's own tax identity is NOT audited. §42's reasoning for the cart applies exactly: an
audit row per self-service edit buries the entries that matter, and the value an audit needs is
the one snapshotted onto the order.

**No domain event.** §39's rule has held for ten increments. `tax.rate_changed` is the obvious
candidate — a reporting pipeline would want it — and that is precisely why it must not be
published speculatively. A test asserts no `tax.*` event reaches the outbox.

A discovery worth recording: `audit.record` refuses to write outside a transaction by default,
and four tax write paths initially called it without one. That default is correct and caught a
real defect — a profile change that switched GST on with no trail of who did it is exactly the
entry an auditor comes looking for. All four now commit the write and its audit row together.

### The API

Eleven new operations across six paths, taking the documented surface to **79 operations across
55 paths**.

| Method               | Path                              | Access                     |
| -------------------- | --------------------------------- | -------------------------- |
| `GET` `PUT`          | `/admin/store/tax-profile`        | Staff — **the GST switch** |
| `POST` `GET`         | `/admin/tax-classes`              | Staff                      |
| `PATCH`              | `/admin/tax-classes/{code}`       | Staff                      |
| `POST` `GET`         | `/admin/tax-classes/{code}/rates` | Staff                      |
| `PUT`                | `/admin/skus/{code}/tax`          | Staff                      |
| `GET` `PUT` `DELETE` | `/users/me/tax-identity`          | Customer                   |

Everything is addressed by CODE; no database id appears in a URL or a body. A tax class code is
immutable after creation, because every order line that used it carries the code as a snapshot
and renaming would leave historical invoices naming a code the admin surface no longer has.

There is deliberately **no rate update and no rate delete**. A rate that was in force is what a
historical order was assessed under; superseding it with a new dated window is the honest
correction. Orders snapshot their own rates, so a figure is safe either way — but the master data
should still tell the truth about what applied when.

SKU classification got its own route rather than fields on `PATCH /admin/skus/{code}`, so a
well-tested existing contract did not have to be widened for data with a different authority and
a different reviewer.

**The order response changed additively:** `taxTotal`, `grandTotal` and a nullable `tax` object
on the header, and a nullable `tax` object per line. Nullable rather than zeroed, so "not
assessed" and "assessed at nil" stay distinguishable on the wire as well as in the database. A
test asserts the exact key set of both.

Nothing a client sends can reach a tax figure. A test fires nine forged fields at checkout —
`taxTotal`, `grandTotal`, `supplyType`, `placeOfSupply`, `sellerGstin`, `customerGstin`,
`cgstRate`, `taxClassCode`, `hsnCode` — and every one is a `400` naming the field, because every
request schema in the system is a `strictObject`.

### The migration, and the eighth appearance of a known fault

Migration 21, `20260908180451_tiresome_tombstone.sql`, 76 statements, one transaction.

**Drizzle emitted `fk_tax_rate_class_store` BEFORE `uq_tax_class_id_store`, the unique index it
references.** This is the EIGHTH appearance of that fault — §43 records the fifth, §44 the sixth,
§46 the seventh. Every `CREATE INDEX` was hoisted above every `ADD CONSTRAINT … FOREIGN KEY`.

A second correction was needed, and it is new. Drizzle emitted `order.grand_total` as `NOT NULL`
with no default, which cannot be added to a populated table, and `order_line.taxable_value` as
`NOT NULL DEFAULT 0`, which would then violate `ck_order_line_taxable_value` on every existing
row. Both are handled by a backfill block: `grand_total` arrives nullable, both columns are
backfilled from data already present, and `grand_total` is then set `NOT NULL`.

**The backfill states facts rather than inventing them.** `grand_total := total` because no tax
was calculated or charged on any pre-existing order, so `total + 0` is arithmetic;
`taxable_value := line_total − discount_amount` because that identity was already true of every
line and the column merely materialises it. What those orders deliberately do NOT get is a
determination — every snapshot column stays NULL.

Not destructive. No `DROP` of any kind: no column removed, narrowed or retyped, no existing CHECK
dropped or replaced, and `registered_address` left exactly as it was.

Applied to Neon: **33 tables, 21 migrations**, all three tables, nine indexes, six foreign keys
and 24 new CHECK constraints verified live, with 11 pre-existing orders backfilled and zero
identity violations.

### Verification

| Check                                         | Result                                        |
| --------------------------------------------- | --------------------------------------------- |
| Tax calculator (unit)                         | 30 passed                                     |
| Payments + fulfilment + GST integration       | 198 passed (45 of them GST)                   |
| Orders, inventory, tax, http, payments        | 650 passed                                    |
| Full suite                                    | **1,855 passed**, 59 files, exit 0            |
| Fresh-database migration                      | 33 tables, 21 migrations, exit 0              |
| Mutation gate                                 | **11 probes, 11 killed**                      |
| `format:check` · `lint` · `typecheck`         | exit 0                                        |
| `depcruise`                                   | exit 0 — 0 violations, 170 modules            |
| `build` · `db:generate` · `drizzle-kit check` | exit 0, no drift                              |
| Dependencies                                  | **unchanged** — 17 production, 21 development |

### An incident worth recording

Midway through this increment a `git checkout` on a single test file — intended to remove a
debug probe — reverted `payments.integration.test.ts` to `HEAD`, discarding the Increment 36
expiry tests, the Increment 37 fulfilment tests and the Increment 38 GST tests in one stroke.
Nothing was staged, no stash existed, and `git fsck` found no dangling blob.

It was fully recovered because each block had been composed in a scratch file before being
spliced in, and those files survived. The harness itself was rebuilt from the sibling
`payments.edge-cases.integration.test.ts`, which carried the same shape.

Two things are worth carrying forward. **`git checkout -- <file>` is a destructive command on a
repository with uncommitted work**, and it should never be reached for to undo an edit that an
editor tool can undo precisely. And `core.autocrlf=true` restored the file with CRLF line
endings, which silently broke every subsequent exact-string patch until it was normalised — a
second failure mode hiding behind the first.

### What this increment does NOT do

**Deferred, explicitly:** invoice numbering and the FY-scoped series · HSN-wise and rate-wise
invoice summaries · e-invoicing, IRN, QR · e-way bills · credit and debit notes · refunds and
returns · GSTR-1/3B export and reconciliation · reverse charge · composition scheme · exemptions
and zero-rating as first-class concepts · multi-location origin · shipping tax (shipping is free,
so there is nothing to tax) · multi-currency GST · a GST state-code catalogue · a GSTIN checksum
· rate correction in place.
_(Invoice numbering, the FY-scoped series and the HSN/rate-wise summary were delivered in §48.
Everything else in this list still stands, e-invoicing and IRN/QR included.)_

**Still open from earlier increments, and untouched:** a COD payment never terminalises · a
payment can still succeed against a cancelled order · `store_setting` and `feature_flag` remain
dead tables.

**The one thing accounting must ratify:** that an unconfigured store assesses no tax, and that a
configured store REFUSES an unclassified line rather than assessing it at zero. Everything else
in this section was decided before implementation.

---

## 48. Phase 3 increment 39 — statutory invoice issuance

The increment that gives the document a number. Two tables, one new module, no new route — and
the first thing in this project whose defining property is that it must have **no gaps**.

### The approved requirements

| #   | Requirement                                             | How it landed                                               |
| --- | ------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | Issuance inside the existing checkout transaction       | Step 17b, after the lines and the reservation               |
| 2   | **No payment-success dependency**; COD invoiced too     | No payment state is read on the issuance path at all        |
| 3   | Dedicated invoice persistence                           | `invoice` — immutable, one per order                        |
| 4   | Dedicated store + FY series counter                     | `invoice_series` — one row per store per year               |
| 5   | FY = 1 April to 31 March in `store.timezone`            | `financial-year.ts`, via `Intl` with an explicit IANA zone  |
| 6   | Format exactly `INV/YYYY-YY/NNNNNN`                     | One formatter, and a CHECK that re-derives it in SQL        |
| 7   | Sequential and gapless                                  | The counter row, and the rollback that releases it          |
| 8   | Transactional allocation; **no sequence, no `MAX()+1`** | One `INSERT … ON CONFLICT DO UPDATE … RETURNING`            |
| 9   | One invoice per order, in the database                  | `uq_invoice_order`                                          |
| 10  | HSN/rate-wise summary from frozen line snapshots        | `invoice-summary.ts`, a pure module                         |
| 11  | Exact monetary reconciliation                           | `reconcile()`, before the number is allocated               |
| 12  | Historical seller identity from the order's snapshot    | The renderer reads `order.seller_*` and nothing else        |
| 13  | Remove the hardcoded seller from the renderer           | `COMPANY` deleted; a test guards against its return         |
| 14  | Persist invoice date / `issued_at`                      | Both columns, and the date is parsed rather than re-derived |
| 15  | The GET routes stay read-only                           | `findForOrder` has no allocation path                       |
| 16  | Unassessed orders get no statutory number               | `issueForOrder` answers `null`                              |
| 17  | No fake IRN/QR, no IRP integration                      | Nothing to hold one; the disclaimer says so                 |
| 18  | Preserve escaping / CSP / `no-store`                    | Unchanged, and re-asserted on the new fields                |
| 19  | Preserve architecture and depcruise boundaries          | A new module behind a consumer-declared port                |
| 20  | Update the documentation                                | This section, and the README                                |

None of these was chosen here; all were approved before implementation.

### Why the counter is a ROW and not a sequence

This is the whole increment in one decision.

**`nextval()` produces gaps, and a gap is the one thing a statutory series may not have.** A
PostgreSQL sequence is deliberately non-transactional: it advances even when the transaction
that called it rolls back, because that is exactly what makes it fast and lock-free. For a
surrogate key that is right. Here it is fatal — a checkout that fails on insufficient stock
would burn a number, and the books would read 000001, 000003, 000004 with nothing to account
for the one in between.

A counter **row** increments inside the caller's transaction, so a rollback un-increments it and
the number goes to the next order instead. A test provokes exactly that: it starves the stock,
watches the checkout fail with a `409`, asserts that neither the invoice nor the series row
exists, then restocks and places a good order — which takes **000001**.

**`MAX(sequence_number) + 1` is wrong for the more familiar reason.** Under READ COMMITTED two
concurrent readers see the same maximum and both write it. One would lose `uq_invoice_number`
and a customer would get a 500 on a successful order.

### The allocation: one statement

```sql
INSERT INTO invoice_series (id, store_id, financial_year, last_number)
VALUES ($1, $2, $3, 1)
ON CONFLICT (store_id, financial_year)
  DO UPDATE SET last_number = invoice_series.last_number + 1, updated_at = now()
RETURNING last_number;
```

First call returns 1, every later call returns the next. Concurrency, exactly: two transactions
issuing the first invoice of a year both attempt the INSERT; one wins `uq_invoice_series`, the
other **blocks on that index** until the winner commits or rolls back, then takes the
`DO UPDATE` branch and reads the committed value. So the two allocations are 1 and 2, in some
order, and never both 1.

`FOR UPDATE` appears nowhere: `DO UPDATE` takes the row lock itself.

**Two-statement shapes were considered and rejected.** `INSERT … DO NOTHING` followed by an
`UPDATE` has a real failure mode, not a theoretical one: if the transaction that inserted the
series row then rolls back, a concurrent transaction that had already decided to "do nothing"
finds no row to update and allocates nothing. `DO UPDATE` has no such window — the row either
arrives from this statement or is locked and incremented by it.

A test fires three concurrent checkouts on real connections and asserts the sequences are
exactly `[1, 2, 3]`, the numbers are distinct, and the counter reads 3.

### The financial year, and why the timezone is load-bearing

1 April to 31 March, in **`store.timezone`** — approved requirement 5.

The timezone is not decoration. `2027-03-31T20:00:00Z` is already 1 April in Kolkata and still
31 March in UTC, so computing the year in UTC would file an Indian store's first invoice of the
new year into the series that closed four hours earlier. A misfiled statutory document, and one
only a tax audit would ever find. A test asserts that one instant lands in two different years
for two stores in different zones.

`Intl.DateTimeFormat.formatToParts` with an explicit `timeZone`, rather than arithmetic on the
`Date`: the platform's own IANA database handles every historical offset change and DST rule,
and the parts come back separately so nothing has to parse a formatted string back apart. An
invalid zone is an OPERATOR error — `store.timezone` is configuration — so it raises rather than
guessing.

The label's second half is the closing year modulo 100, zero-padded, so the century turn is
`2099-00`. A test pins that so nobody "fixes" it into `2099-100`.

### Where issuance sits, and why nowhere else would do

```
15. the order header            <- the number needs an order to attach to
16. the lines                   <- the summary is derived from their frozen snapshots
16b. the reservation            <- a stock failure must not burn a number
17. the first history row
17b. ISSUE THE INVOICE          <- Increment 39
18. audit
19. complete the idempotency claim
```

After the lines, because there is nothing to summarise before them. After the reservation, so an
order that fails on stock never reaches the counter. Inside the transaction, which is what makes
the rollback release the number. `issueForOrder` asserts it is in a transaction rather than
trusting the caller — the same assertion `lockCartForCheckout`, `reserveForOrder` and
`determineForCheckout` all make.

**No payment state is consulted anywhere on this path.** Requirement 2 makes issuance a
consequence of the supply being recorded, not of money arriving — which is forced rather than
chosen: §44–§46 record that a COD payment is created `pending` and no code path terminalises it,
so waiting for payment would leave every COD sale permanently uninvoiced. A test asserts the
invoice exists _before_ any payment is created, and again after a COD payment is created
`pending`.

### The two tables

**`invoice_series`** — the only row in this schema meant to change. `last_number` is named for
what it holds rather than `next_number`, which would make the row's meaning depend on whether
you read it before or after an allocation.

**`invoice`** — immutable. No `UPDATE` path, no `deleted_at`, no revision column. §3 #15 ties
order retention to tax law and it applies with more force here: a gapless series is only gapless
if nothing can remove a number from the middle of it.

**What `invoice` deliberately does NOT duplicate:** the seller's identity, the place of supply,
the supply type, both parties' GSTIN, and every per-line rate and amount. All of those are
already frozen on `order` and `order_line` by §47. Requirement 12 makes the order's snapshot the
source of historical seller identity, and a second copy would be a second thing that could
disagree with the first — the failure §43 avoided by deriving `discount_total` from the allocated
parts rather than computing it twice.

What IS stored is what the order cannot answer: the number, the series it came from, the date the
document bears, and the money totals as they stood when the number was allocated.

### Five CHECKs worth naming

| Constraint                        | What it stops                                           |
| --------------------------------- | ------------------------------------------------------- |
| `ck_invoice_number_matches_parts` | A printed number that disagrees with its own sequence   |
| `ck_invoice_grand_total_identity` | An invoice that does not foot, checkable without a join |
| `ck_invoice_number_shape`         | Anything that is not `INV/YYYY-YY/NNNNNN`               |
| `ck_invoice_sequence_positive`    | A number nobody issued                                  |
| `uq_invoice_sequence`             | Two invoices claiming one place in a series             |

`ck_invoice_number_matches_parts` re-derives the string in SQL —
`'INV/' || financial_year || '/' || lpad(sequence_number::text, 6, '0')` — so a change to the
formatter that was not mirrored in the constraint fails at the database rather than on a printed
document. It is the single worst defect this table could carry, and one no reader would spot.

### The HSN/rate-wise summary

Derived, not stored. The inputs are already immutable — `order_line`'s frozen tax snapshots — so
a stored copy would only be a second thing that could disagree with them. A rate change, a
reclassification or a renamed tax class cannot alter a summary computed years later, and a test
proves it by changing all three and re-rendering.

**The grouping key has five parts:** `(hsn_code, cgst_rate, sgst_rate, igst_rate, cess_rate)`.
Two lines share a row only when they share the code AND every rate. Grouping by HSN alone would
merge two lines carrying the same code under different rates — producing a row whose "rate"
column is a lie about one of them, and the first thing an assessing officer would query. A test
asserts the split.

Ordering is deterministic — by HSN then by rate — because the summary is PRINTED: two renders of
one invoice must be byte-identical, and `Map` insertion order would make the layout depend on the
order rows came back from the database in.

A line with no classification is SKIPPED, not bucketed under a placeholder. Inventing an
`UNCLASSIFIED` HSN row would print a code no catalogue contains.

### Reconciliation happens BEFORE the number is allocated

Three exact equalities — requirement 11:

```
Σ summary taxable value = order.total
Σ summary tax           = order.tax_total
taxable + tax           = order.grand_total
```

Plus a fourth: the four components must foot to the summary's own tax total, which is the check
that would catch a future grouping change dropping one.

Compared with `equals()` on `Money`, never string equality — `'324.00'` and `'324.0000'` are the
same amount and different strings, and a reconciliation that failed on formatting would be worse
than none at all.

It raises an `InvariantViolation` rather than returning a verdict, because the caller has no
useful recovery: it is inside the checkout transaction, and the right answer to "the invoice does
not foot" is to write no invoice and no order.

### The hardcoded seller is gone

§47 left one contradiction standing. Approved decision 2 had made the STORE the seller of record
and the platform explicitly not — and the renderer still carried:

```ts
const COMPANY = { name: 'Syntellite Innovation', tagline: …, email: …, site: … };
```

presenting a constant as the issuer on every document. Requirement 13 removed it. The letterhead
now reads `order.seller_legal_name` and `order.seller_gstin`, both frozen at checkout, and the
footer carries the origin address from the same snapshot. A merchant who re-registers, renames or
moves does not restate a single historical document.

**An unassessed order shows no seller at all.** It is not a statutory invoice, has no seller of
record, and inventing one for the letterhead would be the same mistake in a smaller font. A test
asserts that no document — assessed or not — contains the old constant.

The logo survives, because it is decorative (`alt=""`) and makes no claim about who sold
anything.

### Three documents, one renderer

| Order                      | Title           | Reference            | Seller          | Tax rows | HSN summary |
| -------------------------- | --------------- | -------------------- | --------------- | -------- | ----------- |
| Unassessed                 | Invoice         | order number         | none            | none     | none        |
| Assessed, pre-Increment-39 | Invoice         | order number         | frozen snapshot | yes      | none        |
| Assessed and invoiced      | **Tax invoice** | `INV/YYYY-YY/NNNNNN` | frozen snapshot | yes      | **yes**     |

The middle row matters: an order placed before this increment renders exactly as it did, which is
the proof that the read path issues nothing. Requirement 15, and two tests — one fetches an
uninvoiced document three times and asserts no invoice and no series row appear, the other
fetches an invoiced one three times and asserts the number and the counter do not move.

### Still not e-invoiced, and the disclaimer says so

No IRN, no acknowledgement number, no signed QR code — real or fake. Requirement 17 forbids
inventing a plausible-looking substitute, and there is nowhere to put one: `invoice` has no
column for it. A test asserts the rendered document contains no `IRN:`, no
`Acknowledgement number`, no `<canvas>` and no `qrcode`.

So the disclaimer is reworded a second time rather than deleted:

> _"Issued under a sequential, financial-year-scoped invoice series, with an HSN/SAC and
> rate-wise tax summary. This document is not e-invoiced: it carries no IRN, no acknowledgement
> number and no signed QR code, because this system is not registered with the Invoice
> Registration Portal."_

A document that quietly stopped disclaiming the moment it grew a number would be the worst
possible outcome of this increment.

### No route, and no event

**Zero new endpoints.** The document is served by the two existing orders routes; issuance is a
consequence of checkout. The API stays at **79 operations across 55 paths**, and the drift guard
needed no change — which is the clearest possible statement that this increment added capability
rather than surface.

**No domain event.** §39's rule holds for the eleventh increment. `invoice.issued` is the most
event-worthy thing here — "email the customer their invoice" is what every shop sends, and the
mail infrastructure already exists — which is exactly why it must not get a speculative one. A
test asserts no `invoice.*` event reaches the outbox.

One audit action, `invoice.issued`, because a gapless series is an auditable artefact: "which
order took number 000042, and when" must be answerable without reading the invoice table.

### The migration, and the fault that did NOT appear

Migration 22, `20260909064622_slim_luminals.sql`, 9 statements, one transaction.

**No manual correction was needed, and that is worth recording.** Eight prior increments hit the
same drizzle-kit fault — a FOREIGN KEY emitted before the unique index it references (§43 the
fifth, §44 the sixth, §46 the seventh, §47 the eighth). This migration is clean as generated,
because all three of its FK targets already exist: `fk_invoice_order_store` points at
`order(id, store_id)` via `uq_order_id_store`, and the two store references point at a primary
key. Nothing here references an index created by this migration. Verified by applying it, not
assumed.

One thing WAS corrected before generating: the first draft carried both
`uq_invoice_sequence` and a plain `ix_invoice_series_sequence` on the identical three columns in
the identical order. The unique index already serves the series audit read, so the plain one was
dead weight the planner would never choose. Removed, and the schema comment says why.

Additive and non-destructive: two `CREATE TABLE`s, three FKs, four unique indexes, no `DROP` of
any kind, no column added to an existing table, and **no backfill**. An order placed before this
migration simply has no invoice row. Backfilling would mean allocating numbers to historical
orders in whatever sequence a query returned them, which is not a series.

### Verification

| Check                                         | Result                                        |
| --------------------------------------------- | --------------------------------------------- |
| Financial year + number format (unit)         | 24 passed                                     |
| HSN summary + reconciliation (unit)           | 17 passed                                     |
| Invoice document (unit)                       | 41 passed                                     |
| Invoicing integration (real PostgreSQL)       | 27 passed                                     |
| Full suite                                    | see the increment report                      |
| `format:check` · `lint` · `typecheck`         | exit 0                                        |
| `depcruise`                                   | exit 0 — **0 violations, 177 modules**        |
| `build` · `db:generate` · `drizzle-kit check` | exit 0, no drift                              |
| Live Neon                                     | 35 tables, 22 migrations                      |
| Dependencies                                  | **unchanged** — 17 production, 21 development |

### What this increment does NOT do

**Deferred, explicitly:** IRP integration · real IRN generation · statutory QR generation ·
e-way bills · returns and refunds · credit and debit notes · GSTR exports · reverse charge ·
composition · exemptions and zero-rating · multi-location GST · multi-currency GST · a GST
state-code catalogue · a GSTIN checksum · tax-rate correction in place · any payment or COD state
redesign.

**Still open from earlier increments, and untouched:** a COD payment never terminalises · a
payment can still succeed against a cancelled order · state matching for place of supply is free
text, so two spellings of one state still produce IGST where CGST+SGST was due · `store_setting`
and `feature_flag` remain dead tables.

**Two limitations this increment introduces, both stated rather than hidden:**

An invoice **cannot be cancelled or amended**. There is no credit note, so an order that is
cancelled after being invoiced keeps its number and its document — which is correct for a series
that must not have gaps, and incomplete until credit notes exist. The document already shows
`Cancelled` in its status badge, so it does not misrepresent the order.

The series width is **six digits**, so a store may issue 999,999 invoices in one financial year
before the format must widen. `formatInvoiceNumber` refuses a wider number loudly rather than
producing a document the CHECK would reject.
