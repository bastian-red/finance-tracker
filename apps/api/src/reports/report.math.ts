/**
 * The arithmetic behind the dashboard, as pure functions over query rows.
 *
 * Two properties are worth stating, because getting either wrong produces a chart
 * that is confidently wrong rather than obviously broken.
 *
 * **Every aggregate arrives as a `bigint`.** `SUM(int4)` in Postgres is `bigint`,
 * so Prisma's `$queryRaw` hands back a JavaScript `BigInt` for every rollup here.
 * `JSON.stringify(1n)` **throws** -- not a wrong number, an unhandled `TypeError`
 * in the serialiser -- so a route that worked perfectly against an empty ledger
 * starts answering 500 the moment the first row is inserted. It is the class of
 * bug that passes every test written before the data existed. `minorFromSum`
 * converts at this boundary and nothing downstream ever sees one.
 *
 * **The trend is dense.** Every month in the window appears, including the ones
 * with no rows at all. A chart built from "the months that have transactions"
 * silently omits the month somebody spent nothing, which is the single most
 * interesting month on the page.
 *
 * A note on sign, because two conventions are defensible and this file picks one:
 * `expenseMinor` and `spentMinor` are both **positive magnitudes**, and
 * `netMinor` is `income - expense`. The ledger stores expenses negative; the
 * report does not. One convention across the whole response object beats two,
 * and `budgetStatusSchema.spentMinor` is documented as an absolute, so this is
 * the one that makes the object internally consistent.
 */
import {
  minor,
  shareInBasisPoints,
  UNCATEGORISED_SLOT,
  type CalendarMonth,
  type CategoryTotal,
  type MonthlyTotals,
} from '@fin/shared';
import { minorFromSum } from '../common/numbers';

/** One `GROUP BY month` row: income and expense split by sign. */
export interface MonthlySumRow {
  month: string;
  incomeMinor: bigint | number | null;
  /** Negative, as stored. Made absolute here. */
  expenseMinor: bigint | number | null;
}

/** One `GROUP BY category` row of expense for a single month. */
export interface CategorySumRow {
  categoryId: string | null;
  categoryName: string | null;
  colorSlot: number | null;
  amountMinor: bigint | number | null;
}

/** What an amount with no category is called on the chart. */
export const UNCATEGORISED_NAME = 'Uncategorised';

export function totalsOf(month: CalendarMonth, row: MonthlySumRow | undefined): MonthlyTotals {
  const incomeMinor = minorFromSum(row?.incomeMinor);
  const expenseMinor = minor(Math.abs(minorFromSum(row?.expenseMinor)));
  return {
    month,
    incomeMinor,
    expenseMinor,
    netMinor: minor(incomeMinor - expenseMinor),
  };
}

/** One entry per month in the window, in ascending order, gaps filled with zeros. */
export function denseTrend(
  months: readonly CalendarMonth[],
  rows: readonly MonthlySumRow[],
): MonthlyTotals[] {
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  return months.map((month) => totalsOf(month, byMonth.get(month)));
}

/**
 * Category spending for one month, as positive magnitudes with their share.
 *
 * The share is integer basis points rather than a percentage float, so the pie
 * slice's angle and the "24%" label beside it come from the same integer and
 * cannot disagree at the boundary.
 *
 * Sorted by amount descending so the chart's "top seven plus Other" cut is a
 * `slice`, and by name after that so two categories with identical spending do
 * not swap places between two identical requests.
 */
export function categoryTotals(rows: readonly CategorySumRow[]): CategoryTotal[] {
  const totals = rows.map((row) => ({
    categoryId: row.categoryId,
    categoryName: row.categoryName ?? UNCATEGORISED_NAME,
    // A negative slot rather than a magic name: "uncategorised" is a real and
    // common state, it must be visible on the chart rather than dropped, and it
    // must not steal a hue a real category could be using.
    colorSlot: row.colorSlot ?? UNCATEGORISED_SLOT,
    amountMinor: minor(Math.abs(minorFromSum(row.amountMinor))),
  }));

  const whole = minor(totals.reduce((sum, total) => sum + total.amountMinor, 0));

  return totals
    .map((total) => ({
      ...total,
      shareBasisPoints: shareInBasisPoints(total.amountMinor, whole),
    }))
    .sort(
      (a, b) =>
        b.amountMinor - a.amountMinor ||
        (a.categoryName < b.categoryName ? -1 : a.categoryName > b.categoryName ? 1 : 0),
    );
}
