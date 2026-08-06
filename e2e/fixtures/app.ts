import { test as base, expect, type Page } from '@playwright/test';
import { demoEmail, demoPassword } from './seed-facts';

/**
 * One fixture: a page that is already signed in as the demo user.
 *
 * Sign-in goes through the real form rather than through a stored cookie jar or
 * a token minted in the fixture. It costs a second per spec and it buys the one
 * thing a shortcut cannot: every spec exercises the credential path, so an
 * `AUTH_SECRET` that never reaches the web app fails the whole suite loudly
 * instead of producing a wall of "element not found" on pages that quietly
 * redirected to `/login`.
 *
 * `signedIn` is the only shared setup. Everything else each spec does for
 * itself, because a spec that depends on state another spec left behind fails
 * in whatever order Playwright happens to pick.
 */
export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

/**
 * The app's own `<Notice>`, and nothing else.
 *
 * `page.getByRole('alert')` cannot be used bare here: Next renders a permanently
 * mounted, permanently empty `<div role="alert" id="__next-route-announcer__">`
 * on every page to announce client-side navigations. Every assertion against the
 * role therefore either violates strict mode or resolves to the announcer's
 * empty string and waits out its timeout, which is exactly the failure this
 * suite hit on its first run. Scoping to the element the `Notice` component
 * actually renders is the fix, and a CSS selector is the honest way to say
 * "our alert, not the framework's".
 */
export function notice(page: Page) {
  return page.locator('p[role="alert"]');
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(demoEmail);
  await page.getByLabel('Password').fill(demoPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The nav only renders inside the signed-in layout, so its appearance is the
  // signal that the session actually took. Waiting on the URL alone would pass
  // against an error boundary rendered at `/`.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

export { expect };
