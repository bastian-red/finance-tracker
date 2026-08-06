/**
 * Calendar days, months, and the reason neither of them is a `Date`.
 *
 * A transaction happens on a **day**, not at an instant. "Coffee on 1 March" is
 * true in Madrid and in Santiago and on a CI runner in UTC; the moment it maps
 * to is not. The instant you store an instant, the month a row belongs to starts
 * depending on where the reader is standing, and a monthly report is exactly a
 * question about which month a row belongs to.
 *
 * So the ledger's unit of time is a `CalendarDay`: the string `YYYY-MM-DD`, with
 * no zone, no clock, and no arithmetic that can shift it. Postgres stores it as
 * `date`. Prisma hands it back as a `Date` pinned to UTC midnight, which is the
 * one dangerous moment in the round trip — `new Date('2026-03-01')` printed in
 * `America/Santiago` is 28 February — so every conversion in this file uses the
 * UTC accessors and nothing else. `getMonth()` and friends do not appear here,
 * and `day.test.ts` runs the whole suite under four zones spanning UTC-11 to
 * UTC+14 to prove it.
 *
 * Pure functions throughout: no clock, no environment. `today()` takes the
 * instant as an argument rather than reading it, because a report that quietly
 * depends on when it ran is a report that cannot be tested.
 */

declare const DAY_BRAND: unique symbol;
declare const MONTH_BRAND: unique symbol;

/** A calendar day, `YYYY-MM-DD`. No zone, no time. */
export type CalendarDay = string & { readonly [DAY_BRAND]: 'calendar-day' };

/** A calendar month, `YYYY-MM`. */
export type CalendarMonth = string & { readonly [MONTH_BRAND]: 'calendar-month' };

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/**
 * Days in a month, Gregorian.
 *
 * Written out rather than obtained from `new Date(y, m, 0).getDate()`, which is
 * the usual trick and is local-time dependent: the two-argument `Date`
 * constructor builds a local timestamp, so the answer can be off by one either
 * side of a DST boundary in zones with unusual rules.
 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new TimeError(`Month out of range: ${month}`);
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Parse and validate `YYYY-MM-DD`. Rejects 31 February rather than rolling it over. */
export function day(value: string): CalendarDay {
  const match = DAY_PATTERN.exec(value);
  if (!match) throw new TimeError(`Not a calendar day (expected YYYY-MM-DD): ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12) throw new TimeError(`Month out of range in ${value}`);
  if (date < 1 || date > daysInMonth(year, month)) {
    throw new TimeError(
      `Day out of range in ${value}: ${month}/${year} has ${daysInMonth(year, month)} days`,
    );
  }
  return value as CalendarDay;
}

/** Parse and validate `YYYY-MM`. */
export function month(value: string): CalendarMonth {
  const match = MONTH_PATTERN.exec(value);
  if (!match) throw new TimeError(`Not a calendar month (expected YYYY-MM): ${value}`);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new TimeError(`Month out of range in ${value}`);
  return value as CalendarMonth;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function makeDay(year: number, monthNumber: number, dayNumber: number): CalendarDay {
  return day(`${pad(year, 4)}-${pad(monthNumber, 2)}-${pad(dayNumber, 2)}`);
}

export function makeMonth(year: number, monthNumber: number): CalendarMonth {
  return month(`${pad(year, 4)}-${pad(monthNumber, 2)}`);
}

export function yearOf(value: CalendarDay | CalendarMonth): number {
  return Number(value.slice(0, 4));
}

export function monthNumberOf(value: CalendarDay | CalendarMonth): number {
  return Number(value.slice(5, 7));
}

export function dayNumberOf(value: CalendarDay): number {
  return Number(value.slice(8, 10));
}

/** The month a day falls in. Pure string work, so no zone can move it. */
export function monthOf(value: CalendarDay): CalendarMonth {
  return value.slice(0, 7) as CalendarMonth;
}

export function firstDayOfMonth(value: CalendarMonth): CalendarDay {
  return `${value}-01` as CalendarDay;
}

export function lastDayOfMonth(value: CalendarMonth): CalendarDay {
  const days = daysInMonth(yearOf(value), monthNumberOf(value));
  return `${value}-${pad(days, 2)}` as CalendarDay;
}

/** Move a month by a signed number of months. `addMonths('2026-01', -1)` is `'2025-12'`. */
export function addMonths(value: CalendarMonth, delta: number): CalendarMonth {
  if (!Number.isInteger(delta)) throw new TimeError(`Month delta must be an integer, got ${delta}`);
  const total = yearOf(value) * 12 + (monthNumberOf(value) - 1) + delta;
  return makeMonth(Math.floor(total / 12), (total % 12) + 1);
}

/** Every month from `from` to `to` inclusive, ascending. */
export function monthRange(from: CalendarMonth, to: CalendarMonth): CalendarMonth[] {
  if (from > to) throw new TimeError(`Month range runs backwards: ${from} to ${to}`);
  const out: CalendarMonth[] = [];
  for (let cursor = from; cursor <= to; cursor = addMonths(cursor, 1)) out.push(cursor);
  return out;
}

/**
 * The last `count` months ending at `end`, ascending.
 *
 * This is the shape every trend chart on the dashboard wants, and it is the
 * shape that makes an empty month visible. A chart built from "the months that
 * have rows" silently omits a month with no spending, which is the single most
 * interesting month on the page.
 */
export function trailingMonths(end: CalendarMonth, count: number): CalendarMonth[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new TimeError(`Trailing month count must be a positive integer, got ${count}`);
  }
  return monthRange(addMonths(end, -(count - 1)), end);
}

/** Move a day by a signed number of days, over the UTC epoch so no zone is involved. */
export function addDays(value: CalendarDay, delta: number): CalendarDay {
  if (!Number.isInteger(delta)) throw new TimeError(`Day delta must be an integer, got ${delta}`);
  const shifted = new Date(toUtcDate(value).getTime() + delta * 86_400_000);
  return fromUtcDate(shifted);
}

/** Whole days between two calendar days, `to - from`. */
export function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000);
}

/**
 * The `Date` Postgres round-trips a `date` column through: UTC midnight.
 *
 * Built with `Date.UTC` rather than by parsing the string. `new Date('2026-03-01')`
 * happens to be UTC midnight per spec, but `new Date('2026-3-1')` is local
 * midnight, and the difference between those two literals is one character.
 */
export function toUtcDate(value: CalendarDay): Date {
  return new Date(Date.UTC(yearOf(value), monthNumberOf(value) - 1, dayNumberOf(value)));
}

/**
 * Read a `Date` back as the calendar day it represents.
 *
 * UTC accessors, always. This is the exact line where a finance app in Santiago
 * starts filing March transactions under February.
 */
export function fromUtcDate(value: Date): CalendarDay {
  if (Number.isNaN(value.getTime())) throw new TimeError('Cannot read an Invalid Date as a day.');
  return makeDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

/**
 * Today, in a named zone, from an explicit instant.
 *
 * The zone is required rather than defaulted to the machine's, because "the
 * machine's zone" is the assumption that makes a report irreproducible. The
 * instant is an argument for the same reason.
 *
 * Uses `en-CA`, whose short date format is ISO `YYYY-MM-DD`. That is a real
 * property of the locale rather than a coincidence worth relying on blindly, so
 * the output is validated by `day()` before it is returned.
 */
export function today(now: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return day(`${get('year')}-${get('month')}-${get('day')}`);
}

export function currentMonth(now: Date, timeZone: string): CalendarMonth {
  return monthOf(today(now, timeZone));
}

/**
 * A month's label for display, e.g. `March 2026` or `marzo de 2026`.
 *
 * Formatted from UTC noon rather than UTC midnight. Midnight of the first is the
 * one instant that can render as the previous month in any zone west of UTC, and
 * `Intl` formats in the given zone; noon has twelve hours of slack either way,
 * which covers every real offset from -11 to +14.
 */
export function formatMonth(value: CalendarMonth, locale: string): string {
  const at = new Date(Date.UTC(yearOf(value), monthNumberOf(value) - 1, 1, 12));
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(at);
}

/** A day's label for display, in the given locale. Same UTC-noon reasoning. */
export function formatDay(value: CalendarDay, locale: string): string {
  const at = new Date(Date.UTC(yearOf(value), monthNumberOf(value) - 1, dayNumberOf(value), 12));
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}
