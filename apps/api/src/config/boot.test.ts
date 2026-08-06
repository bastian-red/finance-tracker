import { describe, expect, it } from 'vitest';
import { assertBootable } from './boot';
import { ConfigError, loadConfig, type ApiConfig } from './config';

/**
 * Pins that every startup check refuses the value it exists for, and that the
 * message names the variable.
 *
 * The assertions are on the **name**, never on the whole sentence. The wording is
 * meant to be improved; the name is the only part of the message a reader acts
 * on, and a test that quotes the sentence turns every rewording into a red
 * suite for no gain.
 *
 * Without these, each bad value fails somewhere else entirely: a relative
 * `APP_BASE_URL` throws inside `renderAlert`'s `new URL()` at send time, after
 * the request's write has committed, and a blank `MAIL_FROM` throws nothing at
 * all -- `createChannel` returns the null channel and every alert reports
 * `delivered: false` beside a configured SMTP server.
 */

/** A config that boots. Every test below changes exactly one field of it. */
const BOOTABLE: ApiConfig = loadConfig({
  DATABASE_URL: 'postgresql://fin:fin@localhost:5436/fin?schema=public',
  REDIS_URL: 'redis://localhost:6383',
  AUTH_SECRET: 'sixteen-characters-at-least',
});

const withSmtpFrom = (from: string): ApiConfig => ({
  ...BOOTABLE,
  smtp: { ...BOOTABLE.smtp, from },
});

/** The message of the `ConfigError` a call threw, or '' if it did not throw. */
const messageOf = (config: ApiConfig): string => {
  try {
    assertBootable(config);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
};

describe('assertBootable', () => {
  it('accepts the config a fresh checkout produces', () => {
    // The defaults in `loadConfig` and the checks here are two lists that have to
    // agree. If they ever stop agreeing, `pnpm dev` fails on a clone with nothing
    // wrong in it, which is the worst first impression the repo can make.
    expect(() => assertBootable(BOOTABLE)).not.toThrow();
  });

  it('returns nothing, so a caller cannot mistake it for a parser', () => {
    expect(assertBootable(BOOTABLE)).toBeUndefined();
  });
});

describe('APP_BASE_URL', () => {
  it('accepts http and https', () => {
    expect(() =>
      assertBootable({ ...BOOTABLE, appBaseUrl: 'http://localhost:3000' }),
    ).not.toThrow();
    expect(() => assertBootable({ ...BOOTABLE, appBaseUrl: 'https://fin.example' })).not.toThrow();
  });

  it('refuses a relative base, which is the failure this check exists for', () => {
    // `new URL('/app')` throws. `renderAlert` does that at send time, on the tail
    // of a committed request, so the alert vanishes and the log names a URL
    // nobody touched today.
    expect(() => assertBootable({ ...BOOTABLE, appBaseUrl: '/app' })).toThrow(ConfigError);
    expect(messageOf({ ...BOOTABLE, appBaseUrl: '/app' })).toMatch(/APP_BASE_URL/);
  });

  it('refuses a scheme a browser will not follow', () => {
    // Absolute and parseable, so the URL check alone would pass it. A deep link
    // to `ftp://fin.example/alerts/1` is a dead link in every mail client.
    const broken = { ...BOOTABLE, appBaseUrl: 'ftp://fin.example' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/APP_BASE_URL/);
    expect(messageOf(broken)).toMatch(/ftp:/);
  });

  it('quotes the value it could not parse, so the typo is visible', () => {
    // Quoted, because the interesting values are the ones that look fine in a
    // `.env`: a trailing space, an empty string, a shell variable that never
    // expanded. `JSON.stringify` makes all three legible in a boot log.
    expect(messageOf({ ...BOOTABLE, appBaseUrl: '/app ' })).toContain(JSON.stringify('/app '));
  });

  it('names the scheme when the value parses but is the wrong kind of URL', () => {
    // `localhost:3000/` is the classic http:// omission, and it is *not* the
    // unparseable branch: `new URL` accepts it happily with `localhost:` as the
    // protocol and `3000/` as the path. Reporting it as "not a URL" would send
    // an operator looking for a typo in the host. Naming the scheme points at
    // the actual missing characters.
    const broken = { ...BOOTABLE, appBaseUrl: 'localhost:3000/' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/APP_BASE_URL/);
    expect(messageOf(broken)).toContain('"localhost:" scheme');
    expect(messageOf(broken)).toContain('http:, https:');
  });
});

describe('DATABASE_URL', () => {
  it('accepts both spellings of the Postgres scheme', () => {
    // Prisma writes `postgresql://`, psql and most hosting dashboards write
    // `postgres://`, and they are the same server.
    expect(() =>
      assertBootable({ ...BOOTABLE, databaseUrl: 'postgres://fin:fin@localhost:5436/fin' }),
    ).not.toThrow();
    expect(() =>
      assertBootable({ ...BOOTABLE, databaseUrl: 'postgresql://fin:fin@localhost:5436/fin' }),
    ).not.toThrow();
  });

  it('refuses a database that is not Postgres', () => {
    const broken = { ...BOOTABLE, databaseUrl: 'mysql://fin:fin@localhost:3306/fin' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/DATABASE_URL/);
  });

  it('refuses a value that is not a URL at all', () => {
    // The shape a `.env` acquires when someone pastes a host and a password into
    // it by hand.
    const broken = { ...BOOTABLE, databaseUrl: 'fin:fin@localhost/fin' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/DATABASE_URL/);
  });

  it('names only the variable that is wrong', () => {
    // Three URL checks in a row, and a message that named the wrong one would
    // send the reader to edit a line that is fine.
    const message = messageOf({ ...BOOTABLE, databaseUrl: 'mysql://localhost/fin' });
    expect(message).not.toMatch(/REDIS_URL/);
    expect(message).not.toMatch(/APP_BASE_URL/);
  });
});

describe('REDIS_URL', () => {
  it('accepts redis and rediss', () => {
    expect(() => assertBootable({ ...BOOTABLE, redisUrl: 'redis://localhost:6383' })).not.toThrow();
    expect(() =>
      assertBootable({ ...BOOTABLE, redisUrl: 'rediss://cache.example:6380' }),
    ).not.toThrow();
  });

  it('refuses an HTTP endpoint, which is the usual paste from a dashboard', () => {
    const broken = { ...BOOTABLE, redisUrl: 'https://cache.example' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/REDIS_URL/);
  });

  it('refuses a bare host and port', () => {
    const broken = { ...BOOTABLE, redisUrl: 'localhost:6383' };
    expect(() => assertBootable(broken)).toThrow(ConfigError);
    expect(messageOf(broken)).toMatch(/REDIS_URL/);
  });
});

describe('MAIL_FROM', () => {
  it('refuses an all-whitespace sender, which zod min(1) accepts', () => {
    // The reason this check is here and not a `.refine()`: `"   "` is one
    // character or more, so the schema is satisfied, and `createChannel` reads a
    // blank `from` as "no channel" before it ever looks at SMTP_HOST. Every
    // alert then reports `delivered: false` with a working relay beside it.
    expect(() => assertBootable(withSmtpFrom('   '))).toThrow(ConfigError);
    expect(messageOf(withSmtpFrom('   '))).toMatch(/MAIL_FROM/);
  });

  it('refuses a tab or a newline for the same reason', () => {
    expect(() => assertBootable(withSmtpFrom('\t'))).toThrow(ConfigError);
    expect(() => assertBootable(withSmtpFrom('\n'))).toThrow(ConfigError);
  });

  it('accepts a sender with padding around it, because trim decides', () => {
    expect(() => assertBootable(withSmtpFrom('  alerts@fin.example  '))).not.toThrow();
  });

  it('is checked after the URLs, so a broken URL is reported first', () => {
    // Both wrong at once. The URL is the one that stops the process from
    // serving anything, so it is the one worth naming first.
    const message = messageOf({
      ...withSmtpFrom(' '),
      appBaseUrl: '/app',
    });
    expect(message).toMatch(/APP_BASE_URL/);
    expect(message).not.toMatch(/MAIL_FROM/);
  });
});
