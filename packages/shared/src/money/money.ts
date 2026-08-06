/**
 * Money, as integer minor units.
 *
 * The single rule this app is built on: **an amount is never a floating-point
 * number.** `0.1 + 0.2` is `0.30000000000000004`, and a personal finance app is
 * a machine for adding thousands of small amounts together and showing the
 * total. A cent lost to binary rounding does not announce itself; it shows up
 * months later as a category total that does not match the sum of its rows, and
 * by then there is no way to tell which row was wrong.
 *
 * So an amount is an integer count of the currency's smallest unit — cents for
 * EUR and USD, whole yen for JPY — and it stays that way from the CSV parser,
 * through the database column, to the moment it is turned into a string for the
 * DOM. Nothing in between divides.
 *
 * `Minor` is branded so a bare `number` cannot be passed where an amount is
 * expected. That catches the realistic mistake, which is not `2.5` appearing out
 * of nowhere but a raw column value being threaded through three functions
 * before anyone notices it was euros rather than cents.
 */

declare const MINOR_BRAND: unique symbol;

/** An exact amount, counted in the currency's smallest unit. */
export type Minor = number & { readonly [MINOR_BRAND]: 'minor-units' };

/**
 * Currencies whose minor unit is not 1/100.
 *
 * Deliberately a short list rather than a full ISO 4217 table: these are the
 * ones a European or American user plausibly holds, and an unknown code falling
 * back to two decimals is right far more often than it is wrong. When it is
 * wrong the failure is visible immediately — the amount is off by a factor of a
 * hundred on the first screen — rather than silent.
 */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  CLP: 0,
  ISK: 0,
  VND: 0,
  BHD: 3,
  JOD: 3,
  KWD: 3,
  TND: 3,
};

/** How many decimal places this currency's minor unit represents. */
export function exponentOf(currency: string): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Assert that a number really is an exact integer count of minor units.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`: above 2^53 integers
 * stop being exactly representable, so `9007199254740993` silently becomes
 * `9007199254740992` and arithmetic on it is quietly wrong. That ceiling is
 * ~90 trillion euros in cents, which no personal budget reaches, so refusing is
 * free and the alternative is a number that lies.
 */
export function minor(value: number): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      `Amount must be a safe integer number of minor units, got ${value}. ` +
        'A fractional value here means a float leaked in somewhere upstream.',
    );
  }
  return value as Minor;
}

export const ZERO = 0 as Minor;

export function addMinor(a: Minor, b: Minor): Minor {
  return minor(a + b);
}

export function subMinor(a: Minor, b: Minor): Minor {
  return minor(a - b);
}

export function negateMinor(a: Minor): Minor {
  return minor(-a);
}

export function absMinor(a: Minor): Minor {
  return minor(Math.abs(a));
}

/**
 * Sum, with the overflow check applied to the running total rather than only to
 * the result. A sum that passes through the unsafe range and comes back is still
 * wrong, and checking only at the end would not see it.
 */
export function sumMinor(amounts: readonly Minor[]): Minor {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
    if (!Number.isSafeInteger(total)) {
      throw new MoneyError('Sum exceeded the exact integer range.');
    }
  }
  return total as Minor;
}

/**
 * Scale by a ratio, exactly, rounding half away from zero.
 *
 * Budgets need "80% of 1234,56" and reports need "this category as a share of
 * the month". Doing that as `amount * 0.8` reintroduces the float this module
 * exists to avoid, so the ratio arrives as two integers and the division happens
 * once, on an integer, at the end.
 *
 * Half away from zero rather than JavaScript's `Math.round`, which rounds -0.5
 * to -0 and 0.5 to 1 — asymmetric, so a refund and a charge of the same size
 * would round differently.
 */
export function scaleMinor(amount: Minor, numerator: number, denominator: number): Minor {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError('Scaling ratio must be two integers.');
  }
  if (denominator === 0) {
    throw new MoneyError('Cannot scale by a zero denominator.');
  }
  const scaled = amount * numerator;
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyError('Scaling overflowed the exact integer range.');
  }
  const quotient = scaled / denominator;
  const rounded = quotient < 0 ? -Math.round(-quotient) : Math.round(quotient);
  return minor(rounded);
}

/**
 * Share of a whole, in basis points (1/100 of a percent).
 *
 * Returns an integer so a progress bar or a "63% of budget" label never carries
 * a float either. A zero whole yields 0 rather than throwing: an empty budget is
 * a normal state, and a division-by-zero crash on a dashboard is not.
 */
export function shareInBasisPoints(part: Minor, whole: Minor): number {
  if (whole === 0) return 0;
  return Math.round((part * 10_000) / whole);
}

/**
 * The exact decimal string for an amount: `-8990` at exponent 2 is `"-89.90"`.
 *
 * Built by slicing the integer's digits, never by dividing. This is what gets
 * handed to `Intl.NumberFormat`, which accepts a decimal string and formats it
 * exactly, so no step of the display path goes through a float.
 */
export function toDecimalString(amount: Minor, exponent: number): string {
  if (exponent === 0) return String(amount);
  const sign = amount < 0 ? '-' : '';
  const digits = Math.abs(amount)
    .toString()
    .padStart(exponent + 1, '0');
  const cut = digits.length - exponent;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

export interface FormatOptions {
  currency: string;
  locale: string;
  /** Force a leading `+` on positive amounts. Income rows want it; totals do not. */
  signDisplay?: 'auto' | 'always' | 'never';
}

/**
 * Format for display.
 *
 * `Intl.NumberFormat` is given the exact decimal string rather than a number.
 * That is the whole trick: `format("123456789012345678.99")` is exact, while
 * `format(123456789012345678.99)` has already lost digits before Intl sees it.
 */
export function formatMoney(amount: Minor, options: FormatOptions): string {
  const exponent = exponentOf(options.currency);
  const formatter = new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: options.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
    signDisplay: options.signDisplay ?? 'auto',
  });
  // The cast is the one place this module leans on a type it cannot prove.
  // `Intl.StringNumericLiteral` is the template type `` `${number}` ``, and a
  // string built by slicing digits cannot be checked against it statically.
  // What guarantees it is `toDecimalString`, which only ever emits an optional
  // minus, digits, and at most one dot. `money.test.ts` asserts that shape
  // directly rather than trusting this comment.
  return formatter.format(toDecimalString(amount, exponent) as Intl.StringNumericLiteral);
}

/**
 * Direction of an amount, as a word.
 *
 * The design rule for this app is that money direction is never carried by
 * colour alone: a green number and a red number collapse to nearly the same
 * grey for a deuteranopic reader, and "is this a refund or a charge" is not a
 * detail they should have to infer. Every amount that reaches the screen is
 * accompanied by this word or by its sign, so the colour is reinforcement rather
 * than the message.
 */
export type Direction = 'income' | 'expense' | 'zero';

export function directionOf(amount: Minor): Direction {
  if (amount > 0) return 'income';
  if (amount < 0) return 'expense';
  return 'zero';
}
