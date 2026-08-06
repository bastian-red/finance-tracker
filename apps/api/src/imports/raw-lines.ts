/**
 * The verbatim text behind each parsed record.
 *
 * `import_rows.raw` exists because when an import goes wrong the only useful
 * question is "what did the file actually say", and by then the upload is a
 * `PlannedRow` and the file is a blob on disk nobody will open. The parser hands
 * back cells, and re-joining cells with the delimiter is not the same string: it
 * loses the quoting, the padding and the trailing separator, which are exactly
 * the three things that make a statement parse wrongly in the first place.
 *
 * So the text is sliced out of the decoded file by line number. A record that
 * spans several physical lines (a quoted description containing a newline) keeps
 * all of them, because its span runs to the line before the next record starts.
 * The last record runs to the end of the file.
 */

/** `import_rows.raw` is `VARCHAR(2000)`. Longer input is stored truncated, marked. */
export const MAX_RAW = 2_000;
const TRUNCATION_MARK = '…';

/**
 * Map a record's 1-based start line to the verbatim text of that record.
 *
 * `starts` must be ascending, which is what `readStatement` produces. Anything
 * else would make the spans overlap, and the function would silently return the
 * wrong text rather than fail, so the order is asserted rather than assumed.
 */
export function rawLinesOf(text: string, starts: readonly number[]): Map<number, string> {
  const lines = text.split(/\r?\n/);
  const raw = new Map<number, string>();

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] as number;
    const previous = index === 0 ? 0 : (starts[index - 1] as number);
    if (index > 0 && start <= previous) {
      throw new Error(`Record start lines must ascend; got ${previous} then ${start}.`);
    }

    // Exclusive end: the line before the next record begins, or the end of the
    // file for the last one.
    const end = index + 1 < starts.length ? (starts[index + 1] as number) - 1 : lines.length;
    const span = lines
      .slice(start - 1, end)
      .join('\n')
      // Blank lines between records belong to neither, and `readStatement` has
      // already dropped them as records. Trailing whitespace is dropped for the
      // same reason; leading whitespace is kept, because an indented row is
      // evidence about the file.
      .replace(/\s+$/, '');

    raw.set(start, truncateRaw(span));
  }

  return raw;
}

/**
 * Fit the column, and say so.
 *
 * A silent truncation at 2000 characters produces a stored line that looks
 * complete and is not, which is worse than no line at all: the reader draws a
 * conclusion about a file from text that was cut. The ellipsis costs one
 * character of budget and makes the cut visible.
 */
export function truncateRaw(value: string): string {
  if (value.length <= MAX_RAW) return value;
  return `${value.slice(0, MAX_RAW - TRUNCATION_MARK.length)}${TRUNCATION_MARK}`;
}
