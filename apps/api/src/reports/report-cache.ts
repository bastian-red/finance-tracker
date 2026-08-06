/**
 * Cache keys for the monthly report, and the reason there is a version number in
 * them.
 *
 * The obvious design is `DEL report:{user}:{month}` on every write. It is wrong,
 * and it is wrong in a way that only shows up under the load that makes it
 * matter:
 *
 *   reader   GET  key -> miss
 *   reader   SELECT ... (slow: a month of rollups)
 *   writer   INSERT transaction; COMMIT
 *   writer   DEL  key            <- deletes a key that does not exist yet
 *   reader   SET  key = numbers computed *before* the write
 *
 * The cache now holds pre-write numbers with a full TTL in front of them, and
 * nothing will delete them again until the next write. The dashboard shows a
 * total that is missing a transaction the user just entered, and refreshing does
 * not fix it. There is no ordering of `DEL` and `SET` that closes that window,
 * because the reader's `SET` is unconditional and it happens last.
 *
 * A version counter closes it structurally. The reader reads the version
 * **before** it queries Postgres and writes its answer under that version; the
 * writer bumps the version **after** its commit. In the race above the reader
 * writes to `...:v7:...` while every subsequent read looks for `...:v8:...`, so
 * the stale entry is not found, not deleted, and expires on its own. It is also
 * O(1) regardless of how many months a write touches, where `DEL` would have to
 * enumerate every cached window that contains the affected month.
 *
 * Pure string functions, so the whole scheme is a gate test with no Redis in it.
 */

/** `INCR` target. One counter per user: writes are per-user, and so are reports. */
export function versionKey(userId: string): string {
  return `report:ver:${userId}`;
}

/**
 * The payload key.
 *
 * `trailing` is in the key because it changes the answer: a twelve-month trend
 * and a thirty-six-month trend are different documents, and serving one for the
 * other is a chart that silently shows the wrong window.
 */
export function reportKey(
  userId: string,
  version: number,
  month: string,
  trailing: number,
): string {
  return `report:${userId}:v${version}:${month}:t${trailing}`;
}
