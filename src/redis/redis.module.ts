import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Command connection: general-purpose GET/SET/EVAL (dedup locks, rate limits, breaker state). */
export const REDIS_CLIENT = 'REDIS_CLIENT';
/** Dedicated publisher for the in-app realtime fan-out. */
export const REDIS_PUBLISHER = 'REDIS_PUBLISHER';
/**
 * Dedicated subscriber. A connection in subscribe mode cannot run normal commands, so
 * pub/sub always needs its own socket — sharing one is a classic source of
 * "ERR only (P|S)SUBSCRIBE / ... allowed in this context".
 */
export const REDIS_SUBSCRIBER = 'REDIS_SUBSCRIBER';

function createClient(url: string, role: string): Redis {
  const client = new Redis(url, {
    // BullMQ's blocking commands require this; harmless for the others.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    connectionName: `notif-${role}`,
  });
  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[redis:${role}] ${err.message}`);
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(config.getOrThrow<string>('redisUrl'), 'client'),
    },
    {
      provide: REDIS_PUBLISHER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(config.getOrThrow<string>('redisUrl'), 'pub'),
    },
    {
      provide: REDIS_SUBSCRIBER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient(config.getOrThrow<string>('redisUrl'), 'sub'),
    },
  ],
  exports: [REDIS_CLIENT, REDIS_PUBLISHER, REDIS_SUBSCRIBER],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onApplicationShutdown() {
    // `quit` drains in-flight commands; `disconnect` would drop them.
    await Promise.allSettled([this.client.quit(), this.publisher.quit(), this.subscriber.quit()]);
  }
}
