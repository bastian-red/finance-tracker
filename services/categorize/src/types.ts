/**
 * The service's inputs and outputs.
 *
 * Deliberately plain structural types rather than the Prisma row types. This
 * package must stay callable from the API, from the importer's preview (where the
 * rows do not exist in the database yet) and from a test with three literals, and
 * a dependency on the generated client would rule out two of those.
 */

/** Mirrors the `matcher_type` enum and `matcherSchema` in packages/shared. */
export type MatcherType = 'contains' | 'equals' | 'startsWith' | 'regex';

export interface CategorizeRule {
  id: string;
  categoryId: string;
  matcherType: MatcherType;
  matcherValue: string;
  /** Lower runs first. Ties break on `id`, so the outcome never depends on row order. */
  priority: number;
  /**
   * Inclusive bounds on the **signed** amount in minor units, or null for open.
   *
   * Signed, not magnitude. The ledger has one signed column, expenses are
   * negative and income is positive, and a magnitude comparison would make
   * "anything over 500" mean two different things depending on which way the
   * money went. So a groceries rule capped at 94 EUR is `minAmountMinor: -9400`,
   * `maxAmountMinor: null` — the lower bound is the larger expense. That reads
   * backwards the first time and is the only reading that stays consistent when
   * the same field has to express "salary above 2000".
   */
  minAmountMinor: number | null;
  maxAmountMinor: number | null;
  active: boolean;
}

/** The parts of a transaction a rule can see. Nothing else is an input. */
export interface CategorizeCandidate {
  description: string;
  amountMinor: number;
}

export interface CategorizeMatch {
  categoryId: string;
  ruleId: string;
  /**
   * Why, in words, for the UI to render beside the category.
   *
   * An automatic classification nobody can explain is one nobody trusts and
   * nobody can correct at the source: the user sees the wrong category, has no
   * idea which rule did it, and fixes the row by hand every month instead of
   * fixing the rule once.
   */
  reason: string;
}

/** One rule's verdict on one candidate. The full trace, for the "why" screen. */
export interface RuleTrace {
  ruleId: string;
  categoryId: string;
  matched: boolean;
  reason: string;
}

/** A rule that could not be compiled, and why. Never silently dropped. */
export interface SkippedRule {
  ruleId: string;
  problem: string;
}

export interface CompiledRuleSet {
  rules: CompiledRule[];
  /**
   * Rules that are stored but cannot run.
   *
   * A pattern that passed validation under an older, laxer check is still in the
   * table, and so is anything an operator edited directly in SQL. Dropping those
   * quietly means a category silently stops being assigned and the only symptom
   * is a growing review queue. The caller gets them back and is expected to log
   * or surface them.
   */
  skipped: SkippedRule[];
}

export interface CompiledRule {
  id: string;
  categoryId: string;
  priority: number;
  /** The reason string this rule contributes when it matches. */
  reason: string;
  test: (normalisedDescription: string, amountMinor: number) => boolean;
}
