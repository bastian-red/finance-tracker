/**
 * Everything the importer decides about a file *before* it looks at a single
 * transaction.
 *
 * Encoding, delimiter, header position, column roles, decimal separator, date
 * order: six decisions, each of which is wrong in a way that is invisible on
 * screen, and each of which is made from the whole file rather than from the
 * first row. That is the shape of the whole module -- a per-value guess is a
 * coin flip repeated a thousand times, and a per-column decision is one call the
 * reader can check and correct.
 *
 * The result is a `DetectedFormat`, which is a wire type: it goes to the browser,
 * gets shown as "semicolon separated, comma decimal, day first", and comes back
 * into `buildPreview` unchanged or corrected. So this function decides, and
 * nothing downstream re-decides.
 */
import { detectAmountFormat, MoneyError, type DetectedFormat } from '@fin/shared';
import { findHeader } from './columns';
import { detectDateFormat } from './dates';
import { ImportError } from './errors';
import { cellAt, readStatement, type StatementRecord } from './records';
import type { ParseOptions } from './types';

/** How many data rows the decimal and date scans read. */
export const SAMPLE_LIMIT = 500;

export function detectStatement(bytes: Buffer, opts: ParseOptions): DetectedFormat {
  const read = readStatement(bytes, opts);
  const header = findHeader(read.records);
  const columns = header.columns;
  const data = read.records.slice(header.recordIndex + 1);

  // Both amount columns feed the decimal scan. A debit/credit file writes the
  // same convention in both, and a file whose debits are all whole euros and
  // whose credits carry the cents would otherwise be decided by half the
  // evidence.
  const amountSamples = sample(data, (record) =>
    [cellAt(record, columns.amount), cellAt(record, columns.credit)].filter(
      (value) => value !== '',
    ),
  );

  let amountFormat;
  try {
    amountFormat = detectAmountFormat(amountSamples, opts.localeDecimal);
  } catch (error) {
    // The only way `detectAmountFormat` throws is a column using both characters
    // as decimals in different rows, which has no correct single reading. It says
    // so in words, and that sentence is more use to the reader than a code.
    if (error instanceof MoneyError) throw new ImportError('unreadable', error.message);
    throw error;
  }

  const dateSamples = sample(data, (record) => {
    const cell = cellAt(record, columns.date);
    return cell === '' ? [] : [cell];
  });

  return {
    delimiter: read.delimiter,
    decimal: amountFormat.decimal,
    decimalReason: amountFormat.reason,
    decimalAmbiguous: amountFormat.ambiguous,
    dateFormat: detectDateFormat(dateSamples),
    encoding: read.encoding,
    columns: {
      date: columns.date,
      description: columns.description,
      amount: columns.amount,
      credit: columns.credit,
      balance: columns.balance,
    },
  };
}

/**
 * The first `SAMPLE_LIMIT` rows, not all of them.
 *
 * A five-year export is tens of thousands of rows and the decimal separator is
 * settled by the first dozen. The cap is generous enough that an unambiguous
 * value arriving late still lands inside it, and small enough that detection
 * stays linear in a bounded number rather than in the file.
 */
function sample(
  records: readonly StatementRecord[],
  valuesOf: (record: StatementRecord) => string[],
): string[] {
  const out: string[] = [];
  for (const record of records) {
    out.push(...valuesOf(record));
    if (out.length >= SAMPLE_LIMIT) break;
  }
  return out;
}
