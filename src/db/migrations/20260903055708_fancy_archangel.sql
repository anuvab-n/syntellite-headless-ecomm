-- Increment 25 — variant options and SKU combinations.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- Every composite foreign key below references a pair of columns, and PostgreSQL requires a
-- unique constraint on EXACTLY those columns before such a key can be created:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "..."
--
-- drizzle-kit emits all `ADD CONSTRAINT` statements before all `CREATE INDEX` statements, so
-- its generated order fails on the first composite key. The FK-target unique indexes are
-- therefore hoisted above the foreign keys here. Regenerating this migration will reintroduce
-- the original order — reorder it again rather than dropping the composite keys, which are
-- what make the cross-product and cross-store invariants unrepresentable rather than merely
-- checked.

CREATE TABLE "product_option" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_option_value" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"value" varchar(120) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sku_option_value" (
	"sku_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_sku_option_value" PRIMARY KEY("sku_id","option_value_id")
);
--> statement-breakpoint
-- Existing SKUs need no backfill: '' IS the empty combination, and `uq_sku_combination`
-- exempts it, so every option-less SKU created by Increment 24 remains valid and they all
-- continue to coexist under one product. No "Default" option is invented, and no row is
-- created here — which is why this migration needs no UUID generation at all.
ALTER TABLE "sku" ADD COLUMN "option_signature" text DEFAULT '' NOT NULL;--> statement-breakpoint

-- ── FK-target unique indexes, created BEFORE the foreign keys that reference them ────────
-- These add no guarantee of their own — `id` is already a primary key in every case — and
-- exist solely so the composite foreign keys below are creatable.
CREATE UNIQUE INDEX "uq_product_option_id_product" ON "product_option" USING btree ("id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pov_id_option" ON "product_option_value" USING btree ("id","option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pov_id_product" ON "product_option_value" USING btree ("id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sku_id_product" ON "sku" USING btree ("id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sku_id_store" ON "sku" USING btree ("id","store_id");--> statement-breakpoint

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "product_option" ADD CONSTRAINT "product_option_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_option" ADD CONSTRAINT "product_option_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_option_value" ADD CONSTRAINT "product_option_value_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- A value's option must belong to the value's own product.
ALTER TABLE "product_option_value" ADD CONSTRAINT "fk_pov_option_product" FOREIGN KEY ("option_id","product_id") REFERENCES "public"."product_option"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The four keys that make a SKU's combination impossible to corrupt: the SKU's product and
-- store are pinned, the value's option and product are pinned, and both product references
-- must equal the junction row's own `product_id`.
ALTER TABLE "sku_option_value" ADD CONSTRAINT "fk_sov_sku_product" FOREIGN KEY ("sku_id","product_id") REFERENCES "public"."sku"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_option_value" ADD CONSTRAINT "fk_sov_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_option_value" ADD CONSTRAINT "fk_sov_value_option" FOREIGN KEY ("option_value_id","option_id") REFERENCES "public"."product_option_value"("id","option_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_option_value" ADD CONSTRAINT "fk_sov_value_product" FOREIGN KEY ("option_value_id","product_id") REFERENCES "public"."product_option_value"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── Business uniqueness and read indexes ─────────────────────────────────────────────────
-- `lower(...)` is the case-insensitivity mechanism, in the DATABASE. A bulk import or an
-- operator running SQL cannot create the duplicate the API rejects.
CREATE UNIQUE INDEX "uq_product_option_name_active" ON "product_option" USING btree ("product_id",lower("name")) WHERE "product_option"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_option_value_active" ON "product_option_value" USING btree ("option_id",lower("value")) WHERE "product_option_value"."deleted_at" IS NULL;--> statement-breakpoint
-- One value per option per SKU. Only meaningful because `fk_sov_value_option` above proves
-- `option_id` is honest; without it a falsified `option_id` would slip past this index.
CREATE UNIQUE INDEX "uq_sov_sku_option" ON "sku_option_value" USING btree ("sku_id","option_id");--> statement-breakpoint
CREATE INDEX "ix_product_option_product" ON "product_option" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ix_product_option_value_option" ON "product_option_value" USING btree ("option_id");--> statement-breakpoint
-- Serves the delete guard: "is any live SKU still using this value?"
CREATE INDEX "ix_sov_option_value" ON "sku_option_value" USING btree ("option_value_id");--> statement-breakpoint
-- The concurrency arbiter for duplicate variant combinations. `<> ''` exempts option-less
-- SKUs; `deleted_at IS NULL` frees a combination when its SKU is deleted, without which a
-- merchant could never re-create a variant they had deleted.
CREATE UNIQUE INDEX "uq_sku_combination" ON "sku" USING btree ("product_id","option_signature") WHERE "sku"."option_signature" <> '' AND "sku"."deleted_at" IS NULL;
