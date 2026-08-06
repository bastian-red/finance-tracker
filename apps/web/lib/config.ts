/**
 * Everything the web app reads out of the environment, in one place.
 *
 * Each reader takes `env` as a defaulted parameter rather than closing over
 * `process.env` at module scope. Two reasons, and the second is the one that
 * matters:
 *
 * - a unit test can hand it a fake environment without mutating the real one,
 *   which is what lets `config.test.ts` prove the fallbacks;
 * - `scripts/env-contract.mjs` scans source for `process.env.NAME` and `env.NAME`
 *   and cross-checks the result against `turbo.json` and `.env.example`. Turbo 2
 *   runs in strict env mode, so a name the code reads but nobody declared is
 *   stripped silently and arrives as `undefined`. Keeping the reads in this shape
 *   keeps them visible to that scanner.
 *
 * There is one exception below, and it is deliberate.
 */

/** Server-to-server base URL. Inside compose this is the service name, not localhost. */
export function apiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.API_BASE_URL ?? 'http://localhost:4000';
}

/**
 * The API URL as the *browser* would have to reach it.
 *
 * Written as a literal `process.env.NEXT_PUBLIC_API_BASE_URL` rather than through
 * an `env` parameter, because Next inlines `NEXT_PUBLIC_*` by textual
 * substitution at build time. Read through a variable it would not be replaced,
 * and the client bundle would see `undefined`.
 *
 * It exists because `API_BASE_URL` is meaningless outside the compose network:
 * `http://api:4000/health` resolves for the Next server and for nobody else. The
 * footer links here so a reader running the stack can open the API's health
 * check from the page.
 */
export const PUBLIC_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/** Absolute origin of this app, used as the metadata base for canonical URLs. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.APP_BASE_URL ?? 'http://localhost:3000';
}

/**
 * Formatting fallbacks.
 *
 * The signed-in user carries their own currency and locale in the session, so
 * these only apply before there is a session: the signup form's example amounts
 * and the money helpers' defaults. `es-ES` and `EUR` match `.env.example`, and
 * the pairing matters -- `1.234,56` and `1,234.56` are the same number under
 * different locales and guessing wrong is a 1000x error.
 */
export function defaultCurrency(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEFAULT_CURRENCY ?? 'EUR';
}

export function defaultLocale(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEFAULT_LOCALE ?? 'es-ES';
}

/**
 * The secret shared with the API, used to sign the short-lived service token.
 *
 * Throws rather than defaulting. A default here would mint tokens the API cannot
 * verify, and every authenticated request would fail with a 401 that says nothing
 * about the missing configuration.
 */
export function authSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET is missing or shorter than 16 characters. The web app signs the ' +
        'service token the API verifies, so without it no authenticated request can succeed.',
    );
  }
  return secret;
}
