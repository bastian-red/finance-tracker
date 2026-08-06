import { formatDay, day as parseDay } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Amount, DirectionTag } from '../../../components/amount';
import { money } from '../../../lib/format';
import { accountIndex, accountName, categoryIndex } from '../../../lib/lookup';
import { readTransactionFilters, transactionQueryString } from '../../../lib/query';
import { fetchAccounts, fetchCategories, fetchTransactions } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';
import { Filters } from './filters';
import { Recategorise } from './recategorise';

export const metadata: Metadata = { title: 'Transactions' };

/**
 * The ledger.
 *
 * `searchParams` is a plain object here, **not** a promise. That changed in Next
 * 15; this app is on 14.2, and awaiting it would give a Promise object whose
 * properties are all undefined, which reads as "no filters applied" and silently
 * shows the unfiltered list.
 *
 * Pagination is keyset, not offset. `nextCursor` comes back opaque from the API
 * and is threaded into the next link untouched. The reason it is not
 * `?page=3` is that this list is ordered by booked date and rows are inserted
 * into the middle of it by every import: with an offset, importing a statement
 * while someone reads page 3 shifts every later row up and they see the same
 * transactions twice, or never.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };
  const filters = readTransactionFilters(searchParams);

  const [page, categories, accounts] = await Promise.all([
    fetchTransactions(filters),
    fetchCategories(),
    fetchAccounts(),
  ]);

  const byCategory = categoryIndex(categories);
  const byAccount = accountIndex(accounts);

  // The cursor is dropped from the "start again" link and carried in the "next"
  // one. Everything else about the filter stays identical between them.
  const { cursor: _current, ...withoutCursor } = filters;
  const nextHref = page.nextCursor
    ? `/transactions${transactionQueryString({ ...withoutCursor, cursor: page.nextCursor })}`
    : null;
  const firstHref = `/transactions${transactionQueryString(withoutCursor)}`;

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Transactions</h1>
          <p>
            Change a category from the table and it is marked as your choice, so re-running the
            rules will not overwrite it.
          </p>
        </div>
      </div>

      <Filters accounts={accounts} categories={categories} filters={filters} />

      <section className="card" aria-labelledby="ledger-heading">
        <div className="card-head">
          <h2 id="ledger-heading">
            {page.items.length} {page.items.length === 1 ? 'row' : 'rows'}
          </h2>
          <p>
            Net of everything matching this filter:{' '}
            <span className="num">{money(page.totalMinor, format, 'always')}</span>
          </p>
        </div>

        {page.items.length === 0 ? (
          <p className="empty">
            No transactions match this filter. <Link href="/transactions">Clear it</Link> or{' '}
            <Link href="/import">import a statement</Link>.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>The ledger, most recent first. Every amount is exact to the cent.</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Account</th>
                  <th scope="col">Category</th>
                  <th scope="col">Direction</th>
                  <th className="right" scope="col">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDay(parseDay(transaction.bookedOn), user.locale)}</td>
                    <th scope="row">
                      {transaction.description}
                      {transaction.categorySource === 'rule' && transaction.categoryId ? (
                        <span className="visually-hidden"> (category set by a rule)</span>
                      ) : null}
                    </th>
                    <td>{accountName(byAccount, transaction.accountId)}</td>
                    <td>
                      <Recategorise
                        transactionId={transaction.id}
                        description={transaction.description}
                        categories={categories}
                        selected={
                          transaction.categoryId && byCategory.has(transaction.categoryId)
                            ? transaction.categoryId
                            : ''
                        }
                      />
                    </td>
                    <td>
                      <DirectionTag amountMinor={transaction.amountMinor} />
                    </td>
                    <td className="right">
                      <Amount
                        amountMinor={transaction.amountMinor}
                        format={format}
                        srDirection={false}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <nav className="row" aria-label="Pagination">
          <Link className="btn" href={firstHref}>
            First page
          </Link>
          {nextHref ? (
            <Link className="btn" href={nextHref}>
              Next page
            </Link>
          ) : (
            <span className="tile-note">That is the end of this filter.</span>
          )}
        </nav>
      </section>
    </>
  );
}
