/**
 * Rule CRUD.
 *
 * Rules do not change any stored amount, so nothing here touches the report
 * cache. What they change is what the *next* write gets categorised as, and
 * re-running them over the existing ledger is deliberately not something this
 * service does silently: `category_source` exists precisely so a human's choice
 * is never overwritten by a rule, and a rule edit that quietly re-filed a year of
 * transactions would be the most alarming thing this app could do.
 */
import type { CreateRule, Matcher, Rule } from '@fin/shared';
import type { MatcherType } from '@fin/db';
import { compileRules, type CompiledRuleSet } from '@fin/categorize';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertRuleRunnable } from './rule-validation';

interface RuleRow {
  id: string;
  categoryId: string;
  matcherType: MatcherType;
  matcherValue: string;
  priority: number;
  minAmountMinor: number | null;
  maxAmountMinor: number | null;
  active: boolean;
}

export function ruleOf(row: RuleRow): Rule {
  return {
    id: row.id,
    categoryId: row.categoryId,
    matcher: { type: row.matcherType, value: row.matcherValue } as Matcher,
    priority: row.priority,
    minAmountMinor: row.minAmountMinor,
    maxAmountMinor: row.maxAmountMinor,
    active: row.active,
  };
}

@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The user's active rules, compiled once, for a caller that is about to run
   * them over one row or over four thousand.
   *
   * `skipped` is logged rather than dropped. A rule that is stored but cannot run
   * (a pattern that passed an older, laxer check, or something an operator edited
   * directly in SQL) means a category silently stops being assigned, and the only
   * symptom is a review queue that keeps growing. Nobody debugs that from an
   * empty log.
   */
  async compiledFor(userId: string): Promise<CompiledRuleSet> {
    const rows = await this.prisma.rule.findMany({ where: { userId, active: true } });
    const compiled = compileRules(
      rows.map((row) => ({
        id: row.id,
        categoryId: row.categoryId,
        matcherType: row.matcherType,
        matcherValue: row.matcherValue,
        priority: row.priority,
        minAmountMinor: row.minAmountMinor,
        maxAmountMinor: row.maxAmountMinor,
        active: row.active,
      })),
    );

    for (const skipped of compiled.skipped) {
      this.logger.warn(`Rule ${skipped.ruleId} is stored but cannot run: ${skipped.problem}`);
    }

    return compiled;
  }

  async list(userId: string): Promise<Rule[]> {
    const rows = await this.prisma.rule.findMany({
      where: { userId },
      // The order the engine runs them in. A screen that lists rules in a
      // different order than they fire is a screen that cannot answer "why did
      // this one win".
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    });
    return rows.map(ruleOf);
  }

  async create(userId: string, input: CreateRule): Promise<Rule> {
    const min = input.minAmountMinor ?? null;
    const max = input.maxAmountMinor ?? null;
    assertRuleRunnable({ matcher: input.matcher, minAmountMinor: min, maxAmountMinor: max });
    await this.assertOwnsCategory(userId, input.categoryId);

    const row = await this.prisma.rule.create({
      data: {
        userId,
        categoryId: input.categoryId,
        matcherType: input.matcher.type,
        matcherValue: input.matcher.value,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        minAmountMinor: min,
        maxAmountMinor: max,
        ...(input.active === undefined ? {} : { active: input.active }),
      },
    });
    return ruleOf(row);
  }

  async update(userId: string, id: string, input: CreateRule): Promise<Rule> {
    const existing = await this.prisma.rule.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundException('No such rule.');

    const min = input.minAmountMinor ?? null;
    const max = input.maxAmountMinor ?? null;
    assertRuleRunnable({ matcher: input.matcher, minAmountMinor: min, maxAmountMinor: max });
    await this.assertOwnsCategory(userId, input.categoryId);

    const row = await this.prisma.rule.update({
      where: { id },
      data: {
        categoryId: input.categoryId,
        matcherType: input.matcher.type,
        matcherValue: input.matcher.value,
        priority: input.priority ?? existing.priority,
        minAmountMinor: min,
        maxAmountMinor: max,
        active: input.active ?? existing.active,
      },
    });
    return ruleOf(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.rule.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException('No such rule.');
  }

  private async assertOwnsCategory(userId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('No such category.');
  }
}
