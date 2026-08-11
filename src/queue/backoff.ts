import { WorkerOptions } from 'bullmq';

/**
 * Jittered exponential backoff.
 *
 * Plain exponential backoff *synchronises* retries: a provider outage fails 500 jobs at once, and
 * all 500 retry at exactly t+1s, t+2s, t+4s — hammering the provider the moment it recovers and
 * likely tripping its rate limiter again. Full jitter spreads each retry uniformly across its
 * window, which flattens that thundering herd.
 *
 * Note where this lives: BullMQ resolves custom backoff strategies on the *worker*, not the queue
 * (`QueueOptions` has no `settings` field). Every processor therefore spreads `WORKER_SETTINGS`
 * into its @Processor options, and jobs opt in with `backoff: { type: BACKOFF_JITTER }`.
 */
export function jitteredBackoff(attemptsMade: number): number {
  const base = 1000;
  const cap = 5 * 60 * 1000; // never wait more than 5 minutes
  const expWindow = Math.min(cap, base * 2 ** attemptsMade);
  // Full jitter: uniform across [0, window) rather than window +/- a little.
  return Math.floor(Math.random() * expWindow);
}

/** Spread into every @Processor so all workers understand the custom backoff type. */
export const WORKER_SETTINGS: Pick<WorkerOptions, 'settings'> = {
  settings: {
    backoffStrategy: (attemptsMade: number) => jitteredBackoff(attemptsMade),
  },
};
