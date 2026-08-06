"""Format the per-category spend table that sizes the seed's budget limits.

Reads tab-separated `category, min, median, max, current` rows on stdin (see
`budget-fit.sh`, which supplies them from Postgres) and the limits the seed
currently sets, and prints the state each budget would land in.

Integer arithmetic throughout, and the same comparison the app uses:
`spent * 10000 >= limit * threshold`. A float version here would disagree with
`packages/shared/src/budget/status.ts` at the boundary, and the whole point of
this table is to predict what the screen will say.
"""

from __future__ import annotations

import os
import sys

SEED = "packages/db/prisma/seed.ts"
BASIS_POINTS = 10_000


def seeded_limits(path: str) -> dict[str, int]:
    """The limits the seed sets, read back out of the source.

    Parsed rather than duplicated so the table reports the real gap between what
    is budgeted and what is spent, instead of an aspiration that was edited in
    one file and not the other.
    """
    limits: dict[str, int] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith("{ category: '") or "limitMinor: " not in line:
                continue
            name = line.split("'")[1]
            raw = line.split("limitMinor: ", 1)[1].split(",", 1)[0]
            limits[name] = int(raw.replace("_", ""))
    return limits


def state(spent: int, limit: int, threshold_bp: int) -> str:
    if spent > limit:
        return "exceeded"
    if spent * BASIS_POINTS >= limit * threshold_bp:
        return "approaching"
    return "under"


def main() -> int:
    reference = os.environ["REFERENCE_MONTH"]
    threshold_bp = int(os.environ["THRESHOLD_BP"])
    limits = seeded_limits(SEED)

    rows = []
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        category, low, median, high, current = line.split("\t")
        rows.append((category, int(low), int(median), int(high), int(current)))

    if not rows:
        print("No seeded expense transactions found. Run `pnpm db:seed` first.", file=sys.stderr)
        return 1

    width = max(max(len(row[0]) for row in rows), len("category"))
    print(f"reference month {reference}, approaching at {threshold_bp / 100:.0f}% of the limit")
    print()
    header = (
        f"{'category'.ljust(width)} {'min/mo':>10} {'median/mo':>10} "
        f"{'max/mo':>10} {reference:>10} {'limit':>10}  state"
    )
    print(header)
    print("-" * len(header))
    for category, low, median, high, current in rows:
        limit = limits.get(category)
        if limit is None:
            verdict, shown = "no budget", "-"
        else:
            used = current * BASIS_POINTS / limit / 100
            verdict = f"{state(current, limit, threshold_bp)} ({used:.0f}%)"
            shown = str(limit)
        print(
            f"{category.ljust(width)} {low:>10} {median:>10} "
            f"{high:>10} {current:>10} {shown:>10}  {verdict}"
        )
    print()
    print("Amounts are minor units (cents), positive as money out.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
