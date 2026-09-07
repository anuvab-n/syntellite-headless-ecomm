CREATE TABLE "sku" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(300) DEFAULT '' NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_sku_price_non_negative" CHECK ("sku"."price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product" ALTER COLUMN "price" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "sku_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku" ADD CONSTRAINT "sku_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sku_code_active" ON "sku" USING btree ("store_id","code") WHERE "sku"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_sku_product" ON "sku" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ix_sku_store_active" ON "sku" USING btree ("store_id","is_active");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- BACKFILL: one SKU per existing product, carrying its price forward.
--
-- Price moved from the merchandising container to the sellable unit. Every product that had
-- a price gets exactly one SKU with that price, so nothing becomes unsellable and no value
-- is recomputed or rounded on the way across.
--
-- Field by field, and why:
--
--   id          A UUIDv7, constructed below rather than gen_random_uuid(). v4 is a LOCKED
--               decision against (docs/DECISIONS.md): it loses the time-ordering that makes
--               these ids index like a sequence, and an ESLint rule bans it in application
--               code. A backfill quietly seeding v4 rows into a v7 table would defeat that.
--               The expression overlays a 48-bit big-endian unix-ms timestamp over a random
--               uuid and stamps version 7; the variant bits are already correct because
--               gen_random_uuid() sets them to 10xx.
--
--   store_id    From the PRODUCT row, not a constant. The backfill is inherently multi-store
--               and copying the parent's store is what keeps every SKU in the right tenant.
--
--   code        The product slug. Slugs are already unique per store among non-deleted rows,
--               so this satisfies uq_sku_code_active without inventing a numbering scheme —
--               which is a merchant decision, not a migration's. Merchants rename freely
--               afterwards via the API.
--
--   name        Empty. These SKUs have no variant label because there is no option grid yet
--               (Increment 25); inventing "Default" would be a label nobody chose.
--
--   price       Copied verbatim. NUMERIC to NUMERIC, so no rounding and no float anywhere.
--
--   is_active   true. Sellability was governed by product.status before this migration, and
--               deactivating everything would silently unpublish the whole catalogue.
--
--   timestamps  Copied from the product, so the SKU's history reflects when this price
--               actually came into being rather than when the migration ran.
--
--   deleted_at  Copied. A deleted product's SKU must be deleted too, or it would be a row
--               that looks sellable to any future query reaching it by code. It also keeps
--               the 1:1 invariant total, so a later undelete needs no special case.
--
-- The WHERE guard is defensive: product.price cannot be NULL yet, and stating it means this
-- statement stays correct if the column is ever partially cleared before the column is
-- dropped in Increment 25.
-- ---------------------------------------------------------------------------
INSERT INTO "sku" (
  "id", "store_id", "product_id", "code", "name", "price", "is_active",
  "created_at", "updated_at", "deleted_at"
)
SELECT
  (
    overlay(
      overlay(
        encode(uuid_send(gen_random_uuid()), 'hex')
        placing lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0')
        from 1 for 12
      )
      placing '7' from 13 for 1
    )
  )::uuid,
  p."store_id",
  p."id",
  p."slug",
  '',
  p."price",
  true,
  p."created_at",
  p."updated_at",
  p."deleted_at"
FROM "product" p
WHERE p."price" IS NOT NULL;
