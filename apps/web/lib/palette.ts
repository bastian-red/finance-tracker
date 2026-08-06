import { COLOR_SLOT_COUNT } from '@fin/shared';

/**
 * Picking the swatch a brand new category gets.
 *
 * This exists because of what the API does when the field is absent.
 * `CategoriesService.nextSlot` hands out `max(colorSlot) + 1`, deliberately never
 * reusing a freed slot so that a new category cannot inherit the colour a deleted
 * one had. That is the right rule for a *stored* index and the wrong number for
 * this palette: the seeded taxonomy already occupies 0..9, so the eleventh
 * category is created with slot 10, `categorySwatchVar` folds anything outside
 * 0..9 onto `--cat-none`, and `--cat-none` is the grey reserved for
 * "uncategorised". The user's first hand-made category would therefore be painted
 * as the one state that means "no category at all".
 *
 * So the form always sends a slot, chosen here, and the API's fallback never
 * runs. The swatch is decoration either way -- every place it appears, the
 * category's name is beside it -- but decoration that lies about a state is worse
 * than no decoration.
 */

/**
 * The lowest slot in the palette nobody is using, or a wrap-around when all ten
 * are taken.
 *
 * The wrap is `size % COLOR_SLOT_COUNT` rather than 0, so creating five
 * categories in a row after the palette fills up spreads them over five hues
 * instead of stacking all five on the first one.
 */
export function firstFreeColorSlot(used: readonly number[]): number {
  const taken = new Set(used);
  for (let slot = 0; slot < COLOR_SLOT_COUNT; slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return taken.size % COLOR_SLOT_COUNT;
}

/** `[0, 1, ... 9]`. The options a slot picker offers, in palette order. */
export function colorSlotChoices(): number[] {
  return Array.from({ length: COLOR_SLOT_COUNT }, (_unused, index) => index);
}
