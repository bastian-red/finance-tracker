/**
 * The monthly report, read through a versioned Redis cache.
 *
 * The rollups are three `GROUP BY` queries over a year of somebody's ledger, and
 * the dashboard asks for them on every page load, so caching them is worth doing.
 * The scheme is in `report-cache.ts`: a version counter, incremented on write, in
 * the key. `DEL`-on-write loses a documented race and this does not.
 *
 * Redis being unreachable is a slower report, never a 500. Every cache call
 * degrades: `probe` returns version 0 and no value, `store` does nothing, and the
 * numbers come from Postgres exactly as they would on a cold cache. The one cost
 * is that a version bump missed during an outage leaves an entry readable until
 * `REPORT_CACHE_TTL_SECONDS` expires it, which is the reason that TTL exists at
 * all given the version counter would otherwise make it redundant.
 */
import {
  currentMonth,
  firstDayOfMonth,
  lastDayOfMonth,
  month as parseMonth,
  trailingMonths,
  type CalendarMonth,
  type MonthlyReport,
  type ReportQuery,
} from '@fin/shared';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { BudgetStatusService } from '../budgets/budget-status.service';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCacheService } from './report-cache.service';
import {
  categoryTotals,
  denseTrend,
  totalsOf,
  type CategorySumRow,
  type MonthlySumRow,
} from './report.math';

@Injectable()
export class ReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BudgetStatusService) private readonly budgets: BudgetStatusService,
    @Inject(ReportCacheService) private readonly cache: ReportCacheService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async monthly(
    userId: string,
    query: ReportQuery,
    now: Date = new Date(),
  ): Promise<MonthlyReport> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true, timeZone: true },
    });
    if (!user) throw new NotFoundException('That account no longer exists.');

    // "This month" is a question about where the reader is standing, and it is
    // the only place in the report where a time zone appears at all. Every stored
    // row is a zoneless calendar day.
    const month =
      query.month === undefined ? currentMonth(now, user.timeZone) : parseMonth(query.month);
    const months = trailingMonths(month, query.trailing);

    // The version is read here, **before** the queries below. Reading it after
    // would let a concurrent write land in between and this answer would be
    // stored under the new version, which is the stale entry the whole scheme
    // exists to prevent.
    const probe = await this.cache.probe<MonthlyReport>(userId, month, query.trailing);
    if (probe.value !== null) {
      // `cached` is set on the way out rather than stored, so one entry serves
      // both and the field always tells the truth about *this* response.
      return { ...probe.value, cached: true };
    }

    const report = await this.compute(userId, user.currency, month, months, now);

    await this.cache.store(
      userId,
      month,
      query.trailing,
      probe.version,
      report,
      this.config.reportCacheTtlSeconds,
    );

    return report;
  }

  private async compute(
    userId: string,
    currency: string,
    month: CalendarMonth,
    months: readonly CalendarMonth[],
    now: Date,
  ): Promise<MonthlyReport> {
    const windowStart = firstDayOfMonth(months[0] ?? month);
    const windowEnd = lastDayOfMonth(months[months.length - 1] ?? month);

    const [monthly, byCategory, budgets] = await Promise.all([
      this.monthlySums(userId, windowStart, windowEnd),
      this.categorySums(userId, firstDayOfMonth(month), lastDayOfMonth(month)),
      // Statuses for the whole window, not just the selected month: a budget
      // covers a range, and `planAlerts` is written to filter a trailing window
      // down to one month rather than to trust its caller.
      this.budgets.statuses(userId, months),
    ]);

    const trend = denseTrend(months, monthly);

    return {
      month,
      currency,
      totals: totalsOf(
        month,
        monthly.find((row) => row.month === month),
      ),
      trend,
      byCategory: categoryTotals(byCategory),
      budgets,
      cached: false,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Income and expense per month, split by the sign of the row.
   *
   * One pass with two conditional sums rather than two queries: the index scan is
   * the expensive part and running it twice to ask two questions about the same
   * rows doubles it for nothing.
   *
   * Day bounds are bound as text and cast with `::date`. Binding a JavaScript
   * `Date` would make Postgres compare `date` against `timestamptz`, which it
   * resolves through the session time zone, so the same query would include or
   * exclude the first of the month depending on where the server is standing.
   */
  private monthlySums(userId: string, from: string, to: string): Promise<MonthlySumRow[]> {
    return this.prisma.$queryRaw<MonthlySumRow[]>`
      SELECT to_char(t.booked_on, 'YYYY-MM') AS "month",
             SUM(CASE WHEN t.amount_minor > 0 THEN t.amount_minor ELSE 0 END) AS "incomeMinor",
             SUM(CASE WHEN t.amount_minor < 0 THEN t.amount_minor ELSE 0 END) AS "expenseMinor"
      FROM transactions t
      WHERE t.user_id = ${userId}
        AND t.booked_on >= ${from}::date
        AND t.booked_on <= ${to}::date
      GROUP BY 1
    `;
  }

  /**
   * Expense per category for one month.
   *
   * `LEFT JOIN` so rows with no category still appear: the uncategorised slice is
   * the queue of work after an import, and a chart that drops it makes the
   * month's spending look smaller than it was.
   */
  private categorySums(userId: string, from: string, to: string): Promise<CategorySumRow[]> {
    return this.prisma.$queryRaw<CategorySumRow[]>`
      SELECT t.category_id AS "categoryId",
             c.name AS "categoryName",
             c.color_slot AS "colorSlot",
             SUM(t.amount_minor) AS "amountMinor"
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = ${userId}
        AND t.booked_on >= ${from}::date
        AND t.booked_on <= ${to}::date
        AND t.amount_minor < 0
      GROUP BY 1, 2, 3
    `;
  }
}
