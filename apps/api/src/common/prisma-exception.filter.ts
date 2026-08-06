import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  ACCOUNT_NAME_UNIQUE,
  ALERT_ONCE_PER_MONTH,
  BUDGET_LIMIT_POSITIVE,
  BUDGET_MONTH_ALIGNED,
  BUDGET_NO_OVERLAP,
  BUDGET_RANGE_ORDERED,
  CATEGORY_NAME_UNIQUE,
  IMPORT_SHA_UNIQUE,
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isNotFound,
  isUniqueViolation,
  TRANSACTION_CURRENCY_MATCHES_ACCOUNT,
  TRANSACTION_EXTERNAL_ID_UNIQUE,
} from '@fin/db';
import type { Response } from 'express';

interface ErrorBody {
  statusCode: number;
  message: string;
  /** The invariant that fired, when one did. Names the constraint, never the SQL. */
  constraint?: string;
}

/**
 * Database invariants, translated into HTTP.
 *
 * Every entry matches on a **constraint name** exported from `@fin/db`, never on
 * the message text. Postgres localises its messages and rewords them between
 * versions, so a filter that greps `"violates exclusion constraint"` works until
 * the day the database is upgraded, and then turns every budget conflict into a
 * 500 -- at exactly the moment somebody is trying to read the error.
 *
 * The status codes are the point of the whole file. Collapsing a constraint
 * violation into a 500 loses the one bit that matters to the caller: whether the
 * request was wrong (400, fix it and retry) or whether somebody else got there
 * first (409, look at what is already there). A 500 says "try again later" for
 * both, and for a duplicate budget that is never true.
 */
const RULES: readonly {
  matches: (error: unknown) => boolean;
  status: HttpStatus;
  constraint: string;
  message: string;
}[] = [
  {
    matches: (error) => isExclusionViolation(error, BUDGET_NO_OVERLAP),
    status: HttpStatus.CONFLICT,
    constraint: BUDGET_NO_OVERLAP,
    message:
      'Another budget for this category already covers part of that period. Close it first, or pick a different range.',
  },
  {
    matches: (error) => isUniqueViolation(error, ALERT_ONCE_PER_MONTH),
    status: HttpStatus.CONFLICT,
    constraint: ALERT_ONCE_PER_MONTH,
    message: 'That budget has already raised this alert for this month.',
  },
  {
    matches: (error) => isUniqueViolation(error, CATEGORY_NAME_UNIQUE),
    status: HttpStatus.CONFLICT,
    constraint: CATEGORY_NAME_UNIQUE,
    message: 'A category with that name already exists.',
  },
  {
    matches: (error) => isUniqueViolation(error, ACCOUNT_NAME_UNIQUE),
    status: HttpStatus.CONFLICT,
    constraint: ACCOUNT_NAME_UNIQUE,
    message: 'An account with that name already exists.',
  },
  {
    matches: (error) => isUniqueViolation(error, IMPORT_SHA_UNIQUE),
    status: HttpStatus.CONFLICT,
    constraint: IMPORT_SHA_UNIQUE,
    message: 'That file has already been uploaded. Open the existing import instead.',
  },
  {
    matches: (error) => isUniqueViolation(error, TRANSACTION_EXTERNAL_ID_UNIQUE),
    status: HttpStatus.CONFLICT,
    constraint: TRANSACTION_EXTERNAL_ID_UNIQUE,
    message: 'That transaction is already in the ledger.',
  },
  {
    // A currency mismatch is a bug in the writer, not a choice the caller made:
    // the API takes the currency from the account row, so this can only fire if
    // some path stopped doing that. 400 rather than 500 so it is visible in the
    // response instead of only in the log.
    matches: (error) => isCheckViolation(error, TRANSACTION_CURRENCY_MATCHES_ACCOUNT),
    status: HttpStatus.BAD_REQUEST,
    constraint: TRANSACTION_CURRENCY_MATCHES_ACCOUNT,
    message: "A transaction's currency must match the account it belongs to.",
  },
  {
    matches: (error) => isCheckViolation(error, BUDGET_LIMIT_POSITIVE),
    status: HttpStatus.BAD_REQUEST,
    constraint: BUDGET_LIMIT_POSITIVE,
    message: 'A budget limit must be greater than zero.',
  },
  {
    matches: (error) => isCheckViolation(error, BUDGET_MONTH_ALIGNED),
    status: HttpStatus.BAD_REQUEST,
    constraint: BUDGET_MONTH_ALIGNED,
    message: 'A budget period is stated in whole months.',
  },
  {
    matches: (error) => isCheckViolation(error, BUDGET_RANGE_ORDERED),
    status: HttpStatus.BAD_REQUEST,
    constraint: BUDGET_RANGE_ORDERED,
    message: 'A budget cannot end before it starts.',
  },
];

/** The status a violation deserves when no named rule above claims it. */
function fallbackFor(error: unknown): { status: HttpStatus; message: string } | null {
  if (isNotFound(error)) {
    return { status: HttpStatus.NOT_FOUND, message: 'Not found' };
  }
  if (isUniqueViolation(error) || isExclusionViolation(error)) {
    return {
      status: HttpStatus.CONFLICT,
      message: 'That change conflicts with something already stored.',
    };
  }
  if (isCheckViolation(error)) {
    return { status: HttpStatus.BAD_REQUEST, message: 'That change breaks a rule of the ledger.' };
  }
  if (isForeignKeyViolation(error)) {
    // The referenced row does not exist, or does not belong to this user. Both
    // are the caller pointing at something that is not theirs to point at.
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'That change references something that does not exist.',
    };
  }
  return null;
}

@Catch()
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = translate(exception);

    if (body.statusCode >= 500) {
      // The only branch that logs the exception itself. Everything else is a
      // deliberate answer, and logging those at error level is how a log stops
      // being read.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.status(body.statusCode).json(body);
  }
}

/**
 * The pure half, so the mapping is testable without an HTTP server.
 *
 * An `HttpException` passes through untouched: a handler that already decided on
 * a 404 with a message knows more about the request than this filter does.
 */
export function translate(exception: unknown): ErrorBody & Record<string, unknown> {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    if (typeof payload === 'object' && payload !== null) {
      return {
        statusCode: status,
        message: exception.message,
        ...(payload as object),
      } as ErrorBody & Record<string, unknown>;
    }
    return { statusCode: status, message: String(payload) };
  }

  for (const rule of RULES) {
    if (rule.matches(exception)) {
      return { statusCode: rule.status, message: rule.message, constraint: rule.constraint };
    }
  }

  const fallback = fallbackFor(exception);
  if (fallback) return { statusCode: fallback.status, message: fallback.message };

  return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' };
}
