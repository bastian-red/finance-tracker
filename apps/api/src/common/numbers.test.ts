import { MoneyError } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { countFromSum, minorFromSum } from './numbers';

/**
 * Pins the boundary where a Postgres aggregate stops being a `bigint`.
 *
 * `SUM(int4)` is `bigint` in Postgres, so Prisma's `$queryRaw` hands back a
 * JavaScript `BigInt` for every rollup this app runs, and `JSON.stringify(1n)`
 * **throws**. Not a wrong number: an unhandled `TypeError` in the serialiser,
 * surfacing as a 500 on a route that worked perfectly against an empty ledger
 * and started failing the moment the first row was inserted. It is the class of
 * bug that passes every test written before the data existed, which is why the
 * assertions below serialise rather than only compare.
 *
 * The second half is the ceiling. `minor()` re-applies the safe-integer check,
 * so a total past 2^53 is refused rather than silently rounded. Rounding
 * somebody's lifetime spending to the nearest neighbour of the right answer is
 * not a thing this app is allowed to do quietly.
 */

describe('minorFromSum', () => {
  it('converts a bigint aggregate to a number', () => {
    expect(minorFromSum(BigInt(1_234_567))).toBe(1_234_567);
    expect(minorFromSum(BigInt(-1_234_567))).toBe(-1_234_567);
    expect(minorFromSum(BigInt(0))).toBe(0);
    expect(typeof minorFromSum(BigInt(1))).toBe('number');
  });

  it('reads an empty aggregate as zero', () => {
    // `SUM` over no rows is NULL. A month with no transactions is a normal
    // month, not an error and not an absent number.
    expect(minorFromSum(null)).toBe(0);
    expect(minorFromSum(undefined)).toBe(0);
  });

  it('passes a plain number through, because aggregate() returns one', () => {
    // Prisma's `aggregate()` and `$queryRaw` disagree about the type of the same
    // SUM. Both have to work, or the caller has to know which one ran.
    expect(minorFromSum(-8_990)).toBe(-8_990);
  });

  it('refuses a fractional number, which means a float leaked into the ledger', () => {
    // `minor()` does this. It matters here because a `SUM` over a column that
    // somebody changed to `numeric` would arrive as a decimal and be stored
    // back as cents-and-a-bit.
    expect(() => minorFromSum(12.34)).toThrow(MoneyError);
  });

  it('accepts the largest exactly representable total on both signs', () => {
    // The boundary is inclusive. 2^53 - 1 is still exact, so refusing it would
    // be refusing a correct number.
    expect(minorFromSum(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(minorFromSum(BigInt(-Number.MAX_SAFE_INTEGER))).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('refuses the first total that is no longer exact, on both signs', () => {
    // One past the boundary. `Number(9007199254740992n)` returns a number, and
    // it is a number that no longer has a unique predecessor, so every sum built
    // on it is wrong by an amount nothing reports.
    const past = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    expect(() => minorFromSum(past)).toThrow(MoneyError);
    expect(() => minorFromSum(-past)).toThrow(MoneyError);
  });

  it('says which value was out of range, because the row is not in the message otherwise', () => {
    const past = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    expect(() => minorFromSum(past)).toThrow(/9007199254740992/);
    expect(() => minorFromSum(past)).toThrow(/exact integer range/);
  });

  it('produces a value the serialiser can send, where the input was not', () => {
    // The hazard in one assertion. The left-hand side is what the route returns
    // today; the right-hand side is what it returned before this conversion
    // existed.
    expect(JSON.stringify({ totalMinor: minorFromSum(BigInt(-12_345)) })).toBe(
      '{"totalMinor":-12345}',
    );
    expect(() => JSON.stringify({ totalMinor: BigInt(-12_345) })).toThrow(TypeError);
  });

  it('produces a value arithmetic can mix with a plain number', () => {
    // `1n + 1` is a TypeError too, so a bigint carried past this boundary fails
    // at the point of use rather than at the boundary, three files away from the
    // query that produced it.
    expect(minorFromSum(BigInt(100)) + 1).toBe(101);
    expect(() => (BigInt(100) as unknown as number) + 1).toThrow(TypeError);
  });
});

describe('countFromSum', () => {
  it('converts a COUNT, which is bigint as well', () => {
    expect(countFromSum(BigInt(747))).toBe(747);
    expect(typeof countFromSum(BigInt(0))).toBe('number');
  });

  it('reads an absent count as zero', () => {
    expect(countFromSum(null)).toBe(0);
    expect(countFromSum(undefined)).toBe(0);
  });

  it('passes a plain number through', () => {
    expect(countFromSum(12)).toBe(12);
  });

  it('carries no range check, unlike the money conversion', () => {
    // Deliberate asymmetry, pinned so it reads as a decision rather than an
    // oversight. A row count cannot reach 2^53 in a personal finance database,
    // and a count is not money: nobody adds it to a balance. An amount past the
    // exact range is a number that has silently stopped being right, which is
    // why that one throws and this one does not.
    const past = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
    expect(() => countFromSum(past)).not.toThrow();
    expect(() => minorFromSum(past)).toThrow(MoneyError);
  });
});
