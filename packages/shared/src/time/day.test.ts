import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  currentMonth,
  day,
  daysBetween,
  daysInMonth,
  firstDayOfMonth,
  formatDay,
  formatMonth,
  fromUtcDate,
  lastDayOfMonth,
  makeDay,
  makeMonth,
  month,
  monthOf,
  monthRange,
  TimeError,
  today,
  toUtcDate,
  trailingMonths,
  type CalendarDay,
  type CalendarMonth,
} from './day';

/**
 * Four zones spanning the whole inhabited range: UTC-11, UTC-3 (the machine that
 * wrote this), UTC, and UTC+14. Every zone-sensitive assertion runs under all
 * four.
 *
 * This is the point of the module. A `date` column comes back from Postgres as
 * UTC midnight, and UTC midnight on the first of the month is *the previous
 * month* everywhere west of Greenwich. A single `getMonth()` instead of
 * `getUTCMonth()` anywhere in the reporting path files a third of March under
 * February for a user in Santiago, and the totals still add up, so nothing looks
 * broken.
 */
const ZONES = ['Pacific/Midway', 'America/Santiago', 'UTC', 'Pacific/Kiritimati'] as const;
const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('parsing', () => {
  it('accepts a well-formed day', () => {
    expect(day('2026-03-09')).toBe('2026-03-09');
  });

  it.each(['2026-3-9', '09-03-2026', '2026-03-09T00:00:00Z', '', 'yesterday'])(
    'rejects %s as a day',
    (value) => {
      expect(() => day(value)).toThrow(TimeError);
    },
  );

  it('rejects a day that does not exist instead of rolling it over', () => {
    // `new Date('2026-02-31')` is 3 March. Silently accepting that is how a
    // mistyped import date lands in the wrong month.
    expect(() => day('2026-02-31')).toThrow(/has 28 days/);
    expect(() => day('2026-04-31')).toThrow(/has 30 days/);
    expect(() => day('2026-01-00')).toThrow(TimeError);
  });

  it('knows February in leap and century years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(day('2024-02-29')).toBe('2024-02-29');
    expect(() => day('2100-02-29')).toThrow(TimeError);
  });

  it.each(['2026-13', '2026-00', '2026', '26-03'])('rejects %s as a month', (value) => {
    expect(() => month(value)).toThrow(TimeError);
  });

  it('builds from numbers with the zero padding the format needs', () => {
    // `makeDay` is how every generated day in the codebase is built (the seed,
    // the importer, the report windows). Unpadded, `2026-3-9` fails `day()`, so
    // the padding is load-bearing rather than cosmetic.
    expect(makeDay(2026, 3, 9)).toBe('2026-03-09');
    expect(makeDay(2026, 12, 31)).toBe('2026-12-31');
    expect(makeMonth(2026, 3)).toBe('2026-03');
    expect(makeMonth(2026, 12)).toBe('2026-12');
  });

  it('validates what it builds rather than trusting the caller', () => {
    // The whole point of routing through `day()` and `month()`. A caller doing
    // its own arithmetic can hand this a 13th month or a 31st of February, and
    // the alternative to throwing is a string that no other function can parse.
    expect(() => makeDay(2026, 2, 31)).toThrow(TimeError);
    expect(() => makeDay(2026, 13, 1)).toThrow(TimeError);
    expect(() => makeDay(2026, 0, 1)).toThrow(TimeError);
    expect(() => makeMonth(2026, 13)).toThrow(TimeError);
  });
});

describe('month arithmetic', () => {
  it('crosses the year boundary in both directions', () => {
    expect(addMonths(makeMonth(2026, 1), -1)).toBe('2025-12');
    expect(addMonths(makeMonth(2025, 12), 1)).toBe('2026-01');
    expect(addMonths(makeMonth(2026, 6), 0)).toBe('2026-06');
  });

  it('handles deltas larger than a year, including negative ones', () => {
    expect(addMonths(makeMonth(2026, 3), 25)).toBe('2028-04');
    expect(addMonths(makeMonth(2026, 3), -25)).toBe('2024-02');
    // The one that breaks a naive `total % 12`: a negative remainder.
    expect(addMonths(makeMonth(2026, 1), -13)).toBe('2024-12');
  });

  it('builds an inclusive ascending range', () => {
    expect(monthRange(makeMonth(2025, 11), makeMonth(2026, 2))).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthRange(makeMonth(2026, 2), makeMonth(2026, 2))).toEqual(['2026-02']);
    expect(() => monthRange(makeMonth(2026, 3), makeMonth(2026, 2))).toThrow(/backwards/);
  });

  it('gives a trend chart every month, including the empty ones', () => {
    // The whole reason this returns a dense range: a month with no spending is
    // the most interesting bar on the chart, and it only exists if the axis is
    // built from the calendar rather than from the rows.
    expect(trailingMonths(makeMonth(2026, 2), 6)).toEqual([
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(trailingMonths(makeMonth(2026, 2), 1)).toEqual(['2026-02']);
    expect(() => trailingMonths(makeMonth(2026, 2), 0)).toThrow(TimeError);
  });

  it('finds the ends of a month, February included', () => {
    expect(firstDayOfMonth(makeMonth(2026, 2))).toBe('2026-02-01');
    expect(lastDayOfMonth(makeMonth(2026, 2))).toBe('2026-02-28');
    expect(lastDayOfMonth(makeMonth(2024, 2))).toBe('2024-02-29');
    expect(lastDayOfMonth(makeMonth(2026, 12))).toBe('2026-12-31');
  });
});

describe('day arithmetic', () => {
  it('crosses months and years', () => {
    expect(addDays(day('2026-02-28'), 1)).toBe('2026-03-01');
    expect(addDays(day('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(day('2026-01-01'), -1)).toBe('2025-12-31');
    expect(addDays(day('2026-03-09'), 0)).toBe('2026-03-09');
  });

  it('counts the gap the importer uses to spot a duplicate', () => {
    expect(daysBetween(day('2026-03-01'), day('2026-03-04'))).toBe(3);
    expect(daysBetween(day('2026-03-04'), day('2026-03-01'))).toBe(-3);
    expect(daysBetween(day('2026-02-27'), day('2026-03-02'))).toBe(3);
  });

  it.each(ZONES)('adds days without drifting in %s', (zone) => {
    process.env.TZ = zone;
    // A DST boundary in a zone that has one. Adding 86_400_000 ms across a
    // spring-forward is 23 hours of local time, so any implementation that
    // reads the result with a local accessor lands on the wrong day.
    expect(addDays(day('2026-03-28'), 1)).toBe('2026-03-29');
    expect(addDays(day('2026-10-24'), 1)).toBe('2026-10-25');
    expect(daysBetween(day('2026-03-28'), day('2026-03-29'))).toBe(1);
  });
});

describe('the Postgres date round trip', () => {
  it.each(ZONES)('survives in %s', (zone) => {
    process.env.TZ = zone;
    for (const value of ['2026-01-01', '2026-03-01', '2026-06-15', '2026-12-31'] as CalendarDay[]) {
      expect(fromUtcDate(toUtcDate(value))).toBe(value);
      expect(monthOf(fromUtcDate(toUtcDate(value)))).toBe(value.slice(0, 7));
    }
  });

  it.each(ZONES)('files the first of the month under that month in %s', (zone) => {
    process.env.TZ = zone;
    // The specific failure: UTC midnight on 1 March is 28 February local in
    // every zone west of UTC, and 1 March 14:00 in Kiritimati.
    const fromDatabase = new Date(Date.UTC(2026, 2, 1));
    expect(monthOf(fromUtcDate(fromDatabase))).toBe('2026-03');
  });

  it('refuses an Invalid Date rather than producing NaN-NaN-NaN', () => {
    expect(() => fromUtcDate(new Date('not a date'))).toThrow(TimeError);
  });

  it('reads the month from the string, so no zone is ever consulted', () => {
    process.env.TZ = 'Pacific/Midway';
    expect(monthOf(day('2026-03-01'))).toBe('2026-03');
    process.env.TZ = 'Pacific/Kiritimati';
    expect(monthOf(day('2026-03-01'))).toBe('2026-03');
  });
});

describe('today in an explicit zone', () => {
  it('reads the same instant as two different days either side of the date line', () => {
    // 2026-03-01T10:00Z: still 28 February in Midway (UTC-11), already 2 March
    // in Kiritimati (UTC+14). Both are correct; that is exactly why the zone is
    // a required argument rather than a default.
    const instant = new Date('2026-03-01T10:00:00Z');
    expect(today(instant, 'Pacific/Midway')).toBe('2026-02-28');
    expect(today(instant, 'UTC')).toBe('2026-03-01');
    expect(today(instant, 'Pacific/Kiritimati')).toBe('2026-03-02');
    expect(currentMonth(instant, 'Pacific/Midway')).toBe('2026-02');
    expect(currentMonth(instant, 'Pacific/Kiritimati')).toBe('2026-03');
  });

  it.each(ZONES)('ignores the machine zone when the process runs in %s', (zone) => {
    process.env.TZ = zone;
    const instant = new Date('2026-06-15T12:00:00Z');
    expect(today(instant, 'Europe/Madrid')).toBe('2026-06-15');
  });
});

describe('display', () => {
  /**
   * Every expected string below was produced by running the formatter and
   * pasting the output, never typed from memory. `es-ES` renders March as
   * `marzo de 2026`, with the `de`; a hand-written `marzo 2026` would fail
   * against a page that is completely correct.
   */
  it('labels a month in the reader locale', () => {
    expect(formatMonth(makeMonth(2026, 3), 'en-GB')).toBe('March 2026');
    expect(formatMonth(makeMonth(2026, 3), 'es-ES')).toBe('marzo de 2026');
  });

  it('labels a day in the reader locale', () => {
    expect(formatDay(day('2026-03-09'), 'en-GB')).toBe('9 Mar 2026');
    expect(formatDay(day('2026-03-09'), 'es-ES')).toBe('9 mar 2026');
  });

  it.each(ZONES)('labels the first of the month as that month in %s', (zone) => {
    process.env.TZ = zone;
    // Formatting from UTC midnight would render `February 2026` here for every
    // zone west of UTC. The module formats from UTC noon for exactly this.
    expect(formatMonth(makeMonth(2026, 3), 'en-GB')).toBe('March 2026');
    expect(formatDay(day('2026-03-01'), 'en-GB')).toBe('1 Mar 2026');
  });
});

describe('branding', () => {
  it('keeps a month and a day from being interchanged', () => {
    // Compile-time, so the runtime assertion here is only that the constructors
    // agree with each other. The value of the brand is that
    // `firstDayOfMonth(someDay)` does not typecheck.
    const value: CalendarMonth = makeMonth(2026, 3);
    const start: CalendarDay = firstDayOfMonth(value);
    expect(monthOf(start)).toBe(value);
  });
});
