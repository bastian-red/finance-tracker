import { compileRules, type CategorizeRule } from '@fin/categorize';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertRuleRunnable, type RuleDraft } from './rule-validation';

/**
 * Pins that a rule which cannot run is refused at write time, with a 400.
 *
 * The `regex` matcher is the only user input in this codebase that is compiled
 * into something that executes. JavaScript's engine backtracks, the import loop
 * runs the pattern once per row, and there is no way to interrupt a running
 * `RegExp` in Node: one pasted pattern and the worker is gone. The read path is
 * never allowed to see one, so this is the gate.
 *
 * Two failures that a pattern check alone would miss are pinned here too,
 * because both are silent rather than loud. A `contains` matcher that normalises
 * to nothing swallows the entire ledger into one category on the next import,
 * and an inverted amount window can never match, which the user would otherwise
 * spend an afternoon debugging.
 */

const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
  matcher: { type: 'contains', value: 'mercadona' },
  minAmountMinor: null,
  maxAmountMinor: null,
  ...patch,
});

/** The status a `BadRequestException` carries, or -1 if the wrong thing was thrown. */
const statusOf = (run: () => void): number => {
  try {
    run();
    return 0;
  } catch (error) {
    return error instanceof BadRequestException ? error.getStatus() : -1;
  }
};

describe('rules that run', () => {
  it('accepts an ordinary keyword rule', () => {
    expect(() => assertRuleRunnable(draft())).not.toThrow();
  });

  it('accepts the other three matcher types', () => {
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'equals', value: 'emt madrid' } })),
    ).not.toThrow();
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'startsWith', value: 'transferencia' } })),
    ).not.toThrow();
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'regex', value: '^mercadona [0-9]{4}$' } })),
    ).not.toThrow();
  });

  it('accepts an amount window in either open form', () => {
    expect(() => assertRuleRunnable(draft({ minAmountMinor: -9_400 }))).not.toThrow();
    expect(() => assertRuleRunnable(draft({ maxAmountMinor: -100 }))).not.toThrow();
    expect(() =>
      assertRuleRunnable(draft({ minAmountMinor: -9_400, maxAmountMinor: -100 })),
    ).not.toThrow();
  });

  it('accepts a window whose bounds are equal', () => {
    // A rule for one exact amount. Inclusive on both ends, so this matches
    // rather than being the smallest possible inverted window.
    expect(() =>
      assertRuleRunnable(draft({ minAmountMinor: -9_400, maxAmountMinor: -9_400 })),
    ).not.toThrow();
  });

  it('returns nothing, so it cannot be mistaken for a parser', () => {
    expect(assertRuleRunnable(draft())).toBeUndefined();
  });
});

describe('patterns that would hang the importer', () => {
  it('refuses a nested quantifier', () => {
    // The textbook catastrophic pattern, caught by the star-height check.
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'regex', value: '(a+)+$' } })),
    ).toThrow(BadRequestException);
  });

  it('refuses the pattern the star-height check calls safe', () => {
    // `(a|a)*$` has star height 1, so `safe-regex2` accepts it, and it is among
    // the most expensive patterns that exist. This is the case the timing ladder
    // in `@fin/categorize` was added for, and the only proof that this
    // validation runs the real compiler rather than a lookalike check.
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'regex', value: '(a|a)*$' } })),
    ).toThrow(BadRequestException);
  });

  it('refuses a pattern that is not a regular expression at all', () => {
    expect(() => assertRuleRunnable(draft({ matcher: { type: 'regex', value: '([' } }))).toThrow(
      /not a valid regular expression/,
    );
  });

  it('refuses an empty pattern', () => {
    expect(() => assertRuleRunnable(draft({ matcher: { type: 'regex', value: '' } }))).toThrow(
      /cannot be empty/,
    );
  });

  it('answers 400, not 500', () => {
    // A bad pattern is the caller's mistake. A 500 would page somebody and tell
    // the user nothing.
    expect(
      statusOf(() => assertRuleRunnable(draft({ matcher: { type: 'regex', value: '(a+)+$' } }))),
    ).toBe(400);
  });
});

describe('matchers that would swallow the ledger', () => {
  it('refuses a contains value with no letters or digits in it', () => {
    // `"!!!"` normalises to `""`, and `''` is a substring of every string. The
    // rule would file every transaction on the next import into one category,
    // and undoing that is a manual pass over the whole ledger.
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'contains', value: '!!!' } })),
    ).toThrow(BadRequestException);
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'contains', value: '---' } })),
    ).toThrow(/match every transaction/);
  });

  it('refuses the same value for equals and startsWith', () => {
    expect(() => assertRuleRunnable(draft({ matcher: { type: 'equals', value: '???' } }))).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'startsWith', value: '...' } })),
    ).toThrow(BadRequestException);
  });

  it('keeps a value that only looks empty after normalisation', () => {
    // Accents and case survive normalisation as letters, so this is a real
    // needle and must not be caught by the check above.
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'contains', value: 'Café' } })),
    ).not.toThrow();
  });
});

describe('amount windows that can never match', () => {
  it('refuses an inverted window', () => {
    // Amounts are signed: an expense of 94.00 is -9400, so the lower bound is
    // the larger expense. Reading it backwards is the easy mistake, and the
    // resulting rule silently never fires.
    expect(() => assertRuleRunnable(draft({ minAmountMinor: 100, maxAmountMinor: -100 }))).toThrow(
      BadRequestException,
    );
    expect(() => assertRuleRunnable(draft({ minAmountMinor: 100, maxAmountMinor: -100 }))).toThrow(
      /inverted/,
    );
  });

  it('explains the sign convention in the message it hands the user', () => {
    expect(() => assertRuleRunnable(draft({ minAmountMinor: 0, maxAmountMinor: -1 }))).toThrow(
      /Amounts are signed/,
    );
  });
});

describe('what the validation is wired to', () => {
  it('forwards the message from @fin/categorize rather than rewording it', () => {
    // Two sentences saying the same thing drift apart, and the one the user sees
    // is always the vaguer of the two. Compared against the compiler's own
    // output for the same rule, using a matcher whose message carries no timing
    // measurement in it.
    const candidate: CategorizeRule = {
      id: 'draft',
      categoryId: 'draft',
      matcherType: 'contains',
      matcherValue: '!!!',
      priority: 0,
      minAmountMinor: null,
      maxAmountMinor: null,
      active: true,
    };
    const expected = compileRules([candidate]).skipped[0]?.problem;
    expect(expected).toBeDefined();

    let thrown = '';
    try {
      assertRuleRunnable(draft({ matcher: { type: 'contains', value: '!!!' } }));
    } catch (error) {
      thrown = error instanceof Error ? error.message : '';
    }
    expect(thrown).toBe(expected);
  });

  it('compiles the draft as active, which is the only way a bad rule is seen', () => {
    // `compileRules` drops inactive rules without compiling them. If the draft
    // were passed through with `active: false`, validation would compile
    // nothing, find nothing, and store a pattern that hangs the importer the
    // moment somebody ticks the box. The left-hand side below is that broken
    // world; the right-hand side is this one.
    const inactive: CategorizeRule = {
      id: 'draft',
      categoryId: 'draft',
      matcherType: 'regex',
      matcherValue: '(a|a)*$',
      priority: 0,
      minAmountMinor: null,
      maxAmountMinor: null,
      active: false,
    };
    expect(compileRules([inactive]).skipped).toEqual([]);
    expect(() =>
      assertRuleRunnable(draft({ matcher: { type: 'regex', value: '(a|a)*$' } })),
    ).toThrow(BadRequestException);
  });
});
