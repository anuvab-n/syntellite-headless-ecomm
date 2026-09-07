CREATE TABLE "feature_flag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid,
	"key" varchar(200) NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"rollout_percentage" smallint DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"remove_by_ticket" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_feature_flag_scope" UNIQUE NULLS NOT DISTINCT("store_id","key")
);
--> statement-breakpoint
CREATE TABLE "store" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"domain" varchar(255),
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"supported_currencies" text[] DEFAULT ARRAY['INR']::text[] NOT NULL,
	"default_locale" varchar(10) DEFAULT 'en-IN' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Kolkata' NOT NULL,
	"legal_name" varchar(300),
	"gstin" varchar(15),
	"pan" varchar(10),
	"registered_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_setting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"key" varchar(200) NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"phone" varchar(20),
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(150) DEFAULT '' NOT NULL,
	"last_name" varchar(150) DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_staff" boolean DEFAULT false NOT NULL,
	"is_superuser" boolean DEFAULT false NOT NULL,
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"accepts_marketing" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid,
	"actor_user_id" uuid,
	"actor_type" varchar(32) NOT NULL,
	"action" varchar(128) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" varchar(64),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" varchar(64),
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"family_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(64),
	"user_agent" varchar(512),
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid,
	"event_name" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"request_id" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"claimed_by" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"handler_name" varchar(128) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_setting" ADD CONSTRAINT "store_setting_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_session" ADD CONSTRAINT "refresh_session_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_session" ADD CONSTRAINT "refresh_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_event" ADD CONSTRAINT "processed_event_event_id_outbox_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_slug" ON "store" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_domain" ON "store" USING btree ("domain") WHERE "store"."domain" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_store_setting" ON "store_setting" USING btree ("store_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_email_active" ON "app_user" USING btree ("store_id",lower("email")) WHERE "app_user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_phone_active" ON "app_user" USING btree ("store_id","phone") WHERE "app_user"."deleted_at" IS NULL AND "app_user"."phone" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_audit_log_store_time" ON "audit_log" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_log_actor" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_log_resource" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_refresh_session_token" ON "refresh_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_refresh_session_user" ON "refresh_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_refresh_session_family" ON "refresh_session" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "ix_refresh_session_expiry" ON "refresh_session" USING btree ("expires_at") WHERE "refresh_session"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_outbox_unpublished" ON "outbox_event" USING btree ("available_at","occurred_at") WHERE "outbox_event"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_outbox_stale_claims" ON "outbox_event" USING btree ("claimed_at") WHERE "outbox_event"."published_at" IS NULL AND "outbox_event"."claimed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_outbox_published" ON "outbox_event" USING btree ("published_at") WHERE "outbox_event"."published_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_processed_event" ON "processed_event" USING btree ("event_id","handler_name");--> statement-breakpoint
CREATE INDEX "ix_processed_event_time" ON "processed_event" USING btree ("processed_at");