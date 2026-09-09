# E-commerce Backend

A multi-tenant e-commerce API for the Indian market. One deployment serves many stores; every
table is keyed by store, so two brands can run side by side without ever seeing each other's data.

A shopper can register, browse a catalogue with variants, fill a cart, apply a coupon, check out,
pay (Razorpay or cash on delivery), cancel while still cancellable, and download an invoice.
Staff manage the catalogue, stock and promotions through authenticated JSON APIs.

**This is a backend only.** There is no storefront and no admin dashboard — the `/admin/*` routes
are JSON APIs, not a UI.

|               |                                                          |
| ------------- | -------------------------------------------------------- |
| **Endpoints** | 79 operations across 55 paths, all documented in OpenAPI |
| **Tests**     | 1,855 passing across 59 files                            |
| **Database**  | PostgreSQL 18.6 (Neon), 35 tables, 22 migrations         |
| **Language**  | TypeScript (strict, NodeNext) on Node 22                 |

---

## Contents

- [What works and what doesn't](#what-works-and-what-doesnt)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [The three processes](#the-three-processes)
- [Try it end to end](#try-it-end-to-end)
- [Becoming a staff user](#becoming-a-staff-user)
- [API reference](#api-reference)
- [Testing and quality gates](#testing-and-quality-gates)
- [Project structure](#project-structure)
- [How the code is organised](#how-the-code-is-organised)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

---

## What works and what doesn't

Read this before demoing anything. It is the honest version.

### Works, proven by tests and by hand

Registration and login (rotating refresh tokens with reuse detection) · password reset by email ·
product catalogue with option grids and per-variant SKUs · publish/archive lifecycle · public
browse, search and price filtering · manual stock tracking with an append-only ledger · address
book · cart with server-computed totals · coupon codes · checkout into an immutable order ·
**cash-on-delivery payment** · payment status · order cancellation · **branded HTML invoice** for
customers and for staff · **stock reservation at checkout** · **manual shipping and fulfilment**
(staff raise a shipment, ship it, mark it delivered; the customer sees carrier and tracking) ·
**GST** (configurable effective-dated rates, per-SKU HSN/tax class, CGST/SGST vs IGST by place of
supply, B2B/B2C, and an immutable tax snapshot on every order) · **numbered tax invoices**
(a sequential, gapless, financial-year-scoped series per store, with an HSN/rate-wise summary).

### Implemented but never run against the real provider

**Online payment.** The whole path is written and tested — initiate, receive the webhook, verify
the signature, mark the order paid — but **no Razorpay API keys have ever been supplied**, so
nothing here has exchanged a byte with Razorpay. With no keys configured the endpoint returns a
clean `503` rather than pretending. Call it "implemented and unit-proven", never "working", until
one real payment and one real webhook have been observed.

### Not built

No shipping provider, carrier API or calculated shipping rates (shipping is free and fulfilment is
manual) · no partial or multi-parcel shipments · **no e-invoicing** (invoices carry a statutory
number and an HSN summary, but no IRN, no acknowledgement number and no signed QR code — this
system is not registered with the Invoice Registration Portal) · no e-way bills · no credit or
debit notes · no invoice cancellation or amendment · no GSTR export · no refunds or returns · no
admin order list or payment visibility beyond the fulfilment queue · no staff-management endpoints
· no email verification · no product images · no payment retry · no guest checkout · no reporting.

### Three limitations that will bite you

1. **Checkout does not touch stock.** An item with 5 on hand still reads 5 after being bought.
   Two customers can buy the last unit and both orders succeed. Keep inventory buffers high.
2. **Coupons have no usage limits.** A code can be used unlimited times by unlimited customers.
3. **An abandoned online payment strands its order.** Nothing ever writes the `expired` payment
   state, because no expiry window was ever agreed — so a `pending` payment blocks both paying
   and cancelling, permanently.

---

## Tech stack

| Concern               | Choice                                     | Why                                                                    |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Language              | TypeScript, `strict`, NodeNext modules     | Compile-time guarantees on a money-handling API                        |
| Runtime               | Node 22                                    | Native `--env-file`, stable fetch                                      |
| HTTP                  | Express 5                                  | Async error propagation without a wrapper library                      |
| Database              | PostgreSQL + Drizzle ORM                   | SQL you can read; migrations are plain `.sql` files in the repo        |
| Money                 | `NUMERIC(19,4)` + decimal.js               | Never floats. A lint rule forbids arithmetic on money outside one file |
| Cache / locks / queue | Redis (ioredis) + BullMQ                   | Three logical databases: `/0` cache, `/1` locks, `/2` queue            |
| Validation            | Zod (`strictObject`)                       | Unknown fields are a `400`, never silently dropped                     |
| Auth                  | RS256 JWT via `jose`, argon2 for passwords | Asymmetric so verifiers need no signing key                            |
| Logging               | Pino                                       | Structured JSON, request-scoped ids                                    |
| Email                 | nodemailer behind a `Mailer` port          | Swappable; never logs message bodies                                   |
| Tests                 | Vitest + Testcontainers                    | Every integration test gets a real throwaway PostgreSQL                |
| Docs                  | swagger-ui-express                         | Served at `/docs` outside production                                   |

17 production dependencies. **There is deliberately no Razorpay SDK** — `src/razorpay/gateway.ts`
(351 lines) does it with `fetch` and `node:crypto`, and is the only file that speaks Razorpay's
HTTP API or knows its signature scheme. Elsewhere Razorpay appears only as a name: an env var, the
`provider` enum value on the `payment` table, the webhook route path, and one line of container
wiring. Swapping providers means writing a second adapter, not touching the payments module.

---

## Quick start

### Prerequisites

- **Node 22+** and **pnpm 10** (`corepack enable` will do it)
- **Docker** — for Redis, the mail catcher, and the test suite's throwaway databases
- A **PostgreSQL** database. The project currently points at hosted Neon; a local one is available
  behind a Compose profile if you prefer.

### 1. Install

```bash
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
```

Then edit `.env`. The three things you must set are `DATABASE_URL`, the two `JWT_*` keys, and the
three `REDIS_*` URLs. Generate the key pair with:

```bash
pnpm keys:generate
```

See [Environment variables](#environment-variables) for what each one does and what breaks without it.

### 3. Start the supporting services

```bash
docker compose up -d
```

That gives you **Redis** on host port `56379` and **Mailpit** (an SMTP catcher) on `1025`, with its
web inbox at **http://localhost:8025** — that is where password-reset emails land.

Want a local PostgreSQL instead of Neon?

```bash
docker compose --profile local-db up -d
# then set DATABASE_URL=postgres://ecom:ecom@localhost:55432/ecom
```

Host ports are deliberately unusual (`56379`, `55432`) because `6379` and `5432` are routinely
already taken.

### 4. Create the schema and the first store

```bash
pnpm db:migrate   # applies all 22 migrations
pnpm db:seed      # creates the store named by DEFAULT_STORE_SLUG
```

`db:seed` is required, not optional. Every request resolves a store, and with no store row the API
answers nothing.

### 5. Run it

```bash
pnpm dev          # API on http://localhost:8000
pnpm dev:worker   # background jobs — needed for password-reset email
```

Check it came up:

```bash
curl http://localhost:8000/health/ready
# {"status":"ok","checks":{"postgres":"ok","redis":"ok"}}
```

Then open **http://localhost:8000/docs** for the full interactive API reference.

---

## Environment variables

`src/config.ts` reads `process.env` **once**, validates it with Zod, and refuses to boot on
anything invalid. Nothing else in the codebase touches `process.env`, so a missing variable is a
startup error with a clear message rather than an `undefined` surfacing hours later.

### Required — the app will not start without these

| Variable                 | Example                                          | What it does                                                                                              |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | `postgresql://user:pass@host/db?sslmode=require` | Primary PostgreSQL connection                                                                             |
| `REDIS_CACHE_URL`        | `redis://localhost:56379/0`                      | Cache database                                                                                            |
| `REDIS_LOCK_URL`         | `redis://localhost:56379/1`                      | Idempotency keys and rate-limit counters                                                                  |
| `REDIS_QUEUE_URL`        | `redis://localhost:56379/2`                      | BullMQ job queue                                                                                          |
| `JWT_PRIVATE_KEY`        | PEM, newlines as `\n`                            | Signs access tokens (`pnpm keys:generate`)                                                                |
| `JWT_PUBLIC_KEY`         | PEM, newlines as `\n`                            | Verifies them                                                                                             |
| `JWT_ISSUER`             | `ecom-local`                                     | Token `iss` claim                                                                                         |
| `JWT_AUDIENCE`           | `ecom-storefront`                                | Token `aud` claim                                                                                         |
| `CORS_ALLOWED_ORIGINS`   | `http://localhost:3000`                          | Comma-separated allowlist. Refuses to boot with `*` in production                                         |
| `SMTP_HOST`              | `localhost`                                      | Outbound mail host                                                                                        |
| `S3_BUCKET`, `S3_REGION` | `ecom-dev`, `ap-south-1`                         | **Vestigial.** Nothing reads them, but `config.ts` requires them to boot. There is no file upload feature |

> **`REDIS_LOCK_URL` must point at a Redis with `noeviction`.** It holds idempotency keys, and
> evicting one of those is a duplicate charge, not a cache miss. The local Compose Redis shares one
> instance across all three databases for convenience; production must separate them.

### Needed for specific features

| Variable                  | Default                                | Feature it unblocks                                                                               |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `RAZORPAY_KEY_ID`         | —                                      | Online payment. Absent → `503` on `method: "online"`                                              |
| `RAZORPAY_KEY_SECRET`     | —                                      | Same                                                                                              |
| `RAZORPAY_WEBHOOK_SECRET` | —                                      | Webhook signature verification                                                                    |
| `SMTP_PORT`               | `1025`                                 | Mailpit's port locally; `587` for a real provider                                                 |
| `MAIL_FROM`               | `no-reply@localhost`                   | Sender address on password-reset email                                                            |
| `PASSWORD_RESET_URL_BASE` | `http://localhost:3000/reset-password` | Where the reset link points. **This is a frontend URL** — get it from whoever owns the storefront |

### Tunable, with sensible defaults

| Variable                         | Default       | Notes                                                |
| -------------------------------- | ------------- | ---------------------------------------------------- |
| `PORT`                           | `8000`        |                                                      |
| `NODE_ENV` / `ENVIRONMENT`       | `development` | `/docs` is not mounted when `ENVIRONMENT=production` |
| `DEFAULT_STORE_SLUG`             | `default`     | Which store a request resolves to                    |
| `DEFAULT_CURRENCY`               | `INR`         | One of `INR USD EUR GBP AED JPY`                     |
| `JWT_ACCESS_TTL_MINUTES`         | `15`          | Access tokens are short-lived by design              |
| `JWT_REFRESH_TTL_DAYS`           | `30`          |                                                      |
| `DATABASE_POOL_MAX`              | `10`          |                                                      |
| `DATABASE_STATEMENT_TIMEOUT_MS`  | `30000`       |                                                      |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60`          |                                                      |
| `AUTH_RATE_LIMIT_IP_MAX`         | `10`          | Login attempts per IP per window                     |
| `AUTH_RATE_LIMIT_EMAIL_MAX`      | `5`           | Per email address                                    |
| `AUTH_RATE_LIMIT_REFRESH_IP_MAX` | `60`          |                                                      |
| `OUTBOX_POLL_INTERVAL_MS`        | `1000`        | How often the dispatcher drains the outbox           |
| `OUTBOX_BATCH_SIZE`              | `100`         |                                                      |
| `LOG_LEVEL`                      | `info`        |                                                      |
| `LOG_FORMAT`                     | `json`        | Use `pretty` locally                                 |

---

## The three processes

| Command              | Process       | Responsibility                                                  |
| -------------------- | ------------- | --------------------------------------------------------------- |
| `pnpm dev`           | **API**       | Serves HTTP. Also drains the outbox, but runs no job handlers   |
| `pnpm dev:worker`    | **Worker**    | Runs job handlers — this is what actually sends the reset email |
| `pnpm dev:scheduler` | **Scheduler** | Recurring jobs. Nothing schedules work yet; it starts and idles |

For local development the API and worker are enough. `pnpm dev` and `pnpm dev:worker` both hot-reload.

Production equivalents are `pnpm build` then `pnpm start`, `pnpm start:worker`, `pnpm start:scheduler`.

---

## Try it end to end

A complete purchase, from empty database to downloaded invoice. Copy-pasteable, in order.

```bash
BASE=http://localhost:8000/api/v1
```

### 1. Register

```bash
curl -X POST "$BASE/auth/register" -H 'content-type: application/json' -d '{
  "email": "shopper@example.com",
  "password": "Str0ng!Passw0rd#2026",
  "firstName": "Priya",
  "lastName": "Kumari",
  "phone": "+919876543210"
}'
```

> **Two gotchas.** Registration returns the **user only — no tokens**; you must log in next. And
> **phone numbers are unique**, so reusing one gives `409 PHONE_ALREADY_REGISTERED`.

### 2. Log in

```bash
TOKEN=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  -d '{"email":"shopper@example.com","password":"Str0ng!Passw0rd#2026"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).accessToken))")
```

Access tokens last **15 minutes**. When calls start returning `401 INVALID_ACCESS_TOKEN`, re-run this.

### 3. Find something to buy

```bash
curl -s "$BASE/products" | head -c 400
```

Note a SKU `code` from the response — you need it for the cart.

### 4. Add it to the cart

```bash
curl -X PUT "$BASE/users/me/cart/items/YOUR-SKU-CODE" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"quantity": 2}'
```

`PUT` **sets** the quantity, it does not add to it. Sending `2` twice leaves 2 in the cart.

### 5. Save a delivery address

```bash
curl -X POST "$BASE/users/me/addresses" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "label": "Home",
  "recipientName": "Priya Kumari",
  "phone": "+919876543210",
  "line1": "42 Residency Road",
  "line2": "Ashok Nagar",
  "city": "Bengaluru",
  "state": "Karnataka",
  "postalCode": "560025"
}'
```

Keep the returned `id`.

### 6. Check out

```bash
curl -X POST "$BASE/users/me/checkout" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: checkout-$(date +%s)" \
  -d '{"addressId": "THE-ADDRESS-ID"}'
```

The `Idempotency-Key` header is **required**. Replay the same key and you get the original order
back with `Idempotent-Replay: true` — never a second order. The whole body is `{ addressId }`;
prices, discounts and totals are all recomputed server-side inside the transaction.

Keep the returned `orderNumber` (`ORD-YYYYMMDD-XXXXXX`).

### 7. Pay

```bash
curl -X POST "$BASE/users/me/orders/ORD-.../payments" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: pay-$(date +%s)" \
  -d '{"method": "cod"}'
```

`"method": "online"` returns `503 DEPENDENCY_UNAVAILABLE` (`dependency: "payment provider"`) until
Razorpay keys are configured.

There is **one payment per order**, enforced by a unique constraint, and no retry — so a second
attempt on an order that already has a payment is `409`, whatever the method, and a failure is
final.

### 8. Download the invoice

```bash
curl "$BASE/users/me/orders/ORD-.../invoice" \
  -H "Authorization: Bearer $TOKEN" -o invoice.html
```

A self-contained HTML document with the Syntellite logo embedded as a `data:` URI — no network
needed to view or print it. Open it and print to PDF; it has `@media print` rules for exactly that.

> Add `invoice.html` to `.gitignore` or write it outside the repo — Prettier scans root-level HTML
> and a stray download will fail `pnpm format:check`.

### 9. Or cancel instead

```bash
curl -X POST "$BASE/users/me/orders/ORD-.../cancel" -H "Authorization: Bearer $TOKEN"
```

Refused once a payment is `pending` (`PAYMENT_IN_PROGRESS`) or `succeeded` (`ORDER_PAID`).

### Password reset

```bash
curl -X POST "$BASE/auth/forgot-password" -H 'content-type: application/json' \
  -d '{"email":"shopper@example.com"}'
```

Then read the email at **http://localhost:8025**. The link is single-use and expires in 60 minutes.
Requires `pnpm dev:worker` to be running — the API only queues the event.

### Why am I getting 404 on someone else's order?

Because you should. Another customer's order is **deliberately indistinguishable from one that
never existed** — same `404`, same body. A `403` would confirm the order number is real. If you
need an order you don't own, use the staff route below.

---

## Becoming a staff user

All 28 `/admin/*` operations require the `staff` scope. **There is deliberately no endpoint that
grants it** — that would be a privilege-escalation route on a public API. Promote the first staff
user directly in the database:

```sql
UPDATE app_user SET is_staff = true WHERE email = 'you@example.com';
```

Then **log in again** — the scope is baked into the access token at sign-in. It is re-derived from
the database on every request, so a demotion takes effect immediately.

Once staff, you can also fetch the invoice for **any** order in your store:

```bash
curl "$BASE/admin/orders/ORD-.../invoice" -H "Authorization: Bearer $STAFF_TOKEN" -o invoice.html
```

Tenant scoping still applies — staff of one store get `404` for another store's orders.

---

## API reference

Everything is under `/api/v1`. Interactive docs at **`/docs`**, machine-readable at **`/docs.json`**
— neither is mounted in production, because an OpenAPI document is a complete map of the attack
surface.

**Access** column: `Public` needs nothing · `Customer` needs a login · `Staff` needs the staff
scope · `Signed` is verified by provider signature instead of a login.

### Authentication and account — 9

| Method  | Path                    | Access   |
| ------- | ----------------------- | -------- |
| `POST`  | `/auth/register`        | Public   |
| `POST`  | `/auth/login`           | Public   |
| `POST`  | `/auth/refresh`         | Public   |
| `POST`  | `/auth/logout`          | Customer |
| `POST`  | `/auth/forgot-password` | Public   |
| `POST`  | `/auth/reset-password`  | Public   |
| `GET`   | `/users/me`             | Customer |
| `PATCH` | `/users/me`             | Customer |
| `POST`  | `/users/me/password`    | Customer |

### Catalogue — 21

| Method                 | Path                                         | Access |
| ---------------------- | -------------------------------------------- | ------ |
| `GET`                  | `/products`                                  | Public |
| `GET`                  | `/products/:slug`                            | Public |
| `POST` `GET`           | `/admin/products`                            | Staff  |
| `GET` `PATCH` `DELETE` | `/admin/products/:slug`                      | Staff  |
| `POST`                 | `/admin/products/:slug/publish` · `/archive` | Staff  |
| `POST` `GET`           | `/admin/products/:slug/skus`                 | Staff  |
| `PATCH` `DELETE`       | `/admin/skus/:code`                          | Staff  |
| `PUT`                  | `/admin/skus/:code/options`                  | Staff  |
| `POST` `GET`           | `/admin/products/:slug/options`              | Staff  |
| `PATCH` `DELETE`       | `/admin/options/:id`                         | Staff  |
| `POST`                 | `/admin/options/:id/values`                  | Staff  |
| `PATCH` `DELETE`       | `/admin/option-values/:id`                   | Staff  |

### Cart — 6

| Method         | Path                            | Access   |
| -------------- | ------------------------------- | -------- |
| `GET` `DELETE` | `/users/me/cart`                | Customer |
| `PUT` `DELETE` | `/users/me/cart/items/:skuCode` | Customer |
| `PUT` `DELETE` | `/users/me/cart/promotion`      | Customer |

### Addresses — 5

| Method                 | Path                      | Access   |
| ---------------------- | ------------------------- | -------- |
| `POST` `GET`           | `/users/me/addresses`     | Customer |
| `GET` `PATCH` `DELETE` | `/users/me/addresses/:id` | Customer |

### Checkout, orders and invoice — 6

| Method | Path                                    | Access                             |
| ------ | --------------------------------------- | ---------------------------------- |
| `POST` | `/users/me/checkout`                    | Customer · needs `Idempotency-Key` |
| `GET`  | `/users/me/orders`                      | Customer                           |
| `GET`  | `/users/me/orders/:orderNumber`         | Customer                           |
| `POST` | `/users/me/orders/:orderNumber/cancel`  | Customer                           |
| `GET`  | `/users/me/orders/:orderNumber/invoice` | Customer                           |
| `GET`  | `/admin/orders/:orderNumber/invoice`    | **Staff** · any order in the store |

**The two invoice routes are READ-ONLY.** A statutory invoice is issued once, inside the checkout
transaction, for an order that carries a GST determination — fetching the document never
allocates a number, however many times it is fetched. An assessed order's document is titled
**Tax invoice** and bears `INV/YYYY-YY/NNNNNN`; an unassessed one is titled **Invoice** and is
referenced by its order number.

The financial year runs 1 April to 31 March **in the store's own timezone**, and the series is
per store and per year — two stores both start at `000001`, and so does each new year. The
numbering is gapless: the counter is a row incremented inside the checkout transaction, so a
checkout that rolls back releases its number instead of burning it.

### Payments — 4

| Method | Path                                     | Access                             |
| ------ | ---------------------------------------- | ---------------------------------- |
| `POST` | `/users/me/orders/:orderNumber/payments` | Customer · needs `Idempotency-Key` |
| `GET`  | `/users/me/orders/:orderNumber/payment`  | Customer                           |
| `GET`  | `/users/me/payments`                     | Customer                           |
| `POST` | `/webhooks/razorpay`                     | **Signed**                         |

### Shipping and fulfilment — 6

| Method       | Path                                      | Access                               |
| ------------ | ----------------------------------------- | ------------------------------------ |
| `GET`        | `/users/me/orders/:orderNumber/shipments` | Customer · status, carrier, tracking |
| `GET`        | `/admin/orders/fulfilment`                | **Staff** · the fulfilment queue     |
| `POST` `GET` | `/admin/orders/:orderNumber/shipments`    | **Staff** · one shipment per order   |
| `POST`       | `/admin/shipments/:id/ship`               | **Staff** · moves the stock          |
| `POST`       | `/admin/shipments/:id/deliver`            | **Staff**                            |
| `PATCH`      | `/admin/shipments/:id`                    | **Staff** · corrects tracking only   |

Shipping is free and fulfilment is manual — there is no carrier integration. A shipment is created
`pending`, then shipped, then delivered; shipping is the only thing that decrements `on_hand`. An
online order must be paid first; a COD order may ship while its payment is still `pending`.

### GST and tax — 11

| Method               | Path                             | Access                                 |
| -------------------- | -------------------------------- | -------------------------------------- |
| `GET` `PUT`          | `/admin/store/tax-profile`       | **Staff** · seller identity and origin |
| `POST` `GET`         | `/admin/tax-classes`             | **Staff**                              |
| `PATCH`              | `/admin/tax-classes/:code`       | **Staff** · rename or deactivate       |
| `POST` `GET`         | `/admin/tax-classes/:code/rates` | **Staff** · effective-dated rates      |
| `PUT`                | `/admin/skus/:code/tax`          | **Staff** · tax class + HSN/SAC        |
| `GET` `PUT` `DELETE` | `/users/me/tax-identity`         | Customer · their own GSTIN             |

**`PUT /admin/store/tax-profile` is the GST switch.** A store with no profile assesses no tax and
its orders carry no tax snapshot. Once a profile exists, every checkout is assessed and a line
whose SKU has no active tax class and no rate in force is refused with `422`.

**No rate is built in.** There is no default, no seed and no constant anywhere in the source
naming a GST percentage — a class has no rate until one is configured, and HSN codes are strings a
merchant supplies. Rates cannot be edited or deleted, only superseded by a new dated window.

Order responses gained `taxTotal`, `grandTotal` and a nullable `tax` object on the header and on
each line. **`total` still means the goods total; `grandTotal` is what a payment charges.**

### Promotions — 5 · Inventory — 3 · Operations — 2

| Method                 | Path                                | Access |
| ---------------------- | ----------------------------------- | ------ |
| `POST` `GET`           | `/admin/promotions`                 | Staff  |
| `GET` `PATCH` `DELETE` | `/admin/promotions/:code`           | Staff  |
| `GET`                  | `/admin/inventory`                  | Staff  |
| `POST`                 | `/admin/inventory/adjustments`      | Staff  |
| `GET`                  | `/admin/inventory/:skuCode/history` | Staff  |
| `GET`                  | `/health/live`                      | Public |
| `GET`                  | `/health/ready`                     | Public |

**No general staff order list and no staff payment visibility exist.** Beyond the narrow
fulfilment queue, staff can render an invoice for an order number they already have, but cannot
browse, search or act on orders.

### Error format

Every error is the same envelope. There is no second shape to code against.

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "The requested order does not exist.",
    "details": { "resource": "order" },
    "requestId": "294f75ae-dee1-4908-98a5-2a018dd8dbbd"
  }
}
```

`requestId` also comes back in the `X-Request-Id` header and appears on every log line for that
request — quote it in bug reports.

---

## Testing and quality gates

```bash
pnpm verify   # format + lint + typecheck + depcruise + test. Run this before any commit.
```

Individually:

```bash
pnpm test              # 1,855 tests across 59 files
pnpm test:watch
pnpm test:coverage
pnpm typecheck         # three tsconfigs: src, tests, tools
pnpm lint
pnpm format:check
pnpm depcruise         # architecture boundaries — 153 modules, must report 0 violations
pnpm build
pnpm db:generate       # must say "No schema changes, nothing to migrate"
pnpm exec drizzle-kit check   # migration consistency
```

**Docker must be running.** Integration tests start their own throwaway PostgreSQL per run via
Testcontainers, so they need neither `docker compose up` nor a configured `DATABASE_URL`.

> **If the suite fails with `Memory allocation error`, worker-fork crashes, or scattered
> `expected 401 to be 200`, you are out of memory, not broken.** Run it sequentially:
>
> ```bash
> pnpm exec vitest run --fileParallelism=false
> ```
>
> Slower (~8 min vs ~4 min) but reliable on a machine with less than ~6 GB free.

---

## Project structure

```
src/
├── main.ts                  API entry point
├── container.ts             Composition root — the ONLY place adapters are wired
├── config.ts                Reads process.env once, validates with Zod
├── db/
│   ├── schema/              Drizzle table definitions (17 files, 35 tables)
│   ├── migrations/          17 plain .sql files — the real source of truth
│   ├── outbox/              Transactional outbox: dispatcher, publisher, queues
│   ├── migrate.ts           pnpm db:migrate
│   └── seed.ts              pnpm db:seed
├── http/
│   ├── app.ts               Express assembly. Middleware order is load-bearing — read the comment
│   ├── middleware/          auth, store resolution, idempotency, scope, errors, context
│   └── routes/              health, docs (the OpenAPI document lives here)
├── modules/                 One directory per domain
│   ├── identity/            registration, login, tokens, password reset
│   ├── catalogue/           products, SKUs, option grids
│   ├── inventory/           stock items and the append-only ledger
│   ├── addresses/
│   ├── cart/
│   ├── promotions/
│   ├── orders/              checkout, orders, cancellation, invoice rendering
│   ├── payments/            payment state machine, webhook handling
│   ├── fulfilment/          shipments, the fulfilment queue, stock fulfilment
│   ├── tax/                 GST: classes, effective-dated rates, the calculation
│   ├── invoicing/           the FY-scoped invoice series and the issued invoice
│   └── stores/              tenant resolution
├── razorpay/                The ONLY file that names Razorpay
├── mail/                    SMTP adapter + the password-reset consumer
├── shared/                  money, ids, errors, logger, audit, pagination
└── workers/                 worker and scheduler entry points
```

Each module holds the same five files: `*.routes.ts` (HTTP adapter), `*.service.ts` (business
rules), `*.repository.ts` (SQL), `dto.ts` (Zod schemas and response mapping), `*.events.ts` (audit
and event vocabulary).

---

## How the code is organised

Boundaries are **machine-enforced**. `pnpm depcruise` fails the build on a violation, so these are
not conventions anyone can quietly ignore:

| Rule                               | Meaning                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `no-cross-module-imports`          | One module may not import another's internals                    |
| `no-modules-to-http`               | Business code may not import from `http/` — except `*.routes.ts` |
| `no-http-to-modules`               | And the reverse                                                  |
| `schema-only-in-repositories`      | Only repositories may touch Drizzle table definitions            |
| `shared-is-the-base-layer`         | `shared/` may not import upward                                  |
| `jose-only-in-token-service`       | JWT library confined to one file                                 |
| `argon2-only-in-password-module`   | Password hashing confined to one file                            |
| `container-only-from-entry-points` | Nothing imports the composition root except entry points         |
| `no-circular`, `no-orphans`        |                                                                  |

Plus two custom ESLint rules with their own tests: `no-money-arithmetic` (no `+`/`*` on money
outside `shared/money.ts`) and `no-relational-api-in-inventory`.

**Modules talk through consumer-declared ports.** When orders needs payment state it declares the
four-line interface it wants, and `container.ts` supplies the payments service to satisfy it. The
orders module never imports payments.

---

## Design decisions worth knowing

**Money is never a float.** `NUMERIC(19,4)` in the database, decimal.js with `ROUND_HALF_UP` in
code, and a single rounding boundary (`toMinorUnits`) at the point an amount is handed to the
payment provider. Display formatting uses Indian digit grouping: `₹12,34,567.89`.

**Tenancy is structural, not conditional.** 31 of 33 tables carry `store_id`, and **32 composite
foreign keys** make a cross-store reference _unrepresentable_ — the database refuses it, rather than
application code remembering to check.

**Orders are immutable snapshots.** Each line freezes the SKU code, product name, unit price and
line total; nine `ship_*` columns freeze the address. Renaming a product, changing its price,
deleting the address or withdrawing the coupon afterwards leaves a placed order byte-identical.

**Idempotency is enforced by the database.** `UNIQUE (store_id, user_id, key, endpoint)`. The
authenticated user is part of the scope, so two customers sending the same `Idempotency-Key` cannot
replay each other's order.

**Payment webhooks trust only the signature.** HMAC over the exact raw request bytes, compared with
`timingSafeEqual`, verified _before_ the payload is parsed. The webhook router is mounted with
`express.raw` **before** `express.json()` — otherwise the original bytes are gone and every
signature check fails. The store is taken from the matched payment row, never from the payload. A
duplicate delivery is a successful no-op enforced by a unique constraint.

**`order.status` never represents payment state.** Payment lives entirely on the `payment` row.
Order status has exactly two values: `placed` and `cancelled`.

**Events go through a transactional outbox.** Domain events are written in the same transaction as
the business change, then delivered at-least-once by the dispatcher. There is currently **exactly
one consumer** — the password-reset email. Order and payment events are deliberately _not_
published: an event with no consumer is a guess at what the consumer will need.

**History tables are append-only.** Eight tables have no `updated_at` and no `UPDATE` path, among
them `order_status_history`, `stock_ledger`, `audit_log` and `payment_event`. The past cannot be
rewritten.

---

## Known limitations

Beyond the three in [What works and what doesn't](#what-works-and-what-doesnt):

- **`app_user.email_verified_at` is never written**, so `emailVerified` is permanently `false`.
  Registration accepts any address without proving ownership.
- **`store_setting` and `feature_flag` are dead tables** — no repository, no route, nothing reads
  them.
- **A 100%-off coupon produces a `total` of 0**, which can be placed but never paid, because the
  payment amount must be positive. It can still be cancelled.
- **The invoice is numbered but not e-invoiced.** An assessed order now gets a sequential,
  gapless, financial-year-scoped number (`INV/2026-27/000001`) with an HSN/rate-wise summary and
  the seller identity frozen at checkout — but **no IRN, no acknowledgement number and no signed
  QR code**, because this system is not registered with the Invoice Registration Portal. The
  document says so on its face.
- **An invoice cannot be cancelled or amended.** There are no credit or debit notes, so an order
  cancelled AFTER being invoiced keeps its number and its document — which is correct for a
  series that must not have gaps, and incomplete until credit notes exist. The document shows
  `Cancelled` in its status badge, so it does not misrepresent the order.
- **The invoice series is six digits**, so a store may issue 999,999 invoices in one financial
  year before the format has to widen. A wider number is refused loudly rather than truncated.
- **Orders placed before the invoicing increment have no invoice number**, and none is
  backfilled: allocating numbers to historical orders in whatever order a query returned them
  would not be a series. Those documents render as they always did, referenced by order number.
- **`/health/ready` gives each dependency 2,000 ms**, hardcoded. A Neon database that has scaled to
  zero takes longer to wake, so the first probe after an idle period reports `unavailable` and the
  next succeeds. Either keep the database warm or make the timeout configurable before deploying.
- **`docs/DECISIONS.md` stops at Increment 30 for some subjects.** Increments 35–39 are
  documented in §44–§48; the reasoning for payments, password reset and cancellation still lives
  only in source file headers.
- **A COD payment never leaves `pending`.** There is no delivery-settlement step, so a COD order
  can be shipped and delivered while its payment row still reads `pending`, and it stays
  uncancellable. The money is not tracked anywhere.
- **A shipment cannot be undone.** `pending → shipped → delivered` is one-way, with no `cancelled`
  or `returned` state, and a shipped order can no longer be cancelled. A `pending` shipment on a
  cancelled order is left behind as an operational fact that can never ship.
- **GST is off until a store configures it.** A store with no seller tax profile assesses no tax
  at all, and its orders carry a NULL tax snapshot — which records "not assessed", deliberately
  distinct from "assessed at nil". Once a profile exists, a line whose SKU has no active tax class
  and no rate in force is REFUSED with `422`, never silently untaxed. **This rule was settled by
  engineering and needs accounting's ratification.**
- **State matching for place of supply is free text.** There is no GST state-code catalogue — that
  is statutory master data this build does not invent — so the seller's origin state and the
  delivery state are compared after normalising case and whitespace. Two different SPELLINGS of
  one state (`Orissa` / `Odisha`), an abbreviation or a typo compare unequal and produce IGST
  where CGST+SGST was due. The value actually compared is snapshotted on the order so a wrong
  determination can be found afterwards.
- **GSTIN and PAN are validated for SHAPE only.** No checksum, and no registry lookup.
- **One GST origin per store.** Multi-warehouse dispatch is deferred, so every order's place of
  supply is computed against the same origin address.
- **A tax rate cannot be edited or deleted**, only superseded by a new effective-dated window.

---

## Troubleshooting

| Symptom                                                                            | Cause and fix                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 INVALID_ACCESS_TOKEN` on a call that just worked                              | Access tokens last 15 minutes. Log in again                                                                                                                                     |
| `401` from a token you just pasted                                                 | Check it has **two** dots. A truncated JWT is missing its signature                                                                                                             |
| `404` on an order you can see in the database                                      | It belongs to another user. This is intentional — see [above](#why-am-i-getting-404-on-someone-elses-order)                                                                     |
| `409 PHONE_ALREADY_REGISTERED`                                                     | Phone numbers are unique. Use a different one                                                                                                                                   |
| Registration succeeded but you have no token                                       | Registration returns the user only. Call `/auth/login`                                                                                                                          |
| `503` on `method: "online"`                                                        | No Razorpay keys configured. COD works                                                                                                                                          |
| `409` on a payment attempt                                                         | That order already has a payment. One payment per order, enforced by a unique constraint, with no retry                                                                         |
| `DEPENDENCY_UNAVAILABLE`, `dependency: rate-limiter`                               | Redis is down or saturated. `docker compose up -d`, and don't run the test suite at the same time                                                                               |
| No password-reset email                                                            | `pnpm dev:worker` is not running — the API only queues the event. Then check http://localhost:8025                                                                              |
| `/health/ready` says postgres unavailable, then fine                               | Neon cold start exceeding the 2s timeout. Probe again                                                                                                                           |
| Tests fail with `Memory allocation error` or scattered `401`s                      | Out of memory. Use `pnpm exec vitest run --fileParallelism=false`                                                                                                               |
| Tests fail at container startup                                                    | Docker is not running, or its daemon is returning 500. Restart Docker Desktop                                                                                                   |
| `422` when shipping an order                                                       | The payment is not `succeeded`. Only COD may ship while `pending`                                                                                                               |
| `409` on `POST /admin/orders/:orderNumber/shipments`                               | That order already has a shipment. Exactly one per order, enforced by a unique constraint                                                                                       |
| `422 TAX_NOT_DETERMINABLE` at checkout                                             | The store has a GST profile, but a SKU has no tax class, its class is inactive, or no rate is in force. `details.skuCodes` names them                                           |
| Orders show `tax: null` and no GST is charged                                      | The store has no seller tax profile. `PUT /admin/store/tax-profile`                                                                                                             |
| IGST charged when you expected CGST+SGST                                           | The seller origin state and the delivery state did not match after normalising. Check for two spellings of the same state — there is no state-code catalogue                    |
| `format:check` fails on a file you didn't write                                    | A stray root-level `.html` — usually a downloaded invoice. Move it out of the repo                                                                                              |
| `EADDRINUSE :::8000`                                                               | An old `pnpm dev` is still alive. Kill it, or change `PORT`                                                                                                                     |
| Container exits with `unable to find user ...: no matching entries in passwd file` | An Alpine/musl image on this Docker + WSL2 kernel. **Never use `-alpine` images here** — every image in `docker-compose.yml` is Debian-based for this reason                    |
| A new migration fails on apply                                                     | Drizzle sometimes emits a foreign key _before_ the unique index it depends on. This has needed hand-correction six times. **Read every generated migration before applying it** |

---

## Further reading

| File                     | What it holds                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **`docs/DECISIONS.md`**  | 3,141 lines of design decisions, one section per increment, with the reasoning and the alternatives rejected. Covers increments 1–30 |
| **`Report.md`**          | Current status audit: measured counts, quality-gate results, gap analysis, and what is needed from the business to finish            |
| **`docker-compose.yml`** | Heavily commented — explains every service, every port choice, and what was removed and why                                          |
| **`src/http/app.ts`**    | The middleware order, with a note on each entry explaining what breaks if it moves                                                   |
| **`/docs`**              | Interactive OpenAPI reference against your running instance                                                                          |
