-- Increment 29 — promotions: coupon-code discounts applied to a cart.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- `fk_cart_promotion_promotion_store` references `promotion(id, store_id)`, and PostgreSQL
-- requires a unique constraint on EXACTLY those columns before such a key can be created:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "promotion"
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts `uq_promotion_id_store` last and the migration fails. Verified by running it against a
-- fresh database. The FK-target index is therefore hoisted above the foreign keys here — the
-- fourth time this correction has been needed, after Increments 25, 27 and 28.
--
-- **Do not regenerate this file without restoring this order.** Regenerating reintroduces the
-- original sequence; reorder it again rather than dropping the composite keys, which are what
-- make a cross-store cart promotion unrepresentable rather than merely rejected by application
-- code.
--
-- The other composite key needs no new index: `uq_cart_id_store` was created by Increment 28.
--
-- Purely additive. Both tables are new and hold no rows, no existing table is altered, there
-- is no backfill, and no existing behaviour changes at the database level.

CREATE TABLE "promotion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	-- Stored as the merchant supplied it (trimmed, never re-cased). Matching is
	-- case-insensitive via `lower(code)` below.
	"code" varchar(64) NOT NULL,
	"name" varchar(300) NOT NULL,
	"discount_type" varchar(20) NOT NULL,
	-- `NUMERIC(9,6)` is the type `_shared.ts` designates for a discount fraction.
	"percent_rate" numeric(9, 6),
	-- `NUMERIC(19,4)`: the same type and scale as every price, so a discount and a subtotal
	-- compare directly with no conversion.
	"amount" numeric(19, 4),
	"min_subtotal" numeric(19, 4),
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- Enforced in the database because the API is not the only writer: a seed script or an
	-- operator running SQL bypasses Zod entirely.
	CONSTRAINT "ck_promotion_discount_type" CHECK ("promotion"."discount_type" in ('percentage', 'fixed_amount')),
	-- The discriminated union. Exactly one of the two value columns is present, and it is the
	-- one `discount_type` names. Both present would leave the evaluator choosing; neither would
	-- be a coupon that discounts nothing while looking valid.
	CONSTRAINT "ck_promotion_shape" CHECK ((
        "promotion"."discount_type" = 'percentage'
          AND "promotion"."percent_rate" IS NOT NULL
          AND "promotion"."amount" IS NULL
      ) OR (
        "promotion"."discount_type" = 'fixed_amount'
          AND "promotion"."amount" IS NOT NULL
          AND "promotion"."percent_rate" IS NULL
      )),
	-- 0% discounts nothing; over 100% would pay the customer to shop.
	CONSTRAINT "ck_promotion_percent_range" CHECK ("promotion"."percent_rate" IS NULL OR ("promotion"."percent_rate" > 0 AND "promotion"."percent_rate" <= 100)),
	CONSTRAINT "ck_promotion_amount_positive" CHECK ("promotion"."amount" IS NULL OR "promotion"."amount" > 0),
	CONSTRAINT "ck_promotion_min_subtotal" CHECK ("promotion"."min_subtotal" IS NULL OR "promotion"."min_subtotal" >= 0),
	-- A window that closes before it opens can never apply, and nothing would ever report it:
	-- the coupon would simply always 404.
	CONSTRAINT "ck_promotion_window" CHECK ("promotion"."starts_at" IS NULL OR "promotion"."ends_at" IS NULL OR "promotion"."ends_at" > "promotion"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "cart_promotion" (
	"cart_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- ONE PROMOTION PER CART, structurally. This is where "no stacking" lives — not a service
	-- check, a primary key. It is also the conflict target for the apply upsert, which is what
	-- makes replacement atomic and makes two concurrent applies converge on one row.
	CONSTRAINT "pk_cart_promotion" PRIMARY KEY("cart_id")
);
--> statement-breakpoint

-- ── FK-target unique index, created BEFORE the foreign key that references it ─────────────
-- Adds no guarantee of its own — `id` is already the primary key — and exists solely so the
-- composite foreign key below is creatable.
CREATE UNIQUE INDEX "uq_promotion_id_store" ON "promotion" USING btree ("id","store_id");--> statement-breakpoint

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- CASCADE: an applied promotion has no meaning without its cart, and a cart is not an order,
-- so there is no history to preserve. Matches `cart_line`.
ALTER TABLE "cart_promotion" ADD CONSTRAINT "fk_cart_promotion_cart_store" FOREIGN KEY ("cart_id","store_id") REFERENCES "public"."cart"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Together with the key above, this makes cross-store contamination UNREPRESENTABLE: both keys
-- pin the same `store_id` column, so a cart in store A cannot hold a coupon from store B.
-- RESTRICT because hard-deleting a promotion out from under a customer's cart is the mistake
-- `cart_line` already refuses for SKUs; merchants retire a coupon by soft-deleting it, which
-- this key does not obstruct.
ALTER TABLE "cart_promotion" ADD CONSTRAINT "fk_cart_promotion_promotion_store" FOREIGN KEY ("promotion_id","store_id") REFERENCES "public"."promotion"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Case-insensitive live code uniqueness ────────────────────────────────────────────────
-- `lower(...)` is the case-insensitivity mechanism, in the DATABASE, so a bulk import that
-- forgets to normalise cannot create a second `Save10`. Partial on `deleted_at IS NULL` so a
-- retired `DIWALI24` does not block next year's. Scoped to the store, because a unique index on
-- `code` alone would let one merchant's coupon block another's.
CREATE UNIQUE INDEX "uq_promotion_code_active" ON "promotion" USING btree ("store_id",lower("code")) WHERE "promotion"."deleted_at" IS NULL;--> statement-breakpoint

-- ── Admin listing ────────────────────────────────────────────────────────────────────────
-- The only non-constraint index in this migration. Removing it changes performance, not
-- behaviour, which is why no mutation probe counts it.
CREATE INDEX "ix_promotion_store_active" ON "promotion" USING btree ("store_id","is_active") WHERE "promotion"."deleted_at" IS NULL;
