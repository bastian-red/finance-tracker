import { healthSchema } from '@fin/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PUBLIC_API_BASE_URL } from '../../../lib/config';
import { endpoints } from '../../../lib/endpoints';
import { authedRequest, requireUser } from '../../../lib/session';
import { uptimeLabel, viewOfFailure, viewOfHealth, type StatusView } from '../../../lib/status';

export const metadata: Metadata = { title: 'Status' };

/**
 * The service status page, fed by the same `/health` a monitor would poll.
 *
 * **This is the one page in the app that catches its own errors, and the reason
 * is the page's whole purpose.** Everywhere else a failed read belongs in the
 * route's error boundary with its status intact: a ledger that cannot reach the
 * API has nothing true to render. Here the opposite holds. A status page that
 * throws when the thing it reports on is down is a status page that only works
 * when it is not needed, which is the same failure as a green health check with a
 * dead database behind it.
 *
 * So the fetch is wrapped, and an unreachable API is *content*: the page renders,
 * says the API did not answer, and prints the error's own sentence. That is not a
 * loosening of the rule the other pages state, it is the exception the rule is
 * written against.
 *
 * **`/health` decides the status code, not this page.** The endpoint answers 200
 * when every dependency responded and 503 when one did not, because the default
 * configuration of every uptime checker is "is it 2xx". `lib/api.ts` turns the 503
 * into an `ApiError` carrying the body, so a degraded API arrives here as a throw
 * whose per-check detail is still readable.
 *
 * **The classification lives in `lib/status.ts`, not here.** Three states, not
 * two: "Redis is down" and "the API is down" send an operator to two different
 * places. A server component's fetch happens inside the Next process, where
 * Playwright cannot intercept it, so the two failure branches are only provable
 * as a pure function -- `lib/status.test.ts` drives all three, and an e2e test
 * claiming to cover them would pass whether or not they existed.
 *
 * `force-dynamic`, because a cached status page is a lie with a timestamp on it.
 * `lib/api.ts` already sends `cache: 'no-store'` on every request; this stops
 * Next from prerendering the *route* at build time, which would freeze whatever
 * the API happened to say while the image was being built.
 */
export const dynamic = 'force-dynamic';

async function probe(): Promise<StatusView> {
  try {
    return viewOfHealth(await authedRequest(endpoints.health, healthSchema));
  } catch (error) {
    return viewOfFailure(error);
  }
}

/** The glyph, the word and the class for a check's result. Colour is third. */
function checkLabel(status: 'ok' | 'fail'): { glyph: string; word: string; className: string } {
  return status === 'ok'
    ? { glyph: '✓', word: 'Responding', className: 'state-income' }
    : { glyph: '✕', word: 'Not responding', className: 'state-exceeded' };
}

export default async function StatusPage(): Promise<JSX.Element> {
  // Awaited *before* the probe, and outside its try, on purpose. `authedRequest`
  // calls `requireUser()` itself, and `requireUser` redirects by throwing
  // `NEXT_REDIRECT`; reaching it for the first time from inside the catch below
  // would swallow the navigation and render this page for an anonymous visitor.
  // Calling it here means the session is already settled by the time anything is
  // wrapped.
  await requireUser();
  const view = await probe();
  const health = view.kind === 'unreachable' ? null : view.health;

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>Status</h1>
          <p>
            The same <code>/health</code> a monitor would poll, read live. Each check is a real
            round trip to the dependency, not a look at a connection object: a green tick here means
            the query returned.
          </p>
        </div>
        <Link className="btn" href={`${PUBLIC_API_BASE_URL}${endpoints.health}`}>
          Raw JSON
        </Link>
      </div>

      {view.kind !== 'ok' ? (
        <section className="card" aria-labelledby="problem-heading">
          <div className="card-head">
            <h2 id="problem-heading">
              <span className="state state-exceeded">
                <span aria-hidden="true" className="state-glyph">
                  {view.kind === 'unreachable' ? '✕' : '▲'}
                </span>
                {view.kind === 'unreachable' ? 'The API did not answer' : 'Degraded'}
              </span>
            </h2>
          </div>
          <p>{view.message}</p>
          <p className="tile-note">
            {view.kind === 'unreachable'
              ? 'Nothing answered at all, which is a different problem from a dependency being down: the API process itself is not running or is not reachable at the configured base URL.'
              : 'The API is running and reported the problem itself, so the detail below is its own.'}
          </p>
          <p className="tile-note">
            Nothing in this portfolio is deployed, so this is what a local stack that is not fully
            up looks like. Start the datastores with{' '}
            <code>docker compose -f infra/docker-compose.yml up -d</code> and the app with{' '}
            <code>pnpm dev</code>.
          </p>
        </section>
      ) : null}

      {health === null ? null : (
        <>
          <section className="grid-3" aria-label="Service summary">
            <div className="card">
              <span className="tile-label">Overall</span>
              <span className="tile-value">
                <span
                  className={`state ${health.status === 'ok' ? 'state-income' : 'state-exceeded'}`}
                >
                  <span aria-hidden="true" className="state-glyph">
                    {health.status === 'ok' ? '✓' : '▲'}
                  </span>
                  {health.status === 'ok' ? 'All checks passed' : 'Degraded'}
                </span>
              </span>
              <span className="tile-note">
                {health.status === 'ok'
                  ? 'Every dependency answered.'
                  : 'At least one dependency did not answer. The endpoint returns 503 in this state.'}
              </span>
            </div>

            <div className="card">
              <span className="tile-label">API version</span>
              <span className="tile-value num">{health.version}</span>
              <span className="tile-note">From APP_VERSION, or the package version.</span>
            </div>

            <div className="card">
              <span className="tile-label">Uptime</span>
              <span className="tile-value num">{uptimeLabel(health.uptimeSeconds)}</span>
              <span className="tile-note">Since the API process started.</span>
            </div>
          </section>

          <section className="card" aria-labelledby="checks-heading">
            <div className="card-head">
              <h2 id="checks-heading">Dependencies</h2>
              <p>
                {health.checks.length} {health.checks.length === 1 ? 'check' : 'checks'}, each timed
                on this request.
              </p>
            </div>

            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">
                  Every dependency the API checks, its result and how long the round trip took
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Dependency</th>
                    <th scope="col">Result</th>
                    <th className="right" scope="col">
                      Round trip
                    </th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {health.checks.map((check) => {
                    const label = checkLabel(check.status);
                    return (
                      <tr key={check.name}>
                        <th scope="row">{check.name}</th>
                        <td>
                          <span className={`state ${label.className}`}>
                            <span aria-hidden="true" className="state-glyph">
                              {label.glyph}
                            </span>
                            {label.word}
                          </span>
                        </td>
                        <td className="right">
                          <span className="num">{check.latencyMs}</span> ms
                        </td>
                        <td>{check.detail ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
