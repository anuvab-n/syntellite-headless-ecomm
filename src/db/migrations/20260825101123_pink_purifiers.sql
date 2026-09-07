ALTER TABLE "outbox_event" ADD COLUMN "aggregate_type" varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "aggregate_id" varchar(128) NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_outbox_aggregate" ON "outbox_event" USING btree ("store_id","aggregate_type","aggregate_id","occurred_at");