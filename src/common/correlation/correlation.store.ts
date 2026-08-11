import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface CorrelationContext {
  correlationId: string;
}

/**
 * Request-scoped correlation id, carried implicitly through the async call graph.
 *
 * The interceptor opens a store per HTTP request; queue processors open one per job using the
 * correlationId that was persisted on the notification. That means a single id ties together:
 * the ingest request -> the outbox row -> the dispatch job -> each channel job -> the provider
 * webhook that arrives minutes later.
 */
const storage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function newCorrelationId(): string {
  return randomUUID();
}
