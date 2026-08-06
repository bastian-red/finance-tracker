#!/usr/bin/env bash
#
# Run the integration lane against a real Postgres and a real Redis.
#
# What it proves: the properties the README claims are properties of the
# database, not of the service layer. The budget exclusion constraint under two
# concurrent writers, the monthly rollup's query plan, cache invalidation on
# write, import idempotence. A mocked Postgres cannot refuse an overlapping
# budget, so a suite that mocks it is asserting on its own mock.
#
# What breaks without it: the guard rails are all in the schema
# (`20260801121000_ledger_invariants`), and nothing in the gate lane touches the
# schema. A migration that drops the EXCLUDE constraint would ship green.
#
# The migrate-and-seed step is part of the lane rather than a prerequisite. The
# suite asserts on row counts for the demo user, so it needs a known ledger; the
# seed is idempotent (it deletes the demo user and lets the cascades run), which
# is what makes this runnable twice in a row with no manual cleanup.
#
# The env-loading block is deliberately the same shape as scripts/dev.sh, so the
# repo has one idiom for this rather than two that can drift apart.
#
# Usage: ./scripts/integration.sh [vitest args...]
# Assumes Postgres and Redis are up: docker compose -f infra/docker-compose.yml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Defaults match .env.example, so the lane runs on a CI runner that has service
# containers but no .env file. They are not a second source of truth: if these
# and .env.example ever disagree, .env.example wins and this is the bug.
export DATABASE_URL="${DATABASE_URL:-postgresql://fin:fin@localhost:5436/fin?schema=public}"
# Prisma requires directUrl to be set; with no pooler locally it is the same value.
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6383}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export DEFAULT_CURRENCY="${DEFAULT_CURRENCY:-EUR}"
export DEFAULT_LOCALE="${DEFAULT_LOCALE:-es-ES}"
export IMPORT_ROOT="${IMPORT_ROOT:-./var/imports}"
export MAX_IMPORT_BYTES="${MAX_IMPORT_BYTES:-8388608}"
export DUPLICATE_WINDOW_DAYS="${DUPLICATE_WINDOW_DAYS:-3}"
export REPORT_CACHE_TTL_SECONDS="${REPORT_CACHE_TTL_SECONDS:-900}"
export BUDGET_ALERT_THRESHOLD="${BUDGET_ALERT_THRESHOLD:-0.8}"

# The concurrency proof fires a burst of simultaneous budget writes from one
# address, which a production-shaped per-IP budget is supposed to refuse. Raising
# the limit here keeps the production defaults in .env.example honest instead of
# weakening them so a test can pass.
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=100000
export RATE_LIMIT_IMPORT=100000

# The importer writes the original bytes of every upload so a failed import can
# be re-read and explained. A missing directory is a confusing ENOENT forty lines
# into a parse, so it is created up front.
mkdir -p "$IMPORT_ROOT"

# Same /dev/tcp probe as scripts/dev.sh: bash's own, because nc is not installed
# everywhere. Postgres or Redis being absent presents as a slow hang or a wall of
# connection errors rather than as one clear line, so it gets named up front.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0 # No explicit host:port to check. Let the tool report it.
  fi
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[3]}"
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    echo "${label} is not reachable at ${host}:${port}. Start the datastores:" >&2
    echo "  docker compose -f infra/docker-compose.yml up -d" >&2
    return 1
  fi
}

failed=0
check_reachable "$DATABASE_URL" Postgres || failed=1
check_reachable "$REDIS_URL" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

echo "==> Applying migrations"
pnpm --filter @fin/db exec prisma migrate deploy >/dev/null

# Built directly rather than through `turbo run test:integration`, because this
# lane is about the datastores and turbo's task graph is not what is under test.
# `@fin/api^...` selects the API's workspace dependencies without the API itself,
# so a package added to apps/api/package.json next month is built without anyone
# editing this line.
echo "==> Building the packages the API imports"
pnpm --filter "@fin/api^..." run build >/dev/null

echo "==> Seeding the demo ledger"
pnpm --filter @fin/db run seed

echo "==> Running the integration suite"
pnpm --filter @fin/api run test:integration -- "$@"
