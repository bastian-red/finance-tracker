/**
 * Accounts, and the balance that is never stored.
 *
 * `balanceMinor` is `opening_balance_minor` plus the sum of the account's rows,
 * computed on every read. A stored running balance is the obvious optimisation
 * and it is wrong the first time a transaction is edited or deleted or arrives
 * out of order from an import of last year's statement: the column and the rows
 * disagree, both look authoritative, and there is no way to tell which one is the
 * lie. Recomputing is one indexed `GROUP BY` over rows that Postgres is already
 * keeping in an index for the reports.
 */
import { minor, type Account, type CreateAccount } from '@fin/shared';
import type { AccountKind } from '@fin/db';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiConfig } from '../config/config';
import { API_CONFIG } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingBalanceMinor: number;
  archivedAt: Date | null;
}

/** The row plus its movement, as the contract publishes it. */
export function accountOf(row: AccountRow, movementMinor: number): Account {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    balanceMinor: minor(row.openingBalanceMinor + movementMinor),
    archived: row.archivedAt !== null,
  };
}

@Injectable()
export class AccountsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async list(userId: string): Promise<Account[]> {
    const rows = await this.prisma.account.findMany({
      where: { userId },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    });

    const movement = await this.movement(userId);
    return rows.map((row) => accountOf(row, movement.get(row.id) ?? 0));
  }

  async create(userId: string, input: CreateAccount): Promise<Account> {
    const row = await this.prisma.account.create({
      data: {
        userId,
        name: input.name,
        kind: input.kind,
        currency: input.currency ?? this.config.defaultCurrency,
        openingBalanceMinor: input.openingBalanceMinor ?? 0,
      },
    });
    return accountOf(row, 0);
  }

  /**
   * Replace the editable fields. The currency is not one of them.
   *
   * `transactions_currency_matches_account` is checked when a *transaction* is
   * written, not when an account is. Re-denominating an account with rows in it
   * would therefore succeed and leave every existing row in the old currency,
   * with nothing to detect it and a balance that sums two currencies into one
   * number. Refused with a sentence rather than allowed with a trigger error.
   */
  async update(userId: string, id: string, input: CreateAccount): Promise<Account> {
    const existing = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such account.');

    if (input.currency !== undefined && input.currency !== existing.currency) {
      throw new ConflictException(
        `This account is in ${existing.currency} and its transactions are stored in ${existing.currency}. ` +
          'Create a new account in the other currency rather than re-denominating this one.',
      );
    }

    const row = await this.prisma.account.update({
      where: { id },
      data: {
        name: input.name,
        kind: input.kind,
        ...(input.openingBalanceMinor === undefined
          ? {}
          : { openingBalanceMinor: input.openingBalanceMinor }),
      },
    });

    const movement = await this.movement(userId);
    return accountOf(row, movement.get(row.id) ?? 0);
  }

  /** Archive, which is what "closed" means: the history stays, the picker hides it. */
  async setArchived(userId: string, id: string, archived: boolean): Promise<Account> {
    const existing = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such account.');

    const row = await this.prisma.account.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });

    const movement = await this.movement(userId);
    return accountOf(row, movement.get(row.id) ?? 0);
  }

  /**
   * Hard delete, refused while the account still holds transactions.
   *
   * The foreign key cascades, so without this check a `DELETE /accounts/:id`
   * silently erases a year of somebody's ledger and answers 204. Archiving is the
   * operation people actually want; deleting is for the account created by
   * mistake five minutes ago.
   */
  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.prisma.account.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such account.');

    const rows = await this.prisma.transaction.count({ where: { accountId: id } });
    if (rows > 0) {
      throw new ConflictException(
        `This account holds ${rows} transaction${rows === 1 ? '' : 's'}, and deleting it would delete them too. ` +
          'Archive it instead.',
      );
    }

    await this.prisma.account.delete({ where: { id } });
  }

  /**
   * Sum of the rows, per account, in one query.
   *
   * `groupBy` rather than a per-account `aggregate`: the list page shows every
   * account, and one query per account is the N+1 that turns a page into a
   * hundred round trips as soon as somebody has a hundred accounts. Prisma
   * converts the `bigint` a Postgres `SUM(int4)` returns into a JavaScript
   * number for an `Int` field, which is why this path does not need
   * `minorFromSum` and the raw-SQL rollups in `reports/` do.
   */
  private async movement(userId: string): Promise<Map<string, number>> {
    const rows = await this.prisma.transaction.groupBy({
      by: ['accountId'],
      where: { userId },
      _sum: { amountMinor: true },
    });
    return new Map(rows.map((row) => [row.accountId, row._sum.amountMinor ?? 0]));
  }
}
