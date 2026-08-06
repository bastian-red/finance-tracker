import { day, transactionQuerySchema } from '@fin/shared';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor';
import { countFromSum, minorFromSum } from './numbers';

describe('cursor', () => {
  it('round-trips a position', () => {
    const cursor = { bookedOn: day('2026-03-14'), id: 'ckz9tq0000000abcd' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips two rows booked on the same day', () => {
    // The whole reason the id is in the cursor. A day holds dozens of rows, and a
    // cursor that carried only the day would either drop the rest of that day or
    // repeat it on the next page.
    const first = { bookedOn: day('2026-03-14'), id: 'row_aaa' };
    const second = { bookedOn: day('2026-03-14'), id: 'row_bbb' };

    expect(encodeCursor(first)).not.toBe(encodeCursor(second));
    expect(decodeCursor(encodeCursor(first))).toEqual(first);
    expect(decodeCursor(encodeCursor(second))).toEqual(second);
  });

  it('is base64url, so it survives a query string unescaped', () => {
    const encoded = encodeCursor({ bookedOn: day('2026-12-31'), id: 'a'.repeat(40) });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it('keeps an id containing the separator intact', () => {
    // Split on the first `|` rather than on every one, so an id that happens to
    // contain the separator comes back whole rather than truncated.
    const cursor = { bookedOn: day('2026-01-02'), id: 'weird|id|value' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a cursor with no separator', () => {
    const encoded = Buffer.from('2026-03-14', 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(BadRequestException);
  });

  it('rejects a cursor with an empty id', () => {
    const encoded = Buffer.from('2026-03-14|', 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(BadRequestException);
  });

  it('rejects a day that does not exist rather than letting it roll over', () => {
    const encoded = Buffer.from('2026-02-31|row_1', 'utf8').toString('base64url');
    expect(() => decodeCursor(encoded)).toThrow(BadRequestException);
  });

  it('rejects arbitrary junk with a 400, not a 500', () => {
    expect(() => decodeCursor('!!!not base64!!!')).toThrow(BadRequestException);
    expect(() => decodeCursor('')).toThrow(BadRequestException);
  });
});

describe('minorFromSum', () => {
  it('converts a Postgres bigint aggregate to an exact amount', () => {
    // Prisma hands back `bigint` for SUM(int4). `JSON.stringify` throws on one,
    // so the conversion has to happen at the query boundary or the route 500s as
    // soon as the ledger has rows.
    expect(minorFromSum(BigInt(-1_234_567))).toBe(-1_234_567);
    expect(minorFromSum(BigInt(0))).toBe(0);
  });

  it('treats an empty aggregate as zero', () => {
    // `SUM` over no rows is NULL, and a month with no transactions is a normal
    // month, not an error.
    expect(minorFromSum(null)).toBe(0);
    expect(minorFromSum(undefined)).toBe(0);
  });

  it('passes a plain number through, because Prisma aggregate() returns one', () => {
    expect(minorFromSum(4200)).toBe(4200);
  });

  it('refuses a total that has left the exactly-representable range', () => {
    expect(() => minorFromSum(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))).toThrow();
  });

  it('produces something JSON.stringify can actually serialise', () => {
    expect(JSON.stringify({ totalMinor: minorFromSum(BigInt(99)) })).toBe('{"totalMinor":99}');
    expect(() => JSON.stringify({ totalMinor: BigInt(99) })).toThrow(TypeError);
  });
});

describe('countFromSum', () => {
  it('converts a COUNT, which is bigint too', () => {
    expect(countFromSum(BigInt(747))).toBe(747);
    expect(countFromSum(null)).toBe(0);
  });
});

describe('the transactionQuerySchema uncategorised trap', () => {
  it('reads uncategorised=false as true, because Boolean("false") is true', () => {
    // This is `z.coerce.boolean()` doing exactly what it is specified to do, and
    // the contract is frozen: another package parses responses against it, so it
    // cannot be changed here. Pinned as a test rather than left in somebody's
    // memory, because the symptom -- an "all transactions" filter that silently
    // returns only the uncategorised ones -- looks like a backend bug.
    //
    // The API therefore treats the parsed value as "the filter is present" and
    // the web app must OMIT the parameter rather than send `false`.
    expect(transactionQuerySchema.parse({ uncategorised: 'false' }).uncategorised).toBe(true);
    expect(transactionQuerySchema.parse({ uncategorised: '0' }).uncategorised).toBe(true);
    expect(transactionQuerySchema.parse({ uncategorised: 'true' }).uncategorised).toBe(true);
    expect(transactionQuerySchema.parse({ uncategorised: '' }).uncategorised).toBe(false);
  });

  it('leaves uncategorised undefined when the parameter is omitted', () => {
    // The only spelling of "do not filter" that works.
    expect(transactionQuerySchema.parse({}).uncategorised).toBeUndefined();
  });
});
