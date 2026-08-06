import type { Account, Category } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { accountIndex, accountName, categoryIndex } from './lookup';

/**
 * Turning a list into something a table row can ask a question of.
 *
 * The interesting case is the one that is not an error: a transaction whose
 * `categoryId` is not in the list. That happens legitimately -- a category was
 * deleted while the page was open, and `ON DELETE SET NULL` moved its
 * transactions into the uncategorised queue -- and it must never throw or render
 * the string "undefined" into a cell.
 *
 * The reason these are `Map`s and not `find()` calls in the row is complexity:
 * 200 rows against 10 categories is 2,000 comparisons for an answer one hash
 * lookup gives. The last case pins that the index is built once.
 */

const category = (id: string, name: string): Category => ({
  id,
  name,
  kind: 'expense',
  colorSlot: 0,
});

const account = (id: string, name: string): Account => ({
  id,
  name,
  kind: 'checking',
  currency: 'EUR',
  balanceMinor: 0,
  archived: false,
});

describe('categoryIndex', () => {
  it('keys by id', () => {
    const index = categoryIndex([category('cat_a', 'Groceries'), category('cat_b', 'Transport')]);
    expect(index.get('cat_a')?.name).toBe('Groceries');
    expect(index.size).toBe(2);
  });

  it('returns undefined for an id the list does not contain, rather than throwing', () => {
    // The normal state for a row whose category was deleted under it.
    const index = categoryIndex([category('cat_a', 'Groceries')]);
    expect(index.get('cat_gone')).toBeUndefined();
  });

  it('is empty for an empty list, not undefined', () => {
    expect(categoryIndex([]).size).toBe(0);
  });
});

describe('accountIndex', () => {
  it('keys by id', () => {
    const index = accountIndex([account('acc_a', 'Cuenta corriente')]);
    expect(index.get('acc_a')?.name).toBe('Cuenta corriente');
  });
});

describe('accountName', () => {
  it('reads the name', () => {
    const index = accountIndex([account('acc_a', 'Ahorro')]);
    expect(accountName(index, 'acc_a')).toBe('Ahorro');
  });

  it('answers with a placeholder that does not pretend to be a name', () => {
    // Not the empty string, and not the raw cuid. A blank cell reads as "this
    // transaction has no account", which is impossible, and a cuid reads as a
    // bug the user is being asked to interpret.
    expect(accountName(accountIndex([]), 'acc_gone')).toBe('Unknown account');
  });

  it('never renders the literal string "undefined"', () => {
    expect(accountName(accountIndex([]), 'acc_gone')).not.toContain('undefined');
  });
});
