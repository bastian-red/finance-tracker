import type { DetectedFormat, ImportRowStatus } from '@fin/shared';

/**
 * The vocabulary the import screen needs, and the one trap it has to dodge.
 *
 * `@fin/import` already owns every one of these lists -- `DELIMITERS`,
 * `EncodingName`, the date templates `parseDateTemplate` accepts. The web app
 * cannot import that package: it reads `Buffer`, it pulls in `safe-regex2`
 * through `@fin/categorize`, and it is not a dependency of `@fin/web` for exactly
 * that reason. So the *choices* are restated here, deliberately, and the contract
 * (`detectedFormatSchema`) is what keeps the two honest: send a delimiter that is
 * not one character, or an order this list invented, and the API answers 400 with
 * the field named.
 *
 * **The trap: a delimiter is not safe to round-trip as a form value.** Tab is one
 * of the four separators a bank export uses, `lib/form-fields.ts` trims every
 * string it reads out of a `FormData`, and `"\t".trim()` is `""`. A tab-delimited
 * file corrected through a select whose option value was the character itself
 * would be re-read with an empty delimiter, which fails the contract's
 * `length(1)` and reports as a validation error on a field the user never
 * touched. So the select carries a *name* and the name is mapped to the character
 * here, where it cannot be trimmed away.
 */

export interface DelimiterChoice {
  /** What the `<option value>` carries. Never the character itself. See above. */
  name: string;
  char: string;
  label: string;
}

/** In the same order as `DELIMITERS` in `@fin/import`, which is tiebreak order. */
export const DELIMITER_CHOICES: readonly DelimiterChoice[] = [
  { name: 'semicolon', char: ';', label: 'Semicolon  ;' },
  { name: 'comma', char: ',', label: 'Comma  ,' },
  { name: 'tab', char: 'tab', label: 'Tab' },
  { name: 'pipe', char: '|', label: 'Pipe  |' },
];

/** The character a delimiter name stands for, or null when the name is not one. */
export function delimiterCharOf(name: string): string | null {
  if (name === 'tab') return '\t';
  return DELIMITER_CHOICES.find((choice) => choice.name === name)?.char ?? null;
}

/** The name to preselect for a delimiter the detector reported. */
export function delimiterNameOf(char: string): string {
  if (char === '\t') return 'tab';
  return DELIMITER_CHOICES.find((choice) => choice.char === char)?.name ?? 'comma';
}

/** Mirrors `EncodingName` in `@fin/import`. `latin1` is that module's fallback. */
export const ENCODING_CHOICES: readonly { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'latin1', label: 'Latin-1 / Windows-1252' },
  { value: 'utf-16le', label: 'UTF-16, little endian' },
  { value: 'utf-16be', label: 'UTF-16, big endian' },
];

/**
 * Every template `parseDateTemplate` can read, with an example beside it.
 *
 * The example is the point. "DD/MM/YYYY" is jargon and the reader is holding a
 * statement, not a format string; `31/12/2026` next to it is the same fact in a
 * form they can check against the file in front of them. The examples are literal
 * strings and never go through `Intl` -- they describe the *file's* notation, not
 * the reader's locale, and formatting them would make the label disagree with the
 * data the moment somebody's browser is set to `en-US`.
 */
export const DATE_FORMAT_CHOICES: readonly { value: string; label: string }[] = [
  { value: 'DD/MM/YYYY', label: 'Day first, slashes  31/12/2026' },
  { value: 'MM/DD/YYYY', label: 'Month first, slashes  12/31/2026' },
  { value: 'YYYY/MM/DD', label: 'Year first, slashes  2026/12/31' },
  { value: 'DD-MM-YYYY', label: 'Day first, dashes  31-12-2026' },
  { value: 'MM-DD-YYYY', label: 'Month first, dashes  12-31-2026' },
  { value: 'YYYY-MM-DD', label: 'Year first, dashes  2026-12-31' },
  { value: 'DD.MM.YYYY', label: 'Day first, dots  31.12.2026' },
  { value: 'MM.DD.YYYY', label: 'Month first, dots  12.31.2026' },
  { value: 'YYYY.MM.DD', label: 'Year first, dots  2026.12.31' },
];

/**
 * The template without the detector's commentary.
 *
 * `detectDateFormat` answers `DD/MM/YYYY (day-first assumed)` when the column
 * carried no evidence either way, and `parseDateTemplate` reads only the first
 * word. The select has to preselect the bare form or it matches no option and
 * silently shows the first one instead, which would offer to "correct" a
 * day-first file to day-first while displaying month-first.
 */
export function bareDateFormat(dateFormat: string): string {
  return dateFormat.split(' ')[0] ?? '';
}

/**
 * What the detector could not settle, in sentences.
 *
 * Both cases are files that contain no evidence rather than files that were read
 * wrongly: a statement whose amounts are all whole euros says nothing about its
 * own decimal separator, and one whose days are all below the 13th says nothing
 * about day-first versus month-first. Neither shows up as an error, and both put
 * every row in the wrong place if the guess was wrong, which is why they are
 * surfaced as a question rather than logged.
 */
export function formatAmbiguities(format: DetectedFormat): string[] {
  const notes: string[] = [];
  if (format.decimalAmbiguous) {
    notes.push(
      'Nothing in this file settles which character is the decimal point, so the app fell back ' +
        `to "${format.decimal}". Check one amount against your statement.`,
    );
  }
  if (format.dateFormat !== bareDateFormat(format.dateFormat)) {
    notes.push(
      'Every date in this file could be read either way round, so day-first was assumed. ' +
        'If this export is American, switch it to month first.',
    );
  }
  if (format.dateFormat === 'unknown') {
    notes.push('No column in this file looks like dates. Pick the date column and its format.');
  }
  return notes;
}

/**
 * The glyph, the word and the colour for a preview row's status, in that order.
 *
 * Same contract as `budgetStateLabel` and `directionLabel` in `lib/format.ts`:
 * the word is the signal, the glyph survives greyscale, and the colour only
 * agrees with them. A preview is the one screen in this app where a reader scans
 * a hundred rows looking for the handful that are not fine, and doing that by hue
 * alone is exactly the task a colour vision deficiency makes impossible.
 */
export function importRowLabel(status: ImportRowStatus): {
  glyph: string;
  word: string;
  className: string;
} {
  if (status === 'duplicate') {
    return { glyph: '▲', word: 'Duplicate', className: 'state-approaching' };
  }
  if (status === 'error') return { glyph: '✕', word: 'Error', className: 'state-exceeded' };
  return { glyph: '+', word: 'New', className: 'state-income' };
}
