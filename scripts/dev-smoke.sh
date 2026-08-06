#!/usr/bin/env bash
#
# Smoke the documented developer command: `pnpm dev`.
#
# scripts/env-contract.mjs proves the variable names are declared. It cannot
# prove they arrive. That depends on package.json pointing "dev" at
# scripts/dev.sh, on dev.sh sourcing .env, and on turbo passing every name
# through in strict mode. This boots the real `pnpm dev` and asserts the app
# serves a page built from the database.
#
# Why it is not folded into scripts/e2e.sh: that lane sources .env itself and
# starts the built apps directly, never touching turbo. It is a different code
# path, and in the three sibling projects it stayed green for months while the
# documented `pnpm dev` was broken. A lane that cannot fail the way the README
# fails is not covering the README.
#
# The one rule that makes this check real: it supplies the child with NOTHING.
# Every name .env.example documents is stripped with `env -u` before `pnpm dev`
# starts, so the only path configuration can take is .env -> dev.sh -> turbo ->
# the process. An earlier version of this idea in a sibling project did
# `set -a; . ./.env` first, which put every value into its own environment, so
# the app was configured by the test rather than by the repo and the check
# passed with the fix reverted.
#
# Usage: ./scripts/dev-smoke.sh
# Assumes Postgres and Redis are up and the database is migrated and seeded:
#   docker compose -f infra/docker-compose.yml up -d
#   pnpm db:deploy && pnpm db:seed
set -euo pipefail

# Job control, so each background job lands in its own process group and the
# cleanup below can take down turbo *and* the next/nest children it spawned.
# Killing only the turbo PID leaves servers holding :3000 and :4000, which makes
# the next run fail for a reason unrelated to the code.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG=/tmp/fin-dev-smoke.log
COOKIES="$(mktemp -t fin-dev-smoke-cookies.XXXXXX)"
DEV_PID=""

# Bounded, and stated once. A cold .next on a loaded machine is slow, so it is
# overridable, but there is no unbounded wait anywhere in this file: a hang has
# to fail with a message rather than sit there.
WAIT_SECONDS="${WAIT_SECONDS:-60}"

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f .env ]] || die "no .env in the repo root. See README.md, 'Running it'."
[[ -f .env.example ]] || die "no .env.example, so there is no list of names to strip."

# Read what the probes need WITHOUT sourcing .env, for the reason in the header.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" .env | tail -1
}

API_PORT="$(env_value API_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"
API_BASE_URL="$(env_value API_BASE_URL)"
APP_BASE_URL="$(env_value APP_BASE_URL)"
API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"

# The routes this asserts against. Overridable so a rename is a one-line change
# here rather than a rewrite, but defaulted to what the README documents.
DASHBOARD_PATH="${DASHBOARD_PATH:-/dashboard}"
TRANSACTIONS_PATH="${TRANSACTIONS_PATH:-/transactions}"

# Every signed-in route in components/nav.tsx, read out of the file rather than
# retyped. A route added to the nav and forgotten here would be a route nobody
# ever loads until a reader does.
#
# This list exists because of a concrete outage: `GET /budgets/status` was never
# added to `apps/api/src/budgets/budgets.controller.ts`, so `/budgets` answered
# 500 while `/`, `/transactions` and every unit test stayed green. Two probed
# routes cannot catch a third route being broken.
mapfile -t NAV_PATHS < <(
  sed -n "s/^[[:space:]]*{ href: '\([^']*\)'.*/\1/p" apps/web/components/nav.tsx
)
[[ ${#NAV_PATHS[@]} -gt 0 ]] ||
  die "could not read any hrefs out of apps/web/components/nav.tsx."

# --- Facts read out of the seed, never retyped here -------------------------
#
# A copy of a seeded string that drifts from the seed produces a check that is
# confidently about data that no longer exists, which is worse than no check.
# Same idiom as scripts/budget-fit.sh reading REFERENCE_MONTH out of the file.

SEED=packages/db/prisma/seed.ts
CATEGORIES=packages/shared/src/categories.ts

DEMO_EMAIL="$(sed -n "s/^const DEMO_EMAIL = '\([^']*\)';.*/\1/p" "$SEED")"
DEMO_PASSWORD="$(sed -n "s/^const DEMO_PASSWORD = '\([^']*\)';.*/\1/p" "$SEED")"
[[ -n "$DEMO_EMAIL" && -n "$DEMO_PASSWORD" ]] ||
  die "could not read DEMO_EMAIL / DEMO_PASSWORD out of ${SEED}."

# The first category in the taxonomy the seed plants. Its name is a plain string
# and stable across runs, unlike the cuid primary keys.
CATEGORY_NAME="$(sed -n "s/^[[:space:]]*name: '\([^']*\)',$/\1/p" "$CATEGORIES" | head -1)"
[[ -n "$CATEGORY_NAME" ]] || die "could not read a category name out of ${CATEGORIES}."

# The first account the seed opens. The import screen is the one route with no
# category on it -- its upload form lists accounts -- so this is what proves that
# page read the database rather than rendering an empty select.
ACCOUNT_NAME="$(sed -n "s/^[[:space:]]*name: '\([^']*\)',$/\1/p" "$SEED" | sed -n 2p)"
[[ -n "$ACCOUNT_NAME" ]] || die "could not read an account name out of ${SEED}."

# Every merchant label the seed can write. The transactions page is paginated and
# ordered by date, so pinning one specific label would be a coin flip; matching
# any of them is the assertion that actually means "these rows came from the
# database".
mapfile -t MERCHANTS < <(sed -n "s/.*{ label: '\([^']*\)'.*/\1/p" "$SEED" | sort -u)
[[ ${#MERCHANTS[@]} -gt 0 ]] || die "could not read any merchant labels out of ${SEED}."

# --- How this locale writes money, computed rather than recalled -------------
#
# `es-ES` renders 1234.56 as "1.234,56 EUR-symbol" and `en-US` as "$1,234.56":
# the decimal separator and the symbol both move. Typing either into a grep
# pattern from memory is how a correct page fails a wrong assertion, so both are
# asked of Intl, using the same locale and currency the app was configured with.
DEFAULT_CURRENCY="$(env_value DEFAULT_CURRENCY)"
DEFAULT_LOCALE="$(env_value DEFAULT_LOCALE)"
read -r MONEY_SYMBOL MONEY_DECIMAL < <(
  LOC="${DEFAULT_LOCALE:-es-ES}" CUR="${DEFAULT_CURRENCY:-EUR}" node -e '
    const locale = process.env.LOC;
    const currency = process.env.CUR;
    const money = new Intl.NumberFormat(locale, { style: "currency", currency });
    // Strip digits, grouping, decimals and every flavour of space. The two
    // escapes are U+00A0 and U+202F, the characters a locale actually puts
    // before a currency symbol. They are escapes rather than literals because
    // pasted raw they are indistinguishable from a space in every editor.
    const symbol = money.format(0).replace(/[\d\s\u00a0\u202f.,]/gu, "");
    const decimal = new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((part) => part.type === "decimal").value;
    // The trailing newline is load-bearing: `read` returns non-zero at EOF
    // without a delimiter, and under `set -e` that ends the script here.
    process.stdout.write(`${symbol} ${decimal}\n`);
  '
)
[[ -n "$MONEY_SYMBOL" && -n "$MONEY_DECIMAL" ]] ||
  die "could not derive the money format for ${DEFAULT_LOCALE:-es-ES}/${DEFAULT_CURRENCY:-EUR}."

# --- Refuse to run against somebody else's server ---------------------------
#
# A leftover dev server is the worst failure mode here: the new process fails to
# bind, the probes talk to the stale one, and the result describes code that is
# no longer on disk.
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    die "something is already serving ${url}. Stop it first."
  fi
done

# --- Strip the environment and start ----------------------------------------
#
# Derived from .env.example rather than hardcoded, so a variable added next month
# is stripped without anyone remembering to come back here. .env is unioned in
# because a local file may carry a name the example does not yet document, and
# an unstripped name is a hole in exactly this check.
mapfile -t ENV_KEYS < <(
  sed -n 's/^[[:space:]]*#\?[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' .env.example .env |
    sort -u
)
[[ ${#ENV_KEYS[@]} -gt 0 ]] || die "parsed no variable names out of .env.example."

UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

echo "==> Starting: pnpm dev (${#ENV_KEYS[@]} .env names stripped from the child environment)"
echo "    log: ${LOG}"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

# The API is polled for ANY response rather than a 2xx: /health answers 503 when
# a dependency is down, and a 503 that names the failing check is far more useful
# than a timeout that says nothing. The body is asserted below either way.
wait_for() {
  local url="$1" name="$2" mode="${3:-ok}"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if [[ "$mode" == "any" ]]; then
      curl -s -o /dev/null "$url" 2>/dev/null && return 0
    elif curl -sf -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting
    # out the full timeout hides the reason it died.
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 40 lines of ${LOG}:" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 40 lines of ${LOG}:" >&2
  tail -40 "$LOG" >&2
  exit 1
}

echo "==> Waiting for the api on :${API_PORT} and the web app on :${WEB_PORT}"
wait_for "${API_BASE_URL}/health" "api (:${API_PORT})" any
wait_for "${APP_BASE_URL}/" "web (:${WEB_PORT})"

# --- /health, parsed as JSON rather than grepped ----------------------------
#
# The shape is packages/shared/src/contracts/index.ts `healthSchema`:
# { status, version, uptimeSeconds, checks: [{ name, status, latencyMs, detail }] }.
# A regex over JSON passes on a body that happens to contain the right substring
# in the wrong place; JSON.parse does not.
echo "==> Checking /health reports postgres and redis"
health="$(curl -s "${API_BASE_URL}/health")"
if ! HEALTH_BODY="$health" node -e '
  let health;
  try {
    health = JSON.parse(process.env.HEALTH_BODY ?? "");
  } catch {
    console.error("  /health did not return JSON:", (process.env.HEALTH_BODY ?? "").slice(0, 400));
    process.exit(1);
  }
  const problems = [];
  if (health.status !== "ok") problems.push(`status is ${JSON.stringify(health.status)}, not "ok"`);
  const checks = Array.isArray(health.checks) ? health.checks : [];
  for (const required of ["postgres", "redis"]) {
    const check = checks.find((c) => String(c?.name ?? "").toLowerCase().startsWith(required));
    if (!check) problems.push(`no "${required}" entry in checks[]`);
    else if (check.status !== "ok") problems.push(`${required} reports ${check.status}: ${check.detail ?? "no detail"}`);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
'; then
  echo "  body: ${health}" >&2
  die "/health is not green. A green endpoint with a dead datastore behind it is the bug this catches."
fi

# --- Sign in, the way a person does -----------------------------------------
#
# Every page worth asserting on is behind the session, so there is no anonymous
# database-backed page to grep. Auth.js exposes a stable HTTP interface for this:
# GET /api/auth/csrf, then POST the token back to the credentials callback with
# the cookie jar carrying the double-submit cookie.
echo "==> Signing in as ${DEMO_EMAIL}"
csrf="$(
  curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/csrf" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          process.stdout.write(String(JSON.parse(raw).csrfToken ?? ""));
        } catch {
          /* Not JSON. The caller fails on the empty value with a better message. */
        }
      });
    '
)"
[[ -n "$csrf" ]] || die "GET ${APP_BASE_URL}/api/auth/csrf returned no csrfToken. Auth.js is not mounted."

curl -s -o /dev/null -L -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "csrfToken=${csrf}" \
  --data-urlencode "email=${DEMO_EMAIL}" \
  --data-urlencode "password=${DEMO_PASSWORD}" \
  "${APP_BASE_URL}/api/auth/callback/credentials"

session="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/session")"
if ! grep -qF "$DEMO_EMAIL" <<<"$session"; then
  echo "  session: ${session}" >&2
  echo "  Last 40 lines of ${LOG}:" >&2
  tail -40 "$LOG" >&2
  die "sign-in did not produce a session. Either AUTH_SECRET never reached the web app or the seed did not run."
fi

# --- The load-bearing assertions --------------------------------------------
#
# Content, not status codes. A broken app answers 200 with an error page, and an
# error page is exactly what a missing AUTH_SECRET or an unreachable API_BASE_URL
# produces, so a `curl -f` check would have passed through the whole outage this
# script exists for.
echo "==> Checking ${DASHBOARD_PATH} rendered the ledger"
dashboard="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}${DASHBOARD_PATH}")"

grep -qF "$CATEGORY_NAME" <<<"$dashboard" ||
  { tail -40 "$LOG" >&2; die "${DASHBOARD_PATH} does not contain the seeded category '${CATEGORY_NAME}'. It is an error page or an empty shell."; }

# Two separate assertions rather than one pattern spanning both, because markup
# is free to put the amount and the symbol in sibling elements.
grep -qF "$MONEY_SYMBOL" <<<"$dashboard" ||
  die "${DASHBOARD_PATH} contains no '${MONEY_SYMBOL}', so nothing on it is a formatted amount."
grep -Eq "[0-9][${MONEY_DECIMAL}][0-9][0-9]" <<<"$dashboard" ||
  die "${DASHBOARD_PATH} contains no amount written as N${MONEY_DECIMAL}NN, so no money was rendered."

echo "==> Checking ${TRANSACTIONS_PATH} rendered seeded rows"
transactions="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}${TRANSACTIONS_PATH}")"
matched=""
for merchant in "${MERCHANTS[@]}"; do
  if grep -qF "$merchant" <<<"$transactions"; then
    matched="$merchant"
    break
  fi
done
if [[ -z "$matched" ]]; then
  tail -40 "$LOG" >&2
  die "${TRANSACTIONS_PATH} shows none of the ${#MERCHANTS[@]} seeded merchants. Those rows did not come from the database."
fi
echo "    matched: ${matched}"

# --- Every route in the nav, not just the two above -------------------------
#
# Status *and* content, in that order. A server component that throws answers
# 500, which the two checks above would catch on their own routes and nowhere
# else; a route whose API call quietly returns nothing answers 200 with an empty
# shell, which a status check alone would pass. Both are real failures this
# project has shipped.
#
# The needle is the nav's own landmark plus a per-route string, because a Next
# error page still carries the app's <html> shell but not the signed-in chrome.
echo "==> Checking every route in the nav renders for a signed-in reader"
route_failures=0
for path in "${NAV_PATHS[@]}"; do
  route_body="$(curl -s -L -b "$COOKIES" -c "$COOKIES" -w '\n%{http_code}' "${APP_BASE_URL}${path}")"
  route_status="${route_body##*$'\n'}"
  route_html="${route_body%$'\n'*}"

  if [[ "$route_status" != "200" ]]; then
    echo "  ${path} answered ${route_status}" >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  # The primary nav only renders inside the signed-in layout, so its absence
  # means an error boundary or the login page, whatever the status said.
  if ! grep -qF 'aria-label="Primary"' <<<"$route_html"; then
    echo "  ${path} answered 200 without the signed-in chrome. It is an error page." >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  # And something only a database-backed render produces. The seeded category
  # name appears on every one of these screens: as a budget's category, a chip
  # in the ledger, a row in the taxonomy, a rule's target, the tester's samples,
  # or a suggested category on the import screen's empty state copy. The one
  # exception is the bare `/import` upload form, which is checked for the
  # seeded account name instead.
  case "$path" in
  /import) needle="$ACCOUNT_NAME" ;;
  *) needle="$CATEGORY_NAME" ;;
  esac
  if ! grep -qF "$needle" <<<"$route_html"; then
    echo "  ${path} rendered without '${needle}', so nothing on it came from the database." >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  echo "    ${path} ok"
done

if [[ "$route_failures" -gt 0 ]]; then
  tail -40 "$LOG" >&2
  die "${route_failures} of ${#NAV_PATHS[@]} nav routes did not render."
fi

# --- The symptoms of the original outage, by name ---------------------------
echo "==> Checking the dev log is clean"
PATTERN='ECONNREFUSED|MissingSecret|AUTH_SECRET is not set|AUTH_SECRET must be|Invalid environment|is not defined in the environment'
if grep -qE "$PATTERN" "$LOG"; then
  echo "pnpm dev logged an environment failure even though the pages rendered:" >&2
  grep -nE "$PATTERN" "$LOG" | head -5 >&2
  exit 1
fi

echo
echo "PASS: pnpm dev serves all ${#NAV_PATHS[@]} nav routes from the seeded database,"
echo "      /health green on postgres and redis, with ${#ENV_KEYS[@]} .env names stripped from its environment."
