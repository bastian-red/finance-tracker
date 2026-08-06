import type { Category, Rule } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CategoryChip } from '../../../components/category-chip';
import { describeMatcher } from '../../../lib/matcher';
import { fetchCategories, fetchRules, fetchTransactions } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';
import { CreateRuleForm, EditRuleForm } from './rule-forms';

export const metadata: Metadata = { title: 'Rules' };

/**
 * The categorisation rules, in the order the engine runs them.
 *
 * **The order is the screen.** `services/categorize/src/engine.ts` walks rules by
 * `(priority, id)` and stops at the first match, so a rule's position is not a
 * display preference: a broad `contains "amazon"` at priority 0 makes every
 * narrower Amazon rule below it dead code. A list sorted by name would hide that
 * completely. This one is sorted the way the engine reads it and numbers each row,
 * so "why did this land in Shopping?" has an answer you can point at.
 *
 * **Sample descriptions come from the user's own ledger, not from a fixture.** The
 * rule tester in `lib/matcher.ts` is only convincing if it runs against text the
 * reader recognises, and the thing it exists to reveal -- that the engine matches
 * the *normalised* description, so `MERCADONA 4023 MADRID` is `mercadona madrid`
 * and a pattern containing `\d{4}` can never fire -- is invisible against invented
 * samples. One page of transactions is enough and it is a read this app already
 * knows how to do.
 *
 * Inactive rules stay in the list rather than moving to a section of their own.
 * An inactive rule still occupies its priority, still has to be scrolled past to
 * understand the ones after it, and hiding it is how somebody spends ten minutes
 * wondering why priority 20 is missing.
 */

/** Priority first, then id, exactly as `compileRules` orders them. */
function inEngineOrder(rules: readonly Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The distinct descriptions to test patterns against, most recent first.
 *
 * Deduplicated because a ledger is repetitive: forty rows of the same supermarket
 * teach nothing that one row does not, and the tester's value is breadth. Capped
 * because every sample is a regex execution on every keystroke in the form.
 */
function sampleDescriptions(descriptions: readonly string[], limit = 12): string[] {
  const seen = new Set<string>();
  for (const description of descriptions) {
    if (seen.size >= limit) break;
    if (description.trim() !== '') seen.add(description);
  }
  return [...seen];
}

function categoryOf(categories: readonly Category[], categoryId: string): Category | undefined {
  return categories.find((category) => category.id === categoryId);
}

export default async function RulesPage(): Promise<JSX.Element> {
  const user = await requireUser();

  // Issued together: none of the three depends on another. The transaction read
  // is a single page and exists only to feed the tester's samples.
  const [rules, categories, page] = await Promise.all([
    fetchRules(),
    fetchCategories(),
    fetchTransactions({ limit: 50 }),
  ]);

  const ordered = inEngineOrder(rules);
  const samples = sampleDescriptions(page.items.map((item) => item.description));
  const expenseCategories = categories.filter((category) => category.kind === 'expense');
  const activeCount = ordered.filter((rule) => rule.active).length;

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Rules</h1>
          <p>
            Every imported row is tested against these in order, top to bottom, and takes the
            category of the first one that matches. Changing a rule affects the next import; rows
            already in the ledger keep the category they have.
          </p>
        </div>
        <Link className="btn" href="/import">
          Import a statement
        </Link>
      </div>

      <section className="card" aria-labelledby="new-rule-heading">
        <div className="card-head">
          <h2 id="new-rule-heading">Add a rule</h2>
          <p>
            {activeCount} of {ordered.length} {ordered.length === 1 ? 'rule is' : 'rules are'}{' '}
            active.
          </p>
        </div>

        {expenseCategories.length === 0 && categories.length === 0 ? (
          <p className="empty">
            A rule files a transaction into a category, so there has to be one first.{' '}
            <Link href="/categories">Add a category</Link>.
          </p>
        ) : (
          <CreateRuleForm
            categories={categories}
            samples={samples}
            currency={user.currency}
            locale={user.locale}
            defaultPriority={(ordered[ordered.length - 1]?.priority ?? -10) + 10}
          />
        )}
      </section>

      <section className="card" aria-labelledby="rules-heading">
        <div className="card-head">
          <h2 id="rules-heading">In the order they run</h2>
          <p>
            Lower priority runs first. A rule that matches stops the search, so a broad rule near
            the top can leave every narrower rule below it unreachable.
          </p>
        </div>

        {ordered.length === 0 ? (
          <p className="empty">
            No rules yet. Everything imported arrives uncategorised and can be filed by hand from
            the ledger.
          </p>
        ) : (
          <ol className="stack">
            {ordered.map((rule, index) => {
              const category = categoryOf(categories, rule.categoryId);
              return (
                <li className="card" key={rule.id}>
                  <div className="card-head">
                    <h3>
                      <span className="num">{index + 1}.</span>{' '}
                      {category ? (
                        <CategoryChip name={category.name} colorSlot={category.colorSlot} />
                      ) : (
                        'Unknown category'
                      )}
                    </h3>
                    <p>
                      Priority <span className="num">{rule.priority}</span>,{' '}
                      {describeMatcher(rule.matcher)}.{' '}
                      {rule.active ? (
                        <span className="state state-income">
                          <span aria-hidden="true" className="state-glyph">
                            +
                          </span>
                          Active
                        </span>
                      ) : (
                        <span className="state state-neutral">
                          <span aria-hidden="true" className="state-glyph">
                            &minus;
                          </span>
                          Paused
                        </span>
                      )}
                    </p>
                  </div>

                  <EditRuleForm
                    rule={rule}
                    categories={categories}
                    samples={samples}
                    currency={user.currency}
                    locale={user.locale}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
