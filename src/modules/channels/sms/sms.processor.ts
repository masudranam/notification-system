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
import { MockSmsProvider } from './mock-sms.provider';
import { TwilioProvider } from './twilio.provider';

@Injectable()
@Processor(QUEUE.SMS, {
  ...WORKER_SETTINGS,
  concurrency: 5,
  // Twilio's default long-code throughput is 1 message/sec; this is deliberately conservative.
  limiter: { max: 5, duration: 1000 },
})
export class SmsProcessor extends BaseChannelProcessor {
  protected readonly channel = Channel.SMS;

  constructor(
    private readonly mock: MockSmsProvider,
    private readonly twilio: TwilioProvider,
    deliveries: DeliveriesService,
    templates: TemplateService,
    suppression: SuppressionService,
    breaker: CircuitBreakerService,
    metrics: MetricsService,
    unsubscribe: UnsubscribeService,
  ) {
    super({ deliveries, templates, suppression, breaker, metrics, unsubscribe });
  }

  /**
   * Exactly one of these reports itself configured, decided by SMS_PROVIDER — so this is a
   * provider *switch*, not a failover chain. Falling back from Twilio to a mock would be worse
   * than failing: it would report success for a message nobody received.
   */
  protected providers() {
    return [this.twilio, this.mock];
  }
}
