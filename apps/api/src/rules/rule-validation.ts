/**
 * Proving a rule can run, at **write** time.
 *
 * The `regex` matcher is the only place in this codebase where a user's input is
 * compiled into something that executes, and JavaScript's regex engine
 * backtracks: `(a|a)*$` against thirty non-matching characters takes seconds, the
 * import loop runs it once per row, and there is no way to interrupt a running
 * `RegExp` in Node. One pasted pattern and the worker is gone.
 *
 * So the pattern is proved safe before it is stored, and the read path never sees
 * one that is not. `compilePattern` in `@fin/categorize` owns the proof: a
 * star-height check from `safe-regex2`, plus a timing ladder that runs the
 * compiled pattern against adversarial input built from its own literals, because
 * `safe-regex2` calls `(a|a)*$` safe.
 *
 * This goes through `compileRules` rather than calling `compilePattern` directly,
 * which is deliberate. `compileRules` is the function the import loop and the
 * transaction writer actually use, so validating through it means the rule is
 * checked by the exact code that will run it. It also catches the two failures a
 * pattern check alone would miss: a `contains` matcher whose value normalises to
 * nothing (`"!!!"` becomes `""`, and `""` is a substring of every string, so the
 * rule would swallow the entire ledger into one category on the next import), and
 * an inverted amount window, which can never match and which the user would
 * otherwise spend an afternoon debugging.
 */
import { compileRules, type CategorizeRule } from '@fin/categorize';
import type { Matcher } from '@fin/shared';
import { BadRequestException } from '@nestjs/common';

export interface RuleDraft {
  matcher: Matcher;
  minAmountMinor: number | null;
  maxAmountMinor: number | null;
}

/** The id the draft is compiled under. Never stored; it only appears in `skipped`. */
const DRAFT_ID = 'draft';

/**
 * Throws a 400 naming the problem, or returns.
 *
 * `active: true` is forced. `compileRules` skips inactive rules without compiling
 * them, so validating a draft that arrived with `active: false` would compile
 * nothing, find no problems, and store a pattern that hangs the importer the
 * moment somebody ticks the box.
 */
export function assertRuleRunnable(draft: RuleDraft): void {
  const candidate: CategorizeRule = {
    id: DRAFT_ID,
    categoryId: DRAFT_ID,
    matcherType: draft.matcher.type,
    matcherValue: draft.matcher.value,
    priority: 0,
    minAmountMinor: draft.minAmountMinor,
    maxAmountMinor: draft.maxAmountMinor,
    active: true,
  };

  const compiled = compileRules([candidate]);
  const problem = compiled.skipped[0];
  if (problem !== undefined) {
    // The message comes from `@fin/categorize` and already says what is wrong and
    // what to do instead ("Simplify it, or use a contains rule"). Rewording it
    // here would produce two sentences to keep in step, and the one the user sees
    // would be the vaguer of the two.
    throw new BadRequestException(problem.problem);
  }
}
