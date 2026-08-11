import { Injectable } from '@nestjs/common';
import { Channel, DeliveryStatus } from '@prisma/client';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus instrumentation.
 *
 * The metric set is chosen to answer the four questions you actually ask during an incident:
 *   1. Is traffic arriving?          -> notifications_ingested_total
 *   2. Is it getting delivered?      -> deliveries_total{channel,status}
 *   3. Is the provider slow?         -> provider_send_duration_seconds
 *   4. Is work piling up?            -> queue_depth / circuit_breaker_state
 *
 * Note the label choices: channel and status are low-cardinality enums. Never label by userId or
 * notificationId — each distinct label value creates a new time series, and unbounded cardinality
 * is the standard way to take down a Prometheus server.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly ingested = new Counter({
    name: 'notifications_ingested_total',
    help: 'Notifications accepted at the API boundary',
    labelNames: ['topic', 'outcome'] as const, // outcome: accepted | replayed | deduped
    registers: [this.registry],
  });

  readonly deliveries = new Counter({
    name: 'deliveries_total',
    help: 'Delivery attempts by channel and terminal status',
    labelNames: ['channel', 'status'] as const,
    registers: [this.registry],
  });

  readonly sendDuration = new Histogram({
    name: 'provider_send_duration_seconds',
    help: 'Latency of a single provider send call',
    labelNames: ['channel', 'provider', 'outcome'] as const,
    // Buckets tuned for HTTP calls to email/push APIs, not for microsecond work.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'delivery_retries_total',
    help: 'Retries scheduled after a retryable provider error',
    labelNames: ['channel', 'provider'] as const,
    registers: [this.registry],
  });

  readonly deadLettered = new Counter({
    name: 'deliveries_dead_lettered_total',
    help: 'Jobs that exhausted their retries and were moved to the DLQ',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });

  readonly suppressed = new Counter({
    name: 'deliveries_suppressed_total',
    help: 'Deliveries deliberately not sent',
    labelNames: ['channel', 'reason'] as const,
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: 'queue_depth',
    help: 'Jobs in a queue by state',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });

  /** 0 = closed (healthy), 1 = open (failing fast), 2 = half-open (probing). */
  readonly breakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state per provider',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_pending_events',
    help: 'Unprocessed transactional-outbox rows',
    registers: [this.registry],
  });

  readonly webhooksReceived = new Counter({
    name: 'provider_webhooks_total',
    help: 'Inbound provider webhooks',
    labelNames: ['provider', 'type', 'outcome'] as const, // outcome: processed | duplicate | invalid
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordDelivery(channel: Channel, status: DeliveryStatus) {
    this.deliveries.inc({ channel, status });
  }

  /** Times a provider call and records the outcome, re-throwing so callers keep their error. */
  async timeSend<T>(channel: Channel, provider: string, fn: () => Promise<T>): Promise<T> {
    const stop = this.sendDuration.startTimer({ channel, provider });
    try {
      const result = await fn();
      stop({ outcome: 'success' });
      return result;
    } catch (err) {
      stop({ outcome: 'error' });
      throw err;
    }
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}
