import { month, type CalendarMonth } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { budgetStatuses, indexSpend, spendKey, type BudgetPeriod } from './budget-status.math';

/**
 * Pins the one function the dashboard and the alert mailer both call.
 *
 * They call it because they must not be able to disagree. The failure this
 * prevents is an email saying a budget is blown beside a screen saying it is
 * fine, and the only way to keep those two honest is for both to read the same
 * numbers out of the same pure function.
 *
 * Three properties are pinned here, and each one has a way of failing silently:
 * a budget produces exactly one status per month it covers **inside the window**
 * (an open-ended budget from 2019 would otherwise flood a twelve-month report),
 * spending is matched per (category, month) with a missing month meaning zero
 * rather than absent, and the output order is total. That last one is not
 * cosmetic: the e2e suite and the alert planner index into this array, so an
 * order that depends on how Postgres returned the rows is a flaky test and a
 * table that reshuffles between two identical requests.
 */

const WINDOW: CalendarMonth[] = [month('2026-01'), month('2026-02'), month('2026-03')];

const period = (patch: Partial<BudgetPeriod> = {}): BudgetPeriod => ({
  id: 'bud_groceries',
  categoryId: 'cat_groceries',
  categoryName: 'Groceries',
  colorSlot: 0,
  limitMinor: 40_000,
  effectiveFrom: month('2026-01'),
  effectiveTo: null,
  ...patch,
});

/** 80% of the limit, which is the shipped `BUDGET_ALERT_THRESHOLD`. */
const APPROACHING = 8000;

describe('spendKey', () => {
  /**
   * The separator is a NUL, and it is asserted by character code rather than by a
   * string literal on purpose. Writing the expectation as a literal means pasting
   * an unprintable byte into the test, which is how this went wrong the first
   * time: the source read `${categoryId} ${month}` in every editor and every diff
   * while the byte between them was U+0000, and four tests written against what
   * the code appeared to say failed with `expected undefined` against code that
   * was correct. `scripts/invisible-chars.mjs` now rejects the byte at commit
   * time; these two cases pin the behaviour that made it worth having.
   */
  it('separates the two fields with a NUL', () => {
    const key = spendKey('a', 'b');
    expect(key).toHaveLength(3);
    expect(key.charCodeAt(1)).toBe(0);
  });

  it('cannot be made ambiguous by an id that ends where a month begins', () => {
    // A separator a cuid2 id can contain (a dash, say) would let these two
    // different pairs produce one key, and one budget would read another's spend.
    expect(spendKey('cat_a', '2026-01')).not.toBe(spendKey('cat', 'a-2026-01'));
  });
});

describe('indexSpend', () => {
  it('keys spending by category and month', () => {
    const index = indexSpend([
      { categoryId: 'cat_a', month: '2026-01', amountMinor: -12_000 },
      { categoryId: 'cat_a', month: '2026-02', amountMinor: -8_000 },
    ]);

    expect(index.get(spendKey('cat_a', '2026-01'))).toBe(-12_000);
    expect(index.get(spendKey('cat_a', '2026-02'))).toBe(-8_000);
    expect(index.size).toBe(2);
  });

  it('converts the bigint Postgres returns for SUM(int4)', () => {
    // Carried any further this is a `TypeError` out of `JSON.stringify`, on a
    // route that worked perfectly against an empty ledger.
    const index = indexSpend([
      { categoryId: 'cat_a', month: '2026-01', amountMinor: BigInt(-9_950) },
    ]);
    expect(index.get(spendKey('cat_a', '2026-01'))).toBe(-9_950);
    expect(() => JSON.stringify([...index])).not.toThrow();
  });

  it('drops rows with no category rather than inventing a key for them', () => {
    // Uncategorised spending is real and belongs on the report's category chart.
    // It cannot belong to a budget, because a budget is a limit on a category.
    const index = indexSpend([
      { categoryId: null, month: '2026-01', amountMinor: -50_000 },
      { categoryId: 'cat_a', month: '2026-01', amountMinor: -1_000 },
    ]);
    expect(index.size).toBe(1);
    expect(index.get(spendKey('cat_a', '2026-01'))).toBe(-1_000);
  });

  it('reads a NULL sum as zero', () => {
    const index = indexSpend([{ categoryId: 'cat_a', month: '2026-01', amountMinor: null }]);
    expect(index.get(spendKey('cat_a', '2026-01'))).toBe(0);
  });
});

describe('budgetStatuses', () => {
  it('produces one status per month the budget covers', () => {
    const statuses = budgetStatuses([period()], [], WINDOW, APPROACHING);

    // One stored row, three months of report. This is why the report carries
    // statuses for the whole trailing window and not for the selected month.
    expect(statuses.map((status) => status.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(new Set(statuses.map((status) => status.budgetId))).toEqual(new Set(['bud_groceries']));
  });

  it('bounds an open-ended budget by the window, not by its own start', () => {
    // The concrete failure: a budget set in 2019 and never changed would produce
    // eighty-odd statuses for a twelve-month report and the payload would be
    // mostly months nobody asked about.
    const statuses = budgetStatuses(
      [period({ effectiveFrom: month('2019-01'), effectiveTo: null })],
      [],
      WINDOW,
      APPROACHING,
    );
    expect(statuses).toHaveLength(WINDOW.length);
  });

  it('bounds a budget whose end is past the window', () => {
    const statuses = budgetStatuses(
      [period({ effectiveTo: month('2030-12') })],
      [],
      WINDOW,
      APPROACHING,
    );
    expect(statuses.map((status) => status.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('drops a budget that ended before the window', () => {
    const statuses = budgetStatuses(
      [period({ effectiveFrom: month('2025-01'), effectiveTo: month('2025-06') })],
      [],
      WINDOW,
      APPROACHING,
    );
    expect(statuses).toEqual([]);
  });

  it('drops a budget that starts after the window instead of running a backwards range', () => {
    // `monthRange` throws on `from > to`. The guard is what turns "this budget
    // is not in this report" into no rows rather than into a 500 on the
    // dashboard the month somebody schedules a future budget.
    const statuses = budgetStatuses(
      [period({ effectiveFrom: month('2026-12'), effectiveTo: null })],
      [],
      WINDOW,
      APPROACHING,
    );
    expect(statuses).toEqual([]);
  });

  it('covers only the months inside the budget range', () => {
    const statuses = budgetStatuses(
      [period({ effectiveFrom: month('2026-02'), effectiveTo: month('2026-02') })],
      [],
      WINDOW,
      APPROACHING,
    );
    expect(statuses.map((status) => status.month)).toEqual(['2026-02']);
  });

  it('returns nothing for an empty window rather than reading past the array', () => {
    // `months[months.length - 1]` is `undefined` here, and an open-ended budget
    // would otherwise be evaluated against it.
    expect(budgetStatuses([period()], [], [], APPROACHING)).toEqual([]);
  });

  it('treats a month with no spending row as zero spent, not as absent', () => {
    // A budget with nothing spent against it is the state a fresh month is in,
    // and it must draw an empty bar rather than disappear from the list.
    const statuses = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-02', amountMinor: -20_000 }],
      WINDOW,
      APPROACHING,
    );

    expect(statuses.map((status) => status.spentMinor)).toEqual([0, 20_000, 0]);
    expect(statuses.map((status) => status.state)).toEqual(['under', 'under', 'under']);
  });

  it('reports spending as a positive magnitude, whichever sign the ledger used', () => {
    // The ledger stores expenses negative. `evaluateBudget` takes the absolute
    // itself, so a caller that forgot to flip the sign cannot produce a
    // permanently green budget with a negative bar.
    const negative = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: -30_000 }],
      [month('2026-01')],
      APPROACHING,
    );
    const positive = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: 30_000 }],
      [month('2026-01')],
      APPROACHING,
    );

    expect(negative[0]?.spentMinor).toBe(30_000);
    expect(positive[0]?.spentMinor).toBe(30_000);
  });

  it('flips to approaching exactly at the threshold, not a cent early', () => {
    // 80% of 400.00 is 320.00. The comparison is integer against integer for
    // the reason the whole codebase avoids floats: `0.8 * 40000` is
    // 32000.000000000004, and a budget reading 80.0000000001% used would flip
    // one cent early and cost a user an email they did not need.
    const at = (spentMinor: number): string | undefined =>
      budgetStatuses(
        [period()],
        [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: -spentMinor }],
        [month('2026-01')],
        APPROACHING,
      )[0]?.state;

    expect(at(31_999)).toBe('under');
    expect(at(32_000)).toBe('approaching');
    expect(at(40_000)).toBe('approaching');
    expect(at(40_001)).toBe('exceeded');
  });

  it('reports usage as integer basis points, so the bar and the label agree', () => {
    const statuses = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: -30_000 }],
      [month('2026-01')],
      APPROACHING,
    );

    // 30000 / 40000 = 75.00%.
    expect(statuses[0]?.usedBasisPoints).toBe(7500);
    expect(Number.isInteger(statuses[0]?.usedBasisPoints)).toBe(true);
  });

  it('can report more than 100% used, because overspending is a real state', () => {
    const statuses = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: -60_000 }],
      [month('2026-01')],
      APPROACHING,
    );
    expect(statuses[0]?.usedBasisPoints).toBe(15_000);
    expect(statuses[0]?.state).toBe('exceeded');
  });

  it('matches spending to the right month and the right category, never across', () => {
    const statuses = budgetStatuses(
      [period()],
      [
        // Right category, wrong month.
        { categoryId: 'cat_groceries', month: '2025-12', amountMinor: -39_000 },
        // Right month, wrong category.
        { categoryId: 'cat_transport', month: '2026-01', amountMinor: -39_000 },
      ],
      [month('2026-01')],
      APPROACHING,
    );
    expect(statuses[0]?.spentMinor).toBe(0);
  });

  it('sorts by month, then category name, then budget id', () => {
    // Fed in deliberately backwards. Without the sort the output order is
    // whatever order the rows came back in, which is a flaky e2e assertion and
    // a table that reshuffles between two identical requests.
    const periods: BudgetPeriod[] = [
      period({ id: 'bud_b', categoryId: 'cat_t', categoryName: 'Transport' }),
      period({ id: 'bud_c', categoryId: 'cat_g', categoryName: 'Groceries' }),
      period({ id: 'bud_a', categoryId: 'cat_g2', categoryName: 'Groceries' }),
    ];

    const statuses = budgetStatuses(periods, [], [month('2026-01'), month('2026-02')], APPROACHING);

    expect(
      statuses.map((status) => `${status.month} ${status.categoryName} ${status.budgetId}`),
    ).toEqual([
      '2026-01 Groceries bud_a',
      '2026-01 Groceries bud_c',
      '2026-01 Transport bud_b',
      '2026-02 Groceries bud_a',
      '2026-02 Groceries bud_c',
      '2026-02 Transport bud_b',
    ]);
  });

  it('is stable: the same input twice gives the same array', () => {
    const periods = [
      period({ id: 'bud_b', categoryName: 'Transport' }),
      period({ id: 'bud_a', categoryName: 'Groceries' }),
    ];
    expect(budgetStatuses(periods, [], WINDOW, APPROACHING)).toEqual(
      budgetStatuses(periods, [], WINDOW, APPROACHING),
    );
  });

  it('carries the category display fields through, so the chart needs no second query', () => {
    const statuses = budgetStatuses(
      [period({ colorSlot: 5, categoryName: 'Subscriptions' })],
      [],
      [month('2026-01')],
      APPROACHING,
    );

    expect(statuses[0]).toEqual({
      budgetId: 'bud_groceries',
      categoryId: 'cat_groceries',
      categoryName: 'Subscriptions',
      colorSlot: 5,
      month: '2026-01',
      limitMinor: 40_000,
      spentMinor: 0,
      usedBasisPoints: 0,
      state: 'under',
    });
  });

  it('produces something the serialiser can actually send', () => {
    // The end of the bigint path: aggregates come in as BigInt and the response
    // is JSON. If the conversion were missed the route would 500 the moment the
    // first transaction was inserted.
    const statuses = budgetStatuses(
      [period()],
      [{ categoryId: 'cat_groceries', month: '2026-01', amountMinor: BigInt(-30_000) }],
      [month('2026-01')],
      APPROACHING,
    );
    expect(() => JSON.stringify(statuses)).not.toThrow();
    expect(JSON.parse(JSON.stringify(statuses))[0].spentMinor).toBe(30_000);
  });
});
