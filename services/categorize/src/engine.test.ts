import { describe, expect, it } from 'vitest';
import { categorize, categorizeOnce, compileRules, explain } from './engine';
import type { CategorizeRule } from './types';

const GROCERIES = 'cat_groceries';
const EATING_OUT = 'cat_eating_out';
const SUBSCRIPTIONS = 'cat_subscriptions';
const SALARY = 'cat_salary';

function rule(overrides: Partial<CategorizeRule> & Pick<CategorizeRule, 'id'>): CategorizeRule {
  return {
    categoryId: GROCERIES,
    matcherType: 'contains',
    matcherValue: 'mercadona',
    priority: 100,
    minAmountMinor: null,
    maxAmountMinor: null,
    active: true,
    ...overrides,
  };
}

/** A real statement line, unnormalised, as it arrives from the bank. */
const MERCADONA = { description: 'MERCADONA 4023 MADRID', amountMinor: -8990 };

describe('matchers', () => {
  it('matches on the normalised description, not the raw one', () => {
    // The reason the whole service depends on @fin/shared's normaliser: the
    // terminal id and the city are noise that differ per purchase, and a rule
    // typed as "Mercadona" has to match a line reading "MERCADONA 4023 MADRID".
    const match = categorizeOnce([rule({ id: 'r1' })], MERCADONA);
    expect(match).toEqual({
      categoryId: GROCERIES,
      ruleId: 'r1',
      reason: 'contains "mercadona"',
    });
  });

  it('normalises the matcher value too, so accents and case do not have to agree', () => {
    const match = categorizeOnce(
      [rule({ id: 'r1', matcherValue: 'Café Comercial', categoryId: EATING_OUT })],
      { description: 'CAFE COMERCIAL 4021', amountMinor: -450 },
    );
    expect(match?.categoryId).toBe(EATING_OUT);
    // The reason quotes the normalised needle, because that is what actually ran.
    expect(match?.reason).toBe('contains "cafe comercial"');
  });

  it('honours equals and startsWith against the normalised form', () => {
    const equals = rule({ id: 'r1', matcherType: 'equals', matcherValue: 'mercadona madrid' });
    const startsWith = rule({ id: 'r2', matcherType: 'startsWith', matcherValue: 'mercadona' });

    expect(categorizeOnce([equals], MERCADONA)?.ruleId).toBe('r1');
    expect(categorizeOnce([startsWith], MERCADONA)?.ruleId).toBe('r2');
    // `equals` is exact against the normalised string, so a longer line misses.
    expect(
      categorizeOnce([equals], { ...MERCADONA, description: 'MERCADONA 4023 MADRID SUR' }),
    ).toBeNull();
    expect(
      categorizeOnce([startsWith], { ...MERCADONA, description: 'PAGO MERCADONA 4023' }),
    ).toBeNull();
  });

  it('runs a regex against the normalised subject without normalising the pattern', () => {
    // The trap this pins: normalising `^[a-z]+ [0-9]+$` would produce `a z 0 9`,
    // a literal that matches nothing, and the rule would silently stop working.
    const match = categorizeOnce(
      [
        rule({
          id: 'r1',
          matcherType: 'regex',
          matcherValue: '^(mercadona|lidl|carrefour)',
        }),
      ],
      MERCADONA,
    );
    expect(match?.ruleId).toBe('r1');
    expect(match?.reason).toBe('matches /^(mercadona|lidl|carrefour)/');
  });

  it('does not match a rule whose needle is not in the description', () => {
    expect(categorizeOnce([rule({ id: 'r1', matcherValue: 'lidl' })], MERCADONA)).toBeNull();
  });
});

describe('ordering', () => {
  it('runs lower priority first and stops at the first match', () => {
    const specific = rule({
      id: 'r-specific',
      matcherValue: 'mercadona',
      categoryId: GROCERIES,
      priority: 10,
    });
    const catchAll = rule({
      id: 'r-catchall',
      matcherType: 'regex',
      matcherValue: '.',
      categoryId: EATING_OUT,
      priority: 500,
    });

    expect(categorizeOnce([catchAll, specific], MERCADONA)?.categoryId).toBe(GROCERIES);
  });

  it('breaks a priority tie on id, so the answer never depends on row order', () => {
    // The bug this removes: two rules at the default priority of 100, ordered by
    // whatever Postgres returned. The same transaction would land in different
    // categories on different days with nothing in the data to explain it.
    const a = rule({ id: 'aaa', categoryId: GROCERIES });
    const b = rule({ id: 'bbb', categoryId: EATING_OUT });

    expect(categorizeOnce([a, b], MERCADONA)?.categoryId).toBe(GROCERIES);
    expect(categorizeOnce([b, a], MERCADONA)?.categoryId).toBe(GROCERIES);
  });

  it('skips inactive rules entirely', () => {
    const off = rule({ id: 'r-off', priority: 1, categoryId: EATING_OUT, active: false });
    const on = rule({ id: 'r-on', priority: 2, categoryId: GROCERIES });

    const ruleSet = compileRules([off, on]);
    expect(ruleSet.rules).toHaveLength(1);
    expect(categorize(ruleSet, MERCADONA)?.categoryId).toBe(GROCERIES);
    // An inactive rule is not "skipped" in the error sense; it is not a problem.
    expect(ruleSet.skipped).toEqual([]);
  });
});

describe('the amount window', () => {
  it('is inclusive on both ends', () => {
    const windowed = rule({ id: 'r1', minAmountMinor: -9000, maxAmountMinor: -8000 });
    expect(categorizeOnce([windowed], { ...MERCADONA, amountMinor: -9000 })?.ruleId).toBe('r1');
    expect(categorizeOnce([windowed], { ...MERCADONA, amountMinor: -8000 })?.ruleId).toBe('r1');
    expect(categorizeOnce([windowed], { ...MERCADONA, amountMinor: -9001 })).toBeNull();
    expect(categorizeOnce([windowed], { ...MERCADONA, amountMinor: -7999 })).toBeNull();
  });

  it('compares the signed amount, so the lower bound is the larger expense', () => {
    // The confusing case, pinned deliberately. "Only groceries under 20 EUR"
    // is `minAmountMinor: -2000`, not `maxAmountMinor: 2000`, because an expense
    // of 8.99 EUR is -899 and -899 >= -2000.
    const smallShops = rule({ id: 'r1', minAmountMinor: -2000 });
    expect(categorizeOnce([smallShops], { ...MERCADONA, amountMinor: -899 })?.ruleId).toBe('r1');
    expect(categorizeOnce([smallShops], { ...MERCADONA, amountMinor: -8990 })).toBeNull();
  });

  it('expresses an income floor with a positive bound', () => {
    const salary = rule({
      id: 'r1',
      categoryId: SALARY,
      matcherValue: 'nomina',
      minAmountMinor: 100_000,
    });
    const payslip = { description: 'NOMINA MENSUAL ACME S.L.', amountMinor: 232_000 };
    expect(categorizeOnce([salary], payslip)?.categoryId).toBe(SALARY);
    expect(categorizeOnce([salary], { ...payslip, amountMinor: 90_000 })).toBeNull();
  });

  it('describes the window in the reason', () => {
    // A small shop, so it sits inside every window below. Using MERCADONA's own
    // -8990 here is what made the first version of this test assert against a
    // null match: -8990 is outside `at least -2000`, which is the sign trap the
    // test above exists to pin.
    const small = { description: 'MERCADONA 4023 MADRID', amountMinor: -899 };

    expect(categorizeOnce([rule({ id: 'r1', minAmountMinor: -2000 })], small)?.reason).toBe(
      'contains "mercadona" and amount is at least -2000',
    );
    expect(categorizeOnce([rule({ id: 'r1', maxAmountMinor: -100 })], small)?.reason).toBe(
      'contains "mercadona" and amount is at most -100',
    );
    expect(
      categorizeOnce([rule({ id: 'r1', minAmountMinor: -9000, maxAmountMinor: -100 })], small)
        ?.reason,
    ).toBe('contains "mercadona" and amount is -9000 to -100');
  });

  it('refuses an inverted window rather than never matching', () => {
    // A rule that silently cannot match costs the user an afternoon. The message
    // names the sign convention, because inverting the bounds is exactly the
    // mistake a signed amount invites.
    const inverted = rule({ id: 'r-bad', minAmountMinor: -100, maxAmountMinor: -9000 });
    const ruleSet = compileRules([inverted]);
    expect(ruleSet.rules).toEqual([]);
    expect(ruleSet.skipped).toHaveLength(1);
    expect(ruleSet.skipped[0]?.ruleId).toBe('r-bad');
    expect(ruleSet.skipped[0]?.problem).toMatch(/inverted/);
    expect(ruleSet.skipped[0]?.problem).toMatch(/-9400/);
  });
});

describe('rules that cannot run', () => {
  it('reports an unsafe pattern instead of dropping it silently', () => {
    // A pattern that passed an older, laxer check is still in the table. Dropping
    // it quietly means a category stops being assigned and the only symptom is a
    // growing review queue.
    const ruleSet = compileRules([
      rule({ id: 'r-evil', matcherType: 'regex', matcherValue: '(a|a)*$' }),
      rule({ id: 'r-ok' }),
    ]);
    expect(ruleSet.rules.map((r) => r.id)).toEqual(['r-ok']);
    expect(ruleSet.skipped).toEqual([
      { ruleId: 'r-evil', problem: expect.stringMatching(/backtracks/) },
    ]);
  });

  it('refuses a literal matcher that normalises to nothing', () => {
    // "!!!" normalises to '' and '' is a substring of every string, so a
    // `contains` rule built from one would swallow the whole ledger into a single
    // category on the next import.
    const ruleSet = compileRules([rule({ id: 'r-empty', matcherValue: '!!!' })]);
    expect(ruleSet.rules).toEqual([]);
    expect(ruleSet.skipped[0]?.problem).toMatch(/every transaction/);
  });

  it('keeps every runnable rule when one of its neighbours is broken', () => {
    const ruleSet = compileRules([
      rule({ id: 'r1', priority: 1 }),
      rule({ id: 'r-bad', priority: 2, matcherValue: '???' }),
      rule({ id: 'r3', priority: 3, matcherValue: 'lidl' }),
    ]);
    expect(ruleSet.rules.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(ruleSet.skipped.map((s) => s.ruleId)).toEqual(['r-bad']);
  });
});

describe('explain', () => {
  it('reports every rule that was tried, matched or not', () => {
    // The screen this exists for answers "why is this in nothing?", and that
    // needs the misses. An empty result looks like the rule does not exist.
    const ruleSet = compileRules([
      rule({ id: 'r1', priority: 1, matcherValue: 'lidl' }),
      rule({ id: 'r2', priority: 2, matcherValue: 'mercadona' }),
      rule({ id: 'r3', priority: 3, matcherValue: 'carrefour', categoryId: EATING_OUT }),
    ]);

    expect(explain(ruleSet, MERCADONA)).toEqual([
      { ruleId: 'r1', categoryId: GROCERIES, matched: false, reason: 'contains "lidl"' },
      { ruleId: 'r2', categoryId: GROCERIES, matched: true, reason: 'contains "mercadona"' },
      { ruleId: 'r3', categoryId: EATING_OUT, matched: false, reason: 'contains "carrefour"' },
    ]);
  });

  it('returns the rules in the order they were tried', () => {
    const ruleSet = compileRules([
      rule({ id: 'zzz', priority: 5 }),
      rule({ id: 'aaa', priority: 5 }),
      rule({ id: 'mmm', priority: 1 }),
    ]);
    expect(explain(ruleSet, MERCADONA).map((t) => t.ruleId)).toEqual(['mmm', 'aaa', 'zzz']);
  });
});

describe('an empty rule set', () => {
  it('leaves the transaction uncategorised rather than guessing', () => {
    expect(categorizeOnce([], MERCADONA)).toBeNull();
    expect(explain(compileRules([]), MERCADONA)).toEqual([]);
  });
});

describe('a realistic rule set', () => {
  /** The shape the seed writes: keyword rules, ascending priority, one per keyword. */
  const RULES: CategorizeRule[] = [
    rule({ id: 'r10', priority: 10, matcherValue: 'mercadona', categoryId: GROCERIES }),
    rule({ id: 'r11', priority: 11, matcherValue: 'carrefour', categoryId: GROCERIES }),
    rule({ id: 'r20', priority: 20, matcherValue: 'netflix', categoryId: SUBSCRIPTIONS }),
    rule({ id: 'r21', priority: 21, matcherValue: 'spotify', categoryId: SUBSCRIPTIONS }),
    rule({ id: 'r30', priority: 30, matcherValue: 'bar ', categoryId: EATING_OUT }),
    rule({ id: 'r31', priority: 31, matcherValue: 'restaurante', categoryId: EATING_OUT }),
    rule({ id: 'r40', priority: 40, matcherValue: 'nomina', categoryId: SALARY }),
  ];

  it.each([
    ['MERCADONA 4023 MADRID', GROCERIES],
    ['CARREFOUR EXPRESS', GROCERIES],
    ['NETFLIX.COM', SUBSCRIPTIONS],
    ['SPOTIFY AB', SUBSCRIPTIONS],
    ['BAR LA CAMPANA', EATING_OUT],
    ['RESTAURANTE SOBRINO', EATING_OUT],
    ['NOMINA MENSUAL ACME S.L.', SALARY],
  ])('files %s under the right category', (description, expected) => {
    const ruleSet = compileRules(RULES);
    expect(categorize(ruleSet, { description, amountMinor: -1000 })?.categoryId).toBe(expected);
  });

  it('leaves a merchant nobody wrote a rule for uncategorised', () => {
    // The review queue is a real state of this app, not a failure. A rule engine
    // that guesses is worse than one that says "I do not know".
    const ruleSet = compileRules(RULES);
    expect(
      categorize(ruleSet, { description: 'FRUTERIA LA HUERTA', amountMinor: -1450 }),
    ).toBeNull();
  });

  it('compiles once and answers many times', () => {
    // The reason `compileRules` is separate from `categorize`: an import of 4000
    // rows against these 7 rules is 28,000 evaluations, and compiling inside the
    // loop would re-normalise every matcher value 4000 times.
    const ruleSet = compileRules(RULES);
    const descriptions = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0 ? 'MERCADONA 4023 MADRID' : 'NETFLIX.COM',
    );
    const categories = descriptions.map(
      (description) => categorize(ruleSet, { description, amountMinor: -1000 })?.categoryId,
    );
    expect(new Set(categories)).toEqual(new Set([GROCERIES, SUBSCRIPTIONS]));
  });
});
