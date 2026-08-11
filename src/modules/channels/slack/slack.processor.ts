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
import { SlackProvider } from './slack.provider';

// Slack incoming webhooks allow roughly one message per second per hook, with short bursts
// tolerated. The limiter keeps us inside that instead of collecting 429s.
@Injectable()
@Processor(QUEUE.SLACK, {
  ...WORKER_SETTINGS,
  concurrency: 5,
  limiter: { max: 1, duration: 1000 },
})
export class SlackProcessor extends BaseChannelProcessor {
  protected readonly channel = Channel.SLACK;

  constructor(
    private readonly slack: SlackProvider,
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
    return [this.slack];
  }
}
