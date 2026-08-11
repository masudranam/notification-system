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

/**
 * Slack incoming webhook.
 *
 * Free, no OAuth app, no token refresh: you create a webhook URL in Slack and POST JSON to it.
 * The trade-off is that the URL *is* the credential and it is bound to one channel, so this
 * provider ignores `ctx.address` for routing — a multi-workspace system would store a webhook URL
 * per user instead.
 *
 * The body uses Block Kit rather than plain `text` because blocks render consistently and let the
 * notification carry a context footer. Note Slack's own dialect quirks: links are `<url|label>`,
 * not markdown, and the field is `mrkdwn`, not `markdown`.
 */
@Injectable()
export class SlackProvider implements ChannelProvider {
  readonly name = 'slack';
  readonly channel = Channel.SLACK;

  private readonly logger = new Logger(SlackProvider.name);
  private readonly webhookUrl: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.webhookUrl = config.get('slack', { infer: true }).webhookUrl;
    if (!this.webhookUrl) {
      this.logger.warn('SLACK_WEBHOOK_URL is not set — the Slack provider is disabled');
    }
  }

  isConfigured(): boolean {
    return Boolean(this.webhookUrl);
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    if (!this.webhookUrl) {
      throw new PermanentProviderError('Slack webhook URL is not configured', this.name);
    }

    const body = {
      // `text` is the notification preview and the accessibility fallback for clients that cannot
      // render blocks. Omitting it produces a silent, empty push on mobile.
      text: message.subject ?? 'Notification',
      blocks: [
        ...(message.subject
          ? [
              {
                type: 'header',
                text: { type: 'plain_text', text: truncate(message.subject, 150), emoji: true },
              },
            ]
          : []),
        {
          type: 'section',
          text: { type: 'mrkdwn', text: truncate(message.body, 2900) },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `\`${ctx.topic.key}\` · delivery \`${ctx.deliveryId.slice(0, 8)}\``,
            },
          ],
        },
      ],
    };

    let response: Response;
    try {
      response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Network failure or timeout — no status to classify, so retry.
      throw new RetryableProviderError(
        `Slack request failed: ${(err as Error).message}`,
        this.name,
        undefined,
        err,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      // Slack returns a plain-text reason, not JSON: "invalid_payload", "no_service" (the webhook
      // was revoked), "channel_not_found".
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '1');
        throw new RetryableProviderError(
          `Slack rate limited: ${text}`,
          this.name,
          retryAfter * 1000,
        );
      }
      // A revoked or deleted webhook will never work again — retrying is pointless.
      if (text.includes('no_service') || text.includes('invalid_token')) {
        throw new PermanentProviderError(`Slack webhook is no longer valid: ${text}`, this.name);
      }
      throw classifyHttpStatus(response.status, this.name, `Slack: ${text}`);
    }

    // A successful incoming-webhook POST returns the literal body "ok" and no message id, so
    // there is nothing to correlate later.
    return { meta: { response: text } };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
