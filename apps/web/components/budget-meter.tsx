import type { BudgetStatus } from '@fin/shared';
import type { CSSProperties } from 'react';
import {
  budgetStateLabel,
  meterPercent,
  money,
  percentFromBasisPoints,
  type MoneyFormat,
} from '../lib/format';

/**
 * One budget's progress bar.
 *
 * Three channels, in this order:
 *
 * 1. **the word** — "Exceeded", "Approaching", "Under", from `budgetStateLabel`;
 * 2. **the shape** — the exceeded bar is striped by the stylesheet, which is the
 *    channel that survives greyscale and `forced-colors`;
 * 3. **the colour** — last, and never alone. `--approaching` and `--exceeded`
 *    separate by 2.0:1 in light and 2.61:1 in dark, which is the best available
 *    on this canvas and is not enough by itself.
 *
 * The bar is a `role="progressbar"` rather than a `<progress>` element because
 * `<progress>` cannot be given the stripe, and rather than `role="meter"`, which
 * has materially worse screen-reader support. `aria-valuetext` carries the
 * sentence a reader actually wants ("82% of 340,00 EUR used") instead of the bare
 * number `82`, which on its own could be euros, percent or transactions.
 *
 * `--used` is set from `meterPercent`, an integer clamped to 0..100. The
 * stylesheet's `calc(var(--used, 0) * 1%)` would be invalidated wholesale by a
 * missing property, which renders identically to a 0% bar — the failure
 * `lib/tokens.test.ts` exists to catch.
 */
export function BudgetMeter({
  status,
  format,
  headingLevel = 3,
}: {
  status: BudgetStatus;
  format: MoneyFormat;
  headingLevel?: 2 | 3 | 4;
}): JSX.Element {
  const state = budgetStateLabel(status.state);
  const percent = percentFromBasisPoints(status.usedBasisPoints);
  const used = meterPercent(status.usedBasisPoints);
  const barId = `meter-${status.budgetId}`;
  const labelId = `${barId}-label`;
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  return (
    <div className="stack-tight">
      <div className="card-head">
        <Heading className="meter-name" id={labelId}>
          {status.categoryName}
        </Heading>
        <span className={`state ${state.className}`}>
          <span className="state-glyph" aria-hidden="true">
            {state.glyph}
          </span>
          <span>{state.word}</span>
        </span>
      </div>

      <div
        className={`meter meter-${status.state}`}
        role="progressbar"
        id={barId}
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        // Clamped, like the width. A budget at 142% would otherwise report a
        // value outside its own declared maximum.
        aria-valuenow={used}
        aria-valuetext={`${percent}% of ${money(status.limitMinor, format, 'never')} used`}
      >
        <div className="meter-fill" style={{ '--used': used } as CSSProperties} />
      </div>

      <p className="tile-note">
        <span className="num">{money(status.spentMinor, format, 'never')}</span> of{' '}
        <span className="num">{money(status.limitMinor, format, 'never')}</span> ({percent}%)
      </p>
    </div>
  );
}
