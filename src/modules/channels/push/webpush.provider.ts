import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import * as webpush from 'web-push';
import { AppConfig } from 'src/config/configuration';
import { PermanentProviderError, RetryableProviderError } from 'src/common/errors/provider.errors';
import { PrismaService } from 'src/prisma/prisma.service';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';

/**
 * Web Push via VAPID.
 *
 * Completely free and vendor-free: VAPID (RFC 8292) lets you authenticate directly to whatever
 * push service the browser chose (FCM for Chrome, Mozilla autopush for Firefox, APNs for Safari)
 * using your own keypair. No Firebase project, no account.
 *
 * Two things make this channel different from the others:
 *
 * 1. **Fan-out inside the provider.** A "recipient" is a user, but a user has N browser
 *    subscriptions. One Delivery row therefore maps to N HTTP requests, and the send is treated as
 *    successful if *any* subscription accepted it — one dead laptop should not fail the delivery
 *    to a working phone.
 *
 * 2. **Subscriptions expire, and saying so is the push service's job.** `404`/`410` means the
 *    subscription is permanently gone (browser uninstalled, user cleared site data). Those must be
 *    pruned or you accumulate dead endpoints and waste a request on each one forever.
 */
@Injectable()
export class WebPushProvider implements ChannelProvider {
  readonly name = 'web-push';
  readonly channel = Channel.PUSH;

  private readonly logger = new Logger(WebPushProvider.name);
  private readonly configured: boolean;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    const vapid = config.get('vapid', { infer: true });
    this.configured = Boolean(vapid.publicKey && vapid.privateKey);
    if (this.configured) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    } else {
      this.logger.warn('VAPID keys are not set — run `npm run keys:vapid`. Push is disabled.');
    }
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    const devices = await this.prisma.pushDevice.findMany({
      where: { userId: ctx.user.id, disabledAt: null },
    });

    if (devices.length === 0) {
      throw new PermanentProviderError('No active push subscriptions', this.name);
    }

    // The service worker reads this JSON in its `push` event handler.
    const payload = JSON.stringify({
      title: message.subject ?? 'Notification',
      body: message.body,
      // Deduplicates on the OS side: a re-sent notification replaces rather than stacks.
      tag: ctx.topic.key,
      data: {
        deliveryId: ctx.deliveryId,
        notificationId: ctx.notificationId,
        topicKey: ctx.topic.key,
        url: pickUrl(ctx.data),
      },
    });

    const results = await Promise.allSettled(
      devices.map((device) =>
        webpush.sendNotification(
          {
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth },
          },
          payload,
          {
            // How long the push service should hold the message for an offline device.
            TTL: 12 * 60 * 60,
            urgency: ctx.topic.priority === 'CRITICAL' ? 'high' : 'normal',
          },
        ),
      ),
    );

    const expired: string[] = [];
    let delivered = 0;
    let retryable: Error | undefined;

    results.forEach((result, index) => {
      const device = devices[index];
      if (result.status === 'fulfilled') {
        delivered += 1;
        return;
      }

      const status = (result.reason as { statusCode?: number })?.statusCode;
      const detail = (result.reason as Error)?.message ?? 'unknown error';

      if (status === 404 || status === 410) {
        expired.push(device.id);
      } else if (status === 429 || status === 408 || (status !== undefined && status >= 500)) {
        retryable = new RetryableProviderError(
          `Push service error for ${device.id}: ${detail}`,
          this.name,
        );
      } else if (status === undefined) {
        retryable = new RetryableProviderError(`Push network error: ${detail}`, this.name);
      } else {
        // 400/401/403: a malformed payload or bad VAPID config. Permanent, but do not kill the
        // whole delivery if other devices succeeded.
        this.logger.warn(`Push rejected for device ${device.id} (HTTP ${status}): ${detail}`);
      }
    });

    if (expired.length > 0) {
      await this.prisma.pushDevice.updateMany({
        where: { id: { in: expired } },
        data: { disabledAt: new Date() },
      });
      this.logger.log(`Pruned ${expired.length} expired push subscription(s)`);
    }

    if (delivered === 0) {
      // Nothing landed. Retryable if any failure was transient; otherwise every subscription is
      // dead and there is no point trying again.
      throw (
        retryable ??
        new PermanentProviderError(
          `All ${devices.length} push subscription(s) failed or expired`,
          this.name,
        )
      );
    }

    return {
      // Push services return no durable message id and send no delivery webhooks, so there is
      // nothing to correlate later — SENT is as far as this channel's tracking goes.
      meta: { devices: devices.length, delivered, expired: expired.length },
    };
  }
}

/** Finds a link in the payload to open when the notification is clicked. */
function pickUrl(data: Record<string, unknown>): string | undefined {
  for (const key of ['trackingUrl', 'threadUrl', 'ctaUrl', 'secureAccountUrl', 'activationUrl']) {
    const value = data[key];
    if (typeof value === 'string' && value.startsWith('http')) return value;
  }
  return undefined;
}
