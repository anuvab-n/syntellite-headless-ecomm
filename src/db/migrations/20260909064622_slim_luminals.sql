-- Increment 39: statutory invoice issuance.
--
-- Two tables: invoice_series (a mutable per-store, per-financial-year counter) and invoice
-- (immutable, one per order).
--
-- ---- NO MANUAL CORRECTION NEEDED, and that is worth recording ---------------------------
--
-- Every prior increment that added a composite tenant FK hit the same drizzle-kit fault: the
-- FOREIGN KEY emitted before the unique index it references. DECISIONS 43 records the fifth
-- occurrence, 44 the sixth, 46 the seventh and 47 the eighth.
--
-- This migration is clean as generated, because all three of its FK targets ALREADY EXIST
-- from earlier migrations:
--
--   fk_invoice_order_store              -> order(id, store_id)  via uq_order_id_store
--   invoice_store_id_store_id_fk        -> store(id)            via the primary key
--   invoice_series_store_id_store_id_fk -> store(id)            via the primary key
--
-- Nothing here references a unique index created BY this migration, so the FK-before-index
-- ordering below is harmless. Verified by applying it, not assumed.
--
-- ---- Additive and non-destructive ---------------------------------------------------------
--
-- Two CREATE TABLEs, three FKs, four unique indexes. No DROP of any kind, no column added to
-- an existing table, no existing CHECK dropped or replaced, and NO BACKFILL: an order placed
-- before this migration simply has no invoice row, which the read path renders as having no
-- statutory number rather than as an error. Backfilling would mean allocating numbers to
-- historical orders in whatever sequence a query returned them, which is not a series.
--
-- One transaction, so there is no window in which a table exists without its constraints.
--
-- ---- Rollback -----------------------------------------------------------------------------
--
--   DROP TABLE invoice;
--   DROP TABLE invoice_series;
--
-- Safe only while nothing has been invoiced. After that, dropping these tables discards the
-- record that a numbered statutory invoice was issued, and a gapless series cannot be
-- reconstructed from the orders alone because the numbers are exactly what would be lost.
-- -------------------------------------------------------------------------------------------
CREATE TABLE "invoice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"invoice_number" varchar(32) NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"sequence_number" integer NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"invoice_date" varchar(10) NOT NULL,
	"taxable_value" numeric(19, 4) NOT NULL,
	"tax_total" numeric(19, 4) NOT NULL,
	"grand_total" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_invoice_number_shape" CHECK ("invoice"."invoice_number" ~ '^INV/[0-9]{4}-[0-9]{2}/[0-9]{6}$'),
	CONSTRAINT "ck_invoice_year_shape" CHECK ("invoice"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "ck_invoice_date_shape" CHECK ("invoice"."invoice_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "ck_invoice_sequence_positive" CHECK ("invoice"."sequence_number" >= 1),
	CONSTRAINT "ck_invoice_number_matches_parts" CHECK ("invoice"."invoice_number" = 'INV/' || "invoice"."financial_year" || '/' || lpad("invoice"."sequence_number"::text, 6, '0')),
	CONSTRAINT "ck_invoice_money_non_negative" CHECK ("invoice"."taxable_value" >= 0 AND "invoice"."tax_total" >= 0 AND "invoice"."grand_total" >= 0),
	CONSTRAINT "ck_invoice_grand_total_identity" CHECK ("invoice"."grand_total" = "invoice"."taxable_value" + "invoice"."tax_total")
);
--> statement-breakpoint
CREATE TABLE "invoice_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"financial_year" varchar(7) NOT NULL,
	"last_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_invoice_series_year" CHECK ("invoice_series"."financial_year" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "ck_invoice_series_last_number" CHECK ("invoice_series"."last_number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "fk_invoice_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_series" ADD CONSTRAINT "invoice_series_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_order" ON "invoice" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_number" ON "invoice" USING btree ("store_id","invoice_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_sequence" ON "invoice" USING btree ("store_id","financial_year","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invoice_series" ON "invoice_series" USING btree ("store_id","financial_year");