import { PrismaClient } from '../generated/client';

export * from '../generated/client';
export { PrismaClient };

/**
 * Error codes the services branch on.
 *
 * Two vocabularies, and confusing them fails silently rather than loudly.
 * Prisma's typed client reports its **own** codes — `P2002` for a unique
 * violation — while `$queryRaw` and `$executeRaw` surface the underlying
 * Postgres **SQLSTATE**, `23505`. A guard that checks only the SQLSTATE
 * compiles, type-checks, and never fires against an ordinary `create()`.
 *
 * For this app the consequence is concrete: the budget overlap guard is an
 * exclusion constraint, which Prisma has no code for at all. It arrives as
 * SQLSTATE `23P01` through whichever path made the write. Every predicate below
 * therefore accepts both vocabularies.
 */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';
export const PRISMA_NOT_FOUND = 'P2025';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';
/** An EXCLUDE constraint. Prisma has no equivalent code; this is the only signal. */
export const PG_EXCLUSION_VIOLATION = '23P01';

/**
 * Names of the invariants declared in `20260801121000_ledger_invariants`.
 *
 * Code that catches a constraint violation matches on these rather than on the
 * message text. Postgres error messages are localised and reworded between
 * versions, so a service that greps them breaks on an upgrade, in production,
 * at the exact moment it is trying to report a different error.
 */
export const BUDGET_NO_OVERLAP = 'budgets_no_overlapping_periods';
export const BUDGET_RANGE_ORDERED = 'budgets_period_ordered';
export const BUDGET_MONTH_ALIGNED = 'budgets_months_aligned';
export const BUDGET_LIMIT_POSITIVE = 'budgets_limit_positive';
export const ALERT_MONTH_ALIGNED = 'alerts_month_aligned';
export const TRANSACTION_EXTERNAL_ID_UNIQUE = 'transactions_account_id_external_id_key';
export const IMPORT_SHA_UNIQUE = 'imports_user_id_sha256_key';
export const ALERT_ONCE_PER_MONTH = 'alerts_budget_id_month_level_key';
export const CATEGORY_NAME_UNIQUE = 'categories_user_id_name_key';
export const ACCOUNT_NAME_UNIQUE = 'accounts_user_id_name_key';
export const TRANSACTION_CURRENCY_MATCHES_ACCOUNT = 'transactions_currency_matches_account';

interface PgError {
  code?: string;
  message?: string;
  meta?: { constraint?: unknown; target?: unknown; message?: unknown; cause?: unknown };
}

function asError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null ? (err as PgError) : null;
}

/**
 * The constraint an error is about.
 *
 * Prisma reports it three different ways depending on how the write was made:
 * `meta.constraint` for raw SQL, `meta.target` as a string or as an array of
 * column names for the typed client. Normalising here means every call site
 * asks one question instead of three.
 */
function constraintName(err: PgError): string {
  const constraint = err.meta?.constraint;
  if (typeof constraint === 'string') return constraint;
  if (Array.isArray(constraint)) return constraint.join(',');
  const target = err.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  // Last resort: an exclusion violation raised through a raw query carries the
  // constraint name only in the message text.
  return typeof err.message === 'string' ? err.message : '';
}

/**
 * The SQLSTATE Postgres reported, wherever Prisma happened to put it.
 *
 * There is a third place, and missing it turned every budget overlap into a 500.
 * Prisma's typed client has no error code for an `EXCLUDE` constraint, so a
 * `budget.create()` that trips one does not become a `PrismaClientKnownRequestError`
 * with `code: '23P01'` — it becomes a `PrismaClientUnknownRequestError` whose
 * `code` is `undefined` and whose message is the raw connector text:
 *
 *   Error occurred during query execution:
 *   ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(
 *     PostgresError { code: "23P01", message: "conflicting key value violates
 *     exclusion constraint \"budgets_no_overlapping_periods\"", ... }) })
 *
 * The SQLSTATE is right there, one level of quoting down. Reading it is not
 * message-grepping in the sense this file warns against: `code: "23P01"` is a
 * stable, machine-written field name and a numeric code, not a localised
 * sentence, and the constraint name it is matched against comes from the same
 * structure. The alternative is a 500 on the one path the whole concurrency
 * design exists for.
 */
function codeOf(err: PgError): string | null {
  if (typeof err.code === 'string') return err.code;
  if (typeof err.message !== 'string') return null;
  return /\bcode:\s*"([0-9A-Z]{5})"/.exec(err.message)?.[1] ?? null;
}

function hasCode(err: PgError, ...codes: string[]): boolean {
  const code = codeOf(err);
  return code !== null && codes.includes(code);
}

function matches(err: PgError, constraint?: string): boolean {
  if (constraint === undefined) return true;
  const name = constraintName(err);
  // `includes` rather than equality: the array form joins column names, and the
  // message form embeds the constraint name in a sentence.
  return name.includes(constraint);
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PRISMA_UNIQUE_VIOLATION, PG_UNIQUE_VIOLATION) && matches(error, constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return (
    hasCode(error, PRISMA_FOREIGN_KEY_VIOLATION, PG_FOREIGN_KEY_VIOLATION) &&
    matches(error, constraint)
  );
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PG_CHECK_VIOLATION) && matches(error, constraint);
}

/**
 * An EXCLUDE constraint fired.
 *
 * For this schema that means one thing: two budgets for the same category cover
 * an overlapping range of months. It is the concurrency guard, so the caller's
 * job on catching it is to report a conflict, not to retry.
 */
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  const error = asError(err);
  if (!error) return false;
  return hasCode(error, PG_EXCLUSION_VIOLATION) && matches(error, constraint);
}

/** A write that expected an existing row and did not find one. */
export function isNotFound(err: unknown): boolean {
  const error = asError(err);
  return error !== null && hasCode(error, PRISMA_NOT_FOUND);
}

/**
 * Any violation that means "someone else got there first", as opposed to
 * "the request was malformed".
 *
 * The distinction matters at the HTTP boundary: the first is a 409 the user can
 * act on, the second is a 400. Collapsing them into a 500 is how a duplicate
 * budget becomes a support ticket.
 */
export function isConflict(err: unknown): boolean {
  return isUniqueViolation(err) || isExclusionViolation(err);
}
