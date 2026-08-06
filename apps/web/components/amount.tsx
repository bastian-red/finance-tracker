import { absoluteMoney, directionLabel, type MoneyFormat } from '../lib/format';

/**
 * An amount, and the direction it moved.
 *
 * Colour is the third channel, after a glyph and a word, and that is not a
 * stylistic preference. A scripted search over the full 500-900 and 300-600 ramps
 * proved that no green, amber and red exist that all clear 4.5:1 on this canvas
 * *and* separate from each other by 1.5:1 in greyscale. The best pair available
 * is 2.0:1 in light and 2.68:1 in dark. So a reader who cannot distinguish the
 * hues gets `-` and `Out` and only then the colour, which agrees with them.
 *
 * `srDirection` exists for one situation: a table that already has a visible
 * Direction column. There the word is on screen in the neighbouring cell, and
 * repeating it invisibly would make a screen reader say "out" twice per row.
 */
export function Amount({
  amountMinor,
  format,
  srDirection = true,
}: {
  amountMinor: number;
  format: MoneyFormat;
  srDirection?: boolean;
}): JSX.Element {
  const label = directionLabel(amountMinor);
  return (
    <span className={`state ${label.className}`}>
      {/* Decorative: the word beside it, visible or not, is the real signal. */}
      <span className="state-glyph" aria-hidden="true">
        {label.glyph}
      </span>
      <span className="num">{absoluteMoney(amountMinor, format)}</span>
      {srDirection ? <span className="visually-hidden">{label.word}</span> : null}
    </span>
  );
}

/** The visible glyph-and-word half of a direction, for its own table column. */
export function DirectionTag({ amountMinor }: { amountMinor: number }): JSX.Element {
  const label = directionLabel(amountMinor);
  return (
    <span className={`state ${label.className}`}>
      <span className="state-glyph" aria-hidden="true">
        {label.glyph}
      </span>
      <span>{label.word}</span>
    </span>
  );
}
