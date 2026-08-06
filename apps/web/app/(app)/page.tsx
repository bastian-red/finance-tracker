import {
  currentMonth,
  formatDay,
  formatMonth,
  day as parseDay,
  month as parseMonth,
} from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Amount, DirectionTag } from '../../components/amount';
import { BudgetMeter } from '../../components/budget-meter';
import { CategoryChip, UncategorisedChip } from '../../components/category-chip';
import { TrendChart } from '../../components/charts/trend-chart';
import { StatTile } from '../../components/stat-tile';
import { trendSeries } from '../../lib/chart';
import { money } from '../../lib/format';
import { categoryIndex } from '../../lib/lookup';
import {
  fetchAlerts,
  fetchCategories,
  fetchMonthlyReport,
  fetchTransactions,
} from '../../lib/queries';
import { requireUser } from '../../lib/session';

export const metadata: Metadata = { title: 'Dashboard' };

/** How many months the dashboard's trend shows. The reports page goes wider. */
const TREND_MONTHS = 6;

/** How many rows "Recent" is. Enough to recognise the month, short enough to scan. */
const RECENT_ROWS = 8;

/**
 * This month, at a glance.
 *
 * The three reads are issued together rather than awaited in sequence: they do
 * not depend on each other, and serialising them would make the page as slow as
 * their sum instead of as slow as the slowest.
 *
 * Nothing here is wrapped in a try/catch. `requireUser()` redirects by throwing
 * `NEXT_REDIRECT`, and a catch around it would swallow the navigation and render
 * this page for an anonymous visitor.
 */
export default async function DashboardPage(): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };

  const [report, recent, categories, alerts] = await Promise.all([
    fetchMonthlyReport({ trailing: TREND_MONTHS }),
    fetchTransactions({ limit: RECENT_ROWS }),
    fetchCategories(),
    fetchAlerts(),
  ]);

  const byId = categoryIndex(categories);
  const points = trendSeries(report.trend, user.locale);
  const thisMonth = formatMonth(parseMonth(report.month), user.locale);
  const viewing = currentMonth(new Date(), user.timeZone);

  /**
   * This month's budget statuses, and only this month's.
   *
   * `report.budgets` carries a status per budget **per month of the trailing
   * window**, deliberately: the API returns the whole window so `planAlerts` can
   * narrow it rather than trust its caller. Rendering it unfiltered on a screen
   * about one month gave twelve meters per budget — and, worse, twelve React
   * children keyed on the same `budgetId`, so React reuses the wrong node when
   * the month changes and a meter can keep the previous month's fill beside the
   * new month's number. `/reports` already filters for exactly this reason; this
   * screen did not.
   */
  const budgets = report.budgets.filter((status) => status.month === report.month);
  const unread = alerts.filter((alert) => alert.readAt === null).length;

  /**
   * The newest month in the window that actually has rows, when this one has none.
   *
   * Not a fallback in the data: the totals above stay this month's, because this
   * month's income really is zero and saying otherwise would be a lie about the
   * one number people open the app for. It is a pointer. A ledger whose first
   * screen is three zeroes with no explanation reads as broken, and the honest
   * reading -- "nothing has landed yet; here is where the numbers are" -- takes
   * one sentence and a link.
   */
  const lastActive = [...report.trend]
    .reverse()
    .find(
      (point) =>
        point.month !== report.month && (point.incomeMinor !== 0 || point.expenseMinor !== 0),
    );
  const nothingYet =
    report.totals.incomeMinor === 0 && report.totals.expenseMinor === 0 && lastActive !== undefined;

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>{thisMonth}</h1>
          <p>
            Everything below is this month unless it says otherwise.{' '}
            {report.cached
              ? 'These totals came from the cache.'
              : 'These totals were just computed.'}
          </p>
          {nothingYet && lastActive ? (
            <p className="tile-note">
              Nothing has landed in {thisMonth} yet.{' '}
              <Link href={`/reports?month=${lastActive.month}`}>
                See {formatMonth(parseMonth(lastActive.month), user.locale)}
              </Link>
              , the last month with transactions in it.
            </p>
          ) : null}
        </div>
        <Link className="btn" href={`/reports?month=${viewing}`}>
          Full report
        </Link>
      </div>

      <section className="grid-3" aria-label="This month's totals">
        <StatTile
          label="Money in"
          value={money(report.totals.incomeMinor, format, 'never')}
          note="Salary, refunds, transfers in."
        />
        <StatTile
          label="Money out"
          value={money(report.totals.expenseMinor, format, 'never')}
          note="Everything that left an account."
        />
        <StatTile
          label="Net"
          // `signDisplay: 'always'` so a positive month reads `+2.320,00 EUR`
          // rather than looking like an unsigned magnitude next to the two above.
          value={money(report.totals.netMinor, format, 'always')}
          note={
            report.totals.netMinor >= 0
              ? 'You kept money this month.'
              : 'You spent more than you earned.'
          }
        />
      </section>

      <section className="card" aria-labelledby="budgets-heading">
        <div className="card-head">
          <h2 id="budgets-heading">Budgets</h2>
          {/* The count is the only place an alert is discoverable from the screen
              people actually open, and it is a word beside a number rather than a
              red dot: a dot is a colour and a shape, and neither says how many. */}
          {unread === 0 ? (
            <Link href="/budgets">Manage budgets</Link>
          ) : (
            <Link href="/alerts">
              {unread} unread {unread === 1 ? 'alert' : 'alerts'}
            </Link>
          )}
        </div>
        {budgets.length === 0 ? (
          <p className="empty">
            No budgets yet. <Link href="/budgets">Set one</Link> and this month&apos;s spending
            appears here against it.
          </p>
        ) : (
          <div className="grid-2">
            {budgets.map((status) => (
              <BudgetMeter key={status.budgetId} status={status} format={format} />
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="trend-heading">
        <div className="card-head">
          <h2 id="trend-heading">Money in and out</h2>
          <p>The last {TREND_MONTHS} months, including any month with nothing in it.</p>
        </div>
        <TrendChart
          points={points}
          format={format}
          caption={`Money in and money out, the ${TREND_MONTHS} months ending ${thisMonth}`}
        />
      </section>

      <section className="card" aria-labelledby="recent-heading">
        <div className="card-head">
          <h2 id="recent-heading">Recent transactions</h2>
          <Link href="/transactions">See all transactions</Link>
        </div>
        {recent.items.length === 0 ? (
          <p className="empty">
            Nothing here yet. <Link href="/import">Import a statement</Link> to fill the ledger.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>The {recent.items.length} most recent rows in the ledger.</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Category</th>
                  <th scope="col">Direction</th>
                  <th className="right" scope="col">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.items.map((transaction) => {
                  const category = transaction.categoryId
                    ? byId.get(transaction.categoryId)
                    : undefined;
                  return (
                    <tr key={transaction.id}>
                      <td>{formatDay(parseDay(transaction.bookedOn), user.locale)}</td>
                      <th scope="row">{transaction.description}</th>
                      <td>
                        {category ? (
                          <CategoryChip name={category.name} colorSlot={category.colorSlot} />
                        ) : (
                          <UncategorisedChip />
                        )}
                      </td>
                      <td>
                        <DirectionTag amountMinor={transaction.amountMinor} />
                      </td>
                      <td className="right">
                        {/* The Direction column already says "In"/"Out" out loud,
                            so the amount does not repeat it for a screen reader. */}
                        <Amount
                          amountMinor={transaction.amountMinor}
                          format={format}
                          srDirection={false}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
