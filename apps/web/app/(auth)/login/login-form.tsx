'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Notice } from '../../../components/notice';
import type { ActionResult } from '../../../lib/action-result';
import { signInAction } from '../actions';

/**
 * The sign-in form.
 *
 * Submitted through `onSubmit` rather than through React's form-action prop.
 * That is a typing decision with a real consequence: `@types/react` 18.3 types
 * `<form action>` as a string and leaves the function overload behind a
 * `DO_NOT_USE_OR_YOU_WILL_BE_FIRED_EXPERIMENTAL_FORM_ACTIONS` marker that Next
 * 14.2 does not augment, so passing a server action there is a type error that
 * can only be silenced with a cast. This shape needs no cast, and the element is
 * still a real `<form>` with a real submit button, so Enter-to-submit, the
 * browser's own required-field messages and password managers all behave.
 *
 * The navigation happens here rather than in the action, because the action
 * cannot both redirect and report an error: `redirect()` throws, and a throw is
 * indistinguishable from a failure to the caller.
 */
export function LoginForm(): JSX.Element {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setResult(null);
    startTransition(async () => {
      const outcome = await signInAction(form);
      if (!outcome.ok) {
        setResult(outcome);
        return;
      }
      // `refresh` before `replace`: the session cookie was set by the action, and
      // without discarding the client-side router cache the dashboard can render
      // from an entry captured while nobody was signed in.
      router.refresh();
      router.replace(outcome.message);
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate={false}>
      <Notice result={result} />

      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          // Not `aria-required`: `required` already conveys it, and the browser's
          // own validation message is better than anything this form could show.
        />
      </div>

      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={10}
        />
      </div>

      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  );
}
