import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Interval } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { QUEUE } from 'src/queue/queue.constants';
import { PrismaService } from 'src/prisma/prisma.service';
import { MetricsService } from './metrics.service';

/**
 * Samples queue depth and outbox lag on a timer.
 *
 * These are the two leading indicators of trouble: a rising queue depth means workers cannot keep
 * up with producers, and a rising outbox count means the relay itself is stuck (which is worse —
 * nothing is even reaching the queue).
 */
@Injectable()
export class QueueDepthCollector {
  private readonly logger = new Logger(QueueDepthCollector.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {}

  @Interval(10_000)
  async sample() {
    try {
      for (const name of Object.values(QUEUE)) {
        const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
        const counts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        for (const [state, count] of Object.entries(counts)) {
          this.metrics.queueDepth.set({ queue: name, state }, count ?? 0);
        }
      }

      const pending = await this.prisma.outboxEvent.count({ where: { processedAt: null } });
      this.metrics.outboxLag.set(pending);
    } catch (err) {
      // Never let metrics collection escalate into an application failure.
      this.logger.warn(`Queue depth sample failed: ${(err as Error).message}`);
    }
  }
}
