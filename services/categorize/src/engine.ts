/**
 * The rule engine.
 *
 * One job: given a user's rules and one transaction, decide which category it
 * belongs to and be able to say why. Pure functions over plain objects, no
 * database, no clock, no network — which is what makes the whole thing testable
 * for free and lets the importer run it over a preview whose rows do not exist
 * yet.
 *
 * Two properties the rest of the app depends on:
 *
 * **The answer is deterministic.** Rules run in `(priority, id)` order and the
 * first match wins. Sorting on priority alone is not enough: two rules at the
 * default priority of 100 would then be ordered by however Postgres returned
 * them, and the same transaction would land in different categories on different
 * days with nothing in the data to explain it. The `id` tiebreak costs nothing
 * and removes the entire class.
 *
 * **It never overwrites a human.** That decision is not made here — it belongs to
 * the caller, which checks `category_source` before applying a result. This
 * module has no opinion about what is already on the row, and that separation is
 * deliberate: re-running rules over the whole ledger and re-categorising a single
 * new import are the same operation, differing only in what the caller does with
 * the answer.
 */
import { normaliseDescription } from '@fin/shared';
import { compilePattern, PatternError } from './pattern';
import type {
  CategorizeCandidate,
  CategorizeMatch,
  CategorizeRule,
  CompiledRule,
  CompiledRuleSet,
  RuleTrace,
  SkippedRule,
} from './types';

/**
 * Turn stored rules into something runnable, once, before the loop over rows.
 *
 * An import of four thousand rows against sixty rules is 240,000 evaluations. If
 * the regex were compiled inside that loop it would be compiled 4,000 times per
 * rule, and the literal matchers would re-normalise the same matcher value just
 * as often. Both are hoisted here.
 *
 * Inactive rules are dropped rather than compiled-and-skipped: they cannot match,
 * and leaving them in the trace would fill the "why" screen with rules the user
 * has already turned off.
 */
export function compileRules(rules: readonly CategorizeRule[]): CompiledRuleSet {
  const compiled: CompiledRule[] = [];
  const skipped: SkippedRule[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    try {
      compiled.push(compileRule(rule));
    } catch (error) {
      skipped.push({
        ruleId: rule.id,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Sorted once here rather than in `categorize`, which is the hot path.
  compiled.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { rules: compiled, skipped };
}

/** The first rule that matches, or null. */
export function categorize(
  ruleSet: CompiledRuleSet,
  candidate: CategorizeCandidate,
): CategorizeMatch | null {
  const subject = normaliseDescription(candidate.description);
  for (const rule of ruleSet.rules) {
    if (rule.test(subject, candidate.amountMinor)) {
      return { categoryId: rule.categoryId, ruleId: rule.id, reason: rule.reason };
    }
  }
  return null;
}

/**
 * Every rule's verdict, in the order they were tried.
 *
 * For the screen that answers "why is this in Groceries?", and for the one that
 * answers the harder question: "why is this in *nothing*?". The second is the one
 * that needs a full trace — a user whose rule is not firing needs to see that it
 * was tried and did not match, not an empty result that looks like the rule does
 * not exist.
 */
export function explain(ruleSet: CompiledRuleSet, candidate: CategorizeCandidate): RuleTrace[] {
  const subject = normaliseDescription(candidate.description);
  return ruleSet.rules.map((rule) => ({
    ruleId: rule.id,
    categoryId: rule.categoryId,
    matched: rule.test(subject, candidate.amountMinor),
    reason: rule.reason,
  }));
}

/**
 * Convenience for a one-shot call: compile and match in one step.
 *
 * Correct but slow in a loop, for the reason `compileRules` exists. Named so the
 * cost is visible at the call site rather than hidden behind `categorize`.
 */
export function categorizeOnce(
  rules: readonly CategorizeRule[],
  candidate: CategorizeCandidate,
): CategorizeMatch | null {
  return categorize(compileRules(rules), candidate);
}

function compileRule(rule: CategorizeRule): CompiledRule {
  const withinAmount = amountPredicate(rule);
  const amountClause = describeAmount(rule);

  if (rule.matcherType === 'regex') {
    // The pattern is *not* normalised. Normalising it would destroy it:
    // `^[a-z]+ ?[0-9]{2}$` comes out of `normaliseDescription` as `a z 0 9 2`,
    // which is a literal string that matches nothing. The subject is normalised;
    // the pattern is written against that normalised form, which is why patterns
    // in this app are lowercase and unaccented.
    const pattern = compilePattern(rule.matcherValue);
    return {
      id: rule.id,
      categoryId: rule.categoryId,
      priority: rule.priority,
      reason: `matches /${rule.matcherValue}/${amountClause}`,
      test: (subject, amountMinor) => withinAmount(amountMinor) && pattern.test(subject),
    };
  }

  // The needle goes through the same normalisation as the subject, so a rule
  // typed as "Café Comercial" matches a statement line reading "CAFE COMERCIAL
  // 4021" without the user having to know that either of those things happened.
  const needle = normaliseDescription(rule.matcherValue);
  if (needle.length === 0) {
    // "!!!" and "----" normalise to nothing, and `''` is a substring of every
    // string: a `contains` rule built from one would swallow the entire ledger
    // into a single category on the next import. Refused rather than run.
    throw new PatternError(
      `The matcher "${rule.matcherValue}" has no letters or digits in it, so it would match every transaction.`,
    );
  }

  const reason = `${rule.matcherType} "${needle}"${amountClause}`;
  const test =
    rule.matcherType === 'contains'
      ? (subject: string) => subject.includes(needle)
      : rule.matcherType === 'startsWith'
        ? (subject: string) => subject.startsWith(needle)
        : (subject: string) => subject === needle;

  return {
    id: rule.id,
    categoryId: rule.categoryId,
    priority: rule.priority,
    reason,
    test: (subject, amountMinor) => withinAmount(amountMinor) && test(subject),
  };
}

/**
 * The amount window, inclusive on both ends.
 *
 * Returns a closure rather than being evaluated inline so the common case — both
 * bounds null — costs one function call that returns true, instead of two null
 * checks per rule per row.
 *
 * A window whose bounds are the wrong way round can never match. That is an
 * error, not a rule that quietly does nothing: the user set it deliberately and
 * would otherwise spend the afternoon wondering why their rule is ignored.
 */
function amountPredicate(rule: CategorizeRule): (amountMinor: number) => boolean {
  const { minAmountMinor: min, maxAmountMinor: max } = rule;

  if (min !== null && max !== null) {
    if (min > max) {
      throw new PatternError(
        `The amount window ${min}..${max} is inverted, so this rule can never match. Amounts are signed: an expense of 94.00 is -9400, so the lower bound is the larger expense.`,
      );
    }
    return (amountMinor) => amountMinor >= min && amountMinor <= max;
  }
  if (min !== null) return (amountMinor) => amountMinor >= min;
  if (max !== null) return (amountMinor) => amountMinor <= max;
  return () => true;
}

function describeAmount(rule: CategorizeRule): string {
  const { minAmountMinor: min, maxAmountMinor: max } = rule;
  if (min !== null && max !== null) return ` and amount is ${min} to ${max}`;
  if (min !== null) return ` and amount is at least ${min}`;
  if (max !== null) return ` and amount is at most ${max}`;
  return '';
}
