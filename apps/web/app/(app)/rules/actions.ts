'use server';

import { createRuleSchema, exponentOf, matcherSchema } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import { failed, runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { amountMinorFromMajor, checked, optionalText, text } from '../../../lib/form-fields';
import { authedRequest } from '../../../lib/session';

/**
 * Creating, changing and removing a categorisation rule.
 *
 * **A regex is validated by the API and by nobody else.** `rules/rule-validation.ts`
 * compiles the draft through `compileRules` -- the same function the import loop
 * runs -- with a star-height check from `safe-regex2` and a timing ladder against
 * adversarial input built from the pattern's own literals. That needs a
 * high-resolution clock and a native dependency, it is the thing standing between
 * a pasted `(a|a)*$` and a hung worker, and a second copy of it here would be a
 * weaker copy that disagrees with the real one. So this file sends the pattern and
 * renders whatever comes back: "That pattern took 14.6ms on a 16-character input,
 * which means it backtracks. Simplify it, or use a contains rule." That sentence
 * is written by `@fin/categorize` and reaches the screen verbatim, which is the
 * reason `lib/api.ts` keeps the response body on an error.
 *
 * The amount window is typed in major units and converted with
 * `amountMinorFromMajor`, which moves the decimal point by string surgery and
 * never divides. It is also **signed**, and that is the field people get wrong:
 * the ledger stores an expense negative, so a rule for "groceries over 50 euros"
 * is `max = -5000`, not `min = 5000`. The API refuses an inverted window with a
 * sentence saying so; the form says it up front.
 */

/** Rules change what the *next* write is filed as, so no stored amount moves. */
const AFFECTED = ['/rules', '/import'];

function revalidateAffected(): void {
  for (const path of AFFECTED) revalidatePath(path);
}

/**
 * An optional signed amount bound, in minor units.
 *
 * Three outcomes, and they are genuinely different: the field was left empty
 * (`null`, meaning no bound), it held something readable (a number), or it held
 * something that is not an amount (`'invalid'`, which has to be reported rather
 * than quietly dropped -- a typo that turns into "no bound" produces a rule that
 * matches far more than the user asked for).
 */
function boundFrom(form: FormData, name: string, currency: string): number | null | 'invalid' {
  const raw = optionalText(form, name);
  if (raw === undefined) return null;
  const value = amountMinorFromMajor(raw, exponentOf(currency));
  return value === null ? 'invalid' : value;
}

function priorityFrom(form: FormData): number | undefined {
  const raw = optionalText(form, 'priority');
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

interface RuleBody {
  categoryId: string;
  matcher: unknown;
  priority: number | undefined;
  minAmountMinor: number | null;
  maxAmountMinor: number | null;
  active: boolean;
}

/** The parsed body, or the sentence to show instead of sending it. */
function readForm(form: FormData, currency: string): RuleBody | string {
  const matcher = matcherSchema.safeParse({
    type: text(form, 'matcherType'),
    value: text(form, 'matcherValue'),
  });
  if (!matcher.success) {
    const issue = matcher.error.issues[0];
    return issue ? `The pattern is not usable: ${issue.message}` : 'Check the pattern.';
  }

  const min = boundFrom(form, 'minAmount', currency);
  if (min === 'invalid') {
    return 'Write the lowest amount as a plain number, for example -5000 or -50.00. Leave it empty for no lower bound.';
  }
  const max = boundFrom(form, 'maxAmount', currency);
  if (max === 'invalid') {
    return 'Write the highest amount as a plain number, for example -1000 or -10.00. Leave it empty for no upper bound.';
  }

  return {
    categoryId: text(form, 'categoryId'),
    matcher: matcher.data,
    priority: priorityFrom(form),
    minAmountMinor: min,
    maxAmountMinor: max,
    // HTML omits an unchecked checkbox from the submission entirely, so its
    // absence is the "off" state. Nothing ever sends the string "false", which
    // would be read as true by any `z.coerce.boolean()` it reached.
    active: checked(form, 'active'),
  };
}

function firstIssue(parsed: ReturnType<typeof createRuleSchema.safeParse>): string {
  if (parsed.success) return 'Check the form.';
  const issue = parsed.error.issues[0];
  return issue ? `${String(issue.path[0] ?? 'That')}: ${issue.message}` : 'Check the form.';
}

export async function createRuleAction(currency: string, form: FormData): Promise<ActionResult> {
  const body = readForm(form, currency);
  if (typeof body === 'string') return failed(body);

  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) return failed(firstIssue(parsed));

  return runAction(
    'Rule created. It applies to the next import, not to rows already filed.',
    async () => {
      await authedRequest(endpoints.rules, null, { method: 'POST', json: parsed.data });
      revalidateAffected();
    },
  );
}

/**
 * `PUT`, and it carries every field.
 *
 * `PUT /rules/:id` validates against `createRuleSchema`, the same schema as the
 * `POST`, so a half-sent body fails validation rather than leaving the missing
 * fields alone. The edit form therefore renders every current value and sends all
 * of them back.
 */
export async function updateRuleAction(
  ruleId: string,
  currency: string,
  form: FormData,
): Promise<ActionResult> {
  const body = readForm(form, currency);
  if (typeof body === 'string') return failed(body);

  const parsed = createRuleSchema.safeParse(body);
  if (!parsed.success) return failed(firstIssue(parsed));

  return runAction('Rule saved.', async () => {
    await authedRequest(endpoints.rule(ruleId), null, { method: 'PUT', json: parsed.data });
    revalidateAffected();
  });
}

export async function deleteRuleAction(ruleId: string): Promise<ActionResult> {
  return runAction('Rule removed. Transactions it already filed keep their category.', async () => {
    await authedRequest(endpoints.rule(ruleId), null, { method: 'DELETE' });
    revalidateAffected();
  });
}
