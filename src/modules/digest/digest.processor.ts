import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DigestMode, NotificationStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { newCorrelationId } from 'src/common/correlation/correlation.store';
import { PrismaService } from 'src/prisma/prisma.service';
import { DispatchJobData, JOB, QUEUE } from 'src/queue/queue.constants';
import { WORKER_SETTINGS } from 'src/queue/backoff';
import { OUTBOX_EVENT } from 'src/modules/outbox/outbox.constants';
import { DigestItem, DigestService } from './digest.service';

const DIGEST_TOPIC = 'system.digest';

/**
 * Flushes digest buckets on a schedule.
 *
 * Uses BullMQ repeatable jobs rather than @nestjs/schedule cron. The difference matters when more
 * than one instance is running: `@Cron` fires on *every* instance, so three replicas would send
 * three copies of each digest. A repeatable job is stored in Redis and delivered to exactly one
 * worker.
 *
 * The flush produces a normal `system.digest` notification and lets the standard pipeline send it,
 * so digests get the same retries, templates, breaker and delivery tracking as anything else.
 */
@Injectable()
@Processor(QUEUE.DIGEST, { ...WORKER_SETTINGS, concurrency: 2 })
export class DigestProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(DigestProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: DigestService,
    @InjectQueue(QUEUE.DIGEST) private readonly digestQueue: Queue,
    @InjectQueue(QUEUE.DISPATCH) private readonly dispatchQueue: Queue<DispatchJobData>,
  ) {
    super();
  }

  async onApplicationBootstrap() {
    // Idempotent: re-registering the same repeatable job with the same key replaces it rather
    // than adding a second schedule.
    await this.digestQueue.add(
      JOB.FLUSH_DIGEST_SCAN,
      { window: DigestMode.HOURLY },
      { repeat: { pattern: '0 * * * *' }, jobId: 'digest-hourly' },
    );
    await this.digestQueue.add(
      JOB.FLUSH_DIGEST_SCAN,
      { window: DigestMode.DAILY },
      // 09:00 UTC. A real system would fan this out per-timezone so everyone gets a morning email.
      { repeat: { pattern: '0 9 * * *' }, jobId: 'digest-daily' },
    );
    this.logger.log('Registered hourly + daily digest schedules');
  }

  async process(job: Job<{ window: DigestMode }>) {
    const window = job.data.window;
    const buckets = await this.digest.claimDueBuckets(window);

    if (buckets.length === 0) {
      this.logger.debug(`No ${window} digest buckets due`);
      return { flushed: 0 };
    }

    let flushed = 0;
    for (const bucket of buckets) {
      const items = (bucket.items as unknown as DigestItem[]) ?? [];
      if (items.length === 0) continue;

      try {
        await this.sendDigest(bucket.userId, bucket.window, items);
        flushed += 1;
      } catch (err) {
        this.logger.error(`Failed to flush digest bucket ${bucket.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(`Flushed ${flushed}/${buckets.length} ${window} digest buckets`);
    return { flushed };
  }

  private async sendDigest(userId: string, window: DigestMode, items: DigestItem[]) {
    const correlationId = newCorrelationId();

    // Same transactional-outbox handoff the public ingest endpoint uses.
    const notification = await this.prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          userId,
          topicKey: DIGEST_TOPIC,
          data: {
            window: window.toLowerCase(),
            count: items.length,
            isSingular: items.length === 1,
            items: items.map((i) => ({ subject: i.subject, body: i.body || i.topicKey })),
          } as Prisma.InputJsonValue,
          correlationId,
          status: NotificationStatus.PENDING,
        },
      });

      await tx.outboxEvent.create({
        data: {
          type: OUTBOX_EVENT.NOTIFICATION_CREATED,
          payload: { notificationId: created.id, correlationId },
        },
      });

      return created;
    });

    this.logger.log(
      `Queued ${window} digest ${notification.id} for ${userId} (${items.length} items)`,
    );
  }
}
