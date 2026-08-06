'use client';

import type { DetectedFormat } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import {
  bareDateFormat,
  DATE_FORMAT_CHOICES,
  DELIMITER_CHOICES,
  delimiterNameOf,
  ENCODING_CHOICES,
} from '../../../lib/import-format';
import { setImportFormatAction } from './actions';

/**
 * Correcting the detector.
 *
 * **The delimiter select carries a name, never the character.** Tab is one of the
 * four separators a bank export uses, `lib/form-fields.ts` trims every string it
 * reads out of a `FormData`, and `"\t".trim()` is `""`. An option whose value was
 * the character itself would come back empty for tab-delimited files and fail the
 * contract's `length(1)` on a field the reader never touched. `delimiterCharOf`
 * in the action maps the name back.
 *
 * **The date select is preselected from the bare template.** `detectDateFormat`
 * answers `DD/MM/YYYY (day-first assumed)` when the file carried no evidence
 * either way, and that string matches no option: the select would silently show
 * the first entry instead, offering to "correct" a day-first file to day-first
 * while displaying something else. `bareDateFormat` strips the commentary.
 *
 * The column numbers are zero-based, because that is what the contract carries and
 * what the detector reported. They are labelled as such rather than shifted by one
 * for display: a reader comparing this form against a hex dump or a spreadsheet is
 * better served by one number that is definitely right than by two conventions.
 */
export function FormatForm({
  importId,
  format,
}: {
  importId: string;
  format: DetectedFormat;
}): JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => {
      const outcome = await setImportFormatAction(importId, form);
      setResult(outcome);
      // The rows are rendered by the server from the re-parsed preview, so the
      // refresh is what actually shows the correction.
      if (outcome.ok) router.refresh();
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <div className="grid-3">
        <div className="field">
          <label htmlFor="format-delimiter">Column separator</label>
          <select
            id="format-delimiter"
            name="delimiter"
            defaultValue={delimiterNameOf(format.delimiter)}
          >
            {DELIMITER_CHOICES.map((choice) => (
              <option key={choice.name} value={choice.name}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="format-decimal">Decimal mark</label>
          <select id="format-decimal" name="decimal" defaultValue={format.decimal}>
            <option value=",">Comma 1.234,56</option>
            <option value=".">Dot 1,234.56</option>
          </select>
          <span className="field-hint">Detected: {format.decimalReason}.</span>
        </div>

        <div className="field">
          <label htmlFor="format-encoding">Text encoding</label>
          <select id="format-encoding" name="encoding" defaultValue={format.encoding}>
            {ENCODING_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Wrong here shows as mangled accents in the descriptions below.
          </span>
        </div>
      </div>

      <div className="field">
        <label htmlFor="format-date">Date order</label>
        <select id="format-date" name="dateFormat" defaultValue={bareDateFormat(format.dateFormat)}>
          {DATE_FORMAT_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid-3">
        <div className="field">
          <label htmlFor="format-column-date">Date column</label>
          <input
            id="format-column-date"
            name="columnDate"
            type="number"
            min={0}
            required
            defaultValue={String(format.columns.date)}
          />
          <span className="field-hint">Counting from 0.</span>
        </div>

        <div className="field">
          <label htmlFor="format-column-description">Description column</label>
          <input
            id="format-column-description"
            name="columnDescription"
            type="number"
            min={0}
            required
            defaultValue={String(format.columns.description)}
          />
        </div>

        <div className="field">
          <label htmlFor="format-column-amount">Amount column</label>
          <input
            id="format-column-amount"
            name="columnAmount"
            type="number"
            min={0}
            required
            defaultValue={String(format.columns.amount)}
          />
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="format-column-credit">Credit column</label>
          <input
            id="format-column-credit"
            name="columnCredit"
            type="number"
            min={0}
            defaultValue={format.columns.credit === null ? '' : String(format.columns.credit)}
            placeholder="none"
          />
          <span className="field-hint">
            Only for banks that split debits and credits into two columns instead of signing one.
            Leave empty otherwise.
          </span>
        </div>

        <div className="field">
          <label htmlFor="format-column-balance">Running balance column</label>
          <input
            id="format-column-balance"
            name="columnBalance"
            type="number"
            min={0}
            defaultValue={format.columns.balance === null ? '' : String(format.columns.balance)}
            placeholder="none"
          />
          <span className="field-hint">
            Ignored when importing. Named so it is not read as an amount.
          </span>
        </div>
      </div>

      <div className="row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Re-reading...' : 'Read it again with these'}
        </button>
      </div>
    </form>
  );
}
