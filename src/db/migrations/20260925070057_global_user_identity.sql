-- app_user becomes a single global identity: store_id is dropped, email/phone uniqueness
-- becomes global, and every (user_id, store_id) composite FK is replaced by a plain user_id FK.
-- Tenancy now lives on each row's own store_id; staff customer queries derive membership from
-- the customer's orders. The composite FKs are dropped BEFORE uq_app_user_id_store, which they
-- reference. Pre-checked: no duplicate live emails or phones existed.
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_store_id_store_id_fk";
--> statement-breakpoint
ALTER TABLE "password_reset_token" DROP CONSTRAINT "fk_password_reset_user_store";
--> statement-breakpoint
ALTER TABLE "customer_tax_identity" DROP CONSTRAINT "fk_customer_tax_identity_user_store";
--> statement-breakpoint
ALTER TABLE "idempotency_key" DROP CONSTRAINT "fk_idempotency_user_store";
--> statement-breakpoint
ALTER TABLE "address" DROP CONSTRAINT "fk_address_user_store";
--> statement-breakpoint
ALTER TABLE "cart" DROP CONSTRAINT "fk_cart_user_store";
--> statement-breakpoint
ALTER TABLE "order" DROP CONSTRAINT "fk_order_user_store";
--> statement-breakpoint
ALTER TABLE "payment" DROP CONSTRAINT "fk_payment_user_store";
--> statement-breakpoint
ALTER TABLE "return_request" DROP CONSTRAINT "fk_return_user_store";
--> statement-breakpoint
ALTER TABLE "refund" DROP CONSTRAINT "fk_refund_initiator_store";
--> statement-breakpoint
DROP INDEX "uq_app_user_id_store";--> statement-breakpoint
DROP INDEX "ix_app_user_store_created";--> statement-breakpoint
DROP INDEX "uq_user_email_active";--> statement-breakpoint
DROP INDEX "uq_user_phone_active";--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tax_identity" ADD CONSTRAINT "customer_tax_identity_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart" ADD CONSTRAINT "cart_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "order_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request" ADD CONSTRAINT "return_request_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund" ADD CONSTRAINT "refund_initiated_by_app_user_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_app_user_created" ON "app_user" USING btree ("created_at") WHERE "app_user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_email_active" ON "app_user" USING btree (lower("email")) WHERE "app_user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_phone_active" ON "app_user" USING btree ("phone") WHERE "app_user"."deleted_at" IS NULL AND "app_user"."phone" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "store_id";