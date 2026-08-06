import { describe, expect, it } from 'vitest';
import {
  ZERO,
  absMinor,
  addMinor,
  directionOf,
  exponentOf,
  formatMoney,
  minor,
  MoneyError,
  negateMinor,
  scaleMinor,
  shareInBasisPoints,
  subMinor,
  sumMinor,
  toDecimalString,
} from './money';

describe('minor()', () => {
  it('accepts an integer count of minor units', () => {
    expect(minor(8990)).toBe(8990);
    expect(minor(-8990)).toBe(-8990);
    expect(minor(0)).toBe(0);
  });

  it('refuses a fractional value, because that means a float leaked in', () => {
    expect(() => minor(89.9)).toThrow(MoneyError);
    expect(() => minor(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('refuses a value past the exact integer range', () => {
    // 2^53 + 1 is not representable; the literal below already *is* 2^53.
    expect(() => minor(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
    expect(() => minor(Infinity)).toThrow(MoneyError);
    expect(() => minor(NaN)).toThrow(MoneyError);
  });
});

describe('the float traps this module exists to avoid', () => {
  it('adds tenths exactly, where floats do not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In cents it is just 10 + 20.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addMinor(minor(10), minor(20))).toBe(30);
  });

  it('sums a long column without drift', () => {
    // A thousand rows of 0.07 is 70.00 exactly. Summed as floats it is not:
    // the assertion below is what the naive implementation gets wrong.
    const rows = Array.from({ length: 1000 }, () => minor(7));
    expect(sumMinor(rows)).toBe(7000);

    let asFloat = 0;
    for (let i = 0; i < 1000; i += 1) asFloat += 0.07;
    expect(asFloat).not.toBe(70);
  });

  it('rounds a share half away from zero, symmetrically for refunds', () => {
    // 0.5 cents up on a charge and 0.5 cents up in magnitude on a refund.
    // Math.round alone is asymmetric: Math.round(-0.5) is -0, not -1.
    expect(scaleMinor(minor(101), 1, 2)).toBe(51);
    expect(scaleMinor(minor(-101), 1, 2)).toBe(-51);
  });

  it('returns a whole number of cents from a percentage, by construction', () => {
    const budget = minor(123_456);
    expect(scaleMinor(budget, 80, 100)).toBe(98_765); // 98764.8 -> 98765

    // The hazard `scaleMinor` removes is not that `budget * 0.8` computes a
    // different number — for ordinary ratios it agrees once rounded. It is that
    // it computes a value that is not a whole number of cents at all, and
    // nothing in the type system then forces anyone to round it. 98764.8 cents
    // will store, sum and render perfectly happily.
    expect(Number.isInteger(123_456 * 0.8)).toBe(false);
    expect(Number.isInteger(scaleMinor(budget, 80, 100))).toBe(true);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and absolutes', () => {
    expect(addMinor(minor(1250), minor(-300))).toBe(950);
    expect(subMinor(minor(1250), minor(300))).toBe(950);
    expect(negateMinor(minor(1250))).toBe(-1250);
    expect(absMinor(minor(-1250))).toBe(1250);
    expect(sumMinor([])).toBe(ZERO);
  });

  it('catches overflow on the running total, not only on the result', () => {
    const huge = minor(Number.MAX_SAFE_INTEGER - 1);
    // Ends near zero, but passes through the unsafe range on the way. Checking
    // only the final value would let this through.
    expect(() => sumMinor([huge, huge, negateMinor(huge), negateMinor(huge)])).toThrow(MoneyError);
  });

  it('refuses a zero denominator rather than returning Infinity', () => {
    expect(() => scaleMinor(minor(100), 1, 0)).toThrow(MoneyError);
  });

  it('refuses a fractional ratio, which would reintroduce the float', () => {
    expect(() => scaleMinor(minor(100), 0.8 as unknown as number, 1)).toThrow(MoneyError);
  });
});

describe('shareInBasisPoints()', () => {
  it('reports a share as an integer', () => {
    expect(shareInBasisPoints(minor(5000), minor(10_000))).toBe(5000); // 50.00%
    expect(shareInBasisPoints(minor(1), minor(3))).toBe(3333);
  });

  it('treats an empty budget as zero rather than dividing by it', () => {
    // A budget with nothing in it is a normal state on a fresh account. A
    // dashboard that crashes on it is not.
    expect(shareInBasisPoints(minor(500), ZERO)).toBe(0);
  });

  it('can exceed 100%, because overspending is a real state', () => {
    expect(shareInBasisPoints(minor(15_000), minor(10_000))).toBe(15_000);
  });
});

describe('exponentOf()', () => {
  it('defaults to two decimal places', () => {
    expect(exponentOf('EUR')).toBe(2);
    expect(exponentOf('usd')).toBe(2);
    expect(exponentOf('XYZ')).toBe(2);
  });

  it('knows the currencies that are not 1/100', () => {
    expect(exponentOf('JPY')).toBe(0);
    expect(exponentOf('CLP')).toBe(0);
    expect(exponentOf('KWD')).toBe(3);
  });
});

describe('toDecimalString()', () => {
  it('slices digits instead of dividing', () => {
    expect(toDecimalString(minor(8990), 2)).toBe('89.90');
    expect(toDecimalString(minor(-8990), 2)).toBe('-89.90');
    expect(toDecimalString(minor(5), 2)).toBe('0.05');
    expect(toDecimalString(minor(-5), 2)).toBe('-0.05');
    expect(toDecimalString(ZERO, 2)).toBe('0.00');
  });

  it('handles a zero-exponent currency', () => {
    expect(toDecimalString(minor(1234), 0)).toBe('1234');
  });

  it('handles a three-exponent currency', () => {
    expect(toDecimalString(minor(1234), 3)).toBe('1.234');
    expect(toDecimalString(minor(12), 3)).toBe('0.012');
  });

  it('keeps the currency scale, which dividing does not', () => {
    // This is the concrete reason the display path never divides. `8990 / 100`
    // is 89.9, and `(89.9).toString()` is "89.9" — the trailing zero that makes
    // it money rather than a number is gone before formatting begins, and the
    // fix would be toFixed(), which is a float rounding step in the one place
    // that must not have one.
    expect((8990 / 100).toString()).toBe('89.9');
    expect(toDecimalString(minor(8990), 2)).toBe('89.90');
  });

  it('stays exact at a magnitude a personal ledger will never reach anyway', () => {
    expect(toDecimalString(minor(123_456_789_012_345), 2)).toBe('1234567890123.45');
  });

  it('always emits a plain numeric literal, which is what formatMoney casts to', () => {
    /**
     * `formatMoney` hands this string to `Intl.NumberFormat.format`, whose type
     * is the template literal `` `${number}` ``. A string built by slicing
     * digits cannot be checked against that statically, so there is one cast in
     * `money.ts` — and a cast is only as good as the invariant behind it.
     *
     * This is that invariant, checked rather than asserted in a comment: an
     * optional minus, digits, at most one dot, and nothing else. No grouping
     * separator, no exponent, no leading `+`, all three of which `Intl` would
     * either reject or silently misread.
     */
    const shape = /^-?\d+(\.\d+)?$/;
    const amounts = [0, 1, -1, 5, -5, 8990, -8990, 999_999, -999_999, 123_456_789_012_345];
    for (const exponent of [0, 2, 3]) {
      for (const amount of amounts) {
        const rendered = toDecimalString(minor(amount), exponent);
        expect(rendered, `${amount} at exponent ${exponent}`).toMatch(shape);
        // And it round-trips to the same number the slicing started from.
        expect(Math.round(Number(rendered) * 10 ** exponent)).toBe(amount);
      }
    }
  });
});

describe('formatMoney()', () => {
  it('formats for a Spanish reader', () => {
    // Two things pinned here, both of which a hand-rolled formatter gets wrong
    // and both of which will bite anything that asserts on rendered text:
    //
    //   1. Spanish typography does not group four-digit numbers. This is
    //      `1234,56 €`, not `1.234,56 €`. Grouping starts at five digits.
    //   2. The space before `€` is U+00A0, a non-breaking space, not U+0020.
    //      A Playwright `toHaveText('1.234,56 €')` typed with an ordinary space
    //      fails against a page that is completely correct.
    //
    // Written as `\u00a0` rather than pasted, because the two characters are
    // indistinguishable on screen and in a diff. See src/platform.test.ts.
    expect(formatMoney(minor(123_456), { currency: 'EUR', locale: 'es-ES' })).toBe(
      '1234,56\u00a0€',
    );
    expect(formatMoney(minor(1_234_556), { currency: 'EUR', locale: 'es-ES' })).toBe(
      '12.345,56\u00a0€',
    );
  });

  it('formats for a US reader', () => {
    expect(formatMoney(minor(123_456), { currency: 'USD', locale: 'en-US' })).toBe('$1,234.56');
  });

  it('formats a zero-decimal currency without inventing decimals', () => {
    const text = formatMoney(minor(1234), { currency: 'JPY', locale: 'ja-JP' });
    expect(text).toContain('1,234');
    expect(text).not.toContain('.00');
  });

  it('can force a leading plus for income rows', () => {
    const text = formatMoney(minor(1_240_050), {
      currency: 'EUR',
      locale: 'es-ES',
      signDisplay: 'always',
    });
    expect(text).toBe('+12.400,50\u00a0€');
  });

  it('is exact past the float-safe range, because Intl is given a string', () => {
    const text = formatMoney(minor(123_456_789_012_345), { currency: 'EUR', locale: 'en-US' });
    expect(text).toBe('€1,234,567,890,123.45');
  });
});

describe('directionOf()', () => {
  it('names the direction, so colour is never the only channel', () => {
    expect(directionOf(minor(100))).toBe('income');
    expect(directionOf(minor(-100))).toBe('expense');
    expect(directionOf(ZERO)).toBe('zero');
  });
});
