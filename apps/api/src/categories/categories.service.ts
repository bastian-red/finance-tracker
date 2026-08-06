/**
 * Categories.
 *
 * The only decision in here worth a comment is `colorSlot`, and it is a
 * dataviz decision rather than a data one. The slot is stored, assigned once, and
 * never derived from render order: charts are drawn from whatever rows the query
 * returned, and that order changes every month as spending changes. If the
 * palette were picked at render time, Groceries would be blue in March and orange
 * in April, which destroys the one thing a categorical palette is for.
 */
import { type Category, type CreateCategory } from '@fin/shared';
import type { CategoryKind } from '@fin/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportCacheService } from '../reports/report-cache.service';

interface CategoryRow {
  id: string;
  name: string;
  kind: CategoryKind;
  colorSlot: number;
}

export function categoryOf(row: CategoryRow): Category {
  return { id: row.id, name: row.name, kind: row.kind, colorSlot: row.colorSlot };
}

/**
 * The next slot to hand out.
 *
 * One past the highest in use, rather than the first gap. Reusing a freed slot
 * would give a brand new category the colour a deleted one had, and the reader
 * who still remembers "orange is Travel" reads the new chart wrong. Slots are
 * cheap; the palette wraps on the render side.
 */
export function nextColorSlot(used: readonly number[]): number {
  return used.length === 0 ? 0 : Math.max(...used) + 1;
}

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReportCacheService) private readonly cache: ReportCacheService,
  ) {}

  async list(userId: string): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({
      where: { userId },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return rows.map(categoryOf);
  }

  async create(userId: string, input: CreateCategory): Promise<Category> {
    const colorSlot = input.colorSlot ?? (await this.nextSlot(userId));
    const row = await this.prisma.category.create({
      data: { userId, name: input.name, kind: input.kind as CategoryKind, colorSlot },
    });
    await this.cache.bump(userId);
    return categoryOf(row);
  }

  async update(userId: string, id: string, input: CreateCategory): Promise<Category> {
    const existing = await this.prisma.category.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such category.');

    const row = await this.prisma.category.update({
      where: { id },
      data: {
        name: input.name,
        kind: input.kind as CategoryKind,
        ...(input.colorSlot === undefined ? {} : { colorSlot: input.colorSlot }),
      },
    });

    // The report carries category names and colour slots, so a rename invalidates
    // it even though no amount moved.
    await this.cache.bump(userId);
    return categoryOf(row);
  }

  /**
   * Delete. Transactions keep their history; budgets and rules do not survive.
   *
   * That asymmetry is the schema's, and it is right: `transactions.category_id`
   * is `ON DELETE SET NULL`, so the rows move into the uncategorised queue rather
   * than vanishing, while a budget or a rule for a category that no longer exists
   * has nothing left to mean.
   */
  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.category.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('No such category.');
    await this.cache.bump(userId);
  }

  private async nextSlot(userId: string): Promise<number> {
    const rows = await this.prisma.category.findMany({
      where: { userId },
      select: { colorSlot: true },
    });
    return nextColorSlot(rows.map((row) => row.colorSlot));
  }
}
