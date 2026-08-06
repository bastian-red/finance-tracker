/**
 * The two queries behind every budget number in the app.
 *
 * Lives in `BudgetsModule` and is exported, because both the dashboard report and
 * the alert mailer need it and neither may have its own copy. Two
 * implementations of "how much of the groceries budget is gone" is how an email
 * and a screen end up disagreeing by a cent, and the user believes neither.
 */
import {
  currentMonth,
  firstDayOfMonth,
  lastDayOfMonth,
  month as parseMonth,
  type BudgetStatus,
  type CalendarMonth,
} from '@fin/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { budgetStatuses, type BudgetPeriod, type CategoryMonthSpend } from './budget-status.math';

/** `date` columns come back from Prisma as a `Date` pinned to UTC midnight. */
function monthOfDate(value: Date): CalendarMonth {
  return parseMonth(value.toISOString().slice(0, 7));
}

@Injectable()
export class BudgetStatusService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async statuses(userId: string, months: readonly CalendarMonth[]): Promise<BudgetStatus[]> {
    const first = months[0];
    const last = months[months.length - 1];
    if (first === undefined || last === undefined) return [];

    const [periods, spend] = await Promise.all([
      this.periods(userId, first, last),
      this.spend(userId, first, last),
    ]);

    return budgetStatuses(periods, spend, months, this.config.budgetAlertBasisPoints);
  }

  /**
   * One month's statuses, resolving "this month" against the user's own zone.
   *
   * Split from `statuses` rather than folded into it because the default is the
   * whole point: the budgets screen asks for "now", and "now" is a question about
   * where the reader is standing. Letting the browser answer it makes the same
   * ledger show August in Madrid and July on a laptop still set to UTC-11 at
   * 23:30 local. `currentMonth` is the same helper `ReportsService` uses, reading
   * the same stored `timeZone`, so the dashboard and this screen cannot disagree
   * about which month it is.
   *
   * `now` is a parameter for the same reason it is one in `ReportsService`: a
   * function that reads the clock itself cannot be tested at a month boundary.
   */
  async statusesForMonth(
    userId: string,
    month: string | undefined,
    now: Date = new Date(),
  ): Promise<BudgetStatus[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    });
    if (!user) throw new NotFoundException('That account no longer exists.');

    const resolved = month === undefined ? currentMonth(now, user.timeZone) : parseMonth(month);
    return this.statuses(userId, [resolved]);
  }

  /** Budgets whose range intersects the window, with their category's display fields. */
  private async periods(
    userId: string,
    first: CalendarMonth,
    last: CalendarMonth,
  ): Promise<BudgetPeriod[]> {
    const rows = await this.prisma.budget.findMany({
      where: {
        userId,
        // Both columns hold the first day of a month, so a plain date comparison
        // is exactly a month comparison. That equivalence is what the
        // `budgets_months_aligned` CHECK constraint exists to guarantee.
        effectiveFrom: { lte: new Date(`${lastDayOfMonth(last)}T00:00:00.000Z`) },
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: new Date(`${firstDayOfMonth(first)}T00:00:00.000Z`) } },
        ],
      },
      include: { category: { select: { name: true, colorSlot: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      categoryName: row.category.name,
      colorSlot: row.category.colorSlot,
      limitMinor: row.limitMinor,
      effectiveFrom: monthOfDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo === null ? null : monthOfDate(row.effectiveTo),
    }));
  }

  /**
   * Expense per category per month, as one `GROUP BY`.
   *
   * Raw SQL rather than `groupBy`, for two reasons. Prisma cannot group by a
   * computed expression, and the month here is one (`to_char(booked_on,
   * 'YYYY-MM')`); and this is the query the covering index in
   * `20260801121000_ledger_invariants` was built for, so it is worth being able
   * to read exactly what it does.
   *
   * `amount_minor < 0` keeps refunds and salary out of "spent". `SUM` therefore
   * returns a negative `bigint`, which `budgetStatuses` converts and takes the
   * absolute of.
   *
   * The day bounds are bound as text and cast with `::date`. Binding a JavaScript
   * `Date` would make Postgres compare a `date` against a `timestamptz`, which it
   * resolves using the session's time zone: the same query would then include or
   * exclude the first of the month depending on where the server is standing,
   * which is the entire class of bug `packages/shared/src/time/day.ts` exists to
   * remove.
   */
  private spend(
    userId: string,
    first: CalendarMonth,
    last: CalendarMonth,
  ): Promise<CategoryMonthSpend[]> {
    return this.prisma.$queryRaw<CategoryMonthSpend[]>`
      SELECT t.category_id AS "categoryId",
             to_char(t.booked_on, 'YYYY-MM') AS "month",
             SUM(t.amount_minor) AS "amountMinor"
      FROM transactions t
      WHERE t.user_id = ${userId}
        AND t.booked_on >= ${firstDayOfMonth(first)}::date
        AND t.booked_on <= ${lastDayOfMonth(last)}::date
        AND t.amount_minor < 0
      GROUP BY 1, 2
    `;
  }
}
