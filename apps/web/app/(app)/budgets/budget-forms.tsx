'use client';

import type { Budget, Category } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { createBudgetAction, deleteBudgetAction, updateBudgetAction } from './actions';

/**
 * The three budget forms.
 *
 * They share one submit shape — prevent the default, hand the `FormData` to a
 * server action inside a transition, render whatever comes back in a
 * `role="alert"` — rather than a shared abstraction, because each has a different
 * number of fields and a wrapper that took them all as props would be longer than
 * the three of them.
 *
 * The amount input is `inputMode="decimal"` and `type="text"` rather than
 * `type="number"`. A number input silently discards a value the browser cannot
 * parse in its locale, so a Spanish user typing `340,50` into one can end up
 * submitting an empty string, and a scroll wheel over a focused number field
 * changes a budget by accident. The parsing happens in `amountMinorFromMajor`,
 * which accepts both separators and never divides.
 */

function useSubmit(): {
  result: ActionResult | null;
  pending: boolean;
  run: (action: () => Promise<ActionResult>) => void;
  clear: () => void;
} {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  return {
    result,
    pending,
    clear: () => setResult(null),
    run: (action) => {
      setResult(null);
      startTransition(async () => {
        const outcome = await action();
        setResult(outcome);
        // The server has already dropped its cache for these paths; this pulls
        // the new render so the meter beside the form moves.
        if (outcome.ok) router.refresh();
      });
    },
  };
}

export function CreateBudgetForm({
  categories,
  currency,
  defaultMonth,
}: {
  categories: readonly Category[];
  currency: string;
  defaultMonth: string;
}): JSX.Element {
  const { result, pending, run } = useSubmit();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => createBudgetAction(currency, form));
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <div className="grid-3">
        <div className="field">
          <label htmlFor="new-budget-category">Category</label>
          <select id="new-budget-category" name="categoryId" required defaultValue="">
            <option value="" disabled>
              Pick a category
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="new-budget-limit">Limit per month ({currency})</label>
          <input
            className="num"
            id="new-budget-limit"
            name="limit"
            type="text"
            inputMode="decimal"
            required
            aria-describedby="new-budget-limit-hint"
          />
          <span className="field-hint" id="new-budget-limit-hint">
            A plain amount. Both 340.50 and 340,50 are read the same way.
          </span>
        </div>

        <div className="field">
          <label htmlFor="new-budget-from">In force from</label>
          <input
            id="new-budget-from"
            name="effectiveFrom"
            type="month"
            required
            defaultValue={defaultMonth}
          />
        </div>

        <div className="field">
          <label htmlFor="new-budget-to">Until (optional)</label>
          <input id="new-budget-to" name="effectiveTo" type="month" />
          <span className="field-hint">Leave empty to keep it in force indefinitely.</span>
        </div>
      </div>

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Create budget'}
        </button>
      </div>
    </form>
  );
}

export function EditBudgetForm({
  budget,
  categoryName,
  currency,
  limitMajor,
}: {
  budget: Budget;
  categoryName: string;
  currency: string;
  /** Rendered by the server from integer minor units. Never computed here. */
  limitMajor: string;
}): JSX.Element {
  const { result, pending, run } = useSubmit();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    run(() => updateBudgetAction(budget.id, currency, form));
  }

  function onDelete(): void {
    run(() => deleteBudgetAction(budget.id));
  }

  return (
    <form className="stack-tight" onSubmit={onSubmit}>
      <Notice result={result} />

      <div className="row">
        <div className="field">
          <label htmlFor={`limit-${budget.id}`}>
            Limit for {categoryName} ({currency})
          </label>
          <input
            className="num"
            id={`limit-${budget.id}`}
            name="limit"
            type="text"
            inputMode="decimal"
            defaultValue={limitMajor}
            required
          />
        </div>

        <div className="field">
          <label htmlFor={`until-${budget.id}`}>Until</label>
          <input
            id={`until-${budget.id}`}
            name="effectiveTo"
            type="month"
            defaultValue={budget.effectiveTo ?? ''}
          />
        </div>
      </div>

      <div className="row">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Saving...' : 'Save'}
        </button>
        <button className="btn btn-quiet" type="button" onClick={onDelete} disabled={pending}>
          Delete this budget
        </button>
      </div>
    </form>
  );
}
