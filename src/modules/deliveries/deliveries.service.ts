import { Injectable, Logger } from '@nestjs/common';
import { Channel, Delivery, DeliveryStatus, NotificationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { applyStatus, isSuccessful, timestampFieldFor } from './delivery-status';

export interface StatusUpdate {
  status: DeliveryStatus;
  provider?: string;
  providerMessageId?: string;
  reason?: string;
  lastError?: string;
  occurredAt?: Date;
  /** Extra context stored on the audit event, not on the delivery row. */
  eventType?: string;
  eventPayload?: Prisma.InputJsonValue;
}

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Advances a delivery's status, honouring the monotonic state machine.
   *
   * The read-modify-write is wrapped in a transaction with a row lock. Two things can race here:
   * a worker writing SENT and a webhook writing DELIVERED for the same delivery, arriving within
   * milliseconds of each other. Without the lock both read `QUEUED`, both consider their
   * transition valid, and the later write wins by luck rather than by rank.
   *
   * An audit event is appended even when the status does not change — knowing that a late
   * `email.sent` arrived and was *correctly ignored* is exactly the information you want when
   * reconstructing what happened.
   */
  async updateStatus(deliveryId: string, update: StatusUpdate): Promise<Delivery | null> {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: DeliveryStatus; channel: Channel }>>`
        SELECT status, channel FROM deliveries WHERE id = ${deliveryId} FOR UPDATE
      `;
      const current = rows[0];
      if (!current) {
        this.logger.warn(`updateStatus for unknown delivery ${deliveryId}`);
        return null;
      }

      const decision = applyStatus(current.status, update.status);

      const data: Prisma.DeliveryUpdateInput = {
        ...(update.provider ? { provider: update.provider } : {}),
        ...(update.providerMessageId ? { providerMessageId: update.providerMessageId } : {}),
        ...(update.reason ? { reason: update.reason } : {}),
        ...(update.lastError !== undefined ? { lastError: update.lastError } : {}),
      };

      if (decision.changed) {
        data.status = decision.status;
        const field = timestampFieldFor(decision.status);
        if (field) data[field] = update.occurredAt ?? new Date();
      }

      const updated = await tx.delivery.update({ where: { id: deliveryId }, data });

      await tx.deliveryEvent.create({
        data: {
          deliveryId,
          type: update.eventType ?? update.status.toLowerCase(),
          occurredAt: update.occurredAt ?? new Date(),
          payload: {
            ...(update.eventPayload as object | undefined),
            from: current.status,
            to: update.status,
            applied: decision.changed,
            ...(update.reason ? { reason: update.reason } : {}),
            ...(update.lastError ? { error: update.lastError } : {}),
          } as Prisma.InputJsonValue,
        },
      });

      if (!decision.changed) {
        this.logger.debug(
          `Ignored out-of-order transition ${current.status} -> ${update.status} for ${deliveryId}`,
        );
      }

      return { delivery: updated, changed: decision.changed, channel: current.channel };
    });

    if (!result) return null;

    if (result.changed) {
      this.metrics.recordDelivery(result.channel, update.status);
      // Parent rollup runs outside the transaction: it is a derived value, and holding locks on
      // every sibling delivery just to compute it would serialise the whole fan-out.
      await this.rollUpNotificationStatus(result.delivery.notificationId);
    }

    return result.delivery;
  }

  /**
   * Stores exactly what was rendered.
   *
   * Worth persisting rather than re-rendering on demand: templates are versioned and data can
   * change, so this is the only record of what the user actually saw. The in-app inbox reads
   * these columns directly instead of rendering at read time.
   */
  async saveRendered(
    deliveryId: string,
    rendered: { subject?: string; body: string; templateVersion: number },
  ): Promise<void> {
    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        renderedSubject: rendered.subject ?? null,
        renderedBody: rendered.body,
        templateVersion: rendered.templateVersion,
      },
    });
  }

  async incrementAttempts(deliveryId: string): Promise<number> {
    const updated = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  /**
   * Derives the parent notification's status from its deliveries.
   *
   * COMPLETED only when every delivery reached a good terminal state; PARTIAL when some worked and
   * some did not; FAILED when none did. This is what a support dashboard filters on, so it has to
   * be a stored column rather than something recomputed per query.
   */
  async rollUpNotificationStatus(notificationId: string): Promise<NotificationStatus> {
    const deliveries = await this.prisma.delivery.findMany({
      where: { notificationId },
      select: { status: true },
    });

    if (deliveries.length === 0) return NotificationStatus.DISPATCHED;

    const pending = deliveries.filter(
      (d) => d.status === DeliveryStatus.QUEUED || d.status === DeliveryStatus.RENDERED,
    ).length;
    const succeeded = deliveries.filter((d) => isSuccessful(d.status)).length;

    let status: NotificationStatus;
    if (pending > 0) {
      status = NotificationStatus.DISPATCHED;
    } else if (succeeded === deliveries.length) {
      status = NotificationStatus.COMPLETED;
    } else if (succeeded > 0) {
      status = NotificationStatus.PARTIAL;
    } else {
      status = NotificationStatus.FAILED;
    }

    await this.prisma.notification.update({ where: { id: notificationId }, data: { status } });
    return status;
  }

  /** Resolves the delivery a provider webhook refers to. */
  async findByProviderMessageId(providerMessageId: string) {
    return this.prisma.delivery.findUnique({
      where: { providerMessageId },
      include: { notification: { select: { id: true, userId: true, topicKey: true } } },
    });
  }

  async findById(id: string) {
    return this.prisma.delivery.findUnique({
      where: { id },
      include: {
        notification: {
          include: {
            user: true,
            topic: true,
          },
        },
      },
    });
  }
}
