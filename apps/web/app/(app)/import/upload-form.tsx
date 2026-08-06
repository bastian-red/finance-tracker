'use client';

import type { Account } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import { uploadStatementAction } from './actions';

/**
 * The upload.
 *
 * It navigates rather than rendering the preview in place. The preview lives at
 * `/import?id=...` because it is a resource on the API, and pushing that URL means
 * a reload, a shared link and the back button all reconstruct the same screen. A
 * preview held in this component's state would be gone on the first refresh, after
 * the reader had already scrolled through eight hundred rows.
 *
 * `accept=".csv,text/csv"` is a hint to the file picker and nothing more. Browsers
 * disagree about the MIME type of a CSV (`text/csv`, `application/vnd.ms-excel`,
 * and `application/octet-stream` on a machine with nothing registered), so the API
 * decides what it can read by parsing the bytes, not by trusting a header.
 */
export function UploadForm({ accounts }: { accounts: readonly Account[] }): JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);

    startTransition(async () => {
      const outcome = await uploadStatementAction(form);
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      router.push(`/import?id=${encodeURIComponent(outcome.importId)}`);
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={error === null ? null : { ok: false, error }} />

      <div className="grid-2">
        <div className="field">
          <label htmlFor="upload-account">Account</label>
          <select
            id="upload-account"
            name="accountId"
            required
            defaultValue={accounts[0]?.id ?? ''}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </select>
          <span className="field-hint">
            The statement&rsquo;s currency is the account&rsquo;s. A file in another currency is a
            different account.
          </span>
        </div>

        <div className="field">
          <label htmlFor="upload-file">Statement</label>
          <input id="upload-file" name="file" type="file" accept=".csv,text/csv" required />
          <span className="field-hint">
            A CSV export. Headers optional, any of comma, semicolon, tab or pipe.
          </span>
        </div>
      </div>

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? 'Reading the file...' : 'Upload and check'}
        </button>
      </div>
    </form>
  );
}
