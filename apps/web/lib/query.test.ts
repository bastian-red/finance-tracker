import { describe, expect, it } from 'vitest';
import { readTransactionFilters, toQueryString, transactionQueryString } from './query';

/**
 * The query string, and the one encoding that has to be wrong to be right.
 *
 * What it pins: a false boolean is never sent. `transactionQuerySchema.uncategorised`
 * is `z.coerce.boolean()`, Zod's coercion is `Boolean(value)`, and every non-empty
 * string is truthy, so `uncategorised=false` on the wire turns the filter **on**.
 * The only correct encoding of "off" is to omit the parameter.
 *
 * What breaks without it: the user unticks "only uncategorised", the list gets
 * shorter instead of longer, and nothing anywhere reports an error. It is a
 * silent inversion, which is the worst kind of wrong, and it is one `if` away at
 * all times.
 *
 * The reader is pinned too. Encoding and decoding have to agree, or a filter
 * survives a page load in one direction and not the other.
 */

describe('toQueryString', () => {
  it('omits a false boolean entirely', () => {
    // The line this whole file exists for.
    expect(toQueryString({ uncategorised: false })).toBe('');
    expect(toQueryString({ uncategorised: true })).toBe('?uncategorised=true');
  });

  it('never emits the string "false" for any key', () => {
    const encoded = toQueryString({ a: false, b: true, c: 'false' });
    // `c` is a caller sending the literal text, which is its business. What must
    // not happen is a boolean becoming one.
    expect(encoded).toBe('?b=true&c=false');
  });

  it('drops undefined, null and the empty string', () => {
    // `search=` would otherwise reach a `z.string().max(120)` as a valid empty
    // search and force the API to special-case it.
    expect(toQueryString({ a: undefined, b: null, c: '' })).toBe('');
    expect(toQueryString({ a: undefined, b: 'kept' })).toBe('?b=kept');
  });

  it('keeps a zero, which is a value and not an absence', () => {
    expect(toQueryString({ limit: 0 })).toBe('?limit=0');
  });

  it('prefixes with ? only when there is something to send', () => {
    expect(toQueryString({})).toBe('');
    expect(toQueryString({ a: 1 })).toBe('?a=1');
  });

  it('percent-encodes values rather than trusting them', () => {
    // A search for "bar & grill" must not become two parameters.
    expect(toQueryString({ search: 'bar & grill' })).toBe('?search=bar+%26+grill');
    expect(toQueryString({ search: 'café' })).toBe('?search=caf%C3%A9');
    expect(new URLSearchParams(toQueryString({ search: 'bar & grill' })).get('search')).toBe(
      'bar & grill',
    );
  });
});

describe('transactionQueryString', () => {
  it('encodes a full filter set', () => {
    expect(
      transactionQueryString({
        from: '2026-01-01',
        to: '2026-01-31',
        accountId: 'acc_1',
        categoryId: 'cat_2',
        uncategorised: true,
        search: 'mercadona',
        cursor: 'cur_3',
        limit: 50,
      }),
    ).toBe(
      '?from=2026-01-01&to=2026-01-31&accountId=acc_1&categoryId=cat_2&uncategorised=true&search=mercadona&cursor=cur_3&limit=50',
    );
  });

  it('drops the unticked box instead of encoding it', () => {
    expect(transactionQueryString({ uncategorised: false, search: 'lidl' })).toBe('?search=lidl');
  });

  it('is empty for an empty filter set, so the URL stays clean', () => {
    expect(transactionQueryString({})).toBe('');
  });
});

describe('readTransactionFilters', () => {
  it('reads back what transactionQueryString wrote', () => {
    const filters = {
      from: '2026-01-01',
      to: '2026-01-31',
      accountId: 'acc_1',
      categoryId: 'cat_2',
      uncategorised: true,
      search: 'mercadona',
      cursor: 'cur_3',
      limit: 50,
    };
    const params = Object.fromEntries(
      new URLSearchParams(transactionQueryString(filters)).entries(),
    );
    expect(readTransactionFilters(params)).toEqual(filters);
  });

  it('treats a missing parameter as unset, not as false', () => {
    // `undefined` and `false` are different answers: one means "the user did not
    // say", the other means "the user said no".
    expect(readTransactionFilters({}).uncategorised).toBeUndefined();
  });

  it('reads a hand-typed uncategorised=false as off', () => {
    // The page's own links never emit this, but a URL is user input. The mirror
    // of the encoding rule: present and not the string false means on.
    expect(readTransactionFilters({ uncategorised: 'false' }).uncategorised).toBe(false);
    expect(readTransactionFilters({ uncategorised: 'true' }).uncategorised).toBe(true);
    expect(readTransactionFilters({ uncategorised: '1' }).uncategorised).toBe(true);
  });

  it('takes the first value when a parameter repeats', () => {
    // `?categoryId=a&categoryId=b` has no meaningful second answer, and dropping
    // the filter would be worse than picking one.
    expect(readTransactionFilters({ categoryId: ['a', 'b'] }).categoryId).toBe('a');
    expect(readTransactionFilters({ categoryId: [] }).categoryId).toBeUndefined();
  });

  it('treats an empty value as absent', () => {
    expect(readTransactionFilters({ search: '', from: '' })).toEqual({
      from: undefined,
      to: undefined,
      accountId: undefined,
      categoryId: undefined,
      uncategorised: undefined,
      search: undefined,
      cursor: undefined,
      limit: undefined,
    });
  });

  it.each([
    ['10', 10],
    ['1', 1],
    ['200', 200],
    ['500', 200],
    ['0', undefined],
    ['-5', undefined],
    ['abc', undefined],
    ['', undefined],
    ['1e3', 1],
  ])('limit=%s reads as %s', (raw, expected) => {
    // Capped at 200 because that is the contract's own maximum; a larger value
    // would be rejected by the API after the round trip rather than here.
    // `1e3` is the interesting one: `parseInt` stops at the `e` and gives 1,
    // which is a valid limit, so the page shows one row instead of erroring.
    expect(readTransactionFilters({ limit: raw }).limit).toBe(expected);
  });
});
