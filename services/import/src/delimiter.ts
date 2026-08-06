/**
 * Which character separates the fields.
 *
 * Nobody tells us. The upload is "a CSV", and in practice that means one of four
 * characters, chosen by whichever region the bank's export team lives in. Getting
 * it wrong does not produce an error, it produces a one-column file whose single
 * cell is the entire line, and the header scan then reports that there is no date
 * column in a file whose first word is `Fecha`.
 *
 * The signal is **consistency, not frequency**. A Spanish statement delimited by
 * `;` also contains a comma in every amount (`-52,40`) and a dot in every balance
 * (`1.234,56`), so counting occurrences alone would nominate the comma about as
 * often as the semicolon. What separates them is that the semicolon count is the
 * same on every data line, and so, unfortunately, is the comma count -- which is
 * why the second tiebreak is the field count. Four semicolons beat two commas on
 * the same line because the reading with more fields is the one that puts each
 * value in its own cell instead of gluing a date to a concept.
 *
 * Counting runs outside quotes, and the quote state is carried across newlines.
 * A description containing `Restaurante El Puerto, S.L.` inside quotes must not
 * vote for the comma, and a quoted field that spans two lines must not shift
 * every subsequent line by one.
 */

/** In tiebreak order. `;` first, then `,`: a European export is the likelier upload. */
export const DELIMITERS = [';', ',', '\t', '|'] as const;

export type Delimiter = (typeof DELIMITERS)[number];

/** How many lines from the top the sniff looks at. */
export const SNIFF_LINES = 20;

export function sniffDelimiter(text: string): Delimiter {
  const lines = countsPerLine(text);
  if (lines.length === 0) return ',';

  let best: Delimiter = ',';
  let bestConsistency = 0;
  let bestFields = 0;

  for (const candidate of DELIMITERS) {
    const counts = lines.map((line) => line[candidate] ?? 0).filter((count) => count > 0);
    if (counts.length === 0) continue;

    const modal = modalValue(counts);
    const consistency = counts.filter((count) => count === modal).length / lines.length;

    // Strictly greater on both comparisons, so an earlier candidate in
    // `DELIMITERS` wins a true tie. That is the whole tiebreak rule: it lives in
    // the array order rather than in a chain of ifs nobody can read.
    if (consistency > bestConsistency || (consistency === bestConsistency && modal > bestFields)) {
      best = candidate;
      bestConsistency = consistency;
      bestFields = modal;
    }
  }

  return best;
}

/** Per-line occurrence counts for every candidate, quotes excluded. */
function countsPerLine(text: string): Array<Partial<Record<Delimiter, number>>> {
  const lines: Array<Partial<Record<Delimiter, number>>> = [];
  let current: Partial<Record<Delimiter, number>> = {};
  let sawContent = false;
  let inQuotes = false;

  for (const character of text) {
    if (character === '"') {
      // A doubled quote inside a quoted field toggles twice and lands back where
      // it started, which is the correct answer for counting purposes even
      // though it is not how a parser would model it.
      inQuotes = !inQuotes;
      sawContent = true;
      continue;
    }
    if (character === '\n' && !inQuotes) {
      if (sawContent) lines.push(current);
      if (lines.length >= SNIFF_LINES) return lines;
      current = {};
      sawContent = false;
      continue;
    }
    if (character === '\r') continue;

    if (!inQuotes && isDelimiter(character)) {
      current[character] = (current[character] ?? 0) + 1;
    }
    if (character.trim() !== '' || inQuotes) sawContent = true;
  }

  if (sawContent) lines.push(current);
  return lines;
}

function isDelimiter(character: string): character is Delimiter {
  return (DELIMITERS as readonly string[]).includes(character);
}

/** The most common count, ties broken toward the larger one. */
function modalValue(counts: readonly number[]): number {
  const tally = new Map<number, number>();
  for (const count of counts) tally.set(count, (tally.get(count) ?? 0) + 1);

  let modal = 0;
  let best = 0;
  for (const [value, occurrences] of tally) {
    if (occurrences > best || (occurrences === best && value > modal)) {
      modal = value;
      best = occurrences;
    }
  }
  return modal;
}
