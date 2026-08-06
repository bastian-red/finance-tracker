#!/usr/bin/env bash
#
# Run the E2E lane: migrate, build, reseed, boot the api and the web app, run
# Playwright, tear everything down.
#
# What it proves: the flows a person actually performs. Sign in, import a
# statement, recategorise a row, set a budget, watch the alert fire. Those cross
# every boundary in the repo at once, which is the one thing no unit test does.
#
# The reseed is part of the lane, not a prerequisite. The specs create budgets,
# edit transactions and commit imports, so a second run against a used database
# would fail for reasons that have nothing to do with the code. The seed is
# idempotent, which is what makes the lane repeatable.
#
# The apps are started here rather than through `pnpm dev` or turbo on purpose:
# Playwright owns the lifecycle, the build is the production build, and turbo's
# persistent dev tasks would keep the shell alive after the suite finished.
# That also means this lane cannot see the failure scripts/dev-smoke.sh exists
# for, which is why both lanes exist.
#
# The env-loading block is deliberately the same shape as scripts/dev.sh.
#
# Usage: ./scripts/e2e.sh [playwright args...]
#   ./scripts/e2e.sh --headed
#   ./scripts/e2e.sh a11y.spec.ts
# Assumes Postgres and Redis are up: docker compose -f infra/docker-compose.yml up -d
set -euo pipefail

# Job control, so each server lands in its own process group. `pnpm exec next
# start` is a wrapper: killing the wrapper alone leaves the real server holding
# the port, and the next run then silently tests a stale build.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_LOG=/tmp/fin-e2e-api.log
WEB_LOG=/tmp/fin-e2e-web.log
API_PID=""
WEB_PID=""

WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$WEB_PID" "$API_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Defaults match .env.example so the lane runs on a CI runner with service
# containers and no .env file.
export DATABASE_URL="${DATABASE_URL:-postgresql://fin:fin@localhost:5436/fin?schema=public}"
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
export API_PORT="${API_PORT:-4000}"
export WEB_PORT="${WEB_PORT:-3000}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"
export AUTH_URL="${AUTH_URL:-$APP_BASE_URL}"
# Inlined into the browser bundle by `next build`, so it must be exported before
# the build and not only before the server starts.
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-$API_BASE_URL}"

# A suite driving several browsers from one address looks exactly like abuse to a
# production-shaped per-IP budget, and the sign-in limit of 5/min would fail the
# second spec every time. Raised here rather than lowered in .env.example.
export RATE_LIMIT_GLOBAL=100000
export RATE_LIMIT_AUTH=100000
export RATE_LIMIT_IMPORT=100000

mkdir -p "$IMPORT_ROOT"

# Same /dev/tcp probe as scripts/dev.sh.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0
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

# A leftover server from an interrupted run is the nastiest failure mode this
# script has: the new process fails to bind, the suite happily talks to the stale
# one, and the results describe code that is no longer on disk. The API is probed
# on /health because its root path 404s, which `curl -f` reads as "nothing is
# listening".
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first:" >&2
    echo "  pkill -f 'apps/api/dist/main.js'; pkill -f 'next start'" >&2
    exit 1
  fi
done

echo "==> Applying migrations"
pnpm --filter @fin/db exec prisma migrate deploy >/dev/null

echo "==> Building"
# NODE_ENV=production is required: `next build` under development produces a
# broken prerender that the build itself reports as successful.
NODE_ENV=production pnpm build

echo "==> Seeding the demo ledger"
pnpm --filter @fin/db run seed

# Drop Next's fetch cache, which the seed cannot invalidate.
#
# Server components read the API through fetch, which Next caches on disk under
# .next/cache/fetch-cache. That cache survives both a rebuild and a restart, so
# `next start` will serve a response captured during the previous run, from rows
# the seed has since deleted. `revalidateTag` is the normal way to clear it, but
# the seed is a separate process with no route to call it. The database is
# correct and the page is stale, which is the hardest kind of failure to read.
FETCH_CACHE="$ROOT/apps/web/.next/cache/fetch-cache"
if [[ -d "$FETCH_CACHE" ]]; then
  find "$FETCH_CACHE" -type f -delete
  echo "==> Cleared the Next fetch cache"
fi

echo "==> Starting the api on :${API_PORT} (log: ${API_LOG})"
# Plain `node`, not `nest start` or `pnpm start`: killing a wrapper only kills
# the wrapper, and the grandchild keeps the socket. `$!` here is the process that
# actually holds it.
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!

echo "==> Starting the web app on :${WEB_PORT} (log: ${WEB_LOG})"
pnpm --filter @fin/web exec next start -p "$WEB_PORT" >"$WEB_LOG" 2>&1 &
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting
    # out the full timeout hides the reason it died.
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Last 30 lines of ${log}:" >&2
      tail -30 "$log" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 30 lines of ${log}:" >&2
  tail -30 "$log" >&2
  exit 1
}

wait_for "${API_BASE_URL}/health" api "$API_PID" "$API_LOG"
wait_for "${APP_BASE_URL}/" web "$WEB_PID" "$WEB_LOG"

echo "==> Running Playwright"
# `exec playwright`, not `run test:e2e --`. pnpm 9 forwards the `--` itself to
# the script, so `./scripts/e2e.sh --project=chromium` became
# `playwright test -- --project=chromium`; Playwright read the bare `--` as a
# positional test filter, silently ignored the flag after it, and ran the whole
# suite in every browser while reporting nothing about the argument it dropped.
pnpm --filter @fin/e2e exec playwright test "$@"
