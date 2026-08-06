import { describe, expect, it } from 'vitest';
import {
  ALERT_ONCE_PER_MONTH,
  BUDGET_NO_OVERLAP,
  isCheckViolation,
  isConflict,
  isExclusionViolation,
  isForeignKeyViolation,
  isNotFound,
  isUniqueViolation,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  PRISMA_UNIQUE_VIOLATION,
} from './index';

/**
 * The point of these tests is the two-vocabulary problem.
 *
 * Prisma's typed client reports `P2002` for a unique violation. `$queryRaw`
 * reports Postgres's `23505` for the same thing. A guard written against one of
 * them passes review, passes typecheck, and silently never fires on the other
 * path. Both shapes are asserted here for every predicate, so the bug cannot be
 * reintroduced by writing the "obvious" version.
 *
 * The exclusion constraint is worse: Prisma has no code for it at all. `23P01`
 * arrives through whichever client made the write, and there is nothing else to
 * match on.
 */

/** What the typed client throws. */
const prismaError = (code: string, meta?: Record<string, unknown>) => ({
  name: 'PrismaClientKnownRequestError',
  code,
  meta,
  message: `Invalid \`prisma.budget.create()\` invocation`,
});

/** What a raw query throws. */
const rawError = (code: string, message: string) => ({
  name: 'PrismaClientUnknownRequestError',
  code,
  message,
});

/**
 * What the **typed** client throws when Postgres raises something Prisma has no
 * code for, which for this schema means the budget exclusion constraint.
 *
 * Copied from a real failure, and it is the shape the fixtures above missed:
 * `code` is `undefined`, and the SQLSTATE is a quoted field inside the connector
 * text. The tests above were written against a `rawError` carrying `code:
 * '23P01'`, which no client ever produces on this path, so every predicate
 * passed its unit tests while `budget.create()` returned a 500 in production.
 * The integration lane is what caught it; this fixture is what stops it coming
 * back.
 */
const connectorError = (code: string, constraint: string) => ({
  name: 'PrismaClientUnknownRequestError',
  code: undefined,
  message:
    'Error occurred during query execution:\n' +
    'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(' +
    `PostgresError { code: "${code}", ` +
    `message: "conflicting key value violates exclusion constraint \\"${constraint}\\"", ` +
    'severity: "ERROR", detail: Some("Key (category_id, daterange(effective_from, ' +
    "effective_to, '[]'::text))=(cat_1, [2030-06-01,)) conflicts with existing key " +
    "(category_id, daterange(effective_from, effective_to, '[]'::text))=" +
    '(cat_1, [2030-01-01,2030-06-02))."), column: None, hint: None }), transient: false })',
});

describe('unique violations', () => {
  it('recognises the Prisma code', () => {
    expect(isUniqueViolation(prismaError(PRISMA_UNIQUE_VIOLATION))).toBe(true);
  });

  it('recognises the Postgres SQLSTATE', () => {
    expect(isUniqueViolation(rawError(PG_UNIQUE_VIOLATION, 'duplicate key value'))).toBe(true);
  });

  it('matches a named constraint through meta.target as an array', () => {
    // The typed client's shape: column names, not the constraint name.
    const err = prismaError(PRISMA_UNIQUE_VIOLATION, { target: ['budget_id', 'month', 'level'] });
    expect(isUniqueViolation(err, 'budget_id,month,level')).toBe(true);
    expect(isUniqueViolation(err, 'sha256')).toBe(false);
  });

  it('matches a named constraint through meta.constraint as a string', () => {
    const err = prismaError(PRISMA_UNIQUE_VIOLATION, { constraint: ALERT_ONCE_PER_MONTH });
    expect(isUniqueViolation(err, ALERT_ONCE_PER_MONTH)).toBe(true);
  });

  it('falls back to the message when there is no meta at all', () => {
    const err = rawError(
      PG_UNIQUE_VIOLATION,
      `duplicate key value violates unique constraint "${ALERT_ONCE_PER_MONTH}"`,
    );
    expect(isUniqueViolation(err, ALERT_ONCE_PER_MONTH)).toBe(true);
  });

  it('does not fire on a different code', () => {
    expect(isUniqueViolation(prismaError('P2025'))).toBe(false);
    expect(isUniqueViolation(rawError('23503', 'foreign key'))).toBe(false);
  });
});

describe('exclusion violations', () => {
  it('is the only signal that two budgets overlap', () => {
    const err = rawError(
      PG_EXCLUSION_VIOLATION,
      `conflicting key value violates exclusion constraint "${BUDGET_NO_OVERLAP}"`,
    );
    expect(isExclusionViolation(err)).toBe(true);
    expect(isExclusionViolation(err, BUDGET_NO_OVERLAP)).toBe(true);
  });

  it('is not a unique violation, which is the mistake worth preventing', () => {
    // Catching `isUniqueViolation` around a budget write looks right and never
    // fires, so the 409 the UI expects arrives as a 500 instead.
    const err = rawError(PG_EXCLUSION_VIOLATION, 'conflicting key value');
    expect(isUniqueViolation(err)).toBe(false);
    expect(isExclusionViolation(err)).toBe(true);
  });

  it('reads the SQLSTATE out of a connector error, where the typed client puts it', () => {
    // The shape `prisma.budget.create()` actually produces. `code` is undefined,
    // because Prisma has no code of its own for an EXCLUDE constraint, so the
    // only `23P01` in the whole object is the one quoted inside the message. A
    // predicate that reads `err.code` alone returns false here, and the budget
    // conflict this project is built around answers 500.
    const err = connectorError(PG_EXCLUSION_VIOLATION, BUDGET_NO_OVERLAP);
    expect(err.code).toBeUndefined();
    expect(isExclusionViolation(err)).toBe(true);
    expect(isExclusionViolation(err, BUDGET_NO_OVERLAP)).toBe(true);
    expect(isConflict(err)).toBe(true);
  });

  it('does not confuse one connector error for a different constraint', () => {
    const err = connectorError(PG_EXCLUSION_VIOLATION, BUDGET_NO_OVERLAP);
    expect(isExclusionViolation(err, ALERT_ONCE_PER_MONTH)).toBe(false);
  });

  it('reads a unique violation out of a connector error too', () => {
    // Same mechanism, different SQLSTATE. Asserted so the message-level read is
    // not quietly special-cased to one code.
    const err = connectorError(PG_UNIQUE_VIOLATION, ALERT_ONCE_PER_MONTH);
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, ALERT_ONCE_PER_MONTH)).toBe(true);
    expect(isExclusionViolation(err)).toBe(false);
  });

  it('does not invent a code from a message that merely mentions one', () => {
    // The read is anchored on the field name Prisma writes, `code: "23P01"`, not
    // on the digits appearing anywhere. A user's own transaction description can
    // contain anything.
    const err = {
      name: 'PrismaClientUnknownRequestError',
      code: undefined,
      message: 'Invalid input: the description was "SEPA 23P01 TRANSFER"',
    };
    expect(isExclusionViolation(err)).toBe(false);
    expect(isConflict(err)).toBe(false);
  });
});

describe('other classifications', () => {
  it('recognises foreign key violations from both vocabularies', () => {
    expect(isForeignKeyViolation(prismaError('P2003'))).toBe(true);
    expect(isForeignKeyViolation(rawError('23503', 'violates foreign key constraint'))).toBe(true);
  });

  it('recognises check violations, which only ever arrive as a SQLSTATE', () => {
    expect(isCheckViolation(rawError('23514', 'violates check constraint'))).toBe(true);
    expect(
      isCheckViolation(rawError('23514', 'budgets_limit_positive'), 'budgets_limit_positive'),
    ).toBe(true);
  });

  it('recognises a missing row', () => {
    expect(isNotFound(prismaError('P2025'))).toBe(true);
    expect(isNotFound(prismaError('P2002'))).toBe(false);
  });
});

describe('isConflict', () => {
  it('covers both "someone got there first" cases and nothing else', () => {
    expect(isConflict(prismaError(PRISMA_UNIQUE_VIOLATION))).toBe(true);
    expect(isConflict(rawError(PG_EXCLUSION_VIOLATION, 'conflicting key value'))).toBe(true);
    // A malformed request is a 400, not a 409. Collapsing them loses the
    // distinction the UI needs to tell the user what to do next.
    expect(isConflict(rawError('23514', 'check constraint'))).toBe(false);
    expect(isConflict(prismaError('P2003'))).toBe(false);
  });
});

describe('inputs that are not errors', () => {
  it.each([null, undefined, 'boom', 42, [], new Error('plain')])(
    'returns false for %s',
    (value) => {
      expect(isUniqueViolation(value)).toBe(false);
      expect(isExclusionViolation(value)).toBe(false);
      expect(isConflict(value)).toBe(false);
    },
  );
});
