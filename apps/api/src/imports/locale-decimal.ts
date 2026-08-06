/**
 * Which character a locale writes between the units and the cents.
 *
 * `@fin/import` takes `localeDecimal` as the tie-breaker for a statement whose
 * own numbers are ambiguous -- a file where every amount is `1.234` could be a
 * thousands separator or two decimal places, and nothing inside the file can
 * settle it. `DEFAULT_LOCALE` is the only evidence left, so the question is what
 * that locale writes, not what this machine's default locale writes.
 *
 * Asked of `Intl` rather than kept as a table. A table of locales to separators
 * is a list that is wrong the moment somebody sets `DEFAULT_LOCALE` to a locale
 * nobody thought of, and `Intl` already ships the answer for all of them. The
 * fallback exists for the one case `Intl` cannot answer: an unknown locale tag
 * resolves to the runtime default, and a runtime default of `en-US` would then
 * quietly decide a Spanish statement is written with a dot.
 */

/** What to assume when the locale tag is not one `Intl` knows. */
export const FALLBACK_DECIMAL = '.';

export function localeDecimalOf(locale: string): '.' | ',' {
  let parts: readonly Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale).formatToParts(1.1);
  } catch {
    // `Intl` throws a RangeError on a syntactically invalid tag ("es_ES" with an
    // underscore, an empty string). A malformed locale is a configuration bug
    // and `loadConfig` has already accepted it, so this cannot take the import
    // down; it falls back and lets the file's own evidence win where it can.
    return FALLBACK_DECIMAL;
  }

  const decimal = parts.find((part) => part.type === 'decimal')?.value;
  // Only the two separators the importer understands are accepted. A locale that
  // formats with something else (Arabic-Indic `٫`, for instance) would otherwise
  // return a character `parseAmount` has no branch for, and every amount in the
  // file would fail to parse with an error about the row rather than the setting.
  return decimal === ',' ? ',' : FALLBACK_DECIMAL;
}
