import { DeliveryStatus } from '@prisma/client';

/**
 * Monotonic delivery state machine.
 *
 * Provider webhooks arrive out of order — routinely. `email.delivered` and `email.sent` are
 * emitted milliseconds apart and travel over separate HTTP requests through separate retry
 * queues, so the "sent" callback frequently lands *after* the "delivered" one. A naive
 * `UPDATE deliveries SET status = $1` therefore regresses a delivered email back to SENT, and the
 * dashboard shows mail stuck in flight that actually arrived.
 *
 * The fix is to rank the states and only ever move forward. Rank is deliberately not the enum's
 * declaration order — it encodes *progress*, and terminal outcomes sit above every in-flight one
 * so nothing can overwrite them.
 */
const RANK: Record<DeliveryStatus, number> = {
  [DeliveryStatus.QUEUED]: 0,
  [DeliveryStatus.RENDERED]: 1,
  [DeliveryStatus.SENT]: 2,
  [DeliveryStatus.DELIVERED]: 3,
  [DeliveryStatus.OPENED]: 4,
  [DeliveryStatus.CLICKED]: 5,
  // Terminal outcomes. Higher than any progress state: once an address bounced, a late
  // "delivered" for the same message must not undo it.
  [DeliveryStatus.SKIPPED]: 10,
  [DeliveryStatus.SUPPRESSED]: 10,
  [DeliveryStatus.FAILED]: 11,
  [DeliveryStatus.BOUNCED]: 12,
  [DeliveryStatus.COMPLAINED]: 13,
};

/** Statuses that will never change again. */
const TERMINAL = new Set<DeliveryStatus>([
  DeliveryStatus.SKIPPED,
  DeliveryStatus.SUPPRESSED,
  DeliveryStatus.BOUNCED,
  DeliveryStatus.COMPLAINED,
]);

export function rank(status: DeliveryStatus): number {
  return RANK[status];
}

export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * True when `next` represents real forward progress from `current`.
 *
 * FAILED is the one asymmetric case: a delivery that failed locally can still legitimately be
 * retried and succeed, so SENT after FAILED is allowed even though it lowers the rank.
 */
export function canTransition(current: DeliveryStatus, next: DeliveryStatus): boolean {
  if (current === next) return false;
  if (isTerminal(current)) return false;
  if (current === DeliveryStatus.FAILED) {
    return next === DeliveryStatus.SENT || rank(next) > rank(DeliveryStatus.SENT);
  }
  return rank(next) > rank(current);
}

/** Convenience: the status to store, given what we have and what just arrived. */
export function applyStatus(
  current: DeliveryStatus,
  next: DeliveryStatus,
): { changed: boolean; status: DeliveryStatus } {
  return canTransition(current, next)
    ? { changed: true, status: next }
    : { changed: false, status: current };
}

/** Which timestamp column a status should stamp, if any. */
export function timestampFieldFor(
  status: DeliveryStatus,
): 'sentAt' | 'deliveredAt' | 'failedAt' | null {
  switch (status) {
    case DeliveryStatus.SENT:
      return 'sentAt';
    case DeliveryStatus.DELIVERED:
      return 'deliveredAt';
    case DeliveryStatus.FAILED:
    case DeliveryStatus.BOUNCED:
    case DeliveryStatus.COMPLAINED:
      return 'failedAt';
    default:
      return null;
  }
}

/** Statuses that count as "the notification reached the user". Used to roll up parent status. */
export function isSuccessful(status: DeliveryStatus): boolean {
  return (
    status === DeliveryStatus.SENT ||
    status === DeliveryStatus.DELIVERED ||
    status === DeliveryStatus.OPENED ||
    status === DeliveryStatus.CLICKED
  );
}
