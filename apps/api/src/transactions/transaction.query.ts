/**
 * Turning `transactionQuerySchema` into a Prisma query, as pure functions.
 *
 * Two things in here are traps rather than code, and both have a gate test
 * pinning them.
 *
 * **`uncategorised` is `z.coerce.boolean()`, and `Boolean("false")` is `true`.**
 * Sending `uncategorised=false` therefore turns the filter *on*: the user unticks
 * "only uncategorised", the list gets shorter instead of longer, and nothing
 * reports an error. The web app is written to omit the parameter rather than send
 * `false` (`apps/web/lib/query.ts` exists for that one line), but a hand-typed URL
 * is not, so the only safe reading on this side is `=== true`. Anything else,
 * absent included, means no filter.
 *
 * **The pagination is keyset, never `OFFSET`.** New rows do not arrive at the end
 * of this list: an import of last year's statement inserts thousands of rows into
 * the middle of it. With `OFFSET 50`, every one of those shifts the tail down, so
 * page two re-serves rows the reader already saw and skips the ones that moved
 * past the boundary. Nothing errors; the reader just silently never sees some of
 * their own transactions, which in a finance app is the worst available failure.
 */
import { toUtcDate, day, type TransactionQuery } from '@fin/shared';
import type { Prisma } from '@fin/db';
import { encodeCursor, type TransactionCursor } from '../common/cursor';

/** The stable sort the cursor is a position in. */
export const TRANSACTION_ORDER: Prisma.TransactionOrderByWithRelationInput[] = [
  { bookedOn: 'desc' },
  { id: 'desc' },
];

/**
 * The filters, without the cursor.
 *
 * Kept separate because the page total is a `SUM` over the *whole* filtered set,
 * not over the page. A total that shrank as the reader paged would be a total of
 * nothing anybody asked for.
 */
export function transactionWhere(
  userId: string,
  query: TransactionQuery,
): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = { userId };

  if (query.from !== undefined || query.to !== undefined) {
    where.bookedOn = {
      ...(query.from === undefined ? {} : { gte: toUtcDate(day(query.from)) }),
      ...(query.to === undefined ? {} : { lte: toUtcDate(day(query.to)) }),
    };
  }

  if (query.accountId !== undefined) where.accountId = query.accountId;

  // The uncategorised queue wins over a category filter, because the two
  // contradict each other and one of them has to. It is the more specific
  // request: "show me what still needs filing" cannot also be "show me
  // Groceries".
  if (query.uncategorised === true) where.categoryId = null;
  else if (query.categoryId !== undefined) where.categoryId = query.categoryId;

  if (query.search !== undefined && query.search !== '') {
    // `mode: 'insensitive'` compiles to ILIKE '%term%', which the GIN trigram
    // index on `lower(description)` serves. Without that index this is the one
    // query whose cost grows linearly with the ledger.
    where.description = { contains: query.search, mode: 'insensitive' };
  }

  return where;
}

/**
 * "Strictly after this position" in `(booked_on DESC, id DESC)`.
 *
 * Written as an `OR` rather than as a row-value comparison because Prisma cannot
 * express `(a, b) < (x, y)`. The two are equivalent, and both are servable by the
 * `(user_id, booked_on)` index without walking the rows that were skipped, which
 * is the other half of why this is not `OFFSET`.
 */
export function keysetWhere(cursor: TransactionCursor): Prisma.TransactionWhereInput {
  const bookedOn = toUtcDate(cursor.bookedOn);
  return {
    OR: [{ bookedOn: { lt: bookedOn } }, { AND: [{ bookedOn }, { id: { lt: cursor.id } }] }],
  };
}

/** Combine the filters with the cursor, if there is one. */
export function pageWhere(
  base: Prisma.TransactionWhereInput,
  cursor: TransactionCursor | null,
): Prisma.TransactionWhereInput {
  return cursor === null ? base : { AND: [base, keysetWhere(cursor)] };
}

/**
 * Split an over-read into a page and the cursor for the next one.
 *
 * The query asks for `limit + 1` rows. The extra row is never returned; its
 * existence is the answer to "is there a next page", which is otherwise a second
 * `COUNT` over the same predicate for every page the reader looks at. `nextCursor`
 * is built from the **last returned** row, not from the extra one.
 */
export function splitPage<T extends { bookedOn: string; id: string }>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor:
      last === undefined ? null : encodeCursor({ bookedOn: day(last.bookedOn), id: last.id }),
  };
}
