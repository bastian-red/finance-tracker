/**
 * Everything the API reads from the environment, read once, in one place.
 *
 * A plain function rather than `@nestjs/config`, for two reasons that are both
 * load-bearing rather than stylistic.
 *
 * **`env` is a parameter with a default.** `loadConfig(fake)` is how every branch
 * below gets a unit test without touching `process.env` and without the tests
 * having to run serially. It is also what `scripts/env-contract.mjs` can see: the
 * scanner matches `env.NAME`, so a name read through a helper, a destructure or a
 * loop over a list of keys is invisible to it, and an invisible read is exactly
 * the one that goes undeclared in `turbo.json` and gets stripped in strict mode.
 * Every name below is therefore spelled out as `env.NAME`, once, in the literal.
 *
 * **It throws, naming the variable.** An API that boots with `AUTH_SECRET`
 * undefined does not fail at boot: it fails on the first request that verifies a
 * token, three layers down, as a 500 with a stack trace about `undefined`. The
 * three sibling projects in this portfolio all shipped that way. Failing here
 * costs one line of output and names the knob to fix.
 */
import { thresholdToBasisPoints } from '@fin/shared';
import { z } from 'zod';

/**
 * Mirrors the `version` field of `apps/api/package.json`.
 *
 * A constant rather than an import of the manifest: `rootDir` is `src`, so
 * reaching up to `../../package.json` puts a file outside the compilation root
 * and `tsc` refuses. `APP_VERSION` is what a real deployment sets anyway, from
 * the image tag; this is the value that shows up when nobody set it.
 */
export const PACKAGE_VERSION = '0.1.0';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface SmtpConfig {
  /** Empty means "no SMTP server configured", which `createChannel` reads as the log channel. */
  host: string | undefined;
  port: number | undefined;
  secure: boolean;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

export interface RateLimitConfig {
  /** Requests per minute, per client address. */
  global: number;
  auth: number;
  import: number;
}

export interface ApiConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  version: string;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  appBaseUrl: string;
  defaultCurrency: string;
  defaultLocale: string;
  maxImportBytes: number;
  importRoot: string;
  duplicateWindowDays: number;
  reportCacheTtlSeconds: number;
  /** `BUDGET_ALERT_THRESHOLD` converted once, at the edge, and never a float again. */
  budgetAlertBasisPoints: number;
  smtp: SmtpConfig;
  rateLimits: RateLimitConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** An empty string is an unset variable. `.env` files are full of `SMTP_USER=`. */
const blankToUndefined = (value: unknown): unknown =>
  value === undefined || value === null || value === '' ? undefined : value;

const toNumber = (value: unknown): unknown =>
  blankToUndefined(value) === undefined ? undefined : Number(value);

/**
 * Defaults and `.optional()` sit on the **inner** schema, never outside the
 * preprocess.
 *
 * `z.preprocess(f, inner).default(x)` looks equivalent and is not: `ZodDefault`
 * substitutes only when its own input is `undefined`, and the input here is the
 * empty string, so the effect runs, hands `undefined` to a required inner schema,
 * and the whole thing fails with "Required" for a variable the reader did set --
 * to nothing. `SMTP_USER=` in a `.env` is the normal spelling of "no user", and
 * refusing to boot over it is the wrong answer.
 */
const numberIn = (min: number, max: number): z.ZodNumber =>
  z
    .number({ invalid_type_error: 'must be a number' })
    .int('must be a whole number')
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`);

const stringIn = (min: number, max: number): z.ZodString =>
  z.string().min(min, `must be at least ${min} characters`).max(max);

const integer = (min: number, max: number, fallback: number): z.ZodType<number> =>
  z.preprocess(toNumber, numberIn(min, max).default(fallback)) as z.ZodType<number>;

const optionalInteger = (min: number, max: number): z.ZodType<number | undefined> =>
  z.preprocess(toNumber, numberIn(min, max).optional()) as z.ZodType<number | undefined>;

const text = (min: number, max: number, fallback: string): z.ZodType<string> =>
  z.preprocess(blankToUndefined, stringIn(min, max).default(fallback)) as z.ZodType<string>;

const requiredText = (min: number, max: number): z.ZodType<string> =>
  z.preprocess(blankToUndefined, stringIn(min, max)) as z.ZodType<string>;

const optionalText = (min: number, max: number): z.ZodType<string | undefined> =>
  z.preprocess(blankToUndefined, stringIn(min, max).optional()) as z.ZodType<string | undefined>;

/**
 * A flag, parsed by hand rather than with `z.coerce.boolean()`.
 *
 * `Boolean('false')` is `true`, so `z.coerce.boolean()` reads `SMTP_SECURE=false`
 * as "use TLS" and the connection fails against a plaintext relay with an error
 * about the handshake, which names nothing useful. Only the four spellings a
 * person actually writes are accepted, and anything else is a config error rather
 * than a silent `true`.
 */
const flag = (fallback: boolean): z.ZodType<boolean> =>
  z.preprocess(
    (value) => {
      if (blankToUndefined(value) === undefined) return fallback;
      const normalised = String(value).trim().toLowerCase();
      if (normalised === 'true' || normalised === '1') return true;
      if (normalised === 'false' || normalised === '0') return false;
      return normalised;
    },
    z.boolean({ invalid_type_error: 'must be true or false' }),
  ) as z.ZodType<boolean>;

const schema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),

  // `PORT` wins over `API_PORT` when both are set: it is the name every container
  // runtime injects, and a deployment that cannot override the port without
  // editing the app's own variable is a deployment that does not fit its host.
  API_PORT: integer(1, 65_535, 4000),
  PORT: optionalInteger(1, 65_535),

  APP_VERSION: text(1, 60, PACKAGE_VERSION),

  DATABASE_URL: requiredText(1, 2000),
  REDIS_URL: requiredText(1, 2000),

  // Sixteen characters is the floor because the token this signs is the only
  // thing standing between a request and somebody's whole ledger. Shorter is
  // brute-forceable offline from a single captured token.
  AUTH_SECRET: requiredText(16, 512),
  APP_BASE_URL: text(1, 500, 'http://localhost:3000'),

  DEFAULT_CURRENCY: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(/^[A-Z]{3}$/, 'must be a three-letter ISO 4217 code')
      .default('EUR'),
  ),
  DEFAULT_LOCALE: text(2, 35, 'es-ES'),

  // The ceiling is 64 MB rather than unbounded: multer buffers the upload in
  // memory, so this number is also the amount of heap one request can claim.
  MAX_IMPORT_BYTES: integer(1_024, 67_108_864, 8_388_608),
  IMPORT_ROOT: text(1, 500, './var/imports'),
  DUPLICATE_WINDOW_DAYS: integer(0, 365, 3),

  REPORT_CACHE_TTL_SECONDS: integer(1, 86_400, 900),

  // Validated by `thresholdToBasisPoints`, which owns the (0, 1] rule and the
  // rounding. Kept as a string here so its error message is the one the reader
  // gets rather than zod's.
  BUDGET_ALERT_THRESHOLD: optionalText(1, 20),

  SMTP_HOST: optionalText(1, 255),
  SMTP_PORT: optionalInteger(1, 65_535),
  SMTP_SECURE: flag(false),
  SMTP_USER: optionalText(1, 255),
  SMTP_PASSWORD: optionalText(1, 512),
  MAIL_FROM: text(1, 320, 'alerts@finance.local'),

  RATE_LIMIT_GLOBAL: integer(1, 100_000, 120),
  RATE_LIMIT_AUTH: integer(1, 100_000, 5),
  RATE_LIMIT_IMPORT: integer(1, 100_000, 10),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Spelled out one name per line on purpose. This literal is the only place the
  // environment is read, and `scripts/env-contract.mjs` reads it back to check
  // that every name here is declared in `turbo.json`.
  const raw = {
    NODE_ENV: env.NODE_ENV,
    API_PORT: env.API_PORT,
    PORT: env.PORT,
    APP_VERSION: env.APP_VERSION,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    AUTH_SECRET: env.AUTH_SECRET,
    APP_BASE_URL: env.APP_BASE_URL,
    DEFAULT_CURRENCY: env.DEFAULT_CURRENCY,
    DEFAULT_LOCALE: env.DEFAULT_LOCALE,
    MAX_IMPORT_BYTES: env.MAX_IMPORT_BYTES,
    IMPORT_ROOT: env.IMPORT_ROOT,
    DUPLICATE_WINDOW_DAYS: env.DUPLICATE_WINDOW_DAYS,
    REPORT_CACHE_TTL_SECONDS: env.REPORT_CACHE_TTL_SECONDS,
    BUDGET_ALERT_THRESHOLD: env.BUDGET_ALERT_THRESHOLD,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASSWORD: env.SMTP_PASSWORD,
    MAIL_FROM: env.MAIL_FROM,
    RATE_LIMIT_GLOBAL: env.RATE_LIMIT_GLOBAL,
    RATE_LIMIT_AUTH: env.RATE_LIMIT_AUTH,
    RATE_LIMIT_IMPORT: env.RATE_LIMIT_IMPORT,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`,
    );
    throw new ConfigError(
      `The API cannot start: ${problems.join('; ')}. See .env.example for what each name means.`,
    );
  }

  const values = parsed.data;

  // Outside the zod schema because it has its own error message, which names the
  // variable and states the allowed range in the units a person wrote it in.
  let budgetAlertBasisPoints: number;
  try {
    budgetAlertBasisPoints = thresholdToBasisPoints(values.BUDGET_ALERT_THRESHOLD);
  } catch (error) {
    throw new ConfigError(
      `The API cannot start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT ?? values.API_PORT,
    version: values.APP_VERSION,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    authSecret: values.AUTH_SECRET,
    appBaseUrl: values.APP_BASE_URL,
    defaultCurrency: values.DEFAULT_CURRENCY,
    defaultLocale: values.DEFAULT_LOCALE,
    maxImportBytes: values.MAX_IMPORT_BYTES,
    importRoot: values.IMPORT_ROOT,
    duplicateWindowDays: values.DUPLICATE_WINDOW_DAYS,
    reportCacheTtlSeconds: values.REPORT_CACHE_TTL_SECONDS,
    budgetAlertBasisPoints,
    smtp: {
      host: values.SMTP_HOST,
      port: values.SMTP_PORT,
      secure: values.SMTP_SECURE,
      user: values.SMTP_USER,
      password: values.SMTP_PASSWORD,
      from: values.MAIL_FROM,
    },
    rateLimits: {
      global: values.RATE_LIMIT_GLOBAL,
      auth: values.RATE_LIMIT_AUTH,
      import: values.RATE_LIMIT_IMPORT,
    },
  };
}
