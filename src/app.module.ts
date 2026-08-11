import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import { join } from 'node:path';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { loggerOptions } from './common/logging/logger.config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { HealthModule } from './modules/health/health.module';
import { TopicsModule } from './modules/topics/topics.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { PreferencesModule } from './modules/preferences/preferences.module';
import { SuppressionModule } from './modules/suppression/suppression.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { DigestModule } from './modules/digest/digest.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { RecipientsModule } from './modules/recipients/recipients.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
      cache: true,
    }),
    WinstonModule.forRootAsync({
      useFactory: () => {
        // Read config directly rather than injecting ConfigService: the logger must exist before
        // anything else so early-boot failures are still visible.
        const config = configuration();
        return loggerOptions(config.logLevel, config.isProduction);
      },
    }),
    // Powers the @Interval metrics collector. The digest and retention schedules use BullMQ
    // repeatable jobs instead, so they fire once across a cluster rather than once per instance.
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    // The demo UI. Served at /demo so it cannot shadow an API route.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/demo',
      serveStaticOptions: { index: 'index.html' },
    }),

    // infrastructure
    PrismaModule,
    RedisModule,
    QueueModule,
    MetricsModule,

    // domain
    TopicsModule,
    TemplatesModule,
    DeliveriesModule,
    SuppressionModule,
    PreferencesModule,
    NotificationsModule,
    OutboxModule,
    DispatchModule,
    ChannelsModule,
    WebhooksModule,
    DigestModule,
    MaintenanceModule,
    RecipientsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
