/**
 * The contract between `apps/web` and `apps/api`.
 *
 * Both sides import these schemas; neither side reaches into the other's
 * internals. The API validates requests with them and the web app parses
 * responses with them, which means a field renamed on one side fails a typecheck
 * on the other rather than rendering `undefined` in production.
 *
 * Two shapes recur and are deliberate:
 *
 * - **Amounts cross the wire as integer minor units**, named `amountMinor`, never
 *   as `12.34`. JSON has one number type and it is a double; `12.34` survives the
 *   round trip today and `0.1 + 0.2` does not survive being added to anything.
 *   The `Minor` brand cannot survive JSON, so the schemas validate
 *   `int().safe()` and the caller re-brands with `minor()` at the boundary.
 * - **Days cross as `YYYY-MM-DD` strings**, never as `Date`. `JSON.stringify(new
 *   Date('2026-03-01'))` is an instant in UTC, and reading it back in a browser
 *   in Santiago gives 28 February. See `time/day.ts`.
 */
import { z } from 'zod';

/** `YYYY-MM-DD`. The regex is the cheap half; `day()` rejects 31 February. */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar day, YYYY-MM-DD');

export const calendarMonthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'Expected a calendar month, YYYY-MM');

/**
 * An amount in minor units.
 *
 * The ceiling is the signed 32-bit range because that is what the `amount_minor`
 * column is: ±21.47 million euros in a single transaction. Rejecting at the edge
 * of the contract gives a 400 with a readable message instead of a Postgres
 * "integer out of range" 500 three layers down.
 */
export const amountMinorSchema = z
  .number()
  .int('Amounts are integer minor units (cents), never decimals')
  .min(-2_147_483_648)
  .max(2_147_483_647);

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected a three-letter ISO 4217 code');

export const idSchema = z.string().min(1);

// --- Auth ------------------------------------------------------------------

export const credentialsSchema = z.object({
  email: z.string().email().max(320),
  // Length only. A composition rule ("one symbol, one digit") measurably pushes
  // people toward `Password1!`, and NIST 800-63B has recommended against them
  // since 2017. Length is the property that matters.
  password: z.string().min(10).max(200),
});

export const signupSchema = credentialsSchema.extend({
  name: z.string().min(1).max(120),
  locale: z.string().min(2).max(35).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  currency: currencySchema.optional(),
});

export const sessionUserSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  name: z.string(),
  locale: z.string(),
  timeZone: z.string(),
  currency: currencySchema,
});

// --- Accounts --------------------------------------------------------------

export const accountKindSchema = z.enum(['checking', 'savings', 'card', 'cash']);

export const accountSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  kind: accountKindSchema,
  currency: currencySchema,
  balanceMinor: amountMinorSchema,
  archived: z.boolean(),
});

export const createAccountSchema = z.object({
  name: z.string().min(1).max(80),
  kind: accountKindSchema,
  currency: currencySchema.optional(),
  openingBalanceMinor: amountMinorSchema.optional(),
});

// --- Categories ------------------------------------------------------------

export const categoryKindSchema = z.enum(['income', 'expense']);

export const categorySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  kind: categoryKindSchema,
  colorSlot: z.number().int().min(0),
});

export const createCategorySchema = categorySchema.omit({ id: true }).partial({ colorSlot: true });

// --- Rules -----------------------------------------------------------------

/**
 * How a rule decides whether it applies.
 *
 * `contains` is what almost every rule is, and it is what the UI offers first.
 * `regex` exists because bank descriptions are machine-generated and sometimes
 * need one; it is compiled with a length cap and no backreferences (see
 * services/categorize) so a user cannot paste a catastrophic pattern and hang
 * their own import.
 */
export const matcherSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('contains'), value: z.string().min(1).max(120) }),
  z.object({ type: z.literal('equals'), value: z.string().min(1).max(120) }),
  z.object({ type: z.literal('startsWith'), value: z.string().min(1).max(120) }),
  z.object({ type: z.literal('regex'), value: z.string().min(1).max(200) }),
]);

export const ruleSchema = z.object({
  id: idSchema,
  categoryId: idSchema,
  matcher: matcherSchema,
  /** Lower runs first. Ties break on id so the outcome never depends on row order. */
  priority: z.number().int().min(0).max(10_000),
  /** Optional amount window, in minor units, inclusive. */
  minAmountMinor: amountMinorSchema.nullable(),
  maxAmountMinor: amountMinorSchema.nullable(),
  active: z.boolean(),
});

export const createRuleSchema = ruleSchema.omit({ id: true }).partial({
  priority: true,
  minAmountMinor: true,
  maxAmountMinor: true,
  active: true,
});

// --- Transactions ----------------------------------------------------------

/**
 * Where a transaction's category came from.
 *
 * Stored rather than inferred, because it decides who wins. Re-running the rule
 * engine over the ledger must never overwrite a category a human chose by hand;
 * without this column the only way to know is to guess.
 */
export const categorySourceSchema = z.enum(['manual', 'rule', 'none']);

export const transactionSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  bookedOn: calendarDaySchema,
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  description: z.string().max(300),
  merchant: z.string().max(120).nullable(),
  categoryId: idSchema.nullable(),
  categorySource: categorySourceSchema,
  notes: z.string().max(1000).nullable(),
  importId: idSchema.nullable(),
});

export const createTransactionSchema = z.object({
  accountId: idSchema,
  bookedOn: calendarDaySchema,
  amountMinor: amountMinorSchema,
  description: z.string().min(1).max(300),
  categoryId: idSchema.nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const updateTransactionSchema = createTransactionSchema.partial().omit({ accountId: true });

export const transactionQuerySchema = z.object({
  from: calendarDaySchema.optional(),
  to: calendarDaySchema.optional(),
  accountId: idSchema.optional(),
  categoryId: idSchema.optional(),
  /** `uncategorised` is a first-class filter: it is the queue of work after an import. */
  uncategorised: z.coerce.boolean().optional(),
  search: z.string().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const transactionPageSchema = z.object({
  items: z.array(transactionSchema),
  nextCursor: z.string().nullable(),
  totalMinor: amountMinorSchema,
});

// --- Budgets ---------------------------------------------------------------

/**
 * A budget is a limit for a category over a *range* of months, not for one month.
 *
 * "€400 of groceries a month, from January, until I change it" is what people
 * mean, and storing one row per month means a year of rows to edit when the
 * number changes. `effectiveTo` is null for "still in force". Two budgets for
 * the same category may never overlap; that is a database constraint rather than
 * a service check, because two browser tabs can both pass a service check.
 */
export const budgetSchema = z.object({
  id: idSchema,
  categoryId: idSchema,
  limitMinor: amountMinorSchema.refine((value) => value > 0, 'A budget limit must be positive'),
  effectiveFrom: calendarMonthSchema,
  effectiveTo: calendarMonthSchema.nullable(),
});

export const createBudgetSchema = budgetSchema.omit({ id: true }).partial({ effectiveTo: true });

/** A budget resolved against one month, with what has actually been spent. */
export const budgetStatusSchema = z.object({
  budgetId: idSchema,
  categoryId: idSchema,
  categoryName: z.string(),
  colorSlot: z.number().int(),
  month: calendarMonthSchema,
  limitMinor: amountMinorSchema,
  /** Positive: money out. The ledger stores expenses negative; this is the absolute. */
  spentMinor: amountMinorSchema,
  /** Integer basis points, so the progress bar never carries a float. */
  usedBasisPoints: z.number().int(),
  state: z.enum(['under', 'approaching', 'exceeded']),
});

/**
 * The query behind `GET /budgets/status`.
 *
 * One month, and the month is optional: the budgets screen opens on "now", and
 * "now" is the server's month rather than the browser's. A client-supplied
 * default would make the page show August to a reader in Madrid and July to the
 * same reader on a laptop still set to UTC-11 at 23:30 local, for the same
 * ledger. The API resolves the default from its own clock and echoes back which
 * month it used inside every status row.
 */
export const budgetStatusQuerySchema = z.object({
  month: calendarMonthSchema.optional(),
});

// --- Reports ---------------------------------------------------------------

export const monthlyTotalsSchema = z.object({
  month: calendarMonthSchema,
  incomeMinor: amountMinorSchema,
  expenseMinor: amountMinorSchema,
  netMinor: amountMinorSchema,
});

export const categoryTotalSchema = z.object({
  categoryId: idSchema.nullable(),
  categoryName: z.string(),
  colorSlot: z.number().int(),
  amountMinor: amountMinorSchema,
  shareBasisPoints: z.number().int(),
});

export const monthlyReportSchema = z.object({
  month: calendarMonthSchema,
  currency: currencySchema,
  totals: monthlyTotalsSchema,
  /** Dense: every month in the window, including the ones with no rows. */
  trend: z.array(monthlyTotalsSchema),
  byCategory: z.array(categoryTotalSchema),
  budgets: z.array(budgetStatusSchema),
  /** Where the numbers came from, so a stale dashboard is diagnosable. */
  cached: z.boolean(),
  generatedAt: z.string(),
});

export const reportQuerySchema = z.object({
  month: calendarMonthSchema.optional(),
  trailing: z.coerce.number().int().min(1).max(36).default(12),
});

// --- Import ----------------------------------------------------------------

export const importStatusSchema = z.enum(['pending', 'ready', 'committed', 'failed']);

export const importRowStatusSchema = z.enum(['new', 'duplicate', 'error']);

export const detectedFormatSchema = z.object({
  delimiter: z.string().length(1),
  decimal: z.enum(['.', ',']),
  /** Why the decimal separator was chosen. Shown to the reader; see money/parse.ts. */
  decimalReason: z.string(),
  decimalAmbiguous: z.boolean(),
  dateFormat: z.string(),
  encoding: z.string(),
  columns: z.object({
    date: z.number().int(),
    description: z.number().int(),
    amount: z.number().int(),
    /** Some banks split debit and credit into two columns instead of signing one. */
    credit: z.number().int().nullable(),
    balance: z.number().int().nullable(),
  }),
});

export const importPreviewRowSchema = z.object({
  lineNumber: z.number().int(),
  status: importRowStatusSchema,
  message: z.string().nullable(),
  bookedOn: calendarDaySchema.nullable(),
  amountMinor: amountMinorSchema.nullable(),
  description: z.string(),
  suggestedCategoryId: idSchema.nullable(),
  /** Which rule matched, in words. An unexplained auto-category is not trusted. */
  suggestedBy: z.string().nullable(),
  duplicateOfId: idSchema.nullable(),
});

export const importPreviewSchema = z.object({
  importId: idSchema,
  filename: z.string(),
  accountId: idSchema,
  format: detectedFormatSchema,
  status: importStatusSchema,
  counts: z.object({
    total: z.number().int(),
    new: z.number().int(),
    duplicate: z.number().int(),
    error: z.number().int(),
  }),
  rows: z.array(importPreviewRowSchema),
});

export const commitImportSchema = z.object({
  /**
   * Line numbers to leave out of the commit.
   *
   * Applied exactly as sent; an absent list commits everything the parser could
   * read, duplicates included. Pre-ticking the duplicates is the *form's* job,
   * not the server's: a person looking at two identical coffees on the same
   * afternoon is allowed to decide both are real, and a server that filtered
   * duplicates on their behalf would give them no way to say so.
   */
  skipLines: z.array(z.number().int()).max(20_000).default([]),
});

export const commitResultSchema = z.object({
  importId: idSchema,
  imported: z.number().int(),
  skipped: z.number().int(),
  categorised: z.number().int(),
});

// --- Alerts ----------------------------------------------------------------

export const alertSchema = z.object({
  id: idSchema,
  budgetId: idSchema,
  categoryName: z.string(),
  month: calendarMonthSchema,
  level: z.enum(['approaching', 'exceeded']),
  limitMinor: amountMinorSchema,
  spentMinor: amountMinorSchema,
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

// --- Health ----------------------------------------------------------------

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'fail']),
      latencyMs: z.number(),
      detail: z.string().nullable(),
    }),
  ),
});

// --- Inferred types --------------------------------------------------------

export type Credentials = z.infer<typeof credentialsSchema>;
export type Signup = z.infer<typeof signupSchema>;
export type SessionUser = z.infer<typeof sessionUserSchema>;
export type AccountKind = z.infer<typeof accountKindSchema>;
export type Account = z.infer<typeof accountSchema>;
export type CreateAccount = z.infer<typeof createAccountSchema>;
export type Category = z.infer<typeof categorySchema>;
export type CreateCategory = z.infer<typeof createCategorySchema>;
export type Matcher = z.infer<typeof matcherSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type CreateRule = z.infer<typeof createRuleSchema>;
export type CategorySource = z.infer<typeof categorySourceSchema>;
export type Transaction = z.infer<typeof transactionSchema>;
export type CreateTransaction = z.infer<typeof createTransactionSchema>;
export type UpdateTransaction = z.infer<typeof updateTransactionSchema>;
export type TransactionQuery = z.infer<typeof transactionQuerySchema>;
export type TransactionPage = z.infer<typeof transactionPageSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type CreateBudget = z.infer<typeof createBudgetSchema>;
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;
export type BudgetStatusQuery = z.infer<typeof budgetStatusQuerySchema>;
export type MonthlyTotals = z.infer<typeof monthlyTotalsSchema>;
export type CategoryTotal = z.infer<typeof categoryTotalSchema>;
export type MonthlyReport = z.infer<typeof monthlyReportSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type ImportStatus = z.infer<typeof importStatusSchema>;
export type ImportRowStatus = z.infer<typeof importRowStatusSchema>;
export type DetectedFormat = z.infer<typeof detectedFormatSchema>;
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export type CommitImport = z.infer<typeof commitImportSchema>;
export type CommitResult = z.infer<typeof commitResultSchema>;
export type Alert = z.infer<typeof alertSchema>;
export type Health = z.infer<typeof healthSchema>;
