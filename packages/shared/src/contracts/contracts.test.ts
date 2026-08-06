import { describe, expect, it } from 'vitest';
import {
  amountMinorSchema,
  budgetSchema,
  calendarDaySchema,
  commitImportSchema,
  createTransactionSchema,
  matcherSchema,
  transactionQuerySchema,
} from './index';

/**
 * These tests are about the boundary, not about zod.
 *
 * There is no value in asserting that `z.string()` rejects a number. What is
 * worth pinning is every place the contract encodes a decision the rest of the
 * app depends on: that an amount can never arrive as a decimal, that a day can
 * never arrive as an instant, and that the query defaults are the ones the API
 * and the web app both assume.
 */
describe('amounts cross the wire as integer minor units', () => {
  it('accepts an integer count of cents', () => {
    expect(amountMinorSchema.parse(-8990)).toBe(-8990);
    expect(amountMinorSchema.parse(0)).toBe(0);
  });

  it('rejects a decimal, which is the whole point', () => {
    // If `12.34` were accepted here it would be stored as 12 cents or as 1234
    // depending on which layer rounded first, and both are wrong.
    const result = amountMinorSchema.safeParse(12.34);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/integer minor units/);
  });

  it('rejects an amount the column cannot hold', () => {
    // int4 range. Rejecting here is a 400 with a readable message instead of a
    // Postgres "integer out of range" 500 three layers down.
    expect(amountMinorSchema.safeParse(2_147_483_648).success).toBe(false);
    expect(amountMinorSchema.safeParse(-2_147_483_649).success).toBe(false);
    expect(amountMinorSchema.safeParse(2_147_483_647).success).toBe(true);
  });
});

describe('days cross the wire as strings', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(calendarDaySchema.parse('2026-03-09')).toBe('2026-03-09');
  });

  it.each(['2026-03-09T00:00:00.000Z', '09/03/2026', '2026-3-9'])('rejects %s', (value) => {
    // An instant would be read back in the browser's zone, which files the
    // first of the month under the previous month everywhere west of UTC.
    expect(calendarDaySchema.safeParse(value).success).toBe(false);
  });
});

describe('transaction creation', () => {
  it('requires a description, because a blank ledger row is unreadable', () => {
    const base = { accountId: 'a1', bookedOn: '2026-03-09', amountMinor: -1200 };
    expect(createTransactionSchema.safeParse({ ...base, description: '' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...base, description: 'Coffee' }).success).toBe(
      true,
    );
  });

  it('allows an explicit null category, meaning uncategorised', () => {
    const parsed = createTransactionSchema.parse({
      accountId: 'a1',
      bookedOn: '2026-03-09',
      amountMinor: -1200,
      description: 'Coffee',
      categoryId: null,
    });
    expect(parsed.categoryId).toBeNull();
  });
});

describe('transaction query defaults', () => {
  it('defaults the page size both sides agree on', () => {
    expect(transactionQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces the query string, because URLSearchParams only has strings', () => {
    const parsed = transactionQuerySchema.parse({ limit: '25', uncategorised: 'true' });
    expect(parsed.limit).toBe(25);
    expect(parsed.uncategorised).toBe(true);
  });

  it('caps the page size so one request cannot ask for the whole ledger', () => {
    expect(transactionQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });
});

describe('matchers', () => {
  it('discriminates on type', () => {
    expect(matcherSchema.parse({ type: 'contains', value: 'mercadona' })).toEqual({
      type: 'contains',
      value: 'mercadona',
    });
    expect(matcherSchema.safeParse({ type: 'glob', value: '*' }).success).toBe(false);
  });

  it('caps a regex at a length a person can still read', () => {
    expect(matcherSchema.safeParse({ type: 'regex', value: 'a'.repeat(201) }).success).toBe(false);
  });
});

describe('budgets', () => {
  it('refuses a zero or negative limit', () => {
    const base = { id: 'b1', categoryId: 'c1', effectiveFrom: '2026-01', effectiveTo: null };
    expect(budgetSchema.safeParse({ ...base, limitMinor: 0 }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...base, limitMinor: -100 }).success).toBe(false);
    expect(budgetSchema.safeParse({ ...base, limitMinor: 40_000 }).success).toBe(true);
  });

  it('treats a null end month as still in force', () => {
    const parsed = budgetSchema.parse({
      id: 'b1',
      categoryId: 'c1',
      limitMinor: 40_000,
      effectiveFrom: '2026-01',
      effectiveTo: null,
    });
    expect(parsed.effectiveTo).toBeNull();
  });
});

describe('import commit', () => {
  it('defaults to skipping nothing, so the caller must be explicit', () => {
    expect(commitImportSchema.parse({}).skipLines).toEqual([]);
  });

  it('caps the skip list rather than accepting an unbounded array', () => {
    expect(commitImportSchema.safeParse({ skipLines: new Array(20_001).fill(1) }).success).toBe(
      false,
    );
  });
});
