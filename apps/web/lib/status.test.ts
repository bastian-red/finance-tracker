import type { Health } from '@fin/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, ContractError } from './api';
import { uptimeLabel, viewOfFailure, viewOfHealth } from './status';

/**
 * The three states a status page can be in, and why they are not two.
 *
 * "Redis is down" and "the API is down" send an operator to two different places.
 * Collapsing them into "something is wrong" wastes the trip, and it is the exact
 * shape of failure a status page exists to prevent, so the distinction is pinned
 * here rather than left to the page's markup.
 *
 * These live in `lib/` and not in an e2e spec on purpose. `/status` is a server
 * component: its fetch happens inside the Next process, where Playwright's
 * `page.route` cannot reach it, so the degraded and unreachable branches cannot
 * be driven from a browser at all. An e2e test that claimed to cover them would
 * pass whether or not they existed.
 */

const health = (patch: Partial<Health> = {}): Health => ({
  status: 'ok',
  version: '0.1.0',
  uptimeSeconds: 42,
  checks: [
    { name: 'postgres', status: 'ok', latencyMs: 3, detail: null },
    { name: 'redis', status: 'ok', latencyMs: 1, detail: null },
  ],
  ...patch,
});

describe('viewOfHealth', () => {
  it('is ok when every check passed', () => {
    const view = viewOfHealth(health());
    expect(view.kind).toBe('ok');
  });

  it('refuses to paint a degraded body green, even on a 200', () => {
    // `/health` sets 503 for this, so it should have thrown before reaching here.
    // If the endpoint ever regresses to answering 200 with a degraded body, the
    // page still tells the truth. That regression is not hypothetical: it is the
    // default shape of every health endpoint written without thinking about it.
    const degraded = health({
      status: 'degraded',
      checks: [{ name: 'redis', status: 'fail', latencyMs: 2000, detail: 'timeout' }],
    });
    const view = viewOfHealth(degraded);
    expect(view.kind).toBe('degraded');
  });
});

describe('viewOfFailure', () => {
  it('reads a 503 as degraded and keeps the checks the body carried', () => {
    // The normal path for "Redis is down": the API is up and said so, with the
    // per-check detail in the body. `lib/api.ts` keeps that body on the error,
    // which is the entire reason it does.
    const body = health({
      status: 'degraded',
      checks: [
        { name: 'postgres', status: 'ok', latencyMs: 4, detail: null },
        { name: 'redis', status: 'fail', latencyMs: 2000, detail: 'ECONNREFUSED' },
      ],
    });
    const view = viewOfFailure(new ApiError(503, 'Service Unavailable (/health)', body));

    expect(view.kind).toBe('degraded');
    if (view.kind !== 'degraded') return;
    // The detail survives, so the page can name redis rather than say "something".
    expect(view.health?.checks.map((check) => check.name)).toEqual(['postgres', 'redis']);
    expect(view.health?.checks[1]?.detail).toBe('ECONNREFUSED');
  });

  it('survives a 503 whose body is not a health payload', () => {
    // A proxy in front of the API answers 503 with HTML. There is still something
    // true to render: the API is degraded, and there are no per-check details.
    const view = viewOfFailure(new ApiError(503, 'Service Unavailable (/health)', '<html>'));
    expect(view.kind).toBe('degraded');
    if (view.kind !== 'degraded') return;
    expect(view.health).toBeNull();
  });

  it('reads a contract mismatch as degraded, not as unreachable', () => {
    // Something answered; what it said did not parse. That is a version skew
    // between the two sides, and it is worth naming as itself rather than as
    // "the API is down", which would be false.
    const view = viewOfFailure(
      new ContractError('/health', [
        {
          code: 'invalid_type',
          expected: 'array',
          received: 'undefined',
          path: ['checks'],
          message: 'Required',
        },
      ] as never),
    );
    expect(view.kind).toBe('degraded');
    if (view.kind !== 'degraded') return;
    expect(view.message).toContain('different versions');
  });

  it('reads a refused connection as unreachable, with the error own words', () => {
    // What `fetch` throws when nothing is listening. The distinction from the
    // case above is the whole point of the page.
    const view = viewOfFailure(new TypeError('fetch failed'));
    expect(view.kind).toBe('unreachable');
    if (view.kind !== 'unreachable') return;
    expect(view.message).toBe('fetch failed');
  });

  it('survives a thrown non-Error rather than rendering undefined', () => {
    const view = viewOfFailure('boom');
    expect(view.kind).toBe('unreachable');
    if (view.kind !== 'unreachable') return;
    expect(view.message).toBe('The API did not answer.');
    expect(view.message).not.toContain('undefined');
  });

  it('never classifies a real failure as ok', () => {
    // The property the page depends on, stated directly: nothing that arrives at
    // this function can produce a green page.
    for (const thrown of [
      new ApiError(503, 'down'),
      new ApiError(500, 'boom'),
      new ContractError('/health', [] as never),
      new TypeError('fetch failed'),
      'boom',
      undefined,
    ]) {
      expect(viewOfFailure(thrown).kind, String(thrown)).not.toBe('ok');
    }
  });
});

describe('uptimeLabel', () => {
  it('reads as a duration a person would say out loud', () => {
    expect(uptimeLabel(12)).toBe('0m 12s');
    expect(uptimeLabel(184)).toBe('3m 4s');
    expect(uptimeLabel(3665)).toBe('1h 1m');
    expect(uptimeLabel(93_012)).toBe('1d 1h 50m');
  });

  it('is integer arithmetic, so no unit is ever fractional', () => {
    expect(uptimeLabel(59.9)).toBe('0m 59s');
    expect(uptimeLabel(3599.99)).toBe('59m 59s');
  });

  it('does not render a negative or a NaN uptime', () => {
    // `process.uptime()` cannot go backwards, but the number crosses a wire and
    // a clock, and "-1m -3s" on a status page is worse than a zero.
    expect(uptimeLabel(-5)).toBe('0m 0s');
    expect(uptimeLabel(Number.NaN)).toBe('0m 0s');
  });
});
