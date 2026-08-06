import type { SessionUser } from '@fin/shared';

/**
 * What this app's session actually holds.
 *
 * Auth.js ships a `User` of `{ id?, name?, email?, image? }`, and every one of
 * those is optional. This app needs four more things on every render — the
 * user's id to mint a service token, and their locale, time zone and currency to
 * format a single amount or date correctly — and it needs them to be present
 * rather than possibly-undefined, because `formatMoney(amount, { currency:
 * undefined })` throws at the point of display rather than at the point of the
 * mistake.
 *
 * So the session's user is the contract's `SessionUser`, which is the same shape
 * the API answers `/auth/login` with, parsed rather than cast. `auth.ts` is what
 * guarantees the type is not a lie: the jwt callback refuses to mint a token it
 * cannot parse into this shape, and the session callback returns a session with
 * no user at all rather than a half-built one.
 */
declare module 'next-auth' {
  interface Session {
    user: SessionUser;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /**
     * Namespaced rather than spread across the token's own `name`/`email`
     * fields, which Auth.js writes itself and would overwrite.
     */
    fin?: SessionUser;
  }
}
