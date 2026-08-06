/**
 * Reading a date out of a statement, which is the same problem as reading an
 * amount and has the same shape of answer.
 *
 * `03/04/2026` is the third of April or the fourth of March. Both readings are
 * valid, only one is what the bank meant, and picking wrong does not look wrong:
 * the row lands in the neighbouring month, the monthly report is quietly off by
 * one transaction, and nothing in the data says so. Worse than the amount case,
 * there is no per-value evidence at all -- `03/04/2026` on its own is genuinely
 * undecidable.
 *
 * So the decision is made **once, from the whole column**, exactly as
 * `detectAmountFormat` does it. A column containing `15/01/2026` anywhere can
 * only be day-first, because there is no fifteenth month; a column containing
 * `01/15/2026` can only be month-first. One unambiguous row settles every
 * ambiguous row above and below it, which is why the scan reads the column
 * rather than the first line.
 *
 * When the column stays ambiguous -- a January statement where every day is the
 * 1st to the 12th -- the fallback is day-first, and the format string says so out
 * loud. The app's default locale is `es-ES` and the rest of the world outside the
 * United States writes the day first, so day-first is the better bet; the reason
 * it is written into `format.dateFormat` rather than assumed silently is that the
 * user is the only one who can actually confirm it.
 */
import { makeDay, TimeError, type CalendarDay } from '@fin/shared';

/** `YYYY-MM-DD` and friends: a four-digit year leads and cannot be confused. */
const YEAR_FIRST = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
/** `03/04/2026`, `03.04.2026`, `03-04-26`: two small components then the year. */
const YEAR_LAST = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})$/;

/** The suffix appended when the column could not decide and day-first was assumed. */
export const ASSUMED_SUFFIX = ' (day-first assumed)';

/** Emitted when nothing in the column looks like a date at all. Every row then errors. */
export const UNKNOWN_DATE_FORMAT = 'unknown';

export interface DateTemplate {
  /** Component order, left to right. */
  order: readonly ['year' | 'month' | 'day', 'year' | 'month' | 'day', 'year' | 'month' | 'day'];
  separator: string;
}

/**
 * Decide the column's date format and describe it as a template string.
 *
 * The template is a string rather than a structure because it is what crosses the
 * wire (`detectedFormatSchema.dateFormat`), is shown to the reader, and is what
 * `buildPreview` is handed back on the second pass. One representation, whether
 * it was detected here or corrected in the UI.
 */
export function detectDateFormat(samples: readonly string[]): string {
  let yearFirst = 0;
  const yearFirstSeparators = new Map<string, number>();
  const yearLastSeparators = new Map<string, number>();
  let anyFirstOverTwelve = false;
  let anySecondOverTwelve = false;
  let yearLast = 0;

  for (const sample of samples) {
    const token = firstToken(sample);
    const leading = YEAR_FIRST.exec(token);
    if (leading) {
      yearFirst += 1;
      bump(yearFirstSeparators, leading[2] ?? '-');
      continue;
    }
    const trailing = YEAR_LAST.exec(token);
    if (!trailing) continue;

    yearLast += 1;
    bump(yearLastSeparators, trailing[2] ?? '/');
    if (Number(trailing[1]) > 12) anyFirstOverTwelve = true;
    if (Number(trailing[3]) > 12) anySecondOverTwelve = true;
  }

  if (yearFirst === 0 && yearLast === 0) return UNKNOWN_DATE_FORMAT;

  if (yearFirst >= yearLast) {
    return `YYYY${mostCommon(yearFirstSeparators, '-')}MM${mostCommon(yearFirstSeparators, '-')}DD`;
  }

  const separator = mostCommon(yearLastSeparators, '/');
  // Day-first evidence is checked first. A column holding both a first component
  // over 12 and a second component over 12 has no single correct reading, and
  // day-first at least keeps the majority of European exports right while the
  // impossible rows fall out as per-row errors the reader can see.
  if (anyFirstOverTwelve) return `DD${separator}MM${separator}YYYY`;
  if (anySecondOverTwelve) return `MM${separator}DD${separator}YYYY`;
  return `DD${separator}MM${separator}YYYY${ASSUMED_SUFFIX}`;
}

/**
 * Read a template string back into something the row parser can apply.
 *
 * Returns null for a template nobody can act on, which the caller turns into a
 * per-row error rather than a thrown one: a file whose date column is unreadable
 * still shows the reader its descriptions and amounts, which is usually enough to
 * work out what went wrong.
 */
export function parseDateTemplate(dateFormat: string): DateTemplate | null {
  const bare = dateFormat.split(' ')[0] ?? '';
  const match = /^(YYYY|MM|DD)([-/.])(YYYY|MM|DD)\2(YYYY|MM|DD)$/.exec(bare);
  if (!match) return null;

  const component = (token: string | undefined): 'year' | 'month' | 'day' | null =>
    token === 'YYYY' ? 'year' : token === 'MM' ? 'month' : token === 'DD' ? 'day' : null;

  const first = component(match[1]);
  const second = component(match[3]);
  const third = component(match[4]);
  if (first === null || second === null || third === null) return null;
  if (new Set([first, second, third]).size !== 3) return null;

  return { order: [first, second, third], separator: match[2] ?? '-' };
}

export class DateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateParseError';
  }
}

/**
 * Apply a template to one cell.
 *
 * The separator is enforced rather than sniffed per value. A column that is
 * mostly `03/04/2026` with one `2026-04-03` in it is a file with a broken row,
 * and reporting that row is more use than silently reading it with a second set
 * of rules -- the second set is where a swapped day and month hides.
 *
 * Two-digit years are accepted and mapped into the 2000s. A bank statement is
 * never dated 1926, and refusing `03/04/26` would reject a whole class of older
 * exports for no gain.
 */
export function parseStatementDay(raw: string, template: DateTemplate): CalendarDay {
  const token = firstToken(raw);
  if (token === '') throw new DateParseError('The date cell is empty.');

  const parts = token.split(template.separator);
  if (parts.length !== 3 || parts.some((part) => !/^\d{1,4}$/.test(part))) {
    throw new DateParseError(`"${raw}" is not a date in the detected format.`);
  }

  let year = 0;
  let month = 0;
  let dayNumber = 0;
  template.order.forEach((component, index) => {
    const value = Number(parts[index]);
    if (component === 'year') year = value < 100 ? 2000 + value : value;
    else if (component === 'month') month = value;
    else dayNumber = value;
  });

  // `makeDay` is what rejects 31 February rather than rolling it into March, and
  // it is the same validator the rest of the app uses, so an imported day and a
  // hand-entered day can never disagree about what is a real date. Its `TimeError`
  // is re-thrown as this module's own `DateParseError`: every way a cell can fail
  // to become a day -- empty, malformed, or a real month/day combination that
  // does not exist -- is one error type, so a caller that wants to catch "this
  // row's date is broken" does not also need to know about `@fin/shared`'s.
  try {
    return makeDay(year, month, dayNumber);
  } catch (error) {
    if (error instanceof TimeError) {
      throw new DateParseError(`"${raw}" is not a real date: ${error.message}`);
    }
    throw error;
  }
}

/** The date part of a cell that may carry a time: `2026-02-03 12:33:00`. */
function firstToken(value: string): string {
  const trimmed = value.trim();
  const cut = trimmed.search(/[\sT]/);
  return cut === -1 ? trimmed : trimmed.slice(0, cut);
}

function bump(tally: Map<string, number>, key: string): void {
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

function mostCommon(tally: ReadonlyMap<string, number>, fallback: string): string {
  let best = fallback;
  let bestCount = 0;
  for (const [key, count] of tally) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
