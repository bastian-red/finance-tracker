import { redirect } from 'next/navigation';

/**
 * `/dashboard` is an alias for `/`.
 *
 * The dashboard lives at the root, because that is where someone who bookmarks a
 * finance app expects to land. `/dashboard` exists because it is the name the
 * rest of the repo uses for the same screen — `scripts/dev-smoke.sh` probes
 * `DASHBOARD_PATH`, defaulted to `/dashboard`, and follows redirects — and
 * because an inbound link to a plausible URL should not 404.
 *
 * `redirect()` is the whole body and is outside any try/catch, which is the only
 * way it can work: it throws `NEXT_REDIRECT` for Next to catch upstream.
 */
export default function DashboardAliasPage(): never {
  redirect('/');
}
