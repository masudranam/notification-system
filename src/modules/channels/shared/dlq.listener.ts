import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { AppConfig } from 'src/config/configuration';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { DeadLetterJobData, JOB, QUEUE } from 'src/queue/queue.constants';

/**
 * Dead-letter capture.
 *
 * BullMQ has no built-in DLQ: a job that exhausts its attempts moves to the `failed` set and stays
 * there, invisible unless someone thinks to look. That is a poor place to leave a notification
 * nobody received.
 *
 * This listener watches every channel queue's `failed` event and, on the *final* attempt only,
 * copies the job into a dedicated `dlq` queue. That gives one place to answer "what did we lose
 * today?" and a replay endpoint to re-drive them once the underlying problem is fixed.
 *
 * `QueueEvents` is used rather than a `@OnWorkerEvent('failed')` hook because it reads from the
 * queue's Redis event stream — so it also catches failures from workers in *other* processes,
 * which is the case that matters when you scale out.
 */
@Injectable()
export class DlqListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DlqListener.name);
  private readonly listeners: QueueEvents[] = [];

  private static readonly WATCHED = [
    QUEUE.EMAIL,
    QUEUE.IN_APP,
    QUEUE.PUSH,
    QUEUE.SLACK,
    QUEUE.SMS,
    QUEUE.DISPATCH,
  ];

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
  ) {}

  async onApplicationBootstrap() {
    const connection = { url: this.config.get('redisUrl', { infer: true }) };

    for (const queueName of DlqListener.WATCHED) {
      const events = new QueueEvents(queueName, { connection });

      events.on('failed', async ({ jobId, failedReason }) => {
        try {
          await this.onFailed(queueName, jobId, failedReason);
        } catch (err) {
          this.logger.error(
            `DLQ capture failed for ${queueName}#${jobId}: ${(err as Error).message}`,
          );
        }
      });

      this.listeners.push(events);
    }

    this.logger.log(`Dead-letter listener watching: ${DlqListener.WATCHED.join(', ')}`);
  }

  async onModuleDestroy() {
    await Promise.allSettled(this.listeners.map((l) => l.close()));
  }

  private async onFailed(queueName: string, jobId: string, failedReason: string) {
    const queue = this.moduleRef.get<Queue>(getQueueToken(queueName), { strict: false });
    const job = await queue.getJob(jobId);
    if (!job) return;

    // The `failed` event fires on every attempt, including ones that will be retried. Only the
    // final attempt is a real dead letter.
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade < attemptsAllowed) return;

    const dlq = this.moduleRef.get<Queue<DeadLetterJobData>>(getQueueToken(QUEUE.DLQ), {
      strict: false,
    });

    await dlq.add(
      JOB.DEAD_LETTER,
      {
        queue: queueName,
        originalJobName: job.name,
        data: job.data,
        failedReason,
        attemptsMade: job.attemptsMade,
      },
      {
        // Dead letters are evidence, not work — never retry them automatically, and keep them
        // until someone deals with them.
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
        jobId: `dlq-${queueName}-${jobId}`,
      },
    );

    this.metrics.deadLettered.inc({ queue: queueName });
    this.logger.error(
      `Dead-lettered ${queueName}#${jobId} after ${job.attemptsMade} attempts: ${failedReason}`,
    );
  }
}
