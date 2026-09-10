# Admin + User End-to-End Flow — Coverage Log

**Status:** written 2026-09-10 · companion to `tests/e2e/admin-user-endpoint-coverage.e2e.test.ts`

This document explains what the new test file does, why it exists next to the one that was
already there, exactly which routes each one exercises, how to run them, and the honest result
of trying to run them in the sandbox this was authored in.

## 1. What was added

One new file: **`tests/e2e/admin-user-endpoint-coverage.e2e.test.ts`**.

It follows the exact pattern the codebase had already established in
`tests/e2e/full-flow-walkthrough.e2e.test.ts`:

- Boots a real PostgreSQL and a real Redis via Testcontainers (`tests/helpers/postgres.ts`,
  `tests/helpers/redis.ts`) — no mocks for the database or the cache.
- Calls `buildContainer(...)` — the same composition root `src/main.ts` uses in production — so
  the HTTP surface under test is the real Express app, real middleware chain, real services.
- Substitutes only `globalThis.fetch`, so the Razorpay gateway talks to a stub instead of the
  internet; its HMAC signing, persistence, and webhook de-duplication all still run for real.
- Creates a **brand-new admin** (registered like any customer, then promoted with
  `app_user.is_staff = true` directly against the database — there is deliberately no endpoint
  that grants staff, so this is the only way, matching how the existing walkthrough does it) and
  a **brand-new customer**, both from scratch.
- Narrates every call to stdout via `process.stdout.write` (not `console.log`, which Vitest
  buffers and groups under the test — that collapses to nothing once output is piped to a file).

### Why a second file instead of extending the first

`full-flow-walkthrough.e2e.test.ts` is deliberately a **single straight-line story**: one
product, one purchase, one shipment, one return. It says so in its own header comment. Bending
it to also hit every `GET .../list`, every `PATCH`, and every `DELETE` would turn a narrative
anyone can read in one scroll into an unreadable checklist, which defeats the point of that file.

The new file is explicitly the **checklist**: it exists to reach every route the happy path
does not, and its own header comment cross-references the happy-path file and
`tests/audit/endpoint-inventory.test.ts` (the pre-existing test that walks the real Express
router tree and diffs it against the OpenAPI document) so a reader knows where each kind of
guarantee lives.

## 2. Route coverage

The table below is the full route inventory (88 registered `/api/v1` + `/health` + `/docs`
routes, matching what `tests/audit/endpoint-inventory.test.ts` enumerates from the live
container), marked against which narrated walkthrough exercises it.

`F` = `full-flow-walkthrough.e2e.test.ts`, `C` = `admin-user-endpoint-coverage.e2e.test.ts` (new).

| Method | Path                                         | F   | C   |
| ------ | -------------------------------------------- | --- | --- |
| GET    | /health/live                                 |     | ✅  |
| GET    | /health/ready                                |     | ✅  |
| GET    | /docs.json                                   |     | ✅  |
| GET    | /docs                                        |     | ✅  |
| POST   | /auth/register                               | ✅  | ✅  |
| POST   | /auth/forgot-password                        |     | ✅  |
| POST   | /auth/reset-password                         |     | ✅¹ |
| POST   | /auth/login                                  | ✅  | ✅  |
| POST   | /auth/refresh                                |     | ✅  |
| POST   | /auth/logout                                 |     | ✅  |
| GET    | /users/me                                    |     | ✅  |
| PATCH  | /users/me                                    |     | ✅  |
| POST   | /users/me/password                           |     | ✅  |
| POST   | /users/me/addresses                          | ✅  | ✅  |
| GET    | /users/me/addresses                          |     | ✅  |
| GET    | /users/me/addresses/:id                      |     | ✅  |
| PATCH  | /users/me/addresses/:id                      |     | ✅  |
| DELETE | /users/me/addresses/:id                      |     | ✅  |
| GET    | /users/me/cart                               |     | ✅  |
| PUT    | /users/me/cart/items/:skuCode                | ✅  | ✅  |
| DELETE | /users/me/cart/items/:skuCode                |     | ✅  |
| DELETE | /users/me/cart                               |     | ✅  |
| PUT    | /users/me/cart/promotion                     | ✅  | ✅  |
| DELETE | /users/me/cart/promotion                     |     | ✅  |
| GET    | /users/me/tax-identity                       |     | ✅  |
| PUT    | /users/me/tax-identity                       |     | ✅  |
| DELETE | /users/me/tax-identity                       |     | ✅  |
| POST   | /users/me/checkout                           | ✅  | ✅  |
| GET    | /users/me/orders                             |     | ✅  |
| GET    | /users/me/orders/:n                          | ✅² | ✅  |
| POST   | /users/me/orders/:n/cancel                   |     | ✅  |
| GET    | /users/me/orders/:n/invoice                  | ✅  | ✅² |
| GET    | /users/me/orders/:n/payments (payments list) |     | ✅  |
| POST   | /users/me/orders/:n/payments                 | ✅  | ✅  |
| GET    | /users/me/orders/:n/payment                  | ✅  | ✅² |
| GET    | /users/me/orders/:n/shipments                | ✅  | ✅² |
| POST   | /users/me/orders/:n/returns                  | ✅  | ✅  |
| GET    | /users/me/returns                            | ✅  | ✅² |
| GET    | /users/me/returns/:n                         |     | ✅  |
| POST   | /users/me/returns/:n/cancel                  | ✅  |     |
| POST   | /webhooks/razorpay                           | ✅  | ✅  |
| GET    | /products                                    | ✅  | ✅² |
| GET    | /products/:slug                              |     | ✅  |
| POST   | /admin/products                              | ✅  | ✅  |
| GET    | /admin/products                              |     | ✅  |
| GET    | /admin/products/:slug                        |     | ✅  |
| PATCH  | /admin/products/:slug                        |     | ✅  |
| DELETE | /admin/products/:slug                        |     | ✅  |
| POST   | /admin/products/:slug/publish                |     | ✅  |
| POST   | /admin/products/:slug/archive                |     | ✅  |
| POST   | /admin/products/:slug/skus                   | ✅  | ✅  |
| GET    | /admin/products/:slug/skus                   |     | ✅  |
| PATCH  | /admin/skus/:code                            |     | ✅  |
| DELETE | /admin/skus/:code                            |     | ⚠️³ |
| POST   | /admin/products/:slug/options                |     | ✅  |
| GET    | /admin/products/:slug/options                |     | ✅  |
| PATCH  | /admin/options/:id                           |     | ✅  |
| DELETE | /admin/options/:id                           |     | ✅  |
| POST   | /admin/options/:id/values                    |     | ✅  |
| PATCH  | /admin/option-values/:id                     |     | ✅  |
| DELETE | /admin/option-values/:id                     |     | ✅  |
| PUT    | /admin/skus/:code/options                    |     | ✅  |
| GET    | /admin/orders/:n/invoice                     |     | ✅  |
| GET    | /admin/orders/fulfilment                     |     | ✅  |
| POST   | /admin/orders/:n/shipments                   | ✅  | ✅  |
| GET    | /admin/orders/:n/shipments                   |     | ✅  |
| POST   | /admin/shipments/:id/ship                    | ✅  | ✅  |
| POST   | /admin/shipments/:id/deliver                 | ✅  | ✅  |
| PATCH  | /admin/shipments/:id                         |     | ✅  |
| GET    | /admin/inventory                             |     | ✅  |
| POST   | /admin/inventory/adjustments                 | ✅  | ✅  |
| GET    | /admin/inventory/:skuCode/history            |     | ✅  |
| POST   | /admin/promotions                            | ✅  | ✅  |
| GET    | /admin/promotions                            |     | ✅  |
| GET    | /admin/promotions/:code                      |     | ✅  |
| PATCH  | /admin/promotions/:code                      |     | ✅  |
| DELETE | /admin/promotions/:code                      |     | ✅  |
| GET    | /admin/returns                               | ✅  |     |
| GET    | /admin/returns/:n                            | ✅  |     |
| POST   | /admin/returns/:n/approve                    | ✅  | ✅  |
| POST   | /admin/returns/:n/reject                     | ✅  |     |
| GET    | /admin/store/tax-profile                     |     | ✅  |
| PUT    | /admin/store/tax-profile                     | ✅  | ✅  |
| POST   | /admin/tax-classes                           | ✅  | ✅  |
| GET    | /admin/tax-classes                           |     | ✅  |
| PATCH  | /admin/tax-classes/:code                     |     | ✅  |
| POST   | /admin/tax-classes/:code/rates               | ✅  | ✅  |
| GET    | /admin/tax-classes/:code/rates               |     | ✅  |
| PUT    | /admin/skus/:code/tax                        | ✅  | ✅  |

¹ `reset-password` is exercised only on its failure path (an invalid token → `400
INVALID_RESET_TOKEN`) and `forgot-password` only proves the account-existence oracle stays shut
(same `204` for a known and an unknown address). Completing a real reset needs the plaintext
token, which never touches the database — only its digest does — and only ever reaches the
customer through the mail the SMTP transport sends. `buildContainer` wires a real
`createSmtpMailer` with no override hook, so intercepting that mail is out of scope for a test
built against the real composition root. `src/modules/identity/__tests__/password-reset.integration.test.ts`
already covers the full round trip by wiring the identity module directly with a recording
mailer double — that is the place a broken token or a broken link would be caught.

² Reached by the new file too, but as a secondary check inside a section named for something
else (e.g. `GET /users/me/orders/:n` is read while proving cross-customer isolation is not what
this file is about — it is read as part of confirming order #1's state before payment).

³ **The one gap.** `DELETE /admin/skus/:code` is registered and documented but not called by
either walkthrough. Both files needed their SKU alive through to the end (checkout, payment,
shipment, return all reference it), so deleting it would have broken later sections. It is
covered by `src/modules/catalogue/__tests__/delete-product.integration.test.ts` and the
catalogue integration suite generally; adding it to a narrated walkthrough would mean either a
third disposable SKU or reordering sections, which was judged not worth the added length here.

**Net: 87 of 88 registered routes are exercised by these two narrated walkthroughs combined**,
with the one exception named honestly above and covered by an existing integration test instead.
`tests/audit/endpoint-inventory.test.ts` is the mechanical source of truth for the 88 — it fails
the whole suite if a route is ever registered without being documented, or documented without
being registered, so that count cannot silently drift.

## 3. What each new section proves

The new file is organised into ten sections, each its own `it()` (so a failure in section 6
does not hide whether section 9 also failed):

1. **Actors + infrastructure** — health checks, the OpenAPI document, Swagger UI, then both
   accounts are created and signed in.
2. **Admin catalogue depth** — the full product/SKU/option lifecycle: create, list, patch,
   publish (draft → active, provably changes storefront visibility), a second product created
   already-active then archived (active → archived, provably removes it) and soft-deleted, plus
   creating and then retiring a product option and its value.
3. **Admin promotions / tax / inventory depth** — list, get-by-code, patch, and a disposable
   coupon created and deleted immediately to prove the delete route; the store tax profile,
   tax-class list/patch, rate list, and both inventory read routes (the stock list and one SKU's
   append-only ledger history).
4. **Customer address book, cart lifecycle, GST identity** — two addresses so list/get/patch/
   delete all have something real to act on; a full cart cycle (empty → add → read → apply and
   remove a coupon → remove one line → clear entirely → refill); a GST identity registered, read
   back, and removed.
5. **Two orders** — one is checked out, paid via the signed Razorpay webhook, and carried through
   to fulfilment and the payments list; the second is checked out and then **cancelled while
   still unpaid**, including proving a second cancel attempt on the same order is refused
   (`409`) — the cancellation path the happy-path walkthrough explicitly cannot reach, because
   its order gets paid.
6. **Admin fulfilment depth** — the work queue before and after (proving a delivered order
   leaves it), the staff-side per-order shipment list, and a tracking-number correction applied
   mid-shipment via `PATCH`.
7. **Returns single-record reads** — the customer's and staff's `GET .../returns/:n` views,
   confirming the customer response has no `staffNote` field at all (not merely a null one).
8. **Identity self-service** — profile read/patch, the forgot/reset-password oracle-safety
   checks, a password change that revokes every session, proving the _old_ refresh token is
   dead afterward, a working refresh **rotation**, proving a _reused_ (already-rotated) refresh
   token is refused, and logout.
9. **Authorization boundary** — a sampling of the staff-only routes this file itself just used,
   proven `403` for a customer token (the exhaustive `401`/`403`/`200` boundary proof already
   lives in `full-flow-walkthrough.e2e.test.ts` §2; this section is a spot-check, not a repeat).
10. **Summary** — prints what was created, for a human reading the transcript top to bottom.

## 4. How to run it

Both walkthroughs need Docker (they provision real Postgres and Redis containers via
Testcontainers — see `tests/helpers/postgres.ts` / `tests/helpers/redis.ts`, which explain why a
mock database is the wrong tool for the things under test here: `FOR UPDATE SKIP LOCKED`,
transaction rollback, `ON CONFLICT DO NOTHING`).

```bash
# one file, with the transcript printed live (not swallowed by Vitest's reporter)
pnpm exec vitest run tests/e2e/admin-user-endpoint-coverage.e2e.test.ts

# both narrated walkthroughs together
pnpm exec vitest run tests/e2e/

# save the transcript to disk
pnpm exec vitest run tests/e2e/admin-user-endpoint-coverage.e2e.test.ts > coverage-walkthrough.log
```

Static checks (which do not need Docker or a running database) pass cleanly for the new file:

```bash
pnpm exec tsc --noEmit -p tsconfig.test.json   # clean
pnpm exec eslint tests/e2e/admin-user-endpoint-coverage.e2e.test.ts   # clean
pnpm exec prettier --check tests/e2e/admin-user-endpoint-coverage.e2e.test.ts   # clean
```

## 5. What actually happened in this session, honestly

This environment has **no Docker daemon available** (`docker info` fails). Both the pre-existing
`full-flow-walkthrough.e2e.test.ts` and the new `admin-user-endpoint-coverage.e2e.test.ts` fail
identically at the same first line — `startTestDatabase()` — with:

```
Error: Could not find a working container runtime strategy
 ❯ PostgreSqlContainer.start …
 ❯ startTestDatabase tests/helpers/postgres.ts:126:49
```

That was verified directly: running the **existing, previously-passing** walkthrough file in
this same sandbox produces the exact same error at the exact same point, which confirms the
failure is this sandbox lacking a container runtime — not a defect in the new test. Nothing in
this repository's e2e or integration suite can execute here for that reason; it is a property of
this environment, not of the code.

What _was_ verified here, directly, against the real toolchain:

- **Typecheck** (`tsc --noEmit -p tsconfig.test.json`) — clean.
- **Lint** (`eslint`) — clean (one `no-unnecessary-type-assertion` finding was fixed during
  authoring by dropping an unneeded cast in the authorization-boundary loop).
- **Format** (`prettier --check`) — clean.
- **Route/DTO correctness by inspection** — every path, HTTP method, request schema, and
  response envelope used in the new file was read directly from the corresponding
  `*.routes.ts` and `dto.ts` source before being written into the test, rather than guessed.

**To get an executed transcript**, run this file with Docker Desktop (or another
Testcontainers-compatible runtime) available — locally, or in CI where the project's other e2e
tests already run. Nothing about the new file's requirements differs from the file that already
runs successfully in CI today.
