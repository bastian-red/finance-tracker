import { minor, MoneyError, type Minor } from '@fin/shared';

/**
 * A `SUM()` read back out of Postgres, as an exact amount.
 *
 * `SUM(int4)` in Postgres is `bigint`, so Prisma's `$queryRaw` hands back a
 * JavaScript `BigInt` for every rollup this app runs. Two things go wrong if that
 * value is carried any further than this function:
 *
 *   1. `JSON.stringify(1n)` **throws** -- "Do not know how to serialize a
 *      BigInt". Not a wrong number, an unhandled `TypeError` in the serialiser,
 *      which surfaces as a 500 on a route that worked perfectly against an empty
 *      ledger and starts failing the moment the first row is inserted. It is the
 *      class of bug that passes every test written before the data existed.
 *   2. `1n + 1` is a `TypeError` too, so any arithmetic mixing the aggregate with
 *      a plain number fails at the point of use rather than at the boundary.
 *
 * So the conversion happens here, once, in the repository method that ran the
 * query, and nothing downstream ever sees a bigint. `minor()` re-applies the safe
 * integer check, which is also the ceiling test: a total past 2^53 stops being
 * exactly representable, and silently rounding somebody's lifetime spending is
 * not an acceptable answer.
 */
export function minorFromSum(value: bigint | number | null | undefined): Minor {
  if (value === null || value === undefined) return minor(0);
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw new MoneyError(`Aggregate ${value} is outside the exact integer range.`);
    }
    return minor(Number(value));
  }
  return minor(value);
}

/** A `COUNT()`, which is also `bigint`, as a plain number. */
export function countFromSum(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}
