import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AlertsModule } from '../alerts/alerts.module';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/config';
import { ReportCacheModule } from '../reports/report-cache.module';
import { RulesModule } from '../rules/rules.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/**
 * Multer is configured here, asynchronously, and not with a literal.
 *
 * `FileInterceptor('file')` takes its options either inline or from the module,
 * and inline is evaluated when the class is *defined* -- before `loadConfig` has
 * run, so `MAX_IMPORT_BYTES` would not be readable there without going around
 * the config loader and reading `process.env` directly. Registering the options
 * through a factory keeps one path from the variable to the limit, which is what
 * `scripts/env-contract.mjs` can see and a stray `process.env` lookup is not.
 *
 * Neither `storage` nor `dest` is set, which is multer's documented way of asking
 * for memory storage, and it is deliberate rather than an omission: the service
 * hashes the bytes to decide the file's identity and writes them itself,
 * content-addressed. Letting multer write to a path it invents would mean two
 * copies and a filename this codebase does not control. `multer` is not imported
 * here to say `memoryStorage()` explicitly, because that would pin a second copy
 * of a package `@nestjs/platform-express` already owns, and the interceptor would
 * keep using its own. The consequence of memory storage is that one upload holds
 * `MAX_IMPORT_BYTES` of heap, which is why that ceiling defaults to 8 MB rather
 * than to something generous.
 */
@Module({
  imports: [
    RulesModule,
    ReportCacheModule,
    AlertsModule,
    MulterModule.registerAsync({
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => ({
        limits: { fileSize: config.maxImportBytes, files: 1 },
      }),
    }),
  ],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
