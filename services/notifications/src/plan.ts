/**
 * Deciding which budgets are worth an email.
 *
 * Pure: statuses in, planned alerts out. No database, no clock, no network,
 * which is what lets the API call it inside the same request that computed the
 * report rather than scheduling a job to recompute the same numbers a second
 * time and get a different answer.
 *
 * The level itself is not decided here. `alertLevelFor` in `@fin/shared` owns
 * that, because the dashboard draws the same three states and the two must
 * agree: a screen that says "under" beside an email that says "approaching" is
 * worse than either one being wrong on its own.
 */
import { alertLevelFor, type BudgetStatus, type CalendarMonth } from '@fin/shared';
import type { PlannedAlert } from './types';

/** `exceeded` sorts before `approaching`. Lower number, higher up the list. */
const LEVEL_RANK = { exceeded: 0, approaching: 1 } as const;

/**
 * Every alert the given month deserves, in the order they should be written.
 *
 * **The month filter is not the caller's job.** A monthly report carries a
 * trailing window (twelve months by default), so `report.budgets` contains
 * statuses for months that were settled long ago. A backfilled transaction that
 * pushes last August over its limit must not mail the user about August: the
 * period is closed, they cannot act on it, and the alert would arrive as noise
 * that makes the next real one less likely to be read. Filtering here means no
 * caller has to remember.
 *
 * **The order is load-bearing, not cosmetic.** The API inserts these rows in
 * sequence and the e2e suite asserts on the first one, so an unstable order is
 * a flaky test and an alert list that reshuffles between two identical
 * requests. `exceeded` first (it is the one that needs action), then the
 * fullest budget, then `budgetId` so a tie can never depend on the order
 * Postgres happened to return the rows in.
 *
 * **This deliberately does NOT deduplicate against what was already sent.** It
 * has no way to: two concurrent requests both pass any "have I sent this?"
 * check before either writes, and the second one then sends a duplicate. The
 * only place that can settle it is the `@@unique([budgetId, month, level])`
 * constraint on `alerts`, so the API inserts and treats a unique violation as
 * "already sent". Adding a check here would look like it worked and would fail
 * exactly under the load that makes it matter.
 *
 * Never throws, and returns `[]` for empty input. It runs on the tail of a
 * request that has already committed its transaction; there is nothing useful
 * for it to raise.
 */
export function planAlerts(
  statuses: readonly BudgetStatus[],
  month: CalendarMonth,
): PlannedAlert[] {
  const planned: PlannedAlert[] = [];

  for (const status of statuses) {
    if (status.month !== month) continue;
    const level = alertLevelFor(status.state);
    if (level === null) continue;

    planned.push({
      budgetId: status.budgetId,
      categoryId: status.categoryId,
      categoryName: status.categoryName,
      month: status.month as CalendarMonth,
      level,
      limitMinor: status.limitMinor,
      spentMinor: status.spentMinor,
      usedBasisPoints: status.usedBasisPoints,
    });
  }

  planned.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      b.usedBasisPoints - a.usedBasisPoints ||
      (a.budgetId < b.budgetId ? -1 : a.budgetId > b.budgetId ? 1 : 0),
  );

  return planned;
}
