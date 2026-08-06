/**
 * The duplicate-detection fingerprint.
 *
 * Server-only because it needs `node:crypto`, and because nothing in the browser
 * has any business computing one: a fingerprint that a client could produce is a
 * fingerprint a client could forge into somebody else's account id.
 *
 * Account, day, amount, normalised description — the four things that are equal
 * when a person re-imports a statement they already imported, and unequal
 * otherwise. Deliberately **not** a unique constraint in the database: people do
 * buy the same coffee twice on the same day, and a schema that refuses the second
 * one silently loses real money from the ledger. It exists so the importer can
 * raise a "possible duplicate, review this" row that a human resolves.
 *
 * The true idempotency key is `(account_id, external_id)`, which is unique, and
 * which only exists when the bank gave the row an id. This is the fallback for
 * the many exports that do not.
 */
import { createHash } from 'node:crypto';
import { normaliseDescription } from '../text/normalise';
import type { CalendarDay } from '../time/day';

/**
 * SHA-256 over a space-joined tuple.
 *
 * Space-joined rather than concatenated because concatenation is ambiguous:
 * `('ab', '1')` and `('a', 'b1')` hash to the same thing, and an account id
 * adjacent to a date is exactly where that bites. The separator cannot appear
 * inside a field — ids are cuids, the day is `YYYY-MM-DD`, the amount is digits,
 * and the description has already been through `normaliseDescription`, which
 * collapses runs of whitespace and trims. Single spaces do survive normalisation
 * inside the description, but that is the last field, so nothing follows it to be
 * confused with.
 *
 * SHA-256 rather than a cheaper hash because collisions here are silent: two
 * different transactions colliding means one is flagged as a duplicate of the
 * other and a real row gets dropped by someone clicking "skip".
 */
export function fingerprintOf(
  accountId: string,
  bookedOn: CalendarDay,
  amountMinor: number,
  description: string,
): string {
  return createHash('sha256')
    .update([accountId, bookedOn, String(amountMinor), normaliseDescription(description)].join(' '))
    .digest('hex');
}
