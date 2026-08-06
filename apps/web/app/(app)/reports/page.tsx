import { currentMonth, formatMonth, month as parseMonth } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BudgetMeter } from '../../../components/budget-meter';
import { CategoryBarChart } from '../../../components/charts/category-bar-chart';
import { TrendChart } from '../../../components/charts/trend-chart';
import { StatTile } from '../../../components/stat-tile';
import { sortedCategoryBars, trendSeries } from '../../../lib/chart';
import { money } from '../../../lib/format';
import { fetchMonthlyReport } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';

export const metadata: Metadata = { title: 'Reports' };

/**
 * One month, in full, with the months around it for context.
 *
 * The whole page is a single `GET /reports/monthly`. That is the API's design and
 * not an accident of this file: totals, trend, by-category and budget status are
 * four rollups over the same window, the API computes them together behind one
 * versioned cache entry, and asking for them separately would run the same index
 * scan four times and let the four answers disagree with each other by whatever
 * was written in between.
 *
 * **`report.budgets` is filtered to `report.month` here, and that is load-bearing.**
 * The API returns budget statuses for the *whole trailing window* -- deliberately,
 * because `planAlerts` is written to narrow a window down rather than to trust its
 * caller -- so a twelve-month report carries twelve statuses per budget, one per
 * month. Rendering them unfiltered gives twelve meters for one budget and, worse,
 * twelve React children keyed on the same `budgetId`. Duplicate keys make React
 * reuse the wrong node when the month changes, so a meter can keep the previous
 * month's fill while showing the new month's number.
 *
 * The month and the window both live in the URL, so this view is shareable and
 * the back button walks it. `searchParams` is a plain object in Next 14, not a
 * promise; awaiting it yields an object whose every property is undefined, which
 * reads here as "current month, twelve back" and silently ignores what was asked
 * for.
 */

/** The windows the picker offers. Every one is inside the contract's 1..36 cap. */
const WINDOWS = [6, 12, 24, 36] as const;

const DEFAULT_WINDOW = 12;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };

  const requestedMonth = searchParams.month;
  // Resolved against the *reader's* zone, not the server's. On the first of the
  // month a server in UTC and a reader in Madrid disagree for an hour about which
  // month it is, and the whole page would be about the wrong one.
  const month =
    typeof requestedMonth === 'string' && /^\d{4}-\d{2}$/.test(requestedMonth)
      ? requestedMonth
      : currentMonth(new Date(), user.timeZone);

  const requestedWindow = Number(searchParams.trailing);
  const trailing = WINDOWS.find((candidate) => candidate === requestedWindow) ?? DEFAULT_WINDOW;

  // The month is sent explicitly rather than left to the API's own default, so
  // the value in the picker and the month in the report can never drift apart.
  const report = await fetchMonthlyReport({ month, trailing });

  const monthLabel = formatMonth(parseMonth(report.month), user.locale);
  const points = trendSeries(report.trend, user.locale);
  const bars = sortedCategoryBars(report.byCategory);
  const budgets = report.budgets.filter((status) => status.month === report.month);
  const firstTrendMonth = report.trend[0];
  const windowLabel = firstTrendMonth
    ? `${formatMonth(parseMonth(firstTrendMonth.month), user.locale)} to ${monthLabel}`
    : monthLabel;

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>{monthLabel}</h1>
          <p>
            Every number on this page is {monthLabel} except the trend, which is the {trailing}{' '}
            months ending there.{' '}
            {report.cached
              ? 'These totals came from the cache.'
              : 'These totals were just computed.'}
          </p>
        </div>
        <Link className="btn" href={`/transactions?from=${report.month}-01`}>
          Open the ledger
        </Link>
      </div>

      <section className="card" aria-labelledby="pick-heading">
        <div className="card-head">
          <h2 id="pick-heading">Pick a month</h2>
          {/* A GET form, so the report is a URL: bookmarkable, shareable, and
              undone by the back button. Nothing here needs JavaScript. */}
          <form className="row" method="get" action="/reports">
            <div className="field">
              <label className="visually-hidden" htmlFor="report-month">
                Month to report on
              </label>
              <input id="report-month" name="month" type="month" defaultValue={report.month} />
            </div>
            <div className="field">
              <label className="visually-hidden" htmlFor="report-window">
                How many months of trend
              </label>
              <select id="report-window" name="trailing" defaultValue={String(trailing)}>
                {WINDOWS.map((window) => (
                  <option key={window} value={String(window)}>
                    {window} months of trend
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primary" type="submit">
              Show report
            </button>
          </form>
        </div>
      </section>

      <section className="grid-3" aria-label={`Totals for ${monthLabel}`}>
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

      <section className="card" aria-labelledby="trend-heading">
        <div className="card-head">
          <h2 id="trend-heading">Money in and out</h2>
          <p>{windowLabel}, including any month with nothing in it.</p>
        </div>
        <TrendChart
          points={points}
          format={format}
          caption={`Money in and money out, the ${trailing} months ending ${monthLabel}`}
        />
      </section>

      <section className="card" aria-labelledby="category-heading">
        <div className="card-head">
          <h2 id="category-heading">Where {monthLabel} went</h2>
          <p>
            Spending only. Uncategorised rows are a bar of their own rather than dropped, because
            they are the queue of work after an import.
          </p>
        </div>
        <CategoryBarChart
          bars={bars}
          format={format}
          caption={`Spending by category in ${monthLabel}`}
        />
      </section>

      <section className="card" aria-labelledby="budgets-heading">
        <div className="card-head">
          <h2 id="budgets-heading">Budgets in {monthLabel}</h2>
          <Link href={`/budgets?month=${report.month}`}>Manage budgets</Link>
        </div>
        {budgets.length === 0 ? (
          <p className="empty">
            No budget was in force in {monthLabel}. <Link href="/budgets">Set one</Link> and this
            month&apos;s spending appears here against it.
          </p>
        ) : (
          <div className="grid-2">
            {budgets.map((status) => (
              <BudgetMeter key={status.budgetId} status={status} format={format} headingLevel={3} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
