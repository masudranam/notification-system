import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Notification, NotificationStatus, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { getCorrelationId, newCorrelationId } from 'src/common/correlation/correlation.store';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { TopicsService } from 'src/modules/topics/topics.service';
import { OUTBOX_EVENT } from 'src/modules/outbox/outbox.constants';
import { CreateNotificationDto } from './dto/create-notification.dto';

export interface IngestResult {
  id: string;
  status: NotificationStatus;
  /** accepted = new work queued · replayed = idempotent hit · deduplicated = collapsed */
  outcome: 'accepted' | 'replayed' | 'deduplicated';
  scheduledAt?: Date | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly topics: TopicsService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Accepts a notification request and returns immediately.
   *
   * The whole method is about getting to a durable commit as fast as possible and letting workers
   * do the slow parts. Three guards run before that commit:
   *
   *   1. **Idempotency** — the caller's `Idempotency-Key`. Producers retry on timeout, and without
   *      this a network blip becomes two emails. The stored response is replayed verbatim so the
   *      retry is indistinguishable from the original call.
   *   2. **Dedup** — a content hash inside the topic's window. Catches the case where a producer
   *      genuinely fires the same event twice with *different* idempotency keys (e.g. two
   *      instances reacting to the same upstream message).
   *   3. **Payload validation** — the topic's JSON Schema.
   */
  async ingest(dto: CreateNotificationDto, idempotencyKey?: string): Promise<IngestResult> {
    this.topics.assertProducerAllowed(dto.topicKey);
    const topic = await this.topics.get(dto.topicKey);
    this.topics.assertValidPayload(topic, dto.data);

    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException(`Unknown user "${dto.userId}"`);
    }

    // --- guard 1: idempotent replay -------------------------------------------------
    if (idempotencyKey) {
      const existing = await this.prisma.notification.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.metrics.ingested.inc({ topic: dto.topicKey, outcome: 'replayed' });
        this.logger.log(
          `Idempotent replay of ${existing.id} for key "${idempotencyKey}"`,
          'Ingest',
        );
        return this.toResult(existing, 'replayed');
      }
    }

    // --- guard 2: content dedup window ----------------------------------------------
    const dedupKey = this.buildDedupKey(dto);
    if (topic.dedupWindowSec > 0) {
      const since = new Date(Date.now() - topic.dedupWindowSec * 1000);
      const duplicate = await this.prisma.notification.findFirst({
        where: { dedupKey, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
      });
      if (duplicate) {
        this.metrics.ingested.inc({ topic: dto.topicKey, outcome: 'deduped' });
        this.logger.log(
          `Deduplicated against ${duplicate.id} (window ${topic.dedupWindowSec}s)`,
          'Ingest',
        );
        return this.toResult(duplicate, 'deduplicated');
      }
    }

    const correlationId = getCorrelationId() ?? newCorrelationId();

    // --- the durable commit ---------------------------------------------------------
    // Notification and OutboxEvent are written in ONE transaction. This is the crux of the
    // outbox pattern: if we instead committed the notification and then called queue.add(), a
    // crash in between would leave a notification that no worker will ever pick up. Here either
    // both rows exist (the relay will find the event) or neither does.
    const notification = await this.prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          userId: dto.userId,
          topicKey: dto.topicKey,
          data: dto.data as Prisma.InputJsonValue,
          idempotencyKey: idempotencyKey ?? null,
          dedupKey,
          correlationId,
          scheduledAt: dto.scheduledAt ?? null,
          requestedChannels: dto.channels ?? [],
          status: NotificationStatus.PENDING,
        },
      });

      await tx.outboxEvent.create({
        data: {
          type: OUTBOX_EVENT.NOTIFICATION_CREATED,
          payload: { notificationId: created.id, correlationId },
        },
      });

      // Cache the exact response body so a later replay returns byte-identical JSON.
      const snapshot: IngestResult = {
        id: created.id,
        status: created.status,
        outcome: 'accepted',
        scheduledAt: created.scheduledAt,
      };
      await tx.notification.update({
        where: { id: created.id },
        data: { responseSnapshot: snapshot as unknown as Prisma.InputJsonValue },
      });

      return created;
    });

    this.metrics.ingested.inc({ topic: dto.topicKey, outcome: 'accepted' });
    this.logger.log(`Accepted ${notification.id} (${dto.topicKey} -> ${dto.userId})`, 'Ingest');

    return this.toResult(notification, 'accepted');
  }

  /**
   * Content-addressed dedup key.
   *
   * JSON.stringify is not canonical — `{a:1,b:2}` and `{b:2,a:1}` serialise differently — so keys
   * are sorted before hashing. Without that, the same logical event from two producers would
   * hash differently and slip past the dedup window.
   */
  private buildDedupKey(dto: CreateNotificationDto): string {
    const canonical = stableStringify(dto.data);
    return createHash('sha256').update(`${dto.topicKey}|${dto.userId}|${canonical}`).digest('hex');
  }

  private toResult(notification: Notification, outcome: IngestResult['outcome']): IngestResult {
    return {
      id: notification.id,
      status: notification.status,
      outcome,
      scheduledAt: notification.scheduledAt,
    };
  }

  /** Full trace view: the notification, every delivery, and every delivery event. */
  async findOne(id: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, phone: true, timezone: true, locale: true } },
        topic: { select: { key: true, name: true, category: true, priority: true } },
        deliveries: {
          orderBy: { channel: 'asc' },
          include: { events: { orderBy: { occurredAt: 'asc' } } },
        },
      },
    });
    if (!notification) {
      throw new NotFoundException(`Unknown notification "${id}"`);
    }
    return notification;
  }

  async list(params: { userId?: string; topicKey?: string; limit: number; cursor?: string }) {
    const { userId, topicKey, limit, cursor } = params;
    const rows = await this.prisma.notification.findMany({
      where: { ...(userId ? { userId } : {}), ...(topicKey ? { topicKey } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        deliveries: { select: { channel: true, status: true, provider: true, reason: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id : null };
  }
}

/** Deterministic JSON: object keys sorted recursively so equal payloads hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
