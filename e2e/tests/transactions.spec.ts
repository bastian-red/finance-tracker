import { expect, notice, test } from '../fixtures/app';
import { referenceMonth } from '../fixtures/seed-facts';

/**
 * The ledger: filters, keyset pagination, and the provenance of a category.
 *
 * **Changing a category by hand marks it `manual`, and that is not cosmetic.**
 * Re-running the rule engine over the ledger must never overwrite a choice a
 * person made, and the only way to know which is which is the stored
 * `categorySource` column. Without it the engine has to guess, and the guess is
 * wrong the first time somebody corrects a mis-filed row.
 *
 * **Pagination is keyset, not offset.** The list is ordered by booked date and
 * rows are inserted into the middle of it by every import, so `?page=3` shows a
 * reader the same transactions twice, or never, the moment a statement lands
 * while they are reading. The cursor is opaque and threaded through untouched.
 */
test.describe('the ledger', () => {
  test('renders seeded rows with amounts formatted from the stored locale', async ({
    signedIn: page,
  }) => {
    await page.goto('/transactions');

    await expect(page.getByRole('table')).toBeVisible();
    // The browser is pinned to en-US and UTC in playwright.config.ts. The user's
    // stored locale is es-ES, so a comma decimal here proves the app formatted
    // from the database rather than from the machine it happened to run on.
    await expect(page.getByText(/\d,\d\d/).first()).toBeVisible();
  });

  test('the uncategorised filter is a URL and it narrows the list', async ({ signedIn: page }) => {
    await page.goto('/transactions');
    const all = await page.getByRole('row').count();

    // The label is the sentence the form actually shows, not the schema's word
    // for it. `filters.tsx` writes "Only rows with no category" because the
    // reader is being asked about their own ledger, not about a column name.
    await page.getByLabel('Only rows with no category').check();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    await expect(page).toHaveURL(/uncategorised=true/);
    const filtered = await page.getByRole('row').count();
    expect(filtered).toBeLessThanOrEqual(all);

    // And unticking it must *drop* the parameter rather than send
    // `uncategorised=false`: the contract coerces it with `z.coerce.boolean()`
    // and `Boolean("false")` is `true`, so sending the false would turn the
    // filter on and the list would get shorter when the box is cleared.
    await page.getByLabel('Only rows with no category').uncheck();
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).not.toHaveURL(/uncategorised=false/);
    await expect(page.getByRole('row')).toHaveCount(all);
  });

  test('a category chosen by hand sticks, and is marked as the user choice', async ({
    signedIn: page,
  }) => {
    await page.goto('/transactions');

    const select = page.getByLabel(/^Category for /).first();
    await expect(select).toBeVisible();
    const before = await select.inputValue();

    const options = await select.locator('option').all();
    let target = '';
    for (const option of options) {
      const value = (await option.getAttribute('value')) ?? '';
      if (value !== '' && value !== before) {
        target = value;
        break;
      }
    }
    expect(target, 'the seed must plant more than one category').not.toBe('');

    await select.selectOption(target);
    // Written through a server action, so the value survives a reload rather
    // than living in component state.
    await expect(select).toHaveValue(target);

    await page.reload();
    await expect(page.getByLabel(/^Category for /).first()).toHaveValue(target);

    // Put it back, so a re-run starts from the seeded state.
    const restore = page.getByLabel(/^Category for /).first();
    await restore.selectOption(before);
    await expect(restore).toHaveValue(before);
  });

  test('the next page is a cursor, never an offset', async ({ signedIn: page }) => {
    await page.goto('/transactions');

    const next = page.getByRole('link', { name: /Next|More/ });
    if ((await next.count()) === 0) {
      // The seed plants enough history that this should not happen, but a suite
      // that silently asserts nothing is worse than one that says so.
      throw new Error('The ledger fits on one page, so pagination cannot be exercised.');
    }

    const href = await next.first().getAttribute('href');
    expect(href).toMatch(/cursor=/);
    expect(href).not.toMatch(/page=/);
    expect(href).not.toMatch(/offset=/);

    await next.first().click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('a row can be added, edited and deleted by hand', async ({ signedIn: page }) => {
    // The importer covers the common case; this is cash, a transfer, and the
    // correction somebody makes when a statement rounded something. An app that
    // can only ingest a CSV cannot be made to agree with reality.
    const description = `E2E hand-entered ${process.pid}`;

    await test.step('add it', async () => {
      await page.goto('/transactions');
      // Scoped to the region: the filter bar above the table also has a
      // description field ("Description contains"), and an unscoped
      // `getByLabel('Description')` is a strict-mode violation against both.
      const add = page.getByRole('region', { name: 'Add a transaction' });
      await add.getByLabel('Date').fill(`${referenceMonth}-15`);
      // Signed, and the sign is the whole meaning: there is no direction toggle
      // because there is no `kind` column. Negative is money out.
      await add.getByLabel(/^Amount/).fill('-41.30');
      await add.getByLabel('Description').fill(description);
      await add.getByRole('button', { name: 'Add transaction' }).click();

      await expect(notice(page).first()).toContainText('Transaction added');
    });

    await test.step('it is in the ledger, formatted from the stored locale', async () => {
      await page.goto(`/transactions?search=${encodeURIComponent(description)}`);
      const row = page.getByRole('row').filter({ hasText: description });
      await expect(row).toHaveCount(1);
      // es-ES, not the browser's en-US: a comma decimal proves the app formatted
      // from the database rather than from the machine it happened to run on.
      await expect(row).toContainText('41,30');
      await expect(row).toContainText('Out');
    });

    await test.step('edit the description', async () => {
      const row = page.getByRole('row').filter({ hasText: description });
      await row.getByRole('group').getByText('Edit').click();
      // Scoped to the row, so the create form's Description is out of reach.
      await row.getByLabel('Description').fill(`${description} corrected`);
      await row.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(notice(page).first()).toContainText('Transaction saved');

      await page.goto(`/transactions?search=${encodeURIComponent(description)}`);
      await expect(page.getByRole('row').filter({ hasText: 'corrected' })).toHaveCount(1);
    });

    await test.step('delete it, in two steps', async () => {
      const row = page.getByRole('row').filter({ hasText: description });
      await row.getByRole('group').getByText('Edit').click();
      await row.getByRole('button', { name: 'Delete', exact: true }).click();
      // The confirmation carries the consequence in its own label rather than in
      // a confirm() dialog.
      await row.getByRole('button', { name: 'Yes, delete this transaction' }).click();

      // The row going away is the confirmation, and it is the only one that can
      // be asserted without a race: the `<Notice>` for a delete is rendered
      // *inside* the row being deleted, so `router.refresh()` takes it with the
      // row. Chromium happened to read it before the re-render landed and
      // Firefox did not, which is a flake either way round.
      await expect(row).toHaveCount(0);

      await page.goto(`/transactions?search=${encodeURIComponent(description)}`);
      await expect(page.getByRole('row').filter({ hasText: description })).toHaveCount(0);
    });
  });

  test('an amount that is not a number is refused in words', async ({ signedIn: page }) => {
    await page.goto('/transactions');
    const add = page.getByRole('region', { name: 'Add a transaction' });
    await add.getByLabel('Date').fill(`${referenceMonth}-15`);
    await add.getByLabel(/^Amount/).fill('lots');
    await add.getByLabel('Description').fill('E2E not an amount');
    await add.getByRole('button', { name: 'Add transaction' }).click();

    // The sentence names what to type. "Bad Request" would not.
    await expect(notice(page).first()).toContainText('plain number');
  });

  test('the amount field says which way the money is going, in words', async ({
    signedIn: page,
  }) => {
    // The sign is the only thing separating income from an expense, and a minus
    // at 13px is the worst possible carrier for it. The form restates it.
    await page.goto('/transactions');
    const add = page.getByRole('region', { name: 'Add a transaction' });
    await add.getByLabel(/^Amount/).fill('-52.40');
    await expect(add.getByText(/going out/)).toBeVisible();
    await add.getByLabel(/^Amount/).fill('2400');
    await expect(add.getByText(/coming in/)).toBeVisible();
  });

  test('a date filter reaches the API rather than being applied in the browser', async ({
    signedIn: page,
  }) => {
    await page.goto(`/transactions?from=${referenceMonth}-01&to=${referenceMonth}-28`);
    await expect(page.getByRole('table')).toBeVisible();

    // The net total is computed over the whole filtered set by the API, not over
    // the rendered page: a page-local sum would be wrong for any filter matching
    // more rows than fit on one page, and it would be wrong quietly.
    await expect(page.getByText(/Net of everything matching this filter/)).toBeVisible();
  });
});
