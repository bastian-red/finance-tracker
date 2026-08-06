import { Global, Module } from '@nestjs/common';
import { loadConfig, type ApiConfig } from './config';

/**
 * The injection token for the parsed configuration.
 *
 * A string token rather than a class, because `ApiConfig` is an interface: there
 * is no runtime value to inject by type, and inventing a wrapper class to get one
 * would add a layer whose only job is to hold a property.
 */
export const API_CONFIG = 'API_CONFIG';

/**
 * Global so no other module has to import it.
 *
 * Configuration is genuinely cross-cutting here -- eight of the nine feature
 * modules read at least one value -- and threading `ConfigModule` through every
 * `imports` array buys nothing but noise.
 */
@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: (): ApiConfig => loadConfig() }],
  exports: [API_CONFIG],
})
export class ConfigModule {}
