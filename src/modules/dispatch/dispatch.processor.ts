import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Channel, DeliveryStatus, DigestMode, NotificationStatus, Prisma } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { runWithCorrelationId } from 'src/common/correlation/correlation.store';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { DeliveriesService } from 'src/modules/deliveries/deliveries.service';
import { DigestService } from 'src/modules/digest/digest.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CHANNEL_QUEUE,
  DispatchJobData,
  JOB,
  QUEUE,
  SendDeliveryJobData,
} from 'src/queue/queue.constants';
import { WORKER_SETTINGS } from 'src/queue/backoff';
import { ChannelResolverService } from './channel-resolver.service';
import { QuietHoursService } from './quiet-hours.service';

/**
 * The fan-out worker: one notification in, N channel jobs out.
 *
 * This processor deliberately performs no network I/O. Everything it does is a database read, a
 * pure decision, or a queue push — so it can run at high concurrency and never blocks on a slow
 * provider. All the waiting happens in the per-channel workers downstream.
 */
@Injectable()
@Processor(QUEUE.DISPATCH, { ...WORKER_SETTINGS, concurrency: 10 })
export class DispatchProcessor extends WorkerHost {
  private readonly logger = new Logger(DispatchProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: ChannelResolverService,
    private readonly quietHours: QuietHoursService,
    private readonly deliveries: DeliveriesService,
    private readonly digest: DigestService,
    private readonly metrics: MetricsService,
    @InjectQueue(QUEUE.EMAIL) private readonly emailQueue: Queue<SendDeliveryJobData>,
    @InjectQueue(QUEUE.IN_APP) private readonly inAppQueue: Queue<SendDeliveryJobData>,
    @InjectQueue(QUEUE.PUSH) private readonly pushQueue: Queue<SendDeliveryJobData>,
    @InjectQueue(QUEUE.SLACK) private readonly slackQueue: Queue<SendDeliveryJobData>,
    @InjectQueue(QUEUE.SMS) private readonly smsQueue: Queue<SendDeliveryJobData>,
  ) {
    super();
  }

  async process(job: Job<DispatchJobData>): Promise<{ created: number; queued: number }> {
    // Re-open the correlation scope inside the worker so its logs join the originating request's
    // trace even though this runs in a different tick, possibly a different process.
    return runWithCorrelationId(job.data.correlationId, () => this.dispatch(job));
  }

  private async dispatch(job: Job<DispatchJobData>) {
    const { notificationId } = job.data;

    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        topic: true,
        user: { include: { devices: { where: { disabledAt: null }, select: { id: true } } } },
      },
    });

    if (!notification) {
      this.logger.warn(`Dispatch for missing notification ${notificationId}`);
      return { created: 0, queued: 0 };
    }

    // Guard against a double-relay: if deliveries already exist, this notification was dispatched
    // and re-running would duplicate every send.
    const existing = await this.prisma.delivery.count({ where: { notificationId } });
    if (existing > 0) {
      this.logger.warn(
        `Notification ${notificationId} already has ${existing} deliveries; skipping re-dispatch`,
      );
      return { created: 0, queued: 0 };
    }

    const decisions = await this.resolver.resolve({
      user: notification.user,
      topic: notification.topic,
      requestedChannels: notification.requestedChannels as Channel[],
    });

    if (decisions.length === 0) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.FAILED, dispatchedAt: new Date() },
      });
      this.logger.warn(`No channels resolved for ${notificationId}`);
      return { created: 0, queued: 0 };
    }

    // Quiet hours are evaluated once per notification, not per channel: a user's night-time is a
    // property of the user, and staggering channels would mean the push arrives at 7am but the
    // email at 7:04am for no reason.
    const quiet = this.quietHours.evaluate(notification.user, notification.topic.priority);
    if (quiet.deferred) {
      this.logger.log(
        `Deferring ${notificationId} by ${Math.round(quiet.delayMs / 60_000)}min — ${quiet.reason}`,
      );
    }

    // One transaction creates every Delivery row, so a partial fan-out can never be observed.
    const created = await this.prisma.$transaction(async (tx) => {
      const rows: Array<{ id: string; channel: Channel; action: string }> = [];

      for (const decision of decisions) {
        const isSend = decision.action === 'send';
        const isDigest = decision.action === 'digest';

        const status = isSend || isDigest ? DeliveryStatus.QUEUED : statusFor(decision.action);

        const delivery = await tx.delivery.create({
          data: {
            notificationId,
            channel: decision.channel,
            status,
            reason: 'reason' in decision ? decision.reason : null,
            ...(status === DeliveryStatus.SKIPPED || status === DeliveryStatus.SUPPRESSED
              ? { failedAt: new Date() }
              : {}),
          },
        });

        // Seed the audit trail immediately, including for rejected channels — "why did Bob not
        // get the email" is answerable from this row alone.
        await tx.deliveryEvent.create({
          data: {
            deliveryId: delivery.id,
            type: `dispatch.${decision.action}`,
            payload: {
              action: decision.action,
              ...('reason' in decision ? { reason: decision.reason } : {}),
              ...('digest' in decision ? { digest: decision.digest } : {}),
              ...(quiet.deferred ? { deferredMs: quiet.delayMs, quiet: quiet.reason } : {}),
            } as Prisma.InputJsonValue,
          },
        });

        rows.push({ id: delivery.id, channel: decision.channel, action: decision.action });
      }

      await tx.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.DISPATCHED, dispatchedAt: new Date() },
      });

      return rows;
    });

    // Metrics + queueing happen after the commit: enqueueing a job that references an uncommitted
    // delivery row would let a fast worker read it before it exists.
    let queued = 0;
    for (const row of created) {
      const decision = decisions.find((d) => d.channel === row.channel);
      if (!decision) continue;

      if (decision.action === 'skip' || decision.action === 'suppress') {
        this.metrics.suppressed.inc({ channel: row.channel, reason: decision.action });
        this.metrics.recordDelivery(row.channel, statusFor(decision.action));
        continue;
      }

      if (decision.action === 'digest') {
        // Batched: the item goes into the user's open bucket and the delivery is marked so the
        // trace shows why nothing was sent right now.
        await this.digest.addToBucket({
          userId: notification.userId,
          channel: row.channel,
          window: decision.digest as DigestMode,
          deliveryId: row.id,
          notificationId,
        });
        continue;
      }

      await this.enqueueChannel(
        row.channel,
        {
          deliveryId: row.id,
          notificationId,
          channel: row.channel,
          correlationId: notification.correlationId,
        },
        quiet.delayMs,
      );
      queued += 1;
    }

    // If nothing was queued, every channel resolved to a terminal state already — roll the parent
    // up now rather than leaving it DISPATCHED forever.
    if (queued === 0) {
      await this.deliveries.rollUpNotificationStatus(notificationId);
    }

    this.logger.log(
      `Dispatched ${notificationId}: ${created.length} deliveries, ${queued} queued ` +
        `(${decisions.map((d) => `${d.channel}=${d.action}`).join(' ')})`,
    );

    return { created: created.length, queued };
  }

  private async enqueueChannel(channel: Channel, data: SendDeliveryJobData, delayMs: number) {
    const queue = this.queueFor(channel);
    await queue.add(JOB.SEND_DELIVERY, data, {
      // One job per delivery row. If dispatch somehow runs twice, BullMQ dedupes on this id.
      // Hyphen, not colon: BullMQ rejects custom job ids containing its key separator.
      jobId: `send-${data.deliveryId}`,
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    });
  }

  private queueFor(channel: Channel): Queue<SendDeliveryJobData> {
    switch (channel) {
      case Channel.EMAIL:
        return this.emailQueue;
      case Channel.IN_APP:
        return this.inAppQueue;
      case Channel.PUSH:
        return this.pushQueue;
      case Channel.SLACK:
        return this.slackQueue;
      case Channel.SMS:
        return this.smsQueue;
      default:
        throw new Error(`No queue registered for channel ${channel} (${CHANNEL_QUEUE[channel]})`);
    }
  }
}

function statusFor(action: string): DeliveryStatus {
  return action === 'skip' ? DeliveryStatus.SKIPPED : DeliveryStatus.SUPPRESSED;
}
