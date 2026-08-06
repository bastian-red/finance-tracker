'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markAlertReadAction } from './actions';

/**
 * The one control on the alerts page.
 *
 * A button and not a checkbox: this is an action with a server effect, not a
 * piece of form state, and it is one-way. A checkbox implies it can be unticked.
 *
 * The failure is reported in a `role="status"` beside the button rather than in a
 * `<Notice>` at the top of the page, because with a dozen alerts on screen a
 * message four rows up cannot say which one it is about.
 */
export function MarkRead({ alertId, label }: { alertId: string; label: string }): JSX.Element {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onClick(): void {
    setError(null);
    startTransition(async () => {
      const outcome = await markAlertReadAction(alertId);
      if (outcome.ok) {
        router.refresh();
        return;
      }
      setError(outcome.error);
    });
  }

  return (
    <span className="cell-form">
      <button className="btn btn-quiet" type="button" onClick={onClick} disabled={pending}>
        {pending ? 'Marking...' : 'Mark read'}
        {/* The visible label is the same on every row, so the accessible name
            carries which alert it belongs to. */}
        <span className="visually-hidden">: {label}</span>
      </button>
      <span role="status">{error ?? ''}</span>
    </span>
  );
}
