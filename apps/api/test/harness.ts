/**
 * What every file in this lane needs before it can assert anything: a booted
 * API, a signed service token, and a way back out of the database it just
 * touched.
 *
 * Three decisions here shape the whole lane.
 *
 * **The app is the real `AppModule`, with nothing overridden.** A test that
 * replaces `PrismaService` with a fake is asserting on the fake. The properties
 * this lane exists to prove -- an EXCLUDE constraint refusing a second budget, a
 * BEFORE trigger rejecting a currency, `SUM(int4)` arriving as a `bigint` -- are
 * properties of Postgres, and none of them survives being mocked.
 *
 * **Mutations go to a user this suite created.** The seeded demo ledger is 747
 * transactions and several files read it, so a file that writes into it changes
 * what the next one sees. `withUser` creates an account through the real signup
 * route (which plants the ten categories and their rules, so the categorisation
 * tests have something to categorise with) and deletes it afterwards; the
 * cascades take its accounts, transactions, budgets, rules and alerts with it.
 * Where a claim is specifically about the seeded ledger, the write is undone by
 * id and `expectSeededLedgerIntact` re-checks the count.
 *
 * **The token is minted here rather than fetched.** The API holds no session:
 * `apps/web` signs a short-lived HS256 token per server-side call and
 * `ServiceTokenGuard` verifies it against `AUTH_SECRET`. Minting one with the
 * same secret is exactly what the web app does, and it means these tests do not
 * depend on a login route to exercise a budget route.
 */
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';
import { expect } from 'vitest';
import type { SessionUser } from '@fin/shared';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

/** The account `packages/db/prisma/seed.ts` plants, and the size of its ledger. */
export const DEMO_EMAIL = 'demo@finance.local';
export const SEEDED_TRANSACTION_COUNT = 747;

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  redis: RedisService;
  /** Supertest bound to the booted server. Add the header with `bearer()`. */
  http: TestAgent;
  close: () => Promise<void>;
}

/**
 * Boot the whole API in-process, listening on an ephemeral port.
 *
 * **`listen(0)`, not `init()`, and the difference is the concurrency proof.**
 * Handed a server that is not listening, supertest starts one per request and
 * closes it when that response ends. With eight requests in flight against the
 * same server object -- which is exactly what `budget-overlap.integration.test.ts`
 * fires to race the exclusion constraint -- the first response to finish closes
 * the listener out from under the other seven, and they fail with
 * `read ECONNRESET`. It survived locally, where the requests were fast enough to
 * serialise, and failed on every CI run: a two-core runner overlaps them properly.
 *
 * Port 0 lets the kernel pick, so nothing is hardcoded and two files still cannot
 * collide. `app.close()` closes the listener with everything else.
 *
 * `PrismaService.onModuleInit` runs either way, so an unreachable database still
 * fails here with the message the process would print rather than inside the
 * first assertion.
 */
export async function boot(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);

  const prisma = app.get(PrismaService);
  const redis = app.get(RedisService);

  // `127.0.0.1` and not `localhost`: on a runner that resolves localhost to ::1
  // first, a server bound to the IPv4 wildcard is not there.
  const { port } = app.getHttpServer().address() as { port: number };

  return {
    app,
    prisma,
    redis,
    http: request(`http://127.0.0.1:${port}`),
    close: async () => {
      await app.close();
    },
  };
}

/** `Authorization` for a user, signed exactly the way `apps/web` signs it. */
export function bearer(user: { id: string; email: string }): string {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret === '') {
    throw new Error('AUTH_SECRET is not set; scripts/integration.sh is what supplies it.');
  }
  return `Bearer ${jwt.sign({ sub: user.id, email: user.email }, secret, {
    algorithm: 'HS256',
    expiresIn: '10m',
  })}`;
}

/** The seeded demo user, with the two accounts the ledger hangs off. */
export async function demo(prisma: PrismaService): Promise<{
  id: string;
  email: string;
  timeZone: string;
  checkingAccountId: string;
}> {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    throw new Error(`${DEMO_EMAIL} is missing; scripts/integration.sh seeds it before this runs.`);
  }
  const checking = await prisma.account.findFirst({
    where: { userId: user.id, kind: 'checking' },
    orderBy: { name: 'asc' },
  });
  if (!checking) throw new Error('The demo user has no checking account.');

  return {
    id: user.id,
    email: user.email,
    timeZone: user.timeZone,
    checkingAccountId: checking.id,
  };
}

export interface ScratchUser extends SessionUser {
  token: string;
  /** The `Main` account signup plants, and the ten seeded categories by name. */
  accountId: string;
  categories: Map<string, string>;
}

/**
 * A throwaway account, created through the signup route rather than by hand.
 *
 * Through the route because the taxonomy is the point: signup plants ten
 * categories and their keyword rules in one transaction, and the categorisation
 * and budget tests need both. Building the rows directly would be a second,
 * drifting copy of `auth/taxonomy.ts`.
 *
 * The address carries eight random hex characters so two runs of this lane, or a
 * run that died half way through the previous one, cannot collide on the unique
 * email index.
 */
export async function makeUser(
  harness: Harness,
  label: string,
  overrides: { timeZone?: string; locale?: string; currency?: string } = {},
): Promise<ScratchUser> {
  const email = `${label}-${randomBytes(4).toString('hex')}@integration.local`;

  const response = await harness.http
    .post('/auth/signup')
    .send({
      email,
      password: 'integration-lane-password',
      name: `Integration ${label}`,
      locale: overrides.locale ?? 'es-ES',
      timeZone: overrides.timeZone ?? 'Europe/Madrid',
      currency: overrides.currency ?? 'EUR',
    })
    .expect(201);

  const user = response.body as SessionUser;
  const account = await harness.prisma.account.findFirst({ where: { userId: user.id } });
  if (!account) throw new Error('Signup planted no account.');

  const categories = await harness.prisma.category.findMany({
    where: { userId: user.id },
    select: { id: true, name: true },
  });

  return {
    ...user,
    token: bearer(user),
    accountId: account.id,
    categories: new Map(categories.map((category) => [category.name, category.id])),
  };
}

/** Delete a throwaway account. The cascades take everything it owns. */
export async function dropUser(harness: Harness, user: { id: string }): Promise<void> {
  await harness.prisma.user.deleteMany({ where: { id: user.id } });
}

/**
 * The seeded ledger is still the size the seed left it.
 *
 * Called at the end of every file that writes into the demo user's rows. The
 * seed is idempotent, so re-running it is the repair; this is what tells you it
 * is needed rather than letting the next file fail on a number it did not move.
 */
export async function expectSeededLedgerIntact(prisma: PrismaService): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: DEMO_EMAIL } });
  const count = await prisma.transaction.count({ where: { userId: user.id } });
  expect(count).toBe(SEEDED_TRANSACTION_COUNT);
}

/** Does this constraint exist, and is it the kind of constraint we think it is? */
export async function constraintKind(
  prisma: PrismaService,
  name: string,
): Promise<string | undefined> {
  const rows = await prisma.$queryRaw<{ contype: string }[]>`
    SELECT contype::text AS contype FROM pg_constraint WHERE conname = ${name}
  `;
  return rows[0]?.contype;
}
