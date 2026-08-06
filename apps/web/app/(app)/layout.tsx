import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '../../components/nav';
import { PUBLIC_API_BASE_URL } from '../../lib/config';
import { requireUser } from '../../lib/session';

/**
 * The signed-in shell: nav, page, footer.
 *
 * The session is read here rather than in the root layout. That is the whole
 * reason this route group exists: awaiting `auth()` in the root layout opts
 * *every* route into dynamic rendering, `/login` and `/signup` included, and
 * those two are the only pages in the app that have nothing per-user on them.
 *
 * `requireUser()` redirects anonymous visitors, so every page under this layout
 * can assume a user without repeating the check for the redirect's sake. They
 * still call it themselves, because a page needs the user's currency and locale
 * to render a single amount.
 */
export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const user = await requireUser();

  return (
    <div className="shell">
      <Nav email={user.email} />

      <main className="page" id="main">
        {children}
      </main>

      <footer className="foot">
        {/* The health check is linked rather than described. Nothing in this
            portfolio is deployed, so "it runs" is demonstrated by a reader
            cloning the repo and following this link to a real dependency check
            rather than by a status page. `PUBLIC_API_BASE_URL` and not
            `apiBaseUrl()`: inside compose the latter is `http://api:4000`, which
            resolves for the Next server and for nobody's browser. */}
        <Link href={`${PUBLIC_API_BASE_URL}/health`}>API health</Link>
      </footer>
    </div>
  );
}
