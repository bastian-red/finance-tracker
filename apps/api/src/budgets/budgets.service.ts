/**
 * Budget CRUD, and the one Postgres behaviour that decides the shape of this
 * whole file.
 *
 * Two budgets for one category may never cover the same month. That is enforced
 * by a GiST `EXCLUDE` constraint rather than by a `findFirst` before the insert,
 * because two browser tabs both pass a `findFirst` and both insert -- which is
 * not an exotic race, it is what happens when somebody double-clicks Save.
 *
 * The constraint fires as SQLSTATE `23P01`, and **a constraint violation aborts
 * the entire Postgres transaction** (`25P02`). Catching the error in TypeScript
 * does not un-abort it: every subsequent statement in that transaction fails with
 * "current transaction is aborted, commands ignored until end of transaction
 * block", which is an error message about the recovery code rather than about the
 * conflict, and it is thrown a long way from the write that caused it.
 *
 * So the budget write is its **own statement**, never wrapped in `$transaction`.
 * That is what makes the recovery below legal: after the 23P01 we run another
 * query, on the same connection, to find out *which* budget collided, and turn
 * that into a sentence the user can act on. Inside a transaction that follow-up
 * query is the 25P02. (A `SAVEPOINT` around the write is the other correct
 * answer, and is what would be needed if the budget write ever had to be atomic
 * with something else. It does not.)
 */
import {
  firstDayOfMonth,
  month as parseMonth,
  type Budget,
  type CalendarMonth,
  type CreateBudget,
} from '@fin/shared';
import { BUDGET_NO_OVERLAP, isExclusionViolation, isNotFound } from '@fin/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCacheService } from '../reports/report-cache.service';

/** A stored `date` read back as the month it is the first day of. */
function monthOfDate(value: Date): CalendarMonth {
  return parseMonth(value.toISOString().slice(0, 7));
}

/** The first day of a month, as the UTC midnight `Date` a `date` column wants. */
function dayOfMonth(value: CalendarMonth): Date {
  return new Date(`${firstDayOfMonth(value)}T00:00:00.000Z`);
}

interface BudgetRow {
  id: string;
  categoryId: string;
  limitMinor: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export function budgetOf(row: BudgetRow): Budget {
  return {
    id: row.id,
    categoryId: row.categoryId,
    limitMinor: row.limitMinor,
    effectiveFrom: monthOfDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo === null ? null : monthOfDate(row.effectiveTo),
  };
}

@Injectable()
export class BudgetsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReportCacheService) private readonly cache: ReportCacheService,
  ) {}

  async list(userId: string): Promise<Budget[]> {
    const rows = await this.prisma.budget.findMany({
      where: { userId },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
    });
    return rows.map(budgetOf);
  }

  async create(userId: string, input: CreateBudget): Promise<Budget> {
    // The contract validates the *shape* `YYYY-MM` and hands back a plain
    // string; `parseMonth` is what turns it into the branded `CalendarMonth`
    // the rest of the app passes around. Branding at the boundary, once, is why
    // no function below this line has to re-check the format.
    const effectiveFrom = parseMonth(input.effectiveFrom);
    const effectiveTo = input.effectiveTo == null ? null : parseMonth(input.effectiveTo);
    await this.assertOwnsCategory(userId, input.categoryId);

    const row = await this.write(userId, input.categoryId, effectiveFrom, effectiveTo, null, () =>
      this.prisma.budget.create({
        data: {
          userId,
          categoryId: input.categoryId,
          limitMinor: input.limitMinor,
          effectiveFrom: dayOfMonth(effectiveFrom),
          effectiveTo: effectiveTo === null ? null : dayOfMonth(effectiveTo),
        },
      }),
    );

    // After the commit. A budget change moves every `budgets` entry in the
    // monthly report, so the cached copy of that report is now wrong.
    await this.cache.bump(userId);
    return budgetOf(row);
  }

  async update(userId: string, id: string, input: CreateBudget): Promise<Budget> {
    const existing = await this.prisma.budget.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such budget.');
    await this.assertOwnsCategory(userId, input.categoryId);

    const effectiveFrom = parseMonth(input.effectiveFrom);
    const effectiveTo = input.effectiveTo == null ? null : parseMonth(input.effectiveTo);
    const row = await this.write(userId, input.categoryId, effectiveFrom, effectiveTo, id, () =>
      this.prisma.budget.update({
        where: { id },
        data: {
          categoryId: input.categoryId,
          limitMinor: input.limitMinor,
          effectiveFrom: dayOfMonth(effectiveFrom),
          effectiveTo: effectiveTo === null ? null : dayOfMonth(effectiveTo),
        },
      }),
    );

    await this.cache.bump(userId);
    return budgetOf(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    try {
      // `deleteMany` scoped by user rather than `delete` by id: a delete by
      // primary key alone would remove another user's budget for anyone who can
      // guess a cuid, and the tenancy check has to be in the same statement as
      // the write or it is a race.
      const result = await this.prisma.budget.deleteMany({ where: { id, userId } });
      if (result.count === 0) throw new NotFoundException('No such budget.');
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundException('No such budget.');
      throw error;
    }
    await this.cache.bump(userId);
  }

  /**
   * Run the write, and turn an exclusion violation into a sentence.
   *
   * The follow-up `findFirst` is the whole point, and it is only possible because
   * the write above was not inside a transaction. See the file header.
   */
  private async write(
    userId: string,
    categoryId: string,
    from: CalendarMonth,
    to: CalendarMonth | null,
    excludeId: string | null,
    run: () => Promise<BudgetRow>,
  ): Promise<BudgetRow> {
    try {
      return await run();
    } catch (error) {
      if (!isExclusionViolation(error, BUDGET_NO_OVERLAP)) throw error;

      const clash = await this.findOverlap(userId, categoryId, from, to, excludeId);
      const period =
        clash === null
          ? 'that period'
          : clash.effectiveTo === null
            ? `${monthOfDate(clash.effectiveFrom)} onwards`
            : `${monthOfDate(clash.effectiveFrom)} to ${monthOfDate(clash.effectiveTo)}`;

      throw new ConflictException(
        `Another budget for this category already covers ${period}, which overlaps ` +
          `${to === null ? `${from} onwards` : `${from} to ${to}`}. ` +
          'Close the existing budget first, or pick a range that starts after it ends.',
      );
    }
  }

  private findOverlap(
    userId: string,
    categoryId: string,
    from: CalendarMonth,
    to: CalendarMonth | null,
    excludeId: string | null,
  ): Promise<BudgetRow | null> {
    return this.prisma.budget.findFirst({
      where: {
        userId,
        categoryId,
        ...(excludeId === null ? {} : { id: { not: excludeId } }),
        // An open-ended new budget has no upper bound to test against, so the
        // clause is dropped rather than given a sentinel date.
        ...(to === null ? {} : { effectiveFrom: { lte: dayOfMonth(to) } }),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayOfMonth(from) } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    });
  }

  /**
   * Checked here as well as by the `budgets_consistency` trigger.
   *
   * The trigger is the guarantee; this is the error message. A trigger violation
   * arrives as a check violation with no field attached, and "that change breaks
   * a rule of the ledger" is not something a user can act on.
   */
  private async assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('No such category.');
  }
}
