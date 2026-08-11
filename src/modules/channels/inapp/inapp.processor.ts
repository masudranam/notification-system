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
import { InAppProvider } from './inapp.provider';

// High concurrency: this only writes to our own DB and publishes to Redis.
@Injectable()
@Processor(QUEUE.IN_APP, { ...WORKER_SETTINGS, concurrency: 20 })
export class InAppProcessor extends BaseChannelProcessor {
  protected readonly channel = Channel.IN_APP;

  constructor(
    private readonly inApp: InAppProvider,
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
    return [this.inApp];
  }
}
