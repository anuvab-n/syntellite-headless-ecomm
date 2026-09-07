CREATE TABLE "product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"slug" varchar(255) NOT NULL,
	"name" varchar(300) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ck_product_status" CHECK ("product"."status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_product_slug_active" ON "product" USING btree ("store_id","slug") WHERE "product"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_product_store_status" ON "product" USING btree ("store_id","status");