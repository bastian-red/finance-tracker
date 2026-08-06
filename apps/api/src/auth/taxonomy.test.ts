import { CATEGORY_SEEDS, COLOR_SLOT_COUNT } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_NAME,
  SEEDED_RULE_BASE_PRIORITY,
  seededCategories,
  seededRules,
} from './taxonomy';

/**
 * Pins that a signup plants exactly the taxonomy `@fin/shared` publishes, with
 * the colour slots intact and the rules pointing at the categories that were
 * just written.
 *
 * A finance app that opens on an empty screen is one nobody finishes setting up:
 * the first import has to land somewhere, and the keyword rules are what make
 * the very first statement arrive already sorted instead of as four hundred rows
 * to file by hand. The two failures worth catching are both silent. A category
 * whose colour slot drifts away from the seed makes Groceries change hue between
 * two accounts, and a rule pointing at a category id that was never written is
 * an account whose imports arrive uncategorised forever with nothing on screen
 * saying why.
 *
 * No database. The whole point of these being pure functions returning create
 * payloads is that the interesting property is checkable without one.
 */

const USER = 'usr_1';

/** The map the caller builds inside the signup transaction: name -> written id. */
const idsFor = (names: readonly string[]): Map<string, string> =>
  new Map(names.map((name, index) => [name, `cat_${index}`]));

const ALL_IDS = idsFor(CATEGORY_SEEDS.map((seed) => seed.name));

describe('seededCategories', () => {
  it('plants one row per published seed', () => {
    expect(seededCategories(USER)).toHaveLength(CATEGORY_SEEDS.length);
    expect(CATEGORY_SEEDS.length).toBe(COLOR_SLOT_COUNT);
  });

  it('copies the name, kind and colour slot from the seed unchanged', () => {
    const created = seededCategories(USER);
    expect(created).toEqual(
      CATEGORY_SEEDS.map((seed) => ({
        userId: USER,
        name: seed.name,
        kind: seed.kind,
        colorSlot: seed.colorSlot,
      })),
    );
  });

  it('keeps the colour slots unique, because the palette is indexed by them', () => {
    // Colour is a stored slot, not a render-order index. Two categories sharing
    // a slot means two series drawn in the same hue, which destroys the one
    // thing a categorical palette is for.
    const slots = seededCategories(USER).map((category) => category.colorSlot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('numbers the slots from zero with no gaps, which is what the palette expects', () => {
    // The palette lives in the web app's CSS as a list. A slot past its end
    // renders as no colour at all.
    const slots = seededCategories(USER)
      .map((category) => category.colorSlot)
      .sort((a, b) => a - b);
    expect(slots).toEqual([...Array(COLOR_SLOT_COUNT).keys()]);
  });

  it('seeds both kinds, so income has somewhere to land too', () => {
    const kinds = new Set(seededCategories(USER).map((category) => category.kind));
    expect(kinds).toEqual(new Set(['income', 'expense']));
  });

  it('stamps the owner on every row', () => {
    expect(seededCategories('usr_2').every((category) => category.userId === 'usr_2')).toBe(true);
  });

  it('opens the first account on a name a salary can land in', () => {
    expect(DEFAULT_ACCOUNT_NAME).toBe('Main');
  });
});

describe('seededRules', () => {
  it('writes one rule per keyword in the taxonomy', () => {
    const expected = CATEGORY_SEEDS.reduce((total, seed) => total + seed.keywords.length, 0);
    expect(seededRules(USER, ALL_IDS)).toHaveLength(expected);
  });

  it('points every rule at the id the caller just wrote for that category', () => {
    // The map is a parameter rather than a second read of the database, because
    // the caller already made that round trip inside the transaction and doing
    // it twice is a second chance to disagree with the first.
    const rules = seededRules(USER, ALL_IDS);
    const firstSeed = CATEGORY_SEEDS[0];

    expect(firstSeed).toBeDefined();
    expect(rules[0]).toEqual({
      userId: USER,
      categoryId: ALL_IDS.get(firstSeed?.name ?? ''),
      matcherType: 'contains',
      matcherValue: firstSeed?.keywords[0],
      priority: SEEDED_RULE_BASE_PRIORITY,
    });
  });

  it('seeds literal keyword matchers, never regexes', () => {
    // A seeded regex would be a pattern nobody wrote arriving in the one place
    // this app compiles user input into something that executes.
    expect(seededRules(USER, ALL_IDS).every((rule) => rule.matcherType === 'contains')).toBe(true);
  });

  it('starts at ten, so a user rule can be given a smaller number and win', () => {
    // Lower priority runs first. Starting at zero would mean renumbering every
    // default before a user could outrank one.
    expect(SEEDED_RULE_BASE_PRIORITY).toBe(10);
    expect(seededRules(USER, ALL_IDS)[0]?.priority).toBe(10);
  });

  it('gives every rule a distinct priority, ascending in taxonomy order', () => {
    // "Which rule caught this" then has an answer that is stable and
    // explicable, instead of one that depends on the order Postgres returned
    // the rows in.
    const priorities = seededRules(USER, ALL_IDS).map((rule) => rule.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(priorities[priorities.length - 1]).toBe(
      SEEDED_RULE_BASE_PRIORITY + priorities.length - 1,
    );
  });

  it('keeps the keywords in the order the taxonomy publishes them', () => {
    const rules = seededRules(USER, ALL_IDS);
    expect(rules.map((rule) => rule.matcherValue)).toEqual(
      CATEGORY_SEEDS.flatMap((seed) => [...seed.keywords]),
    );
  });

  it('stamps the owner on every rule', () => {
    expect(seededRules('usr_2', ALL_IDS).every((rule) => rule.userId === 'usr_2')).toBe(true);
  });

  it('refuses loudly when a category is missing from the map', () => {
    // Unreachable by construction, because the caller writes the categories from
    // the same array in the same transaction. Loud rather than silent, because
    // the silent version is an account whose rules point at nothing and whose
    // imports arrive uncategorised forever.
    const missing = new Map(ALL_IDS);
    const dropped = CATEGORY_SEEDS[3]?.name ?? '';
    missing.delete(dropped);

    expect(() => seededRules(USER, missing)).toThrow(dropped);
  });

  it('refuses on an empty map rather than writing rules that point nowhere', () => {
    expect(() => seededRules(USER, new Map())).toThrow(/written without a category/);
  });

  it('writes nothing when there is nothing to write', () => {
    // Guards the loop's own shape: a seed with no keywords must contribute no
    // rules rather than one with an undefined matcher.
    expect(seededRules(USER, ALL_IDS).every((rule) => rule.matcherValue.length > 0)).toBe(true);
  });
});
