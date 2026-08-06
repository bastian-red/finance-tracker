/**
 * Bytes in, numbered rows out.
 *
 * This is the one place that touches `csv-parse`, and the reason it is wrapped
 * rather than called directly from two places is the line numbering. Every
 * message this service produces points at a line, because the reader's next move
 * is to open the file in a text editor and look at it. That means **file** line
 * numbers, 1-based, counting the metadata lines above the header and the blank
 * lines nobody thinks about -- not the index of the row in an array, which is the
 * number that is easy to produce and useless to receive.
 *
 * `csv-parse` reports `info.lines` as the line a record *ends* on, which differs
 * from where it starts exactly when a quoted description contains a newline. The
 * start line is what a person wants, so it is derived from the previous record's
 * end. Blank lines are parsed rather than skipped for the same reason: skipping
 * them inside the parser would silently shift every line number after the first
 * gap.
 */
import { parse } from 'csv-parse/sync';
import { decodeStatement, decodeStatementAs, type EncodingName } from './encoding';
import { sniffDelimiter } from './delimiter';
import { ImportError } from './errors';
import type { ParseOptions } from './types';

export interface StatementRecord {
  /** 1-based file line where this record starts. */
  line: number;
  cells: readonly string[];
}

export interface StatementRead {
  encoding: EncodingName;
  delimiter: string;
  records: StatementRecord[];
}

/** What `csv-parse` yields per record with `info: true`. */
interface RawRecord {
  record: string[];
  info: { lines: number };
}

export interface ReadOverrides {
  /** From a `DetectedFormat` that has already been decided, or corrected by hand. */
  encoding?: string;
  delimiter?: string;
}

export function readStatement(
  bytes: Buffer,
  options: ParseOptions,
  overrides: ReadOverrides = {},
): StatementRead {
  // Checked before a single byte is decoded. The ceiling exists to stop a
  // 400 MB upload from being turned into an 800 MB string first and refused
  // second, which is the version of this check that still takes the process down.
  if (bytes.length > options.maxBytes) {
    throw new ImportError(
      'too-large',
      `The file is ${bytes.length} bytes and the limit is ${options.maxBytes}. Split the statement or narrow the date range on the export.`,
    );
  }
  if (bytes.length === 0) {
    throw new ImportError('empty', 'The file is empty.');
  }

  const decoded =
    overrides.encoding === undefined
      ? decodeStatement(bytes)
      : decodeStatementAs(bytes, overrides.encoding);

  if (decoded.text.trim() === '') {
    throw new ImportError('empty', 'The file contains no text, only whitespace.');
  }

  const delimiter = overrides.delimiter ?? sniffDelimiter(decoded.text);

  let raw: RawRecord[];
  try {
    raw = parse(decoded.text, {
      delimiter,
      info: true,
      // A statement with one short line is a statement with one bad row, not an
      // unreadable file. The row parser reports the missing cell per row.
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      // The BOM is already gone: `decodeStatement` strips it, and for UTF-16 it
      // has to, since csv-parse is looking at a string by this point.
      bom: false,
    }) as RawRecord[];
  } catch (error) {
    throw new ImportError(
      'unreadable',
      `The file could not be parsed as delimited text: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const records: StatementRecord[] = [];
  let previousEnd = 0;
  for (const item of raw) {
    const start = previousEnd + 1;
    previousEnd = item.info.lines;
    // Blank lines are dropped only after their line number has been counted.
    if (item.record.every((cell) => cell.trim() === '')) continue;
    records.push({ line: start, cells: item.record });
  }

  return { encoding: decoded.encoding, delimiter, records };
}

/** The cell at `index`, trimmed, or `''` when the row is too short to have one. */
export function cellAt(record: StatementRecord, index: number | null): string {
  if (index === null) return '';
  return (record.cells[index] ?? '').trim();
}
