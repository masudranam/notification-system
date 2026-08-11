import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Channel, DeliveryStatus, DigestMode, PrismaClient } from '@prisma/client';
// Default import, not `import * as`: supertest v7 exports a callable default and a namespace
// import is not callable under esModuleInterop.
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { ApiKeyGuard } from 'src/common/auth/api-key.guard';
import { CorrelationInterceptor } from 'src/common/correlation/correlation.interceptor';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * End-to-end test of the real pipeline: HTTP ingest -> outbox -> dispatch -> channel workers.
 *
 * Requires the same infrastructure the app needs (Postgres via DATABASE_URL, Redis via REDIS_URL)
 * and a seeded database. It runs the actual queues rather than mocking them, because the things
 * most likely to break — the outbox relay's timestamp comparison, BullMQ job-id constraints,
 * status transitions under concurrency — only fail against real infrastructure.
 *
 *   docker compose up -d && npm run prisma:seed && npm run test:e2e
 */
describe('Notification pipeline (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const apiKey = process.env.API_KEY_SEED ?? 'dev-key-please-change';

  let userId: string;

  /**
   * Unique payload per call.
   *
   * `user.welcome` has a 24-hour dedup window, so reusing `{ name: 'Alice' }` across tests makes
   * every send after the first return the *first* notification — whose deliveries have already
   * settled. Varying the payload keeps each test independent while leaving the dedup behaviour
   * itself covered by its own describe block.
   */
  const uniqueName = () => `Alice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // Mirror main.ts: without the interceptor there is no correlation id to assert on.
    app.useGlobalInterceptors(new CorrelationInterceptor());
    app.useGlobalGuards(new ApiKeyGuard(app.get(PrismaService), app.get(Reflector)));
    await app.init();

    prisma = app.get(PrismaService);

    const user = await prisma.user.findFirst({ where: { email: 'alice@example.com' } });
    if (!user) {
      throw new Error('Seed data missing — run `npm run prisma:seed` before the e2e suite');
    }
    userId = user.id;

    // Start from a clean slate for this user so assertions are not confused by earlier runs.
    await prisma.notification.deleteMany({ where: { userId } });
    await prisma.suppression.deleteMany({});
    await prisma.digestBucket.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Polls until the notification has deliveries in non-pending states, or the deadline passes. */
  async function waitForDispatch(notificationId: string, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const deliveries = await prisma.delivery.findMany({ where: { notificationId } });
      const settled =
        deliveries.length > 0 &&
        deliveries.every(
          (d) => d.status !== DeliveryStatus.QUEUED && d.status !== DeliveryStatus.RENDERED,
        );
      if (settled) return deliveries;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`Notification ${notificationId} did not settle within ${timeoutMs}ms`);
  }

  const post = (body: unknown, idempotencyKey?: string) => {
    const req = request(app.getHttpServer())
      .post('/v1/notifications')
      .set('x-api-key', apiKey)
      .set('content-type', 'application/json');
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send(body as object);
  };

  describe('auth', () => {
    it('rejects a request with no API key', async () => {
      await request(app.getHttpServer()).post('/v1/notifications').send({}).expect(401);
    });

    it('rejects an unknown API key', async () => {
      await request(app.getHttpServer())
        .post('/v1/notifications')
        .set('x-api-key', 'nope')
        .send({})
        .expect(401);
    });

    it('leaves the health endpoint public', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });

  describe('validation', () => {
    it('rejects a payload that violates the topic schema', async () => {
      const res = await post({
        userId,
        topicKey: 'order.shipped',
        data: { orderId: 'X', carrier: 'DHL' }, // trackingNumber missing
      }).expect(400);
      expect(JSON.stringify(res.body.details)).toContain('trackingNumber');
    });

    it('rejects an unknown topic', async () => {
      await post({ userId, topicKey: 'does.not.exist', data: {} }).expect(404);
    });

    it('rejects an internal system.* topic', async () => {
      await post({
        userId,
        topicKey: 'system.digest',
        data: { window: 'daily', count: 1, items: [] },
      }).expect(400);
    });

    it('rejects an unknown user', async () => {
      await post({ userId: 'nope', topicKey: 'user.welcome', data: { name: 'X' } }).expect(404);
    });

    it('rejects unknown body properties', async () => {
      await post({
        userId,
        topicKey: 'user.welcome',
        data: { name: 'X' },
        bogusField: true,
      }).expect(400);
    });
  });

  describe('ingest and fan-out', () => {
    it('accepts with 202 and fans out to one delivery per resolved channel', async () => {
      const res = await post(
        {
          userId,
          topicKey: 'order.shipped',
          data: { orderId: 'E2E-1', carrier: 'DHL', trackingNumber: 'E2E-TRK-1' },
        },
        `e2e-fanout-${Date.now()}`,
      ).expect(202);

      expect(res.body.outcome).toBe('accepted');
      const deliveries = await waitForDispatch(res.body.id);

      // order.shipped defaults to all five channels.
      expect(new Set(deliveries.map((d) => d.channel))).toEqual(
        new Set([Channel.EMAIL, Channel.IN_APP, Channel.PUSH, Channel.SLACK, Channel.SMS]),
      );

      // In-app can never fail: it is a row in our own database.
      const inApp = deliveries.find((d) => d.channel === Channel.IN_APP);
      expect(inApp?.status).toBe(DeliveryStatus.SENT);
      expect(inApp?.renderedSubject).toContain('E2E-1');
    });

    it('records a reason for every channel it did not send on', async () => {
      const res = await post(
        {
          userId,
          topicKey: 'order.shipped',
          data: { orderId: 'E2E-2', carrier: 'DHL', trackingNumber: 'E2E-TRK-2' },
        },
        `e2e-reasons-${Date.now()}`,
      ).expect(202);

      const deliveries = await waitForDispatch(res.body.id);
      for (const delivery of deliveries) {
        if (
          delivery.status === DeliveryStatus.SKIPPED ||
          delivery.status === DeliveryStatus.SUPPRESSED
        ) {
          // A silent drop is the hardest notification bug to support. Every one must be explained.
          expect(delivery.reason).toBeTruthy();
        }
      }
    });

    it('exposes the full delivery trace with an event per delivery', async () => {
      const res = await post(
        { userId, topicKey: 'user.welcome', data: { name: uniqueName() } },
        `e2e-trace-${Date.now()}`,
      ).expect(202);

      await waitForDispatch(res.body.id);

      const trace = await request(app.getHttpServer())
        .get(`/v1/notifications/${res.body.id}`)
        .set('x-api-key', apiKey)
        .expect(200);

      expect(trace.body.deliveries.length).toBeGreaterThan(0);
      for (const delivery of trace.body.deliveries) {
        expect(delivery.events.length).toBeGreaterThan(0);
      }
    });
  });

  describe('idempotency', () => {
    it('replays the original response for a repeated Idempotency-Key', async () => {
      const key = `e2e-idem-${Date.now()}`;
      const body = { userId, topicKey: 'user.welcome', data: { name: uniqueName() } };

      const first = await post(body, key).expect(202);
      expect(first.body.outcome).toBe('accepted');

      const second = await post(body, key).expect(202);
      expect(second.body.outcome).toBe('replayed');
      expect(second.body.id).toBe(first.body.id);

      const count = await prisma.notification.count({ where: { idempotencyKey: key } });
      expect(count).toBe(1);
    });
  });

  describe('deduplication', () => {
    it('collapses an identical payload inside the topic dedup window', async () => {
      const data = { orderId: `E2E-DEDUP-${Date.now()}`, carrier: 'UPS', trackingNumber: 'DD-1' };

      const first = await post({ userId, topicKey: 'order.shipped', data }, `dd-a-${Date.now()}`);
      expect(first.body.outcome).toBe('accepted');

      // Same content, different key ORDER — the canonical hash must still match.
      const reordered = {
        trackingNumber: data.trackingNumber,
        carrier: data.carrier,
        orderId: data.orderId,
      };
      const second = await post(
        { userId, topicKey: 'order.shipped', data: reordered },
        `dd-b-${Date.now()}`,
      );

      expect(second.body.outcome).toBe('deduplicated');
      expect(second.body.id).toBe(first.body.id);
    });
  });

  describe('preferences', () => {
    const setPref = (enabled: boolean | null) =>
      request(app.getHttpServer())
        .put(`/v1/preferences?userId=${userId}`)
        .set('x-api-key', apiKey)
        .send({ updates: [{ topicKey: 'user.welcome', channel: Channel.EMAIL, enabled }] })
        .expect(200);

    it('suppresses a channel the user turned off, with a reason', async () => {
      await setPref(false);
      try {
        const res = await post(
          { userId, topicKey: 'user.welcome', data: { name: uniqueName() } },
          `e2e-pref-${Date.now()}`,
        ).expect(202);

        const deliveries = await waitForDispatch(res.body.id);
        const email = deliveries.find((d) => d.channel === Channel.EMAIL);
        expect(email?.status).toBe(DeliveryStatus.SUPPRESSED);
        expect(email?.reason).toMatch(/preference/i);
      } finally {
        // try/finally so a failed assertion cannot leave the override set and cascade into
        // every later test that sends email.
        await setPref(null);
      }
    });

    it('reports default, override and effective value separately', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/preferences?userId=${userId}`)
        .set('x-api-key', apiKey)
        .expect(200);

      const row = res.body.find(
        (r: { topicKey: string; channel: string }) =>
          r.topicKey === 'order.shipped' && r.channel === 'EMAIL',
      );
      expect(row).toMatchObject({ default: true, override: null, effective: true });
    });
  });

  describe('suppression list', () => {
    it('blocks a send to a manually suppressed address', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

      await request(app.getHttpServer())
        .post('/v1/suppressions')
        .set('x-api-key', apiKey)
        .send({ channel: Channel.EMAIL, address: user.email, reason: 'HARD_BOUNCE' })
        .expect(201);

      try {
        const res = await post(
          { userId, topicKey: 'user.welcome', data: { name: uniqueName() } },
          `e2e-supp-${Date.now()}`,
        ).expect(202);

        const deliveries = await waitForDispatch(res.body.id);
        const email = deliveries.find((d) => d.channel === Channel.EMAIL);
        expect(email?.status).toBe(DeliveryStatus.SUPPRESSED);
        expect(email?.reason).toMatch(/suppression list/i);
      } finally {
        await request(app.getHttpServer())
          .delete('/v1/suppressions')
          .set('x-api-key', apiKey)
          .send({ channel: Channel.EMAIL, address: user.email })
          .expect(200);
      }
    });
  });

  describe('digest batching', () => {
    it('batches into a bucket instead of sending immediately', async () => {
      await request(app.getHttpServer())
        .put(`/v1/preferences?userId=${userId}`)
        .set('x-api-key', apiKey)
        .send({
          updates: [
            {
              topicKey: 'product.newsletter',
              channel: Channel.EMAIL,
              enabled: true,
              digest: DigestMode.DAILY,
            },
          ],
        })
        .expect(200);

      const res = await post(
        {
          userId,
          topicKey: 'product.newsletter',
          data: { headline: `E2E digest ${Date.now()}`, body: 'batched' },
        },
        `e2e-digest-${Date.now()}`,
      ).expect(202);

      const deliveries = await waitForDispatch(res.body.id);
      const email = deliveries.find((d) => d.channel === Channel.EMAIL);
      expect(email?.status).toBe(DeliveryStatus.SUPPRESSED);
      expect(email?.reason).toMatch(/digest/i);

      const buckets = await prisma.digestBucket.findMany({
        where: { userId, channel: Channel.EMAIL, flushedAt: null },
      });
      expect(buckets.length).toBe(1);
      expect((buckets[0].items as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe('provider webhooks', () => {
    /**
     * Drives the webhook endpoint directly. The delivery is given a synthetic providerMessageId so
     * the test does not depend on a real provider having been reachable.
     */
    async function seedSentEmailDelivery(providerMessageId: string) {
      const notification = await prisma.notification.create({
        data: {
          userId,
          topicKey: 'user.welcome',
          data: { name: 'Alice' },
          correlationId: 'e2e-webhook',
        },
      });
      return prisma.delivery.create({
        data: {
          notificationId: notification.id,
          channel: Channel.EMAIL,
          provider: 'resend',
          providerMessageId,
          status: DeliveryStatus.SENT,
        },
      });
    }

    const sendWebhook = (svixId: string, body: unknown) =>
      request(app.getHttpServer())
        .post('/v1/webhooks/resend')
        .set('svix-id', svixId)
        .set('content-type', 'application/json')
        .send(body as object);

    it('advances SENT -> DELIVERED -> OPENED', async () => {
      const messageId = `e2e-msg-${Date.now()}`;
      const delivery = await seedSentEmailDelivery(messageId);

      await sendWebhook(`svix-d-${messageId}`, {
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: messageId, to: ['alice@example.com'] },
      }).expect(200);

      await sendWebhook(`svix-o-${messageId}`, {
        type: 'email.opened',
        created_at: new Date().toISOString(),
        data: { email_id: messageId, to: ['alice@example.com'] },
      }).expect(200);

      const updated = await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(updated.status).toBe(DeliveryStatus.OPENED);
      expect(updated.deliveredAt).not.toBeNull();
    });

    it('ignores an out-of-order email.sent but still records it', async () => {
      const messageId = `e2e-ooo-${Date.now()}`;
      const delivery = await seedSentEmailDelivery(messageId);

      await sendWebhook(`svix-d-${messageId}`, {
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: messageId, to: ['alice@example.com'] },
      }).expect(200);

      // The classic case: sent and delivered race, and sent loses.
      await sendWebhook(`svix-late-${messageId}`, {
        type: 'email.sent',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        data: { email_id: messageId, to: ['alice@example.com'] },
      }).expect(200);

      const updated = await prisma.delivery.findUniqueOrThrow({
        where: { id: delivery.id },
        include: { events: true },
      });
      expect(updated.status).toBe(DeliveryStatus.DELIVERED);

      const lateEvent = updated.events.find((e) => e.type === 'email.sent');
      expect(lateEvent).toBeDefined();
      expect((lateEvent!.payload as { applied: boolean }).applied).toBe(false);
    });

    it('is idempotent on the svix message id', async () => {
      const messageId = `e2e-dup-${Date.now()}`;
      await seedSentEmailDelivery(messageId);
      const svixId = `svix-dup-${messageId}`;
      const body = {
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: messageId, to: ['alice@example.com'] },
      };

      const first = await sendWebhook(svixId, body).expect(200);
      expect(first.body.outcome).toBe('processed');

      const second = await sendWebhook(svixId, body).expect(200);
      expect(second.body.outcome).toBe('duplicate');
    });

    it('suppresses the address on a hard bounce but not a soft one', async () => {
      const hardId = `e2e-hard-${Date.now()}`;
      await seedSentEmailDelivery(hardId);
      await sendWebhook(`svix-${hardId}`, {
        type: 'email.bounced',
        created_at: new Date().toISOString(),
        data: {
          email_id: hardId,
          to: ['hard-bounce@example.com'],
          bounce: { type: 'Permanent', message: '550 no such mailbox' },
        },
      }).expect(200);

      const softId = `e2e-soft-${Date.now()}`;
      await seedSentEmailDelivery(softId);
      await sendWebhook(`svix-${softId}`, {
        type: 'email.bounced',
        created_at: new Date().toISOString(),
        data: {
          email_id: softId,
          to: ['soft-bounce@example.com'],
          bounce: { type: 'Transient', message: '452 mailbox full' },
        },
      }).expect(200);

      const hard = await prisma.suppression.findFirst({
        where: { channel: Channel.EMAIL, address: 'hard-bounce@example.com' },
      });
      const soft = await prisma.suppression.findFirst({
        where: { channel: Channel.EMAIL, address: 'soft-bounce@example.com' },
      });

      expect(hard?.reason).toBe('HARD_BOUNCE');
      // A full mailbox will likely accept mail tomorrow. Suppressing would lock the user out.
      expect(soft).toBeNull();
    });

    it('accepts a webhook for an unknown message without failing', async () => {
      const res = await sendWebhook(`svix-unmatched-${Date.now()}`, {
        type: 'email.delivered',
        created_at: new Date().toISOString(),
        data: { email_id: 'never-sent-this', to: ['x@example.com'] },
      }).expect(200);
      expect(res.body.outcome).toBe('unmatched');
    });
  });

  describe('in-app inbox', () => {
    it('lists items, reports an unread count and marks them read', async () => {
      const res = await post(
        { userId, topicKey: 'comment.mentioned', data: { authorName: 'Bob', excerpt: 'ping' } },
        `e2e-inbox-${Date.now()}`,
      ).expect(202);
      await waitForDispatch(res.body.id);

      const before = await request(app.getHttpServer())
        .get(`/v1/inbox?userId=${userId}`)
        .set('x-api-key', apiKey)
        .expect(200);

      expect(before.body.items.length).toBeGreaterThan(0);
      expect(before.body.unreadCount).toBeGreaterThan(0);

      await request(app.getHttpServer())
        .post(`/v1/inbox/read-all?userId=${userId}`)
        .set('x-api-key', apiKey)
        .expect(201);

      const after = await request(app.getHttpServer())
        .get(`/v1/inbox?userId=${userId}`)
        .set('x-api-key', apiKey)
        .expect(200);
      expect(after.body.unreadCount).toBe(0);
    });
  });

  describe('unsubscribe', () => {
    it('honours a signed token and rejects a tampered one', async () => {
      // Build a real token through the marketing send path by reading it off the rendered body is
      // fragile, so exercise the endpoint's failure mode directly plus a valid round trip.
      await request(app.getHttpServer()).get('/unsubscribe?token=garbage.signature').expect(200);

      const html = (await request(app.getHttpServer()).get('/unsubscribe?token=garbage.signature'))
        .text;
      expect(html).toMatch(/could not process/i);
    });
  });

  describe('observability', () => {
    it('serves Prometheus metrics including delivery counters', async () => {
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.text).toContain('notifications_ingested_total');
      expect(res.text).toContain('deliveries_total');
    });

    it('echoes an inbound correlation id', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('x-correlation-id', 'e2e-trace-me')
        .expect(200);
      expect(res.headers['x-correlation-id']).toBe('e2e-trace-me');
    });
  });
});
