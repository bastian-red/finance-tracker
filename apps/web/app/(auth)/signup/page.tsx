import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { defaultCurrency, defaultLocale } from '../../../lib/config';
import { currentUser } from '../../../lib/session';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create an account' };

export default async function SignupPage(): Promise<JSX.Element> {
  const user = await currentUser();
  if (user) redirect('/');

  return (
    <div className="auth-card">
      <div className="stack-tight">
        <h1>Create an account</h1>
        {/* The currency and locale are stated rather than asked. They are read
            from the deployment's own configuration, they can be changed later,
            and a signup form with five fields converts worse than one with
            three. */}
        <p>
          Amounts are kept in {defaultCurrency()} and shown as {defaultLocale()} writes them.
        </p>
      </div>

      <SignupForm />

      <p>
        Already have one? <Link href="/login">Sign in</Link>.
      </p>
    </div>
  );
}
