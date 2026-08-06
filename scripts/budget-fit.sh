#!/usr/bin/env bash
#
# What the seeded ledger actually spends, per category, per month.
#
# The budget limits in `packages/db/prisma/seed.ts` have to sit against real
# numbers or the dashboard demonstrates nothing: too low and every bar reads 275%
# used on every screen, too high and every bar is stuck near zero. Those numbers
# come out of the database, so reading them is deterministic work and belongs in
# a script rather than in somebody's head.
#
# Run it after any change to the seed's generator and paste the table it prints
# into the comment above the `budgets` array.
#
#   ./scripts/budget-fit.sh          # 80% approaching threshold, the default
#   ./scripts/budget-fit.sh 9000     # 90%
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

# Prisma's URL carries `?schema=public`, which libpq rejects outright with
# "invalid URI query parameter". The query string holds nothing psql needs, so
# it is dropped rather than translated.
PSQL_URL="${DATABASE_URL%%\?*}"

# The threshold the app uses to call a budget "approaching", in basis points.
THRESHOLD_BP="${1:-8000}"

# The reference month has to match `REFERENCE_MONTH` in the seed. Read it out of
# the file rather than repeating it here: a copy that drifts from the seed
# produces a table that is confidently about the wrong month.
REFERENCE_MONTH="$(
  sed -n 's/^const REFERENCE_MONTH = makeMonth(\([0-9]\{4\}\), \([0-9]\{1,2\}\));.*/\1 \2/p' \
    packages/db/prisma/seed.ts |
    awk '{ printf "%04d-%02d\n", $1, $2 }'
)"

if [[ -z "$REFERENCE_MONTH" ]]; then
  echo "Could not read REFERENCE_MONTH out of packages/db/prisma/seed.ts." >&2
  exit 1
fi

# Held in a variable rather than fed to psql as a heredoc, because a heredoc on
# the left of a pipe puts its body after the whole pipeline's last line and the
# two heredocs end up swapped. A variable has no ordering to get wrong.
read -r -d '' SQL <<SQL_END || true
WITH monthly AS (
  SELECT c.name AS category,
         to_char(date_trunc('month', t.booked_on), 'YYYY-MM') AS month,
         -sum(t.amount_minor) AS spent
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
  JOIN users u ON u.id = t.user_id
  WHERE c.kind = 'expense' AND u.email = 'demo@finance.local'
  GROUP BY 1, 2
),
current AS (
  SELECT category, spent FROM monthly WHERE month = '${REFERENCE_MONTH}'
)
SELECT m.category,
       min(m.spent),
       -- percentile_cont would interpolate between two months, which is not a
       -- number this ledger ever produced. _disc returns an actual observation.
       percentile_disc(0.5) WITHIN GROUP (ORDER BY m.spent),
       max(m.spent),
       coalesce(max(cur.spent), 0)
FROM monthly m
LEFT JOIN current cur ON cur.category = m.category
GROUP BY m.category
ORDER BY 3 DESC;
SQL_END

psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align \
  --field-separator=$'\t' --command "$SQL" |
  REFERENCE_MONTH="$REFERENCE_MONTH" THRESHOLD_BP="$THRESHOLD_BP" \
    python3 scripts/budget-fit.py
