import { describe, expect, it } from 'vitest';
import { sniffDelimiter } from './delimiter';

describe('sniffDelimiter', () => {
  it('picks each of the four candidates when it is the consistent one', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6\n')).toBe(';');
    expect(sniffDelimiter('a,b,c\n1,2,3\n4,5,6\n')).toBe(',');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6\n')).toBe('\t');
    expect(sniffDelimiter('a|b|c\n1|2|3\n4|5|6\n')).toBe('|');
  });

  it('does not vote for a delimiter hidden inside quotes', () => {
    // Each quoted field carries an extra semicolon. If that one counted, the
    // per-line semicolon count would be 3 rather than the consistent 2 the real
    // field separators produce, and consistency is exactly what the sniff scores
    // on. `;` still wins outright, which is only true if the quoted one never
    // entered the tally.
    expect(sniffDelimiter('a;b;c\n"x;y";2;3\n"p;q";5;6\n')).toBe(';');
  });

  it('falls back to the default when a file has only one column', () => {
    // No candidate delimiter appears anywhere, so there is no consistency signal
    // to read at all. The fallback is `,`, first in `DELIMITERS`.
    expect(sniffDelimiter('onlycol\nrow1\nrow2\n')).toBe(',');
  });

  it('is unmoved by a bank preamble that has no delimiter opinion of its own', () => {
    // The first line names the bank, not a field. It contributes nothing to
    // either candidate's count, so the header and data lines below it still
    // settle the vote.
    const withPreamble = 'Some Bank Statement\nFecha;Concepto;Importe\n01/01/2026;Cafe;-3,20\n';
    expect(sniffDelimiter(withPreamble)).toBe(';');
  });
});
