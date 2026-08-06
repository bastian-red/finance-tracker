/**
 * Compiling a user-supplied regular expression without handing them a way to
 * hang their own import.
 *
 * The `regex` matcher exists because bank descriptions are machine-generated and
 * `contains` genuinely is not enough for some of them. It is also the only place
 * in this codebase where a user's input is compiled into something that executes,
 * and JavaScript's regex engine backtracks: `(a|a)*$` against twenty-six
 * non-matching characters takes a second, against thirty it takes sixteen, and
 * the import loop runs it once per row. One pasted pattern and the worker is
 * gone.
 *
 * There is no way to interrupt a running `RegExp` in Node. `re2` would fix that
 * by swapping in a linear-time engine, and it was rejected: it is a native module
 * with a `node-gyp` install step, which means every Docker base image has to
 * build it. So the pattern is rejected at the door instead, on the write path,
 * and the read path never sees one.
 *
 * Two layers, because neither is sufficient alone. See `compilePattern`.
 */
import safeRegex from 'safe-regex2';

/** Matches the contract's cap in packages/shared/src/contracts. */
export const MAX_PATTERN_LENGTH = 200;

/**
 * The probe ladder: input lengths to try, shortest first.
 *
 * A single fixed length does not work, and the two ways it fails point in
 * opposite directions.
 *
 * Too short and the check misses. Backtracking cost is exponential in input
 * length, and V8 compiles a `RegExp` to native code once anything has run it —
 * so the warm cost is an order of magnitude under the cold one. At length 22,
 * `(a|a)*$` measures 474ms cold and 23ms warm, and 23ms slipped under a 50ms
 * budget. The first version of this file accepted it.
 *
 * Too long and the rejection itself is the denial of service. At length 26 the
 * same pattern costs a second to reject, and the gate suite that exercises five
 * such patterns took fifteen seconds.
 *
 * The ladder fixes both. Each rung is 16x the work of the one below it, so a
 * pattern that survives a rung is probed far harder at the next, and the total
 * cost is dominated by the rung that trips — which by definition is only just
 * over the budget. Measured on the machine that wrote this: every catastrophic
 * pattern is rejected in under 20ms, cold or warm, and every ordinary pattern is
 * accepted in under 0.11ms.
 *
 * It also makes the check portable. The deciding question is not "does this pattern
 * exceed 5ms at one length" but "does it exceed 5ms at *any* rung", and rung 28
 * costs `(a|a)*$` several seconds here. A machine hundreds of times faster still
 * trips it.
 */
export const PROBE_LENGTHS = [16, 20, 24, 28] as const;

/**
 * The wall-clock budget for a single probe, in milliseconds.
 *
 * Small on purpose: it is what bounds the cost of a rejection, since the ladder
 * stops at the first rung that exceeds it. Measured warm, the cheapest
 * catastrophic pattern trips it at 5.8ms and the most expensive ordinary one
 * costs 0.013ms — so an ordinary pattern would have to run 380 times slower than
 * measured to be falsely rejected, and there are two further rungs above the one
 * that usually decides.
 */
export const PROBE_BUDGET_MS = 5;

/**
 * The character appended to every probe, to force the match to fail at the end.
 *
 * A tilde, because `normaliseDescription` collapses everything outside
 * `[a-z0-9 ]` to a space, so no real subject can contain one and no probe can
 * end in an accidental match. A space would be the wrong choice: `\s` puts a
 * space in the probe alphabet, and a poison the pattern can consume ends the
 * probe in a match instead of in the backtrack it exists to provoke.
 *
 * A printable character rather than NUL, which is what this was first. A raw NUL
 * in a string literal is invisible in every editor and turns the file binary as
 * far as grep is concerned; a tilde is exactly as unmatchable and can be read.
 */
const POISON = '~';

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/**
 * The characters a probe string should be built from.
 *
 * A blowup only happens on input the pattern can partly consume, so `'a'*20`
 * proves nothing about `(x+x+)+y`. The literals in the pattern are the alphabet
 * it can consume, so they are what the probe repeats. Escapes are mapped to one
 * representative each: `\d` to a digit, `\w` and `.` to a letter, `\s` to a
 * space.
 *
 * Capped at four characters because the ladder already runs four rungs and the
 * product bounds the work; a long alternation of literals is not the shape that
 * backtracks anyway.
 */
export function probeAlphabet(source: string): string[] {
  const chars = new Set<string>();

  const withoutEscapes = source.replace(/\\[dwsDWSbBnrtfv0]/g, (escape) => {
    if (escape === '\\d' || escape === '\\D') chars.add('1');
    else if (escape === '\\w' || escape === '\\W') chars.add('a');
    else if (escape === '\\s' || escape === '\\S') chars.add(' ');
    return '';
  });

  for (const character of withoutEscapes) {
    if (/[a-z0-9 ]/i.test(character)) chars.add(character.toLowerCase());
  }
  if (withoutEscapes.includes('.')) chars.add('a');
  if (chars.size === 0) chars.add('a');

  return [...chars].slice(0, 4);
}

/**
 * Reject a pattern that is unsafe to run, or return it compiled.
 *
 * Layer 1 is `safe-regex2`: a star-height check, from the Fastify org, pure
 * JavaScript, and the most-installed thing in this space by an order of
 * magnitude (14M downloads a week against `recheck`'s 428k). It catches the
 * textbook nested quantifier, `(a+)+$`.
 *
 * Layer 2 is the ladder above, and it is here because layer 1 has a documented
 * blind spot: `(a|a)*$` has star height 1, so `safe-regex2` calls it safe, and it
 * is among the most expensive patterns that exist. Static analysis that catches
 * that class does exist — `recheck` — and it costs a worker thread per call.
 * Running the compiled pattern against adversarial input and timing it costs a
 * tenth of a millisecond on the write path and catches it directly.
 *
 * What this does **not** claim: it is not a proof of safety. A pattern crafted to
 * be linear at length 28 and exponential at length 40 would pass, and so would
 * one whose blowup needs an alphabet `probeAlphabet` does not derive. What bounds
 * that in practice is the other end — the engine only ever runs a rule against a
 * normalised description, which `merchantOf` caps at 120 characters, and there is
 * no route by which a user supplies both the pattern and a longer subject.
 */
export function compilePattern(source: string): RegExp {
  if (source.length === 0) {
    throw new PatternError('A pattern cannot be empty.');
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(
      `A pattern may be at most ${MAX_PATTERN_LENGTH} characters; this one is ${source.length}.`,
    );
  }

  let compiled: RegExp;
  try {
    // No flags. Not `g`: a global regex carries `lastIndex` between calls, so the
    // same rule would match a row and then skip the next one, forever, which
    // looks exactly like a categorisation bug and cannot be reproduced from the
    // UI. Not `i` either: the subject has already been lowercased by
    // `normaliseDescription`, and a case-insensitive match against lowercase
    // input is a slower way to get the same answer.
    compiled = new RegExp(source);
  } catch (error) {
    throw new PatternError(
      `That is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!safeRegex(source)) {
    throw new PatternError(
      'That pattern can take exponential time on some inputs (nested quantifiers). Simplify it, or use a "contains" rule.',
    );
  }

  const slowest = slowestProbe(compiled, source);
  if (slowest !== null) {
    throw new PatternError(
      `That pattern took ${slowest.milliseconds.toFixed(1)}ms on a ${slowest.length}-character input, which means it backtracks. Simplify it, or use a "contains" rule.`,
    );
  }

  return compiled;
}

/** True if `compilePattern` would accept it. For validating without throwing. */
export function isSafePattern(source: string): boolean {
  try {
    compilePattern(source);
    return true;
  } catch {
    return false;
  }
}

export interface ProbeResult {
  /** Which rung of the ladder tripped. */
  length: number;
  /** What that probe cost. Always greater than `PROBE_BUDGET_MS`. */
  milliseconds: number;
}

/**
 * How many times a probe that looks slow is re-measured before it is believed.
 *
 * Wall clock is not a property of the regex, it is a property of the regex *and*
 * the machine. A shared CI runner preempted this process between two
 * `hrtime` reads and charged a 16-character probe of `mercadona|carrefour|lidl`
 * with 5.36ms, over a 5ms budget that the same pattern clears in 0.013ms on an
 * idle box. In the suite that was a flaky test; in production it is an API
 * refusing a legitimate rule with "that pattern backtracks" because the host was
 * busy, intermittently, unreproducibly, in front of a user.
 *
 * Backtracking is not intermittent. A pattern that is slow because it explores an
 * exponential search space is slow on every run, so the honest statistic is the
 * **minimum** of a few measurements rather than a single sample: noise can only
 * ever make a run slower, never faster.
 */
const CONFIRMATIONS = 3;

/** One probe, timed. */
function measure(compiled: RegExp, input: string): number {
  const started = process.hrtime.bigint();
  compiled.test(input);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Walk the ladder and return the first probe that blows the budget, or null.
 *
 * Returns on the first confirmed breach rather than finishing the ladder, which
 * is what bounds the cost: there is nothing more to learn once a pattern has
 * exceeded the budget, and continuing would run the same pattern against inputs
 * 16 and 256 times larger.
 *
 * The re-measurement is on the slow path only. An ordinary pattern clears the
 * budget on its first run and is never measured again, so the common case costs
 * exactly what it did before; only a probe that looks slow pays for
 * `CONFIRMATIONS` runs, and a genuinely catastrophic one is over budget on all of
 * them.
 *
 * Exported for the test that pins the separation between an ordinary pattern and
 * a catastrophic one. Nothing else should call it.
 */
export function slowestProbe(compiled: RegExp, source: string): ProbeResult | null {
  const alphabet = probeAlphabet(source);
  for (const length of PROBE_LENGTHS) {
    for (const character of alphabet) {
      const input = character.repeat(length) + POISON;
      let slowest = measure(compiled, input);
      if (slowest <= PROBE_BUDGET_MS) continue;

      // Over budget once. Re-measure and keep the fastest run: a scheduler
      // hiccup does not repeat, and catastrophic backtracking does.
      for (let attempt = 1; attempt < CONFIRMATIONS && slowest > PROBE_BUDGET_MS; attempt += 1) {
        slowest = Math.min(slowest, measure(compiled, input));
      }
      if (slowest > PROBE_BUDGET_MS) return { length, milliseconds: slowest };
    }
  }
  return null;
}
