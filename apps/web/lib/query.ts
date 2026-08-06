import type { TransactionQuery } from '@fin/shared';

/**
 * Building the query string for `GET /transactions`.
 *
 * The whole file exists for one line, and it is the line marked below.
 *
 * `transactionQuerySchema.uncategorised` is `z.coerce.boolean()`. Zod's coercion
 * is `Boolean(value)`, and every non-empty string is truthy, so `Boolean("false")`
 * is `true`. Sending `uncategorised=false` therefore turns the filter **on**: the
 * user unticks "only uncategorised", the list gets shorter instead of longer, and
 * nothing anywhere reports an error. The only correct encoding of "off" is to not
 * send the parameter at all.
 *
 * That is not a quirk of this one field. It is true of every `z.coerce.boolean()`
 * in the contract, which is why the omission is handled by a shared helper rather
 * than at each call site, and why `query.test.ts` pins it directly.
 */

/** A value that can be sent. `undefined`, `null` and `''` all mean "not set". */
type QueryValue = string | number | boolean | undefined | null;

/**
 * Encode parameters, dropping anything unset.
 *
 * Booleans are only ever emitted when true, for the reason above. An empty string
 * is dropped rather than sent, because `search=` would otherwise reach a
 * `z.string().max(120)` as a valid empty search and force the API to special-case
 * it.
 */
export function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    // The line. A false boolean is an omission, never a `false` on the wire.
    if (typeof value === 'boolean') {
      if (value) search.set(key, 'true');
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/** The filters the transactions page can express. Mirrors `transactionQuerySchema`. */
export type TransactionFilters = Partial<Pick<TransactionQuery, 'from' | 'to' | 'limit'>> & {
  accountId?: string;
  categoryId?: string;
  uncategorised?: boolean;
  search?: string;
  cursor?: string;
};

export function transactionQueryString(filters: TransactionFilters): string {
  return toQueryString({
    from: filters.from,
    to: filters.to,
    accountId: filters.accountId,
    categoryId: filters.categoryId,
    uncategorised: filters.uncategorised,
    search: filters.search,
    cursor: filters.cursor,
    limit: filters.limit,
  });
}

/**
 * Read the filters back out of a Next `searchParams` object.
 *
 * In Next 14 `searchParams` is a plain object, not a promise, so this is
 * synchronous. A repeated parameter arrives as an array; the first value wins,
 * because a hand-edited URL with `?categoryId=a&categoryId=b` has no meaningful
 * second answer and silently dropping the filter would be worse than picking one.
 *
 * `uncategorised` is read as "the parameter is present and is not the string
 * false", which is the mirror of the encoding above: the page's own links never
 * emit `uncategorised=false`, but a user can type one.
 */
export function readTransactionFilters(
  searchParams: Record<string, string | string[] | undefined>,
): TransactionFilters {
  const one = (key: string): string | undefined => {
    const value = searchParams[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined || first === '' ? undefined : first;
  };

  const uncategorised = one('uncategorised');
  const limit = one('limit');
  const parsedLimit = limit === undefined ? undefined : Number.parseInt(limit, 10);

  return {
    from: one('from'),
    to: one('to'),
    accountId: one('accountId'),
    categoryId: one('categoryId'),
    uncategorised: uncategorised === undefined ? undefined : uncategorised !== 'false',
    search: one('search'),
    cursor: one('cursor'),
    limit:
      parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 200)
        : undefined,
  };
}
