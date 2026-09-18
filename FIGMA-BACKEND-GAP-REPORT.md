# Figma → Backend Gap Report (v2, re-verified)

**Scope:** The ShopFlow / Duroflo Pumps admin dashboard Figma set — Login, Sign up, Business Onboarding, Dashboard, Products (list/grid/add-wizard/variants/inventory), Orders (list/detail), Shipments (list/create-wizard/tracking), Customers, Returns & Refunds, Payments, Reports, Coupons, Notifications, Settings (10 sub-screens) — against this repo on `feat/admin-orders-day1`.

**Method:** All 87 routes across 12 `*.routes.ts` files extracted, then each one's Zod query/body schema and backing table in `src/db/schema/` read. A claim of "missing" means no endpoint **and** no column.

> ### ⚠️ v3 — THE TREE MOVED MID-ANALYSIS
>
> **Increment 57 landed as uncommitted work while this report was being written.** Everything below was written against the earlier tree. Corrections, verified against the working tree:
>
> - **The Dashboard is BUILT.** `GET /admin/dashboard` (`src/modules/dashboard/`) returns KPIs with previous-period values, `salesSeries` with an `interval`, `orderStatusCounts`, `topProducts`, `lowStock`, and `recentOrders`, all over a `from`/`to` window. It covers **every widget** on the Dashboard Overview screen. Part B2's "Dashboard — zero backend" row is **wrong**.
> - **A low-stock threshold EXISTS.** `sku.lowStockThreshold` (`catalogue.ts:299`), with NULL meaning "never warn" and low defined as `available > 0 AND available <= threshold`. The repeated claim that "low has no definition" is **out of date**.
> - **The customers list is FIXED.** It now returns `phone`, `orderCount`, `totalSpent`, `lastOrderAt` and a `counts: {total, active, inactive}` block, with `q` searching name, email and phone (digits-only matching for phone). Part A2's customers row is **wrong**.
>
> **Still true after re-checking:** `GET /admin/products` is pagination-only; there is no unpublish; `GET /admin/promotions`, `GET /admin/inventory` and `GET /admin/returns` are still thin; Settings, Reports, Notifications, RBAC, media and refunds are all still absent.
>
> **New gap found in v3:** `sku.lowStockThreshold` is **read but never written.** The inventory repository queries it (`inventory.repository.ts:289-300`) and the dashboard renders it, but **no route or DTO sets it** — `CreateSkuRequestSchema` and the SKU patch schema have no such field. The Add Product screen's "Low Stock Threshold" input has a column and a reader but no writer, so every threshold is NULL and the Low Stock Alert is permanently empty.

**v2 corrections over the first pass** (first pass under-counted routes):
- `GET /admin/shipments` and `GET /admin/shipments/:id` **do exist** — a store-wide shipment list with transition history. Previously reported missing.
- `GET /admin/orders/:orderNumber/payment` (admin) **exists**. Previously missed.
- The invoice endpoint returns **HTML**, not JSON and not PDF.
- `GET /admin/products` is **worse** than first reported: pagination only, no search/status/category filter.
- `GET /admin/payments` filtering is **better** than first reported, but its response omits the transaction ID by design.

---

## PART A — WHAT YOU ALREADY HAVE

### A1. Fully built, screen is servable today

| Screen / feature | Endpoints |
|---|---|
| **Login / Sign up / Forgot / Reset password** | `POST /auth/register`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/refresh`, `/auth/logout` |
| **Orders List** — tabs, filters, search, pagination | `GET /admin/orders` with `displayStatus`, `paymentStatus`, `shipmentStatus`, `placedFrom/To`, `q` (order no. or customer email) |
| **Orders List** — tab counts | `GET /admin/orders/summary` → `byDisplayStatus`, `byPaymentStatus`, `byShipmentStatus` |
| **Order Details** — header, items, totals, tax, address, promotion | `GET /admin/orders/:orderNumber` |
| **Print Invoice** | `GET /admin/orders/:orderNumber/invoice` → rendered HTML, CSP-locked |
| **Settings → Tax** (GSTIN, tax classes, rates, per-SKU tax) | `GET/PUT /admin/store/tax-profile`, `POST/GET/PATCH /admin/tax-classes`, `POST/GET /admin/tax-classes/:code/rates`, `PUT /admin/skus/:code/tax` |
| **Customer detail → Order List** | `GET /admin/customers/:customerId/orders` |
| **Shipment Tracking timeline** (storage side) | `GET /admin/shipments/:id` returns the shipment plus its full transition history |
| **Order Details → Payment Information** | `GET /admin/orders/:orderNumber/payment` |

### A2. Built, but the screen needs more fields/filters than the endpoint returns

| Screen | Endpoint exists | What the screen needs that it doesn't give |
|---|---|---|
| **Products list** | `GET /admin/products` | **only `limit`/`offset`** — no `q` search, no `status` filter (All/Active/Draft tabs), no category, no stock status, no counts |
| **Product CRUD** | `POST/GET/PATCH/DELETE /admin/products/:slug` | no media, category, brand, specs, SEO, shipping fields |
| **Variants** | `/admin/products/:slug/skus`, `/admin/skus/:code`, options + option-values CRUD, `PUT /admin/skus/:code/options` | no MRP, no discount type/value, no low-stock threshold, no per-variant media, no bulk "Generate Variants" |
| **Publish / Draft toggle** | `POST /admin/products/:slug/publish`, `/archive` | **no unpublish** — `catalogue.routes.ts:346` says so explicitly. Active → Draft is impossible |
| **Inventory tab** | `GET /admin/inventory`, `/summary`, `POST /admin/inventory/adjustments`, `GET /admin/inventory/:skuCode/history` | pagination only — no SKU search, no stock-status filter, **no low-stock concept at all** |
| **Shipments list** | `GET /admin/shipments` | filters are `status` + exact `orderNumber` only — no date range, no carrier, no type; no AWB column, no ship-from |
| **Create Shipment** | `POST /admin/orders/:orderNumber/shipments` | takes carrier/tracking as free text — no rate quotes, weight, dimensions, service type, cost breakdown |
| **Ship / Deliver** | `POST /admin/shipments/:id/ship`, `/deliver`, `PATCH /admin/shipments/:id` | only 3 statuses; no In Transit / Out for Delivery / RTO / Ready to Ship |
| **Customers list** | `GET /admin/customers` | returns `id, email, firstName, lastName, isActive, createdAt, updatedAt`. Screen renders **Mobile, Orders, Total Spent, Last order Date** — none present. Filters are `isActive` + `createdFrom/To`; **no name/mobile/email search** |
| **Returns list** | `GET /admin/returns`, `/summary`, `/:returnNumber` | filter is a single `status` + pagination. No search, no date range |
| **Returns actions** | `POST /admin/returns/:n/approve`, `/reject` | `received` and `inspected` exist in the enum but **have no endpoint**. No refund, no pickup scheduling |
| **Payments list** | `GET /admin/payments` — good filters: `status`, `method`, `provider`, `orderNumber`, `providerRef`, `createdFrom/To` | response **deliberately omits `providerRef`** (`dto.ts:278`), so the screen's **Transaction ID** column has no source. Also no customer name, no `network`/instrument, no order total |
| **Coupons list** | `GET /admin/promotions` | **pagination only** — no status filter, no search, no usage count |

---

## PART B — WHAT IS MISSING

### B1. Structural blockers — schema, not routes

These need a decision before any endpoint can be written.

**1. Order status is a two-value enum.** `src/db/schema/orders.ts:91` → `['placed','cancelled']`. The compensator at `src/modules/orders/order-display-status.ts:35` derives 7 display statuses from payment + shipment state, covering most tabs. **Unrepresentable:** `ready_to_ship`, `out_for_delivery`, `returned`. And because status is *derived*, the Order Details **status dropdown** ("Ready to ship ▾") has nothing to write to — there is no `PATCH /admin/orders/:n/status` and there cannot be one without a real status column.

**2. Shipment has no carrier integration surface.** `carrier` is a free-text varchar; statuses are `['pending','shipped','delivered']`. Absent: delivery method, courier partner + service type as entities, package weight/L×W×H, volumetric vs dead weight, rate quotes, cost breakdown, AWB as a distinct field, ship-from location. The 7-step tracking timeline can be *stored* (`shipmentEvent` is append-only) but only across 3 statuses.

**3. No locations / warehouses.** `src/db/schema/inventory.ts:90` — `stockItem.skuId` is the **primary key**, so stock is single-location by construction. `store` is the tenant, not a place. Settings → Stores and "Main Bengaluru Warehouse" need a new table plus changes to the reservation logic and every fulfilment query.

**4. No RBAC.** `identity.ts:42-43` has `isStaff` / `isSuperuser`; `scope.ts:84` derives exactly those two scopes. Users & Roles needs `role`, `permission`, `role_permission`, `user_role`, `staff_invitation`, and `requirePermission('orders.write')` replacing `requireStaff`.

**5. No media storage.** No table, no column, no multipart handler anywhere in `src/http/`. Blocks product images, every list thumbnail, return evidence photos, business logo, avatars.

### B2. Whole screens with zero backend

| Screen | What is needed |
|---|---|
| **Dashboard Overview** | `GET /admin/dashboard/metrics?from&to` (4 KPI tiles + MoM delta); `GET /admin/analytics/sales?metric=revenue\|orders&interval=month`; `GET /admin/analytics/top-products`. Order-status donut can reuse `/admin/orders/summary`. **Low Stock Alert is blocked** — `inventory.routes.ts:94`: *"no reorder threshold, so 'low' has no definition."* |
| **Reports** | `GET /admin/reports/types`, `POST /admin/reports` (async), `GET /admin/reports`, `GET /admin/reports/:id/download`, `DELETE /admin/reports/:id`, plus a job runner and file storage. `src/db/outbox/` could host the job. |
| **Notifications** | `notification` table; `GET /admin/notifications`, `/unread-count`, `POST /:id/read`, `/read-all`; SSE or WebSocket for live badges; emission from the existing outbox. |
| **Settings** (9 of 10 sub-screens) | See B3. |
| **Business Onboarding** | `POST /onboarding/business-type` and merchant store provisioning. `src/modules/stores/` has a repository and a resolver but **no routes file** — a merchant signing up today has no way to get a store. |

### B3. Settings sub-screens

| Sub-screen | Status |
|---|---|
| Tax | ✅ **fully built** |
| Business Profile (logo, legal name, GSTIN, phone, address, currency, timezone) | ❌ `GET/PUT /admin/store/profile` — **but most columns already exist on `store`**, so this is pure HTTP work |
| Profile (name, email, phone) | 🟡 `GET/PATCH /users/me` exists; avatar ❌ |
| Password | 🟡 `POST /users/me/password` exists |
| Login Sessions ("Chrome Windows · Sign Out") | ❌ — **but `refreshSession` already stores `userAgent` + `ipAddress`**, so list + revoke is cheap |
| Stores / locations | ❌ blocked on B1.3 |
| Users & Roles + Invite | ❌ blocked on B1.4 |
| Payments (UPI/Card/NetBanking/COD toggles, Razorpay key+secret) | ❌ provider is a hardcoded enum |
| Shipping & Integrations (carrier connect, pickup address, zones) | ❌ blocked on B1.2 |
| Returns & Refunds policy (window, reasons, auto-approve, restocking) | ❌ return window is code-level |
| Orders settings (auto-accept, auto-cancel, invoice prefix) | 🟡 invoice series exists in `src/modules/invoicing/`; not configurable |
| Notification preferences | ❌ |
| 2FA / Google Sync | ❌ |

### B4. Missing data model pieces

| Missing | Blocks |
|---|---|
| **Categories** | Product category column + filter, coupon "Applicable Category", Reports by category |
| **Brand, specifications, SEO block, shipping fields** on `product` | Add Product wizard steps 1 and 3 |
| **MRP, discount type/value, low-stock threshold** on `sku` | Variant editor, price ranges, stock badges |
| **Refund aggregate** | `returns.ts:33`: *"No refund columns and no refund table"*; `payments.ts:60`: *"No refund, settlement, dispute, payout…"*. Returns compute `refundTotal` but **nothing can pay it**. Blocks "Get Refund" on Payments and the whole Refunded status chain |
| **Promotion redemption / usage counters** | `promotions.ts:35`: *"No usage counters, no redemption table, no per-customer limits."* Blocks the "Used" column and usage limits |
| **Payment instrument detail** | `method` is only `online`/`cod`; the Payments screen's "Network" and "Method" (UPI / Credit Card / Net Banking) columns have no source |
| **Return pickup scheduling columns** | "Schedule Pickup" + date/time picker |

### B5. Cross-cutting, missing everywhere

| Feature | Note |
|---|---|
| **Global search** ("Search orders, products, customers…" in every header) | No unified search endpoint |
| **Export** (Orders, Shipments, Returns, Payments, Coupons) | No export infrastructure at all |
| **File upload** | No multipart handler |
| **Real-time / push** | No SSE or WebSocket |
| **Invoice as PDF** | Endpoint returns HTML — fine for "Print", not for "Download Invoice" |
| **Admin cancel order** | Only the customer-side `POST /users/me/orders/:n/cancel` exists |
| **Delete / deactivate customer** | No `DELETE` or `PATCH /admin/customers/:id` |
| **Bulk actions** | Product list has row + select-all checkboxes; no bulk endpoint |
| **Google OAuth** ("Continue with Google" on Login and Sign up) | No OAuth provider |
| **Audit trail screen** | `auditLog` table exists; no `GET /admin/audit-logs` |

---

## PART B6 — PASS-3 FINDINGS (request bodies & response rows)

Passes 1–2 checked routes and query filters. This pass read the **create/update bodies** and the **list-row shapes**. Five new gaps, all precise and all small-to-fix.

### 1. Create bodies are a fraction of the wizard forms

| Endpoint | Accepts | Figma form collects |
|---|---|---|
| `POST /admin/products` | **4 fields** — `slug`, `name`, `description`, `status` | ~25 fields over 3 steps (category, brand, specs, media, pricing, tax, variants, shipping, SEO) |
| `POST /admin/products/:slug/skus` | **4 fields** — `code`, `name`, `price`, `isActive` | MRP, selling price, discount type + value, stock, low-stock threshold, media |
| `POST /admin/orders/:n/shipments` | **3 optional fields** — `carrier`, `trackingNumber`, `trackingUrl` | ~15 fields (delivery method, courier partner, service type, weight, L×W×H, rate selection, cost breakdown) |

**Notably: creating a SKU cannot set its stock.** The Add Product variant table has a Stock column; the backend requires a separate `POST /admin/inventory/adjustments` call afterwards. Worth deciding whether the API should accept an opening quantity.

### 2. `GET /admin/inventory/summary` returns exactly one number

`{ inventory: { outOfStockSkus } }`. The Dashboard needs Total Products and a Low Stock count; the Products tabs need All / Active / Draft counts. None available.

### 3. Orders list row has no products and no item count

`AdminOrderSummaryResponse` carries `orderNumber, displayStatus, status, currency, total, taxTotal, grandTotal, placedAt, customer{}, payment, shipment`.

The Orders List table renders **Products** (thumbnail + name) and **Items** (a count). Neither is on the row. The item count is a cheap join; the thumbnail is blocked on media (B1.5).

### 4. Return detail has no customer, no address, and no timeline

`StaffReturnResponse` = return number, order number, status, reason, customer note, staff note, money, timestamps, and lines carrying `skuCode` only — **no product name**.

The Return Tracking panel needs **Customer Details** (name, email, "View profile"), **Address**, **Evidence** images, and a **Return Timeline**. None are returned.

**This is an inconsistency, not just a gap:** `returnEvent` exists and is written on every transition, and `GET /admin/shipments/:id` already exposes `history` in exactly this shape. Returns simply never read theirs. Adding `history` to the return detail mirrors code already in the repo.

### 5. Product statuses line up — but nothing can filter on them

`PRODUCT_STATUSES = ['draft','active','archived']` matches the Products screen's All / Active / Draft tabs. But `GET /admin/products` takes only `limit`/`offset`, so the tabs cannot filter — and there is still no unpublish, so active → draft is impossible.

---

## PART C — BUILD ORDER

**Phase 1 — cheapest wins, biggest UI unlock**
1. `GET/PUT /admin/store/profile` — columns already on `store`.
2. Enrich `GET /admin/customers`: phone, order count, total spent, last order date, `q` search, status counts. One query, fixes a whole screen.
3. Add `q` + `status` + counts to `GET /admin/products`, `GET /admin/promotions`, `GET /admin/inventory`, `GET /admin/returns`. Four small schema widenings, four screens unblocked.
4. Session list + revoke — `refreshSession` already stores what the screen shows.
5. `GET /admin/dashboard/metrics` + `/analytics/sales` + `/analytics/top-products`.
6. Media upload + `product_media` — unblocks every thumbnail in the app.

**Phase 2 — merchandising**
7. `category` table + CRUD + product association.
8. Product: brand, specs, SEO, shipping fields. SKU: MRP, discount, low-stock threshold → then Low Stock Alert and stock-status filters become possible.
9. Variant generation endpoint; product unpublish.

**Phase 3 — operations**
10. Order status decision (B1.1) + `PATCH /admin/orders/:n/status` + admin cancel.
11. Refund aggregate + `POST /admin/returns/:n/refund` + Razorpay refund + refund webhook.
12. Return `receive` / `inspect` endpoints, pickup scheduling, evidence upload.
13. Locations (B1.3) → carrier integration, rates, AWB, richer shipment statuses.

**Phase 4 — platform**
14. RBAC — replaces `requireStaff` everywhere.
15. Notifications + real-time transport.
16. Reports + async job runner + exports.
17. Google OAuth, 2FA.

---

## PART D — ALREADY STRONGER THAN THE DESIGN NEEDS

Don't rebuild these: the GST engine (CGST/SGST/IGST/cess split, place-of-supply, B2B/B2C classification, HSN per SKU), invoice numbering with financial-year series, the append-only stock ledger with reservations, idempotency middleware, the outbox, and the order / payment / shipment / return event logs. Every timeline and audit view in the design is *renderable* from event tables that already exist.
