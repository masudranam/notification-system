import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import { Resend } from 'resend';
import { AppConfig } from 'src/config/configuration';
import { PermanentProviderError, RetryableProviderError } from 'src/common/errors/provider.errors';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';

/**
 * Resend email provider.
 *
 * Free tier: 100 emails/day, 3,000/month, and a documented 10 requests/second per team — which is
 * why the email queue carries a limiter of 8/sec (see queue.constants.ts). Exceeding it returns
 * 429, which this provider classifies as retryable so the job simply comes back.
 *
 * Sandbox mode rewrites the recipient to one of Resend's test addresses so a learning project can
 * exercise the bounce and complaint paths without ever touching a real mailbox — and, importantly,
 * without accruing bounces against a real sending domain's reputation:
 *   delivered@resend.dev  -> accepted and delivered
 *   bounced@resend.dev    -> hard bounce (SMTP 550)
 *   complained@resend.dev -> delivered, then marked as spam
 */
@Injectable()
export class ResendProvider implements ChannelProvider {
  readonly name = 'resend';
  readonly channel = Channel.EMAIL;

  private readonly logger = new Logger(ResendProvider.name);
  private readonly client?: Resend;
  private readonly from: string;
  private readonly sandbox: boolean;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const resend = config.get('resend', { infer: true });
    this.from = resend.from;
    this.sandbox = config.get('providerMode', { infer: true }) === 'sandbox';
    if (resend.apiKey) {
      this.client = new Resend(resend.apiKey);
    } else {
      this.logger.warn('RESEND_API_KEY is not set — the Resend provider is disabled');
    }
  }

  isConfigured(): boolean {
    return this.client !== undefined;
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    if (!this.client) {
      throw new PermanentProviderError('Resend is not configured', this.name);
    }

    const to = this.resolveRecipient(ctx.address);

    const { data, error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: message.subject ?? '(no subject)',
      html: message.body,
      // Always include a text alternative: some clients prefer it, screen readers use it, and
      // HTML-only mail scores worse with spam filters.
      text: message.text,
      headers: {
        // Lets a recipient's mail client thread and report correctly, and gives us a stable
        // handle in provider logs.
        'X-Entity-Ref-ID': ctx.deliveryId,
        ...(ctx.unsubscribeUrl
          ? {
              // RFC 8058. With both headers present Gmail/Outlook render a native unsubscribe
              // button, which keeps users off the "mark as spam" path.
              'List-Unsubscribe': `<${ctx.unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            }
          : {}),
      },
      tags: [
        { name: 'topic', value: sanitizeTag(ctx.topic.key) },
        { name: 'delivery_id', value: sanitizeTag(ctx.deliveryId) },
      ],
    });

    if (error) {
      throw this.translate(error);
    }
    if (!data?.id) {
      // No id means we cannot correlate the webhook later; treat as retryable rather than
      // silently recording a send we can never confirm.
      throw new RetryableProviderError('Resend returned no message id', this.name);
    }

    return {
      providerMessageId: data.id,
      meta: { to, sandbox: this.sandbox },
    };
  }

  /**
   * In sandbox mode, map the real address onto a Resend test address.
   *
   * The `+label` suffix is preserved through Resend's test addresses, so the original recipient
   * stays visible in the dashboard for debugging.
   */
  private resolveRecipient(address: string): string {
    if (!this.sandbox) return address;

    const local = address.split('@')[0]?.replace(/[^a-zA-Z0-9._-]/g, '') || 'user';

    // Honour an explicit intent encoded in the address so the bounce/complaint paths are testable.
    if (address.includes('bounce')) return `bounced+${local}@resend.dev`;
    if (address.includes('complain') || address.includes('spam')) {
      return `complained+${local}@resend.dev`;
    }
    return `delivered+${local}@resend.dev`;
  }

  /**
   * Maps Resend's error names onto the retry taxonomy.
   *
   * The distinction is the whole game: `rate_limit_exceeded` must be retried, while
   * `validation_error` on a malformed address must not — retrying it five times just delays the
   * queue and produces the same failure.
   */
  private translate(error: { name?: string; message: string }): Error {
    const name = error.name ?? '';
    const message = `Resend: ${error.message}`;

    switch (name) {
      case 'rate_limit_exceeded':
      case 'too_many_requests':
        return new RetryableProviderError(message, this.name, 1_000);
      case 'application_error':
      case 'internal_server_error':
        return new RetryableProviderError(message, this.name);

      // Permanent, and the address itself is the problem — worth suppressing.
      case 'invalid_to_address':
        return new PermanentProviderError(message, this.name, true);

      // Permanent configuration or payload problems. Retrying changes nothing.
      case 'missing_required_field':
      case 'validation_error':
      case 'invalid_from_address':
      case 'invalid_access':
      case 'restricted_api_key':
      case 'missing_api_key':
      case 'invalid_api_key':
      case 'not_found':
      case 'daily_quota_exceeded':
        return new PermanentProviderError(message, this.name);

      default:
        // Unknown errors default to retryable: a transient failure that we drop is worse than a
        // permanent one we retry a few times.
        this.logger.warn(`Unmapped Resend error "${name}", treating as retryable`);
        return new RetryableProviderError(message, this.name);
    }
  }
}

/** Resend tags accept only ASCII letters, numbers, underscores and dashes. */
function sanitizeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256);
}
