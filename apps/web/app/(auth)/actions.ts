'use server';

import { signupSchema } from '@fin/shared';
import { AuthError } from 'next-auth';
import { signIn } from '../../auth';
import { apiRequest } from '../../lib/api';
import { defaultCurrency, defaultLocale } from '../../lib/config';
import { endpoints } from '../../lib/endpoints';
import { describeFailure, failed, type ActionResult } from '../../lib/action-result';
import { text } from '../../lib/form-fields';

/**
 * Sign in and sign up.
 *
 * Both of these resolve with an error or **do not resolve at all**, because a
 * success ends in a redirect and `redirect()` throws `NEXT_REDIRECT` for Next to
 * catch upstream. That is why `signIn` is called outside every try/catch below.
 * Wrapping it is the single most expensive mistake available in this file: the
 * catch swallows the throw, the action returns `{ ok: true }`, the form clears,
 * and the user stays on the login page with no error and no session.
 *
 * `next-auth` distinguishes the two cases for us — a bad password surfaces as an
 * `AuthError`, and `NEXT_REDIRECT` is a plain `Error` whose `digest` starts with
 * `NEXT_REDIRECT` — but relying on that distinction inside a catch is exactly the
 * fragility worth avoiding, so the structure avoids needing it.
 */

/** Where a successful sign-in lands. The dashboard is the only useful answer. */
const AFTER_SIGN_IN = '/';

export async function signInAction(form: FormData): Promise<ActionResult> {
  const email = text(form, 'email');
  const password = text(form, 'password');

  if (email === '' || password === '') {
    return failed('Enter both your email and your password.');
  }

  try {
    // `redirect: false` keeps the throw out of this call entirely: Auth.js
    // returns instead of navigating, and the navigation below is ours. Without
    // it the redirect would fire from inside the try and be caught here.
    await signIn('credentials', { email, password, redirect: false });
  } catch (error) {
    if (error instanceof AuthError) {
      // Deliberately the same sentence for "no such account" and "wrong
      // password". Telling an anonymous visitor which of the two it was turns
      // the login form into an account-enumeration oracle.
      return failed('That email and password do not match an account.');
    }
    return failed(describeFailure(error));
  }

  // No `await auth()` here, and that is the fix rather than an omission.
  //
  // `signIn(..., { redirect: false })` writes the session cookie onto the
  // *response*. `auth()` reads the cookies of the *request*, which was made
  // before that cookie existed, so it returns null on a sign-in that worked
  // perfectly. An earlier version of this function checked it and reported "the
  // sign-in did not produce a session" to every user who typed the right
  // password. It passed every unit test, and both `scripts/dev-smoke.sh` and a
  // manual `curl` missed it because they post straight to Auth.js's credentials
  // callback and never touch this action. The E2E suite is what found it, on the
  // first run, in both browsers.
  //
  // What stands in its place is the guarantee `signIn` already gives: it throws
  // `CredentialsSignin` when `authorize` returns null, and that throw is caught
  // above. Reaching this line means the cookie is on the response.
  return { ok: true, message: AFTER_SIGN_IN };
}

export async function signUpAction(form: FormData): Promise<ActionResult> {
  const parsed = signupSchema.safeParse({
    name: text(form, 'name'),
    email: text(form, 'email'),
    password: text(form, 'password'),
    locale: defaultLocale(),
    currency: defaultCurrency(),
    // The browser knows the visitor's zone and the server does not. Sent rather
    // than guessed, because every calendar day in this app is filed by the zone
    // the person lives in, and defaulting a Madrid user to UTC files their
    // 1 a.m. purchases under the previous day.
    timeZone: text(form, 'timeZone') || 'UTC',
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return failed(
      first
        ? `${String(first.path[0] ?? 'That')}: ${first.message}`
        : 'Check the form and try again.',
    );
  }

  try {
    await apiRequest(endpoints.signup, null, { method: 'POST', json: parsed.data });
  } catch (error) {
    return failed(describeFailure(error));
  }

  // A fresh account has no session yet, so the sign-in is part of signing up.
  // Same `redirect: false` reasoning as above.
  try {
    await signIn('credentials', {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return failed('The account was created, but the automatic sign-in failed. Sign in below.');
    }
    return failed(describeFailure(error));
  }

  return { ok: true, message: AFTER_SIGN_IN };
}
