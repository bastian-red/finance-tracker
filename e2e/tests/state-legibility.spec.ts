import { expect, test } from '../fixtures/app';
import { referenceMonth } from '../fixtures/seed-facts';

/**
 * Colour is never the only channel, and this is the spec that proves it at
 * runtime.
 *
 * The finding behind it is measured, not stylistic. An exhaustive search over
 * the 500-900 and 300-600 ramps of this project's palette found **zero**
 * combinations where a green, an amber and a red all clear 4.5:1 against the
 * `#f7f6fb` canvas *and* separate from each other by 1.5:1 once reduced to
 * greyscale. The best available is 2.0:1 between income and expense in light and
 * 2.68:1 in dark. There is no palette that fixes this; there is only a design
 * that does not depend on it.
 *
 * So every state in this app carries a glyph **and** a word, and the colour only
 * agrees with them. `lib/format.ts` and `lib/import-format.ts` return all three
 * together for exactly that reason. This spec asserts the text is present, which
 * is the half a contrast unit test cannot see: a token can be correct while a
 * component forgets to render the word beside it.
 *
 * It runs in forced greyscale where the browser supports it, so a state that is
 * legible only in colour fails here rather than in front of a reader.
 */
test.describe('state is legible without colour', () => {
  test('a transaction direction carries a word, not only a hue', async ({ signedIn: page }) => {
    await page.goto('/transactions');

    // `directionLabel` returns "In", "Out" or "Zero", and the ledger renders it
    // in its own Direction column via `DirectionTag`. Reading the sign of an
    // amount is not the same task: a minus sign at 12px next to a red number is
    // exactly what a reader with a deficiency is being asked to do without this.
    const direction = page.locator('.state-glyph').first();
    await expect(direction).toBeVisible();
    await expect(page.getByRole('cell', { name: /^[+\-=]?(In|Out|Zero)$/ }).first()).toBeVisible();
  });

  test('a budget state is a word before it is a colour', async ({ signedIn: page }) => {
    await page.goto(`/budgets?month=${referenceMonth}`);
    await expect(page.getByRole('heading', { name: /^Budgets$/ })).toBeVisible();

    const states = page.getByText(/Under|Approaching|Exceeded/);
    // The seed plants budgets in the reference month, so at least one meter has
    // a state on it. Zero would mean the meters render a bar and nothing else.
    expect(await states.count()).toBeGreaterThan(0);
  });

  test('an import row status is a word, and the glyph is hidden from assistive tech', async ({
    signedIn: page,
  }) => {
    await page.goto('/rules');
    // The rules list uses the same state vocabulary as the import table, and it
    // is reachable without uploading a file.
    await expect(page.getByText(/Active|Paused/).first()).toBeVisible();

    // The glyph is decoration: it repeats what the word already says, so
    // announcing it would make a screen reader read "plus Active".
    const glyphs = page.locator('.state-glyph');
    if ((await glyphs.count()) > 0) {
      await expect(glyphs.first()).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('the whole dashboard stays readable in forced greyscale', async ({ signedIn: page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // Not a screenshot comparison: a pixel diff would fail on font rendering and
    // teach nothing. This desaturates the page and then asserts the same words
    // are still there, which is the property that actually matters.
    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(
      page.getByText(/Under|Approaching|Exceeded|Money in|Money out/).first(),
    ).toBeVisible();
  });

  test('the nav marks the current page with an attribute, not a colour', async ({
    signedIn: page,
  }) => {
    await page.goto('/budgets');
    await expect(page.getByRole('link', { name: 'Budgets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // And exactly one link claims it, so a prefix match has not lit up two.
    await expect(page.locator('.nav-link[aria-current="page"]')).toHaveCount(1);
  });
});
