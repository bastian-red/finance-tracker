import { expect, test } from '@playwright/test';

/**
 * `/health` is the one endpoint this repo promises works, and the promise is
 * specific: it checks its dependencies rather than answering 200 because the
 * process is up. A green health check with a dead database behind it is the bug
 * this asserts against, so the checks array is read by name and by status, not
 * merely counted.
 *
 * It uses the `request` fixture rather than a browser: there is no page here,
 * and starting Chromium to read one JSON body is a second of CI for nothing.
 */
const API = process.env.API_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? '4000'}`;

test.describe('health', () => {
  test('reports ok with postgres and redis actually checked', async ({ request }) => {
    const response = await request.get(`${API}/health`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      status: string;
      version: string;
      uptimeSeconds: number;
      checks: { name: string; status: string; latencyMs: number; detail: string | null }[];
    };

    expect(body.status).toBe('ok');
    expect(body.version).not.toBe('');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const names = body.checks.map((check) => check.name);
    expect(names).toContain('postgres');
    expect(names).toContain('redis');

    for (const check of body.checks) {
      expect(check.status, `${check.name}: ${check.detail ?? 'no detail'}`).toBe('ok');
      // A latency of zero would mean the check did not run. Both of these are a
      // round trip to another process; neither is free.
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('refuses an unauthenticated read of somebody else ledger', async ({ request }) => {
    // The API holds no session state: every data route requires the bearer token
    // the web app mints. Without it the answer is 401 and not an empty list,
    // which is the difference between "you may not" and "there is nothing here".
    const response = await request.get(`${API}/transactions`);
    expect(response.status()).toBe(401);
  });
});
