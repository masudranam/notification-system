import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import * as nodemailer from 'nodemailer';
// Pooling options live on SMTPPool, not SMTPTransport — `pool: true` switches nodemailer to a
// different transport class internally.
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import { AppConfig } from 'src/config/configuration';
import { PermanentProviderError, RetryableProviderError } from 'src/common/errors/provider.errors';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';

/**
 * SMTP failover provider.
 *
 * Its job is to prove the failover path works, and to be the thing that keeps sending when the
 * primary API is down. Points at the docker-compose MailHog by default (browse it at
 * http://localhost:8025), so a "Resend is down" drill still produces a visible email.
 *
 * A real deployment would point this at a second transactional provider — the value of failover
 * comes from the two paths having *independent* failure modes, which a second API key on the same
 * vendor would not give you.
 */
@Injectable()
export class SmtpProvider implements ChannelProvider {
  readonly name = 'smtp';
  readonly channel = Channel.EMAIL;

  private readonly logger = new Logger(SmtpProvider.name);
  private transporter?: nodemailer.Transporter;
  private readonly from: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const smtp = config.get('smtp', { infer: true });
    this.from = smtp.from;
    if (smtp.url) {
      // nodemailer accepts a connection URL, but its second parameter is message *defaults*, not
      // transport options — so pooling and timeouts have to go into a parsed options object.
      this.transporter = nodemailer.createTransport(parseSmtpUrl(smtp.url));
    } else {
      this.logger.warn('SMTP_URL is not set — the SMTP failover provider is disabled');
    }
  }

  isConfigured(): boolean {
    return this.transporter !== undefined;
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    if (!this.transporter) {
      throw new PermanentProviderError('SMTP is not configured', this.name);
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: ctx.address,
        subject: message.subject ?? '(no subject)',
        html: message.body,
        text: message.text,
        headers: {
          'X-Entity-Ref-ID': ctx.deliveryId,
          ...(ctx.unsubscribeUrl
            ? {
                'List-Unsubscribe': `<${ctx.unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              }
            : {}),
        },
      });

      return {
        // SMTP message ids arrive wrapped in angle brackets; strip them so the value matches what
        // a webhook would report.
        providerMessageId: info.messageId?.replace(/^<|>$/g, ''),
        meta: { accepted: info.accepted, rejected: info.rejected, response: info.response },
      };
    } catch (err) {
      throw this.translate(err);
    }
  }

  /**
   * SMTP reply codes carry the retry decision in their first digit.
   *
   * 4xx is "try again later" (mailbox busy, greylisting, temporary local error) and 5xx is a
   * permanent rejection. 550 specifically means the mailbox does not exist, so the address should
   * be suppressed rather than retried forever.
   */
  private translate(err: unknown): Error {
    const error = err as { responseCode?: number; code?: string; message?: string };
    const message = `SMTP: ${error.message ?? 'send failed'}`;
    const code = error.responseCode;

    if (code === undefined) {
      // Socket-level failures (ECONNREFUSED, ETIMEDOUT) have no reply code at all.
      return new RetryableProviderError(message, this.name, undefined, err);
    }
    if (code >= 400 && code < 500) {
      return new RetryableProviderError(message, this.name, undefined, err);
    }
    const suppress = code === 550 || code === 553;
    return new PermanentProviderError(message, this.name, suppress, err);
  }
}

/** Turns an `smtp://user:pass@host:port` URL into pooled transport options. */
export function parseSmtpUrl(url: string): SMTPPool.Options {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'smtps:';
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : secure ? 465 : 587,
    secure,
    ...(parsed.username
      ? {
          auth: {
            user: decodeURIComponent(parsed.username),
            pass: decodeURIComponent(parsed.password),
          },
        }
      : {}),
    // Pool connections: opening a TCP+TLS session per email is the main cost of SMTP.
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // MailHog and most local relays speak plaintext on 1025 with no certificate.
    ...(parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      ? { ignoreTLS: true, tls: { rejectUnauthorized: false } }
      : {}),
  };
}
