import { formatMonth, month as parseMonth, type Alert } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { budgetStateLabel, money, percentFromBasisPoints } from '../../../lib/format';
import { fetchAlerts } from '../../../lib/queries';
import { requireUser } from '../../../lib/session';
import { MarkRead } from './mark-read';

export const metadata: Metadata = { title: 'Alerts' };

/**
 * Every budget threshold this ledger has crossed.
 *
 * **Why a page exists when the alert is also an email.** The email is allowed to
 * fail. `AlertsService.evaluate` runs on the tail of a request whose database
 * write has already committed, it never throws, and when the SMTP channel refuses
 * the row is still written with `deliveredAt` null. A notification list that only
 * showed what a mail server accepted would go quiet during an outage without
 * saying so, which is the one time it matters. The row is the record; the email is
 * a delivery of it.
 *
 * **There is one alert per budget, per month, per level, forever.** That is
 * `@@unique([budgetId, month, level])` in Postgres, not a flag this app sets, so
 * the list cannot repeat itself no matter how many transactions land in an
 * over-budget category on a busy Saturday. It is also why nothing here paginates:
 * single-digit budgets times two levels times a handful of months is smaller than
 * one page of the ledger.
 *
 * **Only the current month raises one.** A backfilled transaction that pushes last
 * August over its limit does not mail anybody: the period is closed, nobody can
 * act on it, and every alert that was not needed makes the next real one less
 * likely to be read.
 *
 * Ordering is newest first, and read alerts stay in the list rather than
 * disappearing. An alert you have seen is still the answer to "when did this start
 * going wrong", and hiding it is how somebody loses that.
 */

/** Newest first, then by category so a month's alerts have a fixed order. */
function newestFirst(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.month.localeCompare(a.month) ||
      a.categoryName.localeCompare(b.categoryName),
  );
}

export default async function AlertsPage(): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };

  const alerts = newestFirst(await fetchAlerts());
  const unread = alerts.filter((alert) => alert.readAt === null);

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Alerts</h1>
          <p>
            Raised when spending in a category reaches 80% of its budget, and again when it passes
            it. One per budget per month per level, ever, so a busy afternoon cannot repeat one.
          </p>
        </div>
        <Link className="btn" href="/budgets">
          Manage budgets
        </Link>
      </div>

      <section className="card" aria-labelledby="alerts-heading">
        <div className="card-head">
          <h2 id="alerts-heading">
            {unread.length === 0
              ? `${alerts.length} ${alerts.length === 1 ? 'alert' : 'alerts'}, all read`
              : `${unread.length} unread`}
          </h2>
          <p>
            An alert is also emailed. It is recorded here whether or not that email was accepted,
            which is what makes this list trustworthy during a mail outage.
          </p>
        </div>

        {alerts.length === 0 ? (
          <p className="empty">
            Nothing has crossed a budget yet. <Link href="/budgets">Set a budget</Link> and this
            fills in as spending approaches it.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <caption>
                Every budget threshold crossed, newest first. Read alerts stay in the list.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Category</th>
                  <th scope="col">Month</th>
                  <th className="right" scope="col">
                    Spent
                  </th>
                  <th className="right" scope="col">
                    Limit
                  </th>
                  <th scope="col">Seen</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => {
                  // The alert's own level maps onto the same vocabulary the meters
                  // use, so "Approaching" means the same word and the same glyph
                  // on both screens.
                  const state = budgetStateLabel(alert.level);
                  const percent = percentFromBasisPoints(
                    Math.round((alert.spentMinor / alert.limitMinor) * 10_000),
                  );
                  return (
                    <tr key={alert.id}>
                      <td>
                        <span className={`state ${state.className}`}>
                          <span aria-hidden="true" className="state-glyph">
                            {state.glyph}
                          </span>
                          {state.word}
                        </span>
                      </td>
                      <th scope="row">{alert.categoryName}</th>
                      <td>{formatMonth(parseMonth(alert.month), user.locale)}</td>
                      <td className="right">
                        <span className="num">{money(alert.spentMinor, format, 'never')}</span>{' '}
                        <span className="tile-note">({percent}%)</span>
                      </td>
                      <td className="right">
                        <span className="num">{money(alert.limitMinor, format, 'never')}</span>
                      </td>
                      <td>
                        {/* A word, not a bolder row. Weight is not a channel a
                            reader can name, and "unread" is a state. */}
                        {alert.readAt === null ? (
                          <span className="state state-approaching">
                            <span aria-hidden="true" className="state-glyph">
                              &#9679;
                            </span>
                            New
                          </span>
                        ) : (
                          <span className="state state-neutral">
                            <span aria-hidden="true" className="state-glyph">
                              &#10003;
                            </span>
                            Read
                          </span>
                        )}
                      </td>
                      <td>
                        {alert.readAt === null ? (
                          <MarkRead
                            alertId={alert.id}
                            label={`${state.word}, ${alert.categoryName}, ${alert.month}`}
                          />
                        ) : null}
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
