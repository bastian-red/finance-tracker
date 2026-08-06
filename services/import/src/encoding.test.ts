import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeStatement } from './encoding';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

describe('decodeStatement', () => {
  it('reads plain UTF-8 as itself', () => {
    const bytes = Buffer.from('Café,Amount\n', 'utf8');
    expect(decodeStatement(bytes)).toEqual({ text: 'Café,Amount\n', encoding: 'utf-8' });
  });

  it('strips a UTF-8 BOM rather than leaving it glued to the first header cell', () => {
    const withoutBom = Buffer.from('Café,Amount\n', 'utf8');
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withoutBom]);
    expect(decodeStatement(withBom)).toEqual({ text: 'Café,Amount\n', encoding: 'utf-8' });
  });

  it('reads a real UTF-16LE export with its BOM', () => {
    // The BOM is what selects this branch before any UTF-8 validity check runs;
    // there is nothing to sniff for here, only bytes to recognise.
    const decoded = decodeStatement(fixture('bom-utf16.csv'));
    expect(decoded.encoding).toBe('utf-16le');
    expect(decoded.text.startsWith('Date,Description,Amount')).toBe(true);
  });

  it('falls back to latin1 when UTF-8 decoding would corrupt the text', () => {
    // `Alimentación` as latin1 bytes: the byte for `ó` (0xf3) is not a valid
    // UTF-8 continuation on its own, so decoding those exact bytes as UTF-8 is
    // the proof that detection did something rather than a coincidence.
    const latin1Bytes = Buffer.from('Alimentación,Amount\n', 'latin1');
    expect(latin1Bytes.toString('utf8')).toContain('�');

    const decoded = decodeStatement(latin1Bytes);
    expect(decoded).toEqual({ text: 'Alimentación,Amount\n', encoding: 'latin1' });
  });
});
