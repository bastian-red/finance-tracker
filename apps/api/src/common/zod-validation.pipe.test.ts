import { BadRequestException } from '@nestjs/common';
import { createTransactionSchema, transactionQuerySchema } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe, type ValidationErrorBody } from './zod-validation.pipe';

const bodyOf = (error: unknown): ValidationErrorBody => {
  if (!(error instanceof BadRequestException)) throw new Error('expected a BadRequestException');
  return error.getResponse() as ValidationErrorBody;
};

describe('ZodValidationPipe', () => {
  it('returns the schema output, not the input', () => {
    // The query schema coerces and defaults. A handler that received the raw
    // query would compare the string "50" to a number.
    const pipe = new ZodValidationPipe(transactionQuerySchema);
    expect(pipe.transform({ limit: '50' })).toEqual({ limit: 50 });
    expect(pipe.transform({})).toEqual({ limit: 50 });
  });

  it('answers 400 with a path and a message per problem', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    let caught: unknown;
    try {
      pipe.transform({ accountId: '', bookedOn: 'yesterday', amountMinor: 12.5, description: '' });
    } catch (error) {
      caught = error;
    }

    const body = bodyOf(caught);
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Validation failed');

    const paths = body.errors.map((issue) => issue.path).sort();
    expect(paths).toEqual(['accountId', 'amountMinor', 'bookedOn', 'description']);
    expect(body.errors.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it('names the amount rule in words a caller can act on', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    try {
      pipe.transform({
        accountId: 'acc_1',
        bookedOn: '2026-03-01',
        amountMinor: 12.34,
        description: 'Coffee',
      });
      expect.unreachable('a fractional amount must not validate');
    } catch (error) {
      const body = bodyOf(error);
      expect(body.errors).toEqual([
        { path: 'amountMinor', message: 'Amounts are integer minor units (cents), never decimals' },
      ]);
    }
  });

  it('carries no zod internals into the response body', () => {
    // `code`, `expected`, `received` and `unionErrors` are the validator's
    // implementation, not this API's contract.
    const pipe = new ZodValidationPipe(createTransactionSchema);
    try {
      pipe.transform({});
      expect.unreachable('an empty body must not validate');
    } catch (error) {
      const body = bodyOf(error);
      for (const issue of body.errors) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      }
    }
  });

  it('reports a whole-payload failure with an empty path', () => {
    const pipe = new ZodValidationPipe(createTransactionSchema);
    try {
      pipe.transform('not an object');
      expect.unreachable('a string is not a transaction');
    } catch (error) {
      const body = bodyOf(error);
      expect(body.errors).toEqual([{ path: '', message: 'Expected object, received string' }]);
    }
  });
});
