import { normaliseDescription, type Matcher } from '@fin/shared';

/**
 * The rule tester: "which of these descriptions would this pattern catch?".
 *
 * A rule that does not fire is the single most common thing a user gets wrong
 * here, and the reason is almost always invisible to them: the engine matches
 * against the *normalised* description, not the raw one. `MERCADONA 4023 MADRID`
 * is `mercadona madrid` by the time a rule sees it -- the four-digit terminal
 * number is gone, the case is gone, the accents are gone. Someone writing a regex
 * with `\d{4}` in it will never match anything and has no way to find out why.
 *
 * So the tester shows both forms and runs the same comparisons the engine runs.
 * The semantics below mirror `services/categorize/src/engine.ts` exactly:
 *
 *   - the *subject* is normalised;
 *   - a literal needle is normalised too, so "Café Comercial" matches
 *     "CAFE COMERCIAL 4021" without the user knowing either step happened;
 *   - a regex pattern is **not** normalised, because normalising it would destroy
 *     it: `^[a-z]+ ?[0-9]{2}$` comes back as `a z 0 9 2`, a literal that matches
 *     nothing.
 *
 * This is a preview, not the authority. The API compiles and stores rules, and it
 * is the API that rejects a pattern that backtracks (see the probe ladder in
 * `services/categorize/src/pattern.ts`, which needs `safe-regex2` and a
 * high-resolution clock and does not belong in a browser). The preview runs at
 * most a handful of patterns against short samples on the user's own tab, so the
 * worst case is a pattern the API is about to refuse to save anyway.
 */

export interface MatcherProbe {
  /** What the user typed, or a real description from their ledger. */
  description: string;
  /** What the engine will actually compare against. */
  normalised: string;
  matched: boolean;
}

export interface MatcherPreview {
  /** Null when the matcher itself is unusable; `problem` says why. */
  probes: MatcherProbe[] | null;
  problem: string | null;
}

/**
 * Try a matcher against sample descriptions.
 *
 * Never throws. Every way a matcher can be wrong -- an invalid regex, a literal
 * with no letters or digits in it -- comes back as `problem`, because this runs
 * on every keystroke in the rule form and an exception there would blank the
 * page while someone is typing.
 */
export function previewMatcher(matcher: Matcher, descriptions: readonly string[]): MatcherPreview {
  if (matcher.value.trim() === '') {
    return { probes: null, problem: 'Type something to match on.' };
  }

  if (matcher.type === 'regex') {
    let pattern: RegExp;
    try {
      // No flags, matching the engine. Not `g`, which carries `lastIndex`
      // between calls and would make the same pattern match one sample and skip
      // the next; not `i`, because the subject is already lowercase.
      pattern = new RegExp(matcher.value);
    } catch (error) {
      return {
        probes: null,
        problem: `That is not a valid regular expression: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return {
      probes: descriptions.map((description) => {
        const normalised = normaliseDescription(description);
        return { description, normalised, matched: pattern.test(normalised) };
      }),
      problem: null,
    };
  }

  const needle = normaliseDescription(matcher.value);
  if (needle.length === 0) {
    // "!!!" and "----" normalise to nothing, and the empty string is a substring
    // of every string: a `contains` rule built from one would swallow the whole
    // ledger into a single category on the next import.
    return {
      probes: null,
      problem:
        `"${matcher.value}" has no letters or digits in it, so once normalised it would ` +
        'match every transaction.',
    };
  }

  const test =
    matcher.type === 'contains'
      ? (subject: string) => subject.includes(needle)
      : matcher.type === 'startsWith'
        ? (subject: string) => subject.startsWith(needle)
        : (subject: string) => subject === needle;

  return {
    probes: descriptions.map((description) => {
      const normalised = normaliseDescription(description);
      return { description, normalised, matched: test(normalised) };
    }),
    problem: null,
  };
}

/** How the matcher will read in the rules table. Mirrors the engine's `reason`. */
export function describeMatcher(matcher: Matcher): string {
  if (matcher.type === 'regex') return `matches /${matcher.value}/`;
  return `${matcher.type} "${normaliseDescription(matcher.value)}"`;
}
