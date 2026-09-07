-- `available` is GENERATED ALWAYS AS (on_hand - reserved), and both inputs are NOT NULL, so
-- the generated value can never be NULL. Saying so keeps it a plain `number` for every
-- consumer instead of `number | null`, which Drizzle otherwise infers and which would force a
-- pointless null check at every call site.
--
-- A SECOND migration rather than an edit to the one that created the table: drizzle-kit keeps a
-- snapshot per migration, and hand-editing an applied migration to say something its snapshot
-- does not would leave the two disagreeing and make the next `db:generate` produce phantom
-- drift. Create-then-constrain is also the honest order of events.
ALTER TABLE "stock_item" ALTER COLUMN "available" SET NOT NULL;
