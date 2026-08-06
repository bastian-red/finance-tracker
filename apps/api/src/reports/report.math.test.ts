import { month, trailingMonths, UNCATEGORISED_SLOT } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import {
  categoryTotals,
  denseTrend,
  totalsOf,
  UNCATEGORISED_NAME,
  type CategorySumRow,
  type MonthlySumRow,
} from './report.math';

/**
 * Pins the three properties the dashboard's numbers rest on, each of which fails
 * quietly rather than loudly when it is wrong.
 *
 * **Nothing leaves here as a bigint.** `SUM(int4)` is `bigint` in Postgres and
 * Prisma hands back a JavaScript `BigInt`, which `JSON.stringify` throws on. The
 * route works against an empty ledger and starts answering 500 the moment the
 * first row is inserted, so the assertions below serialise the result rather
 * than only comparing it.
 *
 * **The trend is dense.** A chart built from "the months that have rows" omits
 * the month somebody spent nothing, which is the most interesting month on the
 * page and the one whose absence nobody notices.
 *
 * **One sign convention.** `expenseMinor` is a positive magnitude and `netMinor`
 * is `income - expense`. The ledger stores expenses negative; the report does
 * not, because `budgetStatusSchema.spentMinor` is documented as an absolute and
 * one convention across the response beats two.
 *
 * The share values below are integer arithmetic, computed rather than recalled:
 *
 *     node -e "const s=(p,w)=>Math.round(p*10000/w);
 *       const a=[12345,6789,1000], w=a.reduce((x,y)=>x+y,0);
 *       console.log(w, a.map(v=>s(v,w)))"
 *
 *     20134 [ 6131, 3372, 497 ]
 */

const JANUARY = month('2026-01');

describe('totalsOf', () => {
  it('reads a month with no row as a month of zeros', () => {
    // `SUM` over no rows is NULL and a month with no transactions is a normal
    // month. The row being absent and the row being zero must be the same
    // answer, or a fresh account renders an empty dashboard.
    expect(totalsOf(JANUARY, undefined)).toEqual({
      month: '2026-01',
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    });
  });

  it('converts both aggregates out of bigint', () => {
    const totals = totalsOf(JANUARY, {
      month: '2026-01',
      incomeMinor: BigInt(250_000),
      expenseMinor: BigInt(-98_765),
    });

    expect(totals).toEqual({
      month: '2026-01',
      incomeMinor: 250_000,
      expenseMinor: 98_765,
      netMinor: 151_235,
    });
    expect(() => JSON.stringify(totals)).not.toThrow();
  });

  it('reports expense as a positive magnitude, whichever sign arrived', () => {
    // The ledger stores it negative. A sum that arrives positive (a query that
    // already flipped it) must not come back out negated.
    const stored = totalsOf(JANUARY, { month: '2026-01', incomeMinor: 0, expenseMinor: -4_200 });
    const flipped = totalsOf(JANUARY, { month: '2026-01', incomeMinor: 0, expenseMinor: 4_200 });

    expect(stored.expenseMinor).toBe(4_200);
    expect(flipped.expenseMinor).toBe(4_200);
  });

  it('reports a negative net when the month spent more than it earned', () => {
    const totals = totalsOf(JANUARY, {
      month: '2026-01',
      incomeMinor: 100_000,
      expenseMinor: -150_000,
    });
    expect(totals.netMinor).toBe(-50_000);
  });

  it('reads a NULL aggregate as zero on either side', () => {
    expect(totalsOf(JANUARY, { month: '2026-01', incomeMinor: null, expenseMinor: null })).toEqual({
      month: '2026-01',
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    });
  });

  it('labels the totals with the month asked for, not the month in the row', () => {
    // The month is the caller's window position. Taking it from the row would
    // make an empty month unlabelable.
    expect(totalsOf(JANUARY, undefined).month).toBe('2026-01');
  });
});

describe('denseTrend', () => {
  const months = trailingMonths(month('2026-03'), 3);

  it('emits one entry per month in the window, in ascending order', () => {
    const rows: MonthlySumRow[] = [{ month: '2026-03', incomeMinor: 1_000, expenseMinor: -400 }];
    expect(denseTrend(months, rows).map((entry) => entry.month)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
  });

  it('fills a month with no rows with zeros rather than skipping it', () => {
    // The whole reason this function exists. A gap in the middle of a line chart
    // is drawn as a straight line between its neighbours, which reads as "spent
    // the average" rather than "spent nothing".
    const trend = denseTrend(months, [
      { month: '2026-01', incomeMinor: 200_000, expenseMinor: -50_000 },
      { month: '2026-03', incomeMinor: 200_000, expenseMinor: -60_000 },
    ]);

    expect(trend[1]).toEqual({
      month: '2026-02',
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    });
    expect(trend).toHaveLength(3);
  });

  it('ignores a row for a month outside the window', () => {
    // The window decides the shape of the answer, never the rows. A stray month
    // from a wider query must not lengthen the chart.
    const trend = denseTrend(months, [
      { month: '2025-11', incomeMinor: 999_999, expenseMinor: -999_999 },
    ]);
    expect(trend).toHaveLength(3);
    expect(trend.every((entry) => entry.incomeMinor === 0)).toBe(true);
  });

  it('returns nothing for an empty window', () => {
    expect(denseTrend([], [{ month: '2026-01', incomeMinor: 1, expenseMinor: -1 }])).toEqual([]);
  });

  it('serialises, which is the whole bigint boundary in one assertion', () => {
    const trend = denseTrend(months, [
      { month: '2026-02', incomeMinor: BigInt(1), expenseMinor: BigInt(-1) },
    ]);
    expect(() => JSON.stringify(trend)).not.toThrow();
  });
});

describe('categoryTotals', () => {
  const rows: CategorySumRow[] = [
    { categoryId: 'cat_a', categoryName: 'Groceries', colorSlot: 0, amountMinor: -12_345 },
    { categoryId: 'cat_b', categoryName: 'Transport', colorSlot: 2, amountMinor: -6_789 },
    { categoryId: 'cat_c', categoryName: 'Health', colorSlot: 4, amountMinor: -1_000 },
  ];

  it('reports positive magnitudes with their share in integer basis points', () => {
    expect(categoryTotals(rows)).toEqual([
      {
        categoryId: 'cat_a',
        categoryName: 'Groceries',
        colorSlot: 0,
        amountMinor: 12_345,
        shareBasisPoints: 6131,
      },
      {
        categoryId: 'cat_b',
        categoryName: 'Transport',
        colorSlot: 2,
        amountMinor: 6_789,
        shareBasisPoints: 3372,
      },
      {
        categoryId: 'cat_c',
        categoryName: 'Health',
        colorSlot: 4,
        amountMinor: 1_000,
        shareBasisPoints: 497,
      },
    ]);
  });

  it('shares out of the total of the rows it was given, not out of 100', () => {
    // The pie slice's angle and the "61%" label beside it come from this one
    // integer, so they cannot disagree at the boundary.
    const totals = categoryTotals(rows);
    const sum = totals.reduce((acc, total) => acc + total.shareBasisPoints, 0);
    expect(sum).toBe(10_000);
  });

  it('sorts by amount descending, so the chart cut is a slice', () => {
    // The dashboard draws the top seven plus "Other". That is a `slice(0, 7)`
    // only if this order is guaranteed here.
    const shuffled = [rows[2], rows[0], rows[1]] as CategorySumRow[];
    expect(categoryTotals(shuffled).map((total) => total.categoryName)).toEqual([
      'Groceries',
      'Transport',
      'Health',
    ]);
  });

  it('breaks a tie on name, so two equal categories never swap places', () => {
    // Identical spending is common on round numbers. Without the tiebreak the
    // legend reorders between two identical requests and the colours appear to
    // move.
    const tied: CategorySumRow[] = [
      { categoryId: 'cat_z', categoryName: 'Zebra', colorSlot: 1, amountMinor: -5_000 },
      { categoryId: 'cat_a', categoryName: 'Apples', colorSlot: 2, amountMinor: -5_000 },
    ];
    expect(categoryTotals(tied).map((total) => total.categoryName)).toEqual(['Apples', 'Zebra']);
    expect(categoryTotals([...tied].reverse()).map((total) => total.categoryName)).toEqual([
      'Apples',
      'Zebra',
    ]);
  });

  it('names and colours an uncategorised total instead of dropping it', () => {
    // A fresh import before any rule has run is entirely uncategorised. Dropping
    // it would make the chart add up to less than the month's spending with
    // nothing on screen explaining the difference.
    const totals = categoryTotals([
      { categoryId: null, categoryName: null, colorSlot: null, amountMinor: -7_500 },
    ]);

    expect(totals[0]).toEqual({
      categoryId: null,
      categoryName: UNCATEGORISED_NAME,
      colorSlot: UNCATEGORISED_SLOT,
      amountMinor: 7_500,
      shareBasisPoints: 10_000,
    });
  });

  it('gives uncategorised a slot no real category can hold', () => {
    // Negative rather than a magic name, so it cannot steal a hue a real
    // category is already using.
    expect(UNCATEGORISED_SLOT).toBeLessThan(0);
  });

  it('returns nothing for no rows', () => {
    expect(categoryTotals([])).toEqual([]);
  });

  it('reports a zero share rather than dividing by zero', () => {
    // A month whose only rows net to nothing. `shareInBasisPoints` returns 0 for
    // an empty whole; the alternative is Infinity or NaN on the chart.
    const totals = categoryTotals([
      { categoryId: 'cat_a', categoryName: 'Groceries', colorSlot: 0, amountMinor: 0 },
    ]);
    expect(totals[0]?.shareBasisPoints).toBe(0);
    expect(Number.isFinite(totals[0]?.shareBasisPoints)).toBe(true);
  });

  it('reads a NULL amount as zero', () => {
    const totals = categoryTotals([
      { categoryId: 'cat_a', categoryName: 'Groceries', colorSlot: 0, amountMinor: null },
    ]);
    expect(totals[0]?.amountMinor).toBe(0);
  });

  it('converts bigint amounts, so the response serialises', () => {
    const totals = categoryTotals([
      {
        categoryId: 'cat_a',
        categoryName: 'Groceries',
        colorSlot: 0,
        amountMinor: BigInt(-12_345),
      },
    ]);
    expect(totals[0]?.amountMinor).toBe(12_345);
    expect(() => JSON.stringify(totals)).not.toThrow();
  });
});
