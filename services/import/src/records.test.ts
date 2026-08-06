import { describe, expect, it } from 'vitest';
import { ImportError } from './errors';
import { cellAt, readStatement } from './records';
import type { ParseOptions } from './types';

const opts: ParseOptions = {
  localeDecimal: ',',
  currency: 'EUR',
  maxBytes: 8_388_608,
  duplicateWindowDays: 3,
};

describe('readStatement', () => {
  it('numbers records by file line, not by array position, across a ragged row', () => {
    // Row 2 is short by one cell (no amount). `csv-parse` accepts it because
    // `relax_column_count` is set; the row parser is what turns a missing cell
    // into a per-row error later, not this layer.
    const bytes = Buffer.from(
      'Fecha,Concepto,Importe\n01/01/2026,Cafe\n02/01/2026,Bar,-1.50\n',
      'utf8',
    );
    const read = readStatement(bytes, opts);
    expect(read.records.map((r) => r.line)).toEqual([1, 2, 3]);
    expect(read.records[1]!.cells).toEqual(['01/01/2026', 'Cafe']);
  });

  it('counts a blank line toward the line number without producing a record for it', () => {
    // If the blank line were dropped before counting, line 4 below it would
    // report as line 3 and every message past the gap would point at the wrong
    // row in the reader's editor.
    const bytes = Buffer.from(
      'Fecha,Concepto,Importe\n01/01/2026,Cafe,-1,00\n\n02/01/2026,Bar,-2,00\n',
      'utf8',
    );
    const read = readStatement(bytes, opts);
    expect(read.records.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it('drops trailing blank lines instead of emitting empty records for them', () => {
    const bytes = Buffer.from('Fecha,Concepto,Importe\n01/01/2026,Cafe,-1,00\n\n\n', 'utf8');
    const read = readStatement(bytes, opts);
    expect(read.records).toHaveLength(2);
    expect(read.records[1]!.line).toBe(2);
  });

  it('honours ReadOverrides instead of re-sniffing the delimiter and encoding', () => {
    // A file that is legitimately pipe-delimited, forced to be read as `;`
    // instead: every cell degrades into one glued string. This is what proves
    // the override was actually applied rather than silently ignored.
    const bytes = Buffer.from('a|b|c\n1|2|3\n', 'utf8');
    const auto = readStatement(bytes, opts);
    expect(auto.delimiter).toBe('|');

    const forced = readStatement(bytes, opts, { delimiter: ';' });
    expect(forced.delimiter).toBe(';');
    expect(forced.records[0]!.cells).toEqual(['a|b|c']);
  });

  it('rejects a file over the byte ceiling before decoding it', () => {
    const tight: ParseOptions = { ...opts, maxBytes: 4 };
    expect(() => readStatement(Buffer.from('abcdefgh'), tight)).toThrow(ImportError);
  });

  it('rejects an empty file', () => {
    expect(() => readStatement(Buffer.alloc(0), opts)).toThrow(ImportError);
  });
});

describe('cellAt', () => {
  it('trims the cell at a valid index', () => {
    const bytes = Buffer.from('Fecha,Concepto,Importe\n01/01/2026, Cafe ,-1.50\n', 'utf8');
    const read = readStatement(bytes, opts);
    expect(cellAt(read.records[1]!, 1)).toBe('Cafe');
  });

  it('returns an empty string for a row too short to have the cell', () => {
    const bytes = Buffer.from('Fecha,Concepto,Importe\n01/01/2026,Cafe\n', 'utf8');
    const read = readStatement(bytes, opts);
    expect(cellAt(read.records[1]!, 2)).toBe('');
  });

  it('returns an empty string when the column index is null', () => {
    const bytes = Buffer.from('Fecha,Concepto,Importe\n01/01/2026,Cafe,-1.50\n', 'utf8');
    const read = readStatement(bytes, opts);
    expect(cellAt(read.records[1]!, null)).toBe('');
  });
});
