import { Module } from '@nestjs/common';
import { DeliveriesModule } from 'src/modules/deliveries/deliveries.module';
import { SuppressionModule } from 'src/modules/suppression/suppression.module';
import { TemplatesModule } from 'src/modules/templates/templates.module';
import { InAppProcessor } from './inapp/inapp.processor';
import { InAppProvider } from './inapp/inapp.provider';
import { InboxController } from './inapp/inbox.controller';
import { RealtimeService } from './inapp/realtime.service';
import { CircuitBreakerService } from './shared/circuit-breaker.service';
import { DlqListener } from './shared/dlq.listener';
import { DlqController } from './shared/dlq.controller';
import { EmailProcessor } from './email/email.processor';
import { ResendProvider } from './email/resend.provider';
import { SmtpProvider } from './email/smtp.provider';
import { PushProcessor } from './push/push.processor';
import { WebPushProvider } from './push/webpush.provider';
import { DevicesController } from './push/devices.controller';
import { SlackProcessor } from './slack/slack.processor';
import { SlackProvider } from './slack/slack.provider';
import { SmsProcessor } from './sms/sms.processor';
import { MockSmsProvider } from './sms/mock-sms.provider';
import { TwilioProvider } from './sms/twilio.provider';

/**
 * Every channel, its providers, and the shared machinery they run on.
 *
 * The pattern is uniform: one provider class per external service, one processor per channel that
 * lists its providers in preference order. Adding a channel means adding a provider + processor
 * here and a queue name in queue.constants.ts — nothing in the dispatch path changes.
 */
@Module({
  imports: [DeliveriesModule, TemplatesModule, SuppressionModule],
  controllers: [InboxController, DevicesController, DlqController],
  providers: [
    CircuitBreakerService,
    DlqListener,

    // in-app + realtime
    RealtimeService,
    InAppProvider,
    InAppProcessor,

    // email: Resend primary, SMTP failover
    ResendProvider,
    SmtpProvider,
    EmailProcessor,

    // web push
    WebPushProvider,
    PushProcessor,

    // slack
    SlackProvider,
    SlackProcessor,

    // sms
    MockSmsProvider,
    TwilioProvider,
    SmsProcessor,
  ],
  exports: [RealtimeService, CircuitBreakerService],
})
export class ChannelsModule {}
