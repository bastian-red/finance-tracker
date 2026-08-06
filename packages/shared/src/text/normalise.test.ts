import { describe, expect, it } from 'vitest';
import { MERCHANT_MAX_LENGTH, merchantOf, normaliseDescription } from './normalise';

/**
 * Every expected string in this file was produced by running the function and
 * pasting the result, not by reasoning about what it ought to be. Unicode
 * normalisation and `\b` against digits are both places where a plausible-looking
 * expectation is wrong, and a wrong expectation invites someone to "fix" correct
 * code until it passes.
 */
describe('normaliseDescription', () => {
  it('reduces real bank descriptions to their merchant', () => {
    // These are the exact strings the seed writes, so a change here shows up as a
    // seed diff rather than as a mysteriously empty category.
    expect(normaliseDescription('MERCADONA 4023 MADRID')).toBe('mercadona madrid');
    expect(normaliseDescription('AMAZON EU S.A R.L.')).toBe('amazon eu s a r l');
    expect(normaliseDescription('NETFLIX.COM')).toBe('netflix com');
    expect(normaliseDescription('ALQUILER PISO C/ ATOCHA')).toBe('alquiler piso c atocha');
    expect(normaliseDescription('REPSOL E.S. 1187')).toBe('repsol e s');
  });

  it('drops reference numbers but keeps short ones that identify a store', () => {
    // Four digits is the line. Card suffixes and terminal ids are four or more;
    // `214` is which Lidl and `24h` is which Glovo.
    expect(normaliseDescription('LIDL SUPERMERCADO 214')).toBe('lidl supermercado 214');
    expect(normaliseDescription('GLOVO 24H')).toBe('glovo 24h');
    expect(normaliseDescription('CABIFY RIDE 88213')).toBe('cabify ride');
    expect(normaliseDescription('ES 1234 5678 9012')).toBe('es');
  });

  it('folds accents so a keyword matches either byte sequence', () => {
    // The whole point. `NÓMINA` typed as one code point and as `O` + U+0301 look
    // identical on screen; a rule matching one must match the other.
    expect(normaliseDescription('NÓMINA MENSUAL ACME S.L.')).toBe('nomina mensual acme s l');
    const composed = 'CAFÉ COMERCIAL'.normalize('NFC');
    const decomposed = 'CAFÉ COMERCIAL'.normalize('NFD');
    expect(composed).not.toBe(decomposed);
    expect(normaliseDescription(composed)).toBe('cafe comercial');
    expect(normaliseDescription(decomposed)).toBe('cafe comercial');
  });

  it('folds case after decomposing, so a dotted capital stays one word', () => {
    // `İ` decomposes to `I` + U+0307. If the case fold ran first the dot would
    // survive to the `[^a-z0-9 ]` step and split the word.
    expect(normaliseDescription('İSTANBUL KEBAP')).toBe('istanbul kebap');
  });

  it('is idempotent', () => {
    // The importer normalises stored values again on a re-import. A second pass
    // that changed the string would change the fingerprint, and every previously
    // imported row would come back as new.
    for (const input of [
      'MERCADONA 4023 MADRID',
      'AMAZON EU S.A R.L.',
      'NÓMINA MENSUAL ACME S.L.',
      'GLOVO 24H',
      '   ',
      '',
      '///',
      '2026',
    ]) {
      const once = normaliseDescription(input);
      expect(normaliseDescription(once), input).toBe(once);
    }
  });

  it('returns an empty string rather than throwing on input with nothing to keep', () => {
    expect(normaliseDescription('')).toBe('');
    expect(normaliseDescription('   ')).toBe('');
    expect(normaliseDescription('****')).toBe('');
    expect(normaliseDescription('99999')).toBe('');
  });

  it('drops non-Latin scripts, which is a known limit and not an accident', () => {
    // The character class is `[a-z0-9 ]`, so Cyrillic, Greek and CJK descriptions
    // normalise to nothing and no keyword rule can match them. That is acceptable
    // for a Spanish-locale demo ledger and would be the first thing to change for
    // a real one. Pinned so the limit is visible rather than discovered.
    expect(normaliseDescription('СБЕРБАНК')).toBe('');
    expect(normaliseDescription('セブンイレブン')).toBe('');
    expect(normaliseDescription('AMAZON 日本')).toBe('amazon');
  });
});

describe('merchantOf', () => {
  it('truncates to what the column accepts', () => {
    const long = 'MERCADONA '.repeat(40);
    expect(long.length).toBeGreaterThan(MERCHANT_MAX_LENGTH);
    expect(merchantOf(long)).toHaveLength(MERCHANT_MAX_LENGTH);
  });

  it('leaves anything shorter alone', () => {
    expect(merchantOf('MERCADONA 4023 MADRID')).toBe('mercadona madrid');
  });
});
