import { expect, test } from '@playwright/test';
import { signIn } from '../fixtures/app';
import { demoEmail, demoPassword } from '../fixtures/seed-facts';

test.describe('signing in', () => {
  test('a signed-in reader reaches the dashboard and the nav marks the page', async ({ page }) => {
    await signIn(page);

    await expect(page).toHaveURL(/\/$/);
    // `aria-current="page"` is the state; the underline in the stylesheet is
    // only the visible half of it. Asserting the attribute rather than a class
    // is what makes this a check on what a screen reader is told.
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText(demoEmail)).toBeVisible();
  });

  test('a wrong password is refused in words, without losing the form', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(demoEmail);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // `role="alert"` and not a paragraph, because the message appears after a
    // submission that did not move focus.
    await expect(page.getByRole('alert')).toBeVisible();
    // Still on the form, with the email still typed. An error that unmounts the
    // form into an error boundary takes the user's typing with it.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('Email')).toHaveValue(demoEmail);
  });

  test('an anonymous visitor is redirected off every signed-in route', async ({ page }) => {
    const paths = [
      '/',
      '/transactions',
      '/budgets',
      '/reports',
      '/rules',
      '/import',
      '/alerts',
      '/status',
    ];
    for (const path of paths) {
      await page.goto(path);
      await expect(page, `${path} should redirect an anonymous visitor`).toHaveURL(/\/login/);
    }
  });

  test('signing out ends the session rather than only navigating', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    // The real assertion: going back to a signed-in route must not render it
    // from the client router cache.
    await page.goto('/transactions');
    await expect(page).toHaveURL(/\/login/);
  });

  test('the sign-in page sends a signed-in reader away from the form', async ({ page }) => {
    await signIn(page);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/$/);
  });

  test('the password field is a password field', async ({ page }) => {
    // Cheap, and the failure is expensive: a `type="text"` password field puts
    // the credential in the browser's autofill history and on the screen.
    await page.goto('/login');
    await expect(page.getByLabel('Password')).toHaveAttribute('type', 'password');
    expect(demoPassword.length).toBeGreaterThanOrEqual(10);
  });
});
