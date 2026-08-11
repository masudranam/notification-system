import { Injectable } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';
import { RealtimeService } from './realtime.service';

/**
 * The in-app channel.
 *
 * "Sending" here is just publishing a realtime event — the Delivery row created by the dispatch
 * worker *is* the inbox entry, and the base processor has already stored the rendered subject and
 * body on it. There is no external system, so this provider can never fail in a retryable way,
 * which is why it has no error translation.
 *
 * Note that delivery does not depend on the realtime publish succeeding: the notification is
 * already durably in the inbox, and a browser that is offline will simply see it on next load.
 */
@Injectable()
export class InAppProvider implements ChannelProvider {
  readonly name = 'in-app';
  readonly channel = Channel.IN_APP;

  constructor(private readonly realtime: RealtimeService) {}

  isConfigured(): boolean {
    return true;
  }

  async send(message: RenderedMessage, ctx: SendContext): Promise<SendResult> {
    await this.realtime.publish({
      userId: ctx.user.id,
      type: 'notification',
      payload: {
        deliveryId: ctx.deliveryId,
        notificationId: ctx.notificationId,
        topicKey: ctx.topic.key,
        subject: message.subject,
        body: message.body,
        createdAt: new Date().toISOString(),
      },
    });

    return { meta: { realtime: true } };
  }
}
