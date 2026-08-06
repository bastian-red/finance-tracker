import {
  ACCOUNT_NAME_UNIQUE,
  ALERT_ONCE_PER_MONTH,
  BUDGET_LIMIT_POSITIVE,
  BUDGET_NO_OVERLAP,
  CATEGORY_NAME_UNIQUE,
  IMPORT_SHA_UNIQUE,
  PG_CHECK_VIOLATION,
  PG_EXCLUSION_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PRISMA_NOT_FOUND,
  PRISMA_UNIQUE_VIOLATION,
  TRANSACTION_CURRENCY_MATCHES_ACCOUNT,
} from '@fin/db';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { translate } from './prisma-exception.filter';

/** How Prisma reports a violation raised by the typed client. */
const typedError = (code: string, target: string[]): unknown => ({ code, meta: { target } });

/** How the same violation arrives through $executeRaw: SQLSTATE plus a constraint. */
const rawError = (code: string, constraint: string): unknown => ({
  code,
  meta: { constraint },
  message: `violates constraint "${constraint}"`,
});

describe('translate', () => {
  it('maps the budget exclusion constraint to 409 and names the overlap', () => {
    const body = translate(rawError(PG_EXCLUSION_VIOLATION, BUDGET_NO_OVERLAP));
    expect(body.statusCode).toBe(409);
    expect(body.constraint).toBe(BUDGET_NO_OVERLAP);
    expect(body.message).toMatch(/already covers part of that period/);
  });

  it('maps a duplicate category name to 409', () => {
    const body = translate(typedError(PRISMA_UNIQUE_VIOLATION, ['user_id', 'name']));
    // The typed client reports the columns, not the constraint name, so the
    // generic conflict branch is the one that fires here.
    expect(body.statusCode).toBe(409);
  });

  it('maps the named category constraint to its own message', () => {
    const body = translate(rawError(PRISMA_UNIQUE_VIOLATION, CATEGORY_NAME_UNIQUE));
    expect(body.statusCode).toBe(409);
    expect(body.message).toMatch(/category with that name/);
  });

  it('maps a duplicate account name to 409', () => {
    const body = translate(rawError(PRISMA_UNIQUE_VIOLATION, ACCOUNT_NAME_UNIQUE));
    expect(body.statusCode).toBe(409);
    expect(body.message).toMatch(/account with that name/);
  });

  it('maps a re-uploaded statement to 409 pointing at the existing import', () => {
    const body = translate(rawError(PRISMA_UNIQUE_VIOLATION, IMPORT_SHA_UNIQUE));
    expect(body.statusCode).toBe(409);
    expect(body.message).toMatch(/already been uploaded/);
  });

  it('maps a repeated alert to 409', () => {
    const body = translate(rawError(PRISMA_UNIQUE_VIOLATION, ALERT_ONCE_PER_MONTH));
    expect(body.statusCode).toBe(409);
    expect(body.constraint).toBe(ALERT_ONCE_PER_MONTH);
  });

  it('maps the currency trigger to 400, because it is a writer bug worth seeing', () => {
    const body = translate(rawError(PG_CHECK_VIOLATION, TRANSACTION_CURRENCY_MATCHES_ACCOUNT));
    expect(body.statusCode).toBe(400);
    expect(body.message).toMatch(/must match the account/);
  });

  it('maps a non-positive budget limit to 400', () => {
    const body = translate(rawError(PG_CHECK_VIOLATION, BUDGET_LIMIT_POSITIVE));
    expect(body.statusCode).toBe(400);
  });

  it('maps a foreign key violation to 400', () => {
    const body = translate({ code: PG_FOREIGN_KEY_VIOLATION });
    expect(body.statusCode).toBe(400);
  });

  it('maps a missing row to 404', () => {
    const body = translate({ code: PRISMA_NOT_FOUND });
    expect(body.statusCode).toBe(404);
  });

  it('leaves an HttpException alone, including its body', () => {
    const body = translate(new NotFoundException('No such transaction'));
    expect(body.statusCode).toBe(404);
    expect(body.message).toBe('No such transaction');
  });

  it('keeps the validation pipe error shape intact', () => {
    const thrown = new BadRequestException({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: 'amountMinor', message: 'nope' }],
    });
    const body = translate(thrown);
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Validation failed');
    expect(body.errors).toEqual([{ path: 'amountMinor', message: 'nope' }]);
  });

  it('keeps a handler-thrown 409 rather than re-deriving it', () => {
    const body = translate(new ConflictException('Groceries is already budgeted from 2026-01'));
    expect(body.statusCode).toBe(409);
    expect(body.message).toBe('Groceries is already budgeted from 2026-01');
  });

  it('falls back to 500 for anything it does not recognise, and leaks nothing', () => {
    const body = translate(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.0\.5/);
  });

  it('does not mistake a plain object for a database error', () => {
    expect(translate({ code: 'ENOENT' }).statusCode).toBe(500);
    expect(translate(null).statusCode).toBe(500);
    expect(translate('boom').statusCode).toBe(500);
  });
});
