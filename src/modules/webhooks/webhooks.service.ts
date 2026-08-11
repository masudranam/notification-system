import { Injectable, Logger } from '@nestjs/common';
import { Channel, DeliveryStatus, Prisma, SuppressionReason } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { DeliveriesService } from 'src/modules/deliveries/deliveries.service';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { SuppressionService } from 'src/modules/suppression/suppression.service';
import { RESEND_EVENT_STATUS, ResendWebhookBody, isHardBounce } from './resend-events';

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unmatched';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: DeliveriesService,
    private readonly suppression: SuppressionService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Processes one Resend event.
   *
   * `eventId` is the svix message id and the primary key of `webhook_events`, which is what makes
   * this idempotent. Providers retry webhooks aggressively — on any non-2xx, on a timeout, and
   * sometimes just because — so the same `email.opened` can arrive three times. Inserting the id
   * first and treating a unique-violation as "already handled" is cheaper and more reliable than
   * trying to make each individual side effect idempotent.
   */
  async handleResendEvent(
    eventId: string,
    body: ResendWebhookBody,
  ): Promise<{ outcome: WebhookOutcome; deliveryId?: string }> {
    // Claim the event id. A duplicate delivery loses the race here and exits.
    try {
      await this.prisma.webhookEvent.create({
        data: {
          id: eventId,
          provider: 'resend',
          type: body.type,
          payload: body as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        this.metrics.webhooksReceived.inc({
          provider: 'resend',
          type: body.type,
          outcome: 'duplicate',
        });
        this.logger.debug(`Duplicate webhook ${eventId} (${body.type}) ignored`);
        return { outcome: 'duplicate' };
      }
      throw err;
    }

    const outcome = await this.applyResendEvent(eventId, body);
    this.metrics.webhooksReceived.inc({
      provider: 'resend',
      type: body.type,
      outcome: outcome.outcome,
    });
    return outcome;
  }

  private async applyResendEvent(
    eventId: string,
    body: ResendWebhookBody,
  ): Promise<{ outcome: WebhookOutcome; deliveryId?: string }> {
    const emailId = body.data?.email_id;
    if (!emailId) {
      await this.markProcessed(eventId, 'no email_id in payload');
      return { outcome: 'ignored' };
    }

    const delivery = await this.deliveries.findByProviderMessageId(emailId);
    if (!delivery) {
      // Genuinely common in development: an email sent before the DB was reset, or a webhook for
      // a message sent from the Resend dashboard. Recorded, not an error.
      await this.markProcessed(eventId, `no delivery for provider message ${emailId}`);
      this.logger.debug(`Webhook ${body.type} for unknown message ${emailId}`);
      return { outcome: 'unmatched' };
    }

    const status = RESEND_EVENT_STATUS[body.type];
    // The provider's own timestamp, not ours — this is when the event actually happened, and using
    // receipt time would misorder anything that sat in a retry queue.
    const occurredAt = body.created_at ? new Date(body.created_at) : new Date();

    if (status === null || status === undefined) {
      // Informational event: append to the audit trail without touching the status.
      await this.prisma.deliveryEvent.create({
        data: {
          deliveryId: delivery.id,
          type: body.type,
          occurredAt,
          payload: (body.data ?? {}) as Prisma.InputJsonValue,
        },
      });
      await this.markProcessed(eventId);
      return { outcome: 'ignored', deliveryId: delivery.id };
    }

    // The monotonic state machine inside updateStatus decides whether this actually applies —
    // an `email.sent` arriving after `email.delivered` is recorded and discarded.
    await this.deliveries.updateStatus(delivery.id, {
      status,
      eventType: body.type,
      occurredAt,
      eventPayload: (body.data ?? {}) as Prisma.InputJsonValue,
      ...(status === DeliveryStatus.BOUNCED || status === DeliveryStatus.FAILED
        ? { lastError: body.data?.bounce?.message ?? body.type }
        : {}),
    });

    await this.applySuppression(body, status);
    await this.markProcessed(eventId);

    this.logger.log(`Resend ${body.type} -> delivery ${delivery.id} (${status})`, 'Webhook');

    return { outcome: 'processed', deliveryId: delivery.id };
  }

  /**
   * Feeds bounces and complaints into the suppression list.
   *
   * This is the loop that protects sender reputation: the provider tells us an address is bad, and
   * we stop trying it before the next send. Skipping this step is how an account gets throttled or
   * terminated for a high bounce rate.
   */
  private async applySuppression(body: ResendWebhookBody, status: DeliveryStatus) {
    const recipients = body.data?.to ?? [];
    if (recipients.length === 0) return;

    for (const address of recipients) {
      if (status === DeliveryStatus.BOUNCED && isHardBounce(body)) {
        await this.suppression.add(
          Channel.EMAIL,
          address,
          SuppressionReason.HARD_BOUNCE,
          body.data?.bounce?.message ?? 'hard bounce reported by Resend',
        );
      } else if (status === DeliveryStatus.COMPLAINED) {
        // A spam complaint is the strongest possible signal. Never mail this address again.
        await this.suppression.add(
          Channel.EMAIL,
          address,
          SuppressionReason.SPAM_COMPLAINT,
          'recipient marked the message as spam',
        );
      } else if (status === DeliveryStatus.BOUNCED) {
        this.logger.log(
          `Soft bounce for ${address} (${body.data?.bounce?.type}) — not suppressing`,
        );
      }
    }
  }

  private async markProcessed(eventId: string, error?: string) {
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date(), ...(error ? { error } : {}) },
    });
  }

  /** Recent webhook history, for the demo UI and for debugging. */
  async recent(limit = 50) {
    return this.prisma.webhookEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        provider: true,
        type: true,
        receivedAt: true,
        processedAt: true,
        error: true,
      },
    });
  }
}
