CREATE TABLE "stock_item" (
	"sku_id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"available" integer GENERATED ALWAYS AS (on_hand - reserved) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_stock_on_hand_non_negative" CHECK ("stock_item"."on_hand" >= 0),
	CONSTRAINT "ck_stock_reserved_non_negative" CHECK ("stock_item"."reserved" >= 0),
	CONSTRAINT "ck_stock_reserved_within_on_hand" CHECK ("stock_item"."reserved" <= "stock_item"."on_hand")
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"on_hand_before" integer NOT NULL,
	"on_hand_after" integer NOT NULL,
	"reason" varchar(40) NOT NULL,
	"note" varchar(500) DEFAULT '' NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_stock_ledger_delta_non_zero" CHECK ("stock_ledger"."delta" <> 0),
	CONSTRAINT "ck_stock_ledger_quantities_non_negative" CHECK ("stock_ledger"."on_hand_before" >= 0 AND "stock_ledger"."on_hand_after" >= 0),
	CONSTRAINT "ck_stock_ledger_arithmetic" CHECK ("stock_ledger"."on_hand_before" + "stock_ledger"."delta" = "stock_ledger"."on_hand_after"),
	CONSTRAINT "ck_stock_ledger_reason" CHECK ("stock_ledger"."reason" in ('manual_increase', 'manual_decrease', 'correction'))
);
--> statement-breakpoint
ALTER TABLE "stock_item" ADD CONSTRAINT "stock_item_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_item" ADD CONSTRAINT "fk_stock_item_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "fk_stock_ledger_sku_store" FOREIGN KEY ("sku_id","store_id") REFERENCES "public"."sku"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_stock_ledger_sku_time" ON "stock_ledger" USING btree ("store_id","sku_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- ── Initialisation for SKUs that already exist ───────────────────────────────────────────
--
-- ZERO IS AN INITIALISATION VALUE, NOT A CLAIM ABOUT PHYSICAL STOCK.
--
-- It asserts that this system has not yet been told what these SKUs' stock is. It does NOT
-- assert that the shelves are empty. Conflating the two is how a catalogue goes out of stock
-- on the day inventory ships, so it is stated here rather than left to be inferred.
--
-- Every SKU gets a row, including any that are soft-deleted: a projection row for a deleted
-- SKU is harmless (nothing can adjust it — the adjustment predicate requires
-- `sku.deleted_at IS NULL`), whereas its absence would make the ledger's reconciliation
-- property conditional on liveness and would leave `GET` unable to distinguish "no row" from
-- "zero stock".
--
-- `store_id` is copied from the SKU row, which is what satisfies `fk_stock_item_sku_store`.
--
-- NO LEDGER ROWS ARE CREATED. An initialisation is not a movement: `ck_stock_ledger_delta_non_zero`
-- forbids a zero-delta entry, and attributing an initialisation to some invented actor would
-- put fiction in the audit trail. The ledger begins at the first real adjustment;
-- `stock_item.created_at` records when the row was initialised.
--
-- `ON CONFLICT DO NOTHING` makes this idempotent, so re-running against a partially migrated
-- database is safe. No UUID is generated: the primary key IS the existing `sku.id`.
INSERT INTO "stock_item" ("sku_id", "store_id", "on_hand", "reserved")
SELECT "id", "store_id", 0, 0 FROM "sku"
ON CONFLICT ("sku_id") DO NOTHING;
