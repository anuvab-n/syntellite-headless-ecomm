-- Increment 28 — the shopping cart.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- `fk_cart_line_cart_store` references `cart(id, store_id)`, and PostgreSQL requires a unique
-- constraint on EXACTLY those columns before such a key can be created:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "cart"
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts `uq_cart_id_store` last and the migration fails. Verified by running it. The FK-target
-- index is therefore hoisted above the foreign keys here — the same correction Increments 25 and
-- 27 needed and documented.
--
-- **Do not regenerate this file without restoring this order.** Regenerating reintroduces the
-- original sequence; reorder it again rather than dropping the composite keys, which are what
-- make a cross-store cart line unrepresentable rather than merely rejected by application code.
--
-- The other two composite keys need no new index: `uq_app_user_id_store` was created by
-- Increment 27 and `uq_sku_id_store` by Increment 25.
--
-- Purely additive. Both tables are new and hold no rows, so there is no backfill and no
-- existing data is touched.

CREATE TABLE "cart" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Enforced in the database because the API is not the only writer: a seed script or an
	-- operator running SQL bypasses Zod entirely.
	CONSTRAINT "ck_cart_status" CHECK ("cart"."status" in ('active', 'checked_out'))
);
--> statement-breakpoint
CREATE TABLE "cart_line" (
	"cart_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The pair IS the identity: one line per SKU per cart, structurally. It is also the whole
	-- concurrency mechanism for PUT, since the upsert keys on it.
	CONSTRAINT "pk_cart_line" PRIMARY KEY("cart_id","sku_id"),
	-- 1..999. The minimum is 1 because a line with no units should not exist and DELETE already
	-- says so; the maximum keeps a mistyped paste far from integer overflow, which would surface
	-- as SQLSTATE 22003 rather than a clean 400.
	CONSTRAINT "ck_cart_line_quantity" CHECK ("cart_line"."quantity" >= 1 AND "cart_line"."quantity" <= 999)
);
--> statement-breakpoint

-- ── FK-target unique index, created BEFORE the foreign key that references it ─────────────
-- Adds no guarantee of its own — `id` is already the primary key — and exists solely so the
-- composite foreign key below is creatable.
CREATE UNIQUE INDEX "uq_cart_id_store" ON "cart" USING btree ("id","store_id");--> statement-breakpoint

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "cart" ADD CONSTRAINT "cart_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Ownership AND tenancy in one constraint: the cart's user must exist, and its store must be
-- that user's store.
ALTER TABLE "cart" ADD CONSTRAINT "fk_cart_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- CASCADE is correct here and nowhere else in this schema: a line has no meaning without its
-- cart, and a cart is not an order, so there is no history to preserve.
ALTER TABLE "cart_line" ADD CONSTRAINT "fk_cart_line_cart_store" FOREIGN KEY ("cart_id","store_id") REFERENCES "public"."cart"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Together with the key above, this makes cross-store contamination UNREPRESENTABLE: both keys
-- pin the same `store_id` column, so a cart in store A cannot hold a SKU from store B.
ALTER TABLE "cart_line" ADD CONSTRAINT "fk_cart_line_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Active-cart uniqueness ───────────────────────────────────────────────────────────────
-- Exactly one ACTIVE cart per customer per store. Partial on `status = 'active'`, which is what
-- makes the lifecycle work: a checked-out cart is outside the index, so it neither blocks the
-- customer's next cart nor has to be deleted to get out of the way. This index is also the
-- concurrency arbiter for implicit creation.
CREATE UNIQUE INDEX "uq_cart_active" ON "cart" USING btree ("user_id","store_id") WHERE "cart"."status" = 'active';
