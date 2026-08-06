import type { Account, Category } from '@fin/shared';
import type { TransactionFilters } from '../../../lib/query';

/**
 * The filter bar.
 *
 * A plain `<form method="get">` and no JavaScript at all. Submitting it navigates
 * to `/transactions?from=...&accountId=...`, which is exactly the URL the page
 * reads its filters back out of, so the filter state is the URL: it survives a
 * reload, it can be bookmarked, it can be sent to somebody, and the back button
 * undoes a filter the way a person expects. A client-side filter component would
 * have to reimplement all four.
 *
 * The one thing to be careful about is the checkbox, and it is careful by
 * construction: HTML omits an unchecked checkbox from the submission entirely. It
 * cannot send `uncategorised=false`, which matters more here than anywhere else
 * in the app, because `transactionQuerySchema.uncategorised` is
 * `z.coerce.boolean()` and `Boolean("false")` is `true` — the string "false"
 * would turn the filter **on**.
 *
 * `cursor` is deliberately not a field. Changing a filter has to start the
 * keyset walk again: a cursor is a position in one specific ordered result set,
 * and carrying it into a different filter produces a page from the middle of a
 * list the user is no longer looking at.
 */
export function Filters({
  accounts,
  categories,
  filters,
}: {
  accounts: readonly Account[];
  categories: readonly Category[];
  filters: TransactionFilters;
}): JSX.Element {
  return (
    <form className="card" method="get" action="/transactions">
      <div className="card-head">
        <h2>Filter</h2>
        <p>The filters live in the URL, so this view can be bookmarked.</p>
      </div>

      <div className="grid-3">
        <div className="field">
          <label htmlFor="filter-from">Booked from</label>
          <input id="filter-from" name="from" type="date" defaultValue={filters.from ?? ''} />
        </div>

        <div className="field">
          <label htmlFor="filter-to">Booked to</label>
          <input id="filter-to" name="to" type="date" defaultValue={filters.to ?? ''} />
        </div>

        <div className="field">
          <label htmlFor="filter-account">Account</label>
          <select id="filter-account" name="accountId" defaultValue={filters.accountId ?? ''}>
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-category">Category</label>
          <select id="filter-category" name="categoryId" defaultValue={filters.categoryId ?? ''}>
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="filter-search">Description contains</label>
          <input
            id="filter-search"
            name="search"
            type="search"
            maxLength={120}
            defaultValue={filters.search ?? ''}
          />
        </div>

        <div className="field">
          <label htmlFor="filter-uncategorised">
            <input
              id="filter-uncategorised"
              name="uncategorised"
              type="checkbox"
              value="true"
              defaultChecked={filters.uncategorised === true}
            />{' '}
            Only rows with no category
          </label>
          <span className="field-hint">The queue of work after an import.</span>
        </div>
      </div>

      <div className="row">
        <button className="btn btn-primary" type="submit">
          Apply filters
        </button>
        {/* A link rather than a reset button: reset would restore the values the
            form was rendered with, which are the filters already applied. */}
        <a className="btn" href="/transactions">
          Clear
        </a>
      </div>
    </form>
  );
}
