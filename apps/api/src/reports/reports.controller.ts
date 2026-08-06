import { reportQuerySchema, type MonthlyReport, type ReportQuery } from '@fin/shared';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator';
import { OrdinaryRate } from '../common/rate-limit';
import type { TokenUser } from '../common/service-token.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReportsService } from './reports.service';

@Controller('reports')
@OrdinaryRate()
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  /**
   * The dashboard, in one request.
   *
   * `trailing` defaults to 12 and is capped at 36 by the contract, which is not
   * decoration: the window is the number of months this scans, and an unbounded
   * one would let a query string decide how much of somebody's ledger a single
   * request reads.
   */
  @Get('monthly')
  monthly(
    @CurrentUser() user: TokenUser,
    @Query(new ZodValidationPipe(reportQuerySchema)) query: ReportQuery,
  ): Promise<MonthlyReport> {
    return this.reports.monthly(user.id, query);
  }
}
