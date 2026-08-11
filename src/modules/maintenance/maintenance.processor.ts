import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppConfig } from 'src/config/configuration';
import { PrismaService } from 'src/prisma/prisma.service';
import { JOB, QUEUE } from 'src/queue/queue.constants';
import { WORKER_SETTINGS } from 'src/queue/backoff';

/**
 * Housekeeping.
 *
 * `delivery_events` is append-only and grows fastest of any table — a single email with open and
 * click tracking produces six rows. Left alone it becomes the largest thing in the database and
 * slows down every trace query. Pruning is unglamorous and load-bearing.
 *
 * Processed outbox rows and long-dead push subscriptions get the same treatment.
 */
@Injectable()
@Processor(QUEUE.MAINTENANCE, { ...WORKER_SETTINGS, concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE.MAINTENANCE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    await this.queue.add(
      JOB.PRUNE_EVENTS,
      {},
      // 03:30 daily, off the top of the hour so it does not collide with the digest jobs.
      { repeat: { pattern: '30 3 * * *' }, jobId: 'maintenance-prune' },
    );
    this.logger.log('Registered daily retention job');
  }

  async process() {
    const retentionDays = this.config.get('tuning', { infer: true }).retentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const events = await this.prisma.deliveryEvent.deleteMany({
      where: { occurredAt: { lt: cutoff } },
    });

    // Only *processed* outbox rows. An unprocessed one is a notification nobody has sent yet —
    // deleting it would lose the work permanently.
    const outbox = await this.prisma.outboxEvent.deleteMany({
      where: { processedAt: { not: null, lt: cutoff } },
    });

    const webhooks = await this.prisma.webhookEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });

    // Push subscriptions disabled long enough that the user is clearly not coming back.
    const devices = await this.prisma.pushDevice.deleteMany({
      where: { disabledAt: { not: null, lt: cutoff } },
    });

    const flushedDigests = await this.prisma.digestBucket.deleteMany({
      where: { flushedAt: { not: null, lt: cutoff } },
    });

    this.logger.log(
      `Retention (older than ${retentionDays}d): ${events.count} events, ` +
        `${outbox.count} outbox, ${webhooks.count} webhooks, ${devices.count} devices, ` +
        `${flushedDigests.count} digest buckets`,
    );

    return {
      deliveryEvents: events.count,
      outboxEvents: outbox.count,
      webhookEvents: webhooks.count,
      pushDevices: devices.count,
      digestBuckets: flushedDigests.count,
    };
  }
}
