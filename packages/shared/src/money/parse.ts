/**
 * Reading an amount out of a bank statement.
 *
 * `1.234` is either one thousand two hundred and thirty-four, or one and
 * two hundred thirty-four thousandths. Both readings are correct; only one is
 * what the bank meant. Guessing wrong is a factor-of-a-thousand error in a
 * number somebody is going to make decisions with, and it will not look wrong on
 * screen — `1.234,00 €` and `1,23 €` are both perfectly plausible groceries.
 *
 * So this module does not guess per value. It decides the format **once, from
 * the whole column**, where the ambiguity usually resolves itself: a file
 * containing both `1.234` and `56,78` can only be using `.` for thousands. Only
 * when the entire column stays ambiguous does the caller's configured locale
 * break the tie, and `detectAmountFormat` says so explicitly rather than
 * silently picking one.
 *
 * Everything here is a pure function of its input. No clock, no environment, no
 * I/O — the same column always yields the same decision, which is what makes it
 * testable rather than merely tested.
 */
import { MoneyError, minor, type Minor } from './money';

export interface AmountFormat {
  /** The character before the fractional digits. */
  decimal: '.' | ',';
  /** How the decision was reached, so a wrong guess is visible in the UI. */
  reason:
    | 'both-separators-present'
    | 'fraction-length'
    | 'repeated-groups'
    | 'no-separator'
    | 'locale-fallback';
  /** True when the column alone could not decide and the locale broke the tie. */
  ambiguous: boolean;
}

/** Characters banks use to group thousands, including the non-breaking spaces. */
// U+00A0 no-break, U+202F narrow no-break, U+2019 apostrophe. Written as
// escapes: pasted, they are indistinguishable from an ordinary space and
// from each other, and the next person to retype the line breaks it.
const GROUPING = new Set([' ', '\u00a0', '\u202f', "'", '\u2019']);

/**
 * Strip everything that is not a digit, a separator or a sign, and normalise the
 * ways a statement can express "negative".
 *
 * Accounting parentheses (`(89.90)`) and a trailing minus (`89.90-`) are both
 * common in exports from older core banking systems, and both mean the same
 * thing as a leading minus.
 */
function normaliseSign(raw: string): { body: string; negative: boolean } {
  let text = raw.trim();
  let negative = false;

  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  // Currency symbols, codes and grouping whitespace. Keep `.` and `,` — deciding
  // between them is the entire job of this module.
  const body = [...text].filter((ch) => /[0-9.,]/.test(ch) && !GROUPING.has(ch)).join('');
  return { body, negative };
}

/**
 * Decide, for a whole column of raw amount strings, which character is the
 * decimal separator.
 *
 * The evidence is checked strongest first:
 *
 *   1. **Both separators in one value.** `1.234,56` — whichever comes last is
 *      the decimal. This is conclusive and needs no other input.
 *   2. **Fraction length.** A separator followed by exactly three digits in
 *      *every* value it appears in is grouping, not a decimal; a separator
 *      followed by one or two digits anywhere is a decimal. `1.234` alone is
 *      ambiguous, but `1.234` and `12.34` together are not.
 *   3. **Repeated groups.** `1.234.567` can only be grouping — no number has two
 *      decimal points.
 *   4. Otherwise the column has no separators at all, or every value looks like
 *      `1.234`, and the caller's locale decides. `ambiguous` is set so the
 *      importer can show the reader what it assumed.
 */
export function detectAmountFormat(
  samples: readonly string[],
  localeDecimal: '.' | ',',
): AmountFormat {
  let sawBoth = false;
  let bothDecimal: '.' | ',' = localeDecimal;
  let sawRepeated: '.' | ',' | null = null;
  const shortFraction = new Set<'.' | ','>();
  const threeFraction = new Set<'.' | ','>();
  let sawAnySeparator = false;

  for (const sample of samples) {
    const { body } = normaliseSign(sample);
    if (body === '') continue;

    const dots = (body.match(/\./g) ?? []).length;
    const commas = (body.match(/,/g) ?? []).length;
    if (dots > 0 || commas > 0) sawAnySeparator = true;

    if (dots > 0 && commas > 0) {
      sawBoth = true;
      bothDecimal = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ',';
      continue;
    }
    if (dots > 1) sawRepeated = '.';
    if (commas > 1) sawRepeated = ',';

    const separator: '.' | ',' | null = dots === 1 ? '.' : commas === 1 ? ',' : null;
    if (separator === null) continue;

    const fraction = body.slice(body.lastIndexOf(separator) + 1).length;
    if (fraction === 3) threeFraction.add(separator);
    else shortFraction.add(separator);
  }

  if (sawBoth) {
    return { decimal: bothDecimal, reason: 'both-separators-present', ambiguous: false };
  }

  // A separator that is ever followed by one or two digits is a decimal point.
  // Checked before the three-digit case because a column holding both `12.34`
  // and `1.234` is a decimal column with a four-figure amount in it, not a
  // grouped one.
  if (shortFraction.size === 1) {
    const [decimal] = [...shortFraction];
    return { decimal: decimal as '.' | ',', reason: 'fraction-length', ambiguous: false };
  }
  if (shortFraction.size === 2) {
    // Both characters appear as decimals in different rows, which no single file
    // does on purpose. Refusing beats picking one and being wrong half the time.
    throw new MoneyError(
      'This column uses "." as a decimal in some rows and "," in others. ' +
        'Split the file or fix the export; there is no correct single reading.',
    );
  }

  if (sawRepeated !== null) {
    return {
      decimal: sawRepeated === '.' ? ',' : '.',
      reason: 'repeated-groups',
      ambiguous: false,
    };
  }

  if (!sawAnySeparator) {
    return { decimal: localeDecimal, reason: 'no-separator', ambiguous: false };
  }

  // Every value looks like `1.234`: grouping and decimal are indistinguishable
  // from the column alone.
  return { decimal: localeDecimal, reason: 'locale-fallback', ambiguous: true };
}

/**
 * Parse one amount into exact minor units, given a format already decided for
 * the column and the currency's exponent.
 *
 * More fractional digits than the currency has are an error rather than
 * something to round away. A statement that says `89.905` for a EUR account is
 * not a rounding question, it is a sign the column was misread — most likely a
 * grouped `89.905` that should have been eighty-nine thousand.
 */
export function parseAmount(raw: string, format: AmountFormat, exponent: number): Minor {
  const { body, negative } = normaliseSign(raw);
  if (body === '') {
    throw new MoneyError(`Amount "${raw}" contains no digits.`);
  }

  const grouping = format.decimal === '.' ? ',' : '.';
  const withoutGrouping = body.split(grouping).join('');

  const parts = withoutGrouping.split(format.decimal);
  if (parts.length > 2) {
    throw new MoneyError(`Amount "${raw}" has more than one decimal separator.`);
  }

  const whole = parts[0] ?? '';
  const fraction = parts[1] ?? '';
  if (!/^[0-9]*$/.test(whole) || !/^[0-9]*$/.test(fraction)) {
    throw new MoneyError(`Amount "${raw}" is not a number.`);
  }
  if (whole === '' && fraction === '') {
    throw new MoneyError(`Amount "${raw}" contains no digits.`);
  }
  if (fraction.length > exponent) {
    throw new MoneyError(
      `Amount "${raw}" has ${fraction.length} decimal places but this currency has ${exponent}. ` +
        'That usually means the decimal separator was read the wrong way round.',
    );
  }

  // String concatenation, not arithmetic: `"89" + "90"` is exact at any size,
  // where `89 * 100 + 90` would already have gone through a float.
  const digits = `${whole || '0'}${fraction.padEnd(exponent, '0')}`;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Amount "${raw}" is too large to represent exactly.`);
  }

  return minor(negative ? -value : value);
}

/**
 * Parse a whole column in one pass: detect the format, then apply it to every
 * value. Returns the format alongside the amounts so the importer can tell the
 * reader what it decided and why.
 */
export function parseAmountColumn(
  samples: readonly string[],
  options: { localeDecimal: '.' | ','; exponent: number },
): { format: AmountFormat; amounts: Minor[] } {
  const format = detectAmountFormat(samples, options.localeDecimal);
  return { format, amounts: samples.map((s) => parseAmount(s, format, options.exponent)) };
}
