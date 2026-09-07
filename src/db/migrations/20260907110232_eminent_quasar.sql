-- Increment 31 — payments.
--
-- STATEMENT ORDER IS LOAD-BEARING, and differs from drizzle-kit's generated output.
--
-- drizzle-kit emits every `ADD CONSTRAINT` before every `CREATE INDEX`, so its generated order
-- puts the FK-target unique index after the key that references it and the migration fails.
-- Verified by running it against a fresh database:
--
--   ERROR: there is no unique constraint matching given keys for referenced table "payment"
--
-- One key is affected:
--
--   fk_payment_event_payment_store -> needs uq_payment_id_store
--
-- That target index is therefore hoisted above the foreign keys below. This is the SIXTH time
-- the correction has been needed, after Increments 25, 27, 28, 29 and 30.
--
-- **Do not regenerate this file without restoring this order.** Regenerating reintroduces the
-- original sequence; reorder it again rather than dropping the composite key, which is what
-- makes a cross-store payment event unrepresentable rather than merely rejected by application
-- code.
--
-- ── Two tables, and nothing else changes ────────────────────────────────────────────────
--
-- `order` is NOT touched. No payment column, no new status, no altered CHECK. §43 fixed that
-- `cart.status`, `order.status`, payment and fulfilment are four separate state spaces, and
-- folding payment into the order is the shortcut that makes both impossible to model later. A
-- diff of this file against the schema is the proof: there is no `ALTER TABLE "order"`.
--
-- ── No instrument data, by construction ─────────────────────────────────────────────────
--
-- Neither table has a column for a card number, CVV, expiry, UPI handle, bank account or any
-- token standing for one, and neither has a free-text column that could carry one. `provider_ref`
-- is an opaque identifier belonging to the provider. Storing instrument data would change this
-- system's PCI scope, and the approved scope forbids it outright.
--
-- ── Why both unique indexes on payment_event and payment are PARTIAL ────────────────────
--
--   uq_payment_provider_ref  -> WHERE provider_ref IS NOT NULL
--   uq_payment_event_provider -> WHERE provider_event_id IS NOT NULL
--
-- Every COD payment has a NULL `provider_ref`, and every internally-caused transition has a NULL
-- `provider_event_id`. PostgreSQL treats NULLs as distinct in a unique index, so an unfiltered
-- index would work — but the predicate states the intent and keeps the index off the rows it can
-- never arbitrate.
--
-- `uq_payment_event_provider` is the duplicate-webhook guarantee. `idempotency_key` cannot serve
-- one: its `user_id` is NOT NULL and a provider carries no authenticated user, which its own
-- comment says while naming the alternative — "a webhook … has a natural key", and "a constraint
-- needs no header, no storage, and no expiry policy". This is that constraint.

CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"method" varchar(20) NOT NULL,
	"provider" varchar(32),
	"provider_ref" varchar(255),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_status" CHECK ("payment"."status" in ('pending', 'succeeded', 'failed', 'expired')),
	CONSTRAINT "ck_payment_method" CHECK ("payment"."method" in ('online', 'cod')),
	CONSTRAINT "ck_payment_provider" CHECK ("payment"."provider" is null or "payment"."provider" in ('razorpay')),
	CONSTRAINT "ck_payment_provider_matches_method" CHECK (("payment"."method" = 'online' AND "payment"."provider" IS NOT NULL)
          OR ("payment"."method" = 'cod' AND "payment"."provider" IS NULL AND "payment"."provider_ref" IS NULL)),
	CONSTRAINT "ck_payment_amount_positive" CHECK ("payment"."amount" > 0 AND "payment"."amount_minor" > 0),
	CONSTRAINT "ck_payment_failure_code_only_when_failed" CHECK ("payment"."failure_code" IS NULL OR "payment"."status" = 'failed')
);
--> statement-breakpoint
CREATE TABLE "payment_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"actor_type" varchar(32) NOT NULL,
	"actor_user_id" uuid,
	"provider_event_id" varchar(255),
	"event_type" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_payment_event_to_status" CHECK ("payment_event"."to_status" in ('pending', 'succeeded', 'failed', 'expired')),
	CONSTRAINT "ck_payment_event_from_status" CHECK ("payment_event"."from_status" IS NULL OR "payment_event"."from_status" in ('pending', 'succeeded', 'failed', 'expired')),
	CONSTRAINT "ck_payment_event_progresses" CHECK ("payment_event"."from_status" IS NULL OR "payment_event"."from_status" <> "payment_event"."to_status")
);
--> statement-breakpoint
-- HOISTED above the foreign keys: `fk_payment_event_payment_store` references exactly these
-- columns, and PostgreSQL requires a unique constraint on them to already exist.
CREATE UNIQUE INDEX "uq_payment_id_store" ON "payment" USING btree ("id","store_id");--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "fk_payment_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "fk_payment_order_store" FOREIGN KEY ("order_id","store_id") REFERENCES "public"."order"("id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_event" ADD CONSTRAINT "fk_payment_event_payment_store" FOREIGN KEY ("payment_id","store_id") REFERENCES "public"."payment"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_event" ADD CONSTRAINT "fk_payment_event_actor" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_order" ON "payment" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_provider_ref" ON "payment" USING btree ("store_id","provider","provider_ref") WHERE "payment"."provider_ref" is not null;--> statement-breakpoint
CREATE INDEX "ix_payment_store_status" ON "payment" USING btree ("store_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payment_event_provider" ON "payment_event" USING btree ("store_id","provider_event_id") WHERE "payment_event"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "ix_payment_event_payment" ON "payment_event" USING btree ("payment_id","created_at");
