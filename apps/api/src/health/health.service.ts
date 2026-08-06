/**
 * A health check that actually checks.
 *
 * The failure mode this file exists to prevent is a `/health` that returns
 * `{"status":"ok"}` because the process is running, in front of a database that
 * has been unreachable for an hour. Every dependency the API cannot serve a
 * request without is exercised for real: a round trip to Postgres and a round
 * trip to Redis. A dependency that is only listed is a dependency that is not
 * checked.
 *
 * The two are not equal, and the status reflects that. Postgres down means no
 * route can answer, so the check fails and the endpoint answers 503. Redis down
 * means reports are computed instead of cached and rate limiting fails open, so
 * the check fails and the *service* is still degraded rather than dead -- but it
 * still answers 503, because "degraded" is the strongest word `healthSchema`
 * has and a monitor that sees 200 will not page anybody.
 *
 * Each check is timed and given its own `detail`, because "which one" is the
 * first question anybody asks and a bare boolean does not answer it.
 */
import type { Health } from '@fin/shared';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type Check = Health['checks'][number];

/** How long a single dependency probe may take before it is called a failure. */
const PROBE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  /**
   * When this process became able to serve traffic.
   *
   * Captured here rather than read from `process.uptime()`, which counts from
   * when Node started -- including the seconds spent connecting to Postgres and
   * compiling. The number a reader wants is "how long has this been up", and the
   * two differ by exactly the interval where it was not.
   */
  private readonly startedAt = Date.now();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async check(): Promise<Health> {
    // Concurrently: two sequential 2-second timeouts make a fully dead stack take
    // four seconds to report, and a health endpoint that is slow when things are
    // broken is the one that gets its timeout raised until it means nothing.
    const checks = await Promise.all([this.postgres(), this.redisCheck()]);

    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      version: this.config.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }

  private postgres(): Promise<Check> {
    // `SELECT 1` rather than a count: it proves the connection and the credentials
    // without its cost depending on how big the ledger has become.
    return timed('postgres', async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });
  }

  private redisCheck(): Promise<Check> {
    return timed('redis', async () => {
      const reply = await this.redis.ping();
      if (reply !== 'PONG') throw new Error(`PING answered ${JSON.stringify(reply)}`);
    });
  }
}

/**
 * Run one probe, time it, and never let it hang.
 *
 * The timeout is the load-bearing part. A TCP connection to a host that is
 * dropping packets does not fail, it waits for the OS default, which on Linux is
 * over two minutes. Without a bound, "the database is unreachable" presents as a
 * health endpoint that never answers, which every monitor reads as a timeout with
 * no detail rather than as a 503 naming the dependency.
 */
async function timed(name: string, probe: () => Promise<void>): Promise<Check> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not answer within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Without this the pending timer keeps the event loop alive for two seconds
    // after every successful check, which makes the process refuse to exit
    // promptly and makes the test lane hang at the end of the file.
    if (timer !== undefined) clearTimeout(timer);
  }
}
