'use server';

import { createTransactionSchema, exponentOf, updateTransactionSchema } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import { failed, runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { amountMinorFromMajor, optionalText, text } from '../../../lib/form-fields';
import { authedRequest } from '../../../lib/session';

/**
 * Writing a transaction by hand: create, edit, delete, and the one-field
 * recategorise the table does inline.
 *
 * **Every write invalidates more than the ledger.** A transaction moves the
 * month's totals, the by-category chart, the trend, and whether a budget is over
 * its limit, so the same five paths are revalidated here that the import commit
 * revalidates. Naming them beats `revalidatePath('/(app)', 'layout')`, which
 * would take the nav and the session read with it for no gain.
 *
 * The API is the authority on provenance: it sets `categorySource: 'manual'` on
 * anything a person touched, which is what stops a later rule run overwriting the
 * choice. Deciding that here would put the rule in the wrong tier.
 */

/** Every screen whose numbers a transaction changes. */
const AFFECTED = ['/transactions', '/', '/reports', '/budgets', '/alerts'];

function revalidateAffected(): void {
  for (const path of AFFECTED) revalidatePath(path);
}

/**
 * The amount, in minor units, from what was typed in major units.
 *
 * **Signed, and the sign is the whole meaning.** The ledger stores an expense
 * negative and income positive; there is no separate direction column and no
 * `kind` field on a transaction. `amountMinorFromMajor` moves the decimal point
 * by string surgery rather than multiplying, because `Number('4.10') * 100` is
 * `409.99999999999994` and `minor()` rejects it three layers later with an error
 * naming a value nobody typed.
 */
function amountFrom(form: FormData, currency: string): number | 'invalid' {
  const value = amountMinorFromMajor(text(form, 'amount'), exponentOf(currency));
  return value === null ? 'invalid' : value;
}

const AMOUNT_HELP =
  'Write the amount as a plain number, negative for money out: -52.40 for a shop, 2400.00 for salary.';

/** The parsed body for a create, or the sentence to show instead of sending it. */
function readCreateForm(form: FormData, currency: string): Record<string, unknown> | string {
  const amountMinor = amountFrom(form, currency);
  if (amountMinor === 'invalid') return AMOUNT_HELP;
  if (amountMinor === 0) {
    // Not a contract rule, a usability one: a zero-amount row is either a typo or
    // a note, and the ledger has a notes field for the second case.
    return 'An amount of zero is not a transaction. Use the notes field for a reminder.';
  }

  const categoryId = optionalText(form, 'categoryId');
  return {
    accountId: text(form, 'accountId'),
    bookedOn: text(form, 'bookedOn'),
    amountMinor,
    description: text(form, 'description'),
    // Absent means "leave it uncategorised", which is a real null rather than an
    // omitted field: the rules run against it on the next pass either way.
    categoryId: categoryId ?? null,
    notes: optionalText(form, 'notes') ?? null,
  };
}

function firstIssue(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  const issue = error.issues[0];
  return issue ? `${String(issue.path[0] ?? 'That')}: ${issue.message}` : 'Check the form.';
}

export async function createTransactionAction(
  currency: string,
  form: FormData,
): Promise<ActionResult> {
  const body = readCreateForm(form, currency);
  if (typeof body === 'string') return failed(body);

  const parsed = createTransactionSchema.safeParse(body);
  if (!parsed.success) return failed(firstIssue(parsed.error));

  return runAction('Transaction added.', async () => {
    await authedRequest(endpoints.transactions(), null, { method: 'POST', json: parsed.data });
    revalidateAffected();
  });
}

/**
 * `PATCH`, and it carries only what the edit form shows.
 *
 * `updateTransactionSchema` is `createTransactionSchema.partial().omit({ accountId })`:
 * a transaction cannot move between accounts, because its currency comes from the
 * account and a `BEFORE` trigger enforces that they agree. Moving one would be a
 * delete and a create, and it should look like one.
 */
export async function updateTransactionAction(
  transactionId: string,
  currency: string,
  form: FormData,
): Promise<ActionResult> {
  const amountMinor = amountFrom(form, currency);
  if (amountMinor === 'invalid') return failed(AMOUNT_HELP);

  const categoryId = optionalText(form, 'categoryId');
  const parsed = updateTransactionSchema.safeParse({
    bookedOn: text(form, 'bookedOn'),
    amountMinor,
    description: text(form, 'description'),
    categoryId: categoryId ?? null,
    notes: optionalText(form, 'notes') ?? null,
  });
  if (!parsed.success) return failed(firstIssue(parsed.error));

  return runAction('Transaction saved.', async () => {
    await authedRequest(endpoints.transaction(transactionId), null, {
      method: 'PATCH',
      json: parsed.data,
    });
    revalidateAffected();
  });
}

/**
 * Remove a row from the ledger.
 *
 * There is no soft delete and no undo, which is why the form asks twice. A
 * transaction that came from an import stays deleted: re-uploading the same
 * statement will not bring it back, because the file is refused by its SHA-256
 * before it is parsed. The confirmation says so.
 */
export async function deleteTransactionAction(transactionId: string): Promise<ActionResult> {
  return runAction('Transaction deleted.', async () => {
    await authedRequest(endpoints.transaction(transactionId), null, { method: 'DELETE' });
    revalidateAffected();
  });
}

/**
 * Recategorising a row from the ledger table.
 *
 * The empty string is the "Uncategorised" option's value, because an
 * `<option value={null}>` does not exist in HTML — every option value is a
 * string. It is converted to a real `null` here, which is what
 * `updateTransactionSchema.categoryId` accepts and what tells the API "no
 * category", as opposed to `undefined`, which in a `PATCH` body means "leave this
 * field alone".
 *
 * The API is what marks the row `categorySource: 'manual'`. That column is the
 * reason re-running the rule engine cannot overwrite a choice a human made, and
 * deciding it here would put the rule in the wrong tier.
 */
export async function recategoriseAction(
  transactionId: string,
  categoryId: string,
): Promise<ActionResult> {
  const parsed = updateTransactionSchema.safeParse({
    categoryId: categoryId === '' ? null : categoryId,
  });
  if (!parsed.success) {
    return { ok: false, error: 'That is not a category this ledger has.' };
  }

  return runAction('Category updated.', async () => {
    await authedRequest(endpoints.transaction(transactionId), null, {
      method: 'PATCH',
      json: parsed.data,
    });
    // The same five paths as every other write. A category change moves the
    // by-category chart and can push a budget over its limit, so revalidating
    // only the ledger and the dashboard left the report showing the old split.
    revalidateAffected();
  });
}
