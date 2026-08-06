/**
 * The read-through cache in front of the monthly report, and the one thing every
 * write in this API has to remember to call.
 *
 * `bump` is the whole reason this is a service rather than three lines inside
 * `ReportsService`: transactions, budgets, categories and the import commit all
 * change what a report says, and each of them lives in a different module. A
 * shared, named method is the only version of "invalidate the report" that a
 * reader can grep for and a reviewer can check.
 *
 * Every method degrades rather than throws. See `RedisService`: the cache holds a
 * copy of numbers that live in Postgres, so an unreachable Redis costs a slower
 * report and nothing else.
 */
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { reportKey, versionKey } from './report-cache';

/** What a lookup found, and under which version, so the writer can match it. */
export interface CacheProbe<T> {
  version: number;
  value: T | null;
}

@Injectable()
export class ReportCacheService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Read the version, then the payload, in that order.
   *
   * The order is the invariant. Reading the version *after* the database query
   * would let a write land in between and the answer would be stored under the
   * new version, which is exactly the stale entry the versioning exists to
   * prevent. The caller must pass this `version` back to `store`.
   */
  async probe<T>(userId: string, month: string, trailing: number): Promise<CacheProbe<T>> {
    const version = await this.redis.readCounter(versionKey(userId));
    const raw = await this.redis.get(reportKey(userId, version, month, trailing));
    if (raw === null) return { version, value: null };

    try {
      return { version, value: JSON.parse(raw) as T };
    } catch {
      // A corrupt entry is a miss, not an error. Nothing else writes this key, so
      // the realistic cause is a partial write during a Redis failover, and the
      // right answer is to recompute rather than to fail the request.
      return { version, value: null };
    }
  }

  /** Store under the version the read started at. Best effort. */
  async store(
    userId: string,
    month: string,
    trailing: number,
    version: number,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.setEx(
      reportKey(userId, version, month, trailing),
      JSON.stringify(value),
      ttlSeconds,
    );
  }

  /**
   * Invalidate every cached report for a user, in one round trip.
   *
   * Called **after** the database transaction commits. Bumping first would make
   * the window between the bump and the commit a window in which a reader
   * recomputes from a database that does not have the write yet and caches that
   * under the new version, which is the stale-entry bug with extra steps.
   */
  async bump(userId: string): Promise<void> {
    await this.redis.incr(versionKey(userId));
  }
}
