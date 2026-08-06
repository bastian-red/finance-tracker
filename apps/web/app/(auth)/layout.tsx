import type { ReactNode } from 'react';

/**
 * The shell for the two pages that have no session.
 *
 * A separate route group from `(app)` so the signed-in chrome cannot paint over
 * them: the nav needs a user, and rendering it here would either await a session
 * that does not exist or show a nav with empty links. It carries the `#main`
 * target the root layout's skip link points at.
 */
export default function AuthLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <main className="auth-shell" id="main">
      {children}
    </main>
  );
}
