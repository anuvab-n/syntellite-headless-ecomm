-- Inventory reservation: one new table, nothing else touched.
--
-- STATEMENT ORDER REVIEWED AND CORRECT AS GENERATED. Drizzle has emitted a foreign key
-- before the unique index it depends on six times in this project, so every generated
-- migration is read before it is applied. Here both composite FK targets already exist --
-- uq_order_id_store (created for order_line) and uq_sku_id_store (created for
-- sku_option_value and used by stock_item) -- and the one new index is referenced by
-- nothing, so no hoisting was required.
--
-- ADDITIVE ONLY. No ALTER on stock_item, stock_ledger, order, order_line, payment or
-- payment_event. No backfill: no historical order has a reservation, and every existing
-- stock_item.reserved is 0, so the invariant
--     SUM(quantity) WHERE status IN ('held','committed') = stock_item.reserved
-- holds trivially at 0 = 0 the moment this lands.
--
-- ROLLBACK: DROP TABLE stock_reservation is clean ONLY before the feature is exercised.
-- Once reservations exist, dropping this table orphans non-zero reserved counters with no
-- record explaining them, so a rollback must be paired with:
--     UPDATE stock_item SET reserved = 0;

CREATE TABLE "stock_reservation" (
	"order_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"status" varchar(20) DEFAULT 'held' NOT NULL,
	"settled_reason" varchar(32),
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "pk_stock_reservation" PRIMARY KEY("order_id","sku_id"),
	CONSTRAINT "ck_stock_reservation_quantity" CHECK ("stock_reservation"."quantity" >= 1 AND "stock_reservation"."quantity" <= 999),
	CONSTRAINT "ck_stock_reservation_status" CHECK ("stock_reservation"."status" in ('held', 'released', 'committed')),
	CONSTRAINT "ck_stock_reservation_settled_at" CHECK (("stock_reservation"."status" = 'held') = ("stock_reservation"."settled_at" is null)),
	CONSTRAINT "ck_stock_reservation_settled_reason" CHECK (("stock_reservation"."status" = 'held') = ("stock_reservation"."settled_reason" is null)),
	CONSTRAINT "ck_stock_reservation_reason_values" CHECK ("stock_reservation"."settled_reason" is null OR "stock_reservation"."settled_reason" in ('order_cancelled', 'payment_succeeded', 'payment_failed', 'payment_expired')),
	CONSTRAINT "ck_stock_reservation_settled_after_held" CHECK ("stock_reservation"."settled_at" is null OR "stock_reservation"."settled_at" >= "stock_reservation"."held_at")
);
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "fk_stock_reservation_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "fk_stock_reservation_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_stock_reservation_sku_outstanding" ON "stock_reservation" USING btree ("store_id","sku_id") WHERE "stock_reservation"."status" in ('held', 'committed');