/**
 * Where an uploaded statement lives between preview and commit, and why it lives
 * anywhere at all.
 *
 * The alternative is to keep nothing: parse the upload, write `ImportRow`s, and
 * rebuild the commit from those rows. It does not work. `PlannedRow` carries a
 * `fingerprint` and a `merchant` that are deliberately **not** on the wire type
 * (see `services/import/src/types.ts`), and it carries them because the server
 * computes them from the account id rather than accepting them from the client.
 * Rebuilding the plan from `ImportRow`s alone would mean either persisting the
 * fingerprint in a second place or recomputing it from columns that a `PATCH` to
 * the format could have changed underneath. Keeping the bytes means there is one
 * source of truth for what the file said, and the preview, the format
 * correction and the commit are all the same function applied to it.
 *
 * The file is content-addressed: `<root>/<userId>/<sha256>.csv`. Two consequences
 * that are the point rather than side effects:
 *
 * - Re-uploading a statement that is byte-identical resumes the existing import
 *   instead of creating a second one, and the `imports_user_id_sha256_key` unique
 *   index is what enforces that rather than a `findFirst` that races.
 * - The path contains no attacker-controlled text. `originalname` comes from the
 *   browser and is stored in a column, never used to build a path. This is the
 *   file where that rule is enforced, and `assertSafeSegment` is why a future
 *   caller cannot quietly break it.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Hex SHA-256 of the uploaded bytes. The import's identity. */
export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** ids from the database and hex digests. Nothing that can climb out of the root. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeSegment(label: string, value: string): void {
  if (SAFE_SEGMENT.test(value)) return;
  throw new Error(
    `Refusing to build an import path from ${label}=${JSON.stringify(value)}: ` +
      'only letters, digits, dash and underscore are allowed.',
  );
}

/**
 * The absolute path for one stored statement.
 *
 * `resolve` against the root, then a prefix check, so that even if the guard
 * above is ever loosened the result still cannot escape. Two checks for one
 * property is deliberate: the regex explains the intent, the prefix check is the
 * one that holds if the regex is edited.
 */
export function storedPathFor(root: string, userId: string, sha256: string): string {
  assertSafeSegment('userId', userId);
  assertSafeSegment('sha256', sha256);

  const base = resolve(root);
  const path = resolve(join(base, userId, `${sha256}.csv`));
  if (path !== join(base, userId, `${sha256}.csv`)) {
    throw new Error(`Refusing to write an import outside ${base}.`);
  }
  return path;
}

export async function writeStatement(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

export function readStatementFile(path: string): Promise<Buffer> {
  return readFile(path);
}

/** Best effort. A statement that outlives its import row is litter, not a bug. */
export async function removeStatement(path: string): Promise<void> {
  await rm(path, { force: true });
}
