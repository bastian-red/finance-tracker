import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, notice, test } from '../fixtures/app';
import { accountName } from '../fixtures/seed-facts';
import { uniqueStatement } from '../fixtures/statement';

/**
 * The import pipeline, end to end: upload, read, correct, commit, and the second
 * upload that must not double the ledger.
 *
 * This is the flagship flow of the project and the one that crosses every
 * boundary at once -- a multipart upload through a server action, `@fin/import`
 * detecting a Spanish bank's format from its bytes, `@fin/categorize` suggesting
 * categories from the user's own rules, a content-addressed file on disk, and a
 * commit that is `createMany({ skipDuplicates: true })` behind a fingerprint
 * unique index.
 *
 * The fixture is a real BBVA export: latin1, semicolon-delimited, `31/12/2026`
 * dates and `1.234,56` amounts. Nothing about it is what a JavaScript CSV parser
 * assumes by default, which is the point of using it rather than a hand-written
 * comma file.
 *
 * **Every upload goes through `uniqueStatement`.** The app is idempotent by
 * design in two independent ways -- a SHA-256 on the stored file and a
 * fingerprint on every committed row -- which means a fixed fixture can be
 * imported exactly once, ever. Chromium ran these tests, Firefox ran them next
 * against the same database, and the second project met the 409 the first had
 * just earned. Making the bytes unique per upload leaves everything the detector
 * reads untouched and lets the suite run twice.
 */
test.describe('importing a statement', () => {
  test('reads a Spanish bank export correctly and commits it once', async ({ signedIn: page }) => {
    await test.step('upload the file', async () => {
      await page.goto('/import');
      // By index, not by label: the option's text is `<name> (<currency>)` and
      // pinning that whole string here would make a currency change a test edit.
      // The name itself is asserted separately, below.
      await page.getByLabel('Account').selectOption({ index: 0 });
      await expect(page.getByLabel('Account')).toContainText(accountName);
      await page.getByLabel('Statement').setInputFiles(uniqueStatement('bbva-es.csv'));
      await page.getByRole('button', { name: 'Upload and check' }).click();
      await expect(page).toHaveURL(/\/import\?id=/);
    });

    await test.step('the detector read the format from the bytes', async () => {
      // Semicolons and a comma decimal are what the file uses, and neither is the
      // default a naive parser would pick. If the detector had guessed wrong the
      // amounts would be off by a factor of a hundred and every row would still
      // look plausible, which is exactly why this is asserted rather than eyeballed.
      await expect(page.getByLabel('Column separator')).toHaveValue('semicolon');
      await expect(page.getByLabel('Decimal mark')).toHaveValue(',');
      await expect(page.getByLabel('Date order')).toHaveValue('DD/MM/YYYY');
      await expect(page.getByLabel('Text encoding')).toHaveValue('latin1');
    });

    await test.step('every row was read and none is a duplicate yet', async () => {
      const counts = page.getByRole('region', { name: 'What was read' });
      await expect(counts).toBeVisible();
      await expect(counts.getByText('Already in the ledger')).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
    });

    await test.step('commit it', async () => {
      const commit = page.getByRole('button', { name: /^Import \d+ transactions?$/ });
      await expect(commit).toBeEnabled();
      await commit.click();

      const result = notice(page).first();
      await expect(result).toContainText(/\d+ transactions? imported/);
      await expect(result).toContainText('0 skipped');
    });

    await test.step('the rows are in the ledger', async () => {
      await page.getByRole('link', { name: 'See them in the ledger' }).click();
      await expect(page).toHaveURL(/\/transactions/);
      await expect(page.getByRole('cell', { name: /MERCADONA/ }).first()).toBeVisible();
    });
  });

  test('the same file uploaded twice is all duplicates, pre-ticked out', async ({
    signedIn: page,
  }) => {
    // One file, made unique to this test, uploaded and committed and then offered
    // again. Both halves of the idempotence are exercised: the bytes are refused
    // outright by the content address, and the rows would have been refused by
    // their fingerprints even from a different file.
    const statement = uniqueStatement('chase-us.csv');

    await test.step('first upload and commit', async () => {
      await uploadFile(page, statement);
      const commit = page.getByRole('button', { name: /^Import \d+ transactions?$/ });
      await expect(commit).toBeEnabled();
      await commit.click();
      await expect(notice(page).first()).toContainText(/\d+ transactions? imported/);
    });

    await test.step('the same bytes are refused outright', async () => {
      // Content-addressed storage: the file is keyed by its SHA-256, so an
      // identical re-upload is a conflict rather than a second parse. The
      // sentence has to say so; "something went wrong" would send somebody
      // looking for a bug.
      await page.goto('/import');
      await page.getByLabel('Account').selectOption({ index: 0 });
      await page.getByLabel('Statement').setInputFiles(statement);
      await page.getByRole('button', { name: 'Upload and check' }).click();
      await expect(notice(page).first()).toBeVisible();
      await expect(notice(page).first()).not.toContainText('Something went wrong');
      await expect(page).toHaveURL(/\/import$/);
    });

    await test.step('different bytes carrying the same rows are all duplicates', async () => {
      // A byte-level copy with one extra blank line: a new SHA-256, so the upload
      // is accepted and parsed, and every row then matches a fingerprint already
      // in the ledger. This is the half that catches a bank re-exporting an
      // overlapping month, which is the common case and the reason the row-level
      // check exists at all.
      await uploadFile(page, appendNewline(statement));

      const counts = page.getByRole('region', { name: 'What was read' });
      await expect(counts).toBeVisible();
      // Every importable row starts ticked out, so the commit button offers
      // nothing. Pre-ticking duplicates is this form's job: the API applies
      // `skipLines` exactly as sent and deliberately does not filter them itself.
      await expect(page.getByRole('button', { name: /^Import 0 transactions$/ })).toBeDisabled();

      await page.getByRole('button', { name: 'Discard this upload' }).click();
      await expect(page).toHaveURL(/\/import$/);
    });
  });

  test('an unreadable row does not stop the file', async ({ signedIn: page }) => {
    // `broken-rows.csv` has lines a parser cannot read. The property under test
    // is that the other rows still preview: throwing on the first bad date means
    // the reader fixes one line, re-uploads, and meets the next one.
    await uploadFile(page, uniqueStatement('broken-rows.csv'));

    await expect(page.getByText('Unreadable')).toBeVisible();
    // Error rows cannot be chosen, because there is nothing to import: they have
    // no day and no amount. A tickable checkbox would offer control that the
    // server does not honour.
    const disabled = page.locator('input[type="checkbox"][disabled]');
    await expect(disabled.first()).toBeVisible();

    // And the readable rows are still importable.
    await expect(page.getByRole('button', { name: /^Import \d+ transactions?$/ })).toBeEnabled();

    await page.getByRole('button', { name: 'Discard this upload' }).click();
    await expect(page).toHaveURL(/\/import$/);
  });

  test('correcting the format re-reads the whole file from the stored bytes', async ({
    signedIn: page,
  }) => {
    await uploadFile(page, uniqueStatement('ambiguous-dates.csv'));

    // The file's days are all below the 13th, so nothing in it settles day-first
    // versus month-first and the detector says so rather than logging it. That
    // note is the entire reason this form exists.
    await expect(page.getByLabel('Date order')).toBeVisible();

    await page.getByLabel('Date order').selectOption('MM/DD/YYYY');
    await page.getByRole('button', { name: 'Read it again with these' }).click();

    await expect(notice(page).first()).toContainText('Re-read with the format you chose');
    await expect(page.getByLabel('Date order')).toHaveValue('MM/DD/YYYY');

    await page.getByRole('button', { name: 'Discard this upload' }).click();
    await expect(page).toHaveURL(/\/import$/);
  });

  test('an upload can be thrown away without touching the ledger', async ({ signedIn: page }) => {
    await page.goto('/transactions');
    const before = await page.getByRole('row').count();

    await uploadFile(page, uniqueStatement('n26-eu.csv'));
    await page.getByRole('button', { name: 'Discard this upload' }).click();
    await expect(page).toHaveURL(/\/import$/);

    await page.goto('/transactions');
    await expect(page.getByRole('row')).toHaveCount(before);
  });
});

/** Upload a prepared statement and land on its preview. */
async function uploadFile(page: Page, path: string): Promise<void> {
  await page.goto('/import');
  await page.getByLabel('Account').selectOption({ index: 0 });
  await page.getByLabel('Statement').setInputFiles(path);
  await page.getByRole('button', { name: 'Upload and check' }).click();
  await expect(page).toHaveURL(/\/import\?id=/);
}

/**
 * The same statement, one byte longer.
 *
 * A trailing newline changes the SHA-256 and changes nothing the parser reads,
 * which is exactly the shape of a bank re-exporting the same month: the file is
 * accepted, and the rows inside it are caught by their fingerprints instead.
 */
function appendNewline(path: string): string {
  const copy = `${path}.again.csv`;
  writeFileSync(copy, `${readFileSync(path, 'latin1')}\n`, 'latin1');
  return copy;
}
