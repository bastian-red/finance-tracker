import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectedFormatSchema } from '@fin/shared';
import { detectStatement } from './detect';
import { ImportError } from './errors';
import type { ParseOptions } from './types';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

const opts: ParseOptions = {
  localeDecimal: ',',
  currency: 'EUR',
  maxBytes: 8_388_608,
  duplicateWindowDays: 3,
};

describe('detectStatement', () => {
  it('reads a Spanish BBVA export: semicolons, comma decimal, latin1, day-first', () => {
    const format = detectStatement(fixture('bbva-es.csv'), opts);
    expect(detectedFormatSchema.parse(format)).toEqual(format);
    expect(format).toMatchObject({
      delimiter: ';',
      decimal: ',',
      decimalReason: 'both-separators-present',
      dateFormat: 'DD/MM/YYYY',
      encoding: 'latin1',
      columns: { date: 0, description: 2, amount: 3, credit: null, balance: 4 },
    });
  });

  it('reads a US Chase export: commas, dot decimal, quoted fields, month-first', () => {
    const format = detectStatement(fixture('chase-us.csv'), opts);
    expect(detectedFormatSchema.parse(format)).toEqual(format);
    expect(format).toMatchObject({
      delimiter: ',',
      decimal: '.',
      dateFormat: 'MM/DD/YYYY',
      encoding: 'utf-8',
      columns: { date: 1, description: 2, amount: 3, credit: 4, balance: 5 },
    });
  });

  it('reads a German N26 export: ISO dates, an external id column', () => {
    const format = detectStatement(fixture('n26-eu.csv'), opts);
    expect(detectedFormatSchema.parse(format)).toEqual(format);
    expect(format).toMatchObject({
      delimiter: ',',
      decimal: '.',
      dateFormat: 'YYYY-MM-DD',
      encoding: 'utf-8',
      columns: { date: 0, description: 1, amount: 3, credit: null, balance: null },
    });
  });

  it('raises too-large before decoding a file over the byte ceiling', () => {
    const tight: ParseOptions = { ...opts, maxBytes: 4 };
    expect(() => detectStatement(fixture('bbva-es.csv'), tight)).toThrow(ImportError);
    try {
      detectStatement(fixture('bbva-es.csv'), tight);
    } catch (error) {
      expect((error as ImportError).code).toBe('too-large');
    }
  });

  it('raises empty on a zero-byte file', () => {
    try {
      detectStatement(Buffer.alloc(0), opts);
      throw new Error('expected an ImportError');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).code).toBe('empty');
    }
  });
});
