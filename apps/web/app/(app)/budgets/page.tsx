import {
  currentMonth,
  exponentOf,
  formatMonth,
  minor,
  month as parseMonth,
  toDecimalString,
} from '@fin/shared';
import type { Metadata } from 'next';
import { BudgetMeter } from '../../../components/budget-meter';
import { CategoryChip } from '../../../components/category-chip';
import { categoryIndex } from '../../../lib/lookup';
import { fetchBudgets, fetchBudgetStatuses, fetchCategories } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';
import { CreateBudgetForm, EditBudgetForm } from './budget-forms';

export const metadata: Metadata = { title: 'Budgets' };

/**
 * Budgets, and how this month is going against them.
 *
 * `searchParams.month` lets the page look at an earlier month, which is the only
 * way to check whether a limit was ever right. It defaults to the current month
 * **in the user's own time zone**, not the server's: on the first of the month a
 * server in UTC and a reader in Madrid disagree about which month it is for an
 * hour, and the whole page would be about the wrong one.
 */
export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };

  const requested = searchParams.month;
  const month =
    typeof requested === 'string' && /^\d{4}-\d{2}$/.test(requested)
      ? requested
      : currentMonth(new Date(), user.timeZone);

  const [statuses, budgets, categories] = await Promise.all([
    fetchBudgetStatuses(month),
    fetchBudgets(),
    fetchCategories(),
  ]);

  const byId = categoryIndex(categories);
  const exponent = exponentOf(user.currency);
  const monthLabel = formatMonth(parseMonth(month), user.locale);

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Budgets</h1>
          <p>
            A budget is a limit for one category over a range of months, not for a single month. Two
            budgets for the same category may never overlap.
          </p>
        </div>
      </div>

      <section className="card" aria-labelledby="month-heading">
        <div className="card-head">
          <h2 id="month-heading">{monthLabel}</h2>
          {/* A GET form again: the month is in the URL, so this view is
              shareable and the back button walks the months. */}
          <form className="row" method="get" action="/budgets">
            <div className="field">
              <label className="visually-hidden" htmlFor="month">
                Month to show
              </label>
              <input id="month" name="month" type="month" defaultValue={month} />
            </div>
            <button className="btn" type="submit">
              Show month
            </button>
          </form>
        </div>

        {statuses.length === 0 ? (
          <p className="empty">No budget was in force in {monthLabel}.</p>
        ) : (
          <div className="grid-2">
            {statuses.map((status) => (
              <BudgetMeter key={status.budgetId} status={status} format={format} headingLevel={3} />
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="create-heading">
        <div className="card-head">
          <h2 id="create-heading">Add a budget</h2>
        </div>
        <CreateBudgetForm categories={categories} currency={user.currency} defaultMonth={month} />
      </section>

      <section className="card" aria-labelledby="all-heading">
        <div className="card-head">
          <h2 id="all-heading">Every budget</h2>
          <p>Including the ones that have ended.</p>
        </div>

        {budgets.length === 0 ? (
          <p className="empty">No budgets yet.</p>
        ) : (
          <ul className="stack">
            {budgets.map((budget) => {
              const category = byId.get(budget.categoryId);
              return (
                <li key={budget.id} className="card">
                  <div className="card-head">
                    {category ? (
                      <CategoryChip name={category.name} colorSlot={category.colorSlot} />
                    ) : (
                      <span className="chip">Category removed</span>
                    )}
                    <p>
                      {formatMonth(parseMonth(budget.effectiveFrom), user.locale)}
                      {budget.effectiveTo
                        ? ` to ${formatMonth(parseMonth(budget.effectiveTo), user.locale)}`
                        : ' onwards'}
                    </p>
                  </div>
                  <EditBudgetForm
                    budget={budget}
                    categoryName={category?.name ?? 'this category'}
                    currency={user.currency}
                    // The edit field's starting value is produced by slicing the
                    // integer's digits, never by dividing by 100. `2050 / 100`
                    // is exact and `409 / 100` is not, and a form that starts at
                    // 4.089999999999999 is a form that saves it.
                    limitMajor={toDecimalString(minor(budget.limitMinor), exponent)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
