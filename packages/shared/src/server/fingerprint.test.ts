import { describe, expect, it } from 'vitest';
import { day } from '../time/day';
import { fingerprintOf } from './fingerprint';

const ACCOUNT = 'acc_01hzy7q2m4k9';
const OTHER_ACCOUNT = 'acc_01hzy7q2m4ka';
const DAY = day('2026-03-09');

describe('fingerprintOf', () => {
  it('is a hex sha-256 digest', () => {
    expect(fingerprintOf(ACCOUNT, DAY, -8990, 'MERCADONA 4023 MADRID')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across runs and processes', () => {
    // Pinned to a literal, not to a second call. Comparing the function to itself
    // proves determinism within one process and nothing about the rows already in
    // the database, which is the only thing that matters: change the input format
    // and every stored fingerprint stops matching its own transaction.
    expect(fingerprintOf(ACCOUNT, DAY, -8990, 'MERCADONA 4023 MADRID')).toBe(
      '210430b65fa10f23d89c791b7bc10f1f50e48f242932a5cf4679f7f0996084be',
    );
  });

  it('ignores the noise that differs between two prints of the same purchase', () => {
    // The reason a fingerprint is computed over the normalised description rather
    // than the raw one. Same shop, same day, same amount, different terminal id.
    expect(fingerprintOf(ACCOUNT, DAY, -8990, 'MERCADONA 4023 MADRID')).toBe(
      fingerprintOf(ACCOUNT, DAY, -8990, 'Mercadona  4197  Madrid'),
    );
  });

  it('separates on every field', () => {
    const base = fingerprintOf(ACCOUNT, DAY, -8990, 'MERCADONA MADRID');
    expect(fingerprintOf(OTHER_ACCOUNT, DAY, -8990, 'MERCADONA MADRID')).not.toBe(base);
    expect(fingerprintOf(ACCOUNT, day('2026-03-10'), -8990, 'MERCADONA MADRID')).not.toBe(base);
    expect(fingerprintOf(ACCOUNT, DAY, -8991, 'MERCADONA MADRID')).not.toBe(base);
    expect(fingerprintOf(ACCOUNT, DAY, 8990, 'MERCADONA MADRID')).not.toBe(base);
    expect(fingerprintOf(ACCOUNT, DAY, -8990, 'CARREFOUR MADRID')).not.toBe(base);
  });

  it('does not let a field boundary slide', () => {
    // The separator is why. Concatenated, ('ab','1') and ('a','b1') are the same
    // string, and an account id sitting next to a date is exactly where that
    // would let one account's row look like another's.
    expect(fingerprintOf('ab', DAY, -100, 'x')).not.toBe(fingerprintOf('a', DAY, -100, 'bx'));
    expect(fingerprintOf('acc 1', DAY, -100, 'x')).not.toBe(fingerprintOf('acc', DAY, -100, '1 x'));
  });
});
