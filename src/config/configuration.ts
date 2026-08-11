/**
 * Typed configuration, loaded once at boot.
 *
 * Everything the app reads from the environment lands here so no module ever touches
 * `process.env` directly — that keeps env access testable and makes the full surface of
 * external configuration visible in one file.
 */
export type ProviderMode = 'sandbox' | 'live';
export type SmsProviderName = 'mock' | 'twilio';

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  logLevel: string;
  baseUrl: string;
  apiKeySeed: string;
  unsubscribeSecret: string;
  databaseUrl: string;
  redisUrl: string;
  providerMode: ProviderMode;
  resend: {
    apiKey: string;
    from: string;
    webhookSecret: string;
    allowUnsignedWebhooks: boolean;
  };
  smtp: {
    url: string;
    from: string;
  };
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  };
  slack: {
    webhookUrl: string;
  };
  sms: {
    provider: SmsProviderName;
    twilioAccountSid: string;
    twilioAuthToken: string;
    twilioFrom: string;
  };
  tuning: {
    emailRateLimitPerSec: number;
    circuitBreakerThreshold: number;
    circuitBreakerResetMs: number;
    outboxPollIntervalMs: number;
    retentionDays: number;
  };
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export default (): AppConfig => {
  const env = process.env.NODE_ENV ?? 'development';
  return {
    env,
    isProduction: env === 'production',
    port: int(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
    apiKeySeed: process.env.API_KEY_SEED ?? 'dev-key-please-change',
    unsubscribeSecret: process.env.UNSUBSCRIBE_TOKEN_SECRET ?? 'change-me-unsubscribe-secret',
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    providerMode: (process.env.PROVIDER_MODE as ProviderMode) ?? 'sandbox',
    resend: {
      apiKey: process.env.RESEND_API_KEY ?? '',
      from: process.env.RESEND_FROM ?? 'Notify <onboarding@resend.dev>',
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? '',
      allowUnsignedWebhooks: bool(process.env.WEBHOOK_ALLOW_UNSIGNED, env !== 'production'),
    },
    smtp: {
      url: process.env.SMTP_URL ?? '',
      from: process.env.SMTP_FROM ?? 'Notify <notify@localhost>',
    },
    vapid: {
      publicKey: process.env.VAPID_PUBLIC_KEY ?? '',
      privateKey: process.env.VAPID_PRIVATE_KEY ?? '',
      subject: process.env.VAPID_SUBJECT ?? 'mailto:you@example.com',
    },
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
    },
    sms: {
      provider: (process.env.SMS_PROVIDER as SmsProviderName) ?? 'mock',
      twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
      twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
      twilioFrom: process.env.TWILIO_FROM ?? '',
    },
    tuning: {
      emailRateLimitPerSec: int(process.env.EMAIL_RATE_LIMIT_PER_SEC, 8),
      circuitBreakerThreshold: int(process.env.CIRCUIT_BREAKER_THRESHOLD, 5),
      circuitBreakerResetMs: int(process.env.CIRCUIT_BREAKER_RESET_MS, 30_000),
      outboxPollIntervalMs: int(process.env.OUTBOX_POLL_INTERVAL_MS, 500),
      retentionDays: int(process.env.RETENTION_DAYS, 30),
    },
  };
};
