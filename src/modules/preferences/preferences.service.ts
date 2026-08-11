import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Channel, DigestMode, SuppressionReason } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SuppressionService } from 'src/modules/suppression/suppression.service';
import { UnsubscribePayload, UnsubscribeService } from './unsubscribe.service';

export interface EffectivePreference {
  topicKey: string;
  topicName: string;
  category: string;
  channel: Channel;
  /** What will actually happen for this (topic, channel) pair right now. */
  effective: boolean;
  /** The user's explicit choice: true, false, or null for "never set". */
  override: boolean | null;
  /** What the topic would do with no override. */
  default: boolean;
  digest: DigestMode;
}

@Injectable()
export class PreferencesService {
  private readonly logger = new Logger(PreferencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: SuppressionService,
    private readonly unsubscribe: UnsubscribeService,
  ) {}

  /**
   * The full topic x channel matrix for a user.
   *
   * Returns the default, the override and the effective value separately rather than one boolean.
   * A settings UI needs all three: a toggle that cannot distinguish "off because you turned it
   * off" from "off because this topic doesn't use this channel" will confuse everyone who sees it.
   */
  async getMatrix(userId: string): Promise<EffectivePreference[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`Unknown user "${userId}"`);

    const [topics, preferences] = await Promise.all([
      this.prisma.topic.findMany({
        where: { key: { not: { startsWith: 'system.' } } },
        orderBy: { key: 'asc' },
      }),
      this.prisma.preference.findMany({ where: { userId } }),
    ]);

    const prefMap = new Map(preferences.map((p) => [`${p.topicKey}:${p.channel}`, p]));
    const rows: EffectivePreference[] = [];

    for (const topic of topics) {
      for (const channel of Object.values(Channel)) {
        const pref = prefMap.get(`${topic.key}:${channel}`);
        const isDefault = (topic.defaultChannels as Channel[]).includes(channel);
        rows.push({
          topicKey: topic.key,
          topicName: topic.name,
          category: topic.category,
          channel,
          override: pref?.enabled ?? null,
          default: isDefault,
          effective: pref?.enabled ?? isDefault,
          digest: pref?.digest ?? DigestMode.IMMEDIATE,
        });
      }
    }

    return rows;
  }

  async upsert(
    userId: string,
    updates: Array<{
      topicKey: string;
      channel: Channel;
      enabled?: boolean | null;
      digest?: DigestMode;
    }>,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`Unknown user "${userId}"`);

    for (const update of updates) {
      const exists = await this.prisma.topic.findUnique({ where: { key: update.topicKey } });
      if (!exists) throw new NotFoundException(`Unknown topic "${update.topicKey}"`);

      await this.prisma.preference.upsert({
        where: {
          userId_topicKey_channel: {
            userId,
            topicKey: update.topicKey,
            channel: update.channel,
          },
        },
        create: {
          userId,
          topicKey: update.topicKey,
          channel: update.channel,
          // `undefined` would make Prisma omit the column and fall back to the DB default; the
          // caller explicitly clearing an override needs it stored as SQL NULL.
          enabled: update.enabled ?? null,
          digest: update.digest ?? DigestMode.IMMEDIATE,
        },
        update: {
          ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
          ...(update.digest !== undefined ? { digest: update.digest } : {}),
        },
      });
    }

    return this.getMatrix(userId);
  }

  /**
   * Applies a one-click unsubscribe.
   *
   * Two writes, deliberately:
   *  1. A `Preference` row with `enabled = false` — the precise, per-topic effect.
   *  2. A `Suppression` row with reason UNSUBSCRIBED — a belt-and-braces block keyed on the
   *     address rather than the user id, so it still holds if the same address is later attached
   *     to a different account.
   */
  async applyUnsubscribe(token: string) {
    const payload: UnsubscribePayload = this.unsubscribe.verify(token);

    const user = await this.prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw new NotFoundException('Unknown recipient');

    const topic = await this.prisma.topic.findUnique({ where: { key: payload.topicKey } });
    if (!topic) throw new NotFoundException(`Unknown topic "${payload.topicKey}"`);

    await this.prisma.preference.upsert({
      where: {
        userId_topicKey_channel: {
          userId: payload.userId,
          topicKey: payload.topicKey,
          channel: payload.channel,
        },
      },
      create: {
        userId: payload.userId,
        topicKey: payload.topicKey,
        channel: payload.channel,
        enabled: false,
      },
      update: { enabled: false },
    });

    const address =
      payload.channel === Channel.EMAIL
        ? user.email
        : payload.channel === Channel.SMS
          ? user.phone
          : null;

    if (address) {
      await this.suppression.add(
        payload.channel,
        address,
        SuppressionReason.UNSUBSCRIBED,
        `one-click unsubscribe from ${payload.topicKey}`,
      );
    }

    this.logger.log(
      `Unsubscribed ${payload.userId} from ${payload.topicKey} on ${payload.channel}`,
    );

    return { topicKey: payload.topicKey, topicName: topic.name, channel: payload.channel };
  }
}
