import { Module } from '@nestjs/common';
import { AlertsModule } from '../alerts/alerts.module';
import { ReportCacheModule } from '../reports/report-cache.module';
import { RulesModule } from '../rules/rules.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [RulesModule, ReportCacheModule, AlertsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
