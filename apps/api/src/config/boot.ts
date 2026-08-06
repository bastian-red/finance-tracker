/**
 * The startup checks that `loadConfig`'s zod schema cannot express.
 *
 * Every one of them guards a failure that would otherwise happen far from its
 * cause, hours later, on a request that has nothing to do with the variable that
 * was wrong. That is the whole reason this file exists as a separate step rather
 * than as more `.refine()` calls: these checks are about what a value *means* to
 * a downstream library, not about its shape.
 *
 * The most expensive one is `APP_BASE_URL`. `renderAlert` in `@fin/notifications`
 * builds its deep link with `new URL(appBaseUrl)` and **throws** when the base is
 * not absolute. It throws at send time, which is the tail of a request whose
 * database write has already committed, so the user's budget alert silently never
 * arrives and the log carries an exception about a URL nobody set today. Refusing
 * to boot costs one line and names the knob.
 */
import { ConfigError, type ApiConfig } from './config';

/** Protocols each URL-shaped variable is allowed to use. */
const DATABASE_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const REDIS_PROTOCOLS = new Set(['redis:', 'rediss:']);
const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigError(
      `The API cannot start: ${name} is not a URL (got ${JSON.stringify(value)}). See .env.example.`,
    );
  }
}

function requireProtocol(name: string, url: URL, allowed: Set<string>): void {
  if (allowed.has(url.protocol)) return;
  throw new ConfigError(
    `The API cannot start: ${name} uses the "${url.protocol}" scheme; ` +
      `expected one of ${[...allowed].join(', ')}. See .env.example.`,
  );
}

/**
 * Fail loudly, naming the variable, before a single route is registered.
 *
 * Pure and total: it either returns or throws a `ConfigError` whose message
 * contains the offending name. `main.ts` prints that message and exits, and
 * `boot.test.ts` asserts on the name rather than on the whole sentence.
 */
export function assertBootable(config: ApiConfig): void {
  requireProtocol('APP_BASE_URL', parseUrl('APP_BASE_URL', config.appBaseUrl), WEB_PROTOCOLS);
  requireProtocol('DATABASE_URL', parseUrl('DATABASE_URL', config.databaseUrl), DATABASE_PROTOCOLS);
  requireProtocol('REDIS_URL', parseUrl('REDIS_URL', config.redisUrl), REDIS_PROTOCOLS);

  // `createChannel` returns the *null* channel whenever `from` is blank, and that
  // check runs before the host check, so an all-whitespace MAIL_FROM turns every
  // send into `delivered: false` with a configured SMTP server sitting idle
  // beside it. zod's `min(1)` accepts "   ", which is why this is here and not
  // in the schema.
  if (config.smtp.from.trim() === '') {
    throw new ConfigError(
      'The API cannot start: MAIL_FROM is blank, so every budget alert would be silently dropped ' +
        'by the notification channel. Set a sender address. See .env.example.',
    );
  }
}
