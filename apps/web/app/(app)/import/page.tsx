import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchAccounts, fetchCategories, fetchImportPreview } from '../../../lib/queries';
import { formatAmbiguities } from '../../../lib/import-format';
import { categoryIndex } from '../../../lib/lookup';
import { requireUser } from '../../../lib/session';
import { FormatForm } from './format-form';
import { ImportTable } from './import-table';
import { UploadForm } from './upload-form';

export const metadata: Metadata = { title: 'Import' };

/**
 * Import a bank statement: upload, check, commit.
 *
 * One route with two states rather than two routes, keyed on `?id=`. An import is
 * a resource on the API and its preview is a pure function of the stored bytes, so
 * the id in the URL is enough to reconstruct this screen exactly -- a reload, a
 * shared link and a back button all land on the same rows. Nothing about the
 * preview is held in a session.
 *
 * **Nothing is written until the commit.** The upload stores the file and parses
 * it; the ledger is untouched. That is what makes the format correction worth
 * having: getting the decimal separator wrong is a hundred amounts off by a factor
 * of a hundred, and it is recoverable here and expensive afterwards.
 *
 * `searchParams` is a plain object, not a promise. That changed in Next 15; this
 * app is on 14.2, and awaiting it yields an object whose properties are all
 * undefined, which would read as "no import selected" and quietly show the upload
 * form over an upload in progress.
 */
export default async function ImportPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}): Promise<JSX.Element> {
  const user = await requireUser();
  const format = { currency: user.currency, locale: user.locale };

  const raw = searchParams.id;
  const importId = typeof raw === 'string' && raw !== '' ? raw : null;

  const [accounts, categories] = await Promise.all([fetchAccounts(), fetchCategories()]);

  if (importId === null) {
    return (
      <>
        <div className="page-head">
          <div className="stack-tight">
            <h1>Import a statement</h1>
            <p>
              Upload a CSV export from your bank. Nothing reaches the ledger until you have looked
              at what was read and pressed the button at the bottom.
            </p>
          </div>
          <Link className="btn" href="/rules">
            Rules that file it
          </Link>
        </div>

        <section className="card" aria-labelledby="upload-heading">
          <div className="card-head">
            <h2 id="upload-heading">Choose a file</h2>
            <p>
              The separator, the decimal mark, the date order and the text encoding are worked out
              from the file itself. You get to correct all four before anything is saved.
            </p>
          </div>

          {accounts.length === 0 ? (
            <p className="empty">
              A statement belongs to an account, and there are none yet. Accounts are created with
              your first sign-in seed; if this list is empty the account read failed.
            </p>
          ) : (
            <UploadForm accounts={accounts} />
          )}
        </section>
      </>
    );
  }

  // Deliberately not wrapped: a preview that does not exist (a stale link, an
  // upload someone discarded in another tab) is a 404 from the API and belongs in
  // the route's error boundary with its status intact.
  const preview = await fetchImportPreview(importId);
  const account = accounts.find((candidate) => candidate.id === preview.accountId);
  const ambiguities = formatAmbiguities(preview.format);
  const byCategory = categoryIndex(categories);

  return (
    <>
      <div className="page-head">
        <div className="stack-tight">
          <h1>{preview.filename}</h1>
          <p>
            Read as {preview.counts.total} {preview.counts.total === 1 ? 'row' : 'rows'} for{' '}
            {account?.name ?? 'an unknown account'}. Nothing has been written yet.
          </p>
        </div>
        <Link className="btn btn-quiet" href="/import">
          Upload a different file
        </Link>
      </div>

      <section className="card" aria-labelledby="counts-heading">
        <div className="card-head">
          <h2 id="counts-heading">What was read</h2>
        </div>

        <div className="import-counts">
          <div>
            <span className="tile-label">New</span>
            <span className="tile-value num">{preview.counts.new}</span>
          </div>
          <div>
            <span className="tile-label">Already in the ledger</span>
            <span className="tile-value num">{preview.counts.duplicate}</span>
          </div>
          <div>
            <span className="tile-label">Unreadable</span>
            <span className="tile-value num">{preview.counts.error}</span>
          </div>
        </div>

        {ambiguities.length > 0 ? (
          <ul className="stack-tight">
            {ambiguities.map((note) => (
              <li className="state state-approaching" key={note}>
                <span aria-hidden="true" className="state-glyph">
                  &#9650;
                </span>
                {note}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="card" aria-labelledby="format-heading">
        <div className="card-head">
          <h2 id="format-heading">How the file was read</h2>
          <p>
            Change any of these and the whole file is parsed again from the bytes that were stored.
            Correcting the decimal mark after the fact is not possible, so it is worth a look now.
          </p>
        </div>
        <FormatForm importId={preview.importId} format={preview.format} />
      </section>

      <section className="card" aria-labelledby="rows-heading">
        <div className="card-head">
          <h2 id="rows-heading">Row by row</h2>
          <p>
            Rows already in the ledger start ticked out. Untick one to import it anyway; two
            identical coffees on the same afternoon are allowed to both be real.
          </p>
        </div>
        <ImportTable
          importId={preview.importId}
          rows={preview.rows}
          categories={byCategory}
          format={format}
        />
      </section>
    </>
  );
}
