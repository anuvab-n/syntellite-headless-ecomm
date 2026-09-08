-- Increment 37: shipment + fulfilment foundation.
--
-- ── MANUAL CORRECTION APPLIED. Read this before regenerating. ─────────────────────────────
--
-- Drizzle emitted `fk_shipment_event_shipment_store` BEFORE `uq_shipment_id_store`, the
-- unique index it references. Applied as generated, PostgreSQL refuses it:
--
--   there is no unique constraint matching given keys for referenced table "shipment"
--
-- This is the SEVENTH appearance of that fault in this project (§43 records the fifth, §44
-- the sixth). Every CREATE INDEX has been hoisted above every ADD CONSTRAINT ... FOREIGN KEY;
-- no statement was added, removed or otherwise altered, and the count is unchanged.
--
-- The re-added CHECK constraints deliberately stay LAST, because
-- `ck_stock_reservation_fulfilled_at` constrains the `fulfilled_at` column added above it.
--
-- ── Not destructive ──────────────────────────────────────────────────────────────────────
--
-- The three DROP CONSTRAINT statements drop CHECKs that are immediately re-added as strict
-- SUPERSETS: `ck_stock_ledger_reason` gains `shipment`, `ck_stock_reservation_status` gains
-- `fulfilled`, and `ck_stock_reservation_reason_values` gains two settlement reasons. No row
-- that was legal before is illegal after, so the re-add validates without rejecting anything,
-- and the whole migration is one transaction so no window exists where a CHECK is missing.
--
-- `ADD COLUMN fulfilled_at` is nullable with no default: metadata-only, no table rewrite.
--
-- NO BACKFILL. Every existing reservation is `held`, `released` or `committed`, so
-- `fulfilled_at` is correctly NULL for all of them and `ck_stock_reservation_fulfilled_at`
-- passes unconditionally.
--
-- ── Rollback ─────────────────────────────────────────────────────────────────────────────
--
-- DROP TABLE shipment_event, then shipment; drop `fulfilled_at`; narrow the three CHECKs back.
-- Safe only while no reservation has reached `fulfilled` — after that, narrowing
-- `ck_stock_reservation_status` would reject existing rows, and dropping the shipment tables
-- would discard the record that goods physically left.
CREATE TABLE "shipment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"carrier" varchar(120),
	"tracking_number" varchar(120),
	"tracking_url" varchar(500),
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_shipment_status" CHECK ("shipment"."status" in ('pending', 'shipped', 'delivered')),
	CONSTRAINT "ck_shipment_shipped_at" CHECK (("shipment"."status" in ('shipped', 'delivered')) = ("shipment"."shipped_at" is not null)),
	CONSTRAINT "ck_shipment_delivered_at" CHECK (("shipment"."status" = 'delivered') = ("shipment"."delivered_at" is not null)),
	CONSTRAINT "ck_shipment_delivered_after_shipped" CHECK ("shipment"."delivered_at" is null OR ("shipment"."shipped_at" is not null AND "shipment"."delivered_at" >= "shipment"."shipped_at")),
	CONSTRAINT "ck_shipment_tracking_url_needs_number" CHECK ("shipment"."tracking_url" is null OR "shipment"."tracking_number" is not null)
);
--> statement-breakpoint
CREATE TABLE "shipment_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shipment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_user_id" uuid,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_shipment_event_to_status" CHECK ("shipment_event"."to_status" in ('pending', 'shipped', 'delivered')),
	CONSTRAINT "ck_shipment_event_from_status" CHECK ("shipment_event"."from_status" is null OR "shipment_event"."from_status" in ('pending', 'shipped', 'delivered')),
	CONSTRAINT "ck_shipment_event_progresses" CHECK ("shipment_event"."from_status" is null OR "shipment_event"."from_status" <> "shipment_event"."to_status"),
	CONSTRAINT "ck_shipment_event_actor" CHECK (("shipment_event"."actor_type" = 'staff') = ("shipment_event"."actor_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "stock_ledger" DROP CONSTRAINT "ck_stock_ledger_reason";
--> statement-breakpoint
ALTER TABLE "stock_reservation" DROP CONSTRAINT "ck_stock_reservation_status";
--> statement-breakpoint
ALTER TABLE "stock_reservation" DROP CONSTRAINT "ck_stock_reservation_reason_values";
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD COLUMN "fulfilled_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipment_order" ON "shipment" USING btree ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipment_id_store" ON "shipment" USING btree ("id","store_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipment_tracking" ON "shipment" USING btree ("store_id","carrier","tracking_number") WHERE "shipment"."tracking_number" is not null;
--> statement-breakpoint
CREATE INDEX "ix_shipment_store_status" ON "shipment" USING btree ("store_id","status");
--> statement-breakpoint
CREATE INDEX "ix_shipment_event_shipment_time" ON "shipment_event" USING btree ("store_id","shipment_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "fk_shipment_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shipment_event" ADD CONSTRAINT "fk_shipment_event_shipment_store" FOREIGN KEY ("shipment_id","store_id") REFERENCES "public"."shipment"("id","store_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "ck_stock_ledger_reason" CHECK ("stock_ledger"."reason" in ('manual_increase', 'manual_decrease', 'correction', 'shipment'));
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_fulfilled_at" CHECK (("stock_reservation"."status" = 'fulfilled') = ("stock_reservation"."fulfilled_at" is not null));
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_fulfilled_after_settled" CHECK ("stock_reservation"."fulfilled_at" is null OR ("stock_reservation"."settled_at" is not null AND "stock_reservation"."fulfilled_at" >= "stock_reservation"."settled_at"));
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_status" CHECK ("stock_reservation"."status" in ('held', 'released', 'committed', 'fulfilled'));
--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "ck_stock_reservation_reason_values" CHECK ("stock_reservation"."settled_reason" is null OR "stock_reservation"."settled_reason" in ('order_cancelled', 'payment_succeeded', 'payment_failed', 'payment_expired', 'shipment_fulfilled', 'cod_fulfilment'));
