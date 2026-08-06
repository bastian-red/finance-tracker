/**
 * The composition root.
 *
 * Three things are registered globally here, and each one is global because the
 * alternative is a route that forgets it:
 *
 * **`ServiceTokenGuard`.** The default for a new route is authenticated. A route
 * that forgets `@Public()` is closed; a route that forgets `@UseGuards()` would
 * be open, which is the failure mode that matters.
 *
 * **`ResilientThrottlerGuard`.** Registered after the auth guard in this array,
 * which is the order Nest applies them: an unauthenticated flood is rejected by
 * the cheaper check first, and the rate-limit counters are then keyed by requests
 * that at least carried a valid token.
 *
 * **`PrismaExceptionFilter`.** A constraint violation that reaches the client as
 * a 500 tells the user nothing and tells the log the wrong thing. The filter is
 * `@Catch()`-all so that this is true for every route without a decorator.
 *
 * The throttler storage is the shared ioredis connection from `RedisService`
 * rather than a second one of its own, and it is wired asynchronously because the
 * limits come from `loadConfig`. Three named throttlers, because a login runs
 * scrypt, an import parses thousands of rows and a read is a keyset page: one
 * budget cannot be right for all three. See `common/rate-limit.ts` for how a
 * controller opts into exactly one of them.
 */
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from './accounts/accounts.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { BudgetsModule } from './budgets/budgets.module';
import { CategoriesModule } from './categories/categories.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import {
  RATE_BUCKET_AUTH,
  RATE_BUCKET_GLOBAL,
  RATE_BUCKET_IMPORT,
  ResilientThrottlerGuard,
} from './common/rate-limit';
import { ServiceTokenGuard } from './common/service-token.guard';
import { API_CONFIG, ConfigModule } from './config/config.module';
import type { ApiConfig } from './config/config';
import { HealthModule } from './health/health.module';
import { ImportsModule } from './imports/imports.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from './redis/redis.service';
import { ReportsModule } from './reports/reports.module';
import { RulesModule } from './rules/rules.module';
import { TransactionsModule } from './transactions/transactions.module';

/** Every bucket counts over one minute. The three numbers differ, the window does not. */
const RATE_WINDOW_MS = 60_000;

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: [
          { name: RATE_BUCKET_GLOBAL, ttl: RATE_WINDOW_MS, limit: config.rateLimits.global },
          { name: RATE_BUCKET_AUTH, ttl: RATE_WINDOW_MS, limit: config.rateLimits.auth },
          { name: RATE_BUCKET_IMPORT, ttl: RATE_WINDOW_MS, limit: config.rateLimits.import },
        ],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),

    HealthModule,
    AuthModule,
    AccountsModule,
    CategoriesModule,
    RulesModule,
    TransactionsModule,
    BudgetsModule,
    ReportsModule,
    ImportsModule,
    AlertsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ServiceTokenGuard },
    { provide: APP_GUARD, useClass: ResilientThrottlerGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule {}
