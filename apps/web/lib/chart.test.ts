import type { CategoryTotal, MonthlyTotals } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { axisMaximum, axisMonthLabel, niceCeiling, sortedCategoryBars, trendSeries } from './chart';

/**
 * The arithmetic behind both charts, pinned away from the components.
 *
 * Chart geometry is where a float normally sneaks back into a money app: a
 * library asked to autoscale an axis will produce a domain of
 * `[0, 1234.5600000000002]` and label it without complaint. Everything here is
 * integer minor units in and integer minor units out, and these cases exist to
 * keep it that way.
 *
 * The month labels are computed by string slicing rather than by formatting a
 * `Date`, and one case below states why: constructing an instant for `2026-07`
 * and formatting it is how a July row becomes a June label for a reader west of
 * UTC. The expectations that do go through `Intl` were produced by running the
 * function, never by recalling what `es-ES` does.
 */

describe('niceCeiling', () => {
  it('rounds up to the 1, 2 or 5 a person would pick for an axis', () => {
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(1234)).toBe(2000);
    expect(niceCeiling(2001)).toBe(5000);
    expect(niceCeiling(5001)).toBe(10_000);
    expect(niceCeiling(87_500)).toBe(100_000);
  });

  it('returns the value itself when it is already a round step', () => {
    // Not the *next* step up: an axis whose data tops out at exactly 2000 should
    // read 0 / 1.000 / 2.000, not 0 / 2.500 / 5.000 with a bar two-fifths tall.
    expect(niceCeiling(1000)).toBe(1000);
    expect(niceCeiling(2000)).toBe(2000);
    expect(niceCeiling(5000)).toBe(5000);
  });

  it('never returns zero, because a domain of [0, 0] gives every bar no width', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-500)).toBe(1);
    expect(niceCeiling(Number.NaN)).toBe(1);
    expect(niceCeiling(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('is an integer for every integer input, so no float reaches the axis', () => {
    for (const value of [1, 7, 99, 100, 3456, 999_999, 21_474_836]) {
      const ceiling = niceCeiling(value);
      expect(Number.isInteger(ceiling), `${value} -> ${ceiling}`).toBe(true);
      expect(ceiling).toBeGreaterThanOrEqual(value);
    }
  });
});

describe('axisMaximum', () => {
  it('takes the largest magnitude across every series', () => {
    // Expenses arrive negative from the ledger; an axis that read the raw
    // minimum would put the tallest bar off the top of the frame.
    expect(axisMaximum([1200, -9500, 300])).toBe(10_000);
  });

  it('survives an empty series rather than returning -Infinity', () => {
    // `Math.max()` with no arguments is -Infinity, which is why the seed value
    // is there. An empty month is a normal state, not an error.
    expect(axisMaximum([])).toBe(1);
  });
});

describe('trendSeries', () => {
  const trend: MonthlyTotals[] = [
    { month: '2026-05', incomeMinor: 250_000, expenseMinor: -180_000, netMinor: 70_000 },
    { month: '2026-06', incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
    { month: '2026-07', incomeMinor: 250_000, expenseMinor: -310_000, netMinor: -60_000 },
  ];

  it('keeps the API order and never sorts by amount', () => {
    // The API sends a dense trend, every month in the window included. Sorting
    // or filtering here would drop the empty month, which is often the single
    // most interesting one on the page.
    expect(trendSeries(trend, 'es-ES').map((point) => point.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  it('reports both magnitudes as positive so the axis starts at zero', () => {
    const points = trendSeries(trend, 'es-ES');
    expect(points.map((point) => point.expenseMinor)).toEqual([180_000, 0, 310_000]);
    expect(points.every((point) => point.incomeMinor >= 0)).toBe(true);
  });

  it('keeps net signed, because a negative month is the fact worth seeing', () => {
    expect(trendSeries(trend, 'es-ES').map((point) => point.netMinor)).toEqual([
      70_000, 0, -60_000,
    ]);
  });

  it('labels in the locale it is given, not the machine one', () => {
    // Both computed by running `formatMonth`, not recalled. `es-ES` writes the
    // month name in lower case and joins with "de"; `en-US` does neither.
    const spanish = trendSeries([trend[2]!], 'es-ES')[0]?.label;
    const english = trendSeries([trend[2]!], 'en-US')[0]?.label;
    expect(spanish).toBe('julio de 2026');
    expect(english).toBe('July 2026');
  });
});

describe('sortedCategoryBars', () => {
  const total = (name: string, amountMinor: number, share = 0): CategoryTotal => ({
    categoryId: `cat_${name}`,
    categoryName: name,
    colorSlot: 0,
    amountMinor,
    shareBasisPoints: share,
  });

  it('sorts largest first, which is what lets the chart be one hue', () => {
    // Rank is carried by position, so colour carries nothing. That is the ruling
    // this project took over a ten-slice donut: ten categorical hues cannot pass
    // a colour vision deficiency check.
    const bars = sortedCategoryBars([total('Transport', -3000), total('Groceries', -12_000)]);
    expect(bars.map((bar) => bar.name)).toEqual(['Groceries', 'Transport']);
  });

  it('breaks ties on name, so two equal categories do not swap between renders', () => {
    const bars = sortedCategoryBars([total('Zoo', -5000), total('Aviary', -5000)]);
    expect(bars.map((bar) => bar.name)).toEqual(['Aviary', 'Zoo']);
    // The property that matters, stated directly: the same input twice gives
    // the same order.
    expect(sortedCategoryBars([total('Zoo', -5000), total('Aviary', -5000)])).toEqual(bars);
  });

  it('takes the magnitude, so bars grow from one baseline at zero', () => {
    expect(sortedCategoryBars([total('Groceries', -12_000)])[0]?.amountMinor).toBe(12_000);
  });

  it('drops a category that spent nothing rather than drawing a zero-width bar', () => {
    const bars = sortedCategoryBars([total('Groceries', -12_000), total('Holidays', 0)]);
    expect(bars.map((bar) => bar.name)).toEqual(['Groceries']);
  });

  it('keeps the uncategorised bucket, which has a null id and is not a category', () => {
    // Uncategorised spending is the queue of work after an import. Dropping it
    // would make the chart's total quietly disagree with the month's total.
    const bars = sortedCategoryBars([
      {
        categoryId: null,
        categoryName: 'Uncategorised',
        colorSlot: 0,
        amountMinor: -8000,
        shareBasisPoints: 4000,
      },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.categoryId).toBeNull();
  });
});

describe('axisMonthLabel', () => {
  it('shortens YYYY-MM to MM/YY', () => {
    expect(axisMonthLabel('2026-07')).toBe('07/26');
    expect(axisMonthLabel('2019-12')).toBe('12/19');
  });

  it('is pure string surgery, so no time zone can move the month', () => {
    // `new Date('2026-07')` is midnight UTC, and formatting that in any zone
    // west of UTC gives June. Every character below comes out of the input.
    expect(axisMonthLabel('2026-01')).toBe('01/26');
    expect(axisMonthLabel('2026-12')).toBe('12/26');
  });
});
