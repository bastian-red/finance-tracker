import { Module } from '@nestjs/common';
import { ReportCacheModule } from '../reports/report-cache.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [ReportCacheModule],
  controllers: [CategoriesController],
  providers: [CategoriesService],
})
export class CategoriesModule {}
