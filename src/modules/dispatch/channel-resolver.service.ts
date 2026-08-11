import { Injectable, Logger } from '@nestjs/common';
import { Channel, DigestMode, Topic, TopicCategory, User } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SuppressionService } from 'src/modules/suppression/suppression.service';

export type ChannelDecision =
  | { channel: Channel; action: 'send'; digest: DigestMode; address: string }
  | { channel: Channel; action: 'digest'; digest: DigestMode; address: string }
  | { channel: Channel; action: 'skip'; reason: string }
  | { channel: Channel; action: 'suppress'; reason: string };

export interface ResolveInput {
  user: User & { devices: { id: string }[] };
  topic: Topic;
  /** Caller-requested subset. Empty means "use topic defaults". */
  requestedChannels: Channel[];
}

/**
 * Decides, per channel, whether this notification should be sent, batched, skipped or suppressed.
 *
 * The precedence chain, highest priority first:
 *
 *   1. **Requested channels** narrow the candidate set (a caller can ask for fewer channels than
 *      the topic defaults, never more than the user allows).
 *   2. **Explicit preference** — `enabled = true/false` always wins over the topic default.
 *      `null` means "never asked", so the topic default applies. This is why the column is a
 *      nullable boolean: collapsing unset into false would mean changing a topic's defaults
 *      silently overrode real user choices.
 *   3. **Category rules** — MARKETING honours the opt-out; TRANSACTIONAL ignores it, because
 *      withholding a password-reset email because someone unsubscribed from a newsletter is a
 *      bug, not compliance.
 *   4. **Suppression list** — hard bounces and spam complaints beat everything, including an
 *      explicit `enabled = true`. Continuing to mail a bouncing address is what destroys a
 *      sending domain's reputation.
 *   5. **Addressability** — no phone number means SMS is SKIPPED, which is different from FAILED:
 *      nothing went wrong, there was simply nowhere to send it.
 *
 * Every rejected channel still produces a Delivery row with a reason. Silent drops are the
 * hardest class of notification bug to debug — "the user says they never got it" needs an answer.
 */
@Injectable()
export class ChannelResolverService {
  private readonly logger = new Logger(ChannelResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
  ) {}

  async resolve(input: ResolveInput): Promise<ChannelDecision[]> {
    const { user, topic, requestedChannels } = input;

    const preferences = await this.prisma.preference.findMany({
      where: { userId: user.id, topicKey: topic.key },
    });
    const prefByChannel = new Map(preferences.map((p) => [p.channel, p]));

    // Step 1: candidate set. Requested channels narrow the defaults but a caller may also name a
    // channel the topic does not default to — honour it, since the caller is explicit.
    const candidates =
      requestedChannels.length > 0 ? requestedChannels : (topic.defaultChannels as Channel[]);

    const decisions: ChannelDecision[] = [];

    for (const channel of new Set(candidates)) {
      const pref = prefByChannel.get(channel);

      // Step 2 + 3: preference and category.
      const defaultOn = (topic.defaultChannels as Channel[]).includes(channel);
      const explicitlyRequested = requestedChannels.includes(channel);
      const enabled = pref?.enabled ?? (defaultOn || explicitlyRequested);

      if (!enabled) {
        decisions.push({
          channel,
          action: 'suppress',
          reason:
            pref?.enabled === false
              ? 'preference: user disabled this channel for this topic'
              : 'preference: channel not enabled by default for this topic',
        });
        continue;
      }

      // Step 5 (before the suppression lookup, because we need the address to check it).
      const address = this.addressFor(channel, user);
      if (!address) {
        decisions.push({
          channel,
          action: 'skip',
          reason: this.missingAddressReason(channel),
        });
        continue;
      }

      // Step 4: suppression list.
      const suppressed = await this.suppression.find(channel, address);
      if (suppressed) {
        decisions.push({
          channel,
          action: 'suppress',
          reason: `suppression list: ${suppressed.reason.toLowerCase()}`,
        });
        continue;
      }

      // MARKETING respects a topic-wide unsubscribe recorded as a suppression on the address.
      if (topic.category === TopicCategory.MARKETING) {
        const optedOut = await this.suppression.isUnsubscribed(channel, address);
        if (optedOut) {
          decisions.push({
            channel,
            action: 'suppress',
            reason: 'unsubscribed from marketing',
          });
          continue;
        }
      }

      const digest = pref?.digest ?? DigestMode.IMMEDIATE;
      // Digests only make sense for MARKETING and low-priority chatter. A HIGH/CRITICAL
      // transactional message is never batched — nobody wants tomorrow's summary to be the first
      // they hear of a suspicious login.
      const digestable =
        digest !== DigestMode.IMMEDIATE &&
        topic.priority !== 'CRITICAL' &&
        topic.priority !== 'HIGH';

      decisions.push({
        channel,
        action: digestable ? 'digest' : 'send',
        digest,
        address,
      });
    }

    return decisions;
  }

  /** Where a channel actually delivers to. Also the key used for suppression lookups. */
  addressFor(channel: Channel, user: User & { devices?: { id: string }[] }): string | null {
    switch (channel) {
      case Channel.EMAIL:
        return user.email ?? null;
      case Channel.SMS:
        return user.phone ?? null;
      case Channel.SLACK:
        return user.slackChannelId ?? null;
      case Channel.PUSH:
        // Push has no single address; the "address" is the user, and the provider fans out to
        // every active subscription. No active devices means nothing to send to.
        return (user.devices?.length ?? 0) > 0 ? user.id : null;
      case Channel.IN_APP:
        // Always reachable: the inbox is a table in our own database.
        return user.id;
      default:
        return null;
    }
  }

  private missingAddressReason(channel: Channel): string {
    switch (channel) {
      case Channel.EMAIL:
        return 'no email address on file';
      case Channel.SMS:
        return 'no phone number on file';
      case Channel.SLACK:
        return 'no Slack channel configured for this user';
      case Channel.PUSH:
        return 'no active push subscriptions';
      default:
        return 'no address for this channel';
    }
  }
}
