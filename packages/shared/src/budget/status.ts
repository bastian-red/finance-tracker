/**
 * Turning "spent 340, limit 400" into something a person can act on.
 *
 * Pure arithmetic, deliberately outside both the API and the web app, because
 * both need it and they must agree. The API needs it to decide whether to send
 * an alert; the dashboard needs it to draw the bar. If those two disagreed by a
 * cent, the app would email someone about a budget the screen says is fine.
 *
 * Everything is integer. `usedBasisPoints` is hundredths of a percent, so the
 * progress bar's width and the "85%" label come from the same integer rather
 * than from two roundings of a float that can disagree at the boundary.
 */
import { absMinor, minor, shareInBasisPoints, type Minor } from '../money/money';

export type BudgetState = 'under' | 'approaching' | 'exceeded';

export interface BudgetEvaluation {
  limitMinor: Minor;
  /** Always positive: money out. The ledger signs expenses negative. */
  spentMinor: Minor;
  remainingMinor: Minor;
  usedBasisPoints: number;
  state: BudgetState;
}

/** Basis points, so the threshold comparison is integer against integer. */
export const BASIS_POINTS = 10_000;

/**
 * Evaluate one budget against one month's spending.
 *
 * `spent` is accepted signed and taken absolute. Category spending comes out of
 * the ledger as a negative sum, and a caller that forgets to flip the sign would
 * otherwise get a permanently green budget with a negative bar. Taking the
 * absolute here makes both callers correct rather than making one of them
 * responsible for remembering.
 *
 * The threshold arrives as basis points rather than as `0.8` for the reason this
 * whole codebase avoids floats: `0.8 * 40000` is `32000.000000000004`, and a
 * budget that reads 80.0000000001% used would flip to "approaching" one cent
 * early. It is a small wrongness that costs a user an email.
 */
export function evaluateBudget(options: {
  limitMinor: Minor;
  spentMinor: Minor;
  approachingBasisPoints: number;
}): BudgetEvaluation {
  const { limitMinor, approachingBasisPoints } = options;
  const spentMinor = absMinor(options.spentMinor);

  if (limitMinor <= 0) {
    throw new Error('A budget limit must be positive; a zero limit has no meaningful state.');
  }
  if (
    !Number.isInteger(approachingBasisPoints) ||
    approachingBasisPoints < 0 ||
    approachingBasisPoints > BASIS_POINTS
  ) {
    throw new Error(
      `The approaching threshold must be 0..${BASIS_POINTS} basis points, got ${approachingBasisPoints}.`,
    );
  }

  const usedBasisPoints = shareInBasisPoints(spentMinor, limitMinor);
  const remainingMinor = minor(limitMinor - spentMinor);

  // Compared on the exact amounts rather than on the rounded basis points.
  // `shareInBasisPoints` rounds, so 39.999999% of a large limit can round up to
  // exactly 10000 and report "exceeded" for a budget with money left in it.
  const state: BudgetState =
    spentMinor > limitMinor
      ? 'exceeded'
      : spentMinor * BASIS_POINTS >= limitMinor * approachingBasisPoints
        ? 'approaching'
        : 'under';

  return { limitMinor, spentMinor, remainingMinor, usedBasisPoints, state };
}

/**
 * Parse the configured threshold (`BUDGET_ALERT_THRESHOLD=0.8`) into basis points.
 *
 * The env var is a decimal because that is what a person writes in a `.env`.
 * It is converted once, here, at the edge, and never used as a float again.
 * `Math.round` rather than truncation: `0.8 * 10000` is `8000.000000000001` on
 * some inputs and `7999.999999999999` on others, and truncating the second one
 * gives 7999.
 */
export function thresholdToBasisPoints(
  value: string | number | undefined,
  fallback = 8000,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(
      `BUDGET_ALERT_THRESHOLD must be a fraction in (0, 1], got ${JSON.stringify(value)}.`,
    );
  }
  return Math.round(parsed * BASIS_POINTS);
}

/**
 * The alert level a state deserves, or null for "say nothing".
 *
 * Separate from the state because they are not the same question: the dashboard
 * shows three states, and only two of them are worth an email. Every alert the
 * app sends that the reader did not need makes the next one less likely to be
 * read.
 */
export function alertLevelFor(state: BudgetState): 'approaching' | 'exceeded' | null {
  return state === 'under' ? null : state;
}
