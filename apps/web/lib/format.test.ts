import { describe, expect, it } from 'vitest';
import {
  absoluteMoney,
  budgetStateLabel,
  categorySwatchVar,
  directionLabel,
  meterPercent,
  money,
  percentFromBasisPoints,
  type MoneyFormat,
} from './format';

/**
 * What every number and every state word looks like by the time it reaches the DOM.
 *
 * What it pins: the exact output strings, the two rounding rules that are
 * deliberately asymmetric, and the fact that a state always carries a glyph and
 * a word beside its colour class.
 *
 * What breaks without it: money renders wrong in a way that looks right. `1234,56`
 * and `1.234,56` are the same number under different locales and a factor of a
 * thousand apart under the wrong one, and a percentage rounded the convenient way
 * tells a person with nine euros left that they have spent their budget.
 *
 * **Every expectation below that depends on `Intl` was produced by running the
 * code and pasting the output**, never by recalling what a locale does. `es-ES`
 * renders `1234,56` with no thousands separator at four digits and `1.000.000,00`
 * at seven, and the character before the currency symbol is U+00A0, not a space.
 * The escapes are written out (`\u00a0`, `€`) rather than pasted, because a
 * no-break space and a space are the same pixels in every editor and every diff.
 */

/** The app's own defaults, from `lib/config.ts`. */
const ES: MoneyFormat = { currency: 'EUR', locale: 'es-ES' };
const US: MoneyFormat = { currency: 'USD', locale: 'en-US' };

describe('money', () => {
  it('formats minor units as the locale writes them', () => {
    expect(money(123456, ES)).toBe('1234,56\u00a0€');
    expect(money(-8990, ES)).toBe('-89,90\u00a0€');
    expect(money(0, ES)).toBe('0,00\u00a0€');
    expect(money(5, ES)).toBe('0,05\u00a0€');
  });

  it('groups only once the number is long enough for es-ES to group it', () => {
    // Four digits get no separator in Spanish. This is the assertion that would
    // have caught someone "fixing" the code until it emitted 1.234,56.
    expect(money(123456, ES)).toBe('1234,56\u00a0€');
    expect(money(100000000, ES)).toBe('1.000.000,00\u00a0€');
  });

  it('honours signDisplay', () => {
    expect(money(123456, ES, 'always')).toBe('+1234,56\u00a0€');
    expect(money(-8990, ES, 'always')).toBe('-89,90\u00a0€');
    expect(money(-8990, ES, 'never')).toBe('89,90\u00a0€');
    expect(money(123456, ES, 'never')).toBe('1234,56\u00a0€');
    // Zero takes a plus under 'always'. Worth pinning: a ledger row for a
    // zero-amount correction should not read as if the sign were missing.
    expect(money(0, ES, 'always')).toBe('+0,00\u00a0€');
  });

  it('takes its locale and currency from the argument, never from the machine', () => {
    // The same integer, four different strings. A helper that reached for the
    // process locale would make a CI screenshot disagree with a laptop.
    expect(money(-8990, US)).toBe('-$89.90');
    expect(money(123456, US, 'always')).toBe('+$1,234.56');
  });

  it('respects the currency exponent instead of assuming two decimals', () => {
    // JPY has no minor unit: 1234 is 1234 yen, not 12,34.
    expect(money(1234, { currency: 'JPY', locale: 'es-ES' })).toBe('1234\u00a0JPY');
    expect(money(1234, { currency: 'JPY', locale: 'ja-JP' })).toBe('￥1,234');
  });

  it('throws on a fractional amount rather than displaying a rounded one', () => {
    // `minor()` is the tripwire for "a float leaked in three layers upstream".
    // Failing at the point of display beats a total that is quietly one cent out.
    expect(() => money(12.5, ES)).toThrow(/safe integer/);
    expect(() => money(Number.NaN, ES)).toThrow(/safe integer/);
  });
});

describe('absoluteMoney', () => {
  it('drops the sign and the magnitude survives', () => {
    // Pairs with a direction word beside it, so the sign would be a second
    // statement of the same fact and a contradictory one if they disagreed.
    expect(absoluteMoney(-8990, ES)).toBe('89,90\u00a0€');
    expect(absoluteMoney(8990, ES)).toBe('89,90\u00a0€');
    expect(absoluteMoney(0, ES)).toBe('0,00\u00a0€');
  });
});

describe('directionLabel', () => {
  it('carries a glyph and a word, not only a colour class', () => {
    // The colour is the third channel. If this ever returned a class alone, a
    // reader with a colour vision deficiency would be told nothing: income and
    // expense measure 2.0:1 against each other in greyscale in light mode, which
    // is the best pair available on this canvas.
    expect(directionLabel(4500)).toEqual({
      direction: 'income',
      glyph: '+',
      word: 'In',
      className: 'state-income',
    });
    expect(directionLabel(-4500)).toEqual({
      direction: 'expense',
      glyph: '-',
      word: 'Out',
      className: 'state-expense',
    });
    expect(directionLabel(0)).toEqual({
      direction: 'zero',
      glyph: '=',
      word: 'Zero',
      className: 'state-neutral',
    });
  });

  it('gives every direction a distinct glyph and a distinct word', () => {
    const labels = [directionLabel(1), directionLabel(-1), directionLabel(0)];
    expect(new Set(labels.map((label) => label.glyph)).size).toBe(3);
    expect(new Set(labels.map((label) => label.word)).size).toBe(3);
  });

  it('throws on a fractional amount', () => {
    expect(() => directionLabel(0.5)).toThrow(/safe integer/);
  });
});

describe('budgetStateLabel', () => {
  it('gives each state its own glyph and word', () => {
    expect(budgetStateLabel('exceeded')).toEqual({
      glyph: '✕',
      word: 'Exceeded',
      className: 'state-exceeded',
    });
    expect(budgetStateLabel('approaching')).toEqual({
      glyph: '▲',
      word: 'Approaching',
      className: 'state-approaching',
    });
    expect(budgetStateLabel('under')).toEqual({
      glyph: '✓',
      word: 'Under',
      className: 'state-income',
    });
  });

  it('reuses the income colour for "under" rather than inventing a fourth', () => {
    // Deliberate: "under budget" and "money in" are the same good news, and a
    // fourth status hue would be a fourth thing to keep above 4.5:1.
    expect(budgetStateLabel('under').className).toBe(directionLabel(1).className);
  });

  it('never returns the same glyph for two states', () => {
    const glyphs = (['under', 'approaching', 'exceeded'] as const).map(
      (state) => budgetStateLabel(state).glyph,
    );
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe('percentFromBasisPoints', () => {
  it('truncates below the limit and rounds up above it', () => {
    // The asymmetry is the point. 9,990 basis points is 99.9%: rounding it to
    // 100 tells someone with nine euros left that they have none. 10,050 is
    // 100.5%: rounding it down to 100 tells someone who has overspent that they
    // have not.
    expect(percentFromBasisPoints(9990)).toBe(99);
    expect(percentFromBasisPoints(10_000)).toBe(100);
    expect(percentFromBasisPoints(10_001)).toBe(101);
    expect(percentFromBasisPoints(10_050)).toBe(101);
  });

  it('handles the ordinary middle and the empty budget', () => {
    expect(percentFromBasisPoints(0)).toBe(0);
    expect(percentFromBasisPoints(1)).toBe(0);
    expect(percentFromBasisPoints(5000)).toBe(50);
    expect(percentFromBasisPoints(8249)).toBe(82);
    expect(percentFromBasisPoints(14_200)).toBe(142);
  });
});

describe('meterPercent', () => {
  it('rounds to a whole percent', () => {
    expect(meterPercent(0)).toBe(0);
    expect(meterPercent(8250)).toBe(83);
    expect(meterPercent(8249)).toBe(82);
    expect(meterPercent(10_000)).toBe(100);
  });

  it('clamps, because a bar cannot be more than full or less than empty', () => {
    // A month of refunds nets negative. A negative width is invalid CSS, which
    // browsers drop, rendering a bar identical to an untouched budget's.
    expect(meterPercent(-5000)).toBe(0);
    expect(meterPercent(14_200)).toBe(100);
  });

  it('always produces an integer, which is what the inline style needs', () => {
    for (const basisPoints of [1, 333, 6667, 9999, 10_001]) {
      expect(Number.isInteger(meterPercent(basisPoints)), `${basisPoints}`).toBe(true);
    }
  });
});

describe('categorySwatchVar', () => {
  it('maps each of the ten slots to its own variable', () => {
    for (let slot = 0; slot < 10; slot += 1) {
      expect(categorySwatchVar(slot)).toBe(`var(--cat-${slot})`);
    }
    expect(new Set(Array.from({ length: 10 }, (_, slot) => categorySwatchVar(slot))).size).toBe(10);
  });

  it('folds anything outside 0..9 onto the neutral', () => {
    // UNCATEGORISED_SLOT is -1 and is a normal state, not an error. Everything
    // else lands here too: an undeclared custom property invalidates the whole
    // declaration, so the swatch would inherit silently instead of failing where
    // someone can see it.
    expect(categorySwatchVar(-1)).toBe('var(--cat-none)');
    expect(categorySwatchVar(10)).toBe('var(--cat-none)');
    expect(categorySwatchVar(1.5)).toBe('var(--cat-none)');
    expect(categorySwatchVar(Number.NaN)).toBe('var(--cat-none)');
  });

  it('emits literal names the token gate can find by grepping', () => {
    // `var(--cat-${slot})` would be shorter and invisible to lib/tokens.test.ts,
    // which is how a renamed token would ship with no warning anywhere.
    expect(categorySwatchVar(3)).toMatch(/^var\(--cat-\d\)$/);
  });
});
