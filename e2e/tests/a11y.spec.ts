import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '../fixtures/app';

/**
 * axe over every route, in both colour schemes.
 *
 * **Both schemes, because the palette is not the same in each.** This project's
 * contrast gate parses the real stylesheet and checks every pair in light and
 * dark, and this is the runtime half of that: a token that clears AA on paper
 * and fails on the dark canvas is a real failure for a real reader, and running
 * one scheme finds it half the time.
 *
 * **Nothing here is wrapped in `aria-hidden`.** Recharts makes its surface
 * focusable, and hiding a subtree that contains a focusable element is itself a
 * WCAG failure -- it produces a tab stop a screen reader is told does not exist.
 * The charts carry a `<details>` table instead, which is asserted below.
 *
 * `BASELINE=1` records instead of failing. That mode exists for one purpose: to
 * capture the number a redesign starts from, because "the redesign improved
 * accessibility" is worth nothing without it, and once the stylesheet is
 * rewritten the old number is unrecoverable. `scripts/a11y-baseline.sh` sets it.
 */
const BASELINE = process.env.BASELINE === '1';

const ROUTES = [
  { path: '/', name: 'dashboard' },
  { path: '/transactions', name: 'transactions' },
  { path: '/budgets', name: 'budgets' },
  { path: '/reports', name: 'reports' },
  { path: '/categories', name: 'categories' },
  { path: '/rules', name: 'rules' },
  { path: '/import', name: 'import' },
  { path: '/alerts', name: 'alerts' },
  // Not in the nav -- it is a footer affordance -- so `scripts/dev-smoke.sh`,
  // which reads the hrefs out of nav.tsx, does not pick it up and this list has
  // to name it by hand.
  { path: '/status', name: 'status' },
] as const;

const SCHEMES = ['light', 'dark'] as const;

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    for (const route of ROUTES) {
      test(`${route.name} has no axe violations`, async ({ signedIn: page }, testInfo) => {
        await page.goto(route.path);
        // The nav renders only inside the signed-in layout, so waiting for it
        // means axe scans the page rather than a redirect in flight.
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();

        if (BASELINE) {
          // The attachment is named `a11y` and carries axe's `violations` array
          // unchanged. Both are the contract `scripts/a11y-summary.mjs` reads,
          // stated at the top of that file: it keys on the name, and it takes
          // the route and scheme from the payload rather than from this test's
          // title, because a title is prose and prose gets rewritten. Naming it
          // anything else makes the summary fall back to counting pass/fail and
          // report zero violations for a page full of them.
          await testInfo.attach('a11y', {
            body: JSON.stringify({
              route: route.path,
              scheme,
              violations: results.violations,
            }),
            contentType: 'application/json',
          });
          return;
        }

        expect(
          results.violations,
          results.violations
            .map(
              (violation) =>
                `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
                violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
            )
            .join('\n'),
        ).toEqual([]);
      });
    }
  });
}

test.describe('the things axe cannot check', () => {
  test('every chart has a table alternative rather than being hidden', async ({
    signedIn: page,
  }) => {
    await page.goto('/reports');

    // The chart's surface is focusable, so `aria-hidden` on its wrapper would be
    // a violation in itself. The alternative is a real `<details>` with a real
    // table in it, reachable by keyboard.
    const details = page.getByRole('group');
    await expect(details.first()).toBeVisible();
    await expect(page.locator('[aria-hidden="true"] .recharts-surface')).toHaveCount(0);
  });

  test('the skip link is the first thing keyboard focus reaches', async ({ signedIn: page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /Skip/ })).toBeFocused();
  });

  test('every page has exactly one h1 and starts its outline there', async ({ signedIn: page }) => {
    for (const route of ROUTES) {
      await page.goto(route.path);
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      const count = await page.getByRole('heading', { level: 1 }).count();
      expect(count, `${route.path} should have exactly one h1`).toBe(1);
    }
  });
});
