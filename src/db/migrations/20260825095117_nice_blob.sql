DROP INDEX "ix_outbox_unpublished";--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_outbox_dead_lettered" ON "outbox_event" USING btree ("dead_lettered_at") WHERE "outbox_event"."dead_lettered_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_outbox_unpublished" ON "outbox_event" USING btree ("available_at","occurred_at") WHERE "outbox_event"."published_at" IS NULL AND "outbox_event"."dead_lettered_at" IS NULL;