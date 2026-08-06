import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTokens } from './contrast';

/**
 * The dangling-token gate.
 *
 * What it pins: every `var(--x)` this app ships resolves to something. Either
 * the stylesheet declares it, or the reference supplies a fallback, or it is one
 * of the three names `next/font` injects at runtime.
 *
 * What breaks without it: nothing that any other check can see. An undeclared
 * custom property does not warn, does not throw and does not fail a type check.
 * Inside `calc()` it is worse than that: per CSS Values 4, a `var()` that
 * resolves to nothing makes the whole declaration invalid at computed-value
 * time, so `width: calc(var(--used) * 1%)` with no `--used` does not fall back
 * to some width, it drops the declaration entirely and the element takes its
 * initial width. A budget bar at 0% and a budget bar that is broken render
 * identically. The same class of bug shipped in a sibling repo, where a renamed
 * token left `fill="var(--panel-2)"` in a chart: SVG has no fallback either, so
 * the bars painted solid black and every test still passed.
 *
 * The scan is source-level and deterministic. Comments are stripped before it
 * runs, because three doc comments in `lib/` quote `var(--x)`, `var(--other)`
 * and `` var(--cat-${slot}) `` as prose, and a scanner that counted those would
 * report failures nobody can fix.
 */
const WEB = join(__dirname, '..');
const APP = join(WEB, 'app');

/**
 * The names `next/font` writes onto `<html>` at runtime.
 *
 * They are declared in `app/layout.tsx` as `variable: '--font-display'` and
 * friends, not in any stylesheet, so the CSS scan cannot see them. Pinned as an
 * explicit list rather than a pattern: three names that the identity gate also
 * checks are wired up, so a typo in one is caught on both sides.
 */
const INJECTED_BY_NEXT_FONT = new Set(['--font-display', '--font-ui', '--font-mono']);

/**
 * Strip comments before scanning.
 *
 * Block comments in both CSS and TS, plus whole-line `//` comments in TS. Only
 * whole-line: a trailing `//` strip would eat the rest of a line containing
 * `http://`, and `lib/config.ts` has several. Nothing in this codebase writes a
 * `var()` and a comment on the same line, and the cost of being wrong in that
 * direction is a missed reference rather than a false failure.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every file that reaches the DOM. Test files are excluded: they are fixtures. */
function sourceFiles(): string[] {
  const skip = new Set(['node_modules', '.next', '.turbo', 'dist']);
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      found.push(path);
    }
  };

  walk(APP);
  walk(join(WEB, 'components'));
  walk(join(WEB, 'lib'));
  return found;
}

/** Every `--name:` at a declaration position, in any block of the stylesheet. */
function declaredTokens(): Set<string> {
  const css = stripComments(readFileSync(join(APP, 'globals.css'), 'utf8'));
  const declared = new Set<string>();
  for (const match of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1]!);
  return declared;
}

interface Reference {
  token: string;
  file: string;
  /** True when the reference is `var(--x, something)`. */
  hasFallback: boolean;
}

/**
 * Every `var()` reference in the app, with whether it carries a fallback.
 *
 * The fallback matters and is the one judgement call in this file. `var(--x,
 * 0)` is legal CSS with no declaration anywhere: that is the entire point of the
 * fallback, and this app depends on it. `--used` is written per element as an
 * inline style by `components/budget-meter.tsx` and is deliberately never
 * declared in the stylesheet, because a declared default would mean a bar whose
 * inline property failed to arrive would silently paint the default instead of
 * the real number.
 *
 * So the rule is: a token must be declared in the stylesheet, OR every single
 * reference to it must carry a fallback. "Some references have one" is the
 * dangerous middle, because the one that does not is the one that breaks. That
 * is stricter than CSS requires and is the shape this codebase actually uses.
 */
function references(): Reference[] {
  const found: Reference[] = [];
  for (const path of sourceFiles()) {
    const source = stripComments(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      found.push({
        token: match[1]!,
        file: path.slice(WEB.length + 1),
        hasFallback: match[2] === ',',
      });
    }
  }
  return found;
}

describe('design tokens', () => {
  const declared = declaredTokens();
  const referenced = references();
  const names = new Set(referenced.map((reference) => reference.token));

  it('found tokens on both sides, so the scan is actually running', () => {
    // A walk that silently returned nothing would make every assertion below
    // vacuously true, which is the failure mode of every scanning test.
    expect(declared.size, 'declarations found in globals.css').toBeGreaterThan(40);
    expect(names.size, 'distinct var() references found').toBeGreaterThan(25);
    expect(sourceFiles().length, 'files walked').toBeGreaterThan(20);
  });

  it('strips comments rather than scanning prose', () => {
    // Three doc comments quote a var() as an example. They are not references a
    // browser will ever try to resolve, and counting them would make the gate
    // permanently red for a reason nobody can act on.
    expect(names.has('--x'), 'lib/format.ts doc comment').toBe(false);
    expect(names.has('--other'), 'lib/contrast.ts doc comment').toBe(false);
    expect(names.has('--cat-'), 'the interpolated example in lib/format.ts').toBe(false);
  });

  it('every referenced token resolves to something at runtime', () => {
    const byToken = new Map<string, Reference[]>();
    for (const reference of referenced) {
      byToken.set(reference.token, [...(byToken.get(reference.token) ?? []), reference]);
    }

    const dangling = [...byToken.entries()]
      .filter(([token, uses]) => {
        if (declared.has(token) || INJECTED_BY_NEXT_FONT.has(token)) return false;
        // Undeclared is fine only when every use supplies its own fallback.
        return !uses.every((use) => use.hasFallback);
      })
      .map(([token, uses]) => {
        const where = [...new Set(uses.filter((use) => !use.hasFallback).map((use) => use.file))];
        return `${token} used without a fallback in ${where.join(', ')}`;
      })
      .sort();

    expect(dangling, 'these var() references resolve to nothing at runtime').toEqual([]);
  });

  it('--used is never referenced without its fallback', () => {
    // The named case, asserted directly rather than only through the rule above,
    // because this is the one the stylesheet calls out: `calc(var(--used) * 1%)`
    // with no inline property drops the whole `width` declaration, and a 0% bar
    // and a broken bar are the same pixels.
    const uses = referenced.filter((reference) => reference.token === '--used');
    expect(uses.length, '--used must actually be referenced somewhere').toBeGreaterThan(0);
    expect(
      uses.filter((use) => !use.hasFallback).map((use) => use.file),
      'every var(--used) needs a fallback, because nothing declares it',
    ).toEqual([]);
    expect(declared.has('--used'), '--used is set inline per element, never declared').toBe(false);
  });

  it('the fallback-only tokens are the ones written as inline styles', () => {
    // Anything undeclared and fallback-carrying is a property some component
    // sets per element. There are two, and both are values only the render knows:
    //
    //   --used  the budget meter's fill, from integer basis points
    //   --bars  how many bars the by-category chart has, which is what
    //           `.chart-bars` turns into a height. Recharts' ResponsiveContainer
    //           measures its parent, so a box with no height renders no chart at
    //           all -- silently, with the `<details>` table still underneath it.
    //
    // A third appearing is not necessarily wrong, but it is a decision to make on
    // purpose rather than to discover in a screenshot.
    const fallbackOnly = [
      ...new Set(
        referenced
          .filter(
            (reference) =>
              !declared.has(reference.token) && !INJECTED_BY_NEXT_FONT.has(reference.token),
          )
          .map((reference) => reference.token),
      ),
    ].sort();
    expect(fallbackOnly).toEqual(['--bars', '--used']);
  });

  it('the palette tokens all have a :root default', () => {
    // The dark block overrides a subset. A colour declared only inside the media
    // query renders as nothing in light mode, which is the same dangling failure
    // with a smaller blast radius.
    const root = new Set(
      Object.keys(extractTokens(readFileSync(join(APP, 'globals.css'), 'utf8'), ':root')),
    );
    const palette = [
      '--bg',
      '--surface',
      '--surface-2',
      '--border',
      '--border-strong',
      '--text',
      '--muted',
      '--accent',
      '--accent-ink',
      '--income',
      '--expense',
      '--approaching',
      '--exceeded',
      '--cat-none',
      '--radius',
    ];
    for (const token of palette) {
      expect(root.has(token), `${token} must have a :root default`).toBe(true);
    }
  });

  it('every token the dark scheme overrides exists in :root', () => {
    const css = readFileSync(join(APP, 'globals.css'), 'utf8');
    const root = new Set(Object.keys(extractTokens(css, ':root')));
    const darkOnly = Object.keys(extractTokens(css, '@media (prefers-color-scheme: dark)')).filter(
      (token) => !root.has(token),
    );
    expect(darkOnly, 'these tokens only exist in dark mode').toEqual([]);
  });

  it('the ten category slots are all declared, in both schemes', () => {
    // `categorySwatchVar` in lib/format.ts emits one of these per row. A missing
    // slot would make one category's swatch inherit whatever the parent paints,
    // and slot 7 is not a thing anyone checks by eye.
    const css = readFileSync(join(APP, 'globals.css'), 'utf8');
    const root = extractTokens(css, ':root');
    const darkBlock = extractTokens(css, '@media (prefers-color-scheme: dark)');
    for (let slot = 0; slot < 10; slot += 1) {
      expect(root[`--cat-${slot}`], `--cat-${slot} in :root`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(darkBlock[`--cat-${slot}`], `--cat-${slot} in dark`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
