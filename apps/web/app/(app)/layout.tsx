import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '../../components/nav';
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
        {/* The status page, not the raw `/health` JSON.
            An earlier version of this footer linked the endpoint directly and
            argued that a page was unnecessary because nothing here is deployed.
            That had it backwards: with no public URL and no uptime dashboard, a
            page a reader can open *is* the only demonstration that this app knows
            whether its dependencies are answering. The endpoint is still one click
            further on, for anyone who would rather read the JSON. */}
        <Link href="/status">Service status</Link>
      </footer>
    </div>
  );
}
