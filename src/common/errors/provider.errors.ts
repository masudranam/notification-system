/**
 * Error taxonomy for provider calls.
 *
 * Getting this classification right is the single most important detail in the whole worker path.
 * Retrying a permanent failure (invalid address, malformed payload) burns quota and delays the
 * queue for nothing; NOT retrying a transient one (429, 503, socket timeout) silently drops a
 * notification the user was supposed to receive.
 *
 * So providers never throw raw errors — they translate into one of these two, and the worker
 * decides retry-vs-fail purely from the type.
 */

/** Transient. Worth another attempt after a backoff. */
export class RetryableProviderError extends Error {
  readonly retryable = true as const;

  constructor(
    message: string,
    readonly provider: string,
    /** Provider's own hint, honoured over our backoff when present (e.g. Retry-After). */
    readonly retryAfterMs?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryableProviderError';
  }
}

/** Permanent for this payload. Retrying will produce the identical failure. */
export class PermanentProviderError extends Error {
  readonly retryable = false as const;

  constructor(
    message: string,
    readonly provider: string,
    /** Set when the failure means the address itself is dead and should be suppressed. */
    readonly suppressAddress = false,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PermanentProviderError';
  }
}

/** Raised when a circuit breaker is open, so the worker can retry without touching the provider. */
export class CircuitOpenError extends RetryableProviderError {
  constructor(provider: string, retryAfterMs: number) {
    super(`Circuit breaker open for "${provider}"`, provider, retryAfterMs);
    this.name = 'CircuitOpenError';
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof RetryableProviderError;
}

/**
 * Default classifier for HTTP-shaped provider errors.
 *
 * 408/429 and every 5xx are transient. 4xx otherwise is the caller's fault and permanent.
 * Network-level failures (ECONNRESET, ETIMEDOUT, EAI_AGAIN) have no status at all and are
 * always worth a retry.
 */
export function classifyHttpStatus(status: number | undefined, provider: string, message: string) {
  if (status === undefined) {
    return new RetryableProviderError(`${message} (network error)`, provider);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new RetryableProviderError(`${message} (HTTP ${status})`, provider);
  }
  return new PermanentProviderError(`${message} (HTTP ${status})`, provider);
}
