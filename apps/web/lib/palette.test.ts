import { COLOR_SLOT_COUNT } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { categorySwatchVar } from './format';
import { colorSlotChoices, firstFreeColorSlot } from './palette';

/**
 * Picking the swatch a new category gets, and why the form picks it rather than
 * the API.
 *
 * `CategoriesService.nextSlot` hands out `max(colorSlot) + 1` and deliberately
 * never reuses a freed slot, so a new category cannot inherit the colour a
 * deleted one had. That is right for a stored index and wrong for this palette:
 * the seeded taxonomy already occupies 0..9, so the eleventh category would be
 * created with slot 10, and `categorySwatchVar` folds anything outside 0..9 onto
 * `--cat-none` -- the grey that means "uncategorised". A user's first hand-made
 * category would be painted as the one state meaning "no category at all".
 *
 * The last case here is the one that ties the two halves together: whatever this
 * function returns must be a slot the stylesheet actually has a colour for.
 */

describe('firstFreeColorSlot', () => {
  it('takes the lowest slot nobody is using', () => {
    expect(firstFreeColorSlot([])).toBe(0);
    expect(firstFreeColorSlot([0, 1, 2])).toBe(3);
  });

  it('fills a gap left by a deleted category', () => {
    // The opposite of the API's rule, and correct here: the palette has ten
    // slots and the point is that a new category gets one of them.
    expect(firstFreeColorSlot([0, 2, 3])).toBe(1);
  });

  it('ignores the order it is given', () => {
    expect(firstFreeColorSlot([5, 0, 3, 1, 2])).toBe(4);
  });

  it('ignores slots outside the palette', () => {
    // A row stored with slot 10 by the API's fallback must not make this think
    // the palette is fuller than it is.
    expect(firstFreeColorSlot([0, 1, 42, 99])).toBe(2);
  });

  it('spreads rather than stacking once every slot is taken', () => {
    const full = Array.from({ length: COLOR_SLOT_COUNT }, (_unused, index) => index);
    // The wrap is `size % COLOR_SLOT_COUNT`, so creating several categories in a
    // row after the palette fills up gives them different hues instead of piling
    // all of them on slot 0.
    expect(firstFreeColorSlot(full)).toBe(0);
    expect(firstFreeColorSlot([...full, 0])).toBe(0);
    expect(firstFreeColorSlot([...full, 100])).toBe(1);
  });

  it('always returns a slot inside the palette', () => {
    for (let taken = 0; taken <= COLOR_SLOT_COUNT + 5; taken += 1) {
      const used = Array.from({ length: taken }, (_unused, index) => index);
      const slot = firstFreeColorSlot(used);
      expect(slot, `${taken} taken`).toBeGreaterThanOrEqual(0);
      expect(slot, `${taken} taken`).toBeLessThan(COLOR_SLOT_COUNT);
    }
  });
});

describe('colorSlotChoices', () => {
  it('offers every slot the palette has, in palette order', () => {
    expect(colorSlotChoices()).toEqual(
      Array.from({ length: COLOR_SLOT_COUNT }, (_unused, index) => index),
    );
  });

  it('offers no slot that renders as the uncategorised grey', () => {
    // The failure this whole file guards against, stated as one assertion: every
    // choice the picker offers must map to a real category colour.
    for (const slot of colorSlotChoices()) {
      expect(categorySwatchVar(slot), `slot ${slot}`).not.toContain('cat-none');
    }
  });
});
