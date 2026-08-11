import { Injectable, Logger } from '@nestjs/common';
import { Priority } from '@prisma/client';
import { DateTime } from 'luxon';

export interface QuietHoursDecision {
  deferred: boolean;
  /** Milliseconds to delay the send by. 0 when not deferred. */
  delayMs: number;
  reason?: string;
}

/**
 * Decides whether a send should wait until the recipient's quiet window ends.
 *
 * Three subtleties this handles that a naive `hour >= start && hour < end` check does not:
 *
 *  1. **The window wraps midnight.** 22:00–07:00 is the common case, and `22 >= 22 && 22 < 7`
 *     is false. Wrapping windows need the inverted comparison.
 *  2. **It must be evaluated in the user's zone, not the server's.** A server in UTC deferring
 *     based on UTC hours would silence a Dhaka user (UTC+6) at completely the wrong times.
 *  3. **DST.** Adding "hours until 7am" arithmetically breaks on the two days a year a zone
 *     shifts. Luxon's `set`/`plus` on a zone-aware DateTime lands on the real local 07:00.
 */
@Injectable()
export class QuietHoursService {
  private readonly logger = new Logger(QuietHoursService.name);

  evaluate(
    user: { timezone: string; quietHoursStart: number | null; quietHoursEnd: number | null },
    priority: Priority,
    now: Date = new Date(),
  ): QuietHoursDecision {
    const { quietHoursStart: start, quietHoursEnd: end } = user;

    if (start === null || end === null || start === end) {
      return { deferred: false, delayMs: 0 };
    }

    // CRITICAL is the escape hatch: a security alert at 3am is the point of the alert.
    if (priority === Priority.CRITICAL) {
      return { deferred: false, delayMs: 0, reason: 'critical-priority-bypass' };
    }

    const local = DateTime.fromJSDate(now, { zone: user.timezone });
    if (!local.isValid) {
      // A bad IANA zone must not stop the notification; treat it as "no quiet hours".
      this.logger.warn(`Invalid timezone "${user.timezone}", skipping quiet-hours check`);
      return { deferred: false, delayMs: 0 };
    }

    const hour = local.hour;
    const wraps = start > end;
    const inQuietWindow = wraps ? hour >= start || hour < end : hour >= start && hour < end;

    if (!inQuietWindow) {
      return { deferred: false, delayMs: 0 };
    }

    // Next occurrence of the window's end hour, in the user's own zone.
    let target = local.set({ hour: end, minute: 0, second: 0, millisecond: 0 });
    if (target <= local) {
      target = target.plus({ days: 1 });
    }

    const delayMs = Math.max(0, target.toMillis() - local.toMillis());
    return {
      deferred: true,
      delayMs,
      reason: `quiet-hours ${start}:00-${end}:00 ${user.timezone}, releasing at ${target.toISO()}`,
    };
  }
}
