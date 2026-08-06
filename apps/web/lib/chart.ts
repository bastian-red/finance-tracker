import {
  formatMonth,
  month as parseMonth,
  type CategoryTotal,
  type MonthlyTotals,
} from '@fin/shared';

/**
 * The arithmetic behind the two charts, kept out of the chart components.
 *
 * Everything here is pure and integer. Chart geometry is the place a float
 * normally sneaks back into a money app — a library asked to autoscale an axis
 * will happily produce a domain of `[0, 1234.5600000000002]` and label it — so
 * the values that reach Recharts stay in **integer minor units** and only the
 * tick and tooltip labels go through `Intl`, via `formatMoney`, which takes an
 * exact decimal string. Nothing divides by 100 anywhere on this path.
 */

/** A point on the trend chart. Both magnitudes are positive; the axis starts at 0. */
export interface TrendPoint {
  month: string;
  /** `julio de 2026` in the reader's locale. The axis shows a shorter form. */
  label: string;
  incomeMinor: number;
  /** Positive magnitude. The ledger signs expenses negative. */
  expenseMinor: number;
  netMinor: number;
}

/** One bar of the by-category chart. */
export interface CategoryBar {
  categoryId: string | null;
  name: string;
  /** Positive magnitude, so the bars grow from a single baseline at zero. */
  amountMinor: number;
  shareBasisPoints: number;
}

/**
 * Round a maximum up to a number a person would choose for an axis.
 *
 * The axis domain is pinned rather than left to Recharts, and pinning it to the
 * exact maximum puts the tallest bar flush against the frame with no room for its
 * end label. So the ceiling is the next 1, 2 or 5 times a power of ten — the same
 * three steps every hand-drawn axis has used for a century, and the reason axis
 * ticks read as `0 / 1.000 / 2.000` rather than as `0 / 1.234 / 2.468`.
 *
 * Integer in, integer out. A zero or negative maximum yields 1 rather than 0,
 * because a domain of `[0, 0]` gives every bar an undefined width.
 */
export function niceCeiling(maxMinor: number): number {
  if (!Number.isFinite(maxMinor) || maxMinor <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maxMinor));
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= maxMinor) return candidate;
  }
  return 10 * magnitude;
}

/**
 * The trend chart's points, in the order the months happened.
 *
 * The API sends a **dense** trend — every month in the window, including the ones
 * with no rows — so this does not fill gaps and must not sort by amount. A chart
 * built from "the months that have rows" silently omits a month with no
 * spending, which is often the single most interesting month on the page.
 */
export function trendSeries(trend: readonly MonthlyTotals[], locale: string): TrendPoint[] {
  return trend.map((point) => ({
    month: point.month,
    label: formatMonth(parseMonth(point.month), locale),
    incomeMinor: Math.abs(point.incomeMinor),
    expenseMinor: Math.abs(point.expenseMinor),
    netMinor: point.netMinor,
  }));
}

/**
 * The by-category bars, largest first.
 *
 * Sorted here rather than in the chart, because sorting is what lets this be a
 * single-hue bar chart at all: rank is carried by position, so colour is free to
 * carry nothing. That is the ruling this project took over a ten-slice donut —
 * ten categorical hues cannot pass a CVD check, and a legend nobody can map back
 * to a slice is worse than no legend.
 *
 * Ties break on name so the order is stable across renders. Without that, two
 * categories that spent the same amount swap places between two loads of the same
 * page and the chart looks like it is showing different data.
 */
export function sortedCategoryBars(totals: readonly CategoryTotal[]): CategoryBar[] {
  return totals
    .map((total) => ({
      categoryId: total.categoryId,
      name: total.categoryName,
      amountMinor: Math.abs(total.amountMinor),
      shareBasisPoints: total.shareBasisPoints,
    }))
    .filter((bar) => bar.amountMinor > 0)
    .sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name));
}

/** The pinned upper bound for a set of series. See `niceCeiling`. */
export function axisMaximum(values: readonly number[]): number {
  return niceCeiling(Math.max(0, ...values.map((value) => Math.abs(value))));
}

/**
 * The short month label an axis tick shows.
 *
 * `julio de 2026` is 13 characters and there are up to 36 of them on the trailing
 * axis, so the tick gets `07/26` instead and the full form stays in the tooltip
 * and in the table. Built by slicing the `YYYY-MM` string rather than by
 * formatting a `Date`, because there is no instant involved and constructing one
 * is how a July row becomes a June label in a zone west of UTC.
 */
export function axisMonthLabel(value: string): string {
  return `${value.slice(5, 7)}/${value.slice(2, 4)}`;
}
