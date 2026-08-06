import { expect, test } from '../fixtures/app';

/**
 * The status page, and the one thing it exists to survive.
 *
 * A status page that throws when the thing it reports on is down only works when
 * it is not needed, which is the same failure as a green health check with a dead
 * database behind it. What this file covers is the happy path against the real
 * stack: the checks the API actually runs, timed, named and readable.
 *
 * The two failure branches -- degraded, and unreachable -- are **not** tested
 * here, and that is deliberate rather than an omission. This page is a server
 * component: its fetch happens inside the Next process, where `page.route`
 * cannot reach it, so a browser cannot make the API look down to it. A spec that
 * claimed to cover them would pass whether or not they existed. The
 * classification is a pure function in `apps/web/lib/status.ts` and
 * `status.test.ts` drives all three states directly.
 */
test.describe('status', () => {
  test('reports every dependency the API checks, with a real round trip', async ({
    signedIn: page,
  }) => {
    await page.goto('/status');
    await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();

    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    // The two the health endpoint actually probes. Naming them beats counting
    // rows: a page that rendered an empty table would pass a count of zero.
    await expect(table.getByRole('rowheader', { name: 'postgres' })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'redis' })).toBeVisible();

    // A latency, because a check that reports no time did not run.
    await expect(table.getByText(/\d+\s*ms/).first()).toBeVisible();

    // Result as a word, not only a colour. Same rule as every other state here.
    await expect(table.getByText('Responding').first()).toBeVisible();
  });

  test('summarises the version and the uptime', async ({ signedIn: page }) => {
    await page.goto('/status');
    await expect(page.getByText('All checks passed')).toBeVisible();
    await expect(page.getByText('API version')).toBeVisible();
    await expect(page.getByText('Uptime')).toBeVisible();
    // Formatted by integer division, never by date arithmetic: `0m 12s`, `3h 4m`.
    await expect(page.getByText(/^\d+[dhm] \d+[hms]/).first()).toBeVisible();
  });

  test('is reachable from the footer of every signed-in page', async ({ signedIn: page }) => {
    // The footer is where an operator looks, and it is the only entry point:
    // /status is deliberately not in the nav, because it is not a daily
    // destination.
    await page.goto('/transactions');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Service status' }).click();
    await expect(page).toHaveURL(/\/status/);
  });

  test('is a page, not a link to raw JSON', async ({ signedIn: page }) => {
    // The regression this guards. An earlier footer linked `/health` directly and
    // argued a page was unnecessary because nothing here is deployed; that had it
    // backwards. With no public URL and no uptime dashboard, a page a reader can
    // open is the only demonstration that this app knows whether its dependencies
    // are answering. The endpoint is still one click further on.
    await page.goto('/status');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Raw JSON' })).toBeVisible();
  });
});
