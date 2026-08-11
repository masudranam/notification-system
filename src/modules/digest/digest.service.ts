import { Injectable, Logger } from '@nestjs/common';
import { Channel, DeliveryStatus, DigestMode, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { DeliveriesService } from 'src/modules/deliveries/deliveries.service';

export interface DigestItem {
  topicKey: string;
  subject: string;
  body: string;
  at: string;
  notificationId: string;
}

export interface AddToBucketInput {
  userId: string;
  channel: Channel;
  window: DigestMode;
  deliveryId: string;
  notificationId: string;
}

/**
 * Digest batching.
 *
 * The problem it solves: a busy thread generates forty "you were mentioned" events in an hour.
 * Sending forty emails is worse than sending none — the user mutes the whole channel, and your
 * complaint rate climbs. Batching collapses them into one summary.
 *
 * Design notes:
 *  - An *open* bucket is one with `flushedAt IS NULL`. Items append to it; the scheduler closes it
 *    and renders a single summary notification.
 *  - Items are stored denormalised (subject/body already rendered) rather than as a list of
 *    notification ids. The summary must reflect what the event said *at the time*, and templates
 *    are versioned — re-rendering an hour later could produce different text.
 *  - The individual delivery is marked SUPPRESSED with a "batched into digest" reason rather than
 *    left QUEUED, so the trace explains why no email went out for it.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: DeliveriesService,
  ) {}

  async addToBucket(input: AddToBucketInput): Promise<void> {
    const { userId, channel, window, deliveryId, notificationId } = input;

    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: { topicKey: true, data: true, createdAt: true },
    });
    if (!notification) return;

    // Render a short line for the summary. Falls back to the topic key if the in-app template
    // is missing — a digest with a plain label beats no digest at all.
    const item: DigestItem = {
      topicKey: notification.topicKey,
      subject: summarise(notification.topicKey, notification.data),
      body: '',
      at: notification.createdAt.toISOString(),
      notificationId,
    };

    await this.prisma.$transaction(async (tx) => {
      const open = await tx.digestBucket.findFirst({
        where: { userId, channel, window, flushedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      if (open) {
        const items = [...((open.items as unknown as DigestItem[]) ?? []), item];
        await tx.digestBucket.update({
          where: { id: open.id },
          data: { items: items as unknown as Prisma.InputJsonValue },
        });
      } else {
        await tx.digestBucket.create({
          data: {
            userId,
            channel,
            window,
            items: [item] as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });

    await this.deliveries.updateStatus(deliveryId, {
      status: DeliveryStatus.SUPPRESSED,
      reason: `batched into ${window.toLowerCase()} digest`,
      eventType: 'digest.batched',
      eventPayload: { window, channel },
    });

    this.logger.debug(`Batched ${notificationId} into ${window} ${channel} digest for ${userId}`);
  }

  /**
   * Claims every bucket that is due, marking it flushed inside the same transaction.
   *
   * Marking before sending is deliberate: if the send then fails, we lose one digest rather than
   * risk sending the same summary repeatedly to a user whose provider is flaky. For a digest —
   * inherently a convenience — at-most-once is the right trade.
   */
  async claimDueBuckets(window: DigestMode, limit = 100) {
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.digestBucket.findMany({
        where: { window, flushedAt: null },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: { user: true },
      });
      if (due.length === 0) return [];

      await tx.digestBucket.updateMany({
        where: { id: { in: due.map((b) => b.id) } },
        data: { flushedAt: new Date() },
      });
      return due;
    });
  }

  async stats(userId?: string) {
    return this.prisma.digestBucket.findMany({
      where: { flushedAt: null, ...(userId ? { userId } : {}) },
      select: { id: true, userId: true, channel: true, window: true, items: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}

/** One-line label for a digest entry, derived from the payload's most identifying field. */
function summarise(topicKey: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const candidates = ['headline', 'subject', 'title', 'excerpt', 'orderId', 'name'];
  for (const key of candidates) {
    const value = d[key];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 120 ? `${value.slice(0, 119)}…` : value;
    }
  }
  return topicKey;
}
