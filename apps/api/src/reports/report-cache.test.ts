import { describe, expect, it } from 'vitest';
import { reportKey, versionKey } from './report-cache';

/**
 * Pins the key scheme that makes the report cache safe under a write that lands
 * mid-read. No Redis here: the whole scheme is string arithmetic, which is why
 * it is testable at all. `report-cache.service.ts` needs a connection and lives
 * in the integration lane.
 *
 * The race the version number closes:
 *
 *   reader   GET  key -> miss
 *   reader   SELECT ... (slow: a month of rollups)
 *   writer   INSERT transaction; COMMIT
 *   writer   DEL  key            <- deletes a key that does not exist yet
 *   reader   SET  key = numbers computed *before* the write
 *
 * With `DEL` invalidation the cache now holds pre-write numbers behind a full
 * TTL, the dashboard is missing a transaction the user just entered, and
 * refreshing does not fix it. There is no ordering of `DEL` and `SET` that
 * closes the window, because the reader's `SET` is unconditional and happens
 * last. The reader reads the version before it queries and writes under that
 * version; the writer bumps the version after its commit; the stale entry is
 * written to a key nobody will look for again.
 *
 * Every property below is about which inputs must change the key. Anything that
 * changes the answer and not the key is a wrong number served from cache.
 */

const USER = 'usr_1';

describe('versionKey', () => {
  it('is one counter per user', () => {
    // Writes are per user and so are reports, so a global counter would flush
    // every user's cache on every write in the system.
    expect(versionKey(USER)).toBe('report:ver:usr_1');
    expect(versionKey('usr_2')).not.toBe(versionKey(USER));
  });

  it('is stable, because it is an INCR target', () => {
    expect(versionKey(USER)).toBe(versionKey(USER));
  });

  it('sits in a namespace the payload keys cannot collide with', () => {
    // `INCR` against a key holding a JSON document is an error, and a version
    // counter overwritten by a payload is a cache that never invalidates again.
    expect(versionKey(USER).startsWith('report:ver:')).toBe(true);
    expect(reportKey(USER, 1, '2026-03', 12).startsWith('report:ver:')).toBe(false);
  });
});

describe('reportKey', () => {
  it('carries the user, the version, the month and the window', () => {
    expect(reportKey(USER, 7, '2026-03', 12)).toBe('report:usr_1:v7:2026-03:t12');
  });

  it('sends a read after a write to a different key than the write raced', () => {
    // The whole point. The reader that lost the race wrote to v7; every read
    // after the writer's INCR looks for v8, does not find it, and the stale
    // entry expires on its own without anybody having to delete it.
    expect(reportKey(USER, 7, '2026-03', 12)).not.toBe(reportKey(USER, 8, '2026-03', 12));
  });

  it('separates two users asking for the same month', () => {
    // A shared key here is one person's ledger rendered on another person's
    // dashboard, which is the worst bug this app could have.
    expect(reportKey('usr_1', 1, '2026-03', 12)).not.toBe(reportKey('usr_2', 1, '2026-03', 12));
  });

  it('separates two months', () => {
    expect(reportKey(USER, 1, '2026-03', 12)).not.toBe(reportKey(USER, 1, '2026-02', 12));
  });

  it('separates two trend windows, because they are different documents', () => {
    // A twelve-month trend and a thirty-six-month one answer different
    // questions. Serving one for the other is a chart quietly showing the wrong
    // window with no error anywhere.
    expect(reportKey(USER, 1, '2026-03', 12)).not.toBe(reportKey(USER, 1, '2026-03', 36));
  });

  it('keeps the version and the window apart, so no two inputs can spell one key', () => {
    // `v` and `t` are prefixes rather than decoration: without them
    // `...:1:2026-03:12` and a different split of the same digits would be the
    // same string.
    expect(reportKey(USER, 1, '2026-03', 12)).not.toBe(reportKey(USER, 12, '2026-03', 1));
  });

  it('is stable, so the reader and the writer agree on where the document lives', () => {
    expect(reportKey(USER, 3, '2026-03', 12)).toBe(reportKey(USER, 3, '2026-03', 12));
  });

  it('holds no character Redis treats specially in a pattern', () => {
    // `SCAN MATCH` and `KEYS` read `*`, `?` and `[` as glob syntax. A key
    // containing one cannot be found again by the operator debugging it.
    expect(reportKey(USER, 12, '2026-03', 36)).toMatch(/^[A-Za-z0-9:_-]+$/);
  });
});
