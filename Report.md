#Report

**Project:** Reusable multi-tenant e-commerce backend (India / INR / GST target market)
**Report date:** 4 September 2026
**Report type:** Status and audit only — no code, tests, migrations, configuration or database data were modified to produce this report.
**Source of truth:** the repository as it stands on disk today, plus verification commands executed during this audit (logged in the final section).

---

## 1. Executive Position

The project is a **backend API only**. Thirty roadmap increments have been implemented and documented. The full automated verification suite passes with **1,449 tests across 50 test files, 0 failing, 0 skipped**.

A customer can today register, log in, browse and search a catalogue, manage an address book, build a cart, apply a coupon, **check out, and place and read real orders**. Staff can manage products, variants, SKUs, inventory and promotions through authenticated APIs.

**There is no user interface of any kind** — no storefront and no Admin Dashboard. **Payment, shipping, GST/tax, invoicing and returns are not implemented** and are explicitly deferred future work.

---

## 2. Roadmap Position

`docs/DECISIONS.md` §3 #1 fixes the roadmap at **9 phases (0–8)**. Section headings in that file identify the increments delivered:

| Phase | Increments delivered | Status |
|---|---|---|
| Phase 0 — foundation, outbox, HTTP scaffolding, composition root, process entry points | documented as steps (§10–§14) | Complete |
| Phase 1 — identity and access | 1, 2, 3, 4, 5, 6, 8, 9, 10, 21 | Complete |
| Phase 2 — catalogue, inventory, addresses, cart, promotions | 11–20, 24–29 | Complete |
| Phase 3 — checkout and orders | 30 | **In progress** (first increment delivered) |
| Phases 4–8 | none | Not started |

**Phase completion: 3 of 9 phases fully complete = 33%** (Phase 3 started, 6 phases untouched).

**No increment-level percentage is given.** The repository documents 29 numbered increments delivered, but neither `docs/DECISIONS.md` nor any other file in the repository defines the *total* number of increments planned across all nine phases. Without a stated denominator, any increment percentage would be invented, so none is offered.

---

## 3. Customer / User-Side Functionality

Legend: ✅ Working & Verified · 🟡 Partially Working · 🔵 Not Implemented · 🔴 Failing

| Function | API / Area | Status | Verified By |
|---|---|---|---|
| Create account | `POST /api/v1/auth/register` | ✅ | `register.integration.test.ts` (22 tests) |
| Log in | `POST /api/v1/auth/login` | ✅ | `login.integration.test.ts` (35), `login-collision` (5) |
| Log out | `POST /api/v1/auth/logout` | ✅ | `logout.integration.test.ts` (18) |
| Refresh session | `POST /api/v1/auth/refresh` | ✅ | `refresh.integration.test.ts` (24), `refresh-token.test.ts` (10) |
| View own profile | `GET /api/v1/users/me` | ✅ | `current-user.integration.test.ts` (18) |
| Update own profile | `PATCH /api/v1/users/me` | ✅ | `update-profile.integration.test.ts` (31) |
| Change own password | `POST /api/v1/users/me/password` | ✅ | `change-password.integration.test.ts` (30) |
| Browse products | `GET /api/v1/products` | ✅ | `public-product-list.integration.test.ts` (23) |
| View one product | `GET /api/v1/products/:slug` | ✅ | `public-product.integration.test.ts` (22) |
| Search products | `GET /api/v1/products?q=` | ✅ | `public-product-search.integration.test.ts` (33) |
| Filter by price | `GET /api/v1/products?price_min=&price_max=` | ✅ | `public-product-price-filter.integration.test.ts` (35) |
| See SKUs / variant options | included in product payloads | ✅ | `sku.integration.test.ts` (64), `options.integration.test.ts` (91) |
| Create address | `POST /api/v1/users/me/addresses` | ✅ | `addresses.integration.test.ts` (53) |
| List / read / update / delete address | `GET`/`GET :id`/`PATCH :id`/`DELETE :id` | ✅ | same file |
| Get or create cart | `GET /api/v1/users/me/cart` | ✅ | `cart.integration.test.ts` (63) |
| Set item quantity | `PUT /api/v1/users/me/cart/items/:skuCode` | ✅ | same file |
| Remove item | `DELETE /api/v1/users/me/cart/items/:skuCode` | ✅ | same file |
| Clear cart | `DELETE /api/v1/users/me/cart` | ✅ | same file |
| Cart totals (subtotal, discount, total, item count) | cart response | ✅ | same file |
| Apply coupon | `PUT /api/v1/users/me/cart/promotion` | ✅ | `cart-promotions.integration.test.ts` (70) |
| Remove / replace coupon | `DELETE /api/v1/users/me/cart/promotion` | ✅ | same file |
| **Checkout** | `POST /api/v1/users/me/checkout` | ✅ | `orders.integration.test.ts` (90 declared) + 194-check live smoke |
| **Place an order** | same | ✅ | same |
| **List own orders** | `GET /api/v1/users/me/orders` | ✅ | same |
| **View one order** | `GET /api/v1/users/me/orders/:orderNumber` | ✅ | same |
| See order status | `status` field on order responses | 🟡 | Implemented, but the only status that exists is `placed` — see §6 |
| Guest checkout | — | 🔵 | Deliberately not supported; every route requires a verified token |
| Pay for an order | — | 🔵 | Not implemented |
| See shipping / tracking | — | 🔵 | Not implemented |
| See tax / GST on an order | — | 🔵 | Not implemented |
| Download an invoice | — | 🔵 | Not implemented |
| Cancel an order | — | 🔵 | Not implemented |
| Return / refund | — | 🔵 | Not implemented |
| Product reviews | — | 🔵 | Not implemented |
| Wishlist | — | 🔵 | Not implemented |
| Order confirmation email / notification | — | 🔵 | Not implemented (no consumers — see §5) |

### What a customer can actually do today

Register, log in, stay logged in via refresh tokens, log out, view and edit their profile, change their password, browse/search/price-filter a published catalogue, keep an address book, build a cart across sessions, apply and remove a coupon code, and **complete a checkout that produces a real, immutable order they can list and re-read by order number**.

What they cannot do: pay for it, be shipped it, be taxed on it, be invoiced for it, cancel it, return it, or be notified about it.

---

## 4. Admin / Staff Functionality

### 4a. Backend Admin/Staff APIs — implemented

14 distinct `/admin/*` route paths, all behind `requireAuth` + `requireScope('staff')`.

| Function | API / Area | Status | Verified By |
|---|---|---|---|
| Staff authentication | shared `/auth/login` + `is_staff` flag | ✅ | `scope.integration.test.ts` (19 tests) |
| Staff authorization guard | `requireScope('staff')` → 403 for customers | ✅ | same file |
| Create product | `POST /admin/products` | ✅ | `create-product.integration.test.ts` (28) |
| List products (all statuses, paginated) | `GET /admin/products` | ✅ | `admin-product-list.integration.test.ts` (25) |
| Read product (any status) | `GET /admin/products/:slug` | ✅ | `admin-product-read.integration.test.ts` (15) |
| Update product | `PATCH /admin/products/:slug` | ✅ | `update-product.integration.test.ts` (28) |
| Publish product | `POST /admin/products/:slug/publish` | ✅ | `product-lifecycle.integration.test.ts` (26) |
| Archive product | `POST /admin/products/:slug/archive` | ✅ | same file |
| Soft-delete product | `DELETE /admin/products/:slug` | ✅ | `delete-product.integration.test.ts` (28) |
| Create SKU | `POST /admin/products/:slug/skus` | ✅ | `sku.integration.test.ts` (64) |
| List SKUs | `GET /admin/products/:slug/skus` | ✅ | same file |
| Update SKU (incl. price, activation) | `PATCH /admin/skus/:code` | ✅ | same file |
| Delete SKU | `DELETE /admin/skus/:code` | ✅ | same file |
| Create / list variant options | `POST`/`GET /admin/products/:slug/options` | ✅ | `options.integration.test.ts` (91) |
| Update / delete option | `PATCH`/`DELETE /admin/options/:id` | ✅ | same file |
| Add / update / delete option values | `/admin/options/:id/values`, `/admin/option-values/:id` | ✅ | same file |
| Assign option combination to SKU | `PUT /admin/skus/:code/options` | ✅ | same file |
| View stock across store | `GET /admin/inventory` | ✅ | `inventory.integration.test.ts` (68) |
| Adjust stock | `POST /admin/inventory/adjustments` | ✅ | same file |
| View stock ledger history | `GET /admin/inventory/:skuCode/history` | ✅ | same file |
| Create promotion | `POST /admin/promotions` | ✅ | `promotions.integration.test.ts` (68) |
| List / read promotion | `GET /admin/promotions`, `GET /admin/promotions/:code` | ✅ | same file |
| Update promotion | `PATCH /admin/promotions/:code` | ✅ | same file |
| Soft-delete promotion | `DELETE /admin/promotions/:code` | ✅ | same file |
| **Order management (staff)** | — | 🔵 | **No admin order endpoints exist.** Verified: zero `/admin/order*` routes in source; `GET /admin/orders` returned 404 in the live smoke run |
| Reporting / analytics | — | 🔵 | No reporting, analytics or dashboard endpoints exist |
| Customer administration | — | 🔵 | No staff endpoints for managing customer accounts |
| Store / tenant administration | — | 🔵 | `store` and `store_setting` tables exist; no admin CRUD endpoints |

### 4b. Admin Dashboard Frontend

**Status: 🔵 DOES NOT EXIST.**

Mechanically verified during this audit:

- No `web/`, `frontend/`, `admin/`, `ui/`, `client/` or `dashboard/` directory anywhere in the repository.
- **Zero** `.tsx`, `.jsx`, `.vue` or `.svelte` files in the repository.
- No React, Vue, Next.js, Svelte, Angular, Vite or Tailwind dependency in `package.json` (only `vitest` and `@vitest/coverage-v8` matched a UI-framework name search, both test tooling).
- The only served HTML is Swagger UI at `/docs`, which is API reference documentation, not an admin dashboard.

**The `/admin/*` routes are backend JSON APIs. They must not be described to stakeholders as an "Admin Dashboard".** Any dashboard would be a separate frontend project that has not been started.

---

## 5. Feature Area Audit

| Area | Status | Evidence |
|---|---|---|
| Identity & access | ✅ Complete | 11 test files; registration, login, logout, refresh rotation with reuse detection, profile, password change, staff scopes |
| Product catalogue | ✅ Complete | Create/read/update/publish/archive/soft-delete, public list, search, price filter |
| SKU / variants | ✅ Complete | CRUD, pricing, activation, uniqueness, product relationship |
| Variant options | ✅ Complete | Options, values, SKU combinations, uniqueness, limits, deletion protection |
| Inventory | 🟡 Partial | `stock_item` (`on_hand`, `reserved`, `available` as a generated column `on_hand - reserved`), append-only `stock_ledger`, manual adjustments, atomic updates. **`reserved` is never written** — ledger reasons are restricted by CHECK to `manual_increase`, `manual_decrease`, `correction` only. No reservation or allocation |
| Addresses | ✅ Complete | Full CRUD, user+store ownership, validation, soft delete |
| Cart | ✅ Complete | Get/create, set quantity, remove, clear, totals, purchasability, one active cart per customer, row-level locking |
| Promotions | 🟡 Partial | Full admin CRUD, coupon codes, percentage and fixed-amount discounts, minimum subtotal, start/end dates, active flag, apply/remove/replace on cart, discount calculation. **No redemption or usage tracking** — the `promotion` table has no usage-count or max-redemption column |
| **Checkout / Orders** | ✅ Complete for its defined scope | See §6 |
| Payment | 🔵 Not implemented | No payment table, route, service or gateway integration. `razorpay` appears only in decision commentary as the deferred Phase 3 choice |
| Shipping | 🔵 Not implemented | No shipment/carrier/tracking table, route or service |
| GST / Tax | 🔵 Not implemented | No tax column, table, route or rate anywhere. All mentions are documented statements of non-scope |
| Invoice | 🔵 Not implemented | No invoice table, numbering, PDF or IRN |
| Returns / refunds | 🔵 Not implemented | No return, RMA or credit-note table or route |
| Domain events | ✅ Infrastructure complete | Transactional outbox (`outbox_event`, `processed_event`), dispatcher, publisher, BullMQ transport, retry/backoff, leader lock. 22 event types emitted |
| Event consumers | 🔵 None | The handler registry defaults to `{}` (`src/container.ts:343`). Infrastructure is proven by its own tests; **no business consumer subscribes to any event** |
| Audit | ✅ Complete | `audit_log`, append-only, FK to actor, actor taken only from the verified token |
| Notifications | 🔵 Not implemented | No email/SMS/WhatsApp sending. No notification consumer |
| Reviews | 🔵 Not implemented | No table or route |
| Wishlist | 🔵 Not implemented | No table or route; zero mentions in source |
| Reporting / analytics | 🔵 Not implemented | No endpoints |
| Admin Dashboard UI | 🔵 Not implemented | See §4b |

---

## 6. Checkout / Orders — Detailed Verification

This is the newest work, so it is reported against evidence rather than plan.

**It is implemented.** Three tables (`order`, `order_line`, `order_status_history`), three endpoints, a dedicated service, repository, DTO and event module, and a 90-test integration suite.

| Requirement | Status | Evidence |
|---|---|---|
| Checkout endpoint | ✅ | `POST /api/v1/users/me/checkout` |
| Authenticated only | ✅ | `auth` middleware first in the chain; `order.user_id` is NOT NULL |
| Address selection | ✅ | Body is exactly `{ addressId }`, `z.strictObject` |
| Cart validation | ✅ | Empty cart → 422 `CHECKOUT_CART_EMPTY` |
| Unpurchasable SKU rejection | ✅ | Whole checkout refused with 422 naming the SKU codes; no partial order |
| Promotion re-evaluation | ✅ | Re-priced inside the transaction at checkout time |
| Discount allocation | ✅ | Largest-remainder allocation across lines; header discount derived as the sum of allocated line shares |
| Order creation | ✅ | Single transaction |
| Order number generation | ✅ | `ORD-YYYYMMDD-XXXXXX`, server-side, collision-retried, unique per store, no row-count leakage |
| Order lines | ✅ | PK `(order_id, sku_id)` |
| Product/SKU snapshots | ✅ | `sku_code`, `sku_name`, `product_name`, `unit_price`, `line_total`, `discount_amount` frozen onto the line |
| Address snapshot | ✅ | Nine `ship_*` columns, plus a RESTRICT foreign key |
| Promotion snapshot | ✅ | `promotion_code` + `promotion_name`, all-or-nothing via CHECK |
| Order status | 🟡 | Implemented but **single-valued**: `placed` is the only permitted status. No confirm/ship/deliver/cancel transitions exist yet |
| Order status history | ✅ | Append-only `order_status_history`; initial row `NULL → placed`; no `updated_at`, no `deleted_at` |
| Order history endpoint | ✅ | `GET /users/me/orders`, paginated, newest first |
| Order detail endpoint | ✅ | `GET /users/me/orders/:orderNumber` |
| Idempotency | ✅ | Required `Idempotency-Key` header; replay returns the original status and body with `Idempotent-Replay: true` |
| Cart locking | ✅ | `SELECT … FOR UPDATE` on the cart row; three independent defences behind `uq_order_cart` |
| Transaction behaviour | ✅ | One transaction; `idempotency.complete()` called inside it |
| **Inventory interaction** | ⚠️ **None, by design** | Checkout checks no stock, reserves nothing and decrements nothing. **Consequence: an order can be placed for stock that is not there.** This is a recorded, accepted deferral, not a defect — but it is a real business limitation today |
| **Promotion redemption** | ⚠️ **None, by design** | Ordering with a coupon consumes nothing; a coupon has no usage limit to consume |

### Live smoke evidence (earlier today, not re-run during this audit)

A 194-check live HTTP smoke test against the real server and real Docker PostgreSQL passed **194/194** earlier today, covering the full customer journey, snapshot immutability under catalogue/address/promotion mutation and deletion, RESTRICT key protection, cross-user idempotency isolation, 8-way concurrent checkout yielding exactly one order, inventory tables untouched, audit written, outbox free of order events, and OpenAPI paths present.

**It was not re-executed for this report, because it writes and then deletes records in the development database, and this audit was instructed not to change the database.** The result above is prior evidence from today, not a claim about this audit run.

---

## 7. Test & Quality Results

All figures below come from the commands logged in §14, executed during this audit.

### Automated test suite — `pnpm test` (Vitest)

```
Test Files  50 passed (50)
Tests       1449 passed (1449)
Duration    161.48s
Exit status 0
```

- **Test files: 50**
- **Tests: 1,449**
- **Passed: 1,449**
- **Failed: 0**
- **Skipped: 0**

**Full automated verification completed with 0 failing tests.**

| Test / Check | Total | Passed | Failed | Skipped | Status |
|---|---:|---:|---:|---:|---|
| All automated tests (`pnpm test`) | 1,449 | 1,449 | 0 | 0 | PASS |
| Test files | 50 | 50 | 0 | 0 | PASS |
| Integration tests (40 files, DB-backed via Testcontainers) | included above | — | 0 | 0 | PASS |
| Pure unit tests (10 files) | included above | — | 0 | 0 | PASS |
| API / HTTP tests (6 files under `src/http/__tests__`) | included above | — | 0 | 0 | PASS |
| Database / constraint tests | included above | — | 0 | 0 | PASS |
| Concurrency tests (27 files exercise concurrent paths) | included above | — | 0 | 0 | PASS |
| OpenAPI drift tests (`docs.integration.test.ts`, 10 cases) | included above | — | 0 | 0 | PASS |
| Custom ESLint rule tests (2 files under `tests/lint-rules`) | included above | — | 0 | 0 | PASS |
| Mutation tests | — | — | — | — | **NOT RUN** (see §9) |
| Live HTTP smoke test | 194 | 194 | 0 | 0 | PASS — **prior run today**, not re-run in this audit (writes to the database) |

**Note on counting:** a static count of top-of-line `it(`/`test(` declarations gives **1,410**. Vitest reports **1,449** because some cases are generated inside loops. The runner's 1,449 is the authoritative figure.

### Test suite composition

- 40 integration test files (real PostgreSQL via Testcontainers)
- 10 pure unit test files
- Largest suites: variant options 91, **orders 90**, cart-promotions 70, promotions 68, inventory 68, SKU 64, cart 63, addresses 53

---

## 8. Test Failure Audit

**No test failures.** `pnpm test` exited 0 with 1,449 passed, 0 failed, 0 skipped. There is no `### Failed Tests` section because there are no failures to report.

### Known flaky test (did not fire in this run)

| Item | Detail |
|---|---|
| Test | Idempotency "release on failure" race, introduced in Increment 23 |
| Nature | Pre-existing, environmental/timing |
| Status in this run | **Did not fire.** Suite was green |
| History | Did not fire in Increments 28, 29 or 30 either |
| Action | Deliberately never fixed, under a standing instruction not to modify unrelated code to make it pass |
| Blocks green? | No — it did not occur in this run |

### Benign log noise

The test log contains one `redis_client_error: write ECONNABORTED` entry emitted during teardown of the Redis-backed suites. It is a shutdown-ordering log line, not an assertion failure; all 50 files and 1,449 tests passed. Recorded here for completeness rather than hidden.

### Environmental incident earlier today (resolved, not a code defect)

The host disk (`C:`) reached **0 bytes free** of 182 GB, which hung the Docker daemon and caused two test runs to abort in container startup (`Hook timed out in 180000ms`, 96 tests skipped). This was infrastructure, not code. After reclaiming space and restarting Docker, the suite ran clean. **`C:` currently has only ~1.9 GB free and will recur** — see §15 Blockers.

---

## 9. Mutation Testing

**Mutation testing was not executed during this verification run.**

Reasons, stated plainly:

1. **No mutation testing tool is installed or configured in this repository.** `package.json` contains no Stryker or equivalent (16 runtime + 20 dev dependencies audited; none is a mutation testing framework), and there is no mutation script in `package.json`.
2. Mutation testing in this project has been performed by **ad-hoc probe scripts that deliberately edit source files and migrations, then revert them**. Running that today would violate this report's explicit instruction not to modify source code, tests or migrations.

No mutation score, mutant count, kill count, survivor count or timeout count is reported for this run, because none was produced.

### Historical mutation results (from `docs/DECISIONS.md`, prior work — not this run)

Each increment's section in `docs/DECISIONS.md` carries a "Mutation verification" subsection. The most recent, §43 for Increment 30 (checkout/orders), records:

- **58 probes** — 40 against source, 18 against the migration
- **54 killed on the first pass**
- **4 survivors**, all classified: 3 provable equivalences, and 2 real test weaknesses that were then fixed with focused tests (one probe overlapped categories)
- A recurring finding is documented: a constraint test can pass because a *different* constraint fired first; the standing rule is that a test asserting a database refusal must assert the constraint **name** and isolate the row

These are prior-work figures recorded in project documentation. They were **not** re-verified today.

---

## 10. Engineering Quality Checks

| Check | Result | Exit Status |
|---|---|---|
| Prettier format check (`pnpm format:check`) | PASS | 0 |
| ESLint (`pnpm lint`) | PASS | 0 |
| TypeScript typecheck (`pnpm typecheck` — 3 project configs) | PASS | 0 |
| dependency-cruiser (`pnpm depcruise`) | PASS — no violations, 133 modules / 535 dependencies | 0 |
| Production build (`pnpm build`) | PASS | 0 |
| Full test suite (`pnpm test`) | PASS — 1,449/1,449 | 0 |
| OpenAPI drift (inside the test suite) | PASS — 10 cases | 0 |
| Schema drift (`pnpm db:generate`) | PASS — "No schema changes, nothing to migrate"; migration file count unchanged at 14 | 0 |
| Architecture rules | PASS — 11 dependency-cruiser rules, 2 custom ESLint rules, all enforced as failing checks | 0 |
| Mutation testing | NOT RUN | — |
| Live HTTP smoke test | NOT RUN in this audit (passed 194/194 earlier today) | — |

TypeScript strictness is enforced across three separate project configs (`tsconfig.json`, `tsconfig.test.json`, `tsconfig.tools.json`), all clean.

---

## 11. Database Status

All figures read directly from the running PostgreSQL 16 instance during this audit.

| Metric | Value | Verified |
|---|---|---|
| Migration files in repository | **14** | `ls src/db/migrations/*.sql` |
| Migrations applied in database | **14** | `drizzle.__drizzle_migrations` |
| Tables declared in schema code | **24** | `src/db/schema/*.ts` |
| Tables present in database | **24** | `information_schema.tables` |
| Indexes | **77** | `pg_indexes` |
| Unique indexes | **53** | `pg_indexes` |
| Primary keys | **24** | `pg_constraint` |
| Foreign keys | **45** | `pg_constraint` |
| — of which **composite** (tenant-enforcing) | **21** | `cardinality(conkey) > 1` |
| CHECK constraints | **34** | `pg_constraint` |
| Schema drift | **None** | `pnpm db:generate` → "No schema changes, nothing to migrate" |

### Tables

`address`, `app_user`, `audit_log`, `cart`, `cart_line`, `cart_promotion`, `feature_flag`, `idempotency_key`, `order`, `order_line`, `order_status_history`, `outbox_event`, `processed_event`, `product`, `product_option`, `product_option_value`, `promotion`, `refresh_session`, `sku`, `sku_option_value`, `stock_item`, `stock_ledger`, `store`, `store_setting`

### Tenant isolation

**22 of 24 tables carry `store_id`.** The two that do not are correctly global: `store` itself, and `processed_event` (event-dispatch bookkeeping). Tenancy is enforced structurally by **21 composite foreign keys** — a cross-store reference is unrepresentable at the database level, not merely rejected by application code.

### Soft-delete strategy

Soft delete (`deleted_at`) on **7 tables**: `address`, `app_user`, `product`, `product_option`, `product_option_value`, `promotion`, `sku`. Consistent with the recorded rule "anonymise, never delete" for records with legal retention needs. **`order` deliberately has no `deleted_at`** — an order cannot be soft-deleted.

### Append-only history

**6 tables have no `updated_at` and are append-only**: `audit_log`, `order_status_history`, `outbox_event`, `processed_event`, `sku_option_value`, `stock_ledger`. Order status history and the stock ledger are the two business-critical ones — no `UPDATE` can rewrite the past.

### Fresh-database migration

**VERIFIED — earlier today, not re-run during this audit.** The full 14-migration chain was applied to a newly created empty database, producing 24 tables, 14 recorded migrations, 3 order tables, 5 order indexes and 8 order foreign keys, with the `idempotency_key.user_id` column NOT NULL. The temporary database was then dropped. This audit did not repeat it, because creating and dropping a database is a database change.

---

## 12. API Coverage

**53 concrete endpoints** are registered (52 `router.*` declarations, one of which is a helper that expands into both `publish` and `archive`). **52 operations are documented in OpenAPI** across 34 documented paths; the single undocumented route is `GET /docs.json` itself, which serves the specification.

| Group | Endpoints | Auth required | Authorization | Validation | Test coverage |
|---|---:|---|---|---|---|
| Authentication | 4 | No (these establish it) | — | Zod strict | 5 files |
| Customer profile | 3 | Yes | Own record only | Zod strict | 3 files |
| Catalogue (public) | 2 | No | Published products only | Zod strict query | 5 files |
| Catalogue (admin) | 8 | Yes | `staff` scope | Zod strict | 7 files |
| SKU (admin) | 5 | Yes | `staff` scope | Zod strict | 1 file (64 tests) |
| Variant options (admin) | 6 | Yes | `staff` scope | Zod strict | 1 file (91 tests) |
| Inventory (admin) | 3 | Yes | `staff` scope | Zod strict | 1 file (68 tests) |
| Addresses | 5 | Yes | Own records only | Zod strict | 1 file (53 tests) |
| Cart | 6 | Yes | Own cart only | Zod strict | 2 files (133 tests) |
| Promotions (admin) | 5 | Yes | `staff` scope | Zod strict | 1 file (68 tests) |
| Checkout | 1 | Yes | Own cart + own address | Zod `strictObject`, one field | 1 file (90 tests) |
| Orders (customer) | 2 | Yes | Own orders only | Zod strict | same file |
| **Orders (admin/staff)** | **0** | — | — | — | **Not implemented** |
| Health / docs | 3 | No | — | — | 2 files |

The OpenAPI drift guard asserts that **every documented path and method actually resolves** (no documented route 404s). It is one-directional: it would not catch a route that exists but was never documented. The current counts (53 registered vs 52 documented, difference accounted for) indicate no such gap today.

---

## 13. Architecture & Security

| Control | Status | Evidence |
|---|---|---|
| Store/tenant isolation | ✅ | 22/24 tables carry `store_id`; **21 composite foreign keys** make cross-store references unrepresentable |
| User isolation | ✅ | `userId` and `storeId` are read only from the verified token; another user's cart/order/address behaves as nonexistent (404, identical envelope to a genuinely unknown record) |
| Staff authorization | ✅ | `requireScope('staff')` on all 14 admin paths; customers receive 403 |
| Strict input validation | ✅ | Zod `strictObject` throughout; unknown fields are rejected with a 400 naming the field, never silently ignored |
| No client-supplied identity | ✅ | Audited during this report: **no request body, query or path parameter anywhere in the codebase supplies a user id.** Every occurrence of `params.userId` is an internal service/repository argument |
| Module boundaries | ✅ | 11 dependency-cruiser rules, 0 violations across 133 modules |
| ESLint architecture rules | ✅ | 2 custom rules (`no-money-arithmetic`, `no-relational-api-in-inventory`) plus 5 mandated safety rules, all enforced as failing checks and covered by their own tests |
| Transaction handling | ✅ | Checkout is one transaction; cart mutations take a row lock; nested transactions use savepoints |
| Money precision | ✅ | `NUMERIC(19,4)` in the database, branded `Money` type + decimal.js + ROUND_HALF_UP in code, and a custom ESLint rule forbidding arithmetic on money outside `src/shared/money.ts` |
| Database constraints | ✅ | 34 CHECK constraints, 53 unique indexes, 45 foreign keys — invariants held by the database, not only by application code |
| Audit logging | ✅ | Append-only `audit_log`, actor from the token only, FK to the actor |
| Append-only history | ✅ | 6 append-only tables including `order_status_history` and `stock_ledger` |
| Snapshotting | ✅ | Order lines and shipping address are fully snapshotted; verified live that renaming, repricing, deactivating, archiving and deleting the source catalogue/address/promotion leaves a placed order byte-identical |

### Checkout idempotency scope — specifically verified

All three required properties hold:

1. **The authenticated user is part of the idempotency scope.** The database unique index is `uq_idempotency_key ON idempotency_key (store_id, user_id, key, endpoint)`, read directly from `pg_indexes` during this audit. `user_id` is NOT NULL and carries a composite foreign key to `(app_user.id, app_user.store_id)`.
2. **Authentication happens before the user-scoped idempotency claim.** The middleware chain on `POST /users/me/checkout` is `auth → requireIdempotency → validate → handler`. The idempotency middleware obtains the user via `requireUser(req).id` (`src/http/middleware/idempotency.ts:141`) and **fails loudly with a 500** if mounted without a preceding authentication guard, rather than silently falling back to an unscoped key.
3. **No client-supplied user ID is trusted.** Confirmed by codebase-wide search: no `body.userId`, `query.userId` or `params.userId` read from an HTTP request exists anywhere.

**Assessment: ✅ CORRECT — no security issue, no blocker.**

For context: this was a genuine cross-user scope defect in the shared idempotency infrastructure, identified and fixed during Increment 30. The live smoke run earlier today confirmed behaviourally that two different users presenting the *same* `Idempotency-Key` value each execute their own checkout and each retain their own replay.

---

## 14. Work Completed So Far

| Increment | Feature | Status | Tests / Evidence |
|---|---|---|---|
| Phase 0 (steps 1–7) | Foundation, migrations, transactional outbox, HTTP scaffolding, composition root, process entry points (`api`/`worker`/`scheduler`) | Complete | `container`, `lifecycle`, `process-lifecycle`, `outbox`, `bullmq`, `retry-delay`, `leader-lock` test files; §10–§14 |
| 1 | Customer registration | Complete | `register.integration.test.ts` (22); §15 |
| 2 | Token foundation (RS256 access tokens) | Complete | `tokens.test.ts` (30); §16 |
| 3 | Login | Complete | `login.integration.test.ts` (35), `login-collision` (5); §17 |
| 4 | Authentication rate limiting | Complete | `rate-limit.integration.test.ts`, `rate-limiter.integration.test.ts`; §18 |
| 5 | Refresh rotation + reuse detection | Complete | `refresh.integration.test.ts` (24), `refresh-token.test.ts` (10); §19 |
| 6 | Logout + authentication middleware | Complete | `logout.integration.test.ts` (18); §20 |
| 8 | `GET /users/me` | Complete | `current-user.integration.test.ts` (18); §21 |
| 9 | Scope-based authorization | Complete | `scope.integration.test.ts` (19); §22 |
| 10 | Architecture enforcement | Complete | 11 depcruise rules + 2 custom ESLint rules with tests; §23 |
| 11 | Product foundation | Complete | `create-product.integration.test.ts` (28); §24 |
| 12 | Public product read | Complete | `public-product.integration.test.ts` (22); §25 |
| 13 | Product lifecycle (publish/archive) | Complete | `product-lifecycle.integration.test.ts` (26); §26 |
| 14 | Admin product read | Complete | `admin-product-read.integration.test.ts` (15); §27 |
| 15 | Admin product listing + pagination | Complete | `admin-product-list.integration.test.ts` (25); §28 |
| 16 | Admin product editing | Complete | `update-product.integration.test.ts` (28); §29 |
| 17 | Admin product deletion | Complete | `delete-product.integration.test.ts` (28); §30 |
| 18 | Public product listing | Complete | `public-product-list.integration.test.ts` (23); §31 |
| 19 | Public product search | Complete | `public-product-search.integration.test.ts` (33); §32 |
| 20 | Public product price filtering | Complete | `public-product-price-filter.integration.test.ts` (35); §33 |
| 21 | Password change + profile update | Complete | `change-password` (30), `update-profile` (31); §34 |
| 22 | Domain events + audit producers | Complete | `product-events.integration.test.ts`; §35 |
| 23 | Idempotency, Money lint rule, leader-lock flake | Complete | `idempotency.integration.test.ts` (33); §36 |
| 24 | SKU / variant foundation | Complete | `sku.integration.test.ts` (64); §37 |
| 25 | Option grid | Complete | `options.integration.test.ts` (91); §38 |
| 26 | Inventory | Complete for its scope | `inventory.integration.test.ts` (68); §39 |
| 27 | Customer address book | Complete | `addresses.integration.test.ts` (53); §40 |
| 28 | Shopping cart | Complete | `cart.integration.test.ts` (63); §41 |
| 29 | Coupon-code promotions | Complete | `promotions` (68), `cart-promotions` (70); §42 |
| **30** | **Checkout and orders** | **Complete for its scope** | `orders.integration.test.ts` (90 declared); §43; 194/194 live smoke; fresh-DB migration verified |

**29 numbered increments delivered, plus Phase 0.** Every increment has a corresponding section in `docs/DECISIONS.md` (43 sections, 3,141 lines) and at least one integration test file.

---

## 15. Current Overall Status

### What has been built

A multi-tenant e-commerce **backend API** — 53 endpoints, 24 database tables, 14 migrations, 8 domain modules, 1,449 automated tests. Node 22 / TypeScript strict / Express 5 / PostgreSQL 16 / Drizzle ORM / Redis / Zod, as a structured modular monolith with machine-enforced module boundaries.

### What is working today

Everything through order placement. Concretely: identity and sessions, the product catalogue with variants and SKUs, public browsing with search and price filtering, manual inventory tracking, the customer address book, the shopping cart, coupon promotions, and checkout producing immutable snapshotted orders.

### What customers can do today

Register → log in → browse/search/filter → build a cart → apply a coupon → **check out and place an order** → list and re-read their orders. They cannot pay, be shipped, be taxed, be invoiced, cancel, return, or be notified.

### What staff/admin can do today

Manage products (full lifecycle), variant options, SKUs and pricing, stock levels with an append-only ledger, and promotions — all via authenticated JSON APIs. **They cannot manage orders**, and **there is no dashboard UI**.

### How much has been verified

- **1,449 of 1,449 automated tests passing**, 50 of 50 files, exit status 0
- **All 9 static quality gates passing** (format, lint, typecheck ×3 configs, depcruise, build, schema drift, OpenAPI drift, architecture rules)
- Fresh-database migration verified earlier today; 194/194 live HTTP smoke verified earlier today
- Mutation testing **not run** in this audit and not installed as a project tool

### Are all tests passing?

**Yes. Full automated verification completed with 0 failing tests.**

### Are there blockers?

**One, and it is environmental, not code:**

🔴 **Host disk exhaustion.** `C:` reached **0 bytes free** of 182 GB today, which hung the Docker daemon and aborted two test runs in container startup. After reclaiming space it is at **~1.9 GB free — this will recur and will block all integration testing when it does**, because the entire test suite depends on Docker/Testcontainers. Largest consumers: `AppData\Local` 38.9 GB, `C:\Windows` 32.9 GB, `Program Files` 27.4 GB, `AppData\Roaming` 8.2 GB. This needs a decision about what to free or whether to move Docker's data root.

**No code blockers. No security blockers. No failing tests.**

### Two accepted business limitations to be aware of

These are recorded, deliberate deferrals, not defects — but they matter commercially and should not surprise anyone:

1. **Checkout does not touch inventory.** An order can be placed for stock that is not there. Reservation/allocation is the next inventory increment.
2. **Coupons have no usage limits and no redemption tracking.** A coupon can be used an unlimited number of times by any number of customers.

---

## 16. Remaining Development Work

### Not Started

- **Payment** — gateway integration (Razorpay recorded as the intended primary for the India market), authorisation, capture, webhooks, retries, COD
- **Shipping** — rates, carriers, service levels, shipments, tracking, fulfilment
- **GST / Tax** — rates, HSN/SAC codes, CGST/SGST/IGST split, place of supply, GSTIN, e-invoicing. *No tax rates or rules have been invented anywhere in the codebase*
- **Invoicing** — invoice numbering, series, PDF generation, IRN
- **Returns / refunds** — returns, RMAs, credit notes, restocking
- **Order cancellation**
- **Admin/staff order management APIs** — no `/admin/orders` surface exists
- **Admin Dashboard frontend** — a separate UI project, not started
- **Storefront frontend** — not started
- **Reporting / analytics APIs**
- **Notifications** — email/SMS/WhatsApp delivery and the consumers to trigger them
- **Reviews / ratings**
- **Wishlist**
- **Customer administration APIs** for staff
- **Store / tenant administration APIs**

### Partially Implemented

- **Inventory** — tracking, adjustments and an append-only ledger work; `reserved` and `available` columns exist (`available` is generated as `on_hand - reserved`) but **`reserved` is never written**. Reservation and allocation remain to be built, and the ledger's reason CHECK will need widening beyond the current three manual reasons
- **Promotions** — full CRUD and cart application work; **redemption and usage-limit tracking are absent** (no usage-count or max-redemption column on `promotion`)
- **Order lifecycle** — orders and append-only status history exist, but `placed` is the only status. Confirm/ship/deliver/cancel transitions remain
- **Event consumers** — the outbox, dispatcher, transport, retry and leader-lock infrastructure is complete and tested, but the handler registry is empty. **22 event types are emitted and nothing consumes any of them**

### Deferred By Scope (recorded decisions)

- **Guest checkout** — `docs/DECISIONS.md` §7 lists it as a Phase 3 open item ("allowed, as a store setting"); Increment 30 implemented authenticated-only checkout and recorded the divergence explicitly
- **Default shipping address** — deferred in Increment 27; checkout therefore requires an explicit `addressId`
- **SKU code generation** — merchant-supplied only; no generation subsystem (roadmap item D3)
- **`expectedTotal` / client-side price confirmation at checkout** — deliberately not added, to avoid a client computing money
- **Order events** — `order.placed` is written to the audit log but deliberately **not** published as a domain event, on the standing rule that an event with no consumer is a guess at one

### Blocked

- **Nothing is blocked by code.**
- **All integration testing is at environmental risk** from the host disk situation described in §15. This is the only item requiring a decision before development resumes.

---

## 17. Manager Summary

- **Backend delivered through Phase 3 increment 30.** Phases 0, 1 and 2 are complete; Phase 3 has begun with checkout and orders. That is **3 of the 9 planned phases fully complete (33%)**. No increment-level percentage is quoted because the repository does not define the total number of planned increments.
- **Automated verification: 1,449 tests across 50 files — 1,449 passed, 0 failed, 0 skipped, exit status 0.** Full automated verification completed with 0 failing tests.
- **All static quality gates pass:** Prettier, ESLint, TypeScript typecheck (3 configs), dependency-cruiser (0 violations across 133 modules), production build, schema-drift check, and the OpenAPI drift guard.
- **Customers can complete a full purchase journey up to order placement** — register, log in, browse/search/filter, manage addresses, build a cart, apply a coupon, check out, and view their order history. They cannot yet pay, receive shipping, see tax, or get an invoice.
- **Staff have working APIs** for products, variant options, SKUs, pricing, inventory and promotions. **There are no staff order-management endpoints**, and **no Admin Dashboard UI exists** — the `/admin/*` routes are backend JSON APIs, and the repository contains zero frontend files.
- **Checkout is real and hardened, not scaffolding:** immutable product/address/promotion snapshots, server-generated order numbers, append-only status history, single-transaction writes, cart row locking (8 concurrent checkouts produce exactly one order), and user-scoped idempotency. A 194-check live smoke test passed 194/194 earlier today.
- **A cross-user idempotency security defect was found and fixed** during this increment; the fix is verified at the database level, in the middleware chain, and behaviourally. No client-supplied user identity is trusted anywhere in the codebase.
- **Two accepted business limitations to note:** checkout performs no inventory check or reservation, so an order can be placed for stock that is not there; and coupons have no usage limits or redemption tracking. Both are deliberate, recorded deferrals scheduled for later increments.
- **Payment, shipping, GST/tax, invoicing, returns/refunds, notifications, reviews, wishlist, reporting, admin order management and all frontend work remain outstanding.**
- **One blocker, environmental:** the development machine's `C:` drive filled to 0 bytes today and now has ~1.9 GB free. It hung Docker and aborted two test runs before space was reclaimed. Since the whole integration suite depends on Docker, this will block testing again and needs a decision on what to free or relocate.

---

## 18. Commands Executed

Every command below was run during the generation of this report. Nothing else was executed against the project, and no command modified source code, tests, migrations, configuration or database data.

| Command | Result | Exit Status |
|---|---|---|
| `pnpm format:check` | PASS — all files match Prettier style | 0 |
| `pnpm lint` | PASS — no ESLint errors | 0 |
| `pnpm typecheck` | PASS — 3 project configs clean | 0 |
| `pnpm depcruise` | PASS — no violations, 133 modules / 535 dependencies | 0 |
| `pnpm build` | PASS | 0 |
| `pnpm test` | PASS — 50 files, 1,449 tests, 0 failed, 0 skipped, 161.48s | 0 |
| `pnpm db:generate` | PASS — "No schema changes, nothing to migrate"; file count unchanged at 14 | 0 |
| `psql` read-only queries against `information_schema` / `pg_indexes` / `pg_constraint` / `drizzle.__drizzle_migrations` | Counts reported in §11 | 0 |
| `docker ps` | Postgres and Redis healthy | 0 |
| Repository inspection — `ls`, `find`, `grep`, `sed`, `node -e` over `package.json`, `src/`, `tests/`, `docs/`, `packages/`, route files, schema files, middleware, OpenAPI spec, ESLint and dependency-cruiser configs | Findings throughout this report | 0 |
| Host disk inspection (`Get-PSDrive`) | `C:` ~1.9 GB free — see §15 | 0 |

### Commands deliberately NOT executed

| Command | Why not |
|---|---|
| Mutation probe scripts | They edit source files and migrations; this audit was instructed not to modify code |
| Live HTTP smoke test | It writes and deletes records in the development database; this audit was instructed not to change the database. Result from earlier today (194/194) is reported as prior evidence |
| Fresh-database migration test | It creates and drops a database. Result from earlier today is reported as prior evidence |
| `pnpm db:migrate` | Not needed; the database is already at migration 14 and drift-free |

---

*Prepared by inspecting the repository on disk and executing the verification commands listed above. Where a result comes from earlier work today rather than this audit run, that is stated explicitly at the point of use.*
