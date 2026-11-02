import { expect, test } from '@playwright/test';

/**
 * The three faces are self-hosted (`apps/web/app/fonts/<Face>/`), not fetched
 * from Google at build time: that fetch made CI fail intermittently with
 * "Failed to find font override values for font `Newsreader`".
 *
 * The gate test (`lib/identity.test.ts`) proves the layout points at the files.
 * This proves a browser actually gets them: every woff2 is served from the app's
 * own origin, nothing is requested from Google, and the headings, the interface
 * and the numbers are each bound to a face that loads rather than to the
 * fallback stack.
 */
test('the three self-hosted faces load from the app itself', async ({ page, baseURL }) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.resourceType() === 'font' ||
      /fonts\.(googleapis|gstatic)\.com/.test(request.url())
    ) {
      fontRequests.push(request.url());
    }
  });

  await page.goto('/login');

  // Faces load lazily: /login sets no number, so the browser never fetches the
  // mono face on its own (the first version of this test read only two loaded
  // faces for that reason). Ask for each bound face by name, as a page that
  // uses it would, and require every face behind it to finish loading.
  const results = await page.evaluate(async () => {
    const style = getComputedStyle(document.documentElement);
    return Promise.all(
      ['--font-display', '--font-ui', '--font-mono'].map(async (variable) => {
        const family = style
          .getPropertyValue(variable)
          .split(',')[0]!
          .trim()
          .replace(/^['"]|['"]$/g, '');
        const faces = await document.fonts.load(`16px "${family}"`);
        return { variable, family, statuses: faces.map((face) => face.status) };
      }),
    );
  });
  for (const { variable, family, statuses } of results) {
    // An empty list means the family is unknown to the document: the variable
    // fell back to a system face, which renders but is not this identity.
    expect(family, `${variable} is unset`).not.toBe('');
    expect(statuses, `${variable} (${family}) did not load`).not.toHaveLength(0);
    expect(
      statuses.every((status) => status === 'loaded'),
      `${variable}: ${statuses.join(', ')}`,
    ).toBe(true);
  }
  expect(new Set(results.map((r) => r.family)).size, 'three distinct faces').toBe(3);

  expect(fontRequests.length).toBeGreaterThan(0);
  const origin = new URL(baseURL!).origin;
  for (const url of fontRequests) expect(new URL(url).origin, url).toBe(origin);
});
