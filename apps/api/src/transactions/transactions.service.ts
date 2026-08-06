/**
 * The ledger.
 *
 * Three things every write in here gets right, each of which is a bug the
 * database would otherwise catch at a much worse moment:
 *
 * **The currency comes from the account row, never from `DEFAULT_CURRENCY`.**
 * `transactions_currency_matches_account` is a `BEFORE` trigger, so a mismatch
 * does not fail one row, it rejects the whole statement, and the message it
 * raises is about a trigger rather than about the field somebody filled in.
 *
 * **`category_source` records who decided.** A category a human chose is
 * `manual` and is never overwritten by a rule; one a rule assigned is `rule` and
 * carries the `rule_id` that did it. Without that column the only way to know
 * whether a category was a person's decision or a guess is to guess.
 *
 * **Every write bumps the report cache version, after it commits.** The dashboard
 * reads through a Redis cache keyed by that version, so a write that forgets is a
 * dashboard that keeps showing yesterday's total until the TTL runs out.
 */
import {
  day,
  fromUtcDate,
  merchantOf,
  minor,
  toUtcDate,
  type CreateTransaction,
  type Transaction,
  type TransactionPage,
  type TransactionQuery,
  type UpdateTransaction,
} from '@fin/shared';
import { fingerprintOf } from '@fin/shared/server';
import { categorize } from '@fin/categorize';
import type { CategorySource } from '@fin/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { decodeCursor } from '../common/cursor';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCacheService } from '../reports/report-cache.service';
import { RulesService } from '../rules/rules.service';
import { TRANSACTION_ORDER, pageWhere, splitPage, transactionWhere } from './transaction.query';

interface TransactionRow {
  id: string;
  accountId: string;
  bookedOn: Date;
  amountMinor: number;
  currency: string;
  description: string;
  merchant: string | null;
  categoryId: string | null;
  categorySource: CategorySource;
  notes: string | null;
  importId: string | null;
}

export function transactionOf(row: TransactionRow): Transaction {
  return {
    id: row.id,
    accountId: row.accountId,
    // UTC accessors, always. This is the exact line where a finance app read in
    // Santiago starts filing March transactions under February.
    bookedOn: fromUtcDate(row.bookedOn),
    amountMinor: row.amountMinor,
    currency: row.currency,
    description: row.description,
    merchant: row.merchant,
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    notes: row.notes,
    importId: row.importId,
  };
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ReportCacheService) private readonly cache: ReportCacheService,
    @Inject(AlertsService) private readonly alerts: AlertsService,
  ) {}

  async list(userId: string, query: TransactionQuery): Promise<TransactionPage> {
    const base = transactionWhere(userId, query);
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);

    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where: pageWhere(base, cursor),
        orderBy: TRANSACTION_ORDER,
        // One more than asked for, to learn whether there is a next page without
        // a second COUNT over the same predicate.
        take: query.limit + 1,
      }),
      // Over `base`, not `pageWhere`: the total describes the filter, not the
      // page. A figure that shrank as the reader paged would describe nothing.
      this.prisma.transaction.aggregate({ where: base, _sum: { amountMinor: true } }),
    ]);

    const page = splitPage(
      rows.map((row) => ({ ...transactionOf(row) })),
      query.limit,
    );

    return {
      items: page.items,
      nextCursor: page.nextCursor,
      totalMinor: minor(total._sum.amountMinor ?? 0),
    };
  }

  async create(userId: string, input: CreateTransaction): Promise<Transaction> {
    const account = await this.account(userId, input.accountId);
    const bookedOn = day(input.bookedOn);

    const assignment = await this.assign(userId, input.categoryId, {
      description: input.description,
      amountMinor: input.amountMinor,
    });

    const row = await this.prisma.transaction.create({
      data: {
        userId,
        accountId: account.id,
        bookedOn: toUtcDate(bookedOn),
        amountMinor: input.amountMinor,
        // From the account row. See the file header.
        currency: account.currency,
        description: input.description,
        merchant: emptyToNull(merchantOf(input.description)),
        notes: input.notes ?? null,
        fingerprint: fingerprintOf(account.id, bookedOn, input.amountMinor, input.description),
        ...assignment,
      },
    });

    await this.afterWrite(userId);
    return transactionOf(row);
  }

  /**
   * Partial update.
   *
   * `'categoryId' in input` rather than `input.categoryId !== undefined`, because
   * `null` is a meaningful value here: it means "take the category off this row",
   * and it has to be distinguishable from "do not touch the category". zod's
   * `.partial()` omits absent keys from its output, so key presence is the honest
   * test and the only one that can tell those two apart.
   */
  async update(userId: string, id: string, input: UpdateTransaction): Promise<Transaction> {
    const existing = await this.prisma.transaction.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such transaction.');

    const bookedOn =
      input.bookedOn === undefined ? fromUtcDate(existing.bookedOn) : day(input.bookedOn);
    const amountMinor = input.amountMinor ?? existing.amountMinor;
    const description = input.description ?? existing.description;

    const categoryChanged = 'categoryId' in input;
    const assignment = categoryChanged
      ? await this.assign(userId, input.categoryId, { description, amountMinor })
      : {};

    const row = await this.prisma.transaction.update({
      where: { id },
      data: {
        bookedOn: toUtcDate(bookedOn),
        amountMinor,
        description,
        merchant: emptyToNull(merchantOf(description)),
        ...('notes' in input ? { notes: input.notes ?? null } : {}),
        // Recomputed unconditionally: it is a hash of exactly the four fields
        // above, and a stale fingerprint means the next import of this statement
        // fails to recognise the row it already holds.
        fingerprint: fingerprintOf(existing.accountId, bookedOn, amountMinor, description),
        ...assignment,
      },
    });

    await this.afterWrite(userId);
    return transactionOf(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.transaction.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('No such transaction.');

    // Bumped, but no alert evaluation: a deletion only ever reduces spending, and
    // there is no such thing as an alert saying a budget got better.
    await this.cache.bump(userId);
  }

  /**
   * Who decided the category, and which rule if it was a rule.
   *
   * A caller-supplied category is `manual` even when a rule would have picked the
   * same one, because the point of the column is provenance, not agreement.
   */
  private async assign(
    userId: string,
    categoryId: string | null | undefined,
    candidate: { description: string; amountMinor: number },
  ): Promise<{ categoryId: string | null; categorySource: CategorySource; ruleId: string | null }> {
    if (categoryId !== undefined && categoryId !== null) {
      await this.assertOwnsCategory(userId, categoryId);
      return { categoryId, categorySource: 'manual', ruleId: null };
    }
    if (categoryId === null) {
      // An explicit clear. Not a chance to re-run the rules: the user just took
      // the category off, and putting it straight back is the app arguing.
      return { categoryId: null, categorySource: 'none', ruleId: null };
    }

    const match = categorize(await this.rules.compiledFor(userId), candidate);
    return match === null
      ? { categoryId: null, categorySource: 'none', ruleId: null }
      : { categoryId: match.categoryId, categorySource: 'rule', ruleId: match.ruleId };
  }

  /**
   * Invalidate the report, then evaluate budgets.
   *
   * In that order, and both after the write has committed. Evaluating first would
   * have the alert mailer read a cached report that predates the transaction it
   * is reacting to.
   */
  private async afterWrite(userId: string): Promise<void> {
    await this.cache.bump(userId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    });
    if (!user) return;

    // The current month in the user's own zone, and only that month. See
    // `AlertsService` for why a backfilled row must not mail anybody about a
    // period that has already closed.
    await this.alerts.evaluate(userId, this.alerts.monthFor(user.timeZone));
  }

  private async account(
    userId: string,
    accountId: string,
  ): Promise<{ id: string; currency: string }> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, userId },
      select: { id: true, currency: true },
    });
    if (!account) throw new NotFoundException('No such account.');
    return account;
  }

  private async assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('No such category.');
  }
}

/** `merchantOf('...')` can legitimately be empty; the column stores null for that. */
function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
