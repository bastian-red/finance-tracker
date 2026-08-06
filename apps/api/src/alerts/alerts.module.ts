import { Module } from '@nestjs/common';
import { BudgetsModule } from '../budgets/budgets.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

/**
 * Exports `AlertsService` because transactions and the import commit both have to
 * call `evaluate` after they write. The dependency runs one way only: alerts read
 * budget statuses, and nothing in `BudgetsModule` knows alerts exist. Wiring it
 * the other way (a budget write raising an alert) would be a cycle, and would
 * also be wrong: changing a limit is not spending money.
 */
@Module({
  imports: [BudgetsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
