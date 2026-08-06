import { expect, notice, test } from '../fixtures/app';

/**
 * Categorisation rules, and the one thing the screen exists to make visible.
 *
 * The engine matches against the **normalised** description, not the raw one:
 * `MERCADONA 4023 MADRID` is `mercadona madrid` by the time a rule sees it, with
 * the case, the accents and the four-digit terminal number gone. Somebody
 * writing a pattern containing `\d{4}` gets no error, no warning and no matches,
 * and there is nothing on any other screen that would tell them why. The tester
 * shows both forms side by side, which is what turns that from a mystery into a
 * fact you can read.
 *
 * The tester is a preview and not the authority: the API compiles the pattern
 * with a star-height check and a timing ladder against adversarial input, and
 * refuses anything that backtracks. That refusal is asserted here too, because a
 * pattern that previews cleanly and then fails to save with an unreadable error
 * is worse than one that fails immediately.
 */
test.describe('rules', () => {
  test('the list is in the order the engine runs, not alphabetical', async ({ signedIn: page }) => {
    await page.goto('/rules');

    // A rule's position decides whether the rules under it are reachable at all,
    // so the list is an ordered list and each row is numbered.
    await expect(page.getByRole('heading', { name: 'In the order they run' })).toBeVisible();
    await expect(page.getByText(/^Priority \d+/).first()).toBeVisible();
  });

  test('the tester shows what the engine actually compares against', async ({ signedIn: page }) => {
    await page.goto('/rules');

    const pattern = page.getByLabel('Pattern').first();
    await pattern.fill('mercadona');

    const tester = page.getByRole('table').first();
    await expect(tester).toBeVisible();
    // Both columns: the statement's own text, and the normalised form. The
    // second is the one nobody would guess.
    await expect(tester.getByRole('columnheader', { name: 'On the statement' })).toBeVisible();
    await expect(tester.getByRole('columnheader', { name: 'What the engine sees' })).toBeVisible();
    await expect(page.getByText(/\d+ of \d+ would match/)).toBeVisible();
  });

  test('a pattern that cannot match anything says so while it is being typed', async ({
    signedIn: page,
  }) => {
    await page.goto('/rules');

    // "!!!" has no letters or digits, so it normalises to the empty string, and
    // the empty string is a substring of every description: a `contains` rule
    // built from it would swallow the entire ledger into one category on the
    // next import. Caught in the browser, before it can be saved.
    await page.getByLabel('Pattern').first().fill('!!!');
    await expect(page.getByText(/would match every transaction/)).toBeVisible();
  });

  test('a half-typed regular expression does not blank the page', async ({ signedIn: page }) => {
    await page.goto('/rules');

    await page.getByLabel('Match by').first().selectOption('regex');
    // `new RegExp('(')` throws. The tester runs on every keystroke, so an
    // uncaught throw here is a white screen while somebody is typing.
    await page.getByLabel('Pattern').first().fill('(');

    await expect(page.getByText(/not a valid regular expression/)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  });

  test('a rule can be created, and it says what it does and does not change', async ({
    signedIn: page,
  }) => {
    await page.goto('/rules');

    await page.getByLabel('File it as').first().selectOption({ label: 'Transport' });
    await page.getByLabel('Pattern').first().fill('e2e-test-taxi');
    await page.getByRole('button', { name: 'Create rule' }).click();

    const result = notice(page).first();
    await expect(result).toBeVisible();
    // The sentence matters: a user who expects a new rule to reclassify the
    // ledger and finds it did not has been misled by the interface, not by the
    // engine. Re-running rules must never overwrite a category a human chose.
    await expect(result).toContainText('applies to the next import');

    await test.step('remove it again', async () => {
      // Matched on the *normalised* pattern, because that is what the list shows:
      // `describeMatcher` prints what the engine will compare against, so the
      // rule typed as `e2e-test-taxi` reads `contains "e2e test taxi"`. Looking
      // for the typed form here would find nothing, which is the same lesson the
      // tester teaches a user two tests above.
      const row = page.getByRole('listitem').filter({ hasText: 'e2e test taxi' }).last();
      // The edit form is inside a `<details>`: twenty expanded rule forms, each
      // carrying a twelve-row tester, is an unusable page, so it opens on demand.
      await row.getByRole('group').getByText('Edit this rule').click();
      await row.getByRole('button', { name: 'Delete', exact: true }).click();
      await row.getByRole('button', { name: 'Yes, delete this rule' }).click();
      await expect(notice(page).first()).toBeVisible();
    });
  });

  test('the API refuses a catastrophically backtracking pattern', async ({ signedIn: page }) => {
    await page.goto('/rules');

    await page.getByLabel('File it as').first().selectOption({ label: 'Shopping' });
    await page.getByLabel('Match by').first().selectOption('regex');
    // The textbook nested quantifier. It previews fine in the browser -- a dozen
    // short samples are not enough input to make it hang -- and is exactly what
    // the API's probe ladder exists to catch before it reaches an import loop.
    await page.getByLabel('Pattern').first().fill('(a+)+$');
    await page.getByRole('button', { name: 'Create rule' }).click();

    const result = notice(page).first();
    await expect(result).toBeVisible();
    // The API writes this sentence and it reaches the screen verbatim, which is
    // why lib/api.ts keeps the response body on an error.
    await expect(result).not.toContainText('Something went wrong');
  });
});
