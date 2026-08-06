import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../../lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Signed-in visitors are sent to the dashboard rather than shown a form they
 * cannot usefully submit. `redirect()` is called outside any try/catch, because
 * it works by throwing `NEXT_REDIRECT`.
 */
export default async function LoginPage(): Promise<JSX.Element> {
  const user = await currentUser();
  if (user) redirect('/');

  return (
    <div className="auth-card">
      <div className="stack-tight">
        <h1>Sign in</h1>
        <p>Your ledger, your categories, your budgets.</p>
      </div>

      <LoginForm />

      <p>
        No account yet? <Link href="/signup">Create one</Link>.
      </p>
    </div>
  );
}
