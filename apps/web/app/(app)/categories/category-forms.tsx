'use client';

import type { Category } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { colorSlotChoices } from '../../../lib/palette';
import { createCategoryAction, deleteCategoryAction, updateCategoryAction } from './actions';

/**
 * The category forms.
 *
 * **The swatch picker is a `<select>` of numbered slots, not a grid of coloured
 * squares.** A grid is the obvious design and it is the wrong one here: it asks
 * the reader to choose a category by hue, which is the exact task this project
 * has already ruled cannot be done reliably -- ten categorical hues do not survive
 * a colour vision deficiency, which is why the by-category chart is a sorted
 * single-hue bar rather than a ten-slice donut. A numbered slot is a label
 * everybody can read, the swatch beside the heading shows what it currently looks
 * like, and nothing in the app ever depends on telling two of them apart: the
 * category's name is beside the swatch everywhere it appears.
 *
 * The delete button is deliberately wordy. Deleting a category is the widest
 * write in this app -- transactions survive and become uncategorised, budgets and
 * rules for it do not survive at all -- and the count of what goes with it is
 * rendered by the server into `alsoRemoved` rather than guessed here.
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
        // The server has already dropped its cache for these paths; this pulls
        // the new render so the list beside the form updates.
        if (outcome.ok) router.refresh();
      });
    },
  };
}

/** The two fields every category has, shared by both forms. */
function CategoryFields({
  idPrefix,
  defaultName,
  defaultKind,
  defaultColorSlot,
}: {
  idPrefix: string;
  defaultName: string;
  defaultKind: 'income' | 'expense';
  defaultColorSlot: number;
}): JSX.Element {
  return (
    <div className="grid-3">
      <div className="field">
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <input
          id={`${idPrefix}-name`}
          name="name"
          type="text"
          required
          maxLength={60}
          defaultValue={defaultName}
        />
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-kind`}>Kind</label>
        <select id={`${idPrefix}-kind`} name="kind" defaultValue={defaultKind}>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
        <span className="field-hint">
          Which side of the ledger this category belongs on. It does not change any amount.
        </span>
      </div>

      <div className="field">
        <label htmlFor={`${idPrefix}-slot`}>Swatch</label>
        <select id={`${idPrefix}-slot`} name="colorSlot" defaultValue={String(defaultColorSlot)}>
          {colorSlotChoices().map((slot) => (
            <option key={slot} value={String(slot)}>
              Slot {slot + 1}
            </option>
          ))}
        </select>
        <span className="field-hint">
          A find-it-again aid in tables. The name is what identifies the category.
        </span>
      </div>
    </div>
  );
}

export function CreateCategoryForm({
  defaultColorSlot,
}: {
  defaultColorSlot: number;
}): JSX.Element {
  const { result, pending, run } = useSubmit();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => createCategoryAction(form));
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <CategoryFields
        idPrefix="new-category"
        defaultName=""
        defaultKind="expense"
        defaultColorSlot={defaultColorSlot}
      />

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Create category'}
        </button>
      </div>
    </form>
  );
}

export function EditCategoryForm({
  category,
  alsoRemoved,
}: {
  category: Category;
  /** "2 rules and 1 budget", rendered by the server. Empty when nothing else goes. */
  alsoRemoved: string;
}): JSX.Element {
  const { result, pending, run } = useSubmit();
  const [confirming, setConfirming] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => updateCategoryAction(category.id, form));
  }

  function onDelete(): void {
    setConfirming(false);
    run(() => deleteCategoryAction(category.id));
  }

  return (
    <form className="stack-tight" onSubmit={onSubmit}>
      <Notice result={result} />

      <CategoryFields
        idPrefix={`category-${category.id}`}
        defaultName={category.name}
        defaultKind={category.kind}
        defaultColorSlot={category.colorSlot}
      />

      <div className="row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Save'}
        </button>

        {/* Two steps, because this one is not undoable from the UI. The second
            button carries the consequence in its own label rather than in a
            confirm() dialog, which cannot be styled, cannot be read by a screen
            reader in context, and is blocked by some browsers outright. */}
        {confirming ? (
          <>
            <button className="btn" type="button" onClick={onDelete} disabled={pending}>
              Yes, delete {category.name}
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
          ? `Transactions in ${category.name} stay in the ledger and become uncategorised. ` +
            (alsoRemoved === '' ? 'Nothing else goes with it.' : `${alsoRemoved} go with it.`)
          : ''}
      </p>
    </form>
  );
}
