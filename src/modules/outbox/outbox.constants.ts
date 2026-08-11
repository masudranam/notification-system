export const OUTBOX_EVENT = {
  NOTIFICATION_CREATED: 'notification.created',
} as const;

export type OutboxEventType = (typeof OUTBOX_EVENT)[keyof typeof OUTBOX_EVENT];

export interface NotificationCreatedPayload {
  notificationId: string;
  correlationId: string;
}

/** Give up relaying after this many attempts and leave the row for a human to inspect. */
export const OUTBOX_MAX_ATTEMPTS = 10;
/** How many rows one relay tick claims. Keeps a single tick bounded. */
export const OUTBOX_BATCH_SIZE = 50;
