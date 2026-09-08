-- Increment 38: GST / tax foundation.
--
-- ---- MANUAL CORRECTION APPLIED. Read this before regenerating. -------------------------
--
-- TWO corrections, both required for this migration to apply at all.
--
-- 1. FK BEFORE ITS TARGET INDEX -- the EIGHTH appearance of this fault in this project
--    (DECISIONS SS43 records the fifth, SS44 the sixth, SS46 the seventh). Drizzle emitted
--    fk_tax_rate_class_store before uq_tax_class_id_store, the unique index it references.
--    Applied as generated, PostgreSQL refuses it:
--
--      there is no unique constraint matching given keys for referenced table "tax_class"
--
--    Every CREATE INDEX has been hoisted above every ADD CONSTRAINT ... FOREIGN KEY. No
--    statement was added, removed or altered by that hoist.
--
-- 2. TWO NOT NULL COLUMNS ON TABLES THAT ALREADY HOLD ROWS. Drizzle emitted
--    order.grand_total as NOT NULL with no default, which cannot be added to a populated
--    table; and order_line.taxable_value as NOT NULL DEFAULT 0, which would then violate
--    ck_order_line_taxable_value on every existing row. Both are handled by the BACKFILL
--    block below: grand_total arrives nullable, both columns are backfilled from data
--    already present, and grand_total is then set NOT NULL.
--
-- ---- The backfill states facts; it does not invent them --------------------------------
--
--   grand_total  := total          -- no tax was calculated or charged on any pre-existing
--                                     order, so grand_total = total + 0 is arithmetic.
--   taxable_value := line_total - discount_amount
--                                  -- the identity ck_order_line_taxable_value enforces. It
--                                     was already true of every line; the column just
--                                     materialises it.
--
-- What existing orders deliberately do NOT get is a tax DETERMINATION. Every snapshot
-- column (tax_at, supply_type, place_of_supply_*, seller_*, origin_*, customer_tax_*)
-- stays NULL, which records "not assessed" -- genuinely different from "assessed at nil",
-- and ck_order_tax_snapshot keeps the two distinguishable for ever.
--
-- ---- Non-destructive ---------------------------------------------------------------------
--
-- No DROP of any kind. No column is removed, narrowed or retyped, and no existing CHECK is
-- dropped or replaced. Every ALTER is an ADD. store.registered_address is left exactly as it
-- was: it is superseded by the typed origin_* columns and read by nothing, and dropping a
-- column that may hold operator-entered values would be destructive for no gain.
--
-- The whole migration is ONE transaction, so there is no window in which a column exists
-- without the CHECK that constrains it.
--
-- ---- Rollback -----------------------------------------------------------------------------
--
--   DROP TABLE tax_rate, customer_tax_identity, tax_class;
--   ALTER TABLE sku   DROP COLUMN tax_class_id, DROP COLUMN hsn_code;
--   ALTER TABLE store DROP COLUMN origin_line1, ... , DROP COLUMN origin_country_code;
--   ALTER TABLE "order"      DROP COLUMN tax_total, grand_total, tax_at, ... ;
--   ALTER TABLE order_line   DROP COLUMN taxable_value, ... ;
--   (plus the matching DROP CONSTRAINT for each CHECK added below)
--
-- Safe only while no order has been assessed. After that, dropping these columns discards
-- the tax that was charged on real orders, which is precisely the record tax law requires be
-- retained -- SS3 #15. Correct a bad rate by adding a new effective-dated one instead.
-- -------------------------------------------------------------------------------------------
CREATE TABLE "customer_tax_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gstin" varchar(15) NOT NULL,
	"legal_name" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_customer_tax_identity_gstin" CHECK ("customer_tax_identity"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "ck_customer_tax_identity_legal_name" CHECK (length(btrim("customer_tax_identity"."legal_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_class" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(300) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tax_class_not_blank" CHECK (length(btrim("tax_class"."code")) > 0 AND length(btrim("tax_class"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "tax_rate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"tax_class_id" uuid NOT NULL,
	"cgst_rate" numeric(9, 6) NOT NULL,
	"sgst_rate" numeric(9, 6) NOT NULL,
	"igst_rate" numeric(9, 6) NOT NULL,
	"cess_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tax_rate_range" CHECK ("tax_rate"."cgst_rate" >= 0 AND "tax_rate"."cgst_rate" <= 100
          AND "tax_rate"."sgst_rate" >= 0 AND "tax_rate"."sgst_rate" <= 100
          AND "tax_rate"."igst_rate" >= 0 AND "tax_rate"."igst_rate" <= 100
          AND "tax_rate"."cess_rate" >= 0 AND "tax_rate"."cess_rate" <= 100),
	CONSTRAINT "ck_tax_rate_period" CHECK ("tax_rate"."effective_to" IS NULL OR "tax_rate"."effective_to" > "tax_rate"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_line1" varchar(300);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_line2" varchar(300) DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_city" varchar(120);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_state" varchar(120);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_postal_code" varchar(16);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "origin_country_code" char(2);
--> statement-breakpoint
ALTER TABLE "sku" ADD COLUMN "tax_class_id" uuid;
--> statement-breakpoint
ALTER TABLE "sku" ADD COLUMN "hsn_code" varchar(16);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "tax_total" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "grand_total" numeric(19, 4);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "tax_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "supply_type" varchar(20);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "place_of_supply_state" varchar(120);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "place_of_supply_basis" varchar(40);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "seller_gstin" varchar(15);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "seller_legal_name" varchar(300);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_line1" varchar(300);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_line2" varchar(300);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_city" varchar(120);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_state" varchar(120);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_postal_code" varchar(16);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "origin_country_code" varchar(2);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "customer_tax_category" varchar(10);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "customer_gstin" varchar(15);
--> statement-breakpoint
ALTER TABLE "order" ADD COLUMN "customer_legal_name" varchar(300);
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "taxable_value" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "hsn_code" varchar(16);
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "tax_class_code" varchar(64);
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "tax_class_name" varchar(300);
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "cgst_rate" numeric(9, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "cgst_amount" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "sgst_rate" numeric(9, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "sgst_amount" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "igst_rate" numeric(9, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "igst_amount" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "cess_rate" numeric(9, 6) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "cess_amount" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_line" ADD COLUMN "tax_total" numeric(19, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
/* Backfill, before either column is constrained. See the header. */
UPDATE "order" SET "grand_total" = "total" WHERE "grand_total" IS NULL;
--> statement-breakpoint
UPDATE "order_line" SET "taxable_value" = "line_total" - "discount_amount";
--> statement-breakpoint
ALTER TABLE "order" ALTER COLUMN "grand_total" SET NOT NULL;
--> statement-breakpoint
/* Indexes BEFORE foreign keys. See correction 1 in the header. */
CREATE UNIQUE INDEX "uq_customer_tax_identity_user" ON "customer_tax_identity" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tax_class_code" ON "tax_class" USING btree ("store_id","code");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tax_class_id_store" ON "tax_class" USING btree ("id","store_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tax_rate_class_from" ON "tax_rate" USING btree ("store_id","tax_class_id","effective_from");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tax_rate_class_open" ON "tax_rate" USING btree ("store_id","tax_class_id") WHERE "tax_rate"."effective_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "ix_tax_rate_lookup" ON "tax_rate" USING btree ("store_id","tax_class_id","effective_from");
--> statement-breakpoint
ALTER TABLE "customer_tax_identity" ADD CONSTRAINT "customer_tax_identity_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_tax_identity" ADD CONSTRAINT "fk_customer_tax_identity_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tax_class" ADD CONSTRAINT "tax_class_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tax_rate" ADD CONSTRAINT "fk_tax_rate_class_store" FOREIGN KEY ("tax_class_id","store_id") REFERENCES "public"."tax_class"("id","store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "fk_sku_tax_class_store" FOREIGN KEY ("tax_class_id","store_id") REFERENCES "public"."tax_class"("id","store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "ck_store_tax_profile" CHECK (("store"."gstin" IS NULL AND "store"."legal_name" IS NULL AND "store"."origin_line1" IS NULL
           AND "store"."origin_city" IS NULL AND "store"."origin_state" IS NULL
           AND "store"."origin_postal_code" IS NULL AND "store"."origin_country_code" IS NULL)
          OR ("store"."gstin" IS NOT NULL AND "store"."legal_name" IS NOT NULL AND "store"."origin_line1" IS NOT NULL
           AND "store"."origin_city" IS NOT NULL AND "store"."origin_state" IS NOT NULL
           AND "store"."origin_postal_code" IS NOT NULL AND "store"."origin_country_code" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "ck_store_gstin" CHECK ("store"."gstin" IS NULL OR "store"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "ck_store_pan" CHECK ("store"."pan" IS NULL OR "store"."pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "ck_store_origin_country_code_shape" CHECK ("store"."origin_country_code" IS NULL OR "store"."origin_country_code" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "ck_store_tax_profile_not_blank" CHECK (("store"."legal_name" IS NULL OR length(btrim("store"."legal_name")) > 0)
          AND ("store"."origin_line1" IS NULL OR length(btrim("store"."origin_line1")) > 0)
          AND ("store"."origin_city" IS NULL OR length(btrim("store"."origin_city")) > 0)
          AND ("store"."origin_state" IS NULL OR length(btrim("store"."origin_state")) > 0)
          AND ("store"."origin_postal_code" IS NULL OR length(btrim("store"."origin_postal_code")) > 0));
--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "ck_sku_tax_classification" CHECK (("sku"."tax_class_id" IS NULL AND "sku"."hsn_code" IS NULL)
          OR ("sku"."tax_class_id" IS NOT NULL AND "sku"."hsn_code" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "ck_sku_hsn_code_not_blank" CHECK ("sku"."hsn_code" IS NULL OR length(btrim("sku"."hsn_code")) > 0);
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_grand_total_identity" CHECK ("order"."grand_total" = "order"."total" + "order"."tax_total");
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_tax_total_non_negative" CHECK ("order"."tax_total" >= 0);
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_tax_needs_determination" CHECK ("order"."tax_total" = 0 OR "order"."tax_at" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_tax_snapshot" CHECK (("order"."tax_at" IS NULL AND "order"."supply_type" IS NULL AND "order"."place_of_supply_state" IS NULL
           AND "order"."place_of_supply_basis" IS NULL AND "order"."seller_gstin" IS NULL
           AND "order"."seller_legal_name" IS NULL AND "order"."origin_line1" IS NULL
           AND "order"."origin_city" IS NULL AND "order"."origin_state" IS NULL
           AND "order"."origin_postal_code" IS NULL AND "order"."origin_country_code" IS NULL
           AND "order"."customer_tax_category" IS NULL)
          OR ("order"."tax_at" IS NOT NULL AND "order"."supply_type" IS NOT NULL
           AND "order"."place_of_supply_state" IS NOT NULL AND "order"."place_of_supply_basis" IS NOT NULL
           AND "order"."seller_gstin" IS NOT NULL AND "order"."seller_legal_name" IS NOT NULL
           AND "order"."origin_line1" IS NOT NULL AND "order"."origin_city" IS NOT NULL
           AND "order"."origin_state" IS NOT NULL AND "order"."origin_postal_code" IS NOT NULL
           AND "order"."origin_country_code" IS NOT NULL AND "order"."customer_tax_category" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_supply_type" CHECK ("order"."supply_type" IS NULL OR "order"."supply_type" in ('intra_state', 'inter_state'));
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_place_of_supply_basis" CHECK ("order"."place_of_supply_basis" IS NULL OR "order"."place_of_supply_basis" in ('delivery_destination'));
--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_customer_tax_category" CHECK (("order"."customer_tax_category" IS NULL AND "order"."customer_gstin" IS NULL
           AND "order"."customer_legal_name" IS NULL)
          OR ("order"."customer_tax_category" = 'b2c' AND "order"."customer_gstin" IS NULL
           AND "order"."customer_legal_name" IS NULL)
          OR ("order"."customer_tax_category" = 'b2b' AND "order"."customer_gstin" IS NOT NULL
           AND "order"."customer_legal_name" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_taxable_value" CHECK ("order_line"."taxable_value" = "order_line"."line_total" - "order_line"."discount_amount");
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_tax_non_negative" CHECK ("order_line"."cgst_rate" >= 0 AND "order_line"."cgst_amount" >= 0
          AND "order_line"."sgst_rate" >= 0 AND "order_line"."sgst_amount" >= 0
          AND "order_line"."igst_rate" >= 0 AND "order_line"."igst_amount" >= 0
          AND "order_line"."cess_rate" >= 0 AND "order_line"."cess_amount" >= 0
          AND "order_line"."tax_total" >= 0);
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_tax_total" CHECK ("order_line"."tax_total" = "order_line"."cgst_amount" + "order_line"."sgst_amount" + "order_line"."igst_amount" + "order_line"."cess_amount");
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_tax_split" CHECK (("order_line"."igst_rate" = 0 AND "order_line"."igst_amount" = 0)
          OR ("order_line"."cgst_rate" = 0 AND "order_line"."cgst_amount" = 0
              AND "order_line"."sgst_rate" = 0 AND "order_line"."sgst_amount" = 0));
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_tax_classification" CHECK (("order_line"."hsn_code" IS NULL AND "order_line"."tax_class_code" IS NULL AND "order_line"."tax_class_name" IS NULL)
          OR ("order_line"."hsn_code" IS NOT NULL AND "order_line"."tax_class_code" IS NOT NULL
              AND "order_line"."tax_class_name" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "order_line" ADD CONSTRAINT "ck_order_line_tax_needs_classification" CHECK ("order_line"."tax_total" = 0 OR "order_line"."tax_class_code" IS NOT NULL);
