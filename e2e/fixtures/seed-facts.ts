import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Facts about the seeded ledger, read out of the seed rather than retyped.
 *
 * A copy of a seeded string that drifts from the seed produces a suite that is
 * confidently about data which no longer exists: it fails, the failure names the
 * wrong cause, and somebody changes working code to satisfy it. Same idiom as
 * `scripts/dev-smoke.sh` and `scripts/budget-fit.sh`, for the same reason.
 *
 * This runs in Node inside the Playwright process, never in a browser, so
 * reading a source file here is fine.
 */
/**
 * The repo root, found by walking up for `pnpm-workspace.yaml`.
 *
 * Not `import.meta.url`: Playwright transpiles each spec to CommonJS and loads
 * it with `require`, where `import.meta` does not exist, and the whole suite
 * fails to collect with "Cannot require() ES Module ... in a cycle" -- an error
 * that names the wrong problem entirely. Not `__dirname` either, because the
 * `module: ESNext` this package typechecks under does not declare it. Walking up
 * from the working directory is the one form that works under both.
 */
export const repoRoot = (() => {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find the repo root above ${process.cwd()}.`);
})();

/** Kept for the readers below; `repoRoot` is the exported name. */
const ROOT = repoRoot;

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

function must(pattern: RegExp, source: string, what: string): string {
  const match = pattern.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`Could not read ${what} out of the seed. The suite would be testing nothing.`);
  }
  return match[1];
}

const SEED = read('packages/db/prisma/seed.ts');
const TAXONOMY = read('packages/shared/src/categories.ts');

export const demoEmail = must(/^const DEMO_EMAIL = '([^']*)';/m, SEED, 'DEMO_EMAIL');
export const demoPassword = must(/^const DEMO_PASSWORD = '([^']*)';/m, SEED, 'DEMO_PASSWORD');

/** The seed's first account. Its second `name:` line; the first is the user's. */
export const accountName = (() => {
  const names = [...SEED.matchAll(/^\s*name: '([^']*)',$/gm)].map((match) => match[1]);
  const name = names[1];
  if (name === undefined) throw new Error('Could not read an account name out of the seed.');
  return name;
})();

/** The first category in the shipped taxonomy. Stable across runs; cuids are not. */
export const categoryName = must(/^\s*name: '([^']*)',$/m, TAXONOMY, 'a category name');

/**
 * The month the seed builds its history around.
 *
 * Every spec that asserts on a report or a budget has to name a month that
 * actually has rows in it, and "this month" does not: the seed plants its
 * history relative to `REFERENCE_MONTH`, and a suite run on the 3rd of a new
 * month would assert against an almost-empty ledger.
 */
export const referenceMonth = (() => {
  const match = /^const REFERENCE_MONTH = makeMonth\((\d{4}), (\d{1,2})\);/m.exec(SEED);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('Could not read REFERENCE_MONTH out of the seed.');
  }
  return `${match[1]}-${match[2].padStart(2, '0')}`;
})();

/** A real bank export, used by the import spec. Latin-1, semicolons, DD/MM/YYYY. */
export const statementFixture = join(ROOT, 'services/import/fixtures/bbva-es.csv');
