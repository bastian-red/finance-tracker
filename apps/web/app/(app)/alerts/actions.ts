'use server';

import { revalidatePath } from 'next/cache';
import { runAction, type ActionResult } from '../../../lib/action-result';
import { endpoints } from '../../../lib/endpoints';
import { authedRequest } from '../../../lib/session';

/**
 * Marking an alert read.
 *
 * The only write this screen has, and it is deliberately not a delete. An alert
 * is a record of a threshold that was crossed in a month that is now closed:
 * deleting it would lose the answer to "did I know about this at the time?",
 * which is the only question a past alert can still answer. `readAt` is a
 * timestamp, so the row keeps both facts.
 *
 * The API answers with the updated `Alert`. It is discarded here rather than
 * parsed and returned, because the page re-renders from the server after
 * `revalidatePath` and a second copy of the row would only be able to disagree
 * with it.
 */
export async function markAlertReadAction(alertId: string): Promise<ActionResult> {
  return runAction('Marked as read.', async () => {
    await authedRequest(endpoints.alertRead(alertId), null, { method: 'POST' });
    // The dashboard carries the unread count, so it is as wrong as this list is.
    revalidatePath('/alerts');
    revalidatePath('/');
  });
}
