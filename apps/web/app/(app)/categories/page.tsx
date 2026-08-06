import type { Category } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CategoryChip } from '../../../components/category-chip';
import { firstFreeColorSlot } from '../../../lib/palette';
import { fetchBudgets, fetchCategories, fetchRules } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';
import { CreateCategoryForm, EditCategoryForm } from './category-forms';

export const metadata: Metadata = { title: 'Categories' };

/**
 * The taxonomy, and what depends on each line of it.
 *
 * The list is grouped by kind and the group is a heading rather than a column,
 * because "expense" and "income" are the two halves of a ledger and a reader
 * scanning for one of them should not have to read the other. Within a group the
 * order is the API's, which is by name.
 *
 * **Rules and budgets are read here purely to say what a delete would take with
 * it.** That costs two extra requests, issued alongside the categories read
 * rather than after it, and it buys the one thing this screen cannot otherwise
 * tell anybody: `categories.id` is `ON DELETE CASCADE` for both tables, so
 * removing "Transport" silently deletes the four rules that file things into it
 * and the budget that caps it. Transactions are the exception -- they are
 * `ON DELETE SET NULL` and move into the uncategorised queue -- and that
 * asymmetry is worth stating on screen rather than discovering afterwards.
 *
 * Nothing here is wrapped in a try/catch. `requireUser()` redirects by throwing
 * `NEXT_REDIRECT`, and a catch around it would swallow the navigation and render
 * this page for an anonymous visitor.
 */

/** "2 rules and 1 budget", or the empty string when nothing else goes. */
function alsoRemovedText(rules: number, budgets: number): string {
  const parts: string[] = [];
  if (rules > 0) parts.push(`${rules} ${rules === 1 ? 'rule' : 'rules'}`);
  if (budgets > 0) parts.push(`${budgets} ${budgets === 1 ? 'budget' : 'budgets'}`);
  return parts.join(' and ');
}

function tally(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export default async function CategoriesPage(): Promise<JSX.Element> {
  // Gates the page and redirects an anonymous visitor. Nothing on this screen is
  // an amount or a date, so the returned locale and currency are not needed.
  await requireUser();

  // Issued together rather than awaited in sequence: none of the three depends on
  // another, and serialising them makes the page as slow as their sum.
  const [categories, rules, budgets] = await Promise.all([
    fetchCategories(),
    fetchRules(),
    fetchBudgets(),
  ]);

  const rulesPerCategory = tally(rules.map((rule) => rule.categoryId));
  const budgetsPerCategory = tally(budgets.map((budget) => budget.categoryId));
  const nextSlot = firstFreeColorSlot(categories.map((category) => category.colorSlot));

  const groups: readonly { kind: Category['kind']; heading: string; blurb: string }[] = [
    {
      kind: 'expense',
      heading: 'Expense categories',
      blurb: 'Where money goes. These are the ones budgets and the monthly chart are about.',
    },
    {
      kind: 'income',
      heading: 'Income categories',
      blurb: 'Where money comes from. Budgets do not apply to these.',
    },
  ];

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Categories</h1>
          <p>
            Rename or delete any of them. Deleting one leaves its transactions in the ledger and
            marks them uncategorised; its rules and budgets are removed with it.
          </p>
        </div>
        <Link className="btn" href="/rules">
          Rules that use them
        </Link>
      </div>

      <section className="card" aria-labelledby="create-heading">
        <div className="card-head">
          <h2 id="create-heading">Add a category</h2>
          <p>{categories.length} so far.</p>
        </div>
        <CreateCategoryForm defaultColorSlot={nextSlot} />
      </section>

      {groups.map((group) => {
        const inGroup = categories.filter((category) => category.kind === group.kind);
        const headingId = `${group.kind}-heading`;
        return (
          <section className="card" aria-labelledby={headingId} key={group.kind}>
            <div className="card-head">
              <h2 id={headingId}>{group.heading}</h2>
              <p>{group.blurb}</p>
            </div>

            {inGroup.length === 0 ? (
              <p className="empty">Nothing here yet. Add one above.</p>
            ) : (
              <ul className="stack">
                {inGroup.map((category) => {
                  const ruleCount = rulesPerCategory.get(category.id) ?? 0;
                  const budgetCount = budgetsPerCategory.get(category.id) ?? 0;
                  return (
                    <li className="card" key={category.id}>
                      <div className="card-head">
                        <h3>
                          <CategoryChip name={category.name} colorSlot={category.colorSlot} />
                        </h3>
                        <p>
                          {ruleCount === 0
                            ? 'No rule files anything here.'
                            : `${ruleCount} ${ruleCount === 1 ? 'rule files' : 'rules file'} into it.`}{' '}
                          {budgetCount === 0
                            ? 'No budget caps it.'
                            : `${budgetCount} ${budgetCount === 1 ? 'budget caps' : 'budgets cap'} it.`}
                        </p>
                      </div>
                      <EditCategoryForm
                        category={category}
                        alsoRemoved={alsoRemovedText(ruleCount, budgetCount)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </>
  );
}
