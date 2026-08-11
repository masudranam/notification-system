import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import { AppConfig } from 'src/config/configuration';
import {
  PermanentProviderError,
  RetryableProviderError,
  classifyHttpStatus,
} from 'src/common/errors/provider.errors';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';
import { isE164, maskPhone } from './mock-sms.provider';

/**
 * Twilio SMS — off unless SMS_PROVIDER=twilio, because it costs real money.
 *
 * Written against the REST API with `fetch` rather than the `twilio` SDK: the whole call is one
 * form-encoded POST with basic auth, and skipping the SDK keeps the dependency tree small and
 * makes the HTTP shape visible for learning purposes.
 *
 * Twilio's error codes are the interesting part. They are numeric and stable, and the retry
 * decision depends on them rather than on the HTTP status — 21610 (recipient opted out via STOP)
 * arrives as a 400 but legally means *never message this number again*, which is a suppression,
 * not a failure.
 */
@Injectable()
export class TwilioProvider implements ChannelProvider {
  readonly name = 'twilio';
  readonly channel = Channel.SMS;

  private readonly logger = new Logger(TwilioProvider.name);
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    const sms = config.get('sms', { infer: true });
    this.accountSid = sms.twilioAccountSid;
    this.authToken = sms.twilioAuthToken;
    this.from = sms.twilioFrom;
    this.enabled =
      sms.provider === 'twilio' && Boolean(this.accountSid && this.authToken && this.from);

    if (sms.provider === 'twilio' && !this.enabled) {
      this.logger.warn('SMS_PROVIDER=twilio but credentials are incomplete — Twilio is disabled');
    }
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    if (!isE164(ctx.address)) {
      throw new PermanentProviderError(
        `"${ctx.address}" is not a valid E.164 phone number`,
        this.name,
        true,
      );
    }

    const body = new URLSearchParams({
      To: ctx.address,
      From: this.from,
      Body: message.body,
    });

    let response: Response;
    try {
      response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (err) {
      throw new RetryableProviderError(
        `Twilio request failed: ${(err as Error).message}`,
        this.name,
        undefined,
        err,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      code?: number;
      message?: string;
    };

    if (!response.ok) {
      throw this.translate(response.status, payload);
    }

    this.logger.log(`Twilio SMS queued to ${maskPhone(ctx.address)} (sid=${payload.sid})`);
    return { providerMessageId: payload.sid, meta: { status: payload.status } };
  }

  private translate(status: number, payload: { code?: number; message?: string }): Error {
    const message = `Twilio ${payload.code ?? status}: ${payload.message ?? 'send failed'}`;

    switch (payload.code) {
      // Permanent, and the number should be suppressed.
      case 21211: // invalid 'To' number
      case 21614: // 'To' is not a valid mobile number
      case 21610: // recipient sent STOP — messaging them again is a compliance violation
        return new PermanentProviderError(message, this.name, true);

      // Permanent configuration problems.
      case 21212: // invalid 'From' number
      case 21606: // 'From' is not SMS-capable
      case 21408: // no permission to send to this region
        return new PermanentProviderError(message, this.name);

      // Transient.
      case 20429: // too many requests
      case 30001: // queue overflow
      case 30002: // account suspended (often temporary billing state)
        return new RetryableProviderError(message, this.name, 2_000);

      default:
        return classifyHttpStatus(status, this.name, message);
    }
  }
}
