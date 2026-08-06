import { describe, expect, it } from 'vitest';
import { minor } from '../money/money';
import { alertLevelFor, BASIS_POINTS, evaluateBudget, thresholdToBasisPoints } from './status';

const evaluate = (limit: number, spent: number, threshold = 8000) =>
  evaluateBudget({
    limitMinor: minor(limit),
    spentMinor: minor(spent),
    approachingBasisPoints: threshold,
  });

describe('evaluateBudget', () => {
  it('reports an untouched budget as under', () => {
    const result = evaluate(40_000, 0);
    expect(result).toMatchObject({ state: 'under', usedBasisPoints: 0, remainingMinor: 40_000 });
  });

  it('takes the ledger sign off the spend', () => {
    // Category spending comes out of the ledger negative. Both directions have
    // to land on the same evaluation or the alert and the dashboard disagree.
    expect(evaluate(40_000, -34_000)).toEqual(evaluate(40_000, 34_000));
    expect(evaluate(40_000, -34_000).spentMinor).toBe(34_000);
  });

  it('flips to approaching exactly at the threshold, not a cent early', () => {
    // 80% of 40000 is 32000. This is the assertion that fails if the comparison
    // is done on `0.8 * 40000`, which is 32000.000000000004.
    expect(evaluate(40_000, 31_999).state).toBe('under');
    expect(evaluate(40_000, 32_000).state).toBe('approaching');
    expect(evaluate(40_000, 32_001).state).toBe('approaching');
  });

  it('flips to exceeded only above the limit', () => {
    expect(evaluate(40_000, 40_000).state).toBe('approaching');
    expect(evaluate(40_000, 40_001).state).toBe('exceeded');
    expect(evaluate(40_000, 40_001).remainingMinor).toBe(-1);
  });

  it('does not let rounding report exceeded for a budget with money left', () => {
    // A limit big enough that one cent under it rounds to 10000 basis points.
    // The state must come from the exact amounts, not from the rounded share.
    const result = evaluate(2_000_000, 1_999_999);
    expect(result.usedBasisPoints).toBe(BASIS_POINTS);
    expect(result.state).toBe('approaching');
    expect(result.remainingMinor).toBe(1);
  });

  it('reports used share in integer basis points', () => {
    expect(evaluate(40_000, 10_000).usedBasisPoints).toBe(2500);
    expect(evaluate(30_000, 10_000).usedBasisPoints).toBe(3333);
    expect(evaluate(40_000, 60_000).usedBasisPoints).toBe(15_000);
  });

  it('honours a different threshold', () => {
    expect(evaluate(10_000, 5_000, 5_000).state).toBe('approaching');
    expect(evaluate(10_000, 4_999, 5_000).state).toBe('under');
    // A threshold of 10000 means "never warn early, only when exceeded".
    expect(evaluate(10_000, 9_999, BASIS_POINTS).state).toBe('under');
    expect(evaluate(10_000, 10_000, BASIS_POINTS).state).toBe('approaching');
  });

  it('refuses a limit that cannot have a state', () => {
    expect(() => evaluate(0, 100)).toThrow(/must be positive/);
    expect(() => evaluate(-100, 100)).toThrow(/must be positive/);
  });

  it('refuses a threshold outside the basis-point range', () => {
    expect(() => evaluate(10_000, 0, -1)).toThrow(/basis points/);
    expect(() => evaluate(10_000, 0, 10_001)).toThrow(/basis points/);
    expect(() => evaluate(10_000, 0, 0.8)).toThrow(/basis points/);
  });
});

describe('thresholdToBasisPoints', () => {
  it('converts the documented default exactly', () => {
    expect(thresholdToBasisPoints('0.8')).toBe(8000);
    expect(thresholdToBasisPoints(0.8)).toBe(8000);
    expect(thresholdToBasisPoints('1')).toBe(10_000);
    expect(thresholdToBasisPoints('0.0001')).toBe(1);
  });

  it('falls back when the variable is absent or blank', () => {
    expect(thresholdToBasisPoints(undefined)).toBe(8000);
    expect(thresholdToBasisPoints('')).toBe(8000);
    expect(thresholdToBasisPoints(undefined, 9000)).toBe(9000);
  });

  it('refuses a value that is not a fraction', () => {
    // `80` almost certainly means 80%, and silently reading it as 800000 basis
    // points would disable the alert entirely without saying so.
    expect(() => thresholdToBasisPoints('80')).toThrow(/fraction/);
    expect(() => thresholdToBasisPoints('0')).toThrow(/fraction/);
    expect(() => thresholdToBasisPoints('-0.5')).toThrow(/fraction/);
    expect(() => thresholdToBasisPoints('eighty percent')).toThrow(/fraction/);
  });
});

describe('alertLevelFor', () => {
  it('says nothing about a budget that is fine', () => {
    expect(alertLevelFor('under')).toBeNull();
    expect(alertLevelFor('approaching')).toBe('approaching');
    expect(alertLevelFor('exceeded')).toBe('exceeded');
  });
});
