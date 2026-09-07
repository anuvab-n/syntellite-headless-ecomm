-- Increment 27 — the customer address book.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- `fk_address_user_store` references `app_user(id, store_id)`, and PostgreSQL requires a unique
-- constraint on EXACTLY those columns before such a key can be created:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "app_user"
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts `uq_app_user_id_store` last and the migration fails. Verified by running it. The
-- FK-target index is therefore hoisted above the foreign keys here — the same correction
-- Increment 25's migration needed and documented. Regenerating this file will reintroduce the
-- original order: reorder it again rather than dropping the composite key, which is what makes
-- a cross-store address row unrepresentable rather than merely rejected.
--
-- Purely additive: `address` is new and holds no rows, so there is no backfill and no existing
-- data is touched. The one change to an existing table is an index on `app_user`, which is
-- metadata plus an index build.

-- ── FK-target unique index, created BEFORE the foreign key that references it ─────────────
-- Adds no guarantee of its own — `id` is already the primary key — and exists solely so the
-- composite foreign key below is creatable.
CREATE UNIQUE INDEX "uq_app_user_id_store" ON "app_user" USING btree ("id","store_id");--> statement-breakpoint

CREATE TABLE "address" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"label" varchar(60) NOT NULL,
	"recipient_name" varchar(300) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"line1" varchar(300) NOT NULL,
	"line2" varchar(300) DEFAULT '' NOT NULL,
	"landmark" varchar(300) DEFAULT '' NOT NULL,
	"city" varchar(120) NOT NULL,
	"state" varchar(120) NOT NULL,
	"postal_code" varchar(16) NOT NULL,
	"country_code" char(2) DEFAULT 'IN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- Shape, not membership: enough to reject 'in', 'IND' and '1N' in the database as well as
	-- at the boundary, without encoding a 249-entry country catalogue that would then need
	-- maintaining and would reject a legitimate country if it fell behind.
	CONSTRAINT "ck_address_country_code_shape" CHECK ("address"."country_code" ~ '^[A-Z]{2}$'),
	-- NOT NULL alone would admit '', which is the same failure wearing a different hat: an
	-- address with an empty city is not an address. `line2` and `landmark` are absent on
	-- purpose — they default to '' and are genuinely optional.
	CONSTRAINT "ck_address_required_not_blank" CHECK (length(btrim("address"."label")) > 0
          AND length(btrim("address"."recipient_name")) > 0
          AND length(btrim("address"."phone")) > 0
          AND length(btrim("address"."line1")) > 0
          AND length(btrim("address"."city")) > 0
          AND length(btrim("address"."state")) > 0
          AND length(btrim("address"."postal_code")) > 0)
);
--> statement-breakpoint

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "address" ADD CONSTRAINT "address_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Ownership AND tenancy in one constraint: the address's user must exist, and its store must be
-- that user's store.
ALTER TABLE "address" ADD CONSTRAINT "fk_address_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Read index ───────────────────────────────────────────────────────────────────────────
-- The ONE read pattern: "this user's live addresses". `user_id` leads because it is the
-- selective column; partial on `deleted_at IS NULL` because no query ever wants deleted rows —
-- there is no restore endpoint and no history read.
CREATE INDEX "ix_address_user_active" ON "address" USING btree ("user_id","store_id") WHERE "address"."deleted_at" IS NULL;
