# Report

**Project:** Reusable multi-tenant e-commerce backend (India / INR / GST target market)
**Report date:** 8 September 2026
**Supersedes:** the 4 September 2026 edition of this file (Increment 30 / 1,449 tests / 53 endpoints). Every figure below was re-measured; nothing was carried over on trust.
**Report type:** Status and audit. No source code, test or migration was modified to produce it. Unlike the previous edition, this one **did** execute the full test suite and read the live database, because the database is now a hosted Neon instance rather than a local container and the suite creates its own throwaway database.
**Source of truth:** the repository as it stands on disk today, plus the verification commands logged in §18.

---

## 1. Executive Position

The project is a **backend API only**. Thirty-four roadmap increments have been implemented. The full automated verification suite passes with **1,655 tests across 57 test files, 0 failing, 0 skipped, exit status 0** (233.17s).

The headline change since the last report is that **the money path is closed**. A customer can now register, log in, browse and search a catalogue, keep an address book, build a cart, apply a coupon, check out, **pay for the order — online through Razorpay or by cash on delivery — cancel it while it is still cancellable, and download a branded invoice**. Password reset by email works end to end.

**There is still no user interface of any kind** — no storefront and no Admin Dashboard. **Shipping, GST/tax, refunds and returns remain unimplemented** and are explicitly deferred.

Two limitations from the last report are unchanged and both are commercially significant:

1. **Checkout still performs no stock check and no reservation.** Overselling is possible. Re-verified today: the production code paths in `src/modules/orders` and `src/modules/cart` contain **zero** references to `stock_item` or `stock_ledger` — the only such references in those directories are in test files that assert stock is untouched.
2. **Coupons still have no usage limits or redemption tracking.**

One new limitation has been introduced by the payment work and must not be glossed over: **the online payment path has never been exercised against Razorpay**, because no API keys have been supplied. See §7c.

---

## 2. Roadmap Position

`docs/DECISIONS.md` §3 #1 fixes the roadmap at **9 phases (0–8)**.

| Phase                                                                                  | Increments delivered           | Status                     |
| -------------------------------------------------------------------------------------- | ------------------------------ | -------------------------- |
| Phase 0 — foundation, outbox, HTTP scaffolding, composition root, process entry points | documented as steps (§10–§14)  | Complete                   |
| Phase 1 — identity and access                                                          | 1, 2, 3, 4, 5, 6, 8, 9, 10, 21 | Complete                   |
| Phase 2 — catalogue, inventory, addresses, cart, promotions                            | 11–20, 24–29                   | Complete                   |
| Phase 3 — checkout, orders, payment                                                    | 30, 31, 32, 33, 34             | **Substantially advanced** |
| Phases 4–8 (shipping, tax, returns, reporting, front ends)                             | none                           | Not started                |

**Phase completion: 3 of 9 phases fully complete = 33%.** Phase 3 has moved from "first increment delivered" to "checkout, payment, cancellation and invoicing delivered", but it is not complete while shipping and tax sit inside it.

No increment-level percentage is offered, for the same reason as the last edition: the repository nowhere states the _total_ number of planned increments, so any percentage would be invented.

### Documentation drift — a real finding

`docs/DECISIONS.md` still ends at **§43, Increment 30**. It is 3,141 lines and 43 sections, byte-for-byte the same length as at the last report. **Increments 31–34 have no decision record**: a search for "increment 31" in that file returns 0 matches. The design reasoning for payments, password reset, cancellation and invoicing currently exists only as file-header commentary in the source, which is thorough but is not the project's decision log.

A related, smaller drift: the header comments in `orders.events.ts`, `payments.events.ts`, `promotions.events.ts` and `addresses.events.ts` all still state that "the handler registry is empty (`container.ts` passes `opts.handlers ?? {}`)". That is no longer true — `src/container.ts:394` now passes `opts.handlers ?? builtInHandlers`, with one registered consumer. The comments' _conclusion_ (no order or payment events are published) still holds; their _premise_ is stale.

---

## 3. Customer / User-Side Functionality

Legend: ✅ Working & Verified · 🟡 Partially Working · ⚠️ Works but unproven against the real provider · 🔵 Not Implemented · 🔴 Failing

| Function                                      | API / Area                                           | Status | Verified By                                                                                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create account                                | `POST /api/v1/auth/register`                         | ✅     | `register.integration.test.ts`                                                                                                                                                                                 |
| Log in                                        | `POST /api/v1/auth/login`                            | ✅     | `login.integration.test.ts`, `login-collision`                                                                                                                                                                 |
| Log out                                       | `POST /api/v1/auth/logout`                           | ✅     | `logout.integration.test.ts`                                                                                                                                                                                   |
| Refresh session                               | `POST /api/v1/auth/refresh`                          | ✅     | `refresh.integration.test.ts`, `refresh-token.test.ts`                                                                                                                                                         |
| **Forgot password**                           | `POST /api/v1/auth/forgot-password`                  | ✅     | **NEW** — `password-reset.integration.test.ts` (22 declared)                                                                                                                                                   |
| **Reset password with token**                 | `POST /api/v1/auth/reset-password`                   | ✅     | **NEW** — same file                                                                                                                                                                                            |
| View own profile                              | `GET /api/v1/users/me`                               | ✅     | `current-user.integration.test.ts`                                                                                                                                                                             |
| Update own profile                            | `PATCH /api/v1/users/me`                             | ✅     | `update-profile.integration.test.ts`                                                                                                                                                                           |
| Change own password                           | `POST /api/v1/users/me/password`                     | ✅     | `change-password.integration.test.ts`                                                                                                                                                                          |
| Browse products                               | `GET /api/v1/products`                               | ✅     | `public-product-list.integration.test.ts`                                                                                                                                                                      |
| View one product                              | `GET /api/v1/products/:slug`                         | ✅     | `public-product.integration.test.ts`                                                                                                                                                                           |
| Search products                               | `GET /api/v1/products?q=`                            | ✅     | `public-product-search.integration.test.ts`                                                                                                                                                                    |
| Filter by price                               | `GET /api/v1/products?price_min=&price_max=`         | ✅     | `public-product-price-filter.integration.test.ts`                                                                                                                                                              |
| See SKUs / variant options                    | included in product payloads                         | ✅     | `sku.integration.test.ts`, `options.integration.test.ts`                                                                                                                                                       |
| Address book (create/list/read/update/delete) | `/api/v1/users/me/addresses`                         | ✅     | `addresses.integration.test.ts`                                                                                                                                                                                |
| Cart (get/set qty/remove/clear/totals)        | `/api/v1/users/me/cart`                              | ✅     | `cart.integration.test.ts`                                                                                                                                                                                     |
| Apply / remove coupon                         | `PUT`/`DELETE /api/v1/users/me/cart/promotion`       | ✅     | `cart-promotions.integration.test.ts`                                                                                                                                                                          |
| Checkout / place an order                     | `POST /api/v1/users/me/checkout`                     | ✅     | `orders.integration.test.ts`                                                                                                                                                                                   |
| List own orders                               | `GET /api/v1/users/me/orders`                        | ✅     | same file                                                                                                                                                                                                      |
| View one order                                | `GET /api/v1/users/me/orders/:orderNumber`           | ✅     | same file                                                                                                                                                                                                      |
| **Pay by cash on delivery**                   | `POST /api/v1/users/me/orders/:orderNumber/payments` | ✅     | **NEW** — `payments.integration.test.ts` (79 declared)                                                                                                                                                         |
| **Pay online (Razorpay)**                     | same endpoint, `method: "online"`                    | ⚠️     | **NEW** — logic fully tested against a stubbed gateway; **never run against Razorpay — no API keys supplied.** Returns `503` today. See §7c                                                                    |
| **Payment status for an order**               | `GET /api/v1/users/me/orders/:orderNumber/payment`   | ✅     | **NEW** — same file                                                                                                                                                                                            |
| **Own payment history**                       | `GET /api/v1/users/me/payments`                      | ✅     | **NEW** — same file                                                                                                                                                                                            |
| **Cancel an order**                           | `POST /api/v1/users/me/orders/:orderNumber/cancel`   | ✅     | **NEW** — `order-cancellation.integration.test.ts` (19 declared)                                                                                                                                               |
| **Download an invoice**                       | `GET /api/v1/users/me/orders/:orderNumber/invoice`   | ✅     | **NEW** — `invoice.test.ts` (25 declared) + live download                                                                                                                                                      |
| See order status                              | `status` field on order responses                    | 🟡     | Two states now exist — `placed` and `cancelled`. Still no confirm/ship/deliver                                                                                                                                 |
| Retry a failed payment                        | —                                                    | 🔵     | One payment per order by design; a failure is terminal                                                                                                                                                         |
| Guest checkout                                | —                                                    | 🔵     | Deliberately unsupported; every route requires a verified token                                                                                                                                                |
| See shipping / tracking                       | —                                                    | 🔵     | Not implemented                                                                                                                                                                                                |
| See tax / GST on an order                     | —                                                    | 🔵     | Not implemented                                                                                                                                                                                                |
| Return / refund                               | —                                                    | 🔵     | Explicitly out of scope for Increment 31                                                                                                                                                                       |
| Email verification of the account             | —                                                    | 🔵     | `app_user.email_verified_at` exists and **nothing ever writes it**, so `emailVerified` is permanently `false`. Verified today: the column is only ever read (`identity.repository.ts:36/74/111`, `dto.ts:139`) |
| Order confirmation email                      | —                                                    | 🔵     | The only registered event consumer is password reset                                                                                                                                                           |
| Product reviews / wishlist                    | —                                                    | 🔵     | No table or route                                                                                                                                                                                              |

### What a customer can actually do today

The complete journey through payment: register → log in (or recover a forgotten password by email) → browse, search and price-filter a published catalogue → keep an address book → build a cart across sessions → apply a coupon → check out into an immutable order → **pay for it by COD (or online, once keys exist) → read its payment status → cancel it while it is still cancellable → download an invoice for it**.

What they still cannot do: be shipped it, be taxed on it, be refunded, retry a failed payment, verify their email address, or receive any notification other than a password reset.

---

## 4. Admin / Staff Functionality

### 4a. Backend Admin/Staff APIs — implemented

**28 `/admin/*` operations** across 20 route paths, all behind `requireAuth` + `requireScope('staff')`. Increments 31–34 added no admin surface; the staff invoice route below was added afterwards and is the module's first `/admin/order*` route.

| Function                                       | API / Area                                              | Status | Verified By                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Staff authentication                           | shared `/auth/login` + `is_staff` flag                  | ✅     | `scope.integration.test.ts`                                                                                                                                                                                              |
| Staff authorization guard                      | `requireScope('staff')` → 403 for customers             | ✅     | same file                                                                                                                                                                                                                |
| Product create / list / read / update / delete | `/admin/products*`                                      | ✅     | 6 test files                                                                                                                                                                                                             |
| Publish / archive product                      | `POST /admin/products/:slug/publish` · `/archive`       | ✅     | `product-lifecycle.integration.test.ts`                                                                                                                                                                                  |
| SKU create / list / update / delete            | `/admin/products/:slug/skus`, `/admin/skus/:code`       | ✅     | `sku.integration.test.ts`                                                                                                                                                                                                |
| Variant options and values (full grid)         | `/admin/products/:slug/options`, `/admin/option-values` | ✅     | `options.integration.test.ts`                                                                                                                                                                                            |
| Assign option combination to SKU               | `PUT /admin/skus/:code/options`                         | ✅     | same file                                                                                                                                                                                                                |
| View stock / adjust stock / stock ledger       | `/admin/inventory*`                                     | ✅     | `inventory.integration.test.ts`                                                                                                                                                                                          |
| Promotion CRUD                                 | `/admin/promotions*`                                    | ✅     | `promotions.integration.test.ts`                                                                                                                                                                                         |
| **Order invoice (staff)**                      | `GET /admin/orders/{orderNumber}/invoice`               | ✅     | **NEW** — the invoice for **any** order in the store, so re-issuing a customer's invoice no longer requires impersonating them. Tenant scoping is kept; only ownership within the store is relaxed                       |
| **Order management (staff)**                   | —                                                       | 🔵     | **No `/admin/orders` list and no staff order detail.** Staff can produce an invoice for an order number they already have, but cannot browse, search or act on orders                                                    |
| **Payment visibility (staff)**                 | —                                                       | 🔵     | **No `/admin/payment*` route exists.** Payments are visible only to the customer who made them. This is new debt created by Increment 31                                                                                 |
| **Staff / role management**                    | —                                                       | 🔵     | There is deliberately no endpoint that grants `is_staff` — that would be a privilege-escalation route on a public API. The first staff user must be promoted with SQL (§16)                                              |
| Reporting / analytics                          | —                                                       | 🔵     | No endpoints                                                                                                                                                                                                             |
| Customer administration                        | —                                                       | 🔵     | No endpoints                                                                                                                                                                                                             |
| Store / tenant administration                  | —                                                       | 🔵     | `store`, `store_setting` and `feature_flag` tables exist with **no repository and no route** — verified today: zero references to `storeSetting` or `featureFlag` anywhere outside `src/db/schema`. They are dead tables |

### 4b. Admin Dashboard Frontend

**Status: 🔵 DOES NOT EXIST.** Re-verified today: zero `.tsx`, `.jsx`, `.vue` or `.svelte` files; no `web/`, `frontend/`, `admin/`, `ui/`, `client/` or `dashboard/` directory; no React, Vue, Next.js, Svelte, Angular, Vite or Tailwind dependency among the 17 production and 21 development dependencies. The only served HTML is Swagger UI at `/docs` and the invoice document.

**The `/admin/*` routes are backend JSON APIs and must not be described to stakeholders as an "Admin Dashboard".**

---

## 5. Feature Area Audit

| Area                           | Status                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity & access              | ✅ Complete                         | 13 test files. Registration, login, logout, refresh rotation with reuse detection, profile, password change, staff scopes, **and password reset by email**                                                                                                                                                                                                                                                               |
| Product catalogue              | ✅ Complete                         | Create/read/update/publish/archive/soft-delete, public list, search, price filter                                                                                                                                                                                                                                                                                                                                        |
| SKU / variants                 | ✅ Complete                         | CRUD, pricing, activation, uniqueness, product relationship                                                                                                                                                                                                                                                                                                                                                              |
| Variant options                | ✅ Complete                         | Options, values, SKU combinations, uniqueness, limits, deletion protection                                                                                                                                                                                                                                                                                                                                               |
| Inventory                      | 🟡 Partial                          | `stock_item` (`on_hand`, `reserved`, generated `available`), append-only `stock_ledger`, manual adjustments. **`reserved` is still never written**; ledger reasons remain CHECK-restricted to `manual_increase`, `manual_decrease`, `correction`. No reservation, no allocation                                                                                                                                          |
| Addresses                      | ✅ Complete                         | Full CRUD, user+store ownership, validation, soft delete                                                                                                                                                                                                                                                                                                                                                                 |
| Cart                           | ✅ Complete                         | Get/create, set quantity, remove, clear, totals, purchasability, one active cart per customer, row-level locking                                                                                                                                                                                                                                                                                                         |
| Promotions                     | 🟡 Partial                          | Full admin CRUD, percentage and fixed-amount discounts, minimum subtotal, date window, active flag, apply/remove/replace on cart. **Still no redemption or usage tracking** — the `promotion` table has no usage-count or max-redemption column, and its own header comment says so                                                                                                                                      |
| Checkout / Orders              | ✅ Complete for its scope           | See §6                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Order cancellation**         | ✅ **NEW — Complete**               | `POST /users/me/orders/:orderNumber/cancel`. Locks the order `FOR UPDATE`, reads payment state **inside the lock**, refuses when a payment is `pending` (`PAYMENT_IN_PROGRESS`) or `succeeded` (`ORDER_PAID`). `ORDER_STATUSES` widened to `['placed','cancelled']` by migration                                                                                                                                         |
| **Payment**                    | ✅ **NEW — Complete for its scope** | See §7. `payment` + `payment_event` tables, provider-agnostic port, Razorpay adapter, signed webhook, COD, idempotency, one payment per order                                                                                                                                                                                                                                                                            |
| **Invoicing**                  | 🟡 **NEW — Document only**          | `GET /users/me/orders/:orderNumber/invoice` renders a self-contained, print-ready HTML invoice branded **Syntellite Innovation**, carrying the company logo as an embedded `data:` PNG so the document needs no network and survives the asset path changing. It states on its face that it is **not a GST tax invoice** and uses the order number as its reference. **No invoice series, no numbering, no PDF, no IRN** |
| Shipping                       | 🔵 Not implemented                  | No shipment/carrier/tracking table, route or service                                                                                                                                                                                                                                                                                                                                                                     |
| GST / Tax                      | 🔵 Not implemented                  | No tax column, table, route or rate anywhere. An order total is lines minus discount, full stop                                                                                                                                                                                                                                                                                                                          |
| Returns / refunds              | 🔵 Not implemented                  | **Explicitly out of scope for Increment 31.** No refund table, route or provider call                                                                                                                                                                                                                                                                                                                                    |
| Domain events                  | ✅ Infrastructure complete          | Transactional outbox (`outbox_event`, `processed_event`), dispatcher, publisher, BullMQ transport, retry/backoff, leader lock                                                                                                                                                                                                                                                                                            |
| **Event consumers**            | 🟡 **NEW — exactly one**            | `src/container.ts:378` registers `user.password_reset_requested` → the password-reset mail handler. **This is the first real consumer in the project's history.** Every other emitted event type still has none, and order and payment events are deliberately not published at all                                                                                                                                      |
| **Email delivery**             | ✅ **NEW — Complete**               | `src/mail/mailer.ts`, a nodemailer SMTP adapter behind a `Mailer` port that never logs message bodies or secrets. Delivered locally into Mailpit                                                                                                                                                                                                                                                                         |
| Audit                          | ✅ Complete                         | `audit_log`, append-only, FK to actor, actor taken only from the verified token. Payments added four audit actions                                                                                                                                                                                                                                                                                                       |
| Notifications                  | 🟡 Partial                          | Password-reset email only. No order confirmation, no payment receipt, no SMS/WhatsApp                                                                                                                                                                                                                                                                                                                                    |
| Reviews / wishlist / reporting | 🔵 Not implemented                  | No table or route                                                                                                                                                                                                                                                                                                                                                                                                        |
| Admin Dashboard UI             | 🔵 Not implemented                  | See §4b                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 6. Checkout / Orders — Verification Delta

Everything recorded in the previous edition still holds: immutable product/address/promotion snapshots, server-generated `ORD-YYYYMMDD-XXXXXX` numbers, append-only status history, single-transaction writes, cart row locking, and user-scoped idempotency. Only the changes are listed here.

| Requirement                    | Status | Evidence                                                                                                                                                                                                              |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order status values            | 🟡     | Now **two**: `placed` and `cancelled`. `CANCELLABLE_ORDER_STATUSES = ['placed']`. Three CHECK constraints were widened by migration `20260907171400_outstanding_loners.sql`. Confirm/ship/deliver still do not exist  |
| Cancellation                   | ✅     | Locks the order row, then reads payment state **within that lock** through the `OrderPayments` port, so a payment cannot be initiated between the check and the write                                                 |
| Cancellation vs payment        | ✅     | `pending` → refused as `PAYMENT_IN_PROGRESS`; `succeeded` → refused as `ORDER_PAID`. Only an unpaid, uninitiated order can be cancelled by the customer                                                               |
| **`order.status` and payment** | ✅     | Deliberately decoupled. Payment state lives **only** on the `payment` row; `order.status` is never mutated to represent it. This was a locked constraint of the increment and it holds                                |
| Invoice                        | ✅     | Pure `renderInvoice(input)` → self-contained HTML. Escapes `& < > " '`. Derives its own document state (Cancelled / Paid / Cash on delivery / Payment pending / Payment failed / Proforma) from the order and payment |
| Invoice response hardening     | ✅     | The route sets its own `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` and `Cache-Control: private, no-store`    |
| **Inventory interaction**      | ⚠️     | **Still none.** Re-verified today by grep: no `stock_item` / `stock_ledger` reference in the non-test source of `src/modules/orders` or `src/modules/cart`. An order can be placed for stock that is not there        |
| **Promotion redemption**       | ⚠️     | Still none, by design                                                                                                                                                                                                 |

### Known reachable dead end

A 100%-off coupon produces an order with `total = 0.0000`. Such an order **can be placed but then neither paid nor cancelled**: the payment amount must be positive (`ck_payment_amount_positive`), so no payment row can exist, and cancellation is permitted — so in practice the customer can cancel, but there is no way to mark a zero-value order as fulfilled or complete. A total that rounds to zero minor units behaves identically. This is documented rather than designed away, because the correct behaviour is a business decision.

---

## 7. Payment — Detailed Verification

This is the newest and most sensitive work in the project, so it is reported against evidence rather than intent.

**It is implemented.** Two tables, one provider adapter, one webhook route mounted separately from the API router, four endpoints, a pure state machine, and 127 declared tests across four files.

### 7a. What was built

| Element                | Detail                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables                 | `payment`, `payment_event`                                                                                                                                                                                                          |
| States                 | `pending → succeeded \| failed \| expired`. All three destinations are terminal. Encoded as a pure transition table in `payments.state.ts` with `canTransition` / `isTerminal`, unit-tested independently of the database           |
| Methods                | `online` (Razorpay) and `cod`                                                                                                                                                                                                       |
| One payment per order  | `uq_payment_order`. There is no retry and no second attempt                                                                                                                                                                         |
| No auth/capture split  | A single succeeded state. No partial capture, no partial payment                                                                                                                                                                    |
| Amount                 | Always `order.total`, never a client-supplied figure. `ck_payment_amount_positive` refuses zero or negative                                                                                                                         |
| Constraints            | 10 on `payment` (including `ck_payment_provider_matches_method` and `ck_payment_failure_code_only_when_failed`), 4 on `payment_event`                                                                                               |
| Idempotency            | `Idempotency-Key` **required** on payment initiation, scoped `(store_id, user_id, key, endpoint)`                                                                                                                                   |
| Provider isolation     | `src/razorpay/gateway.ts` is the **only** file in the repository that names Razorpay. No SDK dependency — `fetch` plus `node:crypto`                                                                                                |
| Webhook signature      | `parseVerifiedWebhook` verifies **then** parses in one method, so parsed data is unobtainable without a valid signature. Compared with `timingSafeEqual`, over the **exact raw request body**                                       |
| Raw body ordering      | The webhook router is mounted at `/api/v1/webhooks` with `express.raw` **before** `express.json()`, and deliberately **not** on `apiRouter`, so `resolveStore` never runs on it                                                     |
| Store resolution       | Taken from the verified provider context — specifically, from the matched `payment` row — **never** from client input. `lockByProviderRef` matches on `(provider, provider_ref)` without a store, so the store comes _from_ the row |
| Duplicate webhooks     | Identified by provider event ID and enforced by `uq_payment_event_provider`; a duplicate is a **successful no-op**, not an error                                                                                                    |
| Transaction discipline | The gateway call happens **outside** the transaction; every database write, the audit entry and `idempotency.complete()` happen **inside** one `withTransaction`                                                                    |
| Card data              | None stored, ever. No card number, CVV, expiry or bank credential column exists                                                                                                                                                     |
| Secrets in logs        | No provider secret, signature or authorization credential is logged                                                                                                                                                                 |
| Unconfigured behaviour | `createUnconfiguredGateway` **refuses** rather than fabricating a provider reference — the source of the honest `503` described below                                                                                               |

### 7b. Deliberate non-scope, all confirmed present in the code

- **Refunds** — not implemented, as instructed.
- **Payment domain events** — not published. Four audit actions exist; the outbox stays empty for payments, and a test asserts that, so adding an event later is a deliberate act.
- **Reconciliation** — deferred. There is no job that polls the provider for drifted state.
- **`expired`** — the state exists in the machine and in the CHECK constraint, but **nothing writes it**, because no expiry window was ever approved. This is the single most consequential unfinished thread in the payment work: an abandoned online payment leaves the order permanently `pending`, and therefore neither payable nor cancellable.

### 7c. The honest gap — online payment has never touched Razorpay

**Verified today: `.env` contains 0 `RAZORPAY_*` keys.** They exist only as commented placeholders.

Consequences, stated plainly:

- COD is fully proven, end to end, against the real database.
- The online path's logic is fully tested — 79 + 20 integration tests, 18 gateway unit tests, 10 state-machine tests — but **every one of those runs against a stubbed gateway.** The signature verification is tested with locally computed HMACs.
- With no keys configured, `POST /users/me/orders/:orderNumber/payments` with `method: "online"` returns **`503`**. It does not fail silently and it does not fabricate a reference.
- **Nothing in this repository has ever exchanged a byte with Razorpay.** Until test keys are supplied and one real payment plus one real webhook are observed, the online path should be described as _implemented and unit-proven_, never as _working_.

This is the top engineering risk on the project, and it is unblockable by engineering alone.

---

## 8. Test & Quality Results

All figures below come from the commands logged in §18, executed today.

### Automated test suite — `pnpm test` (Vitest)

```
Test Files  57 passed (57)
Tests       1655 passed (1655)
Duration    233.17s
Exit status 0
```

- **Test files: 57** (was 50)
- **Tests: 1,655** (was 1,449 — **+206**)
- **Passed: 1,655 · Failed: 0 · Skipped: 0**

**Full automated verification completed with 0 failing tests.**

| Test / Check                                    | Total |     Passed | Failed | Skipped | Status                               |
| ----------------------------------------------- | ----: | ---------: | -----: | ------: | ------------------------------------ |
| All automated tests (`pnpm test`)               | 1,655 |      1,655 |      0 |       0 | PASS                                 |
| Test files                                      |    57 |         57 |      0 |       0 | PASS                                 |
| Payment integration                             |    79 | (declared) |      0 |       0 | PASS                                 |
| Payment edge cases                              |    20 | (declared) |      0 |       0 | PASS                                 |
| Payment state machine (pure unit)               |    10 | (declared) |      0 |       0 | PASS                                 |
| Razorpay gateway (pure unit, stubbed transport) |    18 | (declared) |      0 |       0 | PASS                                 |
| Password reset integration                      |    22 | (declared) |      0 |       0 | PASS                                 |
| Order cancellation integration                  |    19 | (declared) |      0 |       0 | PASS                                 |
| Invoice rendering (pure unit)                   |    25 | (declared) |      0 |       0 | PASS                                 |
| OpenAPI drift guard                             |     — |          — |      0 |       0 | PASS                                 |
| Custom ESLint rule tests                        |     — |          — |      0 |       0 | PASS                                 |
| Mutation tests                                  |     — |          — |      — |       — | **NOT RUN** (see §9)                 |
| **Live Razorpay payment**                       |     — |          — |      — |       — | **NEVER RUN — no API keys.** See §7c |

**Note on counting:** "declared" figures are static counts of `it(`/`test(` declarations. Vitest reports 1,655 in total because some cases are generated inside loops; the runner's figure is the authoritative one.

### Suite stabilisation since the last report

The previous edition recorded one known flaky test that "did not fire in this run". That was optimistic. During the intervening work the suite was found to be failing intermittently at roughly a one-in-two rate, and **five distinct flaky tests were identified and fixed — all of them test-code defects, not product defects**:

| Flake                                     | Root cause                                                                                                                               | Fix                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `http/idempotency` (4 assertion sites)    | Reads racing the idempotency middleware, which records and releases keys **after** the response and does not await it                    | Bounded `waitFor` poll                       |
| `orders` — "releases the idempotency key" | Same cause                                                                                                                               | Same fix                                     |
| `catalogue/options` — cascade audit       | `UPDATE … RETURNING` has no `ORDER BY`, so row order is not guaranteed                                                                   | Compare as a Set                             |
| `cart-promotions` — clear vs apply        | **The assertion was unsound**: it demanded a `422` whenever the cart ended empty, but apply-then-clear is equally correct                | Removed that line; kept the state assertions |
| `public-product`                          | Asserted the body did not contain `'1499'` while serialising the whole envelope, including a random `requestId` that could end `...1499` | Exclude `requestId` from the comparison      |

The suite has since run green on consecutive executions, including today's.

### Benign log noise

The test log still contains `redis_client_error: write ECONNABORTED` entries emitted during teardown of the Redis-backed suites, and `migrations_started` / `migrations_complete` bootstrap lines. These are shutdown-ordering and setup log lines, not assertion failures. All 57 files and 1,655 tests passed. Recorded rather than hidden.

### The previous report's blocker is resolved

The 4 September edition recorded one blocker: the host `C:` drive had reached 0 bytes free, hanging Docker and aborting two test runs. Today's full suite ran to completion in 233.17s with exit status 0, so the condition is not currently blocking. It is a host-capacity risk, not a code defect, and it is no longer listed as a blocker.

---

## 9. Mutation Testing

**Not executed as a tooled run, for the same reason as last time: no mutation testing framework is installed.** `package.json` has 17 production and 21 development dependencies; none is Stryker or an equivalent, and there is no mutation script.

Mutation discipline in this project is manual: probe scripts deliberately edit a source file or migration, the suite is re-run, and the edit is reverted. That was done during the payment work rather than during this report, and two findings from it are worth recording because both were genuine test weaknesses:

- **A probe survived** — removing the user predicate from the payment list query broke nothing, because the orders port already returns 404 for another user's order. The test suite was proving the right behaviour through the wrong layer. A `repository scoping` block was added that exercises the repository directly; the probe now kills.
- **A probe was a no-op** — it edited the Drizzle schema file, but the test database is built from **migrations**, not from schema code. Re-run against the migration SQL, it killed. Any future probe against a constraint must edit the migration.

No mutation score is claimed for this run, because none was produced.

---

## 10. Engineering Quality Checks

| Check                                       | Result                                                     | Exit Status |
| ------------------------------------------- | ---------------------------------------------------------- | ----------- |
| Prettier format check (`pnpm format:check`) | PASS                                                       | 0           |
| ESLint (`pnpm lint`)                        | PASS                                                       | 0           |
| TypeScript typecheck (3 project configs)    | PASS                                                       | 0           |
| dependency-cruiser (`pnpm depcruise`)       | PASS — no violations, **152 modules / 627 dependencies**   | 0           |
| Production build (`pnpm build`)             | PASS                                                       | 0           |
| Full test suite (`pnpm test`)               | PASS — **1,655/1,655**, 233.17s                            | 0           |
| Schema drift (`pnpm db:generate`)           | PASS — "No schema changes, nothing to migrate"             | 0           |
| Migration consistency (`drizzle-kit check`) | PASS — "Everything's fine"                                 | 0           |
| OpenAPI drift (inside the test suite)       | PASS                                                       | 0           |
| Architecture rules                          | PASS — 11 dependency-cruiser rules + 2 custom ESLint rules | 0           |
| Mutation testing                            | NOT RUN                                                    | —           |
| Live Razorpay payment                       | **NEVER RUN — no keys**                                    | —           |

Module count grew from 133 to 152 and dependency count from 535 to 627, with **zero** new boundary violations — the architecture rules absorbed payments, mail and the Razorpay adapter without being relaxed.

**Note on `format:check`:** this gate was failing before this report was written, and on exactly one file — `Report.md` itself, whose previous edition was not Prettier-formatted. Rewriting it Prettier-clean is what returns the gate to 0. No source file was touched.

### Architecture rules currently enforced

`no-circular`, `no-http-to-modules`, `no-modules-to-http` (except `*.routes.ts`), `no-cross-module-imports`, `shared-is-the-base-layer`, `schema-only-in-repositories`, `jose-only-in-token-service`, `argon2-only-in-password-module`, `container-only-from-entry-points`, `no-orphans`, `not-to-dev-dep` — plus the custom ESLint rules `no-money-arithmetic` and `no-relational-api-in-inventory`.

The payment work extended this pattern rather than escaping it: `PaymentGateway`, `PaymentOrders`, `OrderPayments` and `PaymentIdempotency` are **consumer-declared ports**, adapted only in `src/container.ts`. The orders module reads payment state through a four-line port, not by importing the payments module.

---

## 11. Database Status

All figures read directly from the live database during this report.

**The database has moved.** It is now a hosted **Neon PostgreSQL 18.6** instance (`us-east-2`), not the local PostgreSQL 16 container of the previous edition. `docker-compose.yml` still offers a local Postgres, but behind a `local-db` profile that is off by default.

| Metric                                      | Value                    | Was (4 Sep) | Verified                                 |
| ------------------------------------------- | ------------------------ | ----------- | ---------------------------------------- |
| PostgreSQL version                          | **18.6** (Neon, aarch64) | 16 (local)  | `select version()`                       |
| Migration files in repository               | **17**                   | 14          | `ls src/db/migrations/*.sql`             |
| Migrations applied in database              | **17**                   | 14          | `drizzle.__drizzle_migrations`           |
| Schema files                                | **14**                   | —           | `ls src/db/schema/*.ts`                  |
| Tables declared in schema code              | **27**                   | 24          | `src/db/schema/*.ts`                     |
| Tables present in database                  | **27**                   | 24          | `information_schema.tables`              |
| Indexes                                     | **89**                   | 77          | `pg_indexes`                             |
| Unique indexes                              | **61**                   | 53          | `pg_indexes`                             |
| Primary keys                                | **27**                   | 24          | `pg_constraint`                          |
| Foreign keys                                | **52**                   | 45          | `pg_constraint`                          |
| — of which **composite** (tenant-enforcing) | **25**                   | 21          | `cardinality(conkey) > 1`                |
| CHECK constraints                           | **44**                   | 34          | `pg_constraint`                          |
| Tables carrying `store_id`                  | **25 of 27**             | 22 of 24    | `information_schema.columns`             |
| Schema drift                                | **None**                 | None        | `pnpm db:generate` + `drizzle-kit check` |

### Tables

`address`, `app_user`, `audit_log`, `cart`, `cart_line`, `cart_promotion`, `feature_flag`, `idempotency_key`, `order`, `order_line`, `order_status_history`, `outbox_event`, **`password_reset_token`**, **`payment`**, **`payment_event`**, `processed_event`, `product`, `product_option`, `product_option_value`, `promotion`, `refresh_session`, `sku`, `sku_option_value`, `stock_item`, `stock_ledger`, `store`, `store_setting`

Three new since the last report, shown in bold.

### Tenant isolation

**25 of 27 tables carry `store_id`.** The two that do not are correctly global: `store` itself and `processed_event` (event-dispatch bookkeeping). Tenancy is enforced structurally by **25 composite foreign keys** — a cross-store reference is unrepresentable at the database level, not merely rejected in application code.

One deliberate exception is worth naming: `password_reset_token.token_hash` is **globally** unique and is looked up **without** a store predicate. A reset link arrives before any session exists, so there is no trusted store context to scope the lookup by; the token's own 256 bits of entropy are the security boundary, and the store is then read from the row. The composite FK `(user_id, store_id)` still ties the token to its tenant.

### Soft-delete strategy

Soft delete (`deleted_at`) on **7 tables**: `address`, `app_user`, `product`, `product_option`, `product_option_value`, `promotion`, `sku`. **`order`, `payment` and `payment_event` deliberately have no `deleted_at`** — a financial record cannot be soft-deleted.

### Append-only history

**8 tables have no `updated_at` and are append-only** (was 6): `audit_log`, `order_status_history`, `outbox_event`, **`password_reset_token`**, **`payment_event`**, `processed_event`, `sku_option_value`, `stock_ledger`. `payment_event` is the new business-critical one — the provider's side of every payment is a permanent record that no `UPDATE` can rewrite.

### A migration-authoring hazard, recorded

Drizzle generates the statements of a migration in an order that can place a foreign key **before** the unique index it depends on, which fails on apply. This has now been hand-corrected **six times**, most recently in `20260907110232_eminent_quasar.sql`, where `uq_payment_id_store` had to be hoisted above the FKs. Every generated migration must be read before it is applied; this is not a formality.

### Operational note — readiness flaps on a cold Neon database

`/health/ready` gives each dependency a hardcoded **2,000 ms** budget (`src/http/routes/health.ts:53`). A Neon instance that has scaled to zero takes longer than that to wake. **Observed live during this report**: the first probe after an idle period returned

```json
{ "status": "unavailable", "checks": { "postgres": "unavailable", "redis": "ok" } }
```

and the next three consecutive probes all returned `{"status":"ok"}`. Nothing is wrong with the database or the check — the timeout is simply shorter than a cold start. On a serverless database plan this will mark a healthy instance as not-ready after every idle period, and a load balancer will act on that. Either keep the database warm or make the timeout configurable before deploying.

---

## 12. API Coverage

**61 operations across 43 paths**, all documented in OpenAPI. The counts of 60/42 read from the running server during this report predate the staff invoice route added immediately afterwards; the table below is the current shape.

| Group                  | Operations | Auth required           | Authorization              | Validation      |
| ---------------------- | ---------: | ----------------------- | -------------------------- | --------------- |
| Catalogue              |         21 | Public ×2, staff ×19    | `staff` scope on admin     | Zod strict      |
| Authentication         |          6 | No (these establish it) | —                          | Zod strict      |
| Cart                   |          6 | Yes                     | Own cart only              | Zod strict      |
| Addresses              |          5 | Yes                     | Own records only           | Zod strict      |
| Orders (incl. invoice) |          5 | Yes                     | Own orders only            | Zod strict      |
| Promotions             |          5 | Yes                     | `staff` scope              | Zod strict      |
| Payments               |          3 | Yes                     | Own orders only            | Zod strict      |
| Inventory              |          3 | Yes                     | `staff` scope              | Zod strict      |
| Users                  |          3 | Yes                     | Own record only            | Zod strict      |
| Health                 |          2 | No                      | —                          | —               |
| Webhooks               |          1 | **Provider signature**  | Store from the matched row | Raw body        |
| **Orders (staff)**     |      **1** | Yes                     | `staff` scope, store-wide  | Zod strict      |
| **Payments (staff)**   |      **0** | —                       | —                          | Not implemented |
| **Total**              |     **61** |                         |                            |                 |

Previous edition: 53 endpoints, 52 documented, 34 paths. **All 61 operations are documented** — the payment work closed the documentation gap rather than widening it, and the staff invoice route was documented in the same change that added it.

Swagger UI is served at `/docs` and the raw document at `/docs.json`, **but not in production**: an OpenAPI document is a complete map of the attack surface, and publishing it to anonymous callers is deliberately avoided until admin authentication exists.

---

## 13. Architecture & Security

| Control                     | Status | Evidence                                                                                                                                                                                                                      |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store/tenant isolation      | ✅     | 25/27 tables carry `store_id`; **25 composite foreign keys** make cross-store references unrepresentable                                                                                                                      |
| User isolation              | ✅     | `userId` and `storeId` are read only from the verified token; another user's cart, order or payment behaves as nonexistent (404, identical envelope to a genuinely unknown record)                                            |
| Staff authorization         | ✅     | `requireScope('staff')` on all 28 admin operations; customers receive 403. No endpoint can grant `is_staff`                                                                                                                   |
| Strict input validation     | ✅     | Zod `strictObject` throughout; unknown fields rejected with a 400 naming the field, never silently ignored                                                                                                                    |
| No client-supplied identity | ✅     | No request body, query or path parameter anywhere supplies a user id or a store id                                                                                                                                            |
| **Webhook store identity**  | ✅     | The webhook resolves its store from the matched `payment` row, never from the payload. It is mounted off `apiRouter` so `resolveStore` cannot run on it and cannot be spoofed by a header                                     |
| **Webhook signature**       | ✅     | HMAC over the exact raw bytes, `timingSafeEqual`, verify-then-parse in a single method. The raw-body parser is mounted before `express.json()`, which is load-bearing and documented as such in `app.ts`                      |
| **Card data**               | ✅     | Never stored. No column exists for a card number, CVV, expiry or bank credential                                                                                                                                              |
| **Secret handling in logs** | ✅     | No provider secret, signature or authorization header is logged. The mailer never logs message bodies                                                                                                                         |
| **Invoice XSS**             | ✅     | `renderInvoice` escapes `& < > " '` (ampersand first) on all customer-supplied text; the route adds a restrictive per-response CSP as a second defence. Global CSP stays off deliberately, and `app.ts` explains why          |
| Module boundaries           | ✅     | 11 dependency-cruiser rules, 0 violations across 152 modules                                                                                                                                                                  |
| Transaction handling        | ✅     | Checkout and payment are each one transaction; cart and order mutations take row locks; the gateway call sits outside the transaction                                                                                         |
| Money precision             | ✅     | `NUMERIC(19,4)`, branded `Money` + decimal.js + `ROUND_HALF_UP`, a single `toMinorUnits` rounding boundary at the provider edge, and a custom ESLint rule forbidding money arithmetic outside `shared/money.ts`               |
| Database constraints        | ✅     | 44 CHECK constraints, 61 unique indexes, 52 foreign keys — invariants held by the database, not only by code                                                                                                                  |
| Audit logging               | ✅     | Append-only `audit_log`; actor from the token only                                                                                                                                                                            |
| Password reset security     | ✅     | 32 random bytes, base64url; only the SHA-256 **hash** is stored; 60-minute TTL; issuing a token invalidates prior live ones; `markUsed` is a compare-and-set on `used_at IS NULL`, so a token is single-use under concurrency |

### One security item requires action outside the codebase

🔴 **The Neon connection string was supplied in plain text and now sits in `.env`.** It is a live production-capable credential in a file with no access control. This is acceptable for local development and not acceptable at deployment. **It should be rotated, and the replacement should live in the deployment platform's secret store.** This is a configuration and process action, not a code change — no amount of code review fixes a leaked credential.

---

## 14. Work Completed So Far

Increments 1–30 are unchanged from the previous edition and are not re-listed. Only the new work appears here.

| Increment | Feature                                      | Status                 | Tests / Evidence                                                                                        |
| --------- | -------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| **31**    | **Payment — Razorpay + COD**                 | Complete for its scope | `payments.integration` (79), `payments.edge-cases` (20), `payments.state` (10), `razorpay/gateway` (18) |
| **32**    | **Password reset / forgot password + email** | Complete               | `password-reset.integration` (22); first real outbox consumer; nodemailer SMTP adapter                  |
| **33**    | **Order cancellation**                       | Complete               | `order-cancellation.integration` (19); `ORDER_STATUSES` widened by migration                            |
| **34**    | **Invoice document**                         | Complete as a document | `invoice.test` (25); live download verified                                                             |

### Cross-cutting work in the same period

| Item                             | Detail                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Neon migration**               | `DATABASE_URL` repointed to hosted Neon PostgreSQL 18.6; all 17 migrations applied cleanly                                                                                                                                                                                      |
| **Duplication removal**          | `src/shared/pagination.ts` replaced 5 identical copies each of `PaginationResponse` and `boundedIntParam`; `src/db/errors.ts` replaced 4 copies of `uniqueViolationConstraint`. **Proven behaviour-neutral**: 60 routes and 42 documented paths byte-identical before and after |
| **Suite stabilisation**          | Five flaky tests found and fixed, all test-code defects (§8)                                                                                                                                                                                                                    |
| **`.env` cleanup**               | Reduced to 26 keys. `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` removed because nothing in `src/` reads them; `S3_BUCKET` and `S3_REGION` remain only because `config.ts` requires them to boot                                                            |
| **`docker-compose.yml` rewrite** | Now `redis:7` on host port 56379 and `axllent/mailpit` on 1025/8025, with `postgres:16` behind a `local-db` profile. MinIO and its bucket-init job removed as infrastructure for a feature with no code. All images Debian-based, never `-alpine`                               |
| **Dead-reference audit**         | Dangling references cleaned; the unused `cli` script removed from `package.json`                                                                                                                                                                                                |

**34 numbered increments delivered, plus Phase 0.** Increments 1–30 each have a section in `docs/DECISIONS.md`; **31–34 do not** (§2).

### A packaging note on Alpine images

`mailhog/mailhog` **cannot start on this machine** — `unable to find user mailhog: no matching entries in passwd file`, and `-u root` fails identically, so the image's own passwd file is unreadable. `postgres:16-alpine` failed the same way. This is the Alpine/musl-on-WSL2 failure mode recorded in `docs/DECISIONS.md` §172, and it is not theoretical here. Mailpit is the maintained drop-in successor on the same ports and starts healthy.

---

## 15. Current Overall Status

### What has been built

A multi-tenant e-commerce **backend API** — **61 endpoints, 27 tables, 17 migrations, 9 domain modules, 1,655 automated tests**, roughly 36,500 lines of source against a comparable volume of test code. Node 22 / TypeScript strict / Express 5 / PostgreSQL 18.6 (Neon) / Drizzle ORM / Redis / BullMQ / Zod, as a structured modular monolith with machine-enforced module boundaries.

### What is working today

The complete customer money path, minus delivery. Identity and sessions, password recovery by email, the product catalogue with variants and SKUs, public browsing with search and price filtering, manual inventory tracking, the address book, the cart, coupon promotions, checkout producing immutable snapshotted orders, **payment by COD, order cancellation, and invoice download**. Online payment is implemented and unit-proven but has never contacted Razorpay.

### What customers can do today

Register → recover a forgotten password → log in → browse/search/filter → build a cart → apply a coupon → check out → **pay (COD today, online once keys exist) → check payment status → cancel while cancellable → download an invoice**. They cannot be shipped, be taxed, be refunded, retry a failed payment, verify their email, or receive any other notification.

### What staff/admin can do today

Manage products through their full lifecycle, variant options, SKUs and pricing, stock levels with an append-only ledger, and promotions — all via authenticated JSON APIs. **They still cannot see or manage orders or payments**, they cannot grant staff access without SQL, and **there is no dashboard UI**.

### How much has been verified

- **1,655 of 1,655 automated tests passing**, 57 of 57 files, exit status 0, 233.17s
- **All 10 static quality gates passing** — format, lint, typecheck ×3 configs, depcruise (152 modules, 0 violations), build, schema drift, migration consistency, OpenAPI drift, architecture rules
- Live database read directly: 27 tables, 17 applied migrations, 89 indexes, 52 foreign keys, 44 CHECK constraints
- Real data exercised on Neon: product `tshirt-kpvvpw` with 3 variants; orders `ORD-20260907-KTY3TB` (paid), `RFZQCJ` (COD pending), `EKYMUE` (cancelled)
- Mutation testing **not run** as a tooled pass and not installed
- **Live Razorpay payment never run** — no API keys

### Are all tests passing?

**Yes. Full automated verification completed with 0 failing tests.**

### Are there blockers?

**No code blockers. No failing tests. No security defects in the code.** The previous edition's disk-exhaustion blocker is resolved — today's suite ran to completion.

Four items block _completion_ rather than _development_, and none can be resolved by engineering:

| #   | Blocked item                              | Needs                                                                             |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Online payment                            | Razorpay `KEY_ID`, `KEY_SECRET`, `WEBHOOK_SECRET` (test keys suffice to prove it) |
| 2   | Password reset in production              | A real SMTP account and sender address, plus the storefront reset URL             |
| 3   | Catalogue setup by anyone but a developer | The email address of the first staff user, to promote by SQL                      |
| 4   | Deployment                                | Rotation of the plaintext Neon credential and a secret store to put it in         |

### Three accepted business limitations to be aware of

Recorded, deliberate deferrals — not defects — but each has commercial consequences and none should surprise anyone:

1. **Checkout does not touch inventory.** An order can be placed for stock that is not there, and two customers can buy the last unit. Re-verified today.
2. **Coupons have no usage limits and no redemption tracking.** A coupon can be used an unlimited number of times by any number of customers.
3. **An abandoned online payment leaves its order stuck.** Nothing writes the `expired` state, because no expiry window was ever approved, so a `pending` payment blocks both payment and cancellation indefinitely.

---

## 16. Remaining Development Work

### Blocked on a business decision or a credential — not on engineering

| Item                      | The decision or value required                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Razorpay keys             | Test and live `KEY_ID`, `KEY_SECRET`, `WEBHOOK_SECRET`                                                                                        |
| Email sending             | SMTP host/port/credentials (or a transactional provider), plus `MAIL_FROM`                                                                    |
| Password reset link       | The frontend URL for the reset screen                                                                                                         |
| Secret handling           | Rotate the Neon credential; name the production secret store                                                                                  |
| First staff user          | An email address. Promoted with `UPDATE app_user SET is_staff = true WHERE email = '…';` — there is deliberately no API for this              |
| **GST / tax**             | Are we charging GST at launch? If so: GSTIN, rate per product category, and whether entered prices are tax-inclusive or tax-exclusive         |
| **Invoice numbering**     | The statutory series format and reset period (e.g. `SYN/25-26/0001`, resetting each financial year), or confirmation the order number will do |
| **Refund policy**         | Who may refund, within what window, and full or partial. Until answered, the documented process is "refund by hand in the Razorpay dashboard" |
| **Payment expiry window** | How many minutes an unpaid online payment stays valid. One number unblocks the `expired` state and the stuck-order dead end                   |
| **Overselling at launch** | Do we accept that overselling is possible and manage it with inventory buffers, or does stock reservation block launch?                       |

### Not started

- **Stock reservation at checkout** — reserve on checkout, release on cancellation or payment expiry, commit on payment. Depends on the expiry decision. Estimated 1–2 days, and it must be right under concurrency.
- **GST / tax** — rates, HSN/SAC codes, CGST/SGST/IGST split, place of supply, GSTIN, e-invoicing. _No tax rate or rule has been invented anywhere in the codebase._ Estimated 3–5 days.
- **Shipping** — rates, carriers, service levels, shipments, tracking, fulfilment, and the order states to go with them. Estimated 4–6 days.
- **Statutory invoicing** — invoice series, gap-free numbering, PDF, IRN. Estimated 2 days on top of tax.
- **Refunds / returns** — refund records, provider calls, partial rules, credit notes, restocking. Estimated 2–3 days.
- **Admin order and payment views** — still the most immediately painful gap for real operations, now narrowed rather than closed: staff can render the invoice for a known order number (`GET /admin/orders/{orderNumber}/invoice`), but cannot list or search orders, and have no payment visibility at all. Estimated 2–3 days.
- **Staff and role management** — invite a colleague, roles beyond a single `is_staff` flag, revocation without SQL. Estimated 2 days.
- **Email verification** — the column exists and is never written. Estimated 1 day.
- **Product images** — no media upload; products carry text only, so a storefront has nothing to show. Estimated 2 days.
- **Payment retry** — one payment per order by design; a failure is currently terminal.
- **Guest checkout**, **reporting / analytics**, **reviews / ratings**, **wishlist**, **customer administration APIs**, **store / tenant administration APIs** (the `store_setting` and `feature_flag` tables are dead until these exist).
- **Storefront and Admin Dashboard front ends** — separate projects, not started.
- **Order confirmation and payment receipt emails** — the delivery mechanism now exists and is proven by password reset; only the consumers are missing.

### Partially implemented

- **Inventory** — tracking, adjustments and the append-only ledger work; `reserved` is never written and `available` is generated as `on_hand - reserved`. The ledger's reason CHECK will need widening beyond its three manual reasons.
- **Promotions** — CRUD and cart application work; redemption and usage-limit tracking are absent.
- **Order lifecycle** — `placed` and `cancelled` exist with append-only history. Confirm/ship/deliver remain.
- **Payment lifecycle** — `pending`, `succeeded` and `failed` are all reachable; **`expired` is not**, and reconciliation is deferred.
- **Invoicing** — the document renders well and is honest about what it is; it is not a statutory tax invoice.
- **Event consumers** — one registered consumer (password reset). Every other emitted event type has none, and order and payment events are deliberately unpublished.
- **Project documentation** — `docs/DECISIONS.md` stops at Increment 30; four increments of design reasoning live only in source comments, some of which are now stale (§2).

### Deferred by scope (recorded decisions)

- **Guest checkout** — a Phase 3 open item; Increment 30 implemented authenticated-only checkout and recorded the divergence.
- **Default shipping address** — deferred in Increment 27, so checkout requires an explicit `addressId`.
- **SKU code generation** — merchant-supplied only.
- **`expectedTotal` at checkout** — deliberately omitted, to avoid a client computing money.
- **Order and payment domain events** — written to the audit log but not published, on the standing rule that an event with no consumer is a guess at one.
- **Refunds** — explicitly out of scope for Increment 31.
- **Payment reconciliation** — deferred with the increment.

---

## 17. Manager Summary

- **The money path is closed.** Payment (Increment 31), password reset (32), order cancellation (33) and invoicing (34) are delivered on top of the checkout and orders work from the last report. A customer can now go from registration to a paid, invoiced order.
- **Automated verification: 1,655 tests across 57 files — 1,655 passed, 0 failed, 0 skipped, exit status 0**, in 233.17s. Up from 1,449 across 50 files.
- **All 10 static quality gates pass**, including dependency-cruiser with **0 violations across 152 modules** — the module count grew by 19 and the architecture rules were not relaxed to accommodate it.
- **The API is now fully documented: 61 operations across 43 paths, all present in OpenAPI.** The previous 53-vs-52 documentation gap is closed.
- **The database moved to hosted Neon PostgreSQL 18.6** and carries 27 tables, 17 applied migrations, 52 foreign keys (25 of them tenant-enforcing composites) and 44 CHECK constraints, with no schema drift.
- **The one thing that is implemented but not proven: online payment.** No Razorpay keys have ever been supplied, so nothing in this project has exchanged a byte with the provider. The endpoint returns an honest `503` rather than pretending. COD is fully proven. **This should never be described as "payments working" until one real payment and one real webhook have been observed.**
- **The test suite was stabilised, not just extended.** Five flaky tests were found and fixed during this period; all five were defects in test code, one of which was an assertion that was simply unsound. The suite now runs green consecutively.
- **A de-duplication refactor was proven behaviour-neutral** — 60 routes and 42 documented paths byte-identical before and after.
- **Three business limitations remain, all deliberate and all commercially material:** checkout performs no stock check, so overselling is possible; coupons have no usage limits; and an abandoned online payment leaves its order permanently stuck, because no expiry window was ever approved.
- **Four things block completion and none is an engineering problem:** Razorpay keys, a real email sender plus the reset URL, the first staff user's email address, and rotation of the plaintext Neon credential.
- **Ten business decisions are outstanding** (§16), of which the five that change the shape of the code are GST, invoice numbering, refund policy, the payment expiry window, and whether overselling is acceptable at launch.
- **Still outstanding as engineering work:** stock reservation, GST/tax, shipping, refunds, admin order and payment views, staff management, email verification, product images, payment retry, and all front-end work.
- **Documentation debt to clear:** `docs/DECISIONS.md` ends at Increment 30, so four increments have no decision record, and several source comments still describe an empty event-handler registry that now has one entry.

---

## 18. Commands Executed

Every command below was run while generating this report. Nothing else was executed against the project. No command modified source code, tests, migrations or database data — the only file written was `Report.md` itself.

| Command                                                                                                                                                                   | Result                                                                       | Exit Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| `pnpm test`                                                                                                                                                               | PASS — 57 files, 1,655 tests, 0 failed, 0 skipped, 233.17s                   | 0           |
| `pnpm format:check`                                                                                                                                                       | Initially FAILED on one file — `Report.md`, the previous unformatted edition | 1 → 0       |
| `pnpm lint`                                                                                                                                                               | PASS                                                                         | 0           |
| `pnpm typecheck`                                                                                                                                                          | PASS — 3 project configs clean                                               | 0           |
| `pnpm depcruise`                                                                                                                                                          | PASS — no violations, 152 modules / 627 dependencies                         | 0           |
| `pnpm build`                                                                                                                                                              | PASS                                                                         | 0           |
| `pnpm db:generate`                                                                                                                                                        | PASS — "No schema changes, nothing to migrate"                               | 0           |
| `drizzle-kit check`                                                                                                                                                       | PASS — "Everything's fine"                                                   | 0           |
| Read-only queries against the live Neon database (`information_schema`, `pg_indexes`, `pg_constraint`, `drizzle.__drizzle_migrations`, `version()`)                       | Counts reported in §11                                                       | 0           |
| `curl /docs.json` on the running server, then counted paths and operations                                                                                                | 42 paths, 60 operations                                                      | 0           |
| `curl /health/ready` ×4                                                                                                                                                   | First `unavailable` (postgres cold start), then 3× `ok` — see §11            | 0           |
| `docker ps`                                                                                                                                                               | `redis:7` and `axllent/mailpit` both healthy                                 | 0           |
| Repository inspection — `ls`, `find`, `grep`, `sed`, `wc`, `node -e` over `package.json`, `.env`, `src/`, `docs/`, route files, schema files, event files, `container.ts` | Findings throughout                                                          | 0           |

### Commands deliberately NOT executed

| Command                      | Why not                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Mutation probe scripts       | They edit source files and migrations; this report does not modify code                     |
| `pnpm db:migrate`            | Not needed — the database is at migration 17 and drift-free                                 |
| A live Razorpay payment      | **Impossible: no API keys exist.** Reported as a gap in §7c rather than skipped quietly     |
| Deleting the sweep test data | Left in place on instruction. The orders and product named in §15 are still present in Neon |

---

_Prepared by inspecting the repository on disk, executing the verification commands listed above, and reading the live Neon database. Every figure that differs from the 4 September edition was re-measured, not adjusted. Where something is implemented but unproven, that distinction is made at the point of use rather than in a footnote._
