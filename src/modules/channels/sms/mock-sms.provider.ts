import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfig } from 'src/config/configuration';
import { PermanentProviderError, RetryableProviderError } from 'src/common/errors/provider.errors';
import { RenderedMessage } from 'src/modules/templates/template.service';
import { ChannelProvider, SendContext, SendResult } from '../shared/channel-provider.interface';

/**
 * Mock SMS provider — the default, so the project never costs money.
 *
 * It is not a no-op stub. It reproduces the behaviours that make SMS awkward, so the pipeline is
 * genuinely exercised:
 *
 *  - **Segment accounting.** GSM-7 fits 160 characters in one segment; any character outside that
 *    alphabet (emoji, curly quotes, most non-Latin scripts) forces UCS-2 and drops the limit to 70.
 *    Longer messages are split, and you are billed per segment — so a stray “smart quote” can
 *    triple the cost of a campaign. The count is logged and returned in `meta`.
 *  - **E.164 validation**, rejected permanently, because a malformed number will never work.
 *  - **A deterministic failure hook**: numbers ending in `0000` always fail retryably, so the retry
 *    and DLQ paths can be tested on demand.
 */
@Injectable()
export class MockSmsProvider implements ChannelProvider {
  readonly name = 'mock-sms';
  readonly channel = Channel.SMS;

  private readonly logger = new Logger(MockSmsProvider.name);
  private readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.enabled = config.get('sms', { infer: true }).provider === 'mock';
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

    // Deterministic failure hook for exercising retries and the DLQ.
    if (ctx.address.endsWith('0000')) {
      throw new RetryableProviderError(
        'Mock SMS: simulated carrier failure (number ends in 0000)',
        this.name,
      );
    }

    const { segments, encoding } = countSegments(message.body);
    if (segments > 1) {
      this.logger.warn(
        `SMS to ${maskPhone(ctx.address)} needs ${segments} segments (${encoding}) — ` +
          `${message.body.length} chars. Each segment is billed separately.`,
      );
    }

    const messageId = `mock_${randomUUID()}`;
    this.logger.log(
      `[MOCK SMS] to=${maskPhone(ctx.address)} id=${messageId} ` +
        `segments=${segments} body="${message.body}"`,
    );

    return { providerMessageId: messageId, meta: { segments, encoding, mock: true } };
  }
}

/** E.164: a leading +, a non-zero country code, then up to 14 more digits. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(value);
}

/**
 * GSM-7 basic + extension alphabet. Anything outside it forces the whole message to UCS-2.
 * The extension characters (^{}\[]~|€) occupy two septets each, which is why they are counted
 * separately below.
 */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

export function countSegments(text: string): { segments: number; encoding: 'GSM-7' | 'UCS-2' } {
  let septets = 0;
  let gsm7 = true;

  for (const char of text) {
    if (GSM7_BASIC.includes(char)) {
      septets += 1;
    } else if (GSM7_EXTENDED.includes(char)) {
      septets += 2;
    } else {
      gsm7 = false;
      break;
    }
  }

  if (!gsm7) {
    // UCS-2: 70 chars single, 67 per part when concatenated (6 bytes go to the UDH header).
    const units = [...text].length;
    return { segments: units <= 70 ? 1 : Math.ceil(units / 67), encoding: 'UCS-2' };
  }

  // GSM-7: 160 septets single, 153 per part when concatenated.
  return { segments: septets <= 160 ? 1 : Math.ceil(septets / 153), encoding: 'GSM-7' };
}

/** Never log a full phone number. */
export function maskPhone(value: string): string {
  return value.length <= 5 ? value : `${value.slice(0, 4)}****${value.slice(-2)}`;
}
