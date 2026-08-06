import { describe, expect, it } from 'vitest';
import { MoneyError } from './money';
import { detectAmountFormat, parseAmount, parseAmountColumn } from './parse';

const ES = ',' as const;
const EN = '.' as const;

describe('detectAmountFormat()', () => {
  it('is conclusive when one value carries both separators', () => {
    expect(detectAmountFormat(['1.234,56'], EN)).toMatchObject({
      decimal: ',',
      reason: 'both-separators-present',
      ambiguous: false,
    });
    expect(detectAmountFormat(['1,234.56'], ES)).toMatchObject({
      decimal: '.',
      reason: 'both-separators-present',
      ambiguous: false,
    });
  });

  it('overrides the caller locale when the file disagrees with it', () => {
    // The whole point of reading the column: a Spanish user importing a US
    // statement must not have their locale applied to it.
    expect(detectAmountFormat(['1,234.56', '99.00'], ES).decimal).toBe('.');
  });

  it('uses fraction length when only one separator ever appears', () => {
    expect(detectAmountFormat(['56,78', '12,00'], EN)).toMatchObject({
      decimal: ',',
      reason: 'fraction-length',
      ambiguous: false,
    });
  });

  it('resolves a column that mixes an ambiguous value with a decisive one', () => {
    // `1.234` alone could be either. `12.34` in the same column cannot.
    expect(detectAmountFormat(['1.234', '12.34'], ES)).toMatchObject({
      decimal: '.',
      ambiguous: false,
    });
  });

  it('reads repeated groups as grouping, since no number has two decimal points', () => {
    expect(detectAmountFormat(['1.234.567'], EN)).toMatchObject({
      decimal: ',',
      reason: 'repeated-groups',
      ambiguous: false,
    });
    expect(detectAmountFormat(['1,234,567'], ES)).toMatchObject({
      decimal: '.',
      reason: 'repeated-groups',
      ambiguous: false,
    });
  });

  it('falls back to the locale when every value looks like 1.234, and says so', () => {
    // This is the genuinely undecidable case. It is reported rather than hidden,
    // so the importer can show the reader what it assumed.
    const format = detectAmountFormat(['1.234', '5.678'], ES);
    expect(format).toMatchObject({ decimal: ',', reason: 'locale-fallback', ambiguous: true });

    const asEnglish = detectAmountFormat(['1.234', '5.678'], EN);
    expect(asEnglish).toMatchObject({ decimal: '.', ambiguous: true });
  });

  it('is not ambiguous when the column has no separators at all', () => {
    expect(detectAmountFormat(['1234', '99'], ES)).toMatchObject({
      reason: 'no-separator',
      ambiguous: false,
    });
  });

  it('refuses a column that uses both characters as decimals in different rows', () => {
    // `12.34` and `56,78` in one file is not a format, it is a broken export.
    // Picking one would be wrong for half the rows.
    expect(() => detectAmountFormat(['12.34', '56,78'], ES)).toThrow(MoneyError);
  });

  it('ignores blank cells rather than counting them as evidence', () => {
    expect(detectAmountFormat(['', '  ', '56,78'], EN).decimal).toBe(',');
  });
});

describe('parseAmount()', () => {
  const esFormat = { decimal: ',' as const, reason: 'fraction-length' as const, ambiguous: false };
  const enFormat = { decimal: '.' as const, reason: 'fraction-length' as const, ambiguous: false };

  it('parses the two common European and American shapes to the same cents', () => {
    expect(parseAmount('1.234,56', esFormat, 2)).toBe(123_456);
    expect(parseAmount('1,234.56', enFormat, 2)).toBe(123_456);
  });

  it('parses an amount with no grouping', () => {
    expect(parseAmount('89,90', esFormat, 2)).toBe(8990);
    expect(parseAmount('89.90', enFormat, 2)).toBe(8990);
  });

  it('pads a short fraction to the currency exponent', () => {
    expect(parseAmount('89,9', esFormat, 2)).toBe(8990);
    expect(parseAmount('89', esFormat, 2)).toBe(8900);
  });

  it('reads every way a statement writes "negative"', () => {
    expect(parseAmount('-89,90', esFormat, 2)).toBe(-8990);
    expect(parseAmount('89,90-', esFormat, 2)).toBe(-8990);
    expect(parseAmount('(89,90)', esFormat, 2)).toBe(-8990);
    expect(parseAmount('−89,90', esFormat, 2)).toBe(-8990); // U+2212 minus
  });

  it('keeps an explicit plus positive', () => {
    expect(parseAmount('+89,90', esFormat, 2)).toBe(8990);
  });

  it('strips currency symbols, codes and grouping whitespace', () => {
    expect(parseAmount('€ 1.234,56', esFormat, 2)).toBe(123_456);
    expect(parseAmount('1.234,56 EUR', esFormat, 2)).toBe(123_456);
    expect(parseAmount('1 234,56', esFormat, 2)).toBe(123_456); // non-breaking space
    expect(parseAmount("1'234.56", enFormat, 2)).toBe(123_456); // Swiss apostrophe
  });

  it('handles a zero-decimal currency', () => {
    expect(parseAmount('1.234', { ...esFormat, reason: 'repeated-groups' }, 0)).toBe(1234);
  });

  it('refuses more decimals than the currency has', () => {
    // `89,905` for a EUR account is not a rounding question. It is the signal
    // that the separator was read the wrong way round, and rounding it away
    // would bury the only evidence.
    expect(() => parseAmount('89,905', esFormat, 2)).toThrow(MoneyError);
  });

  it('refuses text that is not a number', () => {
    expect(() => parseAmount('', esFormat, 2)).toThrow(MoneyError);
    expect(() => parseAmount('n/a', esFormat, 2)).toThrow(MoneyError);
    expect(() => parseAmount('1,2,3', esFormat, 2)).toThrow(MoneyError);
  });

  it('refuses an amount too large to hold exactly', () => {
    expect(() => parseAmount('999999999999999999,99', esFormat, 2)).toThrow(MoneyError);
  });
});

describe('parseAmountColumn()', () => {
  it('decides once and applies to every row', () => {
    const { format, amounts } = parseAmountColumn(['1.234,56', '-89,90', '0,00'], {
      localeDecimal: '.',
      exponent: 2,
    });
    expect(format.decimal).toBe(',');
    expect(amounts).toEqual([123_456, -8990, 0]);
  });

  it('is the difference between right and a thousandfold error', () => {
    // Read row by row with a US locale, `1.234` would become 123 cents. Read as a
    // column, the `,` in the second row proves `.` is grouping.
    const { amounts } = parseAmountColumn(['1.234', '56,78'], {
      localeDecimal: '.',
      exponent: 2,
    });
    expect(amounts).toEqual([123_400, 5678]);
  });
});
