'use client';

import type { Category } from '@fin/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ChangeEvent } from 'react';
import { recategoriseAction } from './actions';

/**
 * The inline category picker on a ledger row.
 *
 * A native `<select>`, on purpose. A custom combobox would need a listbox role, a
 * managed active descendant, type-ahead, and an escape path, and would end up a
 * worse version of the control every platform already ships with all of those.
 * The native one is keyboard-operable, screen-reader-announced and touch-friendly
 * for free, which is the entire argument.
 *
 * It commits on `change` rather than behind a Save button. The alternative is a
 * button per row in a table of two hundred rows, and recategorising a batch after
 * an import is the single most repeated action in this app. The trade is that a
 * mis-click writes immediately, which is why the outcome is announced in a live
 * region and the previous value is restored if the write fails: an optimistic
 * control that silently reverts is worse than no feedback at all.
 */
export function Recategorise({
  transactionId,
  description,
  categories,
  selected,
}: {
  transactionId: string;
  description: string;
  categories: readonly Category[];
  selected: string;
}): JSX.Element {
  const router = useRouter();
  const [value, setValue] = useState(selected);
  const [status, setStatus] = useState('');
  const [pending, startTransition] = useTransition();

  function onChange(event: ChangeEvent<HTMLSelectElement>): void {
    const next = event.target.value;
    const previous = value;
    setValue(next);
    setStatus('');
    startTransition(async () => {
      const result = await recategoriseAction(transactionId, next);
      if (result.ok) {
        setStatus('Saved.');
        // The totals at the top of the page, and the dashboard behind it, are
        // both stale now. The server has already been told to drop its cache;
        // this is what pulls the new render.
        router.refresh();
        return;
      }
      setValue(previous);
      setStatus(result.error);
    });
  }

  return (
    <span className="cell-form">
      <label className="visually-hidden" htmlFor={`category-${transactionId}`}>
        Category for {description}
      </label>
      <select id={`category-${transactionId}`} value={value} onChange={onChange} disabled={pending}>
        <option value="">Uncategorised</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
      {/* Polite, not assertive: this is the result of something the user just
          did on purpose, so it should wait its turn rather than interrupt. */}
      <span className="visually-hidden" role="status">
        {status}
      </span>
    </span>
  );
}
