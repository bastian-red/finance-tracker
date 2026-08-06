import { day, type CalendarDay } from '@fin/shared';
import { BadRequestException } from '@nestjs/common';

/** The position of the last row of a page, in the list's own sort order. */
export interface TransactionCursor {
  bookedOn: CalendarDay;
  id: string;
}

/**
 * Keyset pagination, never `OFFSET`.
 *
 * The ledger is ordered `(booked_on DESC, id DESC)` and new rows do not arrive at
 * the end of it: an import of last year's statement inserts thousands of rows
 * into the middle. With `OFFSET 50`, every one of those inserts shifts the whole
 * tail down, so page 2 re-serves rows the reader already saw and skips the ones
 * that moved past the boundary. Nothing errors. The reader just silently never
 * sees some of their own transactions, which in a finance app is the worst
 * available failure mode.
 *
 * A keyset cursor names the last row instead of counting rows, so the next page
 * is "everything strictly after this position" regardless of what was inserted in
 * between. It is also the only form the `(user_id, booked_on)` index can serve
 * without walking the skipped rows.
 *
 * `booked_on` alone is not a key: a day holds dozens of transactions, and a
 * cursor at the day boundary would drop the rest of that day or repeat it. The id
 * is the tiebreak, and it is why the sort carries `id DESC` too.
 */
export function encodeCursor(cursor: TransactionCursor): string {
  return Buffer.from(`${cursor.bookedOn}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * base64url rather than base64: the value travels in a query string, and `+` and
 * `/` are not safe there. A cursor that survives one hop and breaks on the next
 * is worse than one that never worked.
 */
export function decodeCursor(value: string): TransactionCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('Malformed page cursor');
  }

  const separator = decoded.indexOf('|');
  if (separator < 0) throw new BadRequestException('Malformed page cursor');

  const bookedOn = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (id.length === 0) throw new BadRequestException('Malformed page cursor');

  try {
    // `day()` rather than a regex: the cursor is client-supplied and goes
    // straight into a `WHERE booked_on <= $1` comparison, so 2026-02-31 must be
    // refused here rather than turned into a Date that rolls over into March.
    return { bookedOn: day(bookedOn), id };
  } catch {
    throw new BadRequestException('Malformed page cursor');
  }
}
