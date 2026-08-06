/**
 * Reading a `FormData` without lying to the type system.
 *
 * `FormData.get` returns `FormDataEntryValue | null`, which is `string | File |
 * null`. Casting that to `string` compiles and then hands `"[object File]"` to a
 * zod schema the first time a form grows a file input, so every read goes through
 * one of these instead. They are deliberately boring: the interesting validation
 * is the contract schema each action parses against, and anything clever here
 * would be a second, weaker copy of it.
 */

/** A trimmed string, or `undefined` when the field is absent or blank. */
export function optionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A trimmed string, or the empty string. For fields the schema requires. */
export function text(form: FormData, name: string): string {
  return optionalText(form, name) ?? '';
}

/**
 * An amount typed as major units, as integer minor units.
 *
 * The one place in the web app where a decimal becomes an integer, and it does
 * not divide or multiply by 100 in floating point: `4.10` parsed and scaled with
 * `Number(value) * 100` is `409.99999999999994`, which `minor()` then rejects.
 * The digits are moved by string surgery instead, which is exact for every input
 * a number field can produce.
 *
 * Returns `null` for anything that is not a plain decimal, so the caller reports
 * a field error rather than sending `NaN` over the wire.
 */
export function amountMinorFromMajor(raw: string, exponent = 2): number | null {
  const cleaned = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace(/^-/, '').split('.');
  if (fraction.length > exponent) return null;

  const digits = `${whole}${fraction.padEnd(exponent, '0')}`;
  const value = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(value)) return null;
  // `value === 0` is checked before the sign is applied, so `-0.00` produces 0
  // and not -0. Nothing downstream compares with `Object.is`, but -0 is the kind
  // of value that is equal to zero everywhere except in the one assertion that
  // eventually notices, and it costs one comparison to never have it.
  return negative && value !== 0 ? -value : value;
}

/** A checkbox. Present at all means checked; HTML omits an unchecked box entirely. */
export function checked(form: FormData, name: string): boolean {
  return form.get(name) !== null;
}
