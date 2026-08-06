import { describe, expect, it } from 'vitest';
import { amountMinorFromMajor, checked, optionalText, text } from './form-fields';

/**
 * Reading a `FormData` without lying to the type system, and the one conversion
 * in the web app that turns a decimal into an integer.
 *
 * `amountMinorFromMajor` earns most of these cases on its own. `Number('4.10') *
 * 100` is `409.99999999999994`, which `minor()` rejects three layers later with
 * an error naming a value nobody typed. The digits are moved by string surgery
 * instead, and every case below is one way that surgery could go wrong.
 *
 * The `File` cases are not hypothetical: `FormData.get` is typed
 * `string | File | null`, casting it to `string` compiles, and the first form to
 * grow a file input then hands `"[object File]"` to a zod schema. The import
 * screen has one.
 */

function form(entries: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
}

describe('optionalText', () => {
  it('trims, because a trailing space is not a value', () => {
    expect(optionalText(form({ name: '  Groceries  ' }), 'name')).toBe('Groceries');
  });

  it('reads a blank field as absent, not as the empty string', () => {
    // The distinction is real: an empty amount bound means "no bound", and the
    // empty string would be parsed as an amount of zero.
    expect(optionalText(form({ name: '   ' }), 'name')).toBeUndefined();
    expect(optionalText(form({}), 'name')).toBeUndefined();
  });

  it('refuses a File rather than stringifying it', () => {
    const file = new File(['1;2;3'], 'statement.csv', { type: 'text/csv' });
    expect(optionalText(form({ file }), 'file')).toBeUndefined();
  });
});

describe('text', () => {
  it('is the empty string for an absent field, for schemas that require one', () => {
    expect(text(form({}), 'name')).toBe('');
    expect(text(form({ name: 'Rent' }), 'name')).toBe('Rent');
  });
});

describe('checked', () => {
  it('reads presence as checked, because HTML omits an unchecked box entirely', () => {
    expect(checked(form({ active: 'on' }), 'active')).toBe(true);
    expect(checked(form({}), 'active')).toBe(false);
  });

  it('reads the literal string "false" as checked, which is why nothing sends it', () => {
    // Stated as a test rather than as a comment because it is a trap the whole
    // app is arranged around: `transactionQuerySchema.uncategorised` is
    // `z.coerce.boolean()` and `Boolean("false")` is `true`. A form that helpfully
    // sent `false` would turn the filter on when the box was cleared.
    expect(checked(form({ active: 'false' }), 'active')).toBe(true);
  });
});

describe('amountMinorFromMajor', () => {
  it('moves the decimal point instead of multiplying', () => {
    // The case that motivates the whole function. Computed by running it, and
    // `4.10 * 100` is 409.99999999999994 in IEEE 754.
    expect(amountMinorFromMajor('4.10')).toBe(410);
    expect(4.1 * 100).not.toBe(410);
  });

  it('reads both decimal separators, because a Spanish keyboard types a comma', () => {
    expect(amountMinorFromMajor('1234,56')).toBe(123_456);
    expect(amountMinorFromMajor('1234.56')).toBe(123_456);
  });

  it('pads a short fraction rather than truncating it', () => {
    expect(amountMinorFromMajor('4.1')).toBe(410);
    expect(amountMinorFromMajor('4')).toBe(400);
  });

  it('keeps the sign, because an expense bound is negative', () => {
    // "Groceries over 50 euros" is a *maximum* of -5000, not a minimum of 5000.
    expect(amountMinorFromMajor('-50.00')).toBe(-5000);
    expect(amountMinorFromMajor('-0.01')).toBe(-1);
  });

  it('distinguishes -0.00 from 0.00 by not inventing a negative zero', () => {
    // `Object.is(-0, 0)` is false, and a -0 stored as an amount would compare
    // equal in most places and unequal in `Object.is` and `toBe`, which is the
    // worst kind of difference.
    expect(Object.is(amountMinorFromMajor('-0.00'), 0)).toBe(true);
  });

  it('rejects more precision than the currency has', () => {
    // Three decimals in a two-decimal currency is a typo, not a rounding
    // question. Returning null makes the form say so; rounding would silently
    // change what the user typed.
    expect(amountMinorFromMajor('1.234')).toBeNull();
    expect(amountMinorFromMajor('1.234', 3)).toBe(1234);
  });

  it('handles a zero-exponent currency', () => {
    // JPY has no minor unit at all: 500 yen is 500, not 50000.
    expect(amountMinorFromMajor('500', 0)).toBe(500);
    expect(amountMinorFromMajor('500.5', 0)).toBeNull();
  });

  it('rejects everything that is not a plain decimal', () => {
    for (const raw of ['', 'abc', '1e5', '1_000', '--5', '5-', '1.2.3', '+5', '$5', '.']) {
      expect(amountMinorFromMajor(raw), raw).toBeNull();
    }
  });

  it('strips whitespace, including the space a grouping separator leaves behind', () => {
    expect(amountMinorFromMajor(' 12.34 ')).toBe(1234);
    expect(amountMinorFromMajor('1 2 . 3 4')).toBe(1234);
  });

  it('refuses a value beyond the safe integer range instead of rounding it', () => {
    // Above 2^53 the arithmetic stops being exact, and an amount that is off by
    // one cent for reasons nobody can see is worse than a rejected form.
    expect(amountMinorFromMajor('99999999999999999.99')).toBeNull();
  });
});
