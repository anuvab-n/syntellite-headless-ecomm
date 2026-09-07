CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"endpoint" varchar(255) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_idempotency_status" CHECK ("idempotency_key"."status" in ('in_progress', 'completed')),
	CONSTRAINT "ck_idempotency_completed_has_response" CHECK (("idempotency_key"."status" = 'completed') = ("idempotency_key"."response_status" is not null and "idempotency_key"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_idempotency_key" ON "idempotency_key" USING btree ("store_id","key","endpoint");--> statement-breakpoint
CREATE INDEX "ix_idempotency_expiry" ON "idempotency_key" USING btree ("expires_at");