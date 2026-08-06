import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { statementFixture } from './seed-facts';

/**
 * A shipped bank fixture, made unique to one test run.
 *
 * **Why this exists.** The import pipeline is deliberately idempotent in two
 * independent ways: the stored file is content-addressed by its SHA-256, so
 * identical bytes are a 409 before any parsing happens, and every committed row
 * carries a server-side fingerprint, so a row already in the ledger comes back
 * as `duplicate` even from a different file. Both are exactly the properties the
 * import spec exists to prove.
 *
 * They also make a spec that uploads a fixed file usable **once**. Playwright
 * runs the same specs in Chromium and then in Firefox against one database, so
 * the second project met the 409 the first project had just earned, and two
 * tests failed for a reason that had nothing to do with Firefox. Re-running the
 * suite without a reseed did the same thing.
 *
 * So the bytes are made unique per call. What is *not* touched is everything the
 * detector reads: the delimiter, the decimal mark, the date order, the encoding,
 * the header block above the table, and the CRLF line endings. A synthetic
 * comma-delimited file would have avoided the whole problem and proved nothing
 * -- the point of `bbva-es.csv` is that it is latin1, semicolon-delimited, and
 * writes `1.234,56` and `31/12/2026`, none of which a JavaScript CSV parser
 * assumes.
 *
 * The token goes into the **description** column, which the fingerprint hashes
 * alongside the amount and the day. Amounts and dates are left alone so the
 * assertions about them stay meaningful.
 */

/**
 * Which column holds the description, per fixture. Zero-based, as the contract is.
 *
 * Read off the fixtures themselves, and wrong once already: `broken-rows.csv` is
 * semicolon-delimited like the other Spanish export, not comma-delimited, and
 * recording it as a comma made every line look like a single field. The guard
 * below turns that into a thrown error instead of a file that is silently
 * returned unchanged and then collides with the previous run.
 */
const DESCRIPTION_COLUMN: Record<string, { column: number; delimiter: string }> = {
  'bbva-es.csv': { column: 2, delimiter: ';' },
  'chase-us.csv': { column: 2, delimiter: ',' },
  'n26-eu.csv': { column: 1, delimiter: ',' },
  'broken-rows.csv': { column: 1, delimiter: ';' },
  'ambiguous-dates.csv': { column: 1, delimiter: ',' },
};

let counter = 0;

/**
 * Write a one-off copy of `filename` and return its path.
 *
 * `latin1` throughout: every byte round-trips through it unchanged, including
 * the ones that are not valid UTF-8, which is the whole reason the Spanish
 * fixture is worth having. Reading it as `utf8` would replace each of those with
 * U+FFFD and the file would no longer be the file.
 */
export function uniqueStatement(filename = basename(statementFixture)): string {
  const source = join(dirname(statementFixture), filename);
  const spec = DESCRIPTION_COLUMN[filename];
  if (spec === undefined) {
    throw new Error(`No description column recorded for ${filename}. Add one to statement.ts.`);
  }

  counter += 1;
  const token = `E2E${process.pid}X${counter}`;
  const text = readFileSync(source, 'latin1');

  const lines = text.split('\n').map((line) => {
    // The trailing CR of a CRLF file is part of the last field; splitting it off
    // and putting it back is what keeps the line endings the fixture's own.
    const cr = line.endsWith('\r') ? '\r' : '';
    const body = cr === '' ? line : line.slice(0, -1);
    const cells = body.split(spec.delimiter);

    // Header blocks, blank lines and anything too short to be a data row are left
    // exactly as they are: a bank export's preamble is part of what the column
    // detector has to see through.
    if (cells.length <= spec.column) return line;
    const cell = cells[spec.column] ?? '';
    if (cell.trim() === '') return line;

    // Data rows only, identified by a digit somewhere other than the description:
    // every one of these files puts a date and an amount beside it, and no header
    // row or preamble line has either. Tokenising the header would rewrite the
    // very text `findHeader` matches on, which is what the column-detection
    // assertions in import.spec.ts are about.
    const elsewhere = cells.filter((_unused, index) => index !== spec.column).join('');
    if (!/\d/.test(elsewhere)) return line;

    // Inside the quotes when the cell is quoted, so a quoted field stays one
    // field. `chase-us.csv` quotes every description.
    cells[spec.column] = cell.endsWith('"') ? `${cell.slice(0, -1)} ${token}"` : `${cell} ${token}`;
    return `${cells.join(spec.delimiter)}${cr}`;
  });

  const result = lines.join('\n');
  // A file that came back byte-identical is a file this function did nothing to,
  // which means the next upload of it collides with the last one and the failure
  // arrives several tests later as "the commit button is disabled". Better to say
  // so here, naming the fixture whose delimiter or column is recorded wrongly.
  if (result === text) {
    throw new Error(
      `uniqueStatement did not change ${filename}: its delimiter (${JSON.stringify(
        spec.delimiter,
      )}) or description column (${spec.column}) is recorded wrongly in statement.ts.`,
    );
  }

  const directory = mkdtempSync(join(tmpdir(), 'fin-e2e-statement-'));
  const path = join(directory, filename);
  writeFileSync(path, result, 'latin1');
  return path;
}
