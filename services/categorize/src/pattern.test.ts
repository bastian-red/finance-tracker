import safeRegex from 'safe-regex2';
import { describe, expect, it } from 'vitest';
import {
  compilePattern,
  isSafePattern,
  MAX_PATTERN_LENGTH,
  PatternError,
  PROBE_BUDGET_MS,
  PROBE_LENGTHS,
  probeAlphabet,
  slowestProbe,
} from './pattern';

/** Patterns a user of a Spanish bank would plausibly write. */
const ORDINARY = [
  '^nomina',
  'mercadona|carrefour|lidl',
  '^bar |restaurante',
  '\\d{4,}',
  '^(mercadona|lidl|carrefour) ?[0-9]*$',
  'glovo|just eat|deliveroo',
  '^amazon (eu|es)',
];

/**
 * The three shapes that make a backtracking engine explode.
 *
 * `(a+)+$` is the textbook nested quantifier. `(a|a)*$` is the one that matters
 * here: its star height is 1, so a static check calls it safe, and it is among
 * the most expensive patterns that exist.
 */
const CATASTROPHIC = ['^(a+)+$', '(a|a)*$', '(a*)*$', '(x+x+)+y', '(\\w+\\s?)*$'];

describe('compilePattern', () => {
  it.each(ORDINARY)('accepts %s', (source) => {
    expect(compilePattern(source)).toBeInstanceOf(RegExp);
  });

  it.each(CATASTROPHIC)('rejects %s', (source) => {
    expect(() => compilePattern(source)).toThrow(PatternError);
  });

  it('rejects a pattern that is not a regular expression at all', () => {
    expect(() => compilePattern('(unclosed')).toThrow(PatternError);
    expect(() => compilePattern('[z-a]')).toThrow(PatternError);
    expect(() => compilePattern('')).toThrow(PatternError);
  });

  it('rejects a pattern past the contract cap', () => {
    const atCap = 'a'.repeat(MAX_PATTERN_LENGTH);
    const overCap = 'a'.repeat(MAX_PATTERN_LENGTH + 1);
    expect(compilePattern(atCap)).toBeInstanceOf(RegExp);
    expect(() => compilePattern(overCap)).toThrow(/at most 200 characters/);
  });

  it('compiles without flags', () => {
    // `g` is the one that bites: a global regex keeps `lastIndex` between calls,
    // so a rule would match one row and skip the next, forever, in a way that
    // cannot be reproduced from the UI. `i` is unnecessary because the subject is
    // already lowercased by normaliseDescription.
    expect(compilePattern('mercadona').flags).toBe('');
    expect(compilePattern('mercadona').global).toBe(false);
  });

  it('matches against the lowercase, unaccented form rules are written for', () => {
    // Pinned because it is the thing a user gets wrong: the pattern runs against
    // the normalised description, not the raw statement line.
    const pattern = compilePattern('^nomina');
    expect(pattern.test('nomina mensual acme s l')).toBe(true);
    expect(pattern.test('NOMINA MENSUAL ACME S.L.')).toBe(false);
  });
});

describe('isSafePattern', () => {
  it('answers without throwing', () => {
    expect(isSafePattern('^nomina')).toBe(true);
    expect(isSafePattern('(a|a)*$')).toBe(false);
    expect(isSafePattern('(unclosed')).toBe(false);
  });
});

describe('probeAlphabet', () => {
  it('repeats characters the pattern can actually consume', () => {
    // The point of deriving the alphabet. `'a'.repeat(22)` proves nothing about
    // `(x+x+)+y`, because the pattern cannot consume an `a` at all.
    expect(probeAlphabet('(x+x+)+y')).toEqual(['x', 'y']);
    expect(probeAlphabet('^nomina')).toEqual(['n', 'o', 'm', 'i']);
  });

  it('maps character classes to one representative each', () => {
    expect(probeAlphabet('\\d+')).toEqual(['1']);
    expect(probeAlphabet('\\w+')).toEqual(['a']);
    expect(probeAlphabet('\\s+')).toEqual([' ']);
    expect(probeAlphabet('.+')).toEqual(['a']);
  });

  it('always returns something, so the probe always runs', () => {
    // A pattern of pure punctuation has no literals to repeat. Returning an empty
    // alphabet would skip the probe entirely and silently disable layer 2.
    expect(probeAlphabet('^$')).toEqual(['a']);
    expect(probeAlphabet('()')).toEqual(['a']);
  });
});

/**
 * Warm the regex the way anything that runs twice would.
 *
 * This is not a detail, it is the bug that shipped in the first version of this
 * file. V8 compiles a `RegExp` to native code once anything has executed it, and
 * the warm cost of a catastrophic pattern is an order of magnitude under the cold
 * one: `(a|a)*$` at a fixed probe length of 22 measured 474ms cold and 23ms warm,
 * and 23ms sat under the budget of the time. The check accepted it. Every timing
 * assertion below therefore measures the warm case, because that is the one the
 * check has to survive.
 */
function warm(source: string): RegExp {
  const compiled = new RegExp(source);
  for (let i = 0; i < 5; i += 1) compiled.test('a'.repeat(12) + '~');
  return compiled;
}

describe('the probe ladder', () => {
  /**
   * The separation the whole approach rests on.
   *
   * Measured warm on the machine that wrote this: an ordinary pattern walks all
   * four rungs in under 0.013ms total, and every catastrophic one trips a rung at
   * 5.8ms or more. The margins below are loose enough that a loaded CI runner
   * cannot fail them and tight enough to go red if the separation collapses.
   */
  it.each(ORDINARY)('walks the whole ladder for %s without tripping', (source) => {
    expect(slowestProbe(warm(source), source)).toBeNull();
  });

  it('a single slow reading is not enough to reject a pattern', () => {
    // The failure this pins, and it was a CI failure before it was a test: a
    // shared runner preempted the process between two `hrtime` reads and charged
    // a 16-character probe of an ordinary alternation with 5.36ms, over a budget
    // it clears in 0.013ms on an idle machine. In the suite that is a flake. In
    // production it is an API telling somebody their rule backtracks because the
    // host was busy, once, unreproducibly.
    //
    // A regex whose first `test` is slow and whose later ones are not is exactly
    // what noise looks like and exactly what backtracking does not, so the
    // measurement keeps the fastest run rather than the first.
    const ordinary = warm('mercadona|carrefour|lidl');
    let call = 0;
    const flaky = {
      ...ordinary,
      source: ordinary.source,
      test(input: string) {
        call += 1;
        // One long pause, on the first probe only.
        if (call === 1) {
          const until = process.hrtime.bigint() + BigInt(8_000_000);
          while (process.hrtime.bigint() < until) {
            /* burn wall clock the way a descheduled process does */
          }
        }
        return ordinary.test(input);
      },
    } as unknown as RegExp;

    expect(slowestProbe(flaky, 'mercadona|carrefour|lidl')).toBeNull();
    // And it really did stall once, so the case is not vacuous.
    expect(call).toBeGreaterThan(1);
  });

  it.each(CATASTROPHIC)('trips a rung for %s even warm', (source) => {
    // The regression this pins. With a single fixed probe of length 22, `(a|a)*$`
    // measured 72ms in this suite and 23ms warm in isolation — under the 50ms
    // budget of the time, so `compilePattern` accepted it. The fix was the ladder,
    // not a larger threshold.
    const tripped = slowestProbe(warm(source), source);
    expect(tripped).not.toBeNull();
    expect(tripped?.milliseconds).toBeGreaterThan(PROBE_BUDGET_MS);
    expect(PROBE_LENGTHS as readonly number[]).toContain(tripped?.length);
  });

  it.each(CATASTROPHIC)('rejects %s when it has already been run', (source) => {
    // The same claim through the public API, which is what the API's rule-create
    // route calls. Warmed first, because a long-lived process compiles a pattern
    // once and runs it thousands of times.
    warm(source);
    expect(() => compilePattern(source)).toThrow(PatternError);
  });

  it('rejects quickly, so the rejection is not itself the denial of service', () => {
    // A fixed probe of length 26 rejected `(a*)*$` in 1.3 seconds and made this
    // suite take fifteen. The ladder stops at the first rung over budget, and the
    // rung that trips is by definition only just over it. Measured worst case
    // across all five patterns: 20ms. The ceiling here is 40x that, because this
    // is a wall-clock assertion and it must not be the flaky one.
    for (const source of CATASTROPHIC) {
      warm(source);
      const started = process.hrtime.bigint();
      expect(() => compilePattern(source)).toThrow(PatternError);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsed, source).toBeLessThan(800);
    }
  });

  it('is what catches the pattern the static check misses', () => {
    // The load-bearing claim of the two-layer design, as an executable assertion
    // rather than a comment: the static check passes this pattern, and the ladder
    // is the only thing standing between it and the import loop. If safe-regex2
    // ever learns this class, this test goes red and layer 2 can be reconsidered.
    // Not before.
    expect(safeRegex('(a|a)*$')).toBe(true);
    expect(safeRegex('^(a+)+$')).toBe(false);
    expect(() => compilePattern('(a|a)*$')).toThrow(/backtracks/);
  });

  it('climbs in steps of four, so each rung is sixteen times the last', () => {
    // Pinned because this shape is the entire margin, and a fixed single length
    // was wrong twice. Each rung being 16x the work below it is what makes the
    // check portable: a pattern that survives one rung is probed far harder at
    // the next, so a much faster machine still trips somewhere on the ladder.
    expect([...PROBE_LENGTHS]).toEqual([16, 20, 24, 28]);
    expect(PROBE_BUDGET_MS).toBe(5);
  });
});
