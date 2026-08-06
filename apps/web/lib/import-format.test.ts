import type { DetectedFormat } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import {
  bareDateFormat,
  DATE_FORMAT_CHOICES,
  DELIMITER_CHOICES,
  delimiterCharOf,
  delimiterNameOf,
  ENCODING_CHOICES,
  formatAmbiguities,
  importRowLabel,
} from './import-format';

/**
 * The import screen's vocabulary, and the two traps it exists to dodge.
 *
 * **A delimiter cannot round-trip as a form value.** Tab is one of the four
 * separators a bank export uses, `lib/form-fields.ts` trims every string it
 * reads out of a `FormData`, and `"\t".trim()` is the empty string. A select
 * whose option value was the character itself would send nothing for a
 * tab-delimited file and fail the contract's `length(1)` on a field the user
 * never touched. So the option carries a *name*, and these cases pin the
 * mapping in both directions.
 *
 * **The detector's date answer is not a template.** `detectDateFormat` returns
 * `DD/MM/YYYY (day-first assumed)` when the file carried no evidence either way,
 * and that string matches no option in the select, which then silently displays
 * its first entry instead. `bareDateFormat` is what stops the form offering to
 * "correct" a day-first file to day-first while showing something else.
 */

const format = (patch: Partial<DetectedFormat> = {}): DetectedFormat => ({
  delimiter: ';',
  decimal: ',',
  decimalReason: 'both-separators-present',
  decimalAmbiguous: false,
  dateFormat: 'DD/MM/YYYY',
  encoding: 'latin1',
  columns: { date: 0, description: 2, amount: 3, credit: null, balance: 4 },
  ...patch,
});

describe('delimiter choices', () => {
  it('never carries a whitespace character as an option value', () => {
    // The whole reason names exist. If any option value were the character
    // itself, a trim on the way back would erase it.
    for (const choice of DELIMITER_CHOICES) {
      expect(choice.name.trim(), choice.name).toBe(choice.name);
      expect(choice.name.length, choice.name).toBeGreaterThan(0);
    }
  });

  it('maps a name to its character, including the tab', () => {
    expect(delimiterCharOf('semicolon')).toBe(';');
    expect(delimiterCharOf('comma')).toBe(',');
    expect(delimiterCharOf('pipe')).toBe('|');
    expect(delimiterCharOf('tab')).toBe('\t');
  });

  it('maps a character back to the name to preselect', () => {
    expect(delimiterNameOf(';')).toBe('semicolon');
    expect(delimiterNameOf('\t')).toBe('tab');
    expect(delimiterNameOf('|')).toBe('pipe');
  });

  it('round-trips every choice, so a correction cannot change the delimiter', () => {
    for (const choice of DELIMITER_CHOICES) {
      const char = delimiterCharOf(choice.name);
      expect(char, choice.name).not.toBeNull();
      expect(delimiterNameOf(char as string)).toBe(choice.name);
      // And the character is exactly one, which is what the contract requires.
      expect((char as string).length, choice.name).toBe(1);
    }
  });

  it('answers null for a name nobody offered, rather than inventing a separator', () => {
    // A null becomes "pick one of the listed separators" in the action. Falling
    // back to a comma would re-parse a semicolon file into one giant column and
    // report it as the user's choice.
    expect(delimiterCharOf('')).toBeNull();
    expect(delimiterCharOf('colon')).toBeNull();
  });

  it('falls back to a real option for a character it does not know', () => {
    // The opposite direction has to be total: a `<select>` given a value that
    // matches no option shows its first entry, so returning something valid
    // keeps the form and the stored format in agreement.
    expect(DELIMITER_CHOICES.map((choice) => choice.name)).toContain(delimiterNameOf(':'));
  });
});

describe('bareDateFormat', () => {
  it('strips the detector commentary that no option carries', () => {
    expect(bareDateFormat('DD/MM/YYYY (day-first assumed)')).toBe('DD/MM/YYYY');
  });

  it('leaves a clean template alone', () => {
    expect(bareDateFormat('YYYY-MM-DD')).toBe('YYYY-MM-DD');
  });

  it('produces a value that is actually one of the options', () => {
    const values = DATE_FORMAT_CHOICES.map((choice) => choice.value);
    expect(values).toContain(bareDateFormat('DD/MM/YYYY (day-first assumed)'));
    expect(values).toContain(bareDateFormat('MM.DD.YYYY'));
  });
});

describe('formatAmbiguities', () => {
  it('says nothing when the file settled every question itself', () => {
    expect(formatAmbiguities(format())).toEqual([]);
  });

  it('surfaces an undecidable decimal as a question, not a log line', () => {
    // A statement whose amounts are all whole euros contains no evidence about
    // its own decimal separator. It is not an error and it puts every amount out
    // by a factor of a hundred if the guess was wrong.
    const notes = formatAmbiguities(format({ decimalAmbiguous: true, decimal: '.' }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"."');
  });

  it('surfaces an undecidable date order', () => {
    const notes = formatAmbiguities(format({ dateFormat: 'DD/MM/YYYY (day-first assumed)' }));
    expect(notes.join(' ')).toContain('day-first was assumed');
  });

  it('says so when no column looks like dates at all', () => {
    const notes = formatAmbiguities(format({ dateFormat: 'unknown' }));
    expect(notes.join(' ')).toContain('No column in this file looks like dates');
  });

  it('reports both when both are open questions', () => {
    const notes = formatAmbiguities(
      format({ decimalAmbiguous: true, dateFormat: 'DD/MM/YYYY (day-first assumed)' }),
    );
    expect(notes).toHaveLength(2);
  });
});

describe('importRowLabel', () => {
  it('gives every status a word, so colour is never the only channel', () => {
    // The measured reason: on this canvas no green, amber and red all clear AA
    // against the surface and separate from each other in greyscale. The word is
    // the signal; the colour only agrees with it.
    for (const status of ['new', 'duplicate', 'error'] as const) {
      const label = importRowLabel(status);
      expect(label.word.length, status).toBeGreaterThan(0);
      expect(label.glyph.length, status).toBeGreaterThan(0);
      expect(label.className, status).toMatch(/^state-/);
    }
  });

  it('gives the three statuses three distinct words and three distinct glyphs', () => {
    const labels = (['new', 'duplicate', 'error'] as const).map(importRowLabel);
    expect(new Set(labels.map((label) => label.word)).size).toBe(3);
    expect(new Set(labels.map((label) => label.glyph)).size).toBe(3);
  });

  it('names the duplicate state in the reader words, not the schema words', () => {
    // "duplicate" is what the contract calls it. A person looking at their own
    // statement is asking whether this row is already in their ledger.
    expect(importRowLabel('duplicate').word).toBe('Duplicate');
    expect(importRowLabel('error').word).toBe('Error');
    expect(importRowLabel('new').word).toBe('New');
  });
});

describe('encoding choices', () => {
  it('offers the fallback the importer actually uses', () => {
    // `@fin/import` falls back to latin1, and a Spanish or German export read as
    // UTF-8 shows mangled accents rather than failing, which is the symptom this
    // select exists to let somebody fix.
    expect(ENCODING_CHOICES.map((choice) => choice.value)).toContain('latin1');
    expect(ENCODING_CHOICES.map((choice) => choice.value)).toContain('utf-8');
  });
});
