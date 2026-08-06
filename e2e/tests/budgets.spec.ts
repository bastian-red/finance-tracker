import type { Page } from '@playwright/test';
import { expect, notice, test } from '../fixtures/app';
import { referenceMonth } from '../fixtures/seed-facts';

/**
 * Budgets, and the invariant Postgres enforces rather than the app.
 *
 * Two budgets for the same category may never cover the same month. That is a
 * GiST `EXCLUDE` constraint with `btree_gist`, not a `SELECT` followed by an
 * `INSERT`, and the difference is the whole point: a check-then-write loses to
 * two concurrent requests, and the second budget silently wins. What this spec
 * can prove from a browser is the other half of it -- that the violation reaches
 * the reader as a sentence naming the conflict rather than as a 500. The
 * concurrency proof itself lives in `apps/api/test`, where two writes can
 * actually be issued at once.
 *
 * Every test cleans up the budget it creates, because a leftover budget makes
 * the next run's "overlapping" case pass for the wrong reason.
 */
test.describe('budgets', () => {
  test('a new budget appears with a meter, and the meter is not colour alone', async ({
    signedIn: page,
  }) => {
    const category = 'Shopping';

    await page.goto(`/budgets?month=${referenceMonth}`);
    await createBudget(page, category, '400', referenceMonth);

    const meter = page.getByRole('heading', { name: category, level: 3 }).first();
    await expect(meter).toBeVisible();

    // The state carries a word. On this canvas no green, amber and red all clear
    // AA against the surface *and* separate from each other in greyscale, so
    // colour is the third channel here and never the only one. The three words
    // are `budgetStateLabel`'s, in apps/web/lib/format.ts.
    await expect(page.getByText(/Under|Approaching|Exceeded/).first()).toBeVisible();

    await deleteBudget(page, category);
  });

  test('an overlapping budget is refused in a sentence, not a 500', async ({ signedIn: page }) => {
    const category = 'Subscriptions';

    await page.goto(`/budgets?month=${referenceMonth}`);
    await createBudget(page, category, '50', referenceMonth);

    // The same category, the same month. The exclusion constraint rejects this
    // at the database, and `PrismaExceptionFilter` turns 23P01 into a 409 whose
    // message names the months. A 500 here would mean the app is relying on a
    // read-then-write it does not have.
    await createBudget(page, category, '80', referenceMonth, { expectFailure: true });
    const alert = notice(page).first();
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('Something went wrong');

    await deleteBudget(page, category);
  });

  test('the dashboard shows one meter per budget, not one per month', async ({
    signedIn: page,
  }) => {
    // `GET /reports/monthly` returns a budget status per budget **per month of
    // the trailing window** on purpose, so `planAlerts` can narrow it rather than
    // trust its caller. The dashboard rendered that list unfiltered: twelve
    // meters for one budget, twelve React children keyed on the same `budgetId`,
    // and a meter that can keep the previous month's fill beside the new month's
    // number when the month changes. Every unit test and every axe run passed
    // through it; a screenshot is what showed it.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Budgets' })).toBeVisible();

    const names = await page
      .getByRole('region', { name: 'Budgets' })
      .getByRole('heading', { level: 3 })
      .allInnerTexts();

    expect(new Set(names).size, `duplicated meters: ${names.join(', ')}`).toBe(names.length);
  });

  test('the month picker is a URL, so the back button walks the months', async ({
    signedIn: page,
  }) => {
    await page.goto(`/budgets?month=${referenceMonth}`);
    const heading = page.getByRole('heading', { level: 2 }).first();
    const first = await heading.textContent();

    await page.getByLabel('Month to show').fill('2026-01');
    await page.getByRole('button', { name: 'Show month' }).click();
    await expect(page).toHaveURL(/month=2026-01/);
    await expect(heading).not.toHaveText(first ?? '');

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`month=${referenceMonth}`));
  });

  test('a limit typed with decimals is stored exactly, not as a float', async ({
    signedIn: page,
  }) => {
    // 4.10 scaled by multiplication is 409.99999999999994, which `minor()`
    // rejects. The web app moves the decimal point by string surgery instead,
    // and this is the value that catches the difference.
    const category = 'Health';

    await page.goto(`/budgets?month=${referenceMonth}`);
    await createBudget(page, category, '4.10', referenceMonth);

    await expect(notice(page).first()).not.toContainText('Something went wrong');
    // Rendered by `formatMoney` from the stored es-ES locale, so the decimal
    // separator is a comma whatever the browser's own locale says.
    await expect(page.getByText(/4,10/).first()).toBeVisible();

    await deleteBudget(page, category);
  });
});

async function createBudget(
  page: Page,
  category: string,
  limit: string,
  month: string,
  options: { expectFailure?: boolean } = {},
): Promise<void> {
  await page.getByLabel('Category').selectOption({ label: category });
  await page.getByLabel(/^Limit per month/).fill(limit);
  await page.getByLabel('In force from').fill(month);
  await page.getByRole('button', { name: 'Create budget' }).click();

  await expect(notice(page).first()).toBeVisible();
  if (options.expectFailure !== true) {
    await expect(page.getByRole('heading', { name: category, level: 3 }).first()).toBeVisible();
  }
}

/**
 * Remove the budget for a category, so the next run starts clean.
 *
 * One step, not two. Deleting a *budget* is not the same decision as deleting a
 * *category*: a budget carries no rows of its own, nothing cascades, and setting
 * it again is one form. `EditCategoryForm` has the two-step confirmation because
 * removing a category takes its rules and budgets with it.
 */
async function deleteBudget(page: Page, category: string): Promise<void> {
  const row = page.getByRole('listitem').filter({ hasText: category }).last();
  await row.getByRole('button', { name: 'Delete this budget' }).click();
  // The row going away is the confirmation. `EditBudgetForm` renders its
  // `<Notice>` inside the `<li>` being deleted, so `router.refresh()` takes the
  // message with the row: asserting on it is a race that Chromium wins and
  // Firefox loses.
  await expect(row).toHaveCount(0);
}
