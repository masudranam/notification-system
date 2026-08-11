import { Channel, Prisma, Priority, TopicCategory } from '@prisma/client';

/**
 * The topic registry: the public contract producers code against.
 *
 * `payloadSchema` is a real JSON Schema, validated at the API boundary. This is what stops a
 * renaming in the producer from silently producing "Hello {{name}}" emails that say "Hello ".
 */
export interface TopicSeed {
  key: string;
  name: string;
  category: TopicCategory;
  priority: Priority;
  defaultChannels: Channel[];
  dedupWindowSec: number;
  payloadSchema: Prisma.InputJsonValue;
}

export const TOPIC_SEEDS: TopicSeed[] = [
  {
    key: 'user.welcome',
    name: 'Welcome email',
    category: TopicCategory.TRANSACTIONAL,
    priority: Priority.NORMAL,
    defaultChannels: [Channel.EMAIL, Channel.IN_APP],
    dedupWindowSec: 86_400, // a user should only ever be welcomed once a day, even on retries
    payloadSchema: {
      type: 'object',
      required: ['name'],
      additionalProperties: true,
      properties: {
        name: { type: 'string', minLength: 1 },
        activationUrl: { type: 'string', format: 'uri' },
      },
    },
  },
  {
    key: 'order.shipped',
    name: 'Order shipped',
    category: TopicCategory.TRANSACTIONAL,
    priority: Priority.HIGH,
    // The showcase topic: fans out across every channel at once.
    defaultChannels: [Channel.EMAIL, Channel.IN_APP, Channel.PUSH, Channel.SLACK, Channel.SMS],
    dedupWindowSec: 300,
    payloadSchema: {
      type: 'object',
      required: ['orderId', 'carrier', 'trackingNumber'],
      additionalProperties: true,
      properties: {
        orderId: { type: 'string', minLength: 1 },
        carrier: { type: 'string', minLength: 1 },
        trackingNumber: { type: 'string', minLength: 1 },
        trackingUrl: { type: 'string', format: 'uri' },
        etaDate: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'qty'],
            properties: { name: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
          },
        },
      },
    },
  },
  {
    key: 'security.login_alert',
    name: 'New login alert',
    category: TopicCategory.TRANSACTIONAL,
    // CRITICAL is what lets this ignore quiet hours: a 3am "someone logged in from Brazil"
    // is exactly the notification you do want waking you up.
    priority: Priority.CRITICAL,
    defaultChannels: [Channel.EMAIL, Channel.IN_APP, Channel.PUSH],
    dedupWindowSec: 0,
    payloadSchema: {
      type: 'object',
      required: ['ipAddress', 'location', 'device'],
      additionalProperties: true,
      properties: {
        ipAddress: { type: 'string', minLength: 1 },
        location: { type: 'string', minLength: 1 },
        device: { type: 'string', minLength: 1 },
        at: { type: 'string' },
        secureAccountUrl: { type: 'string', format: 'uri' },
      },
    },
  },
  {
    key: 'product.newsletter',
    name: 'Product newsletter',
    // MARKETING: honours unsubscribe, quiet hours and digest batching.
    category: TopicCategory.MARKETING,
    priority: Priority.LOW,
    defaultChannels: [Channel.EMAIL, Channel.IN_APP],
    dedupWindowSec: 3_600,
    payloadSchema: {
      type: 'object',
      required: ['headline', 'body'],
      additionalProperties: true,
      properties: {
        headline: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
        ctaLabel: { type: 'string' },
        ctaUrl: { type: 'string', format: 'uri' },
      },
    },
  },
  {
    // Internal topic used by the digest flush job to send the summary itself. Producers never
    // post to it directly; the ingest endpoint rejects `system.*` keys.
    key: 'system.digest',
    name: 'Digest summary',
    category: TopicCategory.TRANSACTIONAL,
    priority: Priority.LOW,
    defaultChannels: [Channel.EMAIL],
    dedupWindowSec: 0,
    payloadSchema: {
      type: 'object',
      required: ['count', 'items', 'window'],
      additionalProperties: true,
      properties: {
        window: { type: 'string' },
        count: { type: 'integer', minimum: 1 },
        isSingular: { type: 'boolean' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { subject: { type: 'string' }, body: { type: 'string' } },
          },
        },
      },
    },
  },
  {
    key: 'comment.mentioned',
    name: 'You were mentioned',
    category: TopicCategory.TRANSACTIONAL,
    priority: Priority.NORMAL,
    // The natural digest candidate: 40 mentions should not be 40 emails.
    defaultChannels: [Channel.IN_APP, Channel.PUSH, Channel.EMAIL],
    dedupWindowSec: 0,
    payloadSchema: {
      type: 'object',
      required: ['authorName', 'excerpt'],
      additionalProperties: true,
      properties: {
        authorName: { type: 'string', minLength: 1 },
        excerpt: { type: 'string', minLength: 1 },
        threadUrl: { type: 'string', format: 'uri' },
      },
    },
  },
];
