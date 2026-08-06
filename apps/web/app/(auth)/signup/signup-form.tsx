'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { signUpAction } from '../actions';

/**
 * The account form.
 *
 * The one non-obvious field is the hidden `timeZone`, filled from
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` at submit time. The server
 * genuinely cannot know it — `Accept-Language` carries a language, not a zone —
 * and every calendar day in this ledger is filed by the account's zone, so a user
 * in Madrid whose account defaulted to UTC would see a purchase made at 00:30 on
 * the 1st filed under the 31st.
 *
 * It is read at submit rather than in an effect so there is no render where the
 * field is empty, and it falls back to UTC on the browsers that answer
 * `undefined`.
 */
export function SignupForm(): JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('timeZone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    setResult(null);
    startTransition(async () => {
      const outcome = await signUpAction(form);
      if (!outcome.ok) {
        setResult(outcome);
        return;
      }
      router.refresh();
      router.replace(outcome.message);
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <Notice result={result} />

      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" autoComplete="name" required maxLength={120} />
      </div>

      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          aria-describedby="password-hint"
        />
        {/* Length only, and said out loud. A composition rule ("one symbol, one
            digit") measurably pushes people toward `Password1!`; NIST 800-63B has
            recommended against them since 2017, and the contract enforces length
            alone for the same reason. */}
        <p className="field-hint" id="password-hint">
          At least 10 characters. Length is the only rule.
        </p>
      </div>

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Creating your ledger...' : 'Create account'}
      </button>
    </form>
  );
}
