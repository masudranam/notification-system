import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppConfig } from 'src/config/configuration';
import { PrismaService } from 'src/prisma/prisma.service';
import { DispatchJobData, JOB, QUEUE } from 'src/queue/queue.constants';
import { runWithCorrelationId } from 'src/common/correlation/correlation.store';
import {
  NotificationCreatedPayload,
  OUTBOX_BATCH_SIZE,
  OUTBOX_EVENT,
  OUTBOX_MAX_ATTEMPTS,
} from './outbox.constants';

/** Keep the claim transaction short: it holds locks that block every other relay instance. */
const CLAIM_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/**
 * Relays committed outbox rows onto the dispatch queue.
 *
 * Why a poller at all? Because the alternative — enqueueing straight from the request handler —
 * has an unfixable gap: the DB transaction commits, then the process dies before `queue.add()`
 * lands. The notification is durably stored and permanently invisible. Writing an outbox row
 * inside the same transaction moves the problem into a place we control: worst case the relay
 * enqueues twice, and duplicate dispatch is idempotent (see `markProcessed` and the
 * `deliveryId` uniqueness downstream).
 *
 * The claim query uses `FOR UPDATE SKIP LOCKED`, which is what makes this safe to run on every
 * instance simultaneously: each replica locks a disjoint set of rows and no two relays ever hand
 * the same event to the queue.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectQueue(QUEUE.DISPATCH) private readonly dispatchQueue: Queue<DispatchJobData>,
  ) {}

  onApplicationBootstrap() {
    const interval = this.config.get('tuning', { infer: true }).outboxPollIntervalMs;
    this.timer = setInterval(() => void this.tick(), interval);
    this.logger.log(`Outbox relay polling every ${interval}ms`);
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Overlap guard: a slow tick must not stack up behind the interval timer. */
  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      return await this.relayBatch();
    } catch (err) {
      this.logger.error(`Outbox tick failed: ${(err as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async relayBatch(): Promise<number> {
    // Claim rows and mark them in one transaction so a crash mid-tick releases the locks and
    // another instance retries them.
    //
    // Explicit timeouts rather than Prisma's 5s default: this transaction holds row locks that
    // block every other relay instance, so it must fail fast rather than linger. `maxWait` caps
    // how long we queue for a connection when the pool is busy. Observed in practice after the
    // host slept mid-tick — the transaction was 245s old on resume and the commit was rejected,
    // which the outer catch handles by simply retrying the batch.
    const claimed = await this.prisma.$transaction(async (tx) => {
      // `NOW() AT TIME ZONE 'UTC'`, not plain `NOW()`.
      //
      // Prisma maps DateTime to `timestamp without time zone` and writes UTC into it, while
      // NOW() returns a `timestamptz`. Comparing the two makes Postgres coerce the naive column
      // using the *session* time zone — so on a server set to America/Los_Angeles, a row written
      // "now" reads as 7 hours in the future and is never picked up. The relay silently stops.
      // Converting NOW() to a naive UTC timestamp puts both sides in the same frame of reference.
      const rows = await tx.$queryRaw<
        Array<{ id: string; type: string; payload: unknown; attempts: number }>
      >`
        SELECT id, type, payload, attempts
        FROM outbox_events
        WHERE "processedAt" IS NULL
          AND "availableAt" <= (NOW() AT TIME ZONE 'UTC')
          AND attempts < ${OUTBOX_MAX_ATTEMPTS}
        ORDER BY "createdAt" ASC
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];

      // Bump attempts while still holding the lock. If enqueueing then fails, the row is already
      // counted against its retry budget and cannot spin forever.
      await tx.outboxEvent.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { attempts: { increment: 1 } },
      });
      return rows;
    }, CLAIM_TX_OPTIONS);

    if (claimed.length === 0) return 0;

    let relayed = 0;
    for (const row of claimed) {
      try {
        await this.handle(row.type, row.payload);
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date(), lastError: null },
        });
        relayed += 1;
      } catch (err) {
        const message = (err as Error).message;
        // Back the row off exponentially so a broken Redis doesn't produce a hot loop.
        const backoffMs = Math.min(30_000, 500 * 2 ** row.attempts);
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { lastError: message, availableAt: new Date(Date.now() + backoffMs) },
        });
        this.logger.warn(
          `Outbox event ${row.id} (${row.type}) failed, retry in ${backoffMs}ms: ${message}`,
        );
      }
    }

    if (relayed > 0) {
      this.logger.debug(`Relayed ${relayed}/${claimed.length} outbox events`);
    }
    return relayed;
  }

  private async handle(type: string, payload: unknown): Promise<void> {
    switch (type) {
      case OUTBOX_EVENT.NOTIFICATION_CREATED:
        return this.enqueueDispatch(payload as NotificationCreatedPayload);
      default:
        // Unknown types must not block the queue; log once and treat as processed.
        this.logger.warn(`Ignoring unknown outbox event type "${type}"`);
        return;
    }
  }

  private async enqueueDispatch(payload: NotificationCreatedPayload) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: payload.notificationId },
      select: { id: true, scheduledAt: true, correlationId: true },
    });
    if (!notification) {
      this.logger.warn(`Outbox references missing notification ${payload.notificationId}`);
      return;
    }

    // Scheduled sends are just a job delay — no separate scheduler table to keep in sync.
    const delay = notification.scheduledAt
      ? Math.max(0, notification.scheduledAt.getTime() - Date.now())
      : 0;

    await runWithCorrelationId(notification.correlationId, async () =>
      this.dispatchQueue.add(
        JOB.DISPATCH_NOTIFICATION,
        { notificationId: notification.id, correlationId: notification.correlationId },
        {
          // Deterministic jobId makes a double-relay a no-op: BullMQ rejects a duplicate id
          // while the job is still known to the queue.
          // Hyphens, not colons — BullMQ reserves `:` as its Redis key separator and rejects
          // custom ids containing it.
          jobId: `dispatch-${notification.id}`,
          delay,
        },
      ),
    );
  }
}
