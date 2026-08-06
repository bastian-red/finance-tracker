import {
  accountSchema,
  alertSchema,
  budgetSchema,
  budgetStatusSchema,
  categorySchema,
  importPreviewSchema,
  monthlyReportSchema,
  ruleSchema,
  transactionPageSchema,
  type Account,
  type Alert,
  type Budget,
  type BudgetStatus,
  type Category,
  type ImportPreview,
  type MonthlyReport,
  type Rule,
  type TransactionPage,
} from '@fin/shared';
import { z } from 'zod';
import { endpoints } from './endpoints';
import { transactionQueryString, type TransactionFilters } from './query';
import { authedRequest } from './session';

/**
 * Every read this app performs, once each.
 *
 * Pages call these instead of `authedRequest` directly, for two reasons that
 * both bit somebody before this file existed. First, the schema for a collection
 * endpoint is `z.array(thing)`, and writing that at each call site means the day
 * an endpoint starts answering `{ items: [...] }` there are six places to change
 * rather than one. Second, `cache: 'no-store'` lives in `lib/api.ts` and applies
 * to all of these — Next's Data Cache is keyed on the URL and not on the
 * Authorization header, so a cached `/transactions` is one person's ledger served
 * to the next visitor.
 *
 * None of these catch. A failed read belongs in the route's error boundary with
 * its status intact, and a `try` here would also be a `try` around the
 * `redirect()` that `requireUser` throws.
 */

const accountsSchema = z.array(accountSchema);
const categoriesSchema = z.array(categorySchema);
const rulesSchema = z.array(ruleSchema);
const budgetsSchema = z.array(budgetSchema);
const budgetStatusesSchema = z.array(budgetStatusSchema);
const alertsSchema = z.array(alertSchema);

export function fetchAccounts(): Promise<Account[]> {
  return authedRequest(endpoints.accounts, accountsSchema);
}

export function fetchCategories(): Promise<Category[]> {
  return authedRequest(endpoints.categories, categoriesSchema);
}

export function fetchRules(): Promise<Rule[]> {
  return authedRequest(endpoints.rules, rulesSchema);
}

export function fetchBudgets(): Promise<Budget[]> {
  return authedRequest(endpoints.budgets, budgetsSchema);
}

/** Budgets resolved against one month, with what has been spent so far. */
export function fetchBudgetStatuses(month: string): Promise<BudgetStatus[]> {
  return authedRequest(endpoints.budgetStatus(month), budgetStatusesSchema);
}

export function fetchMonthlyReport(query: {
  month?: string;
  trailing?: number;
}): Promise<MonthlyReport> {
  return authedRequest(endpoints.monthlyReport(query), monthlyReportSchema);
}

/**
 * A page of the ledger.
 *
 * The filters go through `transactionQueryString`, which drops a false boolean
 * rather than encoding it. `transactionQuerySchema.uncategorised` is
 * `z.coerce.boolean()` and `Boolean("false")` is `true`, so sending
 * `uncategorised=false` turns the filter **on** and the list gets shorter when
 * the user unticks the box.
 */
export function fetchTransactions(filters: TransactionFilters): Promise<TransactionPage> {
  return authedRequest(
    endpoints.transactions(transactionQueryString(filters)),
    transactionPageSchema,
  );
}

/**
 * Every alert this ledger has raised, newest first.
 *
 * The list is the API's, unfiltered and uncapped, because a budget can raise at
 * most one alert per month per level and there are single-digit budgets: the
 * whole history is smaller than one page of the ledger. Paginating it would add a
 * cursor nobody would ever use.
 */
export function fetchAlerts(): Promise<Alert[]> {
  return authedRequest(endpoints.alerts, alertsSchema);
}

export function fetchImportPreview(importId: string): Promise<ImportPreview> {
  return authedRequest(endpoints.importById(importId), importPreviewSchema);
}
