import { day, transactionQuerySchema, type TransactionQuery } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { decodeCursor } from '../common/cursor';
import {
  keysetWhere,
  pageWhere,
  splitPage,
  TRANSACTION_ORDER,
  transactionWhere,
} from './transaction.query';

/**
 * Pins what the ledger list actually asks Postgres for.
 *
 * Two things here are traps rather than code.
 *
 * `uncategorised` is `z.coerce.boolean()` and `Boolean("false")` is `true`, so a
 * hand-typed `?uncategorised=false` arrives as `true`. The contract is frozen --
 * another package parses responses against it -- so the only safe reading on
 * this side is `=== true`, and the tests below go through the real schema rather
 * than hand-building the query object, because a literal `{ uncategorised: false }`
 * would test a value the HTTP layer can never produce.
 *
 * The pagination is keyset. New rows do not arrive at the end of this list: an
 * import of last year's statement inserts thousands into the middle of it, and
 * with `OFFSET` every one of those shifts the tail down, so page two re-serves
 * rows the reader already saw and skips the ones that moved past the boundary.
 * Nothing errors; the reader silently never sees some of their own transactions.
 */

const USER = 'usr_1';

/** Parse a query string the way the controller's pipe does. */
const query = (raw: Record<string, string>): TransactionQuery => transactionQuerySchema.parse(raw);

describe('transactionWhere', () => {
  it('scopes to the user and nothing else when no filter is given', () => {
    // The `userId` clause is not a filter, it is the tenancy boundary. Every
    // other clause is optional; this one is unconditional.
    expect(transactionWhere(USER, query({}))).toEqual({ userId: USER });
  });

  it('reads a date range as UTC midnight on both ends', () => {
    // `date` columns round-trip through UTC midnight. Building the bound from a
    // local `Date` is the line where a finance app in Santiago files a March
    // transaction under February.
    const where = transactionWhere(USER, query({ from: '2026-03-01', to: '2026-03-31' }));
    const bookedOn = where.bookedOn as { gte: Date; lte: Date };

    expect(bookedOn.gte.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(bookedOn.lte.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('accepts an open-ended range at either end', () => {
    expect(transactionWhere(USER, query({ from: '2026-03-01' })).bookedOn).toEqual({
      gte: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(transactionWhere(USER, query({ to: '2026-03-31' })).bookedOn).toEqual({
      lte: new Date('2026-03-31T00:00:00.000Z'),
    });
  });

  it('leaves bookedOn off entirely when neither end is given', () => {
    // An empty `{}` predicate is not free: it is a clause Prisma has to render.
    expect('bookedOn' in transactionWhere(USER, query({}))).toBe(false);
  });

  it('filters by account when one is named', () => {
    expect(transactionWhere(USER, query({ accountId: 'acc_1' })).accountId).toBe('acc_1');
  });

  it('filters by category when one is named', () => {
    expect(transactionWhere(USER, query({ categoryId: 'cat_1' })).categoryId).toBe('cat_1');
  });

  it('reads uncategorised=true as "categoryId is null"', () => {
    expect(transactionWhere(USER, query({ uncategorised: 'true' })).categoryId).toBeNull();
  });

  it('lets the uncategorised queue win over a category filter', () => {
    // The two contradict each other and one of them has to win. "Show me what
    // still needs filing" is the more specific request, and it cannot also be
    // "show me Groceries".
    const where = transactionWhere(USER, query({ uncategorised: 'true', categoryId: 'cat_1' }));
    expect(where.categoryId).toBeNull();
  });

  it('turns the filter ON for uncategorised=false, because Boolean("false") is true', () => {
    // Not a bug in this function: the coercion is doing exactly what it is
    // specified to do, and the contract is frozen. Pinned here because the
    // symptom is a list that gets *shorter* when the reader unticks a filter,
    // which looks like a backend fault and is a URL the web app never sends
    // (`apps/web/lib/query.ts` exists for that one line).
    expect(query({ uncategorised: 'false' }).uncategorised).toBe(true);
    expect(transactionWhere(USER, query({ uncategorised: 'false' })).categoryId).toBeNull();
  });

  it('applies no filter for an empty uncategorised, which parses to false', () => {
    // `?uncategorised=` is the one spelling that coerces to `false`, and `false`
    // is not `true`, so the category filter beside it is honoured.
    expect(query({ uncategorised: '' }).uncategorised).toBe(false);
    expect(
      transactionWhere(USER, query({ uncategorised: '', categoryId: 'cat_1' })).categoryId,
    ).toBe('cat_1');
  });

  it('applies no filter when the parameter is omitted', () => {
    // The only spelling of "do not filter" that works, which is why the web app
    // omits the parameter rather than sending a value for it.
    expect(query({}).uncategorised).toBeUndefined();
    expect('categoryId' in transactionWhere(USER, query({}))).toBe(false);
  });

  it('searches case-insensitively, which is what the trigram index serves', () => {
    // `mode: 'insensitive'` compiles to ILIKE '%term%'. The GIN trigram index on
    // `lower(description)` is what keeps that off a sequential scan.
    expect(transactionWhere(USER, query({ search: 'mercadona' })).description).toEqual({
      contains: 'mercadona',
      mode: 'insensitive',
    });
  });

  it('ignores an empty search box', () => {
    // A cleared input posts `search=`. Matching `%%` against every row is a
    // filter that filters nothing at the cost of scanning everything.
    expect('description' in transactionWhere(USER, query({ search: '' }))).toBe(false);
  });

  it('combines every filter into one predicate', () => {
    const where = transactionWhere(
      USER,
      query({
        from: '2026-01-01',
        to: '2026-01-31',
        accountId: 'acc_1',
        categoryId: 'cat_1',
        search: 'emt',
      }),
    );

    expect(where).toEqual({
      userId: USER,
      bookedOn: {
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-01-31T00:00:00.000Z'),
      },
      accountId: 'acc_1',
      categoryId: 'cat_1',
      description: { contains: 'emt', mode: 'insensitive' },
    });
  });

  it('carries no cursor, because the page total is a SUM over the whole set', () => {
    // A total that shrank as the reader paged would be a total of nothing
    // anybody asked for, which is why the cursor is applied by `pageWhere` and
    // not here.
    const where = transactionWhere(USER, query({ cursor: 'anything' }));
    expect(JSON.stringify(where)).not.toContain('OR');
  });
});

describe('TRANSACTION_ORDER', () => {
  it('is the sort the cursor is a position in', () => {
    // `bookedOn` alone is not a key: a day holds dozens of rows, and a cursor at
    // the day boundary would drop the rest of that day or repeat it.
    expect(TRANSACTION_ORDER).toEqual([{ bookedOn: 'desc' }, { id: 'desc' }]);
  });
});

describe('keysetWhere', () => {
  it('asks for everything strictly after a position, in two branches', () => {
    // Written as an OR because Prisma cannot express `(a, b) < (x, y)`. The two
    // are equivalent, and both are servable by the `(user_id, booked_on)` index
    // without walking the rows that were skipped.
    expect(keysetWhere({ bookedOn: day('2026-03-14'), id: 'txn_5' })).toEqual({
      OR: [
        { bookedOn: { lt: new Date('2026-03-14T00:00:00.000Z') } },
        { AND: [{ bookedOn: new Date('2026-03-14T00:00:00.000Z') }, { id: { lt: 'txn_5' } }] },
      ],
    });
  });

  it('excludes the cursor row itself on both branches', () => {
    // `lt`, never `lte`. An inclusive bound repeats the last row of the previous
    // page at the top of the next one, forever.
    const where = keysetWhere({ bookedOn: day('2026-03-14'), id: 'txn_5' }) as {
      OR: [{ bookedOn: { lt: Date } }, { AND: [unknown, { id: { lt: string } }] }];
    };
    expect(where.OR[0].bookedOn.lt).toBeInstanceOf(Date);
    expect(where.OR[1].AND[1].id.lt).toBe('txn_5');
  });
});

describe('pageWhere', () => {
  const base = { userId: USER };

  it('returns the filters untouched when there is no cursor', () => {
    // The first page. Wrapping it in an `AND` of one would be a different query
    // plan for no reason.
    expect(pageWhere(base, null)).toBe(base);
  });

  it('ANDs the cursor onto the filters for every page after the first', () => {
    const where = pageWhere(base, { bookedOn: day('2026-03-14'), id: 'txn_5' });
    expect(where.AND).toHaveLength(2);
    expect((where.AND as unknown[])[0]).toBe(base);
  });

  it('keeps the filters, so page two is filtered the same way as page one', () => {
    // The failure this prevents: a search that applies to the first page and
    // silently widens on the second.
    const filtered = transactionWhere(USER, query({ search: 'emt' }));
    const where = pageWhere(filtered, { bookedOn: day('2026-03-14'), id: 'txn_5' });
    expect(JSON.stringify(where)).toContain('insensitive');
  });
});

describe('splitPage', () => {
  const rows = [
    { bookedOn: '2026-03-14', id: 'txn_9' },
    { bookedOn: '2026-03-14', id: 'txn_8' },
    { bookedOn: '2026-03-13', id: 'txn_7' },
  ];

  it('reports no next page when the over-read came back short', () => {
    // The query asks for `limit + 1`. Fewer than that means the ledger ran out,
    // and the extra row's absence is the answer to "is there a next page"
    // without a second COUNT over the same predicate.
    expect(splitPage(rows, 5)).toEqual({ items: rows, nextCursor: null });
  });

  it('reports no next page when the rows exactly fill it', () => {
    expect(splitPage(rows, 3).nextCursor).toBeNull();
  });

  it('drops the extra row and never returns it', () => {
    const page = splitPage(rows, 2);
    expect(page.items.map((row) => row.id)).toEqual(['txn_9', 'txn_8']);
    expect(page.items).toHaveLength(2);
  });

  it('builds the cursor from the last returned row, not from the extra one', () => {
    // Building it from the over-read row would skip that row on the next page:
    // it would be excluded as "before the cursor" while never having been
    // served. One transaction lost per page, silently.
    const page = splitPage(rows, 2);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string)).toEqual({
      bookedOn: '2026-03-14',
      id: 'txn_8',
    });
  });

  it("copies the rows rather than handing back the caller's array", () => {
    const page = splitPage(rows, 5);
    expect(page.items).not.toBe(rows);
    expect(page.items).toEqual(rows);
  });

  it('handles an empty result', () => {
    expect(splitPage([], 50)).toEqual({ items: [], nextCursor: null });
  });

  it('refuses to hand back a cursor pointing at a day that does not exist', () => {
    // The cursor goes into a `WHERE booked_on < $1` on the next request, so an
    // impossible day has to fail while it is being written rather than being
    // rolled over into a real one by `Date`.
    expect(() =>
      splitPage(
        [
          { bookedOn: '2026-02-31', id: 'txn_2' },
          { bookedOn: '2026-02-30', id: 'txn_1' },
        ],
        1,
      ),
    ).toThrow();
  });
});
