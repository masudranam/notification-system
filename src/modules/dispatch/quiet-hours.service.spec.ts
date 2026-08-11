import { Priority } from '@prisma/client';
import { QuietHoursService } from './quiet-hours.service';

/**
 * Quiet hours are the easiest thing in the system to get subtly wrong: the window wraps midnight,
 * it must be evaluated in the recipient's zone rather than the server's, and DST shifts the
 * release time by an hour twice a year.
 */
describe('QuietHoursService', () => {
  const service = new QuietHoursService();

  /** Builds a Date for a given wall-clock hour in a given zone, via the UTC offset. */
  const utc = (iso: string) => new Date(iso);

  const dhakaUser = {
    timezone: 'Asia/Dhaka', // UTC+6, no DST
    quietHoursStart: 22,
    quietHoursEnd: 7,
  };

  it('does not defer when the user has no quiet hours', () => {
    const decision = service.evaluate(
      { timezone: 'UTC', quietHoursStart: null, quietHoursEnd: null },
      Priority.NORMAL,
      utc('2026-08-11T02:00:00Z'),
    );
    expect(decision.deferred).toBe(false);
    expect(decision.delayMs).toBe(0);
  });

  it('does not defer outside the window', () => {
    // 09:00 UTC = 15:00 Dhaka, comfortably outside 22:00-07:00.
    const decision = service.evaluate(dhakaUser, Priority.NORMAL, utc('2026-08-11T09:00:00Z'));
    expect(decision.deferred).toBe(false);
  });

  describe('windows that wrap midnight', () => {
    // A naive `hour >= start && hour < end` check fails both of these: at 23:00,
    // `23 >= 22 && 23 < 7` is false, so the notification would go out at 11pm.
    it('defers late in the evening, before midnight', () => {
      // 17:00 UTC = 23:00 Dhaka.
      const decision = service.evaluate(dhakaUser, Priority.NORMAL, utc('2026-08-11T17:00:00Z'));
      expect(decision.deferred).toBe(true);
      // Released at 07:00 Dhaka the next morning: 8 hours later.
      expect(decision.delayMs).toBe(8 * 60 * 60 * 1000);
    });

    it('defers early in the morning, after midnight', () => {
      // 21:00 UTC on the 11th = 03:00 Dhaka on the 12th.
      const decision = service.evaluate(dhakaUser, Priority.NORMAL, utc('2026-08-11T21:00:00Z'));
      expect(decision.deferred).toBe(true);
      expect(decision.delayMs).toBe(4 * 60 * 60 * 1000);
    });
  });

  it('evaluates the window in the user timezone, not the server one', () => {
    const at = utc('2026-08-11T17:00:00Z');
    // The same instant is 23:00 in Dhaka (quiet) and 17:00 in UTC (not quiet).
    expect(service.evaluate(dhakaUser, Priority.NORMAL, at).deferred).toBe(true);
    expect(service.evaluate({ ...dhakaUser, timezone: 'UTC' }, Priority.NORMAL, at).deferred).toBe(
      false,
    );
  });

  it('lets CRITICAL priority bypass the window', () => {
    // A 3am "someone signed in from Brazil" is exactly the alert you want to be woken by.
    const decision = service.evaluate(dhakaUser, Priority.CRITICAL, utc('2026-08-11T21:00:00Z'));
    expect(decision.deferred).toBe(false);
    expect(decision.reason).toBe('critical-priority-bypass');
  });

  it('still defers HIGH priority', () => {
    expect(service.evaluate(dhakaUser, Priority.HIGH, utc('2026-08-11T21:00:00Z')).deferred).toBe(
      true,
    );
  });

  it('treats an invalid timezone as no quiet hours rather than failing the send', () => {
    const decision = service.evaluate(
      { timezone: 'Not/AZone', quietHoursStart: 22, quietHoursEnd: 7 },
      Priority.NORMAL,
      utc('2026-08-11T21:00:00Z'),
    );
    expect(decision.deferred).toBe(false);
  });

  it('ignores a zero-width window (start === end)', () => {
    const decision = service.evaluate(
      { timezone: 'UTC', quietHoursStart: 9, quietHoursEnd: 9 },
      Priority.NORMAL,
      utc('2026-08-11T09:30:00Z'),
    );
    expect(decision.deferred).toBe(false);
  });

  describe('non-wrapping windows', () => {
    const daytimeQuiet = { timezone: 'UTC', quietHoursStart: 9, quietHoursEnd: 17 };

    it('defers inside the window', () => {
      const decision = service.evaluate(daytimeQuiet, Priority.NORMAL, utc('2026-08-11T10:00:00Z'));
      expect(decision.deferred).toBe(true);
      expect(decision.delayMs).toBe(7 * 60 * 60 * 1000);
    });

    it('does not defer at the exact end hour', () => {
      expect(
        service.evaluate(daytimeQuiet, Priority.NORMAL, utc('2026-08-11T17:00:00Z')).deferred,
      ).toBe(false);
    });

    it('defers at the exact start hour', () => {
      expect(
        service.evaluate(daytimeQuiet, Priority.NORMAL, utc('2026-08-11T09:00:00Z')).deferred,
      ).toBe(true);
    });
  });

  it('lands on the real local hour across a DST transition', () => {
    // US DST ends 2026-11-01 at 02:00 local. A user in New York with a 22:00-07:00 window who is
    // notified at 01:00 EDT must be released at 07:00 EST — which is 7 clock hours later, not 6,
    // because the night contains a repeated hour.
    const nyUser = { timezone: 'America/New_York', quietHoursStart: 22, quietHoursEnd: 7 };
    // 05:00 UTC on 1 Nov = 01:00 EDT (still UTC-4, before the shift).
    const decision = service.evaluate(nyUser, Priority.NORMAL, utc('2026-11-01T05:00:00Z'));
    expect(decision.deferred).toBe(true);
    // Release at 07:00 EST = 12:00 UTC. From 05:00 UTC that is 7 hours.
    expect(decision.delayMs).toBe(7 * 60 * 60 * 1000);
  });
});
