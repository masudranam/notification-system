import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import { AppConfig } from 'src/config/configuration';

/**
 * Reports which channels are actually configured, and never fails the health check.
 *
 * This is deliberately a "report", not a "check": a missing SLACK_WEBHOOK_URL means Slack
 * deliveries get SKIPPED, which is a degraded mode, not an outage. Failing readiness here would
 * take the whole service down over one optional integration.
 */
@Injectable()
export class ProvidersHealthIndicator extends HealthIndicator {
  constructor(private readonly config: ConfigService<AppConfig, true>) {
    super();
  }

  async report(key: string): Promise<HealthIndicatorResult> {
    const resend = this.config.get('resend', { infer: true });
    const vapid = this.config.get('vapid', { infer: true });
    const slack = this.config.get('slack', { infer: true });
    const sms = this.config.get('sms', { infer: true });
    const smtp = this.config.get('smtp', { infer: true });

    return this.getStatus(key, true, {
      mode: this.config.get('providerMode', { infer: true }),
      email: resend.apiKey ? 'resend' : smtp.url ? 'smtp-only' : 'unconfigured',
      emailWebhooks: resend.webhookSecret ? 'signed' : 'unverified',
      push: vapid.publicKey && vapid.privateKey ? 'configured' : 'unconfigured',
      slack: slack.webhookUrl ? 'configured' : 'unconfigured',
      sms: sms.provider === 'twilio' && sms.twilioAccountSid ? 'twilio' : 'mock',
    });
  }
}
