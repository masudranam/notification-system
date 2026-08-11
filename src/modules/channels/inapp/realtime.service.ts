import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject, filter, map } from 'rxjs';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from 'src/redis/redis.module';

export interface RealtimeEvent {
  userId: string;
  type: 'notification' | 'read' | 'read-all';
  payload: Record<string, unknown>;
}

const CHANNEL_PATTERN = 'realtime:user:*';
const channelFor = (userId: string) => `realtime:user:${userId}`;

/**
 * Fan-out for the in-app notification feed, routed through Redis pub/sub.
 *
 * Why Redis and not just an in-process EventEmitter? Because SSE connections are sticky to one
 * process. With two API instances behind a load balancer, a user's browser holds an open stream on
 * instance A while their notification is processed by a worker on instance B. An in-memory emitter
 * on B reaches nobody. Publishing to Redis means whichever instance holds the connection receives
 * it and pushes it down the wire.
 *
 * The local Subject exists only to bridge Redis messages into an RxJS stream that Nest's `@Sse()`
 * decorator can consume.
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events$ = new Subject<RealtimeEvent>();

  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onModuleInit() {
    // One pattern subscription for all users. Subscribing per connected user would mean a
    // SUBSCRIBE/UNSUBSCRIBE round trip on every page load and a growing subscription set.
    await this.subscriber.psubscribe(CHANNEL_PATTERN);
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      try {
        const event = JSON.parse(message) as RealtimeEvent;
        this.events$.next(event);
      } catch (err) {
        this.logger.warn(`Bad realtime payload on ${channel}: ${(err as Error).message}`);
      }
    });
    this.logger.log(`Subscribed to ${CHANNEL_PATTERN}`);
  }

  async onModuleDestroy() {
    this.events$.complete();
    await this.subscriber.punsubscribe(CHANNEL_PATTERN).catch(() => undefined);
  }

  async publish(event: RealtimeEvent): Promise<void> {
    await this.publisher.publish(channelFor(event.userId), JSON.stringify(event));
  }

  /** Per-user stream for the SSE endpoint. */
  streamFor(userId: string): Observable<{ data: RealtimeEvent }> {
    return this.events$.pipe(
      filter((event) => event.userId === userId),
      map((event) => ({ data: event })),
    );
  }
}
