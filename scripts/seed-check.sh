#!/usr/bin/env bash
#
# Prove the seed is deterministic and idempotent, against a real database.
#
# Two properties, both of which everything downstream assumes and neither of
# which a unit test can see:
#
#   deterministic - two runs produce the same ledger. The E2E suite asserts on
#                   totals from this data and the README quotes its numbers; a
#                   generator that drifts turns those into flaky failures that
#                   look like product bugs.
#   idempotent    - running it twice leaves one ledger, not two. The seed deletes
#                   the demo user first and relies on the cascades; a missing
#                   `onDelete: Cascade` anywhere in the schema shows up here as a
#                   doubled row count and nowhere else.
#
# The digest covers content only: day, amount, description, category, source and
# account name. Primary keys are cuids and differ on every run by design, so an
# id in the digest would make this fail every time and teach nothing.
#
#   ./scripts/seed-check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "No .env in the repo root. See README.md, \"Running it\"." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${DATABASE_URL:?DATABASE_URL is not set in .env}"

# Prisma's URL carries `?schema=public`, which libpq rejects outright.
PSQL_URL="${DATABASE_URL%%\?*}"

# `string_agg` needs the ORDER BY: without it the row order is whatever the
# planner produced, and the digest changes between two identical ledgers.
read -r -d '' DIGEST_SQL <<'SQL_END' || true
SELECT count(*) || ' ' || coalesce(md5(string_agg(x, '|' ORDER BY x)), '-')
FROM (
  SELECT t.booked_on::text || ':' || t.amount_minor || ':' || t.description
         || ':' || coalesce(c.name, '-') || ':' || t.category_source
         || ':' || a.name AS x
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  JOIN users u ON u.id = t.user_id
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE u.email = 'demo@finance.local'
) ledger;
SQL_END

digest() {
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align --command "$DIGEST_SQL"
}

run_seed() {
  pnpm --filter @fin/db exec tsx prisma/seed.ts >/dev/null
}

echo "seed-check: first run"
run_seed
FIRST="$(digest)"
echo "  $FIRST"

echo "seed-check: second run"
run_seed
SECOND="$(digest)"
echo "  $SECOND"

if [[ "$FIRST" != "$SECOND" ]]; then
  echo >&2
  echo "FAIL: the seed is not deterministic or not idempotent." >&2
  echo "  run 1: $FIRST" >&2
  echo "  run 2: $SECOND" >&2
  echo "A changed row count means a cascade is missing; a changed digest with the" >&2
  echo "same count means something in the generator reads the clock or Math.random." >&2
  exit 1
fi

if [[ "${FIRST%% *}" == "0" ]]; then
  echo "FAIL: the seed produced no transactions." >&2
  exit 1
fi

echo
echo "PASS: two runs, ${FIRST%% *} transactions, identical content digest."
