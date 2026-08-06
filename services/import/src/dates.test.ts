import { describe, expect, it } from 'vitest';
import {
  ASSUMED_SUFFIX,
  DateParseError,
  detectDateFormat,
  parseDateTemplate,
  parseStatementDay,
  UNKNOWN_DATE_FORMAT,
} from './dates';

describe('detectDateFormat', () => {
  it('reads an unambiguous day-first column', () => {
    // 25 cannot be a month, so this column can only be day-first.
    expect(detectDateFormat(['25/03/2026', '01/01/2026'])).toBe('DD/MM/YYYY');
  });

  it('reads an unambiguous month-first column', () => {
    // 25 in the second slot cannot be a month either, which is what forces the
    // first slot to be the month here instead.
    expect(detectDateFormat(['03/25/2026', '01/01/2026'])).toBe('MM/DD/YYYY');
  });

  it('reads ISO year-first regardless of how the rest of the column looks', () => {
    expect(detectDateFormat(['2026-03-25', '2026-01-01'])).toBe('YYYY-MM-DD');
  });

  it('falls back to day-first, and says so, when the column never disambiguates', () => {
    // Every day here is <= 12, so nothing in the column can settle the order on
    // its own. The fallback is the app's default locale (day-first), and the
    // suffix is what lets the importer show the reader it was a guess.
    const format = detectDateFormat(['03/04/2026', '05/06/2026', '07/08/2026', '11/12/2026']);
    expect(format).toBe(`DD/MM/YYYY${ASSUMED_SUFFIX}`);
  });

  it('reports unknown when nothing in the column looks like a date', () => {
    expect(detectDateFormat(['not-a-date', 'also-not'])).toBe(UNKNOWN_DATE_FORMAT);
  });
});

describe('parseStatementDay', () => {
  it('applies a decided template to a real cell', () => {
    const template = parseDateTemplate('DD/MM/YYYY');
    expect(template).not.toBeNull();
    expect(parseStatementDay('05/01/2026', template!)).toBe('2026-01-05');
  });

  it('raises DateParseError on a month/day combination that does not exist, rather than rolling it over', () => {
    // 31 February is not a date. `Date`-based arithmetic would silently read
    // this as 3 March; this module must not, because a mis-dated transaction
    // moves silently into the wrong month's report.
    const template = parseDateTemplate('DD/MM/YYYY')!;
    expect(() => parseStatementDay('31/02/2026', template)).toThrow(DateParseError);

    // And it really did refuse, not roll over: no valid CalendarDay comes back
    // for this input under any template.
    let threw = false;
    try {
      parseStatementDay('31/02/2026', template);
    } catch (error) {
      threw = true;
      expect(error).toBeInstanceOf(DateParseError);
      expect((error as Error).message).not.toContain('2026-03-03');
    }
    expect(threw).toBe(true);
  });

  it('raises DateParseError on a cell that is not shaped like a date at all', () => {
    const template = parseDateTemplate('DD/MM/YYYY')!;
    expect(() => parseStatementDay('not-a-date', template)).toThrow(DateParseError);
  });

  it('raises DateParseError on an empty cell', () => {
    const template = parseDateTemplate('DD/MM/YYYY')!;
    expect(() => parseStatementDay('', template)).toThrow(DateParseError);
  });
});
