import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfig } from 'src/config/configuration';

export interface UnsubscribePayload {
  userId: string;
  topicKey: string;
  channel: Channel;
  /** Issued-at, seconds. Used to expire ancient links. */
  iat: number;
}

/** Links in an email must keep working for a long time — people read old mail. */
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // ~13 months

/**
 * Stateless signed unsubscribe links.
 *
 * The requirement is awkward: the link has to work from any mail client, with no session, no
 * cookie and no login — while not letting anyone unsubscribe anyone else by editing a URL.
 *
 * The answer is to put the claims in the URL and sign them. An HMAC over
 * `userId|topicKey|channel|iat` means the server needs to store nothing, and a tampered userId
 * invalidates the signature.
 *
 * Two details that matter:
 *  - **base64url**, not base64: `+` and `/` get mangled in URLs and by mail clients that
 *    re-encode links.
 *  - **timingSafeEqual**, not `===`: comparing MAC digests with a short-circuiting comparison
 *    leaks how many leading bytes matched, which is enough to forge one byte at a time.
 */
@Injectable()
export class UnsubscribeService {
  private readonly logger = new Logger(UnsubscribeService.name);
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService<AppConfig, true>) {
    this.secret = config.get('unsubscribeSecret', { infer: true });
    this.baseUrl = config.get('baseUrl', { infer: true });
  }

  sign(payload: Omit<UnsubscribePayload, 'iat'>): string {
    const full: UnsubscribePayload = { ...payload, iat: Math.floor(Date.now() / 1000) };
    const body = b64urlEncode(JSON.stringify(full));
    const mac = this.mac(body);
    return `${body}.${mac}`;
  }

  buildUrl(payload: Omit<UnsubscribePayload, 'iat'>): string {
    return `${this.baseUrl}/unsubscribe?token=${this.sign(payload)}`;
  }

  verify(token: string): UnsubscribePayload {
    const [body, mac] = token.split('.');
    if (!body || !mac) {
      throw new BadRequestException('Malformed unsubscribe token');
    }

    const expected = this.mac(body);
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch, so check that first.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Invalid unsubscribe token signature');
    }

    let payload: UnsubscribePayload;
    try {
      payload = JSON.parse(b64urlDecode(body)) as UnsubscribePayload;
    } catch {
      throw new BadRequestException('Malformed unsubscribe token payload');
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds > MAX_AGE_SECONDS) {
      throw new BadRequestException('Unsubscribe link has expired');
    }

    return payload;
  }

  private mac(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function b64urlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}
