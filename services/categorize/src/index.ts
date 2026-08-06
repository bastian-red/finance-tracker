/**
 * @fin/categorize — deciding which category a transaction belongs to.
 *
 * The contract is the four exports below plus the types. Nothing outside this
 * package reaches into `./engine` or `./pattern` directly.
 *
 *   const ruleSet = compileRules(await prisma.rule.findMany({ where: { userId } }));
 *   for (const row of rows) {
 *     const match = categorize(ruleSet, row);
 *   }
 *
 * `compileRules` once, `categorize` per row. `ruleSet.skipped` is not optional
 * reading: it lists the stored rules that cannot run.
 */
export { categorize, categorizeOnce, compileRules, explain } from './engine';
export {
  compilePattern,
  isSafePattern,
  MAX_PATTERN_LENGTH,
  PatternError,
  PROBE_BUDGET_MS,
  PROBE_LENGTHS,
  probeAlphabet,
  slowestProbe,
} from './pattern';
export type { ProbeResult } from './pattern';
export type {
  CategorizeCandidate,
  CategorizeMatch,
  CategorizeRule,
  CompiledRule,
  CompiledRuleSet,
  MatcherType,
  RuleTrace,
  SkippedRule,
} from './types';
