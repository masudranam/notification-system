import { Injectable, Logger } from '@nestjs/common';
import { Channel, Suppression, SuppressionReason } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * The do-not-contact list.
 *
 * Every mail provider judges you on bounce and complaint rate. Resend, SES and friends will
 * throttle or terminate an account that keeps mailing addresses that hard-bounced — so a bounce
 * is not just "this one failed", it is "never try this address again". Recording that here and
 * checking it before every send is the difference between a healthy sending domain and a blocked
 * one.
 *
 * Note the asymmetry: HARD_BOUNCE and SPAM_COMPLAINT block *everything* to that address, while
 * UNSUBSCRIBED blocks marketing only. A user who unsubscribed from the newsletter still needs
 * their password-reset email.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Returns a hard block (bounce/complaint/manual) for this address, if any. */
  async find(channel: Channel, address: string): Promise<Suppression | null> {
    const row = await this.prisma.suppression.findUnique({
      where: { channel_address: { channel, address: normalize(channel, address) } },
    });
    if (!row) return null;
    // UNSUBSCRIBED is handled separately so it only blocks marketing.
    return row.reason === SuppressionReason.UNSUBSCRIBED ? null : row;
  }

  /** True when the address opted out of marketing. */
  async isUnsubscribed(channel: Channel, address: string): Promise<boolean> {
    const row = await this.prisma.suppression.findUnique({
      where: { channel_address: { channel, address: normalize(channel, address) } },
    });
    return row?.reason === SuppressionReason.UNSUBSCRIBED;
  }

  async add(
    channel: Channel,
    address: string,
    reason: SuppressionReason,
    detail?: string,
  ): Promise<Suppression> {
    const normalized = normalize(channel, address);
    const row = await this.prisma.suppression.upsert({
      where: { channel_address: { channel, address: normalized } },
      create: { channel, address: normalized, reason, detail },
      // A later hard bounce should upgrade an UNSUBSCRIBED row, never the reverse.
      update: this.shouldUpgrade(reason) ? { reason, detail } : {},
    });
    this.logger.warn(
      `Suppressed ${channel}:${normalized} (${reason})${detail ? ` — ${detail}` : ''}`,
    );
    return row;
  }

  async remove(channel: Channel, address: string): Promise<void> {
    await this.prisma.suppression
      .delete({ where: { channel_address: { channel, address: normalize(channel, address) } } })
      .catch(() => undefined);
  }

  async list(params: { channel?: Channel; limit: number }) {
    return this.prisma.suppression.findMany({
      where: params.channel ? { channel: params.channel } : undefined,
      orderBy: { createdAt: 'desc' },
      take: params.limit,
    });
  }

  private shouldUpgrade(reason: SuppressionReason): boolean {
    return reason === SuppressionReason.HARD_BOUNCE || reason === SuppressionReason.SPAM_COMPLAINT;
  }
}

/**
 * Canonicalises an address so the same recipient cannot slip through under a different casing.
 *
 * Email local-parts are technically case-sensitive per RFC 5321, but no real provider treats them
 * that way, and a suppression list that misses `Alice@x.com` after bouncing `alice@x.com` is
 * worse than useless.
 */
export function normalize(channel: Channel, address: string): string {
  const trimmed = address.trim();
  return channel === Channel.EMAIL ? trimmed.toLowerCase() : trimmed;
}
