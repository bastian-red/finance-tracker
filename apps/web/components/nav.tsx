'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTransition, type FormEvent } from 'react';
import { signOutAction } from '../app/(app)/actions';

/**
 * The primary navigation.
 *
 * A client component only because `aria-current` needs the active path, and
 * `usePathname` is the only thing that knows it. The list of links is data passed
 * from the server layout, not fetched here.
 *
 * `aria-current="page"` is the state; the inset underline in the stylesheet is
 * the visible half of the same fact. The link does not rely on its colour change
 * alone, which would be a 1.3.1 failure for anyone who cannot see the difference
 * between `--muted` and `--text`.
 */
const LINKS: readonly { href: string; label: string }[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/transactions', label: 'Transactions' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/reports', label: 'Reports' },
  { href: '/categories', label: 'Categories' },
  { href: '/rules', label: 'Rules' },
  { href: '/import', label: 'Import' },
  { href: '/alerts', label: 'Alerts' },
];

export function Nav({ email }: { email: string }): JSX.Element {
  const pathname = usePathname();
  const [signingOut, startSignOut] = useTransition();

  function onSignOut(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // The action ends in `redirect('/login')`, which throws NEXT_REDIRECT for
    // Next to catch. Nothing here may wrap it in a try/catch.
    startSignOut(() => {
      void signOutAction();
    });
  }

  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-inner">
        <Link className="nav-brand" href="/">
          Ledger
        </Link>

        <ul className="nav-links">
          {LINKS.map((link) => {
            // Exact match for the dashboard, prefix match for the rest, so
            // `/transactions?uncategorised=true` still marks Transactions as the
            // current page while `/budgets` does not light up `/`.
            const current = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link
                  className="nav-link"
                  href={link.href}
                  aria-current={current ? 'page' : undefined}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="nav-user">
          <span className="visually-hidden">Signed in as</span>
          <span>{email}</span>
          <form onSubmit={onSignOut}>
            <button className="btn btn-quiet" type="submit" disabled={signingOut}>
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
