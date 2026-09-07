-- Password reset: forgot-password and reset-password.
--
-- One new table. No FK reordering needed this time — `fk_password_reset_user_store` targets
-- `app_user(id, store_id)`, whose unique index was created by an earlier migration, so
-- drizzle-kit`s ADD-CONSTRAINT-before-CREATE-INDEX order is harmless here.
--
-- ── The token is never stored ───────────────────────────────────────────────────────────
--
-- `token_hash` is a SHA-256 digest of a 256-bit random token, exactly as `refresh_session`
-- stores a refresh token. A dump of this table cannot reset anybody`s password. Storing the
-- token itself would make this table equivalent to a table of plaintext passwords, because a
-- reset token is a bearer credential for the account.
--
-- `uq_password_reset_token` is GLOBAL rather than per store, and that is the correct scope:
-- a customer clicking a link in an email supplies the token and nothing else — no session, no
-- store header — so the digest is the whole lookup key and the store comes back FROM the row.
-- The service then checks that store against the resolved one, which is what refuses a token
-- minted for another tenant.
--
-- ── Single use, by a column rather than by deletion ─────────────────────────────────────
--
-- `used_at` is set instead of the row being removed, so a second click on the same emailed
-- link can be recognised as spent rather than being indistinguishable from a forgery — and so
-- an investigation into a compromised account can see that a reset happened. Both partial
-- indexes exclude spent rows, because neither the sweeper nor the invalidation path reads one
-- again.
CREATE TABLE "password_reset_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_password_reset_used_after_created" CHECK ("password_reset_token"."used_at" IS NULL OR "password_reset_token"."used_at" >= "password_reset_token"."created_at")
);
--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "fk_password_reset_user_store" FOREIGN KEY ("user_id","store_id") REFERENCES "public"."app_user"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_password_reset_token" ON "password_reset_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_password_reset_user" ON "password_reset_token" USING btree ("user_id","store_id") WHERE "password_reset_token"."used_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_password_reset_expiry" ON "password_reset_token" USING btree ("expires_at") WHERE "password_reset_token"."used_at" IS NULL;