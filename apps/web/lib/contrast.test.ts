import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AA_NORMAL,
  AA_UI,
  contrastRatio,
  extractTokens,
  parseHex,
  ratio,
  relativeLuminance,
  resolve,
} from './contrast';

/**
 * The colour gate.
 *
 * What it pins: every foreground/background pair this app actually paints,
 * against WCAG AA, in both colour schemes. 4.5:1 for text, 3:1 for anything
 * non-text that has to be seen (control borders, the focus ring, the meter fill,
 * a category swatch). It reads `app/globals.css` off disk and pulls the palette
 * out of it, so it cannot pass against a stale copy of the colours.
 *
 * What breaks without it: nothing visibly, which is the problem. A token nudged
 * two steps lighter still looks fine to whoever nudged it, and the reader who
 * cannot make out the "Approaching" state on a budget row is not in the room.
 * Contrast is arithmetic on two hex values. Arithmetic belongs in a test, not in
 * anyone's eye.
 *
 * Two constraints this file respects rather than argues with, both stated in the
 * stylesheet header and both measured, not assumed:
 *
 *   - status ink lands on `--bg` and `--surface` only. On `--surface-2` the best
 *     of the four measures 4.29:1 in light and 4.21:1 in dark, under AA. The
 *     stylesheet keeps `--surface-2` to `--text` and `--muted`; asserting status
 *     ink there would be asserting a rule the design does not make;
 *   - green, amber and red cannot all clear AA on this canvas *and* separate
 *     from each other in greyscale. See the pair assertions at the bottom.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');

/** Light is the default palette, on `:root`. Dark overrides a subset of it. */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

const PALETTES = {
  light,
  dark,
} as const;

/** Every surface a foreground can legitimately land on. */
const BACKGROUNDS = ['--bg', '--surface', '--surface-2'] as const;

/**
 * Text-weight foregrounds, allowed on all three surfaces.
 *
 * `--accent` is in here rather than in the non-text list because it is a link
 * colour (`a { color: var(--accent) }`), which is why the stylesheet uses a
 * 600-weight violet that looks heavier on a button than a 500 would.
 */
const TEXT = ['--text', '--muted', '--accent'] as const;

/**
 * Status ink, and the only two surfaces it is allowed on.
 *
 * `.state-income` and friends are rendered inside `.card` (`--surface`) and
 * directly on the page (`--bg`). `--surface-2` is table headers, hover rows and
 * the meter track, and carries `--text` / `--muted` only.
 */
const STATUS = ['--income', '--expense', '--approaching', '--exceeded'] as const;
const STATUS_BACKGROUNDS = ['--bg', '--surface'] as const;

/** The ten category swatches plus the uncategorised grey. Non-text: 3:1. */
const SWATCHES = [
  ...Array.from({ length: 10 }, (_, slot) => `--cat-${slot}` as const),
  '--cat-none',
] as const;

describe('pure contrast maths', () => {
  it('computes the canonical extremes', () => {
    expect(ratio('#000000', '#ffffff')).toBe(21);
    expect(ratio('#ffffff', '#ffffff')).toBe(1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#6d28d9', '#f7f6fb')).toBeCloseTo(
      contrastRatio('#f7f6fb', '#6d28d9'),
      10,
    );
  });

  it('expands three-digit hex', () => {
    expect(parseHex('#fff')).toEqual(parseHex('#ffffff'));
    expect(parseHex('0af')).toEqual({ r: 0, g: 170, b: 255 });
  });

  it('rejects nonsense rather than scoring it', () => {
    // A named colour scored as if it were hex would give the palette a number it
    // has not earned, which is the one outcome worse than no measurement.
    expect(() => parseHex('rebeccapurple')).toThrow(/not a hex colour/);
    expect(() => parseHex('#12345')).toThrow(/not a hex colour/);
  });

  it('matches the WCAG luminance of the reference greys', () => {
    expect(relativeLuminance(parseHex('#000000'))).toBe(0);
    expect(relativeLuminance(parseHex('#ffffff'))).toBeCloseTo(1, 10);
    // 0.2159 is the published relative luminance of #808080, and it is above the
    // naive 0.5 precisely because of the sRGB transfer curve this function
    // implements. A version that skipped the linearisation would report 0.5.
    expect(relativeLuminance(parseHex('#808080'))).toBeCloseTo(0.2159, 3);
  });
});

describe('token extraction', () => {
  it('reads custom properties out of a block', () => {
    expect(extractTokens(':root { --a: #fff; --b: 6px; }', ':root')).toEqual({
      '--a': '#fff',
      '--b': '6px',
    });
  });

  it('walks nested braces so a media query does not truncate the block', () => {
    const css = '@media (prefers-color-scheme: dark) { :root { --a: #000; } }';
    expect(extractTokens(css, '@media (prefers-color-scheme: dark)')).toEqual({ '--a': '#000' });
  });

  it('throws when the selector is not in the file, rather than measuring nothing', () => {
    expect(() => extractTokens(':root { --a: #fff; }', '[data-surface="admin"]')).toThrow(
      /selector not found/,
    );
  });

  it('follows var() indirection', () => {
    expect(resolve({ '--a': 'var(--b)', '--b': '#123456' }, '--a')).toBe('#123456');
  });

  it('throws on a circular reference instead of hanging', () => {
    expect(() => resolve({ '--a': 'var(--b)', '--b': 'var(--a)' }, '--a')).toThrow(/circular/);
  });

  it('throws on a missing token rather than skipping the check', () => {
    expect(() => resolve({}, '--nope')).toThrow(/undefined token/);
  });

  it('throws on a token that is not a colour', () => {
    expect(() => resolve({ '--radius': '6px' }, '--radius')).toThrow(/not a plain hex colour/);
  });

  it('found a real palette in both schemes', () => {
    // The whole file is worthless if `extractTokens` silently returned {}.
    for (const [scheme, palette] of Object.entries(PALETTES)) {
      expect(Object.keys(palette).length, scheme).toBeGreaterThan(25);
      expect(resolve(palette, '--text'), scheme).toMatch(/^#[0-9a-f]{6}$/i);
      expect(resolve(palette, '--bg'), scheme).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('the dark scheme overrides colours it does not inherit', () => {
    // A dark block that stopped being applied would leave `dark` identical to
    // `light`, and every assertion below would then measure the light palette
    // twice and pass.
    expect(resolve(dark, '--bg')).not.toBe(resolve(light, '--bg'));
    expect(resolve(dark, '--text')).not.toBe(resolve(light, '--text'));
    expect(resolve(dark, '--accent')).not.toBe(resolve(light, '--accent'));
  });
});

describe.each(Object.entries(PALETTES))('%s scheme', (scheme, palette) => {
  const at = (token: string): string => resolve(palette, token);

  describe.each(TEXT)('%s as text', (fg) => {
    it.each(BACKGROUNDS)('clears AA on %s', (bg) => {
      const foreground = at(fg);
      const background = at(bg);
      const measured = ratio(foreground, background);
      expect(
        measured,
        `${scheme}: ${fg} (${foreground}) on ${bg} (${background}) is ${measured}:1, needs ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  describe.each(STATUS)('%s as status ink', (fg) => {
    it.each(STATUS_BACKGROUNDS)('clears AA on %s', (bg) => {
      // Only these two surfaces. See the header: on --surface-2 the best of the
      // four is 4.29:1 light / 4.21:1 dark, and the stylesheet does not put them
      // there.
      const foreground = at(fg);
      const background = at(bg);
      const measured = ratio(foreground, background);
      expect(
        measured,
        `${scheme}: ${fg} (${foreground}) on ${bg} (${background}) is ${measured}:1, needs ${AA_NORMAL}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  it('--border-strong clears 3:1 on every surface, because it bounds controls', () => {
    // WCAG 1.4.11. An input sits on --surface, a .btn:hover on --surface-2, and
    // the skip link on --surface, so all three matter.
    for (const bg of BACKGROUNDS) {
      const measured = ratio(at('--border-strong'), at(bg));
      expect(
        measured,
        `${scheme}: --border-strong (${at('--border-strong')}) on ${bg} (${at(bg)}) is ${measured}:1`,
      ).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('the focus ring clears 3:1 on every surface', () => {
    // One ring across the app, painted in --accent by `:focus-visible`. A ring
    // that is invisible on one surface is a keyboard user losing their place
    // exactly once per page.
    for (const bg of BACKGROUNDS) {
      const measured = ratio(at('--accent'), at(bg));
      expect(measured, `${scheme}: focus ring on ${bg} is ${measured}:1`).toBeGreaterThanOrEqual(
        AA_UI,
      );
    }
  });

  it('the primary button label clears AA on its own fill', () => {
    // .btn-primary is --accent-ink on --accent. The dark scheme flips the ink to
    // near-black because its accent is a light violet; if that flip were ever
    // dropped, white on #a78bfa would measure 2.2:1.
    const measured = ratio(at('--accent-ink'), at('--accent'));
    expect(
      measured,
      `${scheme}: --accent-ink (${at('--accent-ink')}) on --accent (${at('--accent')}) is ${measured}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(SWATCHES)('%s is visible as a 10px square on every surface', (swatch) => {
    // Non-text, so 3:1. The swatch always sits beside the category name, so it
    // is a finding aid rather than an identifier, but a smudge is not a finding
    // aid.
    for (const bg of BACKGROUNDS) {
      const measured = ratio(at(swatch), at(bg));
      expect(
        measured,
        `${scheme}: ${swatch} (${at(swatch)}) on ${bg} (${at(bg)}) is ${measured}:1`,
      ).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('every meter fill is visible against its own track', () => {
    // `.meter` is --surface-2 with a --border hairline; `.meter-fill` is one of
    // these. A fill that matches its track renders a budget bar that is always
    // empty, which reads as "you have spent nothing".
    for (const fill of ['--muted', '--income', '--approaching', '--exceeded'] as const) {
      const measured = ratio(at(fill), at('--surface-2'));
      expect(
        measured,
        `${scheme}: ${fill} fill (${at(fill)}) on the --surface-2 track (${at('--surface-2')}) is ${measured}:1`,
      ).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('the exceeded stripe separates from the surface it is cut with', () => {
    // `.meter-exceeded .meter-fill` is a repeating gradient of --exceeded and
    // --surface. If those two converged the stripe would disappear, and the
    // stripe is the non-colour channel that survives greyscale and
    // forced-colors.
    const measured = ratio(at('--exceeded'), at('--surface'));
    expect(measured, `${scheme}: exceeded stripe is ${measured}:1`).toBeGreaterThanOrEqual(AA_UI);
  });

  it('--surface and --surface-2 are distinguishable from --bg', () => {
    // Not a WCAG rule, a real regression from a sibling repo: light mode had
    // --surface === --bg, so every card silently lost its surface. A card here
    // has no shadow and only a hairline border, so the tone is what makes it a
    // card at all.
    expect(at('--surface'), `${scheme}: --surface must not equal --bg`).not.toBe(at('--bg'));
    expect(at('--surface-2'), `${scheme}: --surface-2 must not equal --bg`).not.toBe(at('--bg'));
    expect(at('--surface-2'), `${scheme}: --surface-2 must not equal --surface`).not.toBe(
      at('--surface'),
    );
  });

  /**
   * The two confusable PAIRS, and only those two.
   *
   * A three-way greyscale separation between green, amber and red is provably
   * unavailable on this canvas: the stylesheet header records an exhaustive
   * search over the 500-900 and 300-600 ramps that found zero combinations where
   * all three clear 4.5:1 on #f7f6fb and also separate by 1.5:1 from each other
   * in greyscale. Measured here, income against approaching is 1.0:1 in light
   * and 1.03:1 in dark, which is the same grey.
   *
   * So the design does not rely on it. `directionLabel` and `budgetStateLabel`
   * ship a glyph and a word, the exceeded meter is striped, and colour is the
   * third channel. What is asserted here is only that colour does not quietly
   * contradict the other two: the pairs a reader is actually asked to tell apart
   * side by side (in vs out on a transaction row, approaching vs exceeded on a
   * budget) stay apart in tone.
   */
  it.each([
    ['income', 'expense'],
    ['approaching', 'exceeded'],
  ])('--%s and --%s separate in greyscale, not only in hue', (a, b) => {
    const measured = ratio(at(`--${a}`), at(`--${b}`));
    expect(
      measured,
      `${scheme}: --${a} (${at(`--${a}`)}) vs --${b} (${at(`--${b}`)}) is ${measured}:1, needs 1.5:1`,
    ).toBeGreaterThanOrEqual(1.5);
  });
});
