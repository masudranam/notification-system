import { Channel, Topic, User } from '@prisma/client';
import { RenderedMessage } from 'src/modules/templates/template.service';

export interface SendContext {
  deliveryId: string;
  notificationId: string;
  user: User;
  topic: Topic;
  /** Channel-specific destination: email address, phone number, Slack channel, or user id. */
  address: string;
  /** The producer's original payload, for providers that send structured data (push, Slack). */
  data: Record<string, unknown>;
  /** Signed one-click opt-out URL. Present for MARKETING topics only. */
  unsubscribeUrl?: string;
  correlationId: string;
}

export interface SendResult {
  /** Provider-side id, used to correlate later webhooks. Absent for channels with no callbacks. */
  providerMessageId?: string;
  /** Free-form provider response, stored on the audit event. */
  meta?: Record<string, unknown>;
}

/**
 * What every channel implementation must provide.
 *
 * The whole point of this interface is that the worker in `base-channel.processor.ts` knows
 * nothing about Resend, VAPID or Twilio — it renders, calls `send`, and interprets the thrown
 * error type. Adding a channel means writing one adapter, not touching the pipeline.
 *
 * Implementations must translate every failure into `RetryableProviderError` or
 * `PermanentProviderError` (see src/common/errors/provider.errors.ts). Leaking a raw provider
 * error would make the worker treat it as retryable by default and waste five attempts on a
 * permanently invalid address.
 */
export interface ChannelProvider {
  readonly name: string;
  readonly channel: Channel;

  /** False when credentials are missing, so deliveries are SKIPPED rather than failed. */
  isConfigured(): boolean;

  send(message: RenderedMessage, ctx: SendContext): Promise<SendResult>;
}

/** Token used to register the list of providers for a given channel. */
export const CHANNEL_PROVIDERS = 'CHANNEL_PROVIDERS';
