import { Channel } from '@prisma/client';

/**
 * Queue topology.
 *
 * One queue per channel, deliberately. If everything shared a single queue, a Slack webhook
 * rate-limited to ~1 msg/sec would occupy workers that email jobs need, and email throughput
 * would collapse to the speed of the slowest channel. Separate queues also mean per-channel
 * concurrency, per-channel rate limits, and the ability to pause one provider during an incident
 * without touching the others.
 */
// Note: no colons in queue names. BullMQ rejects them because `:` is its Redis key separator
// (keys look like `bull:<queue>:<jobId>`), so a colon in the name would corrupt the namespace.
export const QUEUE = {
  /** Fan-out: resolve channels and create Delivery rows. No network I/O, so it can run hot. */
  DISPATCH: 'dispatch',
  EMAIL: 'channel-email',
  IN_APP: 'channel-inapp',
  PUSH: 'channel-push',
  SLACK: 'channel-slack',
  SMS: 'channel-sms',
  /** Flushes hourly/daily digest buckets. Driven by a repeatable job. */
  DIGEST: 'digest',
  /** Terminal failures land here for inspection and manual replay. */
  DLQ: 'dlq',
  /** Periodic housekeeping (event retention, stale push-device pruning). */
  MAINTENANCE: 'maintenance',
} as const;

export const CHANNEL_QUEUE: Record<Channel, string> = {
  EMAIL: QUEUE.EMAIL,
  IN_APP: QUEUE.IN_APP,
  PUSH: QUEUE.PUSH,
  SLACK: QUEUE.SLACK,
  SMS: QUEUE.SMS,
};

export const JOB = {
  DISPATCH_NOTIFICATION: 'dispatch-notification',
  SEND_DELIVERY: 'send-delivery',
  FLUSH_DIGEST: 'flush-digest',
  FLUSH_DIGEST_SCAN: 'flush-digest-scan',
  PRUNE_EVENTS: 'prune-events',
  DEAD_LETTER: 'dead-letter',
} as const;

/** Custom BullMQ backoff: exponential with full jitter. */
export const BACKOFF_JITTER = 'exponential-jitter';

export interface DispatchJobData {
  notificationId: string;
  correlationId: string;
}

export interface SendDeliveryJobData {
  deliveryId: string;
  notificationId: string;
  channel: Channel;
  correlationId: string;
}

export interface DeadLetterJobData {
  queue: string;
  originalJobName: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
}
