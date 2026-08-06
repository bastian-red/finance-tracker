import { directionOf, formatMoney, minor, type BudgetState, type Direction } from '@fin/shared';

/**
 * Turning contract values into the exact strings the DOM gets.
 *
 * Everything here is pure and takes its locale and currency as arguments, never
 * from the machine. A report that formats differently on a laptop in Madrid and
 * on a CI runner in UTC is a report whose screenshots cannot be trusted, and the
 * expected values in `format.test.ts` were produced by running these functions
 * rather than by recalling what `Intl` does.
 */

export interface MoneyFormat {
  currency: string;
  locale: string;
}

/**
 * Format an amount that arrived over the wire.
 *
 * The contract validates `amountMinor` as `int().safe()` but cannot carry the
 * `Minor` brand through JSON, so it is re-branded here. `minor()` throws on a
 * fractional value, which turns "a float leaked in three layers upstream" into
 * an error at the point of display instead of a silently wrong total.
 */
export function money(
  amountMinor: number,
  format: MoneyFormat,
  signDisplay: 'auto' | 'always' | 'never' = 'auto',
): string {
  return formatMoney(minor(amountMinor), { ...format, signDisplay });
}

/** The magnitude, with no sign at all. Pairs with a direction word beside it. */
export function absoluteMoney(amountMinor: number, format: MoneyFormat): string {
  return money(Math.abs(amountMinor), format, 'never');
}

/**
 * The glyph and the word that carry a transaction's direction.
 *
 * Colour is the third channel here, not the first. On this canvas no green,
 * amber and red exist that all clear AA *and* separate from each other in
 * greyscale -- income and expense manage 2.0:1 in light and 2.68:1 in dark, and
 * that is the best available. A reader with a colour vision deficiency therefore
 * gets the glyph and the word, and the colour only agrees with them.
 */
export function directionLabel(amountMinor: number): {
  direction: Direction;
  glyph: string;
  word: string;
  className: string;
} {
  const direction = directionOf(minor(amountMinor));
  if (direction === 'income') {
    return { direction, glyph: '+', word: 'In', className: 'state-income' };
  }
  if (direction === 'expense') {
    return { direction, glyph: '-', word: 'Out', className: 'state-expense' };
  }
  return { direction, glyph: '=', word: 'Zero', className: 'state-neutral' };
}

/** The same contract for a budget's state: glyph, word, then colour. */
export function budgetStateLabel(state: BudgetState): {
  glyph: string;
  word: string;
  className: string;
} {
  if (state === 'exceeded') return { glyph: '✕', word: 'Exceeded', className: 'state-exceeded' };
  if (state === 'approaching') {
    return { glyph: '▲', word: 'Approaching', className: 'state-approaching' };
  }
  return { glyph: '✓', word: 'Under', className: 'state-income' };
}

/**
 * Basis points as a whole-number percentage, for a label.
 *
 * Truncated below the limit and rounded up above it, rather than rounded
 * throughout. Rounding 9,990 basis points to "100%" tells someone with nine
 * euros left that they have spent their budget, and rounding 10,050 down to
 * "100%" tells someone who has overspent that they have not. Both are the same
 * mistake in opposite directions, and neither is acceptable next to a number
 * people make decisions on.
 */
export function percentFromBasisPoints(basisPoints: number): number {
  return basisPoints <= 10_000 ? Math.floor(basisPoints / 100) : Math.ceil(basisPoints / 100);
}

/**
 * The number the meter's `--used` custom property takes, clamped to 0..100.
 *
 * Clamped because the bar cannot be more than full, and negative spending (a
 * month of refunds) would otherwise produce a negative width, which browsers
 * treat as invalid and drop -- rendering an empty bar that is indistinguishable
 * from a bar for a budget nobody has touched.
 */
export function meterPercent(basisPoints: number): number {
  return Math.max(0, Math.min(100, Math.round(basisPoints / 100)));
}

/**
 * The ten swatch variables, written out one per line rather than built from the
 * slot number.
 *
 * `` `var(--cat-${slot})` `` would be shorter and would defeat
 * `lib/tokens.test.ts`, which greps the source for `var(--x)` and checks each
 * name against the stylesheet. A name assembled at runtime is invisible to that
 * scan, and a renamed token would then resolve to nothing with no warning, no
 * throw and no failing type check -- which is the exact failure the token gate
 * exists to catch.
 */
const CATEGORY_SWATCH_VARS = [
  'var(--cat-0)',
  'var(--cat-1)',
  'var(--cat-2)',
  'var(--cat-3)',
  'var(--cat-4)',
  'var(--cat-5)',
  'var(--cat-6)',
  'var(--cat-7)',
  'var(--cat-8)',
  'var(--cat-9)',
] as const;

/**
 * The CSS variable that paints a category's swatch.
 *
 * `UNCATEGORISED_SLOT` is -1 and every real slot is 0..9. Anything outside that
 * range folds onto the neutral rather than producing an undeclared property: an
 * undeclared custom property invalidates the whole declaration, so the swatch
 * would silently inherit instead of visibly failing.
 */
export function categorySwatchVar(colorSlot: number): string {
  if (!Number.isInteger(colorSlot) || colorSlot < 0 || colorSlot >= CATEGORY_SWATCH_VARS.length) {
    return 'var(--cat-none)';
  }
  return CATEGORY_SWATCH_VARS[colorSlot]!;
}
