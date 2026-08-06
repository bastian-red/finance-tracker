import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, PACKAGE_VERSION } from './config';

/**
 * The minimum environment that boots the API. Everything else has a default, and
 * the tests below assert what those defaults are rather than trusting them.
 */
const MINIMAL: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://fin:fin@localhost:5436/fin?schema=public',
  REDIS_URL: 'redis://localhost:6383',
  AUTH_SECRET: 'sixteen-characters-at-least',
};

describe('loadConfig', () => {
  it('boots from the three required names and defaults the rest', () => {
    const config = loadConfig(MINIMAL);

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(4000);
    expect(config.version).toBe(PACKAGE_VERSION);
    expect(config.defaultCurrency).toBe('EUR');
    expect(config.defaultLocale).toBe('es-ES');
    expect(config.maxImportBytes).toBe(8_388_608);
    expect(config.importRoot).toBe('./var/imports');
    expect(config.duplicateWindowDays).toBe(3);
    expect(config.reportCacheTtlSeconds).toBe(900);
    expect(config.budgetAlertBasisPoints).toBe(8000);
    expect(config.rateLimits).toEqual({ global: 120, auth: 5, import: 10 });
  });

  it('reads the environment through the parameter, never through process.env', () => {
    // Proves the default parameter is a real seam. If the loader reached for
    // `process.env` anywhere, this fake would not be able to move the port.
    const config = loadConfig({ ...MINIMAL, API_PORT: '4321' });
    expect(config.port).toBe(4321);
  });

  it('lets PORT override API_PORT, because that is the name a container injects', () => {
    const config = loadConfig({ ...MINIMAL, API_PORT: '4000', PORT: '8080' });
    expect(config.port).toBe(8080);
  });

  it('falls back to API_PORT when PORT is present but empty', () => {
    // A container that exports PORT= (unset) must not knock the API onto a
    // default port that nothing is proxying to.
    const config = loadConfig({ ...MINIMAL, API_PORT: '4100', PORT: '' });
    expect(config.port).toBe(4100);
  });

  it('rejects a short AUTH_SECRET and names it', () => {
    expect(() => loadConfig({ ...MINIMAL, AUTH_SECRET: 'too-short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...MINIMAL, AUTH_SECRET: 'too-short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects a missing DATABASE_URL and names it', () => {
    const { DATABASE_URL: _omitted, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects a missing REDIS_URL and names it', () => {
    const { REDIS_URL: _omitted, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/REDIS_URL/);
  });

  it('rejects a non-numeric API_PORT and names it', () => {
    expect(() => loadConfig({ ...MINIMAL, API_PORT: 'four thousand' })).toThrow(/API_PORT/);
  });

  it('rejects a port outside the TCP range', () => {
    expect(() => loadConfig({ ...MINIMAL, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('rejects a currency that is not three upper-case letters', () => {
    expect(() => loadConfig({ ...MINIMAL, DEFAULT_CURRENCY: 'eur' })).toThrow(/DEFAULT_CURRENCY/);
  });

  it('reads SMTP_SECURE=false as false, which z.coerce.boolean() would not', () => {
    // `Boolean('false') === true`. Reading this variable with a coercion would
    // turn TLS on against a plaintext relay and fail during the handshake, with
    // an error that names neither the variable nor the cause.
    expect(loadConfig({ ...MINIMAL, SMTP_SECURE: 'false' }).smtp.secure).toBe(false);
    expect(loadConfig({ ...MINIMAL, SMTP_SECURE: '0' }).smtp.secure).toBe(false);
    expect(loadConfig({ ...MINIMAL, SMTP_SECURE: 'true' }).smtp.secure).toBe(true);
    expect(loadConfig({ ...MINIMAL, SMTP_SECURE: '1' }).smtp.secure).toBe(true);
    expect(loadConfig(MINIMAL).smtp.secure).toBe(false);
  });

  it('rejects an SMTP_SECURE spelling it cannot read rather than guessing', () => {
    expect(() => loadConfig({ ...MINIMAL, SMTP_SECURE: 'yes' })).toThrow(/SMTP_SECURE/);
  });

  it('leaves SMTP_HOST undefined when it is blank, which selects the log channel', () => {
    const config = loadConfig({ ...MINIMAL, SMTP_HOST: '', SMTP_USER: '' });
    expect(config.smtp.host).toBeUndefined();
    expect(config.smtp.user).toBeUndefined();
    expect(config.smtp.from).toBe('alerts@finance.local');
  });

  it('converts BUDGET_ALERT_THRESHOLD to basis points without going through a float', () => {
    expect(loadConfig({ ...MINIMAL, BUDGET_ALERT_THRESHOLD: '0.8' }).budgetAlertBasisPoints).toBe(
      8000,
    );
    expect(loadConfig({ ...MINIMAL, BUDGET_ALERT_THRESHOLD: '0.75' }).budgetAlertBasisPoints).toBe(
      7500,
    );
    expect(loadConfig({ ...MINIMAL, BUDGET_ALERT_THRESHOLD: '1' }).budgetAlertBasisPoints).toBe(
      10_000,
    );
  });

  it('rejects a threshold outside (0, 1] and names the variable', () => {
    expect(() => loadConfig({ ...MINIMAL, BUDGET_ALERT_THRESHOLD: '80' })).toThrow(
      /BUDGET_ALERT_THRESHOLD/,
    );
    expect(() => loadConfig({ ...MINIMAL, BUDGET_ALERT_THRESHOLD: '0' })).toThrow(
      /BUDGET_ALERT_THRESHOLD/,
    );
  });

  it('rejects an upload ceiling large enough to be a memory exhaustion knob', () => {
    // multer buffers the upload in memory, so MAX_IMPORT_BYTES is also the heap
    // one request can claim.
    expect(() => loadConfig({ ...MINIMAL, MAX_IMPORT_BYTES: '1073741824' })).toThrow(
      /MAX_IMPORT_BYTES/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadConfig({ ...MINIMAL, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every broken variable at once rather than the first one', () => {
    // A boot that fails one variable at a time costs a restart per mistake.
    const message = (() => {
      try {
        loadConfig({ ...MINIMAL, AUTH_SECRET: 'short', API_PORT: 'nope' });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    })();

    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).toMatch(/API_PORT/);
  });
});
