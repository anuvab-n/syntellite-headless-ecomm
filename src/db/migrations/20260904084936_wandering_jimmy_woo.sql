-- Increment 30 — checkout and orders, plus the idempotency user-scope fix.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts all four FK-target unique indexes after the keys that reference them and the migration
-- fails. Verified by running it against a fresh database:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "address"
--   ERROR: there is no unique constraint matching given keys for referenced table "order"
--
-- THREE keys were affected this time, not one:
--
--   fk_order_address_store              -> needs uq_address_id_store  (new, on an EXISTING table)
--   fk_order_line_order_store           -> needs uq_order_id_store
--   fk_order_status_history_order_store -> needs uq_order_id_store
--
-- Both target indexes are therefore hoisted above the foreign keys below. This is the fifth time
-- the correction has been needed, after Increments 25, 27, 28 and 29.
--
-- **Do not regenerate this file without restoring this order.** Regenerating reintroduces the
-- original sequence; reorder it again rather than dropping the composite keys, which are what
-- make a cross-store order, order line or applied promotion unrepresentable rather than merely
-- rejected by application code.
--
-- ── The idempotency change is a SECURITY fix, not a feature ──────────────────────────────
--
-- `idempotency_key` gains `user_id`, and `uq_idempotency_key` is rebuilt to include it. With the
-- identity scoped to `(store_id, key, endpoint)` alone, two customers in one store sending the
-- same `Idempotency-Key` to the same endpoint collided: with different payloads the second got a
-- spurious 422, and with IDENTICAL payloads the second was served **a replay of the first
-- customer's response**. On checkout that is another customer's order number, totals and
-- delivery address. Increment 30 is the first increment to mount the middleware, so this had to
-- be closed before the endpoint existed rather than after.
--
-- `ADD COLUMN ... NOT NULL` with no default is safe here because the table is provably EMPTY:
-- no route mounted the middleware before this increment, and `purgeExpired` had no caller, so
-- nothing has ever written a row. Verified on the development database (0 rows) before
-- generating this migration. The index is dropped first and recreated last because its column
-- list changes.
--
-- Otherwise purely additive: three new tables, one new index on `address`, and no change to any
-- other existing table.

CREATE TABLE "order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	-- NOT NULL: checkout is authenticated-only. Guest checkout is not supported in this build,
	-- so there is no ownerless-order case to model.
	"user_id" uuid NOT NULL,
	"cart_id" uuid NOT NULL,
	-- ORD-YYYYMMDD-XXXXXX, generated from a CSPRNG. Deliberately not a sequence: a serial in a
	-- customer-visible identifier leaks the store's order count.
	"order_number" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'placed' NOT NULL,
	-- Copied from the store at checkout, so a store that later changes currency does not restate
	-- every historical total.
	"currency" varchar(3) NOT NULL,
	-- total = subtotal - discount_total, and `total` means the payable GOODS total before any
	-- future tax. When GST arrives it adds tax_total and grand_total; it must not redefine this.
	"subtotal" numeric(19, 4) NOT NULL,
	"discount_total" numeric(19, 4) NOT NULL,
	"total" numeric(19, 4) NOT NULL,
	-- The promotion snapshot: all three NULL together when no discount applied.
	"promotion_id" uuid,
	"promotion_code" varchar(64),
	"promotion_name" varchar(300),
	-- A reference AND a full snapshot. §40: "the moment a past invoice reads a live address, a
	-- customer fixing a typo rewrites history." The ship_* columns are authoritative for every
	-- historical read; the reference only keeps an operator from orphaning it.
	"address_id" uuid,
	"ship_recipient_name" varchar(300) NOT NULL,
	"ship_phone" varchar(20) NOT NULL,
	"ship_line1" varchar(300) NOT NULL,
	"ship_line2" varchar(300) DEFAULT '' NOT NULL,
	"ship_landmark" varchar(300) DEFAULT '' NOT NULL,
	"ship_city" varchar(120) NOT NULL,
	"ship_state" varchar(120) NOT NULL,
	"ship_postal_code" varchar(16) NOT NULL,
	"ship_country_code" varchar(2) NOT NULL,
	-- A business fact, distinct from created_at: the tax rate in force and the invoice date are
	-- both functions of it.
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- No deleted_at anywhere in this migration: §3 #15, "anonymise, never delete. Tax law
	-- requires invoice retention."
	CONSTRAINT "ck_order_status" CHECK ("order"."status" in ('placed')),
	CONSTRAINT "ck_order_money_non_negative" CHECK ("order"."subtotal" >= 0 AND "order"."discount_total" >= 0 AND "order"."total" >= 0),
	CONSTRAINT "ck_order_discount_within_subtotal" CHECK ("order"."discount_total" <= "order"."subtotal"),
	-- Stated as an identity rather than trusted to the service: three money columns that disagree
	-- would be an order that cannot be invoiced, found by an accountant rather than by a test.
	CONSTRAINT "ck_order_total_identity" CHECK ("order"."total" = "order"."subtotal" - "order"."discount_total"),
	-- The promotion snapshot is all-or-nothing; half a snapshot leaves the read path guessing.
	CONSTRAINT "ck_order_promotion_snapshot" CHECK (("order"."promotion_id" IS NULL AND "order"."promotion_code" IS NULL AND "order"."promotion_name" IS NULL)
          OR ("order"."promotion_id" IS NOT NULL AND "order"."promotion_code" IS NOT NULL AND "order"."promotion_name" IS NOT NULL)),
	-- A discount with no promotion behind it has no explanation.
	CONSTRAINT "ck_order_discount_needs_promotion" CHECK ("order"."discount_total" = 0 OR "order"."promotion_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "order_line" (
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	-- Snapshots. §3 #9: "snapshot product and address data onto order lines", because "renaming
	-- a product must not alter a past invoice." A historical read never joins for these.
	"sku_code" varchar(64) NOT NULL,
	"sku_name" varchar(300) NOT NULL,
	"product_name" varchar(300) NOT NULL,
	"quantity" integer NOT NULL,
	-- line_total is PRE-discount merchandise value; discount_amount is this line's allocated
	-- share of the cart-level discount. So a future tax basis is (line_total - discount_amount),
	-- derivable per line with no re-allocation — which is what §42 required be possible.
	"unit_price" numeric(19, 4) NOT NULL,
	"line_total" numeric(19, 4) NOT NULL,
	"discount_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The pair IS the identity, mirroring cart_line: one line per SKU per order.
	CONSTRAINT "pk_order_line" PRIMARY KEY("order_id","sku_id"),
	CONSTRAINT "ck_order_line_quantity" CHECK ("order_line"."quantity" >= 1 AND "order_line"."quantity" <= 999),
	CONSTRAINT "ck_order_line_money_non_negative" CHECK ("order_line"."unit_price" >= 0 AND "order_line"."line_total" >= 0 AND "order_line"."discount_amount" >= 0),
	CONSTRAINT "ck_order_line_total" CHECK ("order_line"."line_total" = "order_line"."unit_price" * "order_line"."quantity"),
	CONSTRAINT "ck_order_line_discount_within_line" CHECK ("order_line"."discount_amount" <= "order_line"."line_total")
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	-- NULL only for the creation row: "the order was created in this state", as distinct from
	-- "it moved into this state".
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_user_id" uuid,
	"note" varchar(500),
	-- No updated_at and no deleted_at. §3 #8: "every transition is a row. No UPDATE rewrites the
	-- past", and _shared.ts names order status history among the tables never deleted at all.
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_order_status_history_to_status" CHECK ("order_status_history"."to_status" in ('placed')),
	CONSTRAINT "ck_order_status_history_from_status" CHECK ("order_status_history"."from_status" IS NULL OR "order_status_history"."from_status" in ('placed')),
	CONSTRAINT "ck_order_status_history_progresses" CHECK ("order_status_history"."from_status" IS NULL OR "order_status_history"."from_status" <> "order_status_history"."to_status")
);
--> statement-breakpoint

-- ── The idempotency user-scope fix ───────────────────────────────────────────────────────
-- Drop first, because the index's column list changes. Safe on an empty table; see the header.
DROP INDEX "uq_idempotency_key";--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint

-- ── FK-target unique indexes, created BEFORE the keys that reference them ────────────────
-- Neither adds a guarantee of its own — `id` is already the primary key on both tables — and
-- both exist solely because PostgreSQL requires a unique constraint on exactly the referenced
-- columns. Hoisted here from the end of the generated file; see the header.
CREATE UNIQUE INDEX "uq_order_id_store" ON "order" USING btree ("id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_address_id_store" ON "address" USING btree ("id","store_id");--> statement-breakpoint

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "order" ADD CONSTRAINT "order_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Ownership AND tenancy in one constraint: the order's user must exist and must belong to its
-- store, so a cross-store order is unrepresentable.
ALTER TABLE "order" ADD CONSTRAINT "fk_order_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- RESTRICT: deleting a cart must never take an order with it. Both are history and both survive.
ALTER TABLE "order" ADD CONSTRAINT "fk_order_cart_store" FOREIGN KEY ("cart_id","store_id") REFERENCES "public"."cart"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- RESTRICT: an operator hard-deleting an address must not silently detach it from a past order.
-- Customers soft-delete addresses, which this does not obstruct, and the snapshot means the
-- order reads correctly either way.
ALTER TABLE "order" ADD CONSTRAINT "fk_order_address_store" FOREIGN KEY ("address_id","store_id") REFERENCES "public"."address"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "fk_order_promotion_store" FOREIGN KEY ("promotion_id","store_id") REFERENCES "public"."promotion"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- CASCADE is correct here and in the history table only: a line has no meaning without its
-- order. It never fires in practice because an order is never deleted.
ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Together with the key above this pins the same store_id column, so a line in store A cannot
-- reference a SKU from store B. RESTRICT also stops a merchant hard-deleting a SKU a past order
-- names — the case §24's soft-delete comment was written for.
ALTER TABLE "order_line" ADD CONSTRAINT "fk_order_line_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "fk_order_status_history_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SET NULL, not RESTRICT: the transition happened whoever caused it, and losing the actor is
-- better than losing the row.
ALTER TABLE "order_status_history" ADD CONSTRAINT "fk_order_status_history_actor" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "fk_idempotency_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Remaining indexes ────────────────────────────────────────────────────────────────────
-- §36's natural key: one order per cart, enforced rather than hoped for. The third of three
-- defences behind the cart-row lock and the status transition.
CREATE UNIQUE INDEX "uq_order_cart" ON "order" USING btree ("cart_id");--> statement-breakpoint
-- Per STORE, not global: two merchants may each have their own ORD-20260904-7QK4M2.
CREATE UNIQUE INDEX "uq_order_number" ON "order" USING btree ("store_id","order_number");--> statement-breakpoint
-- The customer's own order list, newest first.
CREATE INDEX "ix_order_user_placed" ON "order" USING btree ("user_id","placed_at");--> statement-breakpoint
CREATE INDEX "ix_order_status_history_order" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
-- Rebuilt with user_id in the identity. This is the claim guarantee: claiming is an INSERT, so a
-- unique violation is what makes two concurrent requests with one key resolve to one winner.
CREATE UNIQUE INDEX "uq_idempotency_key" ON "idempotency_key" USING btree ("store_id","user_id","key","endpoint");
