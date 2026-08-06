'use server';

import { updateTransactionSchema } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import { runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { authedRequest } from '../../../lib/session';

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
    // Both pages show a category against this row, and both are wrong the moment
    // it changes. `revalidatePath` on the layout segment would take the nav with
    // it for no gain, so each page is named.
    revalidatePath('/transactions');
    revalidatePath('/');
  });
}
