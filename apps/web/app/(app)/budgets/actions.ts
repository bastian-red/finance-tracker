'use server';

import { createBudgetSchema, exponentOf } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import { failed, runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { amountMinorFromMajor, optionalText, text } from '../../../lib/form-fields';
import { authedRequest } from '../../../lib/session';

/**
 * Creating, changing and removing a budget.
 *
 * A budget is a limit for a category over a **range of months**, not for one
 * month, which is why every form here has an "effective from" and an optional
 * "effective to". "400 a month for groceries, from January, until I change it"
 * is what people mean, and storing a row per month means editing twelve rows to
 * change one number.
 *
 * Two budgets for the same category may not overlap. That is enforced by an
 * exclusion constraint in the database rather than by a check in the API, because
 * two browser tabs can both pass a service-level check a millisecond apart and
 * both write. The API turns the constraint violation into a 409 whose message
 * names the months that clash, and `describeFailure` puts that message on screen
 * verbatim — which is the whole reason `lib/api.ts` keeps the response body.
 */

/** Cents, or whatever this currency's minor unit is. */
function limitMinorFrom(form: FormData, currency: string): number | null {
  return amountMinorFromMajor(text(form, 'limit'), exponentOf(currency));
}

export async function createBudgetAction(currency: string, form: FormData): Promise<ActionResult> {
  const limitMinor = limitMinorFrom(form, currency);
  if (limitMinor === null) {
    return failed('Write the limit as a plain amount, for example 340 or 340.50.');
  }

  const parsed = createBudgetSchema.safeParse({
    categoryId: text(form, 'categoryId'),
    limitMinor,
    effectiveFrom: text(form, 'effectiveFrom'),
    // An empty "until" means the budget is still in force, which the contract
    // spells `null`. Sending `undefined` would mean "unset" on a PATCH and is
    // simply absent on a POST, so it is written out explicitly.
    effectiveTo: optionalText(form, 'effectiveTo') ?? null,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return failed(
      first ? `${String(first.path[0] ?? 'That')}: ${first.message}` : 'Check the form.',
    );
  }

  return runAction('Budget created.', async () => {
    await authedRequest(endpoints.budgets, null, { method: 'POST', json: parsed.data });
    revalidatePath('/budgets');
    revalidatePath('/');
  });
}

export async function updateBudgetAction(
  budgetId: string,
  currency: string,
  form: FormData,
): Promise<ActionResult> {
  const limitMinor = limitMinorFrom(form, currency);
  if (limitMinor === null) {
    return failed('Write the limit as a plain amount, for example 340 or 340.50.');
  }
  if (limitMinor <= 0) {
    return failed('A budget limit has to be positive. To stop a budget, set an end month.');
  }

  return runAction('Budget updated.', async () => {
    await authedRequest(endpoints.budget(budgetId), null, {
      method: 'PATCH',
      json: {
        limitMinor,
        effectiveTo: optionalText(form, 'effectiveTo') ?? null,
      },
    });
    revalidatePath('/budgets');
    revalidatePath('/');
  });
}

export async function deleteBudgetAction(budgetId: string): Promise<ActionResult> {
  return runAction('Budget removed.', async () => {
    await authedRequest(endpoints.budget(budgetId), null, { method: 'DELETE' });
    revalidatePath('/budgets');
    revalidatePath('/');
  });
}
