import type { CSSProperties } from 'react';
import { categorySwatchVar } from '../lib/format';

/**
 * A category's name with its swatch.
 *
 * The swatch is decoration and is marked `aria-hidden`, because the name beside
 * it says everything the colour does. Ten categorical hues cannot be told apart
 * reliably under a colour vision deficiency, so the swatch's job is narrower than
 * identity: it lets someone scanning a long table find the *same* category twice
 * without reading. That is a real benefit and it costs nothing, as long as
 * nothing depends on it.
 *
 * `categorySwatchVar` folds any slot outside 0..9 onto `--cat-none`, so a
 * category created with a slot the palette does not have renders grey rather than
 * producing an undeclared custom property, which would invalidate the whole
 * `background` declaration and leave the square transparent.
 */
export function CategoryChip({
  name,
  colorSlot,
}: {
  name: string;
  colorSlot: number;
}): JSX.Element {
  return (
    <span className="chip">
      <span
        className="swatch"
        aria-hidden="true"
        style={{ background: categorySwatchVar(colorSlot) } as CSSProperties}
      />
      {name}
    </span>
  );
}

/** What an uncategorised row shows. A state, not a category, and it says so. */
export function UncategorisedChip(): JSX.Element {
  return (
    <span className="chip">
      <span className="swatch" aria-hidden="true" />
      Uncategorised
    </span>
  );
}
