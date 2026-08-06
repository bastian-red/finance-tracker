'use client';

import { formatDay, day as parseDay, type Category, type ImportPreviewRow } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { CategoryChip } from '../../../components/category-chip';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { money, type MoneyFormat } from '../../../lib/format';
import { importRowLabel } from '../../../lib/import-format';
import { commitImportAction, discardImportAction } from './actions';

/**
 * The preview table, and the one decision this screen exists to let somebody make.
 *
 * **The duplicates start ticked out, and the server is not the one doing it.**
 * `commitImportSchema.skipLines` is applied exactly as sent, and the API
 * deliberately does not filter duplicates on its own: a person looking at two
 * identical coffees on the same afternoon is allowed to decide both are real, and
 * a server that removed them would leave no way to say so. Pre-ticking is
 * therefore this component's job, stated here because it is the kind of default
 * that looks like server behaviour until someone goes looking for it.
 *
 * **Error rows are not a choice.** They have a null day and a null amount because
 * a cell could not be read, they are absent from `preview.plan` on the API side,
 * and there is nothing to import. Their checkbox is disabled and their reason is
 * printed instead. Presenting them as tickable would offer control that does not
 * exist.
 *
 * **Status is a glyph, a word and a colour, in that order.** Same rule as the rest
 * of the app: on this canvas no green, amber and red all clear AA against the
 * surface *and* separate from each other in greyscale. This is the screen where a
 * reader scans hundreds of rows looking for the handful that are not fine, which
 * is exactly the task hue alone cannot do.
 *
 * The row count is capped upstream at 2,000 by `MAX_RAW`, so this renders a
 * bounded table without virtualisation. Adding a windowing library for a list that
 * cannot exceed that would be a dependency bought with nothing.
 */
export function ImportTable({
  importId,
  rows,
  categories,
  format,
}: {
  importId: string;
  rows: readonly ImportPreviewRow[];
  categories: Map<string, Category>;
  format: MoneyFormat;
}): JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [committed, setCommitted] = useState(false);
  const [pending, startTransition] = useTransition();

  // The initial tick state: duplicates out, everything readable in. Errors are
  // not in this set because they are not committable either way.
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(
    () => new Set(rows.filter((row) => row.status === 'duplicate').map((row) => row.lineNumber)),
  );

  const importable = useMemo(() => rows.filter((row) => row.status !== 'error'), [rows]);
  const willImport = importable.filter((row) => !skipped.has(row.lineNumber));
  const netMinor = willImport.reduce((total, row) => total + (row.amountMinor ?? 0), 0);

  function toggle(lineNumber: number): void {
    setSkipped((current) => {
      const next = new Set(current);
      if (!next.delete(lineNumber)) next.add(lineNumber);
      return next;
    });
  }

  function setAll(skip: boolean): void {
    setSkipped(skip ? new Set(importable.map((row) => row.lineNumber)) : new Set());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setResult(null);
    startTransition(async () => {
      const outcome = await commitImportAction(importId, [...skipped]);
      setResult(outcome);
      if (outcome.ok) {
        setCommitted(true);
        router.refresh();
      }
    });
  }

  function onDiscard(): void {
    setResult(null);
    startTransition(async () => {
      const outcome = await discardImportAction(importId);
      if (outcome.ok) {
        router.push('/import');
        return;
      }
      setResult(outcome);
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      {committed ? (
        <p className="row">
          <a className="btn btn-primary" href="/transactions">
            See them in the ledger
          </a>
          <a className="btn btn-quiet" href="/import">
            Import another statement
          </a>
        </p>
      ) : (
        <>
          <div className="row">
            <button className="btn btn-quiet" type="button" onClick={() => setAll(false)}>
              Import all {importable.length}
            </button>
            <button className="btn btn-quiet" type="button" onClick={() => setAll(true)}>
              Skip all
            </button>
            <span role="status">
              {willImport.length} of {importable.length} selected, net{' '}
              <span className="num">{money(netMinor, format, 'always')}</span>
            </span>
          </div>

          <div className="table-scroll">
            <table>
              <caption className="visually-hidden">
                Every row read from the file, with whether it will be imported
              </caption>
              <thead>
                <tr>
                  <th scope="col">Import</th>
                  <th scope="col">Line</th>
                  <th scope="col">Status</th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const label = importRowLabel(row.status);
                  const isError = row.status === 'error';
                  const skip = isError || skipped.has(row.lineNumber);
                  const category =
                    row.suggestedCategoryId === null
                      ? undefined
                      : categories.get(row.suggestedCategoryId);

                  return (
                    <tr className={skip ? 'import-row-skipped' : undefined} key={row.lineNumber}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!skip}
                          disabled={isError || pending}
                          onChange={() => toggle(row.lineNumber)}
                          aria-label={
                            isError
                              ? `Line ${row.lineNumber} cannot be imported`
                              : `Import line ${row.lineNumber}, ${row.description}`
                          }
                        />
                      </td>
                      <td className="num">{row.lineNumber}</td>
                      <td>
                        <span className={`state ${label.className}`}>
                          <span aria-hidden="true" className="state-glyph">
                            {label.glyph}
                          </span>
                          {label.word}
                        </span>
                      </td>
                      <td className="num">
                        {row.bookedOn === null
                          ? ''
                          : formatDay(parseDay(row.bookedOn), format.locale)}
                      </td>
                      <td>
                        {row.description}
                        {row.message === null ? null : (
                          <>
                            <br />
                            <span className="field-hint">{row.message}</span>
                          </>
                        )}
                      </td>
                      <td className="num">
                        {row.amountMinor === null ? '' : money(row.amountMinor, format, 'always')}
                      </td>
                      <td>
                        {category === undefined ? (
                          <span className="field-hint">Uncategorised</span>
                        ) : (
                          <>
                            <CategoryChip name={category.name} colorSlot={category.colorSlot} />
                            {row.suggestedBy === null ? null : (
                              <>
                                <br />
                                <span className="field-hint">{row.suggestedBy}</span>
                              </>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="row">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={pending || willImport.length === 0}
            >
              {pending
                ? 'Importing...'
                : `Import ${willImport.length} ${willImport.length === 1 ? 'transaction' : 'transactions'}`}
            </button>
            <button className="btn btn-quiet" type="button" onClick={onDiscard} disabled={pending}>
              Discard this upload
            </button>
          </div>
        </>
      )}
    </form>
  );
}
