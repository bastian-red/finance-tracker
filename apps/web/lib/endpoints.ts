import { toQueryString } from './query';

/**
 * Every path this app asks `apps/api` for, in one file.
 *
 * The shapes that cross the wire are frozen in
 * `packages/shared/src/contracts/index.ts` and both sides import them. The
 * *paths* are not in that file, because a URL is not a type and putting strings
 * in the contract would mean a route rename is a contract change. So they live
 * here instead, as one table, for one reason: the web app and the API are built
 * by two people at once, and a path that turns out to be wrong is then a
 * one-line fix in a file whose whole job is that list, rather than a grep across
 * twenty server components.
 *
 * The convention is the obvious REST one — a plural collection, an id segment
 * under it, a verb segment only where the operation is not a CRUD verb
 * (`/commit`, `/format`). Ids are percent-encoded even though they are cuids,
 * because "the id is always URL-safe" is an assumption about a column that
 * nothing in the contract enforces.
 */

const id = (value: string): string => encodeURIComponent(value);

export const endpoints = {
  /** Anonymous. The only two calls that carry no bearer token. */
  login: '/auth/login',
  signup: '/auth/signup',

  accounts: '/accounts',

  categories: '/categories',
  category: (categoryId: string): string => `/categories/${id(categoryId)}`,

  rules: '/rules',
  rule: (ruleId: string): string => `/rules/${id(ruleId)}`,

  transactions: (query: string = ''): string => `/transactions${query}`,
  transaction: (transactionId: string): string => `/transactions/${id(transactionId)}`,

  budgets: '/budgets',
  budget: (budgetId: string): string => `/budgets/${id(budgetId)}`,
  /** Budgets resolved against one month, with what has been spent so far. */
  budgetStatus: (month: string): string => `/budgets/status${toQueryString({ month })}`,

  monthlyReport: (query: { month?: string; trailing?: number }): string =>
    `/reports/monthly${toQueryString({ month: query.month, trailing: query.trailing })}`,

  imports: '/imports',
  importById: (importId: string): string => `/imports/${id(importId)}`,
  /** Re-parse an upload the detector read wrongly. See app/(app)/import. */
  importFormat: (importId: string): string => `/imports/${id(importId)}/format`,
  importCommit: (importId: string): string => `/imports/${id(importId)}/commit`,

  alerts: '/alerts',
  /** Marking one read. A verb segment, because it is not a CRUD verb. */
  alertRead: (alertId: string): string => `/alerts/${id(alertId)}/read`,
  health: '/health',
} as const;
