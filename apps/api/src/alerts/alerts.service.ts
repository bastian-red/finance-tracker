/**
 * Budget alerts: decide, persist, send.
 *
 * The dedupe is the interesting part, and it is not done here. Every transaction
 * that lands in an over-budget category re-evaluates that budget, so a busy
 * Saturday evaluates the same "Eating out is over" eleven times. The obvious
 * guard is "have I already sent this?" before inserting, and it is wrong for the
 * same reason the budget overlap check is wrong: two requests both run the check,
 * both see nothing, both insert, and the user gets two emails. It fails exactly
 * under the load that makes it matter.
 *
 * `@@unique([budgetId, month, level])` on `alerts` is the only thing that can
 * settle it, because Postgres evaluates it atomically. So this service **inserts
 * first** and reads a unique violation as "already sent". `planAlerts` in
 * `@fin/notifications` documents the same contract from the other side: it does
 * not deduplicate and it says so.
 *
 * Four other properties this file holds to, all of them because it runs on the
 * tail of a request whose database write has already committed:
 *
 * - **`evaluate` never throws.** The transaction the user created is safely
 *   stored. Failing their request because the mail server is down would be a 500
 *   for something they did nothing wrong in, and it would tell them their
 *   transaction was not saved, which is false.
 * - **The message is passed to the channel unmodified.** `renderAlert` returns
 *   `from: ''` on purpose; the sender is transport configuration (`MAIL_FROM`)
 *   and `createChannel` fills it in. Setting it here would put configuration in
 *   the renderer.
 * - **Only the current month is evaluated.** A backfilled transaction that pushes
 *   last August over its limit must not mail anybody about August: the period is
 *   closed, they cannot act on it, and every alert nobody needed makes the next
 *   real one less likely to be read.
 * - **`deliveredAt` stays null when the channel refuses.** The alert exists
 *   whether or not the email does, and the row is what the in-app list shows.
 */
import { currentMonth, month as parseMonth, type Alert, type CalendarMonth } from '@fin/shared';
import { ALERT_ONCE_PER_MONTH, isUniqueViolation } from '@fin/db';
import {
  createChannel,
  planAlerts,
  renderAlert,
  type Channel,
  type PlannedAlert,
} from '@fin/notifications';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { BudgetStatusService } from '../budgets/budget-status.service';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

interface AlertRow {
  id: string;
  budgetId: string;
  month: Date;
  level: 'approaching' | 'exceeded';
  limitMinor: number;
  spentMinor: number;
  createdAt: Date;
  readAt: Date | null;
  budget: { category: { name: string } };
}

export function alertOf(row: AlertRow): Alert {
  return {
    id: row.id,
    budgetId: row.budgetId,
    categoryName: row.budget.category.name,
    month: parseMonth(row.month.toISOString().slice(0, 7)),
    level: row.level,
    limitMinor: row.limitMinor,
    spentMinor: row.spentMinor,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
  };
}

@Injectable()
export class AlertsService implements OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private readonly channel: Channel;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BudgetStatusService) private readonly statuses: BudgetStatusService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {
    // One channel for the process. `createChannel` picks SMTP, the log channel or
    // the null channel from configuration; with `SMTP_HOST` empty it prints,
    // which is the documented local default so a fresh clone can watch the whole
    // alert path work without a mail server.
    this.channel = createChannel({
      ...config.smtp,
      logger: (line) => this.logger.log(line),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel.close();
  }

  async list(userId: string): Promise<Alert[]> {
    const rows = await this.prisma.alert.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { budget: { include: { category: { select: { name: true } } } } },
      take: 100,
    });
    return rows.map(alertOf);
  }

  async markRead(userId: string, id: string): Promise<Alert> {
    const result = await this.prisma.alert.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    const row = await this.prisma.alert.findFirst({
      where: { id, userId },
      include: { budget: { include: { category: { select: { name: true } } } } },
    });
    if (!row) throw new NotFoundException('No such alert.');

    // `result.count === 0` when it was already read, which is not an error: the
    // second click on a notification is the most ordinary thing a user does.
    void result;
    return alertOf(row);
  }

  /** The month a user is currently in, in their own zone. */
  monthFor(timeZone: string, now: Date = new Date()): CalendarMonth {
    return currentMonth(now, timeZone);
  }

  /**
   * Evaluate the user's budgets for one month and raise whatever is new.
   *
   * Returns the alerts it actually created, which is what the gate tests assert
   * on. Never throws: see the file header.
   */
  async evaluate(userId: string, month: CalendarMonth): Promise<Alert[]> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, locale: true, currency: true },
      });
      if (!user) return [];

      const statuses = await this.statuses.statuses(userId, [month]);
      const planned = planAlerts(statuses, month);
      const created: Alert[] = [];

      // In `planAlerts`' order: exceeded first, then the fullest budget, then
      // budget id. The order is load-bearing because the e2e suite asserts on the
      // first alert, and an unstable one is a flaky test.
      for (const alert of planned) {
        const row = await this.persist(userId, alert);
        if (row === null) continue;
        created.push(alertOf(row));
        await this.deliver(row.id, alert, user.email, user.locale, user.currency);
      }

      return created;
    } catch (error) {
      this.logger.error(
        `Budget evaluation for ${userId} ${month} failed after the write had committed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Insert, and read a unique violation as "already sent".
   *
   * Its own statement, outside any transaction, for the same reason the budget
   * write is: a constraint violation aborts the whole Postgres transaction, so
   * catching it inside one would poison every statement after it.
   */
  private async persist(userId: string, alert: PlannedAlert): Promise<AlertRow | null> {
    try {
      return await this.prisma.alert.create({
        data: {
          userId,
          budgetId: alert.budgetId,
          month: new Date(`${alert.month}-01T00:00:00.000Z`),
          level: alert.level,
          limitMinor: alert.limitMinor,
          spentMinor: alert.spentMinor,
        },
        include: { budget: { include: { category: { select: { name: true } } } } },
      });
    } catch (error) {
      if (isUniqueViolation(error, ALERT_ONCE_PER_MONTH)) return null;
      throw error;
    }
  }

  private async deliver(
    id: string,
    alert: PlannedAlert,
    recipient: string,
    locale: string,
    currency: string,
  ): Promise<void> {
    // `renderAlert` throws when `APP_BASE_URL` is not absolute. `assertBootable`
    // makes that unreachable at runtime by refusing to start, which is why this
    // call is not individually guarded.
    const message = renderAlert(alert, {
      locale,
      currency,
      appBaseUrl: this.config.appBaseUrl,
      recipient,
    });

    const result = await this.channel.send(message);
    if (!result.delivered) {
      this.logger.warn(`Alert ${id} was stored but not delivered: ${result.error ?? 'no reason'}`);
      return;
    }
    await this.prisma.alert.update({ where: { id }, data: { deliveredAt: new Date() } });
  }
}
