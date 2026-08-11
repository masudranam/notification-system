import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { DeliveriesService } from 'src/modules/deliveries/deliveries.service';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { UnsubscribeService } from 'src/modules/preferences/unsubscribe.service';
import { SuppressionService } from 'src/modules/suppression/suppression.service';
import { TemplateService } from 'src/modules/templates/template.service';
import { QUEUE } from 'src/queue/queue.constants';
import { WORKER_SETTINGS } from 'src/queue/backoff';
import { BaseChannelProcessor } from '../shared/base-channel.processor';
import { CircuitBreakerService } from '../shared/circuit-breaker.service';
import { ResendProvider } from './resend.provider';
import { SmtpProvider } from './smtp.provider';

/**
 * Email worker.
 *
 * `limiter` is the important line: Resend's documented cap is 10 requests/second per team, and
 * exceeding it earns 429s that turn into retries and latency. BullMQ's limiter is enforced across
 * every worker sharing the queue, so this holds even with several instances running — a per-process
 * rate limiter would not.
 *
 * Concurrency is 5 while the limiter allows 8/sec: concurrency bounds in-flight requests, the
 * limiter bounds the rate. Both are needed — 5 concurrent slow requests could otherwise still
 * burst above the rate when they all return at once.
 */
@Injectable()
@Processor(QUEUE.EMAIL, {
  ...WORKER_SETTINGS,
  concurrency: 5,
  limiter: { max: 8, duration: 1000 },
})
export class EmailProcessor extends BaseChannelProcessor {
  protected readonly channel = Channel.EMAIL;

  constructor(
    private readonly resend: ResendProvider,
    private readonly smtp: SmtpProvider,
    deliveries: DeliveriesService,
    templates: TemplateService,
    suppression: SuppressionService,
    breaker: CircuitBreakerService,
    metrics: MetricsService,
    unsubscribe: UnsubscribeService,
  ) {
    super({ deliveries, templates, suppression, breaker, metrics, unsubscribe });
  }

  /** Resend first, SMTP as failover. Order here is the failover order. */
  protected providers() {
    return [this.resend, this.smtp];
  }
}
