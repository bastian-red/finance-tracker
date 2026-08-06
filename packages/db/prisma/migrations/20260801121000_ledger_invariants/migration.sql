-- Invariants and indexes Prisma's schema language cannot express.
--
-- Every constraint here exists because application code alone would let a
-- specific bad state reach the database. They are the last line of defence, not
-- the first: the services are supposed to make them unreachable, so a violation
-- surfacing at runtime means there is a bug to fix rather than a case to
-- swallow. The names are exported from `packages/db/src/index.ts`, because code
-- that catches a violation must match on the constraint name and never on the
-- message text, which Postgres localises and rewords between versions.

-- ---------------------------------------------------------------------------
-- Extensions.
--
-- btree_gist lets an exclusion constraint mix an equality test on a text column
-- with an overlap test on a range. Without it, `category_id WITH =` has no GiST
-- operator class and the constraint below cannot be created at all.
--
-- pg_trgm backs the transaction search box. `description ILIKE '%pizza%'` cannot
-- use a b-tree index, so without a trigram index the ledger's own search is the
-- one query that degrades linearly as the ledger grows — which is exactly the
-- direction it grows in.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. A budget limit is positive.
--
-- A zero limit has no meaningful state: every spend is infinitely over it, and
-- `spent / limit` divides by zero. Rejected at the column so it cannot arrive
-- through a path that skipped the zod schema.
ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_limit_positive"
  CHECK ("limit_minor" > 0);

-- ---------------------------------------------------------------------------
-- 2. A budget's period is stated in whole months, first-day-aligned.
--
-- The product's unit is a month: "400 euros of groceries a month". Storing an
-- arbitrary day would make "is 14 March inside this budget" a question with a
-- different answer than "is March inside this budget", and every report asks the
-- second one. Aligning here means the exclusion constraint below can compare
-- first-of-month dates directly and be exactly equivalent to comparing months.
ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_months_aligned"
  CHECK (
    EXTRACT(DAY FROM "effective_from") = 1
    AND ("effective_to" IS NULL OR EXTRACT(DAY FROM "effective_to") = 1)
  );

ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_period_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- ---------------------------------------------------------------------------
-- 3. Two budgets for one category may never cover the same month.
--
-- This is the invariant the whole budget feature rests on. If two rows can cover
-- March, then "the groceries budget for March" has two answers, and which one
-- the dashboard shows depends on row order while which one the alert uses
-- depends on a different query's row order. The app would warn about one number
-- and display another.
--
-- A `findFirst`-then-insert check cannot enforce it. Two browser tabs, two
-- requests, both read no overlap, both insert. That is not a rare race: it is
-- what happens when someone double-clicks Save.
--
-- So it is an EXCLUDE constraint, which Postgres evaluates atomically. Because
-- `effective_to` holds the first day of the **last** month, an inclusive `[]`
-- daterange over first-of-month dates overlaps exactly when the two month sets
-- overlap. No interval arithmetic is involved, which keeps every expression
-- immutable — a requirement for an index expression, and the reason this is not
-- written as `effective_to + interval '1 month'`.
--
-- A NULL upper bound means "still in force", and `daterange(x, NULL, '[]')` is
-- unbounded above, which is precisely that.
--
-- Scoped by category_id rather than by (user_id, category_id): a category
-- belongs to exactly one user, so the second column would only widen the index.
ALTER TABLE "budgets"
  ADD CONSTRAINT "budgets_no_overlapping_periods"
  EXCLUDE USING gist (
    "category_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );

-- ---------------------------------------------------------------------------
-- 4. An alert is about a whole month.
--
-- `alerts_budget_id_month_level_key` (declared in the Prisma schema) is what
-- stops eleven identical emails on a busy Saturday, and it only works if every
-- writer agrees on how to spell "March". Aligning the column makes that
-- agreement structural instead of conventional.
ALTER TABLE "alerts"
  ADD CONSTRAINT "alerts_month_aligned"
  CHECK (EXTRACT(DAY FROM "month") = 1);

-- ---------------------------------------------------------------------------
-- 5. A transaction cannot cross a tenant boundary or a currency.
--
-- Three joins away from anything a CHECK can see, so it is a trigger.
--
-- The tenant half is the one that matters. `user_id` on the transaction is what
-- every report filters by, and `account_id` is what the row actually belongs to.
-- If those two disagree, one user's spending appears in another user's totals —
-- silently, correctly summed, and completely wrong. The API is supposed to make
-- that unreachable; this makes it impossible.
--
-- The currency half prevents the subtler bug: summing 100 USD and 100 EUR into
-- 200 of something. Amounts are integer minor units with no currency attached,
-- so nothing downstream would notice.
CREATE OR REPLACE FUNCTION fin_check_transaction_consistency() RETURNS trigger AS $$
DECLARE
  account_owner text;
  account_currency char(3);
  category_owner text;
BEGIN
  SELECT a."user_id", a."currency" INTO account_owner, account_currency
  FROM "accounts" a WHERE a."id" = NEW."account_id";

  IF account_owner IS DISTINCT FROM NEW."user_id" THEN
    RAISE EXCEPTION
      'transaction user_id % does not own account %', NEW."user_id", NEW."account_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_user_matches_account';
  END IF;

  IF account_currency IS DISTINCT FROM NEW."currency" THEN
    RAISE EXCEPTION
      'transaction currency % does not match account currency %', NEW."currency", account_currency
      USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_currency_matches_account';
  END IF;

  IF NEW."category_id" IS NOT NULL THEN
    SELECT c."user_id" INTO category_owner FROM "categories" c WHERE c."id" = NEW."category_id";
    IF category_owner IS DISTINCT FROM NEW."user_id" THEN
      RAISE EXCEPTION
        'transaction user_id % does not own category %', NEW."user_id", NEW."category_id"
        USING ERRCODE = 'check_violation', CONSTRAINT = 'transactions_user_matches_category';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_consistency"
  BEFORE INSERT OR UPDATE OF "user_id", "account_id", "category_id", "currency"
  ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION fin_check_transaction_consistency();

-- A budget's category must belong to the budget's user, for the same reason.
CREATE OR REPLACE FUNCTION fin_check_budget_consistency() RETURNS trigger AS $$
DECLARE
  category_owner text;
BEGIN
  SELECT c."user_id" INTO category_owner FROM "categories" c WHERE c."id" = NEW."category_id";
  IF category_owner IS DISTINCT FROM NEW."user_id" THEN
    RAISE EXCEPTION
      'budget user_id % does not own category %', NEW."user_id", NEW."category_id"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'budgets_user_matches_category';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "budgets_consistency"
  BEFORE INSERT OR UPDATE OF "user_id", "category_id"
  ON "budgets"
  FOR EACH ROW EXECUTE FUNCTION fin_check_budget_consistency();

-- ---------------------------------------------------------------------------
-- 6. The reporting index carries its payload.
--
-- Every aggregate this app runs has the same shape: one user, a date window,
-- grouped by category. With a plain (user_id, booked_on) index Postgres walks
-- the index to find the rows and then visits the heap for each one to read
-- `category_id` and `amount_minor` — one random page fetch per transaction, for
-- a query that touches every row of a month.
--
-- Adding the two payload columns as INCLUDE makes it an index-only scan: the
-- rollup never touches the table. The columns are non-key, so they do not widen
-- the b-tree's internal pages and the index stays cheap to descend.
--
-- Prisma cannot express INCLUDE, so the index is dropped and recreated here
-- under exactly the name Prisma gave it. Prisma's drift detection reads the
-- index back with all four columns flattened into the key list, which is why the
-- schema declares four and maps the name explicitly. This file is the one that
-- says which two of them are actually keys.
DROP INDEX "transactions_user_id_booked_on_idx";
CREATE INDEX "transactions_user_id_booked_on_idx"
  ON "transactions" ("user_id", "booked_on")
  INCLUDE ("category_id", "amount_minor");

-- ---------------------------------------------------------------------------
-- 7. The uncategorised queue.
--
-- "What still needs a category" is the screen someone opens straight after an
-- import, and it is a tiny fraction of the ledger. A partial index over just
-- those rows stays small enough to remain cached even when the table does not,
-- and it shrinks to nothing as the queue is worked through — which is the one
-- access pattern where the index genuinely wants to disappear when the answer
-- is empty.
CREATE INDEX "transactions_uncategorised_idx"
  ON "transactions" ("user_id", "booked_on" DESC)
  WHERE "category_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 8. Description search.
--
-- The search box is `ILIKE '%term%'`, which no b-tree can serve. A GIN trigram
-- index over the lower-cased description makes it an index scan instead of a
-- sequential one. `lower()` is in the index expression rather than relying on
-- ILIKE's own case folding, so the planner can use it for both spellings.
CREATE INDEX "transactions_description_trgm_idx"
  ON "transactions" USING gin (lower("description") gin_trgm_ops);
