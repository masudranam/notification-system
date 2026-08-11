import { DeliveryStatus } from '@prisma/client';

/**
 * Resend's email event types, mapped onto our delivery statuses.
 *
 * `email.opened` and `email.clicked` are worth a caveat: opens are tracked with a 1x1 pixel that
 * most clients now block or pre-fetch, and clicks require link rewriting. Neither is reliable
 * evidence about a human — treat them as weak signals, not facts. They are mapped anyway because
 * the *ordering* problem they create is the interesting part: a click routinely arrives before the
 * open that logically preceded it.
 */
export const RESEND_EVENT_STATUS: Record<string, DeliveryStatus | null> = {
  'email.sent': DeliveryStatus.SENT,
  'email.delivered': DeliveryStatus.DELIVERED,
  'email.opened': DeliveryStatus.OPENED,
  'email.clicked': DeliveryStatus.CLICKED,
  'email.bounced': DeliveryStatus.BOUNCED,
  'email.complained': DeliveryStatus.COMPLAINED,
  'email.failed': DeliveryStatus.FAILED,
  // Informational only: the provider is still retrying, so the delivery has not regressed and
  // must not be moved backwards. Recorded as an audit event with no status change.
  'email.delivery_delayed': null,
  'email.scheduled': null,
  'email.suppressed': null,
  'email.received': null,
};

export interface ResendWebhookBody {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    /** Present on email.bounced. */
    bounce?: { type?: string; subType?: string; message?: string };
    /** Present on email.clicked. */
    click?: { link?: string; ipAddress?: string; userAgent?: string; timestamp?: string };
    [key: string]: unknown;
  };
}

/**
 * Whether a bounce is permanent.
 *
 * Only a *hard* bounce means "this address does not exist" and warrants suppression. A soft bounce
 * (full mailbox, server temporarily unavailable) will likely succeed later, and suppressing on it
 * would permanently lock out a user whose inbox happened to be full for a day.
 */
export function isHardBounce(body: ResendWebhookBody): boolean {
  const type = body.data?.bounce?.type?.toLowerCase() ?? '';
  return type === 'permanent' || type === 'hard' || type === 'undetermined';
}
