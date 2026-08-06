import { Module } from '@nestjs/common';
import { ReportCacheModule } from '../reports/report-cache.module';
import { BudgetStatusService } from './budget-status.service';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';

/**
 * `BudgetStatusService` is exported; `BudgetsService` is not.
 *
 * Reports and alerts need to *read* budget statuses, and nothing outside this
 * module has any business writing a budget. Exporting only the read half is what
 * keeps that true by construction rather than by convention.
 */
@Module({
  imports: [ReportCacheModule],
  controllers: [BudgetsController],
  providers: [BudgetsService, BudgetStatusService],
  exports: [BudgetStatusService],
})
export class BudgetsModule {}
