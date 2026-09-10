-- Increment 40a — the returns schema: return_request, return_line, return_event.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts the FK-target unique index after the keys that reference it and the migration fails.
-- Verified by running it against a fresh database:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "return_request"
--
-- TWO keys are affected, both pointing at the new table's own composite tenant key:
--
--   fk_return_event_return_store -> needs uq_return_id_store
--   fk_return_line_return_store  -> needs uq_return_id_store
--
-- The other three keys reference indexes that already exist (uq_order_id_store,
-- uq_app_user_id_store, uq_sku_id_store), so only this one has to move.
--
-- `uq_return_id_store` is therefore hoisted above the foreign keys below. This is the sixth
-- time the correction has been needed, after Increments 25, 27, 28, 29 and 30.
--
-- **Do not regenerate this file without restoring this order.** Regenerating reintroduces the
-- original sequence; reorder it again rather than dropping the composite keys, which are what
-- make cross-tenant references impossible at the database level.

CREATE TABLE "return_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"return_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_user_id" uuid,
	"note" varchar(500) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_return_event_to_status" CHECK ("return_event"."to_status" in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')),
	CONSTRAINT "ck_return_event_from_status" CHECK ("return_event"."from_status" is null or "return_event"."from_status" in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')),
	CONSTRAINT "ck_return_event_actor_type" CHECK ("return_event"."actor_type" in ('customer', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "return_line" (
	"return_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"line_total" numeric(19, 4) NOT NULL,
	"discount_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"taxable_value" numeric(19, 4) NOT NULL,
	"cgst_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"cess_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) NOT NULL,
	"refund_total" numeric(19, 4) NOT NULL,
	"restock_quantity" integer DEFAULT 0 NOT NULL,
	"write_off_quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_return_line" PRIMARY KEY("return_id","sku_id"),
	CONSTRAINT "ck_return_line_quantity" CHECK ("return_line"."quantity" >= 1 and "return_line"."quantity" <= 999),
	CONSTRAINT "ck_return_line_taxable" CHECK ("return_line"."taxable_value" = "return_line"."line_total" - "return_line"."discount_amount"),
	CONSTRAINT "ck_return_line_tax_total" CHECK ("return_line"."tax_total" = "return_line"."cgst_amount" + "return_line"."sgst_amount" + "return_line"."igst_amount" + "return_line"."cess_amount"),
	CONSTRAINT "ck_return_line_refund_total" CHECK ("return_line"."refund_total" = "return_line"."taxable_value" + "return_line"."tax_total"),
	CONSTRAINT "ck_return_line_amounts_non_negative" CHECK ("return_line"."line_total" >= 0 and "return_line"."discount_amount" >= 0 and "return_line"."taxable_value" >= 0
          and "return_line"."cgst_amount" >= 0 and "return_line"."sgst_amount" >= 0 and "return_line"."igst_amount" >= 0
          and "return_line"."cess_amount" >= 0 and "return_line"."tax_total" >= 0 and "return_line"."refund_total" >= 0),
	CONSTRAINT "ck_return_line_discount_within_line" CHECK ("return_line"."discount_amount" <= "return_line"."line_total"),
	CONSTRAINT "ck_return_line_inspection_quantity" CHECK ("return_line"."restock_quantity" >= 0 and "return_line"."write_off_quantity" >= 0
          and "return_line"."restock_quantity" + "return_line"."write_off_quantity" <= "return_line"."quantity")
);
--> statement-breakpoint
CREATE TABLE "return_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"return_number" varchar(32) NOT NULL,
	"status" varchar(20) DEFAULT 'requested' NOT NULL,
	"reason" varchar(40) NOT NULL,
	"customer_note" varchar(500) DEFAULT '' NOT NULL,
	"staff_note" varchar(500) DEFAULT '' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"refund_taxable_value" numeric(19, 4) NOT NULL,
	"refund_tax_total" numeric(19, 4) NOT NULL,
	"refund_total" numeric(19, 4) NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_return_status" CHECK ("return_request"."status" in ('requested', 'approved', 'received', 'inspected', 'completed', 'rejected', 'cancelled')),
	CONSTRAINT "ck_return_reason" CHECK ("return_request"."reason" in ('damaged_in_transit', 'defective', 'wrong_item_received', 'not_as_described', 'no_longer_needed')),
	CONSTRAINT "ck_return_total" CHECK ("return_request"."refund_total" = "return_request"."refund_taxable_value" + "return_request"."refund_tax_total"),
	CONSTRAINT "ck_return_amounts_non_negative" CHECK ("return_request"."refund_taxable_value" >= 0 and "return_request"."refund_tax_total" >= 0 and "return_request"."refund_total" >= 0),
	CONSTRAINT "ck_return_closed_at" CHECK (("return_request"."status" in ('completed', 'rejected', 'cancelled')) = ("return_request"."closed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_return_id_store" ON "return_request" USING btree ("id","store_id");--> statement-breakpoint
ALTER TABLE "return_event" ADD CONSTRAINT "fk_return_event_return_store" FOREIGN KEY ("return_id","store_id") REFERENCES "public"."return_request"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_line" ADD CONSTRAINT "fk_return_line_return_store" FOREIGN KEY ("return_id","store_id") REFERENCES "public"."return_request"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_line" ADD CONSTRAINT "fk_return_line_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request" ADD CONSTRAINT "fk_return_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request" ADD CONSTRAINT "fk_return_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_return_event_return" ON "return_event" USING btree ("return_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_return_number" ON "return_request" USING btree ("store_id","return_number");--> statement-breakpoint
CREATE INDEX "ix_return_user_requested" ON "return_request" USING btree ("store_id","user_id","requested_at");--> statement-breakpoint
CREATE INDEX "ix_return_store_status" ON "return_request" USING btree ("store_id","status");--> statement-breakpoint
CREATE INDEX "ix_return_order" ON "return_request" USING btree ("order_id");