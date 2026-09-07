-- Order cancellation: `order.status` gains a second value.
--
-- Three CHECKs are widened, and DROP-then-ADD is the only way to change one in PostgreSQL.
-- Safe on existing data: every current row is `placed`, which both the old and new predicate
-- accept, so the ADD validates without a table rewrite of anything it would reject.
--
-- ── Why `cancelled` is not a payment state ──────────────────────────────────────────────
--
-- §43 fixed that `cart.status`, `order.status`, the payment table and a future shipment table
-- stay four separate state spaces. This does not breach that: `cancelled` records a decision
-- about the ORDER — the customer no longer wants it — and says nothing about money. Whether a
-- payment exists, and what state it is in, is still answered only by the payment table. The
-- cancellation rule READS that table through a port; it does not mirror it into this column.
--
-- No `pending_payment`, `paid` or `payment_failed` is added here, and none should be: each
-- would be exactly the folding-in that decision forbids.
--
-- ── The rule the widened CHECK enables ──────────────────────────────────────────────────
--
-- `placed -> cancelled` is the only legal transition, and it is refused when a payment is
-- `pending` (an online capture may still land) or `succeeded` (refunds do not exist, so
-- cancelling would take money nothing can return). `cancelled` is terminal and absorbing:
-- there is no un-cancel, because reinstating an order cannot re-check the stock, the prices
-- and the promotion it was built from.
ALTER TABLE "order" DROP CONSTRAINT "ck_order_status";--> statement-breakpoint
ALTER TABLE "order_status_history" DROP CONSTRAINT "ck_order_status_history_to_status";--> statement-breakpoint
ALTER TABLE "order_status_history" DROP CONSTRAINT "ck_order_status_history_from_status";--> statement-breakpoint
ALTER TABLE "order" ADD CONSTRAINT "ck_order_status" CHECK ("order"."status" in ('placed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "ck_order_status_history_to_status" CHECK ("order_status_history"."to_status" in ('placed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "ck_order_status_history_from_status" CHECK ("order_status_history"."from_status" IS NULL OR "order_status_history"."from_status" in ('placed', 'cancelled'));