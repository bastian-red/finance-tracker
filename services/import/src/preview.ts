/**
 * The preview: every line of the file, read, judged and explained, before
 * anything is written.
 *
 * An import is the one operation in this app that can quietly ruin a ledger, and
 * it is irreversible in the way that matters -- a user who imports the same
 * statement twice does not get an error, they get a month that says they spent
 * twice what they spent, and they find out when the numbers stop matching their
 * bank. So nothing is written from the upload directly. The file is turned into a
 * list of rows with a status each, the reader looks at it, and only then does
 * `planCommit` turn the survivors into inserts.
 *
 * Three properties hold throughout:
 *
 * **No row may stop the file.** A statement with three broken lines still
 * previews the other nine hundred. Every per-row failure is caught and becomes a
 * row with `status: 'error'`, a null day and a null amount, and a sentence saying
 * which cell was wrong. The alternative -- throwing on the first bad date -- means
 * the reader fixes one line, re-uploads, and finds the next one.
 *
 * **Duplicate detection is an index, not a scan.** A 4,000-row import against a
 * 20,000-row ledger is 80 million comparisons done the obvious way, which is
 * seconds of a request holding a transaction open. Keyed on amount plus
 * normalised description it is one map lookup per row, and the day window is
 * checked only against the handful of rows that already matched on both.
 *
 * **The same row appearing twice in one file is a duplicate too.** Exports that
 * overlap at the month boundary are the common case, but a bank that repeats a
 * line inside a single file is not rare either, and a duplicate that is not in
 * the ledger yet has no id to point at -- which is why `duplicateOfId` is null
 * there and the message names the line instead.
 */
import {
  daysBetween,
  exponentOf,
  merchantOf,
  normaliseDescription,
  parseAmount,
  type AmountFormat,
  type CalendarDay,
  type DetectedFormat,
  type ImportPreviewRow,
} from '@fin/shared';
import { fingerprintOf } from '@fin/shared/server';
import { categorize } from '@fin/categorize';
import { findHeader } from './columns';
import { parseDateTemplate, parseStatementDay, UNKNOWN_DATE_FORMAT } from './dates';
import { cellAt, readStatement, type StatementRecord } from './records';
import type { ParseOptions, PlannedRow, PreviewResult, StatementContext } from './types';

/**
 * The `description` column is `varchar(300)`.
 *
 * Truncating here rather than at the insert means the description the reader
 * approved in the preview is the description that is stored, and the fingerprint
 * is computed from the same string on both passes. Truncating later would make a
 * re-import of the same file produce a different fingerprint and therefore fail
 * to spot itself.
 */
export const MAX_DESCRIPTION = 300;

/** The `amount_minor` column is a signed 32-bit integer. See `amountMinorSchema`. */
const MAX_AMOUNT_MINOR = 2_147_483_647;

interface DuplicateEntry {
  /** Null when the match is another row of this same file, which has no id yet. */
  id: string | null;
  bookedOn: CalendarDay;
  line: number | null;
}

interface ParsedRow {
  bookedOn: CalendarDay;
  amountMinor: number;
}

export function buildPreview(
  bytes: Buffer,
  format: DetectedFormat,
  ctx: StatementContext,
  opts: ParseOptions,
): PreviewResult {
  const read = readStatement(bytes, opts, {
    encoding: format.encoding,
    delimiter: format.delimiter,
  });

  // The header is located again rather than carried in the format, because
  // `detectedFormatSchema` has no field for the external-id column and must not
  // grow one: it is a wire type and the browser has no use for it. The five
  // columns the reader can correct come from `format`; the id column, which is
  // not correctable, is re-derived. Both readings come from the same header line.
  const header = findHeader(read.records);
  const columns = { ...format.columns, externalId: header.columns.externalId };
  const data = read.records.slice(header.recordIndex + 1);

  const template = parseDateTemplate(format.dateFormat);
  const exponent = exponentOf(opts.currency);
  const amountFormat: AmountFormat = {
    decimal: format.decimal,
    // `parseAmount` reads `decimal` and nothing else. The other two fields are
    // the detector's account of how it decided, carried through so a caller that
    // hands this object on still has them.
    reason: format.decimalReason as AmountFormat['reason'],
    ambiguous: format.decimalAmbiguous,
  };

  const byKey = new Map<string, DuplicateEntry[]>();
  const byExternalId = new Map<string, DuplicateEntry>();
  for (const existing of ctx.existing) {
    push(byKey, duplicateKey(existing.amountMinor, existing.description), {
      id: existing.id,
      bookedOn: existing.bookedOn,
      line: null,
    });
    if (existing.externalId !== null && existing.externalId !== '') {
      if (!byExternalId.has(existing.externalId)) {
        byExternalId.set(existing.externalId, {
          id: existing.id,
          bookedOn: existing.bookedOn,
          line: null,
        });
      }
    }
  }

  const rows: ImportPreviewRow[] = [];
  const plan: PlannedRow[] = [];

  for (const record of data) {
    const description = cellAt(record, columns.description).slice(0, MAX_DESCRIPTION);
    const externalId = emptyToNull(cellAt(record, columns.externalId));

    let parsed: ParsedRow;
    try {
      parsed = parseRow(record, columns, template, amountFormat, exponent, format.dateFormat);
    } catch (error) {
      rows.push({
        lineNumber: record.line,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        bookedOn: null,
        amountMinor: null,
        description,
        suggestedCategoryId: null,
        suggestedBy: null,
        duplicateOfId: null,
      });
      continue;
    }

    const duplicate = findDuplicate(
      { byKey, byExternalId },
      parsed,
      description,
      externalId,
      opts.duplicateWindowDays,
    );

    const match = categorize(ctx.rules, {
      description,
      amountMinor: parsed.amountMinor,
    });

    rows.push({
      lineNumber: record.line,
      status: duplicate === null ? 'new' : 'duplicate',
      message: duplicate?.message ?? null,
      bookedOn: parsed.bookedOn,
      amountMinor: parsed.amountMinor,
      description,
      suggestedCategoryId: match?.categoryId ?? null,
      suggestedBy: match?.reason ?? null,
      duplicateOfId: duplicate?.id ?? null,
    });

    plan.push({
      lineNumber: record.line,
      bookedOn: parsed.bookedOn,
      amountMinor: parsed.amountMinor,
      description,
      merchant: emptyToNull(merchantOf(description)),
      externalId,
      fingerprint: fingerprintOf(ctx.accountId, parsed.bookedOn, parsed.amountMinor, description),
      categoryId: match?.categoryId ?? null,
      categorySource: match === null ? 'none' : 'rule',
      ruleId: match?.ruleId ?? null,
    });

    // Registered after it has been judged, so a row never matches itself, and
    // before the next row is read, so the second copy of a line inside one file
    // sees the first.
    push(byKey, duplicateKey(parsed.amountMinor, description), {
      id: null,
      bookedOn: parsed.bookedOn,
      line: record.line,
    });
    if (externalId !== null && !byExternalId.has(externalId)) {
      byExternalId.set(externalId, { id: null, bookedOn: parsed.bookedOn, line: record.line });
    }
  }

  const counts = tally(rows);

  return {
    importId: ctx.importId,
    filename: ctx.filename,
    accountId: ctx.accountId,
    format,
    // `ready` means "this file was read"; it is not a judgement on the rows. A
    // file the parser could not open never gets here, it throws an `ImportError`,
    // and marking the import `failed` is then the API's call.
    status: 'ready',
    counts,
    rows,
    plan,
  };
}

/**
 * The rows to insert: everything that is not an error and not skipped.
 *
 * Note what is *not* here: duplicates are includable. The sane default -- skip
 * every row flagged `duplicate` -- lives in the caller, because it is a default
 * about what a person probably wants, and this function is about what they
 * actually chose. A user who looks at two identical coffees on the same day and
 * decides both are real needs to be able to say so, and if the filter were
 * hardcoded here there would be no way to express it.
 *
 * Error rows have no day and no amount, so they are excluded unconditionally.
 * They are already absent from `plan`; the filter below is only about `skipLines`.
 */
export function planCommit(preview: PreviewResult, skipLines: readonly number[]): PlannedRow[] {
  const skipped = new Set(skipLines);
  return preview.plan.filter((row) => !skipped.has(row.lineNumber));
}

interface RowColumns {
  date: number;
  description: number;
  amount: number;
  credit: number | null;
  balance: number | null;
  externalId: number | null;
}

function parseRow(
  record: StatementRecord,
  columns: RowColumns,
  template: ReturnType<typeof parseDateTemplate>,
  amountFormat: AmountFormat,
  exponent: number,
  dateFormat: string,
): ParsedRow {
  if (template === null) {
    throw new Error(
      dateFormat === UNKNOWN_DATE_FORMAT
        ? 'No date in this column could be recognised, so no row can be dated.'
        : `The date format "${dateFormat}" is not one this importer can apply.`,
    );
  }

  const bookedOn = parseStatementDay(cellAt(record, columns.date), template);
  const amountMinor = readAmount(record, columns, amountFormat, exponent);

  if (Math.abs(amountMinor) > MAX_AMOUNT_MINOR) {
    throw new Error(
      `The amount is ${amountMinor} minor units, past what the ledger stores. That usually means the decimal separator was read the wrong way round.`,
    );
  }

  return { bookedOn, amountMinor };
}

/**
 * One signed amount, from either one column or two.
 *
 * When the bank splits debit and credit, the **column carries the sign** and the
 * values are magnitudes. Subtracting them as written (`credit - debit`) is the
 * obvious reading and it breaks on the exports that write the debit as `-52,40`
 * in a column already named "Debit": the two negatives cancel and a supermarket
 * shop becomes income. Taking the magnitude and applying the column's own sign
 * is correct for both conventions, and the case it cannot express -- a negative
 * *credit*, meaning a reversed payment -- is written into the debit column by
 * every bank that has one.
 */
function readAmount(
  record: StatementRecord,
  columns: RowColumns,
  amountFormat: AmountFormat,
  exponent: number,
): number {
  const primary = cellAt(record, columns.amount);

  if (columns.credit === null) {
    if (primary === '') throw new Error('The amount cell is empty or the row is too short.');
    return parseAmount(primary, amountFormat, exponent);
  }

  const creditCell = cellAt(record, columns.credit);
  if (primary === '' && creditCell === '') {
    throw new Error('Both the debit and the credit cell are empty.');
  }

  const debit = primary === '' ? 0 : Math.abs(parseAmount(primary, amountFormat, exponent));
  const credit = creditCell === '' ? 0 : Math.abs(parseAmount(creditCell, amountFormat, exponent));
  return credit - debit;
}

interface DuplicateIndexes {
  byKey: Map<string, DuplicateEntry[]>;
  byExternalId: Map<string, DuplicateEntry>;
}

interface DuplicateVerdict {
  id: string | null;
  message: string;
}

/**
 * Two mechanisms, in order of how much they prove.
 *
 * The bank's own row id is an identity, not a resemblance: if it matches, this is
 * the same transaction, and `(account_id, external_id)` is unique in the schema
 * precisely so a re-import cannot get past it. Everything else is a resemblance,
 * and the day window is what keeps it honest -- a €1.20 coffee bought every
 * morning would otherwise mark the whole month as duplicated. Three days is the
 * default because that is roughly how long a card transaction takes to settle,
 * which is the reason the same purchase shows up twice with different dates in
 * the first place.
 */
function findDuplicate(
  indexes: DuplicateIndexes,
  parsed: ParsedRow,
  description: string,
  externalId: string | null,
  windowDays: number,
): DuplicateVerdict | null {
  if (externalId !== null) {
    const hit = indexes.byExternalId.get(externalId);
    if (hit !== undefined) {
      return {
        id: hit.id,
        message:
          hit.line === null
            ? `The bank reference "${externalId}" is already on a transaction in this account.`
            : `The bank reference "${externalId}" also appears on line ${hit.line} of this file.`,
      };
    }
  }

  const candidates = indexes.byKey.get(duplicateKey(parsed.amountMinor, description));
  if (candidates === undefined) return null;

  for (const candidate of candidates) {
    const distance = Math.abs(daysBetween(candidate.bookedOn, parsed.bookedOn));
    if (distance > windowDays) continue;
    return {
      id: candidate.id,
      message:
        candidate.line === null
          ? `Same amount and description as a transaction already booked on ${candidate.bookedOn}.`
          : `Same amount and description as line ${candidate.line} of this file.`,
    };
  }

  return null;
}

/**
 * The duplicate key: amount and normalised description.
 *
 * The day is deliberately not in the key -- it is the thing being compared with a
 * tolerance, and putting it in the key would mean the same purchase settling a
 * day later never collides. Normalising the description is what makes
 * `MERCADONA 4023 MADRID` and `MERCADONA 4197 MADRID` the same shop; see
 * `packages/shared/src/text/normalise.ts` for why those digits are noise.
 */
function duplicateKey(amountMinor: number, description: string): string {
  return `${amountMinor} ${normaliseDescription(description)}`;
}

/**
 * The counts, tallied from the rows they describe rather than incremented
 * alongside them.
 *
 * A count that disagrees with its rows is the kind of bug that survives review:
 * the preview looks right, the summary line says "412 new" and the commit inserts
 * 411. Deriving it from the array makes the two impossible to diverge, and the
 * check below is a statement that nothing was added to `ImportRowStatus` without
 * being counted.
 */
function tally(rows: readonly ImportPreviewRow[]): {
  total: number;
  new: number;
  duplicate: number;
  error: number;
} {
  const counts = {
    total: rows.length,
    new: rows.filter((row) => row.status === 'new').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    error: rows.filter((row) => row.status === 'error').length,
  };
  if (counts.new + counts.duplicate + counts.error !== counts.total) {
    throw new Error(
      `Import counts do not add up: ${counts.new} + ${counts.duplicate} + ${counts.error} is not ${counts.total}.`,
    );
  }
  return counts;
}

function push(index: Map<string, DuplicateEntry[]>, key: string, entry: DuplicateEntry): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [entry]);
  else existing.push(entry);
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
