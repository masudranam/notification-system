import { Channel, DigestMode, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TOPIC_SEEDS } from './topics';
import { TEMPLATE_SEEDS } from './templates';

/**
 * Idempotent seed: every write is an upsert on a natural key, so re-running it is safe and
 * updates existing rows rather than duplicating them.
 */
const prisma = new PrismaClient();

const API_KEY = process.env.API_KEY_SEED ?? 'dev-key-please-change';

async function seedTopics() {
  for (const topic of TOPIC_SEEDS) {
    const { key, ...rest } = topic;
    await prisma.topic.upsert({ where: { key }, create: { key, ...rest }, update: rest });
  }
  console.log(`  topics:     ${TOPIC_SEEDS.length}`);
}

async function seedTemplates() {
  for (const template of TEMPLATE_SEEDS) {
    const { topicKey, channel, locale, version, ...rest } = template;
    await prisma.template.upsert({
      where: { topicKey_channel_locale_version: { topicKey, channel, locale, version } },
      create: { topicKey, channel, locale, version, ...rest },
      update: rest,
    });
  }
  console.log(`  templates:  ${TEMPLATE_SEEDS.length}`);
}

async function seedUsers() {
  // Primary demo user: reachable on every channel, with a quiet window that wraps midnight.
  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    create: {
      email: 'alice@example.com',
      phone: '+8801700000001',
      slackChannelId: 'demo-channel',
      timezone: 'Asia/Dhaka',
      locale: 'en',
      quietHoursStart: 22,
      quietHoursEnd: 7,
    },
    update: {},
  });

  // Second user: no phone (so SMS deliveries are SKIPPED, not failed), no quiet hours,
  // and a Bengali locale to exercise template locale selection + fallback.
  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    create: {
      email: 'bob@example.com',
      phone: null,
      timezone: 'UTC',
      locale: 'bn',
    },
    update: {},
  });

  // Explicit preference overrides, so the resolver has something interesting to resolve.
  await prisma.preference.upsert({
    where: {
      userId_topicKey_channel: {
        userId: alice.id,
        topicKey: 'product.newsletter',
        channel: Channel.EMAIL,
      },
    },
    // Alice batches the newsletter into a daily digest instead of taking it immediately.
    create: {
      userId: alice.id,
      topicKey: 'product.newsletter',
      channel: Channel.EMAIL,
      enabled: true,
      digest: DigestMode.DAILY,
    },
    update: { digest: DigestMode.DAILY },
  });

  await prisma.preference.upsert({
    where: {
      userId_topicKey_channel: { userId: bob.id, topicKey: 'order.shipped', channel: Channel.EMAIL },
    },
    // Bob explicitly opted out of shipping emails but still gets the other channels.
    create: {
      userId: bob.id,
      topicKey: 'order.shipped',
      channel: Channel.EMAIL,
      enabled: false,
    },
    update: { enabled: false },
  });

  console.log(`  users:      2 (alice=${alice.id}, bob=${bob.id})`);
  return { alice, bob };
}

async function seedApiKey() {
  const hashedKey = createHash('sha256').update(API_KEY).digest('hex');
  await prisma.apiKey.upsert({
    where: { hashedKey },
    create: { name: 'local-dev', hashedKey, scopes: ['notifications:write', 'admin'] },
    update: { revokedAt: null },
  });
  console.log(`  api key:    ${API_KEY}  (send as x-api-key)`);
}

async function main() {
  console.log('Seeding notification system...');
  await seedTopics();
  await seedTemplates();
  const { alice } = await seedUsers();
  await seedApiKey();

  console.log('\nTry it:');
  console.log(`  curl -X POST http://localhost:3000/v1/notifications \\`);
  console.log(`    -H "x-api-key: ${API_KEY}" -H "content-type: application/json" \\`);
  console.log(`    -H "Idempotency-Key: demo-1" \\`);
  console.log(
    `    -d '{"userId":"${alice.id}","topicKey":"order.shipped",` +
      `"data":{"orderId":"A-1001","carrier":"DHL","trackingNumber":"TRK123"}}'`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
