import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { ReportCacheModule } from './report-cache.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [BudgetsModule, ReportCacheModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
