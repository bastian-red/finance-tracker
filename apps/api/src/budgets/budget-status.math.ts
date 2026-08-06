/**
 * Resolving stored budgets against real spending, for a window of months.
 *
 * Pure: rows in, `BudgetStatus[]` out. No database, no clock. That is what lets
 * the dashboard and the alert mailer run the same function over the same numbers
 * and be unable to disagree, which is the failure this whole shape exists to
 * prevent: an email saying a budget is blown beside a screen saying it is fine.
 *
 * A budget covers a *range* of months, so one stored row produces one status per
 * month it covers. That is why the report carries statuses for the whole trailing
 * window rather than for the selected month alone, and why `planAlerts` filters
 * by month rather than trusting its caller to.
 */
import {
  evaluateBudget,
  minor,
  monthRange,
  type BudgetStatus,
  type CalendarMonth,
} from '@fin/shared';
import { minorFromSum } from '../common/numbers';

/** One stored budget, with its category's display fields already joined on. */
export interface BudgetPeriod {
  id: string;
  categoryId: string;
  categoryName: string;
  colorSlot: number;
  limitMinor: number;
  effectiveFrom: CalendarMonth;
  /** Null means "still in force", which is unbounded above. */
  effectiveTo: CalendarMonth | null;
}

/**
 * One `GROUP BY category, month` row of expense.
 *
 * `amountMinor` is typed to accept `bigint` because that is what it is: Postgres
 * returns `SUM(int4)` as `bigint` and Prisma hands back a JavaScript `BigInt`.
 * Carrying it any further is a `TypeError` from `JSON.stringify`, so it is
 * converted here, at the boundary, by `minorFromSum`.
 */
export interface CategoryMonthSpend {
  categoryId: string | null;
  month: string;
  amountMinor: bigint | number | null;
}

/**
 * `<categoryId>` NUL `<month>`.
 *
 * NUL rather than a space or a dash because it is the one byte a cuid2 id and a
 * `YYYY-MM` month can never contain, so two different pairs cannot produce the
 * same key. It is spelled as the escape `\u0000` and never as the byte itself:
 * written raw it rendered as nothing here and as a space in the comment above,
 * which cost four unit tests failing with `expected undefined` against code that
 * was correct. `scripts/invisible-chars.mjs` refuses the byte at commit time now.
 */
export function spendKey(categoryId: string, month: string): string {
  return `${categoryId}\u0000${month}`;
}

export function indexSpend(rows: readonly CategoryMonthSpend[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const row of rows) {
    if (row.categoryId === null) continue;
    index.set(spendKey(row.categoryId, row.month), minorFromSum(row.amountMinor));
  }
  return index;
}

/**
 * Every (budget, month) pair inside the window, evaluated.
 *
 * The sort is load-bearing rather than cosmetic. The e2e suite and the alert
 * planner both index into this array, and a list whose order depends on the order
 * Postgres returned the budget rows in is a flaky test and a table that reshuffles
 * between two identical requests. Month first (it is the axis a reader scans),
 * then category name, then id so a tie can never be undecided.
 */
export function budgetStatuses(
  periods: readonly BudgetPeriod[],
  spend: readonly CategoryMonthSpend[],
  months: readonly CalendarMonth[],
  approachingBasisPoints: number,
): BudgetStatus[] {
  const index = indexSpend(spend);
  const inWindow = new Set<string>(months);
  const statuses: BudgetStatus[] = [];

  for (const period of periods) {
    // Bounded by the window on both ends: an open-ended budget that started in
    // 2019 must not produce eighty statuses for a twelve-month report.
    const last = period.effectiveTo ?? months[months.length - 1];
    if (last === undefined) continue;
    if (period.effectiveFrom > last) continue;

    for (const month of monthRange(period.effectiveFrom, last)) {
      if (!inWindow.has(month)) continue;

      // `evaluateBudget` takes the signed sum and makes it absolute itself, so a
      // caller that forgot to flip the sign cannot produce a permanently green
      // budget with a negative bar.
      const evaluation = evaluateBudget({
        limitMinor: minor(period.limitMinor),
        spentMinor: minor(index.get(spendKey(period.categoryId, month)) ?? 0),
        approachingBasisPoints,
      });

      statuses.push({
        budgetId: period.id,
        categoryId: period.categoryId,
        categoryName: period.categoryName,
        colorSlot: period.colorSlot,
        month,
        limitMinor: evaluation.limitMinor,
        spentMinor: evaluation.spentMinor,
        usedBasisPoints: evaluation.usedBasisPoints,
        state: evaluation.state,
      });
    }
  }

  statuses.sort(
    (a, b) =>
      compare(a.month, b.month) ||
      compare(a.categoryName, b.categoryName) ||
      compare(a.budgetId, b.budgetId),
  );

  return statuses;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
