import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BACKOFF_JITTER, QUEUE } from './queue.constants';

const ALL_QUEUES = Object.values(QUEUE);

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('redisUrl') },
        // NOTE: the custom backoff strategy is NOT configurable here — BullMQ resolves it on the
        // Worker, not the Queue. See WORKER_SETTINGS in ./backoff.ts, spread into each @Processor.
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: BACKOFF_JITTER },
          // Keep a short window of completed jobs for debugging, then reclaim the memory.
          removeOnComplete: { age: 3600, count: 1000 },
          // Failed jobs are kept: they are the evidence trail for a provider incident.
          removeOnFail: { age: 24 * 3600, count: 5000 },
        },
      }),
    }),
    // Registering every queue here makes each one injectable anywhere via
    // @InjectQueue(QUEUE.X) and lets the metrics module report depth for all of them.
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  exports: [BullModule],
})
export class QueueModule {}
