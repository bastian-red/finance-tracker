import { describe, expect, it } from 'vitest';
import { MAX_RAW, rawLinesOf, truncateRaw } from './raw-lines';

/**
 * Pins that `import_rows.raw` is the file's own text, not a re-rendering of it.
 *
 * The column exists to answer "what did the file actually say" months after the
 * upload is a blob nobody will open. Re-joining the parser's cells with the
 * delimiter would produce a string that looks right and is not: the quoting, the
 * padding and the trailing separator are gone, and those three are precisely
 * what makes a statement parse wrongly in the first place. So the text is sliced
 * out of the decoded file by line number, and the tests below pin the four
 * slicing rules and the truncation.
 *
 * The truncation mark is written as an escape rather than pasted: a
 * one-character ellipsis and three full stops are hard to tell apart in a diff,
 * and the length arithmetic depends on which one it is.
 */

/** The single-character ellipsis `truncateRaw` appends, U+2026. */
const MARK = '\u2026';

describe('rawLinesOf', () => {
  it('gives each single-line record its own line', () => {
    const text = [
      'date;description;amount',
      '2026-03-01;MERCADONA;-12,34',
      '2026-03-02;EMT;-1,50',
    ].join('\n');

    // 1-based, and the header is line 1, so records start at 2.
    expect(rawLinesOf(text, [2, 3])).toEqual(
      new Map([
        [2, '2026-03-01;MERCADONA;-12,34'],
        [3, '2026-03-02;EMT;-1,50'],
      ]),
    );
  });

  it('keeps every physical line of a record that spans several', () => {
    // A quoted description containing a newline. This is the case the whole
    // by-line-number design exists for: the parser hands back one record, and
    // the file spent three lines saying it.
    const text = [
      'date;description;amount',
      '2026-03-01;"TRANSFERENCIA',
      'CONCEPTO: alquiler',
      'marzo";-95000',
      '2026-03-02;EMT;-1,50',
    ].join('\n');

    const raw = rawLinesOf(text, [2, 5]);
    expect(raw.get(2)).toBe('2026-03-01;"TRANSFERENCIA\nCONCEPTO: alquiler\nmarzo";-95000');
    expect(raw.get(5)).toBe('2026-03-02;EMT;-1,50');
  });

  it('normalises CRLF to LF, so the stored text has no stray carriage returns', () => {
    // Bank exports are overwhelmingly CRLF. A `\r` surviving into the column
    // renders as a blank line in the UI and breaks any `===` against a value
    // typed by a person.
    const text = 'date;amount\r\n2026-03-01;-12,34\r\n2026-03-02;-1,50\r\n';
    const raw = rawLinesOf(text, [2, 3]);

    expect(raw.get(2)).toBe('2026-03-01;-12,34');
    expect(raw.get(3)).toBe('2026-03-02;-1,50');
    expect([...raw.values()].join('')).not.toContain('\r');
  });

  it('runs the last record to the end of the file', () => {
    // There is no "next record" to bound it, and a footer line belongs to the
    // record above it rather than to nothing.
    const text = ['date;amount', '2026-03-01;-12,34', 'TOTAL;-12,34'].join('\n');
    expect(rawLinesOf(text, [2]).get(2)).toBe('2026-03-01;-12,34\nTOTAL;-12,34');
  });

  it('strips the trailing blank lines a file ends with', () => {
    // Almost every export ends with a newline, and some end with several. Those
    // belong to no record, and storing them makes the column look padded.
    const text = 'date;amount\n2026-03-01;-12,34\n\n\n';
    expect(rawLinesOf(text, [2]).get(2)).toBe('2026-03-01;-12,34');
  });

  it('keeps leading whitespace, because an indented row is evidence', () => {
    // Asymmetric on purpose. Trailing whitespace is noise from the writer;
    // leading whitespace is often the reason a row parsed strangely.
    const text = 'date;amount\n   2026-03-01;-12,34   ';
    expect(rawLinesOf(text, [2]).get(2)).toBe('   2026-03-01;-12,34');
  });

  it('handles a single record occupying the whole file', () => {
    expect(rawLinesOf('only line', [1])).toEqual(new Map([[1, 'only line']]));
  });

  it('returns an empty map for no records', () => {
    expect(rawLinesOf('date;amount\n', [])).toEqual(new Map());
  });

  it('refuses starts that do not ascend, rather than returning the wrong text', () => {
    // Descending starts make the spans overlap, and the function would happily
    // return a record's text for a different record. Failing is the only way
    // that is ever noticed.
    const text = 'a\nb\nc\nd';
    expect(() => rawLinesOf(text, [3, 2])).toThrow(/ascend/);
    expect(() => rawLinesOf(text, [1, 3, 2])).toThrow(/ascend/);
  });

  it('refuses a repeated start, which would map two records to one key', () => {
    // The check is `<=`, not `<`. Two records claiming line 2 would collapse
    // into one entry in the map and the second one would silently disappear.
    expect(() => rawLinesOf('a\nb\nc', [2, 2])).toThrow(/ascend/);
  });

  it('names both offending line numbers, so the caller is debuggable', () => {
    expect(() => rawLinesOf('a\nb\nc', [3, 2])).toThrow(/3 then 2/);
  });

  it('truncates a record that will not fit the column', () => {
    const long = 'x'.repeat(MAX_RAW + 500);
    const stored = rawLinesOf(long, [1]).get(1);

    // The whole point of routing through `truncateRaw` here: an untruncated
    // value reaches Postgres and the insert fails with "value too long for type
    // character varying(2000)", which aborts the entire import transaction.
    expect(stored).toHaveLength(MAX_RAW);
    expect(stored?.endsWith(MARK)).toBe(true);
  });
});

describe('truncateRaw', () => {
  it('leaves a value one character under the limit alone', () => {
    const value = 'x'.repeat(MAX_RAW - 1);
    expect(truncateRaw(value)).toBe(value);
    expect(truncateRaw(value)).toHaveLength(MAX_RAW - 1);
  });

  it('leaves a value at exactly the limit alone', () => {
    // The boundary is `<=`. At exactly 2000 the column holds it, so marking it
    // as cut would be a lie about a complete line.
    const value = 'x'.repeat(MAX_RAW);
    expect(truncateRaw(value)).toBe(value);
    expect(truncateRaw(value)).not.toContain(MARK);
  });

  it('cuts a value one character over the limit and says so', () => {
    // A silent cut at 2000 produces a line that looks complete and is not, and
    // the reader draws a conclusion about the file from text that was trimmed.
    const value = 'x'.repeat(MAX_RAW + 1);
    const cut = truncateRaw(value);

    expect(cut).toHaveLength(MAX_RAW);
    expect(cut.endsWith(MARK)).toBe(true);
    expect(cut.slice(0, -1)).toBe('x'.repeat(MAX_RAW - 1));
  });

  it('spends the mark out of the budget, never on top of it', () => {
    // The mark costs one character of the 2000, so the result is exactly 2000
    // and not 2001. 2001 is the version that still fails the insert.
    for (const extra of [1, 2, 500, 10_000]) {
      expect(truncateRaw('y'.repeat(MAX_RAW + extra))).toHaveLength(MAX_RAW);
    }
  });

  it('leaves an empty value empty', () => {
    expect(truncateRaw('')).toBe('');
  });
});
