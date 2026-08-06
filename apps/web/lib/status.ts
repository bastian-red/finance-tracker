import type { Health } from '@fin/shared';
import { ApiError, ContractError } from './api';

/**
 * What the status page renders, decided as a pure function.
 *
 * The page itself is a server component: its fetch happens in the Next process,
 * where a Playwright route cannot reach it, so the interesting branch — the API
 * is down and the page has to render anyway — cannot be driven from a browser.
 * Pulling the decision out here is what makes it provable, and the alternative
 * was an E2E test that passed whether or not the branch existed.
 *
 * Three outcomes, and they are genuinely different to a reader:
 *
 * - **`ok`** — every dependency answered. `/health` returned 200.
 * - **`degraded`** — the API is running and told us something is wrong. That
 *   arrives as an `ApiError` with status 503, because `/health` sets the status
 *   code from its own verdict: the default configuration of every uptime checker
 *   on earth is "is it 2xx", so an endpoint that answered 200 with
 *   `"status":"degraded"` in the body is one whose alert nobody configured.
 * - **`unreachable`** — nothing answered at all. A `TypeError` out of `fetch`, a
 *   refused connection, a timeout.
 *
 * The difference between the last two is the whole value of the page. "Redis is
 * down" and "the API is down" send an operator to two different places, and
 * collapsing them into "something is wrong" wastes the trip.
 */
export type StatusView =
  | { kind: 'ok'; health: Health }
  | { kind: 'degraded'; health: Health | null; message: string }
  | { kind: 'unreachable'; message: string };

/** The shape `/health` puts in a 503 body. Parsed defensively: it is an error path. */
function healthFrom(body: unknown): Health | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = body as Partial<Health>;
  return Array.isArray(candidate.checks) && typeof candidate.status === 'string'
    ? (candidate as Health)
    : null;
}

/** A successful read. `/health` only answers 200 when every check passed. */
export function viewOfHealth(health: Health): StatusView {
  return health.status === 'ok'
    ? { kind: 'ok', health }
    : {
        // Belt and braces: the endpoint sets 503 for this, so it should have
        // thrown before reaching here. If it ever answers 200 with a degraded
        // body, the page still tells the truth rather than painting it green.
        kind: 'degraded',
        health,
        message: 'The API reports a dependency it could not reach.',
      };
}

/**
 * A failed read, classified.
 *
 * A `ContractError` counts as degraded rather than unreachable: something
 * answered, and what it said did not match the shared contract. That is a
 * deployment skew between the two sides, and it is worth naming as itself.
 */
export function viewOfFailure(error: unknown): StatusView {
  if (error instanceof ApiError) {
    return {
      kind: 'degraded',
      health: healthFrom(error.body),
      message: error.message,
    };
  }
  if (error instanceof ContractError) {
    return {
      kind: 'degraded',
      health: null,
      message:
        'The API answered with something this page could not read. The two sides are running ' +
        'different versions of the shared contract.',
    };
  }
  return {
    kind: 'unreachable',
    message: error instanceof Error ? error.message : 'The API did not answer.',
  };
}

/** `93012` seconds as `1d 1h 50m`. Integer division; no date arithmetic anywhere. */
export function uptimeLabel(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${whole % 60}s`;
}
