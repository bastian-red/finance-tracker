import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/app';
import { referenceMonth, repoRoot } from '../fixtures/seed-facts';
import { uniqueStatement } from '../fixtures/statement';

/**
 * The screenshots the README's demo GIF is assembled from.
 *
 * **This is a capture, not a check.** Its assertions exist only to keep a frame
 * from being photographed mid-render; nothing here proves a property, and every
 * property it touches is proved by another spec in this directory. That is
 * deliberate: a screenshot test that also asserts behaviour fails for two
 * unrelated reasons and neither failure names itself.
 *
 * **It is skipped unless `DEMO=1`.** See `testIgnore` in `playwright.config.ts`.
 * It writes files, holds still for animations, and commits an import, none of
 * which belong in the lane that runs on every push. `./scripts/demo-gif.sh`
 * turns it on.
 *
 * **The contract with `scripts/demo-gif.sh`**: one PNG per step in
 * `e2e/demo-shots/`, named so that a plain lexical sort is playback order, which
 * in practice means a zero-padded numeric prefix. The script does not invent an
 * order of its own. `e2e/demo-shots/` is gitignored: it is regenerated output,
 * and only the GIF built from it is committed.
 *
 * Chromium only, and the light scheme only. A GIF is a 256-colour format, and
 * interleaving two colour schemes through one generated palette bands both.
 */
const SHOTS = join(repoRoot, 'e2e', 'demo-shots');

test.use({ colorScheme: 'light', viewport: { width: 1280, height: 900 } });

let step = 0;

/**
 * One frame, at the viewport size, deliberately not `fullPage`.
 *
 * A full-page shot of the ledger is 9,467px tall, because the ledger is two
 * hundred rows. `demo-gif.sh` pads every frame to the tallest one, so a single
 * full-page capture turns the other six frames into a strip of screenshot at the
 * top of an otherwise blank 1280x9467 canvas, and the GIF is mostly white. The
 * frames have to be the same shape to play as an animation, and the shape that
 * works is the window.
 */
async function shot(page: Page, name: string): Promise<void> {
  step += 1;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`),
    animations: 'disabled',
  });
}

test('captures the demo', async ({ signedIn: page }) => {
  test.skip(test.info().project.name !== 'chromium', 'One browser is enough for a GIF.');
  test.slow();

  await test.step('the dashboard', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Recharts animates on mount. Waiting for the chart's own `<details>` table
    // alternative means the frame is taken when the data is there, rather than
    // when a clock said so.
    await expect(page.getByRole('group').first()).toBeVisible();
    await shot(page, 'dashboard');
  });

  await test.step('the ledger', async () => {
    await page.goto('/transactions');
    await expect(page.getByRole('table')).toBeVisible();
    await shot(page, 'transactions');
  });

  await test.step('a month in full', async () => {
    await page.goto(`/reports?month=${referenceMonth}`);
    await expect(page.getByRole('group').first()).toBeVisible();
    // The charts are the point of this screen and they sit below the totals, so
    // this frame is taken after scrolling to them rather than at the top.
    await page.getByRole('heading', { name: /^Where /, level: 2 }).scrollIntoViewIfNeeded();
    await shot(page, 'reports');
  });

  await test.step('budgets against real spending', async () => {
    await page.goto(`/budgets?month=${referenceMonth}`);
    await expect(page.getByRole('heading', { name: 'Add a budget' })).toBeVisible();
    await shot(page, 'budgets');
  });

  await test.step('the rule tester', async () => {
    await page.goto('/rules');
    await page.getByLabel('Pattern').first().fill('mercadona');
    await page
      .getByRole('heading', { name: 'Against your last transactions' })
      .first()
      .scrollIntoViewIfNeeded();
    // The verdict is the point of this frame: the "What the engine sees" column
    // is what makes the normalisation visible.
    await expect(page.getByText(/\d+ of \d+ would match/)).toBeVisible();
    await shot(page, 'rules');
  });

  await test.step('importing a statement', async () => {
    await page.goto('/import');
    await page.getByLabel('Account').selectOption({ index: 0 });
    await page.getByLabel('Statement').setInputFiles(uniqueStatement('bbva-es.csv'));
    await page.getByRole('button', { name: 'Upload and check' }).click();
    await expect(page).toHaveURL(/\/import\?id=/);
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('heading', { name: 'Row by row' }).scrollIntoViewIfNeeded();
    await shot(page, 'import-preview');
  });

  await test.step('and what it did', async () => {
    await page.getByRole('button', { name: /^Import \d+ transactions?$/ }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(/imported/);
    await shot(page, 'import-committed');
  });
});
