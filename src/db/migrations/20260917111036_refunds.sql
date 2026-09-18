CREATE TABLE "refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"return_id" uuid,
	"refund_number" varchar(32) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"provider" varchar(32),
	"provider_refund_id" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"failure_code" varchar(64),
	"request_key" varchar(255),
	"initiated_by" uuid NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_refund_status" CHECK ("refund"."status" in ('pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "ck_refund_mode" CHECK ("refund"."mode" in ('provider', 'manual')),
	CONSTRAINT "ck_refund_amount_positive" CHECK ("refund"."amount" > 0),
	CONSTRAINT "ck_refund_amount_minor" CHECK (("refund"."mode" = 'manual' and "refund"."amount_minor" = 0) or ("refund"."mode" = 'provider' and "refund"."amount_minor" > 0)),
	CONSTRAINT "ck_refund_provider_id_requires_provider" CHECK ("refund"."provider_refund_id" is null or ("refund"."mode" = 'provider' and "refund"."provider" is not null)),
	CONSTRAINT "ck_refund_settled_at" CHECK (("refund"."status" in ('succeeded', 'failed')) = ("refund"."settled_at" is not null)),
	CONSTRAINT "ck_refund_succeeded_evidence" CHECK ("refund"."status" <> 'succeeded' or "refund"."mode" = 'manual' or "refund"."provider_refund_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "stock_ledger" DROP CONSTRAINT "ck_stock_ledger_reason";--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "fk_refund_payment_store" FOREIGN KEY ("payment_id","store_id") REFERENCES "public"."payment"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "fk_refund_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "fk_refund_return_store" FOREIGN KEY ("return_id","store_id") REFERENCES "public"."return_request"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "fk_refund_initiator_store" FOREIGN KEY ("initiated_by","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refund_number" ON "refund" USING btree ("store_id","refund_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refund_return_live" ON "refund" USING btree ("store_id","return_id") WHERE "refund"."return_id" is not null and "refund"."status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refund_provider_refund_id" ON "refund" USING btree ("store_id","provider","provider_refund_id") WHERE "refund"."provider_refund_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_refund_payment" ON "refund" USING btree ("store_id","payment_id");--> statement-breakpoint
CREATE INDEX "ix_refund_order" ON "refund" USING btree ("store_id","order_id","created_at");--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "ck_stock_ledger_reason" CHECK ("stock_ledger"."reason" in ('manual_increase', 'manual_decrease', 'correction', 'shipment', 'return_restock'));