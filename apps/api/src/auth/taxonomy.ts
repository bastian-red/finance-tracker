/**
 * What a brand new account starts with.
 *
 * A finance app that opens on an empty screen is one nobody finishes setting up.
 * The first import has to land somewhere, so the ten categories and their
 * keyword rules exist before the user has done anything, and the rules mean the
 * very first statement arrives already sorted rather than as four hundred rows
 * to file by hand.
 *
 * Pure functions returning plain create payloads, so the interesting property --
 * that a signup plants exactly the taxonomy `@fin/shared` publishes, with the
 * colour slots intact -- is a gate test with no database in it.
 */
import { CATEGORY_SEEDS } from '@fin/shared';
import type { CategoryKind, MatcherType } from '@fin/db';

/** The first account. `checking` because that is where a salary lands. */
export const DEFAULT_ACCOUNT_NAME = 'Main';

/**
 * The lowest priority a seeded rule gets.
 *
 * Ten rather than zero so a user's own rule can be given a smaller number and
 * win against the defaults without anyone having to renumber the defaults first.
 * Priorities ascend in taxonomy order for the same reason the seed does it:
 * "which rule caught this" then has an answer that is stable and explicable
 * instead of one that depends on the order Postgres returned the rows in.
 */
export const SEEDED_RULE_BASE_PRIORITY = 10;

export interface CategoryCreate {
  userId: string;
  name: string;
  kind: CategoryKind;
  colorSlot: number;
}

export interface RuleCreate {
  userId: string;
  categoryId: string;
  matcherType: MatcherType;
  matcherValue: string;
  priority: number;
}

export function seededCategories(userId: string): CategoryCreate[] {
  return CATEGORY_SEEDS.map((seed) => ({
    userId,
    name: seed.name,
    kind: seed.kind as CategoryKind,
    colorSlot: seed.colorSlot,
  }));
}

/**
 * The keyword rules, resolved against the categories that were just written.
 *
 * Takes a name-to-id map rather than reading the database itself, because the
 * caller already has to make that round trip inside the transaction and doing it
 * twice would be a second chance to disagree with the first.
 */
export function seededRules(
  userId: string,
  categoryIds: ReadonlyMap<string, string>,
): RuleCreate[] {
  const rules: RuleCreate[] = [];
  let priority = SEEDED_RULE_BASE_PRIORITY;

  for (const seed of CATEGORY_SEEDS) {
    const categoryId = categoryIds.get(seed.name);
    if (categoryId === undefined) {
      // Unreachable by construction: the caller writes the categories from the
      // same array in the same transaction. Loud rather than silent, because the
      // silent version is an account whose rules point at nothing and whose
      // imports arrive uncategorised forever.
      throw new Error(`The taxonomy was written without a category named "${seed.name}".`);
    }
    for (const keyword of seed.keywords) {
      rules.push({
        userId,
        categoryId,
        matcherType: 'contains',
        matcherValue: keyword,
        priority,
      });
      priority += 1;
    }
  }

  return rules;
}
