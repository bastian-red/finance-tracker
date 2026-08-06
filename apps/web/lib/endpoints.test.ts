import { describe, expect, it } from 'vitest';
import { endpoints } from './endpoints';

/**
 * The paths this app asks the API for.
 *
 * These are strings and not types, so nothing else in the repo can catch a typo
 * in one: a wrong path compiles, deploys, and answers 404 at request time from
 * inside a server component, where it surfaces as an error boundary rather than
 * as anything naming the URL. This file is the only check there is.
 *
 * The interesting property is the one every id-taking helper has to hold:
 * **ids are percent-encoded even though they are cuids.** "The id is always
 * URL-safe" is an assumption about a column that nothing in the contract
 * enforces, and the day it stops being true the failure is a path traversal or a
 * silently truncated segment, not a compile error.
 */

const HOSTILE = 'a/b?c=d#e f';

describe('collection paths', () => {
  it('are the plain REST plurals both sides agreed on', () => {
    expect(endpoints.accounts).toBe('/accounts');
    expect(endpoints.categories).toBe('/categories');
    expect(endpoints.rules).toBe('/rules');
    expect(endpoints.budgets).toBe('/budgets');
    expect(endpoints.imports).toBe('/imports');
    expect(endpoints.alerts).toBe('/alerts');
    expect(endpoints.health).toBe('/health');
  });

  it('carry the two anonymous endpoints under /auth', () => {
    // The only two calls that go out without a bearer token.
    expect(endpoints.login).toBe('/auth/login');
    expect(endpoints.signup).toBe('/auth/signup');
  });
});

describe('id segments', () => {
  const withId = [
    ['category', endpoints.category],
    ['rule', endpoints.rule],
    ['transaction', endpoints.transaction],
    ['budget', endpoints.budget],
    ['importById', endpoints.importById],
    ['importFormat', endpoints.importFormat],
    ['importCommit', endpoints.importCommit],
    ['alertRead', endpoints.alertRead],
  ] as const;

  it('build the obvious path for an ordinary cuid', () => {
    expect(endpoints.category('cat_123')).toBe('/categories/cat_123');
    expect(endpoints.rule('rul_123')).toBe('/rules/rul_123');
    expect(endpoints.transaction('txn_123')).toBe('/transactions/txn_123');
    expect(endpoints.budget('bud_123')).toBe('/budgets/bud_123');
    expect(endpoints.importById('imp_123')).toBe('/imports/imp_123');
    expect(endpoints.importFormat('imp_123')).toBe('/imports/imp_123/format');
    expect(endpoints.importCommit('imp_123')).toBe('/imports/imp_123/commit');
    expect(endpoints.alertRead('alr_123')).toBe('/alerts/alr_123/read');
  });

  it('percent-encode every id, so no id can invent a path or a query', () => {
    for (const [name, build] of withId) {
      const path = build(HOSTILE);
      // The separators the id contained must be gone: a raw `/` adds a segment,
      // a raw `?` starts a query string that the API then parses as its own.
      expect(path.replace(/^\/[a-z]+\//, ''), name).not.toContain('?');
      expect(
        path.replace(/^\/[a-z]+\//, '').replace(/\/(format|commit|read)$/, ''),
        name,
      ).not.toContain('/');
      expect(path, name).not.toContain(' ');
      expect(path, name).toContain(encodeURIComponent(HOSTILE));
    }
  });

  it('keeps the verb segment outside the encoded id', () => {
    // `/imports/<id>/commit`, never `/imports/<id>%2Fcommit`. The two sub-verb
    // routes are the only place this could go wrong.
    expect(endpoints.importCommit(HOSTILE).endsWith('/commit')).toBe(true);
    expect(endpoints.importFormat(HOSTILE).endsWith('/format')).toBe(true);
    expect(endpoints.alertRead(HOSTILE).endsWith('/read')).toBe(true);
  });
});

describe('query-bearing paths', () => {
  it('omit the query entirely when there is nothing to ask', () => {
    // Not a bare `?`. Next's Data Cache and the API's own logs are both keyed on
    // the URL, and `/transactions?` and `/transactions` are two of them.
    expect(endpoints.transactions()).toBe('/transactions');
    expect(endpoints.monthlyReport({})).toBe('/reports/monthly');
  });

  it('threads a prebuilt transaction query through untouched', () => {
    expect(endpoints.transactions('?limit=50')).toBe('/transactions?limit=50');
  });

  it('builds the budget status path with its month', () => {
    expect(endpoints.budgetStatus('2026-07')).toBe('/budgets/status?month=2026-07');
  });

  it('builds the monthly report path with only the parameters that were given', () => {
    expect(endpoints.monthlyReport({ month: '2026-07' })).toBe('/reports/monthly?month=2026-07');
    expect(endpoints.monthlyReport({ trailing: 24 })).toBe('/reports/monthly?trailing=24');
    expect(endpoints.monthlyReport({ month: '2026-07', trailing: 6 })).toBe(
      '/reports/monthly?month=2026-07&trailing=6',
    );
  });

  it('never emits a bare leading slash-less path', () => {
    // Everything here is concatenated onto a base URL, so a path missing its
    // leading slash silently resolves against the base's last segment.
    const all = [
      endpoints.transactions(),
      endpoints.budgetStatus('2026-07'),
      endpoints.monthlyReport({}),
      endpoints.category('cat_1'),
      endpoints.importCommit('imp_1'),
    ];
    for (const path of all) expect(path.startsWith('/'), path).toBe(true);
  });
});
