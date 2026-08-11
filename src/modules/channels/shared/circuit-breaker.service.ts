import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from 'src/config/configuration';
import { CircuitOpenError } from 'src/common/errors/provider.errors';
import { MetricsService } from 'src/modules/metrics/metrics.service';
import { REDIS_CLIENT } from 'src/redis/redis.module';

export type BreakerState = 'closed' | 'open' | 'half-open';

const STATE_METRIC: Record<BreakerState, number> = { closed: 0, open: 1, 'half-open': 2 };

/**
 * Per-provider circuit breaker, with state in Redis so every worker shares one view.
 *
 * Why bother, when retries already exist? Because retries are per-job and the breaker is
 * per-provider. If Resend is down, 500 queued emails will each independently make an HTTP call,
 * wait for a timeout, and retry — burning ~5 attempts x 500 jobs of latency against a service
 * that cannot answer. The breaker lets the first few failures speak for all of them: once open,
 * jobs fail instantly and cheaply, and the retry backoff re-tries them later without ever
 * touching the dead provider.
 *
 * The three states:
 *   closed    — normal. Count consecutive failures; at the threshold, open.
 *   open      — fail fast for `resetMs`. No calls reach the provider at all.
 *   half-open — after the cooldown, let exactly ONE probe through. Success closes the breaker,
 *               failure re-opens it. Letting all 500 through at once would just re-kill a
 *               provider that is still recovering.
 *
 * The half-open probe uses `SET NX` as a mutex so concurrent workers cannot each send a probe.
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService,
  ) {
    const tuning = config.get('tuning', { infer: true });
    this.threshold = tuning.circuitBreakerThreshold;
    this.resetMs = tuning.circuitBreakerResetMs;
  }

  private keys(provider: string) {
    return {
      failures: `cb:${provider}:failures`,
      open: `cb:${provider}:open`,
      probe: `cb:${provider}:probe`,
    };
  }

  async state(provider: string): Promise<BreakerState> {
    const k = this.keys(provider);
    const openUntil = await this.redis.get(k.open);
    if (!openUntil) return 'closed';
    return Number(openUntil) > Date.now() ? 'open' : 'half-open';
  }

  /**
   * Runs `fn` through the breaker.
   *
   * Throws CircuitOpenError (a RetryableProviderError) while open, so the caller's normal retry
   * path handles it and the job simply comes back later.
   */
  async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const k = this.keys(provider);
    const state = await this.state(provider);

    if (state === 'open') {
      const openUntil = Number(await this.redis.get(k.open));
      const waitMs = Math.max(1000, openUntil - Date.now());
      this.metrics.breakerState.set({ provider }, STATE_METRIC.open);
      throw new CircuitOpenError(provider, waitMs);
    }

    if (state === 'half-open') {
      // Exactly one probe: SET NX succeeds for a single caller, everyone else keeps failing fast.
      const won = await this.redis.set(k.probe, '1', 'PX', 10_000, 'NX');
      if (!won) {
        this.metrics.breakerState.set({ provider }, STATE_METRIC['half-open']);
        throw new CircuitOpenError(provider, 5_000);
      }
      this.logger.log(`Circuit breaker half-open probe for "${provider}"`);
      this.metrics.breakerState.set({ provider }, STATE_METRIC['half-open']);
    }

    try {
      const result = await fn();
      await this.onSuccess(provider);
      return result;
    } catch (err) {
      await this.onFailure(provider, err);
      throw err;
    }
  }

  private async onSuccess(provider: string) {
    const k = this.keys(provider);
    // A single success clears the whole failure run: the breaker cares about *consecutive*
    // failures, not a lifetime error rate.
    await this.redis.del(k.failures, k.open, k.probe);
    this.metrics.breakerState.set({ provider }, STATE_METRIC.closed);
  }

  private async onFailure(provider: string, err: unknown) {
    const k = this.keys(provider);

    // A CircuitOpenError is not evidence about the provider — it *is* the breaker. Counting it
    // would let an open breaker keep extending its own timeout forever.
    if (err instanceof CircuitOpenError) return;

    const failures = await this.redis.incr(k.failures);
    // Expire the counter so an isolated failure every few hours never accumulates to the
    // threshold. Only a genuine burst should trip it.
    await this.redis.pexpire(k.failures, this.resetMs * 2);

    if (failures >= this.threshold) {
      const openUntil = Date.now() + this.resetMs;
      await this.redis.set(k.open, String(openUntil), 'PX', this.resetMs * 2);
      await this.redis.del(k.probe);
      this.metrics.breakerState.set({ provider }, STATE_METRIC.open);
      this.logger.error(
        `Circuit breaker OPEN for "${provider}" after ${failures} consecutive failures; ` +
          `retrying in ${this.resetMs}ms`,
      );
    } else {
      this.logger.warn(
        `Provider "${provider}" failure ${failures}/${this.threshold}: ${(err as Error).message}`,
      );
    }
  }

  /** Ops escape hatch: force a breaker closed after fixing the underlying problem. */
  async reset(provider: string): Promise<void> {
    const k = this.keys(provider);
    await this.redis.del(k.failures, k.open, k.probe);
    this.metrics.breakerState.set({ provider }, STATE_METRIC.closed);
    this.logger.log(`Circuit breaker for "${provider}" manually reset`);
  }

  async snapshot(providers: string[]): Promise<Record<string, BreakerState>> {
    const entries = await Promise.all(
      providers.map(async (p) => [p, await this.state(p)] as const),
    );
    return Object.fromEntries(entries);
  }
}
