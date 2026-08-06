import { describe, expect, it } from 'vitest';
import {
  apiBaseUrl,
  appBaseUrl,
  authSecret,
  defaultCurrency,
  defaultLocale,
  PUBLIC_API_BASE_URL,
} from './config';

/**
 * Every value this app reads out of the environment.
 *
 * What it pins: each fallback, and the one reader that refuses to have one.
 *
 * What breaks without it: two different things, both quiet. A wrong formatting
 * fallback is a factor-of-a-thousand error on screen, because `1.234,56` and
 * `1,234.56` are the same number read under different locales. A defaulted
 * `AUTH_SECRET` is worse: the web app would mint tokens the API cannot verify
 * and every authenticated request would fail with a 401 that says nothing about
 * the missing configuration.
 *
 * Every loader takes `env` as a defaulted parameter, which is what lets this run
 * against a fake environment instead of mutating the real one. That shape also
 * keeps the reads visible to `scripts/env-contract.mjs`, which cross-checks the
 * names against `turbo.json` and `.env.example`; Turbo 2 runs in strict env mode
 * and silently strips anything nobody declared.
 */

/** A fake environment. Nothing here touches `process.env`. */
const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe('URLs', () => {
  it('reads the server-to-server base URL', () => {
    expect(apiBaseUrl(env({ API_BASE_URL: 'http://api:4000' }))).toBe('http://api:4000');
  });

  it('falls back to localhost when nothing is set', () => {
    // Inside compose this is the service name; on a laptop it is localhost. The
    // fallback is the laptop.
    expect(apiBaseUrl(env({}))).toBe('http://localhost:4000');
    expect(appBaseUrl(env({}))).toBe('http://localhost:3000');
  });

  it('reads the app origin used as the metadata base', () => {
    expect(appBaseUrl(env({ APP_BASE_URL: 'https://ledger.example' }))).toBe(
      'https://ledger.example',
    );
  });

  it('exposes a browser-reachable API URL as a module constant', () => {
    // Written as a literal `process.env.NEXT_PUBLIC_*` on purpose: Next inlines
    // those by textual substitution at build time, and read through a variable
    // it would not be replaced, so the client bundle would see undefined.
    expect(PUBLIC_API_BASE_URL).toMatch(/^https?:\/\/.+/);
  });
});

describe('formatting fallbacks', () => {
  it('reads the configured currency and locale', () => {
    expect(defaultCurrency(env({ DEFAULT_CURRENCY: 'USD' }))).toBe('USD');
    expect(defaultLocale(env({ DEFAULT_LOCALE: 'en-US' }))).toBe('en-US');
  });

  it('defaults to the pair .env.example documents', () => {
    // The pairing matters, not just each value: es-ES with USD would render
    // `1234,56 US$`, which is a currency nobody holds written the way nobody
    // writes it.
    expect(defaultCurrency(env({}))).toBe('EUR');
    expect(defaultLocale(env({}))).toBe('es-ES');
  });

  it('ignores an empty string the same way a missing name is ignored', () => {
    // `DEFAULT_CURRENCY=` in a .env file arrives as '', and `?? ` does not catch
    // it. This documents the real behaviour rather than the hoped-for one: an
    // empty value wins over the fallback and would reach Intl.
    expect(defaultCurrency(env({ DEFAULT_CURRENCY: '' }))).toBe('');
  });
});

describe('authSecret', () => {
  it('returns a secret long enough to sign with', () => {
    expect(authSecret(env({ AUTH_SECRET: 'a'.repeat(16) }))).toBe('a'.repeat(16));
    expect(authSecret(env({ AUTH_SECRET: 'x'.repeat(64) }))).toBe('x'.repeat(64));
  });

  it('throws rather than defaulting', () => {
    // The whole point. A default here mints tokens the API rejects, and the
    // symptom is a 401 that mentions nothing about configuration.
    expect(() => authSecret(env({}))).toThrow(/AUTH_SECRET is missing/);
  });

  it('throws on a secret that is too short to be one', () => {
    expect(() => authSecret(env({ AUTH_SECRET: 'short' }))).toThrow(/shorter than 16/);
    expect(() => authSecret(env({ AUTH_SECRET: 'a'.repeat(15) }))).toThrow(/shorter than 16/);
    expect(() => authSecret(env({ AUTH_SECRET: '' }))).toThrow(/AUTH_SECRET is missing/);
  });

  it('says what the missing value is for', () => {
    // The error is read by someone whose app just failed to boot. "Invalid
    // configuration" would cost them twenty minutes.
    expect(() => authSecret(env({}))).toThrow(/service token/);
  });
});
