import { Module } from '@nestjs/common';
import { ReportCacheService } from './report-cache.service';

/**
 * Its own module, imported by every module that writes.
 *
 * Not folded into `ReportsModule`, because `ReportsModule` imports
 * `BudgetsModule` for budget statuses and `BudgetsModule` has to bump the cache
 * when a limit changes. One module holding both would be a cycle; splitting the
 * cache out is the smaller of the two obvious fixes and the one that names the
 * dependency honestly.
 */
@Module({ providers: [ReportCacheService], exports: [ReportCacheService] })
export class ReportCacheModule {}
