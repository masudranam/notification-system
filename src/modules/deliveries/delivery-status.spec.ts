import { DeliveryStatus } from '@prisma/client';
import {
  applyStatus,
  canTransition,
  isSuccessful,
  isTerminal,
  timestampFieldFor,
} from './delivery-status';

/**
 * The monotonic state machine is the piece that makes out-of-order provider webhooks safe, so it
 * gets the most direct test coverage in the project. Every case here corresponds to something that
 * actually happens in production.
 */
describe('delivery status state machine', () => {
  describe('forward progress', () => {
    it.each([
      [DeliveryStatus.QUEUED, DeliveryStatus.RENDERED],
      [DeliveryStatus.RENDERED, DeliveryStatus.SENT],
      [DeliveryStatus.SENT, DeliveryStatus.DELIVERED],
      [DeliveryStatus.DELIVERED, DeliveryStatus.OPENED],
      [DeliveryStatus.OPENED, DeliveryStatus.CLICKED],
      // Skipping intermediate states is normal: `email.delivered` often arrives before
      // `email.sent` has been processed at all.
      [DeliveryStatus.QUEUED, DeliveryStatus.DELIVERED],
      [DeliveryStatus.SENT, DeliveryStatus.CLICKED],
    ])('allows %s -> %s', (from, to) => {
      expect(canTransition(from, to)).toBe(true);
    });
  });

  describe('out-of-order webhooks', () => {
    // The exact bug this machine exists to prevent: Resend emits sent/delivered milliseconds
    // apart over independent HTTP requests, so `sent` frequently lands last.
    it('ignores a late email.sent after DELIVERED', () => {
      expect(canTransition(DeliveryStatus.DELIVERED, DeliveryStatus.SENT)).toBe(false);
    });

    it('ignores a late email.opened after CLICKED', () => {
      expect(canTransition(DeliveryStatus.CLICKED, DeliveryStatus.OPENED)).toBe(false);
    });

    it('never regresses out of a terminal state', () => {
      for (const terminal of [
        DeliveryStatus.BOUNCED,
        DeliveryStatus.COMPLAINED,
        DeliveryStatus.SUPPRESSED,
        DeliveryStatus.SKIPPED,
      ]) {
        expect(canTransition(terminal, DeliveryStatus.DELIVERED)).toBe(false);
        expect(canTransition(terminal, DeliveryStatus.SENT)).toBe(false);
      }
    });

    it('treats the same status as no change, so duplicate webhooks are inert', () => {
      expect(canTransition(DeliveryStatus.DELIVERED, DeliveryStatus.DELIVERED)).toBe(false);
    });
  });

  describe('terminal outcomes outrank progress', () => {
    // A hard bounce reported after an open-tracking pixel fired must still win: the address is
    // dead regardless of what the tracker claimed.
    it('allows BOUNCED after CLICKED', () => {
      expect(canTransition(DeliveryStatus.CLICKED, DeliveryStatus.BOUNCED)).toBe(true);
    });

    it('allows COMPLAINED after DELIVERED', () => {
      expect(canTransition(DeliveryStatus.DELIVERED, DeliveryStatus.COMPLAINED)).toBe(true);
    });
  });

  describe('retry after local failure', () => {
    // FAILED is the one asymmetric case: a delivery that failed locally can be retried and
    // succeed, so SENT after FAILED must be allowed even though it lowers the rank.
    it('allows SENT after FAILED', () => {
      expect(canTransition(DeliveryStatus.FAILED, DeliveryStatus.SENT)).toBe(true);
    });

    it('allows DELIVERED after FAILED', () => {
      expect(canTransition(DeliveryStatus.FAILED, DeliveryStatus.DELIVERED)).toBe(true);
    });

    it('does not allow FAILED to regress to QUEUED', () => {
      expect(canTransition(DeliveryStatus.FAILED, DeliveryStatus.QUEUED)).toBe(false);
    });
  });

  describe('applyStatus', () => {
    it('reports the change and the new status when it applies', () => {
      expect(applyStatus(DeliveryStatus.SENT, DeliveryStatus.DELIVERED)).toEqual({
        changed: true,
        status: DeliveryStatus.DELIVERED,
      });
    });

    it('keeps the current status when the transition is rejected', () => {
      expect(applyStatus(DeliveryStatus.DELIVERED, DeliveryStatus.SENT)).toEqual({
        changed: false,
        status: DeliveryStatus.DELIVERED,
      });
    });
  });

  describe('helpers', () => {
    it('marks only genuinely final states as terminal', () => {
      expect(isTerminal(DeliveryStatus.BOUNCED)).toBe(true);
      expect(isTerminal(DeliveryStatus.SUPPRESSED)).toBe(true);
      // FAILED is deliberately NOT terminal — it can still be replayed from the DLQ.
      expect(isTerminal(DeliveryStatus.FAILED)).toBe(false);
      expect(isTerminal(DeliveryStatus.SENT)).toBe(false);
    });

    it('counts only reached-the-user states as successful', () => {
      expect(isSuccessful(DeliveryStatus.SENT)).toBe(true);
      expect(isSuccessful(DeliveryStatus.CLICKED)).toBe(true);
      // Suppressed is a correct outcome but not a delivery, so the parent must not roll up to
      // COMPLETED on the strength of it.
      expect(isSuccessful(DeliveryStatus.SUPPRESSED)).toBe(false);
      expect(isSuccessful(DeliveryStatus.BOUNCED)).toBe(false);
    });

    it('maps statuses to the timestamp column they stamp', () => {
      expect(timestampFieldFor(DeliveryStatus.SENT)).toBe('sentAt');
      expect(timestampFieldFor(DeliveryStatus.DELIVERED)).toBe('deliveredAt');
      expect(timestampFieldFor(DeliveryStatus.BOUNCED)).toBe('failedAt');
      expect(timestampFieldFor(DeliveryStatus.OPENED)).toBeNull();
    });
  });
});
