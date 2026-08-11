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
import { WebPushProvider } from './webpush.provider';

// No limiter: browser push services are designed for high volume and impose no meaningful
// per-sender rate limit. Concurrency is high because each send is a short HTTP request.
@Injectable()
@Processor(QUEUE.PUSH, { ...WORKER_SETTINGS, concurrency: 20 })
export class PushProcessor extends BaseChannelProcessor {
  protected readonly channel = Channel.PUSH;

  constructor(
    private readonly webPush: WebPushProvider,
    deliveries: DeliveriesService,
    templates: TemplateService,
    suppression: SuppressionService,
    breaker: CircuitBreakerService,
    metrics: MetricsService,
    unsubscribe: UnsubscribeService,
  ) {
    super({ deliveries, templates, suppression, breaker, metrics, unsubscribe });
  }

  protected providers() {
    return [this.webPush];
  }
}
