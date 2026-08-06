import { describe, expect, it } from 'vitest';
import { month as calendarMonth, type BudgetStatus } from '@fin/shared';
import { planAlerts } from './plan';

const MARCH = calendarMonth('2026-03');

function status(overrides: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    budgetId: 'b-groceries',
    categoryId: 'c-groceries',
    categoryName: 'Groceries',
    colorSlot: 0,
    month: '2026-03',
    limitMinor: 40_000,
    spentMinor: 43_120,
    usedBasisPoints: 10_780,
    state: 'exceeded',
    ...overrides,
  };
}

describe('planAlerts', () => {
  it('plans nothing for a budget that is under its limit', () => {
    const plans = planAlerts(
      [status({ spentMinor: 12_000, usedBasisPoints: 3000, state: 'under' })],
      MARCH,
    );

    expect(plans).toEqual([]);
  });

  it('plans one alert per approaching or exceeded budget', () => {
    const plans = planAlerts(
      [
        status({ budgetId: 'b-1', state: 'under', usedBasisPoints: 1000 }),
        status({ budgetId: 'b-2', state: 'approaching', usedBasisPoints: 8200 }),
        status({ budgetId: 'b-3', state: 'exceeded', usedBasisPoints: 10_780 }),
      ],
      MARCH,
    );

    expect(plans.map((plan) => [plan.budgetId, plan.level])).toEqual([
      ['b-3', 'exceeded'],
      ['b-2', 'approaching'],
    ]);
  });

  it('copies the budget through without recomputing anything', () => {
    const [plan] = planAlerts(
      [
        status({
          budgetId: 'b-77',
          categoryId: 'c-77',
          categoryName: 'Coffee',
          limitMinor: 5000,
          spentMinor: 5001,
          usedBasisPoints: 10_002,
        }),
      ],
      MARCH,
    );

    expect(plan).toEqual({
      budgetId: 'b-77',
      categoryId: 'c-77',
      categoryName: 'Coffee',
      month: '2026-03',
      level: 'exceeded',
      limitMinor: 5000,
      spentMinor: 5001,
      usedBasisPoints: 10_002,
    });
  });

  it('drops statuses from any month but the one asked for', () => {
    // The report carries a trailing window, so a backfilled transaction that
    // pushes last July over its limit must not mail the user about July.
    const plans = planAlerts(
      [
        status({ budgetId: 'b-july', month: '2025-07' }),
        status({ budgetId: 'b-april', month: '2026-04' }),
        status({ budgetId: 'b-march', month: '2026-03' }),
      ],
      MARCH,
    );

    expect(plans.map((plan) => plan.budgetId)).toEqual(['b-march']);
  });

  it('sorts exceeded before approaching even when approaching is listed first', () => {
    const plans = planAlerts(
      [
        status({ budgetId: 'b-approaching', state: 'approaching', usedBasisPoints: 9900 }),
        status({ budgetId: 'b-exceeded', state: 'exceeded', usedBasisPoints: 10_010 }),
      ],
      MARCH,
    );

    expect(plans.map((plan) => plan.budgetId)).toEqual(['b-exceeded', 'b-approaching']);
  });

  it('ranks the level above usage, and above the id tiebreak', () => {
    // The two can report the same number. `evaluateBudget` was run to get these:
    // 1_000_001 spent against a 1_000_000 limit rounds to exactly 10000 basis
    // points and is `exceeded`, while a budget spent exactly to its 40_000 limit
    // reports the same 10000 and is `approaching`. Sorting on usage alone would
    // then fall through to the id, and `b-alpha` would put the merely-full
    // budget above the one that is over.
    const plans = planAlerts(
      [
        status({
          budgetId: 'b-alpha',
          state: 'approaching',
          limitMinor: 40_000,
          spentMinor: 40_000,
          usedBasisPoints: 10_000,
        }),
        status({
          budgetId: 'b-zebra',
          state: 'exceeded',
          limitMinor: 1_000_000,
          spentMinor: 1_000_001,
          usedBasisPoints: 10_000,
        }),
      ],
      MARCH,
    );

    expect(plans.map((plan) => [plan.budgetId, plan.level])).toEqual([
      ['b-zebra', 'exceeded'],
      ['b-alpha', 'approaching'],
    ]);
  });

  it('sorts by descending usage within a level', () => {
    const plans = planAlerts(
      [
        status({ budgetId: 'b-low', state: 'approaching', usedBasisPoints: 8100 }),
        status({ budgetId: 'b-high', state: 'approaching', usedBasisPoints: 9500 }),
        status({ budgetId: 'b-mid', state: 'approaching', usedBasisPoints: 8700 }),
      ],
      MARCH,
    );

    expect(plans.map((plan) => plan.budgetId)).toEqual(['b-high', 'b-mid', 'b-low']);
  });

  it('breaks an exact usage tie on budgetId, in input order and reversed', () => {
    // Constructed tie: same level, same basis points. Without the id tiebreak the
    // order would be whatever order Postgres returned the rows in, and the e2e
    // suite asserts on the first alert.
    const tied = [
      status({ budgetId: 'b-zebra', state: 'exceeded', usedBasisPoints: 11_000 }),
      status({ budgetId: 'b-alpha', state: 'exceeded', usedBasisPoints: 11_000 }),
      status({ budgetId: 'b-mango', state: 'exceeded', usedBasisPoints: 11_000 }),
    ];
    const expected = ['b-alpha', 'b-mango', 'b-zebra'];

    expect(planAlerts(tied, MARCH).map((plan) => plan.budgetId)).toEqual(expected);
    expect(planAlerts([...tied].reverse(), MARCH).map((plan) => plan.budgetId)).toEqual(expected);
  });

  it('returns an empty array for empty input', () => {
    expect(planAlerts([], MARCH)).toEqual([]);
  });

  it('does not deduplicate: two identical statuses plan two alerts', () => {
    // Deliberate. Deduplication belongs to @@unique([budgetId, month, level]),
    // because a check here would pass in both of two concurrent requests.
    const plans = planAlerts([status(), status()], MARCH);

    expect(plans).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const input = [
      status({ budgetId: 'b-2', state: 'approaching', usedBasisPoints: 8200 }),
      status({ budgetId: 'b-1', state: 'exceeded', usedBasisPoints: 10_100 }),
    ];

    planAlerts(input, MARCH);

    expect(input.map((entry) => entry.budgetId)).toEqual(['b-2', 'b-1']);
  });
});
