-- Increment 36: online payment expiry. Additive only.
--
-- STATEMENT ORDER REVIEWED AND CORRECT AS GENERATED. The FK-before-index fault has hit this
-- project six times, so every generated migration is read before it is applied. There is no
-- foreign key here and the new index is referenced by nothing, so nothing needed hoisting.
-- The CHECK is added after the column it constrains, which is the only ordering that matters.
--
-- NOT DESTRUCTIVE. No DROP, no type change, no NOT NULL on an existing column. ADD COLUMN with
-- no default and no NOT NULL is metadata-only in PostgreSQL — no table rewrite, no long lock.
--
-- CREATE INDEX, deliberately NOT CONCURRENTLY: Drizzle runs migrations inside a transaction
-- and CREATE INDEX CONCURRENTLY cannot run in one. The table is small, so a plain build is
-- instant; a large table would need the index created outside the migration runner.
--
-- NO BACKFILL. Every existing row takes NULL, which is correct: the six COD payments are
-- ineligible by decision, and the single online payment is already terminal. The CHECK
-- validates against those rows unconditionally and passes, because all of them are NULL.
--
-- ROLLBACK: DROP the constraint, the index, then the column. Safe at any time — no other
-- object references any of the three, and losing expires_at only stops future expiry.

ALTER TABLE "payment" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_payment_expiry_due" ON "payment" USING btree ("expires_at") WHERE "payment"."status" = 'pending' and "payment"."expires_at" is not null and "payment"."method" = 'online';--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "ck_payment_expires_at_only_online" CHECK ("payment"."expires_at" is null or "payment"."method" = 'online');