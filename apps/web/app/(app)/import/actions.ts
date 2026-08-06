'use server';

import { commitResultSchema, detectedFormatSchema, importPreviewSchema } from '@fin/shared';
import { revalidatePath } from 'next/cache';
import {
  describeFailure,
  failed,
  ok,
  runAction,
  type ActionResult,
} from '../../../lib/action-result';
import { delimiterCharOf } from '../../../lib/import-format';
import { endpoints } from '../../../lib/endpoints';
import { text } from '../../../lib/form-fields';
import { authedRequest } from '../../../lib/session';

/**
 * Uploading a statement, correcting how it was read, and committing it.
 *
 * **The upload does not redirect from inside the action.** `redirect()` works by
 * throwing `NEXT_REDIRECT`, and every other mutation in this app runs inside
 * `runAction`, whose `catch` would swallow exactly that throw and report the
 * navigation as an error. So the upload returns the new import's id and the
 * client pushes the route. It is the one action here that needs a return value
 * richer than a sentence, which is why it has its own result type.
 *
 * **The file is streamed through untouched.** A fresh `FormData` is built rather
 * than forwarding the browser's, because the browser's also carries `accountId`
 * and the API reads that from a body field of the same name -- passing the
 * original through works, and passing a rebuilt one makes what crosses the wire
 * explicit. No `content-type` header is set anywhere in this path: `lib/api.ts`
 * only sets one for a JSON body, so `fetch` writes the multipart boundary itself.
 * Setting it by hand is the classic way to turn a working upload into a 400.
 *
 * **Nothing here re-implements the parser.** The format correction sends the whole
 * `DetectedFormat` back and the API re-parses the stored bytes from scratch; the
 * preview is a pure function of those bytes plus that format, so a correction and
 * a fresh upload of the same file produce the same rows. That is why this file has
 * no notion of what a delimiter or a date template means beyond mapping a select's
 * value to a character.
 */

/** `/import` renders the preview; `/transactions` gains the committed rows. */
const AFFECTED = ['/import', '/transactions', '/', '/reports', '/budgets'];

function revalidateAffected(): void {
  for (const path of AFFECTED) revalidatePath(path);
}

export type UploadResult = { ok: true; importId: string } | { ok: false; error: string };

/**
 * Send the file and hand back the id of the preview it produced.
 *
 * The 413 the API answers for an oversized file is turned into a sentence here
 * rather than in the form, because the limit is the API's (`MAX_IMPORT_BYTES`)
 * and the browser has no way to know it.
 */
export async function uploadStatementAction(form: FormData): Promise<UploadResult> {
  const accountId = text(form, 'accountId');
  if (accountId === '') return { ok: false, error: 'Choose which account this statement is for.' };

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose a CSV file exported from your bank.' };
  }

  const body = new FormData();
  body.set('accountId', accountId);
  body.set('file', file, file.name);

  try {
    const preview = await authedRequest(endpoints.imports, importPreviewSchema, {
      method: 'POST',
      raw: body,
    });
    revalidatePath('/import');
    return { ok: true, importId: preview.importId };
  } catch (error) {
    return { ok: false, error: describeFailure(error) };
  }
}

/**
 * Re-read the file with a format the reader corrected.
 *
 * `PUT`, and it carries every field: the API validates the body against the whole
 * `detectedFormatSchema`, so a partial send fails validation rather than leaving
 * the untouched fields alone. The delimiter arrives as a *name* ("tab") and is
 * mapped to its character here. It cannot travel as the character itself:
 * `lib/form-fields.ts` trims every string it reads and `"\t".trim()` is `""`,
 * which fails the contract's `length(1)` on a field nobody edited.
 */
export async function setImportFormatAction(
  importId: string,
  form: FormData,
): Promise<ActionResult> {
  const delimiter = delimiterCharOf(text(form, 'delimiter'));
  if (delimiter === null) return failed('Pick one of the listed separators.');

  const numberAt = (name: string): number => Number.parseInt(text(form, name), 10);
  const optionalNumberAt = (name: string): number | null => {
    const raw = text(form, name);
    if (raw === '' || raw === 'none') return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : null;
  };

  const parsed = detectedFormatSchema.safeParse({
    delimiter,
    decimal: text(form, 'decimal'),
    // Not editable, and not optional in the contract. The reader is overriding
    // the detector's conclusion, so the detector's stated reason no longer
    // applies and saying so is more honest than echoing the old one back.
    decimalReason: 'set by hand',
    decimalAmbiguous: false,
    dateFormat: text(form, 'dateFormat'),
    encoding: text(form, 'encoding'),
    columns: {
      date: numberAt('columnDate'),
      description: numberAt('columnDescription'),
      amount: numberAt('columnAmount'),
      credit: optionalNumberAt('columnCredit'),
      balance: optionalNumberAt('columnBalance'),
    },
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return failed(
      issue ? `${issue.path.join('.') || 'That'}: ${issue.message}` : 'Check the format fields.',
    );
  }

  return runAction('Re-read with the format you chose.', async () => {
    await authedRequest(endpoints.importFormat(importId), importPreviewSchema, {
      method: 'PUT',
      json: parsed.data,
    });
    revalidatePath('/import');
  });
}

/**
 * Commit the rows that were not ticked out.
 *
 * `skipLines` is applied by the API exactly as sent; it deliberately does not
 * filter duplicates itself, because a person looking at two identical coffees on
 * the same afternoon is allowed to decide both are real. Pre-ticking the
 * duplicates is the form's job, and `import-table.tsx` does it.
 *
 * The message is built from the API's own counts rather than from the form's,
 * because the two can legitimately differ: the insert is
 * `createMany({ skipDuplicates: true })`, so a row that was unique at preview time
 * and arrived through another import a second ago is counted as skipped by the
 * database and by nothing on this page.
 */
export async function commitImportAction(
  importId: string,
  skipLines: readonly number[],
): Promise<ActionResult> {
  try {
    const result = await authedRequest(endpoints.importCommit(importId), commitResultSchema, {
      method: 'POST',
      json: { skipLines: [...skipLines] },
    });
    revalidateAffected();

    const filed =
      result.categorised === 0
        ? 'None matched a rule, so they are all uncategorised.'
        : `${result.categorised} of them matched a rule and were categorised.`;
    return ok(
      `${result.imported} ${result.imported === 1 ? 'transaction' : 'transactions'} imported, ` +
        `${result.skipped} skipped. ${filed}`,
    );
  } catch (error) {
    return failed(describeFailure(error));
  }
}

/** Throw the upload away, file and all. Nothing was written to the ledger yet. */
export async function discardImportAction(importId: string): Promise<ActionResult> {
  return runAction('Upload discarded. Nothing was added to the ledger.', async () => {
    await authedRequest(endpoints.importById(importId), null, { method: 'DELETE' });
    revalidatePath('/import');
  });
}
