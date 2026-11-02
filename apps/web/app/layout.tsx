import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { appBaseUrl } from '../lib/config';
import './globals.css';

/**
 * The document, the three typefaces, and the one keyboard escape hatch.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits the
 * session opts every route in the app into dynamic rendering, including `/login`
 * and `/signup`, which have no session to read and are the two pages that most
 * want to be static. The session is read per route instead: `app/(app)/layout.tsx`
 * reads it once for the nav, and each page reads it again for its own fetch. Both
 * reads hit the same request-scoped cookie, so the cost is a cookie parse rather
 * than a round trip.
 *
 * The three faces are chosen for what this app is read for. Newsreader carries the
 * page and section headings: a finance app is reviewed rather than operated, and a
 * text-weight serif reads as a statement rather than as a console. Public Sans is
 * the interface face, because at 13-15px in a dense table its digits and its `l`/`1`
 * stay separable where a geometric sans does not. Roboto Mono carries every number
 * a reader compares, via `.num`, so a column of amounts aligns on the decimal point.
 */
/**
 * **Self-hosted, not fetched from Google at build time.** `next/font/google`
 * downloads the faces during `next build`, and CI failed on it intermittently
 * ("Failed to find font override values for font `Newsreader`"): a build that
 * depends on a third-party fetch is not reproducible. The three variable woff2
 * files (latin subset, from @fontsource-variable 5.3.0) live in
 * `app/fonts/<Face>/` beside their SIL Open Font License. `lib/identity.test.ts`
 * and `web/scripts/identity-distinct.mjs` read the face names from those paths.
 * Variable files carry every weight the stylesheet asks for (400-600) in one
 * download per face.
 */
const display = localFont({
  src: [
    { path: './fonts/Newsreader/Newsreader-latin-wght.woff2', weight: '200 800', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-display',
});

const ui = localFont({
  src: [
    { path: './fonts/Public_Sans/PublicSans-latin-wght.woff2', weight: '100 900', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-ui',
});

const mono = localFont({
  src: [
    { path: './fonts/Roboto_Mono/RobotoMono-latin-wght.woff2', weight: '100 700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  metadataBase: new URL(appBaseUrl()),
  title: {
    default: 'Ledger',
    template: '%s | Ledger',
  },
  description:
    'Track income and expenses, categorise them with rules, set budgets per category, and import bank statements from CSV.',
};

/**
 * `color-scheme` is what makes the browser paint its own furniture — scrollbars,
 * form controls, the address bar on mobile — in the same scheme the stylesheet
 * is using. Without it a dark page keeps a white scrollbar.
 */
export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        {/* First focusable element on every page. Both layouts below render a
            `<main id="main">`, including the auth pages, so the target always
            exists. */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
