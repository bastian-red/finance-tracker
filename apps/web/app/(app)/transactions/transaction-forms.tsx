'use client';

import type { Account, Category, Transaction } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { money, type MoneyFormat } from '../../../lib/format';
import {
  createTransactionAction,
  deleteTransactionAction,
  updateTransactionAction,
} from './actions';

/**
 * Writing a transaction by hand.
 *
 * **Why this exists at all when there is an importer.** Not every row comes from a
 * bank: cash, a transfer between two of your own accounts, a correction to an
 * amount the statement rounded, a refund that arrived as a note. An app that can
 * only ingest a CSV is an app that cannot be made to agree with reality.
 *
 * **The amount is one signed field, not an amount plus a direction toggle.** That
 * is what the column is: `amount_minor` is a signed `int4` and there is no `kind`
 * anywhere in the schema, so a toggle would be a second source of truth that the
 * ledger would have to reconcile on every read. The sign is explained in the
 * hint, and the line under the field restates whatever was typed as a sentence,
 * "That is 52,40 going out", because a reader who has mixed up the sign
 * recognises it in prose long before they recognise it in a minus.
 *
 * **`type="text"` with `inputMode="decimal"`, never `type="number"`.** Same
 * reasoning as the budget form: a number input silently discards what the browser
 * cannot parse in its own locale, so a Spanish reader typing `-52,40` can submit
 * an empty string, and a scroll wheel over a focused number field edits an amount
 * by accident. `amountMinorFromMajor` accepts both separators and never divides.
 *
 * The date is `type="date"`, which is the one native picker worth having: it
 * submits `YYYY-MM-DD` regardless of how it displays, and that is exactly
 * `calendarDaySchema`.
 */

function useSubmit(): {
  result: ActionResult | null;
  pending: boolean;
  run: (action: () => Promise<ActionResult>) => void;
} {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return {
    result,
    pending,
    run: (action) => {
      setResult(null);
      startTransition(async () => {
        const outcome = await action();
        setResult(outcome);
        // The server has already dropped its cache for these paths; this pulls the
        // new render so the table and the net total below it move together.
        if (outcome.ok) router.refresh();
      });
    },
  };
}

/** Minor units back to the major-unit text the form edits. Never divides in float. */
function majorOf(amountMinor: number): string {
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * What was typed, as a sentence.
 *
 * Deliberately not a live-formatted mirror of the input: the point is the
 * *direction*, which is the half a minus sign at 13px communicates worst.
 */
function amountSentence(raw: string, format: MoneyFormat): string {
  const value = Number.parseFloat(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value === 0) {
    return 'Negative is money out, positive is money in.';
  }
  // Display only. The action converts by string surgery; nothing computed here
  // is ever sent anywhere.
  const shown = money(Math.round(Math.abs(value) * 100), format, 'never');
  return value < 0 ? `That is ${shown} going out.` : `That is ${shown} coming in.`;
}

/** The fields a transaction has, shared by both forms so they cannot drift. */
function TransactionFields({
  idPrefix,
  categories,
  format,
  accounts,
  transaction,
  defaultDay,
}: {
  idPrefix: string;
  categories: readonly Category[];
  format: MoneyFormat;
  /** Only the create form picks one: a row cannot move between accounts. */
  accounts?: readonly Account[];
  transaction?: Transaction;
  defaultDay?: string;
}): JSX.Element {
  const [amount, setAmount] = useState(
    transaction === undefined ? '' : majorOf(transaction.amountMinor),
  );

  return (
    <>
      <div className="grid-3">
        {accounts === undefined ? null : (
          <div className="field">
            <label htmlFor={`${idPrefix}-account`}>Account</label>
            <select
              id={`${idPrefix}-account`}
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
              A row cannot be moved between accounts later: its currency comes from the account.
            </span>
          </div>
        )}

        <div className="field">
          <label htmlFor={`${idPrefix}-date`}>Date</label>
          <input
            id={`${idPrefix}-date`}
            name="bookedOn"
            type="date"
            required
            defaultValue={transaction?.bookedOn ?? defaultDay ?? ''}
          />
          <span className="field-hint">
            The day it was booked, not the day you are entering it.
          </span>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-amount`}>Amount ({format.currency})</label>
          <input
            className="num"
            id={`${idPrefix}-amount`}
            name="amount"
            type="text"
            inputMode="decimal"
            required
            autoComplete="off"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-describedby={`${idPrefix}-amount-note`}
          />
          {/* `role="status"` and not `alert`: it updates on every keystroke, and an
              assertive region would interrupt a screen reader mid-word on every
              character typed into the field it describes. */}
          <span className="field-hint" id={`${idPrefix}-amount-note`} role="status">
            {amountSentence(amount, format)}
          </span>
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-description`}>Description</label>
        <input
          id={`${idPrefix}-description`}
          name="description"
          type="text"
          required
          maxLength={300}
          defaultValue={transaction?.description ?? ''}
          autoComplete="off"
        />
        <span className="field-hint">
          What the rules match on. They compare against a normalised form: lowercase, no accents, no
          terminal numbers.
        </span>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${idPrefix}-category`}>Category</label>
          <select
            id={`${idPrefix}-category`}
            name="categoryId"
            defaultValue={transaction?.categoryId ?? ''}
          >
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Choosing one marks it as your choice, so re-running the rules will not overwrite it.
          </span>
        </div>

        <div className="field">
          <label htmlFor={`${idPrefix}-notes`}>Notes</label>
          <input
            id={`${idPrefix}-notes`}
            name="notes"
            type="text"
            maxLength={1000}
            defaultValue={transaction?.notes ?? ''}
            autoComplete="off"
          />
          <span className="field-hint">Only for you. Rules never match on this.</span>
        </div>
      </div>
    </>
  );
}

export function CreateTransactionForm({
  accounts,
  categories,
  format,
  defaultDay,
}: {
  accounts: readonly Account[];
  categories: readonly Category[];
  format: MoneyFormat;
  /** Today, in the reader's own zone. Resolved on the server; see the page. */
  defaultDay: string;
}): JSX.Element {
  const { result, pending, run } = useSubmit();
  // Remounts the fields after a successful create, which is what clears the
  // controlled amount input. `form.reset()` cannot: that input is driven by
  // state, so resetting the DOM would leave the sentence describing an amount
  // the field no longer holds.
  const [formKey, setFormKey] = useState(0);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(async () => {
      const outcome = await createTransactionAction(format.currency, form);
      if (outcome.ok) setFormKey((key) => key + 1);
      return outcome;
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <TransactionFields
        key={formKey}
        idPrefix="new-transaction"
        accounts={accounts}
        categories={categories}
        format={format}
        defaultDay={defaultDay}
      />

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Add transaction'}
        </button>
      </div>
    </form>
  );
}

export function EditTransactionForm({
  transaction,
  categories,
  format,
}: {
  transaction: Transaction;
  categories: readonly Category[];
  format: MoneyFormat;
}): JSX.Element {
  const { result, pending, run } = useSubmit();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => updateTransactionAction(transaction.id, format.currency, form));
  }

  function onDelete(): void {
    setConfirming(false);
    run(() => deleteTransactionAction(transaction.id));
  }

  return (
    <form className="stack-tight" onSubmit={onSubmit}>
      <Notice result={result} />

      {/* Collapsed by default, and mounted only while open. A page of the ledger
          is fifty rows; fifty expanded forms is fifty controlled inputs and fifty
          date pickers for the one row somebody wants to fix. `<details>` rather
          than a state toggle so it is keyboard operable and findable by in-page
          search without any code of ours. */}
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          Edit<span className="visually-hidden"> {transaction.description}</span>
        </summary>

        <div className="stack">
          {open ? (
            <TransactionFields
              idPrefix={`transaction-${transaction.id}`}
              categories={categories}
              format={format}
              transaction={transaction}
            />
          ) : null}

          <div className="row">
            <button className="btn" type="submit" disabled={pending || !open}>
              {pending ? 'Saving...' : 'Save'}
            </button>

            {/* Two steps, because this one cannot be undone from the UI. The
                second button carries the consequence in its own label rather than
                in a confirm() dialog, which cannot be styled, is not read in
                context by a screen reader, and is blocked outright by some
                browsers. */}
            {confirming ? (
              <>
                <button className="btn" type="button" onClick={onDelete} disabled={pending}>
                  Yes, delete this transaction
                </button>
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  Keep it
                </button>
              </>
            ) : (
              <button
                className="btn btn-quiet"
                type="button"
                onClick={() => setConfirming(true)}
                disabled={pending}
              >
                Delete
              </button>
            )}
          </div>

          <p className="tile-note" role="status">
            {confirming
              ? 'There is no undo. If this row came from a statement, re-uploading that file will ' +
                'not bring it back: the same bytes are refused before they are parsed.'
              : ''}
          </p>
        </div>
      </details>
    </form>
  );
}
