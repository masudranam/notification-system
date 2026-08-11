import { WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Channel, DeliveryStatus, SuppressionReason } from '@prisma/client';
import { Job } from 'bullmq';
import { runWithCorrelationId } from 'src/common/correlation/correlation.store';
import {
  CircuitOpenError,
  PermanentProviderError,
  RetryableProviderError,
} from 'src/common/errors/provider.errors';
import { DeliveriesService } from 'src/modules/deliveries/deliveries.service';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { SuppressionService } from 'src/modules/suppression/suppression.service';
import { TemplateService } from 'src/modules/templates/template.service';
import { SendDeliveryJobData } from 'src/queue/queue.constants';
import { UnsubscribeService } from 'src/modules/preferences/unsubscribe.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ChannelProvider, SendContext } from './channel-provider.interface';

export interface ChannelProcessorDeps {
  deliveries: DeliveriesService;
  templates: TemplateService;
  suppression: SuppressionService;
  breaker: CircuitBreakerService;
  metrics: MetricsService;
  unsubscribe: UnsubscribeService;
}

/**
 * The shared send pipeline for every channel.
 *
 * Subclasses supply an ordered list of providers and nothing else. This class owns:
 *   render -> breaker -> send -> status update -> error classification -> failover.
 *
 * Keeping all of that in one place is what makes "add SMS" a 60-line adapter instead of a new
 * worker with its own subtly different retry semantics.
 */
export abstract class BaseChannelProcessor extends WorkerHost {
  protected abstract readonly channel: Channel;
  /**
   * Providers in preference order. Index 0 is primary; later entries are failover targets tried
   * only when the earlier one fails with a *retryable* error — a permanently invalid address will
   * fail identically on every provider, so failing over would just multiply the damage.
   */
  protected abstract providers(): ChannelProvider[];

  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly deps: ChannelProcessorDeps) {
    super();
  }

  async process(job: Job<SendDeliveryJobData>) {
    return runWithCorrelationId(job.data.correlationId, () => this.handle(job));
  }

  private async handle(job: Job<SendDeliveryJobData>) {
    const { deliveryId } = job.data;

    const delivery = await this.deps.deliveries.findById(deliveryId);
    if (!delivery) {
      this.logger.warn(`Send job for unknown delivery ${deliveryId}`);
      return { skipped: true };
    }

    // A delivery can reach a terminal state between enqueue and pickup — e.g. the address was
    // suppressed by a bounce on a sibling notification while this job waited in the queue.
    if (
      delivery.status !== DeliveryStatus.QUEUED &&
      delivery.status !== DeliveryStatus.RENDERED &&
      delivery.status !== DeliveryStatus.FAILED
    ) {
      this.logger.debug(`Delivery ${deliveryId} already ${delivery.status}; not sending`);
      return { skipped: true, status: delivery.status };
    }

    const { notification } = delivery;
    const { user, topic } = notification;

    const available = this.providers().filter((p) => p.isConfigured());
    if (available.length === 0) {
      // No credentials is a configuration gap, not a delivery failure — SKIPPED keeps it out of
      // the failure metrics and out of the DLQ.
      await this.deps.deliveries.updateStatus(deliveryId, {
        status: DeliveryStatus.SKIPPED,
        reason: `no configured provider for ${this.channel}`,
        eventType: 'send.skipped',
      });
      this.logger.warn(`No configured provider for ${this.channel}; skipped ${deliveryId}`);
      return { skipped: true };
    }

    const address = this.addressFor(delivery);
    if (!address) {
      await this.deps.deliveries.updateStatus(deliveryId, {
        status: DeliveryStatus.SKIPPED,
        reason: `no ${this.channel} address for user`,
        eventType: 'send.skipped',
      });
      return { skipped: true };
    }

    // --- render ---------------------------------------------------------------------
    const data = (notification.data ?? {}) as Record<string, unknown>;
    const unsubscribeUrl =
      topic.category === 'MARKETING'
        ? this.deps.unsubscribe.buildUrl({
            userId: user.id,
            topicKey: topic.key,
            channel: this.channel,
          })
        : undefined;

    let rendered;
    try {
      rendered = await this.deps.templates.render(topic.key, this.channel, user.locale, {
        ...data,
        unsubscribeUrl,
        userName: user.email?.split('@')[0] ?? '',
      });
    } catch (err) {
      // A missing or broken template is permanent: retrying cannot conjure one into existence.
      await this.deps.deliveries.updateStatus(deliveryId, {
        status: DeliveryStatus.FAILED,
        reason: 'render failed',
        lastError: (err as Error).message,
        eventType: 'send.render_failed',
      });
      this.logger.error(`Render failed for ${deliveryId}: ${(err as Error).message}`);
      // Return rather than throw: there is nothing to retry, and throwing would burn 5 attempts
      // and then dead-letter a job that can never succeed.
      return { failed: true, permanent: true };
    }

    await this.deps.deliveries.updateStatus(deliveryId, {
      status: DeliveryStatus.RENDERED,
      eventType: 'send.rendered',
    });
    await this.deps.deliveries.saveRendered(deliveryId, rendered);

    const ctx: SendContext = {
      deliveryId,
      notificationId: notification.id,
      user,
      topic,
      address,
      data,
      unsubscribeUrl,
      correlationId: job.data.correlationId,
    };

    // --- send, with failover --------------------------------------------------------
    const attempts = await this.deps.deliveries.incrementAttempts(deliveryId);
    let lastRetryable: RetryableProviderError | undefined;

    for (const [index, provider] of available.entries()) {
      try {
        const result = await this.deps.breaker.execute(provider.name, () =>
          this.deps.metrics.timeSend(this.channel, provider.name, () =>
            provider.send(rendered, ctx),
          ),
        );

        await this.deps.deliveries.updateStatus(deliveryId, {
          status: DeliveryStatus.SENT,
          provider: provider.name,
          providerMessageId: result.providerMessageId,
          lastError: null as unknown as undefined,
          eventType: 'send.sent',
          eventPayload: { provider: provider.name, attempt: attempts, ...result.meta },
        });

        if (index > 0) {
          this.logger.warn(
            `Delivery ${deliveryId} sent via failover provider "${provider.name}" ` +
              `(primary "${available[0].name}" unavailable)`,
          );
        } else {
          this.logger.log(`Sent ${this.channel} delivery ${deliveryId} via ${provider.name}`);
        }

        return { sent: true, provider: provider.name, providerMessageId: result.providerMessageId };
      } catch (err) {
        if (err instanceof PermanentProviderError) {
          // Permanent: stop immediately. Do not try the next provider — the payload or address is
          // the problem, and every provider will reject it the same way.
          if (err.suppressAddress) {
            await this.deps.suppression.add(
              this.channel,
              address,
              SuppressionReason.HARD_BOUNCE,
              err.message,
            );
          }
          await this.deps.deliveries.updateStatus(deliveryId, {
            status: DeliveryStatus.FAILED,
            provider: provider.name,
            reason: 'permanent provider error',
            lastError: err.message,
            eventType: 'send.permanent_failure',
          });
          this.deps.metrics.recordDelivery(this.channel, DeliveryStatus.FAILED);
          this.logger.error(
            `Permanent failure for ${deliveryId} via ${provider.name}: ${err.message}`,
          );
          return { failed: true, permanent: true };
        }

        lastRetryable =
          err instanceof RetryableProviderError
            ? err
            : new RetryableProviderError((err as Error).message, provider.name, undefined, err);

        const viaBreaker = err instanceof CircuitOpenError ? ' (circuit open)' : '';
        this.logger.warn(
          `Provider "${provider.name}" failed for ${deliveryId}${viaBreaker}: ${lastRetryable.message}`,
        );
        // Fall through to the next provider in the chain.
      }
    }

    // Every provider failed with a retryable error.
    const error = lastRetryable ?? new RetryableProviderError('All providers failed', this.channel);
    const isFinalAttempt = (job.attemptsMade ?? 0) + 1 >= (job.opts.attempts ?? 1);

    await this.deps.deliveries.updateStatus(deliveryId, {
      status: isFinalAttempt ? DeliveryStatus.FAILED : DeliveryStatus.QUEUED,
      reason: isFinalAttempt ? 'retries exhausted' : 'retrying',
      lastError: error.message,
      eventType: isFinalAttempt ? 'send.exhausted' : 'send.retry',
      eventPayload: { attempt: attempts, attemptsMade: job.attemptsMade },
    });

    if (!isFinalAttempt) {
      this.deps.metrics.retries.inc({ channel: this.channel, provider: error.provider });
    }

    // Throwing hands control back to BullMQ, which applies the jittered backoff and — on the last
    // attempt — moves the job to `failed`, where the DLQ listener picks it up.
    throw error;
  }

  /** Where this channel sends to. Overridden by channels whose address is not on the user row. */
  protected addressFor(delivery: {
    notification: {
      user: {
        id: string;
        email: string | null;
        phone: string | null;
        slackChannelId: string | null;
      };
    };
  }): string | null {
    const { user } = delivery.notification;
    switch (this.channel) {
      case Channel.EMAIL:
        return user.email;
      case Channel.SMS:
        return user.phone;
      case Channel.SLACK:
        return user.slackChannelId;
      default:
        return user.id;
    }
  }
}
