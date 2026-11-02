import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTokens, resolve } from './contrast';

/**
 * The identity lock.
 *
 * What it pins: this repo's canvas, its accent, its corner radius and the exact
 * three typefaces it loads, read out of `app/globals.css` and `app/layout.tsx`
 * rather than out of a copy of the palette kept in TypeScript.
 *
 * What breaks without it: the portfolio's actual failure mode, which is that
 * every project ends up wearing whatever visual language the last one wore.
 * Three earlier repos shipped the same monochrome tokens and the same three
 * faces, so a reader opening all three saw one designer with one trick. Nothing
 * in a build catches that: a redesign that drifts back toward a shared palette
 * compiles, renders, and passes every other test in this suite.
 *
 * When the identity genuinely changes, change these constants deliberately and
 * say why in the commit. That is the point: it should cost a decision.
 */
const APP = join(__dirname, '..', 'app');
const globals = readFileSync(join(APP, 'globals.css'), 'utf8');
const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');

/** "Violet on cool paper". See the header comment in `app/globals.css`. */
const IDENTITY = {
  light: { '--bg': '#f7f6fb', '--accent': '#6d28d9' },
  dark: { '--bg': '#12111a', '--accent': '#a78bfa' },
  radius: '6px',
  fonts: ['Newsreader', 'Public_Sans', 'Roboto_Mono'],
} as const;

/**
 * The dark block only overrides part of the light one, so it layers on top.
 * Reading it standalone would report every token the dark scheme inherits as
 * missing, and `resolve()` would throw on the first of them.
 */
const light = extractTokens(globals, ':root');
const dark = { ...light, ...extractTokens(globals, '@media (prefers-color-scheme: dark)') };

/**
 * Every face this app loads: the `<Face>` directory of each self-hosted
 * `./fonts/<Face>/...` path a `next/font/local` call points at.
 *
 * Deliberately the same regex `web/scripts/identity-distinct.mjs` uses, because
 * that script is the only check that can see across repos and it parses this
 * exact shape: a SINGLE-quoted `'./fonts/<Face>/` path. Rewrite the paths with
 * double quotes or move the files elsewhere and the cross-repo check silently
 * reads zero faces from this project. It reports success while checking nothing.
 */
function importedFaces(): string[] {
  const faces = new Set<string>();
  for (const m of layout.matchAll(/'\.\/fonts\/([A-Za-z0-9_]+)\//g)) faces.add(m[1]!);
  return [...faces].sort();
}

describe('visual identity', () => {
  it.each(Object.entries(IDENTITY.light))('light %s is %s', (token, expected) => {
    expect(resolve(light, token).toLowerCase()).toBe(expected);
  });

  it.each(Object.entries(IDENTITY.dark))('dark %s is %s', (token, expected) => {
    expect(resolve(dark, token).toLowerCase()).toBe(expected);
  });

  it('loads exactly the faces this identity is built on', () => {
    // Exact, not "at least": an extra face is how a shared house style creeps
    // back in one import at a time.
    expect(importedFaces()).toEqual([...IDENTITY.fonts].sort());
  });

  it('self-hosts every face, with its licence beside it, and fetches nothing from Google', () => {
    // CI failed intermittently while `next/font/google` fetched the faces at
    // build time. See the comment above the faces in `app/layout.tsx`.
    expect(layout).not.toMatch(/from\s*['"]next\/font\/google['"]/);
    expect(layout).toMatch(/import localFont from 'next\/font\/local'/);
    expect(importedFaces().length, 'the cross-repo regex must find all three faces').toBe(3);
    for (const face of IDENTITY.fonts) {
      const dir = join(APP, 'fonts', face);
      const files = readdirSync(dir).filter((f) => f.endsWith('.woff2'));
      expect(files, `${face} woff2`).not.toHaveLength(0);
      for (const file of files) expect(layout, `${face}/${file} is loaded`).toContain(`./fonts/${face}/${file}`);
      expect(readFileSync(join(dir, 'OFL.txt'), 'utf8'), `${face} licence`).toMatch(/SIL Open Font License/);
    }
  });

  it('sets each face as the CSS variable the stylesheet reads', () => {
    // `--ff-display` and friends wrap these. A face imported but never wired to
    // its variable renders as the fallback stack and nobody notices in review.
    for (const variable of ['--font-display', '--font-ui', '--font-mono']) {
      expect(layout, `${variable} must be declared by next/font`).toContain(
        `variable: '${variable}'`,
      );
    }
  });

  it('is softly cornered, not square and not a pill', () => {
    // 6px is the ruling in the stylesheet header: a page of cards must not read
    // as a spreadsheet, and a 24px-tall table chip must still look square.
    expect(light['--radius']).toBe(IDENTITY.radius);
  });

  it('does not reintroduce the shared signal red', () => {
    // #ff0000 was the one accent three earlier portfolio projects shared.
    expect([...globals.matchAll(/#ff0000|#f00\b/gi)]).toHaveLength(0);
  });

  it('carries no dot-matrix face and no dot-grid texture', () => {
    // Both were tics of the single-aesthetic generator this portfolio banned.
    expect(globals).not.toMatch(/--ff-dot|--dot-grid|--font-dot/);
    expect(importedFaces().join(' ')).not.toMatch(/Doto|Space_/);
  });
});

/**
 * The canvases, accents and faces the rest of the portfolio has already spent.
 *
 * `web/scripts/identity-distinct.mjs` is the authority, because it reads the
 * sibling repos' real stylesheets and this file cannot see them. This is the
 * half of that check a single repo can still make: it catches the common way a
 * collision is introduced, which is pasting a token block out of the project
 * next door, and it fails inside this repo's own pre-commit gate rather than
 * only when someone remembers to run the cross-repo script.
 */
const SPENT = {
  canvases: [
    '#fafaf8', // 001 booking, light
    '#101319', // 001 booking, dark
    '#fffdfa', // 002 shop, light
    '#14120e', // 002 shop, dark
    '#f6f7f9', // 002 admin, light
    '#0b1220', // 003 console, dark
    '#f8fafc', // 003 console, light
    '#14120f', // 003 learn, dark
    '#fbf8f3', // 003 learn, light
  ],
  accents: [
    '#4f46e5', // 001 light
    '#818cf8', // 001 dark
    '#7a2e2e', // 002 shop light
    '#e39a9a', // 002 shop dark
    '#1f6feb', // 002 admin light
    '#60a5fa', // 003 console dark
    '#1d4ed8', // 003 console light
    '#5eead4', // 003 learn dark
    '#0f766e', // 003 learn light
  ],
  faces: [
    'Fraunces',
    'Inter',
    'Archivo',
    'IBM_Plex_Mono',
    'Instrument_Serif',
    'IBM_Plex_Sans',
    'JetBrains_Mono',
    'Source_Serif_4',
  ],
} as const;

describe('no two projects share an identity', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the canvas is this project alone', (scheme, palette) => {
    const canvas = resolve(palette, '--bg').toLowerCase();
    expect(SPENT.canvases, `${scheme} canvas ${canvas} is already taken`).not.toContain(canvas);
  });

  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s: the accent is this project alone', (scheme, palette) => {
    const accent = resolve(palette, '--accent').toLowerCase();
    expect(SPENT.accents, `${scheme} accent ${accent} is already taken`).not.toContain(accent);
  });

  it('loads no typeface another project already uses', () => {
    const collisions = importedFaces().filter((face) =>
      (SPENT.faces as readonly string[]).includes(face),
    );
    expect(collisions, 'these faces are already spent elsewhere in the portfolio').toEqual([]);
  });
});
