/**
 * Proves: two budgets for one category can never cover the same month, and the
 * thing that guarantees it is `budgets_no_overlapping_periods` -- a GiST EXCLUDE
 * constraint Postgres evaluates atomically -- not a `findFirst` in the service.
 *
 * What would ship broken without it: `BudgetsService.create` has no pre-flight
 * overlap check at all, so if the constraint were dropped by a migration every
 * double-clicked Save would store a second budget for the same months. Nothing
 * would error. "The groceries budget for March" would then have two answers, and
 * which one the reader sees would depend on which query's row order they hit:
 * the dashboard would draw one limit while the alert mailer used the other.
 *
 * The second half of the file is about the recovery path. A constraint violation
 * aborts the whole Postgres transaction (`25P02`), so the follow-up "which
 * budget did I collide with" query is only legal because the write was not
 * wrapped in `$transaction`. That is what turns a bare 409 into a sentence
 * naming the period, and it is the assertion below on the message text.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { BUDGET_NO_OVERLAP } from '@fin/db';
import {
  boot,
  constraintKind,
  dropUser,
  makeUser,
  type Harness,
  type ScratchUser,
} from './harness';

let harness: Harness;
let user: ScratchUser;
let groceries: string;

beforeAll(async () => {
  harness = await boot();
  user = await makeUser(harness, 'budget-overlap');
  groceries = user.categories.get('Groceries') as string;
});

afterAll(async () => {
  await dropUser(harness, user);
  await harness.close();
});

/** A fresh slate between cases: these all write to the same (user, category). */
async function clearBudgets(): Promise<void> {
  await harness.prisma.budget.deleteMany({ where: { userId: user.id } });
}

const post = (body: unknown) =>
  harness.http.post('/budgets').set('Authorization', user.token).send(body);

describe('the constraint itself', () => {
  it('is declared, and is an exclusion constraint rather than a unique index', async () => {
    // `x` is `pg_constraint.contype` for EXCLUDE. A unique index would be `u`,
    // and would only catch two budgets with identical bounds -- 2026-01..2026-06
    // and 2026-03..2026-09 would both be stored, which is the whole bug.
    expect(await constraintKind(harness.prisma, BUDGET_NO_OVERLAP)).toBe('x');
  });

  it('refuses an overlapping row written straight to Postgres, with no service in the way', async () => {
    await clearBudgets();
    const first = await harness.prisma.budget.create({
      data: {
        userId: user.id,
        categoryId: groceries,
        limitMinor: 40_000,
        effectiveFrom: new Date('2030-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2030-06-01T00:00:00.000Z'),
      },
    });

    // June is the overlap: `daterange(from, to, '[]')` is inclusive at both ends,
    // and `effective_to` holds the first day of the *last* month covered.
    const overlapping = harness.prisma.budget.create({
      data: {
        userId: user.id,
        categoryId: groceries,
        limitMinor: 10_000,
        effectiveFrom: new Date('2030-06-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    });

    await expect(overlapping).rejects.toThrow(BUDGET_NO_OVERLAP);
    expect(await harness.prisma.budget.count({ where: { userId: user.id } })).toBe(1);
    expect(first.limitMinor).toBe(40_000);
  });

  it('allows two budgets for the same category when the months do not touch', async () => {
    // The counter-test. A constraint that rejected everything would pass every
    // assertion above and make the feature unusable.
    await clearBudgets();
    await post({
      categoryId: groceries,
      limitMinor: 40_000,
      effectiveFrom: '2030-01',
      effectiveTo: '2030-06',
    }).expect(201);

    const next = await post({
      categoryId: groceries,
      limitMinor: 45_000,
      effectiveFrom: '2030-07',
      effectiveTo: null,
    }).expect(201);

    expect(next.body).toMatchObject({ effectiveFrom: '2030-07', effectiveTo: null });
    expect(await harness.prisma.budget.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe('POST /budgets under two simultaneous writers', () => {
  it('stores exactly one of eight identical requests and refuses the rest with a 409', async () => {
    await clearBudgets();

    // Eight rather than two: the race window between the first INSERT and its
    // COMMIT is microseconds, and one pair of requests can miss it and still
    // pass by ordering themselves. Eight in flight makes at least one genuinely
    // concurrent, and the assertion is the same either way -- the constraint is
    // what decides, not the arrival order.
    const attempts = Array.from({ length: 8 }, () =>
      post({
        categoryId: groceries,
        limitMinor: 40_000,
        effectiveFrom: '2030-01',
        effectiveTo: null,
      }),
    );
    const responses = await Promise.all(attempts);

    const created = responses.filter((response) => response.status === 201);
    const conflicted = responses.filter((response) => response.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);
    // The database is the authority on this, not the count of 201s.
    expect(await harness.prisma.budget.count({ where: { userId: user.id } })).toBe(1);

    for (const response of conflicted) {
      // Every loser gets the sentence, not just the first one, and the sentence
      // names the period. The follow-up query that produces it runs on the same
      // connection right after the failed write, which is only possible because
      // the write was never inside a transaction.
      expect(response.body.message).toContain('2030-01 onwards');
      expect(response.body.message).toContain('overlaps');
      expect(response.body.message).toContain('pick a range that starts after it ends');
    }
  });

  it('names the period of the budget it actually collided with, not the one that was sent', async () => {
    await clearBudgets();
    await post({
      categoryId: groceries,
      limitMinor: 40_000,
      effectiveFrom: '2030-01',
      effectiveTo: '2030-06',
    }).expect(201);

    const clash = await post({
      categoryId: groceries,
      limitMinor: 12_000,
      effectiveFrom: '2030-06',
      effectiveTo: '2030-12',
    }).expect(409);

    // "2030-01 to 2030-06" is the stored budget; "2030-06 to 2030-12" is the
    // rejected request. Both are in the sentence, in that order, so the reader
    // can see which month is the problem without opening the budgets screen.
    expect(clash.body.message).toContain('already covers 2030-01 to 2030-06');
    expect(clash.body.message).toContain('overlaps 2030-06 to 2030-12');
    expect(await harness.prisma.budget.count({ where: { userId: user.id } })).toBe(1);
  });

  it('reports the conflict on an update as well as on a create', async () => {
    await clearBudgets();
    const january = await post({
      categoryId: groceries,
      limitMinor: 40_000,
      effectiveFrom: '2030-01',
      effectiveTo: '2030-06',
    }).expect(201);
    const july = await post({
      categoryId: groceries,
      limitMinor: 45_000,
      effectiveFrom: '2030-07',
      effectiveTo: null,
    }).expect(201);

    // Dragging the second budget's start back one month into the first one's
    // range. `excludeId` keeps the row from being reported as its own clash.
    const response = await harness.http
      .put(`/budgets/${july.body.id}`)
      .set('Authorization', user.token)
      .send({
        categoryId: groceries,
        limitMinor: 45_000,
        effectiveFrom: '2030-06',
        effectiveTo: null,
      })
      .expect(409);

    expect(response.body.message).toContain('already covers 2030-01 to 2030-06');

    const stored = await harness.prisma.budget.findUniqueOrThrow({ where: { id: july.body.id } });
    expect(stored.effectiveFrom.toISOString().slice(0, 10)).toBe('2030-07-01');
    expect(january.body.effectiveTo).toBe('2030-06');
  });
});
