--> The FK target must exist before the foreign key that references it. PostgreSQL requires a
--> unique constraint on exactly the referenced columns, so `uq_product_id_store` is created
--> first; drizzle-kit emits indexes after constraints, which would fail with 42830.
CREATE UNIQUE INDEX "uq_product_id_store" ON "product" USING btree ("id","store_id");
--> statement-breakpoint
CREATE TABLE "product_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku_id" uuid,
	"storage_key" varchar(512) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"alt_text" varchar(300) DEFAULT '' NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_product_media_position_non_negative" CHECK ("product_media"."position" >= 0),
	CONSTRAINT "ck_product_media_dimensions" CHECK (("product_media"."width" IS NULL) = ("product_media"."height" IS NULL) AND ("product_media"."width" IS NULL OR "product_media"."width" > 0) AND ("product_media"."height" IS NULL OR "product_media"."height" > 0)),
	CONSTRAINT "ck_product_media_byte_size" CHECK ("product_media"."byte_size" IS NULL OR "product_media"."byte_size" > 0)
);
--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "fk_product_media_product_store" FOREIGN KEY ("product_id","store_id") REFERENCES "public"."product"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "fk_product_media_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_media_primary" ON "product_media" USING btree ("product_id") WHERE "product_media"."is_primary" AND "product_media"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_media_key" ON "product_media" USING btree ("store_id","storage_key") WHERE "product_media"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_product_media_product" ON "product_media" USING btree ("product_id","position") WHERE "product_media"."deleted_at" IS NULL;
